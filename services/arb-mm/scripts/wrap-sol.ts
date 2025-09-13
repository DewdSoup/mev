// services/arb-mm/scripts/wrap-sol.ts
// Wrap a small amount of SOL into WSOL in your ATA.
// Usage: pnpm tsx services/arb-mm/scripts/wrap-sol.ts 0.002

import { Connection, PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
    NATIVE_MINT
} from "@solana/spl-token";
import * as fs from "fs";

async function main() {
    const amtSol = Number(process.argv[2] ?? "0.002");
    if (!(amtSol > 0)) throw new Error("amount SOL required, e.g. 0.002");

    const rpc = process.env.SOLANA_RPC_URL || process.env.RPC_URL!;
    const conn = new Connection(rpc, "confirmed");
    const secret = JSON.parse(fs.readFileSync(process.env.SOLANA_KEYPAIR_PATH!, "utf8"));
    const payer = Keypair.fromSecretKey(new Uint8Array(secret));

    const ata = await getAssociatedTokenAddress(NATIVE_MINT, payer.publicKey);
    const tx = new Transaction();

    // Create WSOL ATA (no-op if exists)
    tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, ata, payer.publicKey, NATIVE_MINT));

    // Transfer lamports into the ATA then sync-native
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata, lamports: Math.floor(amtSol * 1e9) }));
    tx.add(createSyncNativeInstruction(ata));

    const sig = await conn.sendTransaction(tx, [payer], { skipPreflight: false });
    console.log("wrapped", amtSol, "SOL -> WSOL ATA", ata.toBase58(), "sig", sig);
}
main().catch(e => { console.error(e); process.exit(1); });
