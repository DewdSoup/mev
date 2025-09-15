// services/arb-mm/src/executor/buildOrcaWhirlpoolIx.ts
import {
    Connection, PublicKey, TransactionInstruction, Transaction, VersionedTransaction, Keypair,
} from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
    WhirlpoolContext,
    ORCA_WHIRLPOOL_PROGRAM_ID,
    buildWhirlpoolClient,
    swapQuoteByInputToken,
} from "@orca-so/whirlpools-sdk";
import { Percentage } from "@orca-so/common-sdk";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";

class ReadonlyWallet {
    constructor(public publicKey: PublicKey) { }
    get payer(): Keypair { return Keypair.generate(); }
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> { return tx; }
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> { return txs; }
}

export async function buildOrcaWhirlpoolSwapIx(params: {
    connection?: Connection;
    user: PublicKey;
    poolId: string;
    baseIn: boolean;
    amountInAtoms: bigint;
    slippageBps: number;
}): Promise<{ ok: true; ixs: TransactionInstruction[] } | { ok: false; reason: string }> {
    try {
        const conn = params.connection ?? new Connection(String(process.env.RPC_URL ?? process.env.SOLANA_RPC_URL), "confirmed");
        const programId = new PublicKey(process.env.ORCA_WHIRLPOOL_PROGRAM_ID ?? ORCA_WHIRLPOOL_PROGRAM_ID);
        const wallet = new ReadonlyWallet(params.user);

        const provider = new AnchorProvider(conn, wallet, AnchorProvider.defaultOptions());
        const ctx = WhirlpoolContext.withProvider(provider, programId);
        const client = buildWhirlpoolClient(ctx);

        const whirlpool = await client.getPool(new PublicKey(params.poolId));
        if (!whirlpool) return { ok: false, reason: "whirlpool_not_found" };

        const wpData = whirlpool.getData();
        const ataA = await getAssociatedTokenAddress(wpData.tokenMintA, wallet.publicKey, false, TOKEN_PROGRAM_ID);
        const ataB = await getAssociatedTokenAddress(wpData.tokenMintB, wallet.publicKey, false, TOKEN_PROGRAM_ID);

        const inputTokenType = params.baseIn ? "TokenA" : "TokenB";
        const amountBN = new BN(params.amountInAtoms.toString());
        const slippagePercentage = Percentage.fromFraction(params.slippageBps, 10_000);

        const quote = await swapQuoteByInputToken(
            whirlpool,
            inputTokenType as any,
            amountBN,
            slippagePercentage,
            wallet.publicKey,
            ctx.fetcher,
            {}
        );

        const swapTxBuilder = await whirlpool.swap(quote, {
            tokenAuthority: wallet.publicKey,
            tokenOwnerAccountA: ataA,
            tokenOwnerAccountB: ataB,
        } as any);

        const txPayload = await swapTxBuilder.build();

        if (txPayload && typeof txPayload === "object") {
            if ("transaction" in txPayload && txPayload.transaction) {
                const tx = txPayload.transaction as Transaction;
                if ("instructions" in tx && Array.isArray(tx.instructions)) {
                    return { ok: true, ixs: tx.instructions };
                }
            }
            if ("instructions" in txPayload && Array.isArray((txPayload as any).instructions)) {
                return { ok: true, ixs: (txPayload as any).instructions as TransactionInstruction[] };
            }
            if ("ixs" in txPayload && Array.isArray((txPayload as any).ixs)) {
                return { ok: true, ixs: (txPayload as any).ixs as TransactionInstruction[] };
            }
        }
        return { ok: false, reason: "whirlpool_builder_no_instructions" };
    } catch (e: any) {
        return { ok: false, reason: String(e?.message ?? e) };
    }
}
