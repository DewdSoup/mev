// services/arb-mm/src/accounts.ts
import fs from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export type WalletCtx = {
  owner: Keypair;
  atas: { wsol: PublicKey; usdc: PublicKey };
  lastBalances?: { usdc: number; wsol: number };
};

function loadKeypairFromFile(p: string): Keypair {
  const raw = fs.readFileSync(p, "utf8").trim();
  const arr = JSON.parse(raw) as number[];
  const sk = Uint8Array.from(arr);
  return Keypair.fromSecretKey(sk);
}

export async function initAccounts(conn: Connection): Promise<WalletCtx> {
  const keyPath = process.env.WALLET_KEYPAIR_PATH!;
  const owner = loadKeypairFromFile(keyPath);

  const USDC_MINT = new PublicKey(process.env.USDC_MINT!);
  const WSOL_MINT = new PublicKey(process.env.WSOL_MINT!);

  const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey, true);
  const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, owner.publicKey, true);

  let lastBalances: { usdc: number; wsol: number } | undefined;
  try {
    const [usdcBal, wsolBal] = await Promise.all([
      conn.getTokenAccountBalance(usdcAta, "processed").then(r => Number(r?.value?.uiAmount ?? 0)).catch(() => 0),
      conn.getTokenAccountBalance(wsolAta, "processed").then(r => Number(r?.value?.uiAmount ?? 0)).catch(() => 0),
    ]);
    lastBalances = { usdc: usdcBal, wsol: wsolBal };
  } catch { }

  return { owner, atas: { wsol: wsolAta, usdc: usdcAta }, lastBalances };
}
