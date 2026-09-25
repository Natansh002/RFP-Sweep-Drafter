/**
 * Excel workbook of findings, and the import that reads people's edits back.
 *
 * Editable in the sheet (and read back by `npm run import` or the dashboard's
 * Import button):
 *   Findings:   Status, Assignee, Notes, Est. value, Loss reason, Awardee
 *   Actions:    Action, Assignee, Due, Done, plus new rows (leave Action ID blank)
 *   Compliance: Owner, Status, Response section
 *
 * Everything else is regenerated from the ledger on every export, so editing it
 * in the sheet does nothing. The hidden Rev columns are how the import detects a
 * dashboard edit made after the sheet was exported: that row is reported as a
 * conflict and skipped rather than silently overwritten.
 */
import ExcelJS from "exceljs";
import { STATUSES, COMPLIANCE_STATUSES, DEFAULT_GO_NO_GO, goNoGoScore, isOpen, updateFinding, addAction, updateAction } from "./ledger.mjs";

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
const EDIT_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7D6" } };
const BAND_FILL = {
  pursue: { type: "pattern", pattern: "solid", fgColor: { argb: "FFD1FAE5" } },
  review: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } },
};

const FINDING_EDITABLE = ["status", "assignee", "notes", "estimatedValue", "lossReason", "awardee"];
const toDate = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00Z`) : null);
const fromCell = (v) => {
  if (v == null || v === "") return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("result" in v) return fromCell(v.result);
    if ("text" in v) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  }
  return String(v).trim();
};

function styleHeader(ws, editableKeys = []) {
  const row = ws.getRow(1);
  row.eachCell((cell, col) => {
    const key = ws.columns[col - 1].key;
    cell.font = { bold: true, color: { argb: editableKeys.includes(key) ? "FF111827" : "FFFFFFFF" } };
    cell.fill = editableKeys.includes(key) ? { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCD34D" } } : HEADER_FILL;
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  row.height = 22;
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
}

function listValidation(ws, colKey, formula, rows, strict) {
  const col = ws.getColumn(colKey);
  for (let r = 2; r <= rows; r++) {
    ws.getCell(r, col.number).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [formula],
      showErrorMessage: strict,
      errorStyle: "stop",
      error: "Pick a value from the list.",
    };
  }
}

export async function buildWorkbook(ledger, tenant) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ionic-rfp-sweeper";
  wb.created = new Date();
  const team = (tenant.team ?? []).map((m) => (typeof m === "string" ? { name: m } : m));
  const findings = [...ledger.findings].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.score - a.score);

  // ---------------------------------------------------------------- Findings
  const fs = wb.addWorksheet("Findings");
  fs.columns = [
    { header: "ID", key: "id", width: 16 },
    { header: "Buyer industry", key: "sectorLabel", width: 22 },
    { header: "Search category", key: "industry", width: 18 },
    { header: "Score", key: "score", width: 7 },
    { header: "Band", key: "band", width: 9 },
    { header: "Status ✎", key: "status", width: 13 },
    { header: "Assignee ✎", key: "assignee", width: 20 },
    { header: "Suggested owner", key: "suggestedAssignee", width: 18 },
    { header: "Title", key: "title", width: 60 },
    { header: "Buyer", key: "buyer", width: 30 },
    { header: "Country", key: "country", width: 8 },
    { header: "Closes", key: "closeDate", width: 12 },
    { header: "Days left", key: "daysLeft", width: 9 },
    { header: "Est. value ✎", key: "estimatedValue", width: 13 },
    { header: "Go/no-go", key: "goNoGo", width: 14 },
    { header: "Q&A deadline", key: "questionsDue", width: 12 },
    { header: "Changed", key: "changed", width: 30 },
    { header: "Competitors", key: "competitors", width: 18 },
    { header: "Open actions", key: "openActions", width: 11 },
    { header: "Next action due", key: "nextDue", width: 14 },
    { header: "Channel", key: "channel", width: 24 },
    { header: "First seen", key: "firstSeen", width: 12 },
    { header: "Last seen", key: "lastSeen", width: 12 },
    { header: "Notes ✎", key: "notes", width: 40 },
    { header: "Loss reason ✎", key: "lossReason", width: 24 },
    { header: "Awardee ✎", key: "awardee", width: 20 },
    { header: "Why it scored this way", key: "reasons", width: 70 },
    { header: "Flags", key: "flags", width: 40 },
    { header: "Rev", key: "rev", width: 5, hidden: true },
  ];
  const gng = tenant.goNoGo ?? DEFAULT_GO_NO_GO;
  for (const f of findings) {
    const open = (f.actions ?? []).filter((a) => !a.done);
    const g = goNoGoScore(f.goNoGo, gng);
    const nextDue = open.map((a) => a.due).filter(Boolean).sort()[0] ?? null;
    const row = fs.addRow({
      ...f,
      title: f.url ? { text: f.title, hyperlink: f.url } : f.title,
      closeDate: toDate(f.closeDate),
      openActions: open.length,
      nextDue: toDate(nextDue),
      firstSeen: toDate(f.firstSeen),
      lastSeen: toDate(f.lastSeen),
      reasons: (f.reasons ?? []).join("\n"),
      sectorLabel: f.sector?.label ?? "",
      goNoGo: g.answered ? `${g.pct}% ${g.verdict}` : "not scored",
      questionsDue: toDate(f.keyDates?.questions),
      changed: f.changed ? `${f.changed.at.slice(0, 10)}: ${f.changed.what.join("; ")}` : "",
      competitors: (f.competitors ?? []).join(", "),
      flags: (f.flags ?? []).join("\n"),
      rev: f.rev ?? 0,
    });
    const r = row.number;
    fs.getCell(`L${r}`).value = f.closeDate ? { formula: `IF(K${r}="","",K${r}-TODAY())` } : "";
    for (const k of ["closeDate", "nextDue", "firstSeen", "lastSeen", "questionsDue"]) row.getCell(k).numFmt = "yyyy-mm-dd";
    if (f.changed) row.getCell("changed").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEE2E2" } };
    row.getCell("estimatedValue").numFmt = "#,##0";
    row.getCell("title").font = { color: { argb: "FF1D4ED8" }, underline: true };
    if (BAND_FILL[f.band]) row.getCell("band").fill = BAND_FILL[f.band];
    for (const k of FINDING_EDITABLE) row.getCell(k).fill = EDIT_FILL;
    row.alignment = { vertical: "top", wrapText: true };
  }
  styleHeader(fs, FINDING_EDITABLE);
  listValidation(fs, "status", `"${STATUSES.join(",")}"`, findings.length + 1, true);
  // Not strict: a name that is not on the roster yet is still a valid assignee.
  listValidation(fs, "assignee", "Team!$A$2:$A$500", findings.length + 1, false);

  // ---------------------------------------------------------------- Actions
  const as = wb.addWorksheet("Actions");
  as.columns = [
    { header: "Finding ID", key: "findingId", width: 16 },
    { header: "Finding", key: "finding", width: 50 },
    { header: "Finding status", key: "findingStatus", width: 13 },
    { header: "Action ✎", key: "title", width: 60 },
    { header: "Assignee ✎", key: "assignee", width: 20 },
    { header: "Due ✎", key: "due", width: 12 },
    { header: "Done ✎", key: "done", width: 8 },
    { header: "Source", key: "source", width: 9 },
    { header: "Action ID", key: "actionId", width: 14, hidden: true },
    { header: "Rev", key: "rev", width: 5, hidden: true },
  ];
  let actionRows = 0;
  for (const f of findings) {
    for (const a of f.actions ?? []) {
      const row = as.addRow({ findingId: f.id, finding: f.title, findingStatus: f.status, title: a.title, assignee: a.assignee, due: toDate(a.due), done: a.done ? "Yes" : "No", source: a.source, actionId: a.id, rev: a.rev ?? 0 });
      row.getCell("due").numFmt = "yyyy-mm-dd";
      for (const k of ["title", "assignee", "due", "done"]) row.getCell(k).fill = EDIT_FILL;
      row.alignment = { vertical: "top", wrapText: true };
      actionRows++;
    }
  }
  styleHeader(as, ["title", "assignee", "due", "done"]);
  listValidation(as, "assignee", "Team!$A$2:$A$500", actionRows + 200, false);
  listValidation(as, "done", '"Yes,No"', actionRows + 200, true);

  // ---------------------------------------------------------------- Drafts
  const ds = wb.addWorksheet("Drafts");
  ds.columns = [
    { header: "Finding ID", key: "id", width: 16 },
    { header: "Title", key: "title", width: 40 },
    { header: "Bid / no-bid brief", key: "brief", width: 80 },
    { header: "Response draft (edit in the dashboard)", key: "response", width: 110 },
  ];
  for (const f of findings.filter((x) => x.draft)) {
    ds.addRow({ id: f.id, title: f.title, brief: f.draft.brief ?? "", response: f.draft.response ?? "(not drafted — use Draft response in the dashboard)" }).alignment = { vertical: "top", wrapText: true };
  }
  styleHeader(ds);

  // ---------------------------------------------------------------- Compliance
  const cs = wb.addWorksheet("Compliance");
  cs.columns = [
    { header: "Finding ID", key: "findingId", width: 16 },
    { header: "Finding", key: "finding", width: 36 },
    { header: "Req ID", key: "rid", width: 10 },
    { header: "Kind", key: "kind", width: 11 },
    { header: "Requirement (from the posting page — verify against the full solicitation)", key: "text", width: 80 },
    { header: "Owner ✎", key: "owner", width: 18 },
    { header: "Status ✎", key: "status", width: 12 },
    { header: "Response section ✎", key: "section", width: 18 },
  ];
  let reqRows = 0;
  for (const f of findings.filter((x) => isOpen(x) && x.requirements?.length)) {
    for (const q of f.requirements) {
      const t = f.compliance?.[q.id] ?? {};
      const row = cs.addRow({ findingId: f.id, finding: f.title, rid: q.id, kind: q.kind, text: q.text, owner: t.owner ?? "", status: t.status ?? "Open", section: t.section ?? "" });
      for (const k of ["owner", "status", "section"]) row.getCell(k).fill = EDIT_FILL;
      row.alignment = { vertical: "top", wrapText: true };
      reqRows++;
    }
  }
  styleHeader(cs, ["owner", "status", "section"]);
  listValidation(cs, "owner", "Team!$A$2:$A$500", reqRows + 1, false);
  listValidation(cs, "status", `"${COMPLIANCE_STATUSES.join(",")}"`, reqRows + 1, true);

  // ---------------------------------------------------------------- Pipeline
  const ps = wb.addWorksheet("Pipeline");
  ps.columns = [
    { header: "Industry", key: "industry", width: 22 },
    ...STATUSES.map((st) => ({ header: st, key: st, width: 11 })),
    { header: "Open value", key: "openValue", width: 14 },
    { header: "Won value", key: "wonValue", width: 14 },
    { header: "Win rate", key: "winRate", width: 10 },
  ];
  const industriesSeen = [...new Set(findings.map((f) => f.industry))];
  for (const ind of [...industriesSeen, "All"]) {
    const set = findings.filter((f) => ind === "All" || f.industry === ind);
    const count = Object.fromEntries(STATUSES.map((st) => [st, set.filter((f) => f.status === st).length]));
    const won = count.Won, lost = count.Lost;
    const row = ps.addRow({
      industry: ind, ...count,
      openValue: set.filter(isOpen).reduce((a, f) => a + (f.estimatedValue ?? 0), 0),
      wonValue: set.filter((f) => f.status === "Won").reduce((a, f) => a + (f.estimatedValue ?? 0), 0),
      winRate: won + lost ? won / (won + lost) : "",
    });
    row.getCell("openValue").numFmt = "#,##0";
    row.getCell("wonValue").numFmt = "#,##0";
    row.getCell("winRate").numFmt = "0%";
    if (ind === "All") row.font = { bold: true };
  }
  styleHeader(ps);

  // ---------------------------------------------------------------- Coverage gaps
  const gs = wb.addWorksheet("Coverage gaps");
  gs.columns = [
    { header: "Industry", key: "industry", width: 20 },
    { header: "Channel", key: "channel", width: 28 },
    { header: "Status", key: "status", width: 16 },
    { header: "Detail", key: "detail", width: 80 },
    { header: "Run at", key: "runAt", width: 22 },
  ];
  for (const g of ledger.gaps ?? []) gs.addRow(g);
  styleHeader(gs);

  // ---------------------------------------------------------------- Runs
  const rs = wb.addWorksheet("Runs");
  rs.columns = [
    { header: "Run at", key: "runAt", width: 22 },
    { header: "Industry", key: "industry", width: 20 },
    { header: "Source", key: "source", width: 8 },
    { header: "Channels read", key: "channelsRead", width: 13 },
    { header: "Postings seen", key: "postingsSeen", width: 13 },
    { header: "Pursue", key: "pursue", width: 8 },
    { header: "Review", key: "review", width: 8 },
    { header: "New", key: "added", width: 6 },
    { header: "Gaps", key: "gaps", width: 6 },
    { header: "Halted", key: "halted", width: 7 },
    { header: "Note", key: "note", width: 80 },
  ];
  for (const r of ledger.runs ?? []) rs.addRow({ ...r, halted: r.halted ? "YES" : "", note: [r.haltReason, r.caveat].filter(Boolean).join(" ") });
  styleHeader(rs);

  // ---------------------------------------------------------------- Team
  const ts = wb.addWorksheet("Team");
  ts.columns = [
    { header: "Role (assignee list — add roles here, not people's names)", key: "name", width: 48 },
  ];
  for (const m of team) ts.addRow({ name: m.name });
  styleHeader(ts);

  // ---------------------------------------------------------------- How to use
  const hs = wb.addWorksheet("How to use");
  hs.getColumn(1).width = 110;
  [
    `RFP Sweep and Drafter: RFP findings, ${tenant.name}`,
    `Exported ${new Date().toISOString()} from the findings ledger. ${ledger.findings.length} finding(s).`,
    "",
    "Yellow columns (marked ✎) are yours. Edit them here or in the dashboard:",
    "  Findings: Status, Assignee, Notes, Est. value, Loss reason, Awardee",
    "  Compliance: Owner, Status, Response section for each mandatory requirement found on the posting page",
    "  Actions:  Action, Assignee, Due, Done. To add an action, add a row with a Finding ID and an Action, and leave Action ID blank.",
    "  Team:     add role titles to extend the Assignee dropdown. Use roles, not people's names.",
    "",
    "Then bring the edits back: dashboard → Import Excel, or  npm run import -- --tenant " + tenant.id + " --file <this file>",
    "If a row was changed in the dashboard after this file was exported, the import skips it and reports a conflict instead of overwriting.",
    "",
    "Everything else is regenerated on every export. Nothing in this workbook creates a Jira issue, a task, or a Confluence page.",
  ].forEach((t, i) => { const c = hs.getCell(i + 1, 1); c.value = t; if (i === 0) c.font = { bold: true, size: 14 }; });

  wb.views = [{ activeTab: 0 }];
  return wb;
}

export async function writeWorkbook(ledger, tenant, file) {
  const wb = await buildWorkbook(ledger, tenant);
  await wb.xlsx.writeFile(file);
  return file;
}

export async function workbookBuffer(ledger, tenant) {
  const wb = await buildWorkbook(ledger, tenant);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Read Findings and Actions edits back into the ledger. Mutates the ledger; the caller saves. */
/**
 * `authoritative: true` is for the published-site build: the spreadsheet
 * committed to assignments/ is the only place people edit, so its values win
 * and the rev check is skipped.
 */
export async function importWorkbook(ledger, input, { by, authoritative = false } = {}) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(input)) await wb.xlsx.load(input);
  else await wb.xlsx.readFile(input);

  const result = { applied: [], conflicts: [], errors: [], added: [] };
  const header = (ws) => {
    const map = {};
    ws.getRow(1).eachCell((c, col) => { map[fromCell(c.value).replace(/\s*✎$/, "")] = col; });
    return map;
  };
  const byId = new Map(ledger.findings.map((f) => [f.id, f]));

  const fws = wb.getWorksheet("Findings");
  if (fws) {
    const h = header(fws);
    fws.eachRow((row, n) => {
      if (n === 1) return;
      const id = fromCell(row.getCell(h["ID"]).value);
      const f = byId.get(id);
      if (!id) return;
      if (!f) { result.errors.push(`Findings row ${n}: ${id} is not in the ledger`); return; }
      const cell = (name) => (h[name] ? fromCell(row.getCell(h[name]).value) : undefined);
      const sheet = { status: cell("Status"), assignee: cell("Assignee"), notes: cell("Notes"), estimatedValue: cell("Est. value"), lossReason: cell("Loss reason"), awardee: cell("Awardee") };
      const patch = {};
      for (const k of Object.keys(sheet)) {
        if (sheet[k] === undefined) continue;
        const cur = f[k] == null ? "" : String(f[k]);
        if (k === "estimatedValue" ? Number(sheet[k] || 0) !== Number(f[k] ?? 0) : sheet[k] !== cur) patch[k] = sheet[k];
      }
      if (!Object.keys(patch).length) return;
      if (patch.status !== undefined && patch.status !== "" && !STATUSES.includes(patch.status)) { result.errors.push(`Findings row ${n}: status "${patch.status}" is not one of ${STATUSES.join(", ")}`); return; }
      if (patch.status === "") delete patch.status;
      const rev = Number(fromCell(row.getCell(h["Rev"]).value) || 0);
      if (!authoritative && rev !== (f.rev ?? 0)) { result.conflicts.push(`${id} "${f.title.slice(0, 60)}": changed in the dashboard after this sheet was exported; sheet values ${JSON.stringify(patch)} not applied`); return; }
      updateFinding(ledger, id, patch, { by: by ?? "excel" });
      result.applied.push(`${id}: ${Object.entries(patch).map(([k, v]) => `${k} → ${v || "(blank)"}`).join(", ")}`);
    });
  }

  const aws = wb.getWorksheet("Actions");
  if (aws) {
    const h = header(aws);
    aws.eachRow((row, n) => {
      if (n === 1) return;
      const fid = fromCell(row.getCell(h["Finding ID"]).value);
      const aid = fromCell(row.getCell(h["Action ID"]).value);
      const title = fromCell(row.getCell(h["Action"]).value);
      if (!fid && !title) return;
      const f = byId.get(fid);
      if (!f) { result.errors.push(`Actions row ${n}: finding ${fid || "(blank)"} is not in the ledger`); return; }
      const sheet = { title, assignee: fromCell(row.getCell(h["Assignee"]).value), due: fromCell(row.getCell(h["Due"]).value) || null, done: /^(yes|y|true|1|done|x)$/i.test(fromCell(row.getCell(h["Done"]).value)) };
      if (!aid) {
        if (!title) return;
        // The committed sheet is re-imported on every build: a new row must not become a new action each time.
        if ((f.actions ?? []).some((x) => x.title.trim().toLowerCase() === title.trim().toLowerCase())) return;
        const a = addAction(ledger, fid, sheet, { by: by ?? "excel" });
        if (sheet.done) updateAction(ledger, fid, a.id, { done: true });
        result.added.push(`${fid}: + "${title}"${sheet.assignee ? ` → ${sheet.assignee}` : ""}`);
        return;
      }
      const a = (f.actions ?? []).find((x) => x.id === aid);
      if (!a) { result.errors.push(`Actions row ${n}: action ${aid} is not on ${fid}`); return; }
      const patch = {};
      if (sheet.title && sheet.title !== a.title) patch.title = sheet.title;
      // A blank cell does not clear an assignee the action inherited from its
      // finding in this same import (the sheet was exported before the handoff).
      const inherited = !sheet.assignee && a.assignee && a.assignee === f.assignee;
      if (sheet.assignee !== String(a.assignee ?? "") && !inherited) patch.assignee = sheet.assignee;
      if ((sheet.due ?? null) !== (a.due ?? null)) patch.due = sheet.due;
      if (sheet.done !== !!a.done) patch.done = sheet.done;
      if (!Object.keys(patch).length) return;
      const rev = Number(fromCell(row.getCell(h["Rev"]).value) || 0);
      if (!authoritative && rev !== (a.rev ?? 0)) { result.conflicts.push(`${fid} action "${a.title.slice(0, 50)}": changed in the dashboard after export; not applied`); return; }
      updateAction(ledger, fid, aid, patch);
      result.applied.push(`${fid} action "${a.title.slice(0, 40)}": ${Object.entries(patch).map(([k, v]) => `${k} → ${v === "" || v == null ? "(blank)" : v}`).join(", ")}`);
    });
  }
  const cws = wb.getWorksheet("Compliance");
  if (cws) {
    const h = header(cws);
    cws.eachRow((row, n) => {
      if (n === 1) return;
      const fid = fromCell(row.getCell(h["Finding ID"]).value), rid = fromCell(row.getCell(h["Req ID"]).value);
      const f = byId.get(fid);
      if (!f || !rid) return;
      const cur = f.compliance?.[rid] ?? {};
      const sheet = { owner: fromCell(row.getCell(h["Owner"]).value), status: fromCell(row.getCell(h["Status"]).value) || "Open", section: fromCell(row.getCell(h["Response section"]).value) };
      const patch = {};
      if (sheet.owner !== (cur.owner ?? "")) patch.owner = sheet.owner;
      if (sheet.status !== (cur.status ?? "Open")) patch.status = sheet.status;
      if (sheet.section !== (cur.section ?? "")) patch.section = sheet.section;
      if (!Object.keys(patch).length) return;
      if (patch.status && !COMPLIANCE_STATUSES.includes(patch.status)) { result.errors.push(`Compliance row ${n}: status "${patch.status}" is not one of ${COMPLIANCE_STATUSES.join(", ")}`); return; }
      // Compliance cells carry no rev; a person's newer dashboard edit to the same requirement is overwritten. Reported so it is visible.
      updateFinding(ledger, fid, { compliance: { [rid]: patch } }, { by: by ?? "excel" });
      result.applied.push(`${fid} ${rid}: ${Object.entries(patch).map(([k, v]) => `${k} → ${v || "(blank)"}`).join(", ")}`);
      byId.set(fid, f);
    });
  }
  return result;
}

export default { buildWorkbook, writeWorkbook, workbookBuffer, importWorkbook };
