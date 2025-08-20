// services/arb-mm/src/io/jsonl.ts
// JSONL follower with watch + poll fallback

import fs from "fs";
import path from "path";
import { logger } from "@mev/storage";

export type LineHandler = (obj: any) => void;

export class JsonlFollower {
  private fd: number | null = null;
  private offset = 0;
  private buffer = "";
  private watcher: fs.FSWatcher | null = null;
  private poller: NodeJS.Timeout | null = null;

  constructor(
    private file: string,
    private onLine: LineHandler,
    private pollMs: number = 750
  ) {}

  async start() {
    await this.openAtEOF();
    this.watch();
    this.poller = setInterval(() => this.readNewBytes(), this.pollMs);
  }

  stop() {
    try { this.watcher?.close(); } catch {}
    if (this.poller) clearInterval(this.poller);
    try { if (this.fd !== null) fs.closeSync(this.fd); } catch {}
    this.watcher = null;
    this.poller = null;
    this.fd = null;
  }

  private async openAtEOF() {
    try {
      const existed = fs.existsSync(this.file);
      this.fd = fs.openSync(this.file, "a+");
      const size = existed ? fs.fstatSync(this.fd).size : 0;
      this.offset = size;
      logger.log("edge_follow_opened", { file: this.file, initial_size: size });
    } catch (e) {
      logger.log("edge_follow_open_error", { file: this.file, err: String(e) });
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.fd = fs.openSync(this.file, "a+");
        this.offset = 0;
        logger.log("edge_follow_opened", { file: this.file, initial_size: 0 });
      } catch (e2) {
        logger.log("edge_follow_open_fatal", { file: this.file, err: String(e2) });
      }
    }
  }

  private watch() {
    try {
      this.watcher = fs.watch(this.file, (event) => {
        if (event === "rename") {
          try { if (this.fd !== null) fs.closeSync(this.fd); } catch {}
          this.openAtEOF().catch(() => {});
          return;
        }
        this.readNewBytes();
      });
    } catch (e) {
      logger.log("edge_follow_watch_error", { file: this.file, err: String(e) });
    }
  }

  private readNewBytes() {
    if (this.fd === null) return;
    try {
      const stat = fs.fstatSync(this.fd);
      if (stat.size <= this.offset) return;
      const toRead = stat.size - this.offset;
      const buf = Buffer.allocUnsafe(toRead);
      const n = fs.readSync(this.fd, buf, 0, toRead, this.offset);
      this.offset += n;
      this.buffer += buf.toString("utf8", 0, n);
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try { this.onLine(JSON.parse(line)); } catch {}
      }
    } catch (e) {
      logger.log("edge_follow_read_error", { file: this.file, err: String(e) });
    }
  }
}
