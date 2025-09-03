// baseline_burn.js – withdrawAllTokenTypes with correct‑decimals snapshots
import fs from "fs";
import {
    Connection, Keypair, PublicKey,
    TransactionInstruction, TransactionMessage, VersionedTransaction
} from "@solana/web3.js";

const conn = new Connection("https://mainnet.helius-rpc.com/?api-key=2bb675f2-573f-4561-b57f-d351db310e5a", "confirmed");
const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("./blondi.json", "utf8")))
);

// ── addresses ───────────────────────────────────────────────────────────────
const MINT_USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MINT_WSOL = new PublicKey("So11111111111111111111111111111111111111112");

const DOOAR = new PublicKey("Dooar9JkhdZ7J3LHN3A7YCuoGRUggXhQaG4kijfLGU2j");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const POOL = new PublicKey("5GGvkcqQ1554ibdc18JXiPqR8aJz6WV3JSNShoj32ufT");
const VAULT_AUTH = new PublicKey("5w1nmqvpus3UfpP67EpYuHhE63aSFdF5AT8VHZTkvnp5");
const VAULT_USDC = new PublicKey("ARryk4nSoS6bu7nyv6BgQah8oU23svFm7Rek7kR4fy3X");
const VAULT_WSOL = new PublicKey("GVfKYBNMdaER21wwuqa4CSQV8ajVpuPbNZVV3wcuKWhE");
const LP_MINT = new PublicKey("DajMqwbJXA7JbqgU97zycA1zReQhmTqf1YjNNQjo6gCQ");
const FEE_ACC = new PublicKey("3FKpkMEmqMifpPErCxpnYY8gTH1BxeDLH3r5t8vLU6ZK");

const ATA_USDC = new PublicKey("FEcYTKzvgkNDD2VG9SdcvNH1bWYZ2Ggn59XES5y2nAc6");
const ATA_WSOL = new PublicKey("GkvWNym7ctZ3Q6fnB4VuqRV2LDeViygqbtzKRU9Pi4yj");
const ATA_LP = new PublicKey("ADSeJ8imTVR4Cjem8pZTVicwjUq8XEMT9ZfNpc38p2dq");

// ── snapshot helper (no pretty needed) ──────────────────────────────────────
async function snap() {
    const [vU, vW, uU, uW, uL, supp] =
        await conn.getMultipleAccountsInfo([VAULT_USDC, VAULT_WSOL, ATA_USDC, ATA_WSOL, ATA_LP, LP_MINT]);
    const r64 = a => a?.data.readBigUInt64LE(64) ?? 0n;
    return { vUSDC: r64(vU), vWSOL: r64(vW), uUSDC: r64(uU), uWSOL: r64(uW), uLP: r64(uL), lpSupply: BigInt(supp?.data.readBigUInt64LE(36) || 0) };
}

// BigInt‑safe JSON
const J = (k, v) => typeof v === "bigint" ? v.toString() : v;

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
    const lpBal = BigInt((await conn.getTokenAccountBalance(ATA_LP)).value.amount || "0");
    if (lpBal === 0n) { console.error("Your LP = 0"); return; }

    const pre = await snap();

    const data = Buffer.alloc(25);
    data.writeUInt8(0x03, 0);
    data.writeBigUInt64LE(lpBal, 1);
    data.writeBigUInt64LE(0n, 9);
    data.writeBigUInt64LE(0n, 17);

    const ix = new TransactionInstruction({
        programId: DOOAR,
        keys: [
            { pubkey: POOL, isSigner: false, isWritable: true },
            { pubkey: VAULT_AUTH, isSigner: false, isWritable: false },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
            { pubkey: LP_MINT, isSigner: false, isWritable: true },
            { pubkey: ATA_LP, isSigner: false, isWritable: true },
            { pubkey: VAULT_WSOL, isSigner: false, isWritable: true },
            { pubkey: VAULT_USDC, isSigner: false, isWritable: true },
            { pubkey: ATA_WSOL, isSigner: false, isWritable: true },
            { pubkey: ATA_USDC, isSigner: false, isWritable: true },
            { pubkey: FEE_ACC, isSigner: false, isWritable: true },
            { pubkey: TOKEN, isSigner: false, isWritable: false }
        ],
        data
    });

    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [ix]
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg); tx.sign([wallet]);

    const sig = await conn.sendTransaction(
        tx,
        { skipPreflight: false, maxRetries: 0 }  // <— bypass simulation
    );
    await conn.confirmTransaction(sig, "confirmed");
    console.log(`✅ burn confirmed – ${sig}`);

    const post = await snap();
    fs.mkdirSync("logs", { recursive: true });
    fs.writeFileSync(`logs/${sig}.state.txt`,
        `${sig}\n\nBEFORE\n${JSON.stringify(pre, J, 2)}\n\nAFTER\n${JSON.stringify(post, J, 2)}`);
})();
