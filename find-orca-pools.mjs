import { Connection, PublicKey } from "@solana/web3.js";
import { PDAUtil, PoolUtil, PriceMath, ORCA_WHIRLPOOL_PROGRAM_ID } from "@orca-so/whirlpools-sdk";

const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Known Orca Whirlpool configs for different fee tiers
const configs = [
  "FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR", // 1 bps
  "3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt", // 2 bps  
  "E88WJq69g1oPJxUjCEhXVdN9Cc3Riq99MMv7tjSPF9kS", // 4 bps
  "2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ", // 30 bps
  // Add more if needed
];

console.log("Searching for SOL/USDC Whirlpools...\n");

for (const configId of configs) {
  try {
    const pda = PDAUtil.getWhirlpool(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      new PublicKey(configId),
      new PublicKey(SOL_MINT),
      new PublicKey(USDC_MINT),
      1 // tickSpacing (try different values: 1, 8, 64, 128)
    );
    
    const info = await conn.getAccountInfo(pda.publicKey);
    if (info?.data) {
      const parsed = ParsableWhirlpool.parse(pda.publicKey, info);
      const feeBps = Number(parsed.feeRate) / 100;
      console.log(`Pool: ${pda.publicKey.toBase58()}`);
      console.log(`  Config: ${configId}`);
      console.log(`  Fee: ${feeBps} bps`);
      console.log(`  TVL: ~$${(Number(parsed.liquidity) / 1e6).toFixed(0)}k (approx)`);
      console.log();
    }
  } catch (e) {
    // Pool doesn't exist for this config/tickSpacing combo
  }
}
