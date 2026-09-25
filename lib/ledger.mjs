/**
 * The findings ledger: one JSON file per tenant in store/.
 *
 * This is the system of record that replaces ticket filing. The sweep writes
 * machine fields (score, reasons, close date). People write human fields
 * (assignee, status, notes, action items), from the dashboard or the Excel
 * workbook. A sweep never overwrites a human field.
 *
 * Every human edit bumps the row's `rev`. The Excel export carries it, so an
 * import can tell "you changed this in the sheet" from "someone changed this in
 * the dashboard after you exported" and refuses the second rather than losing it.
 */
import fs from "node:fs";
import path from "node:path";

export const STATUSES = ["New", "Qualifying", "Pursuing", "Drafting", "Submitted", "Won", "Lost", "No-bid", "Archived"];
const OPEN = new Set(["New", "Qualifying", "Pursuing", "Drafting"]);
export const isOpen = (f) => OPEN.has(f.status);
export const COMPLIANCE_STATUSES = ["Open", "In progress", "Done", "N/A"];

const MACHINE = ["industry", "industryStatus", "title", "buyer", "country", "url", "channel", "closeDate", "estimatedValue", "score", "band", "reasons", "flags", "suggestedAssignee", "keyDates", "requirements", "competitors", "incumbent", "libraryMatches", "sourceText", "capabilities", "team", "publishedDate", "noticeType", "sector", "rfp"];

// "rfp": what the solicitation documents said. A run that could not read them keeps the last reading.
const STICKY = new Set(["sourceText", "closeDate", "estimatedValue", "keyDates", "requirements", "competitors", "incumbent", "libraryMatches", "buyer", "country", "rfp"]);

/** Default go/no-go criteria. A tenant overrides them with goNoGo.criteria. */
export const DEFAULT_GO_NO_GO = {
  threshold: 65,
  criteria: [
    { id: "fit", label: "Our product meets most mandatory requirements", weight: 25 },
    { id: "relationship", label: "We know the buyer, or had contact before the RFP", weight: 15 },
    { id: "reference", label: "We have a strong reference in this segment", weight: 15 },
    { id: "timeline", label: "We can produce a quality response by the deadline", weight: 15 },
    { id: "budget", label: "Budget or value is worth the pursuit cost", weight: 10 },
    { id: "incumbent", label: "No incumbent lock-in, or the incumbent is vulnerable", weight: 10 },
    { id: "capacity", label: "We have delivery capacity if we win", weight: 10 },
  ],
};

/** Weighted go/no-go from a person's answers: yes = full weight, partial = half, no/unknown = 0. */
export function goNoGoScore(answers, config = DEFAULT_GO_NO_GO) {
  const crit = config.criteria ?? [];
  const total = crit.reduce((a, c) => a + c.weight, 0) || 1;
  const answered = crit.filter((c) => answers?.[c.id] && answers[c.id] !== "unknown").length;
  const got = crit.reduce((a, c) => a + (answers?.[c.id] === "yes" ? c.weight : answers?.[c.id] === "partial" ? c.weight / 2 : 0), 0);
  const pct = Math.round((got / total) * 100);
  return { pct, answered, of: crit.length, verdict: answered < crit.length ? "incomplete" : pct >= (config.threshold ?? 65) ? "go" : "no-go" };
}

export function ledgerPath(root, tenantId) {
  // RFP_STORE_DIR points the ledger at another folder (used by the end-to-end tests).
  const dir = process.env.RFP_STORE_DIR ? path.resolve(process.env.RFP_STORE_DIR) : path.join(root, "store");
  return path.join(dir, `${tenantId}.json`);
}

