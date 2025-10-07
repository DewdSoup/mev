import { Connection, PublicKey } from "@solana/web3.js";
import { ParsableWhirlpool } from "@orca-so/whirlpools-sdk";

const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com");
const poolId = "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm";

const pk = new PublicKey(poolId);
const info = await conn.getAccountInfo(pk);
const parsed = ParsableWhirlpool.parse(pk, info);
const feeBps = Number(parsed.feeRate) / 100;
console.log(`${poolId}: ${feeBps} bps`);
