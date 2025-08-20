// packages/solana/src/wallet.ts
import fs from "fs";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountIdempotent, } from "@solana/spl-token";
import { logger } from "@mev/storage";
function loadKeypairMaybe(p) {
    try {
        if (!p)
            return null;
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        return Keypair.fromSecretKey(Uint8Array.from(raw));
    }
    catch {
        return null;
    }
}
export async function loadWallet(conn) {
    const ownerStr = process.env.OWNER_PUBKEY || process.env.WALLET_PUBKEY || "";
    if (!ownerStr)
        throw new Error("OWNER_PUBKEY/WALLET_PUBKEY is required");
    const owner = new PublicKey(ownerStr);
    const usdcMint = new PublicKey(process.env.USDC_MINT ??
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const wsolMint = new PublicKey(process.env.SOL_MINT ??
        "So11111111111111111111111111111111111111112");
    const payer = loadKeypairMaybe(process.env.WALLET_KEYPAIR_PATH) ||
        loadKeypairMaybe(process.env.KEYPAIR_PATH) ||
        null;
    const usdcAta = process.env.USDC_ATA
        ? new PublicKey(process.env.USDC_ATA)
        : getAssociatedTokenAddressSync(usdcMint, owner, true);
    const wsolAta = process.env.WSOL_ATA
        ? new PublicKey(process.env.WSOL_ATA)
        : getAssociatedTokenAddressSync(wsolMint, owner, true);
    logger.log("wallet_loaded", {
        pubkey: owner.toBase58(),
        atas: { wsol: wsolAta.toBase58(), usdc: usdcAta.toBase58() },
        has_signer: !!payer,
    });
    // Ensure ATAs exist (idempotent)
    await ensureAtas(conn, owner, payer, { usdcMint, wsolMint, usdcAta, wsolAta });
    // Rent sanity: keep a tiny SOL buffer for wrap/fees
    const accInfo = await conn.getAccountInfo(owner, "processed");
    const solLamports = accInfo?.lamports ?? 0;
    const rentOk = solLamports >= 0.01 * LAMPORTS_PER_SOL; // ~0.01 SOL safety
    const { usdc, wsol } = await getBalances(conn, { usdcAta, wsolAta });
    logger.log("balances", {
        sol: Number((solLamports / LAMPORTS_PER_SOL).toFixed(6)),
        usdc: Number(usdc.toFixed(6)),
        wsol: Number(wsol.toFixed(9)),
        rent_ok: rentOk,
    });
    return { payer, owner, usdcMint, wsolMint, usdcAta, wsolAta };
}
export async function ensureAtas(conn, owner, payer, m) {
    if (!payer) {
        logger.log("atas_ok", { wsol: true, usdc: true, note: "no signer (read-only)" });
        return;
    }
    const before = { usdc: false, wsol: false };
    try {
        await getAccount(conn, m.usdcAta, "processed");
        before.usdc = true;
    }
    catch { }
    try {
        await getAccount(conn, m.wsolAta, "processed");
        before.wsol = true;
    }
    catch { }
    const ixs = [];
    if (!before.usdc) {
        ixs.push(createAssociatedTokenAccountIdempotent(payer, owner, m.usdcMint, { commitment: "processed" }));
    }
    if (!before.wsol) {
        ixs.push(createAssociatedTokenAccountIdempotent(payer, owner, m.wsolMint, { commitment: "processed" }));
    }
    await Promise.all(ixs);
    logger.log("atas_ok", { wsol: true, usdc: true });
}
export async function getBalances(conn, a) {
    const [usdcAcc, wsolAcc] = await Promise.allSettled([
        getAccount(conn, a.usdcAta, "processed"),
        getAccount(conn, a.wsolAta, "processed"),
    ]);
    const usdc = usdcAcc.status === "fulfilled" ? Number(usdcAcc.value.amount) / 1e6 : 0;
    const wsol = wsolAcc.status === "fulfilled" ? Number(wsolAcc.value.amount) / 1e9 : 0;
    return { usdc, wsol };
}
