import type { CallRecord, MarketHistoryPoint, RealityReport, TokenScan } from "./types.js";

const EXIT_SIZES = [100, 500, 1_000, 10_000];
const DEFAULT_NOTIONAL = 1_000;
const SWAP_FEE = 0.003;

/**
 * A conservative constant-product estimate derived from the pool's reported USD
 * liquidity. It is explicitly presented as an estimate because concentrated
 * liquidity and transfer-tax tokens require a live router quote for exact output.
 */
export function estimateExit(sellValueUsd: number, liquidityUsd: number | null): { receivedUsd: number | null; impactPercent: number | null } {
  if (!Number.isFinite(sellValueUsd) || sellValueUsd <= 0 || liquidityUsd == null || liquidityUsd <= 0) {
    return { receivedUsd: null, impactPercent: null };
  }
  const quoteReserveUsd = liquidityUsd / 2;
  const effectiveInput = sellValueUsd * (1 - SWAP_FEE);
  const receivedUsd = quoteReserveUsd * effectiveInput / (quoteReserveUsd + effectiveInput);
  const impactPercent = Math.max(0, (1 - receivedUsd / sellValueUsd) * 100);
  return { receivedUsd, impactPercent };
}

export function buildRealityReport(scan: TokenScan, call: CallRecord | null, notionalUsd = DEFAULT_NOTIONAL): RealityReport {
  const marketCap = scan.market.marketCapUsd ?? scan.market.fdvUsd;
  const liquidity = scan.market.liquidityUsd;
  const quotes = EXIT_SIZES.map((size) => ({ notionalUsd: size, ...estimateExit(size, liquidity) }));
  const headlineMultiple = call?.entryMarketCapUsd && marketCap
    ? marketCap / call.entryMarketCapUsd
    : null;
  const realMultiple = estimateRealMultiple(call, marketCap, liquidity, notionalUsd);
  const liquidityToMarketCapPercent = liquidity != null && marketCap != null && marketCap > 0
    ? liquidity / marketCap * 100
    : null;
  const exitScore = calculateExitScore(scan, quotes.find((quote) => quote.notionalUsd === DEFAULT_NOTIONAL)?.impactPercent ?? null);
  const warnings: string[] = [];
  if (liquidity == null || liquidity <= 0) warnings.push("No usable liquidity is indexed");
  if (quotes[2]?.impactPercent != null && quotes[2].impactPercent > 20) warnings.push("A $1K exit has severe estimated price impact");
  if (liquidityToMarketCapPercent != null && liquidityToMarketCapPercent < 2) warnings.push("Liquidity is below 2% of market cap");
  if (scan.holders.top10Percent != null && scan.holders.top10Percent > 50) warnings.push("Holder concentration can amplify exits");
  if (!scan.verified) warnings.push("Contract source is unverified");
  return {
    exitScore,
    grade: scoreGrade(exitScore),
    quotes,
    headlineMultiple,
    realMultiple,
    notionalUsd,
    liquidityToMarketCapPercent,
    warnings,
  };
}

export function estimateRealMultiple(
  call: CallRecord | null,
  currentMarketCapUsd: number | null,
  currentLiquidityUsd: number | null,
  notionalUsd = DEFAULT_NOTIONAL,
): number | null {
  if (!call?.entryMarketCapUsd || !currentMarketCapUsd || !call.entryLiquidityUsd || !currentLiquidityUsd) return null;
  const headline = currentMarketCapUsd / call.entryMarketCapUsd;
  const entryReserve = call.entryLiquidityUsd / 2;
  const effectiveBuy = notionalUsd * (1 - SWAP_FEE);
  const acquiredEntryValue = entryReserve * effectiveBuy / (entryReserve + effectiveBuy);
  const currentPositionValue = acquiredEntryValue * headline;
  const exit = estimateExit(currentPositionValue, currentLiquidityUsd);
  return exit.receivedUsd == null ? null : exit.receivedUsd / notionalUsd;
}

export function summarizeLiquidityHistory(points: MarketHistoryPoint[]): {
  samples: number;
  firstUsd: number | null;
  currentUsd: number | null;
  lowUsd: number | null;
  highUsd: number | null;
  largestDropPercent: number | null;
} {
  const values = points.flatMap((point) => point.liquidityUsd != null && point.liquidityUsd >= 0 ? [point.liquidityUsd] : []);
  let largestDropPercent: number | null = null;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous == null || current == null || previous <= 0 || current >= previous) continue;
    const drop = (previous - current) / previous * 100;
    largestDropPercent = Math.max(largestDropPercent ?? 0, drop);
  }
  return {
    samples: values.length,
    firstUsd: values[0] ?? null,
    currentUsd: values.at(-1) ?? null,
    lowUsd: values.length ? Math.min(...values) : null,
    highUsd: values.length ? Math.max(...values) : null,
    largestDropPercent,
  };
}

function calculateExitScore(scan: TokenScan, thousandImpact: number | null): number | null {
  const liquidity = scan.market.liquidityUsd;
  const marketCap = scan.market.marketCapUsd ?? scan.market.fdvUsd;
  if (liquidity == null || liquidity <= 0) return 0;
  let score = 100;
  if (thousandImpact != null) score -= Math.min(50, thousandImpact * 1.25);
  if (marketCap && marketCap > 0) {
    const ratio = liquidity / marketCap;
    if (ratio < 0.01) score -= 25;
    else if (ratio < 0.03) score -= 15;
    else if (ratio < 0.08) score -= 7;
  }
  if (scan.holders.top10Percent != null) score -= Math.max(0, scan.holders.top10Percent - 30) * 0.35;
  if (!scan.verified) score -= 8;
  const trades = (scan.market.buys1h ?? 0) + (scan.market.sells1h ?? 0);
  if (trades === 0) score -= 7;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreGrade(score: number | null): RealityReport["grade"] {
  if (score == null) return "N/A";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 35) return "D";
  return "F";
}
