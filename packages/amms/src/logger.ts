// packages/amms/src/logger.ts
// Minimal, zero-dep, structured logger used by AMM packages only.
// Intentionally tiny to avoid cross-package coupling.

type Json = Record<string, unknown>;

function stamp() {
    return new Date().toISOString();
}

export const logger = {
    log(event: string, data?: Json) {
        try {
            const line = data && typeof data === "object"
                ? JSON.stringify({ ts: stamp(), event, data })
                : JSON.stringify({ ts: stamp(), event, data: { msg: String(data ?? "") } });
            // eslint-disable-next-line no-console
            console.log(line);
        } catch {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify({ ts: stamp(), event, data: { warn: "logger_serialize_failed" } }));
        }
    }
};
