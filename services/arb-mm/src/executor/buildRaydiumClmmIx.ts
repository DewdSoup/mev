// services/arb-mm/src/executor/buildRaydiumClmmIx.ts
// Raydium CLMM swap builder.
//
// Requirements
// - Depends on the Raydium CLMM REST API for pool metadata (override via RAYDIUM_CLMM_API_URL).
// - Defaults to the “real” builder; set CLMM_REAL_BUILDER=0 to fall back to the historical memo placeholder.

import fetch from "node-fetch";
import BN from "bn.js";
import {
    Connection,
    PublicKey,
    TransactionInstruction,
    ComputeBudgetProgram,
} from "@solana/web3.js";
import { Clmm, TxVersion } from "@raydium-io/raydium-sdk";

type ApiClmmPoolsStats = {
    volume: number;
    volumeFee: number;
    feeA: number;
    feeB: number;
    feeApr: number;
    rewardApr: { A: number; B: number; C: number };
    apr: number;
    priceMin: number;
    priceMax: number;
};

type ApiClmmConfig = {
    id: string;
    index: number;
    protocolFeeRate: number;
    tradeFeeRate: number;
    tickSpacing: number;
    fundFeeRate: number;
    fundOwner: string;
    description: string;
};

type ApiClmmPoolsItem = {
    id: string;
    mintProgramIdA: string;
    mintProgramIdB: string;
    mintA: string;
    mintB: string;
    vaultA: string;
    vaultB: string;
    mintDecimalsA: number;
    mintDecimalsB: number;
    ammConfig: ApiClmmConfig;
    rewardInfos: { mint: string; programId: string }[];
    tvl: number;
    day: ApiClmmPoolsStats;
    week: ApiClmmPoolsStats;
    month: ApiClmmPoolsStats;
    lookupTableAccount: string;
};

const DEFAULT_CLMM_API_URL = process.env.RAYDIUM_CLMM_API_URL ?? "https://api.raydium.io/v2/ammV3/ammPools";

let clmmPoolCache: Map<string, ApiClmmPoolsItem> | null = null;

async function loadClmmPoolFromApi(poolId: string): Promise<ApiClmmPoolsItem> {
    if (!clmmPoolCache) {
        const response = await fetch(DEFAULT_CLMM_API_URL);
        if (!response.ok) {
            throw new Error(`raydium_clmm_api_http_${response.status}`);
        }
        const json: any = await response.json();
        const list: ApiClmmPoolsItem[] = Array.isArray(json?.data) ? json.data : [];
        clmmPoolCache = new Map(list.map((item) => [item.id, item]));
    }
    const item = clmmPoolCache.get(poolId);
    if (!item) {
        throw new Error(`raydium_clmm_pool_not_found(${poolId})`);
    }
    return item;
}

function toPublicKey(value: PublicKey | string): PublicKey {
    return value instanceof PublicKey ? value : new PublicKey(value);
}

function applyBpsDown(value: bigint, bps: number): bigint {
    if (value <= 0n) return 0n;
    const BPS = 10_000n;
    const clamped = BigInt(Math.max(0, Math.min(10_000, Math.round(bps))));
    return (value * (BPS - clamped)) / BPS;
}

async function resolveTickArrayAccounts(connection: Connection, poolId: string, poolInfo: any): Promise<PublicKey[]> {
    const tickMap = await Clmm.fetchMultiplePoolTickArrays({
        connection,
        poolKeys: [poolInfo],
        batchRequest: true,
    });
    const perPool = tickMap[poolId];
    if (!perPool || Object.keys(perPool).length === 0) {
        throw new Error("raydium_clmm_tick_arrays_missing");
    }
    const ordered = Object.keys(perPool)
        .map(Number)
        .sort((a, b) => Math.abs(poolInfo.tickCurrent - a) - Math.abs(poolInfo.tickCurrent - b));
    const accounts = ordered.slice(0, 3).map((idx) => toPublicKey(perPool[idx].address));
    while (accounts.length < 3 && accounts.length > 0) accounts.push(accounts[accounts.length - 1]);
    if (accounts.length === 0) throw new Error("raydium_clmm_tick_arrays_empty");
    return accounts;
}

