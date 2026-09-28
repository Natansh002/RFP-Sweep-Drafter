#!/usr/bin/env node
/**
 * The findings dashboard. Replaces ticket filing: findings, owners and action
 * items are tracked here and in the Excel workbook, nowhere else.
 *
 *   npm run dashboard                       local copy: http://127.0.0.1:4173, only you
 *   PORT=5000 npm run dashboard
 *   RFP_MODE=internal node scripts/dashboard.mjs
 *                                           the internal host, for a team, behind company
 *                                           sign-in (docs/internal-hosting.md)
 *
 * Security posture, on purpose:
 *   - local: binds to 127.0.0.1 only, and rejects any Host header that is not localhost
 *     (stops DNS-rebinding pages from driving it)
 *   - internal: every request needs a Microsoft Entra account signed in by App Service
 *     and on the access list; configuration changes need an admin; if sign-in is not
 *     switched on, everyone is refused (lib/hosting.mjs)
 *   - every write needs the X-RFP-Dashboard header, which a cross-site form or
 *     fetch cannot send without a CORS preflight this server never answers
 *   - strict Content-Security-Policy: no external scripts, styles, fonts or frames
 *   - no outbound calls except GETs to public pages, which go through lib/guard.mjs
 *     (no internal tools) and lib/netguard.mjs (no private or reserved addresses)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import PizZip from "pizzip";
import { ROOT, tenantIds, loadTenant, loadPack, loadData, outputFile } from "../lib/config.mjs";
import { hostMode, applyDataDir, dataStatus, signInStatus, readPrincipal, principalRefusal, adminEmails, defaultSchedule, validateSchedule, nextRun, isDue, zonedParts, describeSchedule, formatZoned, appVersion, hostSettings, SCHEDULE_DAYS, TIME_ZONES } from "../lib/hosting.mjs";
import { installNetworkGuard } from "../lib/netguard.mjs";
import { matchLibrary } from "../lib/library.mjs";
import { loadLedger, saveLedger, mergeRun, updateFinding, addAction, updateAction, getFinding } from "../lib/ledger.mjs";
import { workbookBuffer, importWorkbook, writeWorkbook } from "../lib/excel.mjs";
import { runSweep, readPublicPage } from "../lib/sweep.mjs";
import { browserInstalled, closeBrowser } from "../lib/browser.mjs";
import { pageFacts, textFacts, profileLinks, buildProfile, profileSearch } from "../lib/profile.mjs";
import { readStore, writeStore, mergePostings, writeTexts, readText, privateFile } from "../lib/ledger.mjs";
import { makeReference, linksIn } from "../lib/references.mjs";
import { pageText } from "../lib/enrich.mjs";
import { effectivePack } from "../lib/pack.mjs";
import { draftResponse, findingId } from "../lib/draft.mjs";
import { safeLink } from "../lib/guard.mjs";
import { validateAccess, accessFor, accessChanges, ACCESS_ROLES } from "../lib/access.mjs";
import { CRM_PLATFORMS, CRM_NAMES, validCrmLink } from "../lib/crm.mjs";
import { buildCalendar } from "../lib/ics.mjs";
import { DEFAULT_GO_NO_GO, saveWorkspace } from "../lib/ledger.mjs";
import { browserBundle, VENDOR } from "../lib/bundle.mjs";
import { sharedMeta } from "../lib/meta.mjs";
import { matchCapabilities, recommendTeam } from "../lib/capabilities.mjs";
import { GENERAL_ID } from "../lib/config.mjs";

const MODE = hostMode();
const INTERNAL = MODE === "internal";
// Before anything reads or writes the store: RFP_DATA_DIR moves all of it.
const DATA = applyDataDir(process.env, ROOT);
installNetworkGuard();
const VERSION = appVersion(ROOT);

const PORT = Number(process.env.PORT ?? (INTERNAL ? 8080 : 4173));
const HOST = INTERNAL ? (process.env.RFP_BIND || "0.0.0.0") : "127.0.0.1";
// App Service ends a request after 230 seconds. A sweep that takes longer carries on,
// and the browser picks up its result from /api/jobs/<id> (0 = always wait).
const WAIT_MS = Number(process.env.RFP_REQUEST_WAIT_MS ?? (INTERNAL ? 180000 : 0));
// On the internal host a link someone pastes (company website, reference) is read as a plain
// page, never opened in the host's browser: the browser renders only the configured portals.
const LINK_BROWSER = !INTERNAL;
const STATIC = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const CSP = "default-src 'none'; script-src 'self'; worker-src 'self' blob:; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SIGN_IN = "/.auth/login/aad";
const SIGN_OUT = "/.auth/logout?post_logout_redirect_uri=/";

// One write at a time per tenant, so two tabs cannot interleave a load/modify/save.
const locks = new Map();
async function withLedger(tenantId, fn) {
  const prev = locks.get(tenantId) ?? Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  locks.set(tenantId, prev.then(() => next));
  await prev;
  try {
    const ledger = loadLedger(ROOT, tenantId);
    const out = await fn(ledger);
    saveLedger(ROOT, ledger);
    return out;
  } finally {
    release();
  }
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, {
    "content-type": isBuf ? headers["content-type"] ?? "application/octet-stream" : "application/json; charset=utf-8",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    ...(INTERNAL ? { "strict-transport-security": "max-age=31536000" } : {}),
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** A plain page for people who cannot get in (not signed in, not on the list, sign-in off). */
const page = (title, ...paras) => Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">
<title>${esc(title)} · RFP Sweep and Drafter</title><link rel="stylesheet" href="/style.css"></head>
<body><main class="card no-access"><h1>${esc(title)}</h1>
${paras.join("\n")}
</main></body></html>
`);

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error("Upload too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const json = async (req) => { const b = await readBody(req, 2 * 1024 * 1024); return b.length ? JSON.parse(b.toString("utf8")) : {}; };
const fail = (status, message) => Object.assign(new Error(message), { status });

function tenantSummary(id) {
  const t = loadTenant(id);
  return {
    id: t.id, name: t.name, status: t.status, industries: t.industries,
    team: (t.team ?? []).map((m) => (typeof m === "string" ? { name: m } : m)).filter((m) => m.name),
    defaultOwner: t.owners?.default ?? "",
    goNoGo: t.goNoGo ?? DEFAULT_GO_NO_GO,
  };
}

const readPrivate = (name) => { try { const p = privateFile(ROOT, name); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null; } catch { return null; } };
const writePrivate = (name, value) => { const p = privateFile(ROOT, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(value, null, 2)); };

// ------------------------------------------------------------------ host settings, activity, sweeps
const accessList = () => readStore(ROOT, "access.json", { users: [] }).users ?? [];
function readSettings() {
  const s = readStore(ROOT, "settings.json", {});
  return { ...s, schedule: { ...defaultSchedule(), ...(s.schedule ?? {}) }, runs: s.runs ?? [] };
}
const writeSettings = (s) => writeStore(ROOT, "settings.json", s);

/** The internal host's activity log: who changed the configuration, and when (admins see it). */
function audit(user, what) {
  if (!INTERNAL) return;
  const a = readStore(ROOT, "audit.json", { entries: [] });
  a.entries = [{ at: new Date().toISOString(), by: user?.email ?? "schedule", what: String(what).slice(0, 600) }, ...(a.entries ?? [])].slice(0, 500);
  writeStore(ROOT, "audit.json", a);
}

// One sweep at a time, whoever starts it (a person's search, the pipeline's Sweep, the schedule).
const jobs = new Map();
let running = null;
const publicJob = (j) => j && ({ id: j.id, kind: j.kind, label: j.label, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt ?? null, error: j.error ?? null });
function startJob(kind, label, work) {
  if (running) throw Object.assign(fail(409, `A sweep is already running (${running.label}, started at ${running.startedAt.slice(11, 16)} UTC). Try again when it finishes.`), { job: publicJob(running) });
  const job = { id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind, label, status: "running", startedAt: new Date().toISOString() };
  running = job;
  jobs.set(job.id, job);
  job.promise = (async () => {
    try { job.result = await work(); job.status = "done"; }
    catch (e) { job.error = e.message; job.status = "failed"; console.error(e); }
    finally {
      job.endedAt = new Date().toISOString();
      running = null;
      await closeBrowser().catch(() => {});
      for (const [id, j] of jobs) if (j.status !== "running" && jobs.size > 20) jobs.delete(id);
    }
  })();
  return job;
}
/** The job's result if it finishes within WAIT_MS, else 202 with the job to poll. */
async function answerWith(job) {
  if (WAIT_MS > 0) await Promise.race([job.promise, new Promise((r) => setTimeout(r, WAIT_MS))]);
  else await job.promise;
  if (job.status === "done") return job.result;
  if (job.status === "failed") throw fail(500, job.error);
  return { __status: 202, job: publicJob(job), message: "Still sweeping. The results appear when it finishes." };
}

/** A live sweep of every industry (or one), merged into the all-industries pipeline. */
async function searchSweep(b = {}, { source = "dashboard" } = {}) {
  const industries = b.industry ? [b.industry] : loadTenant(GENERAL_ID).industries;
  const log = [], started = Date.now();
  if (process.env.RFP_SWEEP_DRY === "1") { // tests: the whole job flow without touching the portals
    await new Promise((r) => setTimeout(r, Number(process.env.RFP_SWEEP_DRY_MS ?? 400)));
    return { ids: [], found: 0, high: 0, review: 0, low: 0, gaps: 0, added: 0, log: ["dry run: no portals read"], seconds: 0 };
  }
  // Only the documents already read come from the ledger: people keep working on it while the portals are read.
  const docsRead = Object.fromEntries(loadLedger(ROOT, GENERAL_ID).findings.filter((f) => f.rfp?.readAt).map((f) => [f.id, f.rfp.readAt]));
  const ids = new Set();
  let low = 0, gaps = 0, added = 0;
  for (const ind of industries) {
    const run = await runSweep(GENERAL_ID, ind, { width: Number(b.width ?? 2), capabilities: b.capability ? [b.capability] : [], geography: b.geography || null, sinceDays: b.days ? Number(b.days) : null, matrix: loadData("config/capability-matrix.json") ?? undefined, profileTerms: b.profileTerms ?? null, docsRead, log: (m) => log.push(m), source });
    added += (await withLedger(GENERAL_ID, (l) => mergeRun(l, run))).added ?? 0;
    writeTexts(ROOT, run.texts);
    writeStore(ROOT, "postings.json", mergePostings(readStore(ROOT, "postings.json"), run.raw));
    for (const f of run.findings) ids.add(f.id);
    low += run.lowFit ?? 0; gaps += run.gaps.length;
  }
  const ledger = loadLedger(ROOT, GENERAL_ID);
  const found = ledger.findings.filter((f) => ids.has(f.id));
  await writeWorkbook(ledger, loadTenant(GENERAL_ID), outputFile(GENERAL_ID));
  return { ids: [...ids], found: found.length, high: found.filter((f) => f.band === "pursue").length, review: found.filter((f) => f.band === "review").length, low, gaps, added, log, seconds: Math.round((Date.now() - started) / 1000) };
}

/** The scheduled sweep (or an admin's "Run now"): every industry, searched with the company profile's terms. */
function scheduledSweep(trigger) {
  const s = readSettings();
  const profile = readStore(ROOT, "profile.json", null);
  return startJob("sweep", trigger === "schedule" ? "the scheduled sweep" : "a sweep an admin started", async () => {
    const at = new Date().toISOString();
    let r;
    try { r = await searchSweep({ width: s.schedule.width, profileTerms: profile?.name ? profileSearch(profile) : null }, { source: trigger === "schedule" ? "schedule" : "dashboard" }); }
    catch (e) { const st = readSettings(); st.runs = [{ at, trigger, error: e.message }, ...st.runs].slice(0, 10); writeSettings(st); throw e; }
    const st = readSettings();
    st.runs = [{ at, trigger, found: r.found, high: r.high, review: r.review, added: r.added, gaps: r.gaps, seconds: r.seconds }, ...st.runs].slice(0, 10);
    writeSettings(st);
    return r;
  });
}

function schedulerTick(now = new Date()) {
  if (!INTERNAL || running) return;
  const st = readSettings();
  if (!isDue(st.schedule, now, st.lastRunDate)) return;
  st.lastRunDate = zonedParts(now, st.schedule.timeZone).date; // before starting, so a restart cannot run it twice
  writeSettings(st);
  try { scheduledSweep("schedule"); } catch (e) { console.error(`Scheduled sweep not started: ${e.message}`); }
}

/** Everything the Configuration page shows about this host. */
async function hostInfo(user) {
  const base = { mode: MODE, version: VERSION.text, user: user ? { email: user.email, role: user.role, admin: user.admin } : null, canConfigure: !INTERNAL || !!user?.admin, signOut: INTERNAL ? SIGN_OUT : null, days: SCHEDULE_DAYS, timeZones: TIME_ZONES };
  const data = dataStatus(DATA, ROOT);
  const browser = await browserInstalled();
  if (!INTERNAL) return { ...base, data, browser };
  const st = readSettings(), next = nextRun(st.schedule), signIn = signInStatus();
  const users = accessList(), admins = adminEmails();
  const adminCount = new Set([...admins, ...users.filter((u) => u.admin).map((u) => u.email)]).size;
  const last = st.runs[0] ?? null;
  const checks = [
    { id: "signin", ok: signIn.on, label: signIn.on ? `Company sign-in is on: ${signIn.how}.` : "Company sign-in is off. Turn on App Service authentication with Microsoft Entra." },
    { id: "tenant", ok: !!process.env.RFP_TENANT_ID, warn: !process.env.RFP_TENANT_ID, label: process.env.RFP_TENANT_ID ? "Only accounts from your Microsoft Entra tenant are accepted." : "Set RFP_TENANT_ID so accounts from other tenants are refused as well." },
    { id: "admins", ok: adminCount > 0, label: `${adminCount} admin${adminCount === 1 ? "" : "s"} can change this configuration.` },
    { id: "data", ok: data.writable && data.persistent, label: data.writable ? `Data folder ${data.dir}: ${data.note}` : `The data folder ${data.dir} cannot be written.` },
    { id: "schedule", ok: !!next, warn: !next, label: next ? `Scheduled sweep: ${describeSchedule(st.schedule)}. Next: ${formatZoned(next, st.schedule.timeZone)}.` : "The scheduled sweep is off." },
    { id: "lastrun", ok: !!last && !last.error, warn: !last || !!last.error, label: !last ? "No sweep has run on this host yet." : last.error ? `The last sweep failed: ${last.error}` : `Last sweep ${last.at.slice(0, 16).replace("T", " ")} UTC: ${last.found} opportunities, ${last.gaps} source(s) not read.` },
    { id: "browser", ok: browser, warn: !browser, label: browser ? "A headless browser is installed for portals that need one." : "No headless browser: portals that build their listings with JavaScript are reported as not read. Use the container image." },
  ];
  return {
    ...base,
    signIn, data, browser, checks,
    schedule: { ...st.schedule, text: describeSchedule(st.schedule), next: next?.toISOString() ?? null, nextText: next ? formatZoned(next, st.schedule.timeZone) : null },
    runs: st.runs.slice(0, 5), running: publicJob(running),
    people: { count: users.length, admins: adminCount },
    settings: user?.admin ? hostSettings() : [],
  };
}

// ------------------------------------------------------------------ routes
// [method, path, handler, options]. options.admin: on the internal host, admins only.
const ADMIN = { admin: true };
const routes = [
  ["GET", /^\/api\/meta$/, async () => ({ tenants: tenantIds().map(tenantSummary), ...sharedMeta({ includePrivate: true }) })],
  ["GET", /^\/api\/host$/, async (req) => hostInfo(req.user)],

  // Industry → Geography → Capability → Date range. Live sweep, merged into the all-industries pipeline.
  ["POST", /^\/api\/search$/, async (req) => {
    const b = await json(req);
    return answerWith(startJob("search", "a search", () => searchSweep(b)));
  }],
  ["GET", /^\/api\/jobs\/current$/, async () => ({ job: publicJob(running) })],
  ["GET", /^\/api\/jobs\/([\w-]+)$/, async (req, u, [id]) => {
    const j = jobs.get(id);
    if (!j) throw fail(404, "That sweep is no longer known (the host restarted). Its results, if it finished, are in the pipeline.");
    return { ...publicJob(j), result: j.status === "done" ? j.result : null };
  }],

  // ---- company profile: understand the business from its website (or pasted text)
  ["GET", /^\/api\/profile$/, async () => readStore(ROOT, "profile.json", {})],
  ["PUT", /^\/api\/profile$/, async (req) => {
    const p = await json(req);
    if (!p || !p.name) throw fail(400, "A profile needs a name.");
    writeStore(ROOT, "profile.json", p);
    return p;
  }],
  ["DELETE", /^\/api\/profile$/, async () => { writeStore(ROOT, "profile.json", {}); return {}; }],
  ["POST", /^\/api\/profile\/build$/, async (req) => {
    const b = await json(req);
    let profile;
    if (b.url) {
      const url = /^https?:\/\//i.test(b.url) ? b.url : `https://${b.url}`;
      // Guarded: public web only. A refused or unreadable site is the person's input, not a server fault.
      const home = await readPublicPage(url, { browser: LINK_BROWSER }).catch((e) => ({ error: e.message }));
      if (home.error) throw fail(/^Blocked:/.test(home.error) ? 400 : 422, `Could not read ${url}: ${home.error}`);
      const pages = [pageFacts(home.html, url)];
      const read = [{ url, html: home.html }];
      const more = profileLinks(url, pages[0], 6);
      for (const u of more) {
        const r = await readPublicPage(u, { browser: LINK_BROWSER }).catch((e) => ({ error: e.message }));
        if (!r.error && r.html) { pages.push(pageFacts(r.html, u)); read.push({ url: u, html: r.html }); }
      }
      profile = buildProfile({ website: url, pages });
      // The pages read are product knowledge: add them to the reference library, so drafts can cite them.
      const refs = readPrivate("references.local.json")?.references ?? [];
      const byId = new Map(refs.map((r) => [r.id, r]));
      for (const p of read) { const r = makeReference({ source: p.url, title: `${profile.name}: ${pageFacts(p.html, p.url).title || p.url}`, kind: "link", text: pageText(p.html) }); if (!r.error) byId.set(r.id, r); }
      writePrivate("references.local.json", { references: [...byId.values()] });
    } else if (b.text && String(b.text).trim().length > 80) {
      profile = buildProfile({ website: b.website || null, pages: [textFacts(b.text, b.name || "")], source: "pasted text" });
    } else throw fail(400, "Give a website address, or paste at least a paragraph about the company.");
    writeStore(ROOT, "profile.json", profile);
    return profile;
  }],
  ["GET", /^\/api\/postings$/, async () => readStore(ROOT, "postings.json", { postings: [] })],

  // ---- your response template and reference library (the private library folder, never in git or published)
  ["GET", /^\/api\/library$/, async () => {
    const refs = readPrivate("references.local.json")?.references ?? [];
    return { template: readPrivate("template.json"), references: refs.map(({ passages, ...r }) => ({ ...r, passages: passages?.length ?? 0 })) };
  }],
  ["GET", /^\/api\/library\/template$/, async () => {
    const meta = readPrivate("template.json");
    if (!meta) throw fail(404, "No template uploaded yet.");
    return { __file: fs.readFileSync(privateFile(ROOT, `template.${meta.type}`)), type: meta.type === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: meta.name.replace(/[^\w. -]/g, "_") };
  }],
  ["PUT", /^\/api\/library\/template$/, async (req) => {
    const name = String(req.headers["x-file-name"] ?? "").slice(0, 120);
    const type = /\.xlsx$/i.test(name) ? "xlsx" : /\.docx$/i.test(name) ? "docx" : null;
    const buf = await readBody(req, 10 * 1024 * 1024);
    if (!type || buf[0] !== 0x50 || buf[1] !== 0x4b) throw fail(400, "Upload a Word (.docx) or Excel (.xlsx) template.");
    fs.mkdirSync(path.dirname(privateFile(ROOT, "x")), { recursive: true });
    for (const t of ["docx", "xlsx"]) fs.rmSync(privateFile(ROOT, `template.${t}`), { force: true });
    fs.writeFileSync(privateFile(ROOT, `template.${type}`), buf);
    const meta = { name, type, size: buf.length, uploadedAt: new Date().toISOString(), tags: String(req.headers["x-template-tags"] ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 60) };
    writePrivate("template.json", meta);
    return meta;
  }],
  ["DELETE", /^\/api\/library\/template$/, async () => {
    for (const f of ["template.json", "template.docx", "template.xlsx"]) fs.rmSync(privateFile(ROOT, f), { force: true });
    return {};
  }],
  // Links are read here, through the guard (public pages only); files are read in the browser and sent as text.
  ["POST", /^\/api\/library\/references$/, async (req) => {
    const b = await json(req);
    const added = [];
    for (const url of linksIn((b.links ?? []).join("\n")).slice(0, 25)) {
      const pg = await readPublicPage(url, { browser: LINK_BROWSER }).catch((e) => ({ error: e.message }));
      if (pg.error) { added.push(makeReference({ source: url, kind: "link", error: /^Blocked:/.test(pg.error) ? "Internal tools and private addresses are never read. Upload the file instead." : `Could not read it (${pg.error}).` })); continue; }
      added.push(makeReference({ source: url, title: pageFacts(pg.html, url).title, kind: "link", text: pageText(pg.html) }));
    }
    for (const f of (b.files ?? []).slice(0, 25)) added.push(makeReference({ source: String(f.name ?? "file").slice(0, 160), kind: "file", text: String(f.text ?? "").slice(0, 2_000_000) }));
    const cur = readPrivate("references.local.json")?.references ?? [];
    const byId = new Map(cur.map((r) => [r.id, r]));
    for (const r of added) byId.set(r.id, r);
    writePrivate("references.local.json", { references: [...byId.values()] });
    return { added: added.map(({ passages, ...r }) => ({ ...r, passages: passages.length })), references: [...byId.values()].map(({ passages, ...r }) => ({ ...r, passages: passages?.length ?? 0 })) };
  }],
  ["DELETE", /^\/api\/library\/references\/([\w-]+)$/, async (req, u, [id]) => {
    const cur = readPrivate("references.local.json")?.references ?? [];
    writePrivate("references.local.json", { references: cur.filter((r) => r.id !== id) });
    return {};
  }],

  // ---- configuration: who can open the internal host, the sweep schedule, the sales-platform link
  ["GET", /^\/api\/access$/, async (req) => {
    const users = accessList();
    // Everyone on the list may see their own access; only admins see the whole list.
    if (INTERNAL && !req.user?.admin) return { roles: ACCESS_ROLES, users: [], count: users.length, you: req.user, canEdit: false };
    return { roles: ACCESS_ROLES, users, admins: INTERNAL ? adminEmails() : [], count: users.length, you: req.user ?? null, canEdit: true };
  }],
  ["PUT", /^\/api\/access$/, async (req) => {
    const b = await json(req);
    const { users, errors } = validateAccess(b.users);
    if (errors.length) throw fail(400, errors.join(" "));
    if (INTERNAL && !adminEmails().length && !users.some((u) => u.admin)) throw fail(400, "Keep at least one admin on the list, or nobody can change this configuration.");
    const before = accessList();
    writeStore(ROOT, "access.json", { users, updatedAt: new Date().toISOString() });
    const changes = accessChanges(before, users);
    if (changes.length) audit(req.user, `Access list: ${changes.join("; ")}`);
    return { roles: ACCESS_ROLES, users, admins: INTERNAL ? adminEmails() : [], count: users.length, changes };
  }, ADMIN],
  ["GET", /^\/api\/settings$/, async () => { const s = readSettings(); const next = nextRun(s.schedule); return { schedule: s.schedule, text: describeSchedule(s.schedule), next: next?.toISOString() ?? null, nextText: next ? formatZoned(next, s.schedule.timeZone) : null, runs: s.runs.slice(0, 5), running: publicJob(running) }; }],
  ["PUT", /^\/api\/settings\/schedule$/, async (req) => {
    const b = await json(req);
    const st = readSettings();
    const { schedule, errors } = validateSchedule(b, st.schedule);
    if (errors.length) throw fail(400, errors.join(" "));
    st.schedule = schedule;
    writeSettings(st);
    audit(req.user, `Sweep schedule: ${describeSchedule(schedule)}, width ${schedule.width}`);
    const next = nextRun(schedule);
    return { schedule, text: describeSchedule(schedule), next: next?.toISOString() ?? null, nextText: next ? formatZoned(next, schedule.timeZone) : null };
  }, ADMIN],
  ["POST", /^\/api\/settings\/run-now$/, async (req) => {
    const job = scheduledSweep("admin");
    audit(req.user, "Started a sweep (Run now)");
    return { job: publicJob(job) };
  }, ADMIN],
  ["GET", /^\/api\/audit$/, async () => ({ entries: (readStore(ROOT, "audit.json", { entries: [] }).entries ?? []).slice(0, 50) }), ADMIN],
  // Everything the host keeps (users, settings, findings, library) as one zip, for a backup copy.
  ["GET", /^\/api\/backup\.zip$/, async (req) => {
    const zip = new PizZip();
    const add = (dir, prefix, skip = () => false) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) if (f.isFile() && !f.name.endsWith(".tmp") && !f.name.startsWith(".") && !skip(f.name)) zip.file(`${prefix}/${f.name}`, fs.readFileSync(path.join(dir, f.name)));
    };
    add(DATA.store, "store");
    add(DATA.library, "library");
    audit(req.user, "Downloaded a backup");
    return { __file: zip.generate({ type: "nodebuffer", compression: "DEFLATE" }), type: "application/zip", name: `rfp-sweep-backup-${new Date().toISOString().slice(0, 10)}.zip` };
  }, ADMIN],
  ["GET", /^\/api\/crm$/, async () => ({ platforms: CRM_PLATFORMS, platform: "salesforce", links: {}, ...readStore(ROOT, "crm.json", {}) })],
  ["PUT", /^\/api\/crm$/, async (req) => {
    const b = await json(req);
    if (!CRM_PLATFORMS.includes(b.platform)) throw fail(400, `Choose one of: ${CRM_PLATFORMS.join(", ")}`);
    const cur = readStore(ROOT, "crm.json", { links: {} });
    writeStore(ROOT, "crm.json", { ...cur, platform: b.platform });
    audit(req.user, `Sales platform: ${CRM_NAMES[b.platform]}`);
    return { ...cur, platform: b.platform };
  }, ADMIN],
  ["PUT", /^\/api\/crm\/links\/([\w-]+)$/, async (req, u, [id]) => {
    const b = await json(req);
    const err = validCrmLink(b);
    if (err) throw fail(400, err);
    const cur = readStore(ROOT, "crm.json", { links: {} });
    cur.links = { ...(cur.links ?? {}), [id]: { platform: b.platform, recordId: b.recordId, url: b.url || null, linkedAt: new Date().toISOString() } };
    writeStore(ROOT, "crm.json", cur);
    return cur.links[id];
  }],
  ["DELETE", /^\/api\/crm\/links\/([\w-]+)$/, async (req, u, [id]) => {
    const cur = readStore(ROOT, "crm.json", { links: {} });
    if (cur.links?.[id]) { delete cur.links[id]; writeStore(ROOT, "crm.json", cur); }
    return {};
  }],
  // The full solicitation text the sweep read for a finding (notice + public documents).
  ["GET", /^\/api\/findings\/([\w-]+)\/text$/, async (req, u, [id]) => {
    const text = readText(ROOT, id);
    if (text == null) throw fail(404, "No solicitation documents were read for this finding.");
    return { id, text };
  }],

  ["PUT", /^\/api\/findings\/([\w-]+)\/workspace$/, async (req, u, [id]) => {
    const body = await json(req);
    return withLedger(tenantParam(u), (l) => saveWorkspace(l, id, body, { by: actor(req) }));
  }],

  // An RFP document someone uploaded in "Analyze a document", or a posting the sweep saw
  // that no industry pack kept, added to the pipeline by a person.
  ["POST", /^\/api\/findings$/, async (req, u) => {
    const b = await json(req);
    const tid = tenantParam(u);
    if (!b.title || !b.text) throw fail(400, "title and text are required");
    const day = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d ?? "")) ? d : null);
    return withLedger(tid, (l) => {
      const url = safeLink(b.url) ?? null;
      const fromSweep = !!b.channel && b.channel !== "upload";
      // A posting from the sweep keeps the id the sweep gives it, so a later sweep updates it instead of adding a copy.
      const id = fromSweep ? findingId(tid, { sourceId: b.sourceId || null, title: b.title, buyer: b.buyer }) : `${tid.slice(0, 4)}-u${Date.now().toString(36)}`;
      const same = l.findings.find((x) => x.id === id || (x.title === String(b.title).slice(0, 200) && (x.url ?? null) === url));
      if (same) return same;
      const caps = matchCapabilities(b.title, b.text);
      const f = {
        id, tenant: tid, industry: b.industry || "any", industryStatus: fromSweep ? "added" : "uploaded", title: String(b.title).slice(0, 200), buyer: b.buyer || null, country: /^(CA|US)$/.test(b.country ?? "") ? b.country : null, url,
        channel: fromSweep ? String(b.channel).slice(0, 60) : "upload", closeDate: day(b.closeDate), publishedDate: day(b.publishedDate), noticeType: b.noticeType ? String(b.noticeType).slice(0, 60) : null,
        estimatedValue: null, score: Math.max(0, Math.min(100, Number(b.score ?? 0) || 0)), band: ["pursue", "review"].includes(b.band) ? b.band : "review",
        reasons: [b.reason ? String(b.reason).slice(0, 300) : "uploaded by a person; scored by the analyzer"], flags: [],
        draft: { brief: "", response: null }, assignee: "", suggestedAssignee: "", actions: [], keyDates: {}, requirements: [], competitors: [],
        sourceText: String(b.text).slice(0, 60000), capabilities: caps.map(({ id, label, matched }) => ({ id, label, matched })), team: recommendTeam(caps, loadData("config/capability-matrix.json") ?? undefined),
        status: "New", notes: "", rev: 0, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), seenCount: 1, goNoGo: {}, lossReason: "", awardee: "",
      };
      l.findings.push(f);
      return f;
    });
  }],

  ["GET", /^\/api\/ledger$/, async (req, u) => loadLedger(ROOT, tenantParam(u))],

  ["PATCH", /^\/api\/findings\/([\w-]+)$/, async (req, u, [id]) => {
    const body = await json(req);
    return withLedger(tenantParam(u), (l) => updateFinding(l, id, body, { expectedRev: body.rev, by: actor(req) }));
  }],

  ["POST", /^\/api\/findings\/([\w-]+)\/actions$/, async (req, u, [id]) => {
    const body = await json(req);
    return withLedger(tenantParam(u), (l) => addAction(l, id, body, { by: actor(req) }));
  }],

  ["PATCH", /^\/api\/findings\/([\w-]+)\/actions\/([\w-]+)$/, async (req, u, [id, aid]) => {
    const body = await json(req);
    return withLedger(tenantParam(u), (l) => updateAction(l, id, aid, body, { expectedRev: body.rev }));
  }],

  // The drafter on demand: a "review" finding someone has decided to look at properly.
  ["POST", /^\/api\/findings\/([\w-]+)\/draft$/, async (req, u, [id]) => {
    const tid = tenantParam(u);
    const tenant = loadTenant(tid);
    return withLedger(tid, (l) => {
      const f = getFinding(l, id);
      if (f.draftEdited) throw fail(409, "This draft has been edited by a person; it will not be regenerated over their work.");
      const pack = effectivePack(loadPack(f.industry), tenant);
      const library = matchLibrary(loadData(`library/${tid}.json`)?.entries ?? [], `${f.title} ${(f.requirements ?? []).map((r) => r.text).join(" ")}`, f.industry);
      f.draft = { ...(f.draft ?? {}), response: draftResponse(f, pack, tenant, library) };
      f.libraryMatches = library.map((x) => ({ id: x.id, stale: x.stale }));
      return f;
    });
  }],

  ["POST", /^\/api\/sweep$/, async (req, u) => {
    const body = await json(req);
    const tid = tenantParam(u);
    const tenant = loadTenant(tid);
    const industries = body.industry ? [body.industry] : tenant.industries;
    return answerWith(startJob("sweep", "a pipeline sweep", async () => {
      const log = [], summary = [];
      for (const ind of industries) {
        const run = await runSweep(tid, ind, { width: Number(body.width ?? 2), direct: !!body.direct, log: (m) => log.push(m), source: "dashboard" });
        const merged = await withLedger(tid, (l) => mergeRun(l, run));
        summary.push({ industry: ind, ...merged, halted: run.halted, haltReason: run.haltReason, gaps: run.gaps.length, caveat: run.caveat });
        writeTexts(ROOT, run.texts);
      }
      await writeWorkbook(loadLedger(ROOT, tid), tenant, outputFile(tid));
      return { summary, log };
    }));
  }],

  ["GET", /^\/api\/export\.xlsx$/, async (req, u) => {
    const tid = tenantParam(u);
    const buf = await workbookBuffer(loadLedger(ROOT, tid), loadTenant(tid));
    return { __file: buf, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: `${tid}-rfp-findings-${new Date().toISOString().slice(0, 10)}.xlsx` };
  }],

  ["GET", /^\/api\/calendar\.ics$/, async (req, u) => {
    const tid = tenantParam(u);
    return { __file: Buffer.from(buildCalendar(loadLedger(ROOT, tid), loadTenant(tid))), type: "text/calendar; charset=utf-8", name: `${tid}-rfp-deadlines.ics` };
  }],

  ["POST", /^\/api\/import$/, async (req, u) => {
    const tid = tenantParam(u);
    const buf = await readBody(req);
    if (buf.subarray(0, 2).toString() !== "PK") throw fail(400, "That is not an .xlsx file.");
    const result = await withLedger(tid, (l) => importWorkbook(l, buf, { by: actor(req) ? `${actor(req)} (excel)` : "excel" }));
    await writeWorkbook(loadLedger(ROOT, tid), loadTenant(tid), outputFile(tid));
    return result;
  }],

  // A findings file produced by the n8n workflow (its "findings.json" output), uploaded by a person.
  ["POST", /^\/api\/import-run$/, async (req, u) => {
    const tid = tenantParam(u);
    const run = JSON.parse((await readBody(req, 10 * 1024 * 1024)).toString("utf8"));
    if (run.tenant !== tid) throw fail(400, `That run file is for "${run.tenant}", not "${tid}".`);
    if (!Array.isArray(run.findings)) throw fail(400, "Not a sweeper run file: no findings array.");
    for (const f of run.findings) f.url = safeLink(f.url);
    const r = await withLedger(tid, (l) => mergeRun(l, { ...run, source: "n8n", gaps: run.gaps ?? [] }));
    await writeWorkbook(loadLedger(ROOT, tid), loadTenant(tid), outputFile(tid));
    return r;
  }],
];

