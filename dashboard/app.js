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
  return path === "/api/ledger" ? res.json() : res;
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

async function mutate(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.status === 409 ? `${e.message}\nReloaded the latest version.` : e.message, true);
  }
  await loadLedger();
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
  if (state.tab === "coverage") renderCoverage();
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
  const built = new Date(state.meta.builtAt).toLocaleString();
  if (!state.meta.tenants.length) return;
  const upload = state.meta.repo ? `https://github.com/${state.meta.repo}/upload/main/assignments` : null;
  $(".toolbar").before(h("section", { class: "banner" },
    h("strong", {}, "Published view (read-only). "), `Built ${built}. `,
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
  return h("select", { "aria-label": "Status", onchange: (e) => mutate(() => api("PATCH", `/api/findings/${f.id}`, { status: e.target.value, rev: f.rev }), `Status → ${e.target.value}`) },
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
      h("td", {}, industryName(f.industry)),
      h("td", {}, f.closeDate ? h("span", { class: `due ${d < 0 ? "over" : d <= 14 ? "soon" : ""}` }, f.closeDate, h("br"), d < 0 ? "closed" : `${d} days`) : h("span", { class: "unassigned" }, "not published")),
      h("td", {}, statusSelect(f)),
      h("td", {}, assigneeInput(f.assignee, f.suggestedAssignee ? `suggest: ${f.suggestedAssignee}` : "unassigned", (v) => mutate(() => api("PATCH", `/api/findings/${f.id}`, { assignee: v, rev: f.rev }), v ? `Assigned to ${v}` : "Unassigned"))),
      h("td", { class: "num" }, `${acts.filter((a) => a.done).length}/${acts.length}`),
      h("td", {}, h("button", { class: "link", "aria-expanded": String(isOpen), onclick: () => { isOpen ? state.open.delete(f.id) : state.open.add(f.id); renderFindings(); } }, isOpen ? "Close" : "Open")),
    ));
    if (isOpen) tbody.append(detailRow(f));
  }
}

function detailRow(f) {
  const notes = h("textarea", { "aria-label": "Notes", placeholder: "Notes for the team", value: f.notes || "" });
  notes.addEventListener("change", () => mutate(() => api("PATCH", `/api/findings/${f.id}`, { notes: notes.value, rev: f.rev }), "Notes saved"));

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
        h("button", { onclick: () => mutate(() => api("PATCH", `/api/findings/${f.id}`, { draftResponse: draftBox.value, rev: f.rev }), "Draft saved") }, "Save draft"),
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
          h("button", { onclick: () => mutate(() => api("PATCH", `/api/findings/${f.id}`, { acknowledgeChange: true, rev: f.rev }), "Change acknowledged") }, "Acknowledge")) : null,
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
      h("td", {}, h("select", { "aria-label": c.label, onchange: (e) => mutate(() => api("PATCH", `/api/findings/${f.id}`, { goNoGo: { [c.id]: e.target.value }, rev: f.rev })) },
        ...["unknown", "yes", "partial", "no"].map((v) => h("option", { value: v, selected: (f.goNoGo?.[c.id] ?? "unknown") === v }, v)))))))),
    h("p", { class: `gng-result ${g.verdict}` }, g.answered ? `${g.pct}% — ${g.verdict}${g.verdict === "incomplete" ? ` (${g.answered}/${g.of} answered)` : ""} · threshold ${cfg.threshold ?? 65}%` : "Not scored yet. Answer each criterion; the decision stays a person's."));
}

