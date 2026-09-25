/**
 * Export RFP responses into the company's own template.
 *
 *   Word (.docx) with {{tags}}   filled in place: {{title}}, {{buyer}}, a {{#responses}} loop…
 *   Word (.docx) without tags    the responses are added after the template's own content,
 *                                in its heading styles, so letterhead, headers and footers stay
 *   Excel (.xlsx)                the sheet with a Question/Requirement column and an
 *                                Answer/Response column is filled, matching existing questions
 *   no template                  a built-in Word layout
 *
 * Runs in the browser (and in Node for tests): the zip, Word-template and Excel
 * libraries are passed in. Nothing is uploaded; nothing is invented. SME markers
 * stay in the text so nothing unconfirmed slips into a submission.
 *
 * Import-free: the browser bundle inlines it.
 */

export const TEMPLATE_TAGS = [
  ["company", "Your company's name"], ["title", "RFP title"], ["buyer", "Buyer"], ["reference", "Solicitation reference"],
  ["closeDate", "Closing date"], ["questionsDeadline", "Questions deadline"], ["date", "Today's date"], ["sourceUrl", "Link to the solicitation"],
  ["status", "Pipeline status"], ["executiveSummary", "Executive summary"], ["proposal", "The whole proposal draft"],
  ["#responses … /responses", "Repeat for each requirement: {{reqId}} {{section}} {{requirement}} {{answer}} {{status}} {{owner}}"],
  ["#keyFacts … /keyFacts", "Repeat for each key fact: {{label}} {{value}}"],
];

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (v) => `$${Math.round(v).toLocaleString("en-US")}`;
export const slugify = (s) => String(s || "rfp").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "rfp";

