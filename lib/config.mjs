/** Read config from a checkout. The n8n workflows read the same files over HTTP. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const ids = (dir) =>
  fs.readdirSync(path.isAbsolute(dir) ? dir : path.join(ROOT, dir)).filter((f) => f.endsWith(".json") && !f.startsWith("_")).map((f) => f.replace(/\.json$/, ""));

// Tests point this at scripts/fixtures/tenants so fictional companies never reach tenants/ or the site.
const TENANTS_DIR = process.env.RFP_TENANTS_DIR ? path.resolve(ROOT, process.env.RFP_TENANTS_DIR) : path.join(ROOT, "tenants");

export const tenantIds = () => ids(TENANTS_DIR);
export const industryIds = () => ids("industries");

export function loadTenant(id) {
  const p = path.join(TENANTS_DIR, `${id}.json`);
  if (!/^[a-z0-9-]+$/.test(id) || !fs.existsSync(p)) throw new Error(`Unknown tenant "${id}". Have: ${tenantIds().join(", ")}`);
  return readJson(p);
}

export function loadPack(id) {
  const p = path.join(ROOT, "industries", `${id}.json`);
  if (!/^[a-z0-9-]+$/.test(id) || !fs.existsSync(p)) throw new Error(`Unknown industry "${id}". Have: ${industryIds().join(", ")}`);
  return readJson(p);
}

export const loadRegistry = () => readJson(path.join(ROOT, "channels", "registry.json"));

export function loadData(rel) {
  if (!rel) return null;
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? readJson(p) : null;
}

export function outputFile(tenantId) {
  const dir = path.join(ROOT, "output");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${tenantId}-rfp-findings.xlsx`);
}
