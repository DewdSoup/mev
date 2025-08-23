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
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { logger } from "../ml_logger.js";
import { buildRaydiumSwapIx } from "../util/raydium.js";
import { buildPhoenixSwapIxs } from "../util/phoenix.js";

const WSOL_MINT = new PublicKey(process.env.WSOL_MINT!);
const USDC_MINT = new PublicKey(process.env.USDC_MINT!);

const SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS || "50"); // fallback 50 bps
const ATOMIC_MODE = process.env.ATOMIC_MODE || "single_tx";
const DEFAULT_CU_LIMIT = Number(process.env.SUBMIT_CU_LIMIT || "800000");
const DEFAULT_TIP_LAMPORTS = Number(process.env.SUBMIT_TIP_LAMPORTS || "0");
const CONFIRM_LEVEL: Commitment =
  (process.env.TX_CONFIRM_LEVEL as Commitment) || "confirmed";

function uiToAtoms(ui: number, decimals: number): bigint {
  return BigInt(Math.floor(ui * 10 ** decimals));
}

export type AtomicPath = "PHX->AMM" | "AMM->PHX";

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
      const market = new PublicKey(phoenix.market);

      // 1) Build Phoenix leg if missing
      let phxIxs: TransactionInstruction[] = Array.isArray(payload?.phxIxs) ? payload.phxIxs : [];
      if (!phxIxs.length) {
        try {
          const limitPx = Number(phoenix.limit_px ?? phoenix.limitPx ?? (payload?.sell_px ?? payload?.buy_px));
          const built: any = await buildPhoenixSwapIxs({
            connection: this.conn,
            owner: this.payer.publicKey,
            market,
            side: phoenix.side,            // "buy" or "sell"
            sizeBase: sizeBase,
            limitPx: limitPx,
            slippageBps: Number(process.env.PHOENIX_SLIPPAGE_BPS ?? "3"),
          } as any);
          phxIxs = built?.ixs ?? built ?? [];
        } catch (e: any) {
          logger.log("submit_error", { where: "phoenix_build", error: String(e?.message ?? e) });
          return;
        }
      }

      // 2) Build Raydium leg (we compute minOut on-chain; no eff px required)
      const baseIn =
        path === "PHX->AMM"
          ? true   // buy on PHX → sell BASE on AMM
          : false; // buy BASE on AMM → sell on PHX

      let amountInAtoms: bigint;
      if (baseIn) {
        amountInAtoms = uiToAtoms(sizeBase, 9); // BASE in
      } else {
        // QUOTE in — estimate from limit/side; minOut protects us
        const px = Number(phoenix.limit_px ?? phoenix.limitPx ?? payload?.buy_px ?? payload?.sell_px ?? 0);
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
      const rayIxs = ray.ixs;

      // 3) Pre-instructions
      const preIxs: (TransactionInstruction | undefined)[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: Number(process.env.SUBMIT_CU_LIMIT ?? DEFAULT_CU_LIMIT) }),
        DEFAULT_TIP_LAMPORTS > 0
          ? SystemProgram.transfer({ fromPubkey: this.payer.publicKey, toPubkey: this.payer.publicKey, lamports: DEFAULT_TIP_LAMPORTS })
          : undefined,
      ];

      const ordered: (TransactionInstruction | undefined)[] =
        path === "PHX->AMM"
          ? [...preIxs, ...phxIxs, ...rayIxs]
          : [...preIxs, ...rayIxs, ...phxIxs];

      const ixs = ordered.filter(Boolean) as TransactionInstruction[];
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
        cu_limit: Number(process.env.SUBMIT_CU_LIMIT ?? DEFAULT_CU_LIMIT),
        tip_lamports: DEFAULT_TIP_LAMPORTS,
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
