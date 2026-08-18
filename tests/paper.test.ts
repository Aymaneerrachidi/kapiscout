import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { Store } from "../src/db.js";
import { PaperCompetitionService } from "../src/paper.js";
import type { TokenScanner } from "../src/scanner.js";
import type { TokenScan } from "../src/types.js";

const directories:string[]=[];
const openStores: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const store of openStores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const directory of directories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* windows file lock */ }
  }
});

describe("PaperCompetitionService",()=>{
  it("buys, values, sells, and ranks with executable quotes",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"kapiscout-paper-"));directories.push(directory);
    const store = new Store(join(directory,"paper.db"));
    await store.init();
  openStores.push(store);
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const scan:TokenScan={token:{address:token,name:"KapiScout",symbol:"KAPI",decimals:18,totalSupplyRaw:1_000_000n*10n**18n,holdersCount:100,iconUrl:null},market:{pairAddress:`0x${"4".repeat(64)}`,dexId:"uniswap",pairUrl:null,quoteSymbol:"WETH",priceUsd:1,marketCapUsd:1_000_000,fdvUsd:1_000_000,liquidityUsd:100_000,volume24hUsd:10_000,priceChange1h:0,priceChange24h:0,buys1h:1,sells1h:1,buys24h:1,sells24h:1,pairCreatedAt:Date.now(),websites:[],socials:[],dexPaid:false},holders:{top10Percent:20,holders:[]},verified:true,creator:null,warnings:[],scannedAt:Date.now()};
    const scanner={
      scan:async()=>scan,
      quotePaperBuy:async(_scan:TokenScan,usd:number)=>({side:"BUY" as const,source:"UNISWAP_V4" as const,tokenAmount:usd,grossValueUsd:usd,gasCostUsd:1,executionPriceUsd:1,priceImpactPercent:0,gasEstimate:100n,quotedAt:Date.now()}),
      quotePaperSell:async(_scan:TokenScan,amount:number)=>({side:"SELL" as const,source:"UNISWAP_V4" as const,tokenAmount:amount,grossValueUsd:amount*1.2,gasCostUsd:1,executionPriceUsd:1.2,priceImpactPercent:0,gasEstimate:100n,quotedAt:Date.now()}),
    } as unknown as TokenScanner;
    const paper=new PaperCompetitionService(store,scanner);
    const competition=await paper.create("chat","Kapi Cup",10_000,7,"admin");
    await paper.join("chat","alice","@alice");await paper.join("chat","bob","@bob");
    await paper.buy("chat","alice",token,1_000);
    const snapshot=await paper.portfolio("chat","alice");
    expect(snapshot.cashBalanceUsd).toBe(8_999);
    expect(snapshot.positionsValueUsd).toBe(1_199);
    expect(snapshot.equityUsd).toBe(10_198);
    expect(snapshot.rank).toBe(1);
    const sale=await paper.sell("chat","alice",token,0.5);
    expect(sale.realizedPnlUsd).toBeCloseTo(98.5);
    const ended=await paper.end("chat");
    expect(ended.entries[0]?.userId).toBe("alice");
    expect((await store.paperCompetitionById(competition.id))?.status).toBe("ENDED");
    await store.close();
  });

  it("auto-grants a $100 account on first use without a started competition",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"kapiscout-paper-"));directories.push(directory);
    const store = new Store(join(directory,"paper.db"));
    await store.init();
  openStores.push(store);
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const scan:TokenScan={token:{address:token,name:"KapiScout",symbol:"KAPI",decimals:18,totalSupplyRaw:1_000_000n*10n**18n,holdersCount:100,iconUrl:null},market:{pairAddress:`0x${"4".repeat(64)}`,dexId:"uniswap",pairUrl:null,quoteSymbol:"WETH",priceUsd:1,marketCapUsd:1_000_000,fdvUsd:1_000_000,liquidityUsd:100_000,volume24hUsd:10_000,priceChange1h:0,priceChange24h:0,buys1h:1,sells1h:1,buys24h:1,sells24h:1,pairCreatedAt:Date.now(),websites:[],socials:[],dexPaid:false},holders:{top10Percent:20,holders:[]},verified:true,creator:null,warnings:[],scannedAt:Date.now()};
    const scanner={
      scan:async()=>scan,
      quotePaperBuy:async(_scan:TokenScan,usd:number)=>({side:"BUY" as const,source:"UNISWAP_V4" as const,tokenAmount:usd,grossValueUsd:usd,gasCostUsd:1,executionPriceUsd:1,priceImpactPercent:0,gasEstimate:100n,quotedAt:Date.now()}),
      quotePaperSell:async(_scan:TokenScan,amount:number)=>({side:"SELL" as const,source:"UNISWAP_V4" as const,tokenAmount:amount,grossValueUsd:amount*1.2,gasCostUsd:1,executionPriceUsd:1.2,priceImpactPercent:0,gasEstimate:100n,quotedAt:Date.now()}),
    } as unknown as TokenScanner;
    const paper=new PaperCompetitionService(store,scanner);
    const competition=await store.activePaperCompetition("chat");
    expect(competition).toBeNull();
    const account=await paper.ensureAccount("chat","alice","@alice");
    expect(account.startingBalanceUsd).toBe(100);
    expect(account.cashBalanceUsd).toBe(100);
    const active=await paper.active("chat");
    expect(active?.startingBalanceUsd).toBe(100);
    expect(active?.status).toBe("ACTIVE");
    await paper.buy("chat","alice",token,50);
    const snapshot=await paper.portfolio("chat","alice");
    expect(snapshot.cashBalanceUsd).toBeCloseTo(49);
    const board=await paper.leaderboard("chat");
    expect(board.entries[0]?.username).toBe("@alice");
    expect(board.entries[0]?.equityUsd).toBeGreaterThan(100);
    const duplicate=await paper.ensureAccount("chat","alice","@alice");
    expect(duplicate.cashBalanceUsd).toBeCloseTo(49);
    await store.close();
  });
});
