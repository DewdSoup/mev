import { config } from "dotenv";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { PoolInfoLayout, AmmConfigLayout, FEE_RATE_DENOMINATOR } from "@raydium-io/raydium-sdk";
import { WHIRLPOOL_CODER } from "@orca-so/whirlpools-sdk";
import BN from "bn.js";

config({ path: path.resolve(process.cwd(), ".env.live") });

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  throw new Error("RPC_URL missing in env");
}

const connection = new Connection(RPC_URL, "confirmed");

const feeRateDenominator = new BN(FEE_RATE_DENOMINATOR).toNumber();

async function fetchRaydiumClmm(poolId: string) {
  const pk = new PublicKey(poolId);
  const info = await connection.getAccountInfo(pk, "confirmed");
  if (!info?.data) {
    throw new Error(`raydium_clmm_missing_${poolId}`);
  }
  const state: any = PoolInfoLayout.decode(info.data);
  const cfgPk = new PublicKey(state.ammConfig);
  const cfgInfo = await connection.getAccountInfo(cfgPk, "confirmed");
  if (!cfgInfo?.data) {
    throw new Error(`raydium_clmm_config_missing_${poolId}`);
  }
  const cfg: any = AmmConfigLayout.decode(cfgInfo.data);
  const numerator = Number(cfg.tradeFeeRate ?? cfg.tradeFeeRateNumerator ?? cfg.tradeFeeNumerator);
  let feeBps: number | null = null;
  if (Number.isFinite(numerator)) {
    feeBps = (numerator / feeRateDenominator) * 10_000;
  } else {
    console.log("raydium config decode", poolId, cfg);
  }
  return { poolId, feeBps };
}

async function fetchOrcaClmm(poolId: string) {
  const pk = new PublicKey(poolId);
  const info = await connection.getAccountInfo(pk, "confirmed");
  if (!info?.data) {
    throw new Error(`orca_clmm_missing_${poolId}`);
  }
  const whirlpool: any = WHIRLPOOL_CODER.decode("Whirlpool", info.data);
  const feeRate = Number(whirlpool.feeRate);
  const feeBps = Number.isFinite(feeRate) ? feeRate / 100 : null;
  return { poolId, feeBps };
}

(async () => {
  const raydiumIds = [
    "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
    "EXHyQxMSttcvLPwjENnXCPZ8GmLjJYHtNBnAkcFeFKMn",
  ];
  const orcaIds = [
    "FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q",
  ];

  const ray = await Promise.all(raydiumIds.map(fetchRaydiumClmm));
  const orca = await Promise.all(orcaIds.map(fetchOrcaClmm));

  console.table([...ray, ...orca]);
})();
