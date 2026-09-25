/**
 * One sweep: tenant × industry. Fetch every resolved channel, extract, score,
 * draft, and return a run the ledger can merge. Writes nothing itself.
 *
 * Used by the CLI (scripts/sweep.mjs) and the dashboard's Run sweep button. The
 * n8n workflows run the same extract/score/draft code, inlined.
 */
import { loadTenant, loadPack, loadRegistry, loadData } from "./config.mjs";
import { effectivePack, resolveChannels } from "./pack.mjs";
import { extractPostings, procurementLinks } from "./extract.mjs";
import { score } from "./score.mjs";
import { draftFinding, findingId } from "./draft.mjs";
import { assertAllowedUrl, safeLink } from "./guard.mjs";
import { analyzeDetail } from "./enrich.mjs";
import { renderPage, browserAvailable } from "./browser.mjs";
import { classifySector } from "./sector.mjs";
import { matchLibrary } from "./library.mjs";
import { packForSearch, matchCapabilities, recommendTeam, GEOGRAPHIES } from "./capabilities.mjs";
import { accountPortal, documentLinks, listedDocuments, samAttachments, readDocuments } from "./documents.mjs";
import { extractKeyData, flagRisks, mapRequirements } from "./analyze.mjs";

const UA = "Mozilla/5.0 (compatible; ionic-rfp-sweeper/0.2; +procurement monitoring)";
const COUNTRY = { canada: "CA", "united states": "US", usa: "US", us: "US", ca: "CA" };

// Short-lived cache: an all-industries sweep reads the same open-data feed once, not once per industry.
const CACHE = new Map();
const CACHE_MS = 10 * 60 * 1000;

async function get(url, fetchImpl, blocked = [], timeoutMs = 30000) {
  assertAllowedUrl(url, blocked);
  const hit = fetchImpl === fetch && CACHE.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fetchOnce(url, fetchImpl, blocked, timeoutMs);
  if (fetchImpl === fetch && !value.error) CACHE.set(url, { at: Date.now(), value });
  return value;
}

async function fetchOnce(url, fetchImpl, blocked, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // Follow redirects by hand so every hop passes the guard before it is requested.
    let res, at = url;
    for (let hop = 0; hop < 6; hop++) {
      res = await fetchImpl(at, { headers: { "user-agent": UA, accept: "text/html,application/json;q=0.9,*/*;q=0.5" }, redirect: "manual", signal: ctl.signal });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!loc) break;
      at = assertAllowedUrl(new URL(loc, at).href, blocked);
    }
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const type = res.headers.get("content-type") ?? "";
    return { body: type.includes("json") ? await res.json() : await res.text() };
  } catch (e) {
    if (/^Blocked:/.test(e.message)) return { error: e.message, blocked: true };
    return { error: e.name === "AbortError" ? `timed out after ${timeoutMs / 1000}s` : e.message };
  } finally {
    clearTimeout(t);
  }
}

