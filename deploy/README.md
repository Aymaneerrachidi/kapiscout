# Running the Kapiscout bot 24/7 (free)

The bot is a long-lived process: it long-polls Telegram, holds a WebSocket to
Robinhood Chain, runs six background schedulers, and writes SQLite to disk.
That rules out serverless hosts (Vercel included) — it needs a machine that
stays up.

**Oracle Cloud "Always Free"** gives you one permanently free ARM VM, which is
far more than this bot needs. No code changes, and every feature keeps working.

---

## 1. Create the free VM

1. Sign up at <https://www.oracle.com/cloud/free/>. A card is required for
   identity verification; the Always Free resources are not charged.
2. **Compute → Instances → Create instance**
   - Image: **Ubuntu 24.04**
   - Shape: **VM.Standard.A1.Flex** (Ampere ARM), **2 OCPU / 12 GB RAM**
     — that is the current Always Free ceiling.
   - Add your SSH public key.
3. Create, then copy the instance's **public IP**.

No inbound ports are needed. The bot only makes outbound connections, so you
can leave the default security list alone.

## 2. Install the bot

SSH in and run the setup script:

```bash
ssh ubuntu@<YOUR_PUBLIC_IP>

curl -fsSL https://raw.githubusercontent.com/Aymaneerrachidi/kapiscout/full-project/deploy/setup.sh | sudo bash
```

It installs Node 22 (needed for `node:sqlite`), clones the repo to
`/opt/kapiscout`, builds, and installs a systemd service. On the first run it
stops and tells you to add your token.

## 3. Add your environment

```bash
sudo nano /opt/kapiscout/.env
```

Paste your values — this is the same file you have locally. At minimum set
`TELEGRAM_BOT_TOKEN` to the new bot's token. Leave `DB_PATH` pointing at
`/opt/kapiscout/data/kapiscout.db` so state survives restarts and redeploys.

Then start it:

```bash
sudo systemctl start kapiscout
```

## 4. Confirm it's alive

```bash
sudo systemctl status kapiscout     # should read "active (running)"
journalctl -u kapiscout -f          # live logs
```

You're looking for:

```
Kapiscout is online as @<yourbot> on Robinhood Chain <id>.
```

Message the bot `/menu` in Telegram to confirm.

---

## Staying online

`Restart=always` in the unit file brings the bot back after a crash, and
`systemctl enable` (done by the script) restarts it after a reboot. Your laptop
is irrelevant once this is running.

## Updating after a push

```bash
curl -fsSL https://raw.githubusercontent.com/Aymaneerrachidi/kapiscout/full-project/deploy/setup.sh | sudo bash
```

Re-running is safe: it pulls, rebuilds, and restarts, keeping `.env` and the
database intact.

## Useful commands

| Command | What it does |
|---|---|
| `sudo systemctl restart kapiscout` | Restart the bot |
| `sudo systemctl stop kapiscout` | Stop it |
| `journalctl -u kapiscout -n 200` | Last 200 log lines |
| `journalctl -u kapiscout -f` | Follow logs |

## If the bot doesn't start

- **`409 Conflict` in the logs** — the bot is polling somewhere else too. Stop
  it on your laptop; only one process may poll a given token.
- **`node:sqlite` missing** — Node is older than 22.5. Check with `node -v`.
- **Out of memory during build** — `sharp` compiles native code. The 12 GB
  Always Free shape is plenty; a 1 GB shape is not.
