// RFP findings dashboard. Vanilla JS, no external requests: everything goes to
// this dashboard's own /api on 127.0.0.1. All text from findings is rendered as
// text, never as HTML.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
// The published GitHub Pages build is read-only: data comes from data/*.json and
// edits are made in the Excel sheet committed to assignments/ in the repo.
const STATIC = document.querySelector('meta[name="rfp-mode"]')?.content === "static";
const OPEN = new Set(["New", "Qualifying", "Pursuing", "Drafting"]);
const DAY = 86400000;
const state = { meta: null, tenant: null, ledger: null, open: new Set(), tab: "sweep", allLedger: null, sweepIds: null, ws: null, aws: null };

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `show${isError ? " error" : ""}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ""), isError ? 8000 : 3500);
}

async function staticApi(method, path) {
  if (method !== "GET") throw new Error("This published view is read-only. Download the Excel, edit the yellow columns and upload it to assignments/ in the repo.");
  const file = path === "/api/ledger" ? `data/${state.tenant}.json`
    : path === "/api/export.xlsx" ? `downloads/${state.tenant}-rfp-findings.xlsx`
    : path === "/api/calendar.ics" ? `downloads/${state.tenant}-rfp-deadlines.ics` : null;
  if (!file) throw new Error("Not available in the published view.");
  const res = await fetch(file, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${file}: ${res.status}`);
  return path === "/api/ledger" ? localEdits.apply(await res.json()) : res;
}

async function api(method, path, body, raw = false) {
  if (STATIC) return staticApi(method, path);
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}tenant=${encodeURIComponent(state.tenant)}`, {
    method,
    headers: { "X-RFP-Dashboard": "1", "X-RFP-User": $("#me").value || "", ...(raw ? { "content-type": "application/octet-stream" } : body ? { "content-type": "application/json" } : {}) },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  if (res.headers.get("content-type")?.includes("json")) {
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    return data;
  }
  if (!res.ok) throw new Error(res.statusText);
  return res;
}

// ------------------------------------------------------------------ helpers
// Same rule as lib/ledger.mjs goNoGoScore: yes = full weight, partial = half.
function goNoGo(answers) {
  const cfg = tenantMeta().goNoGo, crit = cfg.criteria ?? [];
  const total = crit.reduce((a, c) => a + c.weight, 0) || 1;
  const answered = crit.filter((c) => answers?.[c.id] && answers[c.id] !== "unknown").length;
  const got = crit.reduce((a, c) => a + (answers?.[c.id] === "yes" ? c.weight : answers?.[c.id] === "partial" ? c.weight / 2 : 0), 0);
  const pct = Math.round((got / total) * 100);
  return { pct, answered, of: crit.length, verdict: answered < crit.length ? "incomplete" : pct >= (cfg.threshold ?? 65) ? "go" : "no-go" };
}
const tenantMeta = () => state.meta.tenants.find((t) => t.id === state.tenant);
const money = (v) => (v == null ? "" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(v));
const daysLeft = (d) => (d ? Math.round((new Date(`${d}T00:00:00`) - new Date(new Date().toDateString())) / DAY) : null);
const findingById = (id) => state.ledger.findings.find((f) => f.id === id);
const team = () => state.meta.tenants.find((t) => t.id === state.tenant)?.team ?? [];
const industryName = (id) => id;

function dueCell(due) {
  if (!due) return h("span", { class: "unassigned" }, "no date");
  const d = daysLeft(due);
  return h("span", { class: `due ${d < 0 ? "over" : d <= 7 ? "soon" : ""}` }, due, d != null ? ` (${d < 0 ? `${-d}d late` : `${d}d`})` : "");
}

// Edits go one at a time, and each sends the latest version number known at send
// time (not the one captured when the row was drawn), so quick successive edits
// never collide with the background refresh.
let mutationChain = Promise.resolve();
const revOf = (id) => state.ledger?.findings.find((x) => x.id === id)?.rev ?? 0;
const actionRevOf = (id, aid) => state.ledger?.findings.find((x) => x.id === id)?.actions?.find((a) => a.id === aid)?.rev ?? 0;
function mutate(fn, okMsg) {
  mutationChain = mutationChain.then(async () => {
    try {
      await fn();
      if (okMsg) toast(okMsg);
    } catch (e) {
      toast(e.status === 409 ? `${e.message}\nReloaded the latest version.` : e.message, true);
    }
    await loadLedger();
  });
  return mutationChain;
}

// ------------------------------------------------------------------ loading
async function loadMeta() {
  const res = await fetch(STATIC ? "data/meta.json" : "/api/meta", { cache: "no-cache" });
  state.meta = await res.json();
  if (STATIC) setupStatic();
  setupSweepForm();
  if (!state.meta.tenants.length) return showNoTenants();
  const sel = $("#tenant");
  sel.replaceChildren(...state.meta.tenants.map((t) => h("option", { value: t.id }, `${t.name}${t.status !== "active" ? ` (${t.status})` : ""}`)));
  const saved = store.get("rfp.tenant");
  state.tenant = state.meta.tenants.some((t) => t.id === saved) ? saved : state.meta.tenants[0]?.id;
  sel.value = state.tenant;
  $("#me").value = store.get("rfp.me", "");
  const fs = $("#fStatus");
  for (const s of state.meta.statuses) fs.append(h("option", { value: s }, s));
  onTenant();
}

function onTenant() {
  const t = state.meta.tenants.find((x) => x.id === state.tenant);
  $("#sweepIndustry")?.replaceChildren(h("option", { value: "" }, "All subscribed industries"), ...t.industries.map((i) => h("option", { value: i }, i)));
  $("#fIndustry").replaceChildren(h("option", { value: "" }, "All industries"), ...t.industries.map((i) => h("option", { value: i }, i)));
  $("#team").replaceChildren(...t.team.map((m) => h("option", { value: m.name }, m.role || "")));
  state.open.clear();
  loadLedger();
}

async function loadLedger() {
  state.ledger = await api("GET", "/api/ledger");
  const names = new Set([...team().map((m) => m.name), ...state.ledger.findings.map((f) => f.assignee).filter(Boolean)]);
  const fa = $("#fAssignee"), keep = fa.value;
  fa.replaceChildren(h("option", { value: "" }, "Anyone"), h("option", { value: "__none" }, "Unassigned"), ...[...names].sort().map((n) => h("option", { value: n }, n)));
  fa.value = [...fa.options].some((o) => o.value === keep) ? keep : "";
  render();
}

// ------------------------------------------------------------------ render
function render() {
  if (state.tab === "sweep") return renderSweepResults();
  if (state.tab === "analyze") return;
  renderKpis();
  if (state.tab === "findings") renderFindings();
  if (state.tab === "actions") renderActions();
  if (STATIC) lockEdits();
}

function showNoTenants() {
  for (const el of [".toolbar", "#kpis", ".tabs", ".controls"]) $(el)?.remove();
  $("main").replaceChildren(h("section", { class: "empty-state" },
    h("h2", {}, "No companies configured yet"),
    h("p", {}, "Add an operating company, then run a sweep:"),
    h("pre", {}, 'npm run new-tenant -- <company-id> "<Company name>" --industries k12,nonprofit\nnpm run check\nnpm run sweep -- --tenant <company-id> --width 1'),
    h("p", { class: "hint" }, "Industries available: k12, nonprofit, logistics-lastmile-tms, logistics-freight-fleet. Commit the new tenants/<company-id>.json and the published site picks it up on the next build.")));
}

function setupStatic() {
  document.body.classList.add("static");
  for (const el of [$("#runSweep")?.closest(".group"), $("#importXlsx")?.closest("label"), $("#importRun")?.closest("label")]) el?.remove();
  if (!state.meta.tenants.length) return;
  const upload = state.meta.repo ? `https://github.com/${state.meta.repo}/upload/main/assignments` : null;
  $(".toolbar").before(h("section", { class: "banner pipeline-only", hidden: state.tab === "sweep" || state.tab === "analyze" },
    h("strong", {}, "Published view (read-only). "),
    "To assign or update: Download Excel → edit the yellow ✎ columns → save it as ", state.meta.tenants.map((t, i) => [i ? " / " : "", h("code", {}, `${t.id}.xlsx`)]),
    " and upload it to the repo's assignments/ folder", upload ? [" (", h("a", { href: upload, target: "_blank", rel: "noopener noreferrer" }, "upload"), ")"] : "",
    ". The site rebuilds with your changes."));
}

function lockEdits() {
  for (const el of document.querySelectorAll("#tab-findings .grid input, #tab-findings .grid select, #tab-findings .grid textarea, #tab-findings .grid button:not(.link), #tab-actions .grid input")) {
    if (el.classList.contains("keep")) continue;
    el.disabled = true;
    el.title = "Read-only here: edit the Excel and upload it to assignments/";
  }
}

function renderKpis() {
  const open = state.ledger.findings.filter((f) => OPEN.has(f.status));
  const acts = open.flatMap((f) => (f.actions ?? []).filter((a) => !a.done));
  const over = acts.filter((a) => a.due && daysLeft(a.due) < 0).length;
  const soon = acts.filter((a) => a.due && daysLeft(a.due) >= 0 && daysLeft(a.due) <= 7).length;
  const won = state.ledger.findings.filter((f) => f.status === "Won").length, lost = state.ledger.findings.filter((f) => f.status === "Lost").length;
  const pipeline = open.reduce((a, f) => a + (f.estimatedValue ?? 0), 0);
  const changed = open.filter((f) => f.changed).length;
  const tiles = [
    ["Open findings", open.length],
    ["Pursue", open.filter((f) => f.band === "pursue").length],
    ["Needs review", open.filter((f) => f.band === "review").length],
    ["Unassigned", open.filter((f) => !f.assignee).length, open.some((f) => !f.assignee && f.band === "pursue")],
    ["Actions due ≤ 7 days", soon],
    ["Overdue actions", over, over > 0],
    ["Changed since last sweep", changed, changed > 0],
    ["Open pipeline value", pipeline ? money(pipeline) : "—"],
    ["Win rate", won + lost ? `${Math.round((won / (won + lost)) * 100)}%` : "—"],
  ];
  $("#kpis").replaceChildren(...tiles.map(([l, v, warn]) => h("div", { class: `kpi${warn ? " warn" : ""}` }, h("div", { class: "v" }, v), h("div", { class: "l" }, l))));
}

function filtered() {
  const q = $("#q").value.trim().toLowerCase();
  const ind = $("#fIndustry").value, band = $("#fBand").value, st = $("#fStatus").value, who = $("#fAssignee").value;
  return state.ledger.findings
    .filter((f) => (!ind || f.industry === ind) && (!band || f.band === band))
    .filter((f) => (st === "*" ? true : st ? f.status === st : OPEN.has(f.status)))
    .filter((f) => (!who ? true : who === "__none" ? !f.assignee : f.assignee === who))
    .filter((f) => !$("#fChanged").checked || f.changed)
    .filter((f) => !q || `${f.title} ${f.buyer ?? ""} ${f.notes ?? ""} ${f.id}`.toLowerCase().includes(q))
    .sort((a, b) => b.score - a.score);
}

function statusSelect(f) {
  return h("select", { "aria-label": "Status", onchange: (e) => mutate(() => api("PATCH", `/api/findings/${f.id}`, { status: e.target.value, rev: revOf(f.id) }), `Status → ${e.target.value}`) },
    ...state.meta.statuses.map((s) => h("option", { value: s, selected: s === f.status }, s)));
}

function assigneeInput(value, placeholder, onSave) {
  const el = h("input", { class: "assignee", list: "team", value: value || "", placeholder: placeholder || "unassigned", "aria-label": "Assignee" });
  const commit = () => { if (el.value.trim() !== (value || "")) onSave(el.value.trim()); };
  el.addEventListener("change", commit);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); });
  return el;
}

function renderFindings() {
  renderFindingsRows();
  if (STATIC) lockEdits();
}

function renderFindingsRows() {
  const rows = filtered();
  const tbody = $("#findings tbody");
  tbody.replaceChildren();
  $("#findingsEmpty").hidden = rows.length > 0;
  for (const f of rows) {
    const d = daysLeft(f.closeDate);
    const acts = f.actions ?? [];
    const isOpen = state.open.has(f.id);
    tbody.append(h("tr", {},
      h("td", { class: "num" }, h("span", { class: `pill ${f.band}`, title: f.band }, f.score)),
      h("td", { class: "title" },
        f.url ? h("a", { href: f.url, target: "_blank", rel: "noopener noreferrer" }, f.title) : h("strong", {}, f.title),
        h("div", { class: "buyer" }, f.buyer || "buyer not published", f.country ? ` · ${f.country}` : "", ` · ${f.channel}`,
          f.industryStatus && f.industryStatus !== "proven" ? h("span", { class: "tag" }, f.industryStatus) : null,
          f.changed ? h("span", { class: "tag changed", title: f.changed.what.join("; ") }, "changed") : null,
          (() => { const g = goNoGo(f.goNoGo); return g.answered ? h("span", { class: `tag gng ${g.verdict}` }, `go/no-go ${g.pct}%`) : null; })(),
          ...(f.competitors ?? []).map((c) => h("span", { class: "tag" }, `vs ${c}`)))),
      h("td", {}, h("span", { title: sectorOf(f) ? `Inferred: ${sectorOf(f).basis}` : "" }, sectorOf(f)?.label ?? industryName(f.industry))),
      h("td", {}, f.closeDate ? h("span", { class: `due ${d < 0 ? "over" : d <= 14 ? "soon" : ""}` }, f.closeDate, h("br"), d < 0 ? "closed" : `${d} days`) : h("span", { class: "unassigned" }, "not published")),
      h("td", {}, statusSelect(f)),
      h("td", {}, assigneeInput(f.assignee, f.suggestedAssignee ? `suggest: ${f.suggestedAssignee}` : "unassigned", (v) => mutate(() => api("PATCH", `/api/findings/${f.id}`, { assignee: v, rev: revOf(f.id) }), v ? `Assigned to ${v}` : "Unassigned"))),
      h("td", { class: "num" }, `${acts.filter((a) => a.done).length}/${acts.length}`),
      h("td", {}, h("button", { class: "link", "aria-expanded": String(isOpen), onclick: () => { isOpen ? state.open.delete(f.id) : state.open.add(f.id); renderFindings(); } }, isOpen ? "Close" : "Open")),
    ));
    if (isOpen) tbody.append(detailRow(f));
  }
}