interface BuildArgs {
    connection: Connection;
    user: PublicKey;
    poolId: string;
    baseIn: boolean;
    amountInAtoms: bigint;
    expectedOutAtoms: bigint;
    slippageBps: number;
}

export async function buildRaydiumClmmSwapIx(args: BuildArgs): Promise<
    | { ok: true; ixs: TransactionInstruction[] }
    | { ok: false; reason: string }
> {
    try {
        const enableReal = String(process.env.CLMM_REAL_BUILDER ?? "1") !== "0";
        if (!enableReal) {
            const cuLimit = Number(process.env.CLMM_CU_LIMIT ?? 1_000_000);
            const cuPrice = Number(process.env.CLMM_CU_PRICE_MICROLAMPORTS ?? 0);
            const memo = Buffer.from(
                `RAYDIUM_CLMM_PLACEHOLDER pool=${args.poolId} baseIn=${args.baseIn} amt=${args.amountInAtoms.toString()}`
            );
            return {
                ok: true,
                ixs: [
                    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
                    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
                    new TransactionInstruction({
                        programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
                        keys: [],
                        data: memo,
                    }),
                ],
            };
        }

        const { connection, user, poolId, baseIn, amountInAtoms, expectedOutAtoms, slippageBps } = args;
        if (!(amountInAtoms > 0n)) return { ok: false, reason: "amount_in_not_positive" };

        const poolIdPk = new PublicKey(poolId);
        const poolIdStr = poolIdPk.toBase58();
        const apiPool = await loadClmmPoolFromApi(poolIdStr);

        const poolInfos = await Clmm.fetchMultiplePoolInfos({
            connection,
            poolKeys: [apiPool],
            chainTime: Math.floor(Date.now() / 1000),
        });
        const wrap = poolInfos[poolIdStr];
        if (!wrap || !wrap.state) {
            return { ok: false, reason: "raydium_clmm_pool_info_missing" };
        }

        const poolInfo = wrap.state;
        const tickArrayAccounts = await resolveTickArrayAccounts(connection, poolIdStr, poolInfo);

        const amountInBn = new BN(amountInAtoms.toString());
        const minOutAtoms = applyBpsDown(expectedOutAtoms, slippageBps);
        const minOutBn = new BN(minOutAtoms.toString());

        const ownerInfo = {
            wallet: user,
            feePayer: user,
            tokenAccounts: [] as any[],
            useSOLBalance: false,
        };

        const buildResult = baseIn
            ? await Clmm.makeSwapBaseInInstructionSimple({
                  connection,
                  poolInfo,
                  ownerInfo,
                  inputMint: toPublicKey(poolInfo.mintA.mint),
                  amountIn: amountInBn,
                  amountOutMin: minOutBn,
                  priceLimit: undefined,
                  remainingAccounts: tickArrayAccounts,
                  associatedOnly: true,
                  checkCreateATAOwner: false,
                  makeTxVersion: TxVersion.V0,
              })
            : await Clmm.makeSwapBaseOutInstructionSimple({
                  connection,
                  poolInfo,
                  ownerInfo,
                  outputMint: toPublicKey(poolInfo.mintA.mint),
                  amountOut: minOutBn,
                  amountInMax: amountInBn,
                  priceLimit: undefined,
                  remainingAccounts: tickArrayAccounts,
                  associatedOnly: true,
                  checkCreateATAOwner: false,
                  makeTxVersion: TxVersion.V0,
              });

        const out: TransactionInstruction[] = [];
        for (const inner of buildResult.innerTransactions ?? []) {
            for (const ix of inner.instructions ?? []) {
                out.push(ix);
            }
        }

        if (!out.length) return { ok: false, reason: "raydium_clmm_builder_returned_no_instructions" };
        return { ok: true, ixs: out };
    } catch (e: any) {
        return { ok: false, reason: String(e?.message ?? e) };
    }
}
