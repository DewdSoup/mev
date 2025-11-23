import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { rpcClient } from "@mev/rpc-facade";

import { quoteDlmm } from "../edge/dlmm_quoter.js";
import { buildMeteoraDlmmSwapIx } from "../executor/buildMeteoraDlmmIx.js";
import type { AmmAdapter, QuoteReq, QuoteResp } from "./types.js";

const ensureConnection = (conn?: Connection): Connection => {
    if (conn) return conn;
    // rpcClient already wraps backoff/limiter logic; cast is safe for adapter surface.
    return rpcClient as unknown as Connection;
};

export const MeteoraAdapter: AmmAdapter = {
    kind: "meteora",

    async quote(conn: Connection, req: QuoteReq): Promise<QuoteResp> {
        const sizeBase = req.inBase;
        if (!(sizeBase > 0)) {
            return { ok: false, err: "meteora_invalid_size" };
        }
        const side = req.direction === "baseToQuote" ? "sell" : "buy";

        const out = await quoteDlmm({
            poolId: req.poolId,
            side,
            sizeBase,
            slippageBps: req.slippageBps,
            baseMint: req.baseMint,
            quoteMint: req.quoteMint,
        });

        if (!out.ok || !(out.price > 0)) {
            const err = !out.ok ? out.err : "meteora_quote_no_price";
            const meta = !out.ok ? out.meta : undefined;
            return { ok: false, err: err ?? "meteora_quote_failed", meta };
        }

        return {
            ok: true,
            price: out.price,
            feeBps: typeof out.feeBps === "number" ? out.feeBps : undefined,
            meta: out.meta,
        };
    },

    async buildSwapIxs(conn: Connection | undefined, userB58: string, req: QuoteReq, meta?: any): Promise<TransactionInstruction[]> {
        const connection = ensureConnection(conn);
        const baseMint = req.baseMint;
        const quoteMint = req.quoteMint;
        if (!baseMint || !quoteMint) {
            throw new Error("meteora: baseMint/quoteMint required");
        }

        const refPx = Number(meta?.refPx ?? meta?.price ?? 0);
        if (!(refPx > 0)) {
            throw new Error("meteora: refPx_required");
        }

        const baseIn = req.direction === "baseToQuote";
        const built = await buildMeteoraDlmmSwapIx({
            connection,
            user: new PublicKey(userB58),
            poolId: req.poolId,
            baseIn,
            sizeBase: req.inBase,
            refPx,
            slippageBps: req.slippageBps,
            baseMint,
            quoteMint,
        });

        if (!built.ok) {
            throw new Error(built.reason ?? "meteora_builder_failed");
        }

        return built.ixs;
    },
};
