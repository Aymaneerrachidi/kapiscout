import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
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

function scanFor(token:Address, priceUsd=1, symbol="KAPI"):TokenScan {
  return {token:{address:token,name:"KapiScout",symbol:symbol,decimals:18,totalSupplyRaw:1_000_000n*10n**18n,holdersCount:100,iconUrl:null},market:{pairAddress:`0x${"4".repeat(64)}`,dexId:"uniswap",pairUrl:null,quoteSymbol:"WETH",priceUsd,marketCapUsd:priceUsd*1_000_000,fdvUsd:priceUsd*1_000_000,liquidityUsd:100_000,volume24hUsd:10_000,priceChange1h:0,priceChange24h:0,buys1h:1,sells1h:1,buys24h:1,sells24h:1,pairCreatedAt:Date.now(),websites:[],socials:[],dexPaid:false},holders:{top10Percent:20,holders:[]},verified:true,creator:null,warnings:[],scannedAt:Date.now()};
}

function scannerStub(options:{prices?:Record<string,number>;spread?:number;gas?:number;failScan?:Record<string,string>} = {}): {scanner:TokenScanner; prices:Record<string,number>; failScan:Record<string,string>} {
  const prices:Record<string,number> = options.prices ?? {};
  const spread=options.spread ?? 1.2;
  const gas=options.gas ?? 1;
  const failScan:Record<string,string> = options.failScan ?? {};
  const scanner={
    scan:async(token:Address)=>{
      const f=failScan[token.toLowerCase()];
      if(f)throw new Error(f);
      const price=prices[token.toLowerCase()] ?? 1;
      return scanFor(token,price);
    },
    quotePaperBuy:async(scan:TokenScan,usd:number)=>({side:"BUY" as const,source:"UNISWAP_V4" as const,tokenAmount:usd/scan.market.priceUsd!,grossValueUsd:usd,gasCostUsd:gas,executionPriceUsd:scan.market.priceUsd!,priceImpactPercent:0,gasEstimate:100n,quotedAt:Date.now()}),
    quotePaperSell:async(scan:TokenScan,amount:number)=>({side:"SELL" as const,source:"UNISWAP_V4" as const,tokenAmount:amount,grossValueUsd:amount*scan.market.priceUsd!*spread,gasCostUsd:gas,executionPriceUsd:scan.market.priceUsd!*spread,priceImpactPercent:0,gasEstimate:100n,quotedAt:Date.now()}),
  } as unknown as TokenScanner;
  return {scanner,prices,failScan};
}

function storeFor():Store{
  const directory=mkdtempSync(join(tmpdir(),"kapiscout-paper-"));directories.push(directory);
  const store = new Store(join(directory,"paper.db"));
  openStores.push(store);
  return store;
}

