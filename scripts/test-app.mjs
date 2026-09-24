#!/usr/bin/env node
/**
 * Tests for the parts around the scorer: the internal-tool guard, the drafter,
 * the ledger's "a sweep never overwrites a person's edit" rule, the Excel
 * round trip (assignee edited in the sheet comes back), and a full offline sweep.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blockedReason, findBlocked, safeLink } from "../lib/guard.mjs";
import { effectivePack, resolveChannels } from "../lib/pack.mjs";
import { draftFinding } from "../lib/draft.mjs";
import { score } from "../lib/score.mjs";
import { loadTenant, loadPack, loadRegistry } from "../lib/config.mjs";
import { mergeRun, updateFinding, addAction } from "../lib/ledger.mjs";
import { buildWorkbook, importWorkbook, workbookBuffer } from "../lib/excel.mjs";
import { runSweep } from "../lib/sweep.mjs";
import ExcelJS from "exceljs";
import { analyzeDetail, parseDateIn, keyDates } from "../lib/enrich.mjs";
import { matchLibrary, isStale } from "../lib/library.mjs";
import { goNoGoScore, DEFAULT_GO_NO_GO } from "../lib/ledger.mjs";
import { buildCalendar } from "../lib/ics.mjs";

let fails = 0, passes = 0;
const a = (name, cond) => { if (cond) passes++; else { fails++; console.log(`FAIL: ${name}`); } };
const soon = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ guard
const blocked = [
  "https://example.atlassian.net/browse/RFP-12", "https://acme.atlassian.net/wiki/spaces/X/pages/1",
  "https://jira.acme.com/browse/ABC-1", "https://confluence.acme.org/display/X", "https://acme.my.salesforce.com/lightning/r/Opportunity/1/view",
  "https://app.hubspot.com/contacts/1", "https://acme.sharepoint.com/sites/rfp", "https://teams.microsoft.com/l/channel/x",
  "https://docs.google.com/document/d/1", "https://acme.slack.com/archives/C1", "https://www.notion.so/acme/page",
  "https://acme.freshdesk.com/a/tickets/1", "https://businesscentral.dynamics.com/tenant", "http://localhost:8080/", "http://10.0.0.5/",
  "http://192.168.1.10/x", "http://intranet/", "https://rfp.corp/", "https://app.sybill.ai/x", "file:///etc/passwd",
];
for (const u of blocked) a(`guard blocks ${u}`, !!blockedReason(u));
const allowed = ["https://canadabuys.canada.ca", "https://www.bidsandtenders.ca/", "https://sam.gov/search", "https://www.merx.com/", "https://www.example-schools.org/"];
for (const u of allowed) a(`guard allows ${u}`, !blockedReason(u));
a("guard: tenant extra hosts", !!blockedReason("https://portal.acme-internal.com/x", ["acme-internal.com"]));
a("safeLink drops internal links", safeLink("https://acme.sharepoint.com/x") === null && safeLink("https://sam.gov/x") === "https://sam.gov/x");
a("findBlocked walks JSON", findBlocked({ a: ["see https://x.atlassian.net/wiki/y"] }).length === 1);

// ------------------------------------------------------------------ packs are generic
const sr = loadTenant("demo-edu");
const k12 = effectivePack(loadPack("k12"), sr);
a("pack carries tenant offering", k12.offering.productLines.includes("Demo SIS"));
a("tenant exclusion removes a channel", !resolveChannels(k12, loadRegistry(), sr, 3).run.some((c) => c.id === "ca.qc.seao"));
const other = { id: "acme", name: "Acme", industries: ["k12"], geography: ["CA"], offerings: { k12: { productLines: ["Acme SIS"], extraTitleKeywords: ["transcript system"] } } };
const k12acme = effectivePack(loadPack("k12"), other);
a("second company shares the pack with its own keywords", k12acme.qualifiers.titleKeywords.includes("transcript system") && !k12.qualifiers.titleKeywords.includes("transcript system"));

// ------------------------------------------------------------------ drafter
const posting = { title: "RFP - Enterprise Resource Planning and Payroll System", summary: "Position control and collective agreement.", buyer: "Example School Board", buyerType: "school board", country: "CA", closeDate: soon(34), estimatedValue: 900000, url: "https://www.bidsandtenders.ca/x" };
const s = score(posting, k12, sr);
const f = draftFinding(posting, s, k12, sr, "ca.mash.bidsandtenders");
a("drafter: pursue gets a response draft", s.band === "pursue" && /Response draft/.test(f.draft.response));
a("drafter: uses tenant product lines", f.draft.response.includes("Demo ERP - Finance + HR"));
a("drafter: never drafts pricing", /pricing is never drafted/.test(f.draft.response));
a("drafter: six action items with dates", f.actions.length === 6 && f.actions.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.due)));
a("drafter: submit is before close", f.actions.find((x) => x.id === "submit").due < posting.closeDate);
a("drafter: assignee left for a person", f.assignee === "" && f.suggestedAssignee === "K-12 Sales Exec");
a("drafter: stable id", draftFinding(posting, s, k12, sr, "other").id === f.id);

// ------------------------------------------------------------------ ledger
const ledger = { tenant: "demo-edu", findings: [], runs: [], gaps: [] };
mergeRun(ledger, { industry: "k12", findings: [f], gaps: [], channelsRead: 1, postingsSeen: 1 });
updateFinding(ledger, f.id, { assignee: "Bid Writer", status: "Qualifying", notes: "call the buyer" });
a("assigning a finding hands blank actions to the same person", ledger.findings[0].actions.every((x) => x.assignee === "Bid Writer"));
const again = draftFinding({ ...posting }, { ...s, total: 70 }, k12, sr, "ca.mash.bidsandtenders");
mergeRun(ledger, { industry: "k12", findings: [again], gaps: [], channelsRead: 1, postingsSeen: 1 });
const kept = ledger.findings[0];
a("re-sweep keeps assignee, status, notes", kept.assignee === "Bid Writer" && kept.status === "Qualifying" && kept.notes === "call the buyer");
a("re-sweep refreshes machine fields", kept.score === 70 && kept.seenCount === 2 && ledger.findings.length === 1);
let threw = false;
try { updateFinding(ledger, f.id, { assignee: "X" }, { expectedRev: 0 }); } catch (e) { threw = e.code === "CONFLICT"; }
a("stale rev is refused", threw);

// ------------------------------------------------------------------ Excel round trip
const buf = await workbookBuffer(ledger, sr);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf);
a("workbook has the sheets", ["Findings", "Actions", "Drafts", "Coverage gaps", "Runs", "Team", "How to use"].every((n) => wb.getWorksheet(n)));
const fws = wb.getWorksheet("Findings");
const hdr = {}; fws.getRow(1).eachCell((c, i) => (hdr[String(c.value).replace(/\s*✎$/, "")] = i));
a("assignee column has a dropdown from Team", fws.getCell(2, hdr["Assignee"]).dataValidation?.formulae?.[0] === "Team!$A$2:$A$500");
fws.getCell(2, hdr["Assignee"]).value = "RFP Manager";
fws.getCell(2, hdr["Status"]).value = "Pursuing";
const aws = wb.getWorksheet("Actions");
const ah = {}; aws.getRow(1).eachCell((c, i) => (ah[String(c.value).replace(/\s*✎$/, "")] = i));
aws.getCell(2, ah["Done"]).value = "Yes";
aws.addRow({}).getCell(ah["Finding ID"]).value = f.id;
aws.getCell(aws.rowCount, ah["Action"]).value = "Book a call with the buyer";
aws.getCell(aws.rowCount, ah["Assignee"]).value = "Solutions Consultant";
const edited = Buffer.from(await wb.xlsx.writeBuffer());
const r = await importWorkbook(ledger, edited);
const after = ledger.findings[0];
a("import: assignee from the sheet", after.assignee === "RFP Manager" && after.status === "Pursuing");
a("import: action done from the sheet", after.actions[0].done === true);
a("import: new action row added", after.actions.some((x) => x.title === "Book a call with the buyer" && x.assignee === "Solutions Consultant"));
a("import: nothing reported as conflict", r.conflicts.length === 0 && r.errors.length === 0);
a("import: assigning a finding in the sheet hands its blank actions over, and they stay assigned", after.actions.filter((x) => x.source === "drafter").every((x) => x.assignee === "RFP Manager" || x.assignee === "Bid Writer"));
// Now the dashboard edits the same row, and the old sheet is imported again.
updateFinding(ledger, f.id, { assignee: "Sales Exec" });
const r2 = await importWorkbook(ledger, edited);
a("import: stale sheet does not overwrite a newer dashboard edit", ledger.findings[0].assignee === "Sales Exec" && r2.conflicts.length >= 1);

// ------------------------------------------------------------------ offline sweep
const HTML = `<html><body>${"<p>padding</p>".repeat(80)}
<a href="/rfp/1">RFP 2026-14 Enterprise Resource Planning and Payroll System Replacement</a>
<a href="https://acme.sharepoint.com/sites/x/doc">RFP Student Information System (SIS) documents</a>
<a href="/rfp/2">Snow removal services for school sites 2026</a>
<a href="https://jira.acme.com/browse/X-1">Link that must never be followed</a></body></html>`;
const requested = [];
const fakeFetch = async (url) => { requested.push(url); return new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }); };
const run = await runSweep("demo-edu", "k12", { width: 1, fetchImpl: fakeFetch });
a("offline sweep: found the ERP posting", run.findings.some((x) => /Enterprise Resource Planning/.test(x.title)));
a("offline sweep: snow removal dropped", !run.findings.some((x) => /Snow removal/.test(x.title)));
a("offline sweep: SharePoint link stripped, finding kept", run.findings.some((x) => /Student Information/.test(x.title) && x.url === null));
a("offline sweep: never requested an internal host", requested.every((u) => !blockedReason(u)));
a("offline sweep: no finding links to an internal tool", run.findings.every((x) => !x.url || !blockedReason(x.url)));

// ------------------------------------------------------------------ enrichment
a("date: ISO", parseDateIn("closes 2026-11-03 at 2pm") === "2026-11-03");
a("date: Month D, YYYY", parseDateIn("October 15, 2026") === "2026-10-15");
a("date: D Month YYYY", parseDateIn("15 October 2026") === "2026-10-15");
a("date: Sept.", parseDateIn("Sept. 4 2026") === "2026-09-04");
a("date: d/m when day > 12", parseDateIn("28/10/2026") === "2026-10-28");
a("date: invalid rejected", parseDateIn("2026-02-31") === null);
const DETAIL = `<html><body><h1>RFP 2026-14 ERP and Payroll</h1>
<p>Closing Date: November 20, 2026 at 2:00 PM local time.</p>
<p>Questions Deadline: November 6, 2026.</p>
<p>A non-mandatory pre-bid meeting will be held on 2026-10-30.</p>
<p>The Board currently uses Legacy Finance Co, which is end of life.</p>
<p>Proponents must provide three references from school boards of similar size. The proposal shall not exceed 40 pages. Proponents must carry commercial general liability insurance of $5,000,000.</p>
<p>Integration with PowerSchool is required. Position control and collective agreement support.</p></body></html>`;
const d = analyzeDetail(DETAIL, { competitors: [{ name: "PowerSchool", aliases: ["PowerSchool ERP"] }, { name: "Workday" }] });
a("enrich: closing date", d.closeDate === "2026-11-20");
a("enrich: questions deadline", d.keyDates.questions === "2026-11-06");
a("enrich: pre-bid meeting", d.keyDates.preBid === "2026-10-30");
a("enrich: incumbent", d.incumbent === "Legacy Finance Co");
a("enrich: competitors are whole-name matches", d.competitors.join() === "PowerSchool");
a("enrich: requirements typed", d.requirements.length >= 3 && d.requirements.some((r) => r.kind === "insurance") && d.requirements.some((r) => r.kind === "format") && d.requirements.some((r) => r.kind === "experience"));
a("enrich: requirement ids stable across reorder", analyzeDetail(DETAIL.replace("<p>Integration", "<p>New: vendors must attend. </p><p>Integration"), {}).requirements.some((r) => r.id === d.requirements[0].id));
a("enrich: timestamp-only change keeps hash", analyzeDetail(DETAIL.replace("2:00 PM", "3:00 PM"), {}).contentHash === d.contentHash);
a("enrich: real change moves hash", analyzeDetail(DETAIL.replace("40 pages", "30 pages"), {}).contentHash !== d.contentHash);

// ------------------------------------------------------------------ go/no-go, library, calendar
a("go/no-go: incomplete until all answered", goNoGoScore({ fit: "yes" }).verdict === "incomplete");
a("go/no-go: go", goNoGoScore(Object.fromEntries(DEFAULT_GO_NO_GO.criteria.map((c) => [c.id, "yes"]))).verdict === "go");
a("go/no-go: partial is half", goNoGoScore(Object.fromEntries(DEFAULT_GO_NO_GO.criteria.map((c) => [c.id, "partial"]))).pct === 50);
const lib = [
  { id: "sec-1", question: "Describe your data security and hosting", answer: "SOC 2 Type II ...", tags: ["security", "hosting"], lastReviewed: soon(-30), reviewEveryDays: 180 },
  { id: "pay-1", question: "Describe payroll and collective agreement support", answer: "...", tags: ["payroll"], industries: ["k12"], lastReviewed: soon(-400), reviewEveryDays: 180 },
  { id: "np-1", question: "Fund accounting for restricted grants", answer: "...", tags: ["fund accounting"], industries: ["nonprofit"], lastReviewed: soon(-10) },
];
const lm = matchLibrary(lib, "ERP and payroll system with collective agreement support, security and hosting requirements", "k12");
a("library: matches by topic", lm.some((x) => x.id === "pay-1") && lm.some((x) => x.id === "sec-1"));
a("library: scoped to industry", !lm.some((x) => x.id === "np-1"));
a("library: stale flagged", lm.find((x) => x.id === "pay-1").stale === true && isStale(lib[0]) === false);
const cal = buildCalendar(ledger, sr);
a("calendar: valid VCALENDAR with events", cal.startsWith("BEGIN:VCALENDAR") && cal.includes("BEGIN:VEVENT") && cal.trim().endsWith("END:VCALENDAR"));
a("calendar: no invites or attendees", !/ATTENDEE|ORGANIZER|METHOD:REQUEST/.test(cal));
a("calendar: lines folded to 75 octets", cal.split("\r\n").every((l) => Buffer.byteLength(l) <= 75));

// ------------------------------------------------------------------ addenda detection + sticky enrichment
const L2 = { tenant: "demo-edu", findings: [], runs: [], gaps: [] };
const base = { ...posting, keyDates: { questions: "2026-11-06" }, requirements: d.requirements, contentHash: "aaa" };
const f1 = draftFinding(base, s, k12, sr, "x");
mergeRun(L2, { industry: "k12", findings: [f1], gaps: [] });
const f2 = draftFinding({ ...base, contentHash: "bbb", keyDates: { questions: "2026-11-10" } }, s, k12, sr, "x");
mergeRun(L2, { industry: "k12", findings: [f2], gaps: [] });
a("addenda: change flagged with what changed", L2.findings[0].changed?.what.some((w) => /questions 2026-11-06 → 2026-11-10/.test(w)) && L2.findings[0].changed.what.includes("posting page content changed"));
a("addenda: review action created", L2.findings[0].actions.some((x) => x.source === "change-detection"));
const f3 = draftFinding({ ...posting, closeDate: null }, s, k12, sr, "x");
mergeRun(L2, { industry: "k12", findings: [f3], gaps: [] });
a("sticky: a run that did not read the page keeps last run's dates and requirements", L2.findings[0].keyDates.questions === "2026-11-10" && L2.findings[0].requirements.length === d.requirements.length && L2.findings[0].closeDate === posting.closeDate);
updateFinding(L2, f1.id, { acknowledgeChange: true, estimatedValue: "1,250,000", goNoGo: { fit: "yes" } });
a("acknowledge clears the flag; value parsed; go/no-go stored", L2.findings[0].changed === null && L2.findings[0].estimatedValue === 1250000 && L2.findings[0].goNoGo.fit === "yes");
mergeRun(L2, { industry: "k12", findings: [draftFinding({ ...posting, estimatedValue: 5 }, s, k12, sr, "x")], gaps: [] });
a("a person's value is not overwritten by a sweep", L2.findings[0].estimatedValue === 1250000);
let bad = false; try { updateFinding(L2, f1.id, { goNoGo: { fit: "maybe" } }); } catch { bad = true; }
a("go/no-go rejects unknown answers", bad);

// ------------------------------------------------------------------ Excel compliance round trip
const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.load(await workbookBuffer(L2, sr));
a("workbook has Compliance and Pipeline sheets", !!wb2.getWorksheet("Compliance") && !!wb2.getWorksheet("Pipeline"));
const cws = wb2.getWorksheet("Compliance");
const ch = {}; cws.getRow(1).eachCell((c, i) => (ch[String(c.value).replace(/\s*✎$/, "").replace(/ \(.*$/, "")] = i));
cws.getCell(2, ch["Owner"]).value = "Legal";
cws.getCell(2, ch["Status"]).value = "Done";
const rid = String(cws.getCell(2, ch["Req ID"]).value);
await importWorkbook(L2, Buffer.from(await wb2.xlsx.writeBuffer()));
a("import: compliance owner and status from the sheet", L2.findings[0].compliance?.[rid]?.owner === "Legal" && L2.findings[0].compliance[rid].status === "Done");

// ------------------------------------------------------------------ offline sweep reads the detail page
const LIST = `<html><body>${"<p>padding</p>".repeat(80)}<a href="https://portal.example.org/rfp/77">RFP 2026-77 Student Information System Replacement</a></body></html>`;
const run2 = await runSweep("demo-edu", "k12", { width: 1, fetchImpl: async (u) => new Response(/rfp\/77/.test(u) ? DETAIL.replace("<h1>", "<p>School District buyer</p><h1>") : LIST, { headers: { "content-type": "text/html" } }) });
const sis = run2.findings.find((x) => /Student Information System/.test(x.title));
a("sweep+detail: close date from the posting page", sis?.closeDate === "2026-11-20");
a("sweep+detail: requirements and key dates carried", sis?.requirements.length >= 3 && sis?.keyDates.questions === "2026-11-06");
a("sweep+detail: fewer unknowns than the listing alone", !sis.reasons.some((r) => /^timeline .*unknown/.test(r)));

console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nall ${passes} app assertions passed`);
process.exit(fails ? 1 : 0);
