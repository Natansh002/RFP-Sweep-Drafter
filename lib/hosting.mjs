/**
 * The internal host: the whole dashboard on your company's Azure App Service, behind
 * Microsoft Entra sign-in (App Service authentication), shared by the team.
 * docs/internal-hosting.md has the set-up.
 *
 *   RFP_MODE=internal   every request needs a signed-in company account on the access
 *                       list; admins manage the list and the sweep schedule on the
 *                       Configuration page; data lives in RFP_DATA_DIR
 *
 * Without it the dashboard is the local, one-person copy on 127.0.0.1.
 *
 * Sign-in itself is done by App Service, in front of this server: it strips any
 * X-MS-CLIENT-PRINCIPAL header a browser sends and adds its own. So those headers are
 * believed only when App Service says authentication is on (WEBSITE_AUTH_ENABLED), or
 * when an operator says an equivalent proxy is in front (RFP_AUTH_HEADERS=trust).
 * Otherwise everyone is refused: a host set up without sign-in fails closed.
 */
import fs from "node:fs";
import path from "node:path";
import { EMAIL } from "./access.mjs";

export const MODES = ["local", "internal"];

export function hostMode(env = process.env) {
  const m = String(env.RFP_MODE ?? "local").trim().toLowerCase() || "local";
  if (!MODES.includes(m)) throw new Error(`RFP_MODE must be "local" or "internal", not "${env.RFP_MODE}".`);
  return m;
}

// ------------------------------------------------------------------ data folder
/**
 * RFP_DATA_DIR holds everything the host keeps: findings, users, settings, the response
 * library. It sets the store, library and output folders unless those are set one by one.
 */
export function applyDataDir(env = process.env, root) {
  const dir = env.RFP_DATA_DIR ? path.resolve(env.RFP_DATA_DIR) : null;
  if (dir) {
    env.RFP_STORE_DIR ||= path.join(dir, "store");
    env.RFP_LIBRARY_DIR ||= path.join(dir, "library");
    env.RFP_OUTPUT_DIR ||= path.join(dir, "output");
  }
  const store = env.RFP_STORE_DIR ? path.resolve(env.RFP_STORE_DIR) : path.join(root, "store");
  const library = env.RFP_LIBRARY_DIR ? path.resolve(env.RFP_LIBRARY_DIR) : path.join(root, "library", "private");
  return { dir: dir ?? store, store, library };
}

const inside = (root, p) => { const r = path.relative(root, p); return !r.startsWith("..") && !path.isAbsolute(r); };

/** Whether the data folder can be written, and whether it survives restarts and redeploys. */
export function dataStatus({ dir, store, library }, root, env = process.env, { probe = true } = {}) {
  let writable = probe ? true : null;
  if (probe) for (const d of [store, library]) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const t = path.join(d, `.write-test-${process.pid}`);
      fs.writeFileSync(t, "ok");
      fs.rmSync(t, { force: true });
    } catch { writable = false; }
  }
  const appService = !!env.WEBSITE_SITE_NAME;
  // A custom container keeps /home only with WEBSITES_ENABLE_APP_SERVICE_STORAGE=true.
  const containerStorageOff = appService && env.RFP_CONTAINER === "1" && !/^true$/i.test(env.WEBSITES_ENABLE_APP_SERVICE_STORAGE ?? "");
  let persistent = true, note = "Outside the app folder.";
  if (inside(root, store)) { persistent = false; note = "Inside the app folder, so a redeploy can erase it. Set RFP_DATA_DIR to a folder outside the app (on App Service: /home/data/rfp-sweep)."; }
  else if (appService && !store.startsWith("/home/")) { persistent = false; note = "Not under /home, so App Service does not keep it. Set RFP_DATA_DIR=/home/data/rfp-sweep."; }
  else if (containerStorageOff) { persistent = false; note = "Set WEBSITES_ENABLE_APP_SERVICE_STORAGE=true, or /home is emptied when the container restarts."; }
  else if (appService) note = "App Service storage under /home: kept across restarts and deploys.";
  return { dir, writable, persistent, note };
}

// ------------------------------------------------------------------ who is signed in
export function signInStatus(env = process.env) {
  if (/^true$/i.test(String(env.WEBSITE_AUTH_ENABLED ?? ""))) return { on: true, how: "App Service authentication (Microsoft Entra)" };
  if (String(env.RFP_AUTH_HEADERS ?? "").toLowerCase() === "trust") return { on: true, how: "a sign-in proxy in front of this app (RFP_AUTH_HEADERS=trust)" };
  return { on: false, how: null };
}

