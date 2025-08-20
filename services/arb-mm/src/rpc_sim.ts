// services/arb-mm/src/rpc_sim.ts
// RPC simulator with two levels:
// - USE_RPC_SIM=true: always run a quick simulate() to measure latency + compute CPMM effective price
// - USE_RAYDIUM_SWAP_SIM=true: build the real Raydium CPMM swap ix via our local builder and simulate it.
//   If anything fails, we fall back to the noop+CPMM path. All fields are additive.

import fs from "fs";
import {
  Connection,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  Keypair,
  PublicKey,
} from "@solana/web3.js";

// ✅ use the local, known-good builder (same one executor/sim.ts uses)
import { buildRaydiumCpmmSwapIx } from "./executor/buildRaydiumCpmmIx.js";

export type RpcSimInput = {
  path: "AMM->PHX" | "PHX->AMM";
  sizeBase: number; // base units (e.g., SOL)
  ammMid: number;   // mid px (quote/base)
  reserves?: { base: number; quote: number };
  ammFeeBps: number;
};

export type RpcSimOutput = {
  rpc_eff_px: number;              // quote per base for AMM leg
  rpc_price_impact_bps: number;    // vs ammMid
  rpc_sim_ms: number;              // wall ms
  rpc_sim_mode: "cpmm-fallback+noop" | "raydium-swap-ix" | "raydium-swap-ix-failed-fallback";
  rpc_sim_error?: string;
  rpc_qty_out?: number;            // quote amount for AMM leg: sizeBase * rpc_eff_px
  rpc_units?: number;              // compute units from simulate()
  prioritization_fee?: number;     // lamports (optional)
};

function round(n: number, p = 6) {
  return Number(n.toFixed(p));
}

// CPMM helpers in human units
function cpmmBuyQuotePerBase(xBase: number, yQuote: number, wantBase: number, feeBps: number) {
  if (!(xBase > 0 && yQuote > 0) || !(wantBase > 0)) return;
  const fee = Math.max(0, feeBps) / 10_000;
  if (wantBase >= xBase * (1 - 1e-9)) return;
  const dqPrime = (wantBase * yQuote) / (xBase - wantBase);
  const dq = dqPrime / (1 - fee);
  if (!Number.isFinite(dq)) return;
  return dq / wantBase;
}
function cpmmSellQuotePerBase(xBase: number, yQuote: number, sellBase: number, feeBps: number) {
  if (!(xBase > 0 && yQuote > 0) || !(sellBase > 0)) return;
  const fee = Math.max(0, feeBps) / 10_000;
  const dbPrime = sellBase * (1 - fee);
  const dy = (yQuote * dbPrime) / (xBase + dbPrime);
  if (!Number.isFinite(dy)) return;
  return dy / sellBase;
}

function loadKeypairMaybe(p?: string): Keypair | undefined {
  try {
    if (!p) return;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const secret = Uint8Array.from(raw);
    return Keypair.fromSecretKey(secret);
  } catch {
    return;
  }
}

