import type { Address } from "viem";
import type { MarketSnapshot } from "./types.js";

interface DexPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string | null;
  txns?: { h1?: { buys?: number; sells?: number }; h24?: { buys?: number; sells?: number } };
  volume?: { h24?: number };
  priceChange?: { h1?: number; h24?: number };
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number | null;
  marketCap?: number | null;
  pairCreatedAt?: number;
  info?: {
    websites?: Array<{ url?: string }>;
    socials?: Array<{ platform?: string; handle?: string }>;
  };
}

interface DexOrder { status?: string }

const emptyMarket = (): MarketSnapshot => ({
  pairAddress: null,
  dexId: null,
  pairUrl: null,
  quoteSymbol: null,
  quoteAddress: null,
  priceUsd: null,
  marketCapUsd: null,
  fdvUsd: null,
  liquidityUsd: null,
  volume24hUsd: null,
  priceChange1h: null,
  priceChange24h: null,
  buys1h: null,
  sells1h: null,
  buys24h: null,
  sells24h: null,
  pairCreatedAt: null,
  websites: [],
  socials: [],
  dexPaid: null,
});

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class MarketClient {
  constructor(private readonly chainId: string) {}

  async getBestMarket(tokenAddress: Address): Promise<MarketSnapshot> {
    const [pairs, orders] = await Promise.all([
      this.getPairs(tokenAddress),
      this.getOrders(tokenAddress).catch(() => null),
    ]);
    if (!Array.isArray(pairs) || pairs.length === 0) return emptyMarket();

    const requested = tokenAddress.toLowerCase();
    const basePairs = pairs.filter((pair) => pair.baseToken?.address?.toLowerCase() === requested);
    if (!basePairs.length) return emptyMarket();
    const best = [...basePairs].sort(
      (a, b) => (finiteNumber(b.liquidity?.usd) ?? 0) - (finiteNumber(a.liquidity?.usd) ?? 0),
    )[0];
    if (!best) return emptyMarket();

    return {
      pairAddress: best.pairAddress ?? null,
      dexId: best.dexId ?? null,
      pairUrl: best.url ?? null,
      quoteSymbol: best.quoteToken?.symbol ?? null,
      quoteAddress: best.quoteToken?.address && /^0x[a-fA-F0-9]{40}$/u.test(best.quoteToken.address)
        ? best.quoteToken.address as Address
        : null,
      priceUsd: finiteNumber(best.priceUsd),
      marketCapUsd: finiteNumber(best.marketCap),
      fdvUsd: finiteNumber(best.fdv),
      liquidityUsd: finiteNumber(best.liquidity?.usd),
      volume24hUsd: finiteNumber(best.volume?.h24),
      priceChange1h: finiteNumber(best.priceChange?.h1),
      priceChange24h: finiteNumber(best.priceChange?.h24),
      buys1h: finiteNumber(best.txns?.h1?.buys),
      sells1h: finiteNumber(best.txns?.h1?.sells),
      buys24h: finiteNumber(best.txns?.h24?.buys),
      sells24h: finiteNumber(best.txns?.h24?.sells),
      pairCreatedAt: finiteNumber(best.pairCreatedAt),
      websites: (best.info?.websites ?? []).flatMap((item) => item.url ? [item.url] : []),
      socials: (best.info?.socials ?? []).flatMap((item) =>
        item.platform && item.handle ? [{ platform: item.platform, handle: item.handle }] : [],
      ),
      dexPaid: orders == null ? null : orders.some((order) => order.status === "approved"),
    };
  }

  private async getPairs(tokenAddress: Address): Promise<DexPair[]> {
    const directUrl = `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(this.chainId)}/${tokenAddress}`;
    try {
      const direct = await fetchJsonWithRetry<DexPair[]>(directUrl);
      if (Array.isArray(direct) && direct.length) return direct;
    } catch (error) {
      console.warn("DEX Screener token-pairs request failed; trying search fallback", error);
    }
    const search = await fetchJsonWithRetry<{ pairs?: DexPair[] }>(
      `https://api.dexscreener.com/latest/dex/search?q=${tokenAddress}`,
    );
    return (search.pairs ?? []).filter((pair) => pair.chainId === this.chainId);
  }

  private async getOrders(tokenAddress: Address): Promise<DexOrder[]> {
    const payload = await fetchJsonWithRetry<DexOrder[] | { orders?: DexOrder[] }>(
      `https://api.dexscreener.com/orders/v1/${encodeURIComponent(this.chainId)}/${tokenAddress}`,
      1,
    );
    return Array.isArray(payload) ? payload : payload.orders ?? [];
  }
}

async function fetchJsonWithRetry<T>(url: string, retries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "KapiScout/0.1" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("DEX Screener request failed");
}
