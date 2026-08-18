import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress } from "viem";
import {
  generateDashboardCard,
  generateGroupSummaryCard,
  generatePaperLeaderboardCard,
  generatePaperPortfolioCard,
  generatePnlCard,
  generateTokenCard,
  generateWalletAlertCard,
} from "../src/card.js";
import { generateChartCard } from "../src/chart.js";
import type { Candle, TokenScan } from "../src/types.js";

async function main() {
  const outDir = resolve(process.cwd(), "output/previews");
  await mkdir(outDir, { recursive: true });

  const scan: TokenScan = {
    token: {
      address: getAddress("0x16003ff072a0758e06e1598d578c8745e8cc7777"),
      name: "Kapiscout",
      symbol: "KAPI",
      decimals: 18,
      totalSupplyRaw: 1_000_000n * 10n ** 18n,
      holdersCount: 4280,
      iconUrl: null,
    },
    market: {
      pairAddress: getAddress("0x4444444444444444444444444444444444444444"),
      dexId: "uniswap",
      pairUrl: "https://dexscreener.com/robinhood/kapi",
      quoteSymbol: "WETH",
      priceUsd: 0.04285,
      marketCapUsd: 428_500,
      fdvUsd: 428_500,
      liquidityUsd: 142_000,
      volume24hUsd: 285_000,
      priceChange1h: 6.8,
      priceChange24h: 38.4,
      buys1h: 64,
      sells1h: 18,
      buys24h: 480,
      sells24h: 142,
      pairCreatedAt: Date.now() - 3 * 86_400_000,
      websites: ["https://kapiscout.com"],
      socials: [{ type: "telegram", url: "https://t.me/kapiscout" }],
      dexPaid: true,
    },
    holders: {
      top10Percent: 24.8,
      holders: [],
    },
    verified: true,
    creator: null,
    warnings: [],
    scannedAt: Date.now(),
  };

  const call = {
    id: 1,
    chatId: "100",
    messageId: 10,
    userId: "200",
    username: "scout_master",
    tokenAddress: scan.token.address,
    symbol: "KAPI",
    calledAt: Date.now() - 4 * 3600 * 1000,
    entryPriceUsd: 0.0125,
    entryMarketCapUsd: 125_000,
    athPriceUsd: 0.0625,
    athMarketCapUsd: 625_000,
    athAt: Date.now() - 3600 * 1000,
    status: "ACTIVE" as const,
  };

  console.log("Generating Dashboard Card...");
  const dashBuf = await generateDashboardCard();
  await writeFile(resolve(outDir, "01_dashboard.png"), dashBuf);

  console.log("Generating Token Scan Card...");
  const tokenBuf = await generateTokenCard(scan);
  await writeFile(resolve(outDir, "02_token_scan.png"), tokenBuf);

  console.log("Generating Candlestick Chart Card...");
  const now = Date.now();
  const candles: Candle[] = Array.from({ length: 48 }, (_, i) => {
    const base = 0.02 + (i / 48) * 0.022 + Math.sin(i / 3) * 0.003;
    return {
      timestamp: now - (47 - i) * 15 * 60 * 1000,
      open: base,
      high: base + 0.0015,
      low: base - 0.0012,
      close: base + (i % 2 === 0 ? 0.0008 : -0.0006),
      volume: 1200 + Math.floor(Math.random() * 4000),
    };
  });
  const chartBuf = await generateChartCard(scan, candles, "15m", "market_cap", call);
  await writeFile(resolve(outDir, "03_chart.png"), chartBuf);

  console.log("Generating PnL Card...");
  const pnlBuf = await generatePnlCard(call, scan);
  await writeFile(resolve(outDir, "04_pnl.png"), pnlBuf);

  console.log("Generating Group Summary Card...");
  const stats = [
    { username: "scout_master", totalCalls: 12, positiveCalls: 10, bestMultiple: 8.42, winRate: 0.83 },
    { username: "robin_hoodler", totalCalls: 8, positiveCalls: 6, bestMultiple: 4.80, winRate: 0.75 },
    { username: "capy_trader", totalCalls: 6, positiveCalls: 4, bestMultiple: 3.25, winRate: 0.66 },
  ];
  const groupBuf = await generateGroupSummaryCard("Robinhood Alpha Lounge", stats, [call]);
  await writeFile(resolve(outDir, "05_group_summary.png"), groupBuf);

  console.log("Generating Smart Money Buy Alert Card...");
  const buyBuf = await generateWalletAlertCard({
    scan,
    label: "Top Robinhood Whale #1",
    isKol: true,
    walletAddress: getAddress("0x71C8fb8663675f0a00085F09BcdAC300e8cc7777"),
    direction: "BUY",
    symbol: "KAPI",
    tokenAmount: 850_000,
    valueUsd: 36_422.50,
    priceUsd: 0.04285,
    marketCapUsd: 428_500,
    liquidityUsd: 142_000,
  });
  await writeFile(resolve(outDir, "06_wallet_buy_alert.png"), buyBuf);

  console.log("Generating Smart Money Sell Alert Card...");
  const sellBuf = await generateWalletAlertCard({
    scan,
    label: "Deployer Wallet",
    isKol: false,
    walletAddress: getAddress("0x9999999999999999999999999999999999999999"),
    direction: "SELL",
    symbol: "KAPI",
    tokenAmount: 200_000,
    valueUsd: 8_570.00,
    priceUsd: 0.04285,
    marketCapUsd: 428_500,
    liquidityUsd: 142_000,
  });
  await writeFile(resolve(outDir, "07_wallet_sell_alert.png"), sellBuf);

  console.log("Generating Paper Portfolio Card...");
  const competition = {
    id: 1,
    chatId: "100",
    name: "Robinhood Scout Championship",
    startingBalanceUsd: 10_000,
    startsAt: Date.now() - 86_400_000,
    endsAt: Date.now() + 86_400_000,
    status: "ACTIVE" as const,
    createdBy: "admin",
    createdAt: Date.now() - 86_400_000,
  };
  const account = {
    competitionId: 1,
    userId: "200",
    username: "scout_master",
    cashBalanceUsd: 4_250,
    startingBalanceUsd: 10_000,
    realizedPnlUsd: 820,
    wins: 4,
    losses: 1,
    finalEquityUsd: null,
    finalPnlUsd: null,
    finalRank: null,
    joinedAt: Date.now() - 86_400_000,
    updatedAt: Date.now(),
  };
  const portfolioBuf = await generatePaperPortfolioCard({
    competition,
    account,
    positions: [
      {
        competitionId: 1,
        userId: "200",
        tokenAddress: scan.token.address,
        symbol: "KAPI",
        tokenAmount: 150_000,
        costBasisUsd: 4_500,
        averageEntryPriceUsd: 0.030,
        updatedAt: Date.now(),
        liquidationValueUsd: 6_420,
        gasCostUsd: 1.20,
        unrealizedPnlUsd: 1_920,
        currentExecutionPriceUsd: 0.0428,
        priceImpactPercent: 0.8,
        quoteAvailable: true,
      },
    ],
    cashBalanceUsd: 4_250,
    positionsValueUsd: 6_420,
    equityUsd: 10_670,
    totalPnlUsd: 2_740,
    returnPercent: 27.4,
    rank: 1,
    participants: 48,
    refreshedAt: Date.now(),
  });
  await writeFile(resolve(outDir, "08_paper_portfolio.png"), portfolioBuf);

  console.log("Generating Paper Leaderboard Card...");
  const lbBuf = await generatePaperLeaderboardCard(competition, [
    { userId: "200", username: "scout_master", equityUsd: 12_740, pnlUsd: 2_740, returnPercent: 27.4, wins: 4, losses: 1, openPositions: 1 },
    { userId: "201", username: "robin_hoodler", equityUsd: 11_820, pnlUsd: 1_820, returnPercent: 18.2, wins: 3, losses: 1, openPositions: 2 },
    { userId: "202", username: "capy_trader", equityUsd: 11_150, pnlUsd: 1_150, returnPercent: 11.5, wins: 2, losses: 0, openPositions: 1 },
    { userId: "203", username: "trench_runner", equityUsd: 10_400, pnlUsd: 400, returnPercent: 4.0, wins: 1, losses: 1, openPositions: 3 },
    { userId: "204", username: "moon_scout", equityUsd: 9_650, pnlUsd: -350, returnPercent: -3.5, wins: 1, losses: 2, openPositions: 1 },
  ]);
  await writeFile(resolve(outDir, "09_paper_leaderboard.png"), lbBuf);

  console.log("All 9 preview cards generated successfully in output/previews!");
}

main().catch(console.error);
