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
import { buildRaydiumSwapIx } from "../src/util/raydium.ts";

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

const atoms = baseIn
    ? BigInt(Math.floor(baseUi * 1e9))  // SOL atoms
    : BigInt(Math.floor(quoteUi * 1e6)); // USDC atoms

const res = await buildRaydiumSwapIx({
    user: owner,
    baseIn,
    amountInBase: atoms,
    slippageBps: slip,
});
if (!res.ok) {
    console.error("[probe-raydium] FAILED:", res.reason);
    process.exit(1);
}
console.log("[probe-raydium] OK: ixs=", res.ixs.length);
res.ixs.forEach((ix, i) =>
    console.log(`  #${i} program=${ix.programId.toBase58()} keys=${ix.keys.length}`)
);
