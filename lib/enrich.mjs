/**
 * Read a posting's own public page and pull out what the listing did not say.
 *
 * Portal listings give a title and a link. The detail page usually carries the
 * closing date, the question deadline, pre-bid meetings, mandatory requirements
 * and sometimes the incumbent. Reading it turns "unknown" dimensions into real
 * ones, which is the single biggest improvement to score quality.
 *
 * Also produces a content hash, so the next sweep can tell when an addendum or
 * change has been posted (a missed addendum can make a bid non-compliant).
 *
 * Deterministic and import-free: build-workflows.mjs inlines it into n8n.
 */

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

export function pageText(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/**
 * Hash of the posting's own text, so only a real change (an addendum, a new requirement)
 * raises "posting page content changed". Portal pages rendered in a browser carry counters,
 * timestamps and sidebars that differ on every visit: the text before the posting's title,
 * lines about time left, views or sessions, countdowns ("1363 d 08 h 11 m") and clock times are
 * left out. Versioned ("v2:") so a new method never flags every posting at once.
 */
export function contentHash(text, { anchor = "" } = {}) {
  let t = String(text);
  const key = String(anchor).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40);
  if (key.length >= 12) { const i = t.toLowerCase().replace(/\s+/g, " ").indexOf(key); if (i > 0) t = t.replace(/\s+/g, " ").slice(i); }
  const norm = t.slice(0, 20000).toLowerCase().split(/\n+/)
    .filter((l) => !/\b(remaining|left to (bid|respond)|days? left|hours? left|ago|views?|viewed|last (updated|refreshed|visited|modified)|session|cookie|sign ?in|log ?in|countdown|server time|current time|page generated|printed on)\b/.test(l))
    .join(" ")
    // Countdowns ("1363 d 08 h 11 m", "12 days 5 hours") and clock times change on every visit; other numbers (page limits, quantities) are real.
    .replace(/\b\d+\s*d(ays?)?\s*,?\s*\d+\s*h(ours?|rs?)?(\s*,?\s*\d+\s*m(in(ute)?s?)?)?(\s*,?\s*\d+\s*s(ec(ond)?s?)?)?\b/g, "")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/g, "")
    .replace(/\s+/g, " ").trim();
  return `v2:${fnv(norm)}${fnv(norm.split("").reverse().join(""))}`;
}

