// rules.js – das Regelwerk des Directors.
// Reine Funktionen, kein Netz, kein Zufall. Alles hier ist testbar (siehe test/rules.test.js).
//
// Grundsatz: Die Regeln entscheiden über Geld. Die KI darf nur innerhalb dieser Regeln
// kommentieren oder (optional) einen Anteil im erlaubten Fenster vorschlagen – nie darüber hinaus.

const MIN = 60 * 1000;

/**
 * Entscheidet, was der Director jetzt tun soll.
 *
 * @param {number} now  Zeitstempel (ms)
 * @param {object} s    Zustand:
 *   vaultSol        SOL, die als Creator-Fee im Vault liegen (noch nicht eingesammelt)
 *   feedBudgetSol   SOL im Wallet, die bereits für Burns zurückgelegt sind
 *   walletSol       SOL im Director-Wallet (nur zur Info)
 *   lastFeedAt      Zeitstempel des letzten Feeds (ms) oder 0
 *   lastDipFeedAt   Zeitstempel des letzten Dip-Feeds (ms) oder 0
 *   priceNow        aktueller Preis (beliebige Einheit, nur Verhältnis zählt) oder null
 *   price1hAgo      Preis vor ~1 h oder null
 *   mcapUsd         Marktkapitalisierung in USD oder null
 *   devBagTokens    Grösse des Dev-Kaufs beim Launch (Token) – wird in Tranchen verbrannt
 *   devTranchesDone Array mit Indizes bereits verbrannter Tranchen
 * @param {object} cfg  Inhalt von director.config.json
 * @returns {Array<object>} Aktionen: {type:'feed', sol, reason} | {type:'devburn', tokens, tranche} | {type:'wait', reason}
 */
export function decide(now, s, cfg) {
  const actions = [];

  // 1) Wie viel SOL steht für den Feed zur Verfügung?
  //    Neue Fees im Vault zählen nur mit dem Burn-Anteil (Rest = Lab-Anteil), plus bereits
  //    zurückgelegtes Feed-Budget im Wallet (Rest eines gedeckelten Feeds).
  const available = round((s.vaultSol ?? 0) * cfg.feedShareOfFees + (s.feedBudgetSol ?? 0));

  // 2) Auslöser prüfen – Reihenfolge = Priorität
  const trigger = pickTrigger(now, s, cfg, available);

  if (trigger) {
    const sol = clampFeed(available, cfg);
    if (sol > 0) actions.push({ type: 'feed', sol, reason: trigger, collect: (s.vaultSol ?? 0) > 0 });
  }

  // 3) Dev-Bag-Tranchen (unabhängig vom Fee-Feed)
  for (const t of dueDevTranches(s, cfg)) actions.push(t);

  if (actions.length === 0) {
    actions.push({ type: 'wait', reason: waitReason(now, s, cfg, available) });
  }
  return actions;
}

/** Welcher Auslöser greift? 'dip' > 'surge' > 'ritual' > null */
export function pickTrigger(now, s, cfg, available) {
  if (available < cfg.minFeedSol) return null;

  const dipCooldownOk = now - (s.lastDipFeedAt ?? 0) >= cfg.dipCooldownMinutes * MIN;
  if (isDip(s.priceNow, s.price1hAgo, cfg.dipTriggerPct) && dipCooldownOk) return 'dip';

  if (available >= cfg.surgeSol) return 'surge';

  if (now - (s.lastFeedAt ?? 0) >= cfg.cycleMinutes * MIN) return 'ritual';

  return null;
}

/** Preis um mindestens dipTriggerPct gefallen (verglichen mit vor 1 h)? */
export function isDip(priceNow, price1hAgo, dipTriggerPct) {
  if (!priceNow || !price1hAgo || price1hAgo <= 0) return false;
  return priceNow <= price1hAgo * (1 - dipTriggerPct / 100);
}

/** Feed-Betrag auf [minFeedSol, maxFeedSolPerCycle] begrenzen; unter Minimum → 0 */
export function clampFeed(sol, cfg) {
  if (!Number.isFinite(sol) || sol < cfg.minFeedSol) return 0;
  return round(Math.min(sol, cfg.maxFeedSolPerCycle));
}

/** Fällige Dev-Bag-Tranchen (Marktkapitalisierung erreicht, noch nicht verbrannt) */
export function dueDevTranches(s, cfg) {
  const out = [];
  const db = cfg.devBagBurn;
  if (!db?.enabled || !s.devBagTokens || s.devBagTokens <= 0) return out;
  if (s.mcapUsd == null) return out; // ohne verlässliche Zahl passiert nichts
  const done = new Set(s.devTranchesDone ?? []);
  db.tranches.forEach((t, i) => {
    if (done.has(i)) return;
    if (s.mcapUsd >= t.mcapUsd) {
      out.push({ type: 'devburn', tranche: i, tokens: Math.floor(s.devBagTokens * t.pct / 100), mcapUsd: t.mcapUsd });
    }
  });
  return out;
}

/** Optionaler KI-Vorschlag hart begrenzen: Anteil 0.5–1.0 der verfügbaren Mittel, nie mehr. */
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

/** Meilensteine – feste Schwellen. Gibt neue (noch nicht erreichte) Meilensteine zurück. */
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
