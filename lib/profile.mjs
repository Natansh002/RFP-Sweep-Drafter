/**
 * Company profile: understand what a company sells from its own website, then
 * score every opportunity against it.
 *
 *   pageFacts(html, url)        title, description, headings, links and text of one page
 *   profileLinks(home, facts)   the site's own pages most likely to describe its offering
 *   buildProfile({ website, pages })
 *                               capabilities (what it sells), industries (who it serves),
 *                               platforms (what it is built on), products, distinctive terms
 *   companyFit(item, profile)   0–100 fit of one opportunity to what the company sells, with reasons
 *   profileSearch(profile)      the capabilities and terms a sweep should search for
 *
 * Deterministic and explainable: every capability, industry and match names the
 * words on the website or in the RFP that produced it. Nothing is invented; a
 * person reviews and edits the profile before it is used.
 *
 * Import-free apart from sibling lib modules: the browser bundle inlines it.
 */
import { CAPABILITIES, matchCapabilities } from "./capabilities.mjs";

const lower = (s) => String(s ?? "").toLowerCase();
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text, phrase) => new RegExp(`(^|[^a-z0-9])${escRe(lower(phrase))}($|[^a-z0-9])`).test(lower(text));
const decode = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&#8217;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#8211;|&ndash;/g, "–").replace(/&#8212;|&mdash;/g, "—");
const clean = (s) => decode(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Platforms a company may be built on or integrate with. Named, so a fit can say "both mention Business Central". */
export const PLATFORMS = [
  ["Microsoft Dynamics 365", /\bdynamics 365\b|\bd365\b/i], ["Business Central", /\bbusiness central\b/i], ["Dynamics GP", /\bdynamics gp\b|\bgreat plains\b/i],
  ["Microsoft 365", /\bmicrosoft 365\b|\bm365\b|\boffice 365\b/i], ["Power BI", /\bpower bi\b/i], ["Microsoft Azure", /\bazure\b/i], ["Copilot", /\bcopilot\b/i],
  ["NetSuite", /\bnetsuite\b/i], ["Sage Intacct", /\bsage intacct\b/i], ["Workday", /\bworkday\b/i], ["Oracle", /\boracle\b/i], ["SAP", /\bSAP\b/],
  ["Salesforce", /\bsalesforce\b/i], ["ServiceNow", /\bservicenow\b/i], ["AWS", /\baws\b|amazon web services/i], ["Google Cloud", /\bgoogle cloud\b/i],
  ["Blackbaud", /\bblackbaud\b/i], ["PowerSchool", /\bpowerschool\b/i], ["Tyler Technologies", /\btyler technologies\b/i], ["Infor", /\binfor\b/i],
  ["UKG", /\bukg\b/i], ["Dayforce", /\bdayforce\b|\bceridian\b/i], ["ADP", /\bADP\b/], ["Esri / ArcGIS", /\besri\b|\barcgis\b/i],
];

/** How a company describes whom it serves, mapped to the buyer industries the sweep assigns. */
export const SERVES = [
  { id: "k12", label: "K-12 education", sectors: ["k12"], re: /\b(k-?12|school districts?|school boards?|school divisions?|public schools|independent schools)\b/gi },
  { id: "higher-ed", label: "Higher education", sectors: ["higher-ed"], re: /\b(higher education|universities|colleges|campuses)\b/gi },
  { id: "nonprofit", label: "Nonprofit / public-benefit", sectors: ["nonprofit"], re: /\b(non-?profits?|not-for-profits?|charities|charitable organi[sz]ations|foundations|associations|human services|social services|community services|mission-driven|public libraries|housing (authorities|agencies|providers))\b/gi },
  { id: "municipal", label: "Municipal / local government", sectors: ["municipal"], re: /\b(municipalities|municipal governments?|cities and counties|local governments?|counties|towns)\b/gi },
  { id: "public", label: "Government / public sector", sectors: ["federal-ca", "federal-us", "provincial", "crown", "defence"], re: /\b(public sector|government agencies|state agencies|state and local|provincial governments?|federal (government|agencies)|crown corporations?)\b/gi },
  { id: "health", label: "Healthcare", sectors: ["health"], re: /\b(healthcare|health care|hospitals|health systems|clinics|behavioral health|long-term care)\b/gi },
  { id: "utilities", label: "Utilities and energy", sectors: ["utilities"], re: /\b(utilities|energy providers|water utilities|electric utilities)\b/gi },
  { id: "transit", label: "Transportation and transit", sectors: ["transit"], re: /\b(transit agencies|transportation agencies|airports|ports)\b/gi },
  { id: "indigenous", label: "Indigenous government", sectors: ["indigenous"], re: /\b(first nations|tribal (governments|nations)|indigenous (communities|governments))\b/gi },
  { id: "logistics", label: "Logistics / courier", sectors: [], packs: ["logistics-lastmile-tms", "logistics-freight-fleet"], re: /\b(couriers?|last[- ]mile|delivery (companies|businesses)|logistics providers|3pls?|freight)\b/gi },
];

// Words that describe the website, not the business.
const NOISE = new Set(("home about contact careers career blog news events login log sign signin register menu search skip content main footer header cookie cookies privacy policy terms " +
  "copyright rights reserved learn more read get started request demo book schedule call subscribe newsletter follow linkedin twitter facebook youtube instagram email phone " +
  "click here view all back top page site website web inc ltd llc corp co www http https com org net ca us our we you your us their they it its the a an and or of to for in on with by is are be " +
  "will can how what why who when where which this that these those more most all any each every new now today help support team people company customers customer clients client " +
  "solutions solution products product services service platform software features feature resources resource industries industry partners partner success stories story case study").split(" "));
const STOP = new Set("a an the and or of to for in on at by with from as is are be been being will can our your their its this that these those it we you they us not no".split(" "));
// Marketing words that make a phrase filler rather than an offering ("built for", "in one place", "trusted by").
const FILLER = new Set(("built build builds helps help helping manage manages managing run runs running replaces replace trust trusted trusts one place " +
  "more than across over into like just every best leading powerful easy simple modern better smarter faster world first great real true key top " +
  "funders funder love loved proud unlock empower empowers deliver delivers delivering make makes making designed purpose").split(" "));
const INDUSTRY_WORD = new RegExp(SERVES_SOURCE(), "i");
function SERVES_SOURCE() { return "\\b(k-?12|schools?|school districts?|school boards?|non-?profits?|charities|foundations|associations|municipalit(y|ies)|governments?|public sector|agencies|hospitals|healthcare|universities|colleges|libraries|first nations|tribal|couriers?)\\b"; }

/** The facts on one page: what it is called, what it says about itself, and where it links. */
export function pageFacts(html, url = "") {
  const raw = String(html ?? "");
  const pick = (re) => clean(raw.match(re)?.[1] ?? "");
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)
    || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  const siteName = pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i);
  const body = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<svg[\s\S]*?<\/svg>/gi, " ");
  const headings = [...body.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => clean(m[2])).filter((t) => t.length >= 3 && t.length <= 120);
  const links = [...body.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)].map((m) => {
    let href = m[1];
    try { href = url ? new URL(m[1], url).href : m[1]; } catch { /* keep */ }
    return { href, text: clean(m[2]).slice(0, 80) };
  });
  const paragraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => clean(m[1])).filter((t) => t.length >= 60);
  const text = clean(body).slice(0, 60000);
  return { url, title, description, siteName, headings, links, paragraphs, text };
}

