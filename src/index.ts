import { BlockscoutClient } from "./blockscout.js";
import { CallTracker } from "./call-tracker.js";
import { createRobinhoodClient } from "./chain.js";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { MarketClient } from "./market.js";
import { TokenScanner } from "./scanner.js";
import { createTelegramBot } from "./telegram.js";
import { WalletAlertService } from "./alerts.js";
import { RobinhoodRwaClient } from "./robinhood-rwa.js";
import { BridgeRadarService, DailyDigestService, HolderTrackerService } from "./features.js";
import { InputFile } from "grammy";
import { PaperCompetitionService } from "./paper.js";

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
const callTracker = new CallTracker(store, market, config.callRefreshIntervalMs, async (chatId, html, tokenAddress) => {
  await bot.api.sendMessage(chatId, html, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "↻ Refresh", callback_data: `r:${tokenAddress}:m:auto` },
        { text: "Explorer", url: `${config.blockscoutBrowserUrl}/token/${tokenAddress}` },
      ]],
    },
  });
});
const alerts = new WalletAlertService(client, store, scanner, config, async (chatId, html, transactionHash, walletAddress, image) => {
  const buttons = [{
    text: "↗ Transaction",
    url: `${config.blockscoutBrowserUrl}/tx/${transactionHash}`,
  }];
  const secondRow = walletAddress ? [{ text: "✏️ Name wallet", callback_data: `wn:${walletAddress}` }] : [];
  const options = { parse_mode: "HTML" as const, reply_markup: { inline_keyboard: [buttons, ...(secondRow.length ? [secondRow] : [])] } };
  if (image) await bot.api.sendPhoto(chatId, new InputFile(image, "kapiscout-wallet-alert.png"), { ...options, caption: html });
  else await bot.api.sendMessage(chatId, html, options);
});
const featureSender = async (chatId: string, html: string, transactionHash?: `0x${string}`) => {
  await bot.api.sendMessage(chatId, html, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: transactionHash ? { inline_keyboard: [[{ text: "↗ Transaction", url: `${config.blockscoutBrowserUrl}/tx/${transactionHash}` }]] } : undefined,
  });
};
const digests = new DailyDigestService(store, featureSender);
const bridgeRadar = new BridgeRadarService(client, store, market, config, featureSender);
const holderTracker = new HolderTrackerService(store, scanner);

callTracker.start();
alerts.start();
digests.start();
bridgeRadar.start();
holderTracker.start();
paper.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down Kapiscout.`);
  alerts.stop();
  callTracker.stop();
  digests.stop();
  bridgeRadar.stop();
  holderTracker.stop();
  paper.stop();
  await bot.stop();
  await store.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await bot.start({
  allowed_updates: ["message", "callback_query", "chat_member"],
  onStart: async (info) => {
    await bot.api.setMyCommands([
      { command: "menu", description: "Open the Kapiscout interface" },
      { command: "scan", description: "Quick token scan" },
      { command: "portfolio", description: "Open wallet portfolio" },
      { command: "settings", description: "Show group settings" },
      { command: "help", description: "How Kapiscout works" },
    ]);
    console.log(`Kapiscout is online as @${info.username} on Robinhood Chain ${config.chainId}.`);
  },
});
