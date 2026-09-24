/**
 * Shared scorer. One implementation, used by the CLI, the dashboard and pasted verbatim into the
 * n8n "Score" Code node, so a bid scored on the desk and a bid scored by the
 * scheduled run get the same number.
 *
 * The weights come from the industry pack, never from here. This file decides HOW
 * each dimension is measured; the pack decides how much each one counts.
 *
 * Every score carries its reasons. A number with no reason attached is a number
 * nobody argues with, which means nobody trusts it.
 */

const lower = (s) => String(s ?? "").toLowerCase();

/**
 * Which needles appear in the haystack, as whole words. Substring matching was
 * wrong on the first live run: "SIS" matched "Mississippi".
 */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function matches(haystack, needles) {
  const h = lower(haystack);
  return (needles ?? []).filter((n) => new RegExp(`(^|[^a-z0-9])${esc(lower(n))}($|[^a-z0-9])`).test(h));
}

/**
 * Hard gate. Runs before scoring. A disqualifier hit means the item never
 * reaches the score, so a bus-routing tender cannot accumulate points for
 * having a close date and a named buyer.
 */
export function disqualify(item, pack) {
  const text = `${item.title ?? ""} ${item.summary ?? ""}`;
  const hits = matches(text, pack.disqualifiers);
  if (hits.length === 0) return null;

  // A disqualifier inside the body but a strong qualifier in the title is a
  // judgement call, not an automatic kill. Flag it rather than dropping it.
  const titleHits = matches(item.title, pack.disqualifiers);
  const titleQualifiers = matches(item.title, pack.qualifiers?.titleKeywords);
  if (titleHits.length === 0 && titleQualifiers.length > 0) {
    return { kind: "flag", reason: `body mentions ${hits.join(", ")} but the title qualifies` };
  }
  return { kind: "drop", reason: `disqualified on ${hits.join(", ")}` };
}

/**
 * Each dimension returns 0..1. The pack's weight turns it into points.
 * Unknown is NOT zero. An item with no close date scores 0.5 on timeline and
 * says so, rather than being punished for a field the portal did not publish.
 */
const DIMENSIONS = {
  productFit(item, pack) {
    const t = matches(item.title, pack.qualifiers?.titleKeywords);
    const b = matches(`${item.summary ?? ""} ${item.body ?? ""}`, pack.qualifiers?.bodyKeywords);
    if (t.length === 0 && b.length === 0) {
      return { v: 0, why: "no qualifier matched" };
    }
    // A title match is worth far more than a body match. Portals pad the body.
    const v = Math.min(1, t.length * 0.4 + b.length * 0.08);
    return { v, why: `title: ${t.join(", ") || "none"}; body: ${b.length} match(es)` };
  },

  buyerFit(item, pack) {
    const hits = matches(`${item.buyer ?? ""} ${item.buyerType ?? ""}`, pack.buyerTypes);
    if (hits.length > 0) return { v: 1, why: `buyer type: ${hits[0]}` };
    if (!item.buyer) return { v: 0.5, why: "buyer not published, unknown" };
    return { v: 0.2, why: "buyer does not match a listed type" };
  },

  dealSize(item, pack) {
    const v = item.estimatedValue;
    if (v == null) return { v: 0.5, why: "value not published, unknown" };
    const floors = (pack.thresholds?.values ?? []).map((t) => t.amount).filter(Boolean);
    const floor = floors.length ? Math.min(...floors) : 75000;
    if (v < floor) return { v: 0.2, why: `below the ${floor} posting floor` };
    if (v < floor * 4) return { v: 0.6, why: `modest: ${v}` };
    return { v: 1, why: `material: ${v}` };
  },

  timeline(item) {
    if (!item.closeDate) return { v: 0.5, why: "close date not published, unknown" };
    const days = Math.round((new Date(item.closeDate) - new Date()) / 86400000);
    if (days < 0) return { v: 0, why: `closed ${-days} days ago` };
    if (days <= 7) return { v: 0.25, why: `${days} days left, too short to run a real response` };
    if (days <= 21) return { v: 0.7, why: `${days} days left` };
    return { v: 1, why: `${days} days left` };
  },

  incumbent(item) {
    if (item.incumbent) return { v: 1, why: `incumbent named: ${item.incumbent}` };
    if (matches(`${item.title} ${item.summary}`, ["replace", "replacement", "legacy", "end of life", "modernization", "modernisation"]).length) {
      return { v: 0.8, why: "replacement language in the posting" };
    }
    return { v: 0.5, why: "no incumbent signal" };
  },

  geography(item, pack, tenant) {
    const geo = tenant?.geography ?? pack.geography ?? [];
    if (!item.country) return { v: 0.5, why: "country not published, unknown" };
    if (geo.includes(item.country)) return { v: 1, why: `${item.country} is in scope` };
    return { v: 0, why: `${item.country} is out of scope` };
  },
};

