import { Connection, PublicKey } from '@solana/web3.js';
import { env } from '../../core/src/env';

export async function canActuallySendNow(conn: Connection, wallet: PublicKey, usdcAta: PublicKey): Promise<boolean> {
    if (env.SEND_WITHOUT_FUNDS) return true;
    const lamports = await conn.getBalance(wallet, { commitment: 'processed' }).catch(() => 0);
    const usdcBal = await getTokenBalance(conn, usdcAta).catch(() => 0n);
    return lamports >= env.FUND_MIN_LAMPORTS && Number(usdcBal) >= env.FUND_MIN_USDC;
}

async function getTokenBalance(conn: Connection, ata: PublicKey): Promise<bigint> {
    const ai = await conn.getAccountInfo(ata, 'processed');
    if (!ai) return 0n;
    // quick & safe: just parse token amount from data via getTokenAccountBalance
    const r = await conn.getTokenAccountBalance(ata, 'processed');
    return BigInt(r.value.amount); // raw integer (e.g., 6 decimals for USDC)
}
