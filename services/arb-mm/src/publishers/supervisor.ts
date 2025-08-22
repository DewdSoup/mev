// services/arb-mm/src/publishers/supervisor.ts
import { spawn, ChildProcess } from "node:child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "@mev/storage";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type Proc = {
  name: "phoenix" | "amms";
  cmd: string;
  args: string[];
  cwd: string;
  cp: ChildProcess | null;
};

function fileIsFresh(p: string, maxAgeMs: number): boolean {
  try {
    const st = fs.statSync(p);
    return Date.now() - st.mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

export class PublisherSupervisor {
  private procs: Proc[] = [];
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private opts: {
      enable: boolean;
      phoenixJsonl: string;
      ammsJsonl: string;
      freshnessMs?: number;
      pollMs?: number;
      repoRoot?: string;
    }
  ) {}

  start() {
    if (!this.opts.enable) {
      logger.log("pubsv_off", { reason: "ENABLE_EMBEDDED_PUBLISHERS=0" });
      return;
    }
    const repoRoot =
      this.opts.repoRoot ??
      path.resolve(__dirname, "..", "..", ".."); // repo root from services/arb-mm/src/publishers

    const freshnessMs = Math.max(1000, this.opts.freshnessMs ?? 3500);
    const pollMs = Math.max(500, this.opts.pollMs ?? 2000);

    const needPhoenix = !fileIsFresh(this.opts.phoenixJsonl, freshnessMs);
    const needAmms = !fileIsFresh(this.opts.ammsJsonl, freshnessMs);

    if (needPhoenix) {
      this.spawnOne({
        name: "phoenix",
        cmd: "pnpm",
        args: ["--filter", "@mev/phoenix", "start"],
        cwd: repoRoot,
        cp: null,
      });
    }
    if (needAmms) {
      this.spawnOne({
        name: "amms",
        cmd: "pnpm",
        args: ["--filter", "@mev/amms", "start"],
        cwd: repoRoot,
        cp: null,
      });
    }
    if (!needPhoenix && !needAmms) {
      logger.log("pubsv_already_live", {
        phoenix: this.opts.phoenixJsonl,
        amms: this.opts.ammsJsonl,
      });
    }

    this.interval = setInterval(() => {
      try {
        const phxFresh = fileIsFresh(this.opts.phoenixJsonl, freshnessMs);
        const ammFresh = fileIsFresh(this.opts.ammsJsonl, freshnessMs);

        if (!phxFresh && !this.find("phoenix")) {
          this.spawnOne({
            name: "phoenix",
            cmd: "pnpm",
            args: ["--filter", "@mev/phoenix", "start"],
            cwd: repoRoot,
            cp: null,
          });
        }
        if (!ammFresh && !this.find("amms")) {
          this.spawnOne({
            name: "amms",
            cmd: "pnpm",
            args: ["--filter", "@mev/amms", "start"],
            cwd: repoRoot,
            cp: null,
          });
        }
      } catch (e) {
        logger.log("pubsv_poll_error", { error: String(e) });
      }
    }, pollMs);

    logger.log("pubsv_started", { pollMs, freshnessMs });
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const p of [...this.procs]) this.killOne(p);
    this.procs = [];
    logger.log("pubsv_stopped", {});
  }

  private find(name: Proc["name"]) {
    return this.procs.find((p) => p.name === name && p.cp);
  }

  private spawnOne(proc: Proc) {
    try {
      const cp = spawn(proc.cmd, proc.args, {
        cwd: proc.cwd,
        stdio: "ignore",
        detached: false,
        env: process.env,
      });
      proc.cp = cp;
      this.procs.push(proc);
      logger.log("pubsv_spawned", { name: proc.name, pid: cp.pid });

      cp.on("exit", (code, signal) => {
        logger.log("pubsv_exit", { name: proc.name, code, signal });
        const i = this.procs.indexOf(proc);
        if (i >= 0) this.procs.splice(i, 1);
      });
    } catch (e) {
      logger.log("pubsv_spawn_error", { name: proc.name, error: String(e) });
    }
  }

  private killOne(proc: Proc) {
    try {
      proc.cp?.kill("SIGTERM");
      logger.log("pubsv_killed", { name: proc.name });
    } catch {}
    proc.cp = null;
  }
}
