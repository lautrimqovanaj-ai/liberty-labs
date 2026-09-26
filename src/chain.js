// chain.js – the real access to the Solana chain and the pump.fun API.
//
// Interface sources (official repo pump-fun/pump-fun-skills, as of April 2026):
//   POST https://fun-block.pump.fun/agents/collect-fees   → tx to collect creator fees (permissionless)
//   POST https://fun-block.pump.fun/agents/swap           → tx to buy (bonding curve OR PumpSwap, detected automatically)
//   GET  https://frontend-api-v3.pump.fun/coins-v2/{mint} → coin data (server-side only, CORS-protected)
//   Creator vault PDA: seeds ["creator-vault", creator] in the Pump program; rent reserve 890,880 lamports
//
// The burn itself is a plain SPL token instruction (burnChecked). There is deliberately NO sell function here.

import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createBurnCheckedInstruction, getAccount, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_PROGRAM_ID, coinCreatorVaultAuthorityPda, coinCreatorVaultAtaPda } from '@pump-fun/pump-swap-sdk';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';

const API = 'https://fun-block.pump.fun';
const COIN_API = 'https://frontend-api-v3.pump.fun/coins-v2';
const VAULT_RENT_LAMPORTS = 890_880;

export function loadKeypair(path) {
  // Cloud hosting: key as an environment variable instead of a file (KEYPAIR_BASE58 = Phantom export)
  const raw = (process.env.KEYPAIR_BASE58 || '').trim() || readFileSync(path, 'utf8').trim();
  if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  return Keypair.fromSecretKey(bs58.decode(raw)); // base58 export from Phantom or similar
}

export function makeChain({ rpcUrl, keypair, mint, cfg, log = console }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const mintPk = new PublicKey(mint);
  const owner = keypair.publicKey;
  let tokenProgram = null;

  /** Always resolve the token program on-chain (SPL Token or Token-2022) – never trust the API for it. */
  async function resolveTokenProgram() {
    if (tokenProgram) return tokenProgram;
    const info = await connection.getAccountInfo(mintPk);
    if (!info) throw new Error('Mint not found – wrong address or wrong network?');
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
    // after graduation, fees also accumulate as WSOL in the AMM vault
    try {
      const auth = coinCreatorVaultAuthorityPda(owner);
      const ata = coinCreatorVaultAtaPda(auth, NATIVE_MINT);
      const acc = await getAccount(connection, ata, 'confirmed', TOKEN_PROGRAM_ID);
      total += Number(acc.amount);
    } catch { /* no AMM vault (not graduated yet) */ }
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
      priceProxy: info?.mcapUsd ?? null, // market cap as a price proxy (pump.fun: price × 1 billion)
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
    if (res.value.err) throw new Error(`Tx failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  async function apiTx(path, body) {
    const r = await fetch(`${API}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...body, encoding: 'base64' }),
    });
    if (!r.ok) throw new Error(`pump.fun API ${path} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (!j.transaction) throw new Error(`pump.fun API ${path}: no transaction in the response`);
    return j;
  }

  /** Collect creator fees from the vault into the wallet. */
  async function collectFees() {
    const j = await apiTx('/agents/collect-fees', { mint, user: owner.toBase58() });
    return signAndSend(j.transaction);
  }

  /** Buy $TOKEN for `sol` SOL. Returns the signature and the tokens bought. */
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

  /** Transfer the lab share to the treasury wallet. */
  async function transferSol(to, sol) {
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
    if (lamports <= 0) throw new Error('Payout is 0');
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(to), lamports }));
    tx.feePayer = owner;
    const bh = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = bh.blockhash;
    tx.sign(keypair);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    const res = await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    if (res.value.err) throw new Error(`Payout failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  /** Burn `tokens` (whole tokens) irreversibly. */
  async function burn(tokens) {
    const prog = await resolveTokenProgram();
    const ata = getAssociatedTokenAddressSync(mintPk, owner, false, prog);
    const amount = BigInt(Math.floor(tokens * 10 ** cfg.tokenDecimals));
    if (amount <= 0n) throw new Error('Burn amount is 0');
    const ix = createBurnCheckedInstruction(ata, mintPk, owner, amount, cfg.tokenDecimals, [], prog);
    const tx = new Transaction().add(ix);
    tx.feePayer = owner;
    const bh = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = bh.blockhash;
    tx.sign(keypair);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    const res = await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    if (res.value.err) throw new Error(`Burn failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  return { mode: 'live', owner: owner.toBase58(), snapshot, collectFees, buy, burn, transferSol, tokenBalance };
}

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
