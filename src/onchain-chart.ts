import { parseAbi, type Address, type PublicClient } from "viem";
import type { Candle, ChartTimeframe } from "./types.js";

/**
 * Builds candles straight from pool events when no indexer has the token.
 *
 * GeckoTerminal only covers DEXes it has integrated, so freshly launched
 * Robinhood Chain pairs (and anything on a smaller DEX like flapsh) return no
 * OHLCV at all. Uniswap-V2-style pools emit Sync(reserve0, reserve1) after
 * every trade, which is a complete price history — this reconstructs the
 * series from those logs.
 */

// Sync(uint112 reserve0, uint112 reserve1)
const SYNC_TOPIC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";
// Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)
const SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const erc20Abi = parseAbi(["function decimals() view returns (uint8)"]);

const bucketMs: Record<Exclude<ChartTimeframe, "auto">, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Newer pools need finer buckets than the indexer-backed default. */
export function onchainTimeframe(pairCreatedAt: number | null): Exclude<ChartTimeframe, "auto"> {
  if (!pairCreatedAt) return "15m";
  const age = Date.now() - pairCreatedAt;
  if (age < 45 * 60_000) return "1m";
  if (age < 6 * 60 * 60_000) return "5m";
  if (age < 2 * 24 * 60 * 60_000) return "15m";
  if (age < 14 * 24 * 60 * 60_000) return "1h";
  return "4h";
}

function word(data: `0x${string}`, index: number): bigint {
  const body = data.slice(2);
  const chunk = body.slice(index * 64, (index + 1) * 64);
  return chunk ? BigInt(`0x${chunk}`) : 0n;
}

function scaled(value: bigint, decimals: number): number {
  // Keep precision for tiny balances by dividing in floating point.
  return Number(value) / 10 ** decimals;
}

export interface OnchainSeries {
  candles: Candle[];
  timeframe: Exclude<ChartTimeframe, "auto">;
  pairAddress: string;
}

export interface OnchainSeriesOptions {
  client: PublicClient;
  pairAddress: Address;
  tokenAddress: Address;
  timeframe: ChartTimeframe;
  /** Current USD price, used to anchor the reserve ratio series to dollars. */
  currentPriceUsd: number | null;
  pairCreatedAt: number | null;
  /** Upper bound on how many blocks to scan, keeping the request bounded. */
  maxBlocks?: bigint;
}

/**
 * Returns null (rather than throwing) whenever the pool is not a V2-style pair
 * or has too little history to plot, so callers can fall through to their own
 * "no chart" handling.
 */
