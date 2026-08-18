import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { Store } from "../src/db.js";
import { buildDailyDigest } from "../src/features.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function storeFixture(): Store {
  const directory = mkdtempSync(join(tmpdir(), "kapiscout-features-"));
  directories.push(directory);
  const store = new Store(join(directory, "features.db"));
  store.ensureChat("1", "Signals");
  return store;
}

const wallet = getAddress("0x1111111111111111111111111111111111111111");
const token = getAddress("0x2222222222222222222222222222222222222222");

describe("advanced feature store", () => {
  it("builds an observed portfolio and wallet score from deduplicated movements", () => {
    const store = storeFixture();
    const base = { chatId: "1", walletAddress: wallet, walletLabel: "Smart Ape", tokenAddress: token, symbol: "KAPI", priceUsd: 1, marketCapUsd: 1_000_000, liquidityUsd: 100_000, occurredAt: Date.now() };
    expect(store.recordWalletMovement({ ...base, txHash: `0x${"1".repeat(64)}`, direction: "BUY", tokenAmount: 100, valueUsd: 100 })).toBe(true);
    expect(store.recordWalletMovement({ ...base, txHash: `0x${"2".repeat(64)}`, direction: "SELL", tokenAmount: 25, valueUsd: 50, priceUsd: 2 })).toBe(true);
    expect(store.recordWalletMovement({ ...base, txHash: `0x${"2".repeat(64)}`, direction: "SELL", tokenAmount: 25, valueUsd: 50, priceUsd: 2 })).toBe(false);
    const position = store.walletPortfolio("1", wallet)[0]!;
    expect(position.tokenAmount).toBe(75);
    expect(position.costBasisUsd).toBe(75);
    expect(position.realizedUsd).toBe(25);
    expect(store.smartWalletScore("1", wallet)?.trades).toBe(2);
    store.close();
  });

  it("stores custom rules, paper trades, bridge flows and digest data", () => {
    const store = storeFixture();
    const rule = store.addAlertRule({ chatId: "1", name: "Early", direction: "BUY", minValueUsd: 5_000, minMarketCapUsd: 0, maxMarketCapUsd: 100_000, minLiquidityUsd: 10_000, minWallets: 2, windowMinutes: 5 });
    expect(store.listAlertRules("1")[0]?.name).toBe("Early");
    expect(store.claimCustomAlert(rule, token)).toBe(true);
    expect(store.claimCustomAlert(rule, token)).toBe(false);

    store.paperBuy("1", "7", token, "KAPI", 100, 1);
    const sold = store.paperSell("1", "7", token, 0.5, 2)!;
    expect(sold.tokenAmount).toBe(50);
    expect(sold.realizedPnlUsd).toBe(50);

    const hash = `0x${"3".repeat(64)}` as `0x${string}`;
    expect(store.recordBridgeFlow({ txHash: hash, direction: "IN", asset: "ETH", amount: 10, valueUsd: 20_000, wallet, occurredAt: Date.now() })).toBe(true);
    expect(store.recordBridgeFlow({ txHash: hash, direction: "IN", asset: "ETH", amount: 10, valueUsd: 20_000, wallet, occurredAt: Date.now() })).toBe(false);
    expect(store.recentBridgeFlows(Date.now() - 1_000)).toHaveLength(1);
    expect(buildDailyDigest(store, "1")).toContain("DAILY EDGE");
    store.close();
  });
});