describe("PaperCompetitionService",()=>{
  it("buys, values, sells, and ranks with executable quotes",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner}=scannerStub();
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
  });

  it("auto-grants a $100 account on first use without a started competition",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner}=scannerStub();
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
  });

  it("does not regrant cash to existing accounts and preserves username when omitted",async()=>{
    const store=storeFor();await store.init();
    const {scanner}=scannerStub();
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice_old");
    await paper.ensureAccount("chat","alice");
    expect((await paper.account((await paper.active("chat"))!.id,"alice"))?.username).toBe("@alice_old");
    await paper.ensureAccount("chat","alice","@alice_new");
    expect((await paper.account((await paper.active("chat"))!.id,"alice"))?.username).toBe("@alice_new");
    const bob=await paper.ensureAccount("chat","bob");
    expect(bob.username).toBe("bob");
    expect(bob.cashBalanceUsd).toBe(100);
  });

  it("rejects invalid buy amounts",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner}=scannerStub();
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    for(const amount of [0,-5,Number.NaN,Number.POSITIVE_INFINITY,Number.NEGATIVE_INFINITY]){
      await expect(paper.buy("chat","alice",token,amount)).rejects.toThrow();
    }
    const snapshot=await paper.portfolio("chat","alice");
    expect(snapshot.cashBalanceUsd).toBe(100);
  });

  it("rejects buys beyond the available cash and allows valid buys afterwards",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner}=scannerStub({gas:1});
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await expect(paper.buy("chat","alice",token,200)).rejects.toThrow(/Insufficient paper cash/);
    await expect(paper.buy("chat","alice",token,99.5)).rejects.toThrow(/Insufficient paper cash/);
    const ok=await paper.buy("chat","alice",token,50);
    expect(ok.spentUsd).toBe(51);
    expect(ok.gasCostUsd).toBe(1);
    expect((await paper.portfolio("chat","alice")).cashBalanceUsd).toBeCloseTo(49);
  });

  it("allows buying the full balance minus gas",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner}=scannerStub({gas:1});
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.buy("chat","alice",token,99);
    const snapshot=await paper.portfolio("chat","alice");
    expect(snapshot.cashBalanceUsd).toBeCloseTo(0);
    expect(snapshot.positionsValueUsd).toBeGreaterThan(0);
  });

  it("averages cost basis across multiple buys of the same token",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner}=scannerStub({gas:1});
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.buy("chat","alice",token,30);
    await paper.buy("chat","alice",token,30);
    const position=await store.paperCompetitionPosition((await paper.active("chat"))!.id,"alice",token);
    expect(position?.tokenAmount).toBeCloseTo(60);
    expect(position?.costBasisUsd).toBeCloseTo(62);
    expect(position?.averageEntryPriceUsd).toBeCloseTo(62/60);
  });

  it("keeps separate positions for different tokens",async()=>{
    const store=storeFor();await store.init();
    const a=getAddress("0x3333333333333333333333333333333333333333");
    const b=getAddress("0x4444444444444444444444444444444444444444");
    const {scanner}=scannerStub();
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.buy("chat","alice",a,40);
    await paper.buy("chat","alice",b,40);
    const snapshot=await paper.portfolio("chat","alice");
    expect(snapshot.positions.length).toBe(2);
    expect(snapshot.cashBalanceUsd).toBeCloseTo(18);
  });

  it("rejects invalid sell fractions and sells with no position",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner}=scannerStub();
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    for(const fraction of [0,-0.5,1.1,2,Number.NaN]){
      await expect(paper.sell("chat","alice",token,fraction)).rejects.toThrow();
    }
    await expect(paper.sell("chat","alice",token,0.5)).rejects.toThrow(/do not have an open position/i);
  });

  it("realizes proportional pnl on a partial sell and closes the rest",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner}=scannerStub({gas:0});
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.buy("chat","alice",token,40);
    const sale=await paper.sell("chat","alice",token,0.5);
    expect(sale.tokenAmount).toBeCloseTo(20);
    expect(sale.netProceedsUsd).toBeCloseTo(24);
    expect(sale.realizedPnlUsd).toBeCloseTo(4);
    const position=await store.paperCompetitionPosition((await paper.active("chat"))!.id,"alice",token);
    expect(position?.tokenAmount).toBeCloseTo(20);
    expect(position?.costBasisUsd).toBeCloseTo(20);
    const snapshot=await paper.portfolio("chat","alice");
    expect(snapshot.cashBalanceUsd).toBeCloseTo(84);
  });

  it("counts wins and losses on profitable and losing sells",async()=>{
    const store=storeFor();await store.init();
    const up=getAddress("0x3333333333333333333333333333333333333333");
    const down=getAddress("0x4444444444444444444444444444444444444444");
    const {scanner,prices}=scannerStub({gas:0,spread:1});
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.buy("chat","alice",up,40);
    await paper.buy("chat","alice",down,40);
    prices[up.toLowerCase()]=2;
    prices[down.toLowerCase()]=0.5;
    await paper.sell("chat","alice",up,1);
    await paper.sell("chat","alice",down,1);
    const account=await paper.account((await paper.active("chat"))!.id,"alice");
    expect(account?.wins).toBe(1);
    expect(account?.losses).toBe(1);
    expect(account?.realizedPnlUsd).toBeCloseTo(20);
  });

  it("sells all and leaves no open position",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner}=scannerStub({gas:1,spread:1});
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.buy("chat","alice",token,50);
    const sale=await paper.sell("chat","alice",token,1);
    expect(sale.realizedPnlUsd).toBeCloseTo(-2);
    const positions=await store.paperCompetitionPositions((await paper.active("chat"))!.id,"alice");
    expect(positions.length).toBe(0);
    const snapshot=await paper.portfolio("chat","alice");
    expect(snapshot.cashBalanceUsd).toBeCloseTo(98);
    expect(snapshot.equityUsd).toBeCloseTo(98);
    expect(snapshot.totalPnlUsd).toBeCloseTo(-2);
    await expect(paper.sell("chat","alice",token,1)).rejects.toThrow(/do not have an open position/i);
  });

  it("passes through price impact and execution price from the quote",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const directory=mkdtempSync(join(tmpdir(),"kapiscout-paper-"));directories.push(directory);
    const scan=scanFor(token,1);
    const scanner={
      scan:async()=>scan,
      quotePaperBuy:async()=>({side:"BUY" as const,source:"UNISWAP_V4" as const,tokenAmount:50,grossValueUsd:50,gasCostUsd:0,executionPriceUsd:1.05,priceImpactPercent:4.2,gasEstimate:100n,quotedAt:Date.now()}),
      quotePaperSell:async()=>({side:"SELL" as const,source:"UNISWAP_V4" as const,tokenAmount:50,grossValueUsd:50,gasCostUsd:0,executionPriceUsd:1.02,priceImpactPercent:2.5,gasEstimate:100n,quotedAt:Date.now()}),
    } as unknown as TokenScanner;
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    const buy=await paper.buy("chat","alice",token,50);
    expect(buy.executionPriceUsd).toBe(1.05);
    expect(buy.priceImpactPercent).toBe(4.2);
    const sale=await paper.sell("chat","alice",token,1);
    expect(sale.executionPriceUsd).toBe(1.02);
    expect(sale.priceImpactPercent).toBe(2.5);
  });

  it("ranks the best trader first and breaks ties by username",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner,prices}=scannerStub({gas:0,spread:1});
    prices[token.toLowerCase()]=1.5;
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.ensureAccount("chat","bob","@bob");
    await paper.ensureAccount("chat","carol","@carol");
    await paper.buy("chat","alice",token,50);
    await paper.buy("chat","bob",token,20);
    const board=await paper.leaderboard("chat");
    expect(board.entries[0]?.username).toBe("@alice");
    expect(board.entries[1]?.username).toBe("@bob");
    expect(board.entries[2]?.username).toBe("@carol");
    const snapshot=await paper.portfolio("chat","alice");
    expect(snapshot.rank).toBe(1);
    expect((await paper.portfolio("chat","bob")).rank).toBe(2);
  });

  it("records trade history newest-first with a limit",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner}=scannerStub();
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.buy("chat","alice",token,10);
    await paper.buy("chat","alice",token,10);
    await paper.sell("chat","alice",token,0.5);
    const history=await paper.history("chat","alice",2);
    expect(history.trades.length).toBe(2);
    expect(history.trades[0]?.side).toBe("SELL");
    expect(history.trades[1]?.side).toBe("BUY");
    const full=await paper.history("chat","alice",10);
    expect(full.trades.length).toBe(3);
    expect(full.trades.every(t=>t.userId==="alice")).toBe(true);
  });

  it("is idempotent: ensureCompetition never creates a second active competition",async()=>{
    const store=storeFor();await store.init();
    const {scanner}=scannerStub();
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.ensureAccount("chat","bob","@bob");
    await paper.buy("chat","bob",getAddress("0x3333333333333333333333333333333333333333"),10);
    const all=(await store.latestPaperCompetition("chat"))!;
    const active=await paper.active("chat");
    expect(active?.id).toBe(all.id);
    const board=await paper.leaderboard("chat");
    expect(board.competition.id).toBe(all.id);
    expect(board.entries.length).toBe(2);
  });

  it("blocks buys on a competition that has ended",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner}=scannerStub();
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    const competition=(await paper.active("chat"))!;
    await store.finalizePaperCompetition(competition.id,[],Date.now());
    await expect(
      store.executeCompetitionBuy({competitionId:competition.id,userId:"alice",tokenAddress:token,symbol:"KAPI",quote:{side:"BUY",source:"UNISWAP_V4",tokenAmount:10,grossValueUsd:10,gasCostUsd:1,executionPriceUsd:1,priceImpactPercent:0,gasEstimate:100n,quotedAt:Date.now()},marketCapUsd:1000})
    ).rejects.toThrow(/trading has ended/i);
    await store.executeCompetitionBuy({competitionId:competition.id,userId:"alice",tokenAddress:token,symbol:"KAPI",quote:{side:"BUY",source:"UNISWAP_V4",tokenAmount:10,grossValueUsd:10,gasCostUsd:1,executionPriceUsd:1,priceImpactPercent:0,gasEstimate:100n,quotedAt:Date.now()},marketCapUsd:1000}).catch(()=>{});
    const ended=await store.paperCompetitionById(competition.id);
    expect(ended?.status).toBe("ENDED");
  });

  it("auto-finalizes expired competitions through finalizeExpired",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner,prices}=scannerStub({gas:0,spread:1});
    prices[token.toLowerCase()]=2;
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.buy("chat","alice",token,50);
    const competition=(await paper.active("chat"))!;
    (store as unknown as {db:{prepare:(sql:string)=>{run:(...args:unknown[])=>unknown}}}).db.prepare("UPDATE paper_competitions SET ends_at=1 WHERE id=?").run(competition.id);
    (paper as unknown as {finalizeExpired():Promise<void>}).finalizeExpired();
    await new Promise((resolve)=>setTimeout(resolve,50));
    const ended=await store.paperCompetitionById(competition.id);
    expect(ended?.status).toBe("ENDED");
    const account=await store.paperCompetitionAccount(competition.id,"alice");
    expect(account?.finalEquityUsd).not.toBeNull();
    const snapshot=await paper.portfolio("chat","alice");
    expect(snapshot.equityUsd).toBe(account?.finalEquityUsd);
  });

  it("survives scanner failures: positions valued at zero with quoteAvailable false",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner,failScan}=scannerStub();
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.buy("chat","alice",token,50);
    failScan[token.toLowerCase()]="chain down";
    const snapshot=await paper.portfolio("chat","alice");
    expect(snapshot.positions[0]?.quoteAvailable).toBe(false);
    expect(snapshot.positions[0]?.liquidationValueUsd).toBe(0);
    expect(snapshot.positionsValueUsd).toBe(0);
    expect(snapshot.equityUsd).toBeCloseTo(49);
    const board=await paper.leaderboard("chat");
    expect(board.entries[0]?.equityUsd).toBeCloseTo(49);
  });

  it("clears valuation cache after a trade so refreshed prices are used",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner,prices}=scannerStub({gas:0,spread:1});
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.buy("chat","alice",token,50);
    expect((await paper.portfolio("chat","alice")).equityUsd).toBeCloseTo(100);
    prices[token.toLowerCase()]=3;
    const sale=await paper.sell("chat","alice",token,0.5);
    expect(sale.realizedPnlUsd).toBeCloseTo(50);
    const snapshot=await paper.portfolio("chat","alice");
    expect(snapshot.cashBalanceUsd).toBeCloseTo(125);
    expect(snapshot.positionsValueUsd).toBeCloseTo(75);
    expect(snapshot.equityUsd).toBeCloseTo(200);
  });

  it("supports a full round trip at the same price with gas deducted twice",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner}=scannerStub({gas:1,spread:1});
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.buy("chat","alice",token,50);
    const sale=await paper.sell("chat","alice",token,1);
    expect(sale.realizedPnlUsd).toBeCloseTo(-2);
    const snapshot=await paper.portfolio("chat","alice");
    expect(snapshot.cashBalanceUsd).toBeCloseTo(98);
    expect(snapshot.totalPnlUsd).toBeCloseTo(-2);
    expect(snapshot.positions.length).toBe(0);
  });

  it("tracks participation counts and portfolio rank after settling",async()=>{
    const store=storeFor();await store.init();
    const token=getAddress("0x3333333333333333333333333333333333333333");
    const {scanner,prices}=scannerStub({gas:0,spread:1});
    const paper=new PaperCompetitionService(store,scanner);
    await paper.ensureAccount("chat","alice","@alice");
    await paper.ensureAccount("chat","bob","@bob");
    await paper.buy("chat","alice",token,50);
    prices[token.toLowerCase()]=1.5;
    const competition=(await paper.active("chat"))!;
    await paper.end("chat");
    const ended=await store.paperCompetitionById(competition.id);
    expect(ended?.status).toBe("ENDED");
    const alice=await store.paperCompetitionAccount(competition.id,"alice");
    expect(alice?.finalEquityUsd).toBeCloseTo(125);
    expect(alice?.finalRank).toBe(1);
    expect(alice?.finalPnlUsd).toBeCloseTo(25);
    const restarted=await paper.ensureAccount("chat","alice","@alice");
    expect(restarted.startingBalanceUsd).toBe(100);
    expect(restarted.cashBalanceUsd).toBe(100);
    expect(restarted.competitionId).not.toBe(competition.id);
    expect((await paper.active("chat"))?.id).toBe(restarted.competitionId);
  });
});