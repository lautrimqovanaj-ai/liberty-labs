#!/usr/bin/env node
// index.js – the Director. Every tick:
//   read state → rules decide → (collect fees → pay lab share → buy → burn) → receipt into the log → write state.json.
//
//   npm start            live mode, one tick every POLL_MINUTES (default 1); also serves public/ (website + state.json)
//   npm run once         exactly one tick (e.g. from cron)
//   npm run simulate     simulate 72 hours offline → public/state.json (mode: "simulation")

import { loadConfig, missingForLive } from './config.js';
import { existsSync } from 'node:fs';
import { decide, newMilestones } from './rules.js';
import { emptyState, loadState, saveState, pushPrice, addLog } from './state.js';
import { narrate, pickScientist } from './narrator.js';
import { makeMockChain, rng } from './chain.mock.js';
import { startServer } from './server.js';

const args = parseArgs(process.argv.slice(2));
const { cfg, env } = loadConfig();
const statePath = cfg.output.statePath;

main().catch(e => { console.error('FATAL', e); process.exit(1); });

async function main() {
  if (args.simulate) return simulate(Number(args.hours || 72));

  // Always serve the website + state.json (even before launch), so the link exists before the coin does.
  if (!args.once && process.env.SERVE !== '0') startServer({ root: 'public' });

  const missing = missingForLive(env);
  if (missing.length) {
    console.error(`Not live yet – missing: ${missing.join(', ')} (see .env.example). The website runs in preview mode.`);
    if (args.once) process.exit(2);
    if (env.mint) return pendingLoop();                    // coin exists, key not set yet: honest zero state + live market data
    // Preview mode: provide simulation data if there is no state.json yet
    if (!existsSync(statePath)) await simulate(72);
    return; // the server keeps running; restart after setting MINT
  }
  const { makeChain, loadKeypair } = await import('./chain.js');
  const keypair = loadKeypair(env.keypairPath);
  const chain = makeChain({ rpcUrl: env.rpcUrl, keypair, mint: env.mint, cfg });
  console.log(`Director online · wallet ${chain.owner} · mint ${env.mint}`);

  const loaded = loadState(statePath, null);
  const state = loaded && loaded.mode !== 'simulation' ? loaded : emptyState(cfg, 'live');   // never carry simulated numbers into live mode
  state.mode = 'live'; state.mint = env.mint; state.wallet = chain.owner; state.treasuryWallet = env.treasuryWallet || null; state.repo = env.repoUrl || null;
  if (!state.startedAt) state.startedAt = Date.now();
  if (env.devBagTokens && !state.devBag.tokens) state.devBag.tokens = env.devBagTokens;

  do {
    try { await tick(chain, state, Date.now(), Math.random); }
    catch (e) { console.error('tick failed:', e.message); }
    if (args.once) break;
    await sleep(env.pollMinutes * 60_000);
  } while (true);
}

/** Pending mode: the coin is live but the Director has no key yet. No burns are claimed; market data is refreshed. */
async function pendingLoop() {
  const prev = loadState(statePath, null);
  const state = prev && prev.mode !== 'simulation' ? prev : emptyState(cfg, 'pending');
  state.mode = 'pending'; state.mint = env.mint; state.treasuryWallet = env.treasuryWallet || null; state.repo = env.repoUrl || null;
  state.log = state.log.filter(e => e.mode !== 'simulation'); state.milestones = state.milestones.filter(m => !m.simulated);
  if (!state.startedAt) state.startedAt = Date.now();
  do {
    try {
      const r = await fetch(`https://frontend-api-v3.pump.fun/coins-v2/${env.mint}`, { headers: { accept: 'application/json' } });
      if (r.ok) { const c = await r.json(); const m = Number(c.usd_market_cap); if (Number.isFinite(m)) { state.mcapUsd = m; pushPrice(state, Date.now(), m); } }
    } catch (e) { console.warn('coin api failed:', e.message); }
    state.updatedAt = Date.now();
    saveState(statePath, state, cfg.output.maxLogEntries);
    log(`pending · coin ${env.mint} · mcap ${state.mcapUsd ?? 'n/a'} USD · waiting for KEYPAIR_BASE58`);
    await sleep(env.pollMinutes * 60_000);
  } while (true);
}

