#!/usr/bin/env node
/**
 * Refuse to go on if a file git would commit holds a secret (lib/secrets.mjs): every
 * tracked file, and every new file that is not ignored. Part of `npm run check` and CI.
 * It names the file, line and kind of secret, never the value.
 *
 *   node scripts/check-secrets.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../lib/config.mjs";
import { findSecrets } from "../lib/secrets.mjs";

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|xlsx|docx|woff2?|ttf)$/i;
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString().split("\0").filter(Boolean);
const found = [];
for (const f of new Set(files)) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
  const text = BINARY.test(f) ? "" : fs.readFileSync(p, "utf8");
  for (const h of findSecrets(f, text)) found.push(`${f}${h.line ? `:${h.line}` : ""}  ${h.kind}`);
}
if (found.length) {
  console.error(`Secret check FAILED: ${found.length} finding(s). Remove the secret (and rotate it if it was ever pushed):\n  ${found.join("\n  ")}`);
  process.exit(1);
}
console.log(`Secret check: ${files.length} files, no secrets.`);
