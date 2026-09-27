#!/usr/bin/env node
/**
 * Tests for configuration: the internal host's access list and what it lets people do,
 * the sales-platform opportunity fields, and the MCP server (spoken to over stdio, as
 * Claude would). Uses a temporary store; nothing real is touched. The host itself
 * (sign-in, the schedule, the server's answers) is tested in test-hosting.mjs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { validateAccess, accessFor, accessChanges, ACCESS_ROLES } from "../lib/access.mjs";
import { crmPayload, validCrmLink, CRM_PLATFORMS } from "../lib/crm.mjs";
import { saveLedger, writeStore, readStore } from "../lib/ledger.mjs";
import { ROOT } from "../lib/config.mjs";
import { findBlocked } from "../lib/guard.mjs";

let fails = 0, passes = 0;
const a = (name, cond) => { if (cond) passes++; else { fails++; console.log(`FAIL: ${name}`); } };

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
// what the list lets a signed-in email do
a("access: a listed email gets its role", JSON.stringify(accessFor({ users: v.users, email: "ANA@example.org" })) === JSON.stringify({ email: "ana@example.org", role: "Account Executive", admin: false, source: "list" }));
a("access: the admin flag makes an admin", accessFor({ users: v.users, email: "sam@example.org" }).admin === true);
a("access: anyone else gets nothing", accessFor({ users: v.users, email: "stranger@example.org" }) === null && accessFor({ users: v.users, email: "" }) === null && accessFor({ users: v.users, email: "not an email" }) === null);
a("access: RFP_ADMINS always get in, as admin and RFP Manager", JSON.stringify(accessFor({ users: [], admins: ["boss@example.org"], email: "Boss@Example.org" })) === JSON.stringify({ email: "boss@example.org", role: "RFP Manager", admin: true, source: "RFP_ADMINS" }));
a("access: a listed RFP_ADMINS email keeps its listed role and is an admin", (() => { const x = accessFor({ users: v.users, admins: ["ana@example.org"], email: "ana@example.org" }); return x.role === "Account Executive" && x.admin && x.source === "list and RFP_ADMINS"; })());
const ch = accessChanges([{ email: "a@x.org", role: "RFP Manager", admin: true }, { email: "b@x.org", role: "SME Contributor", admin: false }], [{ email: "a@x.org", role: "Account Executive", admin: false }, { email: "c@x.org", role: "Pre-sales Consultant", admin: false }]);
a("access: changes described for the activity log", ch.join(" | ") === "a@x.org: RFP Manager → Account Executive | a@x.org: no longer an admin | added c@x.org (Pre-sales Consultant) | removed b@x.org");
a("access: no change, nothing logged", accessChanges(v.users, v.users).length === 0);

// ---- sales-platform fields
const F = { id: "all-abc123", title: "Enterprise Resource Planning System", buyer: "Example Housing Corporation", closeDate: "2026-10-16", status: "Pursuing", url: "https://kyhousing.bonfirehub.com/opportunities/1", estimatedValue: null,
  keyDates: {}, rfp: { keyData: { dates: { questions: "2099-09-30" }, contractTerm: "5 years", renewals: "4 option years", evaluation: [{ criterion: "Technical approach", weight: 60, unit: "%" }, { criterion: "Price", weight: 40, unit: "%" }], evaluationBasis: "Best value (trade-off)" } } };
const sf = crmPayload(F, "salesforce", { profile: { name: "Harborline Systems" } });
a("crm: Salesforce Opportunity fields", sf.object === "Opportunity" && sf.fields.Name === "RFP: Enterprise Resource Planning System" && sf.fields.CloseDate === "2026-10-16" && sf.fields.StageName === "Qualification" && sf.fields.LeadSource === "RFP");
a("crm: the description carries the key facts and the source", /Questions due: 2099-09-30/.test(sf.fields.Description) && /Contract term: 5 years \(4 option years\)/.test(sf.fields.Description) && /Technical approach 60%/.test(sf.fields.Description) && /bonfirehub/.test(sf.fields.Description) && /RFP Sweep and Drafter id: all-abc123/.test(sf.fields.Description));
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
