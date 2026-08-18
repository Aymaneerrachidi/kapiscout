import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import type { Address } from "viem";
import type { CallRecord, Candle, ChartMetric, ChartTimeframe, MarketSnapshot, TokenScan } from "./types.js";
import { compactAddress, formatAge, formatCompactNumber, formatUsd } from "./utils.js";

interface GeckoOhlcvResponse {
  data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } };
}

interface GeckoPoolsResponse {
  data?: Array<{ attributes?: {
    address?: string;
    reserve_in_usd?: string;
    pool_created_at?: string;
    base_token_price_usd?: string;
    market_cap_usd?: string | null;
    fdv_usd?: string | null;
    volume_usd?: { h24?: string };
    price_change_percentage?: { h1?: string; h24?: string };
    transactions?: { h1?: { buys?: number; sells?: number }; h24?: { buys?: number; sells?: number } };
  } }>;
}

export interface ChartSeries {
  candles: Candle[];
  timeframe: Exclude<ChartTimeframe, "auto">;
  pairAddress: string;
  marketFallback?: Partial<MarketSnapshot>;
}

const chartSpecs: Record<Exclude<ChartTimeframe, "auto">, { unit: "minute" | "hour" | "day"; aggregate: number; limit: number }> = {
  "1m": { unit: "minute", aggregate: 1, limit: 120 },
  "5m": { unit: "minute", aggregate: 5, limit: 120 },
  "15m": { unit: "minute", aggregate: 15, limit: 120 },
  "1h": { unit: "hour", aggregate: 1, limit: 120 },
  "4h": { unit: "hour", aggregate: 4, limit: 120 },
  "1d": { unit: "day", aggregate: 1, limit: 120 },
};

let mascotDataUrl: Promise<string> | null = null;

export class ChartClient {
  private readonly cache = new Map<string, { expiresAt: number; value: ChartSeries }>();

  constructor(private readonly network = "robinhood") {}

  async candles(pairAddress: string, timeframe: ChartTimeframe, pairCreatedAt: number | null): Promise<ChartSeries> {
    const selected = timeframe === "auto" ? autoTimeframe(pairCreatedAt) : timeframe;
    const key = `${pairAddress.toLowerCase()}:${selected}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const spec = chartSpecs[selected];
    const url = new URL(`https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(this.network)}/pools/${encodeURIComponent(pairAddress)}/ohlcv/${spec.unit}`);
    url.searchParams.set("aggregate", String(spec.aggregate));
    url.searchParams.set("limit", String(spec.limit));
    url.searchParams.set("currency", "usd");
    const payload = await fetchJson<GeckoOhlcvResponse>(url.toString());
    const candles = (payload.data?.attributes?.ohlcv_list ?? []).flatMap((row) => {
      const [timestamp, open, high, low, close, volume] = row;
      if (![timestamp, open, high, low, close, volume].every(Number.isFinite)) return [];
      return [{ timestamp: timestamp * 1_000, open, high, low, close, volume }];
    }).sort((a, b) => a.timestamp - b.timestamp);
    if (candles.length < 2) throw new Error("Chart history is not available for this pool yet.");
    const value = { candles, timeframe: selected, pairAddress };
    this.cache.set(key, { expiresAt: Date.now() + 20_000, value });
    return value;
  }

  async candlesForToken(tokenAddress: Address | string, timeframe: ChartTimeframe): Promise<ChartSeries> {
    const url = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(this.network)}/tokens/${encodeURIComponent(tokenAddress)}/pools?page=1`;
    const payload = await fetchJson<GeckoPoolsResponse>(url);
    const pool = [...(payload.data ?? [])].sort((a, b) => Number(b.attributes?.reserve_in_usd ?? 0) - Number(a.attributes?.reserve_in_usd ?? 0))[0];
    const pairAddress = pool?.attributes?.address;
    if (!pairAddress) throw new Error("No chart pool is indexed for this token yet.");
    const created = pool.attributes?.pool_created_at ? Date.parse(pool.attributes.pool_created_at) : null;
    const series = await this.candles(pairAddress, timeframe, Number.isFinite(created) ? created : null);
    const attributes = pool.attributes;
    return {
      ...series,
      marketFallback: {
        pairAddress,
        priceUsd: finite(attributes?.base_token_price_usd),
        marketCapUsd: finite(attributes?.market_cap_usd),
        fdvUsd: finite(attributes?.fdv_usd),
        liquidityUsd: finite(attributes?.reserve_in_usd),
        volume24hUsd: finite(attributes?.volume_usd?.h24),
        priceChange1h: finite(attributes?.price_change_percentage?.h1),
        priceChange24h: finite(attributes?.price_change_percentage?.h24),
        buys1h: finite(attributes?.transactions?.h1?.buys),
        sells1h: finite(attributes?.transactions?.h1?.sells),
        buys24h: finite(attributes?.transactions?.h24?.buys),
        sells24h: finite(attributes?.transactions?.h24?.sells),
        pairCreatedAt: Number.isFinite(created) ? created : null,
      },
    };
  }
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function autoTimeframe(pairCreatedAt: number | null): Exclude<ChartTimeframe, "auto"> {
  if (!pairCreatedAt) return "1h";
  const age = Date.now() - pairCreatedAt;
  if (age < 6 * 60 * 60 * 1_000) return "5m";
  if (age < 2 * 24 * 60 * 60 * 1_000) return "15m";
  if (age < 14 * 24 * 60 * 60 * 1_000) return "1h";
  if (age < 90 * 24 * 60 * 60 * 1_000) return "4h";
  return "1d";
}

