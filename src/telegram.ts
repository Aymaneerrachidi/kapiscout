import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import type { Address } from "viem";
import type { AppConfig } from "./config.js";
import { ChartClient, generateChartCard, type ChartSeries } from "./chart.js";
import { generateDashboardCard, generateGroupSummaryCard, generatePaperLeaderboardCard, generatePaperPortfolioCard, generatePnlCard, generateTokenCard } from "./card.js";
import type { Store } from "./db.js";
import { buildRealityReport, estimateRealMultiple, summarizeLiquidityHistory } from "./intelligence.js";
import { buildDailyDigest } from "./features.js";
import type { TokenScanner } from "./scanner.js";
import type { PaperCompetitionService } from "./paper.js";
import type { CallRecord, ChartMetric, ChartTimeframe, ChatSettings, TokenScan } from "./types.js";
import {
  calculateMultiple,
  calculateReturn,
  commandArgument,
  compactAddress,
  escapeHtml,
  extractAddresses,
  formatAge,
  formatCompactNumber,
  formatPercent,
  formatTokenPrice,
  formatTokenSupply,
  formatUsd,
} from "./utils.js";

const timeframes: ChartTimeframe[] = ["auto", "5m", "15m", "1h", "4h", "1d"];
type UiPromptAction = "scan" | "chart" | "quote" | "holders" | "holderchanges" | "pnl" | "intel" | "devhistory" | "timeline" | "addwallet" | "walletscore" | "alertadd" | "paperbuy" | "papersell" | "paperbuyamt";

