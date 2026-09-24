/**
 * The drafter. Turns a scored posting into a finding a person can act on:
 *
 *   - a bid/no-bid brief: what, who, when, the score and why, and what is unknown
 *   - a first-draft response skeleton built from the tenant's own profile and the
 *     product lines it sells into this industry
 *   - a set of action items with due dates worked back from the close date
 *
 * Action items are shown in the dashboard and the Excel "Actions" sheet. They are
 * never created as Jira issues or tasks anywhere.
 *
 * The draft is a starting point, not a submission. Every capability statement in
 * it is taken from tenant.profile, which a person wrote; nothing is invented.
 *
 * Import-free on purpose: build-workflows.mjs inlines it into the n8n Code nodes.
 */

const DAY = 86400000;

/** FNV-1a, twice, for a stable short id without needing a crypto module. */
function hash(s) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return (a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")).slice(0, 12);
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Same posting, same id, whichever portal it was found on. Title plus buyer
 * rather than URL, because one solicitation is often mirrored on two portals.
 */
export function findingId(tenantId, posting) {
  const key = posting.sourceId ? `src:${posting.sourceId}` : `${norm(posting.title)}|${norm(posting.buyer)}`;
  return `${tenantId.slice(0, 4)}-${hash(key)}`;
}

const DATE_NAMES = { closing: "Closing", questions: "Questions deadline", preBid: "Pre-bid meeting", siteVisit: "Site visit", award: "Expected award" };

const parseDate = (d) => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t;
};
const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);

/** Work a due date back from the close date, never earlier than tomorrow. */
function dueBefore(close, daysBefore, fallbackDaysFromNow, now) {
  const floor = new Date(now.getTime() + DAY);
  if (!close) return iso(new Date(now.getTime() + fallbackDaysFromNow * DAY));
  const d = new Date(close.getTime() - daysBefore * DAY);
  return iso(d < floor ? floor : d);
}

function actionsFor(band, close, assignee, now, dates = {}) {
  const mk = (key, title, due) => ({ id: key, title, due, assignee, done: false, source: "drafter", rev: 0 });
  const before = (d, n) => { const t = parseDate(d); return t ? dueBefore(t, n, 1, now) : null; };
  if (band === "review") {
    return [mk("triage", "Triage: read the posting and decide pursue or pass", dueBefore(close, 21, 3, now))];
  }
  const dated = [
    dates.questions && mk("questions", `Send clarification questions before the Q&A deadline (${dates.questions})`, before(dates.questions, 1)),
    dates.preBid && mk("prebid", `Attend the pre-bid meeting (${dates.preBid})`, before(dates.preBid, 0)),
    dates.siteVisit && mk("sitevisit", `Attend the site visit (${dates.siteVisit})`, before(dates.siteVisit, 0)),
  ].filter(Boolean);
  return [...dated,
    mk("read", "Read the full solicitation, addenda and Q&A deadline", dueBefore(close, 25, 2, now)),
    mk("gonogo", "Go / no-go decision with a named sponsor", dueBefore(close, 21, 5, now)),
    mk("compliance", "Build the submission compliance checklist (forms, insurance, references, format)", dueBefore(close, 18, 7, now)),
    mk("draft", "Complete the response draft from the drafter skeleton", dueBefore(close, 7, 14, now)),
    mk("review", "Internal review and pricing sign-off", dueBefore(close, 3, 18, now)),
    mk("submit", "Submit and record the confirmation", dueBefore(close, 1, 21, now)),
  ].sort((a, b) => String(a.due).localeCompare(String(b.due)));
}

function bullet(xs) {
  return xs.filter(Boolean).map((x) => `- ${x}`).join("\n");
}

function brief(p, s, pack, tenant, close, now) {
  const days = close ? Math.round((close - now) / DAY) : null;
  const unknown = s.reasons.filter((r) => /unknown/.test(r)).map((r) => r.split(" — ")[0].split(" ")[0]);
  return [
    `${p.title}`,
    `Buyer: ${p.buyer ?? "not published"}${p.country ? ` (${p.country})` : ""}`,
    `Closes: ${close ? `${iso(close)}, ${days} days from today` : "not published"}`,
    `Value: ${p.estimatedValue ?? "not published"}`,
    `Score: ${s.total}/100 — ${s.band} (${pack.name}${pack.status !== "proven" ? `, pack is ${pack.status}` : ""})`,
    "",
    "Why it scored this way:",
    bullet(s.reasons),
    s.flags.length ? `\nFlags:\n${bullet(s.flags)}` : "",
    p.keyDates && Object.keys(p.keyDates).length ? `\nKey dates from the posting page:\n${bullet(Object.entries(p.keyDates).map(([k, v]) => `${DATE_NAMES[k] ?? k}: ${v}`))}` : "",
    p.requirements?.length ? `\n${p.requirements.length} mandatory requirement statement(s) found on the posting page — see the Compliance sheet.` : "",
    p.competitors?.length ? `\nCompetitors named on the posting page: ${p.competitors.join(", ")}` : "",
    p.incumbent ? `\nIncumbent: ${p.incumbent}` : "",
    unknown.length ? `\nUnknown until someone reads the solicitation: ${unknown.join(", ")}` : "",
    `\nSource: ${p.url}`,
  ].filter((x) => x !== "").join("\n");
}

