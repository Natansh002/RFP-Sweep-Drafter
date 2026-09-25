#!/usr/bin/env node
/**
 * The findings dashboard. Replaces ticket filing: findings, owners and action
 * items are tracked here and in the Excel workbook, nowhere else.
 *
 *   npm run dashboard            http://127.0.0.1:4173
 *   PORT=5000 npm run dashboard
 *
 * Security posture, on purpose:
 *   - binds to 127.0.0.1 only, and rejects any Host header that is not localhost
 *     (stops DNS-rebinding pages from driving it)
 *   - every write needs the X-RFP-Dashboard header, which a cross-site form or
 *     fetch cannot send without a CORS preflight this server never answers
 *   - strict Content-Security-Policy: no external scripts, styles, fonts or frames
 *   - no outbound calls except a sweep's GETs to public procurement pages, which
 *     go through lib/guard.mjs like every other fetch
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT, tenantIds, loadTenant, loadPack, loadData, outputFile } from "../lib/config.mjs";
import { matchLibrary } from "../lib/library.mjs";
import { loadLedger, saveLedger, mergeRun, updateFinding, addAction, updateAction, getFinding, STATUSES } from "../lib/ledger.mjs";
import { workbookBuffer, importWorkbook, writeWorkbook } from "../lib/excel.mjs";
import { runSweep, readPublicPage } from "../lib/sweep.mjs";
import { pageFacts, textFacts, profileLinks, buildProfile } from "../lib/profile.mjs";
import { readStore, writeStore, mergePostings, writeTexts, readText } from "../lib/ledger.mjs";
import { effectivePack } from "../lib/pack.mjs";
import { draftResponse, findingId } from "../lib/draft.mjs";
import { safeLink } from "../lib/guard.mjs";
import { validateAccess, ACCESS_ROLES } from "../lib/access.mjs";
import { CRM_PLATFORMS, validCrmLink } from "../lib/crm.mjs";
import { buildCalendar } from "../lib/ics.mjs";
import { DEFAULT_GO_NO_GO, COMPLIANCE_STATUSES, saveWorkspace } from "../lib/ledger.mjs";
import { browserBundle, VENDOR } from "../lib/bundle.mjs";
import { sharedMeta } from "../lib/meta.mjs";
import { CAPABILITIES, GEOGRAPHIES, DATE_RANGES, DEFAULT_MATRIX, matchCapabilities, recommendTeam } from "../lib/capabilities.mjs";
import { RESPONSE_STATUSES } from "../lib/respond.mjs";
import { industryIds, GENERAL_ID } from "../lib/config.mjs";

const PORT = Number(process.env.PORT ?? 4173);
const HOST = "127.0.0.1";
const STATIC = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const CSP = "default-src 'none'; script-src 'self'; worker-src 'self' blob:; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

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

function tenantSummary(id) {
  const t = loadTenant(id);
  return {
    id: t.id, name: t.name, status: t.status, industries: t.industries,
    team: (t.team ?? []).map((m) => (typeof m === "string" ? { name: m } : m)).filter((m) => m.name),
    defaultOwner: t.owners?.default ?? "",
    goNoGo: t.goNoGo ?? DEFAULT_GO_NO_GO,
  };
}

const routes = [
  ["GET", /^\/api\/meta$/, async () => ({ tenants: tenantIds().map(tenantSummary), ...sharedMeta({ includePrivate: true }) })],

  // Industry → Geography → Capability → Date range. Live sweep, merged into the all-industries pipeline.
  ["POST", /^\/api\/search$/, async (req) => {
    const b = await json(req);
    const industries = b.industry ? [b.industry] : loadTenant(GENERAL_ID).industries;
    const log = [];
    const res = await withLedger(GENERAL_ID, async (l) => {
      const ids = new Set(); let low = 0, gaps = 0;
      for (const ind of industries) {
        const run = await runSweep(GENERAL_ID, ind, { width: Number(b.width ?? 2), capabilities: b.capability ? [b.capability] : [], geography: b.geography || null, sinceDays: b.days ? Number(b.days) : null, matrix: loadData("config/capability-matrix.json") ?? undefined, profileTerms: b.profileTerms ?? null, docsRead: Object.fromEntries(l.findings.filter((f) => f.rfp?.readAt).map((f) => [f.id, f.rfp.readAt])), log: (m) => log.push(m), source: "dashboard" });
        mergeRun(l, run);
        writeTexts(ROOT, run.texts);
        writeStore(ROOT, "postings.json", mergePostings(readStore(ROOT, "postings.json"), run.raw));
        for (const f of run.findings) ids.add(f.id);
        low += run.lowFit ?? 0; gaps += run.gaps.length;
      }
      const found = l.findings.filter((f) => ids.has(f.id));
      return { ids: [...ids], found: found.length, high: found.filter((f) => f.band === "pursue").length, review: found.filter((f) => f.band === "review").length, low, gaps };
    });
    await writeWorkbook(loadLedger(ROOT, GENERAL_ID), loadTenant(GENERAL_ID), outputFile(GENERAL_ID));
    return { ...res, log };
  }],

  // ---- company profile: understand the business from its website (or pasted text)
  ["GET", /^\/api\/profile$/, async () => readStore(ROOT, "profile.json", {})],
  ["PUT", /^\/api\/profile$/, async (req) => {
    const p = await json(req);
    if (!p || !p.name) throw Object.assign(new Error("A profile needs a name."), { status: 400 });
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
      const home = await readPublicPage(url).catch((e) => ({ error: e.message }));
      if (home.error) throw Object.assign(new Error(`Could not read ${url}: ${home.error}`), { status: /^Blocked:/.test(home.error) ? 400 : 422 });
      const pages = [pageFacts(home.html, url)];
      const more = profileLinks(url, pages[0], 6);
      for (const u of more) {
        const r = await readPublicPage(u).catch((e) => ({ error: e.message }));
        if (!r.error && r.html) pages.push(pageFacts(r.html, u));
      }
      profile = buildProfile({ website: url, pages });
    } else if (b.text && String(b.text).trim().length > 80) {
      profile = buildProfile({ website: b.website || null, pages: [textFacts(b.text, b.name || "")], source: "pasted text" });
    } else throw Object.assign(new Error("Give a website address, or paste at least a paragraph about the company."), { status: 400 });
    writeStore(ROOT, "profile.json", profile);
    return profile;
  }],
  ["GET", /^\/api\/postings$/, async () => readStore(ROOT, "postings.json", { postings: [] })],

  // ---- configuration: who can open the private host, and the sales-platform link (both local files, never published)
  ["GET", /^\/api\/access$/, async () => ({ roles: ACCESS_ROLES, users: readStore(ROOT, "access.json", { users: [] }).users ?? [] })],
  ["PUT", /^\/api\/access$/, async (req) => {
    const b = await json(req);
    const { users, errors } = validateAccess(b.users);
    if (errors.length) throw Object.assign(new Error(errors.join(" ")), { status: 400 });
    writeStore(ROOT, "access.json", { users, updatedAt: new Date().toISOString() });
    return { roles: ACCESS_ROLES, users };
  }],
  ["GET", /^\/api\/crm$/, async () => ({ platforms: CRM_PLATFORMS, platform: "salesforce", links: {}, ...readStore(ROOT, "crm.json", {}) })],
  ["PUT", /^\/api\/crm$/, async (req) => {
    const b = await json(req);
    if (!CRM_PLATFORMS.includes(b.platform)) throw Object.assign(new Error(`Choose one of: ${CRM_PLATFORMS.join(", ")}`), { status: 400 });
    const cur = readStore(ROOT, "crm.json", { links: {} });
    writeStore(ROOT, "crm.json", { ...cur, platform: b.platform });
    return { ...cur, platform: b.platform };
  }],
  ["PUT", /^\/api\/crm\/links\/([\w-]+)$/, async (req, u, [id]) => {
    const b = await json(req);
    const err = validCrmLink(b);
    if (err) throw Object.assign(new Error(err), { status: 400 });
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
    if (text == null) throw Object.assign(new Error("No solicitation documents were read for this finding."), { status: 404 });
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
    if (!b.title || !b.text) throw Object.assign(new Error("title and text are required"), { status: 400 });
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
      if (f.draftEdited) throw Object.assign(new Error("This draft has been edited by a person; it will not be regenerated over their work."), { status: 409 });
      const pack = effectivePack(loadPack(f.industry), tenant);
      const library = matchLibrary(loadData(`library/${tid}.json`)?.entries ?? [], `${f.title} ${(f.requirements ?? []).map((r) => r.text).join(" ")}`, f.industry);
      f.draft = { ...(f.draft ?? {}), response: draftResponse(f, pack, tenant, library) };
      f.libraryMatches = library.map((l) => ({ id: l.id, stale: l.stale }));
      return f;
    });
  }],

  ["POST", /^\/api\/sweep$/, async (req, u) => {
    const body = await json(req);
    const tid = tenantParam(u);
    const tenant = loadTenant(tid);
    const industries = body.industry ? [body.industry] : tenant.industries;
    const log = [];
    const summary = await withLedger(tid, async (l) => {
      const out = [];
      for (const ind of industries) {
        const run = await runSweep(tid, ind, { width: Number(body.width ?? 2), direct: !!body.direct, log: (m) => log.push(m), source: "dashboard" });
        out.push({ industry: ind, ...mergeRun(l, run), halted: run.halted, haltReason: run.haltReason, gaps: run.gaps.length, caveat: run.caveat });
        writeTexts(ROOT, run.texts);
      }
      return out;
    });
    await writeWorkbook(loadLedger(ROOT, tid), tenant, outputFile(tid));
    return { summary, log };
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
    if (buf.subarray(0, 2).toString() !== "PK") throw Object.assign(new Error("That is not an .xlsx file."), { status: 400 });
    const result = await withLedger(tid, (l) => importWorkbook(l, buf, { by: actor(req) ? `${actor(req)} (excel)` : "excel" }));
    await writeWorkbook(loadLedger(ROOT, tid), loadTenant(tid), outputFile(tid));
    return result;
  }],

  // A findings file produced by the n8n workflow (its "findings.json" output), uploaded by a person.
  ["POST", /^\/api\/import-run$/, async (req, u) => {
    const tid = tenantParam(u);
    const run = JSON.parse((await readBody(req, 10 * 1024 * 1024)).toString("utf8"));
    if (run.tenant !== tid) throw Object.assign(new Error(`That run file is for "${run.tenant}", not "${tid}".`), { status: 400 });
    if (!Array.isArray(run.findings)) throw Object.assign(new Error("Not a sweeper run file: no findings array."), { status: 400 });
    for (const f of run.findings) f.url = safeLink(f.url);
    const r = await withLedger(tid, (l) => mergeRun(l, { ...run, source: "n8n", gaps: run.gaps ?? [] }));
    await writeWorkbook(loadLedger(ROOT, tid), loadTenant(tid), outputFile(tid));
    return r;
  }],
];

function tenantParam(u) {
  const id = u.searchParams.get("tenant") ?? "";
  if (!id) return GENERAL_ID;
  if (!tenantIds().includes(id)) throw Object.assign(new Error(`Unknown tenant "${id}"`), { status: 400 });
  return id;
}
const actor = (req) => String(req.headers["x-rfp-user"] ?? "").slice(0, 80).replace(/[^\p{L}\p{N} .'@_-]/gu, "") || null;

const server = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host ?? "");
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}$`).test(host)) return send(res, 421, { error: "Unexpected Host header" });
    const u = new URL(req.url, `http://${host}`);

    if (req.method === "GET" && u.pathname === "/rfp-bundle.js") return send(res, 200, Buffer.from(browserBundle()), { "content-type": TYPES[".js"] });
    const vend = u.pathname.match(/^\/vendor\/([\w.-]+)$/);
    if (req.method === "GET" && vend && VENDOR[vend[1]]) return send(res, 200, fs.readFileSync(path.join(ROOT, VENDOR[vend[1]])), { "content-type": TYPES[path.extname(vend[1])] ?? "text/javascript", "cache-control": "max-age=86400" });
    if (req.method === "GET" && STATIC[u.pathname]) {
      const file = path.join(ROOT, "dashboard", STATIC[u.pathname]);
      return send(res, 200, fs.readFileSync(file), { "content-type": TYPES[path.extname(file)] });
    }

    if (req.method !== "GET" && req.headers["x-rfp-dashboard"] !== "1") return send(res, 403, { error: "Missing X-RFP-Dashboard header" });

    for (const [method, re, fn] of routes) {
      const m = req.method === method && u.pathname.match(re);
      if (!m) continue;
      const out = await fn(req, u, m.slice(1));
      if (out?.__file) return send(res, 200, out.__file, { "content-type": out.type, "content-disposition": `attachment; filename="${out.name}"` });
      return send(res, 200, out);
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    const status = e.status ?? (e.code === "CONFLICT" ? 409 : e.code === "NOT_FOUND" ? 404 : e instanceof SyntaxError ? 400 : 500);
    if (status === 500) console.error(e);
    send(res, status, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RFP findings dashboard: http://${HOST}:${PORT}`);
  console.log(`Tenants: ${tenantIds().join(", ")}. Local only; nothing is sent to Jira, Confluence or any other internal tool.`);
});