function detailRow(f) {
  const notes = h("textarea", { "aria-label": "Notes", placeholder: "Notes for the team", value: f.notes || "" });
  notes.addEventListener("change", () => mutate(() => api("PATCH", `/api/findings/${f.id}`, { notes: notes.value, rev: revOf(f.id) }), "Notes saved"));

  const newTitle = h("input", { placeholder: "New action item", "aria-label": "New action title" });
  const newWho = h("input", { class: "assignee", list: "team", placeholder: f.assignee || "assignee", "aria-label": "New action assignee" });
  const newDue = h("input", { type: "date", "aria-label": "New action due date" });
  const addBtn = h("button", { onclick: () => {
    if (!newTitle.value.trim()) return toast("Give the action a title.", true);
    mutate(() => api("POST", `/api/findings/${f.id}/actions`, { title: newTitle.value, assignee: newWho.value || f.assignee, due: newDue.value || null }), "Action added");
  } }, "Add");

  const draftBox = h("textarea", { class: "draft", "aria-label": "Response draft", value: f.draft?.response || "" });
  const draftArea = f.draft?.response
    ? [draftBox, h("div", { class: "row" },
        h("button", { onclick: () => mutate(() => api("PATCH", `/api/findings/${f.id}`, { draftResponse: draftBox.value, rev: revOf(f.id) }), "Draft saved") }, "Save draft"),
        h("button", { class: "keep", onclick: async () => { try { await navigator.clipboard.writeText(draftBox.value); toast("Draft copied"); } catch { draftBox.select(); toast("Select-all done; copy with ⌘C / Ctrl+C"); } } }, "Copy"),
        f.draftEdited ? h("span", { class: "hint" }, "Edited by a person. Sweeps will not overwrite it.") : h("span", { class: "hint" }, "First draft from the drafter. Not reviewed."))]
    : [h("p", { class: "hint" }, "No response draft yet. Review-band findings are drafted on request."),
       h("button", { onclick: () => mutate(() => api("POST", `/api/findings/${f.id}/draft`), "Draft generated") }, "Draft response")];

  return h("tr", { class: "detail" }, h("td", { colspan: 8 },
    h("div", { class: "detail-grid" },
      h("div", {},
        h("h3", {}, "Bid / no-bid brief"),
        h("pre", {}, f.draft?.brief || (f.reasons ?? []).join("\n")),
        h("h3", { class: "mt" }, "Notes"),
        notes,
        f.changed ? h("div", { class: "changed-box" },
          h("strong", {}, "Changed since last sweep: "), f.changed.what.join("; "), " ",
          h("button", { onclick: () => mutate(() => api("PATCH", `/api/findings/${f.id}`, { acknowledgeChange: true, rev: revOf(f.id) }), "Change acknowledged") }, "Acknowledge")) : null,
        keyDatesBlock(f),
        h("h3", { class: "mt" }, "Go / no-go scorecard"),
        goNoGoBlock(f),
        h("h3", { class: "mt" }, "Outcome and value"),
        outcomeBlock(f),
        h("h3", { class: "mt" }, "Action items"),
        h("ul", { class: "actions-list" }, ...(f.actions ?? []).map((a) => actionLi(f, a))),
        h("div", { class: "row" }, newTitle, newWho, newDue, addBtn)),
      h("div", {}, h("h3", {}, "Response draft"), ...draftArea,
        libraryBlock(f),
        h("h3", { class: "mt" }, `Compliance matrix${f.requirements?.length ? ` (${f.requirements.length})` : ""}`),
        complianceBlock(f)),
    )));
}

const DATE_NAMES = { closing: "Closing", questions: "Questions due", preBid: "Pre-bid meeting", siteVisit: "Site visit", award: "Expected award" };
function keyDatesBlock(f) {
  const dates = Object.entries({ ...(f.keyDates ?? {}), ...(f.closeDate ? { closing: f.closeDate } : {}) });
  if (!dates.length) return null;
  return h("div", {}, h("h3", { class: "mt" }, "Key dates"), h("ul", { class: "plain" }, ...dates.sort((a, b) => a[1].localeCompare(b[1])).map(([k, d]) => h("li", {}, `${DATE_NAMES[k] ?? k}: `, dueCell(d)))));
}

function goNoGoBlock(f) {
  const cfg = tenantMeta().goNoGo, g = goNoGo(f.goNoGo);
  return h("div", {},
    h("table", { class: "gng-table" }, h("tbody", {}, ...(cfg.criteria ?? []).map((c) => h("tr", {},
      h("td", {}, c.label, h("span", { class: "hint" }, ` · ${c.weight}`)),
      h("td", {}, h("select", { "aria-label": c.label, onchange: (e) => mutate(() => api("PATCH", `/api/findings/${f.id}`, { goNoGo: { [c.id]: e.target.value }, rev: revOf(f.id) })) },
        ...["unknown", "yes", "partial", "no"].map((v) => h("option", { value: v, selected: (f.goNoGo?.[c.id] ?? "unknown") === v }, v)))))))),
    h("p", { class: `gng-result ${g.verdict}` }, g.answered ? `${g.pct}% — ${g.verdict}${g.verdict === "incomplete" ? ` (${g.answered}/${g.of} answered)` : ""} · threshold ${cfg.threshold ?? 65}%` : "Not scored yet. Answer each criterion; the decision stays a person's."));
}

function outcomeBlock(f) {
  const field = (label, key, value, attrs = {}) => {
    const el = h("input", { value: value ?? "", "aria-label": label, placeholder: label, ...attrs });
    el.addEventListener("change", () => mutate(() => api("PATCH", `/api/findings/${f.id}`, { [key]: el.value, rev: revOf(f.id) }), `${label} saved`));
    return el;
  };
  return h("div", { class: "row" },
    field("Estimated value", "estimatedValue", f.estimatedValue, { inputmode: "numeric" }),
    ["Won", "Lost", "No-bid"].includes(f.status) || f.lossReason ? field("Loss / no-bid reason", "lossReason", f.lossReason) : null,
    ["Won", "Lost"].includes(f.status) || f.awardee ? field("Awarded to", "awardee", f.awardee) : null,
    h("span", { class: "hint" }, "Set status to Won, Lost or No-bid to record the outcome."));
}

function libraryBlock(f) {
  if (!f.libraryMatches?.length) return null;
  const stale = f.libraryMatches.filter((l) => l.stale).length;
  return h("p", { class: "hint mt" }, `${f.libraryMatches.length} library answer(s) cited in the draft`, stale ? h("strong", { class: "stale" }, ` · ${stale} STALE — confirm before use`) : "");
}

function complianceBlock(f) {
  if (!f.requirements?.length) return h("p", { class: "hint" }, "No mandatory statements found on the posting page. Read the full solicitation and addenda.");
  const statuses = state.meta.complianceStatuses;
  return h("div", { class: "compliance" }, ...f.requirements.map((r) => {
    const t = f.compliance?.[r.id] ?? {};
    const owner = assigneeInput(t.owner, "owner", (v) => mutate(() => api("PATCH", `/api/findings/${f.id}`, { compliance: { [r.id]: { owner: v } }, rev: revOf(f.id) })));
    const st = h("select", { "aria-label": "Requirement status", onchange: (e) => mutate(() => api("PATCH", `/api/findings/${f.id}`, { compliance: { [r.id]: { status: e.target.value } }, rev: revOf(f.id) })) },
      ...statuses.map((s) => h("option", { value: s, selected: (t.status ?? "Open") === s }, s)));
    return h("div", { class: `req ${t.status === "Done" || t.status === "N/A" ? "done" : ""}` }, h("div", { class: "rtext" }, h("span", { class: "tag" }, r.kind), " ", r.text), h("div", { class: "rctl" }, owner, st));
  }));
}

function actionLi(f, a) {
  return h("li", { class: a.done ? "done" : "" },
    h("input", { type: "checkbox", checked: a.done, "aria-label": "Done", onchange: (e) => mutate(() => api("PATCH", `/api/findings/${f.id}/actions/${a.id}`, { done: e.target.checked, rev: actionRevOf(f.id, a.id) })) }),
    h("span", { class: "t" }, a.title),
    assigneeInput(a.assignee, "unassigned", (v) => mutate(() => api("PATCH", `/api/findings/${f.id}/actions/${a.id}`, { assignee: v, rev: actionRevOf(f.id, a.id) }), v ? `Action assigned to ${v}` : "Action unassigned")),
    dateInput(a.due, (v) => mutate(() => api("PATCH", `/api/findings/${f.id}/actions/${a.id}`, { due: v || null, rev: actionRevOf(f.id, a.id) }))),
  );
}

function dateInput(value, onSave) {
  const el = h("input", { type: "date", value: value || "", "aria-label": "Due date" });
  el.addEventListener("change", () => onSave(el.value));
  return el;
}

function renderActions() {
  const who = $("#aAssignee").value, me = $("#me").value.trim(), showDone = $("#aShowDone").checked;
  const rows = state.ledger.findings.filter((f) => OPEN.has(f.status))
    .flatMap((f) => (f.actions ?? []).map((a) => ({ f, a })))
    .filter(({ a }) => showDone || !a.done)
    .filter(({ a }) => (!who ? true : who === "__none" ? !a.assignee : who === "__me" ? me && a.assignee === me : a.assignee === who))
    .sort((x, y) => String(x.a.due ?? "9999").localeCompare(String(y.a.due ?? "9999")));
  $("#actionsEmpty").hidden = rows.length > 0;
  $("#actions tbody").replaceChildren(...rows.map(({ f, a }) => h("tr", {},
    h("td", {}, h("input", { type: "checkbox", checked: a.done, "aria-label": "Done", onchange: (e) => mutate(() => api("PATCH", `/api/findings/${f.id}/actions/${a.id}`, { done: e.target.checked, rev: actionRevOf(f.id, a.id) })) })),
    h("td", {}, a.title),
    h("td", { class: "title" }, h("button", { class: "link", onclick: () => { state.open.add(f.id); switchTab("findings"); } }, f.title.slice(0, 80)), h("div", { class: "buyer" }, f.buyer || "")),
    h("td", {}, assigneeInput(a.assignee, "unassigned", (v) => mutate(() => api("PATCH", `/api/findings/${f.id}/actions/${a.id}`, { assignee: v, rev: actionRevOf(f.id, a.id) }), v ? `Assigned to ${v}` : "Unassigned"))),
    h("td", {}, dueCell(a.due)),
  )));
}

function switchTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll(".main-tabs button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const s of document.querySelectorAll(".tab")) s.hidden = s.id !== `tab-${tab}`;
  const pipeline = ["findings", "actions"].includes(tab);
  for (const el of document.querySelectorAll(".pipeline-only")) el.hidden = !pipeline;
  render();
}

// ------------------------------------------------------------------ wiring
$("#tenant").addEventListener("change", (e) => { state.tenant = e.target.value; store.set("rfp.tenant", state.tenant); onTenant(); });
$("#me").addEventListener("change", (e) => { store.set("rfp.me", e.target.value.trim()); render(); });
for (const id of ["q", "fIndustry", "fBand", "fStatus", "fAssignee", "fChanged"]) $(`#${id}`).addEventListener("input", renderFindings);
for (const id of ["aAssignee", "aShowDone"]) $(`#${id}`).addEventListener("input", renderActions);
for (const b of document.querySelectorAll(".main-tabs button")) b.addEventListener("click", () => switchTab(b.dataset.tab));

$("#runSweep").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Sweeping…";
  try {
    const r = await api("POST", "/api/sweep", { industry: $("#sweepIndustry").value || null, width: Number($("#sweepWidth").value), direct: $("#sweepDirect").checked });
    toast(r.summary.map((s) => `${s.industry}: ${s.halted ? `HALTED — ${s.haltReason}` : `${s.added} new, ${s.refreshed} refreshed, ${s.gaps} gap(s)`}`).join("\n"));
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = "Run sweep";
  loadLedger();
});

$("#exportXlsx").addEventListener("click", async () => {
  try {
    const res = await api("GET", "/api/export.xlsx");
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || `${state.tenant}-rfp-findings.xlsx`;
    const a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast(e.message, true); }
});

$("#exportIcs").addEventListener("click", async () => {
  try {
    const res = await api("GET", "/api/calendar.ics");
    const a = h("a", { href: URL.createObjectURL(await res.blob()), download: `${state.tenant}-rfp-deadlines.ics` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast(e.message, true); }
});

$("#importXlsx").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const r = await api("POST", "/api/import", await file.arrayBuffer(), true);
    const lines = [`${r.applied.length} change(s), ${r.added.length} new action(s) imported.`];
    if (r.conflicts.length) lines.push(`${r.conflicts.length} conflict(s) skipped:`, ...r.conflicts.slice(0, 5));
    if (r.errors.length) lines.push(`${r.errors.length} error(s):`, ...r.errors.slice(0, 5));
    toast(lines.join("\n"), r.conflicts.length + r.errors.length > 0);
  } catch (err) { toast(err.message, true); }
  loadLedger();
});

$("#importRun").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const r = await api("POST", "/api/import-run", await file.arrayBuffer(), true);
    toast(`n8n run imported: ${r.added} new, ${r.refreshed} refreshed.`);
  } catch (err) { toast(err.message, true); }
  loadLedger();
});


// =================================================================== RFP Sweep
// Industry → Geography → Capability → Date range. Locally this runs a live sweep;
// on the published site it searches the latest scheduled sweep in the browser.

const R = () => window.RFP;
const GENERAL = "all";

