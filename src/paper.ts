import type { Address } from "viem";
import type { Store } from "./db.js";
import type { TokenScanner } from "./scanner.js";
import type {
  PaperCompetition,
  PaperCompetitionAccount,
  PaperCompetitionPosition,
  PaperCompetitionTrade,
  PaperLeaderboardEntry,
  PaperPortfolioSnapshot,
  PaperPositionValuation,
  TokenScan,
} from "./types.js";

const REFRESH_MS = 15_000;
const STARTING_BALANCE_USD = 100;
const COMPETITION_NAME = "Kapiscout Paper Arena";
const COMPETITION_DURATION_DAYS = 36_500;

export interface PaperBuyResult {
  scan: TokenScan;
  position: PaperCompetitionPosition;
  spentUsd: number;
  gasCostUsd: number;
  tokenAmount: number;
  executionPriceUsd: number;
  priceImpactPercent: number | null;
}

export interface PaperSellResult {
  scan: TokenScan;
  position: PaperCompetitionPosition;
  grossValueUsd: number;
  netProceedsUsd: number;
  gasCostUsd: number;
  tokenAmount: number;
  executionPriceUsd: number;
  priceImpactPercent: number | null;
  realizedPnlUsd: number;
}

export class PaperCompetitionService {
  private timer: NodeJS.Timeout | null = null;
  private readonly valuationCache = new Map<string,{expiresAt:number;value:PaperPositionValuation}>();

  constructor(private readonly store:Store,private readonly scanner:TokenScanner){}

  start():void{
    if(this.timer)return;
    void this.finalizeExpired();
    this.timer=setInterval(async ()=>void await this.finalizeExpired(),REFRESH_MS);
    this.timer.unref();
  }

  stop():void{if(this.timer)clearInterval(this.timer);this.timer=null;}

  async create(chatId:string,name:string,startingBalanceUsd:number,durationDays:number,createdBy:string): Promise<PaperCompetition> {
    return await this.store.createPaperCompetition({chatId,name,startingBalanceUsd,durationDays,createdBy});
  }

  async active(chatId:string): Promise<PaperCompetition|null> {return await this.store.activePaperCompetition(chatId);}
  async latest(chatId:string): Promise<PaperCompetition|null> {return await this.store.latestPaperCompetition(chatId);}
  async account(competitionId:number,userId:string): Promise<PaperCompetitionAccount|null> {return await this.store.paperCompetitionAccount(competitionId,userId);}
  async participants(competitionId:number): Promise<number> {return (await this.store.paperCompetitionAccounts(competitionId)).length;}

  async join(chatId:string,userId:string,username:string): Promise<PaperCompetitionAccount> {
    const competition=await this.requireActive(chatId);
    return await this.store.joinPaperCompetition(competition.id,userId,username);
  }

  async ensureAccount(chatId:string,userId:string,username?:string): Promise<PaperCompetitionAccount> {
    const competition=await this.ensureCompetition(chatId);
    const existing=await this.store.paperCompetitionAccount(competition.id,userId);
    if(existing&&!username)return existing;
    return await this.store.joinPaperCompetition(competition.id,userId,username?.trim()||existing?.username||userId);
  }

  async buy(chatId:string,userId:string,address:Address,valueUsd:number,username?:string):Promise<PaperBuyResult>{
    const account=await this.ensureAccount(chatId,userId,username);
    if(!Number.isFinite(valueUsd)||valueUsd<=0)throw new Error("Choose a paper buy amount above $0.");
    const scan=await this.scanner.scan(address,true);
    const quote=await this.scanner.quotePaperBuy(scan,valueUsd);
    const position=await this.store.executeCompetitionBuy({competitionId:account.competitionId,userId,tokenAddress:address,symbol:scan.token.symbol,quote,marketCapUsd:scan.market.marketCapUsd??scan.market.fdvUsd});
    this.clearCompetitionCache(account.competitionId);
    return {scan,position,spentUsd:quote.grossValueUsd+quote.gasCostUsd,gasCostUsd:quote.gasCostUsd,tokenAmount:quote.tokenAmount,executionPriceUsd:quote.executionPriceUsd,priceImpactPercent:quote.priceImpactPercent};
  }