export async function createTelegramBot(config: AppConfig, store: Store, scanner: TokenScanner, paper:PaperCompetitionService): Promise<Bot> {
  const bot = new Bot(config.telegramToken);
  const charts = new ChartClient("robinhood");
  const refreshCooldowns = new Map<string, number>();
  const pendingWalletNames = new Map<string, { address: Address; promptMessageId: number; expiresAt: number }>();
  const pendingUiActions = new Map<string, { action: UiPromptAction; promptMessageId: number; expiresAt: number; address?: Address }>();

  bot.use(async (ctx, next) => {
    if (ctx.chat) await store.ensureChat(String(ctx.chat.id), "title" in ctx.chat ? ctx.chat.title ?? null : null);
    await next();
  });

  bot.command(["start", "menu"], async (ctx) => void await showDashboard(ctx));
  bot.command("help", async (ctx) => void await ctx.reply(helpText(), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Open KapiScout", "ui:home") }));

  bot.command("scan", async (ctx) => {
    const address = extractAddresses(commandArgument(ctx.message?.text))[0];
    if (!address) return void await replyPanel(ctx, "🔎", "Scan a token", ["Paste any Robinhood Chain contract address."], "No command is required next time.");
    await scanAndReply(ctx, address, store, scanner, charts, config);
  });

  bot.command(["c", "chart"], async (ctx) => {
    const argument = commandArgument(ctx.message?.text);
    const address = extractAddresses(argument)[0];
    if (!address) return void await replyPanel(ctx, "📊", "Chart command", ["<code>/chart CA [5m|15m|1h|4h|1d] [mc|price]</code>"], "Example · /chart 0x… 15m mc");
    const timeframe = parseTimeframe(argument) ?? "auto";
    const metric: ChartMetric = /(?:^|\s)price(?:\s|$)/iu.test(argument) ? "price" : "market_cap";
    await sendChartOnly(ctx, address, timeframe, metric, store, scanner, charts);
  });

  bot.command("pnl", async (ctx) => {
    const address = extractAddresses(commandArgument(ctx.message?.text))[0];
    if (!address || !ctx.chat) return void await replyPanel(ctx, "📈", "PNL command", ["<code>/pnl CA</code>"], "Shows headline and estimated executable PNL.");
    await sendPnl(ctx, address, store, scanner, config);
  });

  bot.command(["intel", "reality"], async (ctx) => {
    const address = extractAddresses(commandArgument(ctx.message?.text))[0];
    if (!address || !ctx.chat) return void await replyPanel(ctx, "🧪", "Reality Check", ["<code>/intel CA</code>"], "Exit impact · liquidity history · launch forensics");
    await sendReality(ctx, address, store, scanner, config);
  });

  bot.command("calls", async (ctx) => {
    if (!ctx.chat) return;
    const calls = await store.listCalls(String(ctx.chat.id), 10);
    if (!calls.length) return void await replyPanel(ctx, "🌱", "No calls yet", ["The first pasted contract will start this group’s history."], "Paste a Robinhood Chain CA to begin.");
    await ctx.reply(`<b>🕘 Recent Calls</b>\n└ Latest 10 recorded plays\n\n${calls.map((call, index) => callLine(call, index)).join("\n")}`, { parse_mode: "HTML" });
  });

  bot.command(["active", "plays"], async (ctx) => {
    if (!ctx.chat) return;
    const calls = await store.activeCalls(String(ctx.chat.id), 10);
    if (!calls.length) return void await replyPanel(ctx, "📭", "No active plays", ["No recorded call currently has usable pricing."], "Refresh a scan after its pool is indexed.");
    await ctx.reply(`<b>⚡ Active Plays</b>\n└ Ranked by current return\n\n${calls.map((call, index) => callLine(call, index, false)).join("\n")}`, { parse_mode: "HTML" });
  });

  bot.command(["lb", "leaderboard"], async (ctx) => {
    if (!ctx.chat) return;
    const calls = await store.leaderboard(String(ctx.chat.id), 10);
    if (!calls.length) return void await replyPanel(ctx, "🏆", "Leaderboard is warming up", ["At least one priced call is required."], "Paste a CA to record the first entry.");
    await ctx.reply(`<b>🏆 ATH Leaderboard</b>\n└ Entry → highest tracked market cap\n\n${calls.map((call, index) => callLine(call, index, true)).join("\n")}`, { parse_mode: "HTML" });
  });

  bot.command(["reallb", "realalpha"], async (ctx) => {
    if (!ctx.chat) return;
    const calls = await store.realAlphaLeaderboard(String(ctx.chat.id), 10);
    if (!calls.length) return void await replyPanel(ctx, "💸", "Real Alpha is warming up", ["Calls need both entry and current liquidity."], "The leaderboard uses an estimated $1K executable return.");
    await ctx.reply([
      "<b>💸 Real Alpha leaderboard</b>",
      "<i>Estimated $1K round-trip return after pool impact</i>",
      "",
      ...calls.map((call, index) => realCallLine(call, index)),
    ].join("\n"), { parse_mode: "HTML" });
  });

  bot.command("callers", async (ctx) => {
    if (!ctx.chat) return;
    const stats = await store.callerStats(String(ctx.chat.id));
    if (!stats.length) return void await replyPanel(ctx, "👤", "No caller stats yet", ["Caller performance appears after the first priced call."]);
    const lines = stats.slice(0, 10).map((item, index) =>
      `${medal(index)} <b>${escapeHtml(item.username)}</b> · ${item.totalCalls} calls · ${item.winRate.toFixed(0)}% wins · ${item.hits2x}/${item.hits5x}/${item.hits10x} hits · ${item.bestMultiple?.toFixed(2) ?? "—"}x best`,
    );
    await ctx.reply(`<b>🎯 Caller Leaderboard</b>\n└ Hits shown as <code>2x / 5x / 10x</code>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
  });

  bot.command("stats", async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    const query = commandArgument(ctx.message?.text).toLowerCase();
    const stats = await store.callerStats(String(ctx.chat.id));
    const item = query
      ? stats.find((candidate) => candidate.username.toLowerCase().replace(/^@/, "") === query.replace(/^@/, ""))
      : stats.find((candidate) => candidate.userId === String(ctx.from!.id));
    if (!item) return void await replyPanel(ctx, "🔎", "Caller not found", ["No recorded calls match that username."], "Try /stats without a username for your own profile.");
    await ctx.reply([
      `<b>🎯 ${escapeHtml(item.username)} · Caller Stats</b>`, "",
      `├ Calls    <b>${item.totalCalls}</b>`,
      `├ Win rate <b>${item.winRate.toFixed(1)}%</b>`,
      `├ Median   <b>${item.medianReturn == null ? "N/A" : formatPercent(item.medianReturn, true)}</b>`,
      `├ Best     <b>${item.bestMultiple?.toFixed(2) ?? "N/A"}x</b>`,
      `└ Hits     <b>${item.hits2x}</b> 2x · <b>${item.hits5x}</b> 5x · <b>${item.hits10x}</b> 10x`,
    ].join("\n"), { parse_mode: "HTML" });
  });

  bot.command(["summary", "groupcard"], async (ctx) => {
    if (!ctx.chat) return;
    const chatId = String(ctx.chat.id);
    const calls = await store.listCalls(chatId, 10_000);
    const title = "title" in ctx.chat ? ctx.chat.title ?? "KapiScout group" : "KapiScout calls";
    const image = await generateGroupSummaryCard(title, await store.callerStats(chatId), calls);
    await ctx.replyWithPhoto(new InputFile(image, "kapiscout-group-report.png"), { caption: `<b>${escapeHtml(title)} · performance report</b>`, parse_mode: "HTML" });
  });

  bot.command(["th", "holders"], async (ctx) => {
    const address = extractAddresses(commandArgument(ctx.message?.text))[0];
    if (!address) return void await replyPanel(ctx, "💎", "Holder command", ["<code>/holders CA</code>"], "Shows concentration and the largest indexed wallets.");
    await sendHolders(ctx, address, store, scanner);
  });

  bot.command("portfolio", async (ctx) => {
    if (!ctx.chat) return;
    const wallet = extractAddresses(commandArgument(ctx.message?.text))[0];
    const positions = await store.walletPortfolio(String(ctx.chat.id), wallet);
    if (!positions.length) return void await replyPanel(ctx, "📭", "Portfolio is empty", ["KapiScout builds this portfolio from wallet movements it observes after tracking starts."], "Add a wallet with /addwallet, then let the live monitor collect trades.");
    const priced = await Promise.all(positions.slice(0, 10).map(async (position) => {
      const scan = await scanner.scan(position.tokenAddress).catch(() => null);
      const price = scan?.market.priceUsd ?? position.lastPriceUsd;
      return { ...position, price, value: price == null ? null : position.tokenAmount * price, pnl: price == null ? null : position.tokenAmount * price - position.costBasisUsd };
    }));
    const value = priced.reduce((sum,item)=>sum+(item.value??0),0);
    const pnl = priced.reduce((sum,item)=>sum+(item.pnl??0)+item.realizedUsd,0);
    await ctx.reply(["<b>💼 OBSERVED WALLET PORTFOLIO</b>",`└ ${wallet ? `<code>${compactAddress(wallet)}</code>` : "All tracked wallets"}`,"",`Value  <b>${formatUsd(value)}</b> · PNL <b>${formatSignedUsd(pnl)}</b>`,"",...priced.map((item,index)=>`${index===priced.length-1?"└":"├"} <b>$${escapeHtml(item.symbol)}</b> · ${formatUsd(item.value)} · ${formatSignedUsd((item.pnl??0)+item.realizedUsd)}`),"","<i>Reconstructed from observed buys/sells; transfers and pre-tracking balances are excluded.</i>"].join("\n"),{parse_mode:"HTML"});
  });

  bot.command(["walletscore","wscore"], async (ctx) => {
    if (!ctx.chat) return;
    const wallet=extractAddresses(commandArgument(ctx.message?.text))[0];
    if(!wallet) return void await replyPanel(ctx,"🧠","Smart Wallet Score",["<code>/walletscore 0xWallet</code>"],"Scores only activity observed by KapiScout.");
    const score=await store.smartWalletScore(String(ctx.chat.id),wallet);
    if(!score) return void await replyPanel(ctx,"📭","Not enough wallet history",["No observed buys or sells exist for this wallet yet."]);
    await ctx.reply([`<b>🧠 ${escapeHtml(score.label)} · SMART SCORE</b>`,`└ <code>${compactAddress(wallet)}</code>`,"",`Score  <b>${score.score}/100 · ${score.grade}</b>`,`├ Trades   ${score.trades}`,`├ Win rate ${score.winRate==null?"Collecting":`${score.winRate.toFixed(0)}%`}`,`├ Volume   ${formatUsd(score.volumeUsd)}`,`└ Realized ${formatSignedUsd(score.realizedPnlUsd)}`,"","<i>Evidence score from observed trade history, not a guarantee of skill.</i>"].join("\n"),{parse_mode:"HTML"});
  });

  bot.command(["alert","alerts"], async (ctx) => {
    if(!ctx.chat) return;
    const chatId=String(ctx.chat.id); const argument=commandArgument(ctx.message?.text).trim();
    if(!argument || argument.toLowerCase()==="list" || ctx.message?.text?.startsWith("/alerts")) return void await sendAlertRules(ctx,await store.listAlertRules(chatId));
    if(!(await canManageChat(ctx))) return void await replyPanel(ctx,"🔒","Admin setting",["Only group admins can change custom alerts."]);
    const remove=argument.match(/^remove\s+(\d+)$/iu);
    if(remove){const removed=await store.removeAlertRule(chatId,Number(remove[1])); return void await replyPanel(ctx,removed?"✅":"🔎",removed?"Alert removed":"Alert not found",[`Rule #${remove[1]}`]);}
    if(!/^add\s+/iu.test(argument)) return void await replyPanel(ctx,"⚡","Custom Alert Builder",["<code>/alert add Name direction=buy minvalue=5k maxmc=100k minlp=10k wallets=2 window=5</code>"],"All filters are optional; use /alerts to list rules.");
    const values=parseRuleValues(argument); const name=argument.replace(/^add\s+/iu,"").split(/\s+[a-z]+=|$/iu)[0]?.trim().slice(0,32)||"Signal";
    const rule=await store.addAlertRule({chatId,name,direction:values.direction,minValueUsd:values.minvalue,minMarketCapUsd:values.minmc,maxMarketCapUsd:values.maxmc||null,minLiquidityUsd:values.minlp,minWallets:Math.max(1,Math.floor(values.wallets)),windowMinutes:Math.max(1,Math.floor(values.window))});
    await replyPanel(ctx,"✅","Custom signal armed",[`<b>#${rule.id} · ${escapeHtml(rule.name)}</b>`,`└ ${rule.direction} · ≥${formatUsd(rule.minValueUsd)} · ${rule.minWallets} wallet${rule.minWallets===1?"":"s"} / ${rule.windowMinutes}m`],"It will fire once per token per time window.");
  });

  bot.command(["devhistory","deployer"], async (ctx)=>{
    const address=extractAddresses(commandArgument(ctx.message?.text))[0]; if(!address) return void await replyPanel(ctx,"🧬","Deployer Reputation",["<code>/devhistory CA</code>"]);
    await sendDeployerHistory(ctx,address,scanner);
  });

  bot.command(["quote","exitquote"],async(ctx)=>{
    const argument=commandArgument(ctx.message?.text); const address=extractAddresses(argument)[0];
    if(!address) return void await replyPanel(ctx,"💱","Live Exit Quote",["<code>/quote CA 1k</code>"],"Uses the official Uniswap v4 Quoter when the pool key can be resolved.");
    const value=parseCompactUsd(argument.replace(/0x[a-fA-F0-9]{40}/u,"").trim())??1_000; await sendQuote(ctx,address,value,scanner);
  });

  bot.command(["holderchanges","holderdelta"],async(ctx)=>{
    if(!ctx.chat)return; const address=extractAddresses(commandArgument(ctx.message?.text))[0]; if(!address)return void await replyPanel(ctx,"💎","Holder Changes",["<code>/holderchanges CA</code>"]);
    await sendHolderChanges(ctx,address,store,scanner);
  });

  bot.command("timeline",async(ctx)=>{
    if(!ctx.chat)return; const address=extractAddresses(commandArgument(ctx.message?.text))[0]; if(!address)return void await replyPanel(ctx,"🕘","Token Timeline",["<code>/timeline CA</code>"]);
    await sendTimeline(ctx,address,store);
  });

  bot.command("digest",async(ctx)=>{
    if(!ctx.chat)return; const chatId=String(ctx.chat.id); const arg=commandArgument(ctx.message?.text).toLowerCase().trim();
    if(!arg||arg==="now")return void await ctx.reply(await buildDailyDigest(store,chatId),{parse_mode:"HTML"});
    if(!(await canManageChat(ctx)))return void await replyPanel(ctx,"🔒","Admin setting",["Only group admins can schedule the digest."]);
    const hour=Number(arg.match(/(?:hour\s+)?(\d{1,2})/u)?.[1]);
    if(arg==="off")await store.configureDigest(chatId,false); else if(arg==="on")await store.configureDigest(chatId,true); else if(Number.isInteger(hour)&&hour>=0&&hour<=23)await store.configureDigest(chatId,true,hour); else return void await replyPanel(ctx,"☀️","Daily Digest",["<code>/digest now|on|off|hour 9</code>"],"Hour uses the bot server timezone.");
    const s=await store.getChatSettings(chatId); await replyPanel(ctx,s.digestEnabled?"🟢":"⚪","Digest updated",[`└ ${s.digestEnabled?`Daily at ${String(s.digestHour).padStart(2,"0")}:00`:`Disabled`}`]);
  });

  bot.command("paperbuy",async(ctx)=>{
    if(!ctx.chat||!ctx.from)return; const argument=commandArgument(ctx.message?.text); const address=extractAddresses(argument)[0]; const usd=parseCompactUsd(argument.replace(/0x[a-fA-F0-9]{40}/u,"").trim());
    if(!address||!usd||usd<=0)return void await replyPanel(ctx,"🧾","Paper Buy",["<code>/paperbuy CA 100</code>"]);
    await paperBuy(ctx,address,usd,paper,store);
  });

  bot.command("papersell",async(ctx)=>{
    if(!ctx.chat||!ctx.from)return; const argument=commandArgument(ctx.message?.text); const address=extractAddresses(argument)[0]; if(!address)return void await replyPanel(ctx,"🧾","Paper Sell",["<code>/papersell CA 50%</code> or <code>/papersell CA all</code>"]);
    const rest=argument.replace(/0x[a-fA-F0-9]{40}/u,"").trim().toLowerCase(); const fraction=rest==="all"?1:Number.parseFloat(rest)/100; if(!Number.isFinite(fraction)||fraction<=0)return void await replyPanel(ctx,"⚠️","Invalid paper size",["Choose 1%–100% or all."]);
    await paperSell(ctx,address,fraction,paper,store);
  });

  bot.command(["paper","competition"],async(ctx)=>{if(ctx.chat&&ctx.from)await showPaperMenu(ctx,paper);});
  bot.command("paperlb",async(ctx)=>{if(ctx.chat)await sendPaperLeaderboard(ctx,paper);});

  bot.command("bridgealerts",async(ctx)=>{
    if(!ctx.chat||!(await canManageChat(ctx)))return; const arg=commandArgument(ctx.message?.text).toLowerCase(); if(!["on","off"].includes(arg))return void await replyPanel(ctx,"🌉","Bridge Radar",["<code>/bridgealerts on|off</code>"]);
    await store.configureBridge(String(ctx.chat.id),arg==="on"); await replyPanel(ctx,arg==="on"?"🟢":"⚪","Bridge Radar updated",[`└ <b>${arg.toUpperCase()}</b>`]);
  });

  bot.command("bridgemin",async(ctx)=>{
    if(!ctx.chat||!(await canManageChat(ctx)))return; const value=parseCompactUsd(commandArgument(ctx.message?.text)); if(value==null)return void await replyPanel(ctx,"🌉","Bridge minimum",["<code>/bridgemin 25k</code>"]);
    const current=await store.getChatSettings(String(ctx.chat.id)); await store.configureBridge(String(ctx.chat.id),current.bridgeAlerts,value); await replyPanel(ctx,"✅","Bridge minimum updated",[`└ <b>${formatUsd(value)}</b>`]);
  });

  bot.command("bridgeflow",async(ctx)=>{
    const flows=await store.recentBridgeFlows(Date.now()-24*60*60_000,10); if(!flows.length)return void await replyPanel(ctx,"🌉","No recent bridge flow",["No chain-native ETH bridge transaction has been observed in the last 24h."]);
    await ctx.reply(["<b>🌉 ROBINHOOD BRIDGE TAPE · 24H</b>","",...flows.map((flow,index)=>`${index===flows.length-1?"└":"├"} ${flow.direction==="IN"?"🟢 IN":"🟠 OUT"} · <b>${formatUsd(flow.valueUsd)}</b> · ${flow.amount.toFixed(3)} ETH · <code>${compactAddress(flow.wallet)}</code>`)].join("\n"),{parse_mode:"HTML"});
  });

  bot.command("addwallet", async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    const argument = commandArgument(ctx.message?.text);
    const address = extractAddresses(argument)[0];
    if (!address) return void await replyPanel(ctx, "🔔", "Track a wallet", ["<code>/addwallet 0xAddress Name</code>"], "Example · /addwallet 0x… Smart Ape");
    if (await store.countCustomWallets(String(ctx.chat.id)) >= config.maxWalletsPerChat && !(await store.findWallets(address)).some((item) => item.chatId === String(ctx.chat!.id))) {
      return void await replyPanel(ctx, "⚠️", "Wallet limit reached", [`This chat can track <b>${config.maxWalletsPerChat}</b> custom wallets.`], "Remove one with /removewallet, then try again.");
    }
    const rawLabel = argument.replace(/0x[a-fA-F0-9]{40}/u, "").trim();
    const label = rawLabel.slice(0, 48) || compactAddress(address);
    await store.addWallet(String(ctx.chat.id), String(ctx.from.id), address, label);
    await replyPanel(ctx, "✅", "Wallet tracking enabled", [
      `├ Name     <b>${escapeHtml(label)}</b>`,
      `└ Address  <code>${address}</code>`,
    ], `Rename anytime · /namewallet ${address} New Name`);
  });

  bot.command(["namewallet", "renamewallet"], async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    const argument = commandArgument(ctx.message?.text);
    const address = extractAddresses(argument)[0];
    const rawLabel = address ? argument.replace(/0x[a-fA-F0-9]{40}/u, "").trim() : "";
    if (!address || !rawLabel) return void await replyPanel(ctx, "✏️", "Name a wallet", ["<code>/namewallet 0xAddress New Name</code>"], "Names can contain spaces and use up to 48 characters.");
    const tracked = (await store.findWallets(address)).find((item) => item.chatId === String(ctx.chat!.id));
    if (!tracked) return void await replyPanel(ctx, "🔎", "Wallet not found", ["That address is not a custom wallet in this chat."], "Add it first with /addwallet.");
    const isOwner = tracked.telegramUserId === String(ctx.from.id);
    if (!isOwner && !(await canManageChat(ctx))) return void await replyPanel(ctx, "🔒", "Rename not allowed", ["Only the person who added this wallet or a group admin can rename it."]);
    const label = rawLabel.slice(0, 48);
    await store.renameWallet(String(ctx.chat.id), address, label);
    await replyPanel(ctx, "✅", "Wallet renamed", [
      `├ Name     <b>${escapeHtml(label)}</b>`,
      `└ Address  <code>${address}</code>`,
    ], "Future alerts will use this name.");
  });

  bot.command("removewallet", async (ctx) => {
    if (!ctx.chat) return;
    const address = extractAddresses(commandArgument(ctx.message?.text))[0];
    if (!address) return void await replyPanel(ctx, "🗑", "Remove a wallet", ["<code>/removewallet 0xAddress</code>"]);
    const removed = await store.removeWallet(String(ctx.chat.id), address);
    await replyPanel(ctx, removed ? "✅" : "🔎", removed ? "Wallet removed" : "Wallet not found", [
      removed ? `<code>${address}</code>` : "That address is not tracked in this chat.",
    ]);
  });

  bot.command("wallets", async (ctx) => {
    if (!ctx.chat) return;
    const wallets = await store.listWallets(String(ctx.chat.id));
    if (!wallets.length) return void await replyPanel(ctx, "🔕", "No tracked wallets", ["Add one with <code>/addwallet 0xAddress Name</code>."]);
    await ctx.reply([
      "<b>🔔 Tracked Wallets</b>",
      `└ ${wallets.length} active monitor${wallets.length === 1 ? "" : "s"}`,
      "",
      ...wallets.map((item, index) => `${index === wallets.length - 1 ? "└" : "├"} ${item.isKol ? "👀" : "◆"} <b>${escapeHtml(item.label)}</b> · <code>${compactAddress(item.address)}</code>`),
      "",
      "<i>Rename · /namewallet 0xAddress New Name</i>",
    ].join("\n"), { parse_mode: "HTML" });
  });

  const toggles = [
    ["contract", "contract_enabled"], ["compact", "compact"], ["detailed", "detailed"],
    ["kolalerts", "kol_alerts"], ["showchart", "show_chart"], ["buttons", "buttons_enabled"],
    ["adminonly", "admin_only"], ["milestones", "milestone_alerts"], ["athalerts", "ath_alerts"],
    ["dexalerts", "dex_paid_alerts"], ["liqalerts", "liquidity_alerts"], ["devalerts", "dev_alerts"],
    ["whalealerts", "whale_alerts"],
  ] as const;
  for (const [command, field] of toggles) {
    bot.command(command, async (ctx) => {
      if (!ctx.chat || !(await canManageChat(ctx))) return void await replyPanel(ctx, "🔒", "Admin setting", ["Only group admins can change this option."]);
      const value = commandArgument(ctx.message?.text).toLowerCase();
      if (value !== "on" && value !== "off") return void await replyPanel(ctx, "⚙️", "Choose a state", [`<code>/${command} on|off</code>`]);
      await store.updateChatSetting(String(ctx.chat.id), field, value === "on");
      await replyPanel(ctx, value === "on" ? "🟢" : "⚪️", "Setting updated", [`├ Option  <b>${escapeHtml(command)}</b>`, `└ State   <b>${value.toUpperCase()}</b>`]);
    });
  }

  bot.command("minmc", async (ctx) => {
    if (!ctx.chat || !(await canManageChat(ctx))) return void await replyPanel(ctx, "🔒", "Admin setting", ["Only group admins can change this option."]);
    const value = parseCompactUsd(commandArgument(ctx.message?.text));
    if (value == null) return void await replyPanel(ctx, "⚙️", "Minimum market cap", ["<code>/minmc 25k</code> or <code>/minmc off</code>"]);
    await store.updateMinMarketCap(String(ctx.chat.id), value);
    await replyPanel(ctx, value ? "✅" : "⚪️", "Minimum market cap updated", [`└ <b>${value ? formatUsd(value) : "Disabled"}</b>`]);
  });

  bot.command("chartmode", async (ctx) => {
    if (!ctx.chat || !(await canManageChat(ctx))) return void await replyPanel(ctx, "🔒", "Admin setting", ["Only group admins can change this option."]);
    const argument = commandArgument(ctx.message?.text).toLowerCase();
    const settings = await store.getChatSettings(String(ctx.chat.id));
    const metric: ChartMetric | null = argument === "price" ? "price" : ["mc", "marketcap", "market_cap"].includes(argument) ? "market_cap" : null;
    if (!metric) return void await replyPanel(ctx, "📊", "Chart mode", ["<code>/chartmode mc|price</code>"]);
    await store.updateChartPreference(String(ctx.chat.id), metric, settings.chartTimeframe);
    await replyPanel(ctx, "✅", "Chart mode updated", [`└ <b>${metric === "market_cap" ? "Market cap" : "Price"}</b>`]);
  });

  bot.command("timeframe", async (ctx) => {
    if (!ctx.chat || !(await canManageChat(ctx))) return void await replyPanel(ctx, "🔒", "Admin setting", ["Only group admins can change this option."]);
    const timeframe = parseTimeframe(commandArgument(ctx.message?.text));
    if (!timeframe) return void await replyPanel(ctx, "⏱", "Chart timeframe", ["<code>/timeframe auto|5m|15m|1h|4h|1d</code>"]);
    const settings = await store.getChatSettings(String(ctx.chat.id));
    await store.updateChartPreference(String(ctx.chat.id), settings.chartMetric, timeframe);
    await replyPanel(ctx, "✅", "Timeframe updated", [`└ <b>${timeframe.toUpperCase()}</b>`]);
  });

  bot.command("settings", async (ctx) => {
    if (!ctx.chat) return;
    await ctx.reply(settingsText(await store.getChatSettings(String(ctx.chat.id))), { parse_mode: "HTML" });
  });

  bot.on("callback_query:data", async (ctx) => {
    const callbackData = ctx.callbackQuery.data;
    if (callbackData.startsWith("ui:")) {
      await ctx.answerCallbackQuery();
      await handleUiCallback(ctx, callbackData.slice(3), store, scanner, charts, config, paper, pendingUiActions, refreshCooldowns);
      return;
    }
    const [action, rawAddress, rawMetric, rawTimeframe] = callbackData.split(":");
    const address = extractAddresses(rawAddress ?? "")[0];
    if (!address) return void await ctx.answerCallbackQuery({ text: "Invalid token." });
    if (action === "wn") {
      if (!ctx.chat || !ctx.from) return void await ctx.answerCallbackQuery({ text: "Open this alert inside its chat." });
      const tracked = (await store.findWallets(address)).find((item) => item.chatId === String(ctx.chat!.id));
      if (!tracked) return void await ctx.answerCallbackQuery({ text: "This is not a custom wallet in this chat.", show_alert: true });
      const isOwner = tracked.telegramUserId === String(ctx.from.id);
      if (!isOwner && !(await canManageChat(ctx))) return void await ctx.answerCallbackQuery({ text: "Only its owner or an admin can rename it.", show_alert: true });
      await ctx.answerCallbackQuery({ text: "Reply with the new wallet name" });
      const prompt = await ctx.reply([
        "<b>✏️ Name this wallet</b>", "",
        `Current · <b>${escapeHtml(tracked.label)}</b>`,
        `Wallet · <code>${compactAddress(address)}</code>`, "",
        "<i>Reply to this message with the new name.</i>",
      ].join("\n"), {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, input_field_placeholder: "Smart Money" },
      });
      pendingWalletNames.set(`${ctx.chat.id}:${ctx.from.id}`, { address, promptMessageId: prompt.message_id, expiresAt: Date.now() + 5 * 60_000 });
      return;
    }
    const metric: ChartMetric = rawMetric === "p" ? "price" : "market_cap";
    const timeframe = isTimeframe(rawTimeframe) ? rawTimeframe : "auto";
    if (action === "r" || action === "m" || action === "t") {
      const messageId = ctx.callbackQuery.message?.message_id ?? 0;
      const cooldownKey = `${ctx.chat?.id ?? 0}:${messageId}`;
      const waitSeconds = claimRefresh(refreshCooldowns, cooldownKey);
      if (waitSeconds > 0) {
        return void await ctx.answerCallbackQuery({ text: `Refresh available in ${waitSeconds}s`, show_alert: false });
      }
      const nextMetric = action === "m" ? (metric === "price" ? "market_cap" : "price") : metric;
      const nextTimeframe = action === "t" ? cycleTimeframe(timeframe) : timeframe;
      await ctx.answerCallbackQuery({ text: "Refreshing…" });
      await refreshMessage(ctx, address, nextMetric, nextTimeframe, store, scanner, charts, config);
      return;
    }
    if (action === "p") {
      await ctx.answerCallbackQuery();
      await sendPnl(ctx, address, store, scanner, config);
      return;
    }
    if (action === "h") {
      await ctx.answerCallbackQuery();
      await sendHolders(ctx, address, store, scanner);
      return;
    }
    if (action === "i") {
      await ctx.answerCallbackQuery({ text: "Building Reality Check…" });
      await sendReality(ctx, address, store, scanner, config);
      return;
    }
    if (action === "q") {
      await ctx.answerCallbackQuery({ text: "Fetching live quote…" });
      await sendQuote(ctx, address, 1_000, scanner);
      return;
    }
    if (action === "tl") {
      await ctx.answerCallbackQuery();
      await sendTimeline(ctx, address, store);
      return;
    }
    if (action === "pb") {
      await ctx.answerCallbackQuery({ text: "Pick a paper buy amount…" });
      await showPaperBuyChooser(ctx, address, paper);
      return;
    }
    if (action === "pbx") {
      const amount = Number.parseFloat(rawMetric ?? "");
      if (!Number.isFinite(amount) || amount <= 0) return void await ctx.answerCallbackQuery({ text: "Invalid amount.", show_alert: true });
      await ctx.answerCallbackQuery({ text: `Paper buying $${amount}…` });
      await paperBuy(ctx, address, amount, paper, store);
      return;
    }
    if (action === "pbc") {
      if (!ctx.chat || !ctx.from) return void await ctx.answerCallbackQuery({ text: "Open this inside the chat." });
      await ctx.answerCallbackQuery({ text: "Reply with the amount" });
      const prompt = await ctx.reply([
        "<b>✏️ PAPER BUY AMOUNT</b>", "",
        `Token · <code>${compactAddress(address)}</code>`, "",
        "<i>Reply to this message with the amount in USD.</i>",
      ].join("\n"), {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, input_field_placeholder: "25" },
      });
      pendingUiActions.set(`${ctx.chat.id}:${ctx.from.id}`, { action: "paperbuyamt", promptMessageId: prompt.message_id, expiresAt: Date.now() + 10 * 60_000, address });
      return;
    }
    if (action === "c") {
      await ctx.answerCallbackQuery();
      await sendChartOnly(ctx, address, timeframe, metric, store, scanner, charts);
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const uiPendingKey = ctx.chat && ctx.from ? `${ctx.chat.id}:${ctx.from.id}` : null;
    const uiPending = uiPendingKey ? pendingUiActions.get(uiPendingKey) : null;
    if (uiPending && uiPending.expiresAt > Date.now() && ctx.message.reply_to_message?.message_id === uiPending.promptMessageId) {
      pendingUiActions.delete(uiPendingKey!);
      if (uiPending.action === "paperbuyamt" && uiPending.address) {
        const usd = parseCompactUsd(text.trim());
        if (!usd || usd <= 0) return void await replyPanel(ctx, "⚠️", "Amount missing", ["Reply with a number like <code>25</code>."]);
        return void await paperBuy(ctx, uiPending.address, usd, paper, store);
      }
      await runUiPromptAction(ctx, uiPending.action, text, store, scanner, charts, config, paper);
      return;
    }
    if (uiPending && uiPending.expiresAt <= Date.now() && uiPendingKey) pendingUiActions.delete(uiPendingKey);
    const pendingKey = ctx.chat && ctx.from ? `${ctx.chat.id}:${ctx.from.id}` : null;
    const pending = pendingKey ? pendingWalletNames.get(pendingKey) : null;
    if (pending && pending.expiresAt > Date.now() && ctx.message.reply_to_message?.message_id === pending.promptMessageId) {
      pendingWalletNames.delete(pendingKey!);
      const label = text.replace(/\s+/gu, " ").trim().slice(0, 48);
      if (!label || label.startsWith("/")) return void await replyPanel(ctx, "⚠️", "Name not changed", ["Send a plain name between 1 and 48 characters."]);
      await store.renameWallet(String(ctx.chat!.id), pending.address, label);
      await replyPanel(ctx, "✅", "Wallet renamed", [
        `├ Name     <b>${escapeHtml(label)}</b>`,
        `└ Address  <code>${pending.address}</code>`,
      ], "Future alerts will use this name.");
      return;
    }
    if (pending && pending.expiresAt <= Date.now() && pendingKey) pendingWalletNames.delete(pendingKey);
    if (text.startsWith(".")) return;
    const address = extractAddresses(text)[0];
    if (!address) return;
    await scanAndReply(ctx, address, store, scanner, charts, config, text.endsWith("."), text.endsWith(","));
  });

  bot.catch((error) => console.error(`Telegram update ${error.ctx.update.update_id} failed`, error.error));
  return bot;
}

