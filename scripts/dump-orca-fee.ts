// scripts/dump-orca-fee.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { WHIRLPOOL_CODER } from "@orca-so/whirlpools-sdk";

const RPC = process.env.RPC_URL!;
const POOL = process.env.ORCA_POOL_ID!; // e.g., HJPjoWUr... or 7qbRF6...

(async () => {
    const conn = new Connection(RPC, "confirmed");
    const acct = await conn.getAccountInfo(new PublicKey(POOL), "confirmed");
    if (!acct?.data) throw new Error("pool not found");
    const w = WHIRLPOOL_CODER.decode("Whirlpool", acct.data);
    const tradeBps = Number(w.feeRate) / 100;
    const protocolBps = Number(w.protocolFeeRate) / 100;
    console.log({ pool: POOL, trade_bps: tradeBps, protocol_bps: protocolBps });
})();
