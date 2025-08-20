// services/arb-mm/src/executor/live.ts
// Live executor with preflight guards, optional RPC-sim gating, and proper Raydium v4 swap build.
// NOTE: amountInAtoms is atoms of the *input* mint: SOL(9) if baseIn, USDC(6) if !baseIn.

import {
  Connection,
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
} from "@solana/web3.js";
import { logger } from "../ml_logger.js";
import { AccountsCtx } from "../accounts.js";
import {
  guardCheck,
  noteConsecutiveResult,
  noteError,
  killSwitchActive,
} from "../risk.js";
import { buildRaydiumCpmmSwapIx } from "./buildRaydiumCpmmIx.js";
import { preflight } from "./preflight.js";
import { emitMl } from "../feature_sink.js";
import { loadConfig, type AppConfig } from "../config.js";
import { computeTipLamports as computeDynTip } from "./dynamic_tip.js";
import { simulateRaydiumSwapFixedIn } from "./sim.js";

export type ExecPath = "PHX->AMM" | "AMM->PHX";
export type ExecPayload = {
  path: ExecPath;
  size_base: number;        // base units (SOL) for sizing
  buy_px?: number;          // quote/base
  sell_px?: number;         // quote/base
  notional_quote: number;
  phoenix: { market: string; side: "buy" | "sell"; limit_px: number };
};

