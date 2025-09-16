// services/arb-mm/src/adapters/manifest.ts
// Config-driven adapter manifest. Add new venues here, not in the router.

import type { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PublicKey as PK } from "@solana/web3.js";
import { buildRaydiumCpmmSwapIx } from "../executor/buildRaydiumCpmmIx.js";
import { buildOrcaWhirlpoolSwapIx } from "../executor/buildOrcaWhirlpoolIx.js";
import { orcaAvgBuyQuotePerBase, orcaAvgSellQuotePerBase } from "../executor/orca_quoter.js";
import type { AmmAdapter, QuoteReq, QuoteResp } from "./types.js";

const WSOL = (process.env.WSOL_MINT ?? "So11111111111111111111111111111111111111112").trim();
const USDC = (process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").trim();

function envNum(name: string, def?: number): number | undefined {
    const v = process.env[name];
    if (v == null || v === "") return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

// ────────────────────────────────────────────────────────────────────────────
// Orca Whirlpool
const OrcaAdapter: AmmAdapter = {
    kind: "orca",

    async quote(_conn, req): Promise<QuoteResp> {
        try {
            const size = Math.max(1e-9, req.inBase);
            const slip = Math.max(0, req.slippageBps);
            const q = req.direction === "baseToQuote"
                ? await orcaAvgBuyQuotePerBase(req.poolId, size, slip)
                : await orcaAvgSellQuotePerBase(req.poolId, size, slip);

            if (q.ok) {
                // The Orca quoter returns only { ok, price } in your tree; fill the rest from env when helpful.
                return {
                    ok: true,
                    price: q.price, // avg QUOTE per BASE
                    feeBps: envNum("ORCA_TRADE_FEE_BPS") ?? envNum("AMM_TAKER_FEE_BPS") ?? 30,
                    // minOut/meta not available from this quoter; leave undefined
                };
            }
            return { ok: false, err: (q as any).reason ?? "orca_quoter_failed" };
        } catch (e: any) {
            return { ok: false, err: String(e?.message ?? e) };
        }
    },

    async buildSwapIxs(conn, userB58, req, _meta): Promise<TransactionInstruction[]> {
        const user = new PK(userB58);
        const baseIn = req.direction === "baseToQuote";
        const pxRef = Number(process.env.ORCA_REF_PX ?? 0); // optional for sizing in quote-in path

        // Amount-in atoms: BASE if baseToQuote, QUOTE if quoteToBase (needs px)
        const atoms = (() => {
            if (baseIn) {
                return BigInt(Math.floor(req.inBase * 1e9)); // WSOL 9
            } else {
                const px = pxRef > 0 ? pxRef : 1;           // fallback if caller didn't pass a ref px yet
                const ui = req.inBase * px;
                return BigInt(Math.floor(ui * 1e6));        // USDC 6
            }
        })();

        const built = await buildOrcaWhirlpoolSwapIx({
            connection: conn,
            user,
            poolId: req.poolId,
            baseIn,
            amountInAtoms: atoms,
            slippageBps: Number(process.env.MAX_SLIPPAGE_BPS ?? 50),
        });

        // Avoid unsafe property access on the union; throw a clean Error on failure.
        if (!(built && (built as any).ok === true && Array.isArray((built as any).ixs) && (built as any).ixs.length)) {
            const reason = (built as any)?.reason ?? "orca_whirlpool_ix_builder_failed";
            throw new Error(String(reason));
        }
        return (built as any).ixs as TransactionInstruction[];
    },
};

// ────────────────────────────────────────────────────────────────────────────
// Raydium CPMM — quote is not chain-sourced here (router can supply reserves).
// We expose only the builder for now; router’s CPMM math handles EV.
const RaydiumAdapter: AmmAdapter = {
    kind: "raydium",

    async quote(_conn, _req): Promise<QuoteResp> {
        // Let the router/edge compute CPMM quotes from reserves to avoid another chain hit here.
        return { ok: false, err: "use_router_cpmm_math" };
    },

    async buildSwapIxs(conn, userB58, req): Promise<TransactionInstruction[]> {
        const user = new PK(userB58);
        const baseIn = req.direction === "baseToQuote";

        const inMint: PublicKey = new PK(baseIn ? WSOL : USDC);
        const outMint: PublicKey = new PK(baseIn ? USDC : WSOL);

        // amountIn taken as BASE atoms for baseToQuote, else QUOTE atoms
        const refPx = Number(process.env.RAY_REF_PX ?? 1);
        const amountIn = baseIn
            ? BigInt(Math.floor(req.inBase * 1e9))                              // base atoms
            : BigInt(Math.floor((req.inBase * Math.max(1, refPx)) * 1e6));      // quote atoms

        // naive minOut; executor/joiner guard EV and slippage separately
        const amountOutMin = (() => {
            const bps = Math.max(0, Number(process.env.RAYDIUM_MINOUT_BUFFER_BPS ?? 0));
            const BPS = 10_000n;
            const v = baseIn
                ? BigInt(Math.floor(req.inBase * Math.max(1, refPx) * 1e6))       // QUOTE atoms out
                : BigInt(Math.floor((req.inBase / Math.max(1, refPx)) * 1e9));    // BASE atoms out
            return (v * (BPS - BigInt(bps))) / BPS;
        })();

        const ixs = await buildRaydiumCpmmSwapIx({
            connection: conn,
            owner: user,
            poolId: new PK(req.poolId),
            inMint,
            outMint,
            amountIn,
            amountOutMin,
        });

        if (!Array.isArray(ixs) || !ixs.length) {
            throw new Error("raydium_cpmm_ix_builder_failed");
        }
        return ixs;
    },
};

// ────────────────────────────────────────────────────────────────────────────
const MANIFEST: Record<string, AmmAdapter> = {
    raydium: RaydiumAdapter,
    orca: OrcaAdapter,
};

export function getAdapter(kind: string): AmmAdapter | undefined {
    return MANIFEST[String(kind ?? "").toLowerCase()];
}