/** Response skeleton. Exported so the dashboard can draft a "review" finding on request. */
export function draftResponse(p, pack, tenant, library = []) {
  const prof = tenant.profile ?? {};
  const o = pack.offering ?? {};
  const company = prof.companyName || tenant.name;
  const products = o.productLines?.length ? o.productLines.join(", ") : "[product lines not configured for this industry]";
  const matched = (pack.qualifiers?.titleKeywords ?? []).filter((k) => String(p.title).toLowerCase().includes(k.toLowerCase()));
  const TODO = (x) => `[TODO: ${x}]`;

  return `# Response draft — ${p.title}

Prepared for: ${p.buyer ?? TODO("buyer name")}
Prepared by: ${company}
Status: FIRST DRAFT generated by the RFP drafter. Not reviewed. Do not submit as is.

## 1. Cover letter

${p.buyer ?? TODO("buyer")} is seeking ${matched.length ? matched.join(", ") : TODO("the scope in the buyer's own words")}. ${company} ${prof.oneLiner || TODO("one-sentence description of the company from tenant.profile.oneLiner")}

We are pleased to submit this response and confirm our intent to meet the requirements set out in the solicitation. ${TODO("confirm addenda acknowledged, validity period, signatory")}

## 2. Executive summary

${o.pitch || prof.summary || TODO("two or three paragraphs: the buyer's problem, our solution, the outcome. Source: tenant.profile.summary or offerings.<industry>.pitch")}

Proposed solution: ${products}

## 3. Understanding of requirements

${TODO("restate each mandatory requirement from the solicitation, in the buyer's numbering, before answering it")}
${p.requirements?.length ? `\nMandatory statements found on the posting page (verify against the full solicitation and addenda):\n${bullet(p.requirements.slice(0, 25).map((r) => `${r.id} [${r.kind}] ${r.text}`))}` : ""}
${matched.length ? `\nThe posting title signals: ${matched.join(", ")}.` : ""}
${p.summary ? `\nPosting summary: ${p.summary.slice(0, 600)}` : ""}

## 4. Proposed solution

${bullet((prof.capabilities ?? []).map((c) => c)) || TODO("capabilities mapped to requirements; list in tenant.profile.capabilities")}

## 5. Implementation approach

${prof.implementationApproach || TODO("phases, timeline, governance, data migration, training; source tenant.profile.implementationApproach")}

## 6. Why ${company}

${bullet(prof.differentiators ?? []) || TODO("differentiators; list in tenant.profile.differentiators")}

## 7. Answers from the library

${library.length ? library.map((l) => `### ${l.question}\n[library:${l.id}${l.lastReviewed ? `, reviewed ${l.lastReviewed}` : ""}${l.owner ? `, owner ${l.owner}` : ""}]${l.stale ? " [STALE — confirm with the owner before use]" : ""}\n\n${l.answer || TODO("library entry has no answer text")}`).join("\n\n") : TODO("no library answers matched; add approved answers to library/" + tenant.id + ".json")}
${p.competitors?.length ? `\n## Competitive notes\n\nNamed on the posting page: ${p.competitors.join(", ")}. ${TODO("how we differ, stated only from approved claims")}\n` : ""}
## 8. References

${TODO(`${prof.referencesNote || "select references from customers in this industry who run the proposed product lines; confirm each has agreed"}`)}

## 9. Questions to clarify with the buyer

${bullet([
    !p.closeDate && "Confirm the closing date and time.",
    !p.keyDates?.questions && "Confirm the deadline for questions.",
    p.estimatedValue == null && "Is a budget or price range published?",
    !p.incumbent && "Is there an incumbent system or provider, and when does that contract end?",
    "Submission method, format and page limits.",
  ])}

## 10. Pricing

${TODO("pricing is never drafted automatically")}
`;
}

/**
 * Build a finding from a posting and its score. `pack` is the effective pack
 * (lib/pack.mjs effectivePack), so it carries the tenant's offering.
 */
export function draftFinding(posting, s, pack, tenant, channelId, now = new Date(), library = []) {
  const close = parseDate(posting.closeDate);
  const assignee = pack.offering?.defaultAssignee ?? tenant.owners?.default ?? "";
  return {
    id: findingId(tenant.id, posting),
    tenant: tenant.id,
    industry: pack.id,
    industryStatus: pack.status,
    title: posting.title,
    buyer: posting.buyer ?? null,
    country: posting.country ?? null,
    url: posting.url,
    channel: channelId,
    closeDate: iso(close),
    estimatedValue: posting.estimatedValue ?? null,
    score: s.total,
    band: s.band,
    reasons: s.reasons,
    flags: s.flags,
    draft: { brief: brief(posting, s, pack, tenant, close, now), response: s.band === "pursue" ? draftResponse(posting, pack, tenant, library) : null },
    // Left blank unless the tenant opts into autoAssign: a person assigns it, in the
    // dashboard or the spreadsheet. The suggestion is shown beside the empty field.
    assignee: tenant.autoAssign ? assignee : "",
    suggestedAssignee: assignee,
    actions: actionsFor(s.band, close, tenant.autoAssign ? assignee : "", now, posting.keyDates),
    keyDates: posting.keyDates ?? {},
    requirements: posting.requirements ?? [],
    competitors: posting.competitors ?? [],
    incumbent: posting.incumbent ?? null,
    contentHash: posting.contentHash ?? null,
    libraryMatches: library.map((l) => ({ id: l.id, stale: l.stale })),
  };
}

export default { findingId, draftFinding, draftResponse };
