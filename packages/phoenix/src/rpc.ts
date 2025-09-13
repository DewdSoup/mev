import { Connection } from "@solana/web3.js";
import type { Commitment, ConnectionConfig } from "@solana/web3.js";
import { logger } from "@mev/storage";

function pickWs(): string | undefined {
    return (
        process.env.RPC_WSS_URL ||
        process.env.PHOENIX_WSS_URL ||
        process.env.WS_URL ||
        process.env.WSS_URL ||
        undefined
    );
}

// Accept optional arg so existing callers compile (commitment or partial config)
export function makePhoenixConnection(
    opts?: Commitment | Partial<ConnectionConfig>
): Connection {
    const rpcUrl =
        process.env.RPC_URL || process.env.RPC_PRIMARY || process.env.RPC_ENDPOINT;
    if (!rpcUrl) throw new Error("RPC_URL missing");

    let commitment: Commitment | undefined;
    let extra: Partial<ConnectionConfig> = {};
    if (typeof opts === "string") commitment = opts as Commitment;
    else if (typeof opts === "object" && opts) extra = opts;

    const ws = pickWs();

    const conf: ConnectionConfig = {
        commitment:
            commitment ||
            (process.env.PHOENIX_COMMITMENT as Commitment) ||
            "confirmed",
        disableRetryOnRateLimit: true,
        ...extra,
        ...(ws ? { wsEndpoint: ws } as Partial<ConnectionConfig> : {}),
    };

    const conn = new Connection(rpcUrl, conf);

    // log in phoenix runtime jsonl
    logger.log("phoenix_ws_attach", {
        ws_attached: !!ws,
        ws_endpoint: ws || null,
    });

    return conn;
}
