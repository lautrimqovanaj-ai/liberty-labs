# Liberty Labs – Director-Bot

Der Director sammelt die Creator-Fees deines Pump.fun-Coins ein und teilt sie auf: 50 % kaufen $LIBERTY am Markt und verbrennen die Token, 50 % gehen sofort an dein Treasury-Wallet. Jeder Burn und jede Auszahlung landet mit Transaktions-Signatur in `public/state.json`, das die Website liest.

Der Bot kann **nur vier Dinge**: Fees einsammeln, deinen Anteil überweisen, kaufen, verbrennen. Eine Verkaufsfunktion gibt es im Code nicht.

## Wie es abläuft

1. Trade auf pump.fun → 0,300 % Creator-Fee landet im Creator-Vault (Quelle: pump.fun/docs/fees, Stand 20.05.2026).
2. Der Bot prüft jede Minute den Vault und die Regeln in `director.config.json`.
3. Greift eine Regel (Minuten-Takt sobald Budget ≥ 0,02 SOL, Dip −15 %, Burn-Budget ≥ 1 SOL), dann: Fees einsammeln → 50 % an `TREASURY_WALLET` überweisen → mit den anderen 50 % kaufen → mit `BurnChecked` verbrennen.
4. Eintrag mit Signaturen ins Log; optional Kommentar von der Claude-API; optional Webhook.

Die KI schreibt nur den Kommentar. Über Geld entscheiden ausschliesslich die Regeln (getestet in `test/rules.test.js`).

## Voraussetzungen

- Node.js 20 oder neuer
- Ein HTTPS-RPC, der Transaktionen senden darf (siehe `.env.example`)
- Das Creator-Wallet des Coins als Schlüsseldatei. Nimm ein eigenes Wallet nur für diesen Coin.

## Einrichten

```bash
npm install
cp .env.example .env      # ausfüllen: SOLANA_RPC_URL, MINT, KEYPAIR_PATH, TREASURY_WALLET
npm test                  # Regeln prüfen (13 Tests)
npm run simulate          # 72 h offline durchspielen → public/state.json (mode: simulation)
npm run once              # EIN echter Takt (zum Prüfen, mit wenig SOL beginnen)
npm start                 # Dauerbetrieb
```

Für den Dauerbetrieb auf einem Server: `pm2 start src/index.js --name director` oder ein systemd-Dienst. Der Bot muss laufen, sonst gibt es keine Burns – die Fees bleiben aber im Vault liegen und werden beim nächsten Start gefüttert.

## Regeln anpassen

Alles in `director.config.json`:

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `feedShareOfFees` | 0.5 | Anteil der Fees, der in Burns geht (0.5 = 50 %); der Rest geht an `TREASURY_WALLET` |
| `cycleMinutes` | 1 | Feed jede Minute, sobald das Burn-Budget ≥ `minFeedSol` ist |
| `dipTriggerPct` | 15 | Preis −15 % in 1 h → sofort füttern |
| `dipCooldownMinutes` | 5 | Höchstens ein Dip-Feed pro 5 Minuten |
| `surgeSol` | 1.0 | Burn-Budget ≥ 1 SOL → sofort füttern |
| `minFeedSol` / `maxFeedSolPerCycle` | 0.02 / 5 | Unter dem Minimum warten (Netzgebühren), über dem Maximum Rest im nächsten Takt |
| `reserveSol` | 0.01 | Bleibt im Wallet für Transaktionsgebühren |
| `slippagePct` | 5 | Slippage beim Kauf |
| `devBagBurn.enabled` | false | AUS: Dein Dev-Kauf bleibt bei dir. Der Bot verbrennt nur, was er selbst kauft. |

Die Zahlen sind Vorschläge. Was du auf der Website versprichst, muss hier drinstehen – die Seite zeigt die Werte aus `state.json`.

## Website verbinden

Die Website liest `./state.json` neben `index.html`. Zwei Wege:

- **Gleicher Server:** Bot schreibt `public/state.json`, Webserver liefert den Ordner `public/` zusammen mit `index.html` aus.
- **Vercel/Netlify:** Bot schreibt die Datei und pusht sie z. B. per Cron ins Repo, oder du legst `stateUrl` in `index.html` (CONFIG) auf eine öffentliche URL, die der Bot beschreibt (S3, GitHub Raw, eigener Endpoint).

Sobald `state.json` `"mode": "live"` hat, verschwindet der Simulations-Hinweis und die Belege verlinken auf Solscan.

## Was du prüfen musst, bevor du live gehst

- Die API `https://fun-block.pump.fun` stammt aus dem offiziellen Repo `pump-fun/pump-fun-skills` (letzter Stand dort: April 2026). Teste `npm run once` mit kleinem Betrag, bevor der Bot dauerhaft läuft.
- Der Vault-Stand wird aus der PDA `["creator-vault", creator]` gelesen (Dokumentation im gleichen Repo). Wenn du auf pump.fun eine Fee-Aufteilung (Sharing Config) einrichtest, funktioniert diese Berechnung nicht mehr – dann lass sie weg.
- `usd_market_cap` kommt von `frontend-api-v3.pump.fun`. Fällt die API aus, passiert in dem Takt kein Dev-Bag-Burn und keine Dip-Prüfung; der Ritual-Feed läuft weiter.

## Sicherheit

- Der Schlüssel liegt im Klartext auf deinem Server. Nur ein Wallet, nur dieser Coin, nie Gelder darauf lagern, die du nicht verlieren darfst.
- `.env` und `creator-wallet.json` niemals ins Repo committen (`.gitignore` ist gesetzt).
- Der Bot loggt nie Schlüssel.

## Dein Dev-Kauf

Der Bot verbrennt nur Token, die er selbst mit Fees gekauft hat. Dein Dev-Kauf aus dem Launch bleibt unangetastet. Empfehlung: Schick diese Token nach dem Launch in dein Treasury-Wallet, dann hält das Director-Wallet zwischen den Burns keine Token und die Website zeigt den Team-Anteil sauber getrennt an.