async function showDashboard(ctx: Context): Promise<void> {
  const image = await generateDashboardCard();
  await ctx.replyWithPhoto(new InputFile(image,"kapiscout-dashboard.png"),{
    caption:["<b>🐹 KAPISCOUT</b>","<i>Your Robinhood Chain edge—without command hunting.</i>","","Choose what you want to do:"].join("\n"),
    parse_mode:"HTML", reply_markup: mainMenuKeyboard(),
  });
}

function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔎 Scan & Research","ui:research").row()
    .text("🎯 Calls","ui:calls_menu").text("👀 Wallets","ui:wallets_menu").row()
    .text("🧾 Paper Trading","ui:paper_menu").text("⚡ Signals","ui:signals_menu").row()
    .text("🌉 Bridge Radar","ui:bridge_menu").text("☀️ Daily Edge","ui:digest_menu").row()
    .text("⚙️ Settings","ui:settings").text("❔ Guide","ui:guide");
}

async function handleUiCallback(ctx:Context, action:string, store:Store, scanner:TokenScanner, charts:ChartClient, config:AppConfig, paper:PaperCompetitionService, pending:Map<string,{action:UiPromptAction;promptMessageId:number;expiresAt:number}>,refreshCooldowns:Map<string,number>):Promise<void>{
  if(action==="home")return void await showDashboard(ctx);
  if(action.startsWith("ask:"))return void await requestUiInput(ctx,action.slice(4) as UiPromptAction,pending);
  if(action.startsWith("toggle:")){
    if(!ctx.chat||!(await canManageChat(ctx)))return void await replyPanel(ctx,"🔒","Admin setting",["Only group admins can change this option."]);
    const chatId=String(ctx.chat.id);const key=action.slice(7);const settings=await store.getChatSettings(chatId);
    const settingMap={show_chart:["show_chart",settings.showChart],kol_alerts:["kol_alerts",settings.kolAlerts],milestone_alerts:["milestone_alerts",settings.milestoneAlerts],dev_alerts:["dev_alerts",settings.devAlerts],whale_alerts:["whale_alerts",settings.whaleAlerts]} as const;
    if(key==="digest")await store.configureDigest(chatId,!settings.digestEnabled);
    else if(key==="bridge")await store.configureBridge(chatId,!settings.bridgeAlerts);
    else {const entry=settingMap[key as keyof typeof settingMap];if(entry)await store.updateChatSetting(chatId,entry[0],!entry[1]);}
    return void await showUiPanel(ctx,settingsPanel(await store.getChatSettings(chatId)),settingsKeyboard(await store.getChatSettings(chatId)));
  }
  if(!ctx.chat)return;
  const chatId=String(ctx.chat.id);
  if(action==="paper_menu")return void await showPaperMenu(ctx,paper);
  if(action==="paper"&&ctx.from)return void await sendPaperPortfolio(ctx,paper);
  if(action.startsWith("paper_refresh:")&&ctx.from){
    const ownerId=action.slice("paper_refresh:".length);
    if(ownerId!==String(ctx.from.id))return;
    const messageId=ctx.callbackQuery?.message?.message_id??0;
    const waitSeconds=claimRefresh(refreshCooldowns,`${chatId}:${messageId}:paper`);
    if(waitSeconds>0)return void await ctx.answerCallbackQuery({text:`Refresh available in ${waitSeconds}s`}).catch(()=>undefined);
    return void await sendPaperPortfolio(ctx,paper,true);
  }
  if(action==="paper_lb"){
    const messageId=ctx.callbackQuery?.message?.message_id??0;
    if(messageId&&claimRefresh(refreshCooldowns,`${chatId}:${messageId}:paper-lb`)>0)return;
    return void await sendPaperLeaderboard(ctx,paper,Boolean(ctx.callbackQuery?.message));
  }
  if(action==="paper_history"&&ctx.from)return void await sendPaperHistory(ctx,paper);
  if(action==="research")return void await showUiPanel(ctx,"<b>🔎 SCAN & RESEARCH</b>\n└ Pick a tool—KapiScout will ask for the contract.",new InlineKeyboard().text("🔎 Full Scan","ui:ask:scan").text("▣ Chart","ui:ask:chart").row().text("💱 Exit Quote","ui:ask:quote").text("🧪 Reality Check","ui:ask:intel").row().text("💎 Holders","ui:ask:holders").text("Δ Holder Change","ui:ask:holderchanges").row().text("🧬 Deployer","ui:ask:devhistory").text("🕘 Timeline","ui:ask:timeline").row().text("‹ Home","ui:home"));
  if(action==="wallets_menu")return void await showUiPanel(ctx,"<b>👀 WALLET INTELLIGENCE</b>\n└ Follow wallets, reconstruct positions, measure the edge.",new InlineKeyboard().text("➕ Track Wallet","ui:ask:addwallet").text("📋 My Wallets","ui:walletlist").row().text("💼 Portfolio","ui:portfolio").text("🧠 Wallet Score","ui:ask:walletscore").row().text("‹ Home","ui:home"));
  if(action==="signals_menu")return void await showUiPanel(ctx,"<b>⚡ CUSTOM SIGNALS</b>\n└ Build smart-money alerts with plain guided input.",new InlineKeyboard().text("➕ Create Signal","ui:ask:alertadd").text("📋 My Signals","ui:alerts").row().text("👀 Wallets","ui:wallets_menu").text("‹ Home","ui:home"));
  if(action==="paper_menu")return void await showUiPanel(ctx,"<b>🧾 PAPER TRADING</b>\n└ Test the thesis with live prices and zero real funds.",new InlineKeyboard().text("🟢 Paper Buy","ui:ask:paperbuy").text("🔴 Paper Sell","ui:ask:papersell").row().text("💼 My Portfolio","ui:paper").text("‹ Home","ui:home"));
  if(action==="calls_menu")return void await showUiPanel(ctx,"<b>🎯 CALL INTELLIGENCE</b>\n└ Group performance, active plays and proof-backed rankings.",new InlineKeyboard().text("🕘 Recent","ui:calls").text("⚡ Active","ui:active").row().text("🏆 Leaderboard","ui:leaderboard").text("👤 Callers","ui:callers").row().text("📈 Token PNL","ui:ask:pnl").text("‹ Home","ui:home"));
  if(action==="bridge_menu")return void await showUiPanel(ctx,"<b>🌉 BRIDGE RADAR</b>\n└ Follow chain-native ETH flow into and out of Robinhood.",new InlineKeyboard().text("📡 24H Flow","ui:bridgeflow").text(`${(await store.getChatSettings(chatId)).bridgeAlerts?"🟢":"⚪"} Live Alerts`,`ui:toggle:bridge`).row().text("‹ Home","ui:home"));
  if(action==="digest_menu")return void await showUiPanel(ctx,"<b>☀️ DAILY EDGE</b>\n└ One clean recap of calls, wallet flow and group momentum.",new InlineKeyboard().text("▶ Generate Now","ui:digestnow").text(`${(await store.getChatSettings(chatId)).digestEnabled?"🟢":"⚪"} Daily Delivery`,`ui:toggle:digest`).row().text("‹ Home","ui:home"));
  if(action==="settings")return void await showUiPanel(ctx,settingsPanel(await store.getChatSettings(chatId)),settingsKeyboard(await store.getChatSettings(chatId)));
  if(action==="guide")return void await showUiPanel(ctx,"<b>❔ HOW KAPISCOUT WORKS</b>\n\n1. Tap a tool.\n2. Reply with the requested CA, wallet or amount.\n3. Get a clean result with action buttons.\n\n<i>You can still paste a CA directly for the fastest scan.</i>",new InlineKeyboard().text("🔎 Start a Scan","ui:ask:scan").row().text("‹ Home","ui:home"));
  if(action==="walletlist"){
    const wallets=await store.listWallets(chatId);return void await ctx.reply(wallets.length?["<b>👀 TRACKED WALLETS</b>","",...wallets.map((item,index)=>`${index===wallets.length-1?"└":"├"} ${item.isKol?"◆":"◇"} <b>${escapeHtml(item.label)}</b> · <code>${compactAddress(item.address)}</code>`)].join("\n"):"<b>📭 No wallets yet</b>\n\nTap <b>Track Wallet</b> to add one.",{parse_mode:"HTML",reply_markup:new InlineKeyboard().text("➕ Track Wallet","ui:ask:addwallet").text("‹ Wallets","ui:wallets_menu")});
  }
  if(action==="alerts")return void await sendAlertRules(ctx,await store.listAlertRules(chatId));
  if(action==="portfolio")return void await sendWalletPortfolio(ctx,null,store,scanner);
  if(action==="paper"&&ctx.from)return void await sendPaperPortfolio(ctx,paper);
  if(action==="digestnow")return void await ctx.reply(await buildDailyDigest(store,chatId),{parse_mode:"HTML",reply_markup:new InlineKeyboard().text("‹ Daily Edge","ui:digest_menu")});
  if(action==="bridgeflow")return void await sendBridgeFlow(ctx,store);
  if(["calls","active","leaderboard","callers"].includes(action))return void await sendUiCallList(ctx,action,store);
  void charts;void config;
}

