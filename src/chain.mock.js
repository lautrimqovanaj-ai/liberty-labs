// chain.mock.js – Simulation ohne Netz. Gleiches Interface wie chain.js.
// Zweck: den ganzen Ablauf offline testen und Demo-Daten (mode: "simulation") für die Website erzeugen.
// Alle Zahlen hier sind erfunden und dienen nur der Vorschau.

const LAMPORTS = 1e9;

/** Deterministischer Zufall (mulberry32), damit die Simulation reproduzierbar ist. */
export function rng(seed = 7) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeMockChain({ cfg, seed = 7, startMcapUsd = 45_000, devBagTokens = 20_000_000 }) {
  const rand = rng(seed);
  const supply = cfg.totalSupply;
  let supplyNow = supply;
  let mcapUsd = startMcapUsd;         // Preis-Ersatz wie live (pump.fun: Preis × 1 Mrd.)
  let vaultSol = 0;
  let walletSol = 0.05;               // Startguthaben für Tx-Gebühren
  let walletTokens = devBagTokens;    // Dev-Kauf, wird nie verkauft
  let sigCounter = 1;
  let solUsd = 150;                   // erfundener SOL-Kurs nur für die Umrechnung
  const BONDING_CURVE_CREATOR_FEE = 0.003; // 0,300 % laut pump.fun/docs/fees (Stand 20.05.2026)

  const fakeSig = (tag) => `SIM${tag}${String(sigCounter++).padStart(4, '0')}${'x'.repeat(40)}`.slice(0, 88);

  /** Eine Stunde Markt simulieren: Volumen → Creator-Fee ins Vault, Preis läuft zufällig (mit Dips). */
  function advanceHour(hourIndex) {
    const hype = 1 + Math.max(0, Math.sin(hourIndex / 9)) * 2.5;               // Wellen von Aufmerksamkeit
    const volumeUsd = (600 + rand() * 4_500) * hype * Math.sqrt(mcapUsd / 12_000);
    vaultSol += (volumeUsd * BONDING_CURVE_CREATOR_FEE) / solUsd;
    const shock = rand() < 0.12 ? -(0.15 + rand() * 0.15) : 0;                  // ab und zu ein Dip
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
    if (sol > walletSol) throw new Error('Simulation: zu wenig SOL im Wallet');
    walletSol -= sol;
    const priceUsdPerToken = mcapUsd / supply;
    const tokensBought = Math.floor((sol * solUsd) / priceUsdPerToken * (1 - 0.0125)); // 1,25 % Gesamtgebühr auf der Curve
    walletTokens += tokensBought;
    mcapUsd *= 1 + (sol * solUsd) / (mcapUsd * 1.2); // kleiner Preiseffekt des Kaufs
    return { signature: fakeSig('BUY'), tokensBought };
  }

  async function transferSol(to, sol) {
    if (sol > walletSol) throw new Error('Simulation: zu wenig SOL für die Auszahlung');
    walletSol -= sol;
    return fakeSig('PAY');
  }

  async function burn(tokens) {
    if (tokens > walletTokens + 1e-6) throw new Error('Simulation: nicht genug Token zum Verbrennen');
    walletTokens -= tokens;
    supplyNow -= tokens;
    return fakeSig('BURN');
  }

  return { mode: 'simulation', owner: 'SIMULATED_WALLET', snapshot, collectFees, buy, burn, transferSol, advanceHour, tokenBalance: async () => walletTokens };
}
