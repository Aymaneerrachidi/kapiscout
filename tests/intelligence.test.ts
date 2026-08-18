import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { buildRealityReport, estimateExit, estimateRealMultiple, summarizeLiquidityHistory } from "../src/intelligence.js";
import type { CallRecord, TokenScan } from "../src/types.js";

describe("Kapi Reality Check", () => {
  it("shows severe impact when the requested exit is large relative to liquidity", async () => {
    const tiny = estimateExit(1_000, 440);
    const healthy = estimateExit(1_000, 100_000);
    expect(tiny.receivedUsd).toBeLessThan(200);
    expect(tiny.impactPercent).toBeGreaterThan(80);
    expect(healthy.impactPercent).toBeLessThan(3);
  });

  it("separates headline PNL from estimated executable PNL", async () => {
    const call = callFixture();
    expect(estimateRealMultiple(call, 500_000, 2_000, 1_000)).toBeLessThan(5);
    const report = buildRealityReport(scanFixture(), call);
    expect(report.headlineMultiple).toBe(5);
    expect(report.realMultiple).toBeLessThan(report.headlineMultiple!);
    expect(report.exitScore).toBeLessThan(50);
  });

  it("summarizes liquidity deterioration", async () => {
    const summary = summarizeLiquidityHistory([
      { capturedAt: 1, priceUsd: 1, marketCapUsd: 1, liquidityUsd: 10_000 },
      { capturedAt: 2, priceUsd: 1, marketCapUsd: 1, liquidityUsd: 4_000 },
      { capturedAt: 3, priceUsd: 1, marketCapUsd: 1, liquidityUsd: 5_000 },
    ]);
    expect(summary.samples).toBe(3);
    expect(summary.largestDropPercent).toBe(60);
    expect(summary.lowUsd).toBe(4_000);
  });
});

function scanFixture(): TokenScan {
  return {
    token: { address: getAddress("0x3333333333333333333333333333333333333333"), name: "Kapi", symbol: "KAPI", decimals: 18, totalSupplyRaw: 1_000_000n, holdersCount: 80, iconUrl: null },
    market: { pairAddress: "pool", dexId: "uniswap", pairUrl: null, quoteSymbol: "USDG", priceUsd: 0.5, marketCapUsd: 500_000, fdvUsd: 500_000, liquidityUsd: 2_000, volume24hUsd: 1_000, priceChange1h: 0, priceChange24h: 0, buys1h: 1, sells1h: 1, buys24h: 1, sells24h: 1, pairCreatedAt: Date.now(), websites: [], socials: [], dexPaid: false },
    holders: { top10Percent: 55, holders: [] }, verified: true, creator: null, warnings: [], scannedAt: Date.now(),
  };
}

function callFixture(): CallRecord {
  return {
    id: 1, chatId: "1", messageId: 1, userId: "2", username: "@kapi",
    tokenAddress: getAddress("0x3333333333333333333333333333333333333333"), symbol: "KAPI",
    entryPriceUsd: 0.1, entryMarketCapUsd: 100_000, entryLiquidityUsd: 2_000,
    athPriceUsd: 0.5, athMarketCapUsd: 500_000, lastPriceUsd: 0.5, lastMarketCapUsd: 500_000,
    lastLiquidityUsd: 2_000, lastDexPaid: false, scanCount: 1, lastAthAlertMarketCapUsd: null,
    lastCheckedAt: Date.now(), proofHash: "abc", calledAt: Date.now(), updatedAt: Date.now(),
  };
}
