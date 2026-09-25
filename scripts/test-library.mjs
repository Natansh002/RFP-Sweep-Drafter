#!/usr/bin/env node
/**
 * Tests for the reference library (articles and past RFP responses → citable
 * passages), drafting from it, and exporting responses into the company's own
 * Word or Excel template. Offline; templates are built in the test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import ExcelJS from "exceljs";
import { passagesFromText, makeReference, referenceKnowledge, linksIn } from "../lib/references.mjs";
import { draftAnswers } from "../lib/respond.mjs";
import { responseData, templateTags, fillDocx, defaultTemplate, fillXlsx, exportResponses, cleanAnswer, TEMPLATE_TAGS } from "../lib/export.mjs";
import { privateFile } from "../lib/ledger.mjs";
import { ROOT } from "../lib/config.mjs";
import { browserBundle, VENDOR } from "../lib/bundle.mjs";

let fails = 0, passes = 0;
const a = (name, cond) => { if (cond) passes++; else { fails++; console.log(`FAIL: ${name}`); } };
const libs = { PizZip, Docxtemplater, ExcelJS };
const docText = (bytes) => new PizZip(bytes).file("word/document.xml").asText().replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ");

// ---- passages
const PAST = `RESPONSE TO RFP 2025-12 FINANCIAL SYSTEM
3.1 Describe your approach to data migration from the legacy system.
We migrate in three passes: a trial load in week four, a reconciled dress rehearsal, and the final cut-over. Finance signs off each pass against the legacy trial balance. Contact jane.doe@vendor.example or 555-123-4567.
3.2 How will you train finance and payroll staff?
Role-based training in the buyer's own processes: super-users first, then end users, with recorded sessions and quick-reference guides for every payroll task.
What is your support model after go-live?
A named customer success manager, 24/7 severity-1 response, and quarterly roadmap reviews with the finance lead for the first two years.`;
const qa = passagesFromText(PAST, { source: "Past response 2025-12.docx" });
a("past response: split into question → answer pairs", qa.length === 3 && qa.every((p) => p.shape === "question") && /data migration/.test(qa[0].question) && /three passes/.test(qa[0].answer));
a("past response: numbered and plain questions both found", /^3\.2 How/.test(qa[1].question) && /^What is your support/.test(qa[2].question));
a("past response: contact details removed", !/jane\.doe|555-123/.test(qa[0].answer) && /\[email\]/.test(qa[0].answer));
a("passages: never approved, marked as references", qa.every((p) => p.kind === "reference" && p.approved === false && p.source === "Past response 2025-12.docx"));
const ART = `Fund accounting for nonprofits
Harborline gives nonprofits a multi-fund general ledger with restricted and unrestricted funds, grant budgets and board-ready reporting, all in Business Central. Finance teams close faster because every transaction carries its fund, program and grant.
Payroll and HR
Position control, collective agreements and benefits administration run in the same system as finance, so budgets and payroll never disagree across sites.`;
const topics = passagesFromText(ART, { source: "https://harborline.example/solutions" });
a("article: split into topics under their headings", topics.length === 2 && topics[0].question === "Fund accounting for nonprofits" && topics[1].question === "Payroll and HR" && topics.every((p) => p.shape === "topic"));
a("ids are stable for the same source", passagesFromText(ART, { source: "https://harborline.example/solutions" })[0].id === topics[0].id);
const ref = makeReference({ source: "Past response 2025-12.docx", kind: "file", text: PAST });
a("reference: summary with its passages", ref.passages.length === 3 && !ref.error && ref.id.startsWith("r-"));
a("reference: nothing usable is reported, not stored silently", /No usable passages/.test(makeReference({ source: "scan.pdf", kind: "file", text: "  " }).error));
a("references → knowledge entries", referenceKnowledge([ref]).length === 3);
a("links: one per line, http(s) only, trailing punctuation dropped", linksIn("https://a.example/x,\nftp://no.example\nhttps://b.example/y.").join() === "https://a.example/x,https://b.example/y");

// ---- drafting from references: cited, never approved
const reqs = [{ id: "4.1", section: "4", text: "Describe your approach to migrating data from the legacy financial system.", level: "question", category: "data" }];
const [ans] = draftAnswers(reqs, referenceKnowledge([ref]), { buyer: "Example District" });
a("draft: uses the matching past answer", /three passes/.test(ans.draft));
a("draft: cites the reference", /\[source: reference "Past response 2025-12\.docx"/.test(ans.draft) && ans.sources[0].kind === "reference");
a("draft: a reference is never an approved answer (SME confirms)", ans.confidence !== "high" && ans.validationRequired === true && /\[SME validation required\] Adapted from your reference library/.test(ans.draft));
const approved = draftAnswers(reqs, [{ id: "K-7", question: "Describe your approach to data migration from the legacy system.", answer: "Approved migration answer with three reconciled passes signed off by finance.", lastReviewed: new Date().toISOString().slice(0, 10) }], {})[0];
a("draft: an approved answer still reaches high confidence", approved.confidence === "high" && !approved.validationRequired);

// ---- export: data for templates
const F = { id: "all-1", sourceId: "RFP-2026-77", title: "ERP and Payroll System", buyer: "Example School District", closeDate: "2026-11-20", status: "Pursuing", url: "https://portal.example/rfp/77", estimatedValue: 1200000,
  rfp: { keyData: { dates: { questions: "2026-11-06" }, contractTerm: "3 years", renewals: "two one-year options", evaluation: [{ criterion: "Technical", weight: 60, unit: "%" }, { criterion: "Price", weight: 40, unit: "%" }], evaluationBasis: "Best value" } } };
const ANSWERS = [
  { reqId: "3.1", section: "3", level: "question", requirement: "Describe your approach to data migration.", draft: "We migrate in three passes.\n\n[source: knowledge K-1, reviewed 2026-01-01]", status: "Approved", owner: "Pre-sales Consultant", confidence: "high" },
  { reqId: "3.2", section: "3", level: "mandatory", requirement: "Provide three references from school boards.", draft: "[SME validation required] Account Executive to write it.", status: "Not started", owner: "Account Executive", confidence: "low" },
];
const PROPOSAL = "# Response to ERP\n\n## 1. Executive summary\n\n**The customer's problem, in their words.**\n> Replace the legacy finance system.\n\n## 2. Understanding of requirements\n\nTwo requirements.";
const data = responseData(F, { answers: ANSWERS, proposal: PROPOSAL, company: "Harborline Systems", now: new Date("2026-10-01T12:00:00Z") });
a("data: the RFP's facts", data.title === "ERP and Payroll System" && data.reference === "RFP-2026-77" && data.questionsDeadline === "2026-11-06" && data.company === "Harborline Systems" && data.date === "2026-10-01");
a("data: key facts include value, term and evaluation", data.keyFacts.some((x) => x.label === "Stated value" && x.value === "$1,200,000") && data.keyFacts.some((x) => /3 years \(two one-year options\)/.test(x.value)) && data.keyFacts.some((x) => /Technical 60%; Price 40%/.test(x.value)));
a("data: internal source notes stripped, SME markers kept", data.responses[0].answer === "We migrate in three passes." && /\[SME validation required\]/.test(data.responses[1].answer));
a("data: executive summary from the proposal, as plain text", /Replace the legacy finance system/.test(data.executiveSummary) && !/\*\*|^>/m.test(data.executiveSummary));
a("clean: the closest-answer hint is internal too", cleanAnswer("Text\n\nClosest approved answer to start from: knowledge K-2 (similarity 0.3).") === "Text");

// ---- Word: the built-in layout and the sample template
const sample = defaultTemplate(PizZip);
a("sample template: a real .docx with every documented tag", sample[0] === 0x50 && ["title", "company", "buyer", "#responses", "answer", "#keyFacts"].every((t) => templateTags(PizZip, sample).includes(t)));
a("tags documented for people", TEMPLATE_TAGS.length >= 10);
const built = docText(fillDocx(libs, sample, data));
a("built-in layout: filled", /ERP and Payroll System/.test(built) && /Response from Harborline Systems to Example School District/.test(built) && /3\.1 Describe your approach to data migration\./.test(built) && /We migrate in three passes\./.test(built));
a("built-in layout: no tag left unfilled", !/\{\{/.test(built));

// A company's own template with tags (split across runs, as Word does)
const ownTagged = (() => {
  const z = new PizZip(sample);
  const xml = z.file("word/document.xml").asText().replace("{{title}}", "</w:t></w:r><w:r><w:t>{{ti</w:t></w:r><w:r><w:t>tle}} · ACME LETTERHEAD");
  z.file("word/document.xml", xml);
  return z.generate({ type: "uint8array" });
})();
const own = docText(fillDocx(libs, ownTagged, data));
a("tagged template: a tag split across runs is still filled", /ERP and Payroll System · ACME LETTERHEAD/.test(own));

// A company template without tags: responses go after its content, in its heading styles
const plain = (() => {
  const z = new PizZip(sample);
  z.file("word/document.xml", z.file("word/document.xml").asText().replace(/<w:body>[\s\S]*<w:sectPr/, '<w:body><w:p><w:r><w:t>ACME Inc. proposal letterhead</w:t></w:r></w:p><w:sectPr'));
  return z.generate({ type: "uint8array" });
})();
const appended = fillDocx(libs, plain, data);
const appendedXml = new PizZip(appended).file("word/document.xml").asText();
a("untagged template: its content kept, responses added after it", /ACME Inc\. proposal letterhead[\s\S]*ERP and Payroll System[\s\S]*We migrate in three passes/.test(appendedXml.replace(/<[^>]+>/g, " ")));
a("untagged template: its heading styles used", /<w:pStyle w:val="Heading1"\/>/.test(appendedXml) && /<w:pStyle w:val="Heading3"\/>/.test(appendedXml));
a("untagged template: the section settings stay last", appendedXml.lastIndexOf("<w:sectPr") > appendedXml.lastIndexOf("We migrate"));

// ---- Excel: the company's response sheet, and a buyer's questionnaire
const xlsxTemplate = async (rows) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("SME Review"); ws.addRow(["Cover"]); ws.addRow(["#", "Section", "SME", "Question", "Draft Answer", "SME Notes / Edits", "Status"]); for (const r of rows) ws.addRow(r); return new Uint8Array(await wb.xlsx.writeBuffer()); };
const readX = async (bytes) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes); return wb.getWorksheet("SME Review"); };
const filled = await readX(await fillXlsx(ExcelJS, await xlsxTemplate([]), { ...data }));
a("Excel template: header found below a cover row; every response written", filled.getRow(3).getCell(1).text === "3.1" && filled.getRow(3).getCell(4).text === "Describe your approach to data migration." && filled.getRow(3).getCell(5).text === "We migrate in three passes." && filled.getRow(4).getCell(3).text === "Account Executive" && filled.getRow(4).getCell(7).text === "Not started");
const questionnaire = await readX(await fillXlsx(ExcelJS, await xlsxTemplate([["Q1", "", "", "Please describe your approach to data migration.", "", "", ""], ["Q2", "", "", "What insurance do you carry?", "", "", ""]]), { ...data }));
a("buyer questionnaire: its questions answered with the closest response", questionnaire.getRow(3).getCell(5).text === "We migrate in three passes.");
a("buyer questionnaire: a question with no drafted answer is flagged, not guessed", /\[SME validation required\] No drafted response matches/.test(questionnaire.getRow(4).getCell(5).text));
let noHeader = false;
try { const wb = new ExcelJS.Workbook(); wb.addWorksheet("x").addRow(["a", "b"]); await fillXlsx(ExcelJS, new Uint8Array(await wb.xlsx.writeBuffer()), { ...data }); } catch (e) { noHeader = /Question \(or Requirement\) column/.test(e.message); }
a("Excel template without the columns: a clear message", noHeader);

// ---- the export zip
const items = [{ finding: F, data }, { finding: { ...F, id: "all-2", title: "ERP and Payroll System" }, data: { ...data } }];
const out = await exportResponses(libs, items, { pipeline: "All industries" });
const zip = new PizZip(out.bytes);
a("zip: one document per opportunity (names never clash), summary and readme", out.files.join() === "erp-and-payroll-system-response.docx,erp-and-payroll-system-response-2.docx" && !!zip.file("all-responses.xlsx") && /These are first drafts/.test(zip.file("README.txt").asText()));
const sumWb = new ExcelJS.Workbook(); await sumWb.xlsx.load(zip.file("all-responses.xlsx").asUint8Array());
a("summary workbook: every answer, with what needs an SME", sumWb.getWorksheet("Responses").rowCount === 5 && sumWb.getWorksheet("Opportunities").getRow(2).getCell(6).value === 1);
const xOut = await exportResponses(libs, [items[0]], { template: { name: "Our template.xlsx", buffer: await xlsxTemplate([]) }, includeSummary: false });
a("zip with an Excel template: .xlsx per opportunity, no summary when not asked", xOut.kind === "xlsx" && xOut.files[0].endsWith(".xlsx") && !new PizZip(xOut.bytes).file("all-responses.xlsx"));

// ---- private library location and the browser bundle
process.env.RFP_LIBRARY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rfp-lib-"));
a("private library: RFP_LIBRARY_DIR moves it (tests never touch real answers)", privateFile(ROOT, "template.json").startsWith(process.env.RFP_LIBRARY_DIR));
delete process.env.RFP_LIBRARY_DIR;
a("private library: library/private by default (gitignored)", privateFile(ROOT, "x").endsWith(path.join("library", "private", "x")) && /library\/private\//.test(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8")));
const bundle = browserBundle();
a("bundle: export and references reach the browser", /exportResponses/.test(bundle) && /passagesFromText/.test(bundle));
a("vendor: the Word-template and zip libraries are served", !!VENDOR["pizzip.min.js"] && !!VENDOR["docxtemplater.min.js"] && fs.existsSync(path.join(ROOT, VENDOR["docxtemplater.min.js"])));

console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nall ${passes} library and export assertions passed`);
process.exit(fails ? 1 : 0);
