import type { Address, Hash } from "viem";

export interface TokenIdentity {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupplyRaw: bigint;
  holdersCount: number | null;
  iconUrl: string | null;
}

export interface MarketSnapshot {
  pairAddress: string | null;
  dexId: string | null;
  pairUrl: string | null;
  quoteSymbol: string | null;
  quoteAddress?: Address | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
  buys1h: number | null;
  sells1h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  pairCreatedAt: number | null;
  websites: string[];
  socials: Array<{ platform: string; handle: string }>;
  dexPaid: boolean | null;
}

export interface HolderSummary {
  top10Percent: number | null;
  holders: Array<{
    address: Address;
    percent: number;
    isContract: boolean;
    label: string | null;
  }>;
}

export interface TokenScan {
  token: TokenIdentity;
  market: MarketSnapshot;
  holders: HolderSummary;
  verified: boolean | null;
  creator: Address | null;
  rwa?: RobinhoodRwaAsset | null;
  warnings: string[];
  scannedAt: number;
}

export interface RobinhoodRwaAsset {
  tokenSymbol: string;
  tokenName: string;
  currentMultiplier: number | null;
  pendingMultiplier: number | null;
  pendingMultiplierEffectiveTime: string | null;
  logoUrl: string | null;
  status: string;
  allDayTradability: string | null;
  fractionalTradability: string | null;
  extendedHoursFractionalTradability: boolean | null;
}

export interface RobinhoodRwaQuote {
  bid: number | null;
  ask: number | null;
  dailyTradingVolume: number | null;
  isTradingHalt: boolean;
  generatedAt: string | null;
}

export interface RobinhoodCorporateAction {
  type: string;
  status: string;
  processDate: string | null;
  summary: string;
}

export interface ExitEstimate {
  notionalUsd: number;
  receivedUsd: number | null;
  impactPercent: number | null;
}

export interface RealityReport {
  exitScore: number | null;
  grade: "A" | "B" | "C" | "D" | "F" | "N/A";
  quotes: ExitEstimate[];
  headlineMultiple: number | null;
  realMultiple: number | null;
  notionalUsd: number;
  liquidityToMarketCapPercent: number | null;
  warnings: string[];
}

export interface LaunchForensics {
  launchBlock: number | null;
  firstBlockRecipients: number;
  firstBlockTransactions: number;
  firstBlockSupplyPercent: number | null;
  clusterScore: number | null;
  risk: "LOW" | "WATCH" | "HIGH" | "UNKNOWN";
  note: string;
}

export interface MarketHistoryPoint {
  capturedAt: number;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
}

export interface CallRecord {
  id: number;
  chatId: string;
  messageId: number;
  userId: string;
  username: string;
  tokenAddress: Address;
  symbol: string;
  entryPriceUsd: number | null;
  entryMarketCapUsd: number | null;
  entryLiquidityUsd: number | null;
  athPriceUsd: number | null;
  athMarketCapUsd: number | null;
  lastPriceUsd: number | null;
  lastMarketCapUsd: number | null;
  lastLiquidityUsd: number | null;
  lastDexPaid: boolean | null;
  scanCount: number;
  lastAthAlertMarketCapUsd: number | null;
  lastCheckedAt: number | null;
  proofHash: string;
  calledAt: number;
  updatedAt: number;
}

export type ChartTimeframe = "auto" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type ChartMetric = "price" | "market_cap";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChatSettings {
  contractEnabled: boolean;
  compact: boolean;
  detailed: boolean;
  kolAlerts: boolean;
  showChart: boolean;
  buttonsEnabled: boolean;
  adminOnly: boolean;
  minMarketCapUsd: number;
  milestoneAlerts: boolean;
  athAlerts: boolean;
  dexPaidAlerts: boolean;
  liquidityAlerts: boolean;
  devAlerts: boolean;
  whaleAlerts: boolean;
  chartMetric: ChartMetric;
  chartTimeframe: ChartTimeframe;
  digestEnabled: boolean;
  digestHour: number;
  bridgeAlerts: boolean;
  bridgeMinUsd: number;
}

export interface CallerStats {
  userId: string;
  username: string;
  totalCalls: number;
  currentWins: number;
  hits2x: number;
  hits5x: number;
  hits10x: number;
  winRate: number;
  medianReturn: number | null;
  bestMultiple: number | null;
}

export interface SecurityWalletWatch {
  chatId: string;
  tokenAddress: Address;
  symbol: string;
  walletAddress: Address;
  kind: "DEV" | "WHALE";
  holdingPercent: number | null;
}