/** One tick. Returns the executed actions. */
export async function tick(chain, state, now, rand) {
  const snap = await chain.snapshot();
  const price1hAgo = pushPrice(state, now, snap.priceProxy);
  Object.assign(state, { vaultSol: snap.vaultSol, walletSol: snap.walletSol, supplyNow: snap.supplyNow, mcapUsd: snap.mcapUsd, teamTokens: Math.floor(snap.walletTokens ?? 0), updatedAt: now });

  const actions = decide(now, {
    vaultSol: snap.vaultSol, feedBudgetSol: state.feedBudgetSol, walletSol: snap.walletSol, lastFeedAt: state.lastFeedAt, lastDipFeedAt: state.lastDipFeedAt,
    priceNow: snap.priceProxy, price1hAgo, mcapUsd: snap.mcapUsd,
    devBagTokens: state.devBag.tokens, devTranchesDone: state.devBag.tranchesDone,
  }, cfg);

  for (const a of actions) {
    if (a.type === 'wait') { log(`wait · ${a.reason}`); continue; }
    if (a.type === 'feed') await doFeed(chain, state, now, a, { price1hAgo, priceNow: snap.priceProxy }, rand);
    if (a.type === 'devburn') await doDevBurn(chain, state, now, a, rand);
  }

  // Detect milestones and write them to the log – the website celebrates them automatically
  for (const m of newMilestones(state, state.milestones.map(x => x.id))) {
    const entry = { ts: now, type: 'milestone', reason: 'milestone', id: m.id, label: m.label, tokens: 0, sol: 0, symbol: cfg.tokenSymbol, scientist: 'Chief Kowalski', mode: chain.mode, burnCountTotal: state.burnCount, burnedPct: round(state.burnedTokens / state.totalSupply * 100, 3), sigs: {}, note: `Milestone reached: ${m.label}. Logged, lit, and on the record.` };
    state.milestones.push({ id: m.id, label: m.label, ts: now });
    addLog(state, entry); log(`MILESTONE ${m.label}`); await webhook(entry);
  }
  state.nextRitualAt = state.lastFeedAt + cfg.cycleMinutes * 60_000;
  saveState(statePath, state, cfg.output.maxLogEntries);
  return actions;
}

async function doFeed(chain, state, now, a, ctx, rand) {
  const sigs = {};
  if (a.collect && state.vaultSol > 0) {                                      // 1) fees into the wallet, then split
    sigs.collect = await chain.collectFees();
    const collected = state.vaultSol;
    const burnPart = collected * cfg.feedShareOfFees;
    const labPart = collected - burnPart;
    state.feesCollectedSol += collected;
    state.feedBudgetSol += burnPart;
    state.labShareSol += labPart;
    state.vaultSol = 0;
    if (labPart > 0.001 && state.treasuryWallet) {                             //    pay out the lab share immediately
      sigs.payout = await chain.transferSol(state.treasuryWallet, labPart);
      state.labPaidOutSol += labPart;
    }
  }
  const sol = round(Math.min(a.sol, state.feedBudgetSol), 6);
  if (sol < cfg.minFeedSol) { log(`feed skipped – budget ${sol} SOL below minimum`); return; }
  const { signature: buySig, tokensBought } = await chain.buy(sol);            // 2) buy
  sigs.buy = buySig;
  if (tokensBought <= 0) throw new Error('Buy returned 0 tokens – burn aborted');
  sigs.burn = await chain.burn(tokensBought);                                  // 3) burn
  state.feedBudgetSol = Math.max(0, round(state.feedBudgetSol - sol, 9));
  a.sol = sol;

  state.feesFedSol += a.sol;
  state.burnedTokens += tokensBought;
  state.supplyNow -= tokensBought;
  state.burnCount += 1;
  state.lastFeedAt = now;
  if (a.reason === 'dip') state.lastDipFeedAt = now;

  const dipPct = ctx.price1hAgo && ctx.priceNow ? (1 - ctx.priceNow / ctx.price1hAgo) * 100 : null;
  const entry = {
    ts: now, type: 'feed', reason: a.reason, sol: round(a.sol, 6), tokens: Math.floor(tokensBought),
    symbol: cfg.tokenSymbol, scientist: pickScientist(rand), dipPct: a.reason === 'dip' ? dipPct : null,
    surgeSol: cfg.surgeSol, mcapUsd: state.mcapUsd, sigs, mode: chain.mode,
    burnCountTotal: state.burnCount, burnedPct: round(state.burnedTokens / state.totalSupply * 100, 3),
  };
  entry.note = await narrate(entry, { apiKey: env.anthropicKey, model: cfg.narrator.model, mode: cfg.narrator.mode, rand });
  addLog(state, entry);
  log(`FEED ${a.reason} · ${a.sol} SOL → ${Math.floor(tokensBought).toLocaleString('en-US')} ${cfg.tokenSymbol} burned · ${sigs.burn}`);
  await webhook(entry);
}

