// state.js – der öffentliche Zustand (public/state.json), den die Website liest.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function emptyState(cfg, mode) {
  return {
    version: 1,
    mode,                       // 'live' | 'simulation'
    symbol: cfg.tokenSymbol,
    mint: null,
    updatedAt: 0,
    startedAt: 0,
    totalSupply: cfg.totalSupply,
    supplyNow: cfg.totalSupply, // aus getTokenSupply (live) bzw. simuliert
    burnedTokens: 0,            // Summe aller Burns durch den Director (Fees + Dev-Bag)
    feesFedSol: 0,              // SOL, die in Rückkäufe geflossen sind
    feesCollectedSol: 0,        // alle eingesammelten Creator-Fees
    feedBudgetSol: 0,           // im Wallet zurückgelegt für Burns
    labShareSol: 0,             // Lab-Anteil (Creator) insgesamt
    labPaidOutSol: 0,           // davon an TREASURY_WALLET überwiesen
    treasuryWallet: null,
    burnCount: 0,
    devBag: { tokens: 0, burned: 0, tranchesDone: [] },
    teamTokens: 0,              // Token im Director-Wallet, die nicht vom Bot gekauft wurden (Team-Anteil, wird nie verbrannt)
    priceSol: null,
    mcapUsd: null,
    vaultSol: 0,
    walletSol: 0,
    lastFeedAt: 0,
    lastDipFeedAt: 0,
    nextRitualAt: 0,
    priceHistory: [],           // [{ts, price}] letzte ~24 h
    log: [],                    // neueste zuerst
    milestones: [],             // erreichte Meilensteine [{id,label,ts}]
    rules: {                    // Auszug für die Website
      feedShareOfFees: cfg.feedShareOfFees,
      labShareOfFees: Math.round((1 - cfg.feedShareOfFees) * 1000) / 1000,
      cycleMinutes: cfg.cycleMinutes,
      dipTriggerPct: cfg.dipTriggerPct,
      surgeSol: cfg.surgeSol,
      minFeedSol: cfg.minFeedSol,
      maxFeedSolPerCycle: cfg.maxFeedSolPerCycle,
      devBagBurn: cfg.devBagBurn,
    },
  };
}

export function loadState(path, fallback) {
  const p = resolve(path);
  if (!existsSync(p)) return fallback;
  try { return { ...fallback, ...JSON.parse(readFileSync(p, 'utf8')) }; }
  catch { return fallback; }
}

export function saveState(path, state, maxLog = 500) {
  const p = resolve(path);
  mkdirSync(dirname(p), { recursive: true });
  const out = { ...state, log: state.log.slice(0, maxLog) };
  // atomar schreiben, damit die Website nie eine halbe Datei liest
  writeFileSync(p + '.tmp', JSON.stringify(out, null, 2));
  renameSync(p + '.tmp', p);
}

/** Preisverlauf pflegen und den Preis vor ~1 h zurückgeben. */
export function pushPrice(state, ts, price, keepMs = 24 * 3600 * 1000) {
  if (price != null && Number.isFinite(price)) state.priceHistory.push({ ts, price });
  state.priceHistory = state.priceHistory.filter(p => ts - p.ts <= keepMs);
  return priceAgo(state, ts, 3600 * 1000);
}

export function priceAgo(state, ts, ageMs) {
  const target = ts - ageMs;
  let best = null;
  for (const p of state.priceHistory) {
    if (p.ts <= target && (!best || p.ts > best.ts)) best = p;
  }
  return best ? best.price : null;
}

export function addLog(state, entry) {
  state.log.unshift(entry);
}