export async function generateChartCard(
  scan: TokenScan,
  candles: Candle[],
  timeframe: Exclude<ChartTimeframe, "auto">,
  metric: ChartMetric,
  call: CallRecord | null,
): Promise<Buffer> {
  const mascotUrl = await mascot();
  const currentMc = scan.market.marketCapUsd ?? scan.market.fdvUsd;
  const factor = metric === "market_cap" && scan.market.priceUsd && currentMc
    ? currentMc / scan.market.priceUsd
    : 1;
  const normalized = candles.map((candle) => ({
    ...candle,
    open: candle.open * factor,
    high: candle.high * factor,
    low: candle.low * factor,
    close: candle.close * factor,
  }));
  const plot = { x: 70, y: 174, width: 1140, height: 350 };
  const volume = { y: 546, height: 78 };
  const min = Math.min(...normalized.map((item) => item.low));
  const max = Math.max(...normalized.map((item) => item.high));
  const range = Math.max(max - min, Math.abs(max) * 0.001, 1e-12);
  const paddedMin = min - range * 0.08;
  const paddedMax = max + range * 0.08;
  const paddedRange = paddedMax - paddedMin;
  const maxVolume = Math.max(...normalized.map((item) => item.volume), 1);
  const step = plot.width / normalized.length;
  const bodyWidth = Math.max(2, Math.min(8, step * 0.62));
  const y = (value: number) => plot.y + ((paddedMax - value) / paddedRange) * plot.height;
  const x = (index: number) => plot.x + step * index + step / 2;

  const grid = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const gridY = plot.y + plot.height * ratio;
    const value = paddedMax - paddedRange * ratio;
    return `<line x1="${plot.x}" y1="${gridY}" x2="${plot.x + plot.width}" y2="${gridY}" stroke="#173426" stroke-width="1"/><text x="${plot.x + plot.width - 4}" y="${gridY - 7}" text-anchor="end" fill="#698273" font-family="Arial,sans-serif" font-size="13">${xml(formatAxis(value, metric))}</text>`;
  }).join("");

  const candleSvg = normalized.map((item, index) => {
    const color = item.close >= item.open ? "#00E86B" : "#FF5F68";
    const cx = x(index);
    const bodyTop = Math.min(y(item.open), y(item.close));
    const bodyHeight = Math.max(2, Math.abs(y(item.open) - y(item.close)));
    const volumeHeight = Math.max(1, (item.volume / maxVolume) * volume.height);
    return `<line x1="${cx}" y1="${y(item.high)}" x2="${cx}" y2="${y(item.low)}" stroke="${color}" stroke-width="1.5"/><rect x="${cx - bodyWidth / 2}" y="${bodyTop}" width="${bodyWidth}" height="${bodyHeight}" rx="1" fill="${color}"/><rect x="${cx - bodyWidth / 2}" y="${volume.y + volume.height - volumeHeight}" width="${bodyWidth}" height="${volumeHeight}" rx="1" fill="${color}" opacity="0.38"/>`;
  }).join("");

  const firstTimestamp = normalized[0]?.timestamp ?? 0;
  const lastTimestamp = normalized.at(-1)?.timestamp ?? 0;
  const callMarker = call ? marker(call, firstTimestamp, lastTimestamp, plot, normalized.length) : "";
  const latest = normalized.at(-1)?.close ?? null;
  const latestY = latest == null ? null : y(latest);
  const currentLine = latestY == null ? "" : `<line x1="${plot.x}" y1="${latestY}" x2="${plot.x + plot.width}" y2="${latestY}" stroke="#D9FFE9" stroke-width="1" stroke-dasharray="5 7" opacity="0.7"/><rect x="${plot.x + plot.width - 112}" y="${latestY - 14}" width="112" height="25" rx="6" fill="#D9FFE9"/><text x="${plot.x + plot.width - 8}" y="${latestY + 4}" text-anchor="end" fill="#062111" font-family="Arial,sans-serif" font-size="13" font-weight="800">${xml(formatAxis(latest ?? 0, metric))}</text>`;
  const change = scan.market.priceChange24h;
  const changeColor = (change ?? 0) >= 0 ? "#00E86B" : "#FF6670";
  const titleValue = metric === "market_cap" ? formatUsd(currentMc) : formatUsd(scan.market.priceUsd);
  const firstLabel = call ? `FIRST ${formatUsd(call.entryMarketCapUsd)} · ${call.username}` : "FIRST CALL PENDING";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <rect width="1280" height="720" fill="#06120C"/>
    <rect x="24" y="24" width="1232" height="672" rx="28" fill="#0A1B12" stroke="#1D432E" stroke-width="2"/>
    <rect x="24" y="24" width="8" height="672" rx="4" fill="#00E86B"/>
    <text x="70" y="72" fill="#00E86B" font-family="Arial,sans-serif" font-size="18" font-weight="900" letter-spacing="4">KAPISCOUT</text>
    <text x="70" y="126" fill="#F5F8F6" font-family="Arial,sans-serif" font-size="38" font-weight="900">${xml(scan.token.name)} <tspan fill="#809B8B" font-size="26">$${xml(scan.token.symbol)}</tspan></text>
    <text x="1210" y="75" text-anchor="end" fill="#769081" font-family="Arial,sans-serif" font-size="14" font-weight="700">#HOOD · ${xml(scan.market.dexId?.toUpperCase() ?? "DEX")} · ${xml(timeframe)}</text>
    <text x="1210" y="126" text-anchor="end" fill="#F5F8F6" font-family="Arial,sans-serif" font-size="34" font-weight="900">${xml(titleValue)}</text>
    <text x="1210" y="153" text-anchor="end" fill="${changeColor}" font-family="Arial,sans-serif" font-size="17" font-weight="800">${change == null ? "24H N/A" : `${change > 0 ? "+" : ""}${change.toFixed(2)}% · 24H`}</text>
    ${grid}${candleSvg}${currentLine}${callMarker}
    <line x1="${plot.x}" y1="534" x2="${plot.x + plot.width}" y2="534" stroke="#1B3B29"/>
    <text x="70" y="654" fill="#8AA294" font-family="Arial,sans-serif" font-size="15" font-weight="700">VOL ${xml(formatUsd(scan.market.volume24hUsd))}  ·  LP ${xml(formatUsd(scan.market.liquidityUsd))}  ·  ${xml(formatCompactNumber(scan.token.holdersCount))} HOLDERS  ·  ${xml(firstLabel)}</text>
    <text x="70" y="679" fill="#526E5D" font-family="monospace" font-size="14">${xml(compactAddress(scan.token.address))}  ·  ${xml(formatAge(scan.market.pairCreatedAt))} OLD</text>
    <clipPath id="capy"><circle cx="1210" cy="654" r="27"/></clipPath><circle cx="1210" cy="654" r="29" fill="#00C805"/><image href="${mascotUrl}" x="1183" y="627" width="54" height="54" preserveAspectRatio="xMidYMid slice" clip-path="url(#capy)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