async function showUiPanel(ctx:Context,caption:string,keyboard:InlineKeyboard):Promise<void>{
  try{await ctx.editMessageCaption({caption,parse_mode:"HTML",reply_markup:keyboard});}
  catch{await ctx.reply(caption,{parse_mode:"HTML",reply_markup:keyboard});}
}

function settingsPanel(settings:ChatSettings):string{
  const s=(value:boolean)=>value?"🟢":"⚪";
  return ["<b>⚙️ QUICK SETTINGS</b>","└ Tap any option to toggle it.","",`${s(settings.showChart)} Charts     ${s(settings.kolAlerts)} Wallet alerts`,`${s(settings.milestoneAlerts)} Milestones  ${s(settings.devAlerts)} Dev alerts`,`${s(settings.whaleAlerts)} Whales      ${s(settings.digestEnabled)} Digest`,`${s(settings.bridgeAlerts)} Bridge radar`].join("\n");
}

function settingsKeyboard(settings:ChatSettings):InlineKeyboard{
  const s=(value:boolean)=>value?"🟢":"⚪";
  return new InlineKeyboard().text(`${s(settings.showChart)} Charts`,`ui:toggle:show_chart`).text(`${s(settings.kolAlerts)} Wallets`,`ui:toggle:kol_alerts`).row().text(`${s(settings.milestoneAlerts)} Milestones`,`ui:toggle:milestone_alerts`).text(`${s(settings.devAlerts)} Dev`,`ui:toggle:dev_alerts`).row().text(`${s(settings.whaleAlerts)} Whales`,`ui:toggle:whale_alerts`).text(`${s(settings.digestEnabled)} Digest`,`ui:toggle:digest`).row().text(`${s(settings.bridgeAlerts)} Bridge`,`ui:toggle:bridge`).text("‹ Home","ui:home");
}

async function requestUiInput(ctx:Context,action:UiPromptAction,pending:Map<string,{action:UiPromptAction;promptMessageId:number;expiresAt:number}>):Promise<void>{
  if(!ctx.chat||!ctx.from)return;
  const prompts:Record<UiPromptAction,{title:string;body:string;placeholder:string}>={
    scan:{title:"Scan a token",body:"Reply with the Robinhood Chain contract address.",placeholder:"0x…"},chart:{title:"Generate a chart",body:"Reply with: <code>CA 15m mc</code>",placeholder:"0x… 15m mc"},quote:{title:"Live exit quote",body:"Reply with: <code>CA amount</code>",placeholder:"0x… 1k"},holders:{title:"Holder map",body:"Reply with the token contract address.",placeholder:"0x…"},holderchanges:{title:"Holder changes",body:"Reply with the token contract address.",placeholder:"0x…"},pnl:{title:"Token PNL",body:"Reply with the called token contract address.",placeholder:"0x…"},intel:{title:"Reality Check",body:"Reply with the token contract address.",placeholder:"0x…"},devhistory:{title:"Deployer reputation",body:"Reply with the token contract address.",placeholder:"0x…"},timeline:{title:"Token timeline",body:"Reply with the token contract address.",placeholder:"0x…"},addwallet:{title:"Track a wallet",body:"Reply with: <code>wallet address + name</code>",placeholder:"0x… Smart Money"},walletscore:{title:"Smart Wallet Score",body:"Reply with the wallet address.",placeholder:"0x…"},alertadd:{title:"Create a signal",body:"Reply like: <code>Early Buyers direction=buy minvalue=5k maxmc=100k wallets=2 window=5</code>",placeholder:"Signal name and filters"},paperbuy:{title:"Paper buy",body:"Reply with: <code>CA amount</code>",placeholder:"0x… 100"},papersell:{title:"Paper sell",body:"Reply with: <code>CA 50%</code> or <code>CA all</code>",placeholder:"0x… 50%"},paperbuyamt:{title:"Paper buy amount",body:"Reply with the amount in USD to buy.",placeholder:"25"},
  };
  const item=prompts[action];if(!item)return;
  const message=await ctx.reply([`<b>→ ${item.title}</b>`,"",item.body,"","<i>Reply to this message. No command needed.</i>"].join("\n"),{parse_mode:"HTML",reply_markup:{force_reply:true,input_field_placeholder:item.placeholder}});
  pending.set(`${ctx.chat.id}:${ctx.from.id}`,{action,promptMessageId:message.message_id,expiresAt:Date.now()+10*60_000});
}

async function runUiPromptAction(ctx:Context,action:UiPromptAction,text:string,store:Store,scanner:TokenScanner,charts:ChartClient,config:AppConfig,paper:PaperCompetitionService):Promise<void>{
  if(!ctx.chat||!ctx.from)return;const chatId=String(ctx.chat.id);const address=extractAddresses(text)[0];
  const needAddress=()=>replyPanel(ctx,"⚠️","Address missing",["Send a complete <code>0x…</code> address."],"Tap the menu action again to retry.");
  if(action!=="alertadd"&&!address)return void await needAddress();
  if(action==="paperbuy"){const usd=parseCompactUsd(text.replace(/0x[a-fA-F0-9]{40}/u,"").trim());if(!usd||usd<=0)return void await replyPanel(ctx,"⚠️","Amount missing",["Example: <code>0x… 100</code>"]);return void await paperBuy(ctx,address!,usd,paper,store);}
  if(action==="papersell"){const rest=text.replace(/0x[a-fA-F0-9]{40}/u,"").trim().toLowerCase();const fraction=rest==="all"?1:Number.parseFloat(rest)/100;if(!Number.isFinite(fraction)||fraction<=0)return void await replyPanel(ctx,"⚠️","Invalid size",["Use a percentage or all."]);return void await paperSell(ctx,address!,fraction,paper,store);}
  if(action==="scan")return void await scanAndReply(ctx,address!,store,scanner,charts,config);
  if(action==="chart"){const tf=parseTimeframe(text)??"auto";const metric:ChartMetric=/(?:^|\s)price(?:\s|$)/iu.test(text)?"price":"market_cap";return void await sendChartOnly(ctx,address!,tf,metric,store,scanner,charts);}
  if(action==="quote"){const amount=parseCompactUsd(text.replace(/0x[a-fA-F0-9]{40}/u,"").trim())??1_000;return void await sendQuote(ctx,address!,amount,scanner);}
  if(action==="holders")return void await sendHolders(ctx,address!,store,scanner);
  if(action==="holderchanges")return void await sendHolderChanges(ctx,address!,store,scanner);
  if(action==="pnl")return void await sendPnl(ctx,address!,store,scanner,config);
  if(action==="intel")return void await sendReality(ctx,address!,store,scanner,config);
  if(action==="devhistory")return void await sendDeployerHistory(ctx,address!,scanner);
  if(action==="timeline")return void await sendTimeline(ctx,address!,store);
  if(action==="walletscore"){const score=await store.smartWalletScore(chatId,address!);if(!score)return void await replyPanel(ctx,"📭","Not enough history",["No observed buys or sells exist for this wallet yet."]);return void await ctx.reply([`<b>🧠 ${escapeHtml(score.label)} · ${score.grade}</b>`,`Score <b>${score.score}/100</b> · ${score.trades} trades · ${score.winRate==null?"collecting":`${score.winRate.toFixed(0)}% wins`}`,`Observed PNL <b>${formatSignedUsd(score.realizedPnlUsd)}</b>`].join("\n"),{parse_mode:"HTML"});}
  if(action==="addwallet"){
    const rawLabel=text.replace(/0x[a-fA-F0-9]{40}/u,"").trim();const label=rawLabel.slice(0,48)||compactAddress(address!);
    if(await store.countCustomWallets(chatId)>=config.maxWalletsPerChat&&!(await store.findWallets(address!)).some((item)=>item.chatId===chatId))return void await replyPanel(ctx,"⚠️","Wallet limit reached",[`This chat can track ${config.maxWalletsPerChat} wallets.`]);
    await store.addWallet(chatId,String(ctx.from.id),address!,label);return void await replyPanel(ctx,"✅","Wallet tracking enabled",[`<b>${escapeHtml(label)}</b>`,`<code>${address}</code>`],"Future activity will arrive as visual alert cards.");
  }
  if(action==="alertadd"){
    if(!(await canManageChat(ctx)))return void await replyPanel(ctx,"🔒","Admin setting",["Only group admins can create signals."]);
    const argument=`add ${text}`;const values=parseRuleValues(argument);const name=text.split(/\s+[a-z]+=|$/iu)[0]?.trim().slice(0,32)||"Signal";const rule=await store.addAlertRule({chatId,name,direction:values.direction,minValueUsd:values.minvalue,minMarketCapUsd:values.minmc,maxMarketCapUsd:values.maxmc||null,minLiquidityUsd:values.minlp,minWallets:Math.max(1,Math.floor(values.wallets)),windowMinutes:Math.max(1,Math.floor(values.window))});return void await replyPanel(ctx,"✅","Signal armed",[`<b>#${rule.id} · ${escapeHtml(rule.name)}</b>`,`${rule.direction} · ≥${formatUsd(rule.minValueUsd)} · ${rule.minWallets} wallet${rule.minWallets===1?"":"s"}/${rule.windowMinutes}m`]);
  }
}

async function sendUiCallList(ctx:Context,action:string,store:Store):Promise<void>{
  if(!ctx.chat)return;const chatId=String(ctx.chat.id);
  if(action==="callers"){const stats=await store.callerStats(chatId);return void await ctx.reply(stats.length?["<b>👤 CALLER LEADERBOARD</b>","",...stats.slice(0,10).map((item,index)=>`${medal(index)} <b>${escapeHtml(item.username)}</b> · ${item.winRate.toFixed(0)}% wins · ${item.bestMultiple?.toFixed(2)??"—"}x best`)].join("\n"):"<b>📭 No caller history yet</b>",{parse_mode:"HTML"});}
  const calls=action==="calls"?await store.listCalls(chatId,10):action==="active"?await store.activeCalls(chatId,10):await store.leaderboard(chatId,10);const title=action==="calls"?"RECENT CALLS":action==="active"?"ACTIVE PLAYS":"ATH LEADERBOARD";
  await ctx.reply(calls.length?[`<b>🎯 ${title}</b>`,"",...calls.map((call,index)=>callLine(call,index,action==="leaderboard"))].join("\n"):`<b>📭 ${title}</b>\n\nNothing to show yet.`,{parse_mode:"HTML"});
}