/** Another file next to the ledgers (profile.json, postings.json), honouring RFP_STORE_DIR. */
export function storeFile(root, name) {
  return path.join(path.dirname(ledgerPath(root, "x")), name);
}
export function readStore(root, name, fallback = null) {
  const p = storeFile(root, name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback;
}
export function writeStore(root, name, value) {
  const p = storeFile(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, p);
}
/**
 * A file in the private library (library/private/, gitignored): learned answers, the
 * reference library, the response template. RFP_LIBRARY_DIR points it elsewhere (tests).
 */
export function privateFile(root, name) {
  const dir = process.env.RFP_LIBRARY_DIR ? path.resolve(process.env.RFP_LIBRARY_DIR) : path.join(root, "library", "private");
  return path.join(dir, name);
}

/** The full solicitation text a sweep read for a finding, kept beside the ledger (not in it). */
export function writeTexts(root, texts) {
  for (const [id, text] of Object.entries(texts ?? {})) {
    if (!/^[\w-]+$/.test(id) || !text) continue;
    const p = storeFile(root, `text/${id}.txt`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
}
export function readText(root, id) {
  if (!/^[\w-]+$/.test(String(id))) return null;
  const p = storeFile(root, `text/${id}.txt`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

/** Merge a run's raw postings into the posting list: newest run wins, closed ones drop off. */
export function mergePostings(prev, raw, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const byKey = new Map((prev?.postings ?? []).map((p) => [`${p.url}|${p.title}`, p]));
  for (const p of raw ?? []) byKey.set(`${p.url}|${p.title}`, { ...byKey.get(`${p.url}|${p.title}`), ...p, seenAt: now.toISOString() });
  const postings = [...byKey.values()].filter((p) => !p.closeDate || p.closeDate >= today).slice(-6000);
  return { updatedAt: now.toISOString(), count: postings.length, postings };
}

export function loadLedger(root, tenantId) {
  const p = ledgerPath(root, tenantId);
  if (!fs.existsSync(p)) return { tenant: tenantId, updatedAt: null, findings: [], runs: [], gaps: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function saveLedger(root, ledger) {
  const p = ledgerPath(root, ledger.tenant);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  ledger.updatedAt = new Date().toISOString();
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  fs.renameSync(tmp, p); // atomic on the same volume: a crash never leaves half a ledger
}

/**
 * Merge one run's findings. New findings are added as status "New"; existing
 * ones get their machine fields refreshed and nothing else.
 */
/**
 * Earlier runs could add a "review the change" action per sweep. Keep one open: those a person
 * touched (assigned, edited), else the newest. Untouched duplicates go.
 */
export function tidyChangeActions(f) {
  const open = (f.actions ?? []).filter((a) => a.source === "change-detection" && !a.done);
  if (open.length <= 1) return 0;
  const touched = open.filter((a) => (a.rev ?? 0) > 0);
  const keep = new Set(touched.length ? touched : [open[open.length - 1]]);
  const drop = new Set(open.filter((a) => !keep.has(a) && (a.rev ?? 0) === 0).map((a) => a.id));
  f.actions = f.actions.filter((a) => !drop.has(a.id));
  return drop.size;
}

export function mergeRun(ledger, run) {
  const now = new Date().toISOString();
  for (const f of ledger.findings) tidyChangeActions(f);
  const byId = new Map(ledger.findings.map((f) => [f.id, f]));
  let added = 0, refreshed = 0;

  for (const f of run.findings) {
    const cur = byId.get(f.id);
    if (!cur) {
      ledger.findings.push({
        ...f,
        status: "New",
        notes: "",
        rev: 0,
        firstSeen: now,
        lastSeen: now,
        seenCount: 1,
        draftEdited: false,
        goNoGo: {},
        lossReason: "",
        awardee: "",
        changed: null,
      });
      added++;
      continue;
    }
    // Addenda / change detection. A changed posting page, close date or title is
    // flagged until a person acknowledges it, and gets its own action item.
    const changes = [];
    // Same hashing method on both sides, and not a version seen recently (pages that flip between variants).
    const version = (x) => (String(x).includes(":") ? String(x).split(":")[0] : "v1");
    if (f.contentHash && cur.contentHash && f.contentHash !== cur.contentHash && version(f.contentHash) === version(cur.contentHash) && !(cur.contentHashes ?? []).includes(f.contentHash)) changes.push("posting page content changed");
    if (f.closeDate && cur.closeDate && f.closeDate !== cur.closeDate) changes.push(`close date ${cur.closeDate} → ${f.closeDate}`);
    for (const [k, v] of Object.entries(f.keyDates ?? {})) if (cur.keyDates?.[k] && cur.keyDates[k] !== v) changes.push(`${k} ${cur.keyDates[k]} → ${v}`);
    if (changes.length) {
      cur.changed = { at: now, what: changes };
      cur.changeLog = [...(cur.changeLog ?? []), { at: now, what: changes }].slice(-20);
      // One open "review the change" action per finding: a new change updates it, never adds another.
      const title = `Review the change and acknowledge any addendum: ${changes.join("; ")}`;
      const openAction = (cur.actions ?? []).find((a) => a.source === "change-detection" && !a.done);
      if (openAction) Object.assign(openAction, { title, due: now.slice(0, 10), rev: (openAction.rev ?? 0) + 1 });
      else cur.actions.push({ id: `addendum-${Date.now().toString(36)}`, title, due: now.slice(0, 10), assignee: cur.assignee || "", done: false, source: "change-detection", rev: 0 });
    }
    if (f.contentHash) { cur.contentHashes = [...(cur.contentHashes ?? []).filter((x) => x !== f.contentHash), f.contentHash].slice(-4); cur.contentHash = f.contentHash; }
    for (const k of MACHINE) {
      if (f[k] === undefined) continue;
      // Enrichment comes from reading the posting page, which a run may skip or
      // fail. An empty value this run never erases a value found last run.
      if (STICKY.has(k) && (f[k] == null || (typeof f[k] === "object" && !Object.keys(f[k]).length))) continue;
      if (k === "estimatedValue" && cur.valueSetByPerson) continue;
      cur[k] = f[k];
    }
    cur.lastSeen = now;
    cur.seenCount = (cur.seenCount ?? 1) + 1;
    // The drafter's brief always tracks the latest score. The response draft is
    // regenerated only if nobody has edited it.
    cur.draft = { brief: f.draft.brief, response: cur.draftEdited ? cur.draft?.response : f.draft.response ?? cur.draft?.response ?? null };
    // Add drafter actions that did not exist before (e.g. review → pursue), keep the rest as people left them.
    const have = new Set((cur.actions ?? []).map((a) => a.id));
    for (const a of f.actions) if (!have.has(a.id)) cur.actions.push({ ...a, assignee: a.assignee || cur.assignee || "" });
    refreshed++;
  }

  ledger.runs = [
    { runAt: now, industry: run.industry, source: run.source ?? "cli", channelsRead: run.channelsRead, postingsSeen: run.postingsSeen, pursue: run.findings.filter((f) => f.band === "pursue").length, review: run.findings.filter((f) => f.band === "review").length, added, refreshed, gaps: run.gaps.length, halted: !!run.halted, haltReason: run.haltReason ?? null, caveat: run.caveat ?? null },
    ...(ledger.runs ?? []),
  ].slice(0, 200);
  // Coverage gaps are per industry; replace this industry's, keep the others.
  ledger.gaps = [...(ledger.gaps ?? []).filter((g) => g.industry !== run.industry), ...run.gaps.map((g) => ({ ...g, industry: run.industry, runAt: now }))];
  return { added, refreshed };
}

class Conflict extends Error {
  constructor(msg) { super(msg); this.code = "CONFLICT"; }
}

export function getFinding(ledger, id) {
  const f = ledger.findings.find((x) => x.id === id);
  if (!f) { const e = new Error(`No finding ${id}`); e.code = "NOT_FOUND"; throw e; }
  return f;
}

/** Human edit of a finding. `expectedRev` guards against overwriting a newer edit. */
export function updateFinding(ledger, id, patch, { expectedRev, by } = {}) {
  const f = getFinding(ledger, id);
  if (expectedRev != null && expectedRev !== f.rev) throw new Conflict(`Finding ${id} changed since you loaded it (rev ${f.rev}, you had ${expectedRev}).`);
  if (patch.status != null && !STATUSES.includes(patch.status)) throw new Error(`Unknown status "${patch.status}". Use one of ${STATUSES.join(", ")}.`);
  const before = f.assignee;
  for (const k of ["assignee", "status", "notes", "lossReason", "awardee"]) if (patch[k] != null) f[k] = String(patch[k]).trim();
  if (patch.estimatedValue !== undefined) {
    const v = patch.estimatedValue === "" || patch.estimatedValue == null ? null : Number(String(patch.estimatedValue).replace(/[^0-9.]/g, ""));
    if (v != null && !Number.isFinite(v)) throw new Error("Estimated value must be a number.");
    f.estimatedValue = v;
    f.valueSetByPerson = v != null;
  }
  if (patch.goNoGo && typeof patch.goNoGo === "object") {
    for (const [k, v] of Object.entries(patch.goNoGo)) {
      if (!["yes", "partial", "no", "unknown"].includes(v)) throw new Error(`go/no-go answer must be yes, partial, no or unknown`);
      f.goNoGo = { ...(f.goNoGo ?? {}), [k]: v };
    }
  }
  if (patch.acknowledgeChange) f.changed = null;
  if (patch.compliance && typeof patch.compliance === "object") {
    for (const [rid, v] of Object.entries(patch.compliance)) {
      const cur = f.compliance?.[rid] ?? {};
      const next = { ...cur };
      if (v.owner != null) next.owner = String(v.owner).trim();
      if (v.status != null) {
        if (!COMPLIANCE_STATUSES.includes(v.status)) throw new Error(`Compliance status must be one of ${COMPLIANCE_STATUSES.join(", ")}`);
        next.status = v.status;
      }
      if (v.section != null) next.section = String(v.section).trim();
      f.compliance = { ...(f.compliance ?? {}), [rid]: next };
    }
  }
  if (patch.draftResponse != null) { f.draft = { ...(f.draft ?? {}), response: String(patch.draftResponse) }; f.draftEdited = true; }
  // A newly assigned finding hands its unassigned action items to the same person.
  if (patch.assignee != null && f.assignee && f.assignee !== before) {
    for (const a of f.actions ?? []) if (!a.assignee && !a.done) { a.assignee = f.assignee; a.rev = (a.rev ?? 0) + 1; }
  }
  f.rev = (f.rev ?? 0) + 1;
  f.updatedAt = new Date().toISOString();
  if (by) f.updatedBy = by;
  audit(f, by, Object.keys(patch).filter((k) => k !== "rev"));
  return f;
}

/** Audit trail: who changed what, when. Kept on the finding, newest last, capped. */
export function audit(f, by, what) {
  f.history = [...(f.history ?? []), { at: new Date().toISOString(), by: by || "unknown", what: [].concat(what).join(", ") }].slice(-200);
}

/**
 * The response workspace for one opportunity: analysis, answers, proposal and
 * red-team result. Versions are kept (last 20) so an overwrite can be undone.
 */
export function saveWorkspace(ledger, id, ws, { by } = {}) {
  const f = getFinding(ledger, id);
  // redTeam holds the RFP submission status check (the stored name predates the label).
  const allowed = ["analysis", "answers", "proposal", "proofread", "redTeam", "teamOverride", "documentName"];
  const next = { ...(f.workspace ?? {}) };
  for (const k of allowed) if (ws[k] !== undefined) next[k] = ws[k];
  if (Array.isArray(next.answers)) {
    for (const a of next.answers) if (a.status && !["Not started", "Drafted", "SME review", "Approved", "Needs revision", "Final"].includes(a.status)) throw new Error(`Unknown response status "${a.status}"`);
  }
  next.updatedAt = new Date().toISOString();
  next.version = (f.workspace?.version ?? 0) + 1;
  f.workspaceVersions = [...(f.workspaceVersions ?? []), ...(f.workspace ? [f.workspace] : [])].slice(-20);
  f.workspace = next;
  audit(f, by, `workspace v${next.version}: ${Object.keys(ws).join(", ")}`);
  return f;
}

export function addAction(ledger, id, { title, assignee, due }, { by } = {}) {
  const f = getFinding(ledger, id);
  if (!title || !String(title).trim()) throw new Error("An action needs a title.");
  const a = { id: `a${Date.now().toString(36)}`, title: String(title).trim(), assignee: String(assignee ?? f.assignee ?? "").trim(), due: due || null, done: false, source: "person", rev: 0, createdBy: by ?? null };
  f.actions = [...(f.actions ?? []), a];
  return a;
}

export function updateAction(ledger, id, actionId, patch, { expectedRev } = {}) {
  const f = getFinding(ledger, id);
  const a = (f.actions ?? []).find((x) => x.id === actionId);
  if (!a) { const e = new Error(`No action ${actionId} on ${id}`); e.code = "NOT_FOUND"; throw e; }
  if (expectedRev != null && expectedRev !== a.rev) throw new Conflict(`Action ${actionId} changed since you loaded it.`);
  if (patch.title != null) a.title = String(patch.title).trim();
  if (patch.assignee != null) a.assignee = String(patch.assignee).trim();
  if (patch.due !== undefined) a.due = patch.due || null;
  if (patch.done != null) a.done = !!patch.done;
  a.rev = (a.rev ?? 0) + 1;
  return a;
}

export default { saveWorkspace, audit, STATUSES, DEFAULT_GO_NO_GO, goNoGoScore, isOpen, loadLedger, saveLedger, mergeRun, updateFinding, addAction, updateAction, getFinding };