async function doDevBurn(chain, state, now, a, rand) {
  const have = await chain.tokenBalance();
  const tokens = Math.min(a.tokens, Math.floor(have));
  if (tokens <= 0) { log('devburn skipped – no team tokens in wallet'); return; }
  const sig = await chain.burn(tokens);
  state.devBag.burned += tokens; state.devBag.tranchesDone.push(a.tranche);
  state.burnedTokens += tokens; state.supplyNow -= tokens; state.burnCount += 1;
  const entry = {
    ts: now, type: 'devburn', reason: 'devburn', tranche: a.tranche, tokens, symbol: cfg.tokenSymbol, sol: 0,
    scientist: pickScientist(rand), mcapUsd: a.mcapUsd, sigs: { burn: sig }, mode: chain.mode,
    burnCountTotal: state.burnCount, burnedPct: round(state.burnedTokens / state.totalSupply * 100, 3),
  };
  entry.note = await narrate(entry, { apiKey: env.anthropicKey, model: cfg.narrator.model, mode: cfg.narrator.mode, rand });
  addLog(state, entry);
  log(`DEVBURN tranche ${a.tranche + 1} · ${tokens.toLocaleString('en-US')} ${cfg.tokenSymbol} · ${sig}`);
  await webhook(entry);
}

/** Offline simulation: `hours` hours in fast forward, reproducible (seed). */
async function simulate(hours) {
  const rand = rng(11);
  const chain = makeMockChain({ cfg, seed: 7, devBagTokens: 20_000_000 });
  const state = emptyState(cfg, 'simulation');
  const t0 = Date.now() - hours * 3600_000;
  state.startedAt = t0; state.mint = null; state.wallet = chain.owner; state.devBag.tokens = 20_000_000; state.treasuryWallet = 'SIMULATED_TREASURY';
  for (let h = 0; h < hours; h++) {
    chain.advanceHour(h);
    const now = t0 + (h + 1) * 3600_000;
    await tick(chain, state, now, rand);
  }
  console.log(`Simulation done: ${state.burnCount} burns, ${Math.round(state.burnedTokens).toLocaleString('en-US')} ${cfg.tokenSymbol} burned (${(state.burnedTokens / state.totalSupply * 100).toFixed(3)} %), ${state.feesFedSol.toFixed(3)} SOL fed, ${state.labShareSol.toFixed(3)} SOL lab share → ${statePath}`);
}

async function webhook(entry) {
  if (!env.webhookUrl) return;
  try {
    const content = `${entry.type === 'milestone' ? '🏁' : '🔥'} ${entry.note}\n${Object.entries(entry.sigs || {}).map(([k, v]) => `${k}: https://solscan.io/tx/${v}`).join('\n')}`;
    await fetch(env.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
  } catch (e) { console.warn('webhook failed:', e.message); }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; out[k] = v; }
  }
  return out;
}
function log(msg) { console.log(new Date().toISOString(), msg); }
function round(x, d) { const f = 10 ** d; return Math.round(x * f) / f; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