const BUYER_HINTS = {
  k12: /\b(school|schools|board of education|district school|school division|school district|conseil scolaire|academy|education authority|isd|usd|oecm|education collaborative|educational cooperative)\b/i,
  nonprofit: /\b(foundation|society|association|charity|charitable|ymca|ywca|united way|community|non-?profit|health centre|health center|housing|shelter|mission|institute|council|library|libraries|biblioth[èe]que)\b/i,
};
export function buyerMatches(p, pack) {
  const b = `${p.buyer ?? ""} ${p.buyerType ?? ""}`;
  if (BUYER_HINTS[pack.id]?.test(b)) return true;
  return (pack.buyerTypes ?? []).some((t) => b.toLowerCase().includes(t.toLowerCase().split(" ")[0]) && b.toLowerCase().includes(t.toLowerCase().split(" ").slice(-1)[0]));
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/**
 * Read one public web page for the company profile: plain fetch first, then the
 * headless browser if the page is empty or refuses the fetch. The same guard as
 * every sweep request: internal tools and private addresses are refused.
 */
export async function readPublicPage(url, { browser = true, fetchImpl = fetch } = {}) {
  assertAllowedUrl(url);
  const r = await get(url, fetchImpl, []);
  const thin = typeof r.body !== "string" || r.body.replace(/<script[\s\S]*?<\/script>|<[^>]+>/g, " ").replace(/\s+/g, " ").length < 600;
  if ((r.error || thin) && browser && fetchImpl === fetch && (await browserAvailable())) {
    const b = await renderPage(url, { timeoutMs: 30000 });
    if (b.body) return { html: b.body };
    if (r.error) return { error: b.error ?? r.error };
  }
  return r.error ? { error: r.error } : { html: typeof r.body === "string" ? r.body : "" };
}

/** Direct sites: the tenant's installed-base watch list and the pack's directSites list. */
function directChannels(pack, tenant) {
  const lists = [loadData(pack.directSites?.seedFrom), loadData(tenant.installedBaseWatch)].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const l of lists) {
    for (const e of [...(l.entries ?? []), ...(l.accounts ?? [])]) {
      if (!e.domain || seen.has(e.domain)) continue;
      if (e.segment && e.segment !== pack.id) continue;
      seen.add(e.domain);
      out.push({ id: `direct:${e.domain}`, name: e.name, buyer: e.name, buyerType: e.segment === "k12" ? "school board" : null, url: e.procurementUrl || `https://${e.domain}/`, portalUrl: e.portalUrl, format: e.format, browser: !!e.browser, discover: !e.procurementUrl, country: COUNTRY[String(e.country ?? "").toLowerCase()] ?? null, render: e.browser ? "client" : "server" });
    }
  }
  return out;
}

const wordCount = (s) => String(s ?? "").split(/\s+/).filter(Boolean).length;
// Stored findings are published: no personal contact details, even from public notices.
export const redactContacts = (s) => String(s ?? "").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]").replace(/(?:\+?1[-.\s]?)?\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, "[phone]");

/**
 * The solicitation's key facts, from the notice, what the feed states outright and the
 * documents read, with the sources listed so every fact can be checked.
 */
function rfpFacts(c, now, blocked) {
  const docs = (c.docs ?? []).filter((d) => d.text);
  const notice = String(c.p.body ?? c.p.summary ?? "");
  const text = docs.length ? [notice, ...docs.map((d) => `\n\n===== ${d.name} =====\n${d.text}`)].join("") : "";
  const kd = extractKeyData(text || notice);
  if (!kd.contractTerm && c.p.contractStart && c.p.contractEnd) {
    const months = Math.round((new Date(c.p.contractEnd) - new Date(c.p.contractStart)) / (30.44 * 86400000));
    if (months > 0) kd.contractTerm = months % 12 === 0 ? `${months / 12} year${months === 12 ? "" : "s"}` : `${months} months`;
  }
  if (c.p.contractStart && c.p.contractEnd) kd.contractDates = `${c.p.contractStart} to ${c.p.contractEnd}`;
  if (!kd.evaluationBasis && c.p.selectionCriteria && !/not applicable/i.test(c.p.selectionCriteria)) kd.evaluationBasis = c.p.selectionCriteria;
  const KEEP = ["dates", "contractTerm", "contractDates", "renewals", "value", "evaluation", "evaluationBasis", "evaluationNote", "submission", "pageLimit", "copies", "validityDays", "references", "insurance"];
  const keyData = Object.fromEntries(KEEP.filter((k) => kd[k] != null && !(k === "dates" && !Object.keys(kd[k]).length)).map((k) => [k, kd[k]]));
  // Contract risks and the response items from the documents (not the date-driven ones, which change daily).
  const risks = flagRisks(text || notice, {}, now).filter((r) => !["closed", "short-timeline", "no-close-date"].includes(r.id)).map((r) => ({ ...r, evidence: redactContacts(r.evidence).slice(0, 220) }));
  const reqs = docs.length ? mapRequirements(text, 400) : [];
  const rank = { question: 0, mandatory: 1, desirable: 2 };
  const requirements = reqs.slice().sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 60).map((r) => ({ ...r, text: redactContacts(r.text).slice(0, 320) }));
  for (const k of ["renewals", "evaluationNote"]) if (keyData[k]) keyData[k] = redactContacts(keyData[k]);
  return {
    facts: {
      readAt: now.toISOString(),
      sources: [
        { kind: "notice", url: c.p.url ?? null, words: wordCount(notice) },
        ...(c.docs ?? []).map((d) => ({ kind: "document", name: d.name, url: safeLink(d.url, blocked), pages: d.pages ?? null, words: d.words ?? 0, ...(d.error ? { error: d.error } : {}) })),
      ],
      keyData,
      risks,
      requirements,
      requirementCounts: reqs.length ? { total: reqs.length, mandatory: reqs.filter((r) => r.level === "mandatory").length, questions: reqs.filter((r) => r.level === "question").length } : null,
      fullText: docs.length > 0,
      words: wordCount(text || notice),
      notes: c.docNotes ?? [],
    },
    text: text ? text.slice(0, 600000) : null,
  };
}

