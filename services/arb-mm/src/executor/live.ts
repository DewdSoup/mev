// services/arb-mm/src/executor/live.ts
import {
  Connection,
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Keypair,
  SendOptions,
  Commitment,
} from "@solana/web3.js";
import { logger } from "../ml_logger.js";
import { buildRaydiumSwapIx } from "../util/raydium.js";
import { buildPhoenixSwapIxs } from "../util/phoenix.js";
import { toIxArray, assertIxArray } from "../util/ix.js";

const SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS || "50"); // fallback 50 bps
const ATOMIC_MODE = process.env.ATOMIC_MODE || "single_tx";
const DEFAULT_CU_LIMIT = Number(process.env.SUBMIT_CU_LIMIT || "800000");
const DEFAULT_TIP_LAMPORTS = Number(process.env.SUBMIT_TIP_LAMPORTS || "0");
const TIP_MICROLAMPORTS_PER_CU = Number(process.env.TIP_MICROLAMPORTS_PER_CU || "0");
const CONFIRM_LEVEL: Commitment =
  (process.env.TX_CONFIRM_LEVEL as Commitment) || "confirmed";

function uiToAtoms(ui: number, decimals: number): bigint {
  return BigInt(Math.floor(ui * 10 ** decimals));
}

export type AtomicPath = "PHX->AMM" | "AMM->PHX";

function extractIxsFromPhoenixBuild(built: any) {
  // Normalize various shapes the phoenix builder might return.
  // Supported:
  //   - TransactionInstruction[]
  //   - { ixs: TransactionInstruction[] }
  //   - { ok: true, ixs: TransactionInstruction[] }
  //   - { ok: false, reason: string }
  if (!built) return { ixs: [] as TransactionInstruction[], reason: "phoenix_build_returned_null" };

  if (Array.isArray(built)) {
    return { ixs: toIxArray(built) };
  }

  if (typeof built === "object") {
    if ("ok" in built) {
      if (built.ok && (built as any).ixs) {
        return { ixs: toIxArray((built as any).ixs) };
      }
      const r = (built as any).reason ?? "phoenix_builder_not_ok";
      return { ixs: [] as TransactionInstruction[], reason: String(r) };
    }

    if ("ixs" in built) {
      return { ixs: toIxArray((built as any).ixs) };
    }
  }

  return { ixs: [] as TransactionInstruction[], reason: "phoenix_build_unrecognized_shape" };
}

export class LiveExecutor {
  constructor(
    private conn: Connection,
    private payer: Keypair,
    private sendOpts: SendOptions = { skipPreflight: false, preflightCommitment: "processed" }
  ) { }

  async startPhoenix(): Promise<void> {
    /* no-op for compatibility */
  }

