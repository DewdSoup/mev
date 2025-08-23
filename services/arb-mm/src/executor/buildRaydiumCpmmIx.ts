// services/arb-mm/src/executor/buildRaydiumCpmmIx.ts
// Raydium AMM v4 fixed-in swap wrapper compatible with @raydium-io/raydium-sdk 1.3.1-beta.58.
// - Reuses the caller's Connection (prevents mixed RPCs / 401).
// - Finds pool keys on-chain via fetchAllPoolKeys (no local-schema drift).
// - Uses PublicKey.equals (no string comparisons).
// - Avoids SDK helpers that aren’t exported in this version (e.g., getOwnerTokenAccounts).

import {
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  Liquidity,
  Token,
  TokenAmount,
  Percent,
} from "@raydium-io/raydium-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

function decimalsFromPool(mint: PublicKey, pool: any): number {
  if (mint.equals(pool.baseMint)) return Number(pool.baseDecimals ?? 9);
  if (mint.equals(pool.quoteMint)) return Number(pool.quoteDecimals ?? 6);
  // Fallbacks for SOL/USDC if pool keys didn’t include decimals
  const usdc = process.env.USDC_MINT ? new PublicKey(process.env.USDC_MINT) : null;
  const wsol = process.env.WSOL_MINT ? new PublicKey(process.env.WSOL_MINT) : null;
  if (usdc && mint.equals(usdc)) return 6;
  if (wsol && mint.equals(wsol)) return 9;
  return 9;
}

// Minimal “tokenAccounts” list in the shape Liquidity.makeSwapFixedInInstruction expects.
function buildUserTokenAccounts(owner: PublicKey, mints: PublicKey[], pool: any): any[] {
  return mints.map((mint) => {
    const ata = getAssociatedTokenAddressSync(mint, owner, true);
    return {
      pubkey: ata,
      mint,
      owner,
      isAssociated: true,
      amount: new TokenAmount(new (Token as any)(mint, decimalsFromPool(mint, pool), "T"), "0"),
    } as any;
  });
}

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

  // 1) Fetch all pools, find the one we need. (tolerate string/PublicKey in p.id)
  const pools: any[] = await (Liquidity as any).fetchAllPoolKeys(connection);
  const pool = pools.find((p: any) => {
    if (p?.id instanceof PublicKey) return (p.id as PublicKey).equals(poolId);
    if (typeof p?.id === "string") return new PublicKey(p.id).equals(poolId);
    return false;
  });
  if (!pool) throw new Error(`Raydium: pool ${poolId.toBase58()} not found via fetchAllPoolKeys()`);

  // 2) Token meta + amounts (Token in this SDK expects >=3 args)
  const inDecimals = decimalsFromPool(inMint, pool);
  const outDecimals = decimalsFromPool(outMint, pool);
  const tokenIn = new (Token as any)(inMint, inDecimals, "IN");
  const tokenOut = new (Token as any)(outMint, outDecimals, "OUT");
  const taIn = new TokenAmount(tokenIn, amountIn.toString());
  const taMinOut = new TokenAmount(tokenOut, amountOutMin.toString());

  // 3) User token accounts (ATAs)
  const tokenAccounts = buildUserTokenAccounts(owner, [inMint, outMint], pool);

  // 4) Slippage object (we already priced slippage into minOut)
  const slip = new Percent(1, 10000); // 0.01%

  // 5) Build swap (fixed-in). Version arg is required (4 = AMM v4).
  const { innerTransaction } = await (Liquidity as any).makeSwapFixedInInstruction(
    {
      connection,
      poolKeys: pool,
      userKeys: {
        owner,
        payer: owner,
        tokenAccounts,
      },
      amountIn: taIn,
      minAmountOut: taMinOut,
      tokenIn,
      tokenOut,
      slippage: slip,
    },
    4
  );

  const ixs: TransactionInstruction[] = innerTransaction?.instructions ?? [];
  if (!Array.isArray(ixs) || ixs.length === 0) {
    throw new Error("Raydium: swap builder returned no instructions");
  }
  return ixs;
}