  async sell(chatId:string,userId:string,address:Address,fraction:number,username?:string):Promise<PaperSellResult>{
    const account=await this.ensureAccount(chatId,userId,username);
    if(!Number.isFinite(fraction)||fraction<=0||fraction>1)throw new Error("Choose a sell size from 1% to 100%.");
    const before=await this.store.paperCompetitionPosition(account.competitionId,userId,address);
    if(!before||before.tokenAmount<=0)throw new Error("You do not have an open position in this token.");
    const tokenAmount=before.tokenAmount*fraction;
    const scan=await this.scanner.scan(address,true);
    const quote=await this.scanner.quotePaperSell(scan,tokenAmount);
    const result=await this.store.executeCompetitionSell({competitionId:account.competitionId,userId,tokenAddress:address,symbol:before.symbol,quote,marketCapUsd:scan.market.marketCapUsd??scan.market.fdvUsd});
    this.clearCompetitionCache(account.competitionId);
    return {scan,position:result.position,grossValueUsd:quote.grossValueUsd,netProceedsUsd:result.netProceedsUsd,gasCostUsd:quote.gasCostUsd,tokenAmount:quote.tokenAmount,executionPriceUsd:quote.executionPriceUsd,priceImpactPercent:quote.priceImpactPercent,realizedPnlUsd:result.realizedPnlUsd};
  }

  async portfolio(chatId:string,userId:string,username?:string):Promise<PaperPortfolioSnapshot>{
    const account=await this.ensureAccount(chatId,userId,username);
    const competition=(await this.store.paperCompetitionById(account.competitionId))!;
    const positions=await this.valuePositions(account.competitionId,userId);
    const livePositionsValue=positions.reduce((sum,item)=>sum+item.liquidationValueUsd,0);
    const liveEquity=account.cashBalanceUsd+livePositionsValue;
    const equityUsd=competition.status==="ENDED"&&account.finalEquityUsd!=null?account.finalEquityUsd:liveEquity;
    const totalPnlUsd=competition.status==="ENDED"&&account.finalPnlUsd!=null?account.finalPnlUsd:equityUsd-account.startingBalanceUsd;
    let rank=account.finalRank;
    let participants=(await this.store.paperCompetitionAccounts(competition.id)).length;
    if(competition.status==="ACTIVE"){
      const board=await this.leaderboardForCompetition(competition);
      rank=board.findIndex(item=>item.userId===userId)+1||null;
      participants=board.length;
    }
    return {competition,account,positions,cashBalanceUsd:account.cashBalanceUsd,positionsValueUsd:competition.status==="ENDED"?Math.max(0,equityUsd-account.cashBalanceUsd):livePositionsValue,equityUsd,totalPnlUsd,returnPercent:account.startingBalanceUsd>0?totalPnlUsd/account.startingBalanceUsd*100:0,rank,participants,refreshedAt:Date.now()};
  }

  async leaderboard(chatId:string):Promise<{competition:PaperCompetition;entries:PaperLeaderboardEntry[]}>{
    const competition=await this.ensureCompetition(chatId);
    return {competition,entries:await this.leaderboardForCompetition(competition)};
  }

  async history(chatId:string,userId:string,limit=12,username?:string):Promise<{competition:PaperCompetition;trades:PaperCompetitionTrade[]}>{
    const account=await this.ensureAccount(chatId,userId,username);
    const competition=(await this.store.paperCompetitionById(account.competitionId))!;
    return {competition,trades:await this.store.paperCompetitionTrades(account.competitionId,userId,limit)};
  }

  async end(chatId:string):Promise<{competition:PaperCompetition;entries:PaperLeaderboardEntry[]}>{
    const competition=await this.requireActive(chatId);
    const entries=await this.liveLeaderboard(competition);
    const ended=await this.store.finalizePaperCompetition(competition.id,entries.map((entry,index)=>({userId:entry.userId,equityUsd:entry.equityUsd,pnlUsd:entry.pnlUsd,rank:index+1})),Date.now());
    if(!ended)throw new Error("The competition could not be finalized.");
    return {competition:ended,entries};
  }

  private async leaderboardForCompetition(competition:PaperCompetition):Promise<PaperLeaderboardEntry[]>{
    const accounts=await this.store.paperCompetitionAccounts(competition.id,100);
    if(competition.status==="ENDED"&&accounts.every(account=>account.finalEquityUsd!=null)){
      const settled=await Promise.all(accounts.map(async (account)=>({userId:account.userId,username:account.username,equityUsd:account.finalEquityUsd!,pnlUsd:account.finalPnlUsd!,returnPercent:account.startingBalanceUsd>0?account.finalPnlUsd!/account.startingBalanceUsd*100:0,wins:account.wins,losses:account.losses,openPositions:(await this.store.paperCompetitionPositions(competition.id,account.userId)).length})));
      return settled.sort((a,b)=>b.equityUsd-a.equityUsd);
    }
    return await this.liveLeaderboard(competition);
  }

