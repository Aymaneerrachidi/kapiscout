import { formatEther, getAddress, type Address, type Hash, type PublicClient, type Transaction } from "viem";
import type { AppConfig } from "./config.js";
import type { Store } from "./db.js";
import type { MarketClient } from "./market.js";
import type { TokenScanner } from "./scanner.js";
import type { BridgeFlow } from "./types.js";
import { compactAddress, escapeHtml, formatUsd } from "./utils.js";

export type FeatureSender = (chatId: string, html: string, txHash?: Hash) => Promise<void>;

export class DailyDigestService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly store: Store, private readonly send: FeatureSender) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const day = localDay(now);
      for (const chatId of this.store.dueDigestChats(now.getHours(), day)) {
        try {
          await this.send(chatId, buildDailyDigest(this.store, chatId, now));
          this.store.markDigestSent(chatId, day);
        } catch (error) { console.error(`Digest failed for ${chatId}`, error); }
      }
    } finally { this.running = false; }
  }
}

export class HolderTrackerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly store: Store, private readonly scanner: TokenScanner) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), 15 * 60_000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async refresh(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const calls=this.store.listAllCalls();
      const addresses=[...new Set(calls.map((call)=>call.tokenAddress.toLowerCase()))].slice(0,100);
      for(const address of addresses){
        const scan=await this.scanner.scan(address,true).catch(()=>null); if(!scan)continue;
        for(const call of calls.filter((item)=>item.tokenAddress.toLowerCase()===address))this.store.recordHolderSnapshot(call.chatId,scan);
      }
    } finally { this.running=false; }
  }
}

export class BridgeRadarService {
  private stopWatching: (() => void) | null = null;
  private ethUsd: { value: number | null; expiresAt: number } = { value: null, expiresAt: 0 };
  private readonly arbSys = "0x0000000000000000000000000000000000000064";

  constructor(
    private readonly client: PublicClient,
    private readonly store: Store,
    private readonly market: MarketClient,
    private readonly config: AppConfig,
    private readonly send: FeatureSender,
  ) {}

  start(): void {
    if (this.stopWatching) return;
    this.stopWatching = this.client.watchBlocks({
      includeTransactions: true,
      emitMissed: true,
      pollingInterval: this.config.blockPollIntervalMs,
      onBlock: (block) => void this.handleBlock(block.transactions, Number(block.timestamp) * 1_000).catch((error) => console.error("Bridge radar failed", error)),
      onError: (error) => console.error("Bridge radar watcher error", error),
    });
  }

  stop(): void { this.stopWatching?.(); this.stopWatching = null; }

  private async handleBlock(transactions: readonly (Hash | Transaction)[], occurredAt: number): Promise<void> {
    const ethUsd = await this.ethPrice();
    for (const tx of transactions) {
      if (typeof tx === "string" || tx.value <= 0n) continue;
      const rawType: unknown = (tx as unknown as { type?: unknown }).type;
      const isDeposit = rawType === "deposit" || rawType === 100 || rawType === "0x64";
      const isWithdrawal = tx.to?.toLowerCase() === this.arbSys;
      if (!isDeposit && !isWithdrawal) continue;
      const amount = Number(formatEther(tx.value));
      const flow: BridgeFlow = { txHash: tx.hash, direction: isDeposit ? "IN" : "OUT", asset: "ETH", amount, valueUsd: ethUsd == null ? null : amount * ethUsd, wallet: getAddress(tx.from), occurredAt };
      if (!this.store.recordBridgeFlow(flow)) continue;
      for (const chatId of this.store.bridgeAlertChats(flow.valueUsd)) await this.send(chatId, bridgeFlowHtml(flow), flow.txHash).catch((error)=>console.error(`Bridge alert failed for ${chatId}`,error));
    }
  }

  private async ethPrice(): Promise<number | null> {
    if (this.ethUsd.expiresAt > Date.now()) return this.ethUsd.value;
    const snapshot = await this.market.getBestMarket(this.config.wethAddress).catch(() => null);
    this.ethUsd = { value: snapshot?.priceUsd ?? null, expiresAt: Date.now() + 60_000 };
    return this.ethUsd.value;
  }
}

export function buildDailyDigest(store: Store, chatId: string, now = new Date()): string {
  const since = now.getTime() - 24 * 60 * 60_000;
  const calls = store.listCalls(chatId, 100).filter((item) => item.calledAt >= since);
  const events = store.recentTokenEvents(chatId, since, 100);
  const walletMoves = store.listWalletMovements(chatId, undefined, since);
  const buys = walletMoves.filter((item) => item.direction === "BUY");
  const sells = walletMoves.filter((item) => item.direction === "SELL");
  const volume = walletMoves.reduce((sum, item) => sum + (item.valueUsd ?? 0), 0);
  const best = [...calls].filter((item) => item.entryMarketCapUsd && item.athMarketCapUsd).sort((a,b) => (b.athMarketCapUsd! / b.entryMarketCapUsd!) - (a.athMarketCapUsd! / a.entryMarketCapUsd!))[0];
  const signals = events.filter((item) => item.kind.startsWith("WALLET_")).slice(0, 4);
  return [
    "<b>☀️ KAPISCOUT · DAILY EDGE</b>",
    "└ Last 24 hours",
    "",
    "<b>📡 Group pulse</b>",
    `├ New calls  <b>${calls.length}</b>`,
    `├ Wallets    <b>${new Set(walletMoves.map((item) => item.walletAddress.toLowerCase())).size}</b> active`,
    `├ Flow       <b>${buys.length}</b> buys · <b>${sells.length}</b> sells`,
    `└ Volume     <b>${formatUsd(volume)}</b> observed`,
    "",
    best ? `<b>🏆 Best call</b>\n└ $${escapeHtml(best.symbol)} · <b>${(best.athMarketCapUsd! / best.entryMarketCapUsd!).toFixed(2)}x ATH</b>` : "<b>🏆 Best call</b>\n└ No priced calls in this window",
    signals.length ? `\n<b>👀 Smart-money tape</b>\n${signals.map((item,index)=>`${index===signals.length-1?"└":"├"} $${escapeHtml(item.symbol)} · ${escapeHtml(item.title)}`).join("\n")}` : "",
    "",
    "<i>Observed data only · not financial advice</i>",
  ].filter(Boolean).join("\n");
}

export function bridgeFlowHtml(flow: BridgeFlow): string {
  const icon = flow.direction === "IN" ? "🟢" : "🟠";
  return [
    `<b>${icon} BRIDGE FLOW · ${flow.direction === "IN" ? "INTO" : "OUT OF"} ROBINHOOD</b>`,
    "",
    `├ Amount  <b>${flow.amount.toLocaleString(undefined,{maximumFractionDigits:4})} ${flow.asset}</b>`,
    `├ Value   <b>${formatUsd(flow.valueUsd)}</b>`,
    `└ Wallet  <code>${compactAddress(flow.wallet)}</code>`,
    "",
    "<i>Detected from a chain-native bridge transaction.</i>",
  ].join("\n");
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
