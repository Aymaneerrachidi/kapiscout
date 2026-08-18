import "dotenv/config";
import { getAddress, isAddress, type Address } from "viem";

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function address(name: string, fallback: Address): Address {
  const raw = process.env[name] ?? fallback;
  if (!isAddress(raw)) throw new Error(`${name} is not a valid EVM address`);
  return getAddress(raw);
}

function parseKols(raw: string | undefined): Array<{ label: string; address: Address }> {
  if (!raw?.trim()) return [];
  return raw.split(",").map((entry, index) => {
    const separator = entry.lastIndexOf("=");
    if (separator < 1) throw new Error(`KOL_WALLETS entry ${index + 1} must use Label=0xAddress`);
    const label = entry.slice(0, separator).trim();
    const candidate = entry.slice(separator + 1).trim();
    if (!label || !isAddress(candidate)) throw new Error(`Invalid KOL_WALLETS entry: ${entry}`);
    return { label, address: getAddress(candidate) };
  });
}

export interface AppConfig {
  telegramToken: string;
  rpcUrl: string;
  wsUrl: string | null;
  chainId: number;
  blockscoutApiUrl: string;
  blockscoutBrowserUrl: string;
  dexScreenerChainId: string;
  dbPath: string;
  blockPollIntervalMs: number;
  callRefreshIntervalMs: number;
  scanCacheTtlMs: number;
  maxWalletsPerChat: number;
  wethAddress: Address;
  usdgAddress: Address;
  kolWallets: Array<{ label: string; address: Address }>;
}

export function loadConfig(options: { requireTelegram?: boolean } = {}): AppConfig {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  if (options.requireTelegram !== false && !telegramToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and add the BotFather token.");
  }

  return {
    telegramToken,
    rpcUrl: process.env.RH_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com",
    wsUrl: process.env.RH_WS_URL?.trim() || null,
    chainId: integer("RH_CHAIN_ID", 4663),
    blockscoutApiUrl: (process.env.BLOCKSCOUT_API_URL?.trim() || "https://robinhoodchain.blockscout.com/api/v2").replace(/\/$/, ""),
    blockscoutBrowserUrl: (process.env.BLOCKSCOUT_BROWSER_URL?.trim() || "https://robinhoodchain.blockscout.com").replace(/\/$/, ""),
    dexScreenerChainId: process.env.DEXSCREENER_CHAIN_ID?.trim() || "robinhood",
    dbPath: process.env.DB_PATH?.trim() || "./data/kapiscout.db",
    blockPollIntervalMs: integer("BLOCK_POLL_INTERVAL_MS", 4_000),
    callRefreshIntervalMs: integer("CALL_REFRESH_INTERVAL_MS", 60_000),
    scanCacheTtlMs: integer("SCAN_CACHE_TTL_MS", 30_000),
    maxWalletsPerChat: integer("MAX_WALLETS_PER_CHAT", 5),
    wethAddress: address("WETH_ADDRESS", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
    usdgAddress: address("USDG_ADDRESS", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
    kolWallets: parseKols(process.env.KOL_WALLETS),
  };
}
