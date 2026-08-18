import { erc20Abi, formatUnits, getAddress, isAddress, parseAbiItem, parseUnits, zeroAddress, type Address, type Hash, type PublicClient } from "viem";
import type { AppConfig } from "./config.js";
import { BlockscoutClient, type BlockscoutTokenData } from "./blockscout.js";
import { MarketClient } from "./market.js";
import type { RobinhoodRwaClient } from "./robinhood-rwa.js";
import type { DeployerReputation, HolderSummary, LaunchForensics, PaperExecutionQuote, RobinhoodCorporateAction, RobinhoodRwaQuote, SwapQuote, TokenIdentity, TokenScan } from "./types.js";

const emptyHolders: HolderSummary = { top10Percent: null, holders: [] };
const poolManager = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
const v4Quoter = getAddress("0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
const initializeEvent = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const v4QuoterAbi = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "poolKey", type: "tuple", components: [
      { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
    ] },
    { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" },
  ] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}] as const;

export class TokenScanner {
  private readonly cache = new Map<string, { expiresAt: number; value: TokenScan }>();
  private readonly poolKeyCache = new Map<string, Promise<V4PoolDetails>>();

  constructor(
    readonly publicClient: PublicClient,
    private readonly blockscout: BlockscoutClient,
    readonly market: MarketClient,
    private readonly config: AppConfig,
    private readonly rwaClient?: RobinhoodRwaClient,
  ) {}

  async scan(rawAddress: string, fresh = false): Promise<TokenScan> {
    if (!isAddress(rawAddress)) throw new Error("That is not a valid EVM contract address.");
    const address = getAddress(rawAddress);
    const key = address.toLowerCase();
    const cached = this.cache.get(key);
    if (!fresh && cached && cached.expiresAt > Date.now()) return cached.value;

    const blockscoutTokenPromise = within(this.blockscout.token(address).catch((error) => {
        console.warn(`Blockscout token lookup failed for ${address}`, error);
        return null;
      }), 5_500, null);
    const marketPromise = within(this.market.getBestMarket(address).catch((error) => {
        console.warn(`Market lookup failed for ${address}`, error);
        return emptyMarket();
      }), 6_000, emptyMarket());
    const contractInfoPromise = within(this.blockscout.contractInfo(address).catch((error) => {
        console.warn(`Contract verification lookup failed for ${address}`, error);
        return { verified: false, creator: null };
      }), 5_500, { verified: false, creator: null });
    const rwaPromise = this.rwaClient
      ? within(this.rwaClient.assetForAddress(address).catch(() => null), 4_500, null)
      : Promise.resolve(null);
    const blockscoutToken = await blockscoutTokenPromise;
    if (!blockscoutToken) {
      const bytecode = await this.publicClient.getBytecode({ address });
      if (!bytecode || bytecode === "0x") throw new Error("This address is not a contract on Robinhood Chain.");
    }
    const token = await this.identityFromChain(address, blockscoutToken);
    const holdersPromise = within(this.blockscout.holders(address, token.totalSupplyRaw).catch((error) => {
      console.warn(`Holder lookup failed for ${address}`, error);
      return emptyHolders;
    }), 5_500, emptyHolders);
    const [market, contractInfo, holders, rwa] = await Promise.all([marketPromise, contractInfoPromise, holdersPromise, rwaPromise]);
    market.priceUsd ??= blockscoutToken?.exchangeRateUsd ?? null;
    market.marketCapUsd ??= blockscoutToken?.marketCapUsd ?? null;
    market.volume24hUsd ??= blockscoutToken?.volume24hUsd ?? null;

    const warnings = buildWarnings(token, holders, contractInfo.verified, market);

    const scan: TokenScan = {
      token,
      market,
      holders,
      verified: contractInfo.verified,
      creator: contractInfo.creator,
      rwa,
      warnings,
      scannedAt: Date.now(),
    };
    this.cache.set(key, { expiresAt: Date.now() + this.config.scanCacheTtlMs, value: scan });
    return scan;
  }

