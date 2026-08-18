import { getAddress, isAddress, type Address } from "viem";
import type { HolderSummary, LaunchForensics, TokenIdentity } from "./types.js";

interface BlockscoutToken {
  address_hash?: string;
  circulating_market_cap?: string | null;
  decimals?: string | null;
  exchange_rate?: string | null;
  holders_count?: string | number | null;
  icon_url?: string | null;
  name?: string | null;
  symbol?: string | null;
  total_supply?: string | null;
  volume_24h?: string | null;
}

export interface BlockscoutTokenData extends Partial<TokenIdentity> {
  exchangeRateUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
}

interface HolderResponse {
  items?: Array<{
    address?: { hash?: string; is_contract?: boolean; name?: string | null };
    value?: string;
  }>;
}

interface LegacyHolderResponse {
  status?: string;
  message?: string;
  result?: Array<{ address?: string; value?: string }>;
}

interface LegacyTransferResponse {
  status?: string;
  result?: Array<{
    blockNumber?: string;
    hash?: string;
    from?: string;
    to?: string;
    value?: string;
  }>;
}

interface InternalTransactionsResponse {
  items?: Array<{ created_contract?: { hash?: string; is_verified?: boolean; name?: string | null } | null }>;
}

interface TransactionsResponse {
  items?: Array<{ hash?: string; from?: { hash?: string } | null }>;
}

export class BlockscoutClient {
  private readonly rootUrl: string;

  constructor(private readonly baseUrl: string) {
    this.rootUrl = baseUrl.replace(/\/api\/v2\/?$/u, "");
  }

