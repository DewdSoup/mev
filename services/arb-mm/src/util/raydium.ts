// services/arb-mm/src/utils/raydium.ts
// Phase 4: minimal Raydium CPMM swap-ix builder that is safe to simulate.
// We build a Raydium-program-targeted ix so simulateTransaction exercises the
// on-chain program path (for timing + CU), while price/EV still come from CPMM math.
// IMPORTANT: We do NOT include a ComputeBudget ix here; callers decide that to
// avoid the “duplicate instruction” error you saw.

import { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const CPMM_PROGRAM_ID = new PublicKey(
  process.env.RAYDIUM_CPMM_PROGRAM_ID ??
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" // Raydium AMM/CPMM program
);

export const SOL_MINT = new PublicKey(
  process.env.SOL_MINT ?? "So11111111111111111111111111111111111111112"
);

export const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

export const DEFAULT_SOL_USDC_POOL = new PublicKey(
  process.env.RAYDIUM_POOL_ID_SOL_USDC ??
  "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"
);

export type CpmmIxBuildResult =
  | { ok: true; ixs: TransactionInstruction[] }
  | { ok: false; reason: string };

export function buildRaydiumSwapFixedInIx(params: {
  user: PublicKey;
  poolId?: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseIn: boolean;
  amountInBase: bigint; // atoms of base mint
  slippageBps: number;  // 1 = 0.01%
}): CpmmIxBuildResult {
  try {
    // NOTE: This is a *simulate-safe* skeleton ix that targets the Raydium program
    // with a small, structured payload. It’s sufficient to get stable timing
    // and compute-units from simulateTransaction without wiring every pool account.
    // All *pricing* still comes from our CPMM math.

    // Tiny payload that encodes fixed-in vs fixed-out & a slippage hint.
    // (The program will ignore/err internally during sim, which is fine; we only
    // care about latency + CU here in Phase 4.)
    const tagSwapFixedIn = 1; // discriminator placeholder
    const slip = Math.max(0, Math.min(10_000, Math.floor(params.slippageBps)));
    const payload = Buffer.alloc(5);
    payload.writeUInt8(tagSwapFixedIn, 0);
    payload.writeUInt32LE(slip, 1);

    const ix = new TransactionInstruction({
      programId: CPMM_PROGRAM_ID,
      keys: [
        // Minimal writable/signer to make the ix well-formed for sim.
        // We avoid bringing in hundreds of accounts here; Phase 5 will wire real accounts.
        { pubkey: params.user, isSigner: true, isWritable: false },
        { pubkey: params.poolId ?? DEFAULT_SOL_USDC_POOL, isSigner: false, isWritable: false },
        { pubkey: params.baseMint, isSigner: false, isWritable: false },
        { pubkey: params.quoteMint, isSigner: false, isWritable: false },
      ],
      data: payload,
    });

    return { ok: true, ixs: [ix] };
  } catch (e) {
    return { ok: false, reason: `raydium_swap_ix_build_failed: ${String(e)}` };
  }
}
