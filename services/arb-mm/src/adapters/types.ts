// services/arb-mm/src/adapters/types.ts
// Canonical adapter interfaces for quoting and building swap ix.

import type { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";

export type Direction = "baseToQuote" | "quoteToBase";

export type QuoteReq = {
    poolId: string;              // concrete pool/whirlpool id
    inBase: number;              // input size in BASE units (ui)
    direction: Direction;        // flow of the leg
    slippageBps: number;         // caller's slippage target
    baseMint?: string;           // optional hints
    quoteMint?: string;
};

export type QuoteResp =
    | { ok: true; price: number; feeBps?: number; minOut?: number; meta?: any }
    | { ok: false; err: string; meta?: any };

export interface AmmAdapter {
    kind: string;

    // Return an *average* QUOTE-per-BASE effective price for the req.
    // (Optional) feeBps/minOut/meta may be supplied if the venue/quoter can provide them.
    quote(conn: Connection, req: QuoteReq): Promise<QuoteResp>;

    // Build swap Ixs for the req (direction=inBase units). `userB58` is the payer.
    // Implementations should throw on failure; callers handle and log.
    buildSwapIxs(
        conn: Connection,
        userB58: string,
        req: QuoteReq,
        meta?: any
    ): Promise<TransactionInstruction[]>;
}