export async function onchainCandles(options: OnchainSeriesOptions): Promise<OnchainSeries | null> {
  const { client, pairAddress, tokenAddress, currentPriceUsd } = options;
  const maxBlocks = options.maxBlocks ?? 900_000n;

  let token0: Address;
  let token1: Address;
  try {
    [token0, token1] = await Promise.all([
      client.readContract({ address: pairAddress, abi: pairAbi, functionName: "token0" }),
      client.readContract({ address: pairAddress, abi: pairAbi, functionName: "token1" }),
    ]);
  } catch {
    return null; // Not a V2-style pair (v3/v4 pools have no token0/token1 pair ABI here).
  }

  const tokenIsZero = token0.toLowerCase() === tokenAddress.toLowerCase();
  const quoteToken = tokenIsZero ? token1 : token0;
  if (!tokenIsZero && token1.toLowerCase() !== tokenAddress.toLowerCase()) return null;

  const [tokenDecimals, quoteDecimals] = await Promise.all([
    client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    client.readContract({ address: quoteToken, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
  ]);

  const latestBlock = await client.getBlockNumber();
  const fromBlock = latestBlock > maxBlocks ? latestBlock - maxBlocks : 0n;

  // One query, split locally: two filtered calls would double the RPC cost.
  const allLogs = await client
    .getLogs({ address: pairAddress, fromBlock, toBlock: latestBlock })
    .catch(() => []);
  const syncLogs = allLogs.filter((log) => log.topics[0] === SYNC_TOPIC);
  const swapLogs = allLogs.filter((log) => log.topics[0] === SWAP_TOPIC);

  if (syncLogs.length < 2) return null;

  // Block timestamps one-by-one would be hundreds of round trips. The chain has
  // a near-constant block time, so anchor on a few real blocks and interpolate.
  const blocks = syncLogs.map((log) => log.blockNumber ?? 0n).filter((value) => value > 0n);
  const first = blocks[0]!;
  const last = blocks[blocks.length - 1]!;
  const [firstBlock, lastBlock] = await Promise.all([
    client.getBlock({ blockNumber: first }),
    client.getBlock({ blockNumber: last }),
  ]);
  const span = Number(last - first);
  const secondsPerBlock = span > 0
    ? Number(lastBlock.timestamp - firstBlock.timestamp) / span
    : 1;
  const timestampFor = (block: bigint): number =>
    (Number(firstBlock.timestamp) + Number(block - first) * secondsPerBlock) * 1_000;

  // Reserve ratio = how much quote each token is worth, in token terms.
  const points = syncLogs.flatMap((log) => {
    const reserve0 = word(log.data as `0x${string}`, 0);
    const reserve1 = word(log.data as `0x${string}`, 1);
    if (reserve0 === 0n || reserve1 === 0n) return [];
    const tokenReserve = scaled(tokenIsZero ? reserve0 : reserve1, tokenDecimals);
    const quoteReserve = scaled(tokenIsZero ? reserve1 : reserve0, quoteDecimals);
    if (!(tokenReserve > 0) || !(quoteReserve > 0)) return [];
    return [{ timestamp: timestampFor(log.blockNumber ?? first), ratio: quoteReserve / tokenReserve }];
  });
  if (points.length < 2) return null;

  // The ratio is denominated in the quote token; rescale so the newest point
  // equals the USD price the scan already reports.
  const latestRatio = points[points.length - 1]!.ratio;
  const factor = currentPriceUsd && latestRatio > 0 ? currentPriceUsd / latestRatio : 1;
  const quoteUsd = currentPriceUsd && latestRatio > 0 ? currentPriceUsd / latestRatio : 0;

  // Per-bucket USD volume from the quote side of each swap.
  const volumeByBucket = new Map<number, number>();
  const selected = options.timeframe === "auto"
    ? onchainTimeframe(options.pairCreatedAt)
    : options.timeframe;
  const size = bucketMs[selected];

  for (const log of swapLogs) {
    const data = log.data as `0x${string}`;
    const amount0In = word(data, 0);
    const amount1In = word(data, 1);
    const amount0Out = word(data, 2);
    const amount1Out = word(data, 3);
    const quoteIn = tokenIsZero ? amount1In : amount0In;
    const quoteOut = tokenIsZero ? amount1Out : amount0Out;
    const quoteAmount = scaled(quoteIn + quoteOut, quoteDecimals);
    if (!(quoteAmount > 0)) continue;
    const bucket = Math.floor(timestampFor(log.blockNumber ?? first) / size) * size;
    volumeByBucket.set(bucket, (volumeByBucket.get(bucket) ?? 0) + quoteAmount * quoteUsd);
  }

  const byBucket = new Map<number, Candle>();
  for (const point of points) {
    const price = point.ratio * factor;
    if (!Number.isFinite(price) || price <= 0) continue;
    const bucket = Math.floor(point.timestamp / size) * size;
    const existing = byBucket.get(bucket);
    if (!existing) {
      byBucket.set(bucket, { timestamp: bucket, open: price, high: price, low: price, close: price, volume: 0 });
      continue;
    }
    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.close = price;
  }

  const candles = [...byBucket.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-120)
    .map((candle) => ({ ...candle, volume: volumeByBucket.get(candle.timestamp) ?? 0 }));

  if (candles.length < 2) return null;
  return { candles, timeframe: selected, pairAddress };
}
