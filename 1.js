// Quick script to check Orca fees
import { Connection, PublicKey } from "@solana/web3.js";
import { ParsableWhirlpool } from "@orca-so/whirlpools-sdk";

const conn = new Connection("https://mainnet.helius-rpc.com/?api-key=YOUR_KEY");

const orcaPools = [
    "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ",
    "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
    "FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q"
];

for (const poolId of orcaPools) {
    const pk = new PublicKey(poolId);
    const info = await conn.getAccountInfo(pk);
    if (info?.data) {
        const parsed = ParsableWhirlpool.parse(pk, info);
        const feeRate = Number(parsed.feeRate);
        const feeBps = feeRate / 100; // Orca returns fee in hundredths of a percent
        console.log(`${poolId}: ${feeRate} (${feeBps} bps)`);
    }
}