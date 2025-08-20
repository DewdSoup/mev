// services/arb-mm/src/submit/jito.ts
// Safe Jito submit helper with dynamic import + graceful fallback.
// If @jito-foundation/jito-ts isn't installed, this returns {ok:false}
// and the caller can fall back to normal RPC.

import type { VersionedTransaction, PublicKey } from "@solana/web3.js";

type JitoOk = { ok: true; bundleId?: string; signature?: string };
type JitoErr = { ok: false; error: string };

export async function sendViaJito(
  txs: VersionedTransaction[],
  tipAccount: PublicKey
): Promise<JitoOk | JitoErr> {
  try {
    // Dynamic import; works if you later add:
    // pnpm add @grpc/grpc-js @grpc/proto-loader  (jito-ts itself is private)
    const spec = "@jito-foundation/jito-ts";
    // @ts-ignore (type shim provided in src/types/jito.d.ts)
    const maybe = await import(spec).catch(() => null);
    if (!maybe) {
      return { ok: false, error: "jito-ts module not installed" };
    }

    const mod: any = (maybe as any).default ?? maybe;
    const SearcherClient = mod.SearcherClient ?? mod.searcher?.SearcherClient;
    const Bundle = mod.Bundle ?? mod.bundle?.Bundle;
    if (!SearcherClient || !Bundle) {
      return { ok: false, error: "jito-ts module shape not found" };
    }

    const { Keypair } = await import("@solana/web3.js");
    const keyJson = process.env.JITO_SEARCHER_KEYPAIR_JSON
      ? JSON.parse(process.env.JITO_SEARCHER_KEYPAIR_JSON)
      : null;

    const kp = keyJson ? Keypair.fromSecretKey(Uint8Array.from(keyJson)) : null;
    if (!kp) return { ok: false, error: "JITO_SEARCHER_KEYPAIR_JSON not set" };

    const url = String(process.env.JITO_BLOCK_ENGINE_URL ?? "https://mainnet.block-engine.jito.wtf");
    const client = await SearcherClient.connect(url, kp, "mainnet-beta");
    const bundle = new Bundle(txs, tipAccount);
    const { bundleId, signature } = await client.sendBundle(bundle);
    return { ok: true, bundleId, signature };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
