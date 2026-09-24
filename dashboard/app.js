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
const state = { meta: null, tenant: null, ledger: null, open: new Set(), tab: "findings" };

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
  $(".brand .sub").textContent = "Published by GitHub Actions. Nothing is filed in Jira or Confluence.";
}

function lockEdits() {
  for (const el of document.querySelectorAll("main .grid input, main .grid select, main .grid textarea, main .grid button:not(.link)")) {
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
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const s of document.querySelectorAll(".tab")) s.hidden = s.id !== `tab-${tab}`;
  render();
}

// ------------------------------------------------------------------ wiring
$("#tenant").addEventListener("change", (e) => { state.tenant = e.target.value; store.set("rfp.tenant", state.tenant); onTenant(); });
$("#me").addEventListener("change", (e) => { store.set("rfp.me", e.target.value.trim()); render(); });
for (const id of ["q", "fIndustry", "fBand", "fStatus", "fAssignee", "fChanged"]) $(`#${id}`).addEventListener("input", renderFindings);
for (const id of ["aAssignee", "aShowDone"]) $(`#${id}`).addEventListener("input", renderActions);
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => switchTab(b.dataset.tab));

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

loadMeta().catch((e) => toast(`Could not load: ${e.message}`, true));
