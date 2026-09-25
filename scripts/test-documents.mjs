#!/usr/bin/env node
/**
 * Tests for fetching the RFP with the posting: finding the public solicitation
 * documents, reading them through the guard, and pulling out the questions
 * deadline, budget, contract term and evaluation criteria. Offline: every
 * document here is built in the test.
 */
import { documentLinks, listedDocuments, samAttachments, fetchDocument, documentText, readDocuments, accountPortal } from "../lib/documents.mjs";
import { extractKeyData, analyzeRfp, qualify } from "../lib/analyze.mjs";
import { keyDates } from "../lib/enrich.mjs";
import { runSweep, redactContacts } from "../lib/sweep.mjs";
import { mergeRun } from "../lib/ledger.mjs";
import { industryIds, loadPack } from "../lib/config.mjs";

let fails = 0, passes = 0;
const a = (name, cond) => { if (cond) passes++; else { fails++; console.log(`FAIL: ${name}`); } };
const NOW = new Date("2026-10-01T12:00:00Z");

/** A one-page PDF holding these lines (Helvetica), built by hand. */
function makePdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (m) => `\\${m}`);
  const content = `BT /F1 10 Tf 40 800 Td 13 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

const RFP_LINES = [
  "REQUEST FOR PROPOSAL 2026-77 STUDENT INFORMATION SYSTEM",
  "Questions Deadline: November 6, 2026 at 2:00 PM",
  "Proposals Due: November 20, 2026 at 2:00 PM",
  "Estimated contract value: $1,800,000",
  "The term of the contract will be three (3) years with an option to extend for two (2) additional one-year periods.",
  "Questions must be sent to procurement.lead@board.example or 555-123-4567.",
  "EVALUATION CRITERIA",
  "1. Technical approach and methodology 40%",
  "2. Relevant experience and references 25%",
  "3. Price 35%",
  "All prices must include 13% HST.",
  "The Proponent shall provide three references from school boards of similar size.",
  "The Proponent must carry general liability insurance of $5,000,000.",
  "3.1 Describe your approach to data migration from the legacy system.",
];
const PDF = makePdf(RFP_LINES);

// ---- which links are documents, most useful first
const PAGE = `<html><body><h1>RFP 2026-77</h1>
<a href="/docs/RFP-2026-77-Student-Information-System.pdf">RFP document</a>
<a href="/docs/Pricing-Form.pdf">Pricing form</a>
<a href="/docs/Bid-Form.xlsx">Bid form (Excel)</a>
<a href="/docs/Addendum-1.pdf">Addendum 1</a>
<a href="/news/why-sis">News</a> <a href="https://elsewhere.example/terms.pdf">Terms</a></body></html>`;
const links = documentLinks(PAGE, "https://portal.example.org/rfp/77");
a("links: PDFs found and resolved", links.some((l) => l.url === "https://portal.example.org/docs/RFP-2026-77-Student-Information-System.pdf"));
a("links: the RFP comes first, the pricing form last or dropped", links[0].name === "RFP document" && links.findIndex((l) => /Pricing/.test(l.name)) !== 0);
a("links: spreadsheets and pages are not documents", !links.some((l) => /xlsx|news/.test(l.url)));
a("links: addenda kept", links.some((l) => /Addendum/.test(l.name)));
const listed = listedDocuments("https://canadabuys.canada.ca/documents/pub/att/a/b/RFP.PDF,https://canadabuys.canada.ca/documents/pub/att/a/b/Price_Schedule.pdf");
a("listed: CanadaBuys attachment list split, the price schedule left out", listed.length === 1 && /RFP/.test(listed[0].name));
a("portal: MERX documents need an account", accountPortal("https://www.merx.com/public/solicitations/1/abstract") === "MERX" && accountPortal("https://sam.gov/opp/x/view") === null);

// ---- SAM.gov attachments from its public API (mocked)
const HAL = { _embedded: { opportunityAttachmentList: [{ attachments: [
  { resourceId: "aaa111", name: "SOW.pdf", type: "file", accessLevel: "public", fileExists: "1", deletedFlag: "0", size: 1000, attachmentOrder: 1 },
  { resourceId: "bbb222", name: "Pricing Worksheet.xlsx", type: "file", accessLevel: "public", fileExists: "1", deletedFlag: "0", size: 1000 },
  { resourceId: "ccc333", name: "Controlled.pdf", type: "file", accessLevel: "private", fileExists: "1", deletedFlag: "0", size: 1000 },
] }] } };
let asked = null;
const sam = await samAttachments("83bdf90589044beaa80e8c1a4ec76791", { fetchImpl: async (u, o) => { asked = o.headers.accept; return new Response(JSON.stringify(HAL), { headers: { "content-type": "application/hal+json" } }); } });
a("sam: public PDF attachment listed with its download URL", sam.length === 1 && sam[0].url.endsWith("/resources/files/aaa111/download") && sam[0].name === "SOW.pdf");
a("sam: asks for HAL JSON (the API refuses plain JSON)", /application\/hal\+json/.test(asked));
a("sam: a malformed notice id is not requested", (await samAttachments("../../etc", { fetchImpl: async () => { throw new Error("should not fetch"); } })).length === 0);

// ---- reading documents, through the guard
const pdfText = await documentText(PDF, { type: "application/pdf", name: "rfp.pdf" });
a("pdf: text read, one line per line", /Questions Deadline: November 6, 2026/.test(pdfText.text) && pdfText.pages === 1 && pdfText.text.split("\n").length >= RFP_LINES.length);
a("text: a plain-text document is read", (await documentText(new TextEncoder().encode("Scope of work"), { type: "text/plain" })).text === "Scope of work");
a("html: a sign-in page is not a document", /sign-in page/.test((await documentText(new TextEncoder().encode("<html>login</html>"), { type: "text/html" })).error));
let fetched = 0;
const spy = async () => { fetched++; return new Response(PDF, { headers: { "content-type": "application/pdf" } }); };
for (const bad of ["http://127.0.0.1/rfp.pdf", "http://10.0.0.5/rfp.pdf", "https://acme.atlassian.net/wiki/rfp.pdf"]) a(`guard: refuses ${bad}`, /Blocked/.test((await fetchDocument(bad, { fetchImpl: spy })).error ?? ""));
a("guard: nothing fetched for refused addresses", fetched === 0);
const hop = await fetchDocument("https://portal.example.org/rfp.pdf", { fetchImpl: async () => new Response("", { status: 302, headers: { location: "http://192.168.0.9/rfp.pdf" } }) });
a("guard: a redirect into a private address is refused", /Blocked/.test(hop.error ?? ""));
a("size: an oversized document is refused", /too large/.test((await fetchDocument("https://portal.example.org/big.pdf", { fetchImpl: async () => new Response(PDF, { headers: { "content-length": String(40 * 1048576) } }) })).error ?? ""));
const docs = await readDocuments([{ url: "https://portal.example.org/rfp.pdf", name: "RFP.pdf" }, { url: "https://portal.example.org/login", name: "Login.pdf" }],
  { fetchImpl: async (u) => (/login/.test(u) ? new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } }) : new Response(PDF, { headers: { "content-type": "application/pdf" } })) });
a("read: the document is read, the sign-in page reported", docs[0].words > 50 && docs[0].pages === 1 && /sign-in/.test(docs[1].error));

// ---- the facts people asked for, from real RFP phrasing
const kd = extractKeyData(pdfText.text);
a("facts: questions deadline", kd.dates.questions === "2026-11-06");
a("facts: estimated value", kd.value?.amount === 1800000);
a("facts: contract term and options", kd.contractTerm === "3 years" && /two \(2\) additional one-year periods/.test(kd.renewals));
a("facts: weighted evaluation criteria, no tax line", kd.evaluation?.length === 3 && kd.evaluation[0].weight === 40 && !kd.evaluation.some((e) => /HST|prices/i.test(e.criterion)));
const SECTION_M = `SECTION M – EVALUATION FACTORS AND BASIS FOR AWARD
M.1 BASIS FOR AWARD
The Government will award to the offeror whose proposal represents the best value to the Government, in a best-value trade-off.
Factor #1 is more important than Factors #2, #3, and #4. Factor #2 is more important than Factors #3 and #4.
M.3 FACTOR #1 – PAST PERFORMANCE / RELEVANT EXPERIENCE
M.4 FACTOR #2 – TECHNICAL APPROACH
M.5 FACTOR #3 – MANAGEMENT APPROACH
M.6 FACTOR #4 – PRICE/COST
The ordering period is five (5) years (sixty (60) months), structured as follows: Base Year and Option Years 1 through 4.`;
const m = extractKeyData(SECTION_M);
a("facts: ranked factors when no weights are given", m.evaluation?.map((e) => e.criterion).join("|") === "Past Performance / Relevant Experience|Technical Approach|Management Approach|Price/Cost" && m.evaluation[0].rank === 1);
a("facts: basis of award and relative importance", m.evaluationBasis === "Best value (trade-off)" && /Factor #1 is more important/.test(m.evaluationNote));
a("facts: ordering period and option years", m.contractTerm === "5 years" && m.renewals === "4 option years");
a("facts: junk percentages are not criteria", !extractKeyData("vulnerability scanning information for 100%\nof 100%\nDemonstrate how the solution achieves greater than 90% uptime").evaluation);
for (const [line, want] of [["Deadline for Questions: October 10, 2026", "2026-10-10"], ["Question Acceptance Deadline 2026/10/08 12:00 PM", "2026-10-08"], ["Enquiry Deadline: 15 October 2026", "2026-10-15"], ["Last day for questions is 2026-10-03.", "2026-10-03"], ["Questions regarding invoices go to the helpdesk.", undefined]]) a(`questions: "${line.slice(0, 40)}"`, keyDates(line).questions === want);
a("redact: contact emails and phones removed, dates kept", redactContacts("Email a.b@x.gov or 555-123-4567 by 2026-10-01") === "Email [email] or [phone] by 2026-10-01");

// ---- the analysis uses what the sweep read, and says what is still missing and why
const packs = industryIds().map(loadPack);
const facts = { sources: [{ kind: "notice", words: 40 }, { kind: "document", name: "RFP.pdf", pages: 12, words: 5000 }], keyData: { dates: { questions: "2026-11-06" }, contractTerm: "3 years", value: { amount: 1800000, context: "estimated" }, evaluation: kd.evaluation }, risks: [{ id: "insurance-high", severity: "medium", label: "Insurance of $5M or more", evidence: "…" }], requirements: [{ id: "3.1", section: "3", text: "Describe your approach to data migration from the legacy system.", level: "question", category: "technical" }], fullText: true, words: 5040, notes: [] };
const thin = analyzeRfp({ text: "Student information system replacement for a school board. Closing November 20, 2026.", packs, now: NOW, known: facts });
const q = qualify(thin, { rfp: facts });
a("merge: questions deadline, term, value and criteria filled from the documents", thin.keyData.dates.questions === "2026-11-06" && thin.keyData.contractTerm === "3 years" && thin.keyData.value.amount === 1800000 && thin.keyData.evaluation.length === 3);
a("merge: risks and response items from the documents", thin.risks.some((r) => r.id === "insurance-high") && thin.requirements.some((r) => r.id === "3.1"));
a("qualify: those items are no longer 'information still required'", !q.infoRequired.some((x) => /^(Deadline for questions|Budget|Contract term|Evaluation criteria)/.test(x)));
a("qualify: facts say they came from the documents", q.verified.some((v) => v.label === "Questions deadline" && /RFP document/.test(v.from)) && q.verified.some((v) => v.label === "Evaluation criteria"));
a("qualify: no 'upload the full document' when the sweep read it", !q.infoRequired.some((x) => /full solicitation document/.test(x)) && !/Get the full RFP/.test(q.nextAction));
const none = qualify(analyzeRfp({ text: "Snow clearing for school sites. Closing November 20, 2026.", packs, now: NOW, known: { sources: [{ kind: "notice" }, { kind: "document", name: "RFP.pdf", words: 900 }], keyData: {}, fullText: true, notes: [] } }), { rfp: { sources: [{ kind: "notice" }, { kind: "document", name: "RFP.pdf", words: 900 }], notes: [] } });
a("qualify: missing items listed once, with where the sweep looked said once", none.infoRequired.some((x) => /^Deadline for questions/.test(x)) && /^None of these is stated in the notice or the RFP document the sweep read \(RFP\.pdf\)/.test(none.infoWhere) && !none.infoRequired.some((x) => /Not stated/.test(x)));

// ---- a sweep fetches the RFP with the posting
const LIST = `<html><body>${"<p>padding</p>".repeat(80)}<a href="https://portal.example.org/rfp/77">RFP 2026-77 Student Information System Replacement</a></body></html>`;
const DETAIL = `<html><body><p>School District buyer</p><h1>RFP 2026-77 Student Information System Replacement</h1><p>Closing Date: November 20, 2026.</p>
<p>Student information system for a school district. See the solicitation documents.</p><a href="/docs/RFP-2026-77.pdf">RFP 2026-77 solicitation document</a></body></html>`;
const got = [];
const run = await runSweep("demo-edu", "k12", { width: 1, browser: false, now: NOW, fetchImpl: async (u) => { got.push(u); return /\.pdf$/.test(u) ? new Response(PDF, { headers: { "content-type": "application/pdf" } }) : new Response(/rfp\/77/.test(u) ? DETAIL : LIST, { headers: { "content-type": "text/html" } }); } });
const sis = run.findings.find((x) => /Student Information System/.test(x.title));
a("sweep: the solicitation document was downloaded", got.some((u) => /RFP-2026-77\.pdf$/.test(u)));
a("sweep: questions deadline from the document", sis?.keyDates?.questions === "2026-11-06" && sis?.rfp?.keyData?.dates?.questions === "2026-11-06");
a("sweep: term, value and evaluation from the document", sis?.rfp?.keyData?.contractTerm === "3 years" && sis?.estimatedValue === 1800000 && sis?.rfp?.keyData?.evaluation?.length === 3);
a("sweep: sources list the document read", sis?.rfp?.sources?.some((s) => s.kind === "document" && s.pages === 1 && s.words > 50));
a("sweep: response items and risks kept", sis?.rfp?.requirements?.some((r) => /data migration/.test(r.text)) && sis?.rfp?.risks?.some((r) => r.id === "insurance-high"));
a("sweep: no contact details stored", !JSON.stringify(sis?.rfp ?? {}).includes("procurement.lead@") && !JSON.stringify(sis?.rfp ?? {}).includes("555-123-4567"));
a("sweep: the full text is returned beside the finding, not inside it", typeof run.texts?.[sis?.id] === "string" && run.texts[sis.id].includes("EVALUATION CRITERIA") && !("text" in (sis?.rfp ?? {})));
const L = { tenant: "demo-edu", findings: [], runs: [], gaps: [] };
mergeRun(L, run);
mergeRun(L, { ...run, findings: run.findings.map((f) => ({ ...f, rfp: undefined })) });
a("ledger: a later run that could not read the documents keeps the last reading", L.findings.find((f) => f.id === sis.id)?.rfp?.keyData?.contractTerm === "3 years");
const again = [];
await runSweep("demo-edu", "k12", { width: 1, browser: false, now: NOW, docsRead: { [sis.id]: NOW.toISOString() }, fetchImpl: async (u) => { again.push(u); return /\.pdf$/.test(u) ? new Response(PDF, { headers: { "content-type": "application/pdf" } }) : new Response(/rfp\/77/.test(u) ? DETAIL : LIST, { headers: { "content-type": "text/html" } }); } });
a("sweep: documents read in the last 3 days are not fetched again", !again.some((u) => /\.pdf$/.test(u)));
const off = await runSweep("demo-edu", "k12", { width: 1, browser: false, documents: false, now: NOW, fetchImpl: async (u) => new Response(/\.pdf$/.test(u) ? PDF : /rfp\/77/.test(u) ? DETAIL : LIST, { headers: { "content-type": /\.pdf$/.test(u) ? "application/pdf" : "text/html" } }) });
a("sweep: documents can be switched off", !off.findings.find((x) => /Student Information System/.test(x.title))?.rfp?.fullText);

console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nall ${passes} document assertions passed`);
process.exit(fails ? 1 : 0);
