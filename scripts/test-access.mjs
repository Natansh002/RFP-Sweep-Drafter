#!/usr/bin/env node
/**
 * Tests for configuration: the private host's access list and roles, the
 * sales-platform opportunity fields, and the MCP server (spoken to over stdio,
 * as Claude would). Uses a temporary store; nothing real is touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { validateAccess, rolesFor, hostConfig, ACCESS_ROLES } from "../lib/access.mjs";
import { crmPayload, validCrmLink, CRM_PLATFORMS } from "../lib/crm.mjs";
import { saveLedger, writeStore, readStore } from "../lib/ledger.mjs";
import { ROOT } from "../lib/config.mjs";
import { findBlocked } from "../lib/guard.mjs";

let fails = 0, passes = 0;
const a = (name, cond) => { if (cond) passes++; else { fails++; console.log(`FAIL: ${name}`); } };
const require = createRequire(import.meta.url);

// ---- the access list: work email + one of the four roles, nothing else
const v = validateAccess([
  { email: " Ana@Example.org ", role: "account executive" },
  { email: "sam@example.org", role: "SME Contributor", admin: true },
  { email: "not an email", role: "RFP Manager" },
  { email: "lee@example.org", role: "Sales Exec" },
  { email: "ana@example.org", role: "RFP Manager" },
]);
a("access: emails normalised, roles matched case-insensitively", v.users[0].email === "ana@example.org" && v.users[0].role === "Account Executive");
a("access: bad email, unknown role and duplicate each reported", v.errors.length === 3 && /not an email/.test(v.errors[0]) && /four roles/.test(v.errors[1]) && /twice/.test(v.errors[2]));
a("access: only email, role and admin are kept (no names)", Object.keys(v.users[1]).sort().join() === "admin,email,role");
a("access: the four roles", ACCESS_ROLES.join("|") === "RFP Manager|Pre-sales Consultant|Account Executive|SME Contributor");
a("roles: a listed email gets rfp_user and its role", rolesFor(v.users, "ANA@example.org").join() === "rfp_user,rfp_account_executive");
a("roles: admin flag adds rfp_admin", rolesFor(v.users, "sam@example.org").includes("rfp_admin"));
a("roles: anyone else gets nothing", rolesFor(v.users, "stranger@example.org").length === 0);

// the host's copy (api/roles) answers exactly like lib/access.mjs
const fn = require("../api/roles/index.js");
process.env.RFP_ACCESS = JSON.stringify(v.users);
const ask = async (body, headers = {}) => { const ctx = {}; await fn(ctx, { body, headers }); return ctx.res.body.roles; };
a("api/roles: same roles as lib/access.mjs", (await ask({ identityProvider: "aad", userDetails: "ana@example.org" })).join() === rolesFor(v.users, "ana@example.org").join());
a("api/roles: only Microsoft sign-in counts", (await ask({ identityProvider: "github", userDetails: "ana@example.org" })).length === 0);
a("api/roles: email from claims when userDetails is empty", (await ask({ identityProvider: "aad", claims: [{ typ: "preferred_username", val: "sam@example.org" }] })).includes("rfp_user"));
const principal = (email) => Buffer.from(JSON.stringify({ userDetails: email })).toString("base64");
a("api/roles: a signed-in person cannot ask about someone else", (await ask({ identityProvider: "aad", userDetails: "ana@example.org" }, { "x-ms-client-principal": principal("mallory@example.org") })).length === 0);
a("api/roles: a broken access setting gives no roles, not an error", await (async () => { process.env.RFP_ACCESS = "{not json"; const r = await ask({ identityProvider: "aad", userDetails: "ana@example.org" }); process.env.RFP_ACCESS = JSON.stringify(v.users); return r.length === 0; })());

// the private host's route rules
const cfg = hostConfig({ tenantId: "00000000-0000-0000-0000-000000000000" });
a("host: every page needs rfp_user", cfg.routes.at(-1).route === "/*" && cfg.routes.at(-1).allowedRoles.join() === "rfp_user");
a("host: roles come from api/roles, sign-in is the company tenant", cfg.auth.rolesSource === "/api/roles" && /00000000-0000-0000-0000-000000000000\/v2\.0$/.test(cfg.auth.identityProviders.azureActiveDirectory.registration.openIdIssuer));
a("host: other sign-in providers are switched off", cfg.routes.some((r) => r.route === "/.auth/login/github" && r.statusCode === 404));
a("host: not signed in → Microsoft sign-in; not on the list → no-access page", cfg.responseOverrides["401"].redirect.startsWith("/.auth/login/aad") && cfg.responseOverrides["403"].rewrite === "/no-access.html");
a("host: secrets are setting names, never values", JSON.stringify(cfg).includes("AAD_CLIENT_SECRET") && !/secret"\s*:\s*"[^A]/i.test(JSON.stringify(cfg)));

// ---- sales-platform fields
const F = { id: "all-abc123", title: "Enterprise Resource Planning System", buyer: "Example Housing Corporation", closeDate: "2026-10-16", status: "Pursuing", url: "https://kyhousing.bonfirehub.com/opportunities/1", estimatedValue: null,
  keyDates: {}, rfp: { keyData: { dates: { questions: "2099-09-30" }, contractTerm: "5 years", renewals: "4 option years", evaluation: [{ criterion: "Technical approach", weight: 60, unit: "%" }, { criterion: "Price", weight: 40, unit: "%" }], evaluationBasis: "Best value (trade-off)" } } };
const sf = crmPayload(F, "salesforce", { profile: { name: "Harborline Systems" } });
a("crm: Salesforce Opportunity fields", sf.object === "Opportunity" && sf.fields.Name === "RFP: Enterprise Resource Planning System" && sf.fields.CloseDate === "2026-10-16" && sf.fields.StageName === "Qualification" && sf.fields.LeadSource === "RFP");
a("crm: the description carries the key facts and the source", /Questions due: 2099-09-30/.test(sf.fields.Description) && /Contract term: 5 years \(4 option years\)/.test(sf.fields.Description) && /Technical approach 60%/.test(sf.fields.Description) && /bonfirehub/.test(sf.fields.Description) && /RFP Sweep id: all-abc123/.test(sf.fields.Description));
a("crm: the account is looked up, not guessed", /Look up the Account for "Example Housing Corporation"/.test(sf.lookups.AccountId));
a("crm: no invented amount; the person is told", sf.fields.Amount === null && sf.decide.some((d) => /No value was published/.test(d)));
a("crm: next step from the questions deadline", /Send questions by 2099-09-30/.test(sf.fields.NextStep));
a("crm: HubSpot deal and Dynamics 365 opportunity", crmPayload(F, "hubspot").object === "deal" && crmPayload(F, "hubspot").properties.dealname && crmPayload(F, "dynamics365").entity === "opportunity" && crmPayload(F, "dynamics365").fields.estimatedclosedate === "2026-10-16");
a("crm: every platform produces fields", CRM_PLATFORMS.every((p) => Object.keys(crmPayload(F, p).fields ?? crmPayload(F, p).properties ?? {}).length >= 4));
a("crm link: a Salesforce id and link on its own domain", validCrmLink({ platform: "salesforce", recordId: "006Hs00001AbCdEIAV", url: "https://acme.lightning.force.com/lightning/r/Opportunity/006Hs00001AbCdEIAV/view" }) === null);
a("crm link: a link on another domain is refused", /not on Salesforce/.test(validCrmLink({ platform: "salesforce", recordId: "006x", url: "https://evil.example/006x" }) ?? ""));
a("crm link: http and odd ids are refused", /https/.test(validCrmLink({ platform: "hubspot", recordId: "123", url: "http://app.hubspot.com/x" }) ?? "") && /record id/.test(validCrmLink({ platform: "hubspot", recordId: "<script>" }) ?? ""));

// ---- the MCP server, as Claude talks to it (stdio, JSON-RPC)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rfp-mcp-"));
process.env.RFP_STORE_DIR = TMP;
const soon = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
saveLedger(ROOT, { tenant: "all", findings: [
  { ...F, closeDate: soon(20), score: 70, band: "pursue", sourceText: "ERP implementation: general ledger, fund accounting, payroll.", workspace: { proofread: { verdict: "Clean", counts: { high: 0, medium: 0, low: 1 }, signedOff: { by: "RFP Manager", at: "2026-09-20" } } } },
  { id: "all-roof01", title: "Roof replacement", buyer: "Town of Example", closeDate: soon(10), status: "New", score: 40, band: "review", sourceText: "Remove and replace the roof." },
  { id: "all-old01", title: "Old ERP", buyer: "City of Past", closeDate: soon(-30), status: "New", score: 60, band: "pursue", sourceText: "" },
], runs: [], gaps: [] });
writeStore(ROOT, "profile.json", { name: "Harborline Systems", capabilities: [{ id: "erp", label: "ERP / Finance implementation", on: true }], keywords: ["fund accounting"], platforms: [], products: [], industries: [] });

const srv = spawn(process.execPath, [path.join(ROOT, "scripts", "mcp-server.mjs")], { env: { ...process.env, RFP_STORE_DIR: TMP }, stdio: ["pipe", "pipe", "pipe"] });
let buf = "", seq = 0;
const waiting = new Map();
srv.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { const m = JSON.parse(line); waiting.get(m.id)?.(m); } } });
const rpc = (method, params) => new Promise((res, rej) => { const id = ++seq; const t = setTimeout(() => rej(new Error(`${method} timed out`)), 15000); waiting.set(id, (m) => { clearTimeout(t); res(m); }); srv.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
const tool = async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args }); return { error: r.result?.isError || !!r.error, text: r.result?.content?.[0]?.text ?? r.error?.message ?? "" }; };
try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  srv.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  a("mcp: server starts and names itself", init.result?.serverInfo?.name === "rfp-sweeper" && /confirmation/.test(init.result?.instructions ?? ""));
  const tools = (await rpc("tools/list", {})).result.tools;
  a("mcp: the six tools", tools.map((t) => t.name).sort().join() === "get_company_profile,get_opportunity,link_crm_opportunity,list_opportunities,prepare_crm_opportunity,unlink_crm_opportunity");
  a("mcp: read tools are marked read-only", tools.filter((t) => /^(list|get|prepare)/.test(t.name)).every((t) => t.annotations?.readOnlyHint === true));
  const list = JSON.parse((await tool("list_opportunities", { status: "active" })).text);
  a("mcp: active opportunities, best offering fit first", list.opportunities.length === 2 && list.opportunities[0].id === "all-abc123" && /Harborline/.test(list.fitBasis));
  a("mcp: minFit filters", JSON.parse((await tool("list_opportunities", { minFit: 60 })).text).opportunities.every((o) => o.fit >= 60));
  a("mcp: past due listed separately", JSON.parse((await tool("list_opportunities", { status: "pastdue" })).text).opportunities.map((o) => o.id).join() === "all-old01");
  const one = JSON.parse((await tool("get_opportunity", { id: "all-abc123" })).text);
  a("mcp: one opportunity with key facts, proofreading and submission status", one.keyFacts.questionsDeadline === "2099-09-30" && one.keyFacts.contractTerm === "5 years" && one.proofread.verdict === "Clean" && one.submissionStatus === "not checked");
  a("mcp: unknown id is an error, not a crash", (await tool("get_opportunity", { id: "all-nope" })).error);
  const prep = JSON.parse((await tool("prepare_crm_opportunity", { id: "all-abc123", platform: "salesforce" })).text);
  a("mcp: Salesforce fields prepared, not created", prep.object === "Opportunity" && prep.fields.Name.startsWith("RFP: ") && prep.alreadyLinked === null);
  a("mcp: a link on the wrong domain is refused", (await tool("link_crm_opportunity", { id: "all-abc123", platform: "salesforce", recordId: "006AAA", url: "https://evil.example/x" })).error);
  const linked = await tool("link_crm_opportunity", { id: "all-abc123", platform: "salesforce", recordId: "006Hs00001AbCdEIAV", url: "https://acme.lightning.force.com/lightning/r/Opportunity/006Hs00001AbCdEIAV/view" });
  a("mcp: link recorded in store/crm.json", !linked.error && readStore(ROOT, "crm.json").links["all-abc123"].recordId === "006Hs00001AbCdEIAV");
  a("mcp: the ledger is untouched and stays publishable", findBlocked(JSON.parse(fs.readFileSync(path.join(TMP, "all.json"), "utf8")), "ledger").length === 0);
  a("mcp: the list shows the link", JSON.parse((await tool("list_opportunities", {})).text).opportunities.find((o) => o.id === "all-abc123").crm?.recordId === "006Hs00001AbCdEIAV");
  a("mcp: unlink forgets it", /Removed/.test((await tool("unlink_crm_opportunity", { id: "all-abc123" })).text) && !readStore(ROOT, "crm.json").links["all-abc123"]);
  a("mcp: company profile", JSON.parse((await tool("get_company_profile")).text).name === "Harborline Systems");
} finally {
  srv.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nall ${passes} configuration assertions passed`);
process.exit(fails ? 1 : 0);
