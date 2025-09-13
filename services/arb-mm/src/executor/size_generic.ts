export async function maximizePnl({
    sizeMin, sizeMax, probes,
    buyPxFn,   // async (s) => avg QUOTE/BASE paid at size s
    sellPxFn,  // async (s) => avg QUOTE/BASE received at size s
    fixedCostQuote,
}: {
    sizeMin: number; sizeMax: number; probes: number;
    buyPxFn: (s: number) => Promise<number | undefined>;
    sellPxFn: (s: number) => Promise<number | undefined>;
    fixedCostQuote: number;
}) {
    let best = { s: 0, pnl: -Infinity, buy: NaN, sell: NaN };
    for (let i = 0; i < probes; i++) {
        const t = i / (probes - 1);
        const s = sizeMin * Math.pow(sizeMax / sizeMin, t);
        const [b, a] = await Promise.all([buyPxFn(s), sellPxFn(s)]);
        if (b != null && a != null) {
            const pnl = (a - b) * s - fixedCostQuote;
            if (pnl > best.pnl) best = { s, pnl, buy: b, sell: a };
        }
    }
    return best;
}
