/**
 * The SME review workbook: the format bid teams already use to review drafted
 * answers with subject-matter experts.
 *
 *   Instructions  how to use the file, status meanings, open items
 *   SME Review    # | Section | SME | Question | Draft Answer | SME Notes / Edits | Status
 *
 * Export fills it from a response workspace; import reads SME edits, notes and
 * status back. Takes the ExcelJS constructor so it runs in Node and the browser.
 * Import-free.
 */
export const SME_STATUSES = ["Not started", "In review", "Approved", "Needs edit", "Question for vendor"];

/** SME review status → workspace response status. */
export const SME_TO_RESPONSE = { "Not started": "Not started", "In review": "SME review", "Approved": "Approved", "Needs edit": "Needs revision", "Question for vendor": "SME review", "Question for Sparkrock": "SME review" };
const RESPONSE_TO_SME = { "Not started": "Not started", Drafted: "In review", "SME review": "In review", Approved: "Approved", "Needs revision": "Needs edit", Final: "Approved" };

const cellText = (v) => (v == null ? "" : typeof v === "object" ? (v.text ?? v.result ?? (v.richText ? v.richText.map((r) => r.text).join("") : "")) : String(v)).trim();

export async function buildSmeReviewWorkbook(ExcelJS, { title = "RFP", buyer = "", answers = [], openItems = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ionic-rfp-sweeper";
  const ins = wb.addWorksheet("Instructions");
  ins.getColumn(1).width = 110;
  [
    "How to use this file",
    "",
    `SME review of the drafted answers for: ${title}${buyer ? ` (${buyer})` : ""}.`,
    "Columns:",
    "  #  -  RFP question number, matching the original numbering.",
    "  Section  -  the RFP section each question belongs to.",
    "  SME  -  the reviewer (role or initials).",
    "  Question  -  the full question as asked in the RFP.",
    "  Draft Answer  -  the current draft for review. Edit it directly or leave edits in the notes.",
    "  SME Notes / Edits  -  comments, corrections, suggested edits.",
    `  Status  -  ${SME_STATUSES.join(", ")}.`,
    "",
    "House rules for answers:",
    "  - Never name a customer. Say \"at a comparable [sector, country] organization\".",
    "  - Answer every part of the question, in the order asked.",
    "  - Use the buyer's own terms and systems. Say what is standard and what needs extra licensing or configuration.",
    "  - If we lack direct experience, say so and give the closest comparable experience.",
    "  - Numbers, references and certifications must come from an approved source.",
    ...(openItems.length ? ["", "Open items still being worked through:", ...openItems.map((x) => `  ${x}`)] : []),
    "",
    "When done, load this file back with Import SME review in the dashboard.",
  ].forEach((t, i) => { const c = ins.getCell(i + 1, 1); c.value = t; if (i === 0) c.font = { bold: true, size: 14 }; c.alignment = { wrapText: true }; });

  const ws = wb.addWorksheet("SME Review");
  ws.columns = [
    { header: "#", key: "id", width: 9 }, { header: "Section", key: "section", width: 28 }, { header: "SME", key: "sme", width: 14 },
    { header: "Question", key: "question", width: 60 }, { header: "Draft Answer", key: "answer", width: 90 },
    { header: "SME Notes / Edits", key: "notes", width: 40 }, { header: "Status", key: "status", width: 16 },
  ];
  ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } }; });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const a of answers) {
    const row = ws.addRow({ id: a.reqId, section: a.section === "—" ? "" : a.section, sme: a.owner ?? "", question: a.requirement, answer: String(a.draft ?? "").replace(/\n\n\[source: knowledge [^\]]+\]$/, ""), notes: a.smeNotes ?? "", status: RESPONSE_TO_SME[a.status] ?? "Not started" });
    row.alignment = { vertical: "top", wrapText: true };
    for (const k of ["answer", "notes", "status"]) row.getCell(k).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7D6" } };
    row.getCell("status").dataValidation = { type: "list", allowBlank: true, formulae: [`"${SME_STATUSES.join(",")}"`], showErrorMessage: true };
  }
  return wb;
}

/** Read an SME review workbook (ours, or one in the same layout). */
export async function parseSmeReviewWorkbook(ExcelJS, input) {
  const wb = new ExcelJS.Workbook();
  if (typeof input === "string") await wb.xlsx.readFile(input); else await wb.xlsx.load(input);
  const ws = wb.getWorksheet("SME Review") ?? wb.worksheets.find((w) => /review/i.test(w.name)) ?? wb.worksheets[1] ?? wb.worksheets[0];
  const head = {};
  ws.getRow(1).eachCell((c, i) => { head[cellText(c.value).toLowerCase()] = i; });
  const col = (...names) => names.map((n) => head[n]).find(Boolean);
  const c = { id: col("#", "no", "number"), section: col("section"), sme: col("sme", "owner"), question: col("question"), answer: col("draft answer", "answer", "response"), notes: col("sme notes / edits", "sme notes", "notes"), status: col("status") };
  if (!c.question || !c.answer) throw new Error("Not an SME review workbook: needs Question and Draft Answer columns.");
  const rows = [];
  ws.eachRow((r, n) => {
    if (n === 1) return;
    const get = (k) => (c[k] ? cellText(r.getCell(c[k]).value) : "");
    if (!get("question")) return;
    rows.push({ id: get("id"), section: get("section"), sme: get("sme"), question: get("question"), answer: get("answer"), notes: get("notes"), status: get("status") });
  });
  const insSheet = wb.getWorksheet("Instructions");
  const instructions = [];
  insSheet?.eachRow((r) => instructions.push(cellText(r.getCell(1).value)));
  // "Open items" lines in the instructions name question numbers still being worked on.
  const openIds = new Set((instructions.join("\n").match(/\b\d+(?:\.\d+){1,3}\b/g) ?? []));
  return { rows, instructions, openIds: [...openIds] };
}

/** Apply SME edits to workspace answers, matched by question number or question text. */
export function applySmeReview(answers, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const norm = (s) => String(s).toLowerCase().replace(/\W+/g, " ").trim().slice(0, 140);
  const byQ = new Map(rows.map((r) => [norm(r.question), r]));
  let applied = 0;
  for (const a of answers) {
    const r = byId.get(a.reqId) ?? byQ.get(norm(a.requirement));
    if (!r) continue;
    if (r.answer && r.answer !== a.draft) a.draft = r.answer;
    if (r.notes) a.smeNotes = r.notes;
    if (r.status && SME_TO_RESPONSE[r.status]) a.status = SME_TO_RESPONSE[r.status];
    if (a.status === "Approved") a.validationRequired = false;
    applied++;
  }
  return applied;
}

export default { SME_STATUSES, SME_TO_RESPONSE, buildSmeReviewWorkbook, parseSmeReviewWorkbook, applySmeReview };
