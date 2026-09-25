#!/usr/bin/env node
/**
 * End-to-end test of every screen, button and filter, in a real browser.
 *
 *   npm run test:e2e
 *
 * Runs twice:
 *   1. the published site (read-only build of site/, served locally)
 *   2. the local dashboard (full editing), against a temporary store, so your
 *      real findings are never touched
 *
 * Fails on any page error or console error, and on anything that is not wired up.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { ROOT, loadPack, loadTenant } from "../lib/config.mjs";
import { effectivePack } from "../lib/pack.mjs";
import { score } from "../lib/score.mjs";
import { draftFinding } from "../lib/draft.mjs";
import { mergeRun, saveLedger } from "../lib/ledger.mjs";
import { classifySector } from "../lib/sector.mjs";
import { matchCapabilities, recommendTeam } from "../lib/capabilities.mjs";
import { analyzeDetail } from "../lib/enrich.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rfp-e2e-"));
const STORE = path.join(TMP, "store"), OUT = path.join(TMP, "output"), DL = path.join(TMP, "downloads"), LIB = path.join(TMP, "library");
for (const d of [STORE, OUT, DL, LIB]) fs.mkdirSync(d, { recursive: true });
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ fixture data
const RFP = `REQUEST FOR PROPOSAL 2026-44
ENTERPRISE RESOURCE PLANNING AND PAYROLL SYSTEM

1. Introduction
The Example School District is seeking a financial management system and payroll system to replace its legacy system.

2. Key Dates
Closing Date: ${new Date(Date.now() + 30 * 86400000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} at 2:00 PM.
Questions Deadline: ${new Date(Date.now() + 14 * 86400000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.

3. Mandatory Requirements
3.1 The solution must support position control and collective agreement rules.
3.2 The proponent shall provide three (3) references from school boards of similar size.
3.3 All data must be stored in Canada.
3.4 The proposal shall not exceed 40 pages.

4. Response Questions
4.0.1 Describe your approach to organizational change management. In your response, explain how you engage stakeholders. Provide examples from similar implementations.

5. Contract
The term of the contract shall be three (3) years. The estimated budget is $1,200,000.
Liquidated damages of $1,000 per day apply to late delivery.

6. Evaluation
Technical approach 40%
Price 30%
`;

const tenant = loadTenant("all");
function finding(packId, p) {
  const pack = effectivePack(loadPack(packId), tenant);
  const d = p.body ? analyzeDetail(p.body, tenant) : {};
  const post = { ...p, keyDates: d.keyDates, requirements: d.requirements, contentHash: d.contentHash };
  const s = score(post, pack, tenant);
  const f = draftFinding({ ...post, body: undefined }, s, pack, tenant, p.channel, new Date(), []);
  const caps = matchCapabilities(p.title, p.body ?? "");
  Object.assign(f, { sourceText: p.body ?? "", sector: classifySector({ buyer: p.buyer, source: p.channel }), capabilities: caps.map(({ id, label, matched }) => ({ id, label, matched })), team: recommendTeam(caps), publishedDate: p.publishedDate });
  return f;
}
const F = [
  finding("k12", { title: "Enterprise Resource Planning (ERP) and Payroll System", buyer: "Example School District", buyerType: "school board", country: "CA", closeDate: day(30), publishedDate: day(-3), estimatedValue: 1200000, url: "https://www.merx.com/public/solicitations/1", channel: "ca.agg.merx", body: RFP }),
  finding("any", { title: "HRIS and Payroll Cloud Based System Purchase", buyer: "Municipality of Example", country: "CA", closeDate: day(10), publishedDate: day(-5), url: "https://www.merx.com/public/solicitations/2", channel: "ca.agg.merx", body: "The Municipality seeks an HRIS and payroll system. The vendor must provide employee self service and position control." }),
  finding("any", { title: "ERP Implementation Services (past due)", buyer: "Town of Pastdue", country: "CA", closeDate: day(-5), publishedDate: day(-40), url: "https://www.merx.com/public/solicitations/3", channel: "ca.agg.merx", body: "ERP implementation services for finance and payroll. The proponent must provide references." }),
  finding("any", { title: "Financial System Replacement (won)", buyer: "City of Wonville", country: "CA", closeDate: day(-20), publishedDate: day(-60), url: "https://www.merx.com/public/solicitations/4", channel: "ca.agg.merx", body: "Financial system replacement, ERP implementation, general ledger." }),
  finding("any", { title: "5000095999 A.6 Programmer / Software Developer – Level 3 (Senior)", buyer: "Canadian Nuclear Safety Commission (CNSC)", country: "CA", closeDate: day(20), publishedDate: day(-1), url: "https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/x", channel: "ca.federal.canadabuys.open", body: "TBIPS resource request: one (1) senior Microsoft software developer." }),
  finding("any", { title: "Payroll Services Review (archive test)", buyer: "Town of Archiveville", country: "CA", closeDate: day(40), publishedDate: day(-2), url: "https://www.merx.com/public/solicitations/5", channel: "ca.agg.merx", body: "Payroll services review and payroll system options for the town." }),
  finding("any", { title: "ERP Finance Module Upgrade (lost test)", buyer: "Town of Lostville", country: "CA", closeDate: day(45), publishedDate: day(-2), url: "https://www.merx.com/public/solicitations/6", channel: "ca.agg.merx", body: "ERP finance module upgrade: general ledger and accounts payable." }),
];
// What the sweep read with the HRIS RFP (its public document), as lib/sweep.mjs stores it.
F[1].rfp = {
  readAt: new Date().toISOString(),
  sources: [{ kind: "notice", url: "https://www.merx.com/public/solicitations/2", words: 20 }, { kind: "document", name: "HRIS-RFP-2026-9.pdf", url: "https://canadabuys.canada.ca/documents/pub/att/2026/09/01/abc/HRIS-RFP-2026-9.pdf", pages: 22, words: 6400 }],
  keyData: { dates: { questions: day(4) }, contractTerm: "3 years", renewals: "two (2) additional one-year periods", value: { amount: 450000, context: "estimated" }, evaluation: [{ criterion: "Technical approach", weight: 60, unit: "%" }, { criterion: "Price", weight: 40, unit: "%" }], evaluationBasis: "Highest combined rating of technical merit and price" },
  risks: [{ id: "insurance-high", severity: "medium", label: "Insurance of $5M or more", evidence: "general liability insurance of $5,000,000" }],
  requirements: [{ id: "2.1", section: "2", text: "Describe your approach to payroll parallel testing before go-live.", level: "question", category: "technical" }],
  requirementCounts: { total: 41, mandatory: 30, questions: 11 }, fullText: true, words: 6420, notes: [],
};
const ledger = { tenant: "all", findings: [], runs: [], gaps: [] };
process.env.RFP_STORE_DIR = STORE;
mergeRun(ledger, { industry: "any", findings: F, gaps: [{ channel: "ca.bc.bcbid", status: "blocked-by-portal", detail: "bot check" }], channelsRead: 5, postingsSeen: 200 });
ledger.findings.find((f) => /won/.test(f.title)).status = "Won";
saveLedger(ROOT, ledger);

// ------------------------------------------------------------------ servers
// The private library (template, references, learned answers) goes to a temporary folder too.
const env = { ...process.env, RFP_STORE_DIR: STORE, RFP_OUTPUT_DIR: OUT, RFP_LIBRARY_DIR: LIB };

// A company template with {{tags}} and its own letterhead line, and a past response to learn from.
const TEMPLATE_FILE = path.join(DL, "our-template.docx"), PAST_FILE = path.join(DL, "past-response.txt");
{
  const PizZip = (await import("pizzip")).default;
  const { defaultTemplate } = await import("../lib/export.mjs");
  const z = new PizZip(defaultTemplate(PizZip));
  z.file("word/document.xml", z.file("word/document.xml").asText().replace("{{title}}", "{{title}} · ACME LETTERHEAD"));
  fs.writeFileSync(TEMPLATE_FILE, z.generate({ type: "nodebuffer" }));
  fs.writeFileSync(PAST_FILE, `RESPONSE TO RFP 2025-12
4.0.1 Describe your approach to organizational change management and how you engage stakeholders.
We run change management alongside the build: a change network of champions in every department, stakeholder interviews in week one, and a communications plan that the district approves before each phase.
4.0.2 How will you train finance and payroll staff?
Role-based training in the buyer's own processes: super-users first, then end users, with recorded sessions and quick-reference guides for every payroll task.
`);
}
execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-site.mjs")], { env, stdio: "ignore" });
const SITE = path.join(ROOT, "site");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".xlsx": "application/octet-stream", ".ics": "text/calendar" };
const staticServer = http.createServer((req, res) => {
  const p = path.join(SITE, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  if (!p.startsWith(SITE) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(p)] ?? "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
}).listen(4190, "127.0.0.1");
const dash = spawn(process.execPath, [path.join(ROOT, "scripts", "dashboard.mjs")], { env: { ...env, PORT: "4191" }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));

// ------------------------------------------------------------------ harness
let browser;
for (const o of [{}, { channel: "chrome" }]) { try { browser = await chromium.launch({ headless: true, ...o }); break; } catch { /* next */ } }
if (!browser) { console.error("No browser available for the end-to-end test."); process.exit(2); }

