import sharp from "sharp";
import { MASCOT_BASE64 } from "./assets.js";
import type { CallerStats, CallRecord, PaperCompetition, PaperLeaderboardEntry, PaperPortfolioSnapshot, TokenScan } from "./types.js";
import { calculateMultiple, calculateReturn, compactAddress, formatAge, formatPercent, formatUsd } from "./utils.js";

let dashboardCard: Promise<Buffer> | null = null;
const artworkCache = new Map<string, Promise<string>>();

async function mascot(): Promise<string> {
  return MASCOT_BASE64;
}

function xml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function statusColor(scan: TokenScan): string {
  if (scan.warnings.length >= 3) return "#FF4D5A";
  if (scan.warnings.length) return "#FFB830";
  return "#00E86B";
}

function statusLabel(scan: TokenScan): string {
  if (scan.warnings.length >= 3) return `${scan.warnings.length} RISKS`;
  if (scan.warnings.length) return `${scan.warnings.length} WARNING${scan.warnings.length === 1 ? "" : "S"}`;
  return "CLEAN SCAN";
}

function compactNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  for (const [size, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (Math.abs(value) >= size) return `${Number((value / size).toFixed(2))}${suffix}`;
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatSignedCardUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatUsd(Math.abs(value))}`;
}

const COMMON_DEFS = `
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

    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0D2217" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#07150E" stop-opacity="0.98"/>
    </linearGradient>

    <linearGradient id="cardBorder" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#245A3A"/>
      <stop offset="50%" stop-color="#153623"/>
      <stop offset="100%" stop-color="#0D2417"/>
    </linearGradient>

    <linearGradient id="emeraldGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#00E86B"/>
      <stop offset="100%" stop-color="#00F59B"/>
    </linearGradient>

    <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#FFD166"/>
      <stop offset="100%" stop-color="#FFB830"/>
    </linearGradient>

    <linearGradient id="redGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#FF5C64"/>
      <stop offset="100%" stop-color="#FF334B"/>
    </linearGradient>

    <linearGradient id="mascotBackdrop" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#143825"/>
      <stop offset="40%" stop-color="#0B2216"/>
      <stop offset="100%" stop-color="#05120B"/>
    </linearGradient>

    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#163825" stroke-width="0.75" opacity="0.3"/>
    </pattern>
  </defs>
`;

export function generateDashboardCard(): Promise<Buffer> {
  dashboardCard ??= (async () => {
    const mascotUrl = await mascot();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
      ${COMMON_DEFS}
      <rect width="1280" height="720" fill="url(#canvasGrad)"/>
      <rect width="1280" height="720" fill="url(#grid)"/>

      <!-- Ambient Glows -->
      <circle cx="1120" cy="120" r="320" fill="#00E86B" opacity="0.12" filter="url(#softGlow)"/>
      <circle cx="160" cy="620" r="260" fill="#00E86B" opacity="0.06" filter="url(#softGlow)"/>

      <!-- Outer Frame -->
      <rect x="24" y="24" width="1232" height="672" rx="32" fill="none" stroke="url(#cardBorder)" stroke-width="2"/>
      <rect x="24" y="24" width="10" height="672" rx="5" fill="url(#emeraldGrad)"/>

      <!-- Header Topbar -->
      <g transform="translate(68, 56)">
        <rect x="0" y="0" width="146" height="32" rx="16" fill="#0E2B1B" stroke="#1F5334" stroke-width="1.5"/>
        <circle cx="16" cy="16" r="4.5" fill="#00E86B"/>
        <text x="28" y="21" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2.5">KAPISCOUT</text>

        <rect x="158" y="0" width="166" height="32" rx="16" fill="#091C12" stroke="#173F28" stroke-width="1.2"/>
        <text x="174" y="21" fill="#84A895" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="800" letter-spacing="1.5">ROBINHOOD CHAIN</text>
      </g>

      <!-- Hero Headline -->
      <text x="68" y="174" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="900" letter-spacing="-1">See the play.</text>
      <text x="68" y="234" fill="url(#emeraldGrad)" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="900" letter-spacing="-1">Know the exit.</text>
      <text x="68" y="286" fill="#8BA797" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700">The premier read-only scout, chart scanner, and first-call alpha terminal.</text>

      <!-- Feature Matrix -->
      <g transform="translate(68, 330)">
        ${dashPill(0, 0, "SCAN", "Live DEX + Candlesticks", "01")}
        ${dashPill(238, 0, "TRACK", "Smart Money + KOL Radar", "02")}
        ${dashPill(476, 0, "PROVE", "First-Call PNL Receipts", "03")}
      </g>

      <!-- Bottom Banner Pill -->
      <g transform="translate(68, 540)">
        <rect x="0" y="0" width="698" height="70" rx="20" fill="#00E86B" filter="url(#drop)"/>
        <circle cx="34" cy="35" r="8" fill="#041F0D"/>
        <text x="54" y="42" fill="#041F0D" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="900" letter-spacing="2">LIVE ONCHAIN · READ-ONLY · INSTANT ALPHA</text>
      </g>

      <!-- Mascot Hero Showcase on the Right -->
      <g transform="translate(798, 48)">
        <rect x="0" y="0" width="430" height="576" rx="32" fill="url(#mascotBackdrop)" stroke="url(#cardBorder)" stroke-width="2" filter="url(#drop)"/>

        <!-- Mascot Glow & Image -->
        <circle cx="215" cy="225" r="160" fill="#00E86B" opacity="0.15" filter="url(#softGlow)"/>
        <clipPath id="dashMascotClip"><rect x="25" y="24" width="380" height="380" rx="26"/></clipPath>
        <image href="${mascotUrl}" x="25" y="24" width="380" height="380" preserveAspectRatio="xMidYMid slice" clip-path="url(#dashMascotClip)"/>

        <!-- Showcase Footer Tag -->
        <rect x="25" y="428" width="380" height="120" rx="20" fill="#081810" stroke="#163825" stroke-width="1.5"/>
        <text x="45" y="460" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="2">LORE OF ROBINHOOD</text>
        <text x="45" y="494" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="900">Kapiscout of Robinhood</text>
        <text x="45" y="522" fill="#7E9E8C" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="700">The quiet guide through the trenches.</text>
      </g>

      <!-- Footer Subtext -->
      <text x="1228" y="666" text-anchor="end" fill="#4B6A57" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="800" letter-spacing="1">KAPISCOUT PROTOCOL · INFORMATIONAL ONLY</text>
    </svg>`;
    return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  })();
  return dashboardCard;
}

