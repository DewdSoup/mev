// services/arb-mm/src/util/pretty.ts
import { green, yellow, gray, bold } from "./colors.js";
import { asNumber } from "./num.js";

function on(): boolean {
  const v = process.env.PRETTY_LOGS?.toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  // default: on if TTY and not NO_COLOR
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

function fx(n: any, p = 4) {
  const num = asNumber(n);
  return num !== undefined ? num.toFixed(p) : String(n);
}

export function prettyDecision(kind: "would_trade" | "would_not_trade", base: any) {
  if (!on()) return;
  const tag = kind === "would_trade" ? green("would_trade") : yellow("would_not_trade");
  const arrow = base?.path === "AMM->PHX" ? "AMM→PHX" : "PHX→AMM";
  const side  = base?.side ?? "?";
  const sz    = fx(base?.trade_size_base, 3);
  const net   = fx(base?.edge_bps_net, 2);
  const buy   = fx(base?.buy_px, 3);
  const sell  = fx(base?.sell_px, 3);
  const imp   = fx(base?.amm_price_impact_bps, 2);

  const rpcMarker = process.env.USE_RPC_SIM?.toLowerCase() === "true" ? "rpc:on" : "rpc:off";

  console.log(
    `${tag} ${bold(arrow)} ${side} sz=${sz} | net=${net}bps | buy=${buy} sell=${sell} | ammImpact=${imp}bps (${rpcMarker})`
  );
}

export function prettyBanner(label: string, obj: Record<string, any>) {
  if (!on()) return;
  console.log(gray(`${label} ${JSON.stringify(obj)}`));
}
