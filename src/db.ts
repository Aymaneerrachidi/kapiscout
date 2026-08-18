import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAddress, type Address } from "viem";
import type {
  CallerStats,
  CallRecord,
  ChartMetric,
  ChartTimeframe,
  ChatSettings,
  MarketHistoryPoint,
  BridgeFlow,
  CustomAlertRule,
  HolderSnapshot,
  PaperPosition,
  PaperCompetition,
  PaperCompetitionAccount,
  PaperCompetitionPosition,
  PaperCompetitionTrade,
  PaperExecutionQuote,
  SecurityWalletWatch,
  SmartWalletScore,
  TokenEvent,
  TokenScan,
  TrackedWallet,
  WalletMovementRecord,
  WalletPortfolioPosition,
} from "./types.js";

interface CallRow {
  id: number;
  chat_id: string;
  message_id: number;
  user_id: string;
  username: string;
  token_address: string;
  symbol: string;
  entry_price_usd: number | null;
  entry_market_cap_usd: number | null;
  entry_liquidity_usd: number | null;
  ath_price_usd: number | null;
  ath_market_cap_usd: number | null;
  last_price_usd: number | null;
  last_market_cap_usd: number | null;
  last_liquidity_usd: number | null;
  last_dex_paid: number | null;
  scan_count: number;
  last_ath_alert_market_cap_usd: number | null;
  last_checked_at: number | null;
  proof_hash: string | null;
  called_at: number;
  updated_at: number;
}