/** Published site: decisions (status, owner) made here are kept in this browser only, over the published data. */
const localEdits = {
  all() { try { return JSON.parse(localStorage.getItem("rfp.edits") || "{}"); } catch { return {}; } },
  save(id, patch) { try { const e = this.all(); e[id] = { ...e[id], ...patch, at: new Date().toISOString() }; localStorage.setItem("rfp.edits", JSON.stringify(e)); } catch { /* private window */ } },
  apply(ledger) {
    const e = this.all();
    for (const f of ledger.findings ?? []) if (e[f.id]) { const { at, ...patch } = e[f.id]; Object.assign(f, patch, { localEdit: at }); }
    return ledger;
  },
};

async function fetchLedgerFor(tid) {
  if (STATIC) { const r = await fetch(`data/${tid}.json`, { cache: "no-cache" }); return localEdits.apply(r.ok ? await r.json() : { findings: [], runs: [], gaps: [] }); }
  const r = await fetch(`/api/ledger?tenant=${encodeURIComponent(tid)}`);
  return r.json();
}

function setupSweepForm() {
  const m = state.meta;
  // Industry = who is buying (from the publishing organization), plus the logistics markets.
  const logistics = m.industries.filter((i) => i.id.startsWith("logistics"));
  $("#sIndustry").replaceChildren(h("option", { value: "" }, "All industries"),
    ...m.sectors.filter((x) => x.id !== "other").map((x) => h("option", { value: `sector:${x.id}` }, x.label)),
    ...logistics.map((i) => h("option", { value: `pack:${i.id}` }, `${i.name}${i.status === "proven" ? "" : ` [${i.status}]`}`)));
  $("#sGeo").replaceChildren(...m.geographies.map((g) => h("option", { value: g.id }, g.label)));
  $("#sCap").replaceChildren(h("option", { value: "" }, "All capabilities"), ...m.capabilities.map((c) => h("option", { value: c.id }, c.label)));
  $("#sDays").replaceChildren(...m.dateRanges.map((d) => h("option", { value: d.id, selected: d.id === "30" }, d.label)));
  const saved = (() => { try { return JSON.parse(localStorage.getItem("rfp.sweep") || "{}"); } catch { return {}; } })();
  for (const [k, id] of [["industry", "sIndustry"], ["geo", "sGeo"], ["cap", "sCap"], ["days", "sDays"], ["status", "sStatus"]]) if (saved[k] != null) $(`#${id}`).value = saved[k];
  // Changing the status filter re-filters at once; no new sweep is needed.
  $("#sStatus").addEventListener("change", () => { state.sweepIds = null; state.sweepFiltered = true; renderSweepResults(); });
  const note = STATIC
    ? ["Searches the latest scheduled sweep of CanadaBuys open data, SAM.gov and the public portals (refreshed every 6 hours)."]
    : ["Runs a live sweep of CanadaBuys open data, SAM.gov and the public portals, then scores every posting. Takes up to a minute."];
  if (STATIC && state.meta.repo) note.push(" To refresh now: ", h("a", { href: `https://github.com/${state.meta.repo}/actions/workflows/pages.yml`, target: "_blank", rel: "noopener noreferrer" }, "run the sweep workflow"), " (about two minutes).");
  $("#sNote").replaceChildren(...note);
  $("#sRun").onclick = runSearch;
  fetchLedgerFor(GENERAL).then((l) => { state.allLedger = l; renderSweepResults(); });
  loadProfile().then(() => renderSweepResults());
}

function sweepParams() {
  const p = { industry: $("#sIndustry").value, geography: $("#sGeo").value, capability: $("#sCap").value, days: $("#sDays").value, status: $("#sStatus").value };
  try { localStorage.setItem("rfp.sweep", JSON.stringify({ industry: p.industry, geo: p.geography, cap: p.capability, days: p.days, status: p.status })); } catch { /* ignore */ }
  return p;
}

const sectorOf = (f) => f.sector ?? R().classifySector({ buyer: f.buyer, source: f.channel });
/** Fit shown everywhere in the sweep: to the company's product offering when there is a profile, else the sweep's own score. */
function fitOf(f) {
  if (state.profile) {
    const c = f._fit ?? (f._fit = R().companyFit(f, state.profile));
    return { score: c.score, band: c.band === "strong" ? "pursue" : c.band === "possible" ? "review" : "low", why: c.reasons.join("\n") };
  }
  return f.raw ? { score: null, band: "low", why: "Seen by the sweep; not scored by an industry pack" } : { score: f.score, band: f.band, why: (f.reasons ?? []).join("\n") };
}
function industryMatch(f, sel) {
  if (!sel) return true;
  const [kind, id] = sel.split(":");
  if (kind === "pack") return f.industry === id;
  // A buyer industry, or what that industry's own search found (e.g. an education co-op for K-12).
  if (kind === "sector") return sectorOf(f)?.id === id || (f.industry && state.meta.sectors.find((x) => x.id === id)?.pack === f.industry && f.industry !== "any");
  return f.industry === sel; // older saved choice
}

const OPEN_STATUSES = new Set(["New", "Qualifying", "Pursuing", "Drafting"]);
/** Active: still open. Past due: closing date passed while we had not submitted or decided. Closed: date passed or decided. */
function lifecycle(f, today = new Date().toISOString().slice(0, 10)) {
  const passed = f.closeDate && f.closeDate < today;
  if (!passed && OPEN_STATUSES.has(f.status ?? "New")) return "active";
  if (passed && OPEN_STATUSES.has(f.status ?? "New")) return "pastdue";
  return "closed";
}
function statusMatch(f, want) {
  if (!want || want === "all") return true;
  const l = lifecycle(f);
  return want === "closed" ? l !== "active" : l === want;
}

function clientFilter(findings, p) {
  const geo = state.meta.geographies.find((g) => g.id === p.geography)?.countries ?? ["CA", "US"];
  const days = state.meta.dateRanges.find((d) => d.id === p.days)?.days;
  const since = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : null;
  const today = new Date().toISOString().slice(0, 10);
  return findings.filter((f) =>
    industryMatch(f, p.industry) &&
    (!f.country || geo.includes(f.country)) &&
    (!p.capability || (f.capabilities ?? []).some((c) => c.id === p.capability)) &&
    (!since || !f.publishedDate || f.publishedDate >= since) &&
    statusMatch(f, p.status ?? "active"));
}

