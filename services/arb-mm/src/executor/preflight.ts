// services/arb-mm/src/executor/preflight.ts
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { AppConfig } from "../config.js";

export type PreflightCheck =
  | "ok"
  | "low_sol_balance"
  | "missing_usdc_ata"
  | "missing_wsol_ata";

export interface PreflightResult {
  ok: boolean;
  checks: Record<PreflightCheck, boolean>;
  lamports: number;
  usdcAta?: PublicKey;
  wsolAta?: PublicKey;
  reasons: string[];
}

function ataFor(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

async function accountExists(conn: Connection, pk: PublicKey): Promise<boolean> {
  const info = await conn.getAccountInfo(pk, { commitment: "processed" });
  return !!info;
}

export async function preflight(
  conn: Connection,
  cfg: AppConfig,
  owner: PublicKey
): Promise<PreflightResult> {
  const reasons: string[] = [];
  const checks: Record<PreflightCheck, boolean> = {
    ok: false,
    low_sol_balance: false,
    missing_usdc_ata: false,
    missing_wsol_ata: false,
  };

  // Lamports
  const lamports = (await conn.getAccountInfo(owner, { commitment: "processed" }))?.lamports ?? 0;
  if (lamports < cfg.MIN_SOL_BALANCE_LAMPORTS) {
    checks.low_sol_balance = true;
    reasons.push(
      `needs_funding: have ${lamports} lamports, need >= ${cfg.MIN_SOL_BALANCE_LAMPORTS}`
    );
  }

  // Mints
  const usdcMint = cfg.USDC_MINT ? new PublicKey(cfg.USDC_MINT) : undefined;
  const wsolMint = cfg.SOL_MINT ? new PublicKey(cfg.SOL_MINT) : undefined;

  // ATAs (use env if provided, else compute)
  const usdcAta = cfg.USDC_ATA
    ? new PublicKey(cfg.USDC_ATA)
    : (usdcMint ? ataFor(usdcMint, owner) : undefined);

  const wsolAta = cfg.WSOL_ATA
    ? new PublicKey(cfg.WSOL_ATA)
    : (wsolMint ? ataFor(wsolMint, owner) : undefined);

  if (usdcAta) {
    const ok = await accountExists(conn, usdcAta);
    if (!ok) {
      checks.missing_usdc_ata = true;
      reasons.push(`missing_usdc_ata: ${usdcAta.toBase58()}`);
    }
  }

  if (wsolAta) {
    const ok = await accountExists(conn, wsolAta);
    if (!ok) {
      checks.missing_wsol_ata = true;
      reasons.push(`missing_wsol_ata: ${wsolAta.toBase58()}`);
    }
  }

  const ok = !checks.low_sol_balance && !checks.missing_usdc_ata && !checks.missing_wsol_ata;
  checks.ok = ok;

  // With exactOptionalPropertyTypes, only include usdcAta/wsolAta when defined.
  return {
    ok,
    checks,
    lamports,
    reasons,
    ...(usdcAta ? { usdcAta } : {}),
    ...(wsolAta ? { wsolAta } : {}),
  };
}
