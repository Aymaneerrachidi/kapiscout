import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { CallTracker } from "../src/call-tracker.js";
import { Store } from "../src/db.js";
import type { MarketClient } from "../src/market.js";
import type { MarketSnapshot, TokenScan } from "../src/types.js";

const directories: string[] = [];
const openStores: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const store of openStores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const directory of directories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* windows file lock */ }
  }
});

describe("CallTracker", () => {
  it("sends deduplicated milestone, DEX-paid and liquidity alerts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kapiscout-tracker-"));
    directories.push(directory);
    const store = new Store(join(directory, "test.db"));
    await store.init();
  openStores.push(store);
    await store.ensureChat("1", "Test");
    await store.recordCall({ chatId: "1", messageId: 1, userId: "2", username: "@caller", scan: scanFixture() });
    const market: MarketSnapshot = { ...scanFixture().market, marketCapUsd: 210_000, fdvUsd: 210_000, liquidityUsd: 8_000, dexPaid: true };
    const fakeMarket = { getBestMarket: async () => market } as unknown as MarketClient;
    const alerts: string[] = [];
    const tracker = new CallTracker(store, fakeMarket, 60_000, async (_chatId, html) => { alerts.push(html); });
    await tracker.refresh();
    expect(alerts.some((item) => item.includes("2x"))).toBe(true);
    expect(alerts.some((item) => item.includes("DEX paid"))).toBe(true);
    expect(alerts.some((item) => item.includes("liquidity removed"))).toBe(true);
    const count = alerts.length;
    await tracker.refresh();
    expect(alerts.length).toBe(count);
    await store.close();
  });
});

function scanFixture(): TokenScan {
  return {
    token: { address: getAddress("0x3333333333333333333333333333333333333333"), name: "Test", symbol: "TEST", decimals: 18, totalSupplyRaw: 1_000_000n * 10n ** 18n, holdersCount: 100, iconUrl: null },
    market: { pairAddress: "0xpool", dexId: "uniswap", pairUrl: null, quoteSymbol: "WETH", priceUsd: 0.0001, marketCapUsd: 100_000, fdvUsd: 100_000, liquidityUsd: 20_000, volume24hUsd: 10_000, priceChange1h: 0, priceChange24h: 0, buys1h: 0, sells1h: 0, buys24h: 0, sells24h: 0, pairCreatedAt: Date.now(), websites: [], socials: [], dexPaid: false },
    holders: { top10Percent: 20, holders: [] }, verified: true, creator: null, warnings: [], scannedAt: Date.now(),
  };
}