async function runSearch() {
  const p = sweepParams();
  const btn = $("#sRun");
  if (STATIC) {
    btn.disabled = true; btn.textContent = "Searching…";
    await new Promise((r) => setTimeout(r, 350));
    const all = state.allLedger?.findings ?? [];
    const hits = clientFilter(all, p);
    state.sweepIds = new Set(hits.map((f) => f.id));
    state.sweepLow = null;
    btn.disabled = false; btn.textContent = "Run RFP Sweep";
    renderSweepResults();
    toast(`Searched ${all.length} opportunities from the latest sweep: ${hits.length} matched.`);
    $("#sResults").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  btn.disabled = true; btn.textContent = "Sweeping…";
  try {
    const days = state.meta.dateRanges.find((d) => d.id === p.days)?.days;
    // Map the chosen buyer industry to the search pack: K-12 and nonprofit have their own; the rest search capability-led.
    const [kind, id] = (p.industry || "").split(":");
    const pack = kind === "pack" ? id : kind === "sector" ? state.meta.sectors.find((x) => x.id === id)?.pack : "";
    const r = await fetch("/api/search?tenant=all", { method: "POST", headers: { "X-RFP-Dashboard": "1", "content-type": "application/json" }, body: JSON.stringify({ ...p, industry: pack || "", days, profileTerms: state.profile ? R().profileSearch(state.profile) : null }) }).then(async (x) => { const j = await x.json(); if (!x.ok) throw new Error(j.error); return j; });
    state.allLedger = await fetchLedgerFor(GENERAL);
    if (state.profile) { state.postings = null; await loadPostings(); }
    // Keep only what matches the chosen buyer industry.
    state.sweepIds = new Set(state.allLedger.findings.filter((f) => r.ids.includes(f.id) && industryMatch(f, p.industry)).map((f) => f.id));
    state.sweepLow = r.low;
    if (r.gaps) toast(`${r.gaps} source(s) could not be read this time (bot checks, sign-ins or errors); the rest were swept.`);
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = "Run RFP Sweep";
  renderSweepResults();
}

/** What each workflow step shows when clicked. */
const FLOW_FILTERS = {
  understand: { label: "Read in depth", test: (f) => (f.requirements ?? []).length > 0 || !!f.workspace?.analysis },
  qualify: { label: "High fit", test: (f) => fitOf(f).band === "pursue" },
  assign: { label: "Assigned", test: (f) => !!f.assignee, fallback: { label: "Unassigned (none are assigned yet)", test: (f) => !f.assignee } },
  answer: { label: "Drafted", test: (f) => !!f.workspace?.answers, empty: "Nothing drafted yet. Open an opportunity and press Draft response." },
  review: { label: "Ready to submit or submitted", test: (f) => f.status === "Submitted" || f.workspace?.redTeam?.readiness === "Ready", empty: "Nothing is ready to submit yet. Open a drafted opportunity, proofread it, then check its RFP submission status." },
};

function onFlowStep(step) {
  if (step === "discover") {
    state.flowFilter = null;
    $(".sweep-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    $("#sRun")?.focus();
    return renderSweepResults();
  }
  if (step === "export") {
    const ws = state.ws ?? state.aws;
    if (ws?.analysis) return exportScoring(ws);
    return $("#exportXlsx") ? $("#exportXlsx").click() : toast("Open an opportunity first, then export its scoring file.");
  }
  state.flowFilter = state.flowFilter === step ? null : step;
  renderSweepResults();
  $("#sResults")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Live numbers on the workflow strip, and which step the person is on. */
function renderFlow(list) {
  const set = (id, t) => { const el = $(`#${id}`); if (el) el.textContent = t; };
  const all = state.allLedger?.findings ?? [];
  const shown = list ?? all;
  set("flowDiscover", `${shown.length} opportunit${shown.length === 1 ? "y" : "ies"}`);
  set("flowUnderstand", `${shown.filter((f) => (f.requirements ?? []).length || f.workspace?.analysis).length} read in depth`);
  set("flowQualify", `${shown.filter((f) => fitOf(f).band === "pursue").length} high fit`);
  set("flowAssign", `${shown.filter((f) => f.assignee).length} assigned`);
  set("flowAnswer", `${shown.filter((f) => f.workspace?.answers).length} drafted`);
  set("flowReview", `${shown.filter((f) => f.status === "Submitted" || f.workspace?.redTeam?.readiness === "Ready").length} ready or submitted`);
  set("flowExport", "Excel + proposal");
  const ws = state.ws ?? state.aws;
  const stage = !ws ? (state.sweepIds ? "qualify" : "discover") : ws.redTeam ? "export" : ws.answers ? "review" : ws.analysis ? (ws.finding?.assignee ? "answer" : "assign") : "understand";
  const order = ["discover", "understand", "qualify", "assign", "answer", "review", "export"];
  for (const li of document.querySelectorAll("#flowSteps li")) {
    const i = order.indexOf(li.dataset.step), cur = order.indexOf(stage);
    li.classList.toggle("active", i === cur);
    li.classList.toggle("done", i < cur);
    li.classList.toggle("filtering", state.flowFilter === li.dataset.step);
    if (!li.dataset.wired) {
      li.dataset.wired = "1";
      li.setAttribute("role", "button");
      li.setAttribute("tabindex", "0");
      li.addEventListener("click", () => onFlowStep(li.dataset.step));
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onFlowStep(li.dataset.step); } });
    }
    li.title = { discover: "Go to the sweep", export: "Export the scoring file" }[li.dataset.step] ?? `Show: ${FLOW_FILTERS[li.dataset.step]?.label}`;
  }
}

function renderSweepResults() {
  const box = $("#sResults");
  if (!box || !state.allLedger) return;
  const p = { industry: $("#sIndustry").value, geography: $("#sGeo").value, capability: $("#sCap").value, days: $("#sDays").value, status: $("#sStatus").value };
  let list = (state.sweepIds && p.status === "active" ? state.allLedger.findings.filter((f) => state.sweepIds.has(f.id)) : clientFilter(state.allLedger.findings, p)).sort((a, b) => b.score - a.score);
  // With a company profile: add every posting the sweep saw (not only what the packs kept),
  // score each against the company, and show the relevant ones first.
  let relevance = null;
  if (state.profile) {
    const have = new Set(list.map((f) => `${(f.title ?? "").toLowerCase()}|${(f.buyer ?? "").toLowerCase()}`));
    const extra = clientFilter((state.postings ?? []).filter((r) => !have.has(`${(r.title ?? "").toLowerCase()}|${(r.buyer ?? "").toLowerCase()}`)), p);
    const all = [...list, ...extra];
    const relevant = all.filter((f) => fitOf(f).score >= 40);
    relevance = { all: all.length, relevant: relevant.length };
    list = (state.relevantOnly ? relevant : all).sort((a, b) => fitOf(b).score - fitOf(a).score || (b.score ?? 0) - (a.score ?? 0));
  }
  renderFlow(state.sweepIds ? list : null);
  let flowNote = null;
  if (state.flowFilter && FLOW_FILTERS[state.flowFilter]) {
    let ff = FLOW_FILTERS[state.flowFilter];
    let narrowed = list.filter(ff.test);
    if (!narrowed.length && ff.fallback) { ff = ff.fallback; narrowed = list.filter(ff.test); }
    flowNote = h("div", { class: "flow-note" }, h("span", {}, "Showing: ", h("strong", {}, ff.label), ` · ${narrowed.length} of ${list.length}`), h("button", { class: "keep link", onclick: () => { state.flowFilter = null; renderSweepResults(); } }, "Show all ✕"));
    if (!narrowed.length && ff.empty) flowNote.append(h("div", { class: "hint" }, ff.empty));
    list = narrowed;
  }
  const high = list.filter((f) => fitOf(f).band === "pursue").length, review = list.filter((f) => fitOf(f).band === "review").length;
  // A narrower geography hides matches elsewhere: say how many, with one click to show them.
  let geoNote = null;
  if (p.geography && p.geography !== "na" && !state.flowFilter) {
    const wider = clientFilter(state.allLedger.findings, { ...p, geography: "na" }).length - clientFilter(state.allLedger.findings, p).length;
    const label = state.meta.geographies.find((g) => g.id === p.geography)?.label ?? p.geography;
    if (wider > 0) geoNote = h("div", { class: "flow-note geo-note" }, h("span", {}, `${wider} more ${wider === 1 ? "match" : "matches"} outside ${label}.`), h("button", { class: "keep link", onclick: () => { $("#sGeo").value = "na"; state.sweepIds = null; renderSweepResults(); } }, "Show North America"));
  }
  box.replaceChildren(
    ...(geoNote ? [geoNote] : []),
    ...(flowNote ? [flowNote] : []), // replaceChildren prints a null as the text "null"
    h("div", { class: "results-head" },
      h("h2", {}, relevance ? `${list.length} ${list.length === 1 ? "opportunity" : "opportunities"} ${state.relevantOnly ? `relevant to ${state.profile.name}` : "found"}` : `${list.length} ${list.length === 1 ? "opportunity" : "opportunities"} found`,
        relevance && state.relevantOnly && relevance.all > relevance.relevant ? h("span", { class: "hint h2-hint" }, ` · ${relevance.all - relevance.relevant} less relevant hidden`) : null),
      h("span", { class: "counts" }, h("span", { class: "pill pursue" }, `${high} ${state.profile ? "Strong fit" : "High fit"}`), " ", h("span", { class: "pill review" }, `${review} ${state.profile ? "Possible fit" : "Review"}`), state.sweepLow != null && !state.profile ? [" ", h("span", { class: "pill low" }, `${state.sweepLow} Low fit (not listed)`)] : "")),
    list.length ? h("div", { class: "tablewrap" }, h("table", { class: "grid" },
      h("thead", {}, h("tr", {}, ...["Fit", "Opportunity", "Customer", "Industry", "Deadline", "Owner", "Status", ""].map((x) => h("th", { title: x === "Fit" ? (state.profile ? `Fit to what ${state.profile.name} sells, from its website` : "Add your company website to score fit on what you sell") : "" }, x)))),
      h("tbody", {}, ...list.map((f) => {
        const d = daysLeft(f.closeDate);
        return h("tr", { class: state.ws?.finding?.id === f.id ? "selected" : "" },
          h("td", {}, (() => { const x = fitOf(f); return h("span", { class: `pill ${x.band}`, title: x.why }, x.score ?? "—"); })()),
          h("td", { class: "title" }, f.url ? h("a", { href: f.url, target: "_blank", rel: "noopener noreferrer" }, f.title) : f.title,
            h("div", { class: "buyer" }, (f.capabilities ?? []).slice(0, 2).map((c) => h("span", { class: "tag" }, c.label)), f.noticeType ? h("span", { class: "tag" }, f.noticeType) : null)),
          h("td", {}, f.buyer || "—"),
          h("td", {}, (() => { const sc = sectorOf(f); return h("span", { title: sc ? `Inferred: ${sc.basis}` : "" }, sc?.label ?? "—"); })()),
          h("td", {}, f.closeDate ? h("span", { class: `due ${d < 0 ? "over" : d <= 14 ? "soon" : ""}` }, f.closeDate, h("br"), `${d} days`) : h("span", { class: "unassigned" }, "not stated")),
          h("td", {}, f.assignee || h("span", { class: "unassigned" }, f.team ? `suggest: ${f.team.rfpManager ?? "RFP Manager"}` : "unassigned")),
          h("td", {}, f.status, (() => { const l = lifecycle(f); return l === "active" ? null : h("div", {}, h("span", { class: `tag life-${l}` }, l === "pastdue" ? "past due" : "closed")); })()),
          h("td", {}, h("button", { class: "primary small", onclick: () => openWorkspace(f, "#sWorkspace") }, "Open")));
      })))) : emptySweep(p));
}

function emptySweep(p) {
  if (!state.sweepIds) return h("p", { class: "empty" }, "Pick what you are looking for and press Run RFP Sweep.");
  const all = state.allLedger?.findings ?? [];
  const label = (k, v) => ({ industry: v ? (state.meta.sectors.find((x) => `sector:${x.id}` === v)?.label ?? state.meta.industries.find((i) => `pack:${i.id}` === v)?.name ?? v) : "All industries", geography: state.meta.geographies.find((g) => g.id === v)?.label, capability: v ? state.meta.capabilities.find((c) => c.id === v)?.label : "All capabilities", days: state.meta.dateRanges.find((d) => d.id === v)?.label, status: { active: "Active", pastdue: "Past due", closed: "Closed", all: "All statuses" }[v] })[k];
  const tries = [
    ["capability", ""], ["days", "any"], ["geography", "na"], ["industry", ""], ["status", "all"],
  ].filter(([k, v]) => p[k] !== v).map(([k, v]) => ({ k, v, n: clientFilter(all, { ...p, [k]: v }).length })).filter((t) => t.n > 0);
  const ids = { industry: "sIndustry", geography: "sGeo", capability: "sCap", days: "sDays", status: "sStatus" };
  const [pk, pid] = (p.industry || "").split(":");
  const pack = state.meta.packs.find((x) => x.id === (pk === "pack" ? pid : state.meta.sectors.find((s) => s.id === pid)?.pack));
  const geo = state.meta.geographies.find((g) => g.id === p.geography)?.countries ?? ["CA", "US"];
  const portals = (pack?.channels ?? []).map((c) => state.meta.channels.find((x) => x.id === c.ref)).filter((c) => c && c.render !== "server" && (!c.country || geo.includes(c.country)));
  return h("div", { class: "card empty-sweep" },
    h("h3", {}, "Nothing matched in the latest sweep"),
    tries.length ? [h("p", {}, "Opportunities do exist if you widen one filter:"),
      h("div", { class: "row" }, ...tries.map((t) => h("button", { class: "keep", onclick: () => { $(`#${ids[t.k]}`).value = t.v; runSearch(); } }, `${label(t.k, t.v)}: ${t.n}`)))]
      : h("p", {}, "No opportunities match even with wider filters in the latest sweep."),
    portals.length ? [h("p", { class: "mt" }, `${pack.name} buyers mostly post on these portals, which block automated reading. Check them directly:`),
      h("ul", { class: "plain portals" }, ...portals.map((c) => h("li", {}, h("a", { href: c.url, target: "_blank", rel: "noopener noreferrer" }, c.name), h("span", { class: "hint" }, ` · ${c.region ?? c.country ?? ""}${c.access !== "free" ? ` · ${c.access}` : ""}`))))] : null,
    h("p", { class: "hint mt" }, "Found an RFP there? Download it and load it in Analyze a document for the full five-step analysis."));
}


// =================================================================== Your company
// Understand the business from its website, then score every opportunity against it.
// Locally the server reads the website. The published page cannot read other sites
// (browsers block it unless a site allows it), so it offers paste / upload instead.

state.profile = null;
state.postings = null;
state.relevantOnly = true;

async function loadProfile() {
  try {
    if (STATIC) state.profile = JSON.parse(localStorage.getItem("rfp.profile") || "null");
    else { const r = await fetch("/api/profile"); const j = await r.json(); state.profile = j && j.name ? j : null; }
  } catch { state.profile = null; }
  try { state.relevantOnly = localStorage.getItem("rfp.relevantOnly") !== "0"; } catch { /* default on */ }
  if (state.profile) await loadPostings();
  renderCompany();
}

async function saveProfile(p) {
  state.profile = p;
  forgetFits();
  if (STATIC) { try { localStorage.setItem("rfp.profile", JSON.stringify(p)); } catch { /* private window */ } }
  else await fetch("/api/profile", { method: "PUT", headers: { "X-RFP-Dashboard": "1", "content-type": "application/json" }, body: JSON.stringify(p) });
}

function forgetFits() {
  for (const f of [...(state.allLedger?.findings ?? []), ...(state.postings ?? [])]) delete f._fit;
  const ws = state.ws ?? state.aws;
  if (ws?.analysis && document.body.contains($(ws.target))) { refreshFit(ws); if ($(ws.target)?.firstChild) renderWorkspace(ws); }
}

async function clearProfile() {
  state.profile = null;
  forgetFits();
  if (STATIC) { try { localStorage.removeItem("rfp.profile"); } catch { /* ignore */ } }
  else await fetch("/api/profile", { method: "DELETE", headers: { "X-RFP-Dashboard": "1" } });
  renderCompany(); renderSweepResults();
}

async function loadPostings() {
  if (state.postings) return;
  try {
    const r = await fetch(STATIC ? "data/postings.json" : "/api/postings", { cache: "no-cache" });
    const j = r.ok ? await r.json() : { postings: [] };
    state.postings = (j.postings ?? []).map(rawToFinding);
  } catch { state.postings = []; }
}

function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h.toString(36); }
/** A posting the sweep saw but no pack kept, shaped like a finding so every screen works with it. */
function rawToFinding(p) {
  const caps = R().matchCapabilities(p.title, p.summary ?? "").slice(0, 3);
  return { id: `raw-${strHash(`${p.url}|${p.title}`)}`, raw: true, title: p.title, buyer: p.buyer, url: p.url, country: p.country, channel: p.channel,
    closeDate: p.closeDate, publishedDate: p.publishedDate, noticeType: p.noticeType, summary: p.summary, sourceText: p.summary ?? "", sourceId: p.sourceId ?? null,
    band: "raw", score: null, status: "New", sector: R().classifySector({ buyer: p.buyer, source: p.channel }),
    capabilities: caps.map(({ id, label, matched }) => ({ id, label, matched })) };
}

async function buildFromWebsite(url) {
  if (!url) return toast("Enter your company's website first.", true);
  const home = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  if (STATIC) {
    // The published page's security policy lets it talk only to its own site, so it
    // cannot read another website. Guide the person to paste or upload instead.
    state.profileFallback = true; state.pendingWebsite = home;
    renderCompany();
    $("#pText")?.focus();
    return;
  }
  const btn = $("#pBuild");
  if (btn) { btn.disabled = true; btn.textContent = "Reading your website…"; }
  try {
    const r = await fetch("/api/profile/build", { method: "POST", headers: { "X-RFP-Dashboard": "1", "content-type": "application/json" }, body: JSON.stringify({ url: home }) });
    const profile = await r.json();
    if (!r.ok) throw new Error(profile.error);
    state.profile = profile; state.postings = null; await loadPostings();
    state.profileEditing = true;
    toast(`Read ${profile.pagesRead?.length ?? 1} page(s) of ${profile.name}: ${profile.capabilities.length} capabilit${profile.capabilities.length === 1 ? "y" : "ies"}, ${profile.industries.length} industr${profile.industries.length === 1 ? "y" : "ies"}. Review it below.`);
  } catch (e) {
    state.profileFallback = true; state.pendingWebsite = home;
    toast(`${e.message}. Paste the text of your website or upload a brochure instead.`, true);
  }
  renderCompany(); renderSweepResults();
}

async function buildFromText(text, name, website) {
  if (!text || text.trim().length < 80) return toast("Paste at least a paragraph about what your company sells and to whom.", true);
  let site = website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : null;
  // Only a public website is kept on the profile (the same rule as the server's guard).
  if (site && /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[)/i.test(site)) site = null;
  const profile = R().buildProfile({ website: site, pages: [R().textFacts(text, name || "")], source: "pasted text" });
  if (name) profile.name = name;
  else if (profile.name === "Your company" && site) { try { profile.name = new URL(site).hostname.replace(/^www\./, "").split(".")[0].replace(/^./, (c) => c.toUpperCase()); } catch { /* keep */ } }
  state.pendingWebsite = null;
  await saveProfile(profile); await loadPostings();
  state.profileEditing = true; state.profileFallback = false;
  toast(`Profile built: ${profile.capabilities.length} capabilit${profile.capabilities.length === 1 ? "y" : "ies"}, ${profile.industries.length} industr${profile.industries.length === 1 ? "y" : "ies"}`);
  renderCompany(); renderSweepResults();
}

function chip(item, label, onToggle) {
  return h("button", { class: `chip keep ${item.on === false ? "off" : "on"}`, "aria-pressed": String(item.on !== false), title: item.evidence?.length ? `From your site: ${item.evidence.join(", ")}` : item.mentions ? `${item.mentions} mention(s)` : "", onclick: () => { item.on = item.on === false; onToggle(); } }, item.on === false ? "＋ " : "✓ ", label);
}

