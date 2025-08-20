import { Connection, Keypair, PublicKey } from "@solana/web3.js";
export type WalletCtx = {
    payer: Keypair | null;
    owner: PublicKey;
    usdcMint: PublicKey;
    wsolMint: PublicKey;
    usdcAta: PublicKey;
    wsolAta: PublicKey;
};
export declare function loadWallet(conn: Connection): Promise<WalletCtx>;
export declare function ensureAtas(conn: Connection, owner: PublicKey, payer: Keypair | null, m: {
    usdcMint: PublicKey;
    wsolMint: PublicKey;
    usdcAta: PublicKey;
    wsolAta: PublicKey;
}): Promise<void>;
export declare function getBalances(conn: Connection, a: {
    usdcAta: PublicKey;
    wsolAta: PublicKey;
}): Promise<{
    usdc: number;
    wsol: number;
}>;
