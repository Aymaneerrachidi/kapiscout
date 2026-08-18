import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { generateDashboardCard, generatePaperLeaderboardCard, generatePaperPortfolioCard, generateTokenCard, generateWalletAlertCard } from "../src/card.js";
import type { TokenScan } from "../src/types.js";

describe("Telegram image card", () => {
  it("renders a 1280x720 PNG", async () => {
    const scan: TokenScan = {
      token: {
        address: getAddress("0x3333333333333333333333333333333333333333"),
        name: "KapiScout",
        symbol: "KAPI",
        decimals: 18,
        totalSupplyRaw: 1_000_000n * 10n ** 18n,
        holdersCount: 4200,
        iconUrl: null,
      },
      market: {
        pairAddress: getAddress("0x4444444444444444444444444444444444444444"),
        dexId: "uniswap",
        pairUrl: "https://dexscreener.com/robinhood/test",
        quoteSymbol: "WETH",
        priceUsd: 0.0042,
        marketCapUsd: 420_000,
        fdvUsd: 420_000,
        liquidityUsd: 82_000,
        volume24hUsd: 120_000,
        priceChange1h: 4.2,
        priceChange24h: 23.5,
        buys1h: 42,
        sells1h: 12,
        buys24h: 321,
        sells24h: 98,
        pairCreatedAt: Date.now() - 3_600_000,
        websites: [],
        socials: [],
        dexPaid: true,
      },
      holders: { top10Percent: 31.4, holders: [] },
      verified: true,
      creator: null,
      warnings: [],
      scannedAt: Date.now(),
    };
    const buffer = await generateTokenCard(scan);
    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1280);
    expect(metadata.height).toBe(720);
  });

  it("renders dashboard and wallet alert cards", async () => {
    const dashboard = await generateDashboardCard();
    expect((await sharp(dashboard).metadata()).width).toBe(1280);
    const alert = await generateWalletAlertCard({
      scan: null,
      label: "Smart Ape",
      isKol: true,
      walletAddress: getAddress("0x1111111111111111111111111111111111111111"),
      direction: "BUY",
      symbol: "KAPI",
      tokenAmount: 1_250_000,
      valueUsd: 4_200,
      priceUsd: 0.00336,
      marketCapUsd: 3_360_000,
      liquidityUsd: 220_000,
    });
    const metadata = await sharp(alert).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1280);
    expect(metadata.height).toBe(720);
  });

  it("renders paper balance and competition leaderboard cards", async () => {
    const competition={id:1,chatId:"1",name:"Kapi Cup",startingBalanceUsd:10_000,startsAt:Date.now(),endsAt:Date.now()+86_400_000,status:"ACTIVE" as const,createdBy:"1",createdAt:Date.now()};
    const account={competitionId:1,userId:"2",username:"@scout",cashBalanceUsd:8_000,startingBalanceUsd:10_000,realizedPnlUsd:100,wins:2,losses:1,finalEquityUsd:null,finalPnlUsd:null,finalRank:null,joinedAt:Date.now(),updatedAt:Date.now()};
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const balance=await generatePaperPortfolioCard({competition,account,positions:[{competitionId:1,userId:"2",tokenAddress:token,symbol:"KAPI",tokenAmount:1_000,costBasisUsd:2_000,averageEntryPriceUsd:2,updatedAt:Date.now(),liquidationValueUsd:2_500,gasCostUsd:1,unrealizedPnlUsd:500,currentExecutionPriceUsd:2.5,priceImpactPercent:1,quoteAvailable:true}],cashBalanceUsd:8_000,positionsValueUsd:2_500,equityUsd:10_500,totalPnlUsd:500,returnPercent:5,rank:1,participants:3,refreshedAt:Date.now()});
    const leaderboard=await generatePaperLeaderboardCard(competition,[{userId:"2",username:"@scout",equityUsd:10_500,pnlUsd:500,returnPercent:5,wins:2,losses:1,openPositions:1}]);
    expect((await sharp(balance).metadata()).width).toBe(1280);
    expect((await sharp(leaderboard).metadata()).height).toBe(720);
  });
});
