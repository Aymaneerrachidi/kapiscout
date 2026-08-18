import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { autoTimeframe, generateChartCard } from "../src/chart.js";
import type { Candle, TokenScan } from "../src/types.js";

describe("Robinhood chart cards", () => {
  it("chooses a useful automatic timeframe", () => {
    expect(autoTimeframe(Date.now() - 2 * 60 * 60 * 1_000)).toBe("5m");
    expect(autoTimeframe(Date.now() - 24 * 60 * 60 * 1_000)).toBe("15m");
    expect(autoTimeframe(Date.now() - 8 * 24 * 60 * 60 * 1_000)).toBe("1h");
    expect(autoTimeframe(Date.now() - 30 * 24 * 60 * 60 * 1_000)).toBe("4h");
  });

  it("renders candles and volume into a Telegram PNG", async () => {
    const scan: TokenScan = {
      token: { address: getAddress("0x3333333333333333333333333333333333333333"), name: "KapiScout", symbol: "KAPI", decimals: 18, totalSupplyRaw: 1_000_000n * 10n ** 18n, holdersCount: 4200, iconUrl: null },
      market: { pairAddress: "0xpool", dexId: "uniswap", pairUrl: null, quoteSymbol: "WETH", priceUsd: 0.004, marketCapUsd: 400_000, fdvUsd: 400_000, liquidityUsd: 80_000, volume24hUsd: 120_000, priceChange1h: 4, priceChange24h: 20, buys1h: 20, sells1h: 10, buys24h: 200, sells24h: 100, pairCreatedAt: Date.now() - 86_400_000, websites: [], socials: [], dexPaid: true },
      holders: { top10Percent: 32, holders: [] }, verified: true, creator: null, warnings: [], scannedAt: Date.now(),
    };
    const now = Date.now();
    const candles: Candle[] = Array.from({ length: 40 }, (_, index) => ({
      timestamp: now - (39 - index) * 900_000,
      open: 0.003 + index * 0.00002,
      high: 0.0031 + index * 0.00002,
      low: 0.0029 + index * 0.00002,
      close: 0.00305 + index * 0.00002,
      volume: 1_000 + index * 30,
    }));
    const image = await generateChartCard(scan, candles, "15m", "market_cap", null);
    const metadata = await sharp(image).metadata();
    expect(metadata.width).toBe(1280);
    expect(metadata.height).toBe(720);
    expect(metadata.format).toBe("png");
  });
});
