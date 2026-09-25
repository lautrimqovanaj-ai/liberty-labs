import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, isDip, clampFeed, dueDevTranches, clampAdvisorShare, pickTrigger, newMilestones } from '../src/rules.js';

const cfg = JSON.parse(readFileSync(new URL('../director.config.json', import.meta.url)));
const H = 60 * 60 * 1000;
const now = 1_800_000_000_000;

const base = { vaultSol: 0, feedBudgetSol: 0, walletSol: 0, lastFeedAt: now - 2 * H, lastDipFeedAt: 0, priceNow: 1, price1hAgo: 1, mcapUsd: 1000, devBagTokens: 0, devTranchesDone: [] };

test('zu wenig Fees → warten', () => {
  const a = decide(now, { ...base, vaultSol: 0.005 }, cfg);
  assert.equal(a[0].type, 'wait');
});

test('Ritual-Feed nach Ablauf des Zyklus: 50 % der neuen Fees (Rest = Lab-Anteil)', () => {
  const a = decide(now, { ...base, vaultSol: 0.3 }, cfg);
  assert.deepEqual(a, [{ type: 'feed', sol: 0.15, reason: 'ritual', collect: true }]);
});

test('kein Ritual-Feed vor Ablauf des Zyklus', () => {
  const a = decide(now, { ...base, vaultSol: 0.3, lastFeedAt: now - 20 * 1000 }, cfg);
  assert.equal(a[0].type, 'wait');
});

test('Dip (−15 %) löst sofort aus, auch mitten im Zyklus', () => {
  const a = decide(now, { ...base, vaultSol: 0.3, lastFeedAt: now - 20 * 1000, priceNow: 0.84, price1hAgo: 1 }, cfg);
  assert.equal(a[0].reason, 'dip');
});

test('Dip-Cooldown wird eingehalten', () => {
  const s = { ...base, vaultSol: 0.3, lastFeedAt: now - 20 * 1000, lastDipFeedAt: now - 60 * 1000, priceNow: 0.8, price1hAgo: 1 };
  assert.equal(pickTrigger(now, s, cfg, 0.3), null);
});

test('Surge: viele Fees → sofort füttern (Burn-Anteil ≥ surgeSol)', () => {
  const a = decide(now, { ...base, vaultSol: 2.5, lastFeedAt: now - 20 * 1000 }, cfg);
  assert.equal(a[0].reason, 'surge');
  assert.equal(a[0].sol, 1.25);
  const b = decide(now, { ...base, vaultSol: 1.5, lastFeedAt: now - 20 * 1000 }, cfg);
  assert.equal(b[0].type, 'wait');
});

test('Feed ist pro Zyklus begrenzt (maxFeedSolPerCycle)', () => {
  const a = decide(now, { ...base, vaultSol: 42 }, cfg);
  assert.equal(a[0].sol, cfg.maxFeedSolPerCycle);
});

test('Zurückgelegtes Feed-Budget wird voll verwendet, Lab-Anteil nie', () => {
  const a = decide(now, { ...base, feedBudgetSol: 0.2, walletSol: 5 }, cfg);
  assert.deepEqual(a, [{ type: 'feed', sol: 0.2, reason: 'ritual', collect: false }]);
});

test('isDip: Grenzfälle', () => {
  assert.equal(isDip(0.85, 1, 15), true);
  assert.equal(isDip(0.86, 1, 15), false);
  assert.equal(isDip(null, 1, 15), false);
  assert.equal(isDip(1, 0, 15), false);
});

test('clampFeed: unter Minimum → 0, über Maximum → Maximum', () => {
  assert.equal(clampFeed(0.01, cfg), 0);
  assert.equal(clampFeed(99, cfg), cfg.maxFeedSolPerCycle);
  assert.equal(clampFeed(NaN, cfg), 0);
});

test('Dev-Bag-Burn ist standardmässig AUS – der Dev-Kauf bleibt beim Team', () => {
  const s = { ...base, devBagTokens: 20_000_000, mcapUsd: 5_000_000, devTranchesDone: [] };
  assert.deepEqual(dueDevTranches(s, cfg), []);
});

test('Dev-Bag-Tranchen (nur wenn eingeschaltet): nur fällige, nur einmal, ohne mcap nichts', () => {
  const on = { ...cfg, devBagBurn: { ...cfg.devBagBurn, enabled: true } };
  const s = { ...base, devBagTokens: 20_000_000, mcapUsd: 260_000, devTranchesDone: [0] };
  const t = dueDevTranches(s, on);
  assert.deepEqual(t.map(x => x.tranche), [1]);
  assert.equal(t[0].tokens, 5_000_000);
  assert.deepEqual(dueDevTranches({ ...s, mcapUsd: null }, on), []);
});

test('KI-Vorschlag wird hart begrenzt (0.5–1.0)', () => {
  assert.equal(clampAdvisorShare(0.1), 0.5);
  assert.equal(clampAdvisorShare(7), 1.0);
  assert.equal(clampAdvisorShare('abc'), 1.0);
});

test('Es gibt keinen Verkaufs-Pfad in den Regeln', () => {
  const src = readFileSync(new URL('../src/rules.js', import.meta.url), 'utf8');
  assert.equal(/type:\s*'sell'/.test(src), false);
});

test('Meilensteine: nur neue, nur erreichte', () => {
  const s = { totalSupply: 1e9, burnedTokens: 21e6, burnCount: 55, feesFedSol: 12 };
  const ids = newMilestones(s, ['burn-0.5', 'count-10']).map(m => m.id);
  assert.deepEqual(ids, ['burn-1', 'burn-2', 'count-50', 'sol-1', 'sol-10']);
  assert.deepEqual(newMilestones({ totalSupply: 1e9, burnedTokens: 0, burnCount: 0, feesFedSol: 0 }), []);
});
