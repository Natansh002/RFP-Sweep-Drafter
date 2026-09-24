#!/usr/bin/env node
/**
 * Config validator. Runs in CI on every push.
 *
 * It fails the build on anything that would make a live sweep behave wrongly:
 * a channel reference that does not resolve, a tenant with no product lines for
 * an industry, a scoring block that does not add to 100, a pack that qualifies
 * and disqualifies the same phrase — and on anything that would connect the
 * sweeper to an internal tool: a ticket-system block, a Jira/Confluence/CRM/M365
 * link anywhere in config or data, or such a node in a generated workflow.
 *
 * It warns on things that are survivable but rot: a channel nobody has opened in
 * six months, a pack still marked draft, a tenant locked to dry run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBlocked, blockedReason } from "../lib/guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");
const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    err(`${path.relative(ROOT, p)}: invalid JSON — ${e.message}`);
    return null;
  }
};
const listJson = (dir) =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .map((f) => ({ file: f, id: f.replace(/\.json$/, ""), full: path.join(ROOT, dir, f) }));

const DAY = 86400000;
const stale = (d, days) => !d || Date.now() - new Date(d).getTime() > days * DAY;

// ---------------------------------------------------------------- channels
const registry = readJson(path.join(ROOT, "channels/registry.json"));
const channelIds = new Set();
if (registry) {
  for (const c of registry.channels ?? []) {
    if (channelIds.has(c.id)) err(`channels/registry.json: duplicate channel id "${c.id}"`);
    channelIds.add(c.id);
    if (!/^https?:\/\//.test(c.url ?? "")) err(`channel "${c.id}": url is not http(s)`);
    if (stale(c.verified, 180)) warn(`channel "${c.id}": not verified since ${c.verified ?? "never"}. Open it and update verified.`);
  }
}

// ---------------------------------------------------------------- industries
const packs = new Map();
for (const { file, id, full } of listJson("industries")) {
  const p = readJson(full);
  if (!p) continue;
  packs.set(id, p);

  if (p.id !== id) err(`industries/${file}: id "${p.id}" does not match the filename`);
  if (!p.name) err(`industries/${file}: missing name`);

  const VALID = ["draft", "unvalidated", "proven", "retired"];
  if (!VALID.includes(p.status)) err(`industries/${file}: status "${p.status}" is not one of ${VALID.join(", ")}`);
  if (p.status === "draft") warn(`industries/${file}: still draft. It will not be swept by a scheduled run.`);
  if (p.status === "unvalidated") warn(`industries/${file}: unvalidated. Its yield is not comparable to a proven pack — say so in any report that mixes them.`);
  if (stale(p.lastReviewed, 180)) warn(`industries/${file}: not reviewed since ${p.lastReviewed || "never"}.`);

  // channel refs must resolve
  for (const ch of p.channels ?? []) {
    if (!channelIds.has(ch.ref)) err(`industries/${file}: channel ref "${ch.ref}" is not in channels/registry.json`);
  }
  if ((p.channels ?? []).length === 0) err(`industries/${file}: no channels`);

  // weights must total 100, or the score is not out of 100 and every threshold lies
  const w = p.scoring?.weights ?? {};
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  if (total !== 100) err(`industries/${file}: scoring weights total ${total}, must be 100`);

  const min = p.scoring?.minScoreToPursue;
  const floor = p.scoring?.autoNoBidBelow;
  if (typeof min !== "number" || typeof floor !== "number") err(`industries/${file}: minScoreToPursue and autoNoBidBelow must both be numbers`);
  else if (floor >= min) err(`industries/${file}: autoNoBidBelow (${floor}) must be below minScoreToPursue (${min})`);

  // a phrase that both qualifies and disqualifies makes the pack undecidable
  const q = [...(p.qualifiers?.titleKeywords ?? []), ...(p.qualifiers?.bodyKeywords ?? [])].map((s) => s.toLowerCase());
  const d = (p.disqualifiers ?? []).map((s) => s.toLowerCase());
  for (const term of q) {
    if (d.includes(term)) err(`industries/${file}: "${term}" is both a qualifier and a disqualifier`);
  }
  if (q.length === 0) err(`industries/${file}: no qualifiers`);
  if (d.length === 0) warn(`industries/${file}: no disqualifiers. Expect noise.`);

  if ((p.directSites?.seedFrom ?? null) && !fs.existsSync(path.join(ROOT, p.directSites.seedFrom))) {
    warn(`industries/${file}: directSites.seedFrom "${p.directSites.seedFrom}" does not exist yet. The portal channels will run; the direct sweep will not.`);
  }
  if ((p.openQuestions ?? []).length > 0) {
    warn(`industries/${file}: ${p.openQuestions.length} open question(s) recorded.`);
  }
  for (const k of ["productGuard", "routing", "owner", "installedBaseWatch"]) {
    if (k in p) err(`industries/${file}: "${k}" is company-specific. Packs are shared by every Ionic company; move it to the tenant's offerings.`);
  }
  if (p.scoring && "minScoreToTicket" in p.scoring) err(`industries/${file}: minScoreToTicket was renamed minScoreToPursue. Nothing is ticketed any more.`);
}

// ---------------------------------------------------------------- tenants
const FORBIDDEN_TENANT_KEYS = ["ticketSystem", "jira", "confluence", "confluencePage", "wiki", "taskSystem"];
for (const { file, id, full } of listJson("tenants")) {
  const t = readJson(full);
  if (!t) continue;

  if (t.id !== id) err(`tenants/${file}: id "${t.id}" does not match the filename`);
  if (id === "all") err(`tenants/${file}: "all" is reserved for the built-in all-industries mode`);
  if (!t.name) err(`tenants/${file}: missing name`);
  if ((t.industries ?? []).length === 0) err(`tenants/${file}: subscribes to no industries`);

  for (const k of FORBIDDEN_TENANT_KEYS) {
    if (k in t) err(`tenants/${file}: "${k}" is not allowed. Findings and action items are tracked in the dashboard and Excel only; nothing is filed in Jira or linked to Confluence.`);
  }
  if (t.tracking && t.tracking.mode !== "dashboard") err(`tenants/${file}: tracking.mode must be "dashboard".`);
  if (t.notify?.teams) err(`tenants/${file}: notify.teams is not allowed. The sweeper does not post to internal tools.`);

  for (const ind of t.industries ?? []) {
    const p = packs.get(ind);
    if (!p) {
      err(`tenants/${file}: subscribes to unknown industry "${ind}"`);
      continue;
    }
    if (p.status === "retired") err(`tenants/${file}: subscribes to retired pack "${ind}"`);
    if ((t.offerings?.[ind]?.productLines ?? []).length === 0) {
      err(`tenants/${file}: offerings.${ind}.productLines is empty. Say which of this company's products the "${ind}" sweep is for; the drafter and scoring are scoped by it.`);
    }
  }
  for (const k of Object.keys(t.offerings ?? {})) {
    if (!(t.industries ?? []).includes(k)) err(`tenants/${file}: offerings.${k} is for an industry the tenant does not subscribe to`);
  }
  for (const ch of [...(t.excludeChannels ?? []), ...Object.values(t.offerings ?? {}).flatMap((o) => o.excludeChannels ?? [])]) {
    if (!channelIds.has(ch)) err(`tenants/${file}: excludeChannels names "${ch}", which is not in channels/registry.json`);
  }

  const team = (t.team ?? []).filter((m) => (typeof m === "string" ? m : m?.name));
  if (team.length === 0) warn(`tenants/${file}: team is empty. The Assignee dropdown will offer no roles (free text still works).`);
  // Team entries are role titles. No personal data (names, emails) in config.
  for (const m of t.team ?? []) {
    const label = typeof m === "string" ? m : m?.name ?? "";
    if (typeof m === "object" && m?.email) err(`tenants/${file}: team entry "${label}" has an email. Team entries are role titles only; no personal data in config.`);
    if (/@/.test(label)) err(`tenants/${file}: team entry "${label}" looks like an email. Use a role title.`);
  }

  if (t.crm?.sweeperWrites === true) {
    err(`tenants/${file}: crm.sweeperWrites is true. The sweeper never writes a CRM record; that is a person's decision at go/no-go.`);
  }
  if (typeof t.safety?.maxNewPursuePerRun !== "number") {
    err(`tenants/${file}: safety.maxNewPursuePerRun is required. A keyword change that matches everything must fail loudly.`);
  }
  if ((t.notify?.email ?? []).length > 0) {
    warn(`tenants/${file}: ${t.notify.email.length} email recipient(s) configured, but the sweeper sends nothing. They are unused.`);
  }
  if (t.goNoGo) {
    const w = (t.goNoGo.criteria ?? []).reduce((a, c) => a + (c.weight ?? 0), 0);
    if (w !== 100) err(`tenants/${file}: goNoGo criteria weights total ${w}, must be 100`);
    const ids = (t.goNoGo.criteria ?? []).map((c) => c.id);
    if (new Set(ids).size !== ids.length || ids.some((x) => !x)) err(`tenants/${file}: goNoGo criteria need unique, non-empty ids`);
  }
  for (const c of t.competitors ?? []) if (!c?.name && t.id !== "CHANGEME") err(`tenants/${file}: every competitor needs a name`);

  // Answer library: approved answers only, reviewed on a cycle.
  const libPath = path.join(ROOT, "library", `${id}.json`);
  if (fs.existsSync(libPath)) {
    const lib = readJson(libPath);
    const now = Date.now();
    const staleN = (lib?.entries ?? []).filter((e) => !e.lastReviewed || now - new Date(e.lastReviewed).getTime() > (e.reviewEveryDays ?? 180) * DAY).length;
    if (staleN) warn(`library/${id}.json: ${staleN} entr(y/ies) past review date. The drafter will mark them STALE.`);
    const ids = (lib?.entries ?? []).map((e) => e.id);
    if (new Set(ids).size !== ids.length) err(`library/${id}.json: duplicate entry ids`);
  } else {
    warn(`tenants/${file}: no library/${id}.json yet. Drafts will have no reusable answers.`);
  }

  const prof = t.profile ?? {};
  if (!prof.oneLiner) warn(`tenants/${file}: profile.oneLiner is empty; response drafts will carry a [TODO] there.`);
  if (t.status === "provisional") warn(`tenants/${file}: provisional.`);
  if ((t.openQuestions ?? []).length > 0) warn(`tenants/${file}: ${t.openQuestions.length} open question(s) recorded.`);
}

if (listJson("tenants").length === 0) warn("No tenants configured yet. Add a company with: npm run new-tenant -- <id> \"<Name>\" --industries <ids>");

// ---------------------------------------------------------------- internal-tool links
// No config, data or generated workflow may link to Jira, Confluence or any other
// internal tool. Checked over every JSON file in the repo's config directories.
for (const dir of ["channels", "industries", "tenants", "data", "n8n", "library"]) {
  for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".json"))) {
    const v = readJson(path.join(ROOT, dir, f));
    if (!v) continue;
    for (const hit of findBlocked(v, `${dir}/${f}`)) err(`${hit.path}: links to ${hit.url} — ${hit.why}. Links to internal tools are not allowed.`);
  }
}
// Watch-list domains are fetched directly, so they get the same check.
const dataFiles = [
  ...fs.readdirSync(path.join(ROOT, "data")).filter((f) => f.endsWith(".json")),
  ...(fs.existsSync(path.join(ROOT, "data", "private")) ? fs.readdirSync(path.join(ROOT, "data", "private")).filter((f) => f.endsWith(".json")).map((f) => `private/${f}`) : []),
];
for (const f of dataFiles) {
  const v = readJson(path.join(ROOT, "data", f));
  for (const e of [...(v?.entries ?? []), ...(v?.accounts ?? [])]) {
    if (e.domain && blockedReason(`https://${e.domain}/`)) err(`data/${f}: domain "${e.domain}" is an internal tool or private host — ${blockedReason(`https://${e.domain}/`)}`);
  }
}

// ---------------------------------------------------------------- report
console.log(`Validated ${packs.size} industry pack(s), ${listJson("tenants").length} tenant(s), ${channelIds.size} channel(s)\n`);
for (const w of warnings) console.log(`  warning: ${w}`);
for (const e of errors) console.log(`  error:   ${e}`);
console.log();

if (errors.length) {
  console.log(`FAIL: ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
if (STRICT && warnings.length) {
  console.log(`FAIL (strict): 0 errors, ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`PASS: 0 errors, ${warnings.length} warning(s)`);
