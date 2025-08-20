// services/arb-mm/src/util/colors.ts
// Minimal ANSI color helpers (no deps). Honors NO_COLOR and TTY.
const enabled =
  !process.env.NO_COLOR &&
  (process.env.FORCE_COLOR ? true : process.stdout.isTTY);

const wrap = (open: string, close: string) => (s: any) =>
  enabled ? `${open}${s}${close}` : String(s);

export const green  = wrap("\x1b[32m", "\x1b[39m");
export const yellow = wrap("\x1b[33m", "\x1b[39m");
export const cyan   = wrap("\x1b[36m", "\x1b[39m");
export const gray   = wrap("\x1b[90m", "\x1b[39m");
export const bold   = wrap("\x1b[1m",  "\x1b[22m");
