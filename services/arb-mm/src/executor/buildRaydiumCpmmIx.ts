// services/arb-mm/src/executor/buildRaydiumCpmmIx.ts
// Raydium CPMM v4 fixed-in swap builder for @raydium-io/raydium-sdk (v1).
// - Uses explicit ATAs for tokenAccountIn/out
// - Uses BN for in/out amounts
// - Handles common SDK return shapes safely
// - Avoids incorrect Token constructions that caused runtime errors

import {
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  Liquidity,
  SPL_ACCOUNT_LAYOUT,
} from "@raydium-io/raydium-sdk";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function ensureIxArray(ixs: any, label: string): TransactionInstruction[] {
  const arr: any[] = Array.isArray(ixs) ? ixs : ixs ? [ixs] : [];
  for (let i = 0; i < arr.length; i++) {
    const ix = arr[i];
    if (
      !ix ||
      typeof ix !== "object" ||
      !ix.programId ||
      !ix.keys ||
      typeof ix.data === "undefined"
    ) {
      throw new Error(`${label}: bad instruction at index ${i}`);
    }
  }
  return arr as TransactionInstruction[];
}

async function findPoolById(conn: Connection, poolId: PublicKey): Promise<any | null> {
  try {
    // v1 exposes fetchAllPoolKeys for CPMM v4 pools
    const pools: any[] = await (Liquidity as any).fetchAllPoolKeys(conn);
    const pool = pools.find((p: any) => {
      if (p?.id instanceof PublicKey) return (p.id as PublicKey).equals(poolId);
      if (typeof p?.id === "string") return new PublicKey(p.id).equals(poolId);
      return false;
    });
    if (pool) return pool;
  } catch {
    // fall through
  }

  // Fallback: some builds expose singular by-id lookup
  try {
    if (typeof (Liquidity as any).fetchPoolKeysById === "function") {
      const pool = await (Liquidity as any).fetchPoolKeysById(conn, poolId);
      if (pool) return pool;
    }
  } catch {
    // ignore
  }
  return null;
}

// Optional: read vault amounts if you want to pre-compute minOut using reserves
export async function getVaultReservesFromPool(
  conn: Connection,
  pool: any
): Promise<{ base: bigint; quote: bigint }> {
  const accs = await conn.getMultipleAccountsInfo([pool.baseVault, pool.quoteVault], {
    commitment: "processed" as any,
  });
  if (!accs[0]?.data || !accs[1]?.data) throw new Error("raydium_pool_reserves_missing");
  const baseInfo: any = SPL_ACCOUNT_LAYOUT.decode(accs[0].data);
  const quoteInfo: any = SPL_ACCOUNT_LAYOUT.decode(accs[1].data);
  const base = BigInt(new BN(baseInfo.amount).toString());
  const quote = BigInt(new BN(quoteInfo.amount).toString());
  return { base, quote };
}

// ───────────────────────────────────────────────────────────────────────────────
// Main builder
// ───────────────────────────────────────────────────────────────────────────────

export async function buildRaydiumCpmmSwapIx(args: {
  connection: Connection;
  owner: PublicKey;
  poolId: PublicKey;
  inMint: PublicKey;
  outMint: PublicKey;
  amountIn: bigint;      // atoms of inMint
  amountOutMin: bigint;  // atoms of outMint
}): Promise<TransactionInstruction[]> {
  const { connection, owner, poolId, inMint, outMint, amountIn, amountOutMin } = args;

  // 1) Discover pool keys (CPMM v4)
  const pool = await findPoolById(connection, poolId);
  if (!pool) {
    throw new Error(`Raydium: pool ${poolId.toBase58()} not found via SDK pool discovery`);
  }

  // 2) Resolve user token accounts (ATAs)
  const ataIn = getAssociatedTokenAddressSync(inMint, owner, false, TOKEN_PROGRAM_ID);
  const ataOut = getAssociatedTokenAddressSync(outMint, owner, false, TOKEN_PROGRAM_ID);

  // 3) BN amounts expected by v1 builder
  const amountInBn = new BN(amountIn.toString());
  const minOutBn = new BN(amountOutMin.toString());

  // 4) Build swap instructions — try known signatures in safe order
  type BuilderResult =
    | TransactionInstruction[]
    | { instructions?: TransactionInstruction[] }
    | { innerTransaction?: { instructions?: TransactionInstruction[] } };

  const tryMake = async (): Promise<BuilderResult> => {
    const build: any = (Liquidity as any).makeSwapFixedInInstruction;
    if (typeof build !== "function") {
      throw new Error("Raydium: makeSwapFixedInInstruction is not available in this SDK build");
    }

    // Variant A: canonical v1 signature
    try {
      return await build({
        connection,
        poolKeys: pool,
        userKeys: {
          owner,
          payer: owner,
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
        },
        amountIn: amountInBn,
        minAmountOut: minOutBn,
      });
    } catch (e) {
      // Variant B: some builds require explicit version as numeric second arg
      try {
        return await build(
          {
            connection,
            poolKeys: pool,
            userKeys: {
              owner,
              payer: owner,
              tokenAccountIn: ataIn,
              tokenAccountOut: ataOut,
            },
            amountIn: amountInBn,
            minAmountOut: minOutBn,
          },
          4 // CPMM v4
        );
      } catch {
        // Variant C: options-like object as second arg
        return await build(
          {
            connection,
            poolKeys: pool,
            userKeys: {
              owner,
              payer: owner,
              tokenAccountIn: ataIn,
              tokenAccountOut: ataOut,
            },
            amountIn: amountInBn,
            minAmountOut: minOutBn,
          },
          { version: 4 }
        );
      }
    }
  };

  let built: BuilderResult;
  try {
    built = await tryMake();
  } catch (e: any) {
    // Last resort: older helper name in some forks
    const simple: any = (Liquidity as any).makeSwapInstructionSimple;
    if (typeof simple === "function") {
      built = await simple({
        connection,
        poolKeys: pool,
        userKeys: {
          owner,
          payer: owner,
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
        },
        amountIn: amountInBn,
        minAmountOut: minOutBn,
        fixedSide: "in",
      });
    } else {
      throw new Error(`Raydium: swap builder unavailable (${e?.message ?? "unknown"})`);
    }
  }

  // 5) Normalize return shapes
  const ixs =
    (built as any)?.innerTransaction?.instructions ??
    (built as any)?.instructions ??
    built;

  const out = ensureIxArray(ixs, "raydium_inner_instructions");
  if (!out.length) throw new Error("Raydium: swap builder returned no instructions");
  return out;
}
