#!/usr/bin/env node
/**
 * Tests for the RFP operating flow: Discover (feeds) → Understand (analyze) →
 * Qualify → Assign (route) → Answer → Build → Red-team, plus the scoring export
 * and the browser bundle.
 */
import fs from "node:fs";
import vm from "node:vm";
import ExcelJS from "exceljs";
import { analyzeRfp, mapRequirements, extractKeyData, flagRisks, qualify } from "../lib/analyze.mjs";
import { draftAnswers, buildProposal, redTeam } from "../lib/respond.mjs";
import { matchCapabilities, packForSearch, recommendTeam, ownerForCategory } from "../lib/capabilities.mjs";
import { buildAnalysisWorkbook } from "../lib/analysis-excel.mjs";
import { parseCsv, extractPostings } from "../lib/extract.mjs";
import { score } from "../lib/score.mjs";
import { browserBundle } from "../lib/bundle.mjs";
import { industryIds, loadPack, loadTenant, tenantIds } from "../lib/config.mjs";

let fails = 0, passes = 0;
const a = (name, cond) => { if (cond) passes++; else { fails++; console.log(`FAIL: ${name}`); } };
const NOW = new Date("2026-10-01T12:00:00Z");
const packs = industryIds().map(loadPack);

const RFP = `REQUEST FOR PROPOSAL 2026-14
ENTERPRISE RESOURCE PLANNING AND PAYROLL SYSTEM

1. Introduction
The Example School Board is seeking a financial management system and payroll system to replace its legacy system.

2. Key Dates
Closing Date: December 18, 2026 at 2:00 PM.
Questions Deadline: December 4, 2026.

3. Mandatory Requirements
3.1 The solution must support position control and collective agreement rules.
3.2 The proponent shall provide three (3) references from school boards of similar size.
3.3 All data must be stored in Canada.
3.4 The proposal shall not exceed 40 pages.
3.5 The proponent must carry general liability insurance of $5,000,000.

4. Desirable Features
4.1 The system should provide an employee self service portal.

5. Contract
The term of the contract shall be three (3) years with an option to renew for two additional one-year terms.
The estimated budget is $1,200,000.
The Board may terminate this agreement for convenience.
Proposals shall remain valid for 90 days.
Liquidated damages of $1,000 per day apply to late delivery.

6. Evaluation
Technical approach 40%
Price 30%
`;
const PROPOSAL = `Our solution provides full position control with collective agreement rules configured per bargaining unit.

We provide three school board references of similar size who run our payroll system.

All customer data is hosted in Canadian data centres in Toronto and Montreal.`;

// ------------------------------------------------------------------ Understand
const reqs = mapRequirements(RFP);
a("requirements: mandatory and desirable", reqs.some((r) => r.level === "mandatory") && reqs.some((r) => r.level === "desirable"));
a("requirements: carry their section", reqs.find((r) => /position control/.test(r.text))?.section === "3 Mandatory Requirements");
a("requirements: categorised", reqs.find((r) => /insurance/.test(r.text))?.category === "insurance" && reqs.find((r) => /stored in Canada/.test(r.text))?.category === "data");
const kd = extractKeyData(RFP);
a("key data: dates", kd.dates.closing === "2026-12-18" && kd.dates.questions === "2026-12-04");
a("key data: term, renewals, value", kd.contractTerm === "3 years" && /renew/.test(kd.renewals) && kd.value.amount === 1200000);
a("key data: evaluation weights", kd.evaluation?.length === 2 && kd.evaluation[0].weight === 40);
a("key data: page limit, validity, references, insurance", kd.pageLimit === 40 && kd.validityDays === 90 && kd.references === 3 && kd.insurance?.[0].amount === 5000000);
const risks = flagRisks(RFP, kd.dates, NOW);
a("risks: liquidated damages is high", risks.find((r) => r.id === "liquidated-damages")?.severity === "high");
a("risks: termination, residency, insurance found", ["termination-convenience", "data-residency", "insurance-high"].every((id) => risks.some((r) => r.id === id)));
a("risks: each carries its sentence", risks.every((r) => r.evidence && r.evidence.length > 5));
a("risks: short timeline flagged", flagRisks("x", { closing: "2026-10-05" }, NOW).some((r) => r.id === "short-timeline" && r.severity === "high"));

