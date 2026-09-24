/**
 * Answer library: approved, reusable answers a tenant keeps in library/<tenant>.json.
 *
 * The drafter cites matching entries in a response draft, each with its id and
 * review date. An entry past its review date is still shown but marked STALE,
 * because an out-of-date answer submitted with confidence is worse than a gap.
 *
 * Entry: { id, question, answer, tags[], industries[], owner, lastReviewed, reviewEveryDays }
 *
 * Import-free: build-workflows.mjs inlines it into n8n.
 */

const STOP = new Set("the a an and or of to for in on with by is are be will your our you we that this as at from it its their".split(" "));
const words = (s) => String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

export function isStale(entry, now = new Date()) {
  if (!entry.lastReviewed) return true;
  const days = (now - new Date(entry.lastReviewed)) / 86400000;
  return days > (entry.reviewEveryDays ?? 180);
}

/** Top library entries for a posting, by keyword overlap, scoped to the industry. */
export function matchLibrary(entries, text, industry, limit = 6, now = new Date()) {
  const doc = new Set(words(text));
  return (entries ?? [])
    .filter((e) => !e.industries?.length || e.industries.includes(industry))
    .map((e) => {
      const terms = [...new Set([...words(e.question), ...(e.tags ?? []).flatMap(words)])];
      const hit = terms.filter((w) => doc.has(w));
      return { entry: e, score: terms.length ? hit.length / Math.sqrt(terms.length) : 0, hit };
    })
    .filter((m) => m.hit.length >= 2 || (m.entry.tags ?? []).some((t) => String(text).toLowerCase().includes(String(t).toLowerCase())))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => ({ id: m.entry.id, question: m.entry.question, answer: m.entry.answer, owner: m.entry.owner ?? null, lastReviewed: m.entry.lastReviewed ?? null, stale: isStale(m.entry, now) }));
}

export default { isStale, matchLibrary };