/** Facts from pasted text or a brochure, when the website cannot be read directly. */
export function textFacts(text, name = "") {
  const t = String(text ?? "").replace(/\r/g, "");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const headings = lines.filter((l) => l.length <= 80 && !/[.;:]$/.test(l) && /^[A-Z0-9]/.test(l)).slice(0, 60);
  const paragraphs = lines.filter((l) => l.length >= 60);
  // Pasted "About" text usually starts with the company's name on its own line.
  const first = lines[0] ?? "";
  const guessed = !name && first.length >= 3 && first.length <= 60 && !/[.:;!?]$/.test(first) && first.split(/\s+/).length <= 6 ? first : "";
  return { url: null, title: name || guessed, description: paragraphs[0] ?? "", siteName: name || guessed, headings, links: [], paragraphs, text: t.replace(/\s+/g, " ").slice(0, 60000) };
}

const OFFERING_PATH = /(product|solution|service|platform|module|feature|capabilit|offering|industr|sector|who-we-serve|who-we-help|customers|clients|what-we-do|about|why-)/i;

/** Up to `max` of the site's own pages most likely to describe what it sells and to whom. */
export function profileLinks(homeUrl, facts, max = 7) {
  let home;
  try { home = new URL(homeUrl); } catch { return []; }
  const host = home.hostname.replace(/^www\./, "");
  const seen = new Set([home.href.replace(/\/$/, "")]);
  const scored = [];
  for (const l of facts.links ?? []) {
    let u;
    try { u = new URL(l.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, "") !== host) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|docx?|xlsx?|mp4)$/i.test(u.pathname) || /\/(blog|news|events?|careers?|jobs|login|signin|cart|privacy|terms|legal|contact)(\/|$)/i.test(u.pathname)) continue;
    const key = `${u.origin}${u.pathname}`.replace(/\/$/, "");
    if (seen.has(key)) continue;
    const s = (OFFERING_PATH.test(u.pathname) ? 3 : 0) + (OFFERING_PATH.test(l.text) ? 2 : 0) - u.pathname.split("/").filter(Boolean).length * 0.3;
    if (s <= 0) continue;
    seen.add(key);
    scored.push({ href: key, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.href);
}