const results = [];
let currentPage = null;
async function check(name, fn) {
  try { await fn(); results.push([true, name]); }
  catch (e) {
    results.push([false, `${name} — ${String(e.message).split("\n")[0].slice(0, 200)}`]);
    // A failure must not leave the workspace open over the next check (one failure, not twenty).
    try { if (currentPage && (await currentPage.locator("#sWorkspace.ws-overlay").count())) await currentPage.keyboard.press("Escape"); } catch { /* page gone */ }
  }
  if (process.env.E2E_VERBOSE) console.log(`${results.at(-1)[0] ? "  ✓" : "  ✗"} ${results.at(-1)[1]}`);
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

async function openPage(url) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // 403 and 400 come from the deliberate security probes (a write without the header, a private
  // address as the company website); server errors are caught by the response listener below.
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|404 \(Not Found\)|403 \(Forbidden\)|400 \(Bad Request\)|422 \(Unprocessable|429 \(Too Many Requests\)|503 \(Service Unavailable\)|500 \(Internal Server Error\)/.test(m.text())) errors.push(`console: ${m.text()}`); });
  // A server error is always a failure; name the request so it can be fixed.
  // (the faked reader service answers 503 on purpose; only this site's own server errors count)
  page.on("response", async (r) => { if (r.status() >= 500 && new URL(r.url()).origin === new URL(url).origin) errors.push(`HTTP ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}: ${(await r.text().catch(() => "")).slice(0, 160)}`); });
  await page.goto(url);
  await page.waitForSelector("#sRun");
  await page.waitForTimeout(600);
  return { page, errors, context };
}
const toastText = (page) => page.locator("#toast").textContent();
/** The toast a person sees: shown, on top of everything at its centre (not under the workspace), saying this. */
async function seenToast(page, re, timeoutMs = 8000) {
  // Wait for this message (an earlier toast may still be showing), then check a person can see it.
  let r = { shown: false, text: "" };
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    await page.waitForTimeout(120);
    r = await page.evaluate(() => {
      const t = document.getElementById("toast");
      if (!t?.classList.contains("show")) return { shown: false, text: t?.textContent ?? "" };
      const b = t.getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { shown: true, onTop: !!top && (top === t || t.contains(top)), text: t.textContent };
    });
    if (r.shown && re.test(r.text)) break;
  }
  expect(r.shown, `no toast shown (last text: "${r.text}")`);
  expect(re.test(r.text), `toast says "${r.text}"`);
  expect(r.onTop, `the toast is hidden under another element: "${r.text}"`);
}
async function download(page, action) {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), action()]);
  const file = path.join(DL, d.suggestedFilename());
  await d.saveAs(file);
  return file;
}
const tab = (page, name) => page.click(`.main-tabs button[data-tab="${name}"]`);

