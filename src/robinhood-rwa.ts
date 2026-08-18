import type { Address } from "viem";
import type { RobinhoodCorporateAction, RobinhoodRwaAsset, RobinhoodRwaQuote } from "./types.js";

interface ApiDeployment { contractAddress?: string; chainId?: number }
interface ApiAsset {
  tokenSymbol?: string;
  tokenName?: string;
  deployments?: ApiDeployment[];
  currentMultiplier?: string;
  pendingMultiplier?: string;
  pendingMultiplierEffectiveTime?: string;
  logoUrl?: string;
  status?: string;
  tradingCapabilities?: {
    allDayTradability?: string | null;
    fractionalTradability?: string | null;
    extendedHoursFractionalTradability?: boolean | null;
  } | null;
}

interface ApiQuote {
  bid?: string;
  ask?: string;
  dailyTradingVolume?: string;
  isTradingHalt?: boolean;
  generatedAt?: string;
}

interface ApiCorporateAction {
  type?: string;
  status?: string;
  tokenSymbol?: string;
  processDate?: { year?: number; month?: number; day?: number } | null;
  details?: Record<string, Record<string, string>>;
}

export class RobinhoodRwaClient {
  private assetsCache: { expiresAt: number; byAddress: Map<string, RobinhoodRwaAsset> } | null = null;
  private actionsCache: { expiresAt: number; value: ApiCorporateAction[] } | null = null;

  constructor(
    private readonly chainId: number,
    private readonly baseUrl = "https://api.robinhood.com/rhj",
  ) {}

  async assetForAddress(address: Address): Promise<RobinhoodRwaAsset | null> {
    const assets = await this.assets();
    return assets.get(address.toLowerCase()) ?? null;
  }

  async quote(symbol: string): Promise<RobinhoodRwaQuote | null> {
    const payload = await this.request<{ quotes?: ApiQuote[] }>(`prices/${encodeURIComponent(symbol)}`);
    const quote = payload.quotes?.[0];
    if (!quote) return null;
    return {
      bid: finite(quote.bid),
      ask: finite(quote.ask),
      dailyTradingVolume: finite(quote.dailyTradingVolume),
      isTradingHalt: Boolean(quote.isTradingHalt),
      generatedAt: quote.generatedAt ?? null,
    };
  }

  async corporateActions(symbol: string): Promise<RobinhoodCorporateAction[]> {
    let actions = this.actionsCache?.expiresAt && this.actionsCache.expiresAt > Date.now()
      ? this.actionsCache.value
      : null;
    if (!actions) {
      const payload = await this.request<{ corpActions?: ApiCorporateAction[] }>("corporate-actions");
      actions = payload.corpActions ?? [];
      this.actionsCache = { expiresAt: Date.now() + 60 * 60_000, value: actions };
    }
    return actions.filter((action) => action.tokenSymbol?.toLowerCase() === symbol.toLowerCase()).slice(0, 3).map(mapAction);
  }

  private async assets(): Promise<Map<string, RobinhoodRwaAsset>> {
    if (this.assetsCache && this.assetsCache.expiresAt > Date.now()) return this.assetsCache.byAddress;
    const payload = await this.request<{ assets?: ApiAsset[] }>("assets");
    const byAddress = new Map<string, RobinhoodRwaAsset>();
    for (const asset of payload.assets ?? []) {
      const deployment = asset.deployments?.find((item) => item.chainId === this.chainId && item.contractAddress);
      if (!deployment?.contractAddress || !asset.tokenSymbol) continue;
      byAddress.set(deployment.contractAddress.toLowerCase(), {
        tokenSymbol: asset.tokenSymbol,
        tokenName: asset.tokenName ?? asset.tokenSymbol,
        currentMultiplier: finite(asset.currentMultiplier),
        pendingMultiplier: finite(asset.pendingMultiplier),
        pendingMultiplierEffectiveTime: asset.pendingMultiplierEffectiveTime ?? null,
        logoUrl: asset.logoUrl ?? null,
        status: asset.status ?? "ASSET_STATUS_UNSPECIFIED",
        allDayTradability: asset.tradingCapabilities?.allDayTradability ?? null,
        fractionalTradability: asset.tradingCapabilities?.fractionalTradability ?? null,
        extendedHoursFractionalTradability: asset.tradingCapabilities?.extendedHoursFractionalTradability ?? null,
      });
    }
    this.assetsCache = { expiresAt: Date.now() + 60 * 60_000, byAddress };
    return byAddress;
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${path}`, {
      headers: { Accept: "application/json", "User-Agent": "KapiScout/0.2" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Robinhood RWA API returned HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }
}

function mapAction(action: ApiCorporateAction): RobinhoodCorporateAction {
  const values = Object.values(action.details ?? {})[0] ?? {};
  const details = Object.entries(values)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${humanize(key)} ${value}`)
    .join(" · ");
  const date = action.processDate;
  const processDate = date?.year && date.month && date.day
    ? `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`
    : null;
  return {
    type: humanize(action.type?.replace("CORPORATE_ACTION_TYPE_", "") ?? "Unknown"),
    status: humanize(action.status?.replace("CORPORATE_ACTION_STATUS_", "") ?? "Unknown"),
    processDate,
    summary: details || "No additional details",
  };
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase().replace(/^./u, (letter) => letter.toUpperCase());
}

function finite(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
