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
const dmy = (s) => { const m = String(s ?? "").match(/(\d{2})\/(\d{2})\/(20\d\d)/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

const FORMATS = {
  // A school board's own bids&tenders portal: one "Bid Details - <title>" link per open bid.
  "bidsandtenders-html"(ch, body) {
    const out = [], seen = new Set();
    for (const [, href, label] of String(body ?? "").matchAll(/<a[^>]+href="([^"]*\/Tender\/Detail\/[^"#]+)"[^>]*>([\s\S]{3,400}?)<\/a>/gi)) {
      const text = stripHtml(label);
      const m = text.match(/^Bid Details - (.+?)(?: Bid Details)?$/i);
      if (!m) continue;
      let url; try { url = new URL(href, ch.url).href; } catch { continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ ...blankPosting(ch), title: m[1].trim(), buyer: ch.buyer ?? null, buyerType: ch.buyerType ?? null, url });
    }
    return out;
  },
  // Euna Procurement (Bonfire) public portal feed.
  "bonfire-json"(ch, body) {
    const projects = body?.payload?.projects ?? {};
    const portal = (ch.portalUrl ?? ch.url ?? "").replace(/\/(portal|PublicPortal).*$/, "");
    return Object.values(projects).map((p) => ({
      ...blankPosting(ch),
      sourceId: p.ReferenceID || String(p.ProjectID ?? ""),
      title: `${p.ReferenceID ? `${p.ReferenceID} ` : ""}${p.ProjectName ?? ""}`.trim(),
      buyer: ch.buyer ?? p.OrganizationName ?? null,
      buyerType: ch.buyerType ?? null,
      closeDate: String(p.DateClose ?? "").slice(0, 10) || null,
      publishedDate: String(p.DatePublished ?? p.DateOpen ?? "").slice(0, 10) || null,
      url: p.ProjectID && portal ? `${portal}/opportunities/${p.ProjectID}` : ch.portalUrl ?? ch.url,
    })).filter((x) => x.title);
  },
  // Ontario Tenders (JAGGAER) public guest list: status | buyer | - | title | published | category | closing.
  "jaggaer-html"(ch, body) {
    const out = [];
    for (const [, row] of String(body ?? "").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripHtml(c[1]));
      if (cells.length < 7 || !/^open$/i.test(cells[0]) || !cells[3]) continue;
      out.push({ ...blankPosting(ch), title: cells[3], buyer: cells[1] || null, publishedDate: dmy(cells[4]), closeDate: dmy(cells[6]), category: cells[5] || null, url: ch.searchUrl ?? ch.url });
    }
    return out;
  },

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
          // No notice link in the feed: link a CanadaBuys search for the reference, never the raw data file.
          url: r["noticeURL-URLavis-eng"] || (r["referenceNumber-numeroReference"] ? `https://canadabuys.canada.ca/en/tender-opportunities?search_filter=${encodeURIComponent(r["referenceNumber-numeroReference"])}` : "https://canadabuys.canada.ca/en/tender-opportunities"),
          publishedDate: (r["publicationDate-datePublication"] || "").slice(0, 10) || null,
          noticeType: r["noticeType-avisType-eng"] || null,
          region: r["regionsOfDelivery-regionsLivraison-eng"] || null,
          // The RFP's own facts, as the feed states them: public documents, contract dates, selection method.
          attachments: r["attachment-piecesJointes-eng"] || null,
          contractStart: (r["expectedContractStartDate-dateDebutContratPrevue"] || "").slice(0, 10) || null,
          contractEnd: (r["expectedContractEndDate-dateFinContratPrevue"] || "").slice(0, 10) || null,
          selectionCriteria: r["selectionCriteria-criteresSelection-eng"] || null,
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
          noticeId: r._id ?? null,
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
      // Structured sources are real listings: mark them so they reach the full posting list.
      const postings = FORMATS[ch.format](ch, body).map((p) => ({ ...p, structured: true }));
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

  // Card-style links are common on buyers' own sites: <a><h3>Title</h3><p>Posted …</p><span>closes …</span></a>.
  // Allow a long link body, take the title from its heading, and read the dates on the card.
  const links = [...stripped.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{3,3000}?)<\/a>/gi)];
  const seen = new Set();
  const postings = [];
  for (const [, href, label] of links) {
    const heading = label.match(/<(h[1-6]|strong|b)\b[^>]*>([\s\S]{3,300}?)<\/\1>/i)?.[2];
    const cardText = decode(label.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const title = (heading ? decode(heading.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : cardText).slice(0, 240);
    if (title.length < 12 || seen.has(title)) continue;
    seen.add(title);
    let url;
    try { url = new URL(href, ch.url).href; } catch (e) { continue; }
    const iso = label.match(/datetime="(20\d\d-\d\d-\d\d)/)?.[1] ?? null;
    postings.push({
      ...blankPosting(ch), title, buyer: ch.buyer ?? null, buyerType: ch.buyerType ?? null, url,
      summary: cardText !== title ? cardText.slice(0, 600) : "",
      publishedDate: cardDate(cardText, /posted|published|issued/i) ?? iso,
      closeDate: cardDate(cardText, /closes?|closing|due|deadline/i),
    });
  }
  return { channel: ch.id, status: postings.length ? "ok" : "empty", postings };
}

const MONTH = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** The first date after a label on a listing card: "Project closes Oct 16, 2026", "Posted 2026-08-17". */
function cardDate(text, label) {
  const m = String(text).match(new RegExp(`(?:${label.source})[^0-9A-Za-z]{0,20}([A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+20\\d\\d|20\\d\\d-\\d\\d-\\d\\d)`, "i"));
  if (!m) return null;
  if (/^20\d\d-/.test(m[1])) return m[1];
  const [, mon, d, y] = m[1].match(/([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(20\d\d)/) ?? [];
  return MONTH[mon?.toLowerCase()] ? `${y}-${String(MONTH[mon.toLowerCase()]).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
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
