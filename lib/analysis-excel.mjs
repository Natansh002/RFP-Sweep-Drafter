/**
 * The scoring file: one analysis as an Excel workbook.
 *
 * Takes the ExcelJS constructor as an argument so the same code runs in Node
 * (import ExcelJS) and in the browser (the vendored exceljs.min.js global).
 * Import-free on purpose.
 *
 * Sheets: Summary, Scores, Requirements, Compliance, Key data, Risks.
 */
export async function buildAnalysisWorkbook(ExcelJS, a, extra = {}) {
  const { answers = null, redTeam = null, team = null, proposal = null } = extra;
  const wb = new ExcelJS.Workbook();
  wb.creator = "ionic-rfp-sweeper";
  wb.created = new Date();
  const HEAD = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const SEV = { high: "FFFEE2E2", medium: "FFFEF3C7", low: "FFE0F2FE" };
  const STATUS = { addressed: "FFD1FAE5", partial: "FFFEF3C7", missing: "FFFEE2E2" };
  const sheet = (name, cols) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols;
    const h = ws.getRow(1);
    h.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = HEAD; c.alignment = { vertical: "middle", wrapText: true }; });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    return ws;
  };
  const wrap = (row) => { row.alignment = { vertical: "top", wrapText: true }; return row; };

  // Summary
  const s = wb.addWorksheet("Summary");
  s.getColumn(1).width = 120;
  a.summary.split("\n").forEach((line, i) => {
    const c = s.getCell(i + 1, 1);
    c.value = line.replace(/\*\*/g, "").replace(/^#+\s*/, "");
    if (/^# /.test(line)) c.font = { bold: true, size: 14 };
    else if (/^## /.test(line)) c.font = { bold: true, size: 12 };
    c.alignment = { wrapText: true, vertical: "top" };
  });

  // Scores
  const sc = sheet("Scores", [{ header: "Measure", key: "k", width: 18 }, { header: "Score (0–100)", key: "v", width: 14 }, { header: "Weight in overall", key: "w", width: 16 }]);
  const sco = a.scores;
  for (const k of ["overall", "fit", "risk", "timeline", "coverage"]) {
    if (sco[k] == null) continue;
    const r = sc.addRow({ k: k[0].toUpperCase() + k.slice(1), v: sco[k], w: k === "overall" ? sco.band : sco.weights[k] != null ? `${sco.weights[k]}%` : "" });
    if (k === "overall") r.font = { bold: true };
  }
  sc.addRow({});
  sc.addRow({ k: "Why" }).font = { bold: true };
  for (const why of sco.reasons) wrap(sc.addRow({ k: "", v: why }));
  sc.getColumn(2).width = 100;
  sc.addRow({});
  sc.addRow({ k: "Method", v: a.method });
  sc.addRow({ k: "Analyzed", v: a.analyzedAt });
  if (a.source) sc.addRow({ k: "Source", v: a.source });

  // Requirements
  const cmap = Object.fromEntries((a.compliance ?? []).map((c) => [c.reqId, c]));
  const rq = sheet("Requirements", [
    { header: "ID", key: "id", width: 10 }, { header: "Section", key: "section", width: 28 }, { header: "Level", key: "level", width: 11 },
    { header: "Category", key: "category", width: 14 }, { header: "Requirement", key: "text", width: 90 },
    { header: "Compliance", key: "status", width: 12 }, { header: "Owner", key: "owner", width: 16 }, { header: "Response section", key: "resp", width: 18 },
  ]);
  for (const r of a.requirements) {
    const c = cmap[r.id];
    const row = wrap(rq.addRow({ ...r, status: c?.status ?? "" }));
    if (r.level === "mandatory") row.getCell("level").font = { bold: true };
    if (c) row.getCell("status").fill = fill(STATUS[c.status]);
  }
  rq.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 8 } };

  // Compliance
  const cp = sheet("Compliance", [
    { header: "Req ID", key: "reqId", width: 10 }, { header: "Level", key: "level", width: 11 }, { header: "Status", key: "status", width: 12 },
    { header: "Similarity", key: "similarity", width: 11 }, { header: "Requirement", key: "req", width: 70 }, { header: "Best-matching proposal passage", key: "evidence", width: 80 },
  ]);
  if (a.compliance) {
    const rmap = Object.fromEntries(a.requirements.map((r) => [r.id, r]));
    for (const c of a.compliance) wrap(cp.addRow({ ...c, req: rmap[c.reqId]?.text ?? "" })).getCell("status").fill = fill(STATUS[c.status]);
  } else cp.addRow({ reqId: "—", req: "No proposal was supplied, so compliance was not screened. Add a draft proposal and analyze again." });

  // Key data
  const kd = sheet("Key data", [{ header: "Item", key: "k", width: 28 }, { header: "Value", key: "v", width: 90 }]);
  const d = a.keyData.dates ?? {};
  const add = (k, v) => v != null && v !== "" && kd.addRow({ k, v });
  add("Closing date", d.closing); add("Questions deadline", d.questions); add("Pre-bid meeting", d.preBid); add("Site visit", d.siteVisit); add("Expected award", d.award);
  add("Contract term", a.keyData.contractTerm); add("Renewal options", a.keyData.renewals);
  add("Value", a.keyData.value ? `${a.keyData.value.amount.toLocaleString("en-US")} (${a.keyData.value.context})` : null);
  add("Submission", a.keyData.submission?.join(", ")); add("Page limit", a.keyData.pageLimit); add("Copies", a.keyData.copies);
  add("Proposal validity (days)", a.keyData.validityDays); add("References required", a.keyData.references);
  for (const i of a.keyData.insurance ?? []) add(`Insurance: ${i.kind}`, i.amount.toLocaleString("en-US"));
  for (const e of a.keyData.evaluation ?? []) add(`Evaluation: ${e.criterion}`, `${e.weight}${e.unit === "%" ? "%" : " points"}`);
  add("Words analyzed", a.words);

  // Risks
  const rk = sheet("Risks", [{ header: "Severity", key: "severity", width: 10 }, { header: "Risk", key: "label", width: 50 }, { header: "Evidence", key: "evidence", width: 100 }]);
  for (const r of a.risks) wrap(rk.addRow(r)).getCell("severity").fill = fill(SEV[r.severity]);
  if (!a.risks.length) rk.addRow({ label: "No risk patterns found. Still read the terms and conditions." });

  // Responses (Answer step)
  if (answers) {
    const CONF = { high: "FFD1FAE5", medium: "FFFEF3C7", low: "FFFEE2E2" };
    const rs = sheet("Responses", [
      { header: "Req ID", key: "reqId", width: 10 }, { header: "Section", key: "section", width: 24 }, { header: "Mandatory", key: "m", width: 10 },
      { header: "Requirement", key: "requirement", width: 60 }, { header: "Draft answer", key: "draft", width: 80 }, { header: "Sources", key: "src", width: 28 },
      { header: "Confidence", key: "confidence", width: 11 }, { header: "SME validation", key: "v", width: 13 }, { header: "Owner", key: "owner", width: 22 }, { header: "Status", key: "status", width: 14 },
    ]);
    for (const x of answers) {
      const row = wrap(rs.addRow({ ...x, m: x.level === "mandatory" ? "Yes" : "No", src: x.sources.map((s) => `${s.id}${s.stale ? " (STALE)" : ""}`).join(", "), v: x.validationRequired ? "Required" : "No" }));
      row.getCell("confidence").fill = fill(CONF[x.confidence]);
    }
  }
  // Team (Route step)
  if (team) {
    const tm = sheet("Team", [{ header: "Role on this bid", key: "k", width: 24 }, { header: "Recommended", key: "v", width: 60 }]);
    const lab = { opportunityOwner: "Opportunity owner", bidManager: "Bid manager", solutionLead: "Solution lead", technicalLead: "Technical lead", commercialOwner: "Commercial owner", executiveSponsor: "Executive sponsor" };
    for (const [k, l] of Object.entries(lab)) if (team[k]) tm.addRow({ k: l, v: team[k] });
    if (team.smes?.length) tm.addRow({ k: "SME contributors", v: team.smes.join(", ") });
    if (team.why) tm.addRow({ k: "Why", v: team.why });
  }
  // Readiness (Red-team step)
  if (redTeam) {
    const rt = sheet("Readiness", [{ header: "Type", key: "t", width: 12 }, { header: "Item", key: "v", width: 110 }]);
    rt.addRow({ t: "Readiness", v: redTeam.readiness }).font = { bold: true };
    for (const b of redTeam.blocking) wrap(rt.addRow({ t: "BLOCKING", v: b })).getCell("t").fill = fill("FFFEE2E2");
    for (const w of redTeam.warnings) wrap(rt.addRow({ t: "Warning", v: w })).getCell("t").fill = fill("FFFEF3C7");
    rt.addRow({ t: "", v: redTeam.note });
  }
  if (proposal) {
    const pp = wb.addWorksheet("Proposal draft");
    pp.getColumn(1).width = 120;
    proposal.split("\n").forEach((line, i) => { const c = pp.getCell(i + 1, 1); c.value = line; c.alignment = { wrapText: true, vertical: "top" }; if (/^#{1,3} /.test(line)) c.font = { bold: true }; });
  }
  return wb;
}

export default { buildAnalysisWorkbook };