/** Distinctive phrases the company uses about itself (1–3 words), most characteristic first. */
function distinctiveTerms(texts, headings, limit = 30) {
  const counts = new Map();
  const add = (phrase, w) => counts.set(phrase, (counts.get(phrase) ?? 0) + w);
  const words = (s) => lower(s).normalize("NFKD").replace(/[^a-z0-9&\s-]/g, " ").split(/\s+/).filter(Boolean);
  const scan = (s, w) => { for (const seg of String(s).split(/[,.;:!?()|\n•–—\/]+/)) scanSegment(seg, w); };
  const scanSegment = (s, w) => {
    const ws = words(s);
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= ws.length; i++) {
        const g = ws.slice(i, i + n);
        if (g.some((x) => (x.length < 3 && x !== "hr" && x !== "it" && x !== "bi") || STOP.has(x) || FILLER.has(x)) || g.every((x) => NOISE.has(x)) || /^\d+$/.test(g.join(""))) continue;
        if (n === 1 && (NOISE.has(g[0]) || g[0].length < 4)) continue;
        add(g.join(" "), w * (n === 1 ? 1 : n === 2 ? 2.2 : 2.6));
      }
    }
  };
  for (const t of texts) scan(t, 1);
  for (const h of headings) scan(h, 3);
  const out = [...counts.entries()].filter(([p, c]) => c >= 4.4 || (p.includes(" ") && c >= 3)).sort((a, b) => b[1] - a[1]);
  // Drop a phrase already covered by a stronger longer one ("fund" under "fund accounting").
  const kept = [];
  for (const [p] of out) {
    if (kept.some((k) => k.includes(p) && k !== p) || kept.some((k) => p.includes(k) && p.split(" ").length - k.split(" ").length > 1)) continue;
    kept.push(p);
    if (kept.length >= limit) break;
  }
  return kept;
}

/**
 * Build the profile from the pages read. `pages` are pageFacts/textFacts results.
 * Every capability and industry carries the words that produced it.
 */