function renderCompany() {
  const box = $("#companyCard");
  if (!box) return;
  const p = state.profile;
  if (!p) {
    const url = h("input", { id: "pUrl", type: "url", placeholder: "https://www.yourcompany.com", "aria-label": "Company website", autocomplete: "url", value: state.pendingWebsite ?? "" });
    url.addEventListener("keydown", (e) => { if (e.key === "Enter") buildFromWebsite(url.value.trim()); });
    const text = h("textarea", { id: "pText", placeholder: "…or paste your About / Products / Solutions text here" });
    const name = h("input", { id: "pName", placeholder: "Company name (optional)" });
    const file = h("input", { id: "pFile", type: "file", accept: ".pdf,.docx,.txt,.md,.html,.htm" });
    file.addEventListener("change", async () => { const fl = file.files[0]; if (!fl) return; try { text.value = await readDocument(fl); toast(`${fl.name} read`); } catch (e) { toast(`Could not read ${fl.name}: ${e.message}`, true); } });
    box.replaceChildren(
      h("div", { class: "company-head" }, h("h2", {}, "Your company"), h("span", { class: "hint" }, "Tell the sweep what you sell. It reads your website, works out your offering, and scores every RFP against it.")),
      h("div", { class: "row company-row" }, url, h("button", { id: "pBuild", class: "primary", onclick: () => buildFromWebsite(url.value.trim()) }, "Understand my business")),
      h("details", { class: "company-alt", open: state.profileFallback || undefined },
        h("summary", {}, STATIC ? "Can't read your website here? Paste text or upload a brochure" : "Or paste text / upload a brochure"),
        state.profileFallback ? h("p", { class: "notice" }, STATIC ? "For security, this published page can only talk to its own site, so it cannot read yours. " : "The website could not be read. ",
          state.pendingWebsite ? ["Open ", h("a", { href: state.pendingWebsite, target: "_blank", rel: "noopener noreferrer" }, state.pendingWebsite.replace(/^https?:\/\//, "")), ", "] : "Open your website, ",
          "copy the text of its home, products and about pages, and paste it here (or upload a brochure).", STATIC ? " The local dashboard (npm run dashboard) reads the website for you." : "") : null,
        name, text, h("div", { class: "row" }, file, h("button", { id: "pBuildText", class: state.profileFallback ? "primary" : "keep", onclick: () => buildFromText(text.value, name.value.trim(), url.value.trim()) }, "Build profile from text"))));
    return;
  }
  // A chip toggle or an added capability is saved at once; terms and name on "Save profile".
  const rerender = async () => { await saveProfile(p); renderCompany(); renderSweepResults(); };
  const kw = h("input", { class: "kw-input", value: (p.keywords ?? []).join(", "), "aria-label": "Your terms" });
  const nm = h("input", { class: "name-input", value: p.name ?? "", "aria-label": "Company name" });
  const editing = !!state.profileEditing;
  box.replaceChildren(
    h("div", { class: "company-head" },
      h("div", {}, h("h2", {}, "Scoring for ", h("span", { class: "co-name" }, p.name)),
        h("div", { class: "hint" }, p.website ? h("a", { href: p.website, target: "_blank", rel: "noopener noreferrer" }, p.website.replace(/^https?:\/\//, "")) : "from pasted text",
          ` · ${p.pagesRead?.length ? `${p.pagesRead.length} page(s) read` : `${p.words ?? 0} words`} · inferred from ${p.source === "pasted text" ? "your text" : "your website"}; review before relying on it`)),
      h("div", { class: "row" },
        h("label", { class: "check" }, h("input", { type: "checkbox", id: "pRelevant", checked: state.relevantOnly, onchange: (e) => { state.relevantOnly = e.target.checked; try { localStorage.setItem("rfp.relevantOnly", e.target.checked ? "1" : "0"); } catch { /* ignore */ } renderSweepResults(); } }), " Show only RFPs relevant to us"),
        h("button", { class: "keep", onclick: () => { state.profileEditing = !editing; renderCompany(); } }, editing ? "Done" : "Edit profile"),
        p.website && !STATIC ? h("button", { class: "keep", onclick: () => buildFromWebsite(p.website) }, "Re-read website") : null,
        h("button", { class: "keep link", onclick: () => { if (confirm("Remove this company profile?")) clearProfile(); } }, "Remove"))),
    p.summary ? h("p", { class: "co-summary" }, p.summary) : null,
    h("div", { class: "co-grid" },
      h("div", {}, h("h4", {}, "What you sell"), h("div", { class: "chips" }, ...(p.capabilities.length ? p.capabilities.map((c) => chip(c, c.label, rerender)) : [h("span", { class: "hint" }, "No capability recognised. Add your terms below.")]),
        editing ? h("select", { class: "add-cap", "aria-label": "Add a capability", onchange: (e) => { const c = state.meta.capabilities.find((x) => x.id === e.target.value); if (c && !p.capabilities.some((x) => x.id === c.id)) p.capabilities.push({ id: c.id, label: c.label, strength: 0, evidence: ["added by you"], on: true }); rerender(); } },
          h("option", { value: "" }, "＋ Add capability"), ...state.meta.capabilities.filter((c) => !p.capabilities.some((x) => x.id === c.id)).map((c) => h("option", { value: c.id }, c.label))) : null)),
      h("div", {}, h("h4", { title: "Read from your website for context. Fit is scored on what you sell, not on the buyer's industry." }, "Who you serve (context)"), h("div", { class: "chips" }, ...(p.industries.length ? p.industries.map((i) => h("span", { class: "tag", title: i.evidence?.length ? `From your site: ${i.evidence.join(", ")}` : "" }, i.label)) : [h("span", { class: "hint" }, "None named on the site.")]))),
      h("div", {}, h("h4", {}, "Platforms"), h("div", { class: "chips" }, ...(p.platforms.length ? p.platforms.map((x) => chip(x, x.name, rerender)) : [h("span", { class: "hint" }, "None named.")]))),
      h("div", { class: "co-terms" }, h("h4", {}, "Your terms"), editing ? [kw, h("div", { class: "hint" }, "Comma-separated. RFPs using these words score higher.")] : h("div", { class: "chips" }, ...(p.keywords ?? []).slice(0, 14).map((k) => h("span", { class: "tag" }, k))))),
    editing ? h("div", { class: "row" }, h("label", {}, "Name ", nm), h("button", { class: "primary", onclick: async () => { p.keywords = kw.value.split(",").map((x) => x.trim()).filter(Boolean); p.name = nm.value.trim() || p.name; state.profileEditing = false; await rerender(); toast("Profile saved. Every RFP is re-scored against it."); } }, "Save profile")) : null);
}

// =================================================================== Workspace
// Qualify → Assign → Analyze RFP → Draft response → Proofread → RFP submission status, for one opportunity.

const STEPS = [["qualify", "Qualify"], ["assign", "Assign"], ["analyze", "Analyze RFP"], ["draft", "Draft response"], ["proofread", "Proofread"], ["submission", "RFP submission status"]];
const WS_TABS = [["overview", "Overview"], ["requirements", "Requirements"], ["risks", "Risks"], ["team", "Team"], ["responses", "Responses"], ["proofread", "Proofread"], ["proposal", "Proposal"], ["submission", "Submission status"]];

function openWorkspace(f, target) {
  const saved = f.workspace ?? {};
  state.ws = {
    target, finding: f, title: f.title, buyer: f.buyer, url: f.url, text: f.sourceText || "", proposalText: "",
    analysis: saved.analysis ?? null, answers: saved.answers ?? null, proposal: saved.proposal ?? null, proofread: saved.proofread ?? null, redTeam: saved.redTeam ?? null,
    team: saved.teamOverride ?? f.team ?? null, tab: "overview", documentName: saved.documentName ?? null,
  };
  if (!state.ws.analysis && state.ws.text) runAnalyze(state.ws, { silent: true });
  renderSweepResults();
  renderWorkspace(state.ws);
  showOverlay(target);
  if (!STATIC && f.rfp?.fullText) loadFullText(state.ws);
}

/** Locally, the sweep kept the full solicitation it read (notice + documents): analyze that, not the summary. */
async function loadFullText(ws) {
  try {
    const r = await fetch(`/api/findings/${encodeURIComponent(ws.finding.id)}/text`);
    if (!r.ok) return;
    const { text } = await r.json();
    if (!text || text.length <= (ws.text ?? "").length) return;
    ws.text = text;
    ws.documentName = ws.documentName ?? (ws.finding.rfp.sources ?? []).filter((x) => x.kind === "document" && !x.error).map((x) => x.name).join(", ");
    // Re-analyze on the full text unless drafting has started on the earlier analysis.
    if (!ws.answers && (!ws.analysis || (ws.analysis.words ?? 0) < 400)) runAnalyze(ws, { silent: true });
    if (ws === state.ws || ws === state.aws) renderWorkspace(ws);
  } catch { /* keep the summary */ }
}

// The opportunity workspace opens as a panel over the page, so it is visible
// wherever the person clicked Open in a long list.
function showOverlay(target) {
  const box = $(target);
  box.classList.add("ws-overlay");
  document.body.classList.add("ws-open");
  box.scrollTop = 0;
  box.querySelector(".workspace")?.focus?.();
}
function hideOverlay(target) {
  const box = $(target);
  box.classList.remove("ws-overlay");
  box.replaceChildren();
  document.body.classList.remove("ws-open");
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("ws-open")) { hideOverlay("#sWorkspace"); state.ws = null; renderSweepResults(); } });
document.addEventListener("click", (e) => { if (e.target?.id === "sWorkspace" && e.target.classList.contains("ws-overlay")) { hideOverlay("#sWorkspace"); state.ws = null; renderSweepResults(); } });

function wsMeta(ws) {
  const f = ws.finding ?? {};
  return { sector: f.sector ?? (ws.buyer ? R().classifySector({ buyer: ws.buyer, source: f.channel }) : null), buyer: ws.buyer ?? f.buyer, publishedDate: f.publishedDate, closeDate: f.closeDate, estimatedValue: f.estimatedValue ? money(f.estimatedValue) : null, url: ws.url ?? f.url, channel: f.channel, capabilities: f.capabilities ?? R().matchCapabilities(ws.title, ws.text).slice(0, 4), rfp: f.rfp ?? null };
}

function runAnalyze(ws, { silent } = {}) {
  if (!ws.text || ws.text.trim().length < 40) { if (!silent) toast("There is no solicitation text yet. Upload the RFP document for this opportunity.", true); return; }
  ws.analysis = R().analyzeRfp({ text: ws.text, title: ws.title, source: ws.url ?? "", proposalText: ws.proposalText, packs: state.meta.packs, profile: state.profile, buyer: ws.buyer ?? ws.finding?.buyer, now: new Date(), closeDate: ws.finding?.closeDate, known: ws.finding?.rfp ?? null });
  ws.analysis.profileSig = profileSig();
  ws.team = ws.team ?? R().recommendTeam(R().matchCapabilities(ws.title, ws.text), state.meta.matrix);
  ws.answers = null; ws.proposal = null; ws.proofread = null; ws.redTeam = null;
  persist(ws, ["analysis"]);
}

function runDraft(ws) {
  if (!ws.analysis) runAnalyze(ws);
  if (!ws.analysis) return;
  ws.answers = R().draftAnswers(ws.analysis.requirements, state.meta.knowledge, { matrix: state.meta.matrix, buyer: ws.buyer ?? ws.finding?.buyer ?? "" });
  ws.proposal = proposalFor(ws);
  textChanged(ws);
  ws.tab = "responses";
  persist(ws, ["answers", "proposal"]);
}

/** The proposal draft, in the company's name when there is a profile. */
function proposalFor(ws) {
  return R().buildProposal(ws.analysis, ws.answers, { text: ws.text, buyer: ws.buyer ?? "", companyName: state.profile?.name ?? "", profile: state.profile?.summary ? { summary: `${state.profile.name}, from its website: ${state.profile.summary}` } : {} });
}

/** Text changed after proofreading or the submission check: both must be done again. */
function textChanged(ws) {
  if (ws.proofread) ws.proofread = { ...ws.proofread, stale: true, signedOff: null };
  ws.redTeam = null;
}

/** Proofread every answer and the proposal: flags only; a person fixes and signs off. */
function runProofread(ws) {
  if (!ws.answers) runDraft(ws);
  if (!ws.answers) return;
  ws.proofread = { ...R().proofread(ws.answers, ws.proposal ?? "", { companyName: state.profile?.name ?? "" }), signedOff: null };
  ws.redTeam = null;
  ws.tab = "proofread";
  persist(ws, ["proofread"]);
}

function signOffProofread(ws) {
  const p = ws.proofread;
  if (!p || p.stale) return toast("Run the proofread again first: the text changed.", true);
  if (p.counts.high) return toast(`Fix the ${p.counts.high} high issue(s) first, then re-check.`, true);
  p.signedOff = { by: $("#me")?.value || "a reviewer", at: new Date().toISOString() };
  ws.redTeam = null;
  persist(ws, ["proofread"]);
  renderWorkspace(ws);
  toast("Proofreading signed off. Next: RFP submission status.");
}

/** RFP submission status: the submission check, which needs a signed-off proofread. */
function runSubmission(ws) {
  if (!ws.answers) runDraft(ws);
  if (!ws.answers) return;
  const rt = R().redTeam(ws.analysis, ws.answers, ws.proposal ?? "");
  const p = ws.proofread;
  const gate = !p ? "Not proofread yet: run Proofread, fix what it flags and sign it off" : p.stale ? "The text changed after proofreading: proofread it again" : !p.signedOff ? `Proofreading is not signed off (${p.counts.high} high, ${p.counts.medium} medium issue(s))` : null;
  if (gate) rt.blocking.unshift(gate);
  rt.readiness = rt.blocking.length ? "Needs review" : "Ready";
  ws.redTeam = rt;
  ws.tab = "submission";
  persist(ws, ["redTeam"]);
}

let persistTimer;
function persist(ws, what) {
  if (STATIC || !ws.finding || ws.finding.raw || ws.finding.channel === undefined) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      await fetch(`/api/findings/${ws.finding.id}/workspace?tenant=${encodeURIComponent(ws.finding.tenant ?? GENERAL)}`, {
        method: "PUT", headers: { "X-RFP-Dashboard": "1", "X-RFP-User": $("#me").value || "", "content-type": "application/json" },
        body: JSON.stringify({ analysis: ws.analysis, answers: ws.answers, proposal: ws.proposal, proofread: ws.proofread, redTeam: ws.redTeam, teamOverride: ws.team, documentName: ws.documentName }),
      });
    } catch (e) { toast(`Not saved: ${e.message}`, true); }
  }, 400);
}

