export const env = {
    FUND_MIN_LAMPORTS: Number(process.env.FUND_MIN_LAMPORTS ?? 0),
    FUND_MIN_USDC: Number(process.env.FUND_MIN_USDC ?? 0),
    SEND_WITHOUT_FUNDS: (process.env.SEND_WITHOUT_FUNDS ?? '0') === '1',
    USE_RPC_SIM: (process.env.USE_RPC_SIM ?? '0') === '1',
    RPC_SIM_TOL_BPS: Number(process.env.RPC_SIM_TOL_BPS ?? 2),
    ROUTER_ALLOW_AMM_PHOENIX: (process.env.ROUTER_ALLOW_AMM_PHOENIX ?? '1') === '1',
    ROUTER_ALLOW_PHOENIX_AMM: (process.env.ROUTER_ALLOW_PHOENIX_AMM ?? '1') === '1',
    ROUTER_ALLOW_AMM_AMM: (process.env.ROUTER_ALLOW_AMM_AMM ?? '1') === '1',
    ROUTER_MAX_HOPS: Number(process.env.ROUTER_MAX_HOPS ?? 2),
    EXEC_JOINER_MODE: process.env.EXEC_JOINER_MODE ?? 'single_tx',
};
