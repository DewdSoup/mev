import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const rootMemo = new Map<string, string>();

function looksLikeRepoRoot(dir: string): boolean {
  try {
    if (fs.existsSync(path.join(dir, ".git"))) return true;
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
  } catch { /* ignore */ }
  return false;
}

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (looksLikeRepoRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return startDir;
}

export function resolveRepoRoot(importMetaUrl: string): string {
  const filePath = fileURLToPath(importMetaUrl);
  const dir = path.dirname(filePath);
  if (rootMemo.has(dir)) return rootMemo.get(dir)!;
  const root = findRepoRoot(dir);
  rootMemo.set(dir, root);
  return root;
}

export function resolveRepoRelative(importMetaUrl: string, relativePath: string): string {
  const root = resolveRepoRoot(importMetaUrl);
  return path.resolve(root, relativePath);
}
