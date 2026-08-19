# KapiScout

KapiScout is a read-only Robinhood Chain Telegram scanner, chart bot, first-call tracker, security monitor and wallet-alert service. It uses public chain data and free API endpoints; it never requests wallet keys and does not execute trades.

## Kapi Intelligence

- **Kapi Reality Check:** conservative $100/$500/$1K/$10K exit estimates, price impact and an explainable ExitScore
- **Real PNL:** compares headline market-cap performance with an estimated executable $1K round trip
- **Real Alpha leaderboard:** ranks calls by estimated sellable return instead of screenshot ATH
- **Liquidity survival history:** five-minute snapshots, observed range and largest liquidity drop
- **Launch forensics:** first-block recipient/transaction distribution with a clearly labeled heuristic cluster score
- **Proof of Call:** a SHA-256 receipt binds the original chat, message, caller, CA, timestamp, MC and liquidity
- **Robinhood RWA Lens:** canonical stock-token verification, multiplier-aware fair value, premium/discount, halt state and corporate actions
- **Live Swap Quote:** read-only `eth_call` against Robinhood's official Uniswap v4 Quoter, with a clearly marked pool-model fallback
- **Wallet intelligence:** observed portfolio reconstruction, realized/unrealized PNL and an evidence-based smart-wallet score
- **Token memory:** holder snapshots, concentration changes, deployer launch history and a chronological event tape
- **Custom signals:** per-group value, MC, liquidity, direction and multi-wallet-window rules
- **Simulation and flow:** paper trading, daily intelligence digests and chain-native bridge flow radar

Reality Check calculations are estimates derived from reported pool liquidity using a conservative constant-product model. `/quote` separately attempts a live read-only Uniswap v4 quote. Concentrated liquidity, transfer taxes, routing and price movement can still change an eventual fill.

## Main experience

Open `/menu` for a visual Telegram dashboard. Research, calls, wallets, signals, paper trading, bridge flow, digests and quick settings are available as buttons. When an action needs a CA, wallet or amount, KapiScout sends a guided reply prompt—users do not need to memorize commands.

For the fastest path, paste an EVM contract address into a private chat or enabled group. KapiScout responds with one minimalist chart-led message containing:

- Live price, market cap, liquidity, volume, pair age and buy/sell flow
- Candlestick and volume chart with automatic timeframe selection
- Market-cap or price chart mode and manual timeframes
- Contract verification, holder count, top-ten concentration and top-holder distribution
- Immutable first caller, entry market cap, current return, ATH and scan count
- Refresh, PNL, holders, chart-only, DEX, explorer, original-call and social buttons

The refresh button edits the existing Telegram message. It never overwrites the original caller or entry market cap.

## Tracking and alerts

- Recent calls, active plays, ATH leaderboard and caller leaderboard
- Caller win rate, median return, best call and 2x/5x/10x hit counts
- Branded token, chart, PNL and group-summary images
- Automatic multiplier, new-ATH, DEX-paid and large liquidity-change alerts
- Transfer-based developer-sell and large-holder movement alerts
- Wallet alerts valued in USD from USDG settlement or live token-price/MC fallback
- Branded wallet/KOL alert images with token artwork, trade value, price, MC and liquidity
- Global KOL wallets plus chat-specific wallet labels and alerts
- Local SQLite persistence with automatic schema migrations

Developer and whale classifications are heuristics based on public creator, holder and ERC-20 transfer data. They are informational, not a guarantee of intent or safety.

## Data sources

- Robinhood Chain RPC, chain ID `4663`
- Robinhood Chain Blockscout
- DEX Screener free API for market snapshots and token metadata
- GeckoTerminal free API for Robinhood OHLCV candles
- Robinhood's read-only Stock Token APIs for canonical RWA metadata and market context
- Official Uniswap v4 PoolManager and Quoter deployments on Robinhood Chain

No Docker, Redis or paid database is required.

## Setup

Requires Node.js 22.5 or newer.

```powershell
npm install
Copy-Item .env.example .env
npm run build
npm start
```

Set the BotFather token only in `.env`. Do not put a real token in `.env.example` or commit it.

For plain contract detection in Telegram groups, disable privacy for the bot through BotFather (`/setprivacy`) or promote the bot to administrator.

## User commands

The Telegram command picker intentionally shows only `/menu`, `/scan`, `/portfolio`, `/calls`, `/paper`, `/settings` and `/help`. Every advanced action below remains available as a shortcut and through the button interface.

