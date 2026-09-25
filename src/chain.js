// chain.js – der echte Zugang zur Solana-Chain und zur pump.fun-API.
//
// Quellen für die Schnittstellen (offizielles Repo pump-fun/pump-fun-skills, Stand April 2026):
//   POST https://fun-block.pump.fun/agents/collect-fees   → Tx zum Einsammeln der Creator-Fees (permissionless)
//   POST https://fun-block.pump.fun/agents/swap           → Tx für Kauf (bonding curve ODER PumpSwap, automatisch)
//   GET  https://frontend-api-v3.pump.fun/coins-v2/{mint} → Coin-Daten (nur server-seitig aufrufbar, CORS-geschützt)
//   Creator-Vault-PDA: seeds ["creator-vault", creator] im Pump-Programm; Rent-Reserve 890 880 Lamports
//
// Der Burn selbst ist eine normale SPL-Token-Anweisung (burnChecked). Es gibt hier absichtlich KEINE Verkaufsfunktion.

import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createBurnCheckedInstruction, getAccount, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_PROGRAM_ID, coinCreatorVaultAuthorityPda, coinCreatorVaultAtaPda } from '@pump-fun/pump-swap-sdk';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';

const API = 'https://fun-block.pump.fun';
const COIN_API = 'https://frontend-api-v3.pump.fun/coins-v2';
const VAULT_RENT_LAMPORTS = 890_880;

export function loadKeypair(path) {
  // Cloud-Hosting: Schlüssel als Umgebungsvariable statt Datei (KEYPAIR_BASE58 = Phantom-Export)
  const raw = (process.env.KEYPAIR_BASE58 || '').trim() || readFileSync(path, 'utf8').trim();
  if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  return Keypair.fromSecretKey(bs58.decode(raw)); // base58-Export aus Phantom o. ä.
}

export function makeChain({ rpcUrl, keypair, mint, cfg, log = console }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const mintPk = new PublicKey(mint);
  const owner = keypair.publicKey;
  let tokenProgram = null;

  /** Token-Programm immer on-chain bestimmen (SPL Token oder Token-2022) – nie aus der API übernehmen. */
  async function resolveTokenProgram() {
    if (tokenProgram) return tokenProgram;
    const info = await connection.getAccountInfo(mintPk);
    if (!info) throw new Error('Mint nicht gefunden – falsche Adresse oder falsches Netz?');
    tokenProgram = info.owner;
    return tokenProgram;
  }

  async function tokenBalance() {
    const prog = await resolveTokenProgram();
    const ata = getAssociatedTokenAddressSync(mintPk, owner, false, prog);
    try {
      const acc = await getAccount(connection, ata, 'confirmed', prog);
      return Number(acc.amount) / 10 ** cfg.tokenDecimals;
    } catch { return 0; }
  }

  async function vaultSol() {
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), owner.toBuffer()], PUMP_PROGRAM_ID);
    const lamports = await connection.getBalance(vault);
    let total = Math.max(0, lamports - VAULT_RENT_LAMPORTS);
    // nach der Graduation liegen Fees zusätzlich als WSOL im AMM-Vault
    try {
      const auth = coinCreatorVaultAuthorityPda(owner);
      const ata = coinCreatorVaultAtaPda(auth, NATIVE_MINT);
      const acc = await getAccount(connection, ata, 'confirmed', TOKEN_PROGRAM_ID);
      total += Number(acc.amount);
    } catch { /* kein AMM-Vault (noch nicht graduiert) */ }
    return total / LAMPORTS_PER_SOL;
  }

  async function coinInfo() {
    try {
      const r = await fetch(`${COIN_API}/${mint}`, { headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      const c = await r.json();
      return { mcapUsd: num(c.usd_market_cap), graduated: !!c.complete, name: c.name, symbol: c.symbol };
    } catch (e) { log.warn?.('coin api failed:', e.message); return null; }
  }

  async function snapshot() {
    const [wallet, vault, supply, info, tokens] = await Promise.all([
      connection.getBalance(owner), vaultSol(), connection.getTokenSupply(mintPk), coinInfo(), tokenBalance(),
    ]);
    return {
      walletSol: wallet / LAMPORTS_PER_SOL,
      vaultSol: vault,
      supplyNow: Number(supply.value.uiAmount ?? 0),
      mcapUsd: info?.mcapUsd ?? null,
      priceProxy: info?.mcapUsd ?? null, // Marktkap. als Preis-Ersatz (pump.fun: Preis × 1 Mrd.)
      graduated: info?.graduated ?? null,
      walletTokens: tokens,
    };
  }

  async function signAndSend(b64) {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    tx.sign([keypair]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    const bh = await connection.getLatestBlockhash('confirmed');
    const res = await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    if (res.value.err) throw new Error(`Tx fehlgeschlagen: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  async function apiTx(path, body) {
    const r = await fetch(`${API}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...body, encoding: 'base64' }),
    });
    if (!r.ok) throw new Error(`pump.fun API ${path} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (!j.transaction) throw new Error(`pump.fun API ${path}: keine Transaktion in der Antwort`);
    return j;
  }

  /** Creator-Fees aus dem Vault ins Wallet holen. */
  async function collectFees() {
    const j = await apiTx('/agents/collect-fees', { mint, user: owner.toBase58() });
    return signAndSend(j.transaction);
  }

  /** $TOKEN für `sol` SOL kaufen. Gibt Signatur und gekaufte Token zurück. */
  async function buy(sol) {
    const before = await tokenBalance();
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
    const j = await apiTx('/agents/swap', {
      inputMint: NATIVE_MINT.toBase58(), outputMint: mint, amount: String(lamports),
      user: owner.toBase58(), slippagePct: cfg.slippagePct,
    });
    const signature = await signAndSend(j.transaction);
    const after = await tokenBalance();
    return { signature, tokensBought: Math.max(0, after - before) };
  }

  /** Lab-Anteil an das Treasury-Wallet überweisen. */
  async function transferSol(to, sol) {
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
    if (lamports <= 0) throw new Error('Auszahlung ist 0');
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(to), lamports }));
    tx.feePayer = owner;
    const bh = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = bh.blockhash;
    tx.sign(keypair);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    const res = await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    if (res.value.err) throw new Error(`Auszahlung fehlgeschlagen: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  /** `tokens` (ganze Token) unwiderruflich verbrennen. */
  async function burn(tokens) {
    const prog = await resolveTokenProgram();
    const ata = getAssociatedTokenAddressSync(mintPk, owner, false, prog);
    const amount = BigInt(Math.floor(tokens * 10 ** cfg.tokenDecimals));
    if (amount <= 0n) throw new Error('Burn-Betrag ist 0');
    const ix = createBurnCheckedInstruction(ata, mintPk, owner, amount, cfg.tokenDecimals, [], prog);
    const tx = new Transaction().add(ix);
    tx.feePayer = owner;
    const bh = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = bh.blockhash;
    tx.sign(keypair);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    const res = await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    if (res.value.err) throw new Error(`Burn fehlgeschlagen: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  return { mode: 'live', owner: owner.toBase58(), snapshot, collectFees, buy, burn, transferSol, tokenBalance };
}

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
