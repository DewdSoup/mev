import type { Commitment, Connection } from "@solana/web3.js";
import { logger } from "@mev/storage";
import { getRpcFacade } from "@mev/rpc-facade";

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
export function makePhoenixConnection(_opts?: Commitment): Connection {
    const facade = getRpcFacade();
    const conn = facade.connection;

    logger.log("phoenix_ws_attach", {
        ws_attached: Boolean(pickWs()),
        ws_endpoint: pickWs() || null,
    });

    return conn;
}
