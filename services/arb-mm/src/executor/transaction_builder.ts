// services/arb-mm/src/executor/transaction_builder.ts
// Build swap instructions for ordered execution legs.

import { PublicKey, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { logger } from "../ml_logger.js";
import { buildPhoenixSwapIxs } from "../util/phoenix.js";
import { toIxArray, assertIxArray } from "../util/ix.js";
import { getAdapter } from "../adapters/manifest.js";
import type { QuoteReq as AdapterQuoteReq } from "../adapters/types.js";
import { buildMeteoraDlmmSwapIx } from "./buildMeteoraDlmmIx.js";
import { buildLifinitySwapIx } from "./buildLifinityIx.js";
import {
  lifinityQuoteFromSnapshot,
  refreshLifinitySnapshot,
} from "../util/lifinity.js";
import { buildRaydiumClmmSwapIx } from "./buildRaydiumClmmIx.js";
import { buildRaydiumCpmmSwapIx } from "./buildRaydiumCpmmIx.js";
import { buildOrcaWhirlpoolSwapIx } from "./buildOrcaWhirlpoolIx.js";
import type { ExecutionLeg, PhoenixExecutionLeg, AmmExecutionLeg } from "../types/execution.js";

const DEFAULT_BASE_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_QUOTE_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function uiToAtoms(ui: number, decimals: number): bigint {
  return BigInt(Math.floor(ui * 10 ** decimals));
}

function applyBpsDownBig(x: bigint, bps: number): bigint {
  const BPS = 10_000n;
  const b = BigInt(Math.max(0, Math.min(10_000, Math.ceil(bps))));
  return (x * (BPS - b)) / BPS;
}

export type BuiltLegInstruction = {
  kind: ExecutionLeg["kind"];
  instructions: TransactionInstruction[];
  lookupTables: PublicKey[];
  label?: string;
};

export interface BuildLegSequenceParams {
  connection: Connection;
  payer: Keypair;
  legs: ExecutionLeg[];
  slippageBps: number;
  phoenixSlippageBps: number;
  resolvePoolId: (venue: string, poolId: string) => string;
  getMintHints?: (leg: ExecutionLeg) => { baseMint?: string; quoteMint?: string };
}

async function buildPhoenixLeg(
  conn: Connection,
  payer: Keypair,
  leg: PhoenixExecutionLeg,
  phoenixSlippageBps: number
): Promise<TransactionInstruction[]> {
  const marketPk = new PublicKey(leg.market);
  const slippage = leg.slippageBps ?? phoenixSlippageBps;
  const built: any = await buildPhoenixSwapIxs({
    connection: conn,
    owner: payer.publicKey,
    market: marketPk,
    side: leg.side,
    sizeBase: leg.sizeBase,
    limitPx: leg.limitPx,
    slippageBps: slippage,
  } as any);

  let instructions: TransactionInstruction[] = [];
  if (Array.isArray(built)) instructions = toIxArray(built);
  else if (built && typeof built === "object" && "ixs" in built) instructions = toIxArray((built as any).ixs);
  else if (built && typeof built === "object" && "ok" in built && (built as any).ok && (built as any).ixs) {
    instructions = toIxArray((built as any).ixs);
  }

  if (!instructions.length) {
    throw new Error("phoenix_build_returned_no_instructions");
  }
  assertIxArray(instructions, "phoenix");
  logger.log("phoenix_build_ok", { market: leg.market, side: leg.side, size: leg.sizeBase, ixs: instructions.length });
  return instructions;
}

async function buildAmmLeg(
  conn: Connection,
  payer: Keypair,
  leg: AmmExecutionLeg,
  slippageBps: number,
  resolvePoolId: (venue: string, poolId: string) => string,
  mintHints?: { baseMint?: string; quoteMint?: string }
): Promise<{ instructions: TransactionInstruction[]; lookupTables: PublicKey[] }> {
  const venue = leg.venue.toLowerCase();
  const poolKind = (leg.poolKind ?? "").toLowerCase();
  const poolId = resolvePoolId(venue, leg.poolId);
  if (!poolId) throw new Error(`missing_pool_id_${venue}`);
  if (!(leg.refPx > 0)) throw new Error(`${venue}_no_ref_px`);

  const baseMintRaw = (mintHints?.baseMint ?? "").trim();
  const quoteMintRaw = (mintHints?.quoteMint ?? "").trim();
  const baseMint = baseMintRaw || DEFAULT_BASE_MINT;
  const quoteMint = quoteMintRaw || DEFAULT_QUOTE_MINT;
  const baseIn = leg.direction === "baseToQuote";

  const adapter = getAdapter(venue);
  if (adapter && typeof adapter.buildSwapIxs === "function") {
    try {
      const adapterReq: AdapterQuoteReq = {
        poolId,
        inBase: leg.sizeBase,
        direction: leg.direction,
        slippageBps,
        baseMint,
        quoteMint,
      };
      const adapterIxs = await adapter.buildSwapIxs(
        conn,
        payer.publicKey.toBase58(),
        adapterReq,
        { refPx: leg.refPx }
      );
      assertIxArray(adapterIxs, `${venue}_adapter`);
      logger.log("adapter_build_ok", { venue, pool: poolId, leg: leg.label, ixs: adapterIxs.length });
      return { instructions: adapterIxs, lookupTables: [] };
    } catch (adapterErr) {
      logger.log("adapter_build_error", {
        venue,
        pool: poolId,
        leg: leg.label,
        err: String((adapterErr as any)?.message ?? adapterErr),
      });
    }
  }

  if (venue === "meteora") {
    const built = await buildMeteoraDlmmSwapIx({
      connection: conn,
      user: payer.publicKey,
      poolId,
      baseIn,
      sizeBase: leg.sizeBase,
      refPx: leg.refPx,
      slippageBps,
      baseMint,
      quoteMint,
    });
    if (!built.ok) throw new Error(built.reason);
    const ixs = built.ixs;
    assertIxArray(ixs, "meteora");
    logger.log("meteora_build_ok", { ixs: ixs.length, pool: poolId, leg: leg.label });
    return { instructions: ixs, lookupTables: [] };
  }

  if (venue === "lifinity") {
    const snapshot = await refreshLifinitySnapshot({
      connection: conn,
      poolId: new PublicKey(poolId),
      expectedBaseMint: baseMint ? new PublicKey(baseMint) : undefined,
      expectedQuoteMint: quoteMint ? new PublicKey(quoteMint) : undefined,
    });

    const quote = lifinityQuoteFromSnapshot({
      snapshot,
      sizeBase: leg.sizeBase,
      direction: baseIn ? "baseToQuote" : "quoteToBase",
    });

    if (!quote.ok) throw new Error(quote.err);

    const amountInAtoms = baseIn
      ? uiToAtoms(leg.sizeBase, snapshot.meta.baseDecimals)
      : uiToAtoms(leg.sizeBase * quote.price, snapshot.meta.quoteDecimals);

    const expectedOutUi = baseIn ? leg.sizeBase * quote.price : leg.sizeBase;
    const minOutUi = expectedOutUi * (1 - slippageBps / 10_000);
    const minOutAtoms = uiToAtoms(
      minOutUi,
      baseIn ? snapshot.meta.quoteDecimals : snapshot.meta.baseDecimals
    );

    const built = await buildLifinitySwapIx({
      connection: conn,
      poolSnapshot: snapshot,
      user: payer.publicKey,
      baseIn,
      amountIn: amountInAtoms,
      minimumOut: minOutAtoms,
    });

    const ixs = built.ixs;
    assertIxArray(ixs, "lifinity");
    logger.log("lifinity_build_ok", { ixs: ixs.length, pool: poolId, leg: leg.label });
    return { instructions: ixs, lookupTables: [] };
  }

  if (venue === "raydium" && poolKind === "clmm") {
    const amountInAtoms = baseIn
      ? uiToAtoms(leg.sizeBase, 9)
      : uiToAtoms(leg.sizeBase * leg.refPx, 6);

    const expectedOutAtoms = baseIn
      ? uiToAtoms(leg.sizeBase * leg.refPx, 6)
      : uiToAtoms(leg.sizeBase, 9);

    const clmm = await buildRaydiumClmmSwapIx({
      connection: conn,
      user: payer.publicKey,
      poolId,
      baseIn,
      amountInAtoms,
      expectedOutAtoms,
      slippageBps,
    });
    if (!clmm.ok) throw new Error(clmm.reason);
    const ixs = clmm.ixs;
    assertIxArray(ixs, "raydium_clmm");
    logger.log("raydium_clmm_build_ok", { ixs: ixs.length, pool: poolId, leg: leg.label });
    return { instructions: ixs, lookupTables: clmm.lookupTables ?? [] };
  }

  if (venue === "raydium") {
    const poolPk = new PublicKey(poolId);
    const inMint = baseIn ? new PublicKey(baseMint ?? "So11111111111111111111111111111111111111112") : new PublicKey(quoteMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const outMint = baseIn ? new PublicKey(quoteMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") : new PublicKey(baseMint ?? "So11111111111111111111111111111111111111112");

    const amountInAtoms = baseIn
      ? uiToAtoms(leg.sizeBase, 9)
      : uiToAtoms(leg.sizeBase * Math.max(1, leg.refPx), 6);

    const usedSlip = Math.max(0, slippageBps);
    const outAtomsRef = baseIn
      ? uiToAtoms(leg.sizeBase * leg.refPx, 6)
      : uiToAtoms(leg.sizeBase, 9);
    const minOut = applyBpsDownBig(outAtomsRef, usedSlip);

    const ixs = await buildRaydiumCpmmSwapIx({
      connection: conn,
      owner: payer.publicKey,
      poolId: poolPk,
      inMint,
      outMint,
      amountIn: amountInAtoms,
      amountOutMin: minOut,
    });
    assertIxArray(ixs, "raydium_cpmm");
    logger.log("raydium_build_ok", { ixs: ixs.length, pool: poolId, leg: leg.label });
    return { instructions: ixs, lookupTables: [] };
  }

  if (venue === "orca") {
    const whirlpoolPk = new PublicKey(poolId);
    const amountInAtoms = baseIn
      ? uiToAtoms(leg.sizeBase, 9)
      : uiToAtoms(leg.sizeBase * leg.refPx, 6);
    const built = await buildOrcaWhirlpoolSwapIx({
      connection: conn,
      user: payer.publicKey,
      poolId: whirlpoolPk.toBase58(),
      baseIn,
      amountInAtoms,
      slippageBps,
    });
    if (!built.ok) throw new Error(built.reason);
    const ixs = built.ixs;
    assertIxArray(ixs, "orca");
    logger.log("orca_build_ok", { ixs: ixs.length, pool: whirlpoolPk.toBase58(), leg: leg.label });
    return { instructions: ixs, lookupTables: [] };
  }

  throw new Error(`unsupported_amm_venue_${venue}`);
}

export async function buildExecutionLegSequence(params: BuildLegSequenceParams): Promise<BuiltLegInstruction[]> {
  const {
    connection,
    payer,
    legs,
    slippageBps,
    phoenixSlippageBps,
    resolvePoolId,
    getMintHints,
  } = params;

  const built: BuiltLegInstruction[] = [];

  for (const leg of legs) {
    if (leg.kind === "phoenix") {
      const instructions = await buildPhoenixLeg(connection, payer, leg, phoenixSlippageBps);
      built.push({ kind: "phoenix", instructions, lookupTables: [], label: leg.side });
    } else {
      const minted = getMintHints ? getMintHints(leg) : undefined;
      const { instructions, lookupTables } = await buildAmmLeg(
        connection,
        payer,
        leg,
        slippageBps,
        resolvePoolId,
        minted
      );
      built.push({ kind: "amm", instructions, lookupTables, label: leg.label });
    }
  }

  return built;
}
