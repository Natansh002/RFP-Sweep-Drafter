#!/usr/bin/env node
/**
 * Generates the importable n8n workflow JSON in n8n/.
 *
 * Why generate rather than hand-write: extraction, scoring, drafting and the
 * internal-tool guard live in lib/ and are inlined into the Code nodes. Hand-
 * editing the workflow JSON would fork them, and a sweep that scores differently
 * from the desk is worse than no sweep.
 *
 * Config (tenants, packs, channel registry) is embedded at build time. n8n never
 * fetches config from a git server or any other host, so there is no link from
 * the workflow to an internal system. Change config → npm run build → re-import.
 *
 * The workflows output files only: a findings .xlsx and a findings.json run file.
 * A person downloads them from the execution and imports the run file in the
 * dashboard. No node creates a Jira issue, a task, or touches Confluence; the
 * validator fails the build if one appears.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "n8n");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const listIds = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".json") && !f.startsWith("_")).map((f) => f.replace(/\.json$/, "")).sort();

const tenants = Object.fromEntries(listIds("tenants").map((id) => [id, readJson(path.join(ROOT, "tenants", `${id}.json`))]));
const packs = Object.fromEntries(listIds("industries").map((id) => [id, readJson(path.join(ROOT, "industries", `${id}.json`))]));
const registry = readJson(path.join(ROOT, "channels", "registry.json"));

// Inline a lib module: strip the ESM export keywords; a Code node has no module system.
const inline = (f) =>
  fs.readFileSync(path.join(ROOT, "lib", f), "utf8").replace(/^export default .*$/m, "").replace(/^export /gm, "");

const GUARD = inline("guard.mjs");
const PACK = inline("pack.mjs");
const EXTRACT = inline("extract.mjs");
const SCORE = inline("score.mjs");
const DRAFT = inline("draft.mjs");
const ENRICH = inline("enrich.mjs");
const LIBRARY = inline("library.mjs");
const libraries = Object.fromEntries(Object.keys(tenants).map((id) => {
  const p = path.join(ROOT, "library", `${id}.json`);
  return [id, fs.existsSync(p) ? readJson(p).entries ?? [] : []];
}));

const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters,
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
  name,
  type,
  typeVersion,
  position,
  ...extra,
});
const chain = (...names) => {
  const c = {};
  for (let i = 0; i < names.length - 1; i++) c[names[i]] = { main: [[{ node: names[i + 1], type: "main", index: 0 }]] };
  return c;
};
const code = (...parts) => parts.join("\n\n").trim();

/* ------------------------------------------------------------------ core */
/* One channel: guarded fetch, extract, score, draft. Called once per channel. */

const FETCH_NODE = code(GUARD, `
// Guarded fetch. Redirects are followed by hand so every hop is checked before
// it is requested: nothing here may reach Jira, Confluence or any internal tool.
const out = [];
for (const item of $input.all()) {
  const ch = item.json.channel;
  const blocked = item.json.tenant?.guard?.extraBlockedHosts ?? [];
  let body = null, error = null;
  try {
    let at = assertAllowedUrl(ch.searchUrl || ch.url, blocked);
    let res;
    for (let hop = 0; hop < 6; hop++) {
      res = await this.helpers.httpRequest({ url: at, method: 'GET', returnFullResponse: true, disableFollowRedirect: true, ignoreHttpStatusErrors: true, timeout: 30000,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; ionic-rfp-sweeper/0.2)' } });
      const loc = res.statusCode >= 300 && res.statusCode < 400 ? (res.headers.location || res.headers.Location) : null;
      if (!loc) break;
      at = assertAllowedUrl(new URL(loc, at).href, blocked);
    }
    if (res.statusCode >= 400) error = 'HTTP ' + res.statusCode;
    else body = res.body;
  } catch (e) {
    error = e.message;
  }
  out.push({ json: { ...item.json, body, error } });
}
return out;`);

const EXTRACT_NODE = code(EXTRACT, `
return $input.all().map((item) => ({ json: { ...item.json, body: undefined, extracted: extractPostings(item.json.channel, item.json.body, item.json.error) } }));`);