function outcomeBlock(f) {
  const field = (label, key, value, attrs = {}) => {
    const el = h("input", { value: value ?? "", "aria-label": label, placeholder: label, ...attrs });
    el.addEventListener("change", () => mutate(() => api("PATCH", `/api/findings/${f.id}`, { [key]: el.value, rev: f.rev }), `${label} saved`));
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
    const owner = assigneeInput(t.owner, "owner", (v) => mutate(() => api("PATCH", `/api/findings/${f.id}`, { compliance: { [r.id]: { owner: v } }, rev: f.rev })));
    const st = h("select", { "aria-label": "Requirement status", onchange: (e) => mutate(() => api("PATCH", `/api/findings/${f.id}`, { compliance: { [r.id]: { status: e.target.value } }, rev: f.rev })) },
      ...statuses.map((s) => h("option", { value: s, selected: (t.status ?? "Open") === s }, s)));
    return h("div", { class: `req ${t.status === "Done" || t.status === "N/A" ? "done" : ""}` }, h("div", { class: "rtext" }, h("span", { class: "tag" }, r.kind), " ", r.text), h("div", { class: "rctl" }, owner, st));
  }));
}

function actionLi(f, a) {
  return h("li", { class: a.done ? "done" : "" },
    h("input", { type: "checkbox", checked: a.done, "aria-label": "Done", onchange: (e) => mutate(() => api("PATCH", `/api/findings/${f.id}/actions/${a.id}`, { done: e.target.checked, rev: a.rev })) }),
    h("span", { class: "t" }, a.title),
    assigneeInput(a.assignee, "unassigned", (v) => mutate(() => api("PATCH", `/api/findings/${f.id}/actions/${a.id}`, { assignee: v, rev: a.rev }), v ? `Action assigned to ${v}` : "Action unassigned")),
    dateInput(a.due, (v) => mutate(() => api("PATCH", `/api/findings/${f.id}/actions/${a.id}`, { due: v || null, rev: a.rev }))),
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
    h("td", {}, h("input", { type: "checkbox", checked: a.done, "aria-label": "Done", onchange: (e) => mutate(() => api("PATCH", `/api/findings/${f.id}/actions/${a.id}`, { done: e.target.checked, rev: a.rev })) })),
    h("td", {}, a.title),
    h("td", { class: "title" }, h("button", { class: "link", onclick: () => { state.open.add(f.id); switchTab("findings"); } }, f.title.slice(0, 80)), h("div", { class: "buyer" }, f.buyer || "")),
    h("td", {}, assigneeInput(a.assignee, "unassigned", (v) => mutate(() => api("PATCH", `/api/findings/${f.id}/actions/${a.id}`, { assignee: v, rev: a.rev }), v ? `Assigned to ${v}` : "Unassigned"))),
    h("td", {}, dueCell(a.due)),
  )));
}

function renderCoverage() {
  const gaps = state.ledger.gaps ?? [];
  $("#gaps tbody").replaceChildren(...(gaps.length ? gaps.map((g) => h("tr", {}, h("td", {}, g.industry), h("td", {}, g.channel), h("td", {}, g.status), h("td", {}, g.detail || ""))) : [h("tr", {}, h("td", { colspan: 4, class: "empty" }, "No gaps recorded."))]));
  const runs = state.ledger.runs ?? [];
  $("#runs tbody").replaceChildren(...runs.slice(0, 50).map((r) => h("tr", {},
    h("td", {}, new Date(r.runAt).toLocaleString()), h("td", {}, r.industry), h("td", {}, r.source),
    h("td", { class: "num" }, r.postingsSeen), h("td", { class: "num" }, r.pursue), h("td", { class: "num" }, r.review), h("td", { class: "num" }, r.added), h("td", { class: "num" }, r.gaps),
    h("td", {}, [r.halted ? `HALTED: ${r.haltReason}` : "", r.caveat || ""].filter(Boolean).join(" ")))));
}

function switchTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll(".main-tabs button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const s of document.querySelectorAll(".tab")) s.hidden = s.id !== `tab-${tab}`;
  const pipeline = ["findings", "actions", "coverage"].includes(tab);
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

async function fetchLedgerFor(tid) {
  if (STATIC) { const r = await fetch(`data/${tid}.json`, { cache: "no-cache" }); return r.ok ? r.json() : { findings: [], runs: [], gaps: [] }; }
  const r = await fetch(`/api/ledger?tenant=${encodeURIComponent(tid)}`);
  return r.json();
}

function setupSweepForm() {
  const m = state.meta;
  $("#sIndustry").replaceChildren(h("option", { value: "" }, "All industries"), ...m.industries.map((i) => h("option", { value: i.id }, `${i.name}${i.status === "proven" ? "" : ` [${i.status}]`}`)));
  $("#sGeo").replaceChildren(...m.geographies.map((g) => h("option", { value: g.id }, g.label)));
  $("#sCap").replaceChildren(h("option", { value: "" }, "All capabilities"), ...m.capabilities.map((c) => h("option", { value: c.id }, c.label)));
  $("#sDays").replaceChildren(...m.dateRanges.map((d) => h("option", { value: d.id, selected: d.id === "30" }, d.label)));
  const saved = (() => { try { return JSON.parse(localStorage.getItem("rfp.sweep") || "{}"); } catch { return {}; } })();
  for (const [k, id] of [["industry", "sIndustry"], ["geo", "sGeo"], ["cap", "sCap"], ["days", "sDays"]]) if (saved[k] != null) $(`#${id}`).value = saved[k];
  const built = state.meta.builtAt ? new Date(state.meta.builtAt).toLocaleString() : null;
  $("#sNote").replaceChildren(...(STATIC
    ? ["Searches the latest scheduled sweep", built ? ` (updated ${built})` : "", ". Sources: CanadaBuys open data, SAM.gov and the configured portals.",
       state.meta.repo ? [" To refresh from the sources now: ", h("a", { href: `https://github.com/${state.meta.repo}/actions/workflows/pages.yml`, target: "_blank", rel: "noopener noreferrer" }, "run the sweep workflow"), " (about two minutes)."] : ""]
    : ["Runs a live sweep of CanadaBuys open data, SAM.gov and the public portals, then scores every posting. Takes up to a minute."]));
  $("#sRun").onclick = runSearch;
  fetchLedgerFor(GENERAL).then((l) => { state.allLedger = l; renderSweepResults(); });
}

function sweepParams() {
  const p = { industry: $("#sIndustry").value, geography: $("#sGeo").value, capability: $("#sCap").value, days: $("#sDays").value };
  try { localStorage.setItem("rfp.sweep", JSON.stringify({ industry: p.industry, geo: p.geography, cap: p.capability, days: p.days })); } catch { /* ignore */ }
  return p;
}

function clientFilter(findings, p) {
  const geo = state.meta.geographies.find((g) => g.id === p.geography)?.countries ?? ["CA", "US"];
  const days = state.meta.dateRanges.find((d) => d.id === p.days)?.days;
  const since = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : null;
  const today = new Date().toISOString().slice(0, 10);
  return findings.filter((f) =>
    (!p.industry || p.industry === "any" || f.industry === p.industry) &&
    (!f.country || geo.includes(f.country)) &&
    (!p.capability || (f.capabilities ?? []).some((c) => c.id === p.capability)) &&
    (!since || !f.publishedDate || f.publishedDate >= since) &&
    (!f.closeDate || f.closeDate >= today) &&
    !["Archived", "No-bid", "Lost"].includes(f.status));
}

async function runSearch() {
  const p = sweepParams();
  const btn = $("#sRun");
  if (STATIC) {
    state.sweepIds = new Set(clientFilter(state.allLedger?.findings ?? [], p).map((f) => f.id));
    state.sweepLow = null;
    return renderSweepResults();
  }
  btn.disabled = true; btn.textContent = "Sweeping…";
  try {
    const days = state.meta.dateRanges.find((d) => d.id === p.days)?.days;
    const r = await fetch("/api/search?tenant=all", { method: "POST", headers: { "X-RFP-Dashboard": "1", "content-type": "application/json" }, body: JSON.stringify({ ...p, days }) }).then(async (x) => { const j = await x.json(); if (!x.ok) throw new Error(j.error); return j; });
    state.allLedger = await fetchLedgerFor(GENERAL);
    state.sweepIds = new Set(r.ids);
    state.sweepLow = r.low;
    if (r.gaps) toast(`${r.gaps} source(s) could not be read. See Coverage & runs.`);
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = "Run RFP Sweep";
  renderSweepResults();
}

function renderSweepResults() {
  const box = $("#sResults");
  if (!box || !state.allLedger) return;
  const p = { industry: $("#sIndustry").value, geography: $("#sGeo").value, capability: $("#sCap").value, days: $("#sDays").value };
  const list = (state.sweepIds ? state.allLedger.findings.filter((f) => state.sweepIds.has(f.id)) : clientFilter(state.allLedger.findings, p)).sort((a, b) => b.score - a.score);
  const high = list.filter((f) => f.band === "pursue").length, review = list.filter((f) => f.band === "review").length;
  box.replaceChildren(
    h("div", { class: "results-head" },
      h("h2", {}, `${list.length} ${list.length === 1 ? "opportunity" : "opportunities"} found`),
      h("span", { class: "counts" }, h("span", { class: "pill pursue" }, `${high} High fit`), " ", h("span", { class: "pill review" }, `${review} Review`), state.sweepLow != null ? [" ", h("span", { class: "pill low" }, `${state.sweepLow} Low fit (not listed)`)] : "")),
    list.length ? h("div", { class: "tablewrap" }, h("table", { class: "grid" },
      h("thead", {}, h("tr", {}, ...["Fit", "Opportunity", "Customer", "Industry", "Deadline", "Value", "Owner", "Status", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...list.map((f) => {
        const d = daysLeft(f.closeDate);
        return h("tr", { class: state.ws?.finding?.id === f.id ? "selected" : "" },
          h("td", {}, h("span", { class: `pill ${f.band}` }, f.score)),
          h("td", { class: "title" }, f.url ? h("a", { href: f.url, target: "_blank", rel: "noopener noreferrer" }, f.title) : f.title,
            h("div", { class: "buyer" }, (f.capabilities ?? []).slice(0, 2).map((c) => h("span", { class: "tag" }, c.label)), f.noticeType ? h("span", { class: "tag" }, f.noticeType) : null)),
          h("td", {}, f.buyer || "—"),
          h("td", {}, (state.meta.industries.find((i) => i.id === f.industry)?.name ?? f.industry).replace(/ \/.*$/, "")),
          h("td", {}, f.closeDate ? h("span", { class: `due ${d < 0 ? "over" : d <= 14 ? "soon" : ""}` }, f.closeDate, h("br"), `${d} days`) : h("span", { class: "unassigned" }, "not stated")),
          h("td", { class: "num" }, f.estimatedValue ? money(f.estimatedValue) : "—"),
          h("td", {}, f.assignee || h("span", { class: "unassigned" }, f.team?.opportunityOwner ? `suggest: ${f.team.opportunityOwner}` : "unassigned")),
          h("td", {}, f.status),
          h("td", {}, h("button", { class: "primary small", onclick: () => openWorkspace(f, "#sWorkspace") }, "Open")));
      })))) : h("p", { class: "empty" }, state.sweepIds ? "Nothing matched. Widen the date range, pick All capabilities, or choose another industry." : "Pick what you are looking for and press Run RFP Sweep."));
}

// =================================================================== Workspace
// Qualify → Assign → Analyze RFP → Draft Response → Red-team, for one opportunity.

const STEPS = [["qualify", "Qualify"], ["assign", "Assign"], ["analyze", "Analyze RFP"], ["draft", "Draft response"], ["redteam", "Red-team"]];
const WS_TABS = [["overview", "Overview"], ["requirements", "Requirements"], ["responses", "Responses"], ["risks", "Risks"], ["team", "Team"], ["proposal", "Proposal"]];

function openWorkspace(f, target) {
  const saved = f.workspace ?? {};
  state.ws = {
    target, finding: f, title: f.title, buyer: f.buyer, url: f.url, text: f.sourceText || "", proposalText: "",
    analysis: saved.analysis ?? null, answers: saved.answers ?? null, proposal: saved.proposal ?? null, redTeam: saved.redTeam ?? null,
    team: saved.teamOverride ?? f.team ?? null, tab: "overview", documentName: saved.documentName ?? null,
  };
  if (!state.ws.analysis && state.ws.text) runAnalyze(state.ws, { silent: true });
  renderSweepResults();
  renderWorkspace(state.ws);
  $(target).scrollIntoView({ behavior: "smooth", block: "start" });
}

function wsMeta(ws) {
  const f = ws.finding ?? {};
  return { buyer: ws.buyer ?? f.buyer, publishedDate: f.publishedDate, closeDate: f.closeDate, estimatedValue: f.estimatedValue ? money(f.estimatedValue) : null, url: ws.url ?? f.url, channel: f.channel, capabilities: f.capabilities ?? R().matchCapabilities(ws.title, ws.text).slice(0, 4) };
}

function runAnalyze(ws, { silent } = {}) {
  if (!ws.text || ws.text.trim().length < 40) { if (!silent) toast("There is no solicitation text yet. Upload the RFP document for this opportunity.", true); return; }
  ws.analysis = R().analyzeRfp({ text: ws.text, title: ws.title, source: ws.url ?? "", proposalText: ws.proposalText, packs: state.meta.packs, now: new Date(), closeDate: ws.finding?.closeDate });
  ws.team = ws.team ?? R().recommendTeam(R().matchCapabilities(ws.title, ws.text), state.meta.matrix);
  ws.answers = null; ws.proposal = null; ws.redTeam = null;
  persist(ws, ["analysis"]);
}

function runDraft(ws) {
  if (!ws.analysis) runAnalyze(ws);
  if (!ws.analysis) return;
  ws.answers = R().draftAnswers(ws.analysis.requirements, state.meta.knowledge, { matrix: state.meta.matrix });
  ws.proposal = R().buildProposal(ws.analysis, ws.answers, { text: ws.text, buyer: ws.buyer ?? "" });
  ws.redTeam = null;
  ws.tab = "responses";
  persist(ws, ["answers", "proposal"]);
}

function runRedTeam(ws) {
  if (!ws.answers) runDraft(ws);
  if (!ws.answers) return;
  ws.redTeam = R().redTeam(ws.analysis, ws.answers, ws.proposal ?? "");
  ws.tab = "proposal";
  persist(ws, ["redTeam"]);
}

let persistTimer;
function persist(ws, what) {
  if (STATIC || !ws.finding || ws.finding.channel === undefined) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      await fetch(`/api/findings/${ws.finding.id}/workspace?tenant=${encodeURIComponent(ws.finding.tenant ?? GENERAL)}`, {
        method: "PUT", headers: { "X-RFP-Dashboard": "1", "X-RFP-User": $("#me").value || "", "content-type": "application/json" },
        body: JSON.stringify({ analysis: ws.analysis, answers: ws.answers, proposal: ws.proposal, redTeam: ws.redTeam, teamOverride: ws.team, documentName: ws.documentName }),
      });
    } catch (e) { toast(`Not saved: ${e.message}`, true); }
  }, 400);
}

async function patchFinding(ws, patch, msg) {
  if (STATIC || !ws.finding) return toast("Read-only here. Use the local dashboard or the Excel sheet to change status and owners.");
  try {
    const r = await fetch(`/api/findings/${ws.finding.id}?tenant=${encodeURIComponent(ws.finding.tenant ?? GENERAL)}`, { method: "PATCH", headers: { "X-RFP-Dashboard": "1", "X-RFP-User": $("#me").value || "", "content-type": "application/json" }, body: JSON.stringify(patch) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    Object.assign(ws.finding, j);
    toast(msg);
  } catch (e) { toast(e.message, true); }
  renderWorkspace(ws);
}

function renderWorkspace(ws) {
  const box = $(ws.target);
  if (!box) return;
  const a = ws.analysis, sc = a?.scores, f = ws.finding;
  const done = { qualify: f && f.status !== "New", assign: !!(f?.assignee), analyze: !!a, draft: !!ws.answers, redteam: !!ws.redTeam };
  const act = {
    qualify: () => { ws.tab = "overview"; if (f && f.status === "New") patchFinding(ws, { status: "Qualifying" }, "Status: Qualifying"); else renderWorkspace(ws); },
    assign: () => { ws.tab = "team"; renderWorkspace(ws); },
    analyze: () => { runAnalyze(ws); ws.tab = "overview"; renderWorkspace(ws); },
    draft: () => { runDraft(ws); renderWorkspace(ws); },
    redteam: () => { runRedTeam(ws); renderWorkspace(ws); },
  };
  box.replaceChildren(h("section", { class: "card workspace" },
    h("div", { class: "ws-head" },
      h("div", {},
        h("h2", {}, ws.title || "Untitled RFP"),
        h("div", { class: "buyer" }, ws.buyer || "buyer not stated", f?.closeDate ? ` · closes ${f.closeDate}` : a?.keyData?.dates?.closing ? ` · closes ${a.keyData.dates.closing}` : "", ws.url ? [" · ", h("a", { href: ws.url, target: "_blank", rel: "noopener noreferrer" }, "source")] : "")),
      h("div", { class: "ws-actions" },
        h("button", { class: "keep", onclick: () => exportScoring(ws), disabled: !a }, "Export scoring file (.xlsx)"),
        h("button", { class: "keep", onclick: () => downloadText(`${slug(ws.title)}-proposal-draft.md`, ws.proposal ?? ""), disabled: !ws.proposal }, "Download proposal (.md)"),
        h("button", { class: "keep link", onclick: () => { box.replaceChildren(); if (ws === state.ws) { state.ws = null; renderSweepResults(); } } }, "Close"))),
    h("ol", { class: "stepper" }, ...STEPS.map(([k, label], i) => h("li", { class: done[k] ? "done" : "" }, h("button", { class: "keep", onclick: act[k] }, h("span", { class: "n" }, done[k] ? "✓" : i + 1), label)))),
    ws.finding && !ws.documentName && (!ws.text || ws.text.split(/\s+/).length < 400) ? uploadPrompt(ws) : null,
    sc ? h("div", { class: "kpis ws-kpis" }, ...[["Overall", sc.overall, sc.band], ["Fit", sc.fit], ["Risk (higher is safer)", sc.risk], ["Timeline", sc.timeline], ...(sc.coverage != null ? [["Coverage", sc.coverage]] : []), ["Requirements", a.requirements.length, `${sc.mandatory} mandatory`]].map(([l, v, sub]) => h("div", { class: "kpi" }, h("div", { class: "v" }, v), h("div", { class: "l" }, l, sub ? ` · ${sub}` : "")))) : null,
    h("nav", { class: "tabs ws-tabs" }, ...WS_TABS.map(([k, label]) => h("button", { class: `keep ${ws.tab === k ? "active" : ""}`, onclick: () => { ws.tab = k; renderWorkspace(ws); } }, label))),
    h("div", { class: "ws-body" }, wsTab(ws))));
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
  return h("div", { class: "notice" }, words ? `Only the notice summary is available (${words} words). ` : "No solicitation text yet. ",
    "For a full analysis, download the RFP from the source and load it here (read in your browser, not uploaded): ", input);
}

function wsTab(ws) {
  const a = ws.analysis;
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
        ws.finding ? h("div", { class: "row" },
          h("button", { class: "keep", onclick: () => patchFinding(ws, { status: "Pursuing" }, "Marked Pursuing") }, "Pursue"),
          h("button", { class: "keep", onclick: () => patchFinding(ws, { status: "No-bid" }, "Marked No-bid") }, "No-bid")) : null),
      h("div", {},
        h("h3", {}, "Verified, from the source"),
        h("table", { class: "facts" }, h("tbody", {}, ...q.verified.map((v) => h("tr", {}, h("th", {}, v.label), h("td", {}, v.value, h("span", { class: "hint" }, ` · ${v.from}`)))))),
        h("h3", { class: "mt" }, "Inferred by this tool"),
        h("table", { class: "facts inferred" }, h("tbody", {}, ...q.inferred.map((v) => h("tr", {}, h("th", {}, v.label), h("td", {}, v.value, h("span", { class: "hint" }, ` · ${v.how}`)))))),
        h("h3", { class: "mt" }, "Evaluator summary"),
        h("pre", {}, a.summary),
        h("button", { class: "keep", onclick: () => navigator.clipboard?.writeText(a.summary).then(() => toast("Summary copied")) }, "Copy summary")));
    case "requirements": return h("div", { class: "tablewrap" }, h("table", { class: "grid" },
      h("thead", {}, h("tr", {}, ...["ID", "Section", "Requirement", "Mandatory", "Category", "Owner", "Compliance"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...a.requirements.map((r) => h("tr", {},
        h("td", {}, r.id), h("td", {}, r.section), h("td", {}, r.text), h("td", {}, r.level === "mandatory" ? h("strong", {}, "Yes") : "No"),
        h("td", {}, h("span", { class: "tag" }, r.category)), h("td", {}, R().ownerForCategory(r.category, state.meta.matrix)),
        h("td", {}, comp[r.id] ? h("span", { class: `status ${comp[r.id].status}` }, comp[r.id].status) : h("span", { class: "hint" }, "load a proposal"))))),
      ), a.compliance ? null : h("p", { class: "hint" }, "To screen compliance, load your draft proposal in Analyze a document."));
    case "responses":
      if (!ws.answers) return h("div", {}, h("p", { class: "empty" }, "Press Draft response. Answers come only from the approved knowledge base (library/knowledge.json); anything without an approved source is marked SME validation required."), h("button", { class: "primary keep", onclick: () => { runDraft(ws); renderWorkspace(ws); } }, "Draft response"));
      return h("div", { class: "tablewrap" }, h("table", { class: "grid responses" },
        h("thead", {}, h("tr", {}, ...["Requirement", "Draft", "Sources", "Confidence", "Owner", "Status"].map((x) => h("th", {}, x)))),
        h("tbody", {}, ...ws.answers.map((x) => {
          const ta = h("textarea", { class: "keep", value: x.draft, "aria-label": `Draft for ${x.reqId}` });
          ta.addEventListener("change", () => { x.draft = ta.value; if (x.status === "Not started") x.status = "Drafted"; ws.proposal = R().buildProposal(a, ws.answers, { text: ws.text, buyer: ws.buyer ?? "" }); persist(ws, ["answers"]); });
          const st = h("select", { class: "keep", "aria-label": "Response status", onchange: (e) => { x.status = e.target.value; ws.proposal = R().buildProposal(a, ws.answers, { text: ws.text, buyer: ws.buyer ?? "" }); persist(ws, ["answers"]); } }, ...state.meta.responseStatuses.map((v) => h("option", { value: v, selected: v === x.status }, v)));
          return h("tr", {},
            h("td", {}, h("strong", {}, x.reqId), x.level === "mandatory" ? h("span", { class: "tag" }, "mandatory") : null, h("div", { class: "buyer" }, reqById[x.reqId]?.text ?? "")),
            h("td", {}, ta),
            h("td", {}, x.sources.length ? x.sources.map((s) => h("div", { class: s.stale ? "stale" : "" }, `${s.id} (${s.similarity})${s.stale ? " STALE" : ""}`)) : h("span", { class: "hint" }, "none")),
            h("td", {}, h("span", { class: `status conf-${x.confidence}` }, x.confidence), x.validationRequired ? h("div", { class: "hint" }, "SME validation") : null),
            h("td", {}, x.owner), h("td", {}, st));
        }))));
    case "risks": return a.risks.length ? h("ul", { class: "risk-list" }, ...a.risks.map((r) => h("li", { class: `sev-${r.severity}` }, h("strong", {}, `${r.severity.toUpperCase()}: ${r.label}`), h("div", { class: "hint" }, r.evidence)))) : h("p", { class: "empty" }, "No risk patterns found. Legal still reviews the terms.");
    case "team": {
      const t = ws.team ?? R().recommendTeam(R().matchCapabilities(ws.title, ws.text), state.meta.matrix);
      const roles = [["opportunityOwner", "Opportunity owner"], ["bidManager", "Bid manager"], ["solutionLead", "Solution lead"], ["technicalLead", "Technical lead"], ["commercialOwner", "Commercial owner"], ["executiveSponsor", "Executive sponsor"]];
      return h("div", {},
        h("p", { class: "hint" }, `Recommended from the capability matrix (config/capability-matrix.json). ${t.why ?? ""} Roles only; override any of them.`),
        h("table", { class: "facts" }, h("tbody", {}, ...roles.map(([k, l]) => {
          const inp = h("input", { class: "keep", list: "team", value: t[k] ?? "", "aria-label": l });
          inp.addEventListener("change", () => { ws.team = { ...t, [k]: inp.value.trim() }; persist(ws, ["teamOverride"]); });
          return h("tr", {}, h("th", {}, l), h("td", {}, inp));
        }), h("tr", {}, h("th", {}, "SME contributors"), h("td", {}, (t.smes ?? []).join(", ") || "—")))),
        ws.finding ? h("div", { class: "row" }, h("button", { class: "primary keep", onclick: () => patchFinding(ws, { assignee: t.opportunityOwner }, `Assigned to ${t.opportunityOwner}`) }, `Assign opportunity to ${t.opportunityOwner}`)) : null);
    }
    case "proposal": {
      if (!ws.proposal) return h("div", {}, h("p", { class: "empty" }, "Press Draft response to build the first draft."), h("button", { class: "primary keep", onclick: () => { runDraft(ws); ws.tab = "proposal"; renderWorkspace(ws); } }, "Draft response"));
      const ta = h("textarea", { class: "draft keep", value: ws.proposal, "aria-label": "Proposal draft" });
      ta.addEventListener("change", () => { ws.proposal = ta.value; ws.redTeam = null; persist(ws, ["proposal"]); renderWorkspace(ws); });
      const rt = ws.redTeam;
      return h("div", { class: "detail-grid" },
        h("div", {}, h("h3", {}, "Proposal draft"), ta),
        h("div", {},
          h("h3", {}, "Red-team readiness"),
          rt ? h("div", {},
            h("p", { class: `readiness ${rt.readiness === "Ready" ? "ok" : "bad"}` }, `RFP readiness: ${rt.readiness}`),
            rt.blocking.length ? [h("h4", {}, "Blocking"), list(rt.blocking, "blocking")] : null,
            rt.warnings.length ? [h("h4", {}, "Warnings"), list(rt.warnings)] : null,
            h("p", { class: "hint" }, rt.note)) : h("button", { class: "primary keep", onclick: () => { runRedTeam(ws); renderWorkspace(ws); } }, "Run red-team check")));
    }
  }
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

async function exportScoring(ws) {
  if (!ws.analysis) return;
  try {
    await loadScript("vendor/exceljs.min.js");
    const wb = await R().buildAnalysisWorkbook(window.ExcelJS, ws.analysis, { answers: ws.answers, redTeam: ws.redTeam, team: ws.team, proposal: ws.proposal });
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
