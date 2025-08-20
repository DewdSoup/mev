// services/arb-mm/src/health.ts
import { Connection } from "@solana/web3.js";
import { logger } from "@mev/storage";
import { setChainTps } from "./feature_sink.js";

export async function startHealth(conn: Connection) {
  async function sampleTps(): Promise<number> {
    try {
      const samples = await conn.getRecentPerformanceSamples(1);
      if (!samples?.length) return 0;
      const s = samples[0];
      if (!s.numTransactions || !s.samplePeriodSecs) return 0;
      return s.numTransactions / s.samplePeriodSecs;
    } catch {
      return 0;
    }
  }

  setInterval(async () => {
    try {
      const [slot, version, tps] = await Promise.all([
        conn.getSlot("processed"),
        conn.getVersion(),
        sampleTps(),
      ]);

      setChainTps(tps);

      logger.log("arb health", {
        slot,
        tps: Number(tps.toFixed(2)),
        version,
        httpHealth: { ok: true, body: "ok" },
      });
    } catch (e) {
      setChainTps(undefined);
      logger.log("arb health", {
        slot: null,
        tps: 0,
        version: { "feature-set": null, "solana-core": "unknown" },
        httpHealth: { ok: false, body: String(e) },
      });
    }
  }, 3000);
}