async function sendWalletPortfolio(ctx:Context,wallet:Address|null,store:Store,scanner:TokenScanner):Promise<void>{
  if(!ctx.chat)return;const positions=await store.walletPortfolio(String(ctx.chat.id),wallet??undefined);if(!positions.length)return void await replyPanel(ctx,"📭","Portfolio is empty",["It starts building when a tracked wallet makes a trade."]);
  const priced=await Promise.all(positions.slice(0,10).map(async(position)=>{const scan=await scanner.scan(position.tokenAddress).catch(()=>null);const price=scan?.market.priceUsd??position.lastPriceUsd;return{...position,value:price==null?null:position.tokenAmount*price,pnl:price==null?null:position.tokenAmount*price-position.costBasisUsd+position.realizedUsd};}));
  await ctx.reply(["<b>💼 OBSERVED PORTFOLIO</b>",wallet?`└ <code>${compactAddress(wallet)}</code>`:"└ All tracked wallets","",...priced.map((item,index)=>`${index===priced.length-1?"└":"├"} <b>$${escapeHtml(item.symbol)}</b> · ${formatUsd(item.value)} · ${formatSignedUsd(item.pnl)}`),"",`Total <b>${formatUsd(priced.reduce((sum,item)=>sum+(item.value??0),0))}</b>`].join("\n"),{parse_mode:"HTML"});
}

async function sendBridgeFlow(ctx:Context,store:Store):Promise<void>{
  const flows=await store.recentBridgeFlows(Date.now()-24*60*60_000,10);if(!flows.length)return void await replyPanel(ctx,"🌉","No recent bridge flow",["No chain-native ETH bridge transaction was observed in the last 24h."]);
  await ctx.reply(["<b>🌉 ROBINHOOD BRIDGE TAPE</b>","",...flows.map((flow,index)=>`${index===flows.length-1?"└":"├"} ${flow.direction==="IN"?"🟢 IN":"🟠 OUT"} · <b>${formatUsd(flow.valueUsd)}</b> · ${flow.amount.toFixed(3)} ETH`)].join("\n"),{parse_mode:"HTML"});
}

async function scanAndReply(ctx: Context, address: Address, store: Store, scanner: TokenScanner, charts: ChartClient, config: AppConfig, compact = false, detailed = false): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  const settings = await store.getChatSettings(String(ctx.chat.id));
  if (!settings.contractEnabled) return;
  if (settings.adminOnly && !(await canManageChat(ctx))) return void await replyPanel(ctx, "🔒", "Admin-only scanning", ["This group only allows admins to scan contracts."]);
  const chartLoad = settings.showChart ? within(charts.candlesForToken(address, settings.chartTimeframe), 6_000, null) : Promise.resolve(null);
  const scan = await withStatus(ctx, () => scanner.scan(address));
  if (!scan) return;
  const chartResult = await chartLoad;
  applyChartFallback(scan, chartResult);
  const marketCap = scan.market.marketCapUsd ?? scan.market.fdvUsd;
  if (settings.minMarketCapUsd > 0 && (marketCap == null || marketCap < settings.minMarketCapUsd)) {
    return void await replyPanel(ctx, "↘️", "Scan filtered", [`Market cap is below this group’s <b>${formatUsd(settings.minMarketCapUsd)}</b> minimum.`]);
  }
  const recorded = await store.recordCall({
    chatId: String(ctx.chat.id), messageId: ctx.message?.message_id ?? 0,
    userId: String(ctx.from.id), username: displayName(ctx), scan,
  });
  const call = recorded.call;
  const caption = renderScanCaption(scan, call, recorded.created, false, compact || settings.compact, detailed || settings.detailed);
  const image = await scanImage(scan, call, settings.chartMetric, settings.chartTimeframe, settings.showChart, charts, chartResult);
  await ctx.replyWithPhoto(new InputFile(image, `kapiscout-${scan.token.symbol}.png`), {
    caption, parse_mode: "HTML", reply_markup: settings.buttonsEnabled ? tokenKeyboard(scan, call, settings.chartMetric, settings.chartTimeframe, config) : undefined,
  });
}

async function refreshMessage(ctx: Context, address: Address, metric: ChartMetric, timeframe: ChartTimeframe, store: Store, scanner: TokenScanner, charts: ChartClient, config: AppConfig): Promise<void> {
  if (!ctx.chat) return;
  const chartLoad = within(charts.candlesForToken(address, timeframe), 6_000, null);
  const scan = await scanner.refreshMarket(address);
  const chartResult = await chartLoad;
  applyChartFallback(scan, chartResult);
  await store.syncSecurityWatchers(String(ctx.chat.id), scan);
  const call = await store.getCall(String(ctx.chat.id), address);
  const currentMc = scan.market.marketCapUsd ?? scan.market.fdvUsd;
  const updated = call ? await store.updateCallMarket(call.id, {
    priceUsd: scan.market.priceUsd, marketCapUsd: currentMc, liquidityUsd: scan.market.liquidityUsd,
    dexPaid: scan.market.dexPaid, incrementScan: true,
  }) : null;
  const settings = await store.getChatSettings(String(ctx.chat.id));
  const image = await scanImage(scan, updated, metric, timeframe, true, charts, chartResult);
  const caption = renderScanCaption(scan, updated, false, true, settings.compact, settings.detailed);
  await ctx.editMessageMedia({
    type: "photo", media: new InputFile(image, `kapiscout-${scan.token.symbol}.png`), caption, parse_mode: "HTML",
  }, { reply_markup: settings.buttonsEnabled ? tokenKeyboard(scan, updated, metric, timeframe, config) : undefined });
}

async function scanImage(scan: TokenScan, call: CallRecord | null, metric: ChartMetric, timeframe: ChartTimeframe, showChart: boolean, charts: ChartClient, prefetched: ChartSeries | null = null): Promise<Buffer> {
  if (showChart && (prefetched || scan.market.pairAddress)) {
    try {
      const result = prefetched ?? await charts.candles(scan.market.pairAddress!, timeframe, scan.market.pairCreatedAt);
      return await generateChartCard(scan, result.candles, result.timeframe, metric, call);
    } catch (error) {
      console.warn("Chart rendering failed; using scan card", error);
    }
  }
  return generateTokenCard(scan);
}

async function sendChartOnly(ctx: Context, address: Address, timeframe: ChartTimeframe, metric: ChartMetric, store: Store, scanner: TokenScanner, charts: ChartClient): Promise<void> {
  const chartLoad = within(charts.candlesForToken(address, timeframe), 6_000, null);
  const scan = await withStatus(ctx, () => scanner.scan(address));
  if (!scan) return;
  const result = await chartLoad ?? (scan.market.pairAddress ? await charts.candles(scan.market.pairAddress, timeframe, scan.market.pairCreatedAt).catch(() => null) : null);
  if (!result) return void await replyPanel(ctx, "📭", "Chart unavailable", ["No OHLCV history is indexed for this token yet."], "Try again after the pool records more trades.");
  const call = ctx.chat ? await store.getCall(String(ctx.chat.id), address) : null;
  const image = await generateChartCard(scan, result.candles, result.timeframe, metric, call);
  await ctx.replyWithPhoto(new InputFile(image, `kapiscout-${scan.token.symbol}-${result.timeframe}.png`), {
    caption: `<b>$${escapeHtml(scan.token.symbol)} · ${result.timeframe} ${metric === "market_cap" ? "market cap" : "price"} chart</b>`, parse_mode: "HTML",
  });
}

async function sendPnl(ctx: Context, address: Address, store: Store, scanner: TokenScanner, config: AppConfig): Promise<void> {
  if (!ctx.chat) return;
  const call = await store.getCall(String(ctx.chat.id), address);
  if (!call) return void await replyPanel(ctx, "🌱", "No first call recorded", ["This token has not been called in this chat yet."], "Paste its contract address to create the entry.");
  const scan = await withStatus(ctx, () => scanner.refreshMarket(address));
  if (!scan) return;
  await store.syncSecurityWatchers(String(ctx.chat.id), scan);
  const currentMc = scan.market.marketCapUsd ?? scan.market.fdvUsd;
  const updated = await store.updateCallMarket(call.id, { priceUsd: scan.market.priceUsd, marketCapUsd: currentMc, liquidityUsd: scan.market.liquidityUsd, dexPaid: scan.market.dexPaid }) ?? call;
  const reality = buildRealityReport(scan, updated);
  const image = await generatePnlCard(updated, scan);
  await ctx.replyWithPhoto(new InputFile(image, `kapiscout-${updated.symbol}-pnl.png`), {
    caption: pnlCaption(updated, currentMc, reality.realMultiple, reality.exitScore), parse_mode: "HTML",
    reply_markup: new InlineKeyboard().url("Explorer", `${config.blockscoutBrowserUrl}/token/${address}`).url("Chart", scan.market.pairUrl ?? `${config.blockscoutBrowserUrl}/token/${address}`),
  });
}

async function sendReality(ctx: Context, address: Address, store: Store, scanner: TokenScanner, config: AppConfig): Promise<void> {
  if (!ctx.chat) return;
  const scan = await withStatus(ctx, () => scanner.scan(address));
  if (!scan) return;
  const call = await store.getCall(String(ctx.chat.id), address);
  const reality = buildRealityReport(scan, call);
  const [launch, rwaDetails] = await Promise.all([
    within(scanner.launchForensics(scan), 6_000, null),
    within(scanner.rwaDetails(scan), 6_000, { quote: null, actions: [] }),
  ]);
  const history = call ? summarizeLiquidityHistory(await store.marketHistory(call.id)) : null;
  const lines = [
    `<b>🧪 ${escapeHtml(scan.token.name)} · Kapi Reality Check</b>`,
    `<i>Conservative pool estimate · not a guaranteed fill</i>`,
    "",
    "<b>💸 Exit Reality</b>",
    `├ ExitScore  <b>${reality.exitScore ?? "N/A"}/100 · ${reality.grade}</b>`,
    `├ Headline   <b>${formatMetricMultiple(reality.headlineMultiple)}</b>`,
    `├ Real PNL   <b>${formatMetricMultiple(reality.realMultiple)}</b> on $${reality.notionalUsd.toLocaleString()}`,
    ...reality.quotes.map((quote, index) => `${index === reality.quotes.length - 1 ? "└" : "├"} Sell ${formatUsd(quote.notionalUsd).padEnd(7)} → <b>${formatUsd(quote.receivedUsd)}</b> · ${formatImpact(quote.impactPercent)} impact`),
    "",
    "<b>💧 Liquidity Survival</b>",
    `├ LP / MC    ${formatPercentShort(reality.liquidityToMarketCapPercent)}`,
    `├ Range      ${history ? `${formatUsd(history.lowUsd)} — ${formatUsd(history.highUsd)}` : "Collecting history"}`,
    `├ Samples    ${history?.samples ?? 0}`,
    `└ Worst drop ${history?.largestDropPercent == null ? "Not observed" : formatPercentShort(-history.largestDropPercent)}`,
  ];
  if (launch) lines.push(
    "",
    "<b>🧬 Launch Forensics</b>",
    `├ Cluster    <b>${launch.risk}</b>${launch.clusterScore == null ? "" : ` · ${launch.clusterScore}/100`}`,
    `├ Block      ${launch.launchBlock?.toLocaleString() ?? "N/A"}`,
    `├ Recipients ${launch.firstBlockRecipients} across ${launch.firstBlockTransactions} tx`,
    `└ Distributed ${formatPercentShort(launch.firstBlockSupplyPercent)} of supply`,
  );
  if (scan.rwa) {
    const quote = rwaDetails.quote;
    const multiplier = scan.rwa.currentMultiplier ?? 1;
    const fairBid = quote?.bid == null ? null : quote.bid * multiplier;
    const fairAsk = quote?.ask == null ? null : quote.ask * multiplier;
    const fairMid = fairBid != null && fairAsk != null ? (fairBid + fairAsk) / 2 : null;
    const premium = fairMid && scan.market.priceUsd ? (scan.market.priceUsd / fairMid - 1) * 100 : null;
    lines.push(
      "",
      "<b>🏛 Official Robinhood RWA</b>",
      `├ Underlier  <b>${escapeHtml(scan.rwa.tokenSymbol)}</b> · ${escapeHtml(scan.rwa.status.replace("ASSET_STATUS_", ""))}`,
      `├ Fair value ${fairBid == null ? "N/A" : `${formatUsd(fairBid)} / ${formatUsd(fairAsk)}`}`,
      `├ Onchain    ${formatTokenPrice(scan.market.priceUsd)} · ${premium == null ? "N/A" : `${formatPercentShort(premium, true)} premium`}`,
      `├ Trading    ${quote?.isTradingHalt ? "🔴 HALTED" : scan.rwa.allDayTradability === "tradable" ? "🟢 24/5" : "Standard session"}`,
      `└ Action     ${rwaDetails.actions[0] ? `${escapeHtml(rwaDetails.actions[0].type)} · ${rwaDetails.actions[0].processDate ?? "date pending"}` : "None indexed"}`,
    );
  }
  if (reality.warnings.length) lines.push("", "<b>⚠️ Evidence</b>", ...reality.warnings.map((warning) => `• ${escapeHtml(warning)}`));
  if (call) lines.push(
    "",
    "<b>🔏 Proof of Call</b>",
    `├ Caller  ${escapeHtml(call.username)} · ${formatAge(call.calledAt)} ago`,
    `├ Entry   ${formatUsd(call.entryMarketCapUsd)} MC · ${formatUsd(call.entryLiquidityUsd)} LP`,
    `└ Receipt <code>${call.proofHash}</code>`,
  );
  lines.push("", `<code>${scan.token.address}</code>`);
  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: new InlineKeyboard()
      .text("🔄 New Reality Check", `i:${address}`)
      .text("📈 PNL", `p:${address}`)
      .row()
      .url("Explorer", `${config.blockscoutBrowserUrl}/token/${address}`)
      .url("Pool", scan.market.pairUrl ?? `${config.blockscoutBrowserUrl}/token/${address}`),
  });
}

