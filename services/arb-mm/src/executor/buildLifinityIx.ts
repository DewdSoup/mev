import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";

import type { LifinitySnapshot } from "../util/lifinity.js";
import { LIFINITY_PROGRAM_ID } from "../util/lifinity.js";

const INSTRUCTION_DISCRIMINATOR = Buffer.from([
  33, 118, 200, 107, 248, 200, 81, 80,
]);

export async function buildLifinitySwapIx(args: {
  connection: Connection;
  user: PublicKey;
  poolSnapshot: LifinitySnapshot;
  baseIn: boolean;
  amountIn: bigint;
  minimumOut: bigint;
}): Promise<{ ixs: TransactionInstruction[] }> {
  const { connection, user, poolSnapshot, baseIn, amountIn, minimumOut } = args;

  const meta = poolSnapshot.meta;

  const userBaseAta = getAssociatedTokenAddressSync(
    meta.baseMint,
    user,
    false,
    TOKEN_PROGRAM_ID
  );
  const userQuoteAta = getAssociatedTokenAddressSync(
    meta.quoteMint,
    user,
    false,
    TOKEN_PROGRAM_ID
  );

  const userSource = baseIn ? userBaseAta : userQuoteAta;
  const userDestination = baseIn ? userQuoteAta : userBaseAta;
  const poolSource = baseIn ? meta.baseVault : meta.quoteVault;
  const poolDestination = baseIn ? meta.quoteVault : meta.baseVault;

  const oracleMain = meta.oracleMain ?? meta.oracleSub ?? meta.oraclePc;
  const oracleSub = meta.oracleSub ?? meta.oracleMain ?? meta.oraclePc;
  const oraclePc = meta.oraclePc ?? meta.oracleMain ?? meta.oracleSub;

  if (!oracleMain || !oracleSub || !oraclePc) {
    throw new Error("lifinity: oracle accounts unavailable");
  }

  const data = Buffer.concat([
    INSTRUCTION_DISCRIMINATOR,
    new BN(amountIn.toString()).toArrayLike(Buffer, "le", 8),
    new BN(minimumOut.toString()).toArrayLike(Buffer, "le", 8),
  ]);

  const keys = [
    { pubkey: meta.authority, isWritable: false, isSigner: false },
    { pubkey: poolSnapshot.poolId, isWritable: true, isSigner: false },
    { pubkey: user, isWritable: false, isSigner: true },
    { pubkey: userSource, isWritable: true, isSigner: false },
    { pubkey: userDestination, isWritable: true, isSigner: false },
    { pubkey: poolSource, isWritable: true, isSigner: false },
    { pubkey: poolDestination, isWritable: true, isSigner: false },
    { pubkey: meta.poolMint, isWritable: true, isSigner: false },
    { pubkey: meta.feeAccount, isWritable: true, isSigner: false },
    { pubkey: meta.tokenProgram, isWritable: false, isSigner: false },
    { pubkey: oracleMain, isWritable: false, isSigner: false },
    { pubkey: oracleSub, isWritable: false, isSigner: false },
    { pubkey: oraclePc, isWritable: false, isSigner: false },
  ];

  const ix = new TransactionInstruction({
    programId: LIFINITY_PROGRAM_ID,
    keys,
    data,
  });

  return { ixs: [ix] };
}
