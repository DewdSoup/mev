// services/arb-mm/src/session_recorder.ts
// ESM-safe; no __dirname. Writes under CFG.DATA_DIR/live.

import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { getSessionId, getSessionStats } from "./ml_logger.js";
import type { AppConfig } from "./config.js";
import { asPublicKey } from "./util/pubkey.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SKIP_BALANCE_READS = String(process.env.SKIP_BALANCE_READS ?? "1").trim() === "1";

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
}
function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

async function readTokenUi(conn: Connection, ata: PublicKey): Promise<number> {
  if (SKIP_BALANCE_READS) return 0;
  try {
    const r = await conn.getTokenAccountBalance(ata, "processed");
    return r?.value?.uiAmount ?? 0;
  } catch {
    return 0;
  }
}
async function readSol(conn: Connection, owner: PublicKey): Promise<number> {
  if (SKIP_BALANCE_READS) return 0;
  try {
    return (await conn.getBalance(owner, "processed")) / 1e9;
  } catch {
    return 0;
  }
}

export async function initSessionRecorder(conn: Connection, owner: PublicKey, cfg: AppConfig) {
  const ownerPk = asPublicKey(owner) ?? owner;
  const liveDir = path.resolve(cfg.DATA_DIR, "live");
  ensureDir(liveDir);

  const session_id = getSessionId();
  const started_at = new Date();

  const usdcMint = new PublicKey(cfg.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const wsolMint = new PublicKey(cfg.SOL_MINT ?? "So11111111111111111111111111111111111111112");
  const usdcAta = asPublicKey(cfg.USDC_ATA) ?? findAta(ownerPk, usdcMint);
  const wsolAta = asPublicKey(cfg.WSOL_ATA) ?? findAta(ownerPk, wsolMint);

  const start = {
    sol: await readSol(conn, ownerPk),
    usdc: await readTokenUi(conn, usdcAta),
    wsol: await readTokenUi(conn, wsolAta),
  };

  let finalized = false;
  async function finalize() {
    if (finalized) return;
    finalized = true;

    const stopped_at = new Date();
    const end = {
      sol: await readSol(conn, ownerPk),
      usdc: await readTokenUi(conn, usdcAta),
      wsol: await readTokenUi(conn, wsolAta),
    };
    const delta = {
      sol: +(end.sol - start.sol).toFixed(9),
      usdc: +(end.usdc - start.usdc).toFixed(6),
      wsol: +(end.wsol - start.wsol).toFixed(9),
    };
    const s = getSessionStats();

    const base = {
      session_id,
      started_at: started_at.toISOString(),
      stopped_at: stopped_at.toISOString(),
      wallet: ownerPk.toBase58(),
      balances: { start, end, delta },
      stats: s,
    };

    const ts = stamp();
    const jsonFile = path.join(liveDir, `${ts}.session.json`);
    const mdFile = path.join(liveDir, `${ts}.session.md`);

    try {
      fs.writeFileSync(jsonFile, JSON.stringify(base, null, 2));
    } catch {}
    try {
      fs.writeFileSync(
        mdFile,
        `# Session ${session_id}
**Start:** ${base.started_at}
**Stop:**  ${base.stopped_at}
**Wallet:** ${base.wallet}

## Balances
- SOL:  ${start.sol.toFixed(9)} → ${end.sol.toFixed(9)}  (Δ ${delta.sol})
- wSOL: ${start.wsol.toFixed(9)} → ${end.wsol.toFixed(9)} (Δ ${delta.wsol})
- USDC: ${start.usdc.toFixed(6)} → ${end.usdc.toFixed(6)} (Δ ${delta.usdc})

## Trade Stats
- considered: ${s.considered}
- would_trade: ${s.would_trade}
- would_not_trade: ${s.would_not_trade}
- submitted_tx: ${s.submitted_tx}
- landed: ${s.landed}
- land_error: ${s.land_error}
- tip_lamports_sum: ${s.tip_lamports_sum}
- best_edge_bps: ${s.best_edge_bps ?? "n/a"}
- worst_edge_bps: ${s.worst_edge_bps ?? "n/a"}
- filled_base_sum: ${s.filled_base_sum ?? 0}
- filled_quote_sum: ${s.filled_quote_sum ?? 0}
`
      );
    } catch {}

    // breadcrumb to stdout
    console.log("arb_session_summary_written", { file: jsonFile });
  }

  process.once("SIGINT", () => void finalize());
  process.once("SIGTERM", () => void finalize());
  process.once("beforeExit", () => void finalize());
}
