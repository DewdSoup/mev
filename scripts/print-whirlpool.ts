// scripts/print-whirlpool.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { AccountFetcher, PriceMath } from "@orca-so/whirlpools-sdk";
import { AccountLayout as SPL_ACCOUNT_LAYOUT, getMint } from "@solana/spl-token";

async function main() {
    const [, poolArg] = process.argv;
    if (!poolArg) throw new Error("usage: pnpm tsx scripts/print-whirlpool.ts <WHIRLPOOL_PUBKEY>");

    const poolId = new PublicKey(poolArg);
    const rpc = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    const programId = new PublicKey(process.env.ORCA_WHIRLPOOL_PROGRAM_ID || "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
    const conn = new Connection(rpc, "processed");
    const fetcher = new AccountFetcher(conn, programId);

    const pd = await fetcher.getPool(poolId);
    if (!pd) throw new Error("pool not found");

    const mintA = new PublicKey(pd.tokenMintA);
    const mintB = new PublicKey(pd.tokenMintB);
    const [ma, mb] = await Promise.all([getMint(conn, mintA).catch(() => undefined), getMint(conn, mintB).catch(() => undefined)]);
    const decA = ma?.decimals ?? 9;
    const decB = mb?.decimals ?? 9;

    const priceAinB = PriceMath.sqrtPriceX64ToPrice(pd.sqrtPrice, decA, decB).toNumber();

    const infos = await conn.getMultipleAccountsInfo([new PublicKey(pd.tokenVaultA), new PublicKey(pd.tokenVaultB)], { commitment: "processed" as any });
    const a: any = SPL_ACCOUNT_LAYOUT.decode(infos[0]!.data);
    const b: any = SPL_ACCOUNT_LAYOUT.decode(infos[1]!.data);

    const fee_bps = Math.round(pd.feeRate / 100); // 500 -> 5 bps, 3000 -> 30 bps

    console.log(JSON.stringify({
        whirlpool: poolId.toBase58(),
        tokenMintA: mintA.toBase58(),
        tokenMintB: mintB.toBase58(),
        decimalsA: decA,
        decimalsB: decB,
        vaultA: pd.tokenVaultA,
        vaultB: pd.tokenVaultB,
        sqrtPriceX64: pd.sqrtPrice.toString(),
        priceAinB,
        feeRate_raw: pd.feeRate,
        fee_bps
    }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
