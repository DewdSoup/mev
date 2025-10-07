import { Connection, PublicKey } from "@solana/web3.js";
import { ParsableWhirlpool } from "@orca-so/whirlpools-sdk";

const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com");

const pools = [
  "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ",
  "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", 
  "FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q"
];

for (const poolId of pools) {
  try {
    const pk = new PublicKey(poolId);
    const info = await conn.getAccountInfo(pk);
    if (!info?.data) {
      console.log(`${poolId}: NOT FOUND`);
      continue;
    }
    const parsed = ParsableWhirlpool.parse(pk, info);
    const feeRate = Number(parsed.feeRate);
    const feeBps = feeRate / 100; // Orca stores in hundredths of percent
    console.log(`${poolId}: ${feeBps} bps (feeRate=${feeRate})`);
  } catch (e) {
    console.log(`${poolId}: ERROR - ${e.message}`);
  }
}