const an = analyzeRfp({ text: RFP, proposalText: PROPOSAL, packs, now: NOW });
a("analysis: title guessed from the document", /REQUEST FOR PROPOSAL 2026-14/.test(an.title));
a("analysis: says how it works", /no language model/.test(an.method));
const byText = (re) => an.compliance.find((c) => re.test(an.requirements.find((r) => r.id === c.reqId).text));
a("compliance: addressed with evidence", byText(/position control/).status === "addressed" && /position control/i.test(byText(/position control/).evidence));
a("compliance: synonyms bridge hosted/stored, Canadian/Canada", byText(/stored in Canada/).status !== "missing");
a("compliance: missing when nothing matches", byText(/insurance/).status === "missing");
a("scores: every number has a reason", an.scores.reasons.length >= 5 && ["k12", "any"].includes(an.scores.industry?.id));
a("scores: coverage only with a proposal", analyzeRfp({ text: RFP, packs, now: NOW }).scores.coverage === null);
a("summary: evaluator summary", /## Key facts/.test(an.summary) && /## Risks/.test(an.summary) && /not by a person or a language model/.test(an.summary));

// ------------------------------------------------------------------ Qualify
const q = qualify(an, { buyer: "Example School Board", closeDate: "2026-12-18" });
a("qualify: verified facts name their source", q.verified.every((v) => v.from) && q.verified.some((v) => v.label === "Closing date"));
a("qualify: inferences kept apart and explained", q.inferred.every((v) => v.how) && q.inferred.some((v) => v.label === "Fit score"));
a("qualify: the five questions answered", q.matters.length && q.mayNotQualify.length && Array.isArray(q.infoRequired) && q.nextAction && Array.isArray(q.keyRisks));
a("qualify: a notice-only read asks for the full document", qualify(analyzeRfp({ text: "ERP implementation services for a school board. Closing soon.", packs, now: NOW })).infoRequired.some((x) => /full solicitation/.test(x)));

// ------------------------------------------------------------------ Discover: capabilities, feeds, relevance
a("capabilities: ERP and payroll recognised", matchCapabilities("RFP for ERP and Payroll System").map((m) => m.id).slice(0, 2).sort().join() === "erp,payroll");
const k12 = loadPack("k12");
const narrowed = packForSearch(k12, ["migration"]);
a("capabilities: search adds capability terms to the pack", narrowed.qualifiers.titleKeywords.includes("data migration") && narrowed.searchTerms.length > 0);
a("capabilities: any-industry search is the capability alone", !packForSearch(loadPack("any"), ["tms"]).qualifiers.titleKeywords.includes("ERP"));
const team = recommendTeam(matchCapabilities("HRIS and payroll implementation"));
a("route: team is roles only", Object.values(team).flat().every((v) => typeof v !== "string" || !/@/.test(v)) && /Practice/.test(team.solutionLead));
a("route: requirement owner by category", ownerForCategory("security") === "Security SME" && ownerForCategory("pricing") === "Commercial Lead");
a("general mode exists without any company", tenantIds()[0] === "all" && loadTenant("all").industries.includes("k12"));

const csv = 'a,b\n"x, y","line1\nline2"\n"he said ""hi""",2\n';
const rows = parseCsv(csv);
a("csv: quotes, commas and newlines inside fields", rows.length === 2 && rows[0].a === "x, y" && rows[0].b === "line1\nline2" && rows[1].a === 'he said "hi"');
const cb = extractPostings({ id: "cb", format: "canadabuys-csv", country: "CA", url: "https://canadabuys.canada.ca" },
  '"title-titre-eng","tenderDescription-descriptionAppelOffres-eng","tenderClosingDate-appelOffresDateCloture","contractingEntityName-nomEntitContractante-eng","noticeURL-URLavis-eng","publicationDate-datePublication","tenderStatus-appelOffresStatut-eng"\n"ERP Implementation","<p>Finance system</p>","2026-11-30T14:00:00","A Department","https://canadabuys.canada.ca/en/tender/1","2026-09-20","Open"\n');
a("feed: CanadaBuys row becomes a posting with dates and buyer", cb.postings[0].closeDate === "2026-11-30" && cb.postings[0].publishedDate === "2026-09-20" && cb.postings[0].buyer === "A Department" && cb.postings[0].body === "Finance system");
const sam = extractPostings({ id: "sam", format: "sam-sgs", country: "US", url: "https://sam.gov/api/prod/sgs/v1/search/" }, { results: [
  { _id: "abc", title: "Courier services", type: { value: "Solicitation" }, responseDate: "2026-10-20T17:00:00+00:00", publishDate: "2026-09-22T00:00:00+00:00", descriptions: [{ content: "<p>Medical courier</p>" }], organizationHierarchy: [{ name: "DEPT" }, { name: "OFFICE" }] },
  { _id: "def", title: "Award", type: { value: "Award Notice" } }] });
a("feed: SAM notice parsed, awards skipped", sam.postings.length === 1 && sam.postings[0].url === "https://sam.gov/opp/abc/view" && sam.postings[0].buyer === "OFFICE");
const lm = loadPack("logistics-lastmile-tms");
a("relevance: one stray body word is not a match", score({ title: "VALVE REG, 4.0 IPS", body: "delivery to warehouse", country: "US" }, lm, { geography: ["US"] }).band === "dropped");

// ------------------------------------------------------------------ Answer, build, red-team
const empty = draftAnswers(an.requirements, [], {});
a("answer: no knowledge means SME validation, never invented text", empty.every((x) => x.validationRequired && /SME validation required/.test(x.draft) && x.sources.length === 0 && x.status === "Not started"));
const kb = [
  { id: "kb-hr-1", question: "Describe position control and collective agreement support", answer: "Position control is configured per bargaining unit, with collective agreement rules for seniority and pay.", tags: ["position control", "collective agreement"], lastReviewed: "2026-08-01", reviewEveryDays: 180 },
  { id: "kb-old", question: "Where is customer data stored", answer: "Customer data is stored in Canada.", tags: ["data residency", "stored in canada"], lastReviewed: "2024-01-01", reviewEveryDays: 180 },
];
const ans = draftAnswers(an.requirements, kb, { now: NOW });
const pc = ans.find((x) => /position control/.test(x.requirement));
a("answer: approved answer drafted with its citation", pc.status === "Drafted" && /knowledge kb-hr-1/.test(pc.draft) && pc.sources[0].id === "kb-hr-1");
a("answer: confidence and owner set", ["high", "medium"].includes(pc.confidence) && pc.owner);
const res = ans.find((x) => /stored in Canada/.test(x.requirement));
a("answer: stale source is flagged and never high confidence", res.sources.some((s) => s.id === "kb-old" && s.stale) && res.confidence !== "high");
const prop = buildProposal(an, ans, { text: RFP, buyer: "Example School Board" });
a("proposal: customer's own problem statement quoted", /seeking a financial management system/.test(prop));
a("proposal: sections in the customer's numbering", /### 3 Mandatory Requirements/.test(prop));
a("proposal: pricing never drafted", /Pricing is never drafted automatically/.test(prop));
a("proposal: compliance matrix", /## 4\. Compliance matrix/.test(prop));
const rt = redTeam(an, ans, prop, { now: NOW });
a("red-team: not ready while mandatory answers are unapproved", rt.readiness === "Needs review" && rt.blocking.some((b) => /mandatory/.test(b)));
a("red-team: stale citations block", rt.blocking.some((b) => /STALE/.test(b)));
const approved = ans.map((x) => ({ ...x, status: "Final", validationRequired: false, sources: x.sources.map((s) => ({ ...s, stale: false })) }));
const rt2 = redTeam(an, approved, "A clean, specific response for the board.", { now: NOW });
a("red-team: ready once everything is final", rt2.readiness === "Ready" && rt2.blocking.length === 0);
a("red-team: generic phrasing warned", redTeam(an, approved, "Our world-class, best-in-class seamless platform", { now: NOW }).warnings.some((w) => /Generic phrasing/.test(w)));

// ------------------------------------------------------------------ export and bundle
const wb = await buildAnalysisWorkbook(ExcelJS, an, { answers: ans, redTeam: rt, team, proposal: prop });
a("export: scoring workbook has every sheet", ["Summary", "Scores", "Requirements", "Compliance", "Key data", "Risks", "Responses", "Team", "Readiness", "Proposal draft"].every((n) => wb.getWorksheet(n)));
const buf = Buffer.from(await wb.xlsx.writeBuffer());
a("export: valid xlsx", buf.subarray(0, 2).toString() === "PK" && buf.length > 5000);
const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(browserBundle(), ctx);
a("bundle: browser build exposes the same steps", ["analyzeRfp", "qualify", "draftAnswers", "buildProposal", "redTeam", "buildAnalysisWorkbook", "matchCapabilities"].every((k) => typeof ctx.window.RFP[k] === "function"));
a("bundle: browser result equals Node result", ctx.window.RFP.analyzeRfp({ text: RFP, packs, now: NOW }).scores.overall === analyzeRfp({ text: RFP, packs, now: NOW }).scores.overall);

console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nall ${passes} analysis assertions passed`);
process.exit(fails ? 1 : 0);
