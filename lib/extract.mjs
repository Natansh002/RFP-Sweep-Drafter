/**
 * Normalise whatever a channel returned into one posting shape.
 *
 * Portals differ wildly: some serve JSON, most serve HTML, several are
 * client-rendered and return an empty body to a plain fetch. That last case is
 * not an error and must not be reported as "no opportunities" — it is reported
 * as "needs-browser", which is a different fact.
 *
 * Deliberately crude. The scorer does the deciding, and a per-portal parser is a
 * maintenance burden that rots the moment the portal redesigns.
 *
 * Import-free on purpose: build-workflows.mjs inlines it into the n8n Code nodes.
 */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: "…", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç" };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

const blankPosting = (ch) => ({
  sourceId: null, title: "", summary: "", buyer: null, buyerType: null,
  country: ch.country ?? null, closeDate: null, estimatedValue: null, incumbent: null, url: ch.url,
});

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  const s = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...data] = rows;
  return data.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const stripHtml = (h) => decode(String(h ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Structured feeds: full descriptions, real buyers and closing dates. */
const FORMATS = {
  // MERX listing rows, rendered by the browser step. One row per solicitation.
  "merx-html"(ch, body) {
    const out = [];
    const rows = String(body ?? "").split(/<tr\b[^>]*class="[^"]*mets-table-row/).slice(1);
    const pick = (row, cls) => { const m = row.match(new RegExp(`class="${cls}(?:\\s[^"]*)?"[^>]*>([\\s\\S]*?)</span>`)); return m ? stripHtml(m[1]) : ""; };
    const date = (row, cls) => { const m = row.match(new RegExp(`class="${cls}(?:\\s[^"]*)?"[\\s\\S]{0,5000}?(20\\d\\d)/(\\d\\d)/(\\d\\d)`)); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
    for (const row of rows) {
      const href = row.match(/<a[^>]+class="[^"]*solicitation-link[^"]*"[^>]*href="([^"]+)"|<a[^>]+href="([^"]+)"[^>]*class="[^"]*solicitation-link/);
      const title = pick(row, "rowTitle");
      if (!title) continue;
      let url = ch.url;
      try { url = new URL(href?.[1] ?? href?.[2] ?? "", "https://www.merx.com").href; } catch { /* keep channel url */ }
      const location = pick(row, "location");
      out.push({
        ...blankPosting(ch),
        title,
        buyer: pick(row, "buyer-name") || null,
        country: /\bUSA?\b|United States/.test(location) ? "US" : /\bCAN\b|Canada/.test(location) ? "CA" : ch.country ?? null,
        region: location || null,
        publishedDate: date(row, "publicationDate"),
        closeDate: date(row, "closingDate"),
        url,
      });
    }
    return out;
  },

  "canadabuys-csv"(ch, body) {
    return parseCsv(body)
      .filter((r) => !/award|cancel|expired/i.test(r["tenderStatus-appelOffresStatut-eng"] ?? ""))
      .map((r) => {
        const desc = stripHtml(r["tenderDescription-descriptionAppelOffres-eng"]);
        return {
          ...blankPosting(ch),
          sourceId: r["referenceNumber-numeroReference"] || null,
          title: r["title-titre-eng"] || r["title-titre-fra"] || "",
          summary: desc.slice(0, 600),
          body: desc.slice(0, 20000),
          buyer: r["contractingEntityName-nomEntitContractante-eng"] || null,
          buyerType: r["endUserEntitiesName-nomEntitesUtilisateurFinal-eng"] || null,
          closeDate: (r["tenderClosingDate-appelOffresDateCloture"] || "").slice(0, 10) || null,
          url: r["noticeURL-URLavis-eng"] || ch.url,
          publishedDate: (r["publicationDate-datePublication"] || "").slice(0, 10) || null,
          noticeType: r["noticeType-avisType-eng"] || null,
          region: r["regionsOfDelivery-regionsLivraison-eng"] || null,
        };
      });
  },
  "sam-sgs"(ch, body) {
    const results = body?.results ?? body?._embedded?.results ?? [];
    return results
      .filter((r) => !/award|justification|sale of surplus/i.test(r.type?.value ?? ""))
      .map((r) => {
        const desc = stripHtml((r.descriptions ?? []).map((d) => d.content).join(" "));
        const org = (r.organizationHierarchy ?? []).map((o) => o.name).filter(Boolean);
        return {
          ...blankPosting(ch),
          sourceId: r.solicitationNumber || r._id || null,
          title: r.title ?? "",
          summary: desc.slice(0, 600),
          body: desc.slice(0, 20000),
          buyer: org[org.length - 1] ?? org[0] ?? null,
          buyerType: org[0] ?? null,
          closeDate: (r.responseDate ?? "").slice(0, 10) || null,
          url: r._id ? `https://sam.gov/opp/${r._id}/view` : ch.url,
          publishedDate: (r.publishDate ?? "").slice(0, 10) || null,
          noticeType: r.type?.value ?? null,
        };
      });
  },
};

export function extractPostings(channel, body, error) {
  const ch = channel ?? {};
  if (!error && FORMATS[ch.format]) {
    try {
      const postings = FORMATS[ch.format](ch, body);
      return { channel: ch.id, status: postings.length ? "ok" : "empty", postings };
    } catch (e) {
      return { channel: ch.id, status: "fetch-failed", detail: `could not parse ${ch.format}: ${e.message}`.slice(0, 300), postings: [] };
    }
  }
  if (error && /^Blocked:/.test(String(error))) return { channel: ch.id, status: "blocked", detail: String(error).slice(0, 300), postings: [] };
  if (error) return { channel: ch.id, status: "fetch-failed", detail: String(error).slice(0, 300), postings: [] };

  // JSON channels (SAM.gov and anything with a real API)
  if (body && typeof body === "object") {
    const rows = body.opportunitiesData ?? body.results ?? body.items ?? [];
    return {
      channel: ch.id,
      status: rows.length ? "ok" : "empty",
      postings: rows.map((r) => ({
        ...blankPosting(ch),
        sourceId: r.noticeId ?? r.id ?? null,
        title: r.title ?? r.name ?? "",
        summary: r.description ?? r.summary ?? "",
        buyer: r.organizationName ?? r.agency ?? r.buyer ?? null,
        closeDate: r.responseDeadLine ?? r.closeDate ?? r.closingDate ?? null,
        estimatedValue: r.awardAmount ?? r.estimatedValue ?? null,
        url: r.uiLink ?? r.url ?? ch.url,
      })),
    };
  }

  const html = String(body ?? "");
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const text = stripped.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  // A client-rendered portal returns a shell. Say so rather than claiming zero.
  if (text.length < 400 && ch.render === "client") {
    return { channel: ch.id, status: "needs-browser", detail: "client-rendered shell, no server-side content", postings: [] };
  }

  const links = [...stripped.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{3,220}?)<\/a>/gi)];
  const seen = new Set();
  const postings = [];
  for (const [, href, label] of links) {
    const title = decode(label.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (title.length < 12 || seen.has(title)) continue;
    seen.add(title);
    let url;
    try { url = new URL(href, ch.url).href; } catch (e) { continue; }
    postings.push({ ...blankPosting(ch), title, buyer: ch.buyer ?? null, buyerType: ch.buyerType ?? null, url });
  }
  return { channel: ch.id, status: postings.length ? "ok" : "empty", postings };
}

/** Links on a buyer's own site that probably lead to its procurement page. */
export function procurementLinks(baseUrl, html, limit = 2) {
  const out = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{2,120}?)<\/a>/gi;
  const want = /\b(rfp|rfq|rfi|tenders?|procurement|bids?|bidding|purchasing|solicitations?|opportunities)\b/i;
  for (const [, href, label] of String(html ?? "").matchAll(re)) {
    const text = label.replace(/<[^>]+>/g, " ");
    if (!want.test(text) && !want.test(href)) continue;
    try {
      const u = new URL(href, baseUrl);
      if (!/^https?:$/.test(u.protocol) || out.includes(u.href)) continue;
      out.push(u.href);
    } catch (e) { /* skip */ }
    if (out.length >= limit) break;
  }
  return out;
}

export default { parseCsv, extractPostings, procurementLinks };