  async maybeExecute(payload: any): Promise<void> {
    try {
      const path = (payload?.path as AtomicPath) || "PHX->AMM";
      const sizeBase = Number(payload?.size_base ?? payload?.trade_size_base ?? 0);
      const phoenix = payload?.phoenix || {};

      if (!phoenix?.market) {
        logger.log("submit_error", { where: "maybe_execute", error: "missing_phoenix_market" });
        return;
      }

      const market = new PublicKey(phoenix.market);

      // ───────────────────────────────────────────────────────────────────────────
      // 1) Build Phoenix leg or use provided; normalize & validate
      let phxIxs: TransactionInstruction[] = Array.isArray(payload?.phxIxs)
        ? toIxArray(payload.phxIxs)
        : [];

      if (!phxIxs.length) {
        const limitPx = Number(
          phoenix.limit_px ?? phoenix.limitPx ?? (payload?.sell_px ?? payload?.buy_px)
        );
        const slippageBps = Number(process.env.PHOENIX_SLIPPAGE_BPS ?? "3");

        const phxParams = {
          market: market.toBase58(),
          side: phoenix.side, // "buy" | "sell"
          sizeBase,
          limitPx,
          slippageBps,
        };
        logger.log("phoenix_build_params", phxParams);

        try {
          const built: any = await buildPhoenixSwapIxs({
            connection: this.conn,
            owner: this.payer.publicKey,
            market,
            side: phoenix.side,
            sizeBase,
            limitPx,
            slippageBps,
          } as any);

          logger.log("phoenix_build_result_shape", {
            type: typeof built,
            hasIxsField: built && typeof built === "object" && "ixs" in built,
            isArray: Array.isArray(built),
            keys: built && typeof built === "object" ? Object.keys(built) : null,
          });

          // Parse instructions from whatever shape the helper returns.
          const parsed = extractIxsFromPhoenixBuild(built);
          phxIxs = parsed.ixs;
          if (!phxIxs.length) {
            const reason = (built as any)?.reason ?? parsed.reason ?? "phoenix_build_returned_no_instructions";
            let hint = "";
            if (reason === "below_min_base_lot") {
              const min = (built as any)?.debug?.metaSummary?.baseUnitsPerLot;
              hint = `size below Phoenix min lot. min_base_size=${min}`;
            } else if (reason === "no_method_match" || reason === "phoenix_swap_helper_unavailable_in_sdk") {
              hint = "SDK method mismatch (ticks/lots vs ui units). Check phoenix_sdk_pick log for methods.";
            }
            logger.log("submit_error", {
              where: "phoenix_build",
              error: reason,
              debug: (built as any)?.debug ?? phxParams,
              hint,
            });
            return;
          }
        } catch (e: any) {
          logger.log("submit_error", { where: "phoenix_build", error: String(e?.message ?? e) });
          return;
        }
      }

      assertIxArray(phxIxs, "phoenix");

      // ───────────────────────────────────────────────────────────────────────────
      // 2) Build Raydium leg (minOut inside builder), normalize & validate
      const baseIn =
        path === "PHX->AMM"
          ? true // buy on PHX → now hold BASE → AMM leg is BASE->QUOTE
          : false; // buy BASE on AMM → AMM leg is QUOTE->BASE

      let amountInAtoms: bigint;
      if (baseIn) {
        amountInAtoms = uiToAtoms(sizeBase, 9); // BASE atoms
      } else {
        const px = Number(
          phoenix.limit_px ?? phoenix.limitPx ?? payload?.buy_px ?? payload?.sell_px ?? 0
        );
        const quoteInUi = Math.max(0, sizeBase * (px || 0));
        amountInAtoms = uiToAtoms(quoteInUi, 6);
      }

      const ray = await buildRaydiumSwapIx({
        user: this.payer.publicKey,
        baseIn,
        amountInBase: amountInAtoms,
        slippageBps: SLIPPAGE_BPS,
      });
      if (!ray.ok) {
        logger.log("submit_error", { where: "raydium_build", error: ray.reason });
        return;
      }

      const rayIxs: TransactionInstruction[] = toIxArray(ray.ixs);
      if (!rayIxs.length) {
        logger.log("submit_error", { where: "maybe_execute", error: "no_ray_ixs" });
        return;
      }
      assertIxArray(rayIxs, "raydium");

      // ───────────────────────────────────────────────────────────────────────────
      // 3) Pre-instructions (CU limit / priority fee)
      const preIxs: TransactionInstruction[] = [];
      const cuLimit = Number(process.env.SUBMIT_CU_LIMIT ?? DEFAULT_CU_LIMIT);
      if (cuLimit > 0) {
        preIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
      }
      if (TIP_MICROLAMPORTS_PER_CU > 0) {
        preIxs.push(
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: TIP_MICROLAMPORTS_PER_CU })
        );
      } else if (DEFAULT_TIP_LAMPORTS > 0) {
        // Fallback "tip" (less effective than unit price; retained for compatibility)
        preIxs.push(
          SystemProgram.transfer({
            fromPubkey: this.payer.publicKey,
            toPubkey: this.payer.publicKey,
            lamports: DEFAULT_TIP_LAMPORTS,
          })
        );
      }

      // ───────────────────────────────────────────────────────────────────────────
      // 4) Order the legs and build the tx
      const ordered =
        path === "PHX->AMM"
          ? [...preIxs, ...phxIxs, ...rayIxs]
          : [...preIxs, ...rayIxs, ...phxIxs];

      const ixs = ordered as TransactionInstruction[];
      assertIxArray(ixs, "ordered");

      logger.log("submit_ixs", {
        ray: rayIxs.length,
        phx: phxIxs.length,
        pre: preIxs.length,
        total: ixs.length,
      });

      const latest = await this.conn.getLatestBlockhash("finalized");
      const msg = new TransactionMessage({
        payerKey: this.payer.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: ixs,
      }).compileToV0Message();

      const tx = new VersionedTransaction(msg);
      tx.sign([this.payer]); // ensure the transaction is signed

      logger.log("tx_built", {
        path,
        trade_size_base: sizeBase,
        atomic_mode: ATOMIC_MODE,
        cu_limit: cuLimit,
        tip_lamports: DEFAULT_TIP_LAMPORTS,
        tip_micro_per_cu: TIP_MICROLAMPORTS_PER_CU,
      });

      const sig = await this.conn.sendTransaction(tx, this.sendOpts);
      logger.log("submitted_tx", { signature: sig, path, atomic_mode: ATOMIC_MODE });

      const conf = await this.conn.confirmTransaction(
        { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        CONFIRM_LEVEL
      );
      const ok = !conf?.value?.err;
      logger.log("landed", {
        signature: sig,
        status: ok ? "ok" : "err",
        err: conf?.value?.err || null,
        commitment: CONFIRM_LEVEL,
      });
    } catch (e: any) {
      logger.log("submit_error", { where: "maybe_execute", error: String(e?.message ?? e) });
    }
  }
}