function envBool(k: string, d = false) {
  const v = String(process.env[k] ?? (d ? "1" : "0")).toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export class LiveExecutor {
  private live = envBool("LIVE_TRADING", false);
  private cuLimit = Number(process.env.SUBMIT_CU_LIMIT ?? 400_000);
  private submitMode = String(process.env.SUBMIT_MODE ?? "rpc");
  private useRpcSim = envBool("USE_RPC_SIM", false);
  private phxReady = true;
  private cfg: AppConfig;

  constructor(private conn: Connection, private a: AccountsCtx, cfg?: AppConfig) {
    this.cfg = cfg ?? loadConfig();
  }

  async startPhoenix(): Promise<void> {
    this.phxReady = true;
    logger.log("phoenix_exec_ready", { single_leg: true });
  }

  private resolvePayerPk(): PublicKey {
    const anyA: any = this.a as any;
    return anyA.signer?.publicKey || anyA.wallet?.publicKey || this.a.owner;
  }

  private async signTx(tx: VersionedTransaction) {
    const anyA: any = this.a as any;
    try {
      if (typeof anyA.sign === "function") return void (await anyA.sign(tx));
      if (anyA.signer?.secretKey) return void tx.sign([anyA.signer]);
      if (anyA.wallet?.signTransaction) {
        const signed = await anyA.wallet.signTransaction(tx);
        tx.signatures = signed.signatures;
      }
    } catch (e) {
      logger.log("sign_warn", { error: String(e) });
    }
  }

  private computeBudgetIxs(units: number) {
    const estUnits = Math.max(50_000, units | 0);
    const lamports = computeDynTip(this.cfg, estUnits);
    const microLamports = lamports > 0 ? Math.floor((lamports * 1_000_000) / estUnits) : 0;
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: estUnits })];
    if (microLamports > 0) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    logger.log("tip_calc", {
      tip_mode: this.cfg.TIP_MODE, cu_limit: estUnits,
      tip_lamports: lamports || undefined, micro_lamports_per_cu: microLamports || undefined,
    });
    return { ixs, lamports };
  }

  async maybeExecute(exec: ExecPayload) {
    if (killSwitchActive()) return void logger.log("guard_violation", { type: "kill_switch_active" });

    const g = guardCheck({ pathId: exec.path, notionalQuote: exec.notional_quote, currentTps: undefined });
    if (!g.ok) return void logger.log("guard_violation", { type: g.reason, value: g.value, limit: g.limit });

    const payerPk = this.resolvePayerPk();

    // Preflight: balances & ATAs
    try {
      const pf = await preflight(this.conn, this.cfg, payerPk);
      if (!pf.ok) {
        logger.log("needs_funding", {
          reasons: pf.reasons, lamports: pf.lamports,
          usdcAta: pf.usdcAta?.toBase58(), wsolAta: pf.wsolAta?.toBase58(),
        });
        return;
      }
      logger.log("preflight_ok", {
        lamports: pf.lamports, usdcAta: pf.usdcAta?.toBase58(), wsolAta: pf.wsolAta?.toBase58(),
      });
    } catch (e) {
      logger.log("preflight_error", { error: String(e) }); return;
    }

    if (!this.live) {
      logger.log("submitted_tx", {
        path: exec.path, size_base: exec.size_base, buy_px: exec.buy_px, sell_px: exec.sell_px,
        ix_count: 0, cu_limit: this.cuLimit, tip_lamports: undefined, live: false, shadow: true, mode: this.submitMode
      });
      logger.log("landed", {
        sig: `shadow_${Math.random().toString(36).slice(2)}`, slot: null, conf_ms: 0, shadow: true,
        fill_px: exec.sell_px ?? exec.buy_px ?? exec.phoenix.limit_px,
        filled_base: exec.size_base,
        filled_quote: Number((exec.size_base * (exec.sell_px ?? exec.buy_px ?? 0)).toFixed(6)),
      });
      emitMl("submit", { path: exec.path, size_base: exec.size_base, buy_px: exec.buy_px, sell_px: exec.sell_px,
        notional_quote: exec.notional_quote, cu_limit: this.cuLimit, submit_mode: this.submitMode });
      return;
    }

    if (!this.phxReady) return void logger.log("submit_error", { where: "phoenix_not_ready", error: "hedge unavailable; skipping" });

    // ── Amount-in atoms must be of the *input* mint ─────────────────────────
    const baseIn = exec.path === "PHX->AMM"; // baseIn=true => input is SOL
    const px = exec.sell_px ?? exec.buy_px ?? exec.phoenix.limit_px ?? 0; // quote/base
    const amountInAtoms = baseIn
      ? BigInt(Math.round(exec.size_base * 1e9))              // SOL atoms
      : BigInt(Math.round(exec.size_base * px * 1e6));       // USDC atoms
    // ────────────────────────────────────────────────────────────────────────

    // RPC sim gate
    if (this.useRpcSim) {
      try {
        const sim = await simulateRaydiumSwapFixedIn(this.conn, {
          user: payerPk, baseIn, amountInBase: amountInAtoms, slippageBps: 50,
        });
        const ok = sim.mode === "cpmm-sim-success";
        logger.log("rpc_sim", {
          ok, mode: sim.mode, rpc_units: (sim as any).rpc_units,
          rpc_sim_ms: sim.rpc_sim_ms, logs_tail: (sim as any).logs_tail,
          path: exec.path, size_base: exec.size_base
        });
        if (!ok) { noteConsecutiveResult(exec.path, false); return; }
      } catch (e) {
        logger.log("rpc_sim", { ok: false, mode: "cpmm-sim-error", reason: String((e as any)?.message ?? e),
          path: exec.path, size_base: exec.size_base });
        noteConsecutiveResult(exec.path, false); return;
      }
    }

    let tx: VersionedTransaction | undefined;
    try {
      const ray = await buildRaydiumCpmmSwapIx({
        user: payerPk, baseIn, amountInBase: amountInAtoms, slippageBps: 50,
      });
      if (!ray.ok) {
        noteError(); logger.log("submit_error", { where: "raydium_build", error: ray.reason });
        emitMl("error", { where: "raydium_build", error: ray.reason }); return;
      }

      const { blockhash } = await this.conn.getLatestBlockhash("processed");
      const { ixs: budgetIxs, lamports: tipLamports } = this.computeBudgetIxs(this.cuLimit);
      const ixs = [...budgetIxs, ...ray.ixs];

      logger.log("submitted_tx", {
        path: exec.path, size_base: exec.size_base, buy_px: exec.buy_px, sell_px: exec.sell_px,
        ix_count: ixs.length, cu_limit: this.cuLimit, tip_lamports: tipLamports || 0,
        live: this.live, mode: this.submitMode
      });
      emitMl("submit", { path: exec.path, size_base: exec.size_base, buy_px: exec.buy_px, sell_px: exec.sell_px,
        notional_quote: exec.notional_quote, cu_limit: this.cuLimit, submit_mode: this.submitMode });

      const msg = new TransactionMessage({ payerKey: payerPk, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
      tx = new VersionedTransaction(msg); await this.signTx(tx);

      let sig: string | null = null;
      if (this.submitMode.toLowerCase() === "jito") {
        try {
          const { sendViaJito } = await import("../submit/jito.js");
          const res = await sendViaJito([tx], payerPk);
          if (res?.ok) { sig = res.signature ?? null; logger.log("jito_bundle_ok", { bundle: res.bundleId, signature: sig || undefined }); }
          else logger.log("jito_bundle_fallback_rpc", { error: res?.error || "unknown" });
        } catch (e) { logger.log("jito_unavailable", { error: String(e) }); }
      }
      if (!sig) sig = await this.conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });

      const t0 = Date.now();
      const confCtx = await this.conn.getLatestBlockhash("processed");
      const conf = await this.conn.confirmTransaction({ signature: sig!, ...confCtx }, "processed");
      const confMs = Date.now() - t0;

      if (conf?.value?.err) {
        noteConsecutiveResult(exec.path, false); noteError();
        logger.log("land_error", { sig, err: JSON.stringify(conf.value.err) });
        emitMl("error", { where: "land", sig, err: conf.value.err });
      } else {
        let unitsConsumed: number | undefined; let feeLamports: number | undefined;
        try {
          const txd = await this.conn.getTransaction(sig!, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          unitsConsumed = (txd?.meta as any)?.computeUnitsConsumed ?? undefined;
          feeLamports = txd?.meta?.fee ?? undefined;
        } catch {}
        noteConsecutiveResult(exec.path, true);
        logger.log("landed", {
          sig, slot: await this.conn.getSlot("processed"), conf_ms: confMs,
          fill_px: exec.phoenix.limit_px, filled_base: exec.size_base,
          filled_quote: Number((exec.size_base * (exec.sell_px ?? exec.buy_px ?? 0)).toFixed(6)),
          compute_units: unitsConsumed, fee_lamports: feeLamports, tip_lamports: tipLamports || 0
        });
        emitMl("fill", {
          sig, path: exec.path, conf_ms: confMs, compute_units: unitsConsumed,
          fee_lamports: feeLamports, tip_lamports: tipLamports || 0,
          size_base: exec.size_base, notional_quote: exec.notional_quote
        });
      }
    } catch (e: any) {
      noteConsecutiveResult(exec.path, false); noteError();
      let logs: string[] | undefined = e?.logs || e?.data?.logs || e?.value?.logs;
      if (!logs && tx) {
        try {
          const sim = await this.conn.simulateTransaction(tx, { replaceRecentBlockhash: true, sigVerify: true });
          logs = sim?.value?.logs ?? undefined;
        } catch {}
      }
      logger.log("land_error", { error: String(e?.message ?? e), logs });
      emitMl("error", { where: "send", error: String(e?.message ?? e), logs });
    }
  }
}