export function buildProfile({ website = null, pages = [], source = "website" } = {}) {
  const home = pages[0] ?? { title: "", description: "", headings: [], text: "", paragraphs: [], links: [] };
  const headings = pages.flatMap((p) => p.headings ?? []);
  const allText = pages.map((p) => [p.title, p.description, (p.headings ?? []).join(". "), p.text].join(" ")).join(" \n ").slice(0, 250000);
  let host = "";
  try { host = website ? new URL(website).hostname.replace(/^www\./, "") : ""; } catch { /* none */ }
  const name = (home.siteName || (home.title ?? "").split(/\s[|–—:-]\s/)[0] || host || "Your company").trim().slice(0, 80);
  const summary = (home.description || pages.flatMap((p) => p.paragraphs ?? [])[0] || "").slice(0, 400);

  const caps = matchCapabilities(headings.join(". "), allText)
    .filter((c) => c.score >= 3)
    .map((c) => ({ id: c.id, label: c.label, strength: c.score, evidence: c.matched.slice(0, 6), on: true }));

  const industries = [];
  for (const s of SERVES) {
    const hits = [...allText.matchAll(s.re)].map((m) => m[0].toLowerCase());
    const inHeadings = headings.some((hd) => new RegExp(s.re.source, "i").test(hd)) || new RegExp(s.re.source, "i").test(summary);
    if (hits.length >= 2 || inHeadings) industries.push({ id: s.id, label: s.label, mentions: hits.length, evidence: [...new Set(hits)].slice(0, 4), on: true });
  }
  industries.sort((a, b) => b.mentions - a.mentions);

  const platforms = PLATFORMS.map(([n, re]) => ({ name: n, mentions: (allText.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)) ?? []).length }))
    .filter((p) => p.mentions > 0).sort((a, b) => b.mentions - a.mentions).map((p) => ({ ...p, on: p.mentions >= 2 }));

  // Product and solution names: links and headings under products / solutions / platform paths.
  const products = [...new Set(pages.flatMap((p) => (p.links ?? []).filter((l) => /\/(products?|solutions?|platform|modules?)\//i.test(l.href) && l.text.length >= 3 && l.text.length <= 40 && !/^(learn more|read more|view|explore|see|more)\b/i.test(l.text)).map((l) => l.text)))].slice(0, 20);

  // Offering terms only: industry words ("school districts") describe who they serve, not what they sell.
  const nameWords = new Set(lower(name).split(/\W+/).filter((w) => w.length > 2));
  const keywords = distinctiveTerms(pages.map((p) => p.text), headings)
    .filter((k) => !INDUSTRY_WORD.test(k) && !k.split(" ").some((w) => nameWords.has(w))).slice(0, 25);

  const geo = [];
  if (/\b(canada|canadian|ontario|british columbia|alberta|quebec|manitoba|saskatchewan|nova scotia)\b/i.test(allText)) geo.push("CA");
  if (/\b(united states|u\.s\.|usa|american|nationwide)\b/i.test(allText)) geo.push("US");

  return {
    kind: "ionic-rfp-sweeper/profile",
    version: 1,
    name,
    website,
    summary,
    capabilities: caps,
    industries,
    platforms,
    products,
    keywords,
    geography: geo,
    source,
    pagesRead: pages.map((p) => p.url).filter(Boolean),
    words: allText.split(/\s+/).length,
    builtAt: new Date().toISOString(),
    method: "keyword and phrase analysis of the company's own pages (no language model)",
  };
}

const onOnly = (xs) => (xs ?? []).filter((x) => x.on !== false);

/**
 * Fit of one opportunity to the company's product offering, 0–100, with the reasons.
 * What it sells (capabilities) 55, its own terms and product names 30, platforms 15.
 * The buyer's industry is not part of fit: fit is about what the RFP asks for.
 * With no capability, headline term or platform match it is capped at 35: not relevant.
 */
export function companyFit(item, profile) {
  if (!profile) return null;
  const title = String(item.title ?? "");
  const text = `${title} ${item.summary ?? ""} ${item.sourceText ?? item.body ?? ""}`;
  const reasons = [];

  const profCaps = new Map(onOnly(profile.capabilities).map((c) => [c.id, c]));
  const oppCaps = matchCapabilities(title, text);
  const capHits = oppCaps.filter((c) => profCaps.has(c.id));
  // A capability named in the title is a core match; one only in the description counts for less.
  const capScore = Math.min(1, capHits.reduce((a, c) => a + (c.score >= 3 ? 0.85 : 0.45), 0));
  if (capHits.length) reasons.push(`Asks for what you offer: ${capHits.map((c) => c.label).join(", ")}`);
  else if (oppCaps.length) reasons.push(`Asks for ${oppCaps.slice(0, 2).map((c) => c.label).join(", ")}, which your profile does not list`);

  const terms = [...(profile.keywords ?? []), ...(profile.products ?? [])];
  const kwTitle = terms.filter((k) => k.length >= 4 && has(title, k));
  const kwText = terms.filter((k) => k.length >= 4 && !kwTitle.includes(k) && has(text, k));
  const kwScore = Math.min(1, kwTitle.length * 0.4 + kwText.length * 0.1);
  if (kwTitle.length || kwText.length) reasons.push(`Uses your terms: ${[...kwTitle, ...kwText].slice(0, 5).join(", ")}`);

  const plats = onOnly(profile.platforms).filter((p) => (PLATFORMS.find(([n]) => n === p.name)?.[1] ?? /$^/).test(text));
  const platScore = plats.length ? 1 : 0;
  if (plats.length) reasons.push(`Names ${plats.map((p) => p.name).join(", ")}, which you work with`);

  let score = Math.round(capScore * 55 + kwScore * 30 + platScore * 15);
  if (!capHits.length && !kwTitle.length && !plats.length) { score = Math.min(score, 35); reasons.push("No match to your offering: not relevant unless you know otherwise"); }
  const band = score >= 60 ? "strong" : score >= 40 ? "possible" : "weak";
  return { score, band, reasons, matched: { capabilities: capHits.map((c) => c.id), terms: [...kwTitle, ...kwText], platforms: plats.map((p) => p.name) }, notOffered: capHits.length ? [] : oppCaps.slice(0, 3).map((c) => c.label) };
}

/** What a sweep should search for, from the profile. */
export function profileSearch(profile) {
  if (!profile) return null;
  const caps = onOnly(profile.capabilities).map((c) => c.id).filter((id) => CAPABILITIES.some((c) => c.id === id));
  const multi = (profile.keywords ?? []).filter((k) => k.includes(" ")).slice(0, 8);
  const plats = onOnly(profile.platforms).map((p) => p.name).filter((n) => !/^(Microsoft 365|Microsoft Azure|AWS|Google Cloud|Copilot)$/.test(n));
  return {
    capabilities: caps,
    titleKeywords: [...new Set([...multi, ...plats])],
    bodyKeywords: (profile.keywords ?? []).slice(0, 20),
    searchTerms: [...new Set([...multi.slice(0, 4), ...plats.slice(0, 2)])],
  };
}

export default { PLATFORMS, SERVES, pageFacts, textFacts, profileLinks, buildProfile, companyFit, profileSearch };
