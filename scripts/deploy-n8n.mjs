#!/usr/bin/env node
/**
 * Deploy the generated workflows to an existing n8n instance (Cloud or
 * self-hosted) through its public API, and wire them together.
 *
 *   npm run deploy:n8n              create or update, activate form + schedules
 *   npm run deploy:n8n -- --dry-run show what would change, touch nothing
 *   npm run deploy:n8n -- --no-activate
 *
 * Credentials come from the environment or .env.local (gitignored), never from
 * the command line or the repo:
 *
 *   N8N_URL=https://your-instance.app.n8n.cloud
 *   N8N_API_KEY=...            n8n → Settings → n8n API → Create an API key
 *
 * Idempotent: workflows are matched by name, so re-running updates in place.
 * Sub-workflow ids are written straight into the Execute Workflow nodes, so no
 * n8n environment variables are needed (n8n Cloud does not allow them).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../lib/config.mjs";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ACTIVATE = !args.includes("--no-activate");

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvFile(path.join(ROOT, ".env.local"));

const BASE = (process.env.N8N_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.N8N_API_KEY ?? "";
if (!/^https?:\/\//.test(BASE) || !KEY) {
  console.error("Set N8N_URL and N8N_API_KEY in .env.local (see .env.example). Nothing was deployed.");
  process.exit(2);
}
if (!BASE.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("Refusing to send the API key over plain http to a non-local host. Use https.");
  process.exit(2);
}

async function api(method, p, body) {
  const res = await fetch(`${BASE}/api/v1${p}`, {
    method,
    headers: { "X-N8N-API-KEY": KEY, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Rebuild first so what is deployed is exactly what the validator checked.
execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-workflows.mjs")], { stdio: "ignore" });
execFileSync(process.execPath, [path.join(ROOT, "scripts", "validate.mjs")], { stdio: "inherit" });

const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "n8n", f), "utf8"));
const files = fs.readdirSync(path.join(ROOT, "n8n")).filter((f) => /^sweep-.*\.json$/.test(f));
const order = ["sweep-core.json", "sweep-run.json", ...(files.includes("sweep-on-demand.json") ? ["sweep-on-demand.json"] : []), ...files.filter((f) => f.startsWith("sweep-scheduled-")).sort()];

// The public API accepts only these settings keys.
const SETTINGS = ["executionOrder", "timezone", "saveDataErrorExecution", "saveDataSuccessExecution", "saveManualExecutions", "saveExecutionProgress", "executionTimeout", "errorWorkflow"];

function wire(wf, ids) {
  for (const n of wf.nodes) {
    if (n.type !== "n8n-nodes-base.executeWorkflow") continue;
    const v = String(n.parameters.workflowId ?? "");
    const target = v.includes("SWEEPER_CORE_WORKFLOW_ID") ? ids.core : v.includes("SWEEPER_RUN_WORKFLOW_ID") ? ids.run : null;
    if (!target) continue;
    n.parameters.source = "database";
    n.parameters.workflowId = { __rl: true, mode: "id", value: target };
  }
  return {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: Object.fromEntries(Object.entries(wf.settings ?? {}).filter(([k]) => SETTINGS.includes(k))),
  };
}

const existing = new Map();
let cursor = "";
do {
  const page = await api("GET", `/workflows?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  for (const w of page.data ?? []) existing.set(w.name, w);
  cursor = page.nextCursor ?? "";
} while (cursor);

const ids = {};
const deployed = [];
for (const f of order) {
  const wf = load(f);
  const body = wire(wf, ids);
  const cur = existing.get(wf.name);
  let id = cur?.id;
  if (DRY) {
    console.log(`${cur ? "update" : "create"}  ${wf.name}`);
    id = id ?? `<new:${f}>`;
  } else if (cur) {
    await api("PUT", `/workflows/${id}`, body);
    console.log(`updated  ${wf.name}  (${id})`);
  } else {
    id = (await api("POST", "/workflows", body)).id;
    console.log(`created  ${wf.name}  (${id})`);
  }
  if (f === "sweep-core.json") ids.core = id;
  if (f === "sweep-run.json") ids.run = id;
  deployed.push({ file: f, name: wf.name, id });
}

// Only entry points are activated. Core and run are sub-workflows called by them.
if (ACTIVATE && !DRY) {
  for (const d of deployed.filter((x) => x.file === "sweep-on-demand.json" || x.file.startsWith("sweep-scheduled-"))) {
    try {
      await api("POST", `/workflows/${d.id}/activate`);
      console.log(`active   ${d.name}`);
    } catch (e) {
      console.log(`NOT ACTIVE  ${d.name}: ${e.message}`);
    }
  }
}

const form = deployed.find((d) => d.file === "sweep-on-demand.json");
console.log(`
${DRY ? "Dry run: nothing changed." : "Done."}
On-demand form:  ${BASE}/form/rfp-sweep
Workflows:       ${BASE}/home/workflows
Results:         open an execution of "RFP Sweeper — run", download "data" (xlsx) and
                 "findings_json", then use Import n8n run in the local dashboard.`);
