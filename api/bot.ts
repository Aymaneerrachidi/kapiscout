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
 * Vercel functions are request-scoped, so the bot is built once per warm
 * instance and reused. Long polling and the background schedulers cannot run
 * here — see api/cron.ts for the periodic work.
 */

type FetchHandler = (request: Request) => Promise<Response>;

let handlerPromise: Promise<FetchHandler> | null = null;

async function build(): Promise<FetchHandler> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  await store.init();
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
  return webhookCallback(bot, "std/http") as unknown as FetchHandler;
}

function handler(): Promise<FetchHandler> {
  if (!handlerPromise) handlerPromise = build();
  return handlerPromise;
}

export default async function (request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Kapiscout webhook is up. POST Telegram updates here.", { status: 200 });
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const callback = await handler();
    return await callback(request);
  } catch (error) {
    console.error("Webhook failed", error);
    // 200 keeps Telegram from hammering a retry loop on a poisoned update.
    return new Response("error", { status: 200 });
  }
}
