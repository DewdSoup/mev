// scripts/dump-raydium-fee.ts
import { Connection, PublicKey } from "@solana/web3.js";
// import raydium decoder for your pool version

const RPC = process.env.RPC_URL!;
const POOL = process.env.RAYDIUM_POOL_ID!; // 58oQChx...

(async () => {
    const conn = new Connection(RPC, "confirmed");
    const info = await conn.getAccountInfo(new PublicKey(POOL), "confirmed");
    if (!info?.data) throw new Error("pool not found");
    // TODO: decode according to your Raydium adapter (amm v4/amm config layout)
    // const { tradeFeeNumerator, tradeFeeDenominator } = decode(...);
    // const trade_bps = 10_000 * Number(tradeFeeNumerator) / Number(tradeFeeDenominator);
    // console.log({ pool: POOL, trade_bps });
})();