const SCORE_NODE = code(GUARD, SCORE, DRAFT, ENRICH, LIBRARY, `
// Score, read each candidate's own posting page (guarded, same as lib/sweep.mjs),
// score again on what the page says, then draft.
const getPage = async (url, blocked) => {
  let at = assertAllowedUrl(url, blocked), res;
  for (let hop = 0; hop < 6; hop++) {
    res = await this.helpers.httpRequest({ url: at, method: 'GET', returnFullResponse: true, disableFollowRedirect: true, ignoreHttpStatusErrors: true, timeout: 30000 });
    const loc = res.statusCode >= 300 && res.statusCode < 400 ? (res.headers.location || res.headers.Location) : null;
    if (!loc) break;
    at = assertAllowedUrl(new URL(loc, at).href, blocked);
  }
  if (res.statusCode >= 400) throw new Error('HTTP ' + res.statusCode);
  return typeof res.body === 'string' ? res.body : null;
};
const out = [];
for (const item of $input.all()) {
  const { pack, tenant, library, extracted: x } = item.json;
  const blocked = tenant?.guard?.extraBlockedHosts ?? [];
  const candidates = [];
  for (const raw of x.postings) {
    const p = { ...raw, url: safeLink(raw.url, blocked) };
    const s = score(p, pack, tenant);
    if (s.band === 'dropped' || s.band === 'no bid') continue;
    candidates.push({ p, s });
  }
  const limit = Math.ceil((tenant.detailPagesPerRun ?? 40) / 4);
  for (const c of candidates.filter((c) => c.p.url).sort((a, b) => b.s.total - a.s.total).slice(0, limit)) {
    try {
      const html = await getPage(c.p.url, blocked);
      if (!html) continue;
      const d = analyzeDetail(html, tenant);
      c.p = { ...c.p, body: d.body, closeDate: c.p.closeDate ?? d.closeDate, incumbent: c.p.incumbent ?? d.incumbent, keyDates: d.keyDates, requirements: d.requirements, competitors: d.competitors, contentHash: d.contentHash };
      c.s = score(c.p, pack, tenant);
    } catch (e) { c.s.flags.push('posting page not read: ' + e.message); }
  }
  const findings = [];
  for (const c of candidates) {
    if (c.s.band === 'dropped' || c.s.band === 'no bid') continue;
    const matched = c.s.band === 'pursue' ? matchLibrary(library ?? [], c.p.title + ' ' + (c.p.body ?? ''), pack.id) : [];
    findings.push(draftFinding({ ...c.p, body: undefined }, c.s, pack, tenant, x.channel, new Date(), matched));
  }
  out.push({ json: { channel: x.channel, status: x.status, detail: x.detail ?? null, found: x.postings.length, findings } });
}
return out;`);

const core = {
  name: "RFP Sweeper — core (one channel)",
  nodes: [
    node("Core input", "n8n-nodes-base.executeWorkflowTrigger", 1, [0, 300], { inputSource: "passthrough" }),
    node("Guarded fetch", "n8n-nodes-base.code", 2, [220, 300], { jsCode: FETCH_NODE }),
    node("Extract postings", "n8n-nodes-base.code", 2, [440, 300], { jsCode: EXTRACT_NODE }),
    node("Score and draft", "n8n-nodes-base.code", 2, [660, 300], { jsCode: SCORE_NODE }),
  ],
  connections: chain("Core input", "Guarded fetch", "Extract postings", "Score and draft"),
  settings: { executionOrder: "v1" },
  pinData: {},
};

/* ------------------------------------------------------------------ run */
/* One tenant × industry. Input: { tenant, industry, maxPriority }. */

const LOAD_CONFIG = code(PACK, `
// Config is embedded at build time (scripts/build-workflows.mjs). Nothing is
// fetched from a config server.
const TENANTS = ${JSON.stringify(tenants)};
const PACKS = ${JSON.stringify(packs)};
const REGISTRY = ${JSON.stringify(registry)};
const LIBRARIES = ${JSON.stringify(libraries)};

const input = $input.first().json;
const tenant = TENANTS[input.tenant];
if (!tenant) throw new Error('Unknown tenant: ' + input.tenant);
if (!tenant.industries.includes(input.industry)) throw new Error(tenant.name + ' does not subscribe to ' + input.industry);
const pack = effectivePack(PACKS[input.industry], tenant);
const { run, skipped } = resolveChannels(pack, REGISTRY, tenant, Number(input.maxPriority ?? 2));
if (!run.length) throw new Error('No channels resolved. Skipped: ' + skipped.join('; '));
return run.map((channel, i) => ({ json: { channel, pack, tenant, library: LIBRARIES[tenant.id] ?? [], skipped: i === 0 ? skipped : undefined } }));`);

const BUILD_RUN = `
// The run file: the same shape the dashboard's "Import n8n run" expects.
const first = $('Load config').first().json;
const { tenant, pack } = first;
const byId = new Map();
const gaps = [];
let postingsSeen = 0;
for (const item of $input.all()) {
  const j = item.json;
  postingsSeen += j.found ?? 0;
  if (j.status !== 'ok') gaps.push({ channel: j.channel, status: j.status, detail: j.detail });
  for (const f of j.findings ?? []) { const p = byId.get(f.id); if (!p || p.score < f.score) byId.set(f.id, f); }
}
const findings = [...byId.values()].sort((a, b) => b.score - a.score);
const cap = tenant.safety?.maxNewPursuePerRun ?? 15;
const pursue = findings.filter((f) => f.band === 'pursue').length;
const halted = pursue > cap;
return [{ json: {
  kind: 'ionic-rfp-sweeper/run', version: 1,
  tenant: tenant.id, industry: pack.id, runAt: new Date().toISOString(),
  channelsRead: $input.all().length, postingsSeen,
  findings: halted ? [] : findings, gaps, halted,
  haltReason: halted ? pursue + ' postings scored "pursue", over the cap of ' + cap + '. Nothing included. A qualifier is probably too loose.' : null,
  caveat: pack.status !== 'proven' ? 'Industry pack "' + pack.id + '" is ' + pack.status + '. Its yield is not comparable to a proven pack.' : null,
  skipped: first.skipped ?? [],
} }];`.trim();

