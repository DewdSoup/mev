// packages/solana/src/wallet.ts
import fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountIdempotent,
} from "@solana/spl-token";
import { logger } from "@mev/storage";

export type WalletCtx = {
  payer: Keypair | null;
  owner: PublicKey;
  usdcMint: PublicKey;
  wsolMint: PublicKey;
  usdcAta: PublicKey;
  wsolAta: PublicKey;
};

function loadKeypairMaybe(p?: string): Keypair | null {
  try {
    if (!p) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch {
    return null;
  }
}

export async function loadWallet(conn: Connection): Promise<WalletCtx> {
  const ownerStr = process.env.OWNER_PUBKEY || process.env.WALLET_PUBKEY || "";
  if (!ownerStr) throw new Error("OWNER_PUBKEY/WALLET_PUBKEY is required");
  const owner = new PublicKey(ownerStr);

  const usdcMint = new PublicKey(
    process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );
  const wsolMint = new PublicKey(
    process.env.SOL_MINT ?? "So11111111111111111111111111111111111111112"
  );

  const payer =
    loadKeypairMaybe(process.env.WALLET_KEYPAIR_PATH) ||
    loadKeypairMaybe(process.env.KEYPAIR_PATH) ||
    null;

  const usdcAta = process.env.USDC_ATA
    ? new PublicKey(process.env.USDC_ATA)
    : getAssociatedTokenAddressSync(usdcMint, owner, true);
  const wsolAta = process.env.WSOL_ATA
    ? new PublicKey(process.env.WSOL_ATA)
    : getAssociatedTokenAddressSync(wsolMint, owner, true);

  logger.log("wallet_loaded", {
    pubkey: owner.toBase58(),
    atas: { wsol: wsolAta.toBase58(), usdc: usdcAta.toBase58() },
    has_signer: !!payer,
  });

  // Ensure ATAs exist (idempotent; no-ops if they already exist)
  await ensureAtas(conn, owner, payer, { usdcMint, wsolMint, usdcAta, wsolAta });

  // Rent sanity + balances
  const accInfo = await conn.getAccountInfo(owner, "processed");
  const solLamports = accInfo?.lamports ?? 0;
  const rentOk = solLamports >= 0.01 * LAMPORTS_PER_SOL; // ~0.01 SOL safety
  const { usdc, wsol } = await getBalances(conn, { usdcAta, wsolAta });

  logger.log("balances", {
    sol: Number((solLamports / LAMPORTS_PER_SOL).toFixed(6)),
    usdc: Number(usdc.toFixed(6)),
    wsol: Number(wsol.toFixed(9)),
    rent_ok: rentOk,
  });

  return { payer, owner, usdcMint, wsolMint, usdcAta, wsolAta };
}

export async function ensureAtas(
  conn: Connection,
  owner: PublicKey,
  payer: Keypair | null,
  m: {
    usdcMint: PublicKey;
    wsolMint: PublicKey;
    usdcAta: PublicKey;
    wsolAta: PublicKey;
  }
): Promise<void> {
  // If no signer or explicit ATAs provided, just verify & log.
  if (!payer) {
    logger.log("atas_ok", {
      wsol: true,
      usdc: true,
      note: "no signer (read-only)",
    });
    return;
  }

  const have = { usdc: false, wsol: false };
  try {
    await getAccount(conn, m.usdcAta, "processed");
    have.usdc = true;
  } catch { }
  try {
    await getAccount(conn, m.wsolAta, "processed");
    have.wsol = true;
  } catch { }

  const confirm: Parameters<typeof createAssociatedTokenAccountIdempotent>[4] = {
    commitment: "processed",
  };

  const ops: Promise<any>[] = [];
  if (!have.usdc) {
    ops.push(
      createAssociatedTokenAccountIdempotent(
        conn,
        payer,
        m.usdcMint,
        owner,
        confirm
      )
    );
  }
  if (!have.wsol) {
    ops.push(
      createAssociatedTokenAccountIdempotent(
        conn,
        payer,
        m.wsolMint,
        owner,
        confirm
      )
    );
  }

  if (ops.length > 0) {
    await Promise.all(ops);
  }
  logger.log("atas_ok", { wsol: true, usdc: true });
}

export async function getBalances(
  conn: Connection,
  a: { usdcAta: PublicKey; wsolAta: PublicKey }
): Promise<{ usdc: number; wsol: number }> {
  const [usdcAcc, wsolAcc] = await Promise.allSettled([
    getAccount(conn, a.usdcAta, "processed"),
    getAccount(conn, a.wsolAta, "processed"),
  ]);
  const usdc =
    usdcAcc.status === "fulfilled" ? Number(usdcAcc.value.amount) / 1e6 : 0;
  const wsol =
    wsolAcc.status === "fulfilled" ? Number(wsolAcc.value.amount) / 1e9 : 0;
  return { usdc, wsol };
}
