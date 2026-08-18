import { createPublicClient, defineChain, http, webSocket, type PublicClient } from "viem";
import type { AppConfig } from "./config.js";

export function createRobinhoodChain(config: AppConfig) {
  return defineChain({
    id: config.chainId,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [config.rpcUrl], webSocket: config.wsUrl ? [config.wsUrl] : undefined },
    },
    blockExplorers: {
      default: { name: "Blockscout", url: config.blockscoutBrowserUrl },
    },
  });
}

export function createRobinhoodClient(config: AppConfig): PublicClient {
  const chain = createRobinhoodChain(config);
  return createPublicClient({
    chain,
    transport: config.wsUrl
      ? webSocket(config.wsUrl, { reconnect: true, retryCount: 5 })
      : http(config.rpcUrl, { batch: true, retryCount: 3, retryDelay: 500 }),
    pollingInterval: config.blockPollIntervalMs,
  });
}
