import 'dotenv/config';
import { Connection, Commitment } from '@solana/web3.js';

export function env(name: string, def?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (def !== undefined) return def;
  throw new Error(`Missing env ${name}`);
}

export const log = (scope: string) => (msg: string, data?: unknown) => {
  if (data !== undefined) {
    console.log(`${new Date().toISOString()} ${scope} ${msg}`, JSON.stringify(data));
  } else {
    console.log(`${new Date().toISOString()} ${scope} ${msg}`);
  }
};

export async function httpHealth(rpcBase: string) {
  const url = rpcBase.endsWith('/') ? `${rpcBase}health` : `${rpcBase}/health`;
  try {
    const res = await fetch(url, { method: 'GET' });
    const txt = await res.text();
    return { ok: res.ok, body: txt.trim() };
  } catch (e) {
    return { ok: false, body: String(e) };
  }
}

export async function pingMs(rpcBase: string): Promise<number> {
  const url = rpcBase.endsWith('/') ? `${rpcBase}health` : `${rpcBase}/health`;
  const t0 = performance.now();
  try {
    await fetch(url, { method: 'GET' });
  } catch {
    // ignore
  }
  return Math.round(performance.now() - t0);
}

export type RpcEndpoint = {
  url: string;
  name?: string;
  weight?: number; // static priority boost
};

export class RpcPool {
  private endpoints: RpcEndpoint[];
  private commitment: Commitment;
  private L = log('rpc');

  // runtime score cache (lower is better)
  private score = new Map<string, number>(); // url -> score

  constructor(endpoints: RpcEndpoint[], commitment: Commitment = 'processed') {
    if (!endpoints.length) throw new Error('RpcPool: empty endpoints');
    this.endpoints = endpoints.map(e => ({ ...e, weight: e.weight ?? 0 }));
    this.commitment = commitment;
  }

  /** Quickest healthy endpoint, preferring lower score and static weight boost. */
  async pick(): Promise<RpcEndpoint> {
    // refresh scores lazily
    await Promise.all(
      this.endpoints.map(async e => {
        const [health, ms] = await Promise.all([httpHealth(e.url), pingMs(e.url)]);
        // Lower score is better: latency + penalty if unhealthy - weight
        const penalty = health.ok ? 0 : 1000;
        const s = ms + penalty - (e.weight ?? 0) * 50;
        this.score.set(e.url, s);
      })
    );

    const best = this.endpoints
      .slice()
      .sort((a, b) => (this.score.get(a.url)! - this.score.get(b.url)!))
      [0];

    if (!best) throw new Error('RpcPool: no endpoint selected');
    return best;
  }

  /** Creates a Connection to the currently best endpoint. */
  async connection(): Promise<Connection> {
    const best = await this.pick();
    this.L('pick', { best: best.name ?? best.url, score: this.score.get(best.url) });
    return new Connection(best.url, { commitment: this.commitment });
  }
}
