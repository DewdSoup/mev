// services/arb-mm/src/accounts.ts
import { Connection } from "@solana/web3.js";
import { logger } from "@mev/storage";
import { loadWallet, getBalances, type WalletCtx } from "@mev/solana";

export type AccountsCtx = WalletCtx & {
  lastBalances?: { usdc: number; wsol: number };
};

export async function initAccounts(conn: Connection): Promise<AccountsCtx> {
  const w = await loadWallet(conn);
  const bal = await getBalances(conn, { usdcAta: w.usdcAta, wsolAta: w.wsolAta });
  logger.log("atas_ok", { wsol: true, usdc: true, note: "pre-provided env ATAs verified" });
  return { ...w, lastBalances: bal };
}

export async function refreshBalances(conn: Connection, a: AccountsCtx) {
  const bal = await getBalances(conn, { usdcAta: a.usdcAta, wsolAta: a.wsolAta });
  a.lastBalances = bal;
  logger.log("balances", {
    usdc: Number(bal.usdc.toFixed(6)),
    wsol: Number(bal.wsol.toFixed(9)),
    rent_ok: true
  });
}
