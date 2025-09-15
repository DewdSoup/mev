// services/arb-mm/src/tx/sendGate.ts
import type { Connection, PublicKey } from '@solana/web3.js';

type GateOpts = {
    env: NodeJS.ProcessEnv;
    owner?: PublicKey;
    // optional soft checks (token balances) if you want later
    // getTokenBalance?: (mint: PublicKey) => Promise<number>;
};

export async function canActuallySendNow(_conn: Connection, opts: GateOpts): Promise<boolean> {
    const {
        LIVE_TRADING = '0',
        SUBMIT_MODE = 'rpc',
        USE_RPC_SIM = '1',
        // You can add other “circuit breaker” envs here
    } = opts.env;

    // Baseline: never block math — but DO block broadcast when not approved.
    // You said: run in "live" but don't actually fail if not funded.
    // This gate lets everything compute, yet prevents send when you want.
    const live = LIVE_TRADING === '1';
    const simOnly = USE_RPC_SIM === '1';

    // In your current regime: LIVE_TRADING=1 but wallets unfunded.
    // That’s fine: we just skip the send (return false) but keep everything else working.
    if (live && simOnly) return false;

    // Otherwise allow if explicitly live and not sim-only
    return live;
}
