#!/usr/bin/env node
/**
 * Analyze an RFP document from the command line: the same five steps as the
 * dashboard, plus drafted answers, the proposal draft and the red-team check.
 *
 *   npm run analyze -- --rfp path/to/rfp.pdf [--proposal draft.docx] [--title "..."]
 *
 * Writes output/<name>-rfp-scoring.xlsx and output/<name>-summary.md.
 * Reads PDF, DOCX, TXT, MD and HTML. Nothing leaves this machine.
 */
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { ROOT, industryIds, loadPack, loadData } from "../lib/config.mjs";
import { analyzeRfp } from "../lib/analyze.mjs";
import { draftAnswers, buildProposal, redTeam } from "../lib/respond.mjs";
import { matchCapabilities, recommendTeam } from "../lib/capabilities.mjs";
import { buildAnalysisWorkbook } from "../lib/analysis-excel.mjs";
import { pageText } from "../lib/enrich.mjs";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

export async function readDocument(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, verbosity: 0 }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      pages.push(tc.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("").replace(/[ \t]{2,}/g, " "));
    }
    return pages.join("\n\n");
  }
  if (ext === ".docx") {
    const mammoth = (await import("mammoth")).default;
    return (await mammoth.extractRawText({ path: file })).value;
  }
  const raw = fs.readFileSync(file, "utf8");
  return /\.html?$/.test(ext) ? pageText(raw) : raw;
}

const rfp = opt("rfp");
if (!rfp || !fs.existsSync(rfp)) { console.error("usage: npm run analyze -- --rfp <file> [--proposal <file>] [--title <title>]"); process.exit(2); }
const text = await readDocument(rfp);
const proposalText = opt("proposal") ? await readDocument(opt("proposal")) : "";
const packs = industryIds().map(loadPack);
const matrix = loadData("config/capability-matrix.json") ?? undefined;
const a = analyzeRfp({ text, title: opt("title") ?? "", source: path.basename(rfp), proposalText, packs });
const knowledge = [...(loadData("library/knowledge.json")?.entries ?? []), ...(loadData("library/private/knowledge.local.json")?.entries ?? [])];
const answers = draftAnswers(a.requirements, knowledge, { matrix, buyer: opt("buyer") ?? "" });
const proposal = buildProposal(a, answers, { text });
const rt = redTeam(a, answers, proposal);
const team = recommendTeam(matchCapabilities(a.title, text), matrix);

const name = path.basename(rfp).replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });
const xlsx = path.join(ROOT, "output", `${name}-rfp-scoring.xlsx`);
await (await buildAnalysisWorkbook(ExcelJS, a, { answers, redTeam: rt, team, proposal })).xlsx.writeFile(xlsx);
const md = path.join(ROOT, "output", `${name}-summary.md`);
fs.writeFileSync(md, `${a.summary}\n\n---\n\n${proposal}\n`);
console.log(`${a.title}\nOverall ${a.scores.overall} (${a.scores.band}) · fit ${a.scores.fit} · risk ${a.scores.risk} · timeline ${a.scores.timeline}${a.scores.coverage == null ? "" : ` · coverage ${a.scores.coverage}`}`);
console.log(`${a.requirements.length} requirement(s), ${a.risks.length} risk flag(s), readiness: ${rt.readiness}`);
console.log(`\nScoring file: ${xlsx}\nSummary + proposal draft: ${md}`);
