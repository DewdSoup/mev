import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";

import { rpcClient } from "@mev/rpc-facade";

import {
    DLMM_BIN_ARRAY_HORIZON,
    DLMM_MIN_SLIPPAGE_BPS,
    getDlmmBinArrays,
    getDlmmInstance,
    getMintDecimals,
    toPublicKeyLike,
    uiToBn,
} from "../util/meteora_dlmm.js";

export async function buildMeteoraDlmmSwapIx(params: {
    connection?: Connection;
    user: PublicKey;
    poolId: string;
    baseIn: boolean;
    sizeBase: number;
    refPx: number;
    slippageBps: number;
    baseMint: string;
    quoteMint: string;
}): Promise<{ ok: true; ixs: TransactionInstruction[] } | { ok: false; reason: string }> {
    try {
        if (!(params.sizeBase > 0) || !(params.refPx > 0)) {
            return { ok: false, reason: "dlmm_invalid_size" };
        }

        const conn = params.connection ?? rpcClient;
        const lbPairPk = new PublicKey(params.poolId);
        const instance = await getDlmmInstance(params.poolId, conn);

        const baseMintPk = new PublicKey(params.baseMint);
        const quoteMintPk = new PublicKey(params.quoteMint);

        const tokenXMint = toPublicKeyLike(instance.lbPair?.tokenXMint ?? instance.tokenXMint);
        const tokenYMint = toPublicKeyLike(instance.lbPair?.tokenYMint ?? instance.tokenYMint);

        const baseIsX = baseMintPk.equals(tokenXMint);
        const swapForY = params.baseIn ? baseIsX : !baseIsX;

        const [baseDecimals, quoteDecimals] = await Promise.all([
            getMintDecimals(baseMintPk, conn),
            getMintDecimals(quoteMintPk, conn),
        ]);

        const sizeBaseBn = uiToBn(params.sizeBase, baseDecimals);
        if (sizeBaseBn.isZero()) return { ok: false, reason: "dlmm_size_underflow" };

        const slippageBps = Math.max(DLMM_MIN_SLIPPAGE_BPS, Math.round(Math.max(0, params.slippageBps ?? 0)));
        const allowedSlippage = new BN(slippageBps);

        const cachedArrays = await getDlmmBinArrays({
            poolId: params.poolId,
            swapForY,
            horizon: DLMM_BIN_ARRAY_HORIZON,
            connection: conn,
            allowStale: true,
            allowRefresh: false,
        });

        const binArraysResult = cachedArrays.ok
            ? cachedArrays
            : await getDlmmBinArrays({
                poolId: params.poolId,
                swapForY,
                horizon: DLMM_BIN_ARRAY_HORIZON,
                connection: conn,
                allowStale: true,
                allowRefresh: true,
            });

        if (!binArraysResult.ok) {
            return { ok: false, reason: `dlmm_bin_fetch:${binArraysResult.err}` };
        }

        const dlmm = binArraysResult.instance ?? instance;
        const binArrays = binArraysResult.binArrays;
        if (!Array.isArray(binArrays) || binArrays.length === 0) {
            return { ok: false, reason: "dlmm_binarray_empty" };
        }

        const binArrayKeys: PublicKey[] = binArrays.map((entry: any) => toPublicKeyLike(entry.publicKey ?? entry.pubkey ?? entry.address ?? entry));

        const binKeys = (quote: any): PublicKey[] =>
            (quote?.binArraysPubkey as PublicKey[] | undefined)?.map((pk) => toPublicKeyLike(pk)) ?? binArrayKeys;

        if (params.baseIn) {
            const quote = dlmm.swapQuote(sizeBaseBn, swapForY, allowedSlippage, binArrays);
            const consumed = quote.consumedInAmount ?? sizeBaseBn;
            if (!quote.outAmount || quote.outAmount.isZero()) {
                return { ok: false, reason: "dlmm_no_liquidity" };
            }

            const minOut = quote.minOutAmount ?? quote.outAmount;
            const tx: Transaction = await dlmm.swap({
                inToken: baseMintPk,
                outToken: quoteMintPk,
                inAmount: consumed,
                minOutAmount: minOut,
                lbPair: lbPairPk,
                user: params.user,
                binArraysPubkey: binKeys(quote),
            });

            if (!(tx?.instructions?.length)) return { ok: false, reason: "dlmm_builder_empty" };
            return { ok: true, ixs: [...tx.instructions] };
        }

        const outAtoms = sizeBaseBn;
        const quote = dlmm.swapQuoteExactOut(outAtoms, swapForY, allowedSlippage, binArrays);
        const maxIn = quote.maxInAmount ?? quote.inAmount;
        if (!maxIn || maxIn.isZero()) {
            return { ok: false, reason: "dlmm_no_liquidity" };
        }

        const tx: Transaction = await dlmm.swapExactOut({
            inToken: quoteMintPk,
            outToken: baseMintPk,
            outAmount: outAtoms,
            maxInAmount: maxIn,
            lbPair: lbPairPk,
            user: params.user,
            binArraysPubkey: binKeys(quote),
        });

        if (!(tx?.instructions?.length)) return { ok: false, reason: "dlmm_builder_empty" };
        return { ok: true, ixs: [...tx.instructions] };
    } catch (err) {
        return { ok: false, reason: String((err as any)?.message ?? err) };
    }
}