| Command | Purpose |
| --- | --- |
| Paste `0x…` | Scan and record the first call; no command required |
| `/chart CA [timeframe] [mc\|price]` | Generate a standalone chart |
| `/holders CA` | Top holders and concentration |
| `/holderchanges CA` | Holder-count and top-wallet changes from stored snapshots |
| `/pnl CA` | Current and ATH performance from first call |
| `/intel CA` | Reality Check, liquidity history, launch forensics, RWA lens and call receipt |
| `/quote CA [amount]` | Live on-chain Uniswap v4 exit quote, with labeled fallback |
| `/devhistory CA` | Originator/factory launch history and reputation heuristic |
| `/timeline CA` | First call, smart-money, liquidity and milestone event tape |
| `/calls` | Recent calls |
| `/active` | Calls ranked by current return |
| `/lb` | Calls ranked by ATH return |
| `/reallb` | Calls ranked by estimated executable $1K PNL |
| `/callers` | Caller ranking, win rate and hit counts |
| `/stats [@user]` | Detailed caller statistics |
| `/summary` | Branded group performance report |
| `/addwallet address label` | Track a wallet in this chat |
| `/namewallet address new name` | Rename a tracked wallet; future alerts use the new label |
| `/removewallet address` | Remove a custom wallet |
| `/wallets` | List global KOL and custom wallets |
| `/portfolio [wallet]` | Portfolio reconstructed from observed wallet trades |
| `/walletscore wallet` | Smart-wallet score from observed wins, PNL, volume and activity |
| `/alerts` | List custom smart-money signal rules |
| `/paper` or `/competition` | Open the button-driven Paper Arena |
| `/paperjoin` | Join the active chat competition |
| `/paperbuy CA amount` | Buy using an exact Uniswap v4 fill and estimated gas |
| `/papersell CA percent\|all` | Sell a position using an exact executable quote |
| `/paperlb` | Open live or frozen final standings |
| `/digest now` | Generate the group's last-24-hour intelligence digest |
| `/bridgeflow` | Show observed chain-native bridge flows from the last 24 hours |

Prefix a contract with `.` to prevent automatic scanning. A trailing `.` requests compact output; a trailing `,` requests detailed output.

Every command above has a short alias that is not shown in the Telegram picker:

| Alias | Original |
| --- | --- |
| `/c CA` | `/chart CA` |
| `/reality CA` | `/intel CA` |
| `/th CA` | `/holders CA` |
| `/holderdelta CA` | `/holderchanges CA` |
| `/plays` | `/active` |
| `/leaderboard` | `/lb` |
| `/realalpha` | `/reallb` |
| `/groupcard` | `/summary` |
| `/wscore wallet` | `/walletscore wallet` |
| `/deployer CA` | `/devhistory CA` |
| `/exitquote CA [amount]` | `/quote CA [amount]` |
| `/renamewallet 0x… New Name` | `/namewallet 0x… New Name` |
| `/competition` | `/paper` |

Scan-card inline buttons also toggle the chart metric (MC ↔ price) and cycle the timeframe (auto → 5m → 15m → 1h → 4h → 1d).

### Paper Arena accounting

An admin starts an event from `/paper` with a name, starting balance and duration. Every participant receives the same paper cash. Buys debit quoted notional plus estimated gas; sells credit executable proceeds minus gas. Open positions are valued by a fresh full-position Uniswap v4 exit quote, not spot price. Positions without an executable pool are conservatively worth $0. Rankings refresh at most once every 15 seconds, and the finalizer freezes equity, PNL and rank when the event ends.

## Admin settings

| Command | Purpose |
| --- | --- |
| `/settings` | Show current settings |
| `/contract on\|off` | Automatic CA detection |
| `/showchart on\|off` | Chart image on scans |
| `/buttons on\|off` | Inline controls |
| `/chartmode mc\|price` | Default chart metric |
| `/timeframe auto\|5m\|15m\|1h\|4h\|1d` | Default candles |
| `/minmc 25k\|off` | Minimum market cap for scans |
| `/adminonly on\|off` | Restrict scans to admins |
| `/compact on\|off` | Compact captions |
| `/detailed on\|off` | Expanded captions |
| `/milestones on\|off` | Multiplier alerts |
| `/athalerts on\|off` | New ATH alerts |
| `/dexalerts on\|off` | DEX-paid alerts |
| `/liqalerts on\|off` | Liquidity-change alerts |
| `/devalerts on\|off` | Creator-sell alerts |
| `/whalealerts on\|off` | Large-holder transfer alerts |
| `/kolalerts on\|off` | Global KOL wallet alerts |
| `/alert add Name direction=buy minvalue=5k maxmc=100k minlp=10k wallets=2 window=5` | Create a custom signal rule |
| `/alert remove ID` | Remove a custom signal rule |
| `/digest on\|off\|hour 9` | Schedule the daily group digest in server-local time |
| `/bridgealerts on\|off` | Enable chain-native bridge alerts |
| `/bridgemin 25k` | Set the minimum USD bridge-flow alert |

## Free-tier behavior

- Full scans use a 30-second token/security cache.
- Refreshes reuse token/security data and fetch fresh market data.
- OHLCV candles use a short cache and load concurrently with the token scan.
- Call markets refresh once per minute.
- Holder snapshots refresh every 15 minutes for up to 100 tracked tokens.
- Button refreshes are rate-limited to once every 15 seconds per message.
- Custom wallets default to five per chat.
- API failures fall back to the available scan card instead of blocking the response indefinitely.

Free public endpoints have no production SLA. A public launch should run behind a process manager such as PM2 or a native service and can later switch to a dedicated RPC without changing bot behavior.