const ROWS = `
// One row per finding, for the Excel file.
const run = $input.first().json;
if (!run.findings.length) return [{ json: { Note: run.halted ? run.haltReason : 'No findings this run. Coverage gaps: ' + run.gaps.map((g) => g.channel + ' (' + g.status + ')').join(', ') } }];
return run.findings.map((f) => ({ json: {
  ID: f.id, Industry: f.industry, Score: f.score, Band: f.band, Status: 'New', Assignee: f.assignee || '', 'Suggested owner': f.suggestedAssignee || '',
  Title: f.title, Link: f.url || '', Buyer: f.buyer || '', Country: f.country || '', Closes: f.closeDate || '',
  'Est. value': f.estimatedValue ?? '', Channel: f.channel, 'Why it scored this way': f.reasons.join(' | '), Flags: f.flags.join(' | '),
  'Questions due': f.keyDates?.questions || '', Competitors: (f.competitors ?? []).join(', '), Requirements: (f.requirements ?? []).length,
  'Action items': f.actions.map((a) => a.title + (a.due ? ' (due ' + a.due + ')' : '')).join(' | '),
} }));`.trim();

const ATTACH = `
// Add the run file beside the spreadsheet so both download from one execution.
const run = $('Build run file').first().json;
const item = $input.first();
item.binary = item.binary ?? {};
item.binary.findings_json = {
  data: Buffer.from(JSON.stringify(run, null, 2)).toString('base64'),
  mimeType: 'application/json',
  fileName: run.tenant + '-' + run.industry + '-run.json',
  fileExtension: 'json',
};
item.json = { tenant: run.tenant, industry: run.industry, findings: run.findings.length, gaps: run.gaps.length, halted: run.halted, next: 'Download findings_json and use Import n8n run in the dashboard. Download data for the spreadsheet.' };
return [item];`.trim();

const runWf = {
  name: "RFP Sweeper — run (tenant × industry)",
  nodes: [
    node("Run input", "n8n-nodes-base.executeWorkflowTrigger", 1, [0, 300], { inputSource: "passthrough" }),
    node("Load config", "n8n-nodes-base.code", 2, [220, 300], { jsCode: LOAD_CONFIG }),
    node("Sweep each channel", "n8n-nodes-base.executeWorkflow", 1.2, [440, 300], {
      workflowId: "={{ $env.SWEEPER_CORE_WORKFLOW_ID }}",
      mode: "each",
      options: { waitForSubWorkflow: true },
    }),
    node("Build run file", "n8n-nodes-base.code", 2, [660, 300], { jsCode: BUILD_RUN }),
    node("Findings rows", "n8n-nodes-base.code", 2, [880, 300], { jsCode: ROWS }),
    node("Findings to Excel", "n8n-nodes-base.convertToFile", 1.1, [1100, 300], {
      operation: "xlsx",
      options: { fileName: "={{ $('Build run file').first().json.tenant }}-{{ $('Build run file').first().json.industry }}-rfp-findings.xlsx", sheetName: "Findings" },
    }),
    node("Attach run file", "n8n-nodes-base.code", 2, [1320, 300], { jsCode: ATTACH }),
  ],
  connections: chain("Run input", "Load config", "Sweep each channel", "Build run file", "Findings rows", "Findings to Excel", "Attach run file"),
  settings: { executionOrder: "v1" },
  pinData: {},
};

/* -------------------------------------------------------- on demand */

const tenantOptions = Object.values(tenants).map((t) => ({ label: t.name, id: t.id }));
const industryOptions = Object.values(packs).map((p) => ({ label: `${p.name}${p.status === "proven" ? "" : `  [${p.status}]`}`, id: p.id }));