const CLAIM = {
  email: ["preferred_username", "email", "emails", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "upn", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn"],
  tenant: ["http://schemas.microsoft.com/identity/claims/tenantid", "tid"],
  oid: ["http://schemas.microsoft.com/identity/claims/objectidentifier", "oid"],
};

/**
 * The signed-in account from App Service's headers: { email, idp, tenantId } or null.
 * A malformed principal counts as not signed in.
 */
export function readPrincipal(headers = {}) {
  const raw = headers["x-ms-client-principal"];
  let claims = [], idp = String(headers["x-ms-client-principal-idp"] ?? "").trim().toLowerCase() || null;
  if (raw) {
    try {
      const p = JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
      claims = Array.isArray(p?.claims) ? p.claims : [];
      idp ||= p?.auth_typ ? String(p.auth_typ).toLowerCase() : null;
    } catch { return null; }
  }
  const claim = (types) => { for (const t of types) { const c = claims.find((x) => x?.typ === t && x.val); if (c) return String(c.val).trim(); } return null; };
  const email = String(claim(CLAIM.email) ?? headers["x-ms-client-principal-name"] ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) return null;
  return { email, idp, tenantId: claim(CLAIM.tenant)?.toLowerCase() ?? null, objectId: claim(CLAIM.oid) };
}

/** Why a signed-in account may not use this host at all (wrong provider or tenant), or null. */
export function principalRefusal(p, env = process.env) {
  if (p.idp && p.idp !== "aad") return "Only company (Microsoft Entra) accounts can sign in here.";
  const tenant = String(env.RFP_TENANT_ID ?? "").trim().toLowerCase();
  if (tenant && p.tenantId !== tenant) return "This account is not from your company's Microsoft Entra tenant.";
  return null;
}

/** The first admins, set by operations as an app setting: they always get in and can change the configuration. */
export function adminEmails(env = process.env) {
  return [...new Set(String(env.RFP_ADMINS ?? "").split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => EMAIL.test(e)))];
}

// ------------------------------------------------------------------ the sweep schedule
export const SCHEDULE_DAYS = { weekdays: "Weekdays (Mon–Fri)", daily: "Every day", mwf: "Mon, Wed and Fri", mondays: "Mondays" };
const DAY_SETS = { weekdays: [1, 2, 3, 4, 5], daily: [0, 1, 2, 3, 4, 5, 6], mwf: [1, 3, 5], mondays: [1] };
export const TIME_ZONES = ["America/St_Johns", "America/Halifax", "America/Toronto", "America/Winnipeg", "America/Regina", "America/Edmonton", "America/Vancouver", "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "Europe/London", "UTC"];
/** A missed run (the host was restarting) still starts if it is less than this late. */
export const CATCH_UP_MS = 3 * 3600 * 1000;

export const validTimeZone = (tz) => { if (!tz || typeof tz !== "string") return false; try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

export function defaultSchedule(env = process.env) {
  return { enabled: true, days: "weekdays", time: "06:00", timeZone: validTimeZone(env.RFP_TIMEZONE) ? env.RFP_TIMEZONE : "America/Toronto", width: 2 };
}

/** Check a schedule change against the current one. Returns { schedule, errors }. */
export function validateSchedule(input = {}, current = defaultSchedule()) {
  const s = { ...current };
  if ("enabled" in input) s.enabled = input.enabled === true;
  if ("days" in input) s.days = String(input.days);
  if ("time" in input) s.time = String(input.time).trim();
  if ("timeZone" in input) s.timeZone = String(input.timeZone).trim();
  if ("width" in input) s.width = Number(input.width);
  const errors = [];
  if (!DAY_SETS[s.days]) errors.push(`Days must be one of: ${Object.keys(DAY_SETS).join(", ")}.`);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) errors.push("The time must be HH:MM on a 24-hour clock, for example 06:00.");
  if (!validTimeZone(s.timeZone)) errors.push(`"${s.timeZone}" is not a time zone. Use a name like America/Toronto.`);
  if (![1, 2, 3].includes(s.width)) errors.push("Width must be 1, 2 or 3.");
  return { schedule: { enabled: s.enabled, days: s.days, time: s.time, timeZone: s.timeZone, width: s.width }, errors };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function parts(date, timeZone) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23" });
  return Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
}

/** The date, time and weekday (0 = Sunday) a moment falls on in a time zone. */
export function zonedParts(date, timeZone) {
  const p = parts(date, timeZone);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: WEEKDAYS.indexOf(p.weekday) };
}

