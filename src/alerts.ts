import {
  decodeEventLog,
  formatUnits,
  getAddress,
  parseAbiItem,
  type Address,
  type Hash,
  type PublicClient,
  type Transaction,
  zeroAddress,
} from "viem";
import type { AppConfig } from "./config.js";
import type { Store } from "./db.js";
import type { TokenScanner } from "./scanner.js";
import type { TrackedWallet, WalletMovement } from "./types.js";
import { compactAddress, escapeHtml, formatCompactNumber, formatTokenPrice, formatUsd } from "./utils.js";
import { generateWalletAlertCard } from "./card.js";

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

interface Transfer {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
}

export type AlertSender = (chatId: string, html: string, transactionHash: Hash, walletAddress?: Address, image?: Buffer) => Promise<void>;

export class WalletAlertService {
  private stopWatching: (() => void) | null = null;

  constructor(
    private readonly client: PublicClient,
    private readonly store: Store,
    private readonly scanner: TokenScanner,
    private readonly config: AppConfig,
    private readonly send: AlertSender,
  ) {}

  start(): void {
    if (this.stopWatching) return;
    this.stopWatching = this.client.watchBlocks({
      includeTransactions: true,
      emitMissed: true,
      onBlock: (block) => {
        void this.handleBlock(block.transactions).catch((error) => {
          console.error("Wallet alert block processing failed", error);
        });
      },
      onError: (error) => console.error("Robinhood Chain block watcher error", error),
      pollingInterval: this.config.blockPollIntervalMs,
    });
  }

  stop(): void {
    this.stopWatching?.();
    this.stopWatching = null;
  }

  private async handleBlock(transactions: readonly (Hash | Transaction)[]): Promise<void> {
    const tracked = new Set([...await this.store.trackedAddressSet(), ...await this.store.securityWatchedAddressSet()]);
    if (tracked.size === 0) return;
    const matches = transactions.filter(
      (tx): tx is Transaction => typeof tx !== "string" && tracked.has(tx.from.toLowerCase()),
    );
    for (const tx of matches) {
      await this.handleTransaction(tx).catch((error) => {
        console.error(`Could not inspect tracked transaction ${tx.hash}`, error);
      });
    }
  }

