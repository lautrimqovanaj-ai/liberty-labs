# Liberty Labs – Director bot

*Deutsche Anleitung: [README.de.md](README.de.md)*

The Director collects the creator fees of the $LIBERTY coin on pump.fun and splits them: **50 % buys $LIBERTY on the open market and burns it, 50 % is paid to the lab treasury wallet.** Every burn and every payout is written with its transaction signature to `public/state.json`, which the website reads. The website itself is served by the same process.

The bot can do **exactly four things**: collect fees, pay the lab share, buy, burn. There is no sell function in the code.

## How it works

1. A trade happens on pump.fun → 0.300 % creator fee lands in the on-chain creator vault (source: [pump.fun/docs/fees](https://pump.fun/docs/fees), last updated 20 May 2026).
2. Every minute the bot reads the vault and checks the rules in `director.config.json`.
3. When a rule fires (ritual feed as soon as the burn budget covers 0.02 SOL, dip −15 % in 1 h, burn budget ≥ 1 SOL), it: collects the fees → transfers 50 % to `TREASURY_WALLET` → buys with the other 50 % → burns with the SPL `BurnChecked` instruction.
4. The entry goes into the log with all signatures; optionally a log line from the Claude API; optionally a webhook post.
5. Milestones (0.5 / 1 / 2 / 5 / 10 / 25 % of supply burned, 10 / 50 / 100 / 500 / 1000 burns, 1 / 10 / 50 / 100 SOL fed) are detected by the bot and celebrated by the website automatically.

The AI only writes the log line. Money is decided exclusively by the rules (`src/rules.js`, tested in `test/rules.test.js`).

## The team's own tokens

The bot burns only tokens it bought with fees. The team's launch buy is not part of the burn program: it is held in the public treasury wallet, not locked, and the bot never touches it. The website shows the amount under *Team allocation*.

## Requirements

- Node.js 20 or newer
- An HTTPS RPC that may send transactions (see `.env.example`)
- The creator wallet of the coin as a key file or as `KEYPAIR_BASE58`. Use a dedicated wallet for this coin only.

## Setup

```bash
npm install
cp .env.example .env      # fill in: SOLANA_RPC_URL, MINT, KEYPAIR_PATH or KEYPAIR_BASE58, TREASURY_WALLET
npm test                  # rule engine tests
npm run simulate          # 72 h offline → public/state.json (mode: simulation)
npm run once              # ONE real tick (to verify, start with little SOL)
npm start                 # continuous operation + website on $PORT
```

`npm start` without `MINT` runs in preview mode: the website is served with simulated data (clearly labelled), so the link exists before the coin does. Set `MINT` after the launch and restart.

### Railway / Render

Deploy the repo, generate a public domain, set the variables `SOLANA_RPC_URL`, `KEYPAIR_BASE58`, `TREASURY_WALLET` and, after the launch, `MINT`. `PORT` is set by the platform. One instance = bot + website + live data.

### Separate static host (Vercel, Cloudflare Pages)

Upload `public/index.html` and set `CONFIG.stateUrl` in it to `https://<your-bot-host>/state.json`. The built-in server allows cross-origin reads.

## Rules

Everything lives in `director.config.json`:

| Key | Default | Meaning |
|---|---|---|
| `feedShareOfFees` | 0.5 | Share of every collected fee that buys and burns (0.5 = 50 %); the rest goes to `TREASURY_WALLET` |
| `cycleMinutes` | 1 | Feed every minute as soon as the burn budget covers `minFeedSol` |
| `dipTriggerPct` | 15 | Price −15 % within 1 h → feed immediately |
| `dipCooldownMinutes` | 5 | At most one dip feed per 5 minutes |
| `surgeSol` | 1.0 | Burn budget ≥ 1 SOL → feed immediately |
| `minFeedSol` / `maxFeedSolPerCycle` | 0.02 / 5 | Below the minimum wait (network fees would eat the burn); above the maximum the rest waits for the next tick |
| `reserveSol` | 0.01 | Stays in the wallet for transaction fees |
| `slippagePct` | 5 | Slippage on buys |
| `devBagBurn.enabled` | false | OFF: the team's launch buy is never burned by the bot |

The numbers are suggestions. Whatever the website promises must match this file – the site reads the values from `state.json`.

## Before going live

- The API `https://fun-block.pump.fun` comes from the official repo [pump-fun/pump-fun-skills](https://github.com/pump-fun/pump-fun-skills) (state there: April 2026). Test `npm run once` with a small amount before running the bot continuously.
- The vault balance is read from the PDA `["creator-vault", creator]` (documented in the same repo). If you set up a fee sharing config on pump.fun, this calculation no longer applies.
- `usd_market_cap` comes from `frontend-api-v3.pump.fun`. If that API is down, the dip check is skipped for that tick; the ritual feed keeps running.

## Security

- The key sits in plain text on your server (or in the platform's variables). One wallet, one coin, never store funds there that you cannot afford to lose.
- Never commit `.env` or the wallet file (`.gitignore` covers both).
- The bot never logs keys.

## Disclaimer

$LIBERTY is an experimental memecoin. Nothing here is financial advice. Burns are as large as the fees. Not affiliated with any government, agency or public figure, nor with pump.fun.