function dashPill(x: number, y: number, tag: string, desc: string, num: string): string {
  return `
    <g transform="translate(${x}, ${y})">
      <rect x="0" y="0" width="222" height="136" rx="20" fill="url(#cardGrad)" stroke="url(#cardBorder)" stroke-width="1.8" filter="url(#drop)"/>
      <text x="20" y="36" fill="#466E54" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900">${xml(num)}</text>
      <rect x="46" y="20" width="76" height="24" rx="12" fill="#0F2B1C" stroke="#1F5336" stroke-width="1"/>
      <text x="84" y="36" text-anchor="middle" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="900" letter-spacing="1.5">${xml(tag)}</text>
      <text x="20" y="84" fill="#F4F8F5" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="800">${xml(desc)}</text>
    </g>
  `;
}

export async function generateTokenCard(scan: TokenScan): Promise<Buffer> {
  const mascotUrl = await mascot();
  const marketCap = scan.market.marketCapUsd ?? scan.market.fdvUsd;
  const security = statusLabel(scan);
  const status = statusColor(scan);
  const priceChange = scan.market.priceChange24h ?? 0;
  const isUp = priceChange >= 0;
  const changeColor = isUp ? "#00E86B" : "#FF5C64";

  const buys = scan.market.buys1h ?? 0;
  const sells = scan.market.sells1h ?? 0;
  const totalFlow = buys + sells;
  const buyRatio = totalFlow > 0 ? (buys / totalFlow) * 100 : 50;

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    ${COMMON_DEFS}
    <rect width="1280" height="720" fill="url(#canvasGrad)"/>
    <rect width="1280" height="720" fill="url(#grid)"/>

    <!-- Ambient Glow Effects -->
    <circle cx="1120" cy="140" r="300" fill="#00E86B" opacity="0.12" filter="url(#softGlow)"/>
    <circle cx="100" cy="100" r="220" fill="#00E86B" opacity="0.08" filter="url(#softGlow)"/>

    <!-- Main Chassis Border -->
    <rect x="24" y="24" width="1232" height="672" rx="32" fill="none" stroke="url(#cardBorder)" stroke-width="2"/>
    <rect x="24" y="24" width="10" height="672" rx="5" fill="url(#emeraldGrad)"/>

    <!-- Left Content Column -->
    <g transform="translate(68, 48)">

      <!-- Top Header Navigation -->
      <rect x="0" y="0" width="138" height="32" rx="16" fill="#0E2B1B" stroke="#1F5334" stroke-width="1.5"/>
      <circle cx="16" cy="16" r="4.5" fill="#00E86B"/>
      <text x="28" y="21" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2.5">KAPISCOUT</text>

      <rect x="150" y="0" width="162" height="32" rx="16" fill="#0A1F14" stroke="#17442B" stroke-width="1.2"/>
      <text x="166" y="21" fill="#7EA590" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="800" letter-spacing="1.5">ROBINHOOD CHAIN</text>

      <!-- Security Status Pill -->
      <rect x="580" y="0" width="180" height="32" rx="16" fill="#0D2418" stroke="${status}" stroke-width="1.5"/>
      <circle cx="598" cy="16" r="5" fill="${status}"/>
      <text x="612" y="21" fill="${status}" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="1.5">${xml(security)}</text>

      <!-- Token Name & Symbol Header -->
      <g transform="translate(0, 50)">
        <text x="0" y="42" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="900" letter-spacing="-0.5">${xml(scan.token.name)}</text>
        <rect x="0" y="56" width="110" height="28" rx="8" fill="#123522" stroke="#215A3B" stroke-width="1.2"/>
        <text x="55" y="75" text-anchor="middle" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="900">$${xml(scan.token.symbol)}</text>
        <text x="122" y="76" fill="#7C9E8C" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700">· ${xml(scan.market.dexId?.toUpperCase() ?? "UNISWAP V4")}</text>
      </g>

      <!-- Hero Price Glass Card -->
      <g transform="translate(0, 156)">
        <rect x="0" y="0" width="760" height="96" rx="18" fill="url(#cardGrad)" stroke="url(#cardBorder)" stroke-width="1.8" filter="url(#drop)"/>
        <text x="24" y="30" fill="#698E7B" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="2">CURRENT PRICE</text>
        <text x="24" y="74" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="900">${xml(formatUsd(scan.market.priceUsd))}</text>

        <!-- 24h Change Pill -->
        <rect x="490" y="22" width="246" height="50" rx="15" fill="${isUp ? "#0B301B" : "#381014"}" stroke="${changeColor}" stroke-width="1.5"/>
        <text x="613" y="54" text-anchor="middle" fill="${changeColor}" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="900">
          ${isUp ? "↗" : "↘"} ${xml(formatPercent(priceChange, true))}
        </text>
      </g>

      <!-- 6-Metric High-Contrast Grid -->
      <g transform="translate(0, 272)">
        ${gridCard(0, 0, 240, 92, "MARKET CAP", formatUsd(marketCap), "#00E86B")}
        ${gridCard(260, 0, 240, 92, "LIQUIDITY (LP)", formatUsd(scan.market.liquidityUsd), "#F4F8F5")}
        ${gridCard(520, 0, 240, 92, "24H VOLUME", formatUsd(scan.market.volume24hUsd), "#F4F8F5")}

        ${gridCard(0, 106, 240, 92, "TOTAL HOLDERS", scan.token.holdersCount?.toLocaleString() ?? "N/A", "#F4F8F5")}
        ${gridCard(260, 106, 240, 92, "TOP 10 CONCENTRATION", formatPercent(scan.holders.top10Percent), scan.holders.top10Percent && scan.holders.top10Percent > 50 ? "#FFB830" : "#00E86B")}
        <g transform="translate(520, 106)">
          <rect x="0" y="0" width="240" height="92" rx="16" fill="url(#cardGrad)" stroke="url(#cardBorder)" stroke-width="1.5" filter="url(#drop)"/>
          <text x="18" y="26" fill="#698E7B" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="1.5">1H FLOW</text>
          <text x="18" y="58" fill="#F4F8F5" font-family="Arial, Helvetica, sans-serif" font-size="19" font-weight="900">${buys}B <tspan fill="#668777">/</tspan> <tspan fill="#FF7B82">${sells}S</tspan></text>
          <!-- Ratio Bar -->
          <rect x="18" y="70" width="204" height="7" rx="3.5" fill="#FF4D5A"/>
          <rect x="18" y="70" width="${(buyRatio / 100) * 204}" height="7" rx="3.5" fill="#00E86B"/>
        </g>
      </g>

      <!-- Bottom Contract & Intelligence Strip -->
      <g transform="translate(0, 490)">
        <rect x="0" y="0" width="760" height="88" rx="16" fill="#08170F" stroke="#173B27" stroke-width="1.5"/>
        <text x="24" y="32" fill="#618371" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="900" letter-spacing="1.5">CONTRACT ADDRESS</text>
        <rect x="24" y="42" width="370" height="32" rx="8" fill="#0E2619" stroke="#1D4C32" stroke-width="1"/>
        <text x="38" y="64" fill="#BCE0CC" font-family="Courier New, monospace" font-size="15" font-weight="700">${xml(compactAddress(scan.token.address))}</text>

        <circle cx="430" cy="58" r="4" fill="#00E86B"/>
        <text x="444" y="63" fill="#7E9F8E" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="700">${scan.verified ? "Verified Contract" : "Unverified"}</text>

        <circle cx="585" cy="58" r="4" fill="#00E86B"/>
        <text x="599" y="63" fill="#7E9F8E" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="700">${scan.warnings.length === 0 ? "Zero Flags" : `${scan.warnings.length} Warnings`}</text>
      </g>

    </g>

    <!-- Right Showcase Column (Mascot & Lore) -->
    <g transform="translate(856, 48)">
      <rect x="0" y="0" width="356" height="580" rx="28" fill="url(#mascotBackdrop)" stroke="url(#cardBorder)" stroke-width="2" filter="url(#drop)"/>

      <!-- Mascot Showcase Portrait -->
      <circle cx="178" cy="175" r="130" fill="#00E86B" opacity="0.15" filter="url(#softGlow)"/>
      <clipPath id="tokenMascotClip"><rect x="28" y="24" width="300" height="300" rx="22"/></clipPath>
      <image href="${mascotUrl}" x="28" y="24" width="300" height="300" preserveAspectRatio="xMidYMid slice" clip-path="url(#tokenMascotClip)"/>

      <!-- Key Snapshot Widgets -->
      <g transform="translate(24, 340)">
        <rect x="0" y="0" width="308" height="96" rx="16" fill="#071810" stroke="#173B28" stroke-width="1.2"/>
        <text x="20" y="32" fill="#5F8270" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="1.5">PAIR AGE</text>
        <text x="20" y="70" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="900">${xml(formatAge(scan.market.pairCreatedAt))}</text>
      </g>

      <g transform="translate(24, 452)">
        <rect x="0" y="0" width="308" height="96" rx="16" fill="#071810" stroke="#173B28" stroke-width="1.2"/>
        <text x="20" y="32" fill="#5F8270" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="1.5">DEX STATUS</text>
        <text x="20" y="68" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="900">${scan.market.dexPaid ? "DEX PAID 🟢" : "COMMUNITY ⚪"}</text>
      </g>
    </g>

    <!-- Footer DYOR Tag -->
    <text x="1212" y="666" text-anchor="end" fill="#4B6C59" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="800">DATA IS INFORMATIONAL · DYOR</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

function gridCard(x: number, y: number, w: number, h: number, label: string, value: string, color = "#F4F8F5"): string {
  return `
    <g transform="translate(${x}, ${y})">
      <rect x="0" y="0" width="${w}" height="${h}" rx="16" fill="url(#cardGrad)" stroke="url(#cardBorder)" stroke-width="1.5" filter="url(#drop)"/>
      <text x="18" y="26" fill="#698E7B" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="1.5">${xml(label)}</text>
      <text x="18" y="64" fill="${color}" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="900">${xml(value)}</text>
    </g>
  `;
}

export async function generatePnlCard(call: CallRecord, scan: TokenScan): Promise<Buffer> {
  const mascotUrl = await mascot();
  const currentMarketCap = scan.market.marketCapUsd ?? scan.market.fdvUsd;
  const currentReturn = calculateReturn(call.entryMarketCapUsd, currentMarketCap);
  const athMultiple = calculateMultiple(call.entryMarketCapUsd, call.athMarketCapUsd);
  const positive = (currentReturn ?? 0) >= 0;
  const pnlColor = positive ? "#00E86B" : "#FF5C64";

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    ${COMMON_DEFS}
    <rect width="1280" height="720" fill="url(#canvasGrad)"/>
    <rect width="1280" height="720" fill="url(#grid)"/>

    <!-- Ambient Glows -->
    <circle cx="340" cy="380" r="280" fill="${pnlColor}" opacity="0.1" filter="url(#softGlow)"/>
    <circle cx="1060" cy="180" r="260" fill="#FFD166" opacity="0.08" filter="url(#softGlow)"/>

    <!-- Main Chassis Border -->
    <rect x="24" y="24" width="1232" height="672" rx="32" fill="none" stroke="url(#cardBorder)" stroke-width="2"/>
    <rect x="24" y="24" width="10" height="672" rx="5" fill="${positive ? "url(#emeraldGrad)" : "url(#redGrad)"}"/>

    <!-- Left Content -->
    <g transform="translate(68, 52)">

      <!-- Top Header Navigation -->
      <rect x="0" y="0" width="190" height="34" rx="17" fill="#0E2B1B" stroke="#1F5334" stroke-width="1.5"/>
      <circle cx="18" cy="17" r="5" fill="#00E86B"/>
      <text x="32" y="23" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2">KAPISCOUT PNL</text>

      <rect x="204" y="0" width="186" height="34" rx="17" fill="#1C1808" stroke="#524314" stroke-width="1.5"/>
      <circle cx="222" cy="17" r="4.5" fill="#FFD166"/>
      <text x="236" y="23" fill="#FFD166" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="1.5">FIRST-CALL PROOF</text>

      <!-- Token & Caller Subtitle -->
      <g transform="translate(0, 56)">
        <text x="0" y="46" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="48" font-weight="900">$${xml(call.symbol)}</text>
        <rect x="0" y="62" width="460" height="34" rx="10" fill="#0C2016" stroke="#1A462F" stroke-width="1.2"/>
        <text x="18" y="85" fill="#92B3A1" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="800">
          CALLED BY <tspan fill="#00E86B">@${xml(call.username.toUpperCase())}</tspan> · ${xml(formatAge(call.calledAt)).toUpperCase()} AGO
        </text>
      </g>

      <!-- Hero Return Giant Display -->
      <g transform="translate(0, 178)">
        <rect x="0" y="0" width="760" height="152" rx="22" fill="url(#cardGrad)" stroke="url(#cardBorder)" stroke-width="1.8" filter="url(#drop)"/>
        <text x="30" y="40" fill="#678E7A" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2">CURRENT RETURN FROM FIRST CALL</text>
        <text x="30" y="122" fill="${pnlColor}" font-family="Arial, Helvetica, sans-serif" font-size="74" font-weight="900" letter-spacing="-1">
          ${xml(formatPercent(currentReturn, true))}
        </text>
      </g>

      <!-- 3-Metric Performance Compare Grid -->
      <g transform="translate(0, 350)">
        ${gridCard(0, 0, 240, 106, "ENTRY MARKET CAP", formatUsd(call.entryMarketCapUsd), "#9CBAB0")}
        ${gridCard(260, 0, 240, 106, "CURRENT MARKET CAP", formatUsd(currentMarketCap), "#FFFFFF")}
        ${gridCard(520, 0, 240, 106, "ATH MULTIPLE", athMultiple == null ? "N/A" : `${athMultiple.toFixed(2)}x`, "#FFD166")}
      </g>

      <!-- Contract Bar -->
      <g transform="translate(0, 480)">
        <rect x="0" y="0" width="760" height="80" rx="16" fill="#08170F" stroke="#173B27" stroke-width="1.5"/>
        <text x="24" y="30" fill="#618371" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="900" letter-spacing="1.5">VERIFIED ONCHAIN RECEIPT</text>
        <text x="24" y="58" fill="#BCE0CC" font-family="Courier New, monospace" font-size="15" font-weight="700">${xml(compactAddress(call.tokenAddress))}</text>
        <text x="736" y="58" text-anchor="end" fill="#587C68" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="800">ROBINHOOD CHAIN</text>
      </g>
    </g>

    <!-- Right Mascot Showcase Panel -->
    <g transform="translate(856, 52)">
      <rect x="0" y="0" width="356" height="578" rx="28" fill="url(#mascotBackdrop)" stroke="url(#cardBorder)" stroke-width="2" filter="url(#drop)"/>

      <!-- Mascot Portrait -->
      <circle cx="178" cy="175" r="130" fill="#00E86B" opacity="0.12" filter="url(#softGlow)"/>
      <clipPath id="pnlMascotClip"><rect x="28" y="24" width="300" height="300" rx="24"/></clipPath>
      <image href="${mascotUrl}" x="28" y="24" width="300" height="300" preserveAspectRatio="xMidYMid slice" clip-path="url(#pnlMascotClip)"/>

      <!-- ATH High Peak Showcase Box -->
      <g transform="translate(24, 340)">
        <rect x="0" y="0" width="308" height="98" rx="18" fill="#15170A" stroke="#4F4414" stroke-width="1.5"/>
        <text x="22" y="32" fill="#FFD166" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="2">ALL-TIME HIGH MARKET CAP</text>
        <text x="22" y="72" fill="#FFF1C2" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="900">${xml(formatUsd(call.athMarketCapUsd))}</text>
      </g>

      <g transform="translate(24, 452)">
        <rect x="0" y="0" width="308" height="96" rx="18" fill="#071810" stroke="#173B28" stroke-width="1.2"/>
        <text x="22" y="34" fill="#5F8270" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="1.5">RECORD STATUS</text>
        <text x="22" y="72" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="900">IMMUTABLE RECEIPT 🔒</text>
      </g>
    </g>

    <!-- Footer -->
    <text x="1212" y="666" text-anchor="end" fill="#4B6C59" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="800">PERFORMANCE FROM FIRST CALL · NO OVERWRITES</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

export async function generateGroupSummaryCard(chatTitle: string, stats: CallerStats[], calls: CallRecord[]): Promise<Buffer> {
  const mascotUrl = await mascot();
  const valid = calls.filter((call) => call.entryMarketCapUsd && call.athMarketCapUsd);
  const best = [...valid].sort((a, b) =>
    ((b.athMarketCapUsd ?? 0) / (b.entryMarketCapUsd ?? 1)) - ((a.athMarketCapUsd ?? 0) / (a.entryMarketCapUsd ?? 1)),
  )[0];
  const hits2x = valid.filter((call) => (call.athMarketCapUsd ?? 0) >= (call.entryMarketCapUsd ?? Infinity) * 2).length;
  const bestMultiple = best?.entryMarketCapUsd && best.athMarketCapUsd ? best.athMarketCapUsd / best.entryMarketCapUsd : null;

  const topRows = stats.slice(0, 3).map((item, index) => {
    const y = 398 + index * 64;
    const medal = index === 0 ? "#FFD166" : index === 1 ? "#D2E2D9" : "#CD8C58";
    return `
      <g transform="translate(0, ${y})">
        <rect x="0" y="0" width="690" height="54" rx="14" fill="#0A1E13" stroke="#18422A" stroke-width="1.2"/>
        <rect x="16" y="12" width="34" height="30" rx="8" fill="${medal}" opacity="0.2"/>
        <text x="33" y="32" text-anchor="middle" fill="${medal}" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="900">0${index + 1}</text>
        <text x="68" y="34" fill="#F4F8F5" font-family="Arial, Helvetica, sans-serif" font-size="19" font-weight="800">@${xml(item.username)}</text>
        <text x="662" y="34" text-anchor="end" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="900">${item.bestMultiple?.toFixed(2) ?? "—"}x</text>
      </g>
    `;
  }).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    ${COMMON_DEFS}
    <rect width="1280" height="720" fill="url(#canvasGrad)"/>
    <rect width="1280" height="720" fill="url(#grid)"/>

    <circle cx="1100" cy="140" r="300" fill="#00E86B" opacity="0.1" filter="url(#softGlow)"/>

    <!-- Main Chassis Border -->
    <rect x="24" y="24" width="1232" height="672" rx="32" fill="none" stroke="url(#cardBorder)" stroke-width="2"/>
    <rect x="24" y="24" width="10" height="672" rx="5" fill="url(#emeraldGrad)"/>

    <!-- Left Content -->
    <g transform="translate(68, 52)">

      <!-- Top Header Navigation -->
      <rect x="0" y="0" width="248" height="34" rx="17" fill="#0E2B1B" stroke="#1F5334" stroke-width="1.5"/>
      <circle cx="18" cy="17" r="5" fill="#00E86B"/>
      <text x="32" y="23" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2">COMMUNITY PERFORMANCE</text>

      <!-- Group Title -->
      <text x="0" y="92" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="900">${xml(chatTitle.slice(0, 34))}</text>
      <text x="0" y="124" fill="#7E9F8E" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700">Official Robinhood Chain Alpha + Call Recap</text>

      <!-- 3 Summary Metrics -->
      <g transform="translate(0, 150)">
        ${gridCard(0, 0, 218, 96, "TOTAL CALLS", String(calls.length), "#FFFFFF")}
        ${gridCard(236, 0, 218, 96, "2X+ ALPHA HITS", String(hits2x), "#00E86B")}
        ${gridCard(472, 0, 218, 96, "BEST MULTIPLIER", bestMultiple == null ? "N/A" : `${bestMultiple.toFixed(2)}x`, "#FFD166")}
      </g>

      <!-- Leaderboard Header & Rows -->
      <g transform="translate(0, 276)">
        <text x="0" y="26" fill="#6A8E7C" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2">TOP GROUP CALLERS</text>
        ${topRows || `<text x="0" y="70" fill="#718C7C" font-family="Arial, Helvetica, sans-serif" font-size="20">No recorded calls in this group yet.</text>`}
      </g>
    </g>

    <!-- Right Showcase (Best Call) -->
    <g transform="translate(830, 52)">
      <rect x="0" y="0" width="382" height="578" rx="28" fill="url(#mascotBackdrop)" stroke="url(#cardBorder)" stroke-width="2" filter="url(#drop)"/>

      <!-- Mascot Frame -->
      <circle cx="191" cy="170" r="120" fill="#00E86B" opacity="0.12" filter="url(#softGlow)"/>
      <clipPath id="groupMascotClip"><rect x="36" y="24" width="310" height="290" rx="24"/></clipPath>
      <image href="${mascotUrl}" x="36" y="24" width="310" height="290" preserveAspectRatio="xMidYMid slice" clip-path="url(#groupMascotClip)"/>

      <!-- Best Call Box -->
      <g transform="translate(24, 334)">
        <rect x="0" y="0" width="334" height="216" rx="22" fill="#071810" stroke="#1A422D" stroke-width="1.5"/>
        <rect x="20" y="20" width="98" height="24" rx="12" fill="#1C1808" stroke="#524314" stroke-width="1"/>
        <text x="69" y="36" text-anchor="middle" fill="#FFD166" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="900" letter-spacing="1.5">TOP ALPHA</text>

        <text x="20" y="88" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="900">${best ? `$${xml(best.symbol)}` : "—"}</text>
        <text x="20" y="126" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="900">${bestMultiple ? `${bestMultiple.toFixed(2)}x PEAK` : "Waiting for alpha"}</text>
        <text x="20" y="162" fill="#7E9F8E" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700">${best ? `Called by @${xml(best.username)}` : "First call pending"}</text>
      </g>
    </g>

    <!-- Footer -->
    <text x="68" y="666" fill="#4B6C59" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="800">ROBINHOOD CHAIN · REAL-TIME CALL VERIFICATION</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

export interface WalletAlertCardInput {
  scan: TokenScan | null;
  label: string;
  isKol: boolean;
  walletAddress: string;
  direction: "BUY" | "SELL" | "TRANSFER";
  symbol: string;
  tokenAmount: number;
  valueUsd: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
}

export async function generateWalletAlertCard(input: WalletAlertCardInput): Promise<Buffer> {
  const artwork = await tokenArtwork(input.scan);
  const actionColor = input.direction === "BUY" ? "#00E86B" : input.direction === "SELL" ? "#FF4D5A" : "#38B6FF";
  const softColor = input.direction === "BUY" ? "#0C2918" : input.direction === "SELL" ? "#341014" : "#0E2436";
  const heading = input.isKol ? "SMART MONEY RADAR" : "WATCHLIST SIGNAL";
  const value = input.valueUsd == null ? "VALUE PENDING" : formatUsd(input.valueUsd);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    ${COMMON_DEFS}
    <rect width="1280" height="720" fill="url(#canvasGrad)"/>
    <rect width="1280" height="720" fill="url(#grid)"/>

    <circle cx="1060" cy="240" r="300" fill="${actionColor}" opacity="0.12" filter="url(#softGlow)"/>

    <!-- Main Chassis Border -->
    <rect x="24" y="24" width="1232" height="672" rx="32" fill="none" stroke="url(#cardBorder)" stroke-width="2"/>
    <rect x="24" y="24" width="10" height="672" rx="5" fill="${actionColor}"/>

    <!-- Left Content -->
    <g transform="translate(68, 52)">

      <!-- Top Header Navigation -->
      <rect x="0" y="0" width="138" height="34" rx="17" fill="#0E2B1B" stroke="#1F5334" stroke-width="1.5"/>
      <circle cx="18" cy="17" r="5" fill="#00E86B"/>
      <text x="32" y="23" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2">KAPISCOUT</text>

      <rect x="150" y="0" width="190" height="34" rx="17" fill="${softColor}" stroke="${actionColor}" stroke-width="1.2"/>
      <text x="166" y="23" fill="${actionColor}" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="1.5">${heading}</text>

      <!-- Action Pill Badge & Token Symbol -->
      <g transform="translate(0, 56)">
        <rect x="0" y="0" width="124" height="42" rx="21" fill="${softColor}" stroke="${actionColor}" stroke-width="2"/>
        <circle cx="24" cy="21" r="5.5" fill="${actionColor}"/>
        <text x="40" y="28" fill="${actionColor}" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="900">${input.direction}</text>

        <text x="0" y="102" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="900">$${xml(input.symbol.slice(0, 18))}</text>
        <text x="0" y="136" fill="#8EAFA0" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="700">
          ${xml(input.label.slice(0, 32))} · <tspan fill="#D5E8DD" font-family="Courier New, monospace">${xml(compactAddress(input.walletAddress as `0x${string}`))}</tspan>
        </text>
      </g>

      <!-- Hero Trade Value Box -->
      <g transform="translate(0, 214)">
        <rect x="0" y="0" width="760" height="136" rx="22" fill="url(#cardGrad)" stroke="url(#cardBorder)" stroke-width="1.8" filter="url(#drop)"/>
        <text x="28" y="38" fill="#678E7A" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2">ESTIMATED TRADE VALUE</text>
        <text x="28" y="96" fill="${actionColor}" font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="900">${xml(value)}</text>
        <text x="28" y="122" fill="#9FBDB0" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700">${xml(compactNumber(input.tokenAmount))} ${xml(input.symbol)} transacted</text>
      </g>

      <!-- 3 Metrics -->
      <g transform="translate(0, 368)">
        ${gridCard(0, 0, 240, 100, "TOKEN PRICE", formatUsd(input.priceUsd), "#FFFFFF")}
        ${gridCard(260, 0, 240, 100, "MARKET CAP", formatUsd(input.marketCapUsd), "#FFFFFF")}
        ${gridCard(520, 0, 240, 100, "LIQUIDITY", formatUsd(input.liquidityUsd), "#FFFFFF")}
      </g>

      <!-- Footer Tag -->
      <g transform="translate(0, 486)">
        <rect x="0" y="0" width="760" height="74" rx="16" fill="#08170F" stroke="#173B27" stroke-width="1.5"/>
        <circle cx="28" cy="37" r="4.5" fill="${actionColor}"/>
        <text x="44" y="42" fill="#95B7A6" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="700">Observed Real-Time Transfer on Robinhood Chain</text>
      </g>
    </g>

    <!-- Right Artwork Showcase -->
    <g transform="translate(856, 52)">
      <rect x="0" y="0" width="356" height="578" rx="28" fill="url(#mascotBackdrop)" stroke="url(#cardBorder)" stroke-width="2" filter="url(#drop)"/>

      <!-- Circular Avatar & Direction Arrow -->
      <circle cx="178" cy="205" r="126" fill="${softColor}" stroke="${actionColor}" stroke-width="2.5"/>
      <clipPath id="alertArtClip"><circle cx="178" cy="205" r="118"/></clipPath>
      <image href="${artwork}" x="60" y="87" width="236" height="236" preserveAspectRatio="xMidYMid slice" clip-path="url(#alertArtClip)"/>

      <!-- Direction Arrow Badge -->
      <circle cx="264" cy="290" r="30" fill="${actionColor}" filter="url(#drop)"/>
      <text x="264" y="301" text-anchor="middle" fill="#041208" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="900">
        ${input.direction === "BUY" ? "↗" : input.direction === "SELL" ? "↘" : "→"}
      </text>

      <!-- Bottom Card Info -->
      <g transform="translate(24, 380)">
        <rect x="0" y="0" width="308" height="154" rx="20" fill="#071810" stroke="#173B28" stroke-width="1.5"/>
        <text x="154" y="46" text-anchor="middle" fill="#5F8270" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2">ROBINHOOD CHAIN</text>
        <text x="154" y="86" text-anchor="middle" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="900">Live Wallet Signal</text>
        <text x="154" y="122" text-anchor="middle" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="800">AUTOMATIC DETECT ⚡</text>
      </g>
    </g>

    <!-- Footer -->
    <text x="1212" y="666" text-anchor="end" fill="#4B6C59" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="800">ONCHAIN EVIDENCE · DYOR</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

export async function generatePaperPortfolioCard(snapshot: PaperPortfolioSnapshot): Promise<Buffer> {
  const positive = snapshot.totalPnlUsd >= 0;
  const accent = positive ? "#00E86B" : "#FF5C64";

  const rows = snapshot.positions.slice(0, 4).map((position, index) => {
    const y = 412 + index * 54;
    const pnlColor = position.unrealizedPnlUsd >= 0 ? "#00E86B" : "#FF6970";
    return `
      <g transform="translate(0, ${y})">
        <rect x="0" y="0" width="700" height="46" rx="12" fill="#0A1E13" stroke="#163C26" stroke-width="1"/>
        <text x="18" y="29" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="900">$${xml(position.symbol.slice(0, 12))}</text>
        <text x="260" y="29" fill="#8FB2A1" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="700">${xml(formatUsd(position.liquidationValueUsd))}</text>
        <text x="500" y="29" text-anchor="end" fill="${pnlColor}" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="900">${xml(formatSignedCardUsd(position.unrealizedPnlUsd))}</text>
        <rect x="540" y="11" width="140" height="24" rx="12" fill="${position.quoteAvailable ? "#0E2B1B" : "#301D0A"}" stroke="${position.quoteAvailable ? "#1D5435" : "#6E4514"}" stroke-width="1"/>
        <text x="610" y="27" text-anchor="middle" fill="${position.quoteAvailable ? "#00E86B" : "#FFB830"}" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="900">${position.quoteAvailable ? "LIVE UNISWAP V4" : "NO LIQUIDITY"}</text>
      </g>
    `;
  }).join("");

  const status = snapshot.competition.status === "ACTIVE" ? "LIVE COMPETITION" : "FINAL RESULT";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    ${COMMON_DEFS}
    <rect width="1280" height="720" fill="url(#canvasGrad)"/>
    <rect width="1280" height="720" fill="url(#grid)"/>

    <circle cx="1100" cy="140" r="300" fill="${accent}" opacity="0.1" filter="url(#softGlow)"/>

    <!-- Main Chassis Border -->
    <rect x="24" y="24" width="1232" height="672" rx="32" fill="none" stroke="url(#cardBorder)" stroke-width="2"/>
    <rect x="24" y="24" width="10" height="672" rx="5" fill="${accent}"/>

    <!-- Left Column -->
    <g transform="translate(68, 52)">

      <!-- Top Header Navigation -->
      <rect x="0" y="0" width="220" height="34" rx="17" fill="#0E2B1B" stroke="#1F5334" stroke-width="1.5"/>
      <circle cx="18" cy="17" r="5" fill="#00E86B"/>
      <text x="32" y="23" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2">KAPISCOUT ARENA</text>

      <rect x="232" y="0" width="170" height="34" rx="17" fill="#0A1F14" stroke="#17442B" stroke-width="1.2"/>
      <text x="248" y="23" fill="#7EA590" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="800" letter-spacing="1.5">${status}</text>

      <!-- Competition & Username -->
      <g transform="translate(0, 54)">
        <text x="0" y="42" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="900">${xml(snapshot.competition.name.slice(0, 32))}</text>
        <text x="0" y="74" fill="#88ABA0" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="800">
          @${xml(snapshot.account.username)} · <tspan fill="#00E86B">RANK #${snapshot.rank ?? "—"}</tspan> OF ${snapshot.participants}
        </text>
      </g>

      <!-- Hero Liquidation Balance Card -->
      <g transform="translate(0, 150)">
        <rect x="0" y="0" width="700" height="126" rx="20" fill="url(#cardGrad)" stroke="url(#cardBorder)" stroke-width="1.8" filter="url(#drop)"/>
        <text x="26" y="34" fill="#678E7A" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2">LIQUIDATION BALANCE (EQUITY)</text>
        <text x="26" y="94" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="50" font-weight="900">${xml(formatUsd(snapshot.equityUsd))}</text>

        <rect x="490" y="36" width="180" height="52" rx="16" fill="${positive ? "#0B301B" : "#381014"}" stroke="${accent}" stroke-width="1.5"/>
        <text x="580" y="69" text-anchor="middle" fill="${accent}" font-family="Arial, Helvetica, sans-serif" font-size="23" font-weight="900">
          ${snapshot.returnPercent >= 0 ? "+" : ""}${snapshot.returnPercent.toFixed(2)}%
        </text>
      </g>

      <!-- Open Positions Table Header & Rows -->
      <g transform="translate(0, 306)">
        <text x="0" y="24" fill="#678E7A" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2">OPEN PORTFOLIO POSITIONS</text>
        ${rows || `<text x="0" y="70" fill="#789084" font-family="Arial, Helvetica, sans-serif" font-size="18">No open positions in this tournament.</text>`}
      </g>
    </g>

    <!-- Right Metric Overview Panel -->
    <g transform="translate(800, 52)">
      <rect x="0" y="0" width="410" height="578" rx="28" fill="url(#mascotBackdrop)" stroke="url(#cardBorder)" stroke-width="2" filter="url(#drop)"/>

      <g transform="translate(32, 38)">
        ${rightPaperMetric(0, 0, "CASH BALANCE", formatUsd(snapshot.cashBalanceUsd))}
        ${rightPaperMetric(0, 110, "POSITIONS VALUE", formatUsd(snapshot.positionsValueUsd))}
        ${rightPaperMetric(0, 220, "TOTAL REALIZED + UNREALIZED PNL", formatSignedCardUsd(snapshot.totalPnlUsd), accent)}
        ${rightPaperMetric(0, 330, "TRADING RECORD", `${snapshot.account.wins}W / ${snapshot.account.losses}L`)}
      </g>

      <g transform="translate(32, 480)">
        <rect x="0" y="0" width="346" height="58" rx="14" fill="#071810" stroke="#163825" stroke-width="1.2"/>
        <text x="173" y="35" text-anchor="middle" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="1.5">SIMULATED GAS INCLUDED ⛽</text>
      </g>
    </g>

    <!-- Footer -->
    <text x="68" y="666" fill="#4B6C59" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="800">EXECUTABLE EXIT VALUES AFTER GAS · REFRESHED LIVE</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

function rightPaperMetric(x: number, y: number, label: string, value: string, color = "#FFFFFF"): string {
  return `
    <g transform="translate(${x}, ${y})">
      <rect x="0" y="0" width="346" height="88" rx="18" fill="#081A10" stroke="#173E29" stroke-width="1.2"/>
      <text x="20" y="28" fill="#5F8371" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="1.5">${xml(label)}</text>
      <text x="20" y="64" fill="${color}" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="900">${xml(value)}</text>
    </g>
  `;
}

export async function generatePaperLeaderboardCard(competition: PaperCompetition, entries: PaperLeaderboardEntry[]): Promise<Buffer> {
  const rows = entries.slice(0, 7).map((entry, index) => {
    const y = 196 + index * 58;
    const color = entry.pnlUsd >= 0 ? "#00E86B" : "#FF6970";
    const medal = index === 0 ? "#FFD166" : index === 1 ? "#D2E2D9" : index === 2 ? "#CD8C58" : "#6F8679";
    const rank = String(index + 1).padStart(2, "0");

    return `
      <g transform="translate(0, ${y})">
        <rect x="0" y="0" width="1144" height="48" rx="12" fill="${index % 2 === 0 ? "#0A1E13" : "#07170E"}" stroke="#163C26" stroke-width="1"/>
        <rect x="14" y="9" width="36" height="30" rx="8" fill="${medal}" opacity="${index < 3 ? "0.2" : "0.08"}"/>
        <text x="32" y="29" text-anchor="middle" fill="${medal}" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="900">${rank}</text>
        <text x="70" y="30" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="800">@${xml(entry.username.slice(0, 24))}</text>
        <text x="580" y="30" text-anchor="end" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="800">${xml(formatUsd(entry.equityUsd))}</text>
        <text x="780" y="30" text-anchor="end" fill="${color}" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="900">${xml(`${entry.returnPercent >= 0 ? "+" : ""}${entry.returnPercent.toFixed(2)}%`)}</text>
        <text x="940" y="30" text-anchor="end" fill="#8FB2A1" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="800">${entry.wins}W / ${entry.losses}L</text>
        <text x="1110" y="30" text-anchor="end" fill="#8FB2A1" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="800">${entry.openPositions} POS</text>
      </g>
    `;
  }).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    ${COMMON_DEFS}
    <rect width="1280" height="720" fill="url(#canvasGrad)"/>
    <rect width="1280" height="720" fill="url(#grid)"/>

    <circle cx="1100" cy="140" r="300" fill="#00E86B" opacity="0.1" filter="url(#softGlow)"/>

    <!-- Main Chassis Border -->
    <rect x="24" y="24" width="1232" height="672" rx="32" fill="none" stroke="url(#cardBorder)" stroke-width="2"/>
    <rect x="24" y="24" width="10" height="672" rx="5" fill="url(#emeraldGrad)"/>

    <!-- Header Navigation -->
    <g transform="translate(68, 50)">
      <rect x="0" y="0" width="220" height="34" rx="17" fill="#0E2B1B" stroke="#1F5334" stroke-width="1.5"/>
      <circle cx="18" cy="17" r="5" fill="#00E86B"/>
      <text x="32" y="23" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="900" letter-spacing="2">KAPISCOUT ARENA</text>

      <rect x="990" y="0" width="154" height="34" rx="17" fill="#0B2B1B" stroke="#00E86B" stroke-width="1.2"/>
      <text x="1067" y="23" text-anchor="middle" fill="#00E86B" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="1.5">
        ${competition.status === "ACTIVE" ? "LIVE STANDINGS 🟢" : "FINAL STANDINGS 🏁"}
      </text>

      <text x="0" y="78" fill="#FFFFFF" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="900">${xml(competition.name.slice(0, 36))}</text>

      <!-- Table Column Headers -->
      <g transform="translate(0, 110)">
        <text x="24" y="20" fill="#5F8270" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="2">RANK</text>
        <text x="70" y="20" fill="#5F8270" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="2">TRADER</text>
        <text x="580" y="20" text-anchor="end" fill="#5F8270" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="2">LIQUIDATION BALANCE</text>
        <text x="780" y="20" text-anchor="end" fill="#5F8270" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="2">RETURN</text>
        <text x="940" y="20" text-anchor="end" fill="#5F8270" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="2">RECORD</text>
        <text x="1110" y="20" text-anchor="end" fill="#5F8270" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="900" letter-spacing="2">OPEN</text>
      </g>

      <!-- Standings Rows -->
      ${rows || `<text x="0" y="180" fill="#789084" font-family="Arial, Helvetica, sans-serif" font-size="20">Waiting for traders to register and open positions.</text>`}
    </g>

    <!-- Footer -->
    <text x="68" y="666" fill="#4B6C59" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="800">RANKINGS USE LIVE ONCHAIN EXECUTABLE QUOTES · GAS INCLUDED</text>
    <text x="1212" y="666" text-anchor="end" fill="#4B6C59" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="800">${entries.length} PARTICIPANTS</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

async function tokenArtwork(scan: TokenScan | null): Promise<string> {
  const url = scan?.token.iconUrl;
  if (url && /^https?:\/\//iu.test(url)) {
    const cached = artworkCache.get(url);
    if (cached) return cached;
    const pending = (async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3_500), headers: { "User-Agent": "KapiScout/0.2" } });
        if (response.ok) {
          const raw = Buffer.from(await response.arrayBuffer());
          if (raw.length <= 5_000_000) {
            const png = await sharp(raw).resize(400, 400, { fit: "cover" }).png().toBuffer();
            return `data:image/png;base64,${png.toString("base64")}`;
          }
        }
      } catch { /* Fall back to mascot */ }
      return mascot();
    })();
    artworkCache.set(url, pending);
    if (artworkCache.size > 200) artworkCache.delete(artworkCache.keys().next().value!);
    return pending;
  }
  return mascot();
}