/** Parse the earliest date in a snippet: 2026-10-15, 15/10/2026, October 15, 2026, 15 October 2026, Oct. 15 2026. */
export function parseDateIn(s) {
  const month = (w) => MONTHS[w.slice(0, 4).toLowerCase()] ?? MONTHS[w.slice(0, 3).toLowerCase()];
  const found = [];
  for (const m of s.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) found.push([m.index, isoDate(+m[1], +m[2] - 1, +m[3])]);
  for (const m of s.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/g)) if (month(m[1]) != null) found.push([m.index, isoDate(+m[3], month(m[1]), +m[2])]);
  for (const m of s.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(20\d{2})\b/g)) if (month(m[2]) != null) found.push([m.index, isoDate(+m[3], month(m[2]), +m[1])]);
  for (const m of s.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g)) {
    // Ambiguous d/m vs m/d: if the first part cannot be a month, it is the day.
    const [x, y] = [+m[1], +m[2]];
    found.push([m.index, x > 12 ? isoDate(+m[3], y - 1, x) : isoDate(+m[3], x - 1, y)]);
  }
  return found.filter(([, d]) => d).sort((p, q) => p[0] - q[0])[0]?.[1] ?? null;
}
function isoDate(y, mo, d) {
  const t = new Date(Date.UTC(y, mo, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
}

const DATE_LABELS = {
  closing: /(closing|close|due|submission|deadline for (proposals|submissions|bids)|proposals? (are )?due|bid closing)\s*(date|time)?/i,
  // "Question deadline", "Deadline for questions", "Enquiry period closes", "Questions must be submitted … no later than".
  questions: /(?:(?:deadline|last day|cut-?off|closing date|due date|final date)\s+(?:date\s+)?(?:for|to submit|to ask)\s+(?:the\s+)?(?:submission\s+of\s+)?(?:bidders'?\s+|proponents'?\s+|vendors'?\s+|offerors'?\s+|suppliers'?\s+)?(?:questions|inquiries|enquiries|clarifications?|requests? for clarification)|(?:questions?|inquir(?:y|ies)|enquir(?:y|ies)|clarifications?|requests? for clarification)\s*(?:and answers?\s*)?(?:acceptance\s*|submission\s*|period\s*)?(?:deadline|due(?:\s+date)?|close[sd]?|closing|cut-?off|end date|must be (?:received|submitted)|shall be (?:received|submitted)|(?:are|is)\s+due|will be accepted (?:until|up to)))/i,
  preBid: /(pre-?bid|pre-?proposal|bidders'?)\s*(meeting|conference|call)/i,
  siteVisit: /site\s*(visit|tour|meeting)/i,
  award: /(anticipated|expected|estimated)\s*(contract\s*)?(award|start)/i,
};

/** Look for each labelled date within a short window after its label. */
export function keyDates(text) {
  const out = {};
  for (const [key, re] of Object.entries(DATE_LABELS)) {
    const g = new RegExp(re.source, "gi");
    let m;
    while ((m = g.exec(text))) {
      // Only the rest of this line: a date on the next line belongs to another label.
      // Question instructions run long ("…in writing to the contact below no later than …").
      const d = parseDateIn(text.slice(m.index, m.index + m[0].length + (key === "questions" ? 170 : 90)).split("\n")[0]);
      if (d) { out[key] = d; break; }
    }
  }
  return out;
}

/** Sentences that state a mandatory requirement: the start of a compliance matrix. */
export function requirements(text, limit = 60) {
  const sentences = String(text).split(/(?<=[.;:])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 25 && s.length <= 400);
  const re = /\b(shall|must|is required to|are required to|mandatory|will be disqualified|at a minimum|no later than|page limit|must not exceed|submit (one|two|three|\d+) (copies|originals))\b/i;
  const kind = (s) =>
    /insurance|liability|bond|wsib|workers'? comp/i.test(s) ? "insurance" :
    /page|font|format|copies|pdf|electronic|envelope|label/i.test(s) ? "format" :
    /reference|experience|years/i.test(s) ? "experience" :
    /sign|form|appendix|schedule|attach|certif|declaration/i.test(s) ? "form" :
    /price|pricing|cost|fee/i.test(s) ? "pricing" : "technical";
  const seen = new Set();
  const out = [];
  for (const s of sentences) {
    if (!re.test(s)) continue;
    const k = s.toLowerCase().slice(0, 80);
    if (seen.has(k)) continue;
    seen.add(k);
    // Id from the text, not the position, so a person's owner/status on a
    // requirement survives an addendum that inserts a new one above it.
    out.push({ id: `R-${fnv(k + s.length)}`.slice(0, 8), text: s, kind: kind(s) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Competitors named in the page: tenant.competitors = [{ name, aliases: [] }]. */
export function competitorMentions(text, competitors) {
  const t = String(text).toLowerCase();
  return (competitors ?? [])
    .filter((c) => [c.name, ...(c.aliases ?? [])].some((n) => n && new RegExp(`(^|[^a-z0-9])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(t)))
    .map((c) => c.name);
}

/** Incumbent phrasing: "currently uses X", "the incumbent is X", "existing X system". */
export function incumbentHint(text) {
  const m = String(text).match(/\b(?:currently uses?|incumbent (?:vendor |provider |system )?is|existing system is|currently (?:running|on))\s+([A-Z][\w&.\- ]{2,40}?)(?=[,.;\n(]| (?:which|that|since|for|and)\b)/);
  return m ? m[1].trim() : null;
}

/** Everything the scorer, drafter and ledger want from one detail page. */
export function analyzeDetail(html, tenant, { title = "" } = {}) {
  const text = pageText(html);
  const dates = keyDates(text);
  return {
    contentHash: contentHash(text, { anchor: title }),
    keyDates: dates,
    closeDate: dates.closing ?? null,
    requirements: requirements(text),
    competitors: competitorMentions(text, tenant?.competitors),
    incumbent: incumbentHint(text),
    body: text.slice(0, 20000),
  };
}

export default { pageText, contentHash, parseDateIn, keyDates, requirements, competitorMentions, incumbentHint, analyzeDetail };