  async refreshMarket(rawAddress: string): Promise<TokenScan> {
    if (!isAddress(rawAddress)) throw new Error("That is not a valid EVM contract address.");
    const address = getAddress(rawAddress);
    const key = address.toLowerCase();
    const previous = this.cache.get(key)?.value;
    if (!previous) return this.scan(address, true);
    const market = await within(this.market.getBestMarket(address).catch(() => previous.market), 4_500, previous.market);
    const refreshed: TokenScan = {
      ...previous,
      market,
      rwa: previous.rwa ?? null,
      warnings: buildWarnings(previous.token, previous.holders, Boolean(previous.verified), market),
      scannedAt: Date.now(),
    };
    this.cache.set(key, { expiresAt: Date.now() + this.config.scanCacheTtlMs, value: refreshed });
    return refreshed;
  }

  async launchForensics(scan: TokenScan): Promise<LaunchForensics> {
    return this.blockscout.launchForensics(scan.token.address, scan.token.totalSupplyRaw);
  }

  async rwaDetails(scan: TokenScan): Promise<{ quote: RobinhoodRwaQuote | null; actions: RobinhoodCorporateAction[] }> {
    if (!scan.rwa || !this.rwaClient) return { quote: null, actions: [] };
    const [quote, actions] = await Promise.all([
      this.rwaClient.quote(scan.rwa.tokenSymbol).catch(() => null),
      this.rwaClient.corporateActions(scan.rwa.tokenSymbol).catch(() => []),
    ]);
    return { quote, actions };
  }

  async deployerReputation(scan: TokenScan): Promise<DeployerReputation | null> {
    if (!scan.creator) return null;
    const originator = await this.blockscout.creationOriginator(scan.token.address).catch(() => null);
    const reputationAddress = originator ?? scan.creator;
    let contracts = originator ? await this.blockscout.originatedTokenContracts(originator, 12) : [];
    if (!contracts.length && !originator) contracts = await this.blockscout.createdTokenContracts(scan.creator, 12);
    const tokens = await Promise.all(contracts.map(async (item) => {
      const market = await within(this.market.getBestMarket(item.address).catch(() => emptyMarket()), 4_000, emptyMarket());
      return { address: item.address, symbol: item.token.symbol ?? "UNKNOWN", marketCapUsd: market.marketCapUsd ?? market.fdvUsd ?? item.token.marketCapUsd, liquidityUsd: market.liquidityUsd, verified: item.verified };
    }));
    if (!tokens.length) {
      return { address: reputationAddress, score: 50, grade: "C", launches: 1, liveMarkets: scan.market.pairAddress ? 1 : 0, verifiedContracts: scan.verified ? 1 : 0, lowLiquidityLaunches: scan.market.liquidityUsd != null && scan.market.liquidityUsd < 5_000 ? 1 : 0, bestMarketCapUsd: scan.market.marketCapUsd ?? scan.market.fdvUsd, tokens: [{ address: scan.token.address, symbol: scan.token.symbol, marketCapUsd: scan.market.marketCapUsd ?? scan.market.fdvUsd, liquidityUsd: scan.market.liquidityUsd }] };
    }
    const liveMarkets = tokens.filter((item) => item.liquidityUsd != null && item.liquidityUsd > 0).length;
    const verifiedContracts = tokens.filter((item) => item.verified).length;
    const lowLiquidityLaunches = tokens.filter((item) => item.liquidityUsd == null || item.liquidityUsd < 5_000).length;
    const survival = liveMarkets / tokens.length;
    const score = Math.round(Math.max(0, Math.min(100, survival * 65 + verifiedContracts / tokens.length * 20 + (1 - lowLiquidityLaunches / tokens.length) * 15)));
    return { address: reputationAddress, score, grade: score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : score >= 30 ? "D" : "F", launches: tokens.length, liveMarkets, verifiedContracts, lowLiquidityLaunches, bestMarketCapUsd: tokens.reduce<number | null>((best, item) => item.marketCapUsd != null && (best == null || item.marketCapUsd > best) ? item.marketCapUsd : best, null), tokens: tokens.map(({ verified: _verified, ...item }) => item) };
  }

