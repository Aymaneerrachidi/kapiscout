import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { Store } from "../src/db.js";
import type { TokenScan } from "../src/types.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore(): Store {
  const directory = mkdtempSync(join(tmpdir(), "kapiscout-test-"));
  directories.push(directory);
  return new Store(join(directory, "test.db"));
}

function fixture(): TokenScan {
  return {
    token: {
      address: getAddress("0x3333333333333333333333333333333333333333"),
      name: "KapiScout",
      symbol: "KAPI",
      decimals: 18,
      totalSupplyRaw: 1_000_000n * 10n ** 18n,
      holdersCount: 100,
      iconUrl: null,
    },
    market: {
      pairAddress: null, dexId: "uniswap", pairUrl: null, quoteSymbol: "WETH",
      priceUsd: 0.001, marketCapUsd: 100_000, fdvUsd: 100_000, liquidityUsd: 20_000,
      volume24hUsd: 5_000, priceChange1h: 3, priceChange24h: 10,
      buys1h: 8, sells1h: 2, buys24h: 20, sells24h: 5,
      pairCreatedAt: Date.now(), websites: [], socials: [], dexPaid: false,
    },
    holders: { top10Percent: 25, holders: [] },
    verified: true,
    creator: null,
    warnings: [],
    scannedAt: Date.now(),
  };
}

describe("Store", () => {
  it("records only the first call for a token in a chat", () => {
    const store = createStore();
    store.ensureChat("1", "Test");
    const first = store.recordCall({ chatId: "1", messageId: 1, userId: "2", username: "@scout", scan: fixture() });
    const laterScan = fixture();
    laterScan.market.marketCapUsd = 250_000;
    const second = store.recordCall({ chatId: "1", messageId: 2, userId: "3", username: "@later", scan: laterScan });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.call.username).toBe("@scout");
    expect(second.call.entryMarketCapUsd).toBe(100_000);
    expect(second.call.lastMarketCapUsd).toBe(250_000);
    expect(second.call.scanCount).toBe(2);
    expect(second.call.proofHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(store.marketHistory(second.call.id)).toHaveLength(1);
    expect(store.realAlphaLeaderboard("1")).toHaveLength(1);
    store.close();
  });

  it("migrates advanced settings and security wallet watches", () => {
    const store = createStore();
    store.ensureChat("10", "Test");
    store.updateChatSetting("10", "admin_only", true);
    store.updateMinMarketCap("10", 25_000);
    store.updateChartPreference("10", "price", "15m");
    const scan = fixture();
    scan.creator = getAddress("0x1111111111111111111111111111111111111111");
    scan.holders.holders = [{ address: getAddress("0x2222222222222222222222222222222222222222"), percent: 3.5, isContract: false, label: null }];
    store.recordCall({ chatId: "10", messageId: 1, userId: "2", username: "@scout", scan });
    const settings = store.getChatSettings("10");
    expect(settings.adminOnly).toBe(true);
    expect(settings.minMarketCapUsd).toBe(25_000);
    expect(settings.chartMetric).toBe("price");
    expect(settings.chartTimeframe).toBe("15m");
    expect(store.securityWatchedAddressSet().size).toBe(2);
    store.close();
  });

  it("tracks custom wallets per chat", () => {
    const store = createStore();
    const address = getAddress("0x1111111111111111111111111111111111111111");
    store.addWallet("10", "20", address, "Main");
    expect(store.countCustomWallets("10")).toBe(1);
    expect(store.listWallets("10")[0]?.label).toBe("Main");
    expect(store.renameWallet("10", address, "Smart Money")).toBe(true);
    expect(store.listWallets("10")[0]?.label).toBe("Smart Money");
    expect(store.removeWallet("10", address)).toBe(true);
    store.close();
  });

  it("keeps an exact competition cash ledger with realized wins and final rankings", () => {
    const store=createStore();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const competition=store.createPaperCompetition({chatId:"arena",name:"Kapi Cup",startingBalanceUsd:10_000,durationDays:7,createdBy:"admin"});
    store.joinPaperCompetition(competition.id,"trader","@trader");
    store.executeCompetitionBuy({competitionId:competition.id,userId:"trader",tokenAddress:token,symbol:"KAPI",marketCapUsd:100_000,quote:{side:"BUY",source:"UNISWAP_V4",tokenAmount:500,grossValueUsd:1_000,gasCostUsd:2,executionPriceUsd:2,priceImpactPercent:1,gasEstimate:100_000n,quotedAt:Date.now()}});
    expect(store.paperCompetitionAccount(competition.id,"trader")?.cashBalanceUsd).toBe(8_998);
    const sale=store.executeCompetitionSell({competitionId:competition.id,userId:"trader",tokenAddress:token,symbol:"KAPI",marketCapUsd:120_000,quote:{side:"SELL",source:"UNISWAP_V4",tokenAmount:250,grossValueUsd:600,gasCostUsd:1,executionPriceUsd:2.4,priceImpactPercent:2,gasEstimate:100_000n,quotedAt:Date.now()}});
    expect(sale.realizedPnlUsd).toBe(98);
    expect(store.paperCompetitionAccount(competition.id,"trader")).toMatchObject({cashBalanceUsd:9_597,realizedPnlUsd:98,wins:1,losses:0});
    expect(store.paperCompetitionTrades(competition.id,"trader")).toHaveLength(2);
    store.finalizePaperCompetition(competition.id,[{userId:"trader",equityUsd:10_100,pnlUsd:100,rank:1}]);
    expect(store.paperCompetitionAccount(competition.id,"trader")).toMatchObject({finalEquityUsd:10_100,finalPnlUsd:100,finalRank:1});
    expect(store.paperCompetitionById(competition.id)?.status).toBe("ENDED");
    store.close();
  });
});
