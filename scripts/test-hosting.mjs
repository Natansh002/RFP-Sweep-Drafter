#!/usr/bin/env node
/**
 * Tests for the internal host: who gets in (App Service sign-in + the access list), what
 * admins alone may change, the sweep schedule, sweeps that outlast a request, backups,
 * the network guard, and that a host set up without sign-in refuses everyone.
 *
 * The server runs for real (scripts/dashboard.mjs, RFP_MODE=internal) on 127.0.0.1 with a
 * temporary data folder. App Service's sign-in headers are sent the way App Service sends
 * them; sweeps run dry (RFP_SWEEP_DRY), so no portal is contacted.
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import PizZip from "pizzip";
import { ROOT } from "../lib/config.mjs";
import { saveLedger, writeStore } from "../lib/ledger.mjs";
import * as H from "../lib/hosting.mjs";
import { ipBlocked, makeGuardedLookup, guardedLookup, guardedFetch } from "../lib/netguard.mjs";
import { findSecrets, SECRET_FILES } from "../lib/secrets.mjs";

let fails = 0, passes = 0;
const a = (name, cond) => { if (cond) passes++; else { fails++; console.log(`FAIL: ${name}`); } };

// ------------------------------------------------------------------ mode and data folder
a("mode: local unless RFP_MODE=internal", H.hostMode({}) === "local" && H.hostMode({ RFP_MODE: " Internal " }) === "internal");
a("mode: anything else is refused", (() => { try { H.hostMode({ RFP_MODE: "public" }); return false; } catch (e) { return /local.*internal/.test(e.message); } })());
{
  const env = { RFP_DATA_DIR: "/srv/rfp" };
  const d = H.applyDataDir(env, ROOT);
  a("data: RFP_DATA_DIR holds the store, library and output", d.store === "/srv/rfp/store" && d.library === "/srv/rfp/library" && env.RFP_OUTPUT_DIR === "/srv/rfp/output" && d.dir === "/srv/rfp");
  const env2 = { RFP_DATA_DIR: "/srv/rfp", RFP_STORE_DIR: "/elsewhere" };
  a("data: a folder set on its own wins", H.applyDataDir(env2, ROOT).store === "/elsewhere");
  const st = (store, env) => H.dataStatus({ dir: store, store, library: store }, ROOT, env, { probe: false });
  a("data: inside the app folder is not kept across deploys", st(path.join(ROOT, "store"), {}).persistent === false);
  a("data: on App Service it must be under /home", st("/srv/rfp/store", { WEBSITE_SITE_NAME: "x" }).persistent === false && st("/home/data/rfp/store", { WEBSITE_SITE_NAME: "x" }).persistent === true);
  a("data: a container needs App Service storage switched on", st("/home/data/rfp/store", { WEBSITE_SITE_NAME: "x", RFP_CONTAINER: "1" }).persistent === false && st("/home/data/rfp/store", { WEBSITE_SITE_NAME: "x", RFP_CONTAINER: "1", WEBSITES_ENABLE_APP_SERVICE_STORAGE: "true" }).persistent === true);
}

// ------------------------------------------------------------------ sign-in
a("sign-in: on when App Service says so", H.signInStatus({ WEBSITE_AUTH_ENABLED: "True" }).on && !H.signInStatus({ WEBSITE_AUTH_ENABLED: "False" }).on && !H.signInStatus({}).on);
a("sign-in: or when an operator says a proxy signs people in", H.signInStatus({ RFP_AUTH_HEADERS: "trust" }).on && !H.signInStatus({ RFP_AUTH_HEADERS: "yes" }).on);
const TENANT = "11111111-2222-3333-4444-555555555555";
const principal = (email, { tenant = TENANT, idp = "aad", claimType = "preferred_username" } = {}) =>
  Buffer.from(JSON.stringify({ auth_typ: idp, claims: [{ typ: claimType, val: email }, { typ: "name", val: "Someone" }, { typ: "http://schemas.microsoft.com/identity/claims/tenantid", val: tenant }] })).toString("base64");
{
  const p = H.readPrincipal({ "x-ms-client-principal": principal("Ana.Lee@Example.org"), "x-ms-client-principal-idp": "aad" });
  a("principal: email (lower case), provider and tenant from App Service's header", p.email === "ana.lee@example.org" && p.idp === "aad" && p.tenantId === TENANT);
  a("principal: the email claim works too", H.readPrincipal({ "x-ms-client-principal": principal("sam@example.org", { claimType: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" }) }).email === "sam@example.org");
  a("principal: missing or malformed is not signed in", H.readPrincipal({}) === null && H.readPrincipal({ "x-ms-client-principal": "%%%not-base64" }) === null && H.readPrincipal({ "x-ms-client-principal": Buffer.from("{").toString("base64") }) === null);
  a("principal: a name that is not an email is not signed in", H.readPrincipal({ "x-ms-client-principal-name": "Ana Lee" }) === null);
  a("principal: another provider is refused", /Microsoft Entra/.test(H.principalRefusal({ email: "a@x.org", idp: "github" }, {}) ?? ""));
  a("principal: another tenant is refused when RFP_TENANT_ID is set", /tenant/.test(H.principalRefusal({ email: "a@x.org", idp: "aad", tenantId: "other" }, { RFP_TENANT_ID: TENANT }) ?? "") && H.principalRefusal({ email: "a@x.org", idp: "aad", tenantId: TENANT }, { RFP_TENANT_ID: TENANT.toUpperCase() }) === null);
  a("admins: RFP_ADMINS parsed, lower-cased, junk dropped", H.adminEmails({ RFP_ADMINS: "a@x.org, B@X.org;not-an-email  a@x.org" }).join() === "a@x.org,b@x.org");
}

// ------------------------------------------------------------------ the schedule
{
  const base = H.defaultSchedule({});
  a("schedule: weekdays at 06:00 Toronto by default; RFP_TIMEZONE changes the zone", base.days === "weekdays" && base.time === "06:00" && base.timeZone === "America/Toronto" && H.defaultSchedule({ RFP_TIMEZONE: "America/Vancouver" }).timeZone === "America/Vancouver" && H.defaultSchedule({ RFP_TIMEZONE: "Mars/Olympus" }).timeZone === "America/Toronto");
  const bad = H.validateSchedule({ time: "6am", timeZone: "Mars/Olympus", days: "sometimes", width: 5 }, base);
  a("schedule: bad time, zone, days and width each reported", bad.errors.length === 4);
  const good = H.validateSchedule({ enabled: false, time: "07:30", days: "daily", timeZone: "America/Vancouver", width: "1" }, base);
  a("schedule: a good change is kept", good.errors.length === 0 && JSON.stringify(good.schedule) === JSON.stringify({ enabled: false, days: "daily", time: "07:30", timeZone: "America/Vancouver", width: 1 }));
  const s = { ...base, enabled: true };
  a("schedule: Sunday noon → Monday 06:00 Toronto (10:00 UTC)", H.nextRun(s, new Date("2026-09-27T16:00:00Z"))?.toISOString() === "2026-09-28T10:00:00.000Z");
  a("schedule: Friday after the run → next Monday", H.nextRun(s, new Date("2026-10-02T11:00:00Z"))?.toISOString() === "2026-10-05T10:00:00.000Z");
  a("schedule: daylight saving ends → 06:00 is 11:00 UTC", H.nextRun({ ...s, days: "daily" }, new Date("2026-11-01T12:00:00Z"))?.toISOString() === "2026-11-02T11:00:00.000Z");
  a("schedule: off → no next run", H.nextRun({ ...s, enabled: false }) === null);
  const mon6 = new Date("2026-09-28T10:00:30Z");
  a("schedule: due at its time on a scheduled day", H.isDue(s, mon6, null) === true);
  a("schedule: not twice the same day", H.isDue(s, mon6, "2026-09-28") === false);
  a("schedule: not before its time", H.isDue(s, new Date("2026-09-28T09:59:00Z"), null) === false);
  a("schedule: a missed run starts late, but not hours late", H.isDue(s, new Date("2026-09-28T12:30:00Z"), null) === true && H.isDue(s, new Date("2026-09-28T13:30:00Z"), null) === false);
  a("schedule: not on a Saturday for weekdays", H.isDue(s, new Date("2026-10-03T10:30:00Z"), null) === false);
  a("schedule: described in words", H.describeSchedule(s) === "Weekdays (Mon–Fri) at 06:00 (America/Toronto)" && H.describeSchedule({ ...s, enabled: false }) === "Off");
  a("schedule: local time in the zone", /06:00/.test(H.formatZoned(new Date("2026-09-28T10:00:00Z"), "America/Toronto")));
}
{
  const v = H.appVersion(ROOT, { RFP_COMMIT: "abcdef1234567890" });
  a("version: package version and short commit, no build date or time", v.commit === "abcdef1" && v.text === `${JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version} (abcdef1)`);
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "rfp-pkg-"));
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "9.8.7" }));
  fs.writeFileSync(path.join(pkg, "COMMIT"), "0123456789abcdef0123456789abcdef01234567\n");
  a("version: a package's COMMIT file names the commit", H.appVersion(pkg, {}).text === "9.8.7 (0123456)");
  fs.rmSync(pkg, { recursive: true, force: true });
  a("settings: listed without secrets", H.hostSettings({ RFP_ADMINS: "a@x.org,b@x.org" }).find((x) => x.name === "RFP_ADMINS").value === "2 set" && !H.hostSettings({}).some((x) => /SECRET/.test(x.name)));
}

// ------------------------------------------------------------------ the network guard
a("netguard: private, loopback, link-local, metadata and mapped addresses blocked", ["127.0.0.1", "10.2.3.4", "172.16.9.9", "192.168.0.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "224.0.0.251"].every(ipBlocked));
a("netguard: public addresses allowed", ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"].every((x) => !ipBlocked(x)));
await new Promise((res) => guardedLookup("localhost", {}, (e) => { a("netguard: a name that resolves to loopback is refused", e?.code === "EBLOCKED"); res(); }));
await new Promise((res) => makeGuardedLookup((h, o, cb) => cb(null, [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.5", family: 4 }]))("mixed.example", {}, (e) => { a("netguard: a name with any private answer is refused", e?.code === "EBLOCKED"); res(); }));
await new Promise((res) => makeGuardedLookup((h, o, cb) => cb(null, [{ address: "93.184.215.14", family: 4 }]))("public.example", {}, (e, addr) => { a("netguard: a public answer passes", !e && addr === "93.184.215.14"); res(); }));
{
  const local = http.createServer((q, s) => s.end("secret")).listen(0, "127.0.0.1");
  await new Promise((r) => local.once("listening", r));
  const port = local.address().port;
  for (const u of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`]) {
    let blocked = false;
    try { await guardedFetch(u); } catch (e) { blocked = /Blocked/.test(e.cause?.message ?? e.message); }
    a(`netguard: fetch refuses ${new URL(u).hostname}`, blocked);
  }
  local.close();
}

// ------------------------------------------------------------------ the secret check
{
  // Built at runtime, so this file never holds anything that looks like a real secret.
  const fakes = { "GitHub token": "gh" + "p_" + "A1b2C3d4".repeat(5), "AWS access key": "AK" + "IA" + "ABCDEFGHIJKLMNOP", "Private key": "-----BEGIN " + "OPENSSH PRIVATE KEY-----",
    "Microsoft Entra client secret": "Abc" + "8Q~" + "x".repeat(32), "Azure storage key or connection string": "Account" + "Key=" + "a".repeat(86) + "==", "Azure publish profile password": "userPWD=\"" + "p".repeat(40) + "\"" };
  for (const [kind, v] of Object.entries(fakes)) a(`secrets: finds a ${kind}`, findSecrets("notes.txt", `line one\nconfig: ${v}`).some((h) => h.kind === kind && h.line === 2));
  a("secrets: lockfile hashes and ordinary text are not secrets", findSecrets("package-lock.json", '"integrity": "sha512-Abc8Q~short", "resolved": "https://registry.npmjs.org/x"').length === 0);
  a("secrets: key, certificate, publish-profile and .env files are refused by name", [".env", "config/.env.production", "certs/site.pem", "deploy.PublishSettings", "id_ed25519", "web.pfx"].every((f) => SECRET_FILES.test(f)));
  a("secrets: examples and ordinary files are fine", ![".env.example", "lib/key.mjs", "docs/env.md", "keys.json"].some((f) => findSecrets(f, "").length));
}

// ------------------------------------------------------------------ the server
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
async function startHost(env, seed = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfp-host-"));
  process.env.RFP_STORE_DIR = path.join(dir, "store");
  seed(dir);
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, "scripts", "dashboard.mjs")], {
    env: { ...process.env, RFP_STORE_DIR: "", RFP_LIBRARY_DIR: "", RFP_OUTPUT_DIR: "", RFP_MODE: "internal", RFP_DATA_DIR: dir, RFP_BIND: "127.0.0.1", PORT: String(port), RFP_SWEEP_DRY: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += d)); proc.stderr.on("data", (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  const call = async (method, p, { as = null, body, headers = {} } = {}) => {
    const h = { ...(as ? { "x-ms-client-principal": as.includes("@") ? principal(as) : as, "x-ms-client-principal-idp": "aad" } : {}), ...(method !== "GET" ? { "x-rfp-dashboard": "1" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers };
    const r = await fetch(`${base}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, headers: r.headers, body: type.includes("json") ? await r.json() : type.includes("zip") ? Buffer.from(await r.arrayBuffer()) : await r.text() };
  };
  return { dir, base, call, out: () => out, stop: () => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const until = async (fn, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); } return null; };

const FINDING = { id: "all-host01", tenant: "all", industry: "any", title: "ERP and Payroll System", buyer: "Town of Example", closeDate: "2099-01-01", status: "New", score: 70, band: "pursue", rev: 0, actions: [], reasons: [], flags: [] };
const ADMIN = "admin@example.org", PRESALES = "presales@example.org";

const host = await startHost({ RFP_AUTH_HEADERS: "trust", RFP_ADMINS: ADMIN, RFP_TENANT_ID: TENANT, RFP_REQUEST_WAIT_MS: "300", RFP_SWEEP_DRY_MS: "1500", RFP_SCHEDULER_TICK_MS: "300" }, (dir) => {
  saveLedger(ROOT, { tenant: "all", findings: [FINDING], runs: [], gaps: [] });
  writeStore(ROOT, "settings.json", { schedule: { enabled: false, days: "weekdays", time: "06:00", timeZone: "America/Toronto", width: 2 } });
});
try {
  const { call } = host;
  let r = await call("GET", "/healthz");
  a("host: health check answers without sign-in, and says only that it is up", r.status === 200 && r.body.ok === true && r.body.mode === "internal" && r.body.signIn === true && Object.keys(r.body).sort().join() === "mode,ok,signIn,version");
  r = await call("GET", "/");
  a("host: not signed in → Microsoft sign-in, then back", r.status === 302 && r.headers.get("location") === "/.auth/login/aad?post_login_redirect_uri=%2F");
  r = await call("GET", "/api/ledger");
  a("host: not signed in → the API says 401, no data", r.status === 401 && !JSON.stringify(r.body).includes("ERP"));
  r = await call("GET", "/", { as: "stranger@example.org" });
  a("host: signed in but not listed → the no-access page, with a way to sign out", r.status === 403 && /not on the access list/.test(r.body) && /stranger@example\.org/.test(r.body) && /\.auth\/logout/.test(r.body) && !/ERP and Payroll/.test(r.body));
  r = await call("GET", "/api/ledger", { as: "stranger@example.org" });
  a("host: not listed → the API refuses too", r.status === 403 && !JSON.stringify(r.body).includes("ERP"));
  r = await call("GET", "/api/ledger", { as: principal(ADMIN, { tenant: "99999999-0000-0000-0000-000000000000" }) });
  a("host: an admin's email from another tenant is refused", r.status === 403 && /tenant/.test(r.body.error));
  r = await call("GET", "/api/ledger", { as: principal(ADMIN, { idp: "github" }), headers: { "x-ms-client-principal-idp": "github" } });
  a("host: another sign-in provider is refused", r.status === 403);
  r = await call("GET", "/style.css");
  a("host: the stylesheet loads for the no-access page", r.status === 200);
  a("host: every answer carries the security headers", ["content-security-policy", "x-content-type-options", "referrer-policy", "x-frame-options", "cross-origin-opener-policy", "cross-origin-resource-policy", "permissions-policy", "strict-transport-security"].every((h) => r.headers.get(h)) && r.headers.get("x-frame-options") === "DENY");

  r = await call("GET", "/api/host", { as: ADMIN });
  a("host: RFP_ADMINS get in as admin RFP Managers", r.status === 200 && r.body.user.email === ADMIN && r.body.user.role === "RFP Manager" && r.body.user.admin === true && r.body.canConfigure === true);
  a("host: the status page's checks", ["signin", "tenant", "admins", "data", "schedule", "lastrun", "browser"].every((id) => r.body.checks.some((c) => c.id === id)) && r.body.checks.find((c) => c.id === "signin").ok && r.body.checks.find((c) => c.id === "schedule").warn);
  a("host: admins see the settings the host reads", r.body.settings.some((s) => s.name === "RFP_TENANT_ID" && s.value === TENANT));
  r = await call("GET", "/", { as: ADMIN });
  a("host: the dashboard page knows it is on the internal host", r.status === 200 && /<meta name="rfp-mode" content="internal">/.test(r.body) && r.headers.get("strict-transport-security"));

  r = await call("PUT", "/api/access", { as: ADMIN, body: { users: [{ email: PRESALES, role: "Pre-sales Consultant" }] }, headers: { "x-rfp-dashboard": "" } });
  a("host: a write without the dashboard header is refused", r.status === 403);
  r = await call("PUT", "/api/access", { as: ADMIN, body: { users: [{ email: PRESALES, role: "Pre-sales Consultant" }] } });
  a("host: an admin adds a person with a role", r.status === 200 && r.body.users.length === 1 && r.body.changes.join() === "added presales@example.org (Pre-sales Consultant)");
  r = await call("PUT", "/api/access", { as: ADMIN, body: { users: [{ email: "nope", role: "Pre-sales Consultant" }] } });
  a("host: a bad email is refused, the list unchanged", r.status === 400 && /not an email/.test(r.body.error));
  r = await call("GET", "/api/host", { as: PRESALES });
  a("host: the new person gets in at once, with their role, not as admin", r.status === 200 && r.body.user.role === "Pre-sales Consultant" && r.body.user.admin === false && r.body.canConfigure === false && r.body.settings.length === 0);
  r = await call("GET", "/api/access", { as: PRESALES });
  a("host: a non-admin sees their own access, not the list", r.status === 200 && r.body.users.length === 0 && r.body.count === 1 && r.body.you.role === "Pre-sales Consultant" && r.body.canEdit === false);
  for (const [m, p, body] of [["PUT", "/api/access", { users: [{ email: PRESALES, role: "RFP Manager", admin: true }] }], ["PUT", "/api/settings/schedule", { enabled: true }], ["POST", "/api/settings/run-now", {}], ["PUT", "/api/crm", { platform: "hubspot" }], ["GET", "/api/audit"], ["GET", "/api/backup.zip"]]) {
    r = await call(m, p, { as: PRESALES, body: m === "GET" ? undefined : body });
    a(`host: only admins may ${m} ${p}`, r.status === 403 && /Only an admin/.test(r.body.error));
  }
  r = await call("PATCH", "/api/findings/all-host01", { as: PRESALES, body: { status: "Qualifying", rev: 0 }, headers: { "x-rfp-user": "Mallory Names" } });
  a("host: everyone listed works on the shared pipeline; changes carry the role, never a name", r.status === 200 && r.body.status === "Qualifying" && r.body.updatedBy === "Pre-sales Consultant");
  r = await call("GET", "/api/ledger", { as: ADMIN });
  a("host: the change is shared: the admin sees it", r.body.findings[0].status === "Qualifying");
  r = await call("PATCH", "/api/findings/all-host01", { as: PRESALES, body: { status: "Pursuing", rev: 1 }, headers: { "sec-fetch-site": "cross-site" } });
  a("host: a cross-site write is refused", r.status === 403);

  r = await call("PUT", "/api/settings/schedule", { as: ADMIN, body: { enabled: true, time: "25:00" } });
  a("host: a bad schedule is refused with the reason", r.status === 400 && /HH:MM/.test(r.body.error));
  // Twelve hours from now, so the scheduler cannot start a sweep in the middle of these checks.
  const later = (() => { const t = H.zonedParts(new Date(Date.now() + 12 * 3600 * 1000), "America/Vancouver").time; return t; })();
  r = await call("PUT", "/api/settings/schedule", { as: ADMIN, body: { enabled: true, days: "daily", time: later, timeZone: "America/Vancouver", width: 1 } });
  a("host: an admin sets the schedule; the next run is shown", r.status === 200 && r.body.text === `Every day at ${later} (America/Vancouver)` && r.body.nextText.includes(later));
  r = await call("PUT", "/api/access", { as: ADMIN, body: { users: [] } });
  a("host: with RFP_ADMINS set, the list may be emptied (the admins keep access)", r.status === 200 && r.body.changes.join() === "removed presales@example.org");
  r = await call("GET", "/api/host", { as: PRESALES });
  a("host: a removed person is refused at once", r.status === 403);

  // A sweep longer than the request: 202, then the result from /api/jobs/<id>; one sweep at a time.
  r = await call("POST", "/api/search", { as: ADMIN, body: {} });
  a("host: a long sweep answers 202 with a job to follow", r.status === 202 && r.body.job?.status === "running");
  const job = r.body.job;
  r = await call("POST", "/api/search", { as: ADMIN, body: {} });
  a("host: a second sweep meanwhile is refused (one at a time)", r.status === 409 && /already running/.test(r.body.error) && r.body.job?.id === job.id);
  r = await call("GET", "/api/jobs/current", { as: ADMIN });
  a("host: the running sweep can be looked up", r.body.job?.id === job.id);
  const done = await until(async () => { const x = await call("GET", `/api/jobs/${job.id}`, { as: ADMIN }); return x.body.status === "done" ? x.body : null; });
  a("host: the job finishes with its result", !!done && done.result?.log?.[0] === "dry run: no portals read");
  r = await call("POST", "/api/settings/run-now", { as: ADMIN });
  a("host: an admin starts a sweep now", r.status === 200 && r.body.job?.status === "running");
  const ran = await until(async () => { const x = await call("GET", "/api/settings", { as: ADMIN }); return x.body.runs?.[0]?.trigger === "admin" ? x.body : null; });
  a("host: the run is recorded for the Configuration page", !!ran && ran.runs[0].found === 0 && ran.runs[0].gaps === 0);

  // The schedule starts a sweep by itself, once.
  const nowParts = H.zonedParts(new Date(), "America/Toronto");
  r = await call("PUT", "/api/settings/schedule", { as: ADMIN, body: { enabled: true, days: "daily", time: nowParts.time, timeZone: "America/Toronto", width: 2 } });
  const sched = await until(async () => { const x = await call("GET", "/api/settings", { as: ADMIN }); return x.body.runs?.[0]?.trigger === "schedule" ? x.body : null; }, 10000);
  a("host: the schedule starts the sweep at its time", !!sched);
  await new Promise((res) => setTimeout(res, 2500));
  r = await call("GET", "/api/settings", { as: ADMIN });
  a("host: and only once that day", r.body.runs.filter((x) => x.trigger === "schedule").length === 1);

  r = await call("GET", "/api/audit", { as: ADMIN });
  const said = r.body.entries.map((e) => `${e.by}: ${e.what}`).join("\n");
  a("host: the activity log says who changed what", /admin@example\.org: Access list: added presales@example\.org \(Pre-sales Consultant\)/.test(said) && said.includes(`Sweep schedule: Every day at ${later}`) && /Started a sweep/.test(said) && /removed presales@example\.org/.test(said));
  r = await call("GET", "/api/backup.zip", { as: ADMIN });
  const zip = r.status === 200 ? new PizZip(r.body) : null;
  a("host: an admin downloads a backup with users, settings and the pipeline", !!zip && !!zip.file("store/access.json") && !!zip.file("store/settings.json") && !!zip.file("store/all.json") && /attachment; filename="rfp-sweep-backup-\d{4}-\d{2}-\d{2}\.zip"/.test(r.headers.get("content-disposition")));
} finally {
  host.stop();
}

// A host whose sign-in is not switched on refuses everyone, even with sign-in headers (anyone can forge them there).
const open = await startHost({ RFP_ADMINS: ADMIN });
try {
  let r = await open.call("GET", "/");
  a("no sign-in: the page says sign-in is not switched on", r.status === 503 && /Company sign-in is not switched on/.test(r.body));
  r = await open.call("GET", "/api/ledger", { as: ADMIN });
  a("no sign-in: a forged admin header gets nothing", r.status === 503);
  r = await open.call("GET", "/healthz");
  a("no sign-in: the health check says so", r.status === 200 && r.body.signIn === false);
  a("no sign-in: the log says every request is refused", /OFF, so every request is refused/.test(open.out()));
} finally {
  open.stop();
}

// On App Service (WEBSITE_AUTH_ENABLED) without RFP_ADMINS: the list must keep an admin.
const appService = await startHost({ WEBSITE_AUTH_ENABLED: "True", WEBSITE_SITE_NAME: "rfp-test" }, () => writeStore(ROOT, "access.json", { users: [{ email: ADMIN, role: "RFP Manager", admin: true }] }));
try {
  let r = await appService.call("GET", "/api/host", { as: ADMIN });
  a("App Service: its sign-in is believed; the listed admin gets in", r.status === 200 && r.body.user.admin === true && r.body.signIn.how === "App Service authentication (Microsoft Entra)");
  a("App Service: a data folder outside /home is flagged", r.body.checks.find((c) => c.id === "data").ok === false && /\/home/.test(r.body.checks.find((c) => c.id === "data").label));
  r = await appService.call("PUT", "/api/access", { as: ADMIN, body: { users: [{ email: ADMIN, role: "RFP Manager", admin: false }] } });
  a("App Service: removing the last admin is refused", r.status === 400 && /at least one admin/.test(r.body.error));
} finally {
  appService.stop();
}

console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nall ${passes} internal-host assertions passed`);
process.exit(fails ? 1 : 0);
