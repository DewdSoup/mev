import { Connection, Keypair, PublicKey, VersionedTransaction, AddressLookupTableAccount } from '@solana/web3.js';
import { env } from '../../core/src/env';
import { canActuallySendNow } from './funding';
import { simulateAtomicTx } from './rpcSim';
import { buildAtomicVtx } from './joiner.single_tx';
import type { Path, PathQuote } from '../../router/src/types';

// assume you already have a way to build quotes; wire it here
export async function tryExecutePath(
    conn: Connection,
    payer: Keypair,
    usdcAta: PublicKey,
    quoted: PathQuote,
    altAccounts: AddressLookupTableAccount[] = []
) {
    // 1) Build instructions
    const { ixs, writeAccounts } = await buildAtomicVtx(
        conn, payer.publicKey, quoted.path.legs, quoted.legQuotes,
        Number(process.env.SUBMIT_CU_LIMIT ?? 800000),
        Number(process.env.TIP_MICROLAMPORTS_PER_CU ?? 0)
    );

    // 2) Assemble v0 msg (add write accounts if you use ALT; otherwise just v0 without ALT)
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('processed');
    const msg = new (await import('@solana/web3.js')).TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
    }).compileToV0Message(altAccounts);
    const vtx = new VersionedTransaction(msg);

    // 3) Sim-first (tolerant)
    let simOk = true, simErr = '', units = undefined;
    if (env.USE_RPC_SIM) {
        const sim = await simulateAtomicTx(conn, vtx, [usdcAta.toBase58()]);
        simOk = sim.ok; simErr = sim.err ?? ''; units = sim.unitsConsumed;
        // tolerance check vs our quoter if you compute rpcEffPx
        if (!simOk) {
            logDecision(quoted, { would_send: false, sim_ok: false, sim_err: simErr, cu: units });
            return;
        }
    }

    // 4) Funding gate (LIVE, but won’t send if empty)
    const funded = await canActuallySendNow(conn, payer.publicKey, usdcAta);
    if (!funded && !env.SEND_WITHOUT_FUNDS) {
        logDecision(quoted, { would_send: true, send_attempted: false, sim_ok: simOk, cu: units });
        return;
    }

    // 5) Send (if allowed)
    vtx.sign([payer]);
    const sig = await conn.sendTransaction(vtx, { skipPreflight: true, maxRetries: 2 });
    logDecision(quoted, { would_send: true, send_attempted: true, sig, cu: units, lastValidBlockHeight });
}

function logDecision(quoted: PathQuote, extra: any) {
    // write to your runtime JSONL with decision + estPnlBps + sim + send flags
}
