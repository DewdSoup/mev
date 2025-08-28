// services/arb-mm/src/execute/maybeExecute.ts
// Hardened atomic executor: validates instruction shape, probes compile,
// builds v0 message, sends, and confirms with structured results.

import {
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
  Signer,
  SendOptions,
  Commitment,
  TransactionInstruction,
} from "@solana/web3.js";
import { connection } from "../infra/connections.js";
import { logger } from "../ml_logger.js";

type Only = "phx" | "ray" | "both";

export interface ExecOpts {
  only?: Only;
  cuLimit?: number;                    // default from env or 400k
  cuPriceMicroLamports?: number;       // priority fee per CU
  tipLamports?: number;                // fallback tip
  confirmLevel?: Commitment;           // default 'confirmed'
  skipPreflight?: boolean;             // default false
  label?: string;                      // optional tag for logs
}

function isIx(x: any): x is TransactionInstruction {
  return (
    x &&
    typeof x === "object" &&
    x.programId &&
    typeof x.programId.equals === "function" &&
    Array.isArray(x.keys) &&
    x.data instanceof Uint8Array
  );
}

function normalizeIxs(arr: any, tag: string): TransactionInstruction[] {
  if (!arr) return [];
  if (Array.isArray(arr)) {
    const out: TransactionInstruction[] = [];
    for (let i = 0; i < arr.length; i++) {
      const ix = arr[i];
      if (isIx(ix)) {
        out.push(ix);
      } else {
        logger.log("ix_shape_invalid", { tag, index: i, keys: Object.keys(ix || {}), typeof: typeof ix });
      }
    }
    return out;
  }
  // single ix
  return isIx(arr) ? [arr] : [];
}

async function probeCompile(owner: PublicKey, ixs: TransactionInstruction[]) {
  // Compile incrementally to find first offender
  for (let i = 0; i < ixs.length; i++) {
    try {
      const { blockhash } = await connection.getLatestBlockhash("processed");
      const msg = new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions: ixs.slice(0, i + 1),
      }).compileToV0Message();
      void msg;
    } catch (e: any) {
      const ix = ixs[i];
      logger.log("ix_encode_failure", {
        index: i,
        programId: ix?.programId?.toBase58?.(),
        dataLen: ix?.data?.length,
        numAccounts: ix?.keys?.length,
        err: String(e?.message ?? e),
      });
      throw e;
    }
  }
}

export async function maybeExecute(
  owner: Signer & { publicKey: PublicKey },
  phxIxsIn: TransactionInstruction[] | any,
  rayIxsIn: TransactionInstruction[] | any,
  opts: ExecOpts = {}
): Promise<{ ok: boolean; signature?: string; reason?: string; debug?: any }> {
  try {
    const label = opts.label ?? "atomic";
    const only: Only =
      opts.only ??
      (process.env.ONLY_PHX ? "phx" : process.env.ONLY_RAY ? "ray" : "both");

    const phxIxs = normalizeIxs(phxIxsIn, "phoenix");
    const rayIxs = normalizeIxs(rayIxsIn, "raydium");

    if (only === "phx" && phxIxs.length === 0) {
      return { ok: false, reason: "no_phx_ixs" };
    }
    if (only === "ray" && rayIxs.length === 0) {
      return { ok: false, reason: "no_ray_ixs" };
    }
    if (only === "both" && (phxIxs.length === 0 || rayIxs.length === 0)) {
      return { ok: false, reason: "missing_one_leg", debug: { phx: phxIxs.length, ray: rayIxs.length } };
    }

    // Pre-instructions (CU budget / priority fee)
    const pre: TransactionInstruction[] = [];
    const cuLimit = Math.max(
      0,
      Number.isFinite(Number(opts.cuLimit))
        ? Number(opts.cuLimit)
        : Number(process.env.SUBMIT_CU_LIMIT ?? 400_000)
    );
    if (cuLimit > 0) {
      pre.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    }
    const cuPrice = Number.isFinite(Number(opts.cuPriceMicroLamports))
      ? Number(opts.cuPriceMicroLamports)
      : Number(process.env.TIP_MICROLAMPORTS_PER_CU ?? 0);
    if (cuPrice > 0) {
      pre.push(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice })
      );
    }

    // Order legs
    const body =
      only === "phx" ? phxIxs
        : only === "ray" ? rayIxs
          : [...phxIxs, ...rayIxs];

    const instructions = [...pre, ...body];

    // Visibility
    logger.log("submit_ixs", {
      label,
      pre: pre.length,
      phx: phxIxs.length,
      ray: rayIxs.length,
      total: instructions.length,
    });

    // Compile-probe to catch malformed ixs early with pinpointed logs
    await probeCompile(owner.publicKey, instructions);

    // Build final message, sign, send, confirm
    const confirmLevel: Commitment = (opts.confirmLevel as Commitment) || "confirmed";
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
    const msg = new TransactionMessage({
      payerKey: owner.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([owner]);

    const sendOpts: SendOptions = {
      skipPreflight: Boolean(opts.skipPreflight ?? false),
      preflightCommitment: "processed",
      maxRetries: 3,
    };

    const sig = await connection.sendTransaction(tx, sendOpts);
    logger.log("submitted_tx", { label, signature: sig });

    const conf = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      confirmLevel
    );
    const ok = !conf?.value?.err;
    logger.log("landed", {
      signature: sig,
      status: ok ? "ok" : "err",
      err: conf?.value?.err || null,
      commitment: confirmLevel,
      label,
    });

    return ok ? { ok: true, signature: sig } : { ok: false, reason: "confirm_err", debug: conf?.value?.err };
  } catch (e: any) {
    logger.log("submit_error", { where: "maybe_execute", error: String(e?.message ?? e) });
    return { ok: false, reason: String(e?.message ?? e) };
  }
}
