// config.js – lädt director.config.json und die Umgebungsvariablen (.env).
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadConfig(root = process.cwd()) {
  loadDotEnv(resolve(root, '.env'));
  const cfg = JSON.parse(readFileSync(resolve(root, 'director.config.json'), 'utf8'));
  const env = {
    rpcUrl: process.env.SOLANA_RPC_URL || '',
    mint: process.env.MINT || '',
    keypairPath: process.env.KEYPAIR_PATH || '',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    webhookUrl: process.env.WEBHOOK_URL || '',
    pollMinutes: Number(process.env.POLL_MINUTES || 5),
    devBagTokens: Number(process.env.DEV_BAG_TOKENS || 0),
    treasuryWallet: process.env.TREASURY_WALLET || '',
    repoUrl: process.env.REPO_URL || '',
  };
  return { cfg, env };
}

/** Minimaler .env-Loader (KEY=VALUE, # Kommentare), ohne Zusatzpaket. */
function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

/** Prüft, ob alles für den Live-Betrieb da ist. Gibt Liste fehlender Dinge zurück. */
export function missingForLive(env) {
  const missing = [];
  if (!env.rpcUrl) missing.push('SOLANA_RPC_URL');
  if (!env.mint) missing.push('MINT');
  if (!env.keypairPath && !process.env.KEYPAIR_BASE58) missing.push('KEYPAIR_PATH oder KEYPAIR_BASE58');
  return missing;
}
