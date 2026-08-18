import "dotenv/config";

/**
 * Registers the slash-command menu that Telegram shows when someone types "/".
 *
 * The polling entrypoint used to do this in bot.start()'s onStart hook, which
 * never runs under webhooks. Run this once after deploying, and again whenever
 * the command list changes:
 *
 *   npm run set-commands
 */

const commands = [
  { command: "menu", description: "Open the Kapiscout dashboard" },
  { command: "scan", description: "Scan a token contract" },
  { command: "chart", description: "Chart a token - CA 15m mc" },
  { command: "intel", description: "Reality Check on a token" },
  { command: "quote", description: "Live exit quote - CA amount" },
  { command: "holders", description: "Holder map for a token" },
  { command: "holderchanges", description: "Holder changes since last check" },
  { command: "timeline", description: "Token timeline" },
  { command: "devhistory", description: "Deployer reputation" },
  { command: "pnl", description: "PNL for a called token" },
  { command: "portfolio", description: "Wallet portfolio" },
  { command: "addwallet", description: "Track a wallet - address + name" },
  { command: "wallets", description: "List tracked wallets" },
  { command: "removewallet", description: "Stop tracking a wallet" },
  { command: "walletscore", description: "Smart Wallet Score" },
  { command: "alerts", description: "Custom signal rules" },
  { command: "settings", description: "Show group settings" },
  { command: "help", description: "How Kapiscout works" },
];

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

async function call(method: string, body: unknown): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(`${method} failed: ${json.description}`);
  return json;
}

// "default" covers private chats and groups that have no narrower scope set.
await call("setMyCommands", { commands, scope: { type: "default" } });
await call("setMyCommands", { commands, scope: { type: "all_group_chats" } });

console.log(`Registered ${commands.length} commands for default and group scopes.`);