const onDemandParams = `
const TENANT = ${JSON.stringify(Object.fromEntries(tenantOptions.map((o) => [o.label, o.id])), null, 2)};
const INDUSTRY = ${JSON.stringify(Object.fromEntries(industryOptions.map((o) => [o.label, o.id])), null, 2)};
const SUBSCRIBED = ${JSON.stringify(Object.fromEntries(Object.values(tenants).map((t) => [t.id, t.industries])))};

const f = $input.first().json;
const tenant = TENANT[f['Operating company']];
const industry = INDUSTRY[f['Industry']];
if (!tenant) throw new Error('Unknown operating company: ' + f['Operating company'] + '. Re-run npm run build and re-import.');
if (!industry) throw new Error('Unknown industry: ' + f['Industry'] + '. Re-run npm run build and re-import.');
if (!SUBSCRIBED[tenant].includes(industry)) throw new Error(f['Operating company'] + ' does not subscribe to ' + industry + '. It subscribes to: ' + SUBSCRIBED[tenant].join(', '));
return [{ json: { tenant, industry, maxPriority: Number(String(f['How wide?']).charAt(0)) } }];`.trim();

const onDemand = {
  name: "RFP Sweeper — on demand",
  nodes: [
    node("Select sweep", "n8n-nodes-base.formTrigger", 2.2, [0, 300], {
      path: "rfp-sweep",
      formTitle: "Run an RFP sweep",
      formDescription: "Pick the operating company and industry. The run produces a findings spreadsheet and a run file for the dashboard. Nothing is filed anywhere.",
      formFields: {
        values: [
          { fieldLabel: "Operating company", fieldType: "dropdown", fieldOptions: { values: tenantOptions.map((o) => ({ option: o.label })) }, requiredField: true },
          { fieldLabel: "Industry", fieldType: "dropdown", fieldOptions: { values: industryOptions.map((o) => ({ option: o.label })) }, requiredField: true },
          {
            fieldLabel: "How wide?",
            fieldType: "dropdown",
            fieldOptions: { values: [{ option: "1 — highest-yield channels only" }, { option: "2 — normal" }, { option: "3 — everything, including paid aggregators" }] },
            requiredField: true,
          },
        ],
      },
      options: {},
    }),
    node("Sweep parameters", "n8n-nodes-base.code", 2, [220, 300], { jsCode: onDemandParams }),
    node("Run sweep", "n8n-nodes-base.executeWorkflow", 1.2, [440, 300], {
      workflowId: "={{ $env.SWEEPER_RUN_WORKFLOW_ID }}",
      mode: "once",
      options: { waitForSubWorkflow: true },
    }),
  ],
  connections: chain("Select sweep", "Sweep parameters", "Run sweep"),
  settings: { executionOrder: "v1" },
  pinData: {},
};

/* -------------------------------------------------------- scheduled, one per tenant */

const scheduled = Object.values(tenants).map((t) => ({
  file: `sweep-scheduled-${t.id}.json`,
  wf: {
    name: `RFP Sweeper — scheduled — ${t.name}`,
    nodes: [
      node("Schedule", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 300], {
        rule: { interval: [{ field: "cronExpression", expression: t.schedule?.cron ?? "0 10 * * 1" }] },
      }),
      node("One run per industry", "n8n-nodes-base.code", 2, [220, 300], {
        jsCode: [
          "// One run per subscribed industry, so each pack gets its own findings file rather than",
          "// one blended report that hides which pack is working. Embedded from tenants/" + t.id + ".json.",
          `return ${JSON.stringify(t.industries)}.map((industry) => ({ json: { tenant: ${JSON.stringify(t.id)}, industry, maxPriority: 2 } }));`,
        ].join("\n"),
      }),
      node("Run sweep", "n8n-nodes-base.executeWorkflow", 1.2, [440, 300], {
        workflowId: "={{ $env.SWEEPER_RUN_WORKFLOW_ID }}",
        mode: "each",
        options: { waitForSubWorkflow: true },
      }),
    ],
    connections: chain("Schedule", "One run per industry", "Run sweep"),
    settings: { executionOrder: "v1", ...(t.schedule?.timezone ? { timezone: t.schedule.timezone } : {}) },
    pinData: {},
  },
}));

/* ------------------------------------------------------------------ write */
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT).filter((f) => f.startsWith("sweep-") && f.endsWith(".json"))) fs.unlinkSync(path.join(OUT, f));
// With no company configured there is nothing to pick in the form, so the form
// workflow is not generated until the first tenant exists.
const files = { "sweep-core.json": core, "sweep-run.json": runWf, ...(tenantOptions.length ? { "sweep-on-demand.json": onDemand } : {}), ...Object.fromEntries(scheduled.map((s) => [s.file, s.wf])) };
if (!tenantOptions.length) console.log("No tenants yet: on-demand and scheduled workflows are generated once one exists (npm run new-tenant).");
for (const [name, wf] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(wf, null, 2) + "\n");
  console.log(`wrote n8n/${name}  (${wf.nodes.length} nodes)`);
}
console.log(`\nindustries: ${Object.keys(packs).join(", ")}`);
console.log(`tenants:    ${Object.keys(tenants).join(", ")}`);