interface WalletRow {
  id: number;
  scope: string;
  chat_id: string | null;
  telegram_user_id: string | null;
  address: string;
  label: string;
  is_kol: number;
  enabled: number;
  created_at: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    this.db = new DatabaseSync(absolute);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.backfillProofs();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        title TEXT,
        contract_enabled INTEGER NOT NULL DEFAULT 1,
        compact INTEGER NOT NULL DEFAULT 0,
        detailed INTEGER NOT NULL DEFAULT 0,
        kol_alerts INTEGER NOT NULL DEFAULT 1,
        show_chart INTEGER NOT NULL DEFAULT 1,
        buttons_enabled INTEGER NOT NULL DEFAULT 1,
        admin_only INTEGER NOT NULL DEFAULT 0,
        min_market_cap_usd REAL NOT NULL DEFAULT 0,
        milestone_alerts INTEGER NOT NULL DEFAULT 1,
        ath_alerts INTEGER NOT NULL DEFAULT 1,
        dex_paid_alerts INTEGER NOT NULL DEFAULT 1,
        liquidity_alerts INTEGER NOT NULL DEFAULT 1,
        dev_alerts INTEGER NOT NULL DEFAULT 1,
        whale_alerts INTEGER NOT NULL DEFAULT 1,
        chart_metric TEXT NOT NULL DEFAULT 'market_cap',
        chart_timeframe TEXT NOT NULL DEFAULT 'auto',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        entry_price_usd REAL,
        entry_market_cap_usd REAL,
        entry_liquidity_usd REAL,
        ath_price_usd REAL,
        ath_market_cap_usd REAL,
        last_price_usd REAL,
        last_market_cap_usd REAL,
        last_liquidity_usd REAL,
        last_dex_paid INTEGER,
        scan_count INTEGER NOT NULL DEFAULT 1,
        last_ath_alert_market_cap_usd REAL,
        last_checked_at INTEGER,
        called_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(chat_id, token_address)
      );
      CREATE INDEX IF NOT EXISTS calls_chat_called_idx ON calls(chat_id, called_at DESC);

      CREATE TABLE IF NOT EXISTS tracked_wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        chat_id TEXT,
        telegram_user_id TEXT,
        address TEXT NOT NULL,
        label TEXT NOT NULL,
        is_kol INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        UNIQUE(scope, address)
      );
      CREATE INDEX IF NOT EXISTS tracked_wallet_address_idx ON tracked_wallets(address, enabled);

      CREATE TABLE IF NOT EXISTS alert_events (
        tx_hash TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(tx_hash, wallet_address, chat_id)
      );

      CREATE TABLE IF NOT EXISTS cursors (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS call_alert_events (
        call_id INTEGER NOT NULL,
        event_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(call_id, event_key),
        FOREIGN KEY(call_id) REFERENCES calls(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS security_wallets (
        chat_id TEXT NOT NULL,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('DEV', 'WHALE')),
        holding_percent REAL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(chat_id, token_address, wallet_address, kind)
      );
      CREATE INDEX IF NOT EXISTS security_wallet_address_idx ON security_wallets(wallet_address);

      CREATE TABLE IF NOT EXISTS market_snapshots (
        call_id INTEGER NOT NULL,
        bucket INTEGER NOT NULL,
        captured_at INTEGER NOT NULL,
        price_usd REAL,
        market_cap_usd REAL,
        liquidity_usd REAL,
        PRIMARY KEY(call_id, bucket),
        FOREIGN KEY(call_id) REFERENCES calls(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS market_snapshots_call_time_idx ON market_snapshots(call_id, captured_at);

      CREATE TABLE IF NOT EXISTS wallet_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        wallet_label TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        direction TEXT NOT NULL,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        token_amount REAL NOT NULL,
        value_usd REAL,
        price_usd REAL,
        market_cap_usd REAL,
        liquidity_usd REAL,
        occurred_at INTEGER NOT NULL,
        UNIQUE(chat_id, tx_hash, wallet_address, token_address)
      );
      CREATE INDEX IF NOT EXISTS wallet_movements_chat_time_idx ON wallet_movements(chat_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS wallet_movements_wallet_time_idx ON wallet_movements(wallet_address, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS custom_alert_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        name TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'ANY',
        min_value_usd REAL NOT NULL DEFAULT 0,
        min_market_cap_usd REAL NOT NULL DEFAULT 0,
        max_market_cap_usd REAL,
        min_liquidity_usd REAL NOT NULL DEFAULT 0,
        min_wallets INTEGER NOT NULL DEFAULT 1,
        window_minutes INTEGER NOT NULL DEFAULT 5,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS custom_alert_events (
        rule_id INTEGER NOT NULL,
        token_address TEXT NOT NULL,
        bucket INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(rule_id, token_address, bucket)
      );

      CREATE TABLE IF NOT EXISTS holder_snapshots (
        chat_id TEXT NOT NULL,
        token_address TEXT NOT NULL,
        bucket INTEGER NOT NULL,
        captured_at INTEGER NOT NULL,
        holders_count INTEGER,
        top10_percent REAL,
        holders_json TEXT NOT NULL,
        PRIMARY KEY(chat_id, token_address, bucket)
      );

      CREATE TABLE IF NOT EXISTS token_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        tx_hash TEXT,
        value_usd REAL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS token_events_lookup_idx ON token_events(chat_id, token_address, created_at DESC);

      CREATE TABLE IF NOT EXISTS paper_positions (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        token_amount REAL NOT NULL,
        cost_basis_usd REAL NOT NULL,
        realized_pnl_usd REAL NOT NULL DEFAULT 0,
        average_entry_price_usd REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(chat_id, user_id, token_address)
      );
      CREATE TABLE IF NOT EXISTS paper_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        token_amount REAL NOT NULL,
        value_usd REAL NOT NULL,
        price_usd REAL NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paper_competitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        name TEXT NOT NULL,
        starting_balance_usd REAL NOT NULL,
        starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','ENDED')),
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS paper_competitions_chat_idx ON paper_competitions(chat_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS paper_competition_accounts (
        competition_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        cash_balance_usd REAL NOT NULL,
        starting_balance_usd REAL NOT NULL,
        realized_pnl_usd REAL NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        final_equity_usd REAL,
        final_pnl_usd REAL,
        final_rank INTEGER,
        joined_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(competition_id,user_id),
        FOREIGN KEY(competition_id) REFERENCES paper_competitions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS paper_competition_positions (
        competition_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        token_amount REAL NOT NULL,
        cost_basis_usd REAL NOT NULL,
        average_entry_price_usd REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(competition_id,user_id,token_address),
        FOREIGN KEY(competition_id,user_id) REFERENCES paper_competition_accounts(competition_id,user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS paper_competition_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        competition_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
        token_amount REAL NOT NULL,
        gross_value_usd REAL NOT NULL,
        gas_cost_usd REAL NOT NULL,
        execution_price_usd REAL NOT NULL,
        realized_pnl_usd REAL,
        market_cap_usd REAL,
        quote_source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(competition_id,user_id) REFERENCES paper_competition_accounts(competition_id,user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS paper_competition_trades_user_idx ON paper_competition_trades(competition_id,user_id,created_at DESC);

      CREATE TABLE IF NOT EXISTS bridge_flows (
        tx_hash TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount REAL NOT NULL,
        value_usd REAL,
        wallet_address TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
    `);
    for (const [table, column, definition] of [
      ["chats", "show_chart", "INTEGER NOT NULL DEFAULT 1"],
      ["chats", "buttons_enabled", "INTEGER NOT NULL DEFAULT 1"],
      ["chats", "admin_only", "INTEGER NOT NULL DEFAULT 0"],
      ["chats", "min_market_cap_usd", "REAL NOT NULL DEFAULT 0"],
      ["chats", "milestone_alerts", "INTEGER NOT NULL DEFAULT 1"],
      ["chats", "ath_alerts", "INTEGER NOT NULL DEFAULT 1"],
      ["chats", "dex_paid_alerts", "INTEGER NOT NULL DEFAULT 1"],
      ["chats", "liquidity_alerts", "INTEGER NOT NULL DEFAULT 1"],
      ["chats", "dev_alerts", "INTEGER NOT NULL DEFAULT 1"],
      ["chats", "whale_alerts", "INTEGER NOT NULL DEFAULT 1"],
      ["chats", "chart_metric", "TEXT NOT NULL DEFAULT 'market_cap'"],
      ["chats", "chart_timeframe", "TEXT NOT NULL DEFAULT 'auto'"],
      ["chats", "digest_enabled", "INTEGER NOT NULL DEFAULT 0"],
      ["chats", "digest_hour", "INTEGER NOT NULL DEFAULT 9"],
      ["chats", "last_digest_day", "TEXT"],
      ["chats", "bridge_alerts", "INTEGER NOT NULL DEFAULT 0"],
      ["chats", "bridge_min_usd", "REAL NOT NULL DEFAULT 10000"],
      ["calls", "last_price_usd", "REAL"],
      ["calls", "last_market_cap_usd", "REAL"],
      ["calls", "last_liquidity_usd", "REAL"],
      ["calls", "last_dex_paid", "INTEGER"],
      ["calls", "scan_count", "INTEGER NOT NULL DEFAULT 1"],
      ["calls", "last_ath_alert_market_cap_usd", "REAL"],
      ["calls", "last_checked_at", "INTEGER"],
      ["calls", "proof_hash", "TEXT"],
      ["paper_competition_accounts", "final_equity_usd", "REAL"],
      ["paper_competition_accounts", "final_pnl_usd", "REAL"],
      ["paper_competition_accounts", "final_rank", "INTEGER"],
    ] as const) this.ensureColumn(table, column, definition);
  }

  private backfillProofs(): void {
    const rows = this.db.prepare("SELECT * FROM calls WHERE proof_hash IS NULL OR proof_hash = ''").all() as unknown as CallRow[];
    const update = this.db.prepare("UPDATE calls SET proof_hash = ? WHERE id = ?");
    for (const row of rows) update.run(proofForRow(row), row.id);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close(): void {
    this.db.close();
  }

  ensureChat(chatId: string, title: string | null): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO chats(chat_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
    `).run(chatId, title, now, now);
  }

  getChatSettings(chatId: string): ChatSettings {
    const row = this.db.prepare("SELECT * FROM chats WHERE chat_id = ?").get(chatId) as Record<string, number | string> | undefined;
    return {
      contractEnabled: row ? Boolean(row.contract_enabled) : true,
      compact: row ? Boolean(row.compact) : false,
      detailed: row ? Boolean(row.detailed) : false,
      kolAlerts: row ? Boolean(row.kol_alerts) : true,
      showChart: row ? Boolean(row.show_chart) : true,
      buttonsEnabled: row ? Boolean(row.buttons_enabled) : true,
      adminOnly: row ? Boolean(row.admin_only) : false,
      minMarketCapUsd: Number(row?.min_market_cap_usd ?? 0),
      milestoneAlerts: row ? Boolean(row.milestone_alerts) : true,
      athAlerts: row ? Boolean(row.ath_alerts) : true,
      dexPaidAlerts: row ? Boolean(row.dex_paid_alerts) : true,
      liquidityAlerts: row ? Boolean(row.liquidity_alerts) : true,
      devAlerts: row ? Boolean(row.dev_alerts) : true,
      whaleAlerts: row ? Boolean(row.whale_alerts) : true,
      chartMetric: row?.chart_metric === "price" ? "price" : "market_cap",
      chartTimeframe: isChartTimeframe(row?.chart_timeframe) ? row.chart_timeframe : "auto",
      digestEnabled: row ? Boolean(row.digest_enabled) : false,
      digestHour: Number(row?.digest_hour ?? 9),
      bridgeAlerts: row ? Boolean(row.bridge_alerts) : false,
      bridgeMinUsd: Number(row?.bridge_min_usd ?? 10_000),
    };
  }

  updateChatSetting(chatId: string, field: "contract_enabled" | "compact" | "detailed" | "kol_alerts" | "show_chart" | "buttons_enabled" | "admin_only" | "milestone_alerts" | "ath_alerts" | "dex_paid_alerts" | "liquidity_alerts" | "dev_alerts" | "whale_alerts", enabled: boolean): void {
    const allowed = new Set(["contract_enabled", "compact", "detailed", "kol_alerts", "show_chart", "buttons_enabled", "admin_only", "milestone_alerts", "ath_alerts", "dex_paid_alerts", "liquidity_alerts", "dev_alerts", "whale_alerts"]);
    if (!allowed.has(field)) throw new Error("Unknown chat setting");
    this.db.prepare(`UPDATE chats SET ${field} = ?, updated_at = ? WHERE chat_id = ?`).run(enabled ? 1 : 0, Date.now(), chatId);
  }

  updateMinMarketCap(chatId: string, value: number): void {
    this.db.prepare("UPDATE chats SET min_market_cap_usd = ?, updated_at = ? WHERE chat_id = ?")
      .run(Math.max(0, value), Date.now(), chatId);
  }

  updateChartPreference(chatId: string, metric: ChartMetric, timeframe: ChartTimeframe): void {
    this.db.prepare("UPDATE chats SET chart_metric = ?, chart_timeframe = ?, updated_at = ? WHERE chat_id = ?")
      .run(metric, timeframe, Date.now(), chatId);
  }

  recordCall(input: {
    chatId: string;
    messageId: number;
    userId: string;
    username: string;
    scan: TokenScan;
  }): { call: CallRecord; created: boolean } {
    const now = Date.now();
    const market = input.scan.market;
    const proofHash = proofForValues({
      chatId: input.chatId, messageId: input.messageId, userId: input.userId,
      tokenAddress: input.scan.token.address.toLowerCase(), calledAt: now,
      entryPriceUsd: market.priceUsd, entryMarketCapUsd: market.marketCapUsd ?? market.fdvUsd,
      entryLiquidityUsd: market.liquidityUsd,
    });
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO calls(
        chat_id, message_id, user_id, username, token_address, symbol,
        entry_price_usd, entry_market_cap_usd, entry_liquidity_usd,
        ath_price_usd, ath_market_cap_usd, last_price_usd, last_market_cap_usd,
        last_liquidity_usd, last_dex_paid, scan_count, last_checked_at, proof_hash, called_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.chatId,
      input.messageId,
      input.userId,
      input.username,
      input.scan.token.address.toLowerCase(),
      input.scan.token.symbol,
      market.priceUsd,
      market.marketCapUsd ?? market.fdvUsd,
      market.liquidityUsd,
      market.priceUsd,
      market.marketCapUsd ?? market.fdvUsd,
      market.priceUsd,
      market.marketCapUsd ?? market.fdvUsd,
      market.liquidityUsd,
      market.dexPaid == null ? null : market.dexPaid ? 1 : 0,
      1,
      now,
      proofHash,
      now,
      now,
    );
    if (result.changes === 0 && (market.priceUsd != null || market.marketCapUsd != null || market.fdvUsd != null)) {
      const marketCap = market.marketCapUsd ?? market.fdvUsd;
      this.db.prepare(`
        UPDATE calls SET
          symbol = ?,
          entry_price_usd = COALESCE(entry_price_usd, ?),
          entry_market_cap_usd = COALESCE(entry_market_cap_usd, ?),
          entry_liquidity_usd = COALESCE(entry_liquidity_usd, ?),
          ath_price_usd = CASE
            WHEN ? IS NOT NULL AND (ath_price_usd IS NULL OR ? > ath_price_usd) THEN ?
            ELSE ath_price_usd
          END,
          ath_market_cap_usd = CASE
            WHEN ? IS NOT NULL AND (ath_market_cap_usd IS NULL OR ? > ath_market_cap_usd) THEN ?
            ELSE ath_market_cap_usd
          END,
          last_price_usd = COALESCE(?, last_price_usd),
          last_market_cap_usd = COALESCE(?, last_market_cap_usd),
          last_liquidity_usd = COALESCE(?, last_liquidity_usd),
          last_dex_paid = COALESCE(?, last_dex_paid),
          scan_count = scan_count + 1,
          last_checked_at = ?,
          updated_at = ?
        WHERE chat_id = ? AND token_address = ?
      `).run(
        input.scan.token.symbol,
        market.priceUsd,
        marketCap,
        market.liquidityUsd,
        market.priceUsd,
        market.priceUsd,
        market.priceUsd,
        marketCap,
        marketCap,
        marketCap,
        market.priceUsd,
        marketCap,
        market.liquidityUsd,
        market.dexPaid == null ? null : market.dexPaid ? 1 : 0,
        now,
        now,
        input.chatId,
        input.scan.token.address.toLowerCase(),
      );
    }
    this.syncSecurityWatchers(input.chatId, input.scan);
    const call = this.getCall(input.chatId, input.scan.token.address);
    if (!call) throw new Error("Failed to load recorded call");
    this.recordMarketSnapshot(call.id, market.priceUsd, market.marketCapUsd ?? market.fdvUsd, market.liquidityUsd, now);
    this.recordHolderSnapshot(input.chatId, input.scan);
    if (result.changes > 0) this.recordTokenEvent({
      chatId: input.chatId,
      tokenAddress: input.scan.token.address,
      symbol: input.scan.token.symbol,
      kind: "CALL",
      title: `First call by ${input.username}`,
      txHash: null,
      valueUsd: market.marketCapUsd ?? market.fdvUsd,
      createdAt: now,
    });
    return { call, created: result.changes > 0 };
  }

  getCall(chatId: string, tokenAddress: Address): CallRecord | null {
    const row = this.db.prepare("SELECT * FROM calls WHERE chat_id = ? AND token_address = ?")
      .get(chatId, tokenAddress.toLowerCase()) as CallRow | undefined;
    return row ? mapCall(row) : null;
  }

  listCalls(chatId: string, limit = 10): CallRecord[] {
    const rows = this.db.prepare("SELECT * FROM calls WHERE chat_id = ? ORDER BY called_at DESC LIMIT ?")
      .all(chatId, limit) as unknown as CallRow[];
    return rows.map(mapCall);
  }

  listAllCalls(): CallRecord[] {
    const rows = this.db.prepare("SELECT * FROM calls ORDER BY called_at DESC").all() as unknown as CallRow[];
    return rows.map(mapCall);
  }

  updateCallAth(callId: number, priceUsd: number | null, marketCapUsd: number | null): void {
    this.updateCallMarket(callId, {
      priceUsd,
      marketCapUsd,
      liquidityUsd: null,
      dexPaid: null,
      incrementScan: false,
    });
  }

  updateCallMarket(callId: number, input: {
    priceUsd: number | null;
    marketCapUsd: number | null;
    liquidityUsd: number | null;
    dexPaid: boolean | null;
    incrementScan?: boolean;
  }): CallRecord | null {
    const now = Date.now();
    this.db.prepare(`
      UPDATE calls SET
        ath_price_usd = CASE WHEN ? IS NOT NULL AND (ath_price_usd IS NULL OR ? > ath_price_usd) THEN ? ELSE ath_price_usd END,
        ath_market_cap_usd = CASE WHEN ? IS NOT NULL AND (ath_market_cap_usd IS NULL OR ? > ath_market_cap_usd) THEN ? ELSE ath_market_cap_usd END,
        last_price_usd = COALESCE(?, last_price_usd),
        last_market_cap_usd = COALESCE(?, last_market_cap_usd),
        last_liquidity_usd = COALESCE(?, last_liquidity_usd),
        last_dex_paid = COALESCE(?, last_dex_paid),
        scan_count = scan_count + ?,
        last_checked_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      input.priceUsd, input.priceUsd, input.priceUsd,
      input.marketCapUsd, input.marketCapUsd, input.marketCapUsd,
      input.priceUsd, input.marketCapUsd, input.liquidityUsd,
      input.dexPaid == null ? null : input.dexPaid ? 1 : 0,
      input.incrementScan ? 1 : 0,
      now, now, callId,
    );
    this.recordMarketSnapshot(callId, input.priceUsd, input.marketCapUsd, input.liquidityUsd, now);
    return this.getCallById(callId);
  }

  marketHistory(callId: number, limit = 288): MarketHistoryPoint[] {
    const rows = this.db.prepare(`
      SELECT captured_at, price_usd, market_cap_usd, liquidity_usd FROM (
        SELECT captured_at, price_usd, market_cap_usd, liquidity_usd
        FROM market_snapshots WHERE call_id = ? ORDER BY captured_at DESC LIMIT ?
      ) ORDER BY captured_at ASC
    `).all(callId, limit) as Array<{ captured_at: number; price_usd: number | null; market_cap_usd: number | null; liquidity_usd: number | null }>;
    return rows.map((row) => ({ capturedAt: row.captured_at, priceUsd: row.price_usd, marketCapUsd: row.market_cap_usd, liquidityUsd: row.liquidity_usd }));
  }

  realAlphaLeaderboard(chatId: string, limit = 10): CallRecord[] {
    const calls = this.listCalls(chatId, 10_000).filter((call) => call.entryMarketCapUsd && call.lastMarketCapUsd && call.entryLiquidityUsd && call.lastLiquidityUsd);
    return calls.sort((a, b) => realAlphaMultiple(b) - realAlphaMultiple(a)).slice(0, limit);
  }

  private recordMarketSnapshot(callId: number, priceUsd: number | null, marketCapUsd: number | null, liquidityUsd: number | null, capturedAt: number): void {
    const bucket = Math.floor(capturedAt / 300_000);
    this.db.prepare(`
      INSERT INTO market_snapshots(call_id, bucket, captured_at, price_usd, market_cap_usd, liquidity_usd)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(call_id, bucket) DO UPDATE SET
        captured_at = excluded.captured_at,
        price_usd = COALESCE(excluded.price_usd, price_usd),
        market_cap_usd = COALESCE(excluded.market_cap_usd, market_cap_usd),
        liquidity_usd = COALESCE(excluded.liquidity_usd, liquidity_usd)
    `).run(callId, bucket, capturedAt, priceUsd, marketCapUsd, liquidityUsd);
  }

  getCallById(callId: number): CallRecord | null {
    const row = this.db.prepare("SELECT * FROM calls WHERE id = ?").get(callId) as CallRow | undefined;
    return row ? mapCall(row) : null;
  }

  setLastAthAlert(callId: number, marketCapUsd: number): void {
    this.db.prepare("UPDATE calls SET last_ath_alert_market_cap_usd = ?, updated_at = ? WHERE id = ?")
      .run(marketCapUsd, Date.now(), callId);
  }

  claimCallAlert(callId: number, eventKey: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO call_alert_events(call_id, event_key, created_at) VALUES (?, ?, ?)
    `).run(callId, eventKey, Date.now());
    return result.changes > 0;
  }

  leaderboard(chatId: string, limit = 10): CallRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM calls
      WHERE chat_id = ? AND entry_market_cap_usd > 0 AND ath_market_cap_usd IS NOT NULL
      ORDER BY (ath_market_cap_usd / entry_market_cap_usd) DESC
      LIMIT ?
    `).all(chatId, limit) as unknown as CallRow[];
    return rows.map(mapCall);
  }

  activeCalls(chatId: string, limit = 10): CallRecord[] {
    const calls = this.listCalls(chatId, 200).filter((call) => call.entryMarketCapUsd && call.lastMarketCapUsd);
    return calls.sort((a, b) => currentMultiple(b) - currentMultiple(a)).slice(0, limit);
  }

  callerStats(chatId: string): CallerStats[] {
    const grouped = new Map<string, CallRecord[]>();
    for (const call of this.listCalls(chatId, 10_000)) {
      const key = call.userId;
      grouped.set(key, [...(grouped.get(key) ?? []), call]);
    }
    return [...grouped.entries()].map(([userId, calls]) => {
      const current = calls.flatMap((call) => {
        const multiple = call.entryMarketCapUsd && call.lastMarketCapUsd ? call.lastMarketCapUsd / call.entryMarketCapUsd : null;
        return multiple == null ? [] : [multiple];
      });
      const ath = calls.flatMap((call) => {
        const multiple = call.entryMarketCapUsd && call.athMarketCapUsd ? call.athMarketCapUsd / call.entryMarketCapUsd : null;
        return multiple == null ? [] : [multiple];
      });
      const sortedReturns = current.map((multiple) => (multiple - 1) * 100).sort((a, b) => a - b);
      const midpoint = Math.floor(sortedReturns.length / 2);
      const medianReturn = sortedReturns.length === 0 ? null : sortedReturns.length % 2
        ? sortedReturns[midpoint] ?? null
        : ((sortedReturns[midpoint - 1] ?? 0) + (sortedReturns[midpoint] ?? 0)) / 2;
      return {
        userId,
        username: calls[0]?.username ?? "Anonymous",
        totalCalls: calls.length,
        currentWins: current.filter((value) => value >= 1).length,
        hits2x: ath.filter((value) => value >= 2).length,
        hits5x: ath.filter((value) => value >= 5).length,
        hits10x: ath.filter((value) => value >= 10).length,
        winRate: current.length ? current.filter((value) => value >= 1).length / current.length * 100 : 0,
        medianReturn,
        bestMultiple: ath.length ? Math.max(...ath) : null,
      };
    }).sort((a, b) => (b.bestMultiple ?? 0) - (a.bestMultiple ?? 0));
  }

  syncSecurityWatchers(chatId: string, scan: TokenScan): void {
    const now = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO security_wallets(chat_id, token_address, symbol, wallet_address, kind, holding_percent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, token_address, wallet_address, kind)
      DO UPDATE SET symbol = excluded.symbol, holding_percent = excluded.holding_percent
    `);
    if (scan.creator) insert.run(chatId, scan.token.address.toLowerCase(), scan.token.symbol, scan.creator.toLowerCase(), "DEV", null, now);
    for (const holder of scan.holders.holders.filter((item) => !item.isContract && item.percent >= 1)) {
      insert.run(chatId, scan.token.address.toLowerCase(), scan.token.symbol, holder.address.toLowerCase(), "WHALE", holder.percent, now);
    }
  }

  securityWatchedAddressSet(): Set<string> {
    const rows = this.db.prepare("SELECT DISTINCT wallet_address FROM security_wallets").all() as Array<{ wallet_address: string }>;
    return new Set(rows.map((row) => row.wallet_address.toLowerCase()));
  }

  findSecurityWallets(address: Address): SecurityWalletWatch[] {
    const rows = this.db.prepare("SELECT * FROM security_wallets WHERE wallet_address = ?")
      .all(address.toLowerCase()) as Array<{ chat_id: string; token_address: string; symbol: string; wallet_address: string; kind: "DEV" | "WHALE"; holding_percent: number | null }>;
    return rows.map((row) => ({
      chatId: row.chat_id,
      tokenAddress: getAddress(row.token_address),
      symbol: row.symbol,
      walletAddress: getAddress(row.wallet_address),
      kind: row.kind,
      holdingPercent: row.holding_percent,
    }));
  }

  chatAllowsAlert(chatId: string, kind: "dev" | "whale"): boolean {
    const settings = this.getChatSettings(chatId);
    return kind === "dev" ? settings.devAlerts : settings.whaleAlerts;
  }

  upsertKol(label: string, address: Address): void {
    this.db.prepare(`
      INSERT INTO tracked_wallets(scope, chat_id, telegram_user_id, address, label, is_kol, enabled, created_at)
      VALUES ('global', NULL, NULL, ?, ?, 1, 1, ?)
      ON CONFLICT(scope, address) DO UPDATE SET label = excluded.label, enabled = 1
    `).run(address.toLowerCase(), label, Date.now());
  }

  addWallet(chatId: string, userId: string, address: Address, label: string): TrackedWallet {
    const scope = `chat:${chatId}`;
    this.db.prepare(`
      INSERT INTO tracked_wallets(scope, chat_id, telegram_user_id, address, label, is_kol, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?)
      ON CONFLICT(scope, address) DO UPDATE SET label = excluded.label, enabled = 1, telegram_user_id = excluded.telegram_user_id
    `).run(scope, chatId, userId, address.toLowerCase(), label, Date.now());
    const row = this.db.prepare("SELECT * FROM tracked_wallets WHERE scope = ? AND address = ?")
      .get(scope, address.toLowerCase()) as unknown as WalletRow;
    return mapWallet(row);
  }

  removeWallet(chatId: string, address: Address): boolean {
    const result = this.db.prepare("DELETE FROM tracked_wallets WHERE scope = ? AND address = ?")
      .run(`chat:${chatId}`, address.toLowerCase());
    return result.changes > 0;
  }

  renameWallet(chatId: string, address: Address, label: string): boolean {
    const result = this.db.prepare(`
      UPDATE tracked_wallets SET label = ?
      WHERE scope = ? AND address = ? AND enabled = 1
    `).run(label, `chat:${chatId}`, address.toLowerCase());
    return result.changes > 0;
  }

  countCustomWallets(chatId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM tracked_wallets WHERE scope = ?")
      .get(`chat:${chatId}`) as { count: number };
    return row.count;
  }

  listWallets(chatId?: string): TrackedWallet[] {
    const rows = chatId
      ? this.db.prepare("SELECT * FROM tracked_wallets WHERE scope IN ('global', ?) AND enabled = 1 ORDER BY is_kol DESC, label")
        .all(`chat:${chatId}`)
      : this.db.prepare("SELECT * FROM tracked_wallets WHERE enabled = 1 ORDER BY is_kol DESC, label").all();
    return (rows as unknown as WalletRow[]).map(mapWallet);
  }

  findWallets(address: Address): TrackedWallet[] {
    const rows = this.db.prepare("SELECT * FROM tracked_wallets WHERE address = ? AND enabled = 1")
      .all(address.toLowerCase()) as unknown as WalletRow[];
    return rows.map(mapWallet);
  }

  trackedAddressSet(): Set<string> {
    const rows = this.db.prepare("SELECT DISTINCT address FROM tracked_wallets WHERE enabled = 1").all() as Array<{ address: string }>;
    return new Set(rows.map((row) => row.address.toLowerCase()));
  }

  listKolAlertChats(): string[] {
    const rows = this.db.prepare("SELECT chat_id FROM chats WHERE kol_alerts = 1").all() as Array<{ chat_id: string }>;
    return rows.map((row) => row.chat_id);
  }

  claimAlert(txHash: string, walletAddress: Address, chatId: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO alert_events(tx_hash, wallet_address, chat_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(txHash.toLowerCase(), walletAddress.toLowerCase(), chatId, Date.now());
    return result.changes > 0;
  }

  recordWalletMovement(input: Omit<WalletMovementRecord, "id">): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO wallet_movements(
      chat_id, wallet_address, wallet_label, tx_hash, direction, token_address, symbol,
      token_amount, value_usd, price_usd, market_cap_usd, liquidity_usd, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.chatId, input.walletAddress.toLowerCase(), input.walletLabel, input.txHash.toLowerCase(), input.direction,
      input.tokenAddress.toLowerCase(), input.symbol, input.tokenAmount, input.valueUsd, input.priceUsd,
      input.marketCapUsd, input.liquidityUsd, input.occurredAt,
    );
    return result.changes > 0;
  }

  listWalletMovements(chatId: string, walletAddress?: Address, since?: number): WalletMovementRecord[] {
    const clauses = ["chat_id = ?"];
    const values: Array<string | number> = [chatId];
    if (walletAddress) { clauses.push("wallet_address = ?"); values.push(walletAddress.toLowerCase()); }
    if (since) { clauses.push("occurred_at >= ?"); values.push(since); }
    const rows = this.db.prepare(`SELECT * FROM wallet_movements WHERE ${clauses.join(" AND ")} ORDER BY occurred_at ASC, id ASC`).all(...values) as Array<Record<string, unknown>>;
    return rows.map(mapWalletMovement);
  }

  walletPortfolio(chatId: string, walletAddress?: Address): WalletPortfolioPosition[] {
    const records = this.listWalletMovements(chatId, walletAddress);
    const positions = new Map<string, WalletPortfolioPosition>();
    for (const item of records) {
      if (item.direction === "TRANSFER") continue;
      const key = item.tokenAddress.toLowerCase();
      const position = positions.get(key) ?? { tokenAddress: item.tokenAddress, symbol: item.symbol, tokenAmount: 0, costBasisUsd: 0, realizedUsd: 0, lastPriceUsd: null, currentValueUsd: null, unrealizedPnlUsd: null };
      position.symbol = item.symbol;
      position.lastPriceUsd = item.priceUsd ?? position.lastPriceUsd;
      if (item.direction === "BUY") {
        position.tokenAmount += item.tokenAmount;
        position.costBasisUsd += item.valueUsd ?? (item.priceUsd == null ? 0 : item.tokenAmount * item.priceUsd);
      } else if (position.tokenAmount > 0) {
        const sold = Math.min(position.tokenAmount, item.tokenAmount);
        const basisRemoved = position.costBasisUsd * sold / position.tokenAmount;
        position.tokenAmount -= sold;
        position.costBasisUsd -= basisRemoved;
        position.realizedUsd += (item.valueUsd ?? (item.priceUsd == null ? 0 : sold * item.priceUsd)) - basisRemoved;
      }
      positions.set(key, position);
    }
    return [...positions.values()].filter((item) => item.tokenAmount > 0.000000001).map((item) => ({
      ...item,
      currentValueUsd: item.lastPriceUsd == null ? null : item.tokenAmount * item.lastPriceUsd,
      unrealizedPnlUsd: item.lastPriceUsd == null ? null : item.tokenAmount * item.lastPriceUsd - item.costBasisUsd,
    }));
  }

  smartWalletScore(chatId: string, walletAddress: Address): SmartWalletScore | null {
    const rows = this.listWalletMovements(chatId, walletAddress).filter((item) => item.direction !== "TRANSFER");
    if (!rows.length) return null;
    let sells = 0, profitableSells = 0, volume = 0, realizedPnlUsd = 0;
    const ledgers = new Map<string, { amount: number; cost: number }>();
    for (const row of rows) {
      const value = row.valueUsd ?? 0;
      volume += value;
      const key = row.tokenAddress.toLowerCase();
      const ledger = ledgers.get(key) ?? { amount: 0, cost: 0 };
      if (row.direction === "BUY") { ledger.amount += row.tokenAmount; ledger.cost += value; }
      else {
        sells += 1;
        const sold = Math.min(ledger.amount, row.tokenAmount);
        const basis = ledger.amount > 0 ? ledger.cost * sold / ledger.amount : 0;
        const pnl = value - basis;
        realizedPnlUsd += pnl;
        if (pnl > 0) profitableSells += 1;
        ledger.amount -= sold;
        ledger.cost -= basis;
      }
      ledgers.set(key, ledger);
    }
    const winRate = sells ? profitableSells / sells * 100 : null;
    const activity = Math.min(30, rows.length * 3);
    const winComponent = winRate == null ? 10 : Math.min(35, winRate * 0.35);
    const pnlComponent = Math.max(0, Math.min(35, 17.5 + (volume ? realizedPnlUsd / volume * 35 : 0)));
    const score = Math.round(Math.min(100, activity + winComponent + pnlComponent));
    return { walletAddress, label: rows.at(-1)?.walletLabel ?? walletAddress, score, grade: score >= 80 ? "A" : score >= 65 ? "B" : score >= 45 ? "C" : "D", trades: rows.length, sells, profitableSells, winRate, realizedPnlUsd, volumeUsd: volume };
  }

  addAlertRule(input: Omit<CustomAlertRule, "id" | "enabled" | "createdAt">): CustomAlertRule {
    const now = Date.now();
    const result = this.db.prepare(`INSERT INTO custom_alert_rules(chat_id,name,direction,min_value_usd,min_market_cap_usd,max_market_cap_usd,min_liquidity_usd,min_wallets,window_minutes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      input.chatId, input.name, input.direction, input.minValueUsd, input.minMarketCapUsd, input.maxMarketCapUsd, input.minLiquidityUsd, input.minWallets, input.windowMinutes, now,
    );
    return this.listAlertRules(input.chatId).find((item) => item.id === Number(result.lastInsertRowid))!;
  }

  listAlertRules(chatId: string): CustomAlertRule[] {
    const rows = this.db.prepare("SELECT * FROM custom_alert_rules WHERE chat_id = ? ORDER BY id").all(chatId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: Number(row.id), chatId: String(row.chat_id), name: String(row.name), direction: String(row.direction) as CustomAlertRule["direction"], minValueUsd: Number(row.min_value_usd), minMarketCapUsd: Number(row.min_market_cap_usd), maxMarketCapUsd: row.max_market_cap_usd == null ? null : Number(row.max_market_cap_usd), minLiquidityUsd: Number(row.min_liquidity_usd), minWallets: Number(row.min_wallets), windowMinutes: Number(row.window_minutes), enabled: Boolean(row.enabled), createdAt: Number(row.created_at) }));
  }

  removeAlertRule(chatId: string, id: number): boolean {
    return this.db.prepare("DELETE FROM custom_alert_rules WHERE chat_id = ? AND id = ?").run(chatId, id).changes > 0;
  }

  claimCustomAlert(rule: CustomAlertRule, tokenAddress: Address, now = Date.now()): boolean {
    const bucket = Math.floor(now / (rule.windowMinutes * 60_000));
    return this.db.prepare("INSERT OR IGNORE INTO custom_alert_events(rule_id,token_address,bucket,created_at) VALUES (?,?,?,?)").run(rule.id, tokenAddress.toLowerCase(), bucket, now).changes > 0;
  }

  matchingWalletCount(chatId: string, tokenAddress: Address, since: number, direction: CustomAlertRule["direction"]): number {
    const row = this.db.prepare(`SELECT COUNT(DISTINCT wallet_address) AS count FROM wallet_movements WHERE chat_id = ? AND token_address = ? AND occurred_at >= ? AND (? = 'ANY' OR direction = ?)`)
      .get(chatId, tokenAddress.toLowerCase(), since, direction, direction) as { count: number };
    return row.count;
  }

  recordHolderSnapshot(chatId: string, scan: TokenScan): void {
    const now = Date.now();
    const bucket = Math.floor(now / 900_000);
    this.db.prepare(`INSERT INTO holder_snapshots(chat_id,token_address,bucket,captured_at,holders_count,top10_percent,holders_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(chat_id,token_address,bucket) DO UPDATE SET captured_at=excluded.captured_at,holders_count=excluded.holders_count,top10_percent=excluded.top10_percent,holders_json=excluded.holders_json`).run(
      chatId, scan.token.address.toLowerCase(), bucket, now, scan.token.holdersCount, scan.holders.top10Percent,
      JSON.stringify(scan.holders.holders),
    );
  }

  holderSnapshots(chatId: string, tokenAddress: Address, limit = 96): HolderSnapshot[] {
    const rows = this.db.prepare("SELECT * FROM holder_snapshots WHERE chat_id = ? AND token_address = ? ORDER BY captured_at DESC LIMIT ?").all(chatId, tokenAddress.toLowerCase(), limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => ({ capturedAt: Number(row.captured_at), holdersCount: row.holders_count == null ? null : Number(row.holders_count), top10Percent: row.top10_percent == null ? null : Number(row.top10_percent), holders: JSON.parse(String(row.holders_json)) as HolderSnapshot["holders"] }));
  }

  recordTokenEvent(input: Omit<TokenEvent, "id" | "createdAt"> & { createdAt?: number }): void {
    this.db.prepare("INSERT INTO token_events(chat_id,token_address,symbol,kind,title,tx_hash,value_usd,created_at) VALUES (?,?,?,?,?,?,?,?)").run(input.chatId, input.tokenAddress.toLowerCase(), input.symbol, input.kind, input.title, input.txHash?.toLowerCase() ?? null, input.valueUsd, input.createdAt ?? Date.now());
  }

  tokenTimeline(chatId: string, tokenAddress: Address, limit = 20): TokenEvent[] {
    const rows = this.db.prepare("SELECT * FROM token_events WHERE chat_id = ? AND token_address = ? ORDER BY created_at DESC LIMIT ?").all(chatId, tokenAddress.toLowerCase(), limit) as Array<Record<string, unknown>>;
    return rows.map(mapTokenEvent);
  }

  recentTokenEvents(chatId: string, since: number, limit = 100): TokenEvent[] {
    const rows = this.db.prepare("SELECT * FROM token_events WHERE chat_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?").all(chatId, since, limit) as Array<Record<string, unknown>>;
    return rows.map(mapTokenEvent);
  }

  paperBuy(chatId: string, userId: string, tokenAddress: Address, symbol: string, valueUsd: number, priceUsd: number): PaperPosition {
    const amount = valueUsd / priceUsd;
    const now = Date.now();
    this.db.prepare(`INSERT INTO paper_positions(chat_id,user_id,token_address,symbol,token_amount,cost_basis_usd,average_entry_price_usd,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(chat_id,user_id,token_address) DO UPDATE SET symbol=excluded.symbol,token_amount=token_amount+excluded.token_amount,cost_basis_usd=cost_basis_usd+excluded.cost_basis_usd,average_entry_price_usd=(cost_basis_usd+excluded.cost_basis_usd)/(token_amount+excluded.token_amount),updated_at=excluded.updated_at`).run(chatId,userId,tokenAddress.toLowerCase(),symbol,amount,valueUsd,priceUsd,now);
    this.db.prepare("INSERT INTO paper_trades(chat_id,user_id,token_address,symbol,side,token_amount,value_usd,price_usd,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(chatId,userId,tokenAddress.toLowerCase(),symbol,"BUY",amount,valueUsd,priceUsd,now);
    return this.paperPosition(chatId,userId,tokenAddress)!;
  }

  paperSell(chatId: string, userId: string, tokenAddress: Address, fraction: number, priceUsd: number): PaperPosition | null {
    const current = this.paperPosition(chatId,userId,tokenAddress);
    if (!current || current.tokenAmount <= 0) return null;
    const safeFraction = Math.max(0.0001, Math.min(1, fraction));
    const amount = current.tokenAmount * safeFraction;
    const proceeds = amount * priceUsd;
    const basis = current.costBasisUsd * safeFraction;
    const now = Date.now();
    this.db.prepare("UPDATE paper_positions SET token_amount=token_amount-?,cost_basis_usd=cost_basis_usd-?,realized_pnl_usd=realized_pnl_usd+?,updated_at=? WHERE chat_id=? AND user_id=? AND token_address=?").run(amount,basis,proceeds-basis,now,chatId,userId,tokenAddress.toLowerCase());
    this.db.prepare("INSERT INTO paper_trades(chat_id,user_id,token_address,symbol,side,token_amount,value_usd,price_usd,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(chatId,userId,tokenAddress.toLowerCase(),current.symbol,"SELL",amount,proceeds,priceUsd,now);
    return this.paperPosition(chatId,userId,tokenAddress);
  }

  paperPositions(chatId: string, userId: string): PaperPosition[] {
    const rows = this.db.prepare("SELECT * FROM paper_positions WHERE chat_id=? AND user_id=? AND token_amount > 0.000000001 ORDER BY updated_at DESC").all(chatId,userId) as Array<Record<string, unknown>>;
    return rows.map(mapPaperPosition);
  }

  paperPosition(chatId: string, userId: string, tokenAddress: Address): PaperPosition | null {
    const row = this.db.prepare("SELECT * FROM paper_positions WHERE chat_id=? AND user_id=? AND token_address=?").get(chatId,userId,tokenAddress.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? mapPaperPosition(row) : null;
  }

  createPaperCompetition(input: { chatId:string; name:string; startingBalanceUsd:number; durationDays:number; createdBy:string }): PaperCompetition {
    const existing=this.activePaperCompetition(input.chatId);
    if(existing)throw new Error(`A competition is already active: ${existing.name}`);
    const now=Date.now();
    const balance=Math.max(100,Math.min(10_000_000,input.startingBalanceUsd));
    const duration=Math.max(1,Math.min(90,input.durationDays));
    const result=this.db.prepare("INSERT INTO paper_competitions(chat_id,name,starting_balance_usd,starts_at,ends_at,status,created_by,created_at) VALUES (?,?,?,?,?,'ACTIVE',?,?)").run(input.chatId,input.name.slice(0,48),balance,now,now+duration*86_400_000,input.createdBy,now);
    return this.paperCompetitionById(Number(result.lastInsertRowid))!;
  }

  activePaperCompetition(chatId:string):PaperCompetition|null{
    const row=this.db.prepare("SELECT * FROM paper_competitions WHERE chat_id=? AND status='ACTIVE' AND ends_at>? ORDER BY created_at DESC LIMIT 1").get(chatId,Date.now()) as Record<string,unknown>|undefined;
    return row?mapPaperCompetition(row):null;
  }

  latestPaperCompetition(chatId:string):PaperCompetition|null{
    const row=this.db.prepare("SELECT * FROM paper_competitions WHERE chat_id=? ORDER BY created_at DESC LIMIT 1").get(chatId) as Record<string,unknown>|undefined;
    return row?mapPaperCompetition(row):null;
  }

  paperCompetitionById(id:number):PaperCompetition|null{
    const row=this.db.prepare("SELECT * FROM paper_competitions WHERE id=?").get(id) as Record<string,unknown>|undefined;
    return row?mapPaperCompetition(row):null;
  }

  endPaperCompetition(chatId:string):PaperCompetition|null{
    const competition=this.activePaperCompetition(chatId);if(!competition)return null;
    this.db.prepare("UPDATE paper_competitions SET status='ENDED',ends_at=? WHERE id=?").run(Date.now(),competition.id);
    return this.paperCompetitionById(competition.id);
  }

  expiredActivePaperCompetitions(now=Date.now()):PaperCompetition[]{
    const rows=this.db.prepare("SELECT * FROM paper_competitions WHERE status='ACTIVE' AND ends_at<=? ORDER BY ends_at ASC").all(now) as Array<Record<string,unknown>>;
    return rows.map(mapPaperCompetition);
  }

  finalizePaperCompetition(competitionId:number,results:Array<{userId:string;equityUsd:number;pnlUsd:number;rank:number}>,endedAt=Date.now()):PaperCompetition|null{
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const update=this.db.prepare("UPDATE paper_competition_accounts SET final_equity_usd=?,final_pnl_usd=?,final_rank=?,updated_at=? WHERE competition_id=? AND user_id=?");
      for(const result of results)update.run(result.equityUsd,result.pnlUsd,result.rank,endedAt,competitionId,result.userId);
      this.db.prepare("UPDATE paper_competitions SET status='ENDED',ends_at=MIN(ends_at,?) WHERE id=?").run(endedAt,competitionId);
      this.db.exec("COMMIT");
      return this.paperCompetitionById(competitionId);
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  joinPaperCompetition(competitionId:number,userId:string,username:string):PaperCompetitionAccount{
    const competition=this.paperCompetitionById(competitionId);if(!competition||competition.status!=="ACTIVE"||competition.endsAt<=Date.now())throw new Error("This competition is no longer active.");
    const now=Date.now();
    this.db.prepare(`INSERT INTO paper_competition_accounts(competition_id,user_id,username,cash_balance_usd,starting_balance_usd,joined_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(competition_id,user_id) DO UPDATE SET username=excluded.username,updated_at=excluded.updated_at`).run(competitionId,userId,username,competition.startingBalanceUsd,competition.startingBalanceUsd,now,now);
    return this.paperCompetitionAccount(competitionId,userId)!;
  }

  paperCompetitionAccount(competitionId:number,userId:string):PaperCompetitionAccount|null{
    const row=this.db.prepare("SELECT * FROM paper_competition_accounts WHERE competition_id=? AND user_id=?").get(competitionId,userId) as Record<string,unknown>|undefined;
    return row?mapPaperCompetitionAccount(row):null;
  }

  paperCompetitionAccounts(competitionId:number,limit=100):PaperCompetitionAccount[]{
    const rows=this.db.prepare("SELECT * FROM paper_competition_accounts WHERE competition_id=? ORDER BY joined_at ASC LIMIT ?").all(competitionId,limit) as Array<Record<string,unknown>>;
    return rows.map(mapPaperCompetitionAccount);
  }

  paperCompetitionPositions(competitionId:number,userId:string):PaperCompetitionPosition[]{
    const rows=this.db.prepare("SELECT * FROM paper_competition_positions WHERE competition_id=? AND user_id=? AND token_amount>0.000000000001 ORDER BY updated_at DESC").all(competitionId,userId) as Array<Record<string,unknown>>;
    return rows.map(mapPaperCompetitionPosition);
  }

  paperCompetitionPosition(competitionId:number,userId:string,tokenAddress:Address):PaperCompetitionPosition|null{
    const row=this.db.prepare("SELECT * FROM paper_competition_positions WHERE competition_id=? AND user_id=? AND token_address=?").get(competitionId,userId,tokenAddress.toLowerCase()) as Record<string,unknown>|undefined;
    return row?mapPaperCompetitionPosition(row):null;
  }

  executeCompetitionBuy(input:{competitionId:number;userId:string;tokenAddress:Address;symbol:string;quote:PaperExecutionQuote;marketCapUsd:number|null}):PaperCompetitionPosition{
    const totalCost=input.quote.grossValueUsd+input.quote.gasCostUsd;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const competition=this.paperCompetitionById(input.competitionId);if(!competition||competition.status!=="ACTIVE"||competition.endsAt<=Date.now())throw new Error("Competition trading has ended.");
      const account=this.paperCompetitionAccount(input.competitionId,input.userId);if(!account)throw new Error("Join the competition before trading.");
      if(totalCost>account.cashBalanceUsd+0.000001)throw new Error(`Insufficient paper cash. Available: $${account.cashBalanceUsd.toFixed(2)}`);
      const current=this.paperCompetitionPosition(input.competitionId,input.userId,input.tokenAddress);
      const amount=(current?.tokenAmount??0)+input.quote.tokenAmount;
      const cost=(current?.costBasisUsd??0)+totalCost;
      const now=Date.now();
      this.db.prepare(`INSERT INTO paper_competition_positions(competition_id,user_id,token_address,symbol,token_amount,cost_basis_usd,average_entry_price_usd,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(competition_id,user_id,token_address) DO UPDATE SET symbol=excluded.symbol,token_amount=excluded.token_amount,cost_basis_usd=excluded.cost_basis_usd,average_entry_price_usd=excluded.average_entry_price_usd,updated_at=excluded.updated_at`).run(input.competitionId,input.userId,input.tokenAddress.toLowerCase(),input.symbol,amount,cost,cost/amount,now);
      this.db.prepare("UPDATE paper_competition_accounts SET cash_balance_usd=cash_balance_usd-?,updated_at=? WHERE competition_id=? AND user_id=?").run(totalCost,now,input.competitionId,input.userId);
      this.insertCompetitionTrade(input,null,now);
      this.db.exec("COMMIT");
      return this.paperCompetitionPosition(input.competitionId,input.userId,input.tokenAddress)!;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  executeCompetitionSell(input:{competitionId:number;userId:string;tokenAddress:Address;symbol:string;quote:PaperExecutionQuote;marketCapUsd:number|null}):{position:PaperCompetitionPosition;realizedPnlUsd:number;netProceedsUsd:number}{
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const competition=this.paperCompetitionById(input.competitionId);if(!competition||competition.status!=="ACTIVE"||competition.endsAt<=Date.now())throw new Error("Competition trading has ended.");
      const account=this.paperCompetitionAccount(input.competitionId,input.userId);if(!account)throw new Error("Join the competition before trading.");
      const current=this.paperCompetitionPosition(input.competitionId,input.userId,input.tokenAddress);if(!current||current.tokenAmount<=0)throw new Error("No open position for this token.");
      if(input.quote.tokenAmount>current.tokenAmount*1.000000001)throw new Error("Sell amount exceeds the open position.");
      const sold=Math.min(current.tokenAmount,input.quote.tokenAmount);const fraction=sold/current.tokenAmount;const basis=current.costBasisUsd*fraction;const net=Math.max(0,input.quote.grossValueUsd-input.quote.gasCostUsd);const realized=net-basis;const amount=Math.max(0,current.tokenAmount-sold);const cost=Math.max(0,current.costBasisUsd-basis);const now=Date.now();
      this.db.prepare("UPDATE paper_competition_positions SET token_amount=?,cost_basis_usd=?,average_entry_price_usd=?,updated_at=? WHERE competition_id=? AND user_id=? AND token_address=?").run(amount,cost,amount>0?cost/amount:0,now,input.competitionId,input.userId,input.tokenAddress.toLowerCase());
      this.db.prepare("UPDATE paper_competition_accounts SET cash_balance_usd=cash_balance_usd+?,realized_pnl_usd=realized_pnl_usd+?,wins=wins+?,losses=losses+?,updated_at=? WHERE competition_id=? AND user_id=?").run(net,realized,realized>0?1:0,realized<0?1:0,now,input.competitionId,input.userId);
      this.insertCompetitionTrade(input,realized,now);
      this.db.exec("COMMIT");
      return {position:this.paperCompetitionPosition(input.competitionId,input.userId,input.tokenAddress)!,realizedPnlUsd:realized,netProceedsUsd:net};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  private insertCompetitionTrade(input:{competitionId:number;userId:string;tokenAddress:Address;symbol:string;quote:PaperExecutionQuote;marketCapUsd:number|null},realizedPnlUsd:number|null,createdAt:number):void{
    this.db.prepare("INSERT INTO paper_competition_trades(competition_id,user_id,token_address,symbol,side,token_amount,gross_value_usd,gas_cost_usd,execution_price_usd,realized_pnl_usd,market_cap_usd,quote_source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(input.competitionId,input.userId,input.tokenAddress.toLowerCase(),input.symbol,input.quote.side,input.quote.tokenAmount,input.quote.grossValueUsd,input.quote.gasCostUsd,input.quote.executionPriceUsd,realizedPnlUsd,input.marketCapUsd,input.quote.source,createdAt);
  }

  paperCompetitionTrades(competitionId:number,userId:string,limit=20):PaperCompetitionTrade[]{
    const rows=this.db.prepare("SELECT * FROM paper_competition_trades WHERE competition_id=? AND user_id=? ORDER BY created_at DESC LIMIT ?").all(competitionId,userId,limit) as Array<Record<string,unknown>>;
    return rows.map(mapPaperCompetitionTrade);
  }

  configureDigest(chatId: string, enabled: boolean, hour?: number): void {
    this.db.prepare("UPDATE chats SET digest_enabled=?,digest_hour=COALESCE(?,digest_hour),updated_at=? WHERE chat_id=?").run(enabled ? 1 : 0, hour ?? null, Date.now(), chatId);
  }

  dueDigestChats(hour: number, day: string): string[] {
    const rows = this.db.prepare("SELECT chat_id FROM chats WHERE digest_enabled=1 AND digest_hour=? AND (last_digest_day IS NULL OR last_digest_day<>?)").all(hour,day) as Array<{chat_id:string}>;
    return rows.map((row)=>row.chat_id);
  }

  markDigestSent(chatId: string, day: string): void { this.db.prepare("UPDATE chats SET last_digest_day=? WHERE chat_id=?").run(day,chatId); }

  configureBridge(chatId: string, enabled: boolean, minUsd?: number): void {
    this.db.prepare("UPDATE chats SET bridge_alerts=?,bridge_min_usd=COALESCE(?,bridge_min_usd),updated_at=? WHERE chat_id=?").run(enabled?1:0,minUsd??null,Date.now(),chatId);
  }

  bridgeAlertChats(valueUsd: number | null): string[] {
    const rows = this.db.prepare("SELECT chat_id FROM chats WHERE bridge_alerts=1 AND (? IS NULL OR ? >= bridge_min_usd)").all(valueUsd,valueUsd) as Array<{chat_id:string}>;
    return rows.map((row)=>row.chat_id);
  }

  recordBridgeFlow(flow: BridgeFlow): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO bridge_flows(tx_hash,direction,asset,amount,value_usd,wallet_address,occurred_at) VALUES (?,?,?,?,?,?,?)").run(flow.txHash.toLowerCase(),flow.direction,flow.asset,flow.amount,flow.valueUsd,flow.wallet.toLowerCase(),flow.occurredAt).changes>0;
  }

  recentBridgeFlows(since: number, limit=20): BridgeFlow[] {
    const rows=this.db.prepare("SELECT * FROM bridge_flows WHERE occurred_at>=? ORDER BY occurred_at DESC LIMIT ?").all(since,limit) as Array<Record<string,unknown>>;
    return rows.map((row)=>({txHash:String(row.tx_hash) as BridgeFlow["txHash"],direction:String(row.direction) as BridgeFlow["direction"],asset:String(row.asset),amount:Number(row.amount),valueUsd:row.value_usd==null?null:Number(row.value_usd),wallet:getAddress(String(row.wallet_address)),occurredAt:Number(row.occurred_at)}));
  }
}

function mapWalletMovement(row: Record<string, unknown>): WalletMovementRecord {
  return { id:Number(row.id),chatId:String(row.chat_id),walletAddress:getAddress(String(row.wallet_address)),walletLabel:String(row.wallet_label),txHash:String(row.tx_hash) as WalletMovementRecord["txHash"],direction:String(row.direction) as WalletMovementRecord["direction"],tokenAddress:getAddress(String(row.token_address)),symbol:String(row.symbol),tokenAmount:Number(row.token_amount),valueUsd:row.value_usd==null?null:Number(row.value_usd),priceUsd:row.price_usd==null?null:Number(row.price_usd),marketCapUsd:row.market_cap_usd==null?null:Number(row.market_cap_usd),liquidityUsd:row.liquidity_usd==null?null:Number(row.liquidity_usd),occurredAt:Number(row.occurred_at) };
}

function mapTokenEvent(row: Record<string, unknown>): TokenEvent {
  return { id:Number(row.id),chatId:String(row.chat_id),tokenAddress:getAddress(String(row.token_address)),symbol:String(row.symbol),kind:String(row.kind),title:String(row.title),txHash:row.tx_hash ? String(row.tx_hash) as TokenEvent["txHash"] : null,valueUsd:row.value_usd==null?null:Number(row.value_usd),createdAt:Number(row.created_at) };
}

function mapPaperPosition(row: Record<string, unknown>): PaperPosition {
  return { chatId:String(row.chat_id),userId:String(row.user_id),tokenAddress:getAddress(String(row.token_address)),symbol:String(row.symbol),tokenAmount:Number(row.token_amount),costBasisUsd:Number(row.cost_basis_usd),realizedPnlUsd:Number(row.realized_pnl_usd),averageEntryPriceUsd:Number(row.average_entry_price_usd),updatedAt:Number(row.updated_at) };
}

function mapPaperCompetition(row:Record<string,unknown>):PaperCompetition{
  return {id:Number(row.id),chatId:String(row.chat_id),name:String(row.name),startingBalanceUsd:Number(row.starting_balance_usd),startsAt:Number(row.starts_at),endsAt:Number(row.ends_at),status:String(row.status) as PaperCompetition["status"],createdBy:String(row.created_by),createdAt:Number(row.created_at)};
}

function mapPaperCompetitionAccount(row:Record<string,unknown>):PaperCompetitionAccount{
  return {competitionId:Number(row.competition_id),userId:String(row.user_id),username:String(row.username),cashBalanceUsd:Number(row.cash_balance_usd),startingBalanceUsd:Number(row.starting_balance_usd),realizedPnlUsd:Number(row.realized_pnl_usd),wins:Number(row.wins),losses:Number(row.losses),finalEquityUsd:row.final_equity_usd==null?null:Number(row.final_equity_usd),finalPnlUsd:row.final_pnl_usd==null?null:Number(row.final_pnl_usd),finalRank:row.final_rank==null?null:Number(row.final_rank),joinedAt:Number(row.joined_at),updatedAt:Number(row.updated_at)};
}

function mapPaperCompetitionPosition(row:Record<string,unknown>):PaperCompetitionPosition{
  return {competitionId:Number(row.competition_id),userId:String(row.user_id),tokenAddress:getAddress(String(row.token_address)),symbol:String(row.symbol),tokenAmount:Number(row.token_amount),costBasisUsd:Number(row.cost_basis_usd),averageEntryPriceUsd:Number(row.average_entry_price_usd),updatedAt:Number(row.updated_at)};
}

function mapPaperCompetitionTrade(row:Record<string,unknown>):PaperCompetitionTrade{
  return {id:Number(row.id),competitionId:Number(row.competition_id),userId:String(row.user_id),tokenAddress:getAddress(String(row.token_address)),symbol:String(row.symbol),side:String(row.side) as PaperCompetitionTrade["side"],tokenAmount:Number(row.token_amount),grossValueUsd:Number(row.gross_value_usd),gasCostUsd:Number(row.gas_cost_usd),executionPriceUsd:Number(row.execution_price_usd),realizedPnlUsd:row.realized_pnl_usd==null?null:Number(row.realized_pnl_usd),marketCapUsd:row.market_cap_usd==null?null:Number(row.market_cap_usd),quoteSource:"UNISWAP_V4",createdAt:Number(row.created_at)};
}

function mapCall(row: CallRow): CallRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    userId: row.user_id,
    username: row.username,
    tokenAddress: getAddress(row.token_address),
    symbol: row.symbol,
    entryPriceUsd: row.entry_price_usd,
    entryMarketCapUsd: row.entry_market_cap_usd,
    entryLiquidityUsd: row.entry_liquidity_usd,
    athPriceUsd: row.ath_price_usd,
    athMarketCapUsd: row.ath_market_cap_usd,
    lastPriceUsd: row.last_price_usd,
    lastMarketCapUsd: row.last_market_cap_usd,
    lastLiquidityUsd: row.last_liquidity_usd,
    lastDexPaid: row.last_dex_paid == null ? null : Boolean(row.last_dex_paid),
    scanCount: row.scan_count,
    lastAthAlertMarketCapUsd: row.last_ath_alert_market_cap_usd,
    lastCheckedAt: row.last_checked_at,
    proofHash: row.proof_hash ?? proofForRow(row),
    calledAt: row.called_at,
    updatedAt: row.updated_at,
  };
}

function currentMultiple(call: CallRecord): number {
  if (!call.entryMarketCapUsd || !call.lastMarketCapUsd) return 0;
  return call.lastMarketCapUsd / call.entryMarketCapUsd;
}

function realAlphaMultiple(call: CallRecord, notionalUsd = 1_000): number {
  if (!call.entryMarketCapUsd || !call.lastMarketCapUsd || !call.entryLiquidityUsd || !call.lastLiquidityUsd) return 0;
  const feeAdjusted = notionalUsd * 0.997;
  const entryReserve = call.entryLiquidityUsd / 2;
  const acquiredValue = entryReserve * feeAdjusted / (entryReserve + feeAdjusted);
  const currentValue = acquiredValue * (call.lastMarketCapUsd / call.entryMarketCapUsd);
  const exitReserve = call.lastLiquidityUsd / 2;
  const exitInput = currentValue * 0.997;
  return exitReserve * exitInput / (exitReserve + exitInput) / notionalUsd;
}

function proofForRow(row: CallRow): string {
  return proofForValues({
    chatId: row.chat_id,
    messageId: row.message_id,
    userId: row.user_id,
    tokenAddress: row.token_address.toLowerCase(),
    calledAt: row.called_at,
    entryPriceUsd: row.entry_price_usd,
    entryMarketCapUsd: row.entry_market_cap_usd,
    entryLiquidityUsd: row.entry_liquidity_usd,
  });
}

function proofForValues(value: {
  chatId: string;
  messageId: number;
  userId: string;
  tokenAddress: string;
  calledAt: number;
  entryPriceUsd: number | null;
  entryMarketCapUsd: number | null;
  entryLiquidityUsd: number | null;
}): string {
  const canonical = [
    "kapiscout-call-v1", value.chatId, value.messageId, value.userId, value.tokenAddress,
    value.calledAt, value.entryPriceUsd ?? "null", value.entryMarketCapUsd ?? "null", value.entryLiquidityUsd ?? "null",
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

function isChartTimeframe(value: unknown): value is ChartTimeframe {
  return typeof value === "string" && new Set(["auto", "1m", "5m", "15m", "1h", "4h", "1d"]).has(value);
}

function mapWallet(row: WalletRow): TrackedWallet {
  return {
    id: row.id,
    scope: row.scope,
    chatId: row.chat_id,
    telegramUserId: row.telegram_user_id,
    address: getAddress(row.address),
    label: row.label,
    isKol: Boolean(row.is_kol),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
  };
}