  private async handleTransaction(tx: Transaction): Promise<void> {
    const wallet = getAddress(tx.from);
    const receipt = await this.client.getTransactionReceipt({ hash: tx.hash });
    const transfers: Transfer[] = [];
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: [transferEvent],
          data: log.data,
          topics: log.topics,
          strict: false,
        });
        if (decoded.eventName !== "Transfer") continue;
        const args = decoded.args as { from?: Address; to?: Address; value?: bigint };
        if (!args.from || !args.to || args.value == null) continue;
        transfers.push({ token: getAddress(log.address), from: getAddress(args.from), to: getAddress(args.to), value: args.value });
      } catch {
        // Not an ERC-20 transfer log.
      }
    }
    const movement = classifyMovement(tx.hash, wallet, tx.value, tx.blockNumber ?? receipt.blockNumber, transfers, [
      this.config.wethAddress,
      this.config.usdgAddress,
    ]);
    if (movement) await this.dispatchMovement(movement);
    await this.dispatchSecurityTransfers(tx.hash, wallet, transfers, movement);
  }

  private async dispatchSecurityTransfers(txHash: Hash, wallet: Address, transfers: Transfer[], movement: WalletMovement | null): Promise<void> {
    const watches = await this.store.findSecurityWallets(wallet);
    if (!watches.length) return;
    for (const watch of watches) {
      if (!await this.store.chatAllowsAlert(watch.chatId, watch.kind === "DEV" ? "dev" : "whale")) continue;
      const outgoing = transfers.filter((item) =>
        item.from.toLowerCase() === wallet.toLowerCase() &&
        item.token.toLowerCase() === watch.tokenAddress.toLowerCase(),
      );
      if (!outgoing.length) continue;
      const scan = await this.scanner.scan(watch.tokenAddress).catch(() => null);
      const totalRaw = scan?.token.totalSupplyRaw ?? 0n;
      const amountRaw = outgoing.reduce((sum, item) => sum + item.value, 0n);
      const supplyPercent = totalRaw > 0n ? Number((amountRaw * 1_000_000n) / totalRaw) / 10_000 : null;
      const isSale = movement?.direction === "SELL" && movement.tokenAddress.toLowerCase() === watch.tokenAddress.toLowerCase();
      if (watch.kind === "DEV" && !isSale) continue;
      if (watch.kind === "WHALE" && (supplyPercent == null || supplyPercent < 0.25)) continue;
      const eventKind = watch.kind === "DEV" ? "dev-sell" : "whale-transfer";
      if (!await this.store.claimAlert(`${txHash}:${eventKind}`, wallet, watch.chatId)) continue;
      const html = [
        `<b>${watch.kind === "DEV" ? "🚨 DEV SELL" : "🐋 LARGE HOLDER MOVE"} · $${escapeHtml(watch.symbol)}</b>`,
        "",
        `<b>Wallet:</b> <code>${compactAddress(wallet)}</code>`,
        `<b>Amount:</b> ${supplyPercent == null ? "N/A" : `${supplyPercent.toFixed(3)}% of supply`}`,
        `<b>Holder size:</b> ${watch.holdingPercent == null ? "Creator" : `${watch.holdingPercent.toFixed(2)}%`}`,
        `<b>Market cap:</b> ${formatUsd(scan?.market.marketCapUsd ?? scan?.market.fdvUsd ?? null)}`,
        "<i>Classification is based on observable token transfers.</i>",
      ].join("\n");
      const tokenAmount = scan ? Number(formatUnits(amountRaw, scan.token.decimals)) : 0;
      const image = await generateWalletAlertCard({ scan, label: watch.kind === "DEV" ? "Token deployer" : "Large holder", isKol: false, walletAddress: wallet, direction: isSale ? "SELL" : "TRANSFER", symbol: watch.symbol, tokenAmount, valueUsd: scan?.market.priceUsd == null ? null : tokenAmount * scan.market.priceUsd, priceUsd: scan?.market.priceUsd ?? null, marketCapUsd: scan?.market.marketCapUsd ?? scan?.market.fdvUsd ?? null, liquidityUsd: scan?.market.liquidityUsd ?? null }).catch(() => undefined);
      await this.send(watch.chatId, html, txHash, wallet, image);
    }
  }

  private async dispatchMovement(movement: WalletMovement): Promise<void> {
    const trackedEntries = await this.store.findWallets(movement.wallet);
    if (!trackedEntries.length) return;
    const scan = await this.scanner.scan(movement.tokenAddress).catch(() => null);
    const tokenDecimals = scan?.token.decimals ?? 18;
    const amount = Number(formatUnits(movement.tokenAmountRaw, tokenDecimals));
    const marketCap = scan?.market.marketCapUsd ?? scan?.market.fdvUsd ?? null;
    const supply = scan ? Number(formatUnits(scan.token.totalSupplyRaw, scan.token.decimals)) : null;
    const derivedPrice = marketCap != null && supply != null && Number.isFinite(supply) && supply > 0 ? marketCap / supply : null;
    const tokenPriceUsd = scan?.market.priceUsd ?? derivedPrice;
    const valuation = movementValuation(movement, amount, tokenPriceUsd, this.config.usdgAddress, this.config.wethAddress);

    for (const tracked of trackedEntries) {
      const chats = tracked.isKol
        ? await this.store.listKolAlertChats()
        : tracked.chatId ? [tracked.chatId] : [];
      for (const chatId of new Set(chats)) {
        const symbol = scan?.token.symbol ?? compactAddress(movement.tokenAddress);
        const inserted = await this.store.recordWalletMovement({
          chatId,
          walletAddress: movement.wallet,
          walletLabel: tracked.label,
          txHash: movement.txHash,
          direction: movement.direction,
          tokenAddress: movement.tokenAddress,
          symbol,
          tokenAmount: amount,
          valueUsd: valuation.valueUsd,
          priceUsd: tokenPriceUsd,
          marketCapUsd: marketCap,
          liquidityUsd: scan?.market.liquidityUsd ?? null,
          occurredAt: Date.now(),
        });
        if (inserted) await this.store.recordTokenEvent({
          chatId,
          tokenAddress: movement.tokenAddress,
          symbol,
          kind: `WALLET_${movement.direction}`,
          title: `${tracked.label} ${movement.direction.toLowerCase()}${valuation.valueUsd == null ? "" : ` ${formatUsd(valuation.valueUsd)}`}`,
          txHash: movement.txHash,
          valueUsd: valuation.valueUsd,
        });
        if (!await this.store.claimAlert(movement.txHash, movement.wallet, chatId)) continue;
        const html = renderAlert(tracked, movement, symbol, amount, valuation, tokenPriceUsd, marketCap, scan?.market.liquidityUsd ?? null);
        const image = await generateWalletAlertCard({ scan, label: tracked.label, isKol: tracked.isKol, walletAddress: movement.wallet, direction: movement.direction, symbol, tokenAmount: amount, valueUsd: valuation.valueUsd, priceUsd: tokenPriceUsd, marketCapUsd: marketCap, liquidityUsd: scan?.market.liquidityUsd ?? null }).catch((error) => { console.warn("Wallet alert card failed", error); return undefined; });
        await this.send(chatId, html, movement.txHash, movement.wallet, image);
        await this.dispatchCustomRules(chatId, movement, symbol, valuation.valueUsd, marketCap, scan?.market.liquidityUsd ?? null);
      }
    }
  }

  private async dispatchCustomRules(chatId: string, movement: WalletMovement, symbol: string, valueUsd: number | null, marketCapUsd: number | null, liquidityUsd: number | null): Promise<void> {
    for (const rule of (await this.store.listAlertRules(chatId)).filter((item) => item.enabled)) {
      if (rule.direction !== "ANY" && rule.direction !== movement.direction) continue;
      if ((valueUsd ?? 0) < rule.minValueUsd || (marketCapUsd ?? 0) < rule.minMarketCapUsd || (liquidityUsd ?? 0) < rule.minLiquidityUsd) continue;
      if (rule.maxMarketCapUsd != null && (marketCapUsd == null || marketCapUsd > rule.maxMarketCapUsd)) continue;
      const since = Date.now() - rule.windowMinutes * 60_000;
      const wallets = await this.store.matchingWalletCount(chatId, movement.tokenAddress, since, rule.direction);
      if (wallets < rule.minWallets || !await this.store.claimCustomAlert(rule, movement.tokenAddress)) continue;
      const html = [
        `<b>⚡ CUSTOM SIGNAL · ${escapeHtml(rule.name)}</b>`,
        `└ <b>$${escapeHtml(symbol)}</b> · ${movement.direction} · ${wallets} wallet${wallets === 1 ? "" : "s"}`,
        "",
        `├ Value  <b>${formatUsd(valueUsd)}</b>`,
        `├ MC     <b>${formatUsd(marketCapUsd)}</b>`,
        `└ LP     <b>${formatUsd(liquidityUsd)}</b>`,
        "",
        `<code>${movement.tokenAddress}</code>`,
        `<i>Matched rule #${rule.id} within ${rule.windowMinutes}m.</i>`,
      ].join("\n");
      await this.send(chatId, html, movement.txHash, movement.wallet);
    }
  }
}

