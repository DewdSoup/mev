// Centralized EV fee policy (prevents double-counting AMM fee)
//
// Rule:
// - Simulator's AMM effective prices (amm_eff_buy_px, amm_eff_sell_px) ALREADY include
//   the Raydium 25 bps input fee + price impact for the given size.
// - Therefore, EV must NOT subtract AMM fee again.
// - Phoenix taker fee for SOL/USDC is effectively 0 (keep env-driven).

export type Path = "PHX->AMM" | "AMM->PHX";

export function computeNetEdgeBps(args: {
    path: Path;
    phoenixBid: number;       // P_bid
    phoenixAsk: number;       // P_ask
    ammEffBuyPx: number;      // A_eff_buy (USDC per SOL) - includes AMM fee+impact
    ammEffSellPx: number;     // A_eff_sell (USDC per SOL) - includes AMM fee+impact
    slippageBps: number;      // total slippage buffers you want to subtract
    phoenixFeeBps?: number;   // default 0
    ammFeeBps?: number;       // default 0 in EV (fee is in eff px already)
    networkCostBps?: number;  // estimated tx+tip / notional
    ammFeeAlreadyInEffPx?: boolean; // default true
}) {
    const {
        path,
        phoenixBid,
        phoenixAsk,
        ammEffBuyPx,
        ammEffSellPx,
        slippageBps,
        phoenixFeeBps = 0,
        ammFeeBps = 0,
        networkCostBps = 0,
        ammFeeAlreadyInEffPx = true,
    } = args;

    // Gross edge in bps using fee-inclusive AMM effective prices
    // Path PHX->AMM: buy on PHX at P_ask, sell on AMM at A_eff_sell
    // Path AMM->PHX: buy on AMM at A_eff_buy, sell on PHX at P_bid
    const gross =
        path === "PHX->AMM"
            ? ((ammEffSellPx / phoenixAsk) - 1) * 1e4
            : ((phoenixBid / ammEffBuyPx) - 1) * 1e4;

    // Fees to subtract (AMM fee only if NOT already embedded in effective price)
    const feeBps =
        slippageBps +
        phoenixFeeBps +
        (ammFeeAlreadyInEffPx ? 0 : ammFeeBps) +
        networkCostBps;

    return gross - feeBps;
}
