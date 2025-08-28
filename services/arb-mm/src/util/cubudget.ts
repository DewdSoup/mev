import { ComputeBudgetProgram, SystemProgram, TransactionInstruction } from "@solana/web3.js";

// Clean number string like "1_000_000"
function cleanNumStr(s: string | undefined): string {
    if (!s) return "0";
    return s.replace(/_/g, "").trim();
}
function clampInt(n: number, lo: number, hi: number): number {
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export function buildPreInstructions(payer: { publicKey: any }) {
    const out: TransactionInstruction[] = [];

    const CU_LIMIT = clampInt(Number(cleanNumStr(process.env.SUBMIT_CU_LIMIT || "800000")), 0, 5_000_000);
    const TIP_UC = clampInt(Number(cleanNumStr(process.env.TIP_MICROLAMPORTS_PER_CU || "0")), 0, 10_000_000);
    const TIP_LAM = clampInt(Number(cleanNumStr(process.env.SUBMIT_TIP_LAMPORTS || "0")), 0, 100_000_000);

    if (CU_LIMIT > 0) {
        out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }));
    }
    if (TIP_UC > 0) {
        out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: TIP_UC }));
    } else if (TIP_LAM > 0) {
        out.push(SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: payer.publicKey,
            lamports: TIP_LAM,
        }));
    }
    return { preIxs: out, cuLimit: CU_LIMIT, tipMicroPerCu: TIP_UC, tipLamports: TIP_LAM };
}