/** An answer as it should appear in a document: without internal source notes. */
export const cleanAnswer = (draft) => String(draft ?? "").replace(/\n*\[source:[^\]]*\]/g, "").replace(/\n*Closest approved answer[^\n]*/g, "").trim();
/** Markdown from the proposal builder, as plain text. */
export const plainText = (md) => String(md ?? "").replace(/^#{1,6}\s+/gm, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1$2").replace(/^>\s?/gm, "").replace(/\n{3,}/g, "\n\n").trim();
const section = (md, n) => { const m = String(md ?? "").match(new RegExp(`##\\s*${n}\\.[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`)); return m ? plainText(m[1]) : ""; };

/** Everything a template can use, for one opportunity. */
export function responseData(f, { answers = [], proposal = "", company = "", now = new Date() } = {}) {
  const k = f.rfp?.keyData ?? f.workspace?.analysis?.keyData ?? {};
  const q = k.dates?.questions ?? f.keyDates?.questions ?? "";
  const value = f.estimatedValue ?? k.value?.amount ?? null;
  const facts = [
    ["Buyer", f.buyer], ["Closing date", f.closeDate], ["Questions deadline", q], ["Stated value", value != null ? money(value) : ""],
    ["Contract term", k.contractTerm ? `${k.contractTerm}${k.renewals ? ` (${k.renewals})` : ""}` : ""],
    ["Evaluation", (k.evaluation ?? []).map((e) => (e.weight != null ? `${e.criterion} ${e.weight}${e.unit === "%" ? "%" : " pts"}` : e.criterion)).join("; ")],
    ["Basis of award", k.evaluationBasis ?? ""], ["Solicitation", f.url ?? ""],
  ].filter(([, v]) => v).map(([label, value]) => ({ label, value: String(value) }));
  return {
    company: company || "[Company name]", title: f.title ?? "", buyer: f.buyer ?? "", reference: f.sourceId ?? f.id ?? "", closeDate: f.closeDate ?? "", questionsDeadline: q,
    date: now.toISOString().slice(0, 10), sourceUrl: f.url ?? "", status: f.status ?? "", executiveSummary: section(proposal, 1), proposal: plainText(proposal),
    responses: answers.map((a) => ({ reqId: a.reqId ?? "", section: a.section ?? "", requirement: a.requirement ?? "", answer: cleanAnswer(a.draft), status: a.status ?? "", owner: a.owner ?? "", confidence: a.confidence ?? "", level: a.level ?? "" })),
    keyFacts: facts,
  };
}

/** The {{tags}} a Word template uses (read from its text, even when Word split a tag across runs). */
export function templateTags(PizZip, buffer) {
  const zip = new PizZip(buffer);
  const parts = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n));
  const text = parts.map((n) => zip.file(n).asText().replace(/<w:tab\/>/g, " ").replace(/<[^>]+>/g, "")).join(" ");
  return [...new Set([...text.matchAll(/\{\{\s*([#/^]?[\w.]+)\s*\}\}/g)].map((m) => m[1]))];
}

const run = (text, bold = false) => String(text).split("\n").map((line, i) => `${i ? "<w:r><w:br/></w:r>" : ""}<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`).join("");

/** Fill a Word template: its {{tags}} if it has them, else the responses after its own content. */
export function fillDocx({ PizZip, Docxtemplater }, buffer, data) {
  if (templateTags(PizZip, buffer).length) {
    const doc = new Docxtemplater(new PizZip(buffer), { paragraphLoop: true, linebreaks: true, delimiters: { start: "{{", end: "}}" }, nullGetter: () => "" });
    doc.render(data);
    return doc.getZip().generate({ type: "uint8array", compression: "DEFLATE" });
  }
  const zip = new PizZip(buffer);
  const styles = zip.file("word/styles.xml")?.asText() ?? "";
  const has = (id) => styles.includes(`w:styleId="${id}"`);
  const p = (text, style) => `<w:p>${style && has(style) ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${run(text, !!style && !has(style))}</w:p>`;
  const body = [
    p(data.title, "Heading1"), p(`${data.company} · response to ${data.buyer}${data.closeDate ? ` · closes ${data.closeDate}` : ""}`),
    ...(data.executiveSummary ? [p("Executive summary", "Heading2"), p(data.executiveSummary)] : []),
    ...(data.keyFacts.length ? [p("Key facts", "Heading2"), ...data.keyFacts.map((x) => p(`${x.label}: ${x.value}`))] : []),
    p("Responses", "Heading2"),
    ...data.responses.flatMap((r) => [p(`${r.reqId} ${r.requirement}`.trim(), "Heading3"), p(r.answer || "[SME validation required]")]),
  ].join("");
  const xml = zip.file("word/document.xml").asText();
  const at = xml.lastIndexOf("<w:sectPr") > -1 ? xml.lastIndexOf("<w:sectPr") : xml.lastIndexOf("</w:body>");
  zip.file("word/document.xml", xml.slice(0, at) + body + xml.slice(at));
  return zip.generate({ type: "uint8array", compression: "DEFLATE" });
}

/** The built-in Word layout (and the sample template people download to start their own). */
export function defaultTemplate(PizZip) {
  const zip = new PizZip();
  const P = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  const heading = (id, name, size) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${heading("Title", "Title", 40)}${heading("Heading1", "heading 1", 32)}${heading("Heading2", "heading 2", 26)}${heading("Heading3", "heading 3", 23)}</w:styles>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
    P("{{title}}", "Title"),
    P("Response from {{company}} to {{buyer}}"),
    P("Reference {{reference}} · Closing {{closeDate}} · Questions due {{questionsDeadline}}"),
    P("Executive summary", "Heading1"), P("{{executiveSummary}}"),
    P("Key facts", "Heading1"), P("{{#keyFacts}}"), P("{{label}}: {{value}}"), P("{{/keyFacts}}"),
    P("Responses", "Heading1"), P("{{#responses}}"), P("{{reqId}} {{requirement}}", "Heading3"), P("{{answer}}"), P("{{/responses}}"),
    P("Prepared {{date}}. First draft: proofread and confirm every answer before submission."),
  ].join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generate({ type: "uint8array", compression: "DEFLATE" });
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const overlap = (a, b) => { const A = new Set(norm(a).split(" ").filter((w) => w.length > 3)), B = new Set(norm(b).split(" ").filter((w) => w.length > 3)); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };

/** Fill an Excel template: the sheet whose header has a question column and an answer column. */
export async function fillXlsx(ExcelJS, buffer, data) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  let target = null;
  for (const ws of wb.worksheets) {
    for (let r = 1; r <= Math.min(ws.rowCount, 15) && !target; r++) {
      const cols = {};
      ws.getRow(r).eachCell((c, i) => {
        const t = norm(c.text), raw = String(c.text ?? "").trim().toLowerCase();
        if (!cols.id && /^(#|no\.?|id|number|ref\.?|reference|item|item #|req\.? ?(id|#)?)$/.test(raw)) cols.id = i;
        else if (!cols.q && /\b(question|requirement|item description|criteria|criterion)\b/.test(t)) cols.q = i;
        else if (!cols.a && /\b(answer|response|draft|proposal|vendor|proponent|reply)\b/.test(t)) cols.a = i;
        else if (!cols.section && /\bsection\b/.test(t)) cols.section = i;
        else if (!cols.status && /\bstatus\b/.test(t)) cols.status = i;
        else if (!cols.owner && /\b(sme|owner|responsible|author)\b/.test(t)) cols.owner = i;
      });
      if (cols.q && cols.a) target = { ws, header: r, cols };
    }
    if (target) break;
  }
  if (!target) throw new Error("The Excel template needs a header row with a Question (or Requirement) column and an Answer (or Response) column.");
  const { ws, header, cols } = target;
  const existing = [];
  for (let r = header + 1; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(cols.q).text.trim()) existing.push(r);
  if (existing.length) {
    // The buyer's own questionnaire: answer each of its questions with the closest drafted response.
    let filled = 0;
    for (const r of existing) {
      const qText = ws.getRow(r).getCell(cols.q).text;
      const idText = cols.id ? ws.getRow(r).getCell(cols.id).text.trim() : "";
      const best = data.responses.map((x) => ({ x, s: idText && x.reqId === idText ? 1 : overlap(qText, x.requirement) })).sort((p, q) => q.s - p.s)[0];
      if (best && best.s >= 0.5) { ws.getRow(r).getCell(cols.a).value = best.x.answer; if (cols.status) ws.getRow(r).getCell(cols.status).value = best.x.status; filled++; }
      else ws.getRow(r).getCell(cols.a).value = "[SME validation required] No drafted response matches this question.";
    }
    data.filledRows = filled;
  } else {
    const style = ws.getRow(header + 1);
    data.responses.forEach((x, i) => {
      const row = ws.getRow(header + 1 + i);
      if (cols.id) row.getCell(cols.id).value = x.reqId;
      if (cols.section) row.getCell(cols.section).value = x.section;
      row.getCell(cols.q).value = x.requirement;
      row.getCell(cols.a).value = x.answer;
      if (cols.status) row.getCell(cols.status).value = x.status;
      if (cols.owner) row.getCell(cols.owner).value = x.owner;
      if (i && style) row.eachCell((c, n) => { const s = style.getCell(n).style; if (s) c.style = { ...s }; });
      row.alignment = { wrapText: true, vertical: "top" };
    });
    data.filledRows = data.responses.length;
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** One workbook with every exported answer: easy to review, sort and hand to SMEs. */
export async function summaryWorkbook(ExcelJS, items, { pipeline = "" } = {}) {
  const wb = new ExcelJS.Workbook();
  const o = wb.addWorksheet("Opportunities");
  o.columns = [{ header: "Opportunity", key: "t", width: 50 }, { header: "Buyer", key: "b", width: 32 }, { header: "Closes", key: "c", width: 12 }, { header: "Status", key: "s", width: 12 }, { header: "Answers", key: "n", width: 9 }, { header: "Need SME", key: "m", width: 10 }, { header: "File", key: "f", width: 44 }];
  const r = wb.addWorksheet("Responses");
  r.columns = [{ header: "Opportunity", key: "t", width: 40 }, { header: "Req", key: "id", width: 10 }, { header: "Section", key: "sec", width: 18 }, { header: "Level", key: "lvl", width: 11 }, { header: "Requirement", key: "q", width: 60 }, { header: "Answer", key: "a", width: 80 }, { header: "Status", key: "s", width: 12 }, { header: "Confidence", key: "c", width: 11 }, { header: "Owner", key: "o", width: 20 }];
  for (const it of items) {
    const d = it.data;
    o.addRow({ t: d.title, b: d.buyer, c: d.closeDate, s: d.status, n: d.responses.length, m: d.responses.filter((x) => /\[SME/.test(x.answer) || x.confidence !== "high").length, f: it.file });
    for (const x of d.responses) r.addRow({ t: d.title, id: x.reqId, sec: x.section, lvl: x.level, q: x.requirement, a: x.answer, s: x.status, c: x.confidence, o: x.owner }).alignment = { wrapText: true, vertical: "top" };
  }
  for (const ws of [o, r]) { ws.getRow(1).font = { bold: true }; ws.views = [{ state: "frozen", ySplit: 1 }]; }
  o.addRow({});
  o.addRow({ t: `Pipeline: ${pipeline}. First drafts: proofread and confirm every answer before submission.` });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/**
 * The export: one filled document per opportunity (your template, or the built-in
 * Word layout), plus the summary workbook, in one zip.
 */
export async function exportResponses(libs, items, { template = null, pipeline = "", includeSummary = true } = {}) {
  const { PizZip, ExcelJS } = libs;
  const zip = new PizZip();
  const kind = template ? (/\.xlsx$/i.test(template.name) ? "xlsx" : "docx") : "docx";
  const base = template ? template.buffer : defaultTemplate(PizZip);
  const used = new Set();
  const done = [];
  for (const it of items) {
    let name = `${slugify(it.data.title)}-response.${kind}`;
    for (let n = 2; used.has(name); n++) name = `${slugify(it.data.title)}-response-${n}.${kind}`;
    used.add(name);
    const bytes = kind === "xlsx" ? await fillXlsx(ExcelJS, base, it.data) : fillDocx(libs, base, it.data);
    zip.file(name, bytes);
    done.push({ ...it, file: name });
  }
  if (includeSummary) zip.file("all-responses.xlsx", await summaryWorkbook(ExcelJS, done, { pipeline }));
  zip.file("README.txt", [`RFP responses: ${pipeline}`, `Exported ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, `Template: ${template ? template.name : "built-in Word layout"}`, "", ...done.map((d) => `- ${d.file}: ${d.data.title} (${d.data.responses.length} answers)`), "", "These are first drafts. Anything marked [SME validation required] needs an SME; proofread and check the RFP submission status before submitting."].join("\r\n"));
  return { bytes: zip.generate({ type: "uint8array", compression: "DEFLATE" }), files: done.map((d) => d.file), kind };
}

export default { TEMPLATE_TAGS, slugify, cleanAnswer, plainText, responseData, templateTags, fillDocx, defaultTemplate, fillXlsx, summaryWorkbook, exportResponses };
