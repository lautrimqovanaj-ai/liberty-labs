// chain.mock.js – simulation without network. Same interface as chain.js.
// Purpose: test the whole flow offline and produce demo data (mode: "simulation") for the website.
// All numbers here are invented and only serve the preview.

const LAMPORTS = 1e9;

/** Deterministic randomness (mulberry32) so the simulation is reproducible. */
export function rng(seed = 7) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeMockChain({ cfg, seed = 7, startMcapUsd = 45_000, devBagTokens = 20_000_000 }) {
  const rand = rng(seed);
  const supply = cfg.totalSupply;
  let supplyNow = supply;
  let mcapUsd = startMcapUsd;         // price proxy like in live mode (pump.fun: price × 1 billion)
  let vaultSol = 0;
  let walletSol = 0.05;               // starting balance for tx fees
  let walletTokens = devBagTokens;    // team's launch buy, never sold
  let sigCounter = 1;
  let solUsd = 150;                   // invented SOL price, only for the conversion
  const BONDING_CURVE_CREATOR_FEE = 0.003; // 0.300 % per pump.fun/docs/fees (as of 20 May 2026)

  const fakeSig = (tag) => `SIM${tag}${String(sigCounter++).padStart(4, '0')}${'x'.repeat(40)}`.slice(0, 88);

  /** Simulate one hour of market: volume → creator fee into the vault, price random-walks (with dips). */
  function advanceHour(hourIndex) {
    const hype = 1 + Math.max(0, Math.sin(hourIndex / 9)) * 2.5;               // waves of attention
    const volumeUsd = (600 + rand() * 4_500) * hype * Math.sqrt(mcapUsd / 12_000);
    vaultSol += (volumeUsd * BONDING_CURVE_CREATOR_FEE) / solUsd;
    const shock = rand() < 0.12 ? -(0.15 + rand() * 0.15) : 0;                  // an occasional dip
    const drift = (rand() - 0.45) * 0.14 + (hype - 1) * 0.03;
    mcapUsd = Math.max(3_000, mcapUsd * (1 + drift + shock));
  }

  async function snapshot() {
    return { walletSol, vaultSol, supplyNow, mcapUsd, priceProxy: mcapUsd, graduated: mcapUsd > 90_000, walletTokens };
  }

  async function collectFees() {
    walletSol += vaultSol; vaultSol = 0;
    return fakeSig('COLLECT');
  }

  async function buy(sol) {
    if (sol > walletSol) throw new Error('Simulation: not enough SOL in the wallet');
    walletSol -= sol;
    const priceUsdPerToken = mcapUsd / supply;
    const tokensBought = Math.floor((sol * solUsd) / priceUsdPerToken * (1 - 0.0125)); // 1.25 % total fee on the curve
    walletTokens += tokensBought;
    mcapUsd *= 1 + (sol * solUsd) / (mcapUsd * 1.2); // small price impact of the buy
    return { signature: fakeSig('BUY'), tokensBought };
  }

  async function transferSol(to, sol) {
    if (sol > walletSol) throw new Error('Simulation: not enough SOL for the payout');
    walletSol -= sol;
    return fakeSig('PAY');
  }

  async function burn(tokens) {
    if (tokens > walletTokens + 1e-6) throw new Error('Simulation: not enough tokens to burn');
    walletTokens -= tokens;
    supplyNow -= tokens;
    return fakeSig('BURN');
  }

  return { mode: 'simulation', owner: 'SIMULATED_WALLET', snapshot, collectFees, buy, burn, transferSol, advanceHour, tokenBalance: async () => walletTokens };
}
