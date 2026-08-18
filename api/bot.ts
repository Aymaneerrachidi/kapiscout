import type { IncomingMessage, ServerResponse } from "node:http";
import { webhookCallback } from "grammy";
import { BlockscoutClient } from "../src/blockscout.js";
import { createRobinhoodClient } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import { MarketClient } from "../src/market.js";
import { RobinhoodRwaClient } from "../src/robinhood-rwa.js";
import { TokenScanner } from "../src/scanner.js";
import { PaperCompetitionService } from "../src/paper.js";
import { createTelegramBot } from "../src/telegram.js";

/**
 * Telegram webhook endpoint.
 *
 * Vercel's Node runtime calls this with (req, res) and waits for the response
 * to be ended, so this uses grammY's "https" adapter rather than a
 * fetch-style handler. The bot is built once per warm instance and reused.
 *
 * Long polling and the background schedulers cannot run here — a Vercel
 * function only lives for the length of one request.
 */

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

let handlerPromise: Promise<NodeHandler> | null = null;

async function build(): Promise<NodeHandler> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  // Schema is applied out of band by `npm run migrate`; replaying it here
  // would cost ~30 round trips to Turso on every cold start.
  await store.init({ migrate: false });
  for (const kol of config.kolWallets) await store.upsertKol(kol.label, kol.address);

  const client = createRobinhoodClient(config);
  const market = new MarketClient(config.dexScreenerChainId);
  const blockscout = new BlockscoutClient(config.blockscoutApiUrl);
  const rwa = new RobinhoodRwaClient(config.chainId);
  const scanner = new TokenScanner(client, blockscout, market, config, rwa);
  const paper = new PaperCompetitionService(store, scanner);
  const bot = await createTelegramBot(config, store, scanner, paper);

  // grammY needs the bot initialised before it can handle a raw update.
  await bot.init();
  return webhookCallback(bot, "https") as unknown as NodeHandler;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    send(res, 200, "Kapiscout webhook is up. POST Telegram updates here.");
    return;
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    send(res, 403, "Forbidden");
    return;
  }

  try {
    if (!handlerPromise) handlerPromise = build();
    const callback = await handlerPromise;
    await callback(req, res);
  } catch (error) {
    console.error("Webhook failed", error);
    // Rebuild on the next request rather than caching a broken bot.
    handlerPromise = null;
    // 200 stops Telegram retrying a poisoned update forever.
    if (!res.writableEnded) send(res, 200, "error");
  }
}