  async quoteExit(scan: TokenScan, notionalUsd: number): Promise<SwapQuote> {
    const price = scan.market.priceUsd;
    const liquidity = scan.market.liquidityUsd;
    const amountInTokens = price && price > 0 ? notionalUsd / price : 0;
    if (amountInTokens > 0 && scan.market.pairAddress && /^0x[a-fA-F0-9]{64}$/u.test(scan.market.pairAddress) && scan.market.pairCreatedAt) {
      try {
        const createdBlock = await this.blockscout.blockByTimestamp(scan.market.pairCreatedAt / 1_000);
        if (createdBlock != null) {
          const fromBlock = createdBlock > 2_000n ? createdBlock - 2_000n : 0n;
          const logs = await this.publicClient.getLogs({ address: poolManager, event: initializeEvent, args: { id: scan.market.pairAddress as Hash }, fromBlock, toBlock: createdBlock + 2_000n });
          const args = logs[0]?.args;
          if (args?.currency0 && args.currency1 && args.fee != null && args.tickSpacing != null && args.hooks) {
            const token = scan.token.address.toLowerCase();
            const zeroForOne = args.currency0.toLowerCase() === token;
            if (zeroForOne || args.currency1.toLowerCase() === token) {
              const rawIn = parseUnits(amountInTokens.toFixed(Math.min(scan.token.decimals, 18)), scan.token.decimals);
              const quoteCurrency = zeroForOne ? args.currency1 : args.currency0;
              const quoteDecimals = quoteCurrency === zeroAddress ? 18 : Number(await this.publicClient.readContract({ address: quoteCurrency, abi: erc20Abi, functionName: "decimals" }));
              const simulation = await this.publicClient.simulateContract({ address: v4Quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", account: zeroAddress, args: [{ poolKey: { currency0: args.currency0, currency1: args.currency1, fee: args.fee, tickSpacing: args.tickSpacing, hooks: args.hooks }, zeroForOne, exactAmount: rawIn, hookData: "0x" }] });
              const [rawOut, gasEstimate] = simulation.result;
              const amountOutTokens = Number(formatUnits(rawOut, quoteDecimals));
              const quoteUsd = await this.quoteCurrencyUsd(quoteCurrency);
              const amountOutUsd = quoteUsd == null ? null : amountOutTokens * quoteUsd;
              return { source: "UNISWAP_V4", amountInTokens, amountOutTokens, amountOutUsd, priceImpactPercent: amountOutUsd == null ? null : Math.max(0, (1 - amountOutUsd / notionalUsd) * 100), gasEstimate, note: "Live eth_call against the official Robinhood Uniswap v4 Quoter; no trade was submitted." };
            }
          }
        }
      } catch (error) {
        console.warn(`Uniswap v4 quote failed for ${scan.token.address}; using pool estimate`, error);
      }
    }
    const reserve = liquidity == null ? null : liquidity / 2;
    const received = reserve && reserve > 0 ? reserve * (notionalUsd * 0.997) / (reserve + notionalUsd * 0.997) : null;
    return { source: "POOL_ESTIMATE", amountInTokens, amountOutTokens: null, amountOutUsd: received, priceImpactPercent: received == null ? null : Math.max(0, (1 - received / notionalUsd) * 100), gasEstimate: null, note: "Fallback constant-product estimate; the indexed pool key was unavailable to the on-chain quoter." };
  }

  async quotePaperBuy(scan:TokenScan,notionalUsd:number):Promise<PaperExecutionQuote>{
    if(!Number.isFinite(notionalUsd)||notionalUsd<=0)throw new Error("Paper buy amount must be positive.");
    const pool=await this.v4PoolDetails(scan);
    const quoteUsd=await this.quoteCurrencyUsd(pool.quoteCurrency);if(quoteUsd==null||quoteUsd<=0)throw new Error("The pool quote currency has no reliable USD price.");
    const quoteAmount=notionalUsd/quoteUsd;
    const rawIn=parseUnits(quoteAmount.toFixed(Math.min(pool.quoteDecimals,18)),pool.quoteDecimals);
    const zeroForOne=pool.quoteCurrency.toLowerCase()===pool.currency0.toLowerCase();
    const [rawOut,gasEstimate]=await this.simulateV4(pool,zeroForOne,rawIn);
    const tokenAmount=Number(formatUnits(rawOut,scan.token.decimals));if(!Number.isFinite(tokenAmount)||tokenAmount<=0)throw new Error("Uniswap returned an empty paper fill.");
    const gasCostUsd=await this.paperGasUsd(gasEstimate);
    const expected=scan.market.priceUsd&&scan.market.priceUsd>0?notionalUsd/scan.market.priceUsd:null;
    return {side:"BUY",source:"UNISWAP_V4",tokenAmount,grossValueUsd:notionalUsd,gasCostUsd,executionPriceUsd:notionalUsd/tokenAmount,priceImpactPercent:expected==null?null:Math.max(0,(1-tokenAmount/expected)*100),gasEstimate,quotedAt:Date.now()};
  }

  async quotePaperSell(scan:TokenScan,tokenAmount:number):Promise<PaperExecutionQuote>{
    if(!Number.isFinite(tokenAmount)||tokenAmount<=0)throw new Error("Paper sell amount must be positive.");
    const pool=await this.v4PoolDetails(scan);
    const quoteUsd=await this.quoteCurrencyUsd(pool.quoteCurrency);if(quoteUsd==null||quoteUsd<=0)throw new Error("The pool quote currency has no reliable USD price.");
    const rawIn=parseUnits(tokenAmount.toFixed(Math.min(scan.token.decimals,18)),scan.token.decimals);
    const [rawOut,gasEstimate]=await this.simulateV4(pool,pool.tokenIs0,rawIn);
    const quoteAmount=Number(formatUnits(rawOut,pool.quoteDecimals));const grossValueUsd=quoteAmount*quoteUsd;if(!Number.isFinite(grossValueUsd)||grossValueUsd<=0)throw new Error("Uniswap returned an empty paper fill.");
    const gasCostUsd=await this.paperGasUsd(gasEstimate);
    const expected=scan.market.priceUsd&&scan.market.priceUsd>0?tokenAmount*scan.market.priceUsd:null;
    return {side:"SELL",source:"UNISWAP_V4",tokenAmount,grossValueUsd,gasCostUsd,executionPriceUsd:grossValueUsd/tokenAmount,priceImpactPercent:expected==null?null:Math.max(0,(1-grossValueUsd/expected)*100),gasEstimate,quotedAt:Date.now()};
  }

  private async v4PoolDetails(scan:TokenScan):Promise<V4PoolDetails>{
    const id=scan.market.pairAddress;
    if(!id||!/^0x[a-fA-F0-9]{64}$/u.test(id)||!scan.market.pairCreatedAt)throw new Error("No resolvable Uniswap v4 pool is indexed for this token.");
    const cached=this.poolKeyCache.get(id.toLowerCase());if(cached)return cached;
    const pending=(async()=>{
      const createdBlock=await this.blockscout.blockByTimestamp(scan.market.pairCreatedAt!/1_000);if(createdBlock==null)throw new Error("Could not locate the pool creation block.");
      const fromBlock=createdBlock>2_000n?createdBlock-2_000n:0n;
      const logs=await this.publicClient.getLogs({address:poolManager,event:initializeEvent,args:{id:id as Hash},fromBlock,toBlock:createdBlock+2_000n});const args=logs[0]?.args;
      if(!args?.currency0||!args.currency1||args.fee==null||args.tickSpacing==null||!args.hooks)throw new Error("Could not resolve the Uniswap v4 pool key.");
      const token=scan.token.address.toLowerCase();const tokenIs0=args.currency0.toLowerCase()===token;if(!tokenIs0&&args.currency1.toLowerCase()!==token)throw new Error("The indexed pool does not contain this token.");
      const quoteCurrency=tokenIs0?args.currency1:args.currency0;const quoteDecimals=quoteCurrency===zeroAddress?18:Number(await this.publicClient.readContract({address:quoteCurrency,abi:erc20Abi,functionName:"decimals"}));
      return {currency0:args.currency0,currency1:args.currency1,fee:args.fee,tickSpacing:args.tickSpacing,hooks:args.hooks,tokenIs0,quoteCurrency,quoteDecimals};
    })();
    this.poolKeyCache.set(id.toLowerCase(),pending);if(this.poolKeyCache.size>500)this.poolKeyCache.delete(this.poolKeyCache.keys().next().value!);
    try{return await pending;}catch(error){this.poolKeyCache.delete(id.toLowerCase());throw error;}
  }

  private async simulateV4(pool:V4PoolDetails,zeroForOne:boolean,exactAmount:bigint):Promise<readonly[bigint,bigint]>{
    const simulation=await this.publicClient.simulateContract({address:v4Quoter,abi:v4QuoterAbi,functionName:"quoteExactInputSingle",account:zeroAddress,args:[{poolKey:{currency0:pool.currency0,currency1:pool.currency1,fee:pool.fee,tickSpacing:pool.tickSpacing,hooks:pool.hooks},zeroForOne,exactAmount,hookData:"0x"}]});
    return simulation.result;
  }

  private async paperGasUsd(gasEstimate:bigint):Promise<number>{
    const [gasPrice,ethUsd]=await Promise.all([this.publicClient.getGasPrice(),this.quoteCurrencyUsd(zeroAddress)]);if(ethUsd==null)return 0;
    return Number(formatUnits(gasEstimate*gasPrice,18))*ethUsd;
  }

  private async quoteCurrencyUsd(currency: Address): Promise<number | null> {
    if (currency.toLowerCase() === this.config.usdgAddress.toLowerCase()) return 1;
    const address = currency === zeroAddress ? this.config.wethAddress : currency;
    const [market, indexed] = await Promise.all([
      this.market.getBestMarket(address).catch(() => null),
      this.blockscout.token(address).catch(() => null),
    ]);
    return market?.priceUsd ?? indexed?.exchangeRateUsd ?? null;
  }

  private async identityFromChain(address: Address, fallback: BlockscoutTokenData | null): Promise<TokenIdentity> {
    if (
      fallback?.name && fallback.symbol && fallback.decimals != null &&
      fallback.totalSupplyRaw != null
    ) {
      return {
        address,
        name: fallback.name,
        symbol: fallback.symbol,
        decimals: fallback.decimals,
        totalSupplyRaw: fallback.totalSupplyRaw,
        holdersCount: fallback.holdersCount ?? null,
        iconUrl: fallback.iconUrl ?? null,
      };
    }
    const reads = await Promise.allSettled([
      this.publicClient.readContract({ address, abi: erc20Abi, functionName: "name" }),
      this.publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      this.publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      this.publicClient.readContract({ address, abi: erc20Abi, functionName: "totalSupply" }),
    ]);
    const value = <T>(index: number, defaultValue: T): T => {
      const result = reads[index];
      return result?.status === "fulfilled" ? result.value as T : defaultValue;
    };
    return {
      address,
      name: value(0, fallback?.name ?? "Unknown Token"),
      symbol: value(1, fallback?.symbol ?? "UNKNOWN"),
      decimals: value(2, fallback?.decimals ?? 18),
      totalSupplyRaw: value(3, fallback?.totalSupplyRaw ?? 0n),
      holdersCount: fallback?.holdersCount ?? null,
      iconUrl: fallback?.iconUrl ?? null,
    };
  }
}

interface V4PoolDetails{currency0:Address;currency1:Address;fee:number;tickSpacing:number;hooks:Address;tokenIs0:boolean;quoteCurrency:Address;quoteDecimals:number}

function emptyMarket(): TokenScan["market"] {
  return {
    pairAddress: null, dexId: null, pairUrl: null, quoteSymbol: null, quoteAddress: null, priceUsd: null,
    marketCapUsd: null, fdvUsd: null, liquidityUsd: null, volume24hUsd: null,
    priceChange1h: null, priceChange24h: null, buys1h: null, sells1h: null,
    buys24h: null, sells24h: null, pairCreatedAt: null,
    websites: [], socials: [], dexPaid: null,
  };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

function buildWarnings(token: TokenIdentity, holders: HolderSummary, verified: boolean, market: TokenScan["market"]): string[] {
  const warnings: string[] = [];
  if (!verified) warnings.push("Contract source is not verified");
  if (!market.pairAddress && market.priceUsd == null) warnings.push("No indexed liquidity pool found");
  if (market.liquidityUsd != null && market.liquidityUsd < 10_000) warnings.push("Low liquidity");
  if (holders.top10Percent != null && holders.top10Percent > 50) warnings.push("Top 10 holders control over 50%");
  if (token.holdersCount != null && token.holdersCount < 50) warnings.push("Very few holders");
  return warnings;
}