function offsetMs(date, timeZone) {
  const p = parts(date, timeZone);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The moment a wall-clock date and time happen in a time zone. */
export function zonedTime(date, time, timeZone) {
  const [y, m, d] = date.split("-").map(Number), [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = offsetMs(new Date(guess), timeZone);
  const second = offsetMs(new Date(guess - first), timeZone);
  return new Date(guess - second);
}

const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The next scheduled start after `now`, or null when the schedule is off. */
export function nextRun(schedule, now = new Date()) {
  if (!schedule?.enabled || !DAY_SETS[schedule.days]) return null;
  const today = zonedParts(now, schedule.timeZone);
  for (let i = 0; i < 8; i++) {
    if (!DAY_SETS[schedule.days].includes((today.weekday + i) % 7)) continue;
    const at = zonedTime(addDays(today.date, i), schedule.time, schedule.timeZone);
    if (at > now) return at;
  }
  return null;
}

/** Whether a scheduled sweep should start now: a scheduled day, past its time (by less than CATCH_UP_MS), not yet run that day. */
export function isDue(schedule, now = new Date(), lastRunDate = null) {
  if (!schedule?.enabled || !DAY_SETS[schedule.days]) return false;
  const p = zonedParts(now, schedule.timeZone);
  if (!DAY_SETS[schedule.days].includes(p.weekday) || lastRunDate === p.date) return false;
  const at = zonedTime(p.date, schedule.time, schedule.timeZone);
  return now >= at && now - at < CATCH_UP_MS;
}

export const describeSchedule = (s) => (s?.enabled ? `${SCHEDULE_DAYS[s.days] ?? s.days} at ${s.time} (${s.timeZone})` : "Off");

export const formatZoned = (date, timeZone) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);

// ------------------------------------------------------------------ what is running
/** The version and commit (no build date or time): RFP_COMMIT (set when the image is built), a COMMIT file, or .git. */
export function appVersion(root, env = process.env) {
  let version = "0.0.0";
  try { version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version; } catch { /* keep the default */ }
  let commit = String(env.RFP_COMMIT ?? "").trim();
  // The package for operations carries its commit in a COMMIT file.
  if (!commit) { try { commit = fs.readFileSync(path.join(root, "COMMIT"), "utf8").trim(); } catch { /* not a package */ } }
  if (!commit) {
    try {
      const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
      const ref = head.startsWith("ref: ") ? head.slice(5) : null;
      commit = ref ? (fs.existsSync(path.join(root, ".git", ref)) ? fs.readFileSync(path.join(root, ".git", ref), "utf8") : (fs.readFileSync(path.join(root, ".git", "packed-refs"), "utf8").split("\n").find((l) => l.endsWith(` ${ref}`)) ?? "").split(" ")[0]) : head;
    } catch { commit = ""; }
  }
  commit = /^[0-9a-f]{7,40}$/i.test(commit.trim()) ? commit.trim().slice(0, 7) : null;
  return { version, commit, text: commit ? `${version} (${commit})` : version };
}

/** The app settings this host reads, for the Configuration page. No secrets: the sign-in secret belongs to App Service, not to this app. */
export function hostSettings(env = process.env) {
  const v = (k) => (env[k] == null || env[k] === "" ? null : String(env[k]));
  return [
    { name: "RFP_MODE", value: v("RFP_MODE"), note: "internal: sign-in, the access list and the schedule are on" },
    { name: "RFP_ADMINS", value: adminEmails(env).length ? `${adminEmails(env).length} set` : null, note: "the first admins (work emails)" },
    { name: "RFP_TENANT_ID", value: v("RFP_TENANT_ID"), note: "only accounts from this Microsoft Entra tenant" },
    { name: "RFP_DATA_DIR", value: v("RFP_DATA_DIR"), note: "findings, users, settings and the library" },
    { name: "RFP_TIMEZONE", value: v("RFP_TIMEZONE"), note: "default time zone for the schedule" },
    { name: "RFP_DOCUMENTS_PER_RUN", value: v("RFP_DOCUMENTS_PER_RUN"), note: "solicitation documents read per industry, per sweep" },
    { name: "WEBSITE_AUTH_ENABLED", value: v("WEBSITE_AUTH_ENABLED"), note: "set by App Service when authentication is on" },
    { name: "WEBSITES_ENABLE_APP_SERVICE_STORAGE", value: v("WEBSITES_ENABLE_APP_SERVICE_STORAGE"), note: "true keeps /home for a container" },
    { name: "RFP_AUTH_HEADERS", value: v("RFP_AUTH_HEADERS"), note: "only for a sign-in proxy other than App Service" },
  ];
}

export default { MODES, hostMode, applyDataDir, dataStatus, signInStatus, readPrincipal, principalRefusal, adminEmails, SCHEDULE_DAYS, TIME_ZONES, CATCH_UP_MS, validTimeZone, defaultSchedule, validateSchedule, zonedParts, zonedTime, nextRun, isDue, describeSchedule, formatZoned, appVersion, hostSettings };