async function sendHolders(ctx: Context, address: Address, store: Store, scanner: TokenScanner): Promise<void> {
  const scan = await withStatus(ctx, () => scanner.scan(address, true));
  if (!scan) return;
  if (ctx.chat) await store.recordHolderSnapshot(String(ctx.chat.id), scan);
  const lines = scan.holders.holders.map((holder, index, holders) => `${index === holders.length - 1 ? "└" : "├"} ${holder.isContract ? "◼" : "◆"} <code>${compactAddress(holder.address)}</code> · <b>${holder.percent.toFixed(2)}%</b>${holder.label ? ` · ${escapeHtml(holder.label)}` : ""}`);
  await ctx.reply([
    `<b>💎 $${escapeHtml(scan.token.symbol)} · Holder Map</b>`,
    `├ Holders  <b>${scan.token.holdersCount?.toLocaleString() ?? "N/A"}</b>`,
    `└ Top 10   <b>${formatPercent(scan.holders.top10Percent)}</b>`,
    "",
    "<b>Largest indexed wallets</b>",
    ...(lines.length ? lines : ["└ No holder rows indexed yet"]),
    "",
    "<i>Contracts and known pools may appear in the raw distribution.</i>",
  ].join("\n"), { parse_mode: "HTML" });
}

async function sendAlertRules(ctx: Context, rules: Awaited<ReturnType<Store["listAlertRules"]>>): Promise<void> {
  if (!rules.length) return void await replyPanel(ctx,"⚡","No custom signals",["Create one with:","<code>/alert add Early direction=buy minvalue=5k maxmc=100k wallets=2 window=5</code>"]);
  await ctx.reply(["<b>⚡ CUSTOM SIGNALS</b>","",...rules.map((rule,index)=>`${index===rules.length-1?"└":"├"} <b>#${rule.id} · ${escapeHtml(rule.name)}</b>\n   ${rule.direction} · value ≥${formatUsd(rule.minValueUsd)} · LP ≥${formatUsd(rule.minLiquidityUsd)} · MC ${rule.maxMarketCapUsd==null?`≥${formatUsd(rule.minMarketCapUsd)}`:`${formatUsd(rule.minMarketCapUsd)}–${formatUsd(rule.maxMarketCapUsd)}`} · ${rule.minWallets}w/${rule.windowMinutes}m`),"","<i>Remove · /alert remove ID</i>"].join("\n"),{parse_mode:"HTML"});
}

function parseRuleValues(argument:string): {direction:"ANY"|"BUY"|"SELL";minvalue:number;minmc:number;maxmc:number;minlp:number;wallets:number;window:number} {
  const pairs=Object.fromEntries([...argument.matchAll(/([a-z]+)=([^\s]+)/giu)].map((match)=>[match[1]!.toLowerCase(),match[2]!]));
  const money=(name:string)=>parseCompactUsd(pairs[name]??"0")??0;
  const direction=pairs.direction?.toLowerCase();
  return {direction:direction==="buy"?"BUY":direction==="sell"?"SELL":"ANY",minvalue:money("minvalue"),minmc:money("minmc"),maxmc:money("maxmc"),minlp:money("minlp"),wallets:Number(pairs.wallets??1)||1,window:Number(pairs.window??5)||5};
}

async function sendDeployerHistory(ctx:Context,address:Address,scanner:TokenScanner):Promise<void>{
  const scan=await withStatus(ctx,()=>scanner.scan(address)); if(!scan)return;
  const report=await withStatus(ctx,()=>scanner.deployerReputation(scan)); if(!report)return void await replyPanel(ctx,"🧬","Deployer unavailable",["No creator address is indexed for this contract."]);
  await ctx.reply([`<b>🧬 DEPLOYER REPUTATION · ${report.grade}</b>`,`└ <code>${compactAddress(report.address)}</code>`,"",`Score       <b>${report.score}/100</b>`,`├ Launches   ${report.launches}${report.launches===12?"+":""}`,`├ Live pools ${report.liveMarkets}`,`├ Low LP     ${report.lowLiquidityLaunches}`,`├ Verified   ${report.verifiedContracts}`,`└ Best MC    ${formatUsd(report.bestMarketCapUsd)}`,"","<b>Recent launch sample</b>",...report.tokens.slice(0,6).map((token,index)=>`${index===Math.min(5,report.tokens.length-1)?"└":"├"} $${escapeHtml(token.symbol)} · ${formatUsd(token.marketCapUsd)} MC · ${formatUsd(token.liquidityUsd)} LP`),"","<i>Factory deployments are grouped when Blockscout identifies the factory as creator.</i>"].join("\n"),{parse_mode:"HTML"});
}

async function sendQuote(ctx:Context,address:Address,valueUsd:number,scanner:TokenScanner):Promise<void>{
  const scan=await withStatus(ctx,()=>scanner.scan(address)); if(!scan)return;
  const quote=await withStatus(ctx,()=>scanner.quoteExit(scan,Math.max(1,valueUsd))); if(!quote)return;
  await ctx.reply([`<b>💱 $${escapeHtml(scan.token.symbol)} · EXIT QUOTE</b>`,`└ Sell notional <b>${formatUsd(valueUsd)}</b>`,"",`├ Route    <b>${quote.source==="UNISWAP_V4"?"Uniswap v4 · onchain":"Pool estimate"}</b>`,`├ Input    ${formatCompactNumber(quote.amountInTokens)} $${escapeHtml(scan.token.symbol)}`,`├ Receive  <b>${quote.amountOutUsd==null?quote.amountOutTokens==null?"N/A":formatCompactNumber(quote.amountOutTokens):formatUsd(quote.amountOutUsd)}</b>`,`├ Impact   <b>${quote.priceImpactPercent==null?"N/A":`${quote.priceImpactPercent.toFixed(2)}%`}</b>`,`└ Gas      ${quote.gasEstimate?.toLocaleString()??"N/A"}`,"",`<i>${escapeHtml(quote.note)}</i>`].join("\n"),{parse_mode:"HTML"});
}

async function sendHolderChanges(ctx:Context,address:Address,store:Store,scanner:TokenScanner):Promise<void>{
  if(!ctx.chat)return; const chatId=String(ctx.chat.id); const scan=await withStatus(ctx,()=>scanner.scan(address,true)); if(!scan)return; await store.recordHolderSnapshot(chatId,scan);
  const snapshots=await store.holderSnapshots(chatId,address); const first=snapshots[0]; const last=snapshots.at(-1)!;
  if(!first||snapshots.length<2)return void await replyPanel(ctx,"💎",`$${scan.token.symbol} · Holder Changes`,["First holder snapshot recorded.","Changes appear after the next 15-minute snapshot window."],"KapiScout does not invent historical holder data.");
  const oldMap=new Map(first.holders.map((item)=>[item.address.toLowerCase(),item.percent])); const newMap=new Map(last.holders.map((item)=>[item.address.toLowerCase(),item.percent]));
  const deltas=[...new Set([...oldMap.keys(),...newMap.keys()])].map((key)=>({key,delta:(newMap.get(key)??0)-(oldMap.get(key)??0)})).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)).slice(0,5);
  const topDelta=first.top10Percent==null||last.top10Percent==null?null:last.top10Percent-first.top10Percent; const countDelta=first.holdersCount==null||last.holdersCount==null?null:last.holdersCount-first.holdersCount;
  await ctx.reply([`<b>💎 $${escapeHtml(scan.token.symbol)} · HOLDER CHANGES</b>`,`└ ${formatAge(first.capturedAt)} window`,"",`├ Holders  <b>${signedNumber(countDelta)}</b> · now ${last.holdersCount?.toLocaleString()??"N/A"}`,`└ Top 10   <b>${topDelta==null?"N/A":`${topDelta>=0?"+":""}${topDelta.toFixed(2)}%`}</b> · now ${formatPercent(last.top10Percent)}`,"","<b>Largest concentration moves</b>",...deltas.map((item,index)=>`${index===deltas.length-1?"└":"├"} <code>${compactAddress(item.key as Address)}</code> · <b>${item.delta>=0?"+":""}${item.delta.toFixed(2)}%</b>`),"","<i>Compared from KapiScout snapshots, not reconstructed history.</i>"].join("\n"),{parse_mode:"HTML"});
}

async function sendTimeline(ctx:Context,address:Address,store:Store):Promise<void>{
  if(!ctx.chat)return; const events=await store.tokenTimeline(String(ctx.chat.id),address,20); if(!events.length)return void await replyPanel(ctx,"🕘","Timeline is empty",["Paste this CA once to create its first-call event."]);
  const icons:Record<string,string>={CALL:"🌱",MILESTONE:"🚀",ATH:"⛰",DEX_PAID:"✅",LIQUIDITY:"💧",WALLET_BUY:"🟢",WALLET_SELL:"🔴",PAPER_BUY:"🧾",PAPER_SELL:"🧾"};
  await ctx.reply([`<b>🕘 $${escapeHtml(events[0]!.symbol)} · EVENT TIMELINE</b>`,"",...events.map((event,index)=>`${index===events.length-1?"└":"├"} ${icons[event.kind]??"•"} <b>${escapeHtml(event.title)}</b> · ${formatAge(event.createdAt)}${event.valueUsd==null?"":` · ${formatUsd(event.valueUsd)}`}`),"",`<code>${address}</code>`].join("\n"),{parse_mode:"HTML"});
}

async function showPaperBuyChooser(ctx:Context,address:Address,paper:PaperCompetitionService):Promise<void>{
  if(!ctx.chat||!ctx.from)return;
  const account=await paperAction(ctx,async ()=>Promise.resolve(await paper.ensureAccount(String(ctx.chat!.id),String(ctx.from!.id),displayName(ctx))));if(!account)return;
  const caption=["<b>🧾 PAPER BUY</b>",`└ <code>${compactAddress(address)}</code>`,"",`Your cash  <b>${formatUsd(account.cashBalanceUsd)}</b>`,"","Choose the amount to buy with:"].join("\n");
  const keyboard=new InlineKeyboard().text("$10",`pbx:${address}:10`).text("$25",`pbx:${address}:25`).text("$50",`pbx:${address}:50`).text("$100",`pbx:${address}:100`).row().text("✏️ Custom",`pbc:${address}`).text("💳 My Balance","ui:paper").row().text("‹ Paper Arena","ui:paper_menu");
  await ctx.reply(caption,{parse_mode:"HTML",reply_markup:keyboard});
}

async function showPaperMenu(ctx:Context,paper:PaperCompetitionService):Promise<void>{
  if(!ctx.chat||!ctx.from)return;
  const chatId=String(ctx.chat.id);const userId=String(ctx.from.id);
  const account=await paperAction(ctx,async ()=>Promise.resolve(await paper.ensureAccount(chatId,userId,displayName(ctx))));if(!account)return;
  const players=await paper.participants(account.competitionId);
  const caption=["<b>🏁 KAPISCOUT PAPER ARENA</b>","└ Every trader starts with <b>$100</b> · zero real funds","",`Your cash  <b>${formatUsd(account.cashBalanceUsd)}</b> · PNL <b>${formatSignedUsd(account.cashBalanceUsd-account.startingBalanceUsd)}</b>`,`Players    <b>${players}</b>`,"","<i>Fills use the official Uniswap v4 quote. Gas and price impact count.</i>"].join("\n");
  const keyboard=new InlineKeyboard().text("🟢 Buy","ui:ask:paperbuy").text("🔴 Sell","ui:ask:papersell").row().text("💳 My Balance","ui:paper").text("🏆 Best Traders","ui:paper_lb").row().text("🕘 Trade History","ui:paper_history").text("‹ Home","ui:home");
  await showUiPanel(ctx,caption,keyboard);
}

async function paperBuy(ctx:Context,address:Address,valueUsd:number,paper:PaperCompetitionService,store:Store):Promise<void>{
  if(!ctx.chat||!ctx.from)return;
  const result=await paperAction(ctx,async ()=>await paper.buy(String(ctx.chat!.id),String(ctx.from!.id),address,valueUsd,displayName(ctx)));if(!result)return;
  await store.recordTokenEvent({chatId:String(ctx.chat.id),tokenAddress:address,symbol:result.scan.token.symbol,kind:"PAPER_BUY",title:`Competition buy ${formatUsd(result.spentUsd)}`,txHash:null,valueUsd:result.spentUsd});
  await replyPanel(ctx,"🟢",`FILLED · BUY $${result.scan.token.symbol}`,[`├ Cost       <b>${formatUsd(result.spentUsd)}</b>`,`├ Tokens     <b>${formatCompactNumber(result.tokenAmount)}</b>`,`├ Fill price ${formatTokenPrice(result.executionPriceUsd)}`,`├ Impact     ${formatImpact(result.priceImpactPercent)}`,`└ Gas        ${formatUsd(result.gasCostUsd)}`],"Official Uniswap v4 eth_call · no transaction sent.");
  await sendPaperPortfolio(ctx,paper);
}

async function paperSell(ctx:Context,address:Address,fraction:number,paper:PaperCompetitionService,store:Store):Promise<void>{
  if(!ctx.chat||!ctx.from)return;
  const result=await paperAction(ctx,async ()=>await paper.sell(String(ctx.chat!.id),String(ctx.from!.id),address,Math.min(1,fraction),displayName(ctx)));if(!result)return;
  await store.recordTokenEvent({chatId:String(ctx.chat.id),tokenAddress:address,symbol:result.scan.token.symbol,kind:"PAPER_SELL",title:`Competition sell ${(Math.min(1,fraction)*100).toFixed(0)}%`,txHash:null,valueUsd:result.netProceedsUsd});
  await replyPanel(ctx,result.realizedPnlUsd>=0?"🟢":"🔴",`FILLED · SELL $${result.scan.token.symbol}`,[`├ Net return <b>${formatUsd(result.netProceedsUsd)}</b>`,`├ Realized   <b>${formatSignedUsd(result.realizedPnlUsd)}</b>`,`├ Fill price ${formatTokenPrice(result.executionPriceUsd)}`,`├ Impact     ${formatImpact(result.priceImpactPercent)}`,`└ Gas        ${formatUsd(result.gasCostUsd)}`],"Official Uniswap v4 eth_call · PNL locked into your record.");
  await sendPaperPortfolio(ctx,paper);
}

