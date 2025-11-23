import type { AmmAdapter } from "./types.js";
import { RaydiumAdapter } from "./raydium.js";
import { OrcaAdapter } from "./orca.js";
import { LifinityAdapter } from "./lifinity.js";
import { MeteoraAdapter } from "./meteora.js";

const MANIFEST: Record<string, AmmAdapter> = {
  raydium: RaydiumAdapter,
  orca: OrcaAdapter,
  meteora: MeteoraAdapter,
  lifinity: LifinityAdapter,
};

export function getAdapter(kind: string): AmmAdapter | undefined {
  return MANIFEST[String(kind ?? "").toLowerCase()];
}
