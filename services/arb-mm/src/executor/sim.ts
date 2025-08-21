// services/arb-mm/src/executor/sim.ts
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { buildRaydiumSwapIx } from "../util/raydium";

// Default ON: keep logs clean on known SDK issue
const QUIET_KNOWN_RAYDIUM_SIM_ERRORS =
  (process.env.QUIET_KNOWN_RAYDIUM_SIM_ERRORS ?? "1") === "1";

// Optional hard-disable switch (keeps your existing env shape)
const USE_RAYDIUM_SWAP_SIM =
  (process.env.USE_RAYDIUM_SWAP_SIM ?? "1") === "1";

// Heuristics for Raydium SDK’s internal crash signatures we’ve seen
const KNOWN_RAYDIUM_SIM_BUG =
  /(isZero|makeSwapInstructionSimple|amountOutMin|otherAmountThreshold)/i;

export async function simulateRaydiumSwapFixedIn(conn: Connection, params: {
  user: PublicKey;
  baseIn: boolean;
  amountInBase: bigint;
  slippageBps: number;
}) {
  const t0 = (globalThis.performance?.now?.() ?? Date.now());

  if (!USE_RAYDIUM_SWAP_SIM) {
    const dt = (globalThis.performance?.now?.() ?? Date.now()) - t0;
    return { ok: false, mode: "raydium-swap-sim-disabled", rpc_sim_ms: dt };
  }

  try {
    const built = await buildRaydiumSwapIx({
      user: params.user,
      baseIn: params.baseIn,
      amountInBase: params.amountInBase,
      slippageBps: params.slippageBps,
    });
    if (!built.ok) throw new Error(built.reason);

    // Simulate the swap ixs (no signature needed)
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: params.user,
      recentBlockhash: blockhash,
      instructions: built.ixs,
    }).compileToV0Message();
    const vx = new VersionedTransaction(msg);

    const sim = await conn.simulateTransaction(vx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });

    const dt = (globalThis.performance?.now?.() ?? Date.now()) - t0;
    return {
      ok: sim.value.err == null,
      mode: "raydium-swap-sim",
      rpc_units: sim.value.unitsConsumed,
      rpc_sim_ms: dt,
      logs_tail: sim.value.logs?.slice(-8),
    };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const dt = (globalThis.performance?.now?.() ?? Date.now()) - t0;

    // Quiet path: treat this as a benign SDK issue, not a failure
    if (QUIET_KNOWN_RAYDIUM_SIM_ERRORS && KNOWN_RAYDIUM_SIM_BUG.test(msg)) {
      return {
        ok: false,
        mode: "raydium-swap-sim-skipped-known-bug",
        rpc_sim_ms: dt,
        // no rpc_sim_error on purpose (keeps logs clean)
      };
    }

    // Everything else surfaces as a real sim failure
    return {
      ok: false,
      mode: "raydium-swap-ix-failed-fallback",
      rpc_sim_error: msg,
      rpc_sim_ms: dt,
    };
  }
}