export async function runSweep(tenantId, industryId, opts = {}) {
  const { width = 2, direct = false, detail = true, documents = process.env.RFP_DOCUMENTS !== "0", browser = process.env.RFP_BROWSER !== "0", fetchImpl = fetch, now = new Date(), log = () => {}, source = "cli", capabilities = [], geography = null, sinceDays = null, matrix, profileTerms = null, docsRead = null } = opts;
  const baseTenant = loadTenant(tenantId);
  // A search can narrow geography without touching the tenant file.
  const geo = GEOGRAPHIES.find((g) => g.id === geography);
  const tenant = geo ? { ...baseTenant, geography: geo.countries } : baseTenant;
  if (!tenant.industries.includes(industryId)) throw new Error(`${tenant.name} does not subscribe to "${industryId}". It subscribes to: ${tenant.industries.join(", ")}`);
  // A company profile adds its own capabilities and terms to the search (lib/profile.mjs profileSearch).
  const pack = packForSearch(effectivePack(loadPack(industryId), tenant), [...capabilities, ...(profileTerms?.capabilities ?? [])], profileTerms);
  const { run: channels, skipped } = resolveChannels(pack, loadRegistry(), tenant, width);
  // Verified portal entries (a procurementUrl) are swept every run when the pack says so;
  // discovering procurement pages from home pages still needs --direct.
  const directs = directChannels(pack, tenant).filter((c) => direct || (pack.directSites?.alwaysSweep && !c.discover));
  const targets = [...channels, ...directs];
  if (!targets.length) throw new Error(`No channels resolved for ${tenantId}/${industryId}. Skipped: ${skipped.join("; ")}`);
  log(`${tenant.name} / ${pack.name}: ${channels.length} portal(s)${direct ? ` + ${targets.length - channels.length} direct site(s)` : ""}, width ${width}`);

  const blocked = tenant.guard?.extraBlockedHosts ?? [];
  const results = await pool(targets, 6, async (ch) => {
    // SAM.gov search: one query per search term, results merged.
    if (ch.format === "sam-sgs") {
      // The capability-led pack also takes the newest notices (blank query), so the raw set is broad.
      const terms = [...(pack.id === "any" ? [""] : []), ...(pack.searchTerms?.length ? pack.searchTerms : pack.qualifiers.titleKeywords.slice(0, 4))].slice(0, 8);
      const seen = new Set(), merged = [];
      let lastErr = null;
      for (const t of terms) {
        const u = `${ch.url}?index=opp&page=0&size=100&is_active=true&sort=-modifiedDate&qMode=ALL&q=${encodeURIComponent(t)}`;
        const r = await get(u, fetchImpl, blocked);
        if (r.error) { lastErr = r.error; continue; }
        for (const x of r.body?._embedded?.results ?? []) if (!seen.has(x._id)) { seen.add(x._id); merged.push(x); }
      }
      const x = extractPostings(ch, { results: merged }, merged.length ? null : lastErr);
      log(`  ${x.status.padEnd(13)} ${ch.id}  ${x.postings.length} notice(s) from ${terms.length} search(es)`);
      return x;
    }
    if (ch.requiresAccount) {
      log(`  needs-account ${ch.id}  (sign-in required; not logged in by design)`);
      return { channel: ch.id, status: "needs-account", detail: "search requires a sign-in; the sweeper does not log in or enter credentials", postings: [] };
    }
    // Portals that render listings with JavaScript: open them in a real (headless) browser.
    const wantsBrowser = ch.browser || ch.render === "client" || ch.render === "mixed";
    if (wantsBrowser && browser && fetchImpl === fetch && (await browserAvailable())) {
      const base = ch.searchUrl || ch.url;
      const urls = ch.keywordParam
        ? [...(pack.id === "any" ? [""] : []), ...(pack.searchTerms?.length ? pack.searchTerms : pack.qualifiers.titleKeywords.slice(0, 4))].slice(0, 6).map((t) => (t ? `${base}${base.includes("?") ? "&" : "?"}${ch.keywordParam}=${encodeURIComponent(t)}` : base))
        : [base];
      // One page at a time with a pause, and one retry: portals rate-limit rapid keyword searches.
      const pages = [];
      for (const [i, u] of urls.entries()) {
        if (i) await new Promise((r) => setTimeout(r, 2500));
        let p = await renderPage(u, { blocked });
        if (!p.body && /HTTP (405|429|503)/.test(p.error ?? "")) { await new Promise((r) => setTimeout(r, 8000)); p = await renderPage(u, { blocked }); }
        pages.push(p);
      }
      const ok = pages.filter((p) => p.body);
      if (!ok.length) {
        const p = pages[0];
        log(`  ${String(p.status).padEnd(13)} ${ch.id}  (browser) ${p.error ?? ""}`);
        return { channel: ch.id, status: p.status ?? "fetch-failed", detail: `browser: ${p.error}`, postings: [] };
      }
      const seen = new Set(), postings = [];
      for (const p of ok) for (const x of extractPostings(ch, p.body, null).postings) if (!seen.has(x.url + x.title)) { seen.add(x.url + x.title); postings.push(x); }
      log(`  ${(postings.length ? "ok" : "empty").padEnd(13)} ${ch.id}  ${postings.length} link(s) via browser from ${ok.length} page(s)`);
      return { channel: ch.id, status: postings.length ? "ok" : "empty", postings, viaBrowser: true };
    }
    let r = await get(ch.searchUrl || ch.url, fetchImpl, blocked);
    // A watch-list domain with no known procurement page: follow its own links to one.
    if (ch.discover && !r.error) {
      const links = procurementLinks(ch.url, r.body).filter((u) => safeLink(u, blocked));
      if (!links.length) return { channel: ch.id, status: "empty", detail: "no procurement page linked from the home page", postings: [] };
      const pages = await Promise.all(links.map((u) => get(u, fetchImpl, blocked)));
      const merged = pages.map((p) => (p.error ? "" : String(p.body))).join("\n");
      r = { body: merged, error: pages.every((p) => p.error) ? pages[0].error : null };
    }
    const x = extractPostings(ch, r.body, r.error);
    log(`  ${x.status.padEnd(13)} ${ch.id}  ${x.postings.length} link(s)`);
    return x;
  });

  const findings = [];
  const texts = {};
  const gaps = [];
  let postingsSeen = 0;
  const candidates = [];
  for (const x of results) {
    postingsSeen += x.postings.length;
    // A direct site with nothing on it is normal, not a coverage gap.
    if (x.status !== "ok" && !(String(x.channel).startsWith("direct:") && x.status === "empty")) gaps.push({ channel: x.channel, status: x.status, detail: x.detail ?? null });
    for (const raw of x.postings) {
      // A link into an internal tool is never stored or shown, whatever the portal pointed at.
      const p = { ...raw, url: safeLink(raw.url, blocked) };
      const s = score(p, pack, tenant);
      if (s.band === "dropped" || s.band === "no bid") continue;
      // An industry claims a posting only when the buyer is that kind of buyer
      // (or unknown). A city ERP found while sweeping K-12 belongs to "any industry".
      if (BUYER_HINTS[pack.id] && p.buyer && !buyerMatches(p, pack)) continue;
      candidates.push({ p, s, channel: x.channel });
    }
  }

  // Read each candidate's own posting page: close date, question deadline,
  // requirements, incumbent, competitors, and a hash for addenda detection.
  // Then score again on what the page actually says.
  const limit = detail ? (tenant.detailPagesPerRun ?? 40) : 0;
  const toRead = candidates.filter((c) => c.p.url && !c.p.body).sort((a, b) => b.s.total - a.s.total).slice(0, limit);
  if (toRead.length) log(`  reading ${toRead.length} posting page(s)`);
  const browserChannels = new Set(results.filter((x) => x.viaBrowser).map((x) => x.channel));
  await pool(toRead, 4, async (c) => {
    const r = browserChannels.has(c.channel) ? await renderPage(c.p.url, { blocked, timeoutMs: 30000 }) : await get(c.p.url, fetchImpl, blocked);
    if (r.error || typeof r.body !== "string") { c.detailError = r.error ?? "not an HTML page"; return; }
    const d = analyzeDetail(r.body, tenant, { title: c.p.title });
    c.html = r.body; // kept in memory only, to find the solicitation documents it links to
    c.p = { ...c.p, body: d.body, closeDate: c.p.closeDate ?? d.closeDate, incumbent: c.p.incumbent ?? d.incumbent, keyDates: d.keyDates, requirements: d.requirements, competitors: d.competitors, contentHash: d.contentHash };
    c.s = score(c.p, pack, tenant);
  });

  // Structured feeds already carry the full description: enrich from it directly.
  for (const c of candidates.filter((c) => c.p.body && !c.p.contentHash)) {
    const d = analyzeDetail(c.p.body, tenant, { title: c.p.title });
    c.p = { ...c.p, closeDate: c.p.closeDate ?? d.closeDate, incumbent: c.p.incumbent ?? d.incumbent, keyDates: d.keyDates, requirements: d.requirements, competitors: d.competitors, contentHash: d.contentHash };
    c.s = score(c.p, pack, tenant);
  }

  // Fetch the RFP with the posting: its public solicitation documents (SAM.gov attachments,
  // the CanadaBuys attachment list, document links on the posting page), read for the
  // questions deadline, budget, contract term and evaluation criteria. Never signs in.
  // `docsRead` (finding id → when its documents were last read): recent readings are kept, not fetched again.
  const docLimit = detail && documents ? Number(process.env.RFP_DOCUMENTS_PER_RUN ?? tenant.documentsPerRun ?? 30) : 0;
  const recent = (c) => { const at = docsRead?.[findingId(tenant.id, c.p)]; return at && now - new Date(at) < 3 * 86400000; };
  const docCands = candidates.filter((c) => c.s.band !== "dropped" && c.s.band !== "no bid" && !recent(c)).sort((a, b) => b.s.total - a.s.total).slice(0, docLimit);
  if (docCands.length) log(`  reading solicitation documents for ${docCands.length} posting(s)`);
  await pool(docCands, 3, async (c) => {
    const samId = c.p.noticeId ?? String(c.p.url ?? "").match(/sam\.gov\/opp\/([a-f0-9]{16,40})\//i)?.[1];
    let links = samId ? await samAttachments(samId, { fetchImpl, blocked }) : c.p.attachments ? listedDocuments(c.p.attachments) : [];
    if (!links.length && c.html) links = documentLinks(c.html, c.p.url);
    const portal = accountPortal(c.p.url);
    if (!links.length) {
      c.docNotes = [portal ? `The solicitation documents are on ${portal}, which needs a supplier account. The sweeper does not sign in: download them there and load them in the workspace.` : "No public solicitation document is linked from the notice."];
      return;
    }
    c.docs = await readDocuments(links, { fetchImpl, blocked, max: 3 });
    const failed = c.docs.filter((d) => d.error);
    if (failed.length) c.docNotes = failed.map((d) => `${d.name}: not read (${d.error}).`);
  });
  for (const c of candidates) if (c.docs || c.docNotes || c.p.contractStart || c.p.selectionCriteria) c.rfp = rfpFacts(c, now, blocked);

  // Date range: postings published before the window are dropped; unknown dates are kept and flagged.
  const since = sinceDays ? new Date(now.getTime() - sinceDays * 86400000).toISOString().slice(0, 10) : null;
  let tooOld = 0;
  if (since) {
    for (const c of candidates) if (c.p.publishedDate && c.p.publishedDate < since) { c.s.band = "no bid"; tooOld++; }
  }
  // Capability filter: when capabilities are chosen, a posting must actually ask for one of them.
  for (const c of candidates) {
    c.caps = matchCapabilities(c.p.title, `${c.p.summary ?? ""} ${c.p.body ?? ""}`);
    if (capabilities.length && !c.caps.some((m) => capabilities.includes(m.id))) c.s.band = "no bid";
  }

  const library = [...(loadData(`library/${tenant.id}.json`)?.entries ?? []), ...(loadData("library/knowledge.json")?.entries ?? [])];
  const byId = new Map();
  for (const c of candidates) {
    if (c.s.band === "dropped" || c.s.band === "no bid") continue;
    const matched = c.s.band === "pursue" ? matchLibrary(library, `${c.p.title} ${c.p.body ?? ""}`, pack.id, 6, now) : [];
    const f = draftFinding({ ...c.p, body: undefined }, c.s, pack, tenant, c.channel, now, matched);
    f.capabilities = c.caps.map(({ id, label, matched }) => ({ id, label, matched }));
    // The buyer's industry, from the organization that published it (inferred, with its basis).
    f.sector = classifySector({ buyer: c.p.buyer, buyerType: c.p.buyerType, source: c.channel });
    f.team = recommendTeam(c.caps, matrix);
    if (since && !c.p.publishedDate) f.flags = [...f.flags, "publish date unknown; kept despite the date filter"];
    // Keep the posting text so the analyzer can run on the finding later.
    if (c.p.body) f.sourceText = redactContacts(c.p.body).slice(0, 15000);
    // What the solicitation itself says, read with the posting. The full text is returned
    // separately (run.texts) and stored beside the ledger, not in it.
    if (c.rfp) {
      f.rfp = c.rfp.facts;
      const kd = c.rfp.facts.keyData;
      f.keyDates = { ...(kd.dates ?? {}), ...(f.keyDates ?? {}) };
      if (!f.closeDate && kd.dates?.closing) f.closeDate = kd.dates.closing;
      if (f.estimatedValue == null && kd.value?.amount) f.estimatedValue = kd.value.amount;
      if (c.rfp.text) texts[f.id] = c.rfp.text;
    }
    if (c.detailError) f.flags = [...f.flags, `posting page not read: ${c.detailError}`];
    const prev = byId.get(f.id);
    if (!prev || prev.score < f.score) byId.set(f.id, f);
  }
  findings.push(...byId.values());
  findings.sort((a, b) => b.score - a.score);
  for (const id of Object.keys(texts)) if (!byId.has(id)) delete texts[id];

  const cap = tenant.safety?.maxNewPursuePerRun ?? 15;
  const pursue = findings.filter((f) => f.band === "pursue").length;
  const halted = pursue > cap;
  return {
    tenant, pack, industry: pack.id, source,
    channelsRead: targets.length, postingsSeen, skipped, tooOld,
    // Every real posting seen (structured sources, or listings with dates), so a company
    // profile can be matched against all of them, not only what the packs kept.
    raw: results.flatMap((x) => x.postings.filter((p) => p.structured || p.closeDate || p.publishedDate).map((p) => ({
      title: String(p.title).slice(0, 240), buyer: p.buyer ?? null, country: p.country ?? null, url: safeLink(p.url, blocked), channel: x.channel, sourceId: p.sourceId || null,
      closeDate: p.closeDate ?? null, publishedDate: p.publishedDate ?? null, summary: String(p.summary ?? p.body ?? "").slice(0, 400), noticeType: p.noticeType ?? null,
    }))).filter((p) => p.title.length >= 12),
    lowFit: candidates.filter((c) => c.s.band === "no bid").length,
    texts,
    findings: halted ? [] : findings,
    wouldHaveAdded: findings.length,
    gaps,
    halted,
    haltReason: halted ? `${pursue} postings scored "pursue", over the cap of ${cap}. Nothing was added. This usually means a qualifier is too loose, not that the market tripled.` : null,
    caveat: pack.status !== "proven" ? `Industry pack "${pack.id}" is ${pack.status}. Its yield is not comparable to a proven pack.` : null,
  };
}
