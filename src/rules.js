// rules.js – the Director's rule engine.
// Pure functions, no network, no randomness. Everything here is testable (see test/rules.test.js).
//
// Principle: the rules decide about money. The AI may only comment within these rules
// or (optionally) suggest a share inside the allowed window – never beyond it.

const MIN = 60 * 1000;

/**
 * Decides what the Director should do right now.
 *
 * @param {number} now  timestamp (ms)
 * @param {object} s    state:
 *   vaultSol        SOL sitting in the creator vault as fees (not collected yet)
 *   feedBudgetSol   SOL in the wallet already set aside for burns
 *   walletSol       SOL in the Director wallet (informational only)
 *   lastFeedAt      timestamp of the last feed (ms) or 0
 *   lastDipFeedAt   timestamp of the last dip feed (ms) or 0
 *   priceNow        current price (any unit, only the ratio matters) or null
 *   price1hAgo      price ~1 h ago or null
 *   mcapUsd         market cap in USD or null
 *   devBagTokens    size of the team's launch buy (tokens) – only used if devBagBurn is enabled
 *   devTranchesDone array of tranche indices already burned
 * @param {object} cfg  contents of director.config.json
 * @returns {Array<object>} actions: {type:'feed', sol, reason} | {type:'devburn', tokens, tranche} | {type:'wait', reason}
 */
export function decide(now, s, cfg) {
  const actions = [];

  // 1) How much SOL is available for the feed?
  //    New fees in the vault count only with the burn share (the rest is the lab share), plus
  //    the feed budget already set aside in the wallet (leftover of a capped feed).
  const available = round((s.vaultSol ?? 0) * cfg.feedShareOfFees + (s.feedBudgetSol ?? 0));

  // 2) Check triggers – order = priority
  const trigger = pickTrigger(now, s, cfg, available);

  if (trigger) {
    const sol = clampFeed(available, cfg);
    if (sol > 0) actions.push({ type: 'feed', sol, reason: trigger, collect: (s.vaultSol ?? 0) > 0 });
  }

  // 3) Team-stake tranches (independent of the fee feed; off by default)
  for (const t of dueDevTranches(s, cfg)) actions.push(t);

  if (actions.length === 0) {
    actions.push({ type: 'wait', reason: waitReason(now, s, cfg, available) });
  }
  return actions;
}

/** Which trigger applies? 'dip' > 'surge' > 'ritual' > null */
export function pickTrigger(now, s, cfg, available) {
  if (available < cfg.minFeedSol) return null;

  const dipCooldownOk = now - (s.lastDipFeedAt ?? 0) >= cfg.dipCooldownMinutes * MIN;
  if (isDip(s.priceNow, s.price1hAgo, cfg.dipTriggerPct) && dipCooldownOk) return 'dip';

  if (available >= cfg.surgeSol) return 'surge';

  if (now - (s.lastFeedAt ?? 0) >= cfg.cycleMinutes * MIN) return 'ritual';

  return null;
}

/** Has the price dropped by at least dipTriggerPct (compared to ~1 h ago)? */
export function isDip(priceNow, price1hAgo, dipTriggerPct) {
  if (!priceNow || !price1hAgo || price1hAgo <= 0) return false;
  return priceNow <= price1hAgo * (1 - dipTriggerPct / 100);
}

/** Clamp the feed amount to [minFeedSol, maxFeedSolPerCycle]; below the minimum → 0 */
export function clampFeed(sol, cfg) {
  if (!Number.isFinite(sol) || sol < cfg.minFeedSol) return 0;
  return round(Math.min(sol, cfg.maxFeedSolPerCycle));
}

/** Due team-stake tranches (market cap reached, not burned yet). Only when devBagBurn.enabled. */
export function dueDevTranches(s, cfg) {
  const out = [];
  const db = cfg.devBagBurn;
  if (!db?.enabled || !s.devBagTokens || s.devBagTokens <= 0) return out;
  if (s.mcapUsd == null) return out; // without a reliable number nothing happens
  const done = new Set(s.devTranchesDone ?? []);
  db.tranches.forEach((t, i) => {
    if (done.has(i)) return;
    if (s.mcapUsd >= t.mcapUsd) {
      out.push({ type: 'devburn', tranche: i, tokens: Math.floor(s.devBagTokens * t.pct / 100), mcapUsd: t.mcapUsd });
    }
  });
  return out;
}

/** Hard-limit an optional AI suggestion: share 0.5–1.0 of the available funds, never more. */
export function clampAdvisorShare(share) {
  const n = Number(share);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(1.0, Math.max(0.5, n));
}

function waitReason(now, s, cfg, available) {
  if (available < cfg.minFeedSol) return `fees below minimum (${available} < ${cfg.minFeedSol} SOL)`;
  const next = (s.lastFeedAt ?? 0) + cfg.cycleMinutes * MIN;
  const m = Math.max(0, Math.ceil((next - now) / MIN));
  return `next ritual feed in ${m} min`;
}

function round(x) { return Math.round(x * 1e9) / 1e9; }

/** Milestones – fixed thresholds. newMilestones() returns the ones reached but not yet logged. */
export const MILESTONES = [
  ...[0.5, 1, 2, 5, 10, 25].map(p => ({ id: `burn-${p}`, kind: 'burnPct', value: p, label: `${p} % of supply burned` })),
  ...[10, 50, 100, 500, 1000].map(n => ({ id: `count-${n}`, kind: 'burnCount', value: n, label: `${n} burns on the record` })),
  ...[1, 10, 50, 100].map(n => ({ id: `sol-${n}`, kind: 'solFed', value: n, label: `${n} SOL fed to the furnace` })),
];
export function newMilestones(s, done = []) {
  const doneSet = new Set(done);
  const pct = s.totalSupply ? s.burnedTokens / s.totalSupply * 100 : 0;
  return MILESTONES.filter(m => !doneSet.has(m.id) && (
    (m.kind === 'burnPct' && pct >= m.value) || (m.kind === 'burnCount' && (s.burnCount ?? 0) >= m.value) || (m.kind === 'solFed' && (s.feesFedSol ?? 0) >= m.value)));
}