// Factory returning a function the joiner can call
export function makeRpcSim(conn: Connection, enabled: boolean) {
  const payer = loadKeypairMaybe(process.env.WALLET_KEYPAIR_PATH || process.env.KEYPAIR_PATH);
  const wantRaydiumSwap = String(process.env.USE_RAYDIUM_SWAP_SIM ?? "").toLowerCase() === "true";

  // optional slippage for the Raydium ix build (bps)
  const SWAP_SLIPPAGE_BPS = Number(process.env.RPC_SIM_SLIPPAGE_BPS ?? 50); // 0.50% default

  // NEW: configurable compute-unit limit for simulate()
  const CU_LIMIT = Number(process.env.RPC_SIM_CU_LIMIT ?? 300_000);
  // NEW: optional microlamports-per-CU → lamports prioritization fee calc
  const CU_PRICE_MICROLAMPORTS = Number(process.env.RPC_SIM_CU_PRICE_MICROLAMPORTS ?? 0);

  return async function rpcSim(input: RpcSimInput): Promise<RpcSimOutput | undefined> {
    if (!enabled) return;
    const { path, sizeBase, ammMid, reserves, ammFeeBps } = input;
    if (!reserves || !(sizeBase > 0) || !(ammMid > 0)) return;

    // Always do a tiny simulate() to get latency + maybe CU
    let simMs = 0;
    let simErr: string | undefined;
    let units: number | undefined;

    try {
      const payerPk: PublicKey =
        payer ? payer.publicKey : new PublicKey("11111111111111111111111111111111");
      const { blockhash } = await conn.getLatestBlockhash("processed");
      const ix1 = ComputeBudgetProgram.setComputeUnitLimit({ units: Math.max(50_000, CU_LIMIT) });
      const ix2 = SystemProgram.transfer({ fromPubkey: payerPk, toPubkey: payerPk, lamports: 0 });
      const msg = new TransactionMessage({
        payerKey: payerPk,
        recentBlockhash: blockhash,
        instructions: [ix1, ix2],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      if (payer) tx.sign([payer]);

      const t0 = Date.now();
      const res = await conn.simulateTransaction(tx, { sigVerify: false, commitment: "processed" });
      simMs = Date.now() - t0;
      // @ts-ignore runtime field (node returns either unitsConsumed or computeUnitsConsumed)
      units = (res as any)?.value?.unitsConsumed ?? (res as any)?.value?.computeUnitsConsumed ?? undefined;
    } catch (e: any) {
      simErr = String(e?.message ?? e);
    }

    // Try full Raydium swap-ix simulate using our builder (same as executor/sim.ts)
    let usedMode: RpcSimOutput["rpc_sim_mode"] = "cpmm-fallback+noop";
    if (wantRaydiumSwap && payer) {
      try {
        // map path to baseIn (buy on AMM when PHX->AMM)
        const baseIn = path === "PHX->AMM";

        // sizeBase is human units (e.g., SOL). Our default pool is SOL(9)/USDC(6).
        // Convert to atoms (BigInt) with 9 decimals.
        const amountInBaseAtoms = BigInt(Math.round(sizeBase * 1e9));

        const built = buildRaydiumCpmmSwapIx({
          user: payer.publicKey,
          baseIn,
          amountInBase: amountInBaseAtoms,
          slippageBps: SWAP_SLIPPAGE_BPS,
        });

        if (built.ok) {
          const { blockhash } = await conn.getLatestBlockhash("processed");
          const vmsg = new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: blockhash,
            instructions: [
              // Exactly one compute-budget ix
              ComputeBudgetProgram.setComputeUnitLimit({ units: Math.max(50_000, CU_LIMIT) }),
              ...built.ixs,
            ],
          }).compileToV0Message();

          const vtx = new VersionedTransaction(vmsg);
          vtx.sign([payer]);

          const t0 = Date.now();
          const simRes = await conn.simulateTransaction(vtx, {
            sigVerify: false,
            replaceRecentBlockhash: true,
            commitment: "processed",
          });
          simMs = Date.now() - t0;
          // @ts-ignore runtime field
          units = (simRes as any)?.value?.unitsConsumed ?? (simRes as any)?.value?.computeUnitsConsumed ?? units;
          usedMode = "raydium-swap-ix";
        } else {
          usedMode = "raydium-swap-ix-failed-fallback";
          simErr = built.reason || simErr;
        }
      } catch (e: any) {
        usedMode = "raydium-swap-ix-failed-fallback";
        simErr = String(e?.message ?? e);
      }
    }

    // Effective price from CPMM math
    const { base, quote } = reserves;
    const feeBps = ammFeeBps;
    let eff: number | undefined;
    if (path === "AMM->PHX") {
      eff = cpmmBuyQuotePerBase(base, quote, sizeBase, feeBps);
    } else {
      eff = cpmmSellQuotePerBase(base, quote, sizeBase, feeBps);
    }
    if (eff == null) return;

    const rpc_eff_px = round(eff);
    const rpc_price_impact_bps = round((rpc_eff_px / ammMid - 1) * 10_000, 4);

    const out: RpcSimOutput = {
      rpc_eff_px,
      rpc_price_impact_bps,
      rpc_sim_ms: simMs,
      rpc_sim_mode: usedMode,
      ...(simErr ? { rpc_sim_error: simErr } : {}),
    };

    // Additive telemetry
    out.rpc_qty_out = round(sizeBase * rpc_eff_px, 9);
    if (units != null && Number.isFinite(units)) out.rpc_units = Number(units);

    // Optional: prioritization fee (lamports) from microlamports-per-CU * units
    if (CU_PRICE_MICROLAMPORTS > 0 && out.rpc_units != null) {
      out.prioritization_fee = Math.round(out.rpc_units * CU_PRICE_MICROLAMPORTS) / 1_000_000;
    }

    return out;
  };
}