export function classifyMovement(
  txHash: Hash,
  wallet: Address,
  nativeValue: bigint,
  blockNumber: bigint,
  transfers: Transfer[],
  quoteTokens: Address[],
): WalletMovement | null {
  const walletKey = wallet.toLowerCase();
  const quotes = new Set(quoteTokens.map((address) => address.toLowerCase()));
  const incoming = transfers.filter((item) => item.to.toLowerCase() === walletKey && item.from !== zeroAddress);
  const outgoing = transfers.filter((item) => item.from.toLowerCase() === walletKey && item.to !== zeroAddress);
  const bought = incoming.find((item) => !quotes.has(item.token.toLowerCase()));
  const sold = outgoing.find((item) => !quotes.has(item.token.toLowerCase()));
  const quoteOut = outgoing.find((item) => quotes.has(item.token.toLowerCase()));
  const quoteIn = incoming.find((item) => quotes.has(item.token.toLowerCase()));

  if (bought) {
    return {
      txHash,
      wallet,
      direction: quoteOut || nativeValue > 0n ? "BUY" : "TRANSFER",
      tokenAddress: bought.token,
      tokenAmountRaw: bought.value,
      quoteAddress: quoteOut?.token ?? null,
      quoteAmountRaw: quoteOut?.value ?? null,
      nativeAmountWei: nativeValue,
      blockNumber,
    };
  }
  if (sold) {
    return {
      txHash,
      wallet,
      direction: quoteIn ? "SELL" : "TRANSFER",
      tokenAddress: sold.token,
      tokenAmountRaw: sold.value,
      quoteAddress: quoteIn?.token ?? null,
      quoteAmountRaw: quoteIn?.value ?? null,
      nativeAmountWei: 0n,
      blockNumber,
    };
  }
  return null;
}

