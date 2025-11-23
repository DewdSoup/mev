import fs from "fs";
import path from "path";
import { resolveRepoRoot } from "../util/paths.js";

export interface VenueTuning {
  slotLagSlots?: number;
  snapshotMaxAgeMs?: number;
  heartbeatGraceMs?: number;
  tradeableWhenDegraded?: boolean;
  feeBps?: number;
}

export interface PoolTuning {
  feeBps?: number;
}

export interface VenueConfigShape {
  venues?: Record<string, VenueTuning>;
  pools?: Record<string, PoolTuning>;
}

type LoadedConfig = {
  path: string;
  mtimeMs: number;
  data: VenueConfigShape;
};

const REPO_ROOT = resolveRepoRoot(import.meta.url);
const DEFAULT_RELATIVE_PATH = path.join("configs", "venues.json");

let cachedConfig: LoadedConfig | null = null;

function resolveConfigPath(): string {
  const hint = process.env.VENUE_CONFIG_PATH?.trim();
  if (hint && hint.length > 0) {
    return path.isAbsolute(hint) ? hint : path.resolve(REPO_ROOT, hint);
  }
  return path.resolve(REPO_ROOT, DEFAULT_RELATIVE_PATH);
}

function safeParse(json: string): VenueConfigShape {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") {
      return parsed as VenueConfigShape;
    }
  } catch {
    /* swallow parse errors and fall back to empty config */
  }
  return {};
}

function loadVenueConfig(): LoadedConfig {
  const configPath = resolveConfigPath();
  try {
    const stat = fs.statSync(configPath);
    const mtimeMs = stat.mtimeMs;
    if (cachedConfig && cachedConfig.path === configPath && cachedConfig.mtimeMs === mtimeMs) {
      return cachedConfig;
    }
    const raw = fs.readFileSync(configPath, "utf8");
    const data = safeParse(raw);
    cachedConfig = { path: configPath, mtimeMs, data };
    return cachedConfig;
  } catch {
    cachedConfig = {
      path: configPath,
      mtimeMs: 0,
      data: {},
    };
    return cachedConfig;
  }
}

export function getVenueConfig(): VenueConfigShape {
  return loadVenueConfig().data;
}

export function getVenueTuning(venue: string): VenueTuning | undefined {
  if (!venue) return undefined;
  const cfg = getVenueConfig();
  const venues = cfg.venues ?? {};
  const key = venue.toLowerCase();
  return venues[key];
}

export function getPoolTuning(poolId: string): PoolTuning | undefined {
  if (!poolId) return undefined;
  const cfg = getVenueConfig();
  const pools = cfg.pools ?? {};
  return pools[poolId];
}

export function listVenueTunings(): Array<{ venue: string; tuning: VenueTuning }> {
  const cfg = getVenueConfig();
  return Object.entries(cfg.venues ?? {}).map(([venue, tuning]) => ({
    venue,
    tuning,
  }));
}
