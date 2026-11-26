
import { existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";

export function resolveBin(name, extraDirs = []) {
  const dirs = [...extraDirs, ...(process.env.PATH || "").split(":")].filter(Boolean);
  const home = process.env.HOME || "";
  if (home) {
    dirs.push(join(home, ".foundry", "bin"));
    dirs.push(join(home, ".local", "share", "solana", "install", "active_release", "bin"));
    dirs.push(join(home, ".local", "share", "solana", "install", "active_release", "bin"));
  }
  const seen = new Set();
  for (const d of dirs) {
    if (seen.has(d)) continue;
    seen.add(d);
    const p = join(d, name);
    try {
      if (existsSync(p)) {
        accessSync(p, constants.X_OK);
        return p;
      }
    } catch { /* not executable */ }
  }
  return null;
}