/**
 * Dimensions where a zero is fatal regardless of the total.
 *
 * Found by test, not by design: a K-12 ERP bid that closed five days ago still
 * scored 81 and would have been marked pursue, because the other five dimensions carried
 * it. Weighting cannot express "this one is a gate" — 10 points of timeline
 * against 90 points of everything else will always lose that argument. So these
 * two are checked separately, after scoring, and they veto.
 */
const VETO = {
  timeline: "the solicitation has already closed",
  geography: "the buyer is outside the tenant's geography",
};

export function score(item, pack, tenant) {
  const dq = disqualify(item, pack);
  if (dq?.kind === "drop") {
    return { total: 0, band: "dropped", reasons: [dq.reason], flags: [] };
  }

  // Relevance gate. A posting that matches no qualifier at all is not a finding,
  // however much "unknown" credit it would collect. Found on the first live run:
  // portal nav links ("Terms of Service", "Create an account") scored 38 on
  // unknowns alone and flooded the review list.
  const relevance = DIMENSIONS.productFit(item, pack);
  if (relevance.v === 0) {
    return { total: 0, band: "dropped", reasons: [`not relevant: ${relevance.why}`], flags: [] };
  }

  const weights = pack.scoring?.weights ?? {};
  const reasons = [];
  const flags = dq?.kind === "flag" ? [dq.reason] : [];
  let total = 0;
  let unknowns = 0;
  const vetoes = [];

  for (const [name, weight] of Object.entries(weights)) {
    const fn = DIMENSIONS[name];
    if (!fn) {
      flags.push(`pack weights an unknown dimension "${name}"; it scored 0`);
      continue;
    }
    const { v, why } = fn(item, pack, tenant);
    if (/unknown/.test(why)) unknowns += 1;
    if (v === 0 && VETO[name]) vetoes.push(`${VETO[name]} (${why})`);
    total += v * weight;
    reasons.push(`${name} ${Math.round(v * weight)}/${weight} — ${why}`);
  }

  total = Math.round(total);
  const min = pack.scoring?.minScoreToPursue ?? 55;
  const floor = pack.scoring?.autoNoBidBelow ?? 30;

  let band;
  if (total < floor) band = "no bid";
  else if (total < min) band = "review";
  else band = "pursue";

  // A veto wins over the total, always. Reported with the score intact so a
  // reviewer can see it was a good fit that arrived too late or in the wrong
  // country, rather than a bad fit.
  if (vetoes.length) {
    band = "no bid";
    reasons.unshift(`VETOED: ${vetoes.join("; ")}`);
  }

  // Honesty rule: a score built mostly on unknowns is not a confident score,
  // whatever the number says. Never mark one "pursue" on its own say-so.
  if (unknowns >= 3 && band === "pursue" && vetoes.length === 0) {
    band = "review";
    flags.push(`${unknowns} dimensions were unknown; downgraded to review rather than pursue`);
  }

  return { total, band, reasons, flags, unknowns, vetoes };
}

export default { score, disqualify };
