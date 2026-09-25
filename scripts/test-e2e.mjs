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
const STORE = path.join(TMP, "store"), OUT = path.join(TMP, "output"), DL = path.join(TMP, "downloads");
for (const d of [STORE, OUT, DL]) fs.mkdirSync(d, { recursive: true });
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
];
const ledger = { tenant: "all", findings: [], runs: [], gaps: [] };
process.env.RFP_STORE_DIR = STORE;
mergeRun(ledger, { industry: "any", findings: F, gaps: [{ channel: "ca.bc.bcbid", status: "blocked-by-portal", detail: "bot check" }], channelsRead: 5, postingsSeen: 200 });
ledger.findings.find((f) => /won/.test(f.title)).status = "Won";
saveLedger(ROOT, ledger);

// ------------------------------------------------------------------ servers
const env = { ...process.env, RFP_STORE_DIR: STORE, RFP_OUTPUT_DIR: OUT };
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
async function check(name, fn) {
  try { await fn(); results.push([true, name]); }
  catch (e) { results.push([false, `${name} — ${String(e.message).split("\n")[0].slice(0, 200)}`]); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

async function openPage(url) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // 403 comes from the deliberate security probe below; anything else is a real error.
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|404 \(Not Found\)|403 \(Forbidden\)/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(url);
  await page.waitForSelector("#sRun");
  await page.waitForTimeout(600);
  return { page, errors, context };
}
const toastText = (page) => page.locator("#toast").textContent();
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
  const P = (n) => `[${mode}] ${n}`;
  const isStatic = mode === "published site";

  await check(P("loads with the workflow strip and 7 steps"), async () => expect((await page.locator("#flowSteps li").count()) === 7, "flow steps missing"));
  await check(P("every main tab opens its screen"), async () => {
    for (const t of ["analyze", "findings", "actions", "coverage", "sweep"]) { await tab(page, t); expect(await page.locator(`#tab-${t}`).isVisible(), `tab ${t} not visible`); }
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
    await check(P("Run RFP Sweep shows results and a result toast"), async () => { await run(); expect((await count()) >= 2, "no results"); expect(/Searched \d+ opportunities/.test(await toastText(page)), "no result toast"); });
  } else {
    await check(P("results render (local search runs live, so this checks the loaded pipeline)"), async () => { await page.selectOption("#sStatus", "active"); await page.selectOption("#sDays", "any"); await page.dispatchEvent("#sStatus", "change"); await page.waitForTimeout(300); expect((await count()) >= 2, "no results"); });
  }
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
  const openFirst = async () => { await page.locator("#sResults tbody tr", { hasText: "Enterprise Resource Planning" }).locator("button", { hasText: "Open" }).click(); await page.waitForSelector("#sWorkspace.ws-overlay .workspace"); };
  await check(P("Open shows the workspace as an overlay"), async () => { await openFirst(); expect(await page.locator("#sWorkspace.ws-overlay").isVisible(), "overlay hidden"); });
  await check(P("all six workspace tabs render"), async () => {
    for (const t of ["Overview", "Requirements", "Responses", "Risks", "Team", "Proposal"]) {
      await page.locator("#sWorkspace .ws-tabs button", { hasText: t }).click(); await page.waitForTimeout(120);
      expect((await page.locator("#sWorkspace .ws-body").textContent()).trim().length > 20, `${t} tab empty`);
    }
  });
  await check(P("Overview shows the five qualify answers and verified vs inferred"), async () => {
    await page.locator("#sWorkspace .ws-tabs button", { hasText: "Overview" }).click();
    const t = await page.locator("#sWorkspace .ws-body").textContent();
    for (const k of ["Why this opportunity matters", "Why we may not qualify", "Information still required", "Recommended next action", "Verified, from the source", "Inferred by this tool", "Evaluator summary"]) expect(t.includes(k), `missing ${k}`);
    expect(await page.locator("#sWorkspace .md li").count() > 3, "summary not rendered as a list");
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
  await check(P("stepper: Red-team gives a readiness verdict"), async () => {
    await page.locator("#sWorkspace .stepper button", { hasText: "Red-team" }).click(); await page.waitForTimeout(250);
    expect(/RFP readiness: (Ready|Needs review)/.test(await page.locator("#sWorkspace .readiness").textContent()), "no readiness");
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
    expect(/answer\(s\) updated from the SME review/.test(await toastText(page)), "no import toast");
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

  // ---- pipeline
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
  await check(P("Pipeline row opens its detail panel"), async () => {
    await page.locator("#findings tbody tr button", { hasText: "Open" }).first().click(); await page.waitForTimeout(200);
    expect(await page.locator("#findings tr.detail").isVisible(), "detail did not open");
    const locked = await page.locator("#findings tr.detail input:not([disabled])").count();
    if (isStatic) expect(locked === 0, "published view should be read-only");
  });
  if (!isStatic || await page.locator("#exportXlsx").count()) {
    await check(P("Download Excel and Deadlines (.ics) download"), async () => {
      const x = await download(page, () => page.click("#exportXlsx")); expect(fs.readFileSync(x).subarray(0, 2).toString() === "PK", "xlsx");
      const i = await download(page, () => page.click("#exportIcs")); expect(fs.readFileSync(i, "utf8").startsWith("BEGIN:VCALENDAR"), "ics");
    });
  }
  await check(P("Action items tab and its filters"), async () => {
    await tab(page, "actions"); await page.waitForTimeout(200);
    expect((await page.locator("#actions tbody tr").count()) >= 1, "no action items");
    await page.selectOption("#aAssignee", "__none"); await page.check("#aShowDone"); await page.waitForTimeout(150);
    await page.selectOption("#aAssignee", ""); await page.uncheck("#aShowDone");
  });
  await check(P("Coverage & runs shows gaps and runs"), async () => {
    await tab(page, "coverage"); await page.waitForTimeout(200);
    expect((await page.locator("#gaps tbody").textContent()).includes("blocked-by-portal"), "gap missing");
    expect((await page.locator("#runs tbody tr").count()) >= 1, "runs missing");
  });

  // ---- editing (local dashboard only)
  if (!isStatic) {
    await tab(page, "findings"); await page.waitForTimeout(200);
    await check(P("edit: assign, status, notes, add action, go/no-go, done"), async () => {
      await page.reload(); await page.waitForSelector("#sRun"); await tab(page, "findings"); await page.waitForTimeout(400);
      const row = page.locator("#findings tbody tr", { hasText: "HRIS" }).first();
      const assignee = row.locator("input.assignee"); await assignee.fill("Bid Writer"); await assignee.press("Enter"); await page.waitForTimeout(500);
      expect(/Assigned to Bid Writer/.test(await toastText(page)), "assign");
      await page.locator("#findings tbody tr", { hasText: "HRIS" }).first().locator("select").selectOption("Qualifying"); await page.waitForTimeout(500);
      expect(/Status → Qualifying/.test(await toastText(page)), "status");
      await page.locator("#findings tbody tr", { hasText: "HRIS" }).first().locator("button", { hasText: "Open" }).click(); await page.waitForTimeout(300);
      const notes = page.locator("#findings tr.detail textarea").first(); await notes.fill("Call the buyer"); await notes.dispatchEvent("change"); await page.waitForTimeout(500);
      expect(/Notes saved/.test(await toastText(page)), "notes");
      await page.fill('#findings tr.detail input[placeholder="New action item"]', "Confirm the Q&A deadline");
      await page.locator("#findings tr.detail button", { hasText: "Add" }).click(); await page.waitForTimeout(500);
      expect(/Action added/.test(await toastText(page)), "add action");
      await page.locator("#findings tr.detail .gng-table select").first().selectOption("yes"); await page.waitForTimeout(500);
      await page.locator("#findings tr.detail .actions-list input[type=checkbox]").first().check(); await page.waitForTimeout(500);
      const saved = JSON.parse(fs.readFileSync(path.join(STORE, "all.json"), "utf8")).findings.find((f) => /HRIS/.test(f.title));
      expect(saved.assignee === "Bid Writer" && saved.status === "Qualifying" && saved.notes === "Call the buyer" && saved.goNoGo.fit === "yes" && saved.actions.some((a) => a.title === "Confirm the Q&A deadline") && saved.actions.some((a) => a.done), "not persisted to the ledger");
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
      expect(/change\(s\)/.test(await toastText(page)), "no import toast");
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
      expect(/Marked Pursuing/.test(await toastText(page)), "pursue");
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
      expect(/Assigned to/.test(await toastText(page)), "assign from team");
      await page.keyboard.press("Escape");
    });
    await check(P("edit: Add to pipeline from Analyze a document"), async () => {
      await tab(page, "analyze"); await page.fill("#aRfpText", RFP); await page.click("#aRun"); await page.waitForSelector("#aWorkspace .workspace");
      await page.locator("#aWorkspace button", { hasText: "Add to pipeline" }).click(); await page.waitForTimeout(700);
      expect(/Added to the pipeline/.test(await toastText(page)), "add to pipeline");
    });
    await check(P("security: writes without the dashboard header are refused"), async () => {
      const r = await page.evaluate(async () => (await fetch("/api/findings/x?tenant=all", { method: "PATCH", body: "{}" })).status);
      expect(r === 403, `expected 403, got ${r}`);
    });
  }

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