  private async request<T>(path: string, allowNotFound = false): Promise<T | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}/${path.replace(/^\//, "")}`, {
          headers: { Accept: "application/json", "User-Agent": "KapiScout/0.1" },
          signal: AbortSignal.timeout(5_000),
        });
        if (allowNotFound && response.status === 404) return null;
        if (!response.ok) throw new Error(`Blockscout returned HTTP ${response.status} for ${path}`);
        return response.json() as Promise<T>;
      } catch (error) {
        lastError = error;
        if (attempt < 1) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Blockscout request failed for ${path}`);
  }

  async token(address: Address): Promise<BlockscoutTokenData | null> {
    const result = await this.request<BlockscoutToken>(`tokens/${address}`, true);
    if (!result) return null;
    return {
      address,
      name: result.name || "Unknown Token",
      symbol: result.symbol || "UNKNOWN",
      decimals: Number.parseInt(result.decimals || "18", 10),
      totalSupplyRaw: BigInt(result.total_supply || "0"),
      holdersCount: result.holders_count == null ? null : Number(result.holders_count),
      iconUrl: result.icon_url ?? null,
      exchangeRateUsd: finiteNumber(result.exchange_rate),
      marketCapUsd: finiteNumber(result.circulating_market_cap),
      volume24hUsd: finiteNumber(result.volume_24h),
    };
  }

  async holders(address: Address, totalSupplyRaw: bigint): Promise<HolderSummary> {
    const legacyUrl = new URL(`${this.rootUrl}/api`);
    legacyUrl.searchParams.set("module", "token");
    legacyUrl.searchParams.set("action", "getTokenHolders");
    legacyUrl.searchParams.set("contractaddress", address);
    legacyUrl.searchParams.set("page", "1");
    legacyUrl.searchParams.set("offset", "10");
    const legacy = await this.requestAbsolute<LegacyHolderResponse>(legacyUrl.toString()).catch(() => null);
    const legacyItems = legacy?.status === "1" ? legacy.result ?? [] : [];
    if (legacyItems.length) {
      const holders = legacyItems.flatMap((item) => {
        const rawAddress = item.address;
        if (!rawAddress || !isAddress(rawAddress)) return [];
        return [holder(getAddress(rawAddress), item.value, totalSupplyRaw, false, null)];
      });
      return {
        top10Percent: holders.reduce((sum, item) => sum + item.percent, 0),
        holders,
      };
    }

    const response = await this.request<HolderResponse>(`tokens/${address}/holders`, true);
    const holders = (response?.items?.slice(0, 10) ?? []).flatMap((item) => {
      const rawAddress = item.address?.hash;
      if (!rawAddress || !isAddress(rawAddress)) return [];
      return [holder(getAddress(rawAddress), item.value, totalSupplyRaw, Boolean(item.address?.is_contract), item.address?.name ?? null)];
    });
    return {
      top10Percent: holders.length ? holders.reduce((sum, item) => sum + item.percent, 0) : null,
      holders,
    };
  }

  private async requestAbsolute<T>(url: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": "KapiScout/0.1" },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`Blockscout returned HTTP ${response.status}`);
        return await response.json() as T;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Blockscout request failed");
  }

  async contractInfo(address: Address): Promise<{ verified: boolean; creator: Address | null }> {
    const addressInfo = await this.request<Record<string, unknown>>(`addresses/${address}`, true).catch(() => null);
    const rawCreator = addressInfo?.creator_address_hash;
    return {
      verified: Boolean(addressInfo?.is_verified),
      creator: typeof rawCreator === "string" && isAddress(rawCreator) ? getAddress(rawCreator) : null,
    };
  }

  async createdTokenContracts(address: Address, limit = 12): Promise<Array<{ address: Address; token: BlockscoutTokenData; verified: boolean }>> {
    const response = await this.request<InternalTransactionsResponse>(`addresses/${address}/internal-transactions`, true).catch(() => null);
    const contracts = [...new Set((response?.items ?? []).flatMap((item) => {
      const hash = item.created_contract?.hash;
      return hash && isAddress(hash) ? [getAddress(hash)] : [];
    }))].slice(0, Math.max(limit * 3, limit));
    const inspected = await Promise.all(contracts.map(async (candidate) => {
      const [token, info] = await Promise.all([
        this.token(candidate).catch(() => null),
        this.contractInfo(candidate).catch(() => ({ verified: false, creator: null })),
      ]);
      return token?.symbol && token.totalSupplyRaw != null ? { address: candidate, token, verified: info.verified } : null;
    }));
    return inspected.filter((item): item is NonNullable<typeof item> => item != null).slice(0, limit);
  }

  async creationOriginator(contract: Address): Promise<Address | null> {
    const info = await this.request<Record<string, unknown>>(`addresses/${contract}`, true).catch(() => null);
    const hash = info?.creation_transaction_hash;
    if (typeof hash !== "string") return null;
    const tx = await this.request<{ from?: { hash?: string } | null }>(`transactions/${hash}`, true).catch(() => null);
    const from = tx?.from?.hash;
    return from && isAddress(from) ? getAddress(from) : null;
  }

  async originatedTokenContracts(originator: Address, limit = 12): Promise<Array<{ address: Address; token: BlockscoutTokenData; verified: boolean }>> {
    const response = await this.request<TransactionsResponse>(`addresses/${originator}/transactions`, true).catch(() => null);
    const hashes = (response?.items ?? []).flatMap((item) =>
      item.hash && item.from?.hash?.toLowerCase() === originator.toLowerCase() ? [item.hash] : [],
    ).slice(0, 20);
    const internal = await Promise.all(hashes.map((hash) => this.request<InternalTransactionsResponse>(`transactions/${hash}/internal-transactions`, true).catch(() => null)));
    const contracts = [...new Set(internal.flatMap((page) => (page?.items ?? []).flatMap((item) => {
      const hash = item.created_contract?.hash;
      return hash && isAddress(hash) ? [getAddress(hash)] : [];
    })))].slice(0, Math.max(limit * 3, limit));
    const inspected = await Promise.all(contracts.map(async (candidate) => {
      const [token, info] = await Promise.all([this.token(candidate).catch(() => null), this.contractInfo(candidate).catch(() => ({ verified: false, creator: null }))]);
      return token?.symbol && token.totalSupplyRaw != null ? { address: candidate, token, verified: info.verified } : null;
    }));
    return inspected.filter((item): item is NonNullable<typeof item> => item != null).slice(0, limit);
  }

  async blockByTimestamp(timestampSeconds: number): Promise<bigint | null> {
    const url = new URL(`${this.rootUrl}/api`);
    url.searchParams.set("module", "block");
    url.searchParams.set("action", "getblocknobytime");
    url.searchParams.set("timestamp", String(Math.floor(timestampSeconds)));
    url.searchParams.set("closest", "before");
    const response = await this.requestAbsolute<{ status?: string; result?: string | { blockNumber?: string } }>(url.toString()).catch(() => null);
    const raw = typeof response?.result === "string" ? response.result : response?.result?.blockNumber;
    if (!raw || !/^\d+$/u.test(raw)) return null;
    return BigInt(raw);
  }

  async launchForensics(address: Address, totalSupplyRaw: bigint): Promise<LaunchForensics> {
    const url = new URL(`${this.rootUrl}/api`);
    url.searchParams.set("module", "account");
    url.searchParams.set("action", "tokentx");
    url.searchParams.set("contractaddress", address);
    url.searchParams.set("page", "1");
    url.searchParams.set("offset", "100");
    url.searchParams.set("sort", "asc");
    const response = await this.requestAbsolute<LegacyTransferResponse>(url.toString());
    const transfers = response.status === "1" ? response.result ?? [] : [];
    const launchBlock = transfers.map((item) => Number(item.blockNumber)).find(Number.isFinite) ?? null;
    if (launchBlock == null) return unknownLaunch("No launch transfers were indexed");
    const firstBlock = transfers.filter((item) => Number(item.blockNumber) === launchBlock);
    const nonMint = firstBlock.filter((item) => item.from?.toLowerCase() !== "0x0000000000000000000000000000000000000000");
    const recipients = new Set(nonMint.flatMap((item) => item.to ? [item.to.toLowerCase()] : []));
    const transactions = new Set(nonMint.flatMap((item) => item.hash ? [item.hash.toLowerCase()] : []));
    const distributed = nonMint.reduce((sum, item) => {
      try { return sum + BigInt(item.value || "0"); } catch { return sum; }
    }, 0n);
    const supplyPercent = totalSupplyRaw > 0n
      ? Number((distributed * 1_000_000n) / totalSupplyRaw) / 10_000
      : null;
    let clusterScore = 10;
    if (recipients.size >= 4) clusterScore += 20;
    if (recipients.size >= 8) clusterScore += 25;
    if (recipients.size >= 15) clusterScore += 20;
    if (recipients.size >= 4 && transactions.size <= 2) clusterScore += 15;
    clusterScore = Math.min(100, clusterScore);
    const risk: LaunchForensics["risk"] = clusterScore >= 70 ? "HIGH" : clusterScore >= 40 ? "WATCH" : "LOW";
    return {
      launchBlock,
      firstBlockRecipients: recipients.size,
      firstBlockTransactions: transactions.size,
      firstBlockSupplyPercent: supplyPercent == null ? null : Math.min(100, supplyPercent),
      clusterScore,
      risk,
      note: "Heuristic based on same-block token distributions; linked funding is not assumed.",
    };
  }
}

function unknownLaunch(note: string): LaunchForensics {
  return { launchBlock: null, firstBlockRecipients: 0, firstBlockTransactions: 0, firstBlockSupplyPercent: null, clusterScore: null, risk: "UNKNOWN", note };
}

function holder(
  address: Address,
  rawValue: string | undefined,
  totalSupplyRaw: bigint,
  isContract: boolean,
  label: string | null,
): HolderSummary["holders"][number] {
  const raw = BigInt(rawValue || "0");
  const percent = totalSupplyRaw > 0n
    ? Number((raw * 1_000_000n) / totalSupplyRaw) / 10_000
    : 0;
  return { address, percent, isContract, label };
}

function finiteNumber(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
