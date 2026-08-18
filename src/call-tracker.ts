import type { Address } from "viem";
import type { Store } from "./db.js";
import type { MarketClient } from "./market.js";
import type { CallRecord, MarketSnapshot } from "./types.js";
import { escapeHtml, formatUsd } from "./utils.js";
import { estimateExit } from "./intelligence.js";

export type CallAlertSender = (chatId: string, html: string, tokenAddress: Address) => Promise<void>;

const milestones = [2, 3, 5, 10, 20, 50, 100, 250, 500, 1_000];

export class CallTracker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly market: MarketClient,
    private readonly intervalMs: number,
    private readonly send?: CallAlertSender,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
    void this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const calls = this.store.listAllCalls();
      const addresses = [...new Set(calls.map((call) => call.tokenAddress.toLowerCase()))].slice(0, 250);
      for (const address of addresses) {
        const market = await this.market.getBestMarket(address as Address).catch(() => null);
        if (!market) continue;
        for (const call of calls.filter((item) => item.tokenAddress.toLowerCase() === address)) {
          await this.refreshCall(call, market).catch((error) => console.error(`Call alert refresh failed for ${address}`, error));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async refreshCall(call: CallRecord, market: MarketSnapshot): Promise<void> {
    const marketCap = market.marketCapUsd ?? market.fdvUsd;
    const previousAth = call.athMarketCapUsd;
    const previousLiquidity = call.lastLiquidityUsd;
    const previousDexPaid = call.lastDexPaid;
    const updated = this.store.updateCallMarket(call.id, {
      priceUsd: market.priceUsd,
      marketCapUsd: marketCap,
      liquidityUsd: market.liquidityUsd,
      dexPaid: market.dexPaid,
    });
    if (!updated || !this.send) return;
    const settings = this.store.getChatSettings(call.chatId);
    const multiple = updated.entryMarketCapUsd && marketCap ? marketCap / updated.entryMarketCapUsd : null;

    let milestoneSent = false;
    if (settings.milestoneAlerts && multiple != null) {
      const crossed = milestones.filter((threshold) => multiple >= threshold && this.store.claimCallAlert(call.id, `multiple:${threshold}`));
      const highest = crossed.at(-1);
      if (highest != null) {
        milestoneSent = true;
        this.store.recordTokenEvent({ chatId: call.chatId, tokenAddress: call.tokenAddress, symbol: call.symbol, kind: "MILESTONE", title: `Reached ${highest}x`, txHash: null, valueUsd: marketCap });
        await this.send(call.chatId, alertHtml("🚀", `$${call.symbol} reached ${highest}x`, call, marketCap, updated.athMarketCapUsd), call.tokenAddress);
      }
    }

    const higherAth = marketCap != null && previousAth != null && marketCap > previousAth;
    const alertBase = updated.lastAthAlertMarketCapUsd ?? previousAth;
    if (!milestoneSent && settings.athAlerts && higherAth && alertBase != null && marketCap >= alertBase * 1.1) {
      this.store.setLastAthAlert(call.id, marketCap);
      this.store.recordTokenEvent({ chatId: call.chatId, tokenAddress: call.tokenAddress, symbol: call.symbol, kind: "ATH", title: "New tracked ATH", txHash: null, valueUsd: marketCap });
      await this.send(call.chatId, alertHtml("⛰", `$${call.symbol} set a new ATH`, call, marketCap, marketCap), call.tokenAddress);
    }

    if (settings.dexPaidAlerts && previousDexPaid === false && market.dexPaid === true && this.store.claimCallAlert(call.id, "dex-paid")) {
      this.store.recordTokenEvent({ chatId: call.chatId, tokenAddress: call.tokenAddress, symbol: call.symbol, kind: "DEX_PAID", title: "DEX profile marked paid", txHash: null, valueUsd: marketCap });
      await this.send(call.chatId, alertHtml("✅", `$${call.symbol} is now DEX paid`, call, marketCap, updated.athMarketCapUsd), call.tokenAddress);
    }

    if (settings.liquidityAlerts && previousLiquidity && market.liquidityUsd) {
      const ratio = market.liquidityUsd / previousLiquidity;
      const direction = ratio <= 0.7 ? "removed" : ratio >= 1.5 ? "added" : null;
      const eventKey = direction ? `liquidity:${direction}:${Math.floor(Date.now() / 3_600_000)}` : null;
      if (direction && eventKey && this.store.claimCallAlert(call.id, eventKey)) {
        const icon = direction === "removed" ? "🔴" : "🟢";
        const change = Math.abs((ratio - 1) * 100).toFixed(0);
        this.store.recordTokenEvent({ chatId: call.chatId, tokenAddress: call.tokenAddress, symbol: call.symbol, kind: "LIQUIDITY", title: `${change}% liquidity ${direction}`, txHash: null, valueUsd: market.liquidityUsd });
        const impact = estimateExit(1_000, market.liquidityUsd).impactPercent;
        const impactText = direction === "removed" && impact != null ? ` · $1K exit ≈ ${impact.toFixed(1)}% impact` : "";
        await this.send(call.chatId, alertHtml(icon, `${change}% liquidity ${direction} on $${call.symbol}${impactText}`, call, marketCap, updated.athMarketCapUsd, market.liquidityUsd), call.tokenAddress);
      }
    }
  }
}

function alertHtml(icon: string, title: string, call: CallRecord, currentMc: number | null, athMc: number | null, liquidity?: number | null): string {
  const currentMultiple = call.entryMarketCapUsd && currentMc ? currentMc / call.entryMarketCapUsd : null;
  return [
    `<b>${icon} ${escapeHtml(title)}</b>`,
    "",
    `Entry <b>${formatUsd(call.entryMarketCapUsd)}</b>  →  Now <b>${formatUsd(currentMc)}</b>`,
    `Return <b>${currentMultiple == null ? "N/A" : currentMultiple >= 1 ? `${currentMultiple.toFixed(2)}x` : `${((currentMultiple - 1) * 100).toFixed(1)}%`}</b>  ·  ATH <b>${formatUsd(athMc)}</b>`,
    liquidity == null ? "" : `Liquidity <b>${formatUsd(liquidity)}</b>`,
    `First call by <b>${escapeHtml(call.username)}</b>`,
  ].filter(Boolean).join("\n");
}