export function renderAlert(
  tracked: TrackedWallet,
  movement: WalletMovement,
  symbol: string,
  amount: number,
  valuation: MovementValuation,
  priceUsd: number | null,
  marketCap: number | null,
  liquidity: number | null,
): string {
  const icon = movement.direction === "BUY" ? "🟢" : movement.direction === "SELL" ? "🔴" : "🔵";
  const heading = tracked.isKol ? "KOL" : "WALLET";
  return [
    `<b>${icon} ${heading} ${movement.direction} · $${escapeHtml(symbol)}</b>`,
    `└ <b>${escapeHtml(tracked.label)}</b> · <code>${compactAddress(movement.wallet)}</code>`,
    "",
    "<b>💸 Trade</b>",
    `├ Amount  <b>${formatAlertAmount(amount)}</b>`,
    `├ Value   <b>${valuation.valueUsd == null ? "N/A" : `${valuation.approximate ? "≈ " : ""}${formatUsd(valuation.valueUsd)}`}</b>`,
    `├ Price   ${formatTokenPrice(priceUsd)}`,
    `├ MC      ${formatUsd(marketCap)}`,
    `└ LP      ${formatUsd(liquidity)}`,
    "",
    `<code>${movement.tokenAddress}</code>`,
    `<i>${escapeHtml(valuation.note)}${valuation.settlement ? ` · ${valuation.settlement}` : ""}</i>`,
  ].join("\n");
}

interface MovementValuation {
  valueUsd: number | null;
  approximate: boolean;
  note: string;
  settlement: string | null;
}

export function movementValuation(
  movement: WalletMovement,
  tokenAmount: number,
  tokenPriceUsd: number | null,
  usdgAddress: Address,
  wethAddress: Address,
): MovementValuation {
  const quoteAmount = movement.quoteAmountRaw == null ? null : Number(formatUnits(movement.quoteAmountRaw, 18));
  const isUsdg = movement.quoteAddress?.toLowerCase() === usdgAddress.toLowerCase();
  const spotValue = Number.isFinite(tokenAmount) && tokenPriceUsd != null && tokenPriceUsd > 0
    ? tokenAmount * tokenPriceUsd
    : null;
  if (isUsdg && quoteAmount != null && Number.isFinite(quoteAmount)) {
    return { valueUsd: quoteAmount, approximate: false, note: "Value settled in USDG", settlement: `${formatCompactNumber(quoteAmount)} USDG` };
  }
  const nativeAmount = movement.nativeAmountWei > 0n ? Number(formatUnits(movement.nativeAmountWei, 18)) : null;
  const isWeth = movement.quoteAddress?.toLowerCase() === wethAddress.toLowerCase();
  const settlement = nativeAmount != null && nativeAmount > 0
    ? `${Number(nativeAmount.toFixed(5))} ETH spent`
    : isWeth && quoteAmount != null
      ? `${Number(quoteAmount.toFixed(5))} WETH ${movement.direction === "BUY" ? "spent" : "received"}`
      : null;
  if (spotValue != null && Number.isFinite(spotValue)) {
    return { valueUsd: spotValue, approximate: true, note: "USD value estimated from live token price", settlement };
  }
  return { valueUsd: null, approximate: true, note: "USD value unavailable from indexed trade data", settlement };
}

function formatAlertAmount(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  const absolute = Math.abs(value);
  for (const unit of [
    { threshold: 1e12, suffix: "T" },
    { threshold: 1e9, suffix: "B" },
    { threshold: 1e6, suffix: "M" },
    { threshold: 1e3, suffix: "K" },
  ]) {
    if (absolute >= unit.threshold) return `${Number((value / unit.threshold).toFixed(2))}${unit.suffix}`;
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
