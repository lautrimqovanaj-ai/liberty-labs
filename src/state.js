// state.js – the public state (public/state.json) that the website reads.
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
    supplyNow: cfg.totalSupply, // from getTokenSupply (live) or simulated
    burnedTokens: 0,            // total of all burns by the Director
    feesFedSol: 0,              // SOL that went into buybacks
    feesCollectedSol: 0,        // all collected creator fees
    feedBudgetSol: 0,           // set aside in the wallet for burns
    labShareSol: 0,             // lab share (creator) in total
    labPaidOutSol: 0,           // of which transferred to TREASURY_WALLET
    treasuryWallet: null,
    burnCount: 0,
    devBag: { tokens: 0, burned: 0, tranchesDone: [] },
    teamTokens: 0,              // tokens in the Director wallet that the bot did not buy (team allocation, never burned)
    priceSol: null,
    mcapUsd: null,
    vaultSol: 0,
    walletSol: 0,
    lastFeedAt: 0,
    lastDipFeedAt: 0,
    nextRitualAt: 0,
    priceHistory: [],           // [{ts, price}] last ~24 h
    log: [],                    // newest first
    milestones: [],             // reached milestones [{id,label,ts}]
    rules: {                    // excerpt for the website
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
  // write atomically so the website never reads a half-written file
  writeFileSync(p + '.tmp', JSON.stringify(out, null, 2));
  renameSync(p + '.tmp', p);
}

/** Maintain the price history and return the price ~1 h ago. */
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