async function sendPaperPortfolio(ctx:Context,paper:PaperCompetitionService,edit=false):Promise<void>{
  if(!ctx.chat||!ctx.from)return;
  const snapshot=await paperAction(ctx,async ()=>await paper.portfolio(String(ctx.chat!.id),String(ctx.from!.id),displayName(ctx)));if(!snapshot)return;
  const image=await generatePaperPortfolioCard(snapshot);const caption=[`<b>💳 ${escapeHtml(snapshot.competition.name)} · MY BALANCE</b>`,`└ Rank <b>#${snapshot.rank??"—"}</b> of ${snapshot.participants} · ${snapshot.competition.status==="ACTIVE"?"live":"final"}`,"",`Balance  <b>${formatUsd(snapshot.equityUsd)}</b> · PNL <b>${formatSignedUsd(snapshot.totalPnlUsd)}</b>`,`Cash ${formatUsd(snapshot.cashBalanceUsd)} · Positions ${formatUsd(snapshot.positionsValueUsd)}`,"",snapshot.positions.some(item=>!item.quoteAvailable)?"⚠️ One or more positions currently have no executable exit and are valued at $0.":"<i>Executable exit value after estimated gas.</i>"].join("\n");
  const keyboard=new InlineKeyboard().text("↻ Refresh",`ui:paper_refresh:${ctx.from.id}`).text("🏆 Rankings","ui:paper_lb").row().text("🟢 Buy","ui:ask:paperbuy").text("🔴 Sell","ui:ask:papersell").row().text("‹ Arena","ui:paper_menu");
  if(edit){try{await ctx.editMessageMedia({type:"photo",media:new InputFile(image,"kapiscout-paper-balance.png"),caption,parse_mode:"HTML"},{reply_markup:keyboard});return;}catch{/* Send a fresh card if Telegram cannot edit the original media. */}}
  await ctx.replyWithPhoto(new InputFile(image,"kapiscout-paper-balance.png"),{caption,parse_mode:"HTML",reply_markup:keyboard});
}

async function sendPaperLeaderboard(ctx:Context,paper:PaperCompetitionService,edit=false):Promise<void>{
  if(!ctx.chat)return;const result=await paperAction(ctx,async ()=>await paper.leaderboard(String(ctx.chat!.id)));if(!result)return;
  const image=await generatePaperLeaderboardCard(result.competition,result.entries);const leader=result.entries[0];const caption=[`<b>🏆 ${escapeHtml(result.competition.name)} · ${result.competition.status==="ACTIVE"?"LIVE":"FINAL"}</b>`,leader?`└ Leader <b>${escapeHtml(leader.username)}</b> · ${formatUsd(leader.equityUsd)} · ${leader.returnPercent>=0?"+":""}${leader.returnPercent.toFixed(2)}%`:"└ Waiting for competitors","","<i>Rankings use current executable exit quotes and refresh every 15 seconds.</i>"].join("\n");const keyboard=new InlineKeyboard().text("↻ Refresh","ui:paper_lb").text("💳 My Balance","ui:paper").row().text("‹ Arena","ui:paper_menu");
  if(edit){try{await ctx.editMessageMedia({type:"photo",media:new InputFile(image,"kapiscout-paper-leaderboard.png"),caption,parse_mode:"HTML"},{reply_markup:keyboard});return;}catch{/* Send a fresh card if Telegram cannot edit the original media. */}}
  await ctx.replyWithPhoto(new InputFile(image,"kapiscout-paper-leaderboard.png"),{caption,parse_mode:"HTML",reply_markup:keyboard});
}

async function sendPaperHistory(ctx:Context,paper:PaperCompetitionService):Promise<void>{
  if(!ctx.chat||!ctx.from)return;const result=await paperAction(ctx,async ()=>Promise.resolve(paper.history(String(ctx.chat!.id),String(ctx.from!.id),12,displayName(ctx))));if(!result)return;
  const lines=result.trades.map((trade,index)=>`${index===result.trades.length-1?"└":"├"} ${trade.side==="BUY"?"🟢":"🔴"} <b>${trade.side} $${escapeHtml(trade.symbol)}</b> · ${formatUsd(trade.side==="BUY"?trade.grossValueUsd+trade.gasCostUsd:trade.grossValueUsd-trade.gasCostUsd)}${trade.realizedPnlUsd==null?"":` · ${formatSignedUsd(trade.realizedPnlUsd)}`} · ${formatAge(trade.createdAt)}`);
  await ctx.reply([`<b>🕘 ${escapeHtml(result.competition.name)} · TRADE HISTORY</b>`,`└ Exact fills · gas included`,"",...(lines.length?lines:["No trades yet."])].join("\n"),{parse_mode:"HTML",reply_markup:new InlineKeyboard().text("💳 My Balance","ui:paper").text("‹ Arena","ui:paper_menu")});
}

async function paperAction<T>(ctx:Context,action:()=>Promise<T>):Promise<T|null>{
  try{await ctx.replyWithChatAction("upload_photo");return await action();}catch(error){const message=error instanceof Error?error.message:"Paper trading request failed.";await replyPanel(ctx,"⚠️","Paper Arena",[escapeHtml(message)],"Competition fills require an exact live Uniswap v4 quote.");return null;}
}

async function legacyPaperBuy(ctx:Context,address:Address,valueUsd:number,store:Store,scanner:TokenScanner):Promise<void>{
  if(!ctx.chat||!ctx.from)return; const scan=await withStatus(ctx,()=>scanner.scan(address,true)); if(!scan)return; const price=scan.market.priceUsd;
  if(price==null||price<=0)return void await replyPanel(ctx,"⚠️","Paper trade unavailable",["This token has no usable indexed USD price."]);
  const position=await store.paperBuy(String(ctx.chat.id),String(ctx.from.id),address,scan.token.symbol,valueUsd,price); await store.recordTokenEvent({chatId:String(ctx.chat.id),tokenAddress:address,symbol:scan.token.symbol,kind:"PAPER_BUY",title:`Paper buy ${formatUsd(valueUsd)}`,txHash:null,valueUsd});
  await replyPanel(ctx,"🧾",`PAPER BUY · $${scan.token.symbol}`,[`├ Filled  <b>${formatUsd(valueUsd)}</b> at ${formatTokenPrice(price)}`,`├ Tokens  ${formatCompactNumber(valueUsd/price)}`,`└ Position cost  <b>${formatUsd(position.costBasisUsd)}</b>`],"Simulation only · no wallet connected and no transaction sent.");
}

async function legacyPaperSell(ctx:Context,address:Address,fraction:number,store:Store,scanner:TokenScanner):Promise<void>{
  if(!ctx.chat||!ctx.from)return; const scan=await withStatus(ctx,()=>scanner.scan(address,true)); if(!scan)return; const price=scan.market.priceUsd; if(price==null||price<=0)return void await replyPanel(ctx,"⚠️","Paper trade unavailable",["This token has no usable indexed USD price."]);
  const before=await store.paperPosition(String(ctx.chat.id),String(ctx.from.id),address); const position=await store.paperSell(String(ctx.chat.id),String(ctx.from.id),address,fraction,price); if(!before||!position)return void await replyPanel(ctx,"📭","No paper position",["Open one with /paperbuy CA 100."]);
  const proceeds=before.tokenAmount*Math.min(1,fraction)*price; await store.recordTokenEvent({chatId:String(ctx.chat.id),tokenAddress:address,symbol:scan.token.symbol,kind:"PAPER_SELL",title:`Paper sell ${(Math.min(1,fraction)*100).toFixed(0)}%`,txHash:null,valueUsd:proceeds});
  await replyPanel(ctx,"🧾",`PAPER SELL · $${scan.token.symbol}`,[`├ Proceeds  <b>${formatUsd(proceeds)}</b>`,`├ Remaining ${formatCompactNumber(position.tokenAmount)} tokens`,`└ Realized  <b>${formatSignedUsd(position.realizedPnlUsd)}</b>`],"Simulation only · live indexed price, no slippage execution.");
}

async function legacySendPaperPortfolio(ctx:Context,chatId:string,userId:string,store:Store,scanner:TokenScanner):Promise<void>{
  const positions=await store.paperPositions(chatId,userId); if(!positions.length)return void await replyPanel(ctx,"📭","No paper positions",["Open one with <code>/paperbuy CA 100</code>."]);
  const valued=await Promise.all(positions.slice(0,10).map(async(position)=>{const scan=await scanner.scan(position.tokenAddress).catch(()=>null);const price=scan?.market.priceUsd;const value=price==null?null:position.tokenAmount*price;return{...position,value,pnl:value==null?null:value-position.costBasisUsd+position.realizedPnlUsd};}));
  await ctx.reply(["<b>🧾 PAPER PORTFOLIO</b>",`└ ${valued.length} open position${valued.length===1?"":"s"}`,"",...valued.map((item,index)=>`${index===valued.length-1?"└":"├"} <b>$${escapeHtml(item.symbol)}</b> · ${formatUsd(item.value)} · ${formatSignedUsd(item.pnl)}`),"",`Total value <b>${formatUsd(valued.reduce((sum,item)=>sum+(item.value??0),0))}</b> · PNL <b>${formatSignedUsd(valued.reduce((sum,item)=>sum+(item.pnl??0),0))}</b>`,"<i>Simulation only · no real funds.</i>"].join("\n"),{parse_mode:"HTML"});
}

function formatSignedUsd(value:number|null):string{return value==null?"N/A":`${value>=0?"+":"-"}${formatUsd(Math.abs(value))}`;}
function signedNumber(value:number|null):string{return value==null?"N/A":`${value>=0?"+":""}${value.toLocaleString()}`;}

export function renderScanCaption(scan: TokenScan, call: CallRecord | null, created: boolean, refreshed: boolean, compact: boolean, detailed: boolean): string {
  const mc = scan.market.marketCapUsd ?? scan.market.fdvUsd;
  const performance = callPerformance(call, mc);
  const reality = buildRealityReport(scan, call);
  if (compact) return [
    `<b>🐹 ${escapeHtml(scan.token.name)} ($${escapeHtml(scan.token.symbol)})</b>`,
    `└ ${formatTokenPrice(scan.market.priceUsd)} · MC <b>${formatUsd(mc)}</b> · LP ${formatUsd(scan.market.liquidityUsd)}`,
    call ? `└ Entry ${formatUsd(call.entryMarketCapUsd)} · <b>${performance}</b> · ATH ${formatMultiple(call.entryMarketCapUsd, call.athMarketCapUsd)}` : "",
    `<code>${scan.token.address}</code>`,
  ].filter(Boolean).join("\n");
  const holders = scan.holders.holders.slice(0, 5).map((item) => item.percent.toFixed(1)).join("|") || "N/A";
  const circulating = scan.market.priceUsd && mc ? formatCompactNumber(mc / scan.market.priceUsd) : "N/A";
  const totalSupply = formatTokenSupply(scan.token.totalSupplyRaw, scan.token.decimals);
  const liquidityFlag = scan.market.liquidityUsd != null && scan.market.liquidityUsd < 10_000 ? " ⚠️" : "";
  const athDrawdown = call?.athMarketCapUsd && mc ? calculateReturn(call.athMarketCapUsd, mc) : null;
  const xSocial = findSocial(scan, "x");
  const tgSocial = findSocial(scan, "telegram");
  const website = scan.market.websites.find(isHttpUrl) ?? null;
  const socialItems = [
    xSocial ? htmlLink("𝕏", xSocial) : null,
    tgSocial ? htmlLink("TG", tgSocial) : null,
    website ? htmlLink("Web", website) : null,
    scan.market.pairUrl ? htmlLink("about", scan.market.pairUrl) : null,
  ].filter((item): item is string => Boolean(item));
  const dexInfo = scan.market.pairUrl ? htmlLink("info", scan.market.pairUrl) : "info";
  const header = [
    `<b>🐹 ${escapeHtml(scan.token.name)} ($${escapeHtml(scan.token.symbol)})</b>`,
    `└  <b>#HOOD</b> (${escapeHtml(titleCase(scan.market.dexId ?? "No indexed DEX"))}) | ${formatAge(scan.market.pairCreatedAt)} | ${formatCompactNumber(scan.token.holdersCount)}`,
  ].join("\n");
  const stats = [
    "<b>📊 Stats</b>",
    `├ USD   <b>${formatTokenPrice(scan.market.priceUsd)}</b> (${formatPercentShort(scan.market.priceChange24h, true)})`,
    `├ MC    <b>${formatUsd(mc)}</b>`,
    `├ Vol   ${formatUsd(scan.market.volume24hUsd)}`,
    `├ LP    ${formatUsd(scan.market.liquidityUsd)}${liquidityFlag}`,
    `├ Sup   ${circulating}/${totalSupply}`,
    `├ 1H    ${formatPercentShort(scan.market.priceChange1h, true)}  🅑${scan.market.buys1h ?? "—"} Ⓢ${scan.market.sells1h ?? "—"}`,
    `├ ATH   ${formatUsd(call?.athMarketCapUsd ?? null)} (${formatPercentShort(athDrawdown, true)} / ${call ? formatAge(call.calledAt) : "—"})`,
    `└ Exit  <b>${reality.exitScore ?? "N/A"}/100 · ${reality.grade}</b>  $1K ${formatImpact(reality.quotes.find((quote) => quote.notionalUsd === 1_000)?.impactPercent ?? null)}`,
  ].join("\n");
  const socials = [
    `<b>🔗 Socials [${formatAge(scan.market.pairCreatedAt)}]</b>`,
    `└ ${socialItems.length ? socialItems.join(" • ") : "No verified socials"}`,
  ].join("\n");
  const security = [
    "<b>🛡 Security</b>",
    `├ Top 10    ${formatPercentShort(scan.holders.top10Percent)} | ${formatCompactNumber(scan.token.holdersCount)} total`,
    `├ TH        ${holders}`,
    `├ Contract  ${scan.verified ? "✅ Verified" : "⚠️ Unverified"}`,
    `${detailed ? "├" : "└"} DEX Paid  ${scan.market.dexPaid == null ? "N/A" : scan.market.dexPaid ? "✅ Yes" : "❌ No"} · ${dexInfo}`,
    ...(detailed ? [`└ 24H Flow  🅑${scan.market.buys24h ?? "—"} Ⓢ${scan.market.sells24h ?? "—"}`] : []),
    ...(scan.warnings.length ? [`⚠️ ${escapeHtml(scan.warnings.slice(0, 2).join(" · "))}`] : []),
  ].join("\n");
  const callSection = call ? [
    `<b>🔥 First Call @ ${formatUsd(call.entryMarketCapUsd)}</b>`,
    `└ ${escapeHtml(call.username)} | Now <b>${performance}</b> | ATH ${formatMultiple(call.entryMarketCapUsd, call.athMarketCapUsd)} | ${call.scanCount} scans${refreshed ? " · updated" : created ? " · recorded" : ""}`,
  ].join("\n") : "<b>Call tracking unavailable</b>";
  const rwaSection = scan.rwa ? `<b>🏛 Official Robinhood RWA</b>\n└ ${escapeHtml(scan.rwa.tokenSymbol)} · ${scan.rwa.allDayTradability === "tradable" ? "24/5 enabled" : "standard session"}` : "";
  return [header, stats, socials, security, rwaSection, callSection, `<code>${scan.token.address}</code>`].filter(Boolean).join("\n\n");
}