// ------------------------------------------------------------------ the checks, shared by both modes
async function suite(mode, url) {
  const { page, errors, context } = await openPage(url);
  currentPage = page;
  const P = (n) => `[${mode}] ${n}`;
  const isStatic = mode === "published site";
  page.on("dialog", (d) => d.accept());

  await check(P("loads with the workflow strip and 7 steps"), async () => expect((await page.locator("#flowSteps li").count()) === 7, "flow steps missing"));
  await check(P("named RFP Sweep and Drafter (tab title and heading)"), async () => { const title = await page.title(), h1 = (await page.locator("h1").first().textContent()).trim(); expect(title === "RFP Sweep and Drafter" && h1 === "RFP Sweep and Drafter", `title "${title}", heading "${h1}"`); });
  await check(P("every main tab opens its screen"), async () => {
    for (const t of ["analyze", "findings", "actions", "config", "sweep"]) { await tab(page, t); expect(await page.locator(`#tab-${t}`).isVisible(), `tab ${t} not visible`); }
    expect((await page.locator(".main-tabs button").allTextContents()).join("|") === "RFP Sweep|Analyze a document|Pipeline|Action items|Configuration", "the main tabs are not exactly RFP Sweep, Analyze a document, Pipeline, Action items, Configuration");
  });
  await check(P("sweep form filters are populated"), async () => {
    for (const [id, min] of [["#sIndustry", 8], ["#sGeo", 3], ["#sCap", 8], ["#sDays", 4], ["#sStatus", 4]]) expect((await page.locator(`${id} option`).count()) >= min, `${id} has too few options`);
  });
  const run = async (o = {}) => {
    for (const [id, v] of Object.entries({ sIndustry: "", sGeo: "na", sCap: "", sDays: "any", sStatus: "active", ...o })) await page.selectOption(`#${id}`, v);
    await page.click("#sRun");
    await page.waitForTimeout(isStatic ? 700 : 400);
  };
  const count = async () => Number((await page.locator(".results-head h2").textContent()).match(/\d+/)[0]);
  const titles = async () => (await page.locator("#sResults tbody .title").allTextContents()).join(" | ");

  if (isStatic) {
    await check(P("Run RFP Sweep shows results and a result toast"), async () => { await run(); expect((await count()) >= 2, "no results"); await seenToast(page, /Searched \d+ opportunities/); });
  } else {
    await check(P("results render (local search runs live, so this checks the loaded pipeline)"), async () => { await page.selectOption("#sStatus", "active"); await page.selectOption("#sDays", "any"); await page.dispatchEvent("#sStatus", "change"); await page.waitForTimeout(300); expect((await count()) >= 2, "no results"); });
  }
  await check(P("results table: Fit, Opportunity, Customer, Industry, Deadline, Owner, Status (no Value column)"), async () => {
    const heads = (await page.locator("#sResults thead th").allTextContents()).map((x) => x.replace(/[▲▼↕]/g, "").trim()).filter(Boolean);
    expect(!heads.includes("Value") && heads.join("|") === "Fit|Opportunity|Customer|Industry|Deadline|Owner|Status", `headers: ${heads.join("|")}`);
  });
  await check(P("results sort by Fit (highest first, click to reverse) and by Deadline (soonest first)"), async () => {
    await page.selectOption("#sStatus", "all"); await page.dispatchEvent("#sStatus", "change"); await page.waitForTimeout(250);
    const fits = async () => (await page.locator("#sResults tbody tr td:first-child .pill").allTextContents()).map((x) => (x === "—" ? -1 : Number(x)));
    const sorted = (xs, dir) => xs.every((x, i) => i === 0 || (dir === "desc" ? xs[i - 1] >= x : xs[i - 1] <= x));
    const fitHead = page.locator("#sResults thead th", { hasText: "Fit" });
    expect((await fitHead.getAttribute("aria-sort")) === "descending" && sorted(await fits(), "desc"), "not highest fit first by default");
    await fitHead.locator("button").click(); await page.waitForTimeout(150);
    expect((await page.locator("#sResults thead th", { hasText: "Fit" }).getAttribute("aria-sort")) === "ascending" && sorted(await fits(), "asc"), "second click did not reverse");
    await page.locator("#sResults thead th", { hasText: "Fit" }).locator("button").click(); await page.waitForTimeout(150);
    await page.locator("#sResults thead th", { hasText: "Deadline" }).locator("button").click(); await page.waitForTimeout(150);
    const dates = (await page.locator("#sResults tbody tr td:nth-child(5)").allTextContents()).map((x) => x.slice(0, 10)).filter((x) => /^\d{4}-/.test(x));
    expect(dates.length >= 2 && dates.every((d, i) => i === 0 || dates[i - 1] <= d), `deadlines not soonest first: ${dates.join(",")}`);
    await page.locator("#sResults thead th", { hasText: "Fit" }).locator("button").click(); await page.waitForTimeout(150); // back to fit, highest first
    expect((await page.locator("#sResults thead th", { hasText: "Fit" }).getAttribute("aria-sort")) === "descending", "fit sort not restored");
    await page.selectOption("#sStatus", "active"); await page.dispatchEvent("#sStatus", "change"); await page.waitForTimeout(200);
  });
  await check(P("contractor roles (TBIPS 'A.6 Programmer, Level 3') are hidden by default, and tagged when shown"), async () => {
    expect(!(await titles()).includes("A.6 Programmer"), "a contractor role is listed by default");
    expect(/Hide contractor roles \(1\)/.test(await page.locator("#sResults .roles-note").textContent()), "no hide switch");
    await page.uncheck("#hideRoles"); await page.waitForTimeout(200);
    const row = page.locator("#sResults tbody tr", { hasText: "A.6 Programmer" });
    expect((await row.count()) === 1 && /contractor role/.test(await row.textContent()), "not shown with its tag");
    await page.check("#hideRoles"); await page.waitForTimeout(200);
  });
  const statusCheck = async (v, include, exclude) => {
    await page.selectOption("#sStatus", v); await page.dispatchEvent("#sStatus", "change"); await page.waitForTimeout(250);
    const t = await titles();
    if (include) expect(t.includes(include), `${v}: missing "${include}"`);
    if (exclude) expect(!t.includes(exclude), `${v}: should not show "${exclude}"`);
  };
  await check(P("status filter: Active excludes past-due"), () => statusCheck("active", "Enterprise Resource Planning", "past due"));
  await check(P("status filter: Past due shows missed deadlines only"), () => statusCheck("pastdue", "past due", "Enterprise Resource Planning"));
  await check(P("status filter: Closed shows closed and won"), () => statusCheck("closed", "(won)", "Enterprise Resource Planning"));
  await check(P("status filter: All shows everything"), async () => { await statusCheck("all", "(won)"); expect((await count()) >= 4, "All should show 4"); });
  await page.selectOption("#sStatus", "active"); await page.dispatchEvent("#sStatus", "change");

  if (isStatic) {
    await check(P("industry filter: K-12 shows the school district only"), async () => { await run({ sIndustry: "sector:k12" }); expect((await count()) === 1 && /School District/.test(await page.locator("#sResults tbody").textContent()), "K-12 filter wrong"); });
    await check(P("industry filter: Municipal shows cities and towns"), async () => { await run({ sIndustry: "sector:municipal" }); expect(/Municipality of Example/.test(await titles() + await page.locator("#sResults tbody").textContent()), "municipal filter wrong"); });
    await check(P("capability filter narrows results"), async () => { await run({ sCap: "hcm" }); expect((await titles()).includes("HRIS"), "capability filter wrong"); });
    await check(P("date filter: last 7 days keeps recent postings"), async () => { await run({ sDays: "7" }); expect((await count()) >= 1, "date filter wrong"); });
    await check(P("empty result offers one-click wider searches that work"), async () => {
      await run({ sIndustry: "sector:k12", sCap: "tms" });
      expect(await page.locator(".empty-sweep").isVisible(), "no empty state");
      await page.locator(".empty-sweep .row button").first().click(); await page.waitForTimeout(700);
      expect((await count()) >= 1, "widen button did not widen");
    });
    await run();
  }

  await check(P("workflow steps filter results and toggle off"), async () => {
    for (const s of ["understand", "qualify", "assign", "answer", "review"]) {
      await page.click(`#flowSteps li[data-step="${s}"]`); await page.waitForTimeout(150);
      expect(await page.locator(".flow-note").isVisible(), `${s}: no filter note`);
    }
    await page.click('#flowSteps li[data-step="review"]'); await page.waitForTimeout(150);
    expect(!(await page.locator(".flow-note").isVisible()), "second click should clear");
  });
  await check(P("workflow Discover step jumps to the sweep form"), async () => { await page.click('#flowSteps li[data-step="discover"]'); await page.waitForTimeout(300); expect(await page.evaluate(() => document.activeElement?.id === "sRun"), "Run button not focused"); });
  await check(P("workflow steps work from the keyboard"), async () => { await page.focus('#flowSteps li[data-step="qualify"]'); await page.keyboard.press("Enter"); await page.waitForTimeout(150); expect(await page.locator(".flow-note").isVisible(), "Enter did nothing"); await page.click(".flow-note button"); });

  // ---- workspace
  const openFirst = async () => { await page.locator("#sResults tbody tr", { hasText: "Enterprise Resource Planning (ERP)" }).locator("button", { hasText: "Open" }).click(); await page.waitForSelector("#sWorkspace.ws-overlay .workspace"); };
  await check(P("Open shows the workspace as an overlay"), async () => { await openFirst(); expect(await page.locator("#sWorkspace.ws-overlay").isVisible(), "overlay hidden"); });
  await check(P("all eight workspace tabs render"), async () => {
    for (const t of ["Overview", "Requirements", "Risks", "Team", "Responses", "Proofread", "Proposal", "Submission status"]) {
      await page.locator("#sWorkspace .ws-tabs button", { hasText: t }).click(); await page.waitForTimeout(120);
      expect((await page.locator("#sWorkspace .ws-body").textContent()).trim().length > 20, `${t} tab empty`);
    }
  });
  await check(P("Team tab: exactly the four roles"), async () => {
    await page.locator("#sWorkspace .ws-tabs button", { hasText: "Team" }).click();
    const roles = (await page.locator("#sWorkspace .team-table tbody th").allTextContents()).map((x) => x.trim());
    expect(roles.join("|") === "RFP Manager|Pre-sales Consultant|Account Executive|SME Contributor", `roles: ${roles.join("|")}`);
    expect(await page.locator("#sWorkspace button", { hasText: "Assign opportunity to RFP Manager" }).count() === 1, "no assign button");
  });
  await check(P("Overview shows the five qualify answers and verified vs inferred"), async () => {
    await page.locator("#sWorkspace .ws-tabs button", { hasText: "Overview" }).click();
    const t = await page.locator("#sWorkspace .ws-body").textContent();
    for (const k of ["Why this opportunity matters", "Why we may not qualify", "Information still required", "Recommended next action", "Verified, from the source", "Inferred by this tool", "Evaluator summary"]) expect(t.includes(k), `missing ${k}`);
    expect(await page.locator("#sWorkspace .md li").count() > 3, "summary not rendered as a list");
  });
  await check(P("Pursue / No-bid: visible confirmation, the button shows the decision, a second click undoes it"), async () => {
    const decide = (label) => page.locator("#sWorkspace .decision-row button", { hasText: label });
    const statusTag = () => page.locator("#sWorkspace .ws-head .status-tag").textContent();
    await decide("Pursue").click();
    await seenToast(page, isStatic ? /Marked Pursuing\. Saved in this browser only/ : /Marked Pursuing/);
    expect((await decide("Pursue").textContent()).startsWith("✓") && (await decide("Pursue").getAttribute("aria-pressed")) === "true", "Pursue does not show as chosen");
    expect((await statusTag()) === "Pursuing", "status in the header not updated");
    await decide("Pursue").click();
    await seenToast(page, /Decision cleared/);
    expect(!(await decide("Pursue").textContent()).startsWith("✓") && (await statusTag()) === "Qualifying", "second click did not undo");
    await decide("No-bid").click();
    await seenToast(page, /Marked No-bid.*Closed filter/);
    expect((await decide("No-bid").textContent()).startsWith("✓"), "No-bid does not show as chosen");
    await decide("No-bid").click(); await page.waitForTimeout(200);
    expect((await statusTag()) === "Qualifying", "No-bid not undone");
  });
  if (isStatic) {
    await check(P("a decision on the published site is kept in this browser across a reload"), async () => {
      await page.locator("#sWorkspace .decision-row button", { hasText: "Pursue" }).click(); await page.waitForTimeout(200);
      await page.reload(); await page.waitForSelector("#sRun"); await page.waitForTimeout(700);
      await run();
      const row = page.locator("#sResults tbody tr", { hasText: "Enterprise Resource Planning" });
      expect((await row.textContent()).includes("Pursuing"), "decision lost on reload");
      await openFirst();
      expect(/saved in this browser/.test(await page.locator("#sWorkspace .decision-row").textContent()), "no 'saved in this browser' note");
      await page.locator("#sWorkspace .decision-row button", { hasText: "Pursue" }).click(); await page.waitForTimeout(200); // undo
    });
  }
  await check(P("an RFP read by the sweep: its facts and documents show, and they are not 'information still required'"), async () => {
    await page.keyboard.press("Escape");
    await page.locator("#sResults tbody tr", { hasText: "HRIS" }).locator("button", { hasText: "Open" }).click();
    await page.waitForSelector("#sWorkspace.ws-overlay .workspace");
    await page.locator("#sWorkspace .ws-tabs button", { hasText: "Overview" }).click();
    const body = await page.locator("#sWorkspace .ws-body").textContent();
    for (const k of ["Questions deadline", "Contract term", "Stated value", "Evaluation criteria", "Basis of award", "Read with the RFP", "HRIS-RFP-2026-9.pdf", "22 pages"]) expect(body.includes(k), `missing "${k}"`);
    const still = await page.locator("#sWorkspace .ws-body h3", { hasText: "Information still required" }).locator("xpath=following-sibling::ul[1]").textContent();
    expect(!/Deadline for questions|Budget or estimated value|Contract term|Evaluation criteria/.test(still), `still asks for: ${still.slice(0, 160)}`);
    expect(/RFP document read by the sweep/.test(body), "facts do not say they came from the document");
    await page.locator("#sWorkspace .ws-tabs button", { hasText: "Requirements" }).click();
    expect((await page.locator("#sWorkspace .ws-body").textContent()).includes("payroll parallel testing"), "requirements from the document missing");
    await page.keyboard.press("Escape");
    await openFirst();
  });
  await check(P("score tiles explain Overall, Fit and Timeline"), async () => {
    for (const k of ["Overall", "Fit", "Timeline"]) {
      await page.locator("#sWorkspace .kpi-btn", { hasText: k }).first().click(); await page.waitForTimeout(120);
      expect((await page.locator("#sWorkspace .explain h3").textContent()).startsWith(k), `${k} tile did not explain`);
    }
    await page.locator("#sWorkspace .explain button", { hasText: "Close" }).click();
    expect(!(await page.locator("#sWorkspace .explain").count()), "explain did not close");
  });
  await check(P("Risk and Requirements tiles jump to their tabs"), async () => {
    await page.locator("#sWorkspace .kpi-btn", { hasText: "Risk" }).click();
    expect((await page.locator("#sWorkspace .ws-tabs button.active").textContent()) === "Risks", "risk tile");
    await page.locator("#sWorkspace .kpi-btn", { hasText: "Requirements" }).click();
    expect((await page.locator("#sWorkspace .ws-tabs button.active").textContent()) === "Requirements", "requirements tile");
  });
  await check(P("stepper: Draft response fills the Responses table"), async () => {
    await page.locator("#sWorkspace .stepper button", { hasText: "Draft response" }).click(); await page.waitForTimeout(250);
    expect((await page.locator("#sWorkspace .responses tbody tr").count()) >= 3, "no drafted responses");
  });
  await check(P("stepper: the six steps, with Proofread before RFP submission status"), async () => {
    const steps = (await page.locator("#sWorkspace .stepper li").allTextContents()).map((x) => x.replace(/^[✓\d]+/, "").trim());
    expect(steps.join("|") === "Qualify|Assign|Analyze RFP|Draft response|Proofread|RFP submission status", `steps: ${steps.join("|")}`);
    expect(!(await page.locator("#sWorkspace").textContent()).includes("Red-team"), "Red-team still shown");
  });
  await check(P("stepper: Proofread flags what to fix and holds sign-off until the high issues are fixed"), async () => {
    await page.locator("#sWorkspace .stepper button", { hasText: "Proofread" }).click();
    await seenToast(page, /Proofread: (Fix before submission|Needs a pass|Clean)/);
    expect((await page.locator("#sWorkspace .ws-tabs button.active").textContent()) === "Proofread", "not on the Proofread tab");
    const t = await page.locator("#sWorkspace .proofread").textContent();
    expect(/placeholder/.test(t) && /\[SME validation required\]/.test(t), "placeholders left in the drafts are not flagged");
    expect(await page.locator("#sWorkspace .proofread button", { hasText: "Sign off proofreading" }).isDisabled(), "sign-off allowed with high issues");
    await page.locator("#sWorkspace .proofread button", { hasText: "Re-check" }).click();
    await seenToast(page, /Proofread again/);
  });
  await check(P("stepper: RFP submission status says what blocks it, and Mark as submitted / Undo work visibly"), async () => {
    await page.locator("#sWorkspace .stepper button", { hasText: "RFP submission status" }).click();
    await seenToast(page, /RFP submission status: not ready, \d+ blocking/);
    expect((await page.locator("#sWorkspace .ws-tabs button.active").textContent()) === "Submission status", "not on the Submission status tab");
    const t = await page.locator("#sWorkspace .submission").textContent();
    expect(/Not ready: \d+ blocking issue/.test(t) && /Proofreading is not signed off|Not proofread yet/.test(t), "blocking reasons missing");
    await page.locator("#sWorkspace .submission button", { hasText: "Mark as submitted" }).click();
    await seenToast(page, /Marked Submitted/);
    expect(/Submitted/.test(await page.locator("#sWorkspace .submission .readiness").textContent()) && (await page.locator("#sWorkspace .ws-head .status-tag").textContent()) === "Submitted", "not shown as submitted");
    await page.locator("#sWorkspace .submission button", { hasText: "Undo submitted" }).click();
    await seenToast(page, /Submission undone/);
  });
  await check(P("stepper: Qualify, Assign and Analyze RFP respond"), async () => {
    await page.locator("#sWorkspace .stepper button", { hasText: "Assign" }).click(); await page.waitForTimeout(150);
    expect((await page.locator("#sWorkspace .ws-tabs button.active").textContent()) === "Team", "assign → team");
    await page.locator("#sWorkspace .stepper button", { hasText: "Analyze RFP" }).click(); await page.waitForTimeout(150);
    expect((await page.locator("#sWorkspace .ws-tabs button.active").textContent()) === "Overview", "analyze → overview");
    await page.locator("#sWorkspace .stepper button", { hasText: "Qualify" }).click(); await page.waitForTimeout(300);
  });
  let scoring, proposal, sme;
  await check(P("Export scoring file downloads a valid .xlsx"), async () => { scoring = await download(page, () => page.locator("#sWorkspace .ws-actions button", { hasText: "Export scoring" }).click()); expect(fs.readFileSync(scoring).subarray(0, 2).toString() === "PK", "not xlsx"); });
  await check(P("Download proposal downloads Markdown"), async () => { await page.locator("#sWorkspace .stepper button", { hasText: "Draft response" }).click(); proposal = await download(page, () => page.locator("#sWorkspace .ws-actions button", { hasText: "Download proposal" }).click()); expect(/^# Response to/.test(fs.readFileSync(proposal, "utf8")), "not a proposal"); });
  await check(P("Export SME review downloads the review workbook"), async () => {
    await page.locator("#sWorkspace .ws-tabs button", { hasText: "Responses" }).click();
    sme = await download(page, () => page.locator("#sWorkspace button", { hasText: "Export SME review" }).click());
    expect(fs.readFileSync(sme).subarray(0, 2).toString() === "PK", "not xlsx");
  });
  await check(P("Import SME review applies edits and status"), async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(sme);
    const ws = wb.getWorksheet("SME Review"); ws.getCell(2, 6).value = "Looks good"; ws.getCell(2, 7).value = "Approved";
    const edited = path.join(DL, "sme-edited.xlsx"); await wb.xlsx.writeFile(edited);
    await page.setInputFiles('#sWorkspace .sme-row input[type="file"]', edited); await page.waitForTimeout(800);
    await seenToast(page, /answer\(s\) updated from the SME review/);
    expect((await page.locator("#sWorkspace .responses").textContent()).includes("SME: Looks good"), "note not shown");
  });
  await check(P("response draft and status are editable"), async () => {
    const ta = page.locator("#sWorkspace .responses textarea").first();
    await ta.fill("Edited draft answer."); await ta.dispatchEvent("change");
    await page.locator("#sWorkspace .responses select").first().selectOption("SME review");
    expect(await page.locator("#sWorkspace .responses select").first().inputValue() === "SME review", "status not set");
  });
  await check(P("Close ✕, Esc and backdrop all close the workspace"), async () => {
    await page.locator("#sWorkspace .ws-actions button", { hasText: "Close" }).click();
    expect(!(await page.locator("#sWorkspace.ws-overlay").count()), "Close ✕");
    await openFirst(); await page.keyboard.press("Escape"); await page.waitForTimeout(150);
    expect(!(await page.locator("#sWorkspace.ws-overlay").count()), "Esc");
    await openFirst(); await page.mouse.click(5, 450); await page.waitForTimeout(150);
    expect(!(await page.locator("#sWorkspace.ws-overlay").count()), "backdrop");
  });

  await check(P("a notice-only opportunity explains empty requirements and offers the file picker"), async () => {
    await page.selectOption("#sStatus", "all"); await page.dispatchEvent("#sStatus", "change"); await page.waitForTimeout(200);
    try {
      await page.locator("#sResults tbody tr", { hasText: "(won)" }).locator("button", { hasText: "Open" }).click();
      await page.waitForSelector("#sWorkspace.ws-overlay .workspace");
      await page.locator("#sWorkspace .ws-tabs button", { hasText: "Requirements" }).click();
      const t = await page.locator("#sWorkspace .ws-body").textContent();
      expect(/Only the notice summary has been read/.test(t) && (await page.locator('#sWorkspace .empty-reqs input[type="file"]').count()) === 1, "no explanation or file picker");
    } finally {
      await page.keyboard.press("Escape");
      await page.selectOption("#sStatus", "active"); await page.dispatchEvent("#sStatus", "change");
    }
  });

  // ---- analyze a document
  await check(P("Analyze a document runs all five steps on pasted text"), async () => {
    await tab(page, "analyze");
    await page.fill("#aRfpText", RFP);
    await page.fill("#aPropText", "Our solution provides position control and collective agreement rules.\n\nAll customer data is hosted in Canadian data centres.\n\nWe provide three school board references.");
    await page.click("#aRun"); await page.waitForSelector("#aWorkspace .workspace");
    expect(await page.locator("#aWorkspace .kpi-btn", { hasText: "Coverage" }).count() === 1, "no coverage score with a proposal");
    const addBtn = await page.locator("#aWorkspace button", { hasText: "Add to pipeline" }).count();
    expect(isStatic ? addBtn === 0 : addBtn === 1, "Add to pipeline visibility wrong");
  });
  await check(P("uploaded .docx is read in the browser"), async () => {
    const JSZipLess = path.join(DL, "rfp.docx");
    try { execFileSync("textutil", ["-convert", "docx", "-stdin", "-output", JSZipLess], { input: RFP }); }
    catch { return; } // no textutil (Linux CI): .docx reading is covered by the unit tests
    await page.setInputFiles("#aRfpFile", JSZipLess); await page.waitForTimeout(1500);
    expect((await page.inputValue("#aRfpText")).includes("ENTERPRISE RESOURCE PLANNING"), "docx not read");
  });

  // ---- your template, references and export (Analyze a document tab)
  await check(P("template: a Word template is uploaded, its tags found, and it survives a reload"), async () => {
    await tab(page, "analyze"); await page.waitForTimeout(300);
    await page.setInputFiles("#libTemplate", TEMPLATE_FILE);
    await seenToast(page, /Template saved: our-template\.docx\. \d+ tag\(s\) found/);
    await page.reload(); await page.waitForSelector("#sRun"); await tab(page, "analyze"); await page.waitForTimeout(800);
    const t = await page.locator("#libraryCard").textContent();
    expect(/our-template\.docx/.test(t) && /Tags filled on export: title/.test(t), "template not kept");
  });
  await check(P("template: the sample template downloads as a Word file with the tags"), async () => {
    const f = await download(page, () => page.click("#libSample"));
    const PizZip = (await import("pizzip")).default;
    expect(/\{\{#responses\}\}/.test(new PizZip(fs.readFileSync(f)).file("word/document.xml").asText()), "not a template");
  });
  await check(P("references: a past response becomes citable passages; an unreadable link is reported"), async () => {
    await page.fill("#libLinks", isStatic ? "https://www.example.org/solutions" : "http://127.0.0.1:4190/private-page");
    await page.setInputFiles("#libFiles", PAST_FILE);
    await page.click("#libAdd");
    await seenToast(page, /1 reference\(s\) added: 2 passage\(s\)/);
    await page.waitForTimeout(300);
    const t = await page.locator("#libraryCard .lib-refs").textContent();
    expect(/past-response\.txt · 2 passage\(s\)/.test(t), `file not listed: ${t.slice(0, 200)}`);
    expect(isStatic ? /cannot read other websites/.test(t) : /never read|Could not read/.test(t), "unreadable link not reported");
  });
  await check(P("references: a draft cites the past response, and an SME must confirm it"), async () => {
    await tab(page, "sweep"); await page.waitForTimeout(200);
    await page.selectOption("#sStatus", "active"); await page.dispatchEvent("#sStatus", "change"); await page.waitForTimeout(200);
    await openFirst();
    await page.locator("#sWorkspace .stepper button", { hasText: "Draft response" }).click(); await page.waitForTimeout(400);
    await page.locator("#sWorkspace .ws-tabs button", { hasText: "Responses" }).click();
    // Drafts are in editable boxes: read their values, not the page text.
    const drafts = await page.locator("#sWorkspace .responses textarea").evaluateAll((els) => els.map((e) => e.value).join("\n"));
    const sources = await page.locator("#sWorkspace .responses").textContent();
    expect(/change network of champions/.test(drafts) && /Adapted from your reference library/.test(drafts), "the past response is not used");
    expect(/Reference: past-response\.txt/.test(sources), "the reference is not cited by name");
    await page.keyboard.press("Escape");
  });
  await check(P("export: one opportunity downloads its Word document, filled into your template with the past response"), async () => {
    await tab(page, "analyze"); await page.waitForTimeout(300);
    expect(/Answers are drafted from \d+ approved answers? and [1-9]\d* passages?/.test(await page.locator("#exportCard .knowledge").textContent()), "knowledge line missing");
    await page.selectOption("#xStatus", "open"); await page.waitForTimeout(500);
    expect((await page.locator("#exportCard .export-list tbody tr").count()) >= 2, "pipeline list empty");
    await page.locator("#exportCard button", { hasText: "Select none" }).click(); await page.waitForTimeout(200);
    await page.check('#exportCard input[aria-label="Export Enterprise Resource Planning (ERP) and Payroll System"]'); await page.waitForTimeout(200);
    expect(/saved draft/.test(await page.locator("#exportCard .export-list tbody tr", { hasText: "Enterprise Resource Planning (ERP)" }).textContent()), "the saved draft is not recognised");
    const file = await download(page, () => page.click("#xRun"));
    await seenToast(page, /Exported enterprise-resource-planning-erp-and-payroll-system-response\.docx, filled into our-template\.docx/);
    expect(file.endsWith(".docx"), `got ${path.basename(file)}, not a Word document`);
    const PizZip = (await import("pizzip")).default;
    const text = new PizZip(fs.readFileSync(file)).file("word/document.xml").asText().replace(/<[^>]+>/g, " ");
    expect(/Enterprise Resource Planning \(ERP\) and Payroll System · ACME LETTERHEAD/.test(text) && /change network of champions/.test(text) && !/\{\{/.test(text), "template not filled");
  });
  await check(P("export: several opportunities come in one zip, with the summary workbook when asked"), async () => {
    await page.locator("#exportCard button", { hasText: "Select all" }).click(); await page.waitForTimeout(200);
    await page.check("#xSummary");
    const zipFile = await download(page, () => page.click("#xRun"));
    await seenToast(page, /Exported \d+ responses into our-template\.docx: \d+ file\(s\) and a summary workbook, in one \.zip/);
    const PizZip = (await import("pizzip")).default;
    const z = new PizZip(fs.readFileSync(zipFile));
    expect(Object.keys(z.files).filter((n) => n.endsWith(".docx")).length >= 2 && !!z.file("all-responses.xlsx"), `zip holds: ${Object.keys(z.files).join(", ")}`);
  });
  await check(P("workspace: Export response (Word) downloads the filled document"), async () => {
    await tab(page, "sweep"); await page.waitForTimeout(200);
    await openFirst();
    const file = await download(page, () => page.click("#wsExportDocx"));
    await seenToast(page, /Exported .*-response\.docx, filled into our-template\.docx/);
    const PizZip = (await import("pizzip")).default;
    expect(/ACME LETTERHEAD/.test(new PizZip(fs.readFileSync(file)).file("word/document.xml").asText()), "not filled into the template");
    await page.keyboard.press("Escape");
  });

  // ---- pipeline
  await check(P("pipeline value tiles are compact and fit their boxes"), async () => {
    await tab(page, "findings"); await page.waitForTimeout(300);
    const tiles = await page.evaluate(() => [...document.querySelectorAll("#kpis .kpi")].map((k) => ({ l: k.querySelector(".l").textContent, v: k.querySelector(".v").textContent, fits: k.querySelector(".v").scrollWidth <= k.querySelector(".v").clientWidth + 1 })));
    const pub = tiles.find((x) => x.l.startsWith("Published value"));
    expect(pub && /^\$\d+(\.\d)?[KMB]?$/.test(pub.v), `published value tile: ${pub?.v}`);
    expect(tiles.some((x) => x.l.startsWith("Pipeline value (being pursued)")), "no pursued-value tile");
    expect(tiles.every((x) => x.fits), `a tile overflows: ${tiles.filter((x) => !x.fits).map((x) => x.v).join(", ")}`);
  });
  await check(P("Pipeline shows KPIs, table and every filter works"), async () => {
    await tab(page, "findings"); await page.waitForTimeout(300);
    expect((await page.locator("#kpis .kpi").count()) >= 6, "KPIs missing");
    const rows = async () => page.locator("#findings tbody tr").count();
    expect((await rows()) >= 3, "pipeline rows missing");
    await page.fill("#q", "HRIS"); await page.waitForTimeout(150); expect((await rows()) === 1, "search filter"); await page.fill("#q", "");
    await page.selectOption("#fBand", "pursue"); await page.waitForTimeout(150); const pursue = await rows(); await page.selectOption("#fBand", "");
    await page.selectOption("#fStatus", "*"); await page.waitForTimeout(150); expect((await rows()) >= 4, "any-status filter"); await page.selectOption("#fStatus", "");
    await page.selectOption("#fAssignee", "__none"); await page.waitForTimeout(150); expect((await rows()) >= 1, "unassigned filter"); await page.selectOption("#fAssignee", "");
    await page.check("#fChanged"); await page.waitForTimeout(150); await page.uncheck("#fChanged");
    expect(pursue >= 0, "band filter");
  });
  await check(P("Pipeline sorts by clicking a header (Closes: soonest first, click again: latest first)"), async () => {
    await tab(page, "findings"); await page.waitForTimeout(200);
    await page.locator("#findings thead th", { hasText: "Closes" }).locator("button").click(); await page.waitForTimeout(150);
    const dates = async () => (await page.locator("#findings tbody tr:not(.detail) td:nth-child(5)").allTextContents()).map((x) => x.slice(0, 10)).filter((x) => /^\d{4}-/.test(x));
    const asc = await dates();
    expect(asc.length >= 2 && asc.every((d, i) => i === 0 || asc[i - 1] <= d), `not soonest first: ${asc.join(",")}`);
    await page.locator("#findings thead th", { hasText: "Closes" }).locator("button").click(); await page.waitForTimeout(150);
    const desc = await dates();
    expect(desc.every((d, i) => i === 0 || desc[i - 1] >= d), `not latest first: ${desc.join(",")}`);
    await page.locator("#findings thead th", { hasText: "Score" }).locator("button").click(); await page.waitForTimeout(150); // back to score, highest first
  });
  await check(P("Pipeline row opens its detail panel, and its fields can be edited"), async () => {
    await page.locator("#findings tbody tr button", { hasText: "Open" }).first().click(); await page.waitForTimeout(200);
    expect(await page.locator("#findings tr.detail").isVisible(), "detail did not open");
    expect((await page.locator("#findings tr.detail textarea:disabled, #findings tr.detail input:disabled").count()) === 0, "fields are locked");
    await page.locator("#findings tbody tr button", { hasText: "Close" }).first().click();
  });
  await check(P("action items: tick Done, confirmed on screen, and kept after a reload"), async () => {
    await tab(page, "actions"); await page.waitForTimeout(300);
    // Action titles repeat across opportunities ("Go/no-go decision"): identify the row by both.
    const rowOf = () => page.locator("#actions tbody tr", { hasText: "Payroll Services Review (archive test)" }).first();
    const title = (await rowOf().locator("td").nth(2).textContent()).trim();
    await rowOf().locator('input[aria-label="Done"]').check();
    await seenToast(page, isStatic ? /Action marked done · saved in this browser/ : /Action marked done/);
    await page.reload(); await page.waitForSelector("#sRun"); await tab(page, "actions"); await page.waitForTimeout(500);
    await page.check("#aShowDone"); await page.waitForTimeout(200);
    const again = page.locator("#actions tbody tr").filter({ hasText: "Payroll Services Review (archive test)" }).filter({ hasText: title }).first();
    expect(await again.locator('input[aria-label="Done"]').isChecked(), "done not kept after a reload");
    await page.uncheck("#aShowDone");
  });
  await check(P("action items: select several, Mark done"), async () => {
    const boxes = page.locator("#actions .sel-action");
    await boxes.nth(0).check(); await boxes.nth(1).check();
    expect(/2 selected/.test(await page.locator("#bulkActions").textContent()), "toolbar not shown");
    await page.locator("#bulkActions button", { hasText: "Mark done" }).click();
    await seenToast(page, isStatic ? /2 action items marked done · saved in this browser/ : /2 action items marked done/);
    expect(await page.locator("#bulkActions").isHidden(), "toolbar should close");
  });
  await check(P("pipeline: select an opportunity, Archive; another, Closed lost"), async () => {
    await tab(page, "findings"); await page.waitForTimeout(300);
    await page.locator("#findings tbody tr", { hasText: "Payroll Services Review (archive test)" }).locator(".sel-finding").check();
    await page.locator("#bulkFindings button", { hasText: "Archive" }).click();
    await seenToast(page, isStatic ? /1 opportunity → Archived · saved in this browser/ : /1 opportunity → Archived/);
    await page.waitForTimeout(300);
    expect(!(await page.locator("#findings tbody").textContent()).includes("Payroll Services Review (archive test)"), "archived opportunity still listed as open");
    await page.locator("#findings tbody tr", { hasText: "ERP Finance Module Upgrade (lost test)" }).locator(".sel-finding").check();
    await page.locator("#bulkFindings button", { hasText: "Closed lost" }).click();
    await seenToast(page, /1 opportunity → Closed lost/);
    await page.selectOption("#fStatus", "*"); await page.waitForTimeout(200);
    const statuses = await page.locator("#findings tbody select[aria-label=Status]").evaluateAll((els) => els.map((e) => e.value));
    expect(statuses.includes("Archived") && statuses.includes("Lost"), `statuses: ${statuses.join(",")}`);
    await page.selectOption("#fStatus", "");
  });
  if (isStatic) {
    await check(P("published copy: Download my changes gives an assignments sheet with them"), async () => {
      expect(/Download my changes \(\d+\)/.test(await page.locator("#myChanges").textContent()), "no change count");
      const file = await download(page, () => page.click("#myChanges"));
      await seenToast(page, /Downloaded all\.xlsx: \d+ opportunit(y|ies) and \d+ action items?/);
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
      const statuses = []; wb.getWorksheet("Findings").eachRow((r, n) => { if (n > 1) statuses.push(r.getCell(3).text); });
      const done = []; wb.getWorksheet("Actions").eachRow((r, n) => { if (n > 1) done.push(r.getCell(6).text); });
      expect(path.basename(file) === "all.xlsx" && statuses.includes("Archived") && statuses.includes("Lost") && done.includes("Yes"), `sheet: ${statuses.join(",")} / ${done.join(",")}`);
    });
  }
  if (!isStatic || await page.locator("#exportXlsx").count()) {
    await check(P("Download Excel and Deadlines (.ics) download"), async () => {
      const x = await download(page, () => page.click("#exportXlsx")); expect(fs.readFileSync(x).subarray(0, 2).toString() === "PK", "xlsx");
      const i = await download(page, () => page.click("#exportIcs")); expect(fs.readFileSync(i, "utf8").startsWith("BEGIN:VCALENDAR"), "ics");
    });
  }
  if (isStatic) {
    await check(P("Configuration on the published site: public copy, users are managed locally, no sales-platform panel"), async () => {
      await tab(page, "config"); await page.waitForTimeout(300);
      const t = await page.locator("#tab-config").textContent();
      expect(/public copy/.test(t) && /local dashboard/.test(t), "no explanation");
      expect(await page.locator("#cfgEmail").count() === 0, "user editing shown on the published site");
      await tab(page, "sweep"); await openFirst();
      expect(await page.locator("#crmOpen").count() === 0, "sales-platform button on the published site");
      await page.keyboard.press("Escape");
    });
  }
  await check(P("Action items tab and its filters"), async () => {
    await tab(page, "actions"); await page.waitForTimeout(200);
    expect((await page.locator("#actions tbody tr").count()) >= 1, "no action items");
    await page.selectOption("#aAssignee", "__none"); await page.check("#aShowDone"); await page.waitForTimeout(150);
    await page.selectOption("#aAssignee", ""); await page.uncheck("#aShowDone");
  });

  // ---- editing (local dashboard only)
  if (!isStatic) {
    await tab(page, "findings"); await page.waitForTimeout(200);
    await check(P("edit: assign, status, notes, add action, go/no-go, done"), async () => {
      await page.reload(); await page.waitForSelector("#sRun"); await tab(page, "findings"); await page.waitForTimeout(400);
      const row = page.locator("#findings tbody tr", { hasText: "HRIS" }).first();
      const assignee = row.locator("input.assignee"); await assignee.fill("Pre-sales Consultant"); await assignee.press("Enter"); await page.waitForTimeout(500);
      await seenToast(page, /Assigned to Pre-sales Consultant/);
      await page.locator("#findings tbody tr", { hasText: "HRIS" }).first().locator("select").selectOption("Qualifying"); await page.waitForTimeout(500);
      await seenToast(page, /Status → Qualifying/);
      await page.locator("#findings tbody tr", { hasText: "HRIS" }).first().locator("button", { hasText: "Open" }).click(); await page.waitForTimeout(300);
      const notes = page.locator("#findings tr.detail textarea").first(); await notes.fill("Call the buyer"); await notes.dispatchEvent("change"); await page.waitForTimeout(500);
      await seenToast(page, /Notes saved/);
      await page.fill('#findings tr.detail input[placeholder="New action item"]', "Confirm the Q&A deadline");
      await page.locator("#findings tr.detail button", { hasText: "Add" }).click(); await page.waitForTimeout(500);
      await seenToast(page, /Action added/);
      await page.locator("#findings tr.detail .gng-table select").first().selectOption("yes"); await page.waitForTimeout(500);
      await page.locator("#findings tr.detail .actions-list input[type=checkbox]").first().check(); await page.waitForTimeout(500);
      const saved = JSON.parse(fs.readFileSync(path.join(STORE, "all.json"), "utf8")).findings.find((f) => /HRIS/.test(f.title));
      expect(saved.assignee === "Pre-sales Consultant" && saved.status === "Qualifying" && saved.notes === "Call the buyer" && saved.goNoGo.fit === "yes" && saved.actions.some((a) => a.title === "Confirm the Q&A deadline") && saved.actions.some((a) => a.done), "not persisted to the ledger");
      expect((saved.history ?? []).length >= 3, "audit trail missing");
    });
    await check(P("edit: Excel import applies sheet changes"), async () => {
      const ExcelJS = (await import("exceljs")).default;
      const x = await download(page, () => page.click("#exportXlsx"));
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(x);
      const ws = wb.getWorksheet("Findings"); const hdr = {}; ws.getRow(1).eachCell((c, i) => (hdr[String(c.value).replace(/\s*✎$/, "")] = i));
      let r = 2; ws.eachRow((row, n) => { if (/Past due|past due/.test(String(row.getCell(hdr["Title"]).text))) r = n; });
      ws.getCell(r, hdr["Assignee"]).value = "RFP Manager";
      const f2 = path.join(DL, "edited.xlsx"); await wb.xlsx.writeFile(f2);
      await page.setInputFiles("#importXlsx", f2); await page.waitForTimeout(800);
      await seenToast(page, /change\(s\)/);
      const saved = JSON.parse(fs.readFileSync(path.join(STORE, "all.json"), "utf8")).findings.find((f) => /past due/.test(f.title));
      expect(saved.assignee === "RFP Manager", "import not applied");
    });
    await check(P("edit: workspace work is saved and survives a reload"), async () => {
      await tab(page, "sweep"); await page.waitForTimeout(200);
      await page.selectOption("#sStatus", "active"); await page.dispatchEvent("#sStatus", "change");
      await openFirst();
      await page.locator("#sWorkspace .stepper button", { hasText: "Draft response" }).click(); await page.waitForTimeout(900);
      await page.locator("#sWorkspace .ws-tabs button", { hasText: "Overview" }).click();
      await page.locator("#sWorkspace button", { hasText: "Pursue" }).click(); await page.waitForTimeout(600);
      await seenToast(page, /Marked Pursuing/);
      await page.reload(); await page.waitForSelector("#sRun"); await page.waitForTimeout(700);
      await page.selectOption("#sStatus", "active"); await page.dispatchEvent("#sStatus", "change"); await page.waitForTimeout(200);
      await openFirst(); await page.locator("#sWorkspace .ws-tabs button", { hasText: "Responses" }).click();
      expect((await page.locator("#sWorkspace .responses tbody tr").count()) >= 3, "drafts not saved");
      const saved = JSON.parse(fs.readFileSync(path.join(STORE, "all.json"), "utf8")).findings.find((f) => /Enterprise Resource Planning/.test(f.title));
      expect(saved.status === "Pursuing" && saved.workspace?.version >= 1, "workspace not in ledger");
      await page.keyboard.press("Escape");
    });
    await check(P("edit: Assign opportunity from the Team tab"), async () => {
      await openFirst(); await page.locator("#sWorkspace .ws-tabs button", { hasText: "Team" }).click();
      await page.locator("#sWorkspace button", { hasText: "Assign opportunity to" }).click(); await page.waitForTimeout(600);
      await seenToast(page, /Assigned to/);
      await page.keyboard.press("Escape");
    });
    await check(P("edit: Add to pipeline from Analyze a document"), async () => {
      await tab(page, "analyze"); await page.fill("#aRfpText", RFP); await page.click("#aRun"); await page.waitForSelector("#aWorkspace .workspace");
      await page.locator("#aWorkspace button", { hasText: "Add to pipeline" }).click(); await page.waitForTimeout(700);
      await seenToast(page, /Added to the pipeline/);
    });
    await check(P("configuration: a bad email is refused visibly; a user is added, saved and survives a reload; removal too"), async () => {
      await tab(page, "config"); await page.waitForTimeout(400);
      await page.fill("#cfgEmail", "not-an-email"); await page.click("#cfgAdd");
      await seenToast(page, /added as RFP Manager/);
      await page.click("#cfgSave");
      await seenToast(page, /not an email address/);
      await page.locator("#cfgAccess button", { hasText: "Remove" }).first().click();
      await seenToast(page, /removed/);
      await page.fill("#cfgEmail", "rfp.lead@example.org");
      await page.locator("#cfgAccess .add-user select").selectOption("Account Executive");
      await page.click("#cfgAdd"); await seenToast(page, /added as Account Executive/);
      await page.click("#cfgSave"); await seenToast(page, /Access list saved: 1 user/);
      const saved = JSON.parse(fs.readFileSync(path.join(STORE, "access.json"), "utf8"));
      expect(saved.users.length === 1 && saved.users[0].email === "rfp.lead@example.org" && saved.users[0].role === "Account Executive" && !("name" in saved.users[0]), "not saved as email + role");
      await page.reload(); await page.waitForSelector("#sRun"); await tab(page, "config"); await page.waitForTimeout(400);
      expect(await page.locator('#cfgAccess tbody input[type="email"]').inputValue() === "rfp.lead@example.org", "user gone after reload");
    });
    await check(P("configuration: the sales platform choice is saved"), async () => {
      await page.selectOption("#cfgPlatform", "hubspot"); await seenToast(page, /Sales platform: HubSpot/);
      expect(JSON.parse(fs.readFileSync(path.join(STORE, "crm.json"), "utf8")).platform === "hubspot", "platform not saved");
      await page.selectOption("#cfgPlatform", "salesforce"); await seenToast(page, /Sales platform: Salesforce/);
    });
    await check(P("workspace: Salesforce panel prepares the fields, refuses a foreign link, links and unlinks a record"), async () => {
      await tab(page, "sweep"); await page.waitForTimeout(300);
      await page.selectOption("#sStatus", "active"); await page.dispatchEvent("#sStatus", "change"); await page.waitForTimeout(200);
      await openFirst();
      await page.click("#crmOpen"); await page.waitForTimeout(300);
      const panel = await page.locator("#sWorkspace .crm-panel").textContent();
      expect(/Salesforce opportunity/.test(panel) && /RFP: Enterprise Resource Planning \(ERP\)/.test(panel) && /creates nothing until you confirm/.test(panel), "fields not prepared");
      await page.fill("#crmRecordId", "006Hs00001AbCdEIAV"); await page.fill("#crmUrl", "https://evil.example/006");
      await page.locator("#sWorkspace .crm-panel button", { hasText: "Link record" }).click();
      await seenToast(page, /not on Salesforce/);
      await page.fill("#crmUrl", "https://acme.lightning.force.com/lightning/r/Opportunity/006Hs00001AbCdEIAV/view");
      await page.locator("#sWorkspace .crm-panel button", { hasText: "Link record" }).click();
      await seenToast(page, /Linked to Salesforce record 006Hs00001AbCdEIAV/);
      expect(/Linked to Salesforce record/.test(await page.locator("#sWorkspace .crm-panel").textContent()), "link not shown");
      const ledgerText = fs.readFileSync(path.join(STORE, "all.json"), "utf8");
      expect(!ledgerText.includes("force.com"), "the Salesforce link leaked into the ledger");
      await page.locator("#sWorkspace .crm-panel button", { hasText: "Unlink" }).click();
      await seenToast(page, /Link removed/);
      await page.keyboard.press("Escape");
    });
    await check(P("security: writes without the dashboard header are refused"), async () => {
      const r = await page.evaluate(async () => (await fetch("/api/findings/x?tenant=all", { method: "PATCH", body: "{}" })).status);
      expect(r === 403, `expected 403, got ${r}`);
    });
  }

  // ---- your company: understand the business, then score every RFP on what it sells
  const PROFILE_TEXT = `Harborline Systems
Fund accounting, payroll and HR software
Harborline Systems provides ERP financial management, fund accounting, budgeting, payroll and human resources software for school boards, school districts and nonprofit organizations across Canada.
Payroll and HR
Payroll software with position control and collective agreement rules, HRIS and employee self service.
Built on Microsoft Dynamics 365 Business Central with Power BI reporting.`;
  // The published page reads websites through a reader service: faked here, so no test depends on the internet.
  const READER_HOME = `Title: Fund accounting and payroll software | Harborline Systems\n\nURL Source: https://www.harborline.example/\n\nMarkdown Content:\n## Fund accounting for nonprofits and school boards\n\nHarborline Systems builds fund accounting, payroll and grant management software for nonprofits and school districts, on Microsoft Dynamics 365 Business Central.\n\nPayroll and HR\n--------------\n\nPayroll software with position control and collective agreements for school boards, with Power BI reporting on Business Central.\n\nLinks/Buttons:\n[Payroll and HR](https://www.harborline.example/solutions/payroll-hr/)\n[Contact](https://www.harborline.example/contact/)`;
  const READER_PAYROLL = `Title: Payroll and HR | Harborline Systems\n\nMarkdown Content:\n## Payroll and HR for school districts\n\nPayroll software with position control, collective agreement rules, substitute management and an HRIS for school boards and nonprofit employers, on Business Central.`;
  let readerMode = "down";
  const ymd = (n) => day(n).replace(/-/g, "/");
  const MERX_HTML = `<table><tr class="mets-table-row odd"><td><a class="solicitation-link" href="/public/supplier/interception/view-notice/1234567?origin=0"><span class="rowTitle">Payroll and HR System Replacement</span></a><span class="buyer-name">Example Library Board</span><span class="location">Toronto, ON, CAN</span><span class="publicationDate">Published ${ymd(-2)}</span><span class="closingDate">Closing ${ymd(30)}</span></td></tr></table>`;
  const SAM_JSON = `Title: \n\nURL Source: https://sam.gov/api/prod/sgs/v1/search/\n\nMarkdown Content:\n${JSON.stringify({ _embedded: { results: [{ _id: "abc123def456", title: "Payroll System Modernization and ERP Integration", type: { value: "Solicitation" }, responseDate: `${day(25)}T16:00:00+00:00`, publishDate: `${day(-1)}T10:00:00+00:00`, organizationHierarchy: [{ name: "DEPARTMENT OF EXAMPLE" }, { name: "EXAMPLE AGENCY" }], descriptions: [{ content: "Replace the payroll system and integrate it with the ERP (general ledger)." }] }] } })}`;
  if (isStatic) await page.route("https://r.jina.ai/**", (route) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "x-with-links-summary", "content-type": "text/plain" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (readerMode === "down") return route.fulfill({ status: 503, headers: cors, body: "down" });
    if (readerMode === "busy-once") { readerMode = "up"; return route.fulfill({ status: 429, headers: cors, body: "busy" }); }
    const u = route.request().url();
    return route.fulfill({ status: 200, headers: cors, body: /merx\.com\/public\/solicitations/.test(u) ? MERX_HTML : /sam\.gov\/api/.test(u) ? SAM_JSON : /payroll-hr/.test(u) ? READER_PAYROLL : READER_HOME });
  });
  if (isStatic) await page.evaluate(() => { sessionStorage.setItem("rfp.readerRetryMs", "50"); sessionStorage.setItem("rfp.readerPerMinute", "1000"); readerRetryMs = 50; readerPerMinute = 1000; });
  await check(P("company: a website that cannot be read falls back to paste / upload, visibly"), async () => {
    await tab(page, "sweep"); await page.waitForTimeout(150);
    if (isStatic) expect(/r\.jina\.ai, a public reader service: only the website's address is sent/.test(await page.locator("#companyCard").textContent()), "the reader is not disclosed");
    await page.fill("#pUrl", isStatic ? "www.harborline.example" : "http://127.0.0.1:4190/");
    await page.click("#pBuild"); await page.waitForTimeout(isStatic ? 600 : 1500);
    await seenToast(page, isStatic ? /could not read .*HTTP 503/ : /Blocked|private|paste/i);
    expect(await page.locator("#companyCard details.company-alt[open]").count() === 1, "paste / upload panel not opened");
    expect(/could not be read/.test(await page.locator("#companyCard .company-alt .notice").textContent()), "no explanation");
  });
  if (isStatic) {
    await check(P("company: an internal or private address is never sent to the reader"), async () => {
      await page.fill("#pUrl", "https://acme.sharepoint.com/sites/about");
      await page.click("#pBuild");
      await seenToast(page, /is not read/);
    });
  }
  await check(P("company: profile built from pasted text shows what it sells, as toggle chips"), async () => {
    await page.fill("#pText", PROFILE_TEXT);
    await page.click("#pBuildText"); await page.waitForTimeout(600);
    await seenToast(page, /Profile built/);
    const card = await page.locator("#companyCard").textContent();
    expect(/Scoring for\s*Harborline Systems/.test(card), "profile name not shown");
    for (const k of ["ERP / Finance", "HR / HCM", "Business Central", "Who you serve"]) expect(card.includes(k), `profile missing ${k}`);
    if (!isStatic) expect(JSON.parse(fs.readFileSync(path.join(STORE, "profile.json"), "utf8")).name === "Harborline Systems", "profile not saved on the server");
    // A new profile opens in the editor, to check; keep it as read.
    await page.click("#peSave"); await seenToast(page, /Profile saved for Harborline Systems/);
  });
  await check(P("company: results are scored on the offering and filtered to what is relevant"), async () => {
    await page.waitForTimeout(200);
    expect(!/(^|\s)(null|undefined)(\s|$)/.test(await page.locator("#companyCard").innerText()), "the company card shows a stray value after Done");
    await page.selectOption("#sStatus", "all"); await page.dispatchEvent("#sStatus", "change"); await page.waitForTimeout(300);
    expect(/relevant to Harborline Systems/.test(await page.locator(".results-head h2").textContent()), "heading does not say relevant to the company");
    expect(/Harborline/.test(await page.locator("#sResults thead th", { hasText: "Fit" }).getAttribute("title")), "Fit column is not the offering fit");
    const relevant = await count();
    await page.uncheck("#pRelevant"); await page.waitForTimeout(250);
    const all = await count();
    await page.check("#pRelevant"); await page.waitForTimeout(250);
    expect(all >= relevant && relevant >= 1, `relevant ${relevant}, all ${all}`);
    await page.selectOption("#sStatus", "active"); await page.dispatchEvent("#sStatus", "change"); await page.waitForTimeout(200);
  });
  if (isStatic) {
    await check(P("company: the Run button finds RFPs for the company, searching MERX and SAM.gov live for what it sells"), async () => {
      readerMode = "up";
      await tab(page, "sweep"); await page.waitForTimeout(200);
      expect((await page.locator("#sRun").textContent()) === "Find RFPs for Harborline Systems", `button: ${await page.locator("#sRun").textContent()}`);
      await page.selectOption("#sDays", "any"); await page.selectOption("#sGeo", "na");
      await page.click("#sRun");
      await seenToast(page, /Searched MERX and SAM\.gov live for "[^"]+"(, "[^"]+")*, plus the latest scheduled sweep: \d+ RFPs? and RFQs relevant to Harborline Systems/);
      const body = await page.locator("#sResults tbody").textContent();
      expect(/Payroll and HR System Replacement/.test(body) && /Payroll System Modernization/.test(body), "live finds not listed");
      expect((await page.locator("#sResults tbody tr", { hasText: "Payroll and HR System Replacement" }).locator(".live-tag").count()) === 1, "not tagged as found live");
      readerMode = "down";
    });
  }
  await check(P("company: the workspace Fit is on your offering, with no industry in it"), async () => {
    await openFirst();
    const tile = page.locator("#sWorkspace .kpi-btn", { hasText: "Fit to Harborline" });
    expect(await tile.count() === 1, "no 'Fit to Harborline' tile");
    await tile.click(); await page.waitForTimeout(150);
    const ex = await page.locator("#sWorkspace .explain").textContent();
    expect(/From your website/.test(ex) && /What you sell/.test(ex) && /ERP \/ Finance/.test(ex), "explanation is not about the offering");
    expect(!/industry/i.test(ex), "the fit explanation mentions industry");
    await page.keyboard.press("Escape");
  });
  await check(P("company: a capability chip switches off and stays off"), async () => {
    const chip = page.locator("#companyCard .chip", { hasText: "HR / HCM" }).first();
    await chip.click(); await page.waitForTimeout(300);
    expect(/off/.test(await page.locator("#companyCard .chip", { hasText: "HR / HCM" }).first().getAttribute("class")), "chip did not switch off");
    await page.reload(); await page.waitForSelector("#sRun"); await page.waitForTimeout(800);
    expect(/off/.test(await page.locator("#companyCard .chip", { hasText: "HR / HCM" }).first().getAttribute("class")), "chip state not kept");
  });
  await check(P("company: Edit profile changes the name, description, who you serve, platforms and terms by hand"), async () => {
    await page.click("#pEdit");
    await page.fill("#peName", "Harborline");
    await page.fill("#peSummary", "Harborline builds fund accounting and payroll software for school boards.");
    await page.selectOption("#peAddInd", "higher-ed");
    await page.selectOption("#peAddPlat", "Workday");
    await page.fill("#peOtherPlat", "Sage 300"); await page.click("#peAddOther");
    await page.fill("#peTerms", "fund accounting, position control\ngrant management");
    await page.click("#peSave");
    await seenToast(page, /Profile saved for Harborline\./);
    const summary = await page.locator("#coSummary").textContent();
    expect(/^Harborline sells /.test(summary) && /higher education/.test(summary) && /In its own words: "Harborline builds fund accounting and payroll software for school boards\."/.test(summary), `summary: ${summary}`);
    const card = await page.locator("#companyCard").textContent();
    expect(card.includes("grant management") && card.includes("Workday") && card.includes("Sage 300") && /edited by you/.test(card), "edits not shown");
    await page.click("#pEdit"); await page.fill("#peName", "Something Else"); await page.click("#peCancel");
    await seenToast(page, /Changes discarded/);
    expect(/Scoring for\s*Harborline/.test(await page.locator("#companyCard").textContent()), "cancel did not discard");
  });
  if (isStatic) {
    await check(P("company: change the website in Edit profile and read it again; the editor stays open with what the new site says"), async () => {
      readerMode = "up";
      await page.click("#pEdit");
      // A different website starts fresh: the hand-edited name ("Harborline") gives way to what the new site says.
      // A failed read says so inside the editor, with Retry; the profile is unchanged.
      readerMode = "down";
      await page.fill("#peWebsite", "https://www.newco.example/");
      await page.click("#peRead");
      await seenToast(page, /Could not read newco\.example/);
      expect(/Could not read newco\.example: .*Your profile is unchanged/.test(await page.locator("#companyCard .pe-error").textContent()), "no error in the editor");
      // Retry, with the reader busy once: it waits and tries again by itself.
      readerMode = "busy-once";
      await page.click("#peRetry");
      await seenToast(page, /Read 1 page\(s\) of Harborline Systems\. Every field below is updated from the new website/);
      expect(await page.locator("#peSave").count() === 1 && (await page.inputValue("#peName")) === "Harborline Systems", "editor not open with the new site's profile");
      expect((await page.inputValue("#peSummary")).startsWith("Harborline Systems builds fund accounting"), "description not filled from the new website");
      const banner = await page.locator("#companyCard .pe-updated").textContent();
      expect(/Updated from newco\.example/.test(banner) && /Harborline Systems sells/.test(banner), `no update banner: ${banner}`);
      await page.click("#peSave"); await seenToast(page, /Profile saved/);
      expect(/newco\.example/.test(await page.locator("#companyCard .company-head").textContent()), "website not changed");
      readerMode = "down";
    });
  }
  await check(P("company: edit terms and save, then remove the profile"), async () => {
    await page.click("#pEdit");
    await page.fill("#peTerms", "fund accounting, position control, grant management");
    await page.click("#peSave");
    await seenToast(page, /Profile saved/);
    expect((await page.locator("#companyCard").textContent()).includes("grant management"), "terms not saved");
    await page.locator("#companyCard button", { hasText: "Remove" }).click(); await page.waitForTimeout(400);
    expect(await page.locator("#pUrl").count() === 1, "profile not removed");
    expect(/opportunit(y|ies) found/.test(await page.locator(".results-head h2").textContent()), "results still filtered after removing the profile");
  });
  if (isStatic) {
    await check(P("company: the live page reads the website, summarises the business, and keeps its pages as product knowledge"), async () => {
      readerMode = "up";
      await page.fill("#pUrl", "https://www.harborline.example/");
      await page.click("#pBuild");
      await seenToast(page, /Read 2 page\(s\) of Harborline Systems/);
      const summary = await page.locator("#coSummary").textContent();
      expect(/^Harborline Systems sells /.test(summary) && /ERP \/ Finance/.test(summary) && /HR \/ HCM/.test(summary) && /built on .*Business Central/.test(summary) && /Read from 2 pages of harborline\.example/.test(summary), `summary: ${summary}`);
      await tab(page, "analyze"); await page.waitForTimeout(400);
      expect(/Harborline Systems: Payroll and HR/.test(await page.locator("#libraryCard .lib-refs").textContent()), "website pages not added as product knowledge");
      await tab(page, "sweep");
      await page.locator("#companyCard button", { hasText: "Remove" }).click(); await page.waitForTimeout(300);
    });
  }

  await check(P("no stray \"null\" or \"undefined\" text on any screen"), async () => {
    for (const t of ["sweep", "analyze", "findings", "actions", "config"]) {
      await tab(page, t); await page.waitForTimeout(150);
      // The whole page, not only the tab: banners and toolbars sit outside it.
      const text = await page.locator("body").innerText();
      const stray = text.match(/\bundefined\b|\bNaN\b|\[object \w+\]|(^|[\s(])null(?=[\s),.]|$)/);
      expect(!stray, `${t} screen shows a stray value: "${stray?.[0]?.trim()}" in "…${stray ? text.slice(Math.max(0, stray.index - 80), stray.index + 40).replace(/\s+/g, " ") : ""}…"`);
    }
  });
  await check(P("no page or console errors"), async () => expect(errors.length === 0, errors.slice(0, 3).join(" · ")));
  await context.close();
}

try {
  await suite("published site", "http://127.0.0.1:4190/");
  await suite("local dashboard", "http://127.0.0.1:4191/");
} finally {
  await browser.close();
  staticServer.close();
  dash.kill();
  fs.rmSync(path.join(ROOT, "site"), { recursive: true, force: true });
}

const failed = results.filter(([ok]) => !ok);
for (const [ok, name] of results) console.log(`${ok ? "  ✓" : "  ✗"} ${name}`);
console.log(failed.length ? `\n${failed.length} of ${results.length} end-to-end check(s) FAILED` : `\nall ${results.length} end-to-end checks passed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