  private async liveLeaderboard(competition:PaperCompetition):Promise<PaperLeaderboardEntry[]>{
    const accounts=await this.store.paperCompetitionAccounts(competition.id,100);
    const entries=await Promise.all(accounts.map(async account=>{
      const positions=await this.valuePositions(competition.id,account.userId);
      const equityUsd=account.cashBalanceUsd+positions.reduce((sum,item)=>sum+item.liquidationValueUsd,0);
      const pnlUsd=equityUsd-account.startingBalanceUsd;
      return {userId:account.userId,username:account.username,equityUsd,pnlUsd,returnPercent:account.startingBalanceUsd>0?pnlUsd/account.startingBalanceUsd*100:0,wins:account.wins,losses:account.losses,openPositions:positions.length};
    }));
    return entries.sort((a,b)=>b.equityUsd-a.equityUsd||a.username.localeCompare(b.username));
  }

  private async valuePositions(competitionId:number,userId:string):Promise<PaperPositionValuation[]>{
    return Promise.all((await this.store.paperCompetitionPositions(competitionId,userId)).map(async position=>await this.valuePosition(position)));
  }

  private async valuePosition(position:PaperCompetitionPosition):Promise<PaperPositionValuation>{
    const key=`${position.competitionId}:${position.userId}:${position.tokenAddress.toLowerCase()}:${position.tokenAmount}`;
    const cached=this.valuationCache.get(key);if(cached&&cached.expiresAt>Date.now())return cached.value;
    let value:PaperPositionValuation;
    try{
      const scan=await this.scanner.scan(position.tokenAddress,true);
      const quote=await this.scanner.quotePaperSell(scan,position.tokenAmount);
      const liquidationValueUsd=Math.max(0,quote.grossValueUsd-quote.gasCostUsd);
      value={...position,liquidationValueUsd,gasCostUsd:quote.gasCostUsd,unrealizedPnlUsd:liquidationValueUsd-position.costBasisUsd,currentExecutionPriceUsd:quote.executionPriceUsd,priceImpactPercent:quote.priceImpactPercent,quoteAvailable:true};
    }catch{
      value={...position,liquidationValueUsd:0,gasCostUsd:0,unrealizedPnlUsd:-position.costBasisUsd,currentExecutionPriceUsd:0,priceImpactPercent:null,quoteAvailable:false};
    }
    this.valuationCache.set(key,{expiresAt:Date.now()+REFRESH_MS,value});
    return value;
  }

  private async requireActive(chatId:string): Promise<PaperCompetition> {
    const competition=await this.store.activePaperCompetition(chatId);
    if(!competition)throw new Error("There is no active paper competition in this chat.");
    return competition;
  }

  private async ensureCompetition(chatId:string): Promise<PaperCompetition> {
    const existing=await this.store.activePaperCompetition(chatId);
    if(existing)return existing;
    return await this.store.createPaperCompetition({chatId,name:COMPETITION_NAME,startingBalanceUsd:STARTING_BALANCE_USD,durationDays:COMPETITION_DURATION_DAYS,createdBy:"system"});
  }

  private async requireAccount(competitionId:number,userId:string): Promise<PaperCompetitionAccount> {
    const account=await this.store.paperCompetitionAccount(competitionId,userId);
    if(!account)throw new Error("Join the competition before paper trading.");
    return account;
  }

  private clearCompetitionCache(competitionId:number):void{
    for(const key of this.valuationCache.keys())if(key.startsWith(`${competitionId}:`))this.valuationCache.delete(key);
  }

  private async finalizeExpired():Promise<void>{
    for(const competition of await this.store.expiredActivePaperCompetitions()){
      try{
        const entries=await this.liveLeaderboard(competition);
        await this.store.finalizePaperCompetition(competition.id,entries.map((entry,index)=>({userId:entry.userId,equityUsd:entry.equityUsd,pnlUsd:entry.pnlUsd,rank:index+1})),competition.endsAt);
      }catch(error){console.error(`Paper competition ${competition.id} finalization failed`,error);}
    }
  }
}
