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

/**
 * "all" is not a company: it is the built-in mode that sweeps every industry
 * pack with no company-specific offering, so the sweep and the analyzer work
 * before any tenant is configured. Its findings live in store/all.json.
 */
export const GENERAL_ID = "all";
export function generalTenant() {
  // "any" first: a posting that also fits a specific industry is later re-labelled by that industry's run.
  const packs = industryIds().sort((a, b) => (a === "any" ? -1 : b === "any" ? 1 : 0)).map((id) => readJson(path.join(ROOT, "industries", `${id}.json`))).filter((p) => !["draft", "retired"].includes(p.status));
  return {
    id: GENERAL_ID,
    name: "All industries (no company)",
    status: "active",
    general: true,
    industries: packs.map((p) => p.id),
    geography: ["CA", "US"],
    offerings: Object.fromEntries(packs.map((p) => [p.id, { productLines: [p.name] }])),
    team: ["RFP Manager", "Pre-sales Consultant", "Account Executive", "SME Contributor"],
    owners: { default: "RFP Manager" },
    autoAssign: false,
    profile: {},
    competitors: [],
    safety: { maxNewPursuePerRun: 50 },
    detailPagesPerRun: 40,
  };
}

export const tenantIds = () => [GENERAL_ID, ...ids(TENANTS_DIR).filter((id) => id !== GENERAL_ID)];
export const companyIds = () => ids(TENANTS_DIR).filter((id) => id !== GENERAL_ID);
export const industryIds = () => ids("industries");

export function loadTenant(id) {
  if (id === GENERAL_ID) return generalTenant();
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
  // RFP_OUTPUT_DIR sends workbooks elsewhere (used by the end-to-end tests).
  const dir = process.env.RFP_OUTPUT_DIR ? path.resolve(process.env.RFP_OUTPUT_DIR) : path.join(ROOT, "output");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${tenantId}-rfp-findings.xlsx`);
}