function marker(call: CallRecord, first: number, last: number, plot: { x: number; y: number; width: number; height: number }, count: number): string {
  if (last <= first) return "";
  const clamped = Math.min(last, Math.max(first, call.calledAt));
  const markerX = plot.x + ((clamped - first) / (last - first)) * plot.width;
  const anchor = markerX > plot.x + plot.width - 180 ? "end" : "start";
  const labelX = markerX + (anchor === "end" ? -8 : 8);
  const outside = call.calledAt < first ? "FIRST CALL · BEFORE RANGE" : "FIRST CALL";
  return `<line x1="${markerX}" y1="${plot.y}" x2="${markerX}" y2="${plot.y + plot.height}" stroke="#FFD166" stroke-width="2" stroke-dasharray="4 6"/><circle cx="${markerX}" cy="${plot.y + 18}" r="6" fill="#FFD166"/><text x="${labelX}" y="${plot.y + 22}" text-anchor="${anchor}" fill="#FFD166" font-family="Arial,sans-serif" font-size="13" font-weight="900">${outside}</text>`;
}

function formatAxis(value: number, metric: ChartMetric): string {
  if (metric === "market_cap") return formatUsd(value);
  if (Math.abs(value) < 0.01) return `$${value.toPrecision(3)}`;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

async function mascot(): Promise<string> {
  mascotDataUrl ??= readFile(resolve(process.cwd(), "assets/kapiscout-mascot.png"))
    .then((buffer) => `data:image/png;base64,${buffer.toString("base64")}`);
  return mascotDataUrl;
}

function xml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "KapiScout/0.2" },
        signal: AbortSignal.timeout(7_000),
      });
      if (!response.ok) throw new Error(`GeckoTerminal returned HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Chart request failed");
}