async function patchFinding(ws, patch, msg) {
  if (!ws.finding) return;
  const closedNow = patch.status && !OPEN_STATUSES.has(patch.status) ? " It now shows under the Closed filter." : "";
  if (STATIC) {
    // No server here: keep the decision in this browser, visibly, and say how to share it.
    Object.assign(ws.finding, patch, { localEdit: new Date().toISOString() });
    localEdits.save(ws.finding.id, patch);
    toast(`${msg}. Saved in this browser only.${closedNow} To share it with the team, set it in the Excel and upload it to assignments/.`);
  } else {
    if (ws.finding.raw && !(await addToPipeline(ws))) return;
    try {
      const r = await fetch(`/api/findings/${ws.finding.id}?tenant=${encodeURIComponent(ws.finding.tenant ?? GENERAL)}`, { method: "PATCH", headers: { "X-RFP-Dashboard": "1", "X-RFP-User": $("#me").value || "", "content-type": "application/json" }, body: JSON.stringify(patch) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      Object.assign(ws.finding, j);
      toast(`${msg}.${closedNow}`);
    } catch (e) { toast(e.message, true); }
  }
  renderWorkspace(ws);
  renderSweepResults();
}

/** Pursue / No-bid, showing the decision already made. */
function decisionRow(ws) {
  const f = ws.finding, st = f.status ?? "New";
  const btn = (label, status, cls) => h("button", { class: `keep decision ${cls} ${st === status ? "on" : ""}`, "aria-pressed": String(st === status),
    onclick: () => (st === status ? patchFinding(ws, { status: "Qualifying" }, `Decision cleared: ${f.title.slice(0, 40)} is back to Qualifying`) : patchFinding(ws, { status }, `Marked ${status}`)) }, st === status ? `✓ ${label}` : label);
  return h("div", { class: "decision-row" },
    btn("Pursue", "Pursuing", "go"), btn("No-bid", "No-bid", "nogo"),
    h("span", { class: "hint" }, `Status: ${st}${f.localEdit ? " (saved in this browser)" : ""}${["Pursuing", "No-bid"].includes(st) ? " · click again to undo" : ""}`));
}

/** A posting the sweep saw but no industry pack kept: add it to the pipeline so it can be worked. */
async function addToPipeline(ws) {
  const f = ws.finding;
  try {
    const r = await fetch(`/api/findings?tenant=${GENERAL}`, { method: "POST", headers: { "X-RFP-Dashboard": "1", "X-RFP-User": $("#me").value || "", "content-type": "application/json" },
      body: JSON.stringify({ title: f.title, text: ws.text || f.summary || f.title, buyer: f.buyer, url: f.url, sourceId: f.sourceId, closeDate: f.closeDate, publishedDate: f.publishedDate, noticeType: f.noticeType, country: f.country, channel: f.channel,
        score: f._fit?.score ?? 0, band: (f._fit?.score ?? 0) >= 60 ? "pursue" : "review", reason: f._fit ? `added from the sweep: fit to ${state.profile?.name ?? "the company"} ${f._fit.score}/100` : "added from the sweep by a person" }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    state.allLedger = await fetchLedgerFor(GENERAL);
    ws.finding = state.allLedger.findings.find((x) => x.id === j.id) ?? j;
    state.postings = (state.postings ?? []).filter((x) => x.id !== f.id);
    state.sweepIds?.add(ws.finding.id);
    toast("Added to the pipeline");
    persist(ws, ["analysis"]);
    renderSweepResults();
    return true;
  } catch (e) { toast(`Could not add it: ${e.message}`, true); return false; }
}

/** Re-score fit when the company profile changed since the analysis was made. Drafts are kept. */
const profileSig = () => (state.profile ? strHash(JSON.stringify([state.profile.name, (state.profile.capabilities ?? []).filter((c) => c.on !== false).map((c) => c.id), state.profile.keywords, (state.profile.platforms ?? []).filter((p) => p.on !== false).map((p) => p.name), state.profile.products])) : "");
function refreshFit(ws) {
  const a = ws.analysis;
  if (!a || a.profileSig === profileSig()) return;
  a.scores = R().scoreRfp({ text: ws.text, title: a.title, buyer: ws.buyer ?? ws.finding?.buyer, requirements: a.requirements, compliance: a.compliance, risks: a.risks, keyData: a.keyData, packs: state.meta.packs, profile: state.profile, now: new Date() });
  a.summary = R().summarize({ title: a.title, source: a.source, scores: a.scores, keyData: a.keyData, requirements: a.requirements, compliance: a.compliance, risks: a.risks });
  a.profileSig = profileSig();
}

function renderWorkspace(ws) {
  const box = $(ws.target);
  if (!box) return;
  renderFlow(state.sweepIds && state.allLedger ? state.allLedger.findings.filter((f) => state.sweepIds.has(f.id)) : null);
  refreshFit(ws);
  const a = ws.analysis, sc = a?.scores, f = ws.finding;
  const done = { qualify: f && f.status !== "New", assign: !!(f?.assignee), analyze: !!a, draft: !!ws.answers, proofread: !!ws.proofread?.signedOff, submission: f?.status === "Submitted" || ws.redTeam?.readiness === "Ready" };
  const act = {
    qualify: () => { ws.tab = "overview"; if (f && f.status === "New") patchFinding(ws, { status: "Qualifying" }, "Status: Qualifying"); else renderWorkspace(ws); },
    assign: () => { ws.tab = "team"; renderWorkspace(ws); },
    analyze: () => { runAnalyze(ws); ws.tab = "overview"; renderWorkspace(ws); },
    draft: () => { runDraft(ws); renderWorkspace(ws); },
    proofread: () => { runProofread(ws); renderWorkspace(ws); if (ws.proofread) toast(`Proofread: ${ws.proofread.verdict} (${ws.proofread.counts.high} high, ${ws.proofread.counts.medium} medium, ${ws.proofread.counts.low} low)`); },
    submission: () => { runSubmission(ws); renderWorkspace(ws); if (ws.redTeam) toast(`RFP submission status: ${f?.status === "Submitted" ? "Submitted" : ws.redTeam.readiness === "Ready" ? "Ready to submit" : `not ready, ${ws.redTeam.blocking.length} blocking issue(s)`}`); },
  };
  box.replaceChildren(h("section", { class: "card workspace", tabindex: "-1", role: "dialog", "aria-label": ws.title || "Opportunity workspace" },
    h("div", { class: "ws-head" },
      h("div", {},
        h("h2", {}, ws.title || "Untitled RFP"),
        h("div", { class: "buyer" }, ws.buyer || "buyer not stated", f?.status ? [" · ", h("span", { class: `tag status-tag st-${slug(f.status)}` }, f.status)] : "", f?.closeDate ? ` · closes ${f.closeDate}` : a?.keyData?.dates?.closing ? ` · closes ${a.keyData.dates.closing}` : "", ws.url ? [" · ", h("a", { href: ws.url, target: "_blank", rel: "noopener noreferrer" }, "source")] : "")),
      h("div", { class: "ws-actions" },
        h("button", { class: "keep", onclick: () => exportScoring(ws), disabled: !a }, "Export scoring file (.xlsx)"),
        h("button", { class: "keep", onclick: () => downloadText(`${slug(ws.title)}-proposal-draft.md`, ws.proposal ?? ""), disabled: !ws.proposal }, "Download proposal (.md)"),
        h("button", { class: "keep", onclick: () => { if (box.classList.contains("ws-overlay")) hideOverlay(ws.target); else box.replaceChildren(); if (ws === state.ws) { state.ws = null; renderSweepResults(); } } }, "Close ✕"))),
    h("ol", { class: "stepper" }, ...STEPS.map(([k, label], i) => h("li", { class: done[k] ? "done" : "" }, h("button", { class: "keep", onclick: act[k] }, h("span", { class: "n" }, done[k] ? "✓" : i + 1), label)))),
    ws.finding && !ws.documentName && (!ws.text || ws.text.split(/\s+/).length < 400) ? uploadPrompt(ws) : null,
    f?.raw ? h("div", { class: "notice raw-note" }, "The sweep saw this posting, but no industry pack kept it, so it is not in the pipeline yet.",
      STATIC ? " Use the local dashboard to add it." : [" ", h("button", { class: "primary small", onclick: async () => { if (await addToPipeline(ws)) renderWorkspace(ws); } }, "Add to pipeline")]) : null,
    sc ? h("div", { class: "kpis ws-kpis" }, ...[["overall", "Overall", sc.overall, sc.band], ["fit", sc.company ? `Fit to ${state.profile?.name ?? "your offering"}` : "Fit", sc.fit, sc.company ? sc.company.band : "add your website"], ["risk", "Risk (higher is safer)", sc.risk], ["timeline", "Timeline", sc.timeline], ...(sc.coverage != null ? [["coverage", "Coverage", sc.coverage]] : []), ["requirements", "Requirements", a.requirements.length, `${sc.mandatory} mandatory`]].map(([k, l, v, sub]) =>
      h("button", { class: `kpi kpi-btn keep ${ws.explain === k ? "on" : ""}`, "aria-pressed": String(ws.explain === k), title: "Show what is behind this number",
        onclick: () => {
          if (k === "risk") { ws.tab = "risks"; ws.explain = null; }
          else if (k === "requirements" || k === "coverage") { ws.tab = "requirements"; ws.explain = null; }
          else ws.explain = ws.explain === k ? null : k;
          renderWorkspace(ws);
          if (!ws.explain) box.querySelector(".ws-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
        } },
        h("div", { class: `v ${k === "fit" && sc.company ? `fit-${sub}` : ""}` }, v), h("div", { class: "l" }, l, sub ? ` · ${sub}` : ""), h("div", { class: "more" }, k === "risk" ? "See risks →" : k === "requirements" || k === "coverage" ? "See requirements →" : ws.explain === k ? "Hide ▴" : "Why? ▾")))) : null,
    sc && ws.explain ? explainScore(ws) : null,
    h("nav", { class: "tabs ws-tabs" }, ...WS_TABS.map(([k, label]) => h("button", { class: `keep ${ws.tab === k ? "active" : ""}`, onclick: () => { ws.tab = k; renderWorkspace(ws); } }, label))),
    h("div", { class: "ws-body" }, wsTab(ws))));
}

/** Close the workspace and open the company profile for editing. */
function editProfileFrom(ws) {
  if ($(ws.target)?.classList.contains("ws-overlay")) hideOverlay(ws.target);
  if (ws === state.ws) state.ws = null;
  if (state.profile) state.profileEditing = true;
  if (state.tab !== "sweep") switchTab("sweep");
  renderCompany(); renderSweepResults();
  $("#companyCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
  ($("#pUrl") ?? $("#companyCard .kw-input"))?.focus();
}

/** What is behind a score tile: the reason, the inputs, and how to move it. */
function explainScore(ws) {
  const a = ws.analysis, sc = a.scores;
  const reason = (p) => sc.reasons.find((r) => r.startsWith(p)) ?? "";
  const close = a.keyData?.dates?.closing;
  const days = close ? Math.round((new Date(`${close}T00:00:00Z`) - new Date()) / 86400000) : null;
  let title, body;
  if (ws.explain === "overall") {
    title = `Overall ${sc.overall}/100: ${sc.band}`;
    const parts = Object.entries(sc.weights).map(([k, w]) => ({ k, w, v: sc[k], c: Math.round((sc[k] * w) / 100) }));
    body = [
      h("table", { class: "facts explain-table" }, h("thead", {}, h("tr", {}, h("th", {}, "Part"), h("th", {}, "Score"), h("th", {}, "Weight"), h("th", {}, "Adds"))),
        h("tbody", {}, ...parts.map((p) => h("tr", {}, h("td", {}, p.k[0].toUpperCase() + p.k.slice(1)), h("td", {}, p.v), h("td", {}, `${p.w}%`), h("td", {}, `+${p.c}`))),
          h("tr", { class: "total" }, h("td", {}, "Overall"), h("td", {}, ""), h("td", {}, "100%"), h("td", {}, sc.overall)))),
      h("p", { class: "hint" }, `70 or more is strong, 50 to 69 is worth a look, below 50 is weak. ${sc.coverage == null ? "Load your draft proposal to add a Coverage score." : ""} The score informs the go/no-go; a person decides.`),
    ];
  } else if (ws.explain === "fit" && sc.company) {
    const cf = sc.company, m = cf.matched, capLabel = (id) => state.meta.capabilities.find((c) => c.id === id)?.label ?? id;
    title = `Fit to ${state.profile?.name ?? "your offering"}: ${sc.fit}/100, ${cf.band}`;
    body = [
      h("ul", { class: "plain" }, ...cf.reasons.map((r) => h("li", {}, r))),
      h("table", { class: "facts explain-table" }, h("thead", {}, h("tr", {}, h("th", {}, "From your website"), h("th", {}, "Weight"), h("th", {}, "Found in this RFP"))),
        h("tbody", {},
          h("tr", {}, h("td", {}, "What you sell"), h("td", {}, "55"), h("td", {}, m.capabilities.length ? m.capabilities.map(capLabel).join(", ") : "none")),
          h("tr", {}, h("td", {}, "Your terms and product names"), h("td", {}, "30"), h("td", {}, m.terms.length ? m.terms.slice(0, 8).join(", ") : "none")),
          h("tr", {}, h("td", {}, "Platforms you work with"), h("td", {}, "15"), h("td", {}, m.platforms.length ? m.platforms.join(", ") : "none")))),
      cf.notOffered?.length ? h("p", {}, "It asks for ", h("strong", {}, cf.notOffered.join(", ")), ", which your profile does not list. If you do offer it, add it to your profile.") : null,
      h("p", { class: "hint" }, `60 or more is a strong fit, 40 to 59 possible, below 40 weak. Keyword matching of the RFP against the offering read from ${state.profile?.website ? "your website" : "your text"}, not a judgement of the buyer. ${(a.words ?? 0) < 400 ? "Only the notice summary was read; load the full RFP document for a firmer fit. " : ""}`,
        h("button", { class: "keep link", onclick: () => editProfileFrom(ws) }, "Edit your profile")),
    ];
  } else if (ws.explain === "fit") {
    const caps = wsMeta(ws).capabilities ?? [];
    title = `Fit ${sc.fit}/100 (general)`;
    body = [
      h("p", { class: "notice" }, "Fit is not yet scored against what you sell. Add your company website in Your company (top of the RFP Sweep tab) and every RFP is scored on your product offering. ", h("button", { class: "primary small", onclick: () => editProfileFrom(ws) }, "Add my website")),
      h("p", {}, reason("Fit").replace(/\. General capability terms.*$/, ".")),
      caps.length ? h("p", {}, "Capabilities asked for: ", ...caps.map((c) => h("span", { class: "tag" }, `${c.label}${c.matched?.length ? `: ${c.matched.slice(0, 3).join(", ")}` : ""}`))) : null,
      h("p", { class: "hint" }, "Until then, fit is general capability-term matching. " + ((a.words ?? 0) < 400 ? "Only the notice summary was read; load the full RFP document for a firmer fit." : "Based on the full text you loaded.")),
    ];
  } else if (ws.explain === "timeline") {
    title = `Timeline ${sc.timeline}/100`;
    const d = { ...(a.keyData?.dates ?? {}) };
    body = [
      h("p", {}, days == null ? "No closing date was found." : days < 0 ? `Closed ${-days} day(s) ago (${close}).` : `${days} day(s) until closing on ${close}.`),
      Object.keys(d).length ? h("ul", { class: "plain" }, ...Object.entries(d).sort((x, y) => x[1].localeCompare(y[1])).map(([k, v]) => h("li", {}, `${DATE_NAMES[k] ?? k}: `, dueCell(v)))) : null,
      h("p", { class: "hint" }, "Scale: 21+ days is 100, 14–20 is 75, 7–13 is 50, under 7 is 20, closed is 0, no date found is 50."),
    ];
  }
  return h("div", { class: "card explain" }, h("div", { class: "explain-head" }, h("h3", {}, title), h("button", { class: "keep link", onclick: () => { ws.explain = null; renderWorkspace(ws); } }, "Close")), ...body);
}

/** Why a tab is empty when no requirements were found, and how to fix it right here. */
function noRequirements(ws, where) {
  const words = ws.text ? ws.text.split(/\s+/).filter(Boolean).length : 0;
  const onlyNotice = !ws.documentName && words < 400;
  return h("div", { class: "card empty-reqs" },
    h("h3", {}, onlyNotice ? "Only the notice summary has been read" : "No requirements or questions found"),
    h("p", {}, onlyNotice
      ? `The sweep has the listing's short summary (${words} words), not the RFP document. Summaries rarely contain "shall / must" statements or numbered questions, so there is nothing to map yet${where === "responses" ? " or to draft answers for" : ""}.`
      : `No "shall / must" statements or response questions (e.g. "4.0.1 Describe…") were found in ${ws.documentName ?? "the text"}. If it is a scanned PDF, it needs OCR first.`),
    h("ol", { class: "steps" },
      ws.url ? h("li", {}, "Download the solicitation from the ", h("a", { href: ws.url, target: "_blank", rel: "noopener noreferrer" }, "source"), ".") : h("li", {}, "Get the solicitation document from the buyer or portal."),
      h("li", {}, "Load it here. It is read in your browser, never uploaded: ", (() => {
        const input = h("input", { type: "file", accept: ".pdf,.docx,.txt,.md,.html,.htm", class: "keep" });
        input.addEventListener("change", async () => {
          const file = input.files[0];
          if (!file) return;
          try {
            toast(`Reading ${file.name}…`);
            ws.text = await readDocument(file);
            ws.documentName = file.name;
            runAnalyze(ws);
            renderWorkspace(ws);
            toast(`${file.name}: ${ws.analysis.requirements.length} requirement(s) and question(s) found`);
          } catch (e) { toast(`Could not read ${file.name}: ${e.message}`, true); }
        });
        return input;
      })()),
      h("li", {}, "Requirements, compliance, drafted answers and the proposal then fill in automatically.")));
}

function uploadPrompt(ws) {
  const input = h("input", { type: "file", accept: ".pdf,.docx,.txt,.md,.html,.htm", class: "keep" });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      toast(`Reading ${file.name}…`);
      ws.text = await readDocument(file);
      ws.documentName = file.name;
      runAnalyze(ws);
      ws.tab = "overview";
      renderWorkspace(ws);
      toast(`Analyzed ${file.name}: ${ws.analysis.requirements.length} requirement(s) found`);
    } catch (e) { toast(`Could not read ${file.name}: ${e.message}`, true); }
  });
  const words = ws.text ? ws.text.split(/\s+/).length : 0;
  const docs = (ws.finding?.rfp?.sources ?? []).filter((x) => x.kind === "document" && !x.error && x.url);
  if (docs.length) return h("div", { class: "notice" }, `The sweep read ${docs.length === 1 ? "the RFP document" : `${docs.length} RFP documents`} for the key facts (${docs.map((d) => d.name).join(", ")}). For every requirement and question, download `, ...docs.map((d, i) => [i ? ", " : "", h("a", { href: d.url, target: "_blank", rel: "noopener noreferrer" }, d.name)]), " and load it here (read in your browser, not uploaded): ", input);
  return h("div", { class: "notice" }, words ? `Only the notice summary is available (${words} words). ` : "No solicitation text yet. ",
    "For a full analysis, download the RFP from the source and load it here (read in your browser, not uploaded): ", input);
}

/** What was read with the RFP: the notice and each public document, with pages, words or why not. */
function readWithRfp(ws) {
  const r = ws.finding?.rfp;
  if (!r) return null;
  return h("div", { class: "read-with" },
    h("h3", { class: "mt" }, "Read with the RFP"),
    h("ul", { class: "plain" }, ...(r.sources ?? []).map((x) => h("li", {},
      x.kind === "notice" ? ["Notice", x.url ? [" · ", h("a", { href: x.url, target: "_blank", rel: "noopener noreferrer" }, "source")] : "", x.words ? ` · ${x.words.toLocaleString()} words` : ""]
        : [x.url ? h("a", { href: x.url, target: "_blank", rel: "noopener noreferrer" }, x.name) : x.name, x.error ? h("span", { class: "hint" }, ` · not read: ${x.error}`) : h("span", { class: "hint" }, ` · ${x.pages ? `${x.pages} pages, ` : ""}${(x.words ?? 0).toLocaleString()} words`)])),
      ...(r.notes ?? []).map((n) => h("li", { class: "hint" }, n))),
    h("p", { class: "hint" }, `Read by the sweep ${String(r.readAt ?? "").slice(0, 10)}. Public documents only; the sweeper never signs in.`));
}

function wsTab(ws) {
  const a = ws.analysis, f = ws.finding;
  if (!a) return h("p", { class: "empty" }, "Press Analyze RFP. If there is no text yet, load the RFP document above.");
  const q = R().qualify(a, wsMeta(ws));
  const list = (items, cls = "") => h("ul", { class: `plain ${cls}` }, ...items.map((x) => h("li", {}, x)));
  const reqById = Object.fromEntries(a.requirements.map((r) => [r.id, r]));
  const comp = Object.fromEntries((a.compliance ?? []).map((c) => [c.reqId, c]));
  switch (ws.tab) {
    case "overview": return h("div", { class: "detail-grid" },
      h("div", {},
        h("h3", {}, "Why this opportunity matters"), list(q.matters),
        h("h3", { class: "mt" }, "Why we may not qualify"), list(q.mayNotQualify),
        h("h3", { class: "mt" }, "Information still required"), list(q.infoRequired.length ? q.infoRequired : ["Nothing obvious missing."]),
        h("h3", { class: "mt" }, "Recommended next action"), h("p", { class: "next" }, q.nextAction),
        ws.finding && !ws.finding.raw ? decisionRow(ws) : ws.finding?.raw ? h("p", { class: "hint" }, STATIC ? "Not in the pipeline yet, so there is no decision to record here." : "Pursue or No-bid adds it to the pipeline first.") : null,
        ws.finding?.raw && !STATIC ? decisionRow(ws) : null),
      h("div", {},
        h("h3", {}, "Verified, from the source"),
        h("table", { class: "facts" }, h("tbody", {}, ...q.verified.map((v) => h("tr", {}, h("th", {}, v.label), h("td", {}, v.value, h("span", { class: "hint" }, ` · ${v.from}`)))))),
        readWithRfp(ws),
        h("h3", { class: "mt" }, "Inferred by this tool"),
        h("table", { class: "facts inferred" }, h("tbody", {}, ...q.inferred.map((v) => h("tr", {}, h("th", {}, v.label), h("td", {}, v.value, h("span", { class: "hint" }, ` · ${v.how}`)))))),
        h("h3", { class: "mt" }, "Evaluator summary"),
        renderMarkdown(a.summary),
        h("button", { class: "keep", onclick: () => navigator.clipboard?.writeText(a.summary).then(() => toast("Summary copied")) }, "Copy summary")));
    case "requirements":
      if (!a.requirements.length) return noRequirements(ws, "requirements");
      return h("div", {},
        h("div", { class: "tablewrap" }, h("table", { class: "grid" },
          h("thead", {}, h("tr", {}, ...["ID", "Section", "Requirement", "Type", "Category", "Owner", "Compliance"].map((x) => h("th", {}, x)))),
          h("tbody", {}, ...a.requirements.map((r) => h("tr", {},
            h("td", {}, r.id), h("td", {}, r.section), h("td", {}, r.text),
            h("td", {}, r.level === "mandatory" ? h("strong", {}, "Mandatory") : r.level === "question" ? "Question" : "Desirable"),
            h("td", {}, h("span", { class: "tag" }, r.category)), h("td", {}, R().ownerForCategory(r.category, state.meta.matrix)),
            h("td", {}, comp[r.id] ? h("span", { class: `status ${comp[r.id].status}` }, comp[r.id].status) : h("span", { class: "hint" }, "—"))))))),
        a.compliance ? null : h("p", { class: "hint mt" }, "To screen compliance, load your draft proposal in Analyze a document."));
    case "responses":
      if (!a.requirements.length) return noRequirements(ws, "responses");
      if (!ws.answers) return h("div", {}, h("p", { class: "empty" }, "Press Draft response. Answers come only from the approved knowledge base (library/knowledge.json); anything without an approved source is marked SME validation required."), h("button", { class: "primary keep", onclick: () => { runDraft(ws); renderWorkspace(ws); } }, "Draft response"));
      return h("div", {}, h("div", { class: "row sme-row" },
          h("button", { class: "keep", onclick: () => exportSmeReview(ws) }, "Export SME review (.xlsx)"),
          h("label", { class: "button keep" }, "Import SME review", (() => { const i = h("input", { type: "file", accept: ".xlsx", hidden: true }); i.addEventListener("change", () => importSmeReview(ws, i)); return i; })()),
          h("span", { class: "hint" }, "Send the review file to SMEs; load it back to apply their edits, notes and status.")),
        h("div", { class: "tablewrap" }, h("table", { class: "grid responses" },
        h("thead", {}, h("tr", {}, ...["Requirement", "Draft", "Sources", "Confidence", "Owner", "Status"].map((x) => h("th", {}, x)))),
        h("tbody", {}, ...ws.answers.map((x) => {
          const ta = h("textarea", { class: "keep", value: x.draft, "aria-label": `Draft for ${x.reqId}` });
          ta.addEventListener("change", () => { x.draft = ta.value; if (x.status === "Not started") x.status = "Drafted"; ws.proposal = proposalFor(ws); textChanged(ws); persist(ws, ["answers"]); });
          const st = h("select", { class: "keep", "aria-label": "Response status", onchange: (e) => { x.status = e.target.value; ws.proposal = proposalFor(ws); textChanged(ws); persist(ws, ["answers"]); } }, ...state.meta.responseStatuses.map((v) => h("option", { value: v, selected: v === x.status }, v)));
          return h("tr", {},
            h("td", {}, h("strong", {}, x.reqId), x.level === "mandatory" ? h("span", { class: "tag" }, "mandatory") : null, h("div", { class: "buyer" }, reqById[x.reqId]?.text ?? "")),
            h("td", {}, ta),
            h("td", {}, x.sources.length ? x.sources.map((s) => h("div", { class: s.stale ? "stale" : "" }, `${s.id} (${s.similarity})${s.stale ? " STALE" : ""}`)) : h("span", { class: "hint" }, "none")),
            h("td", {}, h("span", { class: `status conf-${x.confidence}` }, x.confidence), x.validationRequired ? h("div", { class: "hint" }, "SME validation") : null),
            h("td", {}, x.owner, x.smeNotes ? h("div", { class: "hint" }, `SME: ${x.smeNotes}`) : null), h("td", {}, st));
        })))));
    case "risks": return a.risks.length ? h("ul", { class: "risk-list" }, ...a.risks.map((r) => h("li", { class: `sev-${r.severity}` }, h("strong", {}, `${r.severity.toUpperCase()}: ${r.label}`), h("div", { class: "hint" }, r.evidence)))) : h("p", { class: "empty" }, "No risk patterns found. Legal still reviews the terms.");
    case "team": {
      // The four roles on every bid. Saved overrides from before the four-role model fall back to the defaults.
      const rec = R().recommendTeam(R().matchCapabilities(ws.title, ws.text), state.meta.matrix);
      const t = ws.team?.rfpManager ? { ...rec, ...ws.team } : rec;
      const caps = (wsMeta(ws).capabilities ?? []).slice(0, 3).map((c) => c.label).join(", ");
      const areas = (t.smeAreas ?? rec.smeAreas ?? []).join(", ");
      const roles = [
        ["rfpManager", "RFP Manager", "Owns the response: plan, compliance matrix, proofreading and submission."],
        ["presales", "Pre-sales Consultant", `Solution and technical answers${caps ? `: ${caps}` : ""}.`],
        ["accountExecutive", "Account Executive", "Customer relationship, go/no-go, references and pricing sign-off."],
        ["sme", "SME Contributor", `Subject answers${areas ? ` for ${areas}` : ""}.`],
      ];
      return h("div", {},
        h("p", { class: "hint" }, `Four roles on every bid, recommended from the capability matrix (config/capability-matrix.json). ${t.why ?? ""}. Roles only, never names; write a more specific role if you need one.`),
        h("table", { class: "facts team-table" }, h("thead", {}, h("tr", {}, h("th", {}, "Role"), h("th", {}, "On this bid"), h("th", {}, "Assigned role"))),
          h("tbody", {}, ...roles.map(([k, label, what]) => {
            const inp = h("input", { class: "keep", list: "team", value: t[k] ?? label, "aria-label": label });
            inp.addEventListener("change", () => { ws.team = { ...t, [k]: inp.value.trim() || label }; persist(ws, ["teamOverride"]); toast(`${label}: ${ws.team[k]}`); });
            return h("tr", {}, h("th", {}, label), h("td", {}, what), h("td", {}, inp));
          }))),
        ws.finding ? h("div", { class: "row" }, h("button", { class: "primary keep", onclick: () => patchFinding(ws, { assignee: t.rfpManager ?? "RFP Manager" }, `Assigned to ${t.rfpManager ?? "RFP Manager"}`) }, `Assign opportunity to ${t.rfpManager ?? "RFP Manager"}`)) : null);
    }
    case "proposal": {
      if (!ws.proposal) return h("div", {}, h("p", { class: "empty" }, "Press Draft response to build the first draft."), h("button", { class: "primary keep", onclick: () => { runDraft(ws); ws.tab = "proposal"; renderWorkspace(ws); } }, "Draft response"));
      const ta = h("textarea", { class: "draft keep", value: ws.proposal, "aria-label": "Proposal draft" });
      ta.addEventListener("change", () => { ws.proposal = ta.value; textChanged(ws); persist(ws, ["proposal"]); renderWorkspace(ws); });
      return h("div", {}, h("h3", {}, "Proposal draft"), h("p", { class: "hint" }, "Edit here. Any change means proofreading and the submission status are checked again."), ta,
        h("div", { class: "row" }, h("button", { class: "primary keep", onclick: () => { runProofread(ws); renderWorkspace(ws); } }, "Next: Proofread")));
    }
    case "proofread": {
      if (!ws.answers) return h("div", {}, h("p", { class: "empty" }, "Draft the response first, then proofread it."), h("button", { class: "primary keep", onclick: () => { runDraft(ws); renderWorkspace(ws); } }, "Draft response"));
      const p = ws.proofread;
      if (!p) return h("div", {}, h("p", {}, "Checks every answer and the proposal for placeholders left in, misspellings, doubled words, mixed spellings, undefined acronyms, long sentences, spacing and generic phrasing. It flags; you fix the text and sign off."),
        h("button", { class: "primary keep", onclick: () => { runProofread(ws); renderWorkspace(ws); } }, "Run proofread"));
      const sev = (x) => h("span", { class: `sev sev-${x}` }, x);
      return h("div", { class: "proofread" },
        h("div", { class: "proof-head" },
          h("p", { class: `readiness ${p.counts.high ? "bad" : p.counts.medium ? "warn" : "ok"}` }, `Proofread: ${p.verdict}`),
          h("span", { class: "counts" }, h("span", { class: "pill sev-high" }, `${p.counts.high} high`), " ", h("span", { class: "pill sev-medium" }, `${p.counts.medium} medium`), " ", h("span", { class: "pill sev-low" }, `${p.counts.low} low`)),
          h("span", { class: "hint" }, `${p.stats.words.toLocaleString()} words · ${p.stats.sentences} sentences · ${p.stats.avgWords} words per sentence on average`)),
        p.stale ? h("p", { class: "notice" }, "The text changed after this proofread. Run it again before signing off.") : null,
        p.signedOff ? h("p", { class: "notice ok-note" }, `Signed off by ${p.signedOff.by} on ${String(p.signedOff.at).slice(0, 10)}.`) : null,
        p.issues.length ? h("div", { class: "tablewrap" }, h("table", { class: "grid proof-issues" },
          h("thead", {}, h("tr", {}, ...["Severity", "Where", "Issue", "Text", "What to do"].map((x) => h("th", {}, x)))),
          h("tbody", {}, ...p.issues.map((i) => h("tr", {}, h("td", {}, sev(i.severity)), h("td", {}, /^Answer /.test(i.where) ? h("button", { class: "keep link", title: "Open the Responses tab", onclick: () => { ws.tab = "responses"; renderWorkspace(ws); } }, i.where) : i.where), h("td", {}, i.kind), h("td", { class: "proof-text" }, i.text), h("td", {}, i.suggestion))))))
          : h("p", { class: "empty" }, "No issues found."),
        h("div", { class: "row" },
          h("button", { class: "keep", onclick: () => { runProofread(ws); renderWorkspace(ws); toast(`Proofread again: ${ws.proofread.verdict}`); } }, "Re-check"),
          h("button", { class: "primary keep", disabled: !!(p.counts.high || p.stale || p.signedOff), title: p.counts.high ? "Fix the high issues first" : p.stale ? "Run the proofread again first" : "", onclick: () => signOffProofread(ws) }, p.signedOff ? "✓ Signed off" : "Sign off proofreading"),
          p.signedOff ? h("button", { class: "primary keep", onclick: () => { runSubmission(ws); renderWorkspace(ws); } }, "Next: RFP submission status") : null),
        h("p", { class: "hint" }, p.note));
    }
    case "submission": {
      const rt = ws.redTeam, st = f?.status;
      const submitted = st === "Submitted";
      const headline = submitted ? "Submitted" : rt ? (rt.readiness === "Ready" ? "Ready to submit" : `Not ready: ${rt.blocking.length} blocking issue(s)`) : "Not checked yet";
      const proof = ws.proofread;
      const checks = [
        ["Proofread and signed off", !!proof?.signedOff && !proof.stale, proof?.signedOff ? `by ${proof.signedOff.by}, ${String(proof.signedOff.at).slice(0, 10)}` : proof ? (proof.stale ? "text changed since" : "not signed off") : "not run"],
        ["Mandatory answers Approved or Final", ws.answers ? !ws.answers.some((x) => (x.level === "mandatory" || x.level === "question") && !["Approved", "Final"].includes(x.status)) : false, ws.answers ? `${ws.answers.filter((x) => ["Approved", "Final"].includes(x.status)).length} of ${ws.answers.length} approved or final` : "no answers yet"],
        ["No SME markers or placeholders left", ws.proposal ? !/\[SME validation required\]|\[TODO/.test(ws.proposal) : false, ""],
      ];
      return h("div", { class: "submission" },
        h("h3", {}, "RFP submission status"),
        h("p", { class: `readiness ${submitted || rt?.readiness === "Ready" ? "ok" : "bad"}` }, headline),
        h("ul", { class: "plain checklist" }, ...checks.map(([label, ok, note]) => h("li", { class: ok ? "ok" : "no" }, h("span", { class: "tick", "aria-hidden": "true" }, ok ? "✓" : "✗"), ` ${label}`, note ? h("span", { class: "hint" }, ` · ${note}`) : null))),
        rt?.blocking.length ? [h("h4", {}, "Blocking"), list(rt.blocking, "blocking")] : null,
        rt?.warnings.length ? [h("h4", {}, "Warnings"), list(rt.warnings)] : null,
        h("div", { class: "row" },
          h("button", { class: rt ? "keep" : "primary keep", onclick: () => { runSubmission(ws); renderWorkspace(ws); toast(`RFP submission status: ${ws.redTeam.readiness === "Ready" ? "Ready to submit" : `not ready, ${ws.redTeam.blocking.length} blocking issue(s)`}`); } }, rt ? "Check again" : "Check submission status"),
          f && !submitted ? h("button", { class: "primary keep", onclick: () => {
            if (rt?.readiness !== "Ready" && !confirm(`The submission status is not Ready (${rt ? `${rt.blocking.length} blocking issue(s)` : "not checked"}). Mark it as submitted anyway?`)) return;
            patchFinding(ws, { status: "Submitted" }, "Marked Submitted");
          } }, "Mark as submitted") : null,
          f && submitted ? h("button", { class: "keep", onclick: () => patchFinding(ws, { status: "Drafting" }, "Submission undone: back to Drafting") }, "Undo submitted") : null),
        h("p", { class: "hint" }, "Nothing is sent from this tool. Submit through the buyer's portal or as the RFP instructs, then mark it here."));
    }
  }
}

/**
 * Small, safe Markdown renderer for generated summaries: headings, bullet lists,
 * **bold**, _italic_, links shown as text. Builds DOM nodes; never innerHTML.
 */
function inlineMd(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|_(.+?)_|(https?:\/\/\S+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h("strong", {}, m[1]));
    else if (m[2]) out.push(h("em", {}, m[2]));
    else out.push(h("a", { href: m[3], target: "_blank", rel: "noopener noreferrer", class: "url" }, m[3].length > 60 ? `${m[3].slice(0, 57)}…` : m[3]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function renderMarkdown(md) {
  const root = h("div", { class: "md" });
  let list = null;
  for (const raw of String(md ?? "").split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^(\s*)-\s+(.*)$/);
    if (bullet) {
      if (!list) { list = h("ul", {}); root.append(list); }
      list.append(h("li", { class: bullet[1].length ? "sub" : "" }, ...inlineMd(bullet[2])));
      continue;
    }
    if (!line.trim()) continue; // blank lines end nothing: lists stay together
    list = null;
    const hd = line.match(/^(#{1,3})\s+(.*)$/);
    if (hd) root.append(h(hd[1].length === 1 ? "h4" : "h5", {}, ...inlineMd(hd[2])));
    else if (/^> /.test(line)) root.append(h("blockquote", {}, ...inlineMd(line.slice(2))));
    else root.append(h("p", {}, ...inlineMd(line)));
  }
  return root;
}

const slug = (s) => String(s || "rfp").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "rfp";

function downloadBlob(name, blob) {
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const downloadText = (name, text) => downloadBlob(name, new Blob([text], { type: "text/markdown;charset=utf-8" }));

const loaded = {};
function loadScript(src) {
  if (!loaded[src]) loaded[src] = new Promise((res, rej) => { const el = h("script", { src }); el.onload = res; el.onerror = () => rej(new Error(`could not load ${src}`)); document.head.append(el); });
  return loaded[src];
}

async function exportSmeReview(ws) {
  if (!ws.answers) return toast("Draft the responses first.", true);
  try {
    await loadScript("vendor/exceljs.min.js");
    const wb = await R().buildSmeReviewWorkbook(window.ExcelJS, { title: ws.title, buyer: ws.buyer ?? "", answers: ws.answers, openItems: ws.answers.filter((a) => a.validationRequired).map((a) => `${a.reqId} - needs SME validation`) });
    downloadBlob(`${slug(ws.title)}-SME-review.xlsx`, new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    toast("SME review file downloaded");
  } catch (e) { toast(`Export failed: ${e.message}`, true); }
}

async function importSmeReview(ws, input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  try {
    await loadScript("vendor/exceljs.min.js");
    const parsed = await R().parseSmeReviewWorkbook(window.ExcelJS, await file.arrayBuffer());
    const n = R().applySmeReview(ws.answers, parsed.rows);
    ws.proposal = proposalFor(ws);
    textChanged(ws);
    persist(ws, ["answers", "proposal"]);
    renderWorkspace(ws);
    toast(`${n} of ${ws.answers.length} answer(s) updated from the SME review`);
  } catch (e) { toast(`Import failed: ${e.message}`, true); }
}

async function exportScoring(ws) {
  if (!ws.analysis) return;
  try {
    await loadScript("vendor/exceljs.min.js");
    const wb = await R().buildAnalysisWorkbook(window.ExcelJS, ws.analysis, { answers: ws.answers, proofread: ws.proofread, redTeam: ws.redTeam, team: ws.team, proposal: ws.proposal });
    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(`${slug(ws.title)}-rfp-scoring.xlsx`, new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    toast("Scoring file downloaded");
  } catch (e) { toast(`Export failed: ${e.message}`, true); }
}

// =================================================================== reading documents (in the browser)

async function readDocument(file) {
  const name = file.name.toLowerCase();
  if (file.size > 40 * 1024 * 1024) throw new Error("file is over 40 MB");
  if (name.endsWith(".pdf")) {
    const pdfjs = await import(new URL("vendor/pdf.min.mjs", location.href).href);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.mjs", location.href).href;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 400); i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      pages.push(tc.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n"));
    }
    const text = pages.join("\n\n");
    if (text.replace(/\s/g, "").length < 50) throw new Error("no text layer found (a scanned PDF needs OCR first)");
    return text;
  }
  if (name.endsWith(".docx")) {
    await loadScript("vendor/mammoth.browser.min.js");
    return (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }
  const raw = await file.text();
  if (/\.html?$/.test(name)) return new DOMParser().parseFromString(raw, "text/html").body.innerText;
  return raw;
}

// =================================================================== Analyze a document

async function fileInto(inputId, textId) {
  const file = $(inputId).files[0];
  if (!file) return;
  try { toast(`Reading ${file.name}…`); $(textId).value = await readDocument(file); toast(`${file.name}: ${$(textId).value.split(/\s+/).length} words read`); }
  catch (e) { toast(`Could not read ${file.name}: ${e.message}`, true); }
}
$("#aRfpFile").addEventListener("change", () => fileInto("#aRfpFile", "#aRfpText"));
$("#aPropFile").addEventListener("change", () => fileInto("#aPropFile", "#aPropText"));
$("#aRun").addEventListener("click", () => {
  const text = $("#aRfpText").value;
  if (text.trim().length < 40) return toast("Load or paste the RFP text first.", true);
  state.aws = { target: "#aWorkspace", finding: null, documentName: $("#aRfpFile").files[0]?.name ?? "pasted text", title: $("#aTitle").value.trim(), buyer: $("#aBuyer").value.trim() || null, url: null, text, proposalText: $("#aPropText").value, analysis: null, answers: null, proposal: null, redTeam: null, team: null, tab: "overview" };
  runAnalyze(state.aws);
  if (!state.aws.title) state.aws.title = state.aws.analysis.title;
  renderWorkspace(state.aws);
  if (!STATIC) {
    const btn = h("button", { class: "keep", onclick: async () => {
      try {
        const r = await fetch("/api/findings?tenant=all", { method: "POST", headers: { "X-RFP-Dashboard": "1", "X-RFP-User": $("#me").value || "", "content-type": "application/json" }, body: JSON.stringify({ title: state.aws.title, buyer: state.aws.buyer, text, industry: state.aws.analysis.scores.industry?.id, score: state.aws.analysis.scores.overall, band: state.aws.analysis.scores.overall >= 55 ? "pursue" : "review", closeDate: state.aws.analysis.keyData.dates?.closing }) });
        const f = await r.json();
        if (!r.ok) throw new Error(f.error);
        state.aws.finding = f; persist(state.aws, ["analysis"]);
        state.allLedger = await fetchLedgerFor(GENERAL);
        toast("Added to the pipeline");
      } catch (e) { toast(e.message, true); }
    } }, "Add to pipeline");
    $("#aWorkspace .ws-actions")?.prepend(btn);
  }
});

loadMeta().catch((e) => toast(`Could not load: ${e.message}`, true));