function tokenKeyboard(scan: TokenScan, call: CallRecord | null, metric: ChartMetric, timeframe: ChartTimeframe, config: AppConfig): InlineKeyboard {
  const address = scan.token.address;
  const metricCode = metric === "price" ? "p" : "m";
  const keyboard = new InlineKeyboard()
    .text("🔄 Refresh · 15s", `r:${address}:${metricCode}:${timeframe}`)
    .text("📈 PNL", `p:${address}`)
    .text("🧪 Reality", `i:${address}`).row()
    .text("💎 TH", `h:${address}`)
    .text(metric === "market_cap" ? "📊 MC" : "💵 Price", `m:${address}:${metricCode}:${timeframe}`)
    .text(`⏱ ${timeframe.toUpperCase()}`, `t:${address}:${metricCode}:${timeframe}`).row()
    .text("▣ Chart", `c:${address}:${metricCode}:${timeframe}`).row()
    .text("💱 Quote", `q:${address}`)
    .text("🕘 Timeline", `tl:${address}`)
    .text("🧾 Paper Buy", `pb:${address}`).row();
  if (scan.market.pairUrl) keyboard.url("DS", scan.market.pairUrl);
  if (scan.market.pairAddress) keyboard.url("GT", `https://www.geckoterminal.com/robinhood/pools/${scan.market.pairAddress}`);
  keyboard.url("EXP", `${config.blockscoutBrowserUrl}/token/${address}`);
  const original = call ? messageLink(call.chatId, call.messageId) : null;
  if (original) keyboard.url("First", original);
  const website = scan.market.websites.find(isHttpUrl);
  const xSocial = findSocial(scan, "x");
  const tgSocial = findSocial(scan, "telegram");
  if (website || xSocial || tgSocial) {
    keyboard.row();
    if (xSocial) keyboard.url("𝕏", xSocial);
    if (tgSocial) keyboard.url("TG", tgSocial);
    if (website) keyboard.url("WEB", website);
  }
  return keyboard;
}

function pnlCaption(call: CallRecord, currentMc: number | null, realMultiple: number | null, exitScore: number | null): string {
  return [
    `<b>$${escapeHtml(call.symbol)} · performance</b>`, "",
    `Entry <b>${formatUsd(call.entryMarketCapUsd)}</b>  →  Now <b>${formatUsd(currentMc)}</b>`,
    `Current <b>${callPerformance(call, currentMc)}</b>  ·  ATH <b>${formatMultiple(call.entryMarketCapUsd, call.athMarketCapUsd)}</b>`,
    `Real PNL <b>${formatMetricMultiple(realMultiple)}</b> on $1K  ·  ExitScore <b>${exitScore ?? "N/A"}/100</b>`,
    `Called by ${escapeHtml(call.username)} · ${formatAge(call.calledAt)} ago`,
  ].join("\n");
}

function realCallLine(call: CallRecord, index: number): string {
  const multiple = estimateRealMultiple(call, call.lastMarketCapUsd, call.lastLiquidityUsd);
  const headline = calculateMultiple(call.entryMarketCapUsd, call.lastMarketCapUsd);
  return `${medal(index)} <b>$${escapeHtml(call.symbol)}</b> · real <b>${formatMetricMultiple(multiple)}</b> · headline ${formatMetricMultiple(headline)} · ${escapeHtml(call.username)}`;
}

function callLine(call: CallRecord, index: number, ath = false): string {
  const current = formatPerformance(call.entryMarketCapUsd, call.lastMarketCapUsd);
  const athValue = formatMultiple(call.entryMarketCapUsd, call.athMarketCapUsd);
  return `${medal(index)} <b>$${escapeHtml(call.symbol)}</b> · ${ath ? `${athValue} ATH` : current} · ${escapeHtml(call.username)} · ${formatAge(call.calledAt)}`;
}

function callPerformance(call: CallRecord | null, currentMc: number | null): string {
  return call ? formatPerformance(call.entryMarketCapUsd, currentMc) : "N/A";
}

function formatPerformance(entry: number | null, current: number | null): string {
  const multiple = calculateMultiple(entry, current);
  if (multiple == null) return "N/A";
  return multiple >= 1 ? `${multiple.toFixed(2)}x` : formatPercentShort((multiple - 1) * 100, true);
}

function formatMultiple(entry: number | null, value: number | null): string {
  const multiple = calculateMultiple(entry, value);
  return multiple == null ? "N/A" : `${multiple.toFixed(2)}x`;
}

function formatMetricMultiple(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return value >= 1 ? `${value.toFixed(2)}x` : formatPercentShort((value - 1) * 100, true);
}

function formatImpact(value: number | null): string {
  return value == null ? "N/A" : `${Number(value.toFixed(1))}%`;
}

function formatPercentShort(value: number | null | undefined, signed = false): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const rounded = Number(value.toFixed(1));
  const prefix = signed && rounded > 0 ? "+" : "";
  return `${prefix}${rounded}%`;
}

async function withStatus<T>(ctx: Context, action: () => Promise<T>): Promise<T | null> {
  try {
    await ctx.replyWithChatAction("upload_photo");
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    await replyPanel(ctx, "⚠️", "Scan unavailable", [escapeHtml(message)], "Public indexes can lag briefly. Try again in a moment.");
    return null;
  }
}

async function replyPanel(ctx: Context, icon: string, title: string, lines: string[], hint?: string): Promise<void> {
  await ctx.reply([
    `<b>${icon} ${escapeHtml(title)}</b>`,
    ...(lines.length ? ["", ...lines] : []),
    ...(hint ? ["", `<i>${escapeHtml(hint)}</i>`] : []),
  ].join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

async function canManageChat(ctx: Context): Promise<boolean> {
  if (!ctx.chat || !ctx.from || ctx.chat.type === "private") return true;
  const member = await ctx.getChatMember(ctx.from.id);
  return member.status === "administrator" || member.status === "creator";
}

function displayName(ctx: Context): string {
  if (!ctx.from) return "Anonymous";
  return ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
}

function parseTimeframe(value: string): ChartTimeframe | null {
  const found = value.toLowerCase().match(/(?:^|\s)(auto|1m|5m|15m|1h|4h|1d)(?:\s|$)/u)?.[1];
  return isTimeframe(found) ? found : null;
}

function isTimeframe(value: unknown): value is ChartTimeframe {
  return typeof value === "string" && timeframes.includes(value as ChartTimeframe);
}

function cycleTimeframe(current: ChartTimeframe): ChartTimeframe {
  const index = timeframes.indexOf(current);
  return timeframes[(index + 1) % timeframes.length] ?? "auto";
}

function parseCompactUsd(value: string): number | null {
  const cleaned = value.trim().toLowerCase().replaceAll("$", "").replaceAll(",", "");
  if (["off", "none", "0"].includes(cleaned)) return 0;
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([kmb])?$/u);
  if (!match) return null;
  const base = Number(match[1]);
  const multiplier = match[2] === "k" ? 1e3 : match[2] === "m" ? 1e6 : match[2] === "b" ? 1e9 : 1;
  return Number.isFinite(base) ? base * multiplier : null;
}

function messageLink(chatId: string, messageId: number): string | null {
  if (!chatId.startsWith("-100") || messageId <= 0) return null;
  return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
}

function findSocial(scan: TokenScan, target: "x" | "telegram"): string | null {
  for (const item of scan.market.socials) {
    const platform = item.platform.toLowerCase();
    const matches = target === "x" ? platform === "x" || platform.includes("twitter") : platform.includes("telegram");
    if (!matches) continue;
    const url = socialUrl(platform, item.handle);
    if (url) return url;
  }
  return null;
}

function htmlLink(label: string, url: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function socialUrl(platform: string, handle: string): string | null {
  if (isHttpUrl(handle)) return handle;
  const cleaned = handle.replace(/^@/u, "").replace(/^\//u, "");
  if (!cleaned) return null;
  if (platform.includes("twitter") || platform === "x") return `https://x.com/${cleaned}`;
  if (platform.includes("telegram")) return `https://t.me/${cleaned}`;
  return null;
}

function isHttpUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

function titleCase(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function medal(index: number): string {
  return ["🥇", "🥈", "🥉"][index] ?? `${index + 1}.`;
}

function settingsText(settings: ChatSettings): string {
  const state = (value: boolean) => value ? "🟢" : "⚪️";
  return [
    "<b>⚙️ KapiScout Settings</b>",
    "└ 🟢 enabled · ⚪️ disabled", "",
    `<b>Scanner</b>`,
    `├ Auto scan  ${state(settings.contractEnabled)}`,
    `├ Chart      ${state(settings.showChart)} · ${settings.chartMetric === "market_cap" ? "MC" : "Price"} · ${settings.chartTimeframe.toUpperCase()}`,
    `├ Buttons    ${state(settings.buttonsEnabled)}`,
    `├ Minimum MC <b>${settings.minMarketCapUsd ? formatUsd(settings.minMarketCapUsd) : "Off"}</b>`,
    `└ Admin only ${state(settings.adminOnly)}`, "",
    `<b>Alerts</b>`,
    `├ Milestones ${state(settings.milestoneAlerts)} · ATH ${state(settings.athAlerts)}`,
    `├ DEX paid   ${state(settings.dexPaidAlerts)} · Liquidity ${state(settings.liquidityAlerts)}`,
    `├ Dev ${state(settings.devAlerts)} · Whales ${state(settings.whaleAlerts)} · Wallets ${state(settings.kolAlerts)}`,
    `├ Digest ${state(settings.digestEnabled)} · ${String(settings.digestHour).padStart(2,"0")}:00`,
    `└ Bridge ${state(settings.bridgeAlerts)} · min ${formatUsd(settings.bridgeMinUsd)}`,
  ].join("\n");
}

function helpText(): string {
  return [
    "<b>🐹 KapiScout · Robinhood Chain</b>",
    "└ Scan faster. Track honestly. Know if you can exit.", "",
    "Paste a contract address—no command required. The first scan permanently records the caller, entry MC and proof receipt.", "",
    "<b>🔎 Research</b>",
    "├ /chart · /holders · /holderchanges · /pnl",
    "└ /intel · /quote · /devhistory · /timeline", "",
    "<b>🏆 Calls</b>",
    "├ /calls · /active · /lb · /reallb",
    "└ /callers · /stats · /summary", "",
    "<b>🔔 Wallets</b>",
    "├ /addwallet <code>0x… Name</code>",
    "├ /namewallet <code>0x… New Name</code>",
    "├ /wallets · /removewallet",
    "└ /portfolio · /walletscore · /alert", "",
    "<b>🧾 Simulator & Radar</b>",
    "├ /paperbuy · /papersell · /paper",
    "└ /digest · /bridgeflow · /bridgealerts", "",
    "<b>⚙️ Setup</b>",
    "└ /settings · /showchart · /chartmode · /timeframe · /minmc", "",
    "<i>Prefix a contract with . to ignore it.</i>",
  ].join("\n");
}

function applyChartFallback(scan: TokenScan, chart: ChartSeries | null): void {
  const fallback = chart?.marketFallback;
  if (!fallback) return;
  scan.market.pairAddress ??= fallback.pairAddress ?? null;
  scan.market.priceUsd ??= fallback.priceUsd ?? null;
  scan.market.marketCapUsd ??= fallback.marketCapUsd ?? null;
  scan.market.fdvUsd ??= fallback.fdvUsd ?? null;
  scan.market.liquidityUsd ??= fallback.liquidityUsd ?? null;
  scan.market.volume24hUsd ??= fallback.volume24hUsd ?? null;
  scan.market.priceChange1h ??= fallback.priceChange1h ?? null;
  scan.market.priceChange24h ??= fallback.priceChange24h ?? null;
  scan.market.buys1h ??= fallback.buys1h ?? null;
  scan.market.sells1h ??= fallback.sells1h ?? null;
  scan.market.buys24h ??= fallback.buys24h ?? null;
  scan.market.sells24h ??= fallback.sells24h ?? null;
  scan.market.pairCreatedAt ??= fallback.pairCreatedAt ?? null;
}

async function within<T, F>(promise: Promise<T>, timeoutMs: number, fallback: F): Promise<T | F> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<F>((resolveFallback) => setTimeout(() => resolveFallback(fallback), timeoutMs)),
  ]);
}

export function claimRefresh(cooldowns: Map<string, number>, key: string, now = Date.now(), cooldownMs = 15_000): number {
  const last = cooldowns.get(key) ?? 0;
  const remaining = cooldownMs - (now - last);
  if (remaining > 0) return Math.ceil(remaining / 1_000);
  cooldowns.set(key, now);
  return 0;
}
