#!/usr/bin/env -S node --loader ts-node/esm
/**
 * Minimal Raydium builder probe.
 * Usage:
 *   RPC_URL=... WALLET_PUBKEY=... pnpm tsx services/arb-mm/scripts/probe-raydium.ts
 *   # flags: --quote-in to drive QUOTE->BASE flow
 * Env:
 *   SLIPPAGE_BPS (default 50)
 *   PROBE_BASE_IN (BASE UI, default 0.01)  when base-in
 *   PROBE_QUOTE_IN (USDC UI, default 10)   when quote-in
 */
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { buildRaydiumCpmmSwapIx } from "../src/executor/buildRaydiumCpmmIx.ts";

function envPk(name: string, fallback: string) {
    const v = (process.env[name] ?? "").trim() || fallback;
    return new PublicKey(v);
}

const RPC = (process.env.RPC_URL || process.env.RPC_PRIMARY || "https://api.mainnet-beta.solana.com").trim();
const WS = process.env.RPC_WSS_URL?.trim();
const conn = new Connection(RPC, { commitment: "processed", wsEndpoint: WS });

const owner = process.env.WALLET_PUBKEY
    ? new PublicKey(process.env.WALLET_PUBKEY)
    : Keypair.generate().publicKey;

const baseIn = !process.argv.includes("--quote-in");
const slip = Number(process.env.SLIPPAGE_BPS ?? "50");
const baseUi = Number(process.env.PROBE_BASE_IN ?? "0.01");
const quoteUi = Number(process.env.PROBE_QUOTE_IN ?? "10");

const BASE_MINT = envPk("RAYDIUM_POOL_BASE_MINT", "So11111111111111111111111111111111111111112");
const QUOTE_MINT = envPk("RAYDIUM_POOL_QUOTE_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const POOL_ID = envPk(
    "RAYDIUM_POOL_ID",
    process.env.RAYDIUM_POOL_ID_SOL_USDC?.trim() || "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"
);

const inMint = baseIn ? BASE_MINT : QUOTE_MINT;
const outMint = baseIn ? QUOTE_MINT : BASE_MINT;

const amountIn = baseIn
    ? BigInt(Math.floor(baseUi * 1e9))   // SOL atoms
    : BigInt(Math.floor(quoteUi * 1e6)); // USDC atoms

// Probe uses permissive minOut; this script is only verifying builder shape.
const amountOutMin = 1n;

try {
    const ixs = await buildRaydiumCpmmSwapIx({
        connection: conn,
        owner,
        poolId: POOL_ID,
        inMint,
        outMint,
        amountIn,
        amountOutMin,
    });

    console.log("[probe-raydium] OK: ixs=", ixs.length);
    ixs.forEach((ix, i) =>
        console.log(`  #${i} program=${ix.programId.toBase58()} keys=${ix.keys.length}`)
    );
} catch (e: any) {
    console.error("[probe-raydium] FAILED:", e?.message || String(e));
    process.exit(1);
}
