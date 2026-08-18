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
  if (scan.warnings.length >= 3) return "#FF5C5C";
  if (scan.warnings.length) return "#FFC857";
  return "#00E86B";
}

export function generateDashboardCard(): Promise<Buffer> {
  dashboardCard ??= (async () => {
    const logo = await mascot();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
      <defs>
        <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="60"/></filter>
        <filter id="ringGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="18"/></filter>
        <radialGradient id="medallion" cx="50%" cy="38%" r="72%">
          <stop offset="0%" stop-color="#12351F"/>
          <stop offset="100%" stop-color="#081A0F"/>
        </radialGradient>
        <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#00E86B"/>
          <stop offset="55%" stop-color="#00C805"/>
          <stop offset="100%" stop-color="#0C6B3A"/>
        </linearGradient>
        <clipPath id="logoClip"><circle cx="1012" cy="322" r="188"/></clipPath>
        <linearGradient id="cta" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#00E86B"/>
          <stop offset="100%" stop-color="#38F58C"/>
        </linearGradient>
      </defs>

      <rect width="1280" height="720" fill="#050D08"/>
      <circle cx="1040" cy="250" r="300" fill="#00E86B" opacity=".16" filter="url(#soft)"/>
      <circle cx="180" cy="660" r="220" fill="#00C805" opacity=".07" filter="url(#soft)"/>

      <rect x="28" y="28" width="1224" height="664" rx="38" fill="#0A1810" stroke="#1C3B29" stroke-width="2"/>
      <rect x="28" y="28" width="10" height="664" rx="5" fill="url(#ring)"/>

      <text x="78" y="92" fill="#00E86B" font-family="Arial,sans-serif" font-size="21" font-weight="900" letter-spacing="5">KAPISCOUT</text>
      <rect x="272" y="70" width="212" height="30" rx="15" fill="#10241A" stroke="#214632"/>
      <text x="378" y="91" text-anchor="middle" fill="#7E9A8A" font-family="Arial,sans-serif" font-size="14" font-weight="800" letter-spacing="2">ROBINHOOD CHAIN</text>

      <text x="78" y="212" fill="#F5F8F5" font-family="Arial,sans-serif" font-size="62" font-weight="900">See the play.</text>
      <text x="78" y="286" fill="#F5F8F5" font-family="Arial,sans-serif" font-size="62" font-weight="900">Know the <tspan fill="#00E86B">exit.</tspan></text>
      <text x="78" y="342" fill="#8BA095" font-family="Arial,sans-serif" font-size="22" font-weight="600">One clean interface for tokens, wallets and calls.</text>

      ${dashboardPill(78, 400, "SCAN", "Live market + chart")}${dashboardPill(314, 400, "TRACK", "Wallet intelligence")}${dashboardPill(550, 400, "PROVE", "First-call PNL")}

      <rect x="78" y="572" width="600" height="64" rx="32" fill="url(#cta)"/>
      <circle cx="116" cy="604" r="7" fill="#04200C"/>
      <text x="140" y="613" fill="#04200C" font-family="Arial,sans-serif" font-size="21" font-weight="900" letter-spacing="1">LIVE &#183; FAST &#183; READ-ONLY</text>

      <circle cx="1012" cy="322" r="200" fill="#00E86B" opacity=".16" filter="url(#ringGlow)"/>
      <circle cx="1012" cy="322" r="188" fill="url(#medallion)"/>
      <g clip-path="url(#logoClip)">
        <image href="${logo}" x="800" y="132" width="424" height="424" preserveAspectRatio="xMidYMid slice"/>
      </g>
      <circle cx="1012" cy="322" r="188" fill="none" stroke="url(#ring)" stroke-width="7"/>
      <circle cx="1012" cy="322" r="197" fill="none" stroke="#123D24" stroke-width="2"/>
      <text x="1012" y="576" text-anchor="middle" fill="#00E86B" font-family="Arial,sans-serif" font-size="16" font-weight="900" letter-spacing="4">THE SCOUT</text>
      <text x="1012" y="606" text-anchor="middle" fill="#5C7767" font-family="Arial,sans-serif" font-size="13" font-weight="700" letter-spacing="2">OF ROBINHOOD CHAIN</text>

      <text x="1204" y="664" text-anchor="end" fill="#31463A" font-family="Arial,sans-serif" font-size="13" font-weight="800" letter-spacing="1">BUILT FOR THE TRENCHES</text>
    </svg>`;
    return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  })();
  return dashboardCard;
}

function dashboardPill(x: number, y: number, label: string, detail: string): string {
  return `<rect x="${x}" y="${y}" width="218" height="112" rx="20" fill="#10241A" stroke="#214632"/><text x="${x + 20}" y="${y + 39}" fill="#00E86B" font-family="Arial,sans-serif" font-size="15" font-weight="900" letter-spacing="2">${label}</text><text x="${x + 20}" y="${y + 75}" fill="#DDE8E0" font-family="Arial,sans-serif" font-size="16" font-weight="700">${detail}</text>`;
}

export async function generateTokenCard(scan: TokenScan): Promise<Buffer> {
  const mascotUrl = await mascot();
  const marketCap = scan.market.marketCapUsd ?? scan.market.fdvUsd;
  const security = scan.warnings.length ? `${scan.warnings.length} FLAG${scan.warnings.length === 1 ? "" : "S"}` : "CLEAN SCAN";
  const status = statusColor(scan);
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <rect width="1280" height="720" fill="#07140D"/>
    <rect x="24" y="24" width="1232" height="672" rx="36" fill="#0D2116" stroke="#1F4931" stroke-width="2"/>
    <rect x="24" y="24" width="12" height="672" rx="6" fill="#00E86B"/>

    <text x="74" y="82" fill="#00E86B" font-family="Arial, sans-serif" font-size="22" font-weight="800" letter-spacing="4">KAPISCOUT</text>
    <text x="270" y="82" fill="#789585" font-family="Arial, sans-serif" font-size="18" font-weight="700" letter-spacing="2">ROBINHOOD CHAIN</text>
    <rect x="74" y="108" width="770" height="2" fill="#1C3B29"/>

    <text x="74" y="174" fill="#F4F7F4" font-family="Arial, sans-serif" font-size="50" font-weight="800">${xml(scan.token.name)}</text>
    <text x="74" y="218" fill="#8AA596" font-family="Arial, sans-serif" font-size="27" font-weight="700">$${xml(scan.token.symbol)} · ${xml(scan.market.dexId?.toUpperCase() ?? "NO DEX")}</text>

    <text x="74" y="282" fill="#6F8E7C" font-family="Arial, sans-serif" font-size="17" font-weight="700" letter-spacing="2">PRICE</text>
    <text x="74" y="338" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="48" font-weight="800">${xml(formatUsd(scan.market.priceUsd))}</text>
    <text x="365" y="334" fill="${(scan.market.priceChange24h ?? 0) >= 0 ? "#00E86B" : "#FF6666"}" font-family="Arial, sans-serif" font-size="25" font-weight="800">${xml(formatPercent(scan.market.priceChange24h, true))}</text>
    <text x="365" y="360" fill="#698374" font-family="Arial, sans-serif" font-size="14" font-weight="700">24 HOURS</text>

    ${metric(74, 398, "MARKET CAP", formatUsd(marketCap))}
    ${metric(327, 398, "LIQUIDITY", formatUsd(scan.market.liquidityUsd))}
    ${metric(580, 398, "24H VOLUME", formatUsd(scan.market.volume24hUsd))}

    <rect x="74" y="536" width="770" height="104" rx="20" fill="#0A1A11" stroke="#1C3B29"/>
    <circle cx="108" cy="570" r="7" fill="${status}"/>
    <text x="128" y="577" fill="${status}" font-family="Arial, sans-serif" font-size="18" font-weight="800">${xml(security)}</text>
    <text x="108" y="613" fill="#90A99A" font-family="Arial, sans-serif" font-size="17" font-weight="600">${xml(`${scan.token.holdersCount?.toLocaleString() ?? "N/A"} holders  ·  Top 10 ${formatPercent(scan.holders.top10Percent)}  ·  ${scan.verified ? "Verified" : "Unverified"}`)}</text>

    <rect x="884" y="58" width="324" height="510" rx="30" fill="#00C805"/>
    <clipPath id="mascotClip"><rect x="900" y="76" width="292" height="292" rx="24"/></clipPath>
    <image href="${mascotUrl}" x="900" y="76" width="292" height="292" preserveAspectRatio="xMidYMid slice" clip-path="url(#mascotClip)"/>
    <text x="920" y="414" fill="#05230F" font-family="Arial, sans-serif" font-size="16" font-weight="800" letter-spacing="2">PAIR AGE</text>
    <text x="920" y="455" fill="#031B0B" font-family="Arial, sans-serif" font-size="36" font-weight="900">${xml(formatAge(scan.market.pairCreatedAt))}</text>
    <text x="920" y="502" fill="#05230F" font-family="Arial, sans-serif" font-size="16" font-weight="800" letter-spacing="2">1H FLOW</text>
    <text x="920" y="540" fill="#031B0B" font-family="Arial, sans-serif" font-size="23" font-weight="900">${xml(`${scan.market.buys1h ?? "—"} B / ${scan.market.sells1h ?? "—"} S`)}</text>

    <text x="884" y="614" fill="#708A7A" font-family="Arial, sans-serif" font-size="14" font-weight="700" letter-spacing="1">CONTRACT</text>
    <text x="884" y="646" fill="#D7E4DC" font-family="monospace" font-size="18" font-weight="700">${xml(compactAddress(scan.token.address))}</text>
    <text x="1208" y="676" text-anchor="end" fill="#42614D" font-family="Arial, sans-serif" font-size="13" font-weight="700">DATA IS INFORMATIONAL · DYOR</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

export async function generatePnlCard(call: CallRecord, scan: TokenScan): Promise<Buffer> {
  const mascotUrl = await mascot();
  const currentMarketCap = scan.market.marketCapUsd ?? scan.market.fdvUsd;
  const currentReturn = calculateReturn(call.entryMarketCapUsd, currentMarketCap);
  const athMultiple = calculateMultiple(call.entryMarketCapUsd, call.athMarketCapUsd);
  const positive = (currentReturn ?? 0) >= 0;
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <rect width="1280" height="720" fill="#07140D"/>
    <rect x="24" y="24" width="1232" height="672" rx="36" fill="#0D2116" stroke="#1F4931" stroke-width="2"/>
    <rect x="24" y="24" width="12" height="672" rx="6" fill="#00E86B"/>
    <text x="74" y="82" fill="#00E86B" font-family="Arial, sans-serif" font-size="22" font-weight="800" letter-spacing="4">KAPISCOUT PNL</text>
    <text x="74" y="170" fill="#F4F7F4" font-family="Arial, sans-serif" font-size="55" font-weight="900">$${xml(call.symbol)}</text>
    <text x="74" y="218" fill="#8AA596" font-family="Arial, sans-serif" font-size="22" font-weight="700">CALLED BY ${xml(call.username.toUpperCase())} · ${xml(formatAge(call.calledAt))} AGO</text>
    <text x="74" y="300" fill="#6F8E7C" font-family="Arial, sans-serif" font-size="17" font-weight="700" letter-spacing="2">CURRENT RETURN</text>
    <text x="74" y="390" fill="${positive ? "#00E86B" : "#FF6666"}" font-family="Arial, sans-serif" font-size="86" font-weight="900">${xml(formatPercent(currentReturn, true))}</text>
    ${metric(74, 448, "ENTRY MC", formatUsd(call.entryMarketCapUsd))}
    ${metric(327, 448, "CURRENT MC", formatUsd(currentMarketCap))}
    ${metric(580, 448, "ATH", athMultiple == null ? "N/A" : `${athMultiple.toFixed(2)}x`)}
    <rect x="884" y="58" width="324" height="510" rx="30" fill="#00C805"/>
    <clipPath id="pnlMascot"><rect x="900" y="76" width="292" height="292" rx="24"/></clipPath>
    <image href="${mascotUrl}" x="900" y="76" width="292" height="292" preserveAspectRatio="xMidYMid slice" clip-path="url(#pnlMascot)"/>
    <text x="920" y="424" fill="#05230F" font-family="Arial, sans-serif" font-size="16" font-weight="800" letter-spacing="2">ATH MARKET CAP</text>
    <text x="920" y="470" fill="#031B0B" font-family="Arial, sans-serif" font-size="32" font-weight="900">${xml(formatUsd(call.athMarketCapUsd))}</text>
    <text x="920" y="518" fill="#05230F" font-family="Arial, sans-serif" font-size="16" font-weight="800" letter-spacing="2">ROBINHOOD CHAIN</text>
    <text x="74" y="646" fill="#D7E4DC" font-family="monospace" font-size="18" font-weight="700">${xml(compactAddress(call.tokenAddress))}</text>
    <text x="1208" y="676" text-anchor="end" fill="#42614D" font-family="Arial, sans-serif" font-size="13" font-weight="700">PERFORMANCE SINCE FIRST CALL</text>
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
  const topRows = stats.slice(0, 3).map((item, index) => `
    <text x="90" y="${438 + index * 58}" fill="#718C7C" font-family="Arial,sans-serif" font-size="18" font-weight="800">0${index + 1}</text>
    <text x="138" y="${438 + index * 58}" fill="#F4F7F4" font-family="Arial,sans-serif" font-size="21" font-weight="800">${xml(item.username)}</text>
    <text x="700" y="${438 + index * 58}" text-anchor="end" fill="#00E86B" font-family="Arial,sans-serif" font-size="20" font-weight="900">${item.bestMultiple?.toFixed(2) ?? "—"}x</text>
  `).join("");
  const bestMultiple = best?.entryMarketCapUsd && best.athMarketCapUsd ? best.athMarketCapUsd / best.entryMarketCapUsd : null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <rect width="1280" height="720" fill="#06120C"/><rect x="24" y="24" width="1232" height="672" rx="30" fill="#0A1B12" stroke="#1D432E" stroke-width="2"/><rect x="24" y="24" width="8" height="672" rx="4" fill="#00E86B"/>
    <text x="74" y="76" fill="#00E86B" font-family="Arial,sans-serif" font-size="19" font-weight="900" letter-spacing="4">KAPISCOUT · GROUP REPORT</text>
    <text x="74" y="144" fill="#F4F7F4" font-family="Arial,sans-serif" font-size="42" font-weight="900">${xml(chatTitle.slice(0, 38))}</text>
    ${metric(74, 190, "CALLS", String(calls.length))}${metric(327, 190, "2X HITS", String(hits2x))}${metric(580, 190, "BEST", bestMultiple == null ? "N/A" : `${bestMultiple.toFixed(2)}x`)}
    <text x="74" y="362" fill="#6F8E7C" font-family="Arial,sans-serif" font-size="15" font-weight="900" letter-spacing="2">TOP CALLERS</text>${topRows || `<text x="90" y="438" fill="#718C7C" font-family="Arial,sans-serif" font-size="20">No priced calls yet</text>`}
    <rect x="864" y="58" width="344" height="570" rx="28" fill="#00C805"/><clipPath id="groupCapy"><rect x="886" y="82" width="300" height="300" rx="22"/></clipPath><image href="${mascotUrl}" x="886" y="82" width="300" height="300" preserveAspectRatio="xMidYMid slice" clip-path="url(#groupCapy)"/>
    <text x="902" y="438" fill="#05230F" font-family="Arial,sans-serif" font-size="16" font-weight="900" letter-spacing="2">BEST CALL</text><text x="902" y="488" fill="#031B0B" font-family="Arial,sans-serif" font-size="38" font-weight="900">${best ? `$${xml(best.symbol)}` : "—"}</text><text x="902" y="532" fill="#05230F" font-family="Arial,sans-serif" font-size="19" font-weight="800">${best ? xml(best.username) : "Waiting for alpha"}</text>
    <text x="74" y="662" fill="#526E5D" font-family="Arial,sans-serif" font-size="14" font-weight="700">ROBINHOOD CHAIN · PERFORMANCE FROM FIRST CALL</text>
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
  const actionColor = input.direction === "BUY" ? "#00E86B" : input.direction === "SELL" ? "#FF5C64" : "#55A7FF";
  const softColor = input.direction === "BUY" ? "#0D2B1A" : input.direction === "SELL" ? "#301417" : "#10243A";
  const heading = input.isKol ? "SMART MONEY" : "WALLET WATCH";
  const value = input.valueUsd == null ? "VALUE PENDING" : formatUsd(input.valueUsd);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <defs>
      <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="22"/></filter>
      <clipPath id="coin"><circle cx="1040" cy="262" r="148"/></clipPath>
    </defs>
    <rect width="1280" height="720" fill="#050C08"/>
    <circle cx="1110" cy="110" r="260" fill="${actionColor}" opacity=".09" filter="url(#glow)"/>
    <rect x="28" y="28" width="1224" height="664" rx="34" fill="#0A1710" stroke="#1B3526" stroke-width="2"/>
    <rect x="28" y="28" width="10" height="664" rx="5" fill="${actionColor}"/>

    <text x="78" y="82" fill="#00E86B" font-family="Arial,sans-serif" font-size="20" font-weight="900" letter-spacing="4">KAPISCOUT</text>
    <text x="260" y="82" fill="#6F8A79" font-family="Arial,sans-serif" font-size="16" font-weight="800" letter-spacing="2">${heading}</text>
    <rect x="78" y="111" width="728" height="1" fill="#1B3526"/>

    <rect x="78" y="148" width="150" height="48" rx="24" fill="${softColor}" stroke="${actionColor}"/>
    <circle cx="106" cy="172" r="6" fill="${actionColor}"/>
    <text x="124" y="180" fill="${actionColor}" font-family="Arial,sans-serif" font-size="20" font-weight="900">${input.direction}</text>
    <text x="78" y="266" fill="#F5F8F5" font-family="Arial,sans-serif" font-size="64" font-weight="900">$${xml(input.symbol.slice(0, 18))}</text>
    <text x="78" y="312" fill="#89A093" font-family="Arial,sans-serif" font-size="22" font-weight="700">${xml(input.label.slice(0, 34))} · ${xml(compactAddress(input.walletAddress as `0x${string}`))}</text>

    <text x="78" y="386" fill="#60766A" font-family="Arial,sans-serif" font-size="15" font-weight="900" letter-spacing="2">TRADE VALUE</text>
    <text x="78" y="452" fill="${actionColor}" font-family="Arial,sans-serif" font-size="54" font-weight="900">${xml(value)}</text>
    <text x="78" y="494" fill="#A9BAB0" font-family="Arial,sans-serif" font-size="20" font-weight="700">${xml(compactNumber(input.tokenAmount))} ${xml(input.symbol)} moved</text>

    ${alertMetric(78, 542, "PRICE", formatUsd(input.priceUsd))}
    ${alertMetric(318, 542, "MARKET CAP", formatUsd(input.marketCapUsd))}
    ${alertMetric(558, 542, "LIQUIDITY", formatUsd(input.liquidityUsd))}

    <circle cx="1040" cy="262" r="156" fill="${actionColor}" opacity=".18"/>
    <circle cx="1040" cy="262" r="148" fill="#0C2016" stroke="${actionColor}" stroke-width="3"/>
    <image href="${artwork}" x="892" y="114" width="296" height="296" preserveAspectRatio="xMidYMid slice" clip-path="url(#coin)"/>
    <circle cx="1146" cy="368" r="32" fill="${actionColor}"/>
    <text x="1146" y="379" text-anchor="middle" fill="#041208" font-family="Arial,sans-serif" font-size="34" font-weight="900">${input.direction === "BUY" ? "↗" : input.direction === "SELL" ? "↘" : "→"}</text>

    <rect x="856" y="452" width="368" height="182" rx="28" fill="#0E2117" stroke="#1D3C2A"/>
    <text x="888" y="494" fill="#657F71" font-family="Arial,sans-serif" font-size="14" font-weight="900" letter-spacing="2">ROBINHOOD INTELLIGENCE</text>
    <text x="888" y="534" fill="#F4F8F4" font-family="Arial,sans-serif" font-size="24" font-weight="900">Wallet Movement</text>
    <text x="888" y="566" fill="#88A092" font-family="Arial,sans-serif" font-size="16" font-weight="700">Observed directly from live RPC logs.</text>
    <text x="888" y="604" fill="#00E86B" font-family="Arial,sans-serif" font-size="15" font-weight="900">AUTOMATIC ALERT</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

export async function generatePaperPortfolioCard(snapshot: PaperPortfolioSnapshot): Promise<Buffer> {
  const positive = snapshot.totalPnlUsd >= 0;
  const accent = positive ? "#00E86B" : "#FF5C64";
  const rows = snapshot.positions.slice(0, 4).map((position, index) => {
    const y = 414 + index * 56;
    const pnlColor = position.unrealizedPnlUsd >= 0 ? "#00E86B" : "#FF6970";
    return `<text x="80" y="${y}" fill="#F3F7F4" font-family="Arial,sans-serif" font-size="20" font-weight="900">$${xml(position.symbol.slice(0, 14))}</text><text x="330" y="${y}" fill="#8BA094" font-family="Arial,sans-serif" font-size="18" font-weight="700">${xml(formatUsd(position.liquidationValueUsd))}</text><text x="575" y="${y}" text-anchor="end" fill="${pnlColor}" font-family="Arial,sans-serif" font-size="18" font-weight="900">${xml(formatSignedCardUsd(position.unrealizedPnlUsd))}</text><text x="635" y="${y}" fill="${position.quoteAvailable ? "#5C7767" : "#FFB45C"}" font-family="Arial,sans-serif" font-size="14" font-weight="800">${position.quoteAvailable ? "LIVE EXIT" : "NO EXIT"}</text>`;
  }).join("");
  const status = snapshot.competition.status === "ACTIVE" ? "LIVE COMPETITION" : "FINAL RESULT";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <rect width="1280" height="720" fill="#050C08"/><circle cx="1120" cy="130" r="330" fill="${accent}" opacity=".07"/>
    <rect x="26" y="26" width="1228" height="668" rx="34" fill="#0A1710" stroke="#1D3928" stroke-width="2"/><rect x="26" y="26" width="9" height="668" rx="5" fill="${accent}"/>
    <text x="78" y="78" fill="#00E86B" font-family="Arial,sans-serif" font-size="19" font-weight="900" letter-spacing="4">KAPISCOUT PAPER ARENA</text><text x="1198" y="78" text-anchor="end" fill="#698173" font-family="Arial,sans-serif" font-size="15" font-weight="900" letter-spacing="2">${status}</text>
    <text x="78" y="142" fill="#F5F8F5" font-family="Arial,sans-serif" font-size="34" font-weight="900">${xml(snapshot.competition.name.slice(0, 35))}</text><text x="78" y="178" fill="#7E9588" font-family="Arial,sans-serif" font-size="18" font-weight="700">${xml(snapshot.account.username)} · RANK ${snapshot.rank ?? "—"} / ${snapshot.participants}</text>
    <text x="78" y="238" fill="#687F72" font-family="Arial,sans-serif" font-size="14" font-weight="900" letter-spacing="2">LIQUIDATION BALANCE</text><text x="78" y="315" fill="#F5F8F5" font-family="Arial,sans-serif" font-size="70" font-weight="900">${xml(formatUsd(snapshot.equityUsd))}</text><text x="650" y="306" fill="${accent}" font-family="Arial,sans-serif" font-size="38" font-weight="900">${xml(`${snapshot.returnPercent >= 0 ? "+" : ""}${snapshot.returnPercent.toFixed(2)}%`)}</text>
    <line x1="78" y1="352" x2="760" y2="352" stroke="#1B3526"/><text x="80" y="385" fill="#60776A" font-family="Arial,sans-serif" font-size="13" font-weight="900" letter-spacing="2">POSITION</text><text x="330" y="385" fill="#60776A" font-family="Arial,sans-serif" font-size="13" font-weight="900" letter-spacing="2">EXIT VALUE</text><text x="575" y="385" text-anchor="end" fill="#60776A" font-family="Arial,sans-serif" font-size="13" font-weight="900" letter-spacing="2">OPEN PNL</text>${rows || `<text x="80" y="438" fill="#789084" font-family="Arial,sans-serif" font-size="20">No open positions</text>`}
    <rect x="815" y="132" width="383" height="456" rx="26" fill="#0E2117" stroke="#21442F"/>${paperMetric(850, 178, "CASH", formatUsd(snapshot.cashBalanceUsd))}${paperMetric(850, 280, "POSITIONS", formatUsd(snapshot.positionsValueUsd))}${paperMetric(850, 382, "TOTAL PNL", formatSignedCardUsd(snapshot.totalPnlUsd), accent)}${paperMetric(850, 484, "RECORD", `${snapshot.account.wins}W / ${snapshot.account.losses}L`)}
    <text x="78" y="653" fill="#526A5B" font-family="Arial,sans-serif" font-size="14" font-weight="800">VALUES USE LIVE UNISWAP V4 EXIT QUOTES · GAS INCLUDED</text><text x="1198" y="653" text-anchor="end" fill="#526A5B" font-family="Arial,sans-serif" font-size="14" font-weight="800">REFRESHED ${new Date(snapshot.refreshedAt).toISOString().slice(11, 19)} UTC</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

export async function generatePaperLeaderboardCard(competition: PaperCompetition, entries: PaperLeaderboardEntry[]): Promise<Buffer> {
  const rows = entries.slice(0, 7).map((entry, index) => {
    const y = 232 + index * 60;
    const color = entry.pnlUsd >= 0 ? "#00E86B" : "#FF6970";
    const rank = String(index + 1).padStart(2, "0");
    return `<text x="82" y="${y}" fill="${index < 3 ? "#00E86B" : "#6F8679"}" font-family="Arial,sans-serif" font-size="19" font-weight="900">${rank}</text><text x="142" y="${y}" fill="#F3F7F4" font-family="Arial,sans-serif" font-size="21" font-weight="900">${xml(entry.username.slice(0, 25))}</text><text x="630" y="${y}" text-anchor="end" fill="#F3F7F4" font-family="Arial,sans-serif" font-size="20" font-weight="800">${xml(formatUsd(entry.equityUsd))}</text><text x="820" y="${y}" text-anchor="end" fill="${color}" font-family="Arial,sans-serif" font-size="19" font-weight="900">${xml(`${entry.returnPercent >= 0 ? "+" : ""}${entry.returnPercent.toFixed(2)}%`)}</text><text x="966" y="${y}" text-anchor="end" fill="#81968A" font-family="Arial,sans-serif" font-size="17" font-weight="800">${entry.wins}W/${entry.losses}L</text><text x="1166" y="${y}" text-anchor="end" fill="#81968A" font-family="Arial,sans-serif" font-size="17" font-weight="800">${entry.openPositions}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#050C08"/><rect x="26" y="26" width="1228" height="668" rx="34" fill="#0A1710" stroke="#1D3928" stroke-width="2"/><rect x="26" y="26" width="9" height="668" rx="5" fill="#00E86B"/><text x="78" y="78" fill="#00E86B" font-family="Arial,sans-serif" font-size="19" font-weight="900" letter-spacing="4">KAPISCOUT PAPER ARENA</text><text x="78" y="137" fill="#F5F8F5" font-family="Arial,sans-serif" font-size="38" font-weight="900">${xml(competition.name.slice(0, 38))}</text><text x="1198" y="132" text-anchor="end" fill="${competition.status === "ACTIVE" ? "#00E86B" : "#82968A"}" font-family="Arial,sans-serif" font-size="17" font-weight="900">${competition.status === "ACTIVE" ? "LIVE STANDINGS" : "FINAL STANDINGS"}</text><line x1="78" y1="169" x2="1198" y2="169" stroke="#1B3526"/><text x="82" y="197" fill="#60776A" font-family="Arial,sans-serif" font-size="13" font-weight="900">RANK</text><text x="142" y="197" fill="#60776A" font-family="Arial,sans-serif" font-size="13" font-weight="900">TRADER</text><text x="630" y="197" text-anchor="end" fill="#60776A" font-family="Arial,sans-serif" font-size="13" font-weight="900">BALANCE</text><text x="820" y="197" text-anchor="end" fill="#60776A" font-family="Arial,sans-serif" font-size="13" font-weight="900">RETURN</text><text x="966" y="197" text-anchor="end" fill="#60776A" font-family="Arial,sans-serif" font-size="13" font-weight="900">RECORD</text><text x="1166" y="197" text-anchor="end" fill="#60776A" font-family="Arial,sans-serif" font-size="13" font-weight="900">OPEN</text>${rows || `<text x="78" y="250" fill="#789084" font-family="Arial,sans-serif" font-size="21">Waiting for the first trader to join.</text>`}<text x="78" y="655" fill="#526A5B" font-family="Arial,sans-serif" font-size="14" font-weight="800">RANKED BY EXECUTABLE LIQUIDATION BALANCE · GAS INCLUDED</text><text x="1198" y="655" text-anchor="end" fill="#526A5B" font-family="Arial,sans-serif" font-size="14" font-weight="800">${entries.length} PARTICIPANT${entries.length === 1 ? "" : "S"}</text></svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

function paperMetric(x: number, y: number, label: string, value: string, color = "#F5F8F5"): string {
  return `<text x="${x}" y="${y}" fill="#62796C" font-family="Arial,sans-serif" font-size="13" font-weight="900" letter-spacing="2">${xml(label)}</text><text x="${x}" y="${y + 48}" fill="${color}" font-family="Arial,sans-serif" font-size="31" font-weight="900">${xml(value)}</text>`;
}

function formatSignedCardUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatUsd(Math.abs(value))}`;
}

async function tokenArtwork(scan: TokenScan | null): Promise<string> {
  const url = scan?.token.iconUrl;
  if (url && /^https?:\/\//iu.test(url)) {
    const cached = artworkCache.get(url);
    if (cached) return cached;
    const pending = (async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3_500), headers: { "User-Agent": "KapiScout/0.1" } });
        if (response.ok) {
          const raw = Buffer.from(await response.arrayBuffer());
          if (raw.length <= 5_000_000) {
            const png = await sharp(raw).resize(400, 400, { fit: "cover" }).png().toBuffer();
            return `data:image/png;base64,${png.toString("base64")}`;
          }
        }
      } catch { /* Fall back to the mascot. */ }
      return mascot();
    })();
    artworkCache.set(url, pending);
    if (artworkCache.size > 200) artworkCache.delete(artworkCache.keys().next().value!);
    return pending;
  }
  return mascot();
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  for (const [size, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (Math.abs(value) >= size) return `${Number((value / size).toFixed(2))}${suffix}`;
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function alertMetric(x: number, y: number, label: string, value: string): string {
  return `<rect x="${x}" y="${y}" width="218" height="92" rx="16" fill="#102219" stroke="#1D3C2A"/><text x="${x + 18}" y="${y + 29}" fill="#667E70" font-family="Arial,sans-serif" font-size="13" font-weight="900" letter-spacing="1.5">${xml(label)}</text><text x="${x + 18}" y="${y + 67}" fill="#F2F6F3" font-family="Arial,sans-serif" font-size="25" font-weight="900">${xml(value)}</text>`;
}

function metric(x: number, y: number, label: string, value: string): string {
  return `
    <rect x="${x}" y="${y}" width="226" height="108" rx="18" fill="#132A1D" stroke="#244A33"/>
    <text x="${x + 20}" y="${y + 34}" fill="#6F8E7C" font-family="Arial, sans-serif" font-size="14" font-weight="800" letter-spacing="1.5">${xml(label)}</text>
    <text x="${x + 20}" y="${y + 79}" fill="#F4F7F4" font-family="Arial, sans-serif" font-size="29" font-weight="900">${xml(value)}</text>`;
}
