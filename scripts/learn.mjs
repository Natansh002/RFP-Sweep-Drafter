#!/usr/bin/env node
/**
 * Learn from a completed SME review workbook: turn its reviewed answers into
 * reusable knowledge-base entries for the Answer step.
 *
 *   npm run learn -- --file "path/to/SME_Review.xlsx" [--buyer TPL] [--dry-run]
 *
 * Writes library/private/knowledge.local.json, which is gitignored: reviewed
 * answers are company-confidential and never leave this machine. The buyer's
 * name is replaced with {buyer} so an answer can be reused for the next buyer.
 * Items the instructions list as still open are saved without a review date, so
 * the drafter marks them STALE until a person confirms them.
 */
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { ROOT } from "../lib/config.mjs";
import { parseSmeReviewWorkbook } from "../lib/smereview.mjs";
import { tokens } from "../lib/analyze.mjs";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const file = opt("file");
if (!file || !fs.existsSync(file)) { console.error('usage: npm run learn -- --file "<SME review .xlsx>" [--buyer <name or acronym>] [--dry-run]'); process.exit(2); }

const { rows, openIds } = await parseSmeReviewWorkbook(ExcelJS, file);
const COMMON = new Set("ERP BC GP PO POS AP AR GL HR HRP HCM IT ITS SSO MFA UAT SAML API SFTP OCR CRA EFT MICR CPA KPI RFP RFI RFQ SLA SOW PCR CSM PDF CSV USA US CA TD BMO QA AI ILS SQL M365 SaaS EDI ACH".split(" "));
// The buyer is the acronym the answers use most (e.g. "TPL"), unless given.
let buyer = opt("buyer");
if (!buyer) {
  const counts = {};
  for (const r of rows) for (const m of r.answer.matchAll(/\b[A-Z]{2,6}\b/g)) if (!COMMON.has(m[0])) counts[m[0]] = (counts[m[0]] ?? 0) + 1;
  buyer = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const generic = (t) => (buyer ? t.replace(new RegExp(`\\b${esc(buyer)}('s)?\\b`, "g"), (m, s) => `{buyer}${s ?? ""}`) : t);
const reviewed = fs.statSync(file).mtime.toISOString().slice(0, 10);
const slug = path.basename(file).replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
const topTags = (q) => [...new Set(tokens(q))].slice(0, 8);

const entries = rows.filter((r) => r.answer.trim()).map((r) => ({
  id: `kb-${slug}-${r.id || rows.indexOf(r) + 1}`,
  question: generic(r.question),
  answer: generic(r.answer.trim()),
  tags: [r.section, ...topTags(r.question)].filter(Boolean),
  section: r.section,
  owner: r.sme ? `SME (${r.section || "general"})` : null,
  lastReviewed: openIds.includes(r.id) ? null : reviewed,
  reviewEveryDays: 365,
  source: { workbook: path.basename(file), question: r.id, buyerPlaceholder: buyer ? "{buyer}" : null },
  reviewNotes: r.notes ? "SME notes were applied in this version" : null,
}));

const out = path.join(ROOT, "library", "private", "knowledge.local.json");
const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")).entries ?? [] : [];
const merged = [...prev.filter((e) => !entries.some((n) => n.id === e.id)), ...entries];
console.log(`${rows.length} question(s) read; ${entries.length} answer(s) learned; buyer "${buyer || "none"}" → {buyer}; ${entries.filter((e) => !e.lastReviewed).length} open item(s) saved as STALE.`);
if (args.includes("--dry-run")) { console.log("Dry run: nothing written."); process.exit(0); }
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ $comment: "PRIVATE. Learned from SME-reviewed RFP answers. Gitignored; never published.", entries: merged }, null, 2) + "\n");
console.log(`Knowledge base: ${out} (${merged.length} entries, local only)`);
