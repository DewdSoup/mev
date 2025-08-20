import fs from 'fs';
import {
  Connection,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import fetch from 'node-fetch';

// ---- constants ----
const RPC = process.env.RPC_URL || clusterApiUrl('mainnet-beta');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUP_SWAP  = 'https://quote-api.jup.ag/v6/swap';
const SLIPPAGE_BPS = 50; // 0.50%

async function jupQuote({ inputMint, outputMint, amountLamports, slippageBps=SLIPPAGE_BPS }) {
  const p = new URLSearchParams({
    inputMint: String(inputMint),
    outputMint: String(outputMint),
    amount: String(amountLamports),
    slippageBps: String(slippageBps),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
  });
  const r = await fetch(`${JUP_QUOTE}?${p}`);
  if (!r.ok) throw new Error(`Quote failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function jupSwapTx(quoteResponse, userPk) {
  const body = {
    quoteResponse,
    userPublicKey: userPk.toBase58(),
    wrapUnwrapWSOL: true,
    useSharedAccounts: false,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto',
  };
  const r = await fetch(JUP_SWAP, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Swap build failed: ${r.status} ${await r.text()}`);
  const { swapTransaction } = await r.json();
  return VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
}

async function ensureUsdcAta(connection, owner) {
  const ata = await getAssociatedTokenAddress(USDC_MINT, owner.publicKey);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(owner.publicKey, ata, owner.publicKey, USDC_MINT)
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [owner]);
    console.log(`✅ Created USDC ATA ${ata.toBase58()} – ${sig}`);
  }
  return ata;
}

function parseArgs() {
  // supports: node swap_sol_usdc.js 0.1  OR  node swap_sol_usdc.js --usd 25
  let sol = null, usd = null;
  const args = process.argv.slice(2);
  for (let i=0;i<args.length;i++) {
    const a = args[i];
    if (a === '--usd') usd = parseFloat(args[++i]);
    else if (a.startsWith('--usd=')) usd = parseFloat(a.split('=')[1]);
    else if (!isNaN(parseFloat(a))) sol = parseFloat(a);
  }
  return { sol, usd };
}

async function main() {
  const { sol: solArg, usd } = parseArgs();
  if (!solArg && !usd) {
    console.error('Usage:\n  node swap_sol_usdc.js <amountSOL>\n  node swap_sol_usdc.js --usd 25');
    process.exit(1);
  }

  const connection = new Connection(RPC, 'confirmed');
  const secret = JSON.parse(fs.readFileSync('./blondi.json', 'utf8'));
  const owner = (await import('@solana/web3.js')).Keypair.fromSecretKey(Uint8Array.from(secret));
  console.log(`🔑 ${owner.publicKey.toBase58()}`);
  console.log(`🔌 RPC: ${RPC}`);

  // balances
  const solBalLamports = await connection.getBalance(owner.publicKey);
  const solBal = solBalLamports / LAMPORTS_PER_SOL;
  console.log(`💰 SOL balance: ${solBal.toFixed(6)} SOL`);

  // keep a small fee buffer
  const FEE_BUFFER = 0.02; // keep ~0.02 SOL for fees
  let amountSol = solArg ?? 0;

  // If user asked for USD, probe 0.01 SOL to estimate USDC/SOL then scale
  if (usd) {
    const probeLamports = Math.floor(0.01 * LAMPORTS_PER_SOL);
    const probe = await jupQuote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amountLamports: probeLamports });
    const usdcForProbe = Number(probe.outAmount) / 1e6; // USDC has 6 decimals
    const usdcPerSol = usdcForProbe / 0.01;
    amountSol = (usd / usdcPerSol) * 1.003; // tiny 0.3% headroom
    console.log(`📐 Target: ~$${usd} → estimate ${amountSol.toFixed(6)} SOL (at ~${usdcPerSol.toFixed(2)} USDC/SOL)`);
  }

  // enforce fee buffer
  if (amountSol > solBal - FEE_BUFFER) {
    amountSol = Math.max(solBal - FEE_BUFFER, 0);
    if (amountSol <= 0) throw new Error('Not enough SOL after fee buffer.');
    console.log(`⚠️ Capped swap to ${amountSol.toFixed(6)} SOL to keep fee buffer`);
  }

  const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
  if (amountLamports <= 0) throw new Error('Swap size computed to 0.');

  const usdcAta = await ensureUsdcAta(connection, owner);
  const before = await connection.getTokenAccountBalance(usdcAta).catch(()=>null);

  // quote + build + send
  console.log(`🔄 Quoting ${amountSol.toFixed(6)} SOL → USDC...`);
  const quote = await jupQuote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amountLamports });
  const expected = Number(quote.outAmount) / 1e6;
  console.log(`📊 Expected: ~${expected.toFixed(4)} USDC | impact: ${quote.priceImpactPct}%`);

  const vtx = await jupSwapTx(quote, owner.publicKey);
  vtx.sign([owner]);

  const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 2 });
  console.log(`📤 Sent: ${sig}`);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, signature: sig }, 'confirmed');
  console.log(`✅ Confirmed: https://solscan.io/tx/${sig}`);

  // post balances
  const after = await connection.getTokenAccountBalance(usdcAta);
  const got = after?.value?.uiAmount - (before?.value?.uiAmount ?? 0);
  console.log(`🧾 Received: ${(got ?? 0).toFixed(6)} USDC`);
}

main().catch((e) => {
  console.error('❌ Swap failed:', e);
  process.exit(1);
});
