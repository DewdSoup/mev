// services/arb-mm/src/executor/buildRaydiumCpmmIx.ts
// Raydium CPMM v4 fixed-in swap builder for @raydium-io/raydium-sdk (v1).
// CHANGES:
// - ❌ Removed SDK discovery (fetchAllPoolKeys / fetchPoolKeysById)
// - ✅ Loads full pool-keys from disk (configs/raydium.pool.json) with env overrides
// - ✅ Verifies pool id matches env to avoid mismatched keys
// - ✅ Keeps robust return-shape handling + ATA resolution

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  Liquidity,
} from "@raydium-io/raydium-sdk";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

// ───────────────────────────────────────────────────────────────────────────────
// ESM-safe dirname
const __filename = fileURLToPath(import.meta.url);
const __here = path.dirname(__filename);

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

function getenv(k: string) {
  const v = process.env[k];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function findPoolJsonPath(): string {
  // 1) env
  const envs = [
    getenv("RAYDIUM_POOL_JSON_PATH"),
    getenv("RAYDIUM_POOL_KEYS_JSON"),
    getenv("RAYDIUM_POOLS_FILE"),
  ];
  for (const e of envs) {
    if (e && fs.existsSync(e)) return path.resolve(e);
  }
  // 2) repo-relative fallbacks
  const candidates = [
    path.resolve(process.cwd(), "configs", "raydium.pool.json"),
    path.resolve(process.cwd(), "..", "configs", "raydium.pool.json"),
    path.resolve(process.cwd(), "..", "..", "configs", "raydium.pool.json"),
    path.resolve(__here, "..", "..", "configs", "raydium.pool.json"),
    path.resolve(__here, "..", "..", "..", "configs", "raydium.pool.json"),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;

  throw new Error(
    "Raydium: missing full keys file. Set RAYDIUM_POOL_JSON_PATH or place configs/raydium.pool.json"
  );
}

type DiskPoolKeys = {
  id: string;
  programId: string;
  authority: string;
  openOrders: string;
  targetOrders: string;
  baseVault: string;
  quoteVault: string;
  withdrawQueue: string;
  lpVault: string;
  baseMint: string;
  quoteMint: string;
  marketProgramId: string;
  marketId: string;
  marketBids: string;
  marketAsks: string;
  marketEventQueue: string;
  marketBaseVault: string;
  marketQuoteVault: string;
  marketAuthority?: string;
  lpMint?: string;
  version: 4 | 5 | number;
};

function readDiskPool(): DiskPoolKeys {
  const p = findPoolJsonPath();
  const j = JSON.parse(fs.readFileSync(p, "utf8")) as DiskPoolKeys;
  const req = [
    "id",
    "programId",
    "authority",
    "openOrders",
    "targetOrders",
    "baseVault",
    "quoteVault",
    "withdrawQueue",
    "lpVault",
    "baseMint",
    "quoteMint",
    "marketProgramId",
    "marketId",
    "marketBids",
    "marketAsks",
    "marketEventQueue",
    "marketBaseVault",
    "marketQuoteVault",
    "version",
  ] as const;
  for (const k of req) {
    // @ts-ignore
    if (!j[k]) throw new Error(`Raydium: pool-keys JSON invalid (missing ${k})`);
  }
  return j;
}

function toPoolKeys(d: DiskPoolKeys): any /* LiquidityPoolKeys */ {
  const v = (d.version === 5 ? 5 : 4) as 4 | 5;
  const out = {
    id: new PublicKey(d.id),
    baseMint: new PublicKey(d.baseMint),
    quoteMint: new PublicKey(d.quoteMint),
    lpMint: new PublicKey(d.lpMint ?? d.baseMint), // satisfy type
    version: v,
    programId: new PublicKey(d.programId),
    authority: new PublicKey(d.authority),
    openOrders: new PublicKey(d.openOrders),
    targetOrders: new PublicKey(d.targetOrders),
    baseVault: new PublicKey(d.baseVault),
    quoteVault: new PublicKey(d.quoteVault),

    marketProgramId: new PublicKey(d.marketProgramId),
    marketId: new PublicKey(d.marketId),
    marketBids: new PublicKey(d.marketBids),
    marketAsks: new PublicKey(d.marketAsks),
    marketEventQueue: new PublicKey(d.marketEventQueue),
    marketBaseVault: new PublicKey(d.marketBaseVault),
    marketQuoteVault: new PublicKey(d.marketQuoteVault),

    withdrawQueue: new PublicKey(d.withdrawQueue),
    lpVault: new PublicKey(d.lpVault),

    ...(d.marketAuthority
      ? { marketAuthority: new PublicKey(d.marketAuthority) }
      : {}),
  };
  return out;
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
  amountIn: bigint; // atoms of inMint
  amountOutMin: bigint; // atoms of outMint
}): Promise<TransactionInstruction[]> {
  const { connection, owner, poolId, inMint, outMint, amountIn, amountOutMin } =
    args;

  // 1) Load full pool-keys from disk (no SDK discovery)
  const disk = readDiskPool();
  const diskId = new PublicKey(disk.id);
  if (!diskId.equals(poolId)) {
    throw new Error(
      `Raydium: pool id mismatch (env=${poolId.toBase58()} json=${diskId.toBase58()})`
    );
  }
  const pool = toPoolKeys(disk);

  // 2) Resolve user token accounts (ATAs)
  const ataIn = getAssociatedTokenAddressSync(
    inMint,
    owner,
    false,
    TOKEN_PROGRAM_ID
  );
  const ataOut = getAssociatedTokenAddressSync(
    outMint,
    owner,
    false,
    TOKEN_PROGRAM_ID
  );

  // 3) BN amounts expected by builders
  const amountInBn = new BN(amountIn.toString());
  const minOutBn = new BN(amountOutMin.toString());

  // 4) Build swap instructions — try known signatures in safe order
  type BuilderResult =
    | TransactionInstruction[]
    | { instructions?: TransactionInstruction[] }
    | { innerTransaction?: { instructions?: TransactionInstruction[] } }
    | { innerTransactions?: Array<{ instructions?: TransactionInstruction[] }> };

  const tryMake = async (): Promise<BuilderResult> => {
    const build: any = (Liquidity as any).makeSwapFixedInInstruction;
    if (typeof build !== "function") {
      throw new Error(
        "Raydium: makeSwapFixedInInstruction not available in this SDK build"
      );
    }
    // Variant A: canonical
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
      // Variant B: explicit version
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
          4
        );
      } catch {
        // Variant C: options object
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
      const r = await simple({
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
      built = r;
    } else {
      throw new Error(
        `Raydium: swap builder unavailable (${e?.message ?? "unknown"})`
      );
    }
  }

  // 5) Normalize return shapes
  const ixs =
    (built as any)?.innerTransaction?.instructions ??
    (built as any)?.instructions ??
    (Array.isArray((built as any)?.innerTransactions)
      ? (built as any).innerTransactions.flatMap((it: any) => it?.instructions ?? [])
      : undefined) ??
    built;

  const out = ensureIxArray(ixs, "raydium_inner_instructions");
  if (!out.length)
    throw new Error("Raydium: swap builder returned no instructions");
  return out;
}
