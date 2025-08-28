/* eslint-disable no-console */
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import dotenv from "dotenv";

// Load env (prefer .env.live, fall back to .env); supports ESM
(function loadEnv() {
    const cwd = process.cwd();
    const live = path.resolve(cwd, ".env.live");
    const base = path.resolve(cwd, ".env");
    if (fs.existsSync(live)) dotenv.config({ path: live });
    else if (fs.existsSync(base)) dotenv.config({ path: base });
})();

function prettyTable(
    side: "bids" | "asks",
    levels: Array<{ price: number; size: number }>
) {
    const rows = levels.map((l) => ({
        side,
        price: l.price,
        size: l.size,
        notional: l.price * l.size,
    }));
    console.table(rows);
}

async function getClient(phoenixNs: any, connection: Connection): Promise<any> {
    // Handle both ESM and possible CJS default exports
    const phoenix = phoenixNs?.default ?? phoenixNs;

    const ClientClass =
        phoenix.PhoenixClient ||
        phoenix.Client ||
        phoenix.Phoenix ||
        phoenix.PhoenixSdk ||
        null;
    if (!ClientClass) return null;

    if (typeof ClientClass.create === "function") {
        try {
            const c = await ClientClass.create(connection);
            if (c) return c;
        } catch {
            /* fall through */
        }
    }
    try {
        return new ClientClass(connection);
    } catch {
        return null;
    }
}

async function tryGetDepth(phoenixNs: any, client: any, marketPk: PublicKey) {
    const toLevels = (raw: any) => {
        if (!raw) return { bids: [], asks: [] };
        const norm = (arr: any[]) =>
            (arr || []).map((l: any) => ({
                price: Number(l.price ?? l.px ?? l[0] ?? 0),
                size: Number(l.size ?? l.qty ?? l[1] ?? 0),
            }));
        if (Array.isArray(raw)) {
            const bids = norm(raw[0] || []);
            const asks = norm(raw[1] || []);
            return { bids, asks };
        }
        const bids = norm(raw.bids || raw.bid || []);
        const asks = norm(raw.asks || raw.ask || []);
        return { bids, asks };
    };

    if (client && typeof client.getL2 === "function") {
        const raw = await client.getL2(marketPk, 5).catch(() => null);
        if (raw) return toLevels(raw);
    }

    for (const name of ["getOrderBook", "getBook"]) {
        if (client && typeof client[name] === "function") {
            const raw = await client[name](marketPk).catch(() => null);
            if (raw) return toLevels(raw);
        }
    }

    if (client && typeof client.getMarket === "function") {
        const m = await client.getMarket(marketPk).catch(() => null);
        if (m) {
            for (const cand of [m, (m as any)?.handle, (m as any)?.state]) {
                if (cand && typeof cand.getL2 === "function") {
                    const raw = await cand.getL2(5).catch(() => null);
                    if (raw) return toLevels(raw);
                }
                if (cand && typeof cand.getOrderBook === "function") {
                    const raw = await cand.getOrderBook().catch(() => null);
                    if (raw) return toLevels(raw);
                }
            }
        }
    }

    return { bids: [], asks: [] };
}

async function main() {
    const RPC_URL = process.env.RPC_URL || clusterApiUrl("mainnet-beta");
    // Allow CLI override for convenience:
    //   pnpm --filter arb-mm tsx src/diag.ts <PHOENIX_MARKET_PUBKEY>
    const PHOENIX_MARKET =
        process.env.PHOENIX_MARKET ?? (process.argv[2] || "").trim();

    const connection = new Connection(RPC_URL, { commitment: "confirmed" });

    const phoenixNs = await import("@ellipsis-labs/phoenix-sdk");
    const phoenix = (phoenixNs as any)?.default ?? phoenixNs;

    const exportNames = Object.keys(phoenix).sort();
    console.log("phoenix-sdk exports:", exportNames);

    const client = await getClient(phoenixNs, connection);
    if (!client) {
        console.log("⚠️  Could not construct a Phoenix client with this SDK version.");
    } else {
        for (const hook of ["connect", "refresh", "load"]) {
            if (typeof (client as any)[hook] === "function") {
                try {
                    await (client as any)[hook]();
                    console.log(`✔ ${hook}() ok`);
                } catch (e) {
                    console.log(`⚠️  ${hook}() failed:`, (e as any)?.message ?? e);
                }
            }
        }
    }

    if (!PHOENIX_MARKET) {
        console.log(
            "ℹ️  Set PHOENIX_MARKET (or pass as CLI arg) to print L2/BBO.\n" +
            "   Example: pnpm --filter arb-mm tsx src/diag.ts 4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg"
        );
        return;
    }

    const marketPk = new PublicKey(PHOENIX_MARKET);
    console.log(`ℹ️  Market: ${marketPk.toBase58()}`);

    const { bids, asks } = client
        ? await tryGetDepth(phoenixNs, client, marketPk)
        : { bids: [], asks: [] };

    if (!bids.length && !asks.length) {
        console.log(
            "⚠️  Could not fetch L2 / order book with this SDK+RPC combo. Check PHOENIX_MARKET and RPC_URL."
        );
        return;
    }

    const bidTop = bids[0] ?? { price: 0, size: 0 };
    const askTop = asks[0] ?? { price: 0, size: 0 };
    console.log("— BBO —");
    console.table({
        bestBidPx: bidTop.price,
        bestBidSz: bidTop.size,
        bestAskPx: askTop.price,
        bestAskSz: askTop.size,
        spread:
            askTop.price && bidTop.price ? askTop.price - bidTop.price : null,
    });

    if (bids.length) prettyTable("bids", bids.slice(0, 5));
    if (asks.length) prettyTable("asks", asks.slice(0, 5));
}

main().catch((e) => {
    // make failures readable; don't explode
    console.log("diag error:", (e as any)?.message ?? e);
});