export interface TrackedWallet {
  id: number;
  scope: string;
  chatId: string | null;
  telegramUserId: string | null;
  address: Address;
  label: string;
  isKol: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface WalletMovement {
  txHash: Hash;
  wallet: Address;
  direction: "BUY" | "SELL" | "TRANSFER";
  tokenAddress: Address;
  tokenAmountRaw: bigint;
  quoteAddress: Address | null;
  quoteAmountRaw: bigint | null;
  nativeAmountWei: bigint;
  blockNumber: bigint;
}

export interface WalletMovementRecord {
  id: number;
  chatId: string;
  walletAddress: Address;
  walletLabel: string;
  txHash: Hash;
  direction: "BUY" | "SELL" | "TRANSFER";
  tokenAddress: Address;
  symbol: string;
  tokenAmount: number;
  valueUsd: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  occurredAt: number;
}

export interface WalletPortfolioPosition {
  tokenAddress: Address;
  symbol: string;
  tokenAmount: number;
  costBasisUsd: number;
  realizedUsd: number;
  lastPriceUsd: number | null;
  currentValueUsd: number | null;
  unrealizedPnlUsd: number | null;
}

export interface SmartWalletScore {
  walletAddress: Address;
  label: string;
  score: number;
  grade: "A" | "B" | "C" | "D";
  trades: number;
  sells: number;
  profitableSells: number;
  winRate: number | null;
  realizedPnlUsd: number;
  volumeUsd: number;
}

export interface CustomAlertRule {
  id: number;
  chatId: string;
  name: string;
  direction: "ANY" | "BUY" | "SELL";
  minValueUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number | null;
  minLiquidityUsd: number;
  minWallets: number;
  windowMinutes: number;
  enabled: boolean;
  createdAt: number;
}

export interface HolderSnapshot {
  capturedAt: number;
  holdersCount: number | null;
  top10Percent: number | null;
  holders: HolderSummary["holders"];
}

export interface TokenEvent {
  id: number;
  chatId: string;
  tokenAddress: Address;
  symbol: string;
  kind: string;
  title: string;
  txHash: Hash | null;
  valueUsd: number | null;
  createdAt: number;
}

export interface PaperPosition {
  chatId: string;
  userId: string;
  tokenAddress: Address;
  symbol: string;
  tokenAmount: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  averageEntryPriceUsd: number;
  updatedAt: number;
}

export interface BridgeFlow {
  txHash: Hash;
  direction: "IN" | "OUT";
  asset: string;
  amount: number;
  valueUsd: number | null;
  wallet: Address;
  occurredAt: number;
}

export interface DeployerReputation {
  address: Address;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  launches: number;
  liveMarkets: number;
  verifiedContracts: number;
  lowLiquidityLaunches: number;
  bestMarketCapUsd: number | null;
  tokens: Array<{ address: Address; symbol: string; marketCapUsd: number | null; liquidityUsd: number | null }>;
}

export interface SwapQuote {
  source: "UNISWAP_V4" | "POOL_ESTIMATE";
  amountInTokens: number;
  amountOutTokens: number | null;
  amountOutUsd: number | null;
  priceImpactPercent: number | null;
  gasEstimate: bigint | null;
  note: string;
}

export interface PaperCompetition {
  id: number;
  chatId: string;
  name: string;
  startingBalanceUsd: number;
  startsAt: number;
  endsAt: number;
  status: "ACTIVE" | "ENDED";
  createdBy: string;
  createdAt: number;
}

export interface PaperCompetitionAccount {
  competitionId: number;
  userId: string;
  username: string;
  cashBalanceUsd: number;
  startingBalanceUsd: number;
  realizedPnlUsd: number;
  wins: number;
  losses: number;
  finalEquityUsd: number | null;
  finalPnlUsd: number | null;
  finalRank: number | null;
  joinedAt: number;
  updatedAt: number;
}

export interface PaperCompetitionPosition {
  competitionId: number;
  userId: string;
  tokenAddress: Address;
  symbol: string;
  tokenAmount: number;
  costBasisUsd: number;
  averageEntryPriceUsd: number;
  updatedAt: number;
}

export interface PaperCompetitionTrade {
  id: number;
  competitionId: number;
  userId: string;
  tokenAddress: Address;
  symbol: string;
  side: "BUY" | "SELL";
  tokenAmount: number;
  grossValueUsd: number;
  gasCostUsd: number;
  executionPriceUsd: number;
  realizedPnlUsd: number | null;
  marketCapUsd: number | null;
  quoteSource: "UNISWAP_V4";
  createdAt: number;
}

export interface PaperExecutionQuote {
  side: "BUY" | "SELL";
  source: "UNISWAP_V4";
  tokenAmount: number;
  grossValueUsd: number;
  gasCostUsd: number;
  executionPriceUsd: number;
  priceImpactPercent: number | null;
  gasEstimate: bigint;
  quotedAt: number;
}

export interface PaperPositionValuation extends PaperCompetitionPosition {
  liquidationValueUsd: number;
  gasCostUsd: number;
  unrealizedPnlUsd: number;
  currentExecutionPriceUsd: number;
  priceImpactPercent: number | null;
  quoteAvailable: boolean;
}

export interface PaperPortfolioSnapshot {
  competition: PaperCompetition;
  account: PaperCompetitionAccount;
  positions: PaperPositionValuation[];
  cashBalanceUsd: number;
  positionsValueUsd: number;
  equityUsd: number;
  totalPnlUsd: number;
  returnPercent: number;
  rank: number | null;
  participants: number;
  refreshedAt: number;
}

export interface PaperLeaderboardEntry {
  userId: string;
  username: string;
  equityUsd: number;
  pnlUsd: number;
  returnPercent: number;
  wins: number;
  losses: number;
  openPositions: number;
}
