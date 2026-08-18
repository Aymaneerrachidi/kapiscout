import sharp from "sharp";
import type { Address } from "viem";
import { MASCOT_BASE64 } from "./assets.js";
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
  const mascotUrl = MASCOT_BASE64;
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
  const plot = { x: 68, y: 156, width: 1144, height: 350 };
  const volume = { y: 518, height: 72 };
  const min = Math.min(...normalized.map((item) => item.low));
  const max = Math.max(...normalized.map((item) => item.high));
  const range = Math.max(max - min, Math.abs(max) * 0.001, 1e-12);
  const paddedMin = min - range * 0.08;
  const paddedMax = max + range * 0.08;
  const paddedRange = paddedMax - paddedMin;
  const maxVolume = Math.max(...normalized.map((item) => item.volume), 1);
  const step = plot.width / normalized.length;
  const bodyWidth = Math.max(3, Math.min(10, step * 0.68));
  const y = (value: number) => plot.y + ((paddedMax - value) / paddedRange) * plot.height;
  const x = (index: number) => plot.x + step * index + step / 2;

  const grid = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const gridY = plot.y + plot.height * ratio;
    const value = paddedMax - paddedRange * ratio;
    return `
      <line x1="${plot.x}" y1="${gridY}" x2="${plot.x + plot.width}" y2="${gridY}" stroke="#133623" stroke-width="1" stroke-dasharray="3 4"/>
      <rect x="${plot.x + plot.width - 96}" y="${gridY - 11}" width="96" height="20" rx="6" fill="#091C12" stroke="#17442B" stroke-width="1"/>
      <text x="${plot.x + plot.width - 8}" y="${gridY + 3}" text-anchor="end" fill="#88AE9B" font-family="Courier New, monospace" font-size="11" font-weight="700">${xml(formatAxis(value, metric))}</text>
    `;
  }).join("");

  const candleSvg = normalized.map((item, index) => {
    const isBull = item.close >= item.open;
    const color = isBull ? "#00E86B" : "#FF5C64";
    const cx = x(index);
    const bodyTop = Math.min(y(item.open), y(item.close));
    const bodyHeight = Math.max(2, Math.abs(y(item.open) - y(item.close)));
    const volumeHeight = Math.max(2, (item.volume / maxVolume) * volume.height);
    return `
      <line x1="${cx}" y1="${y(item.high)}" x2="${cx}" y2="${y(item.low)}" stroke="${color}" stroke-width="1.6"/>
      <rect x="${cx - bodyWidth / 2}" y="${bodyTop}" width="${bodyWidth}" height="${bodyHeight}" rx="1.5" fill="${color}"/>
      <rect x="${cx - bodyWidth / 2}" y="${volume.y + volume.height - volumeHeight}" width="${bodyWidth}" height="${volumeHeight}" rx="1.5" fill="${color}" opacity="0.32"/>
    `;
  }).join("");

  const firstTimestamp = normalized[0]?.timestamp ?? 0;
  const lastTimestamp = normalized.at(-1)?.timestamp ?? 0;
  const callMarker = call ? marker(call, firstTimestamp, lastTimestamp, plot) : "";
  const latest = normalized.at(-1)?.close ?? null;
  const latestY = latest == null ? null : y(latest);
  const currentLine = latestY == null ? "" : `
    <line x1="${plot.x}" y1="${latestY}" x2="${plot.x + plot.width}" y2="${latestY}" stroke="#00E86B" stroke-width="1.5" stroke-dasharray="4 6" opacity="0.9"/>
    <rect x="${plot.x + plot.width - 124}" y="${latestY - 14}" width="124" height="26" rx="8" fill="#00E86B" filter="url(#drop)"/>
    <text x="${plot.x + plot.width - 10}" y="${latestY + 4}" text-anchor="end" fill="#04180A" font-family="Courier New, monospace" font-size="13" font-weight="900">${xml(formatAxis(latest ?? 0, metric))}</text>
  `;

  const change = scan.market.priceChange24h;
  const isUp = (change ?? 0) >= 0;
  const changeColor = isUp ? "#00E86B" : "#FF5C64";
  const titleValue = metric === "market_cap" ? formatUsd(currentMc) : formatUsd(scan.market.priceUsd);
  const firstLabel = call ? `FIRST ${formatUsd(call.entryMarketCapUsd)} · @${call.username}` : "FIRST CALL PENDING";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <defs>
      <filter id="softGlow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="32"/>
      </filter>
      <filter id="drop" x="-10%" y="-10%" width="120%" height="130%">
        <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.5"/>
      </filter>
      <linearGradient id="canvasGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#040A07"/>
        <stop offset="50%" stop-color="#06120B"/>
        <stop offset="100%" stop-color="#030805"/>
      </linearGradient>
      <linearGradient id="cardBorder" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#245A3A"/>
        <stop offset="50%" stop-color="#153623"/>
        <stop offset="100%" stop-color="#0D2417"/>
      </linearGradient>
      <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#163825" stroke-width="0.75" opacity="0.3"/>
      </pattern>
    </defs>

    <rect width="1280" height="720" fill="url(#canvasGrad)"/>
    <rect width="1280" height="720" fill="url(#grid)"/>

    <circle cx="1120" cy="140" r="300" fill="#00E86B" opacity="0.1" filter="url(#softGlow)"/>

    <!-- Main Chassis Border -->
    <rect x="24" y="24" width="1232" height="672" rx="32" fill="none" stroke="url(#cardBorder)" stroke-width="2"/>
    <rect x="24" y="24" width="10" height="672" rx="5" fill="#00E86B"/>

    <!-- Top Left Header -->
    <g transform="translate(68, 48)">
      <rect x="0" y="0" width="138" height="32" rx="16" fill="#0E2B1B" stroke="#1F5334" stroke-width="1.5"/>
      <circle cx="16" cy="16" r="4.5" fill="#00E86B"/>
      <text x="28" y="21" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2.5">KAPISCOUT</text>

      <rect x="150" y="0" width="162" height="32" rx="16" fill="#0A1F14" stroke="#17442B" stroke-width="1.2"/>
      <text x="166" y="21" fill="#7EA590" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="800" letter-spacing="1.5">ROBINHOOD CHAIN</text>

      <text x="0" y="74" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="900">${xml(scan.token.name)} <tspan fill="#00E86B" font-size="22">$${xml(scan.token.symbol)}</tspan></text>
    </g>

    <!-- Top Right Stats -->
    <g transform="translate(1212, 48)">
      <text x="0" y="22" text-anchor="end" fill="#7E9F8E" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="800" letter-spacing="1.5">
        #HOOD · ${xml(scan.market.dexId?.toUpperCase() ?? "UNISWAP V4")} · <tspan fill="#00E86B">${xml(timeframe.toUpperCase())}</tspan> · ${metric === "market_cap" ? "MCAP" : "PRICE"}
      </text>
      <text x="0" y="66" text-anchor="end" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="900">${xml(titleValue)}</text>
      <text x="0" y="90" text-anchor="end" fill="${changeColor}" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="900">
        ${isUp ? "↗" : "↘"} ${change == null ? "24H N/A" : `${change > 0 ? "+" : ""}${change.toFixed(2)}% · 24H`}
      </text>
    </g>

    <!-- Chart Plot Canvas Container -->
    <rect x="${plot.x}" y="${plot.y}" width="${plot.width}" height="${plot.height + volume.height + 6}" rx="18" fill="#081A10" stroke="#163C26" stroke-width="1.5" filter="url(#drop)"/>

    <!-- Grid & Candles -->
    ${grid}
    ${candleSvg}
    ${currentLine}
    ${callMarker}

    <!-- Volume Separator -->
    <line x1="${plot.x}" y1="${volume.y - 4}" x2="${plot.x + plot.width}" y2="${volume.y - 4}" stroke="#133623" stroke-width="1" stroke-dasharray="2 3"/>
    <text x="${plot.x + 16}" y="${volume.y + 16}" fill="#547866" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="900" letter-spacing="1.5">VOLUME</text>

    <!-- Bottom Telemetry Bar -->
    <g transform="translate(68, 626)">
      <rect x="0" y="0" width="1070" height="54" rx="16" fill="#08180F" stroke="#173B27" stroke-width="1.5"/>
      <text x="20" y="32" fill="#95B7A6" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="800">
        VOL <tspan fill="#FFFFFF">${xml(formatUsd(scan.market.volume24hUsd))}</tspan>  ·  LP <tspan fill="#FFFFFF">${xml(formatUsd(scan.market.liquidityUsd))}</tspan>  ·  HOLDERS <tspan fill="#FFFFFF">${xml(formatCompactNumber(scan.token.holdersCount))}</tspan>  ·  <tspan fill="#FFD166">${xml(firstLabel)}</tspan>
      </text>
      <text x="1050" y="32" text-anchor="end" fill="#6B907E" font-family="Courier New, monospace" font-size="13">
        ${xml(compactAddress(scan.token.address))} · ${xml(formatAge(scan.market.pairCreatedAt))} OLD
      </text>
    </g>

    <!-- Bottom Right Mascot Circle Badge -->
    <g transform="translate(1156, 624)">
      <circle cx="28" cy="28" r="28" fill="#0E2B1B" stroke="#00E86B" stroke-width="2" filter="url(#drop)"/>
      <clipPath id="chartMascot"><circle cx="28" cy="28" r="25"/></clipPath>
      <image href="${mascotUrl}" x="3" y="3" width="50" height="50" preserveAspectRatio="xMidYMid slice" clip-path="url(#chartMascot)"/>
    </g>

  </svg>`;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

function marker(call: CallRecord, first: number, last: number, plot: { x: number; y: number; width: number; height: number }): string {
  if (last <= first) return "";
  const clamped = Math.min(last, Math.max(first, call.calledAt));
  const markerX = plot.x + ((clamped - first) / (last - first)) * plot.width;
  const anchor = markerX > plot.x + plot.width - 200 ? "end" : "start";
  const labelX = markerX + (anchor === "end" ? -12 : 12);
  const outside = call.calledAt < first ? "FIRST CALL (EARLIER)" : "FIRST CALL";
  return `
    <line x1="${markerX}" y1="${plot.y}" x2="${markerX}" y2="${plot.y + plot.height}" stroke="#FFD166" stroke-width="2" stroke-dasharray="4 6"/>
    <circle cx="${markerX}" cy="${plot.y + 24}" r="6" fill="#FFD166" filter="url(#drop)"/>
    <rect x="${anchor === "end" ? labelX - 170 : labelX - 6}" y="${plot.y + 10}" width="176" height="28" rx="8" fill="#1C1808" stroke="#524314" stroke-width="1.2"/>
    <text x="${anchor === "end" ? labelX - 10 : labelX + 8}" y="${plot.y + 28}" text-anchor="${anchor}" fill="#FFD166" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="900" letter-spacing="1">
      ★ ${outside}
    </text>
  `;
}

function formatAxis(value: number, metric: ChartMetric): string {
  if (metric === "market_cap") return formatUsd(value);
  if (Math.abs(value) < 0.01) return `$${value.toPrecision(3)}`;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function xml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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