function tenantParam(u) {
  const id = u.searchParams.get("tenant") ?? "";
  if (!id) return GENERAL_ID;
  if (!tenantIds().includes(id)) throw fail(400, `Unknown tenant "${id}"`);
  return id;
}
// Who made a change. On the internal host: the signed-in person's role (roles only, never names).
const actor = (req) => req.user?.role ?? (String(req.headers["x-rfp-user"] ?? "").slice(0, 80).replace(/[^\p{L}\p{N} .'@_-]/gu, "") || null);

/**
 * On the internal host: who is asking, or why not. Returns { user } or { status, ... }.
 * App Service signs people in before a request gets here; this decides whether they may use it.
 */
function identify(req) {
  const signIn = signInStatus();
  if (!signIn.on) return { status: 503, reason: "signin-off" };
  const p = readPrincipal(req.headers);
  if (!p) return { status: 401, reason: "signin" };
  const refusal = principalRefusal(p);
  if (refusal) return { status: 403, reason: "account", message: refusal, email: p.email };
  const user = accessFor({ users: accessList(), admins: adminEmails(), email: p.email });
  if (!user) return { status: 403, reason: "not-listed", email: p.email };
  return { user };
}

function refuse(res, req, u, who) {
  const wantsPage = req.method === "GET" && !u.pathname.startsWith("/api/");
  const signOut = `<p><a href="${SIGN_OUT}">Sign out</a></p>`;
  if (who.reason === "signin") {
    const back = /^\/(?!\/)[\w\-./?=&%]*$/.test(u.pathname + u.search) ? u.pathname + u.search : "/";
    if (wantsPage) return send(res, 302, Buffer.from(""), { location: `${SIGN_IN}?post_login_redirect_uri=${encodeURIComponent(back)}`, "content-type": "text/plain" });
    return send(res, 401, { error: "Sign in with your company account first.", signIn: SIGN_IN });
  }
  if (who.reason === "signin-off") {
    if (wantsPage) return send(res, 503, page("Company sign-in is not switched on", "<p>This copy of RFP Sweep and Drafter runs on the internal host, which lets people in only through your company's Microsoft sign-in. That sign-in is not switched on yet, so nobody can open it.</p>", "<p>Operations: turn on App Service authentication with Microsoft Entra for this app (docs/internal-hosting.md in the repository).</p>"), { "content-type": TYPES[".html"] });
    return send(res, 503, { error: "Company sign-in is not switched on for this host." });
  }
  if (who.reason === "account") {
    if (wantsPage) return send(res, 403, page("This account cannot open RFP Sweep and Drafter", `<p>${esc(who.message)}</p>`, `<p>Signed in as ${esc(who.email)}.</p>`, signOut), { "content-type": TYPES[".html"] });
    return send(res, 403, { error: who.message });
  }
  if (wantsPage) return send(res, 403, page("You are signed in, but not on the access list", `<p>You are signed in as <strong>${esc(who.email)}</strong>. RFP Sweep and Drafter is open only to the work emails an admin has added on its Configuration page.</p>`, "<p>Ask an admin to add you, with your role.</p>", signOut), { "content-type": TYPES[".html"] });
  return send(res, 403, { error: `${who.email} is not on the access list. Ask an admin to add you.` });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host ?? "");
    if (!INTERNAL && !new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}$`).test(host)) return send(res, 421, { error: "Unexpected Host header" });
    const u = new URL(req.url, `http://${INTERNAL ? "internal-host" : host}`);

    // The platform's health check. Says only that the app is up: no data.
    if (req.method === "GET" && u.pathname === "/healthz") return send(res, 200, { ok: true, mode: MODE, version: VERSION.text, ...(INTERNAL ? { signIn: signInStatus().on } : {}) });
    // The stylesheet, also for the pages shown to people who cannot get in.
    if (req.method === "GET" && u.pathname === "/style.css") return send(res, 200, fs.readFileSync(path.join(ROOT, "dashboard", "style.css")), { "content-type": TYPES[".css"] });

    if (INTERNAL) {
      const who = identify(req);
      if (!who.user) return refuse(res, req, u, who);
      req.user = who.user;
    }

    if (req.method === "GET" && u.pathname === "/rfp-bundle.js") return send(res, 200, Buffer.from(browserBundle()), { "content-type": TYPES[".js"] });
    const vend = u.pathname.match(/^\/vendor\/([\w.-]+)$/);
    if (req.method === "GET" && vend && VENDOR[vend[1]]) return send(res, 200, fs.readFileSync(path.join(ROOT, VENDOR[vend[1]])), { "content-type": TYPES[path.extname(vend[1])] ?? "text/javascript", "cache-control": "max-age=86400" });
    if (req.method === "GET" && STATIC[u.pathname]) {
      const file = path.join(ROOT, "dashboard", STATIC[u.pathname]);
      let body = fs.readFileSync(file);
      if (INTERNAL && u.pathname === "/") body = Buffer.from(body.toString("utf8").replace("<head>", '<head>\n  <meta name="rfp-mode" content="internal">'));
      return send(res, 200, body, { "content-type": TYPES[path.extname(file)] });
    }

    if (req.method !== "GET" && req.headers["x-rfp-dashboard"] !== "1") return send(res, 403, { error: "Missing X-RFP-Dashboard header" });
    if (req.method !== "GET" && req.headers["sec-fetch-site"] === "cross-site") return send(res, 403, { error: "Cross-site requests are refused" });

    for (const [method, re, fn, opts] of routes) {
      const m = req.method === method && u.pathname.match(re);
      if (!m) continue;
      if (opts?.admin && INTERNAL && !req.user?.admin) return send(res, 403, { error: "Only an admin can change the configuration. Ask an admin on the Configuration page." });
      const out = await fn(req, u, m.slice(1));
      if (out?.__file) return send(res, 200, out.__file, { "content-type": out.type, "content-disposition": `attachment; filename="${out.name}"` });
      if (out?.__status) { const { __status, ...rest } = out; return send(res, __status, rest); }
      return send(res, 200, out);
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    const status = e.status ?? (e.code === "CONFLICT" ? 409 : e.code === "NOT_FOUND" ? 404 : e instanceof SyntaxError ? 400 : 500);
    if (status === 500) console.error(e);
    send(res, status, { error: e.message, ...(e.job ? { job: e.job } : {}) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RFP Sweep and Drafter ${VERSION.text}, ${MODE} mode: http://${HOST}:${PORT}`);
  if (INTERNAL) {
    const s = signInStatus(), d = dataStatus(DATA, ROOT);
    console.log(`Sign-in: ${s.on ? s.how : "OFF, so every request is refused until App Service authentication is switched on"}.`);
    console.log(`Data: ${d.dir} (${d.writable ? "writable" : "NOT writable"}; ${d.note})`);
    console.log(`Admins from RFP_ADMINS: ${adminEmails().length}. Schedule: ${describeSchedule(readSettings().schedule)}.`);
    setInterval(schedulerTick, Number(process.env.RFP_SCHEDULER_TICK_MS ?? 60000)).unref();
  } else {
    console.log(`Tenants: ${tenantIds().join(", ")}. Local only; nothing is sent to Jira, Confluence or any other internal tool.`);
  }
});
