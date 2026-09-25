/**
 * Solicitation documents: fetch the RFP along with the posting.
 *
 * Finds the public documents attached to a posting (links on its page, the
 * CanadaBuys feed's attachment list, SAM.gov's public attachment API), downloads
 * them through the guard and reads their text (PDF, Word, plain text), so the
 * questions deadline, budget, contract term and evaluation criteria come in with
 * the RFP instead of being left as "information still required".
 *
 * Never signs in. A portal whose documents need a supplier account is named in
 * the result, not bypassed. Node only: PDFs are read with pdfjs-dist, Word files
 * with mammoth.
 */
import { assertAllowedUrl } from "./guard.mjs";

const UA = "Mozilla/5.0 (compatible; ionic-rfp-sweeper/0.2; +procurement monitoring)";
export const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PAGES = 150;

const DOC_EXT = /\.(pdf|docx|txt)$/i;
// What a proposal team reads first; price sheets, forms and drawings add little to the key facts.
const USEFUL = /\b(rfp|rfq|rfi|rfsq|rfsa|rfo|solicitation|request for|tender|itt|invitation|terms of reference|statement of work|sow|scope|specification|requirements|instructions|bid (?:document|solicitation)|proposal|addend\w*|amendment|part \d|section|annex|appendix|evaluation)\b/i;
const SKIP = /\b(pric\w*|cost|bid form|form of (?:bid|tender|offer)|declaration|drawings?|site plan|map|logo|attestation|affidavit|certificate|signature page|insurance form|wage|questionnaire|q&a register)\b|\.xlsx?\b/i;

/** Portals whose documents need a supplier account: reported by name, never signed into. */
const ACCOUNT_PORTALS = [
  [/(^|\.)merx\.com$/i, "MERX"], [/bidsandtenders\./i, "bids&tenders"], [/bonfirehub\.(com|ca)$/i, "Bonfire"], [/biddingo\.com$/i, "Biddingo"],
  [/bcbid\.gov\.bc\.ca$/i, "BC Bid"], [/jaggaer|ontario\.ca$/i, "Ontario Tenders"], [/purchasingconnection\.ca$/i, "Alberta Purchasing Connection"], [/ariba\.com$/i, "SAP Ariba"],
];
export function accountPortal(url) {
  try { const host = new URL(url).hostname; return ACCOUNT_PORTALS.find(([re]) => re.test(host))?.[1] ?? null; } catch { return null; }
}

const rank = (label, url) => (USEFUL.test(label) ? 2 : 0) - (SKIP.test(label) ? 3 : 0) + (/\.pdf\b/i.test(label + url) ? 0.5 : 0);

/** Links on a posting page that point at solicitation documents, most useful first. */
export function documentLinks(html, pageUrl, max = 4) {
  const out = [], seen = new Set();
  for (const m of String(html ?? "").matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    let u;
    try { u = new URL(m[1].replace(/&amp;/g, "&"), pageUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    let file = u.pathname.split("/").pop() || "";
    try { file = decodeURIComponent(file); } catch { /* keep */ }
    const isDoc = DOC_EXT.test(u.pathname) || (/(download|attachment|document|file)/i.test(u.pathname + u.search) && /\.(pdf|docx)\b/i.test(`${text} ${file}`));
    if (!isDoc) continue;
    const key = u.href;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = (text && text.length <= 120 && !/^(download|view|open|here|pdf)$/i.test(text) ? text : file).slice(0, 120);
    out.push({ url: key, name, s: rank(`${text} ${file}`, key) });
  }
  return out.filter((d) => d.s > -2).sort((a, b) => b.s - a.s).slice(0, max);
}

/** Attachment URLs listed in a feed (CanadaBuys: comma-separated), most useful first. */
export function listedDocuments(list, max = 4) {
  const urls = String(list ?? "").split(/[,\s]+/).filter((u) => /^https?:\/\//i.test(u));
  return urls.map((url) => { let file = url.split("/").pop(); try { file = decodeURIComponent(file); } catch { /* keep */ } return { url, name: file.slice(0, 120), s: rank(file, url) }; })
    .filter((d) => d.s > -2).sort((a, b) => b.s - a.s).slice(0, max);
}

async function guardedFetch(url, { fetchImpl = fetch, blocked = [], timeoutMs = 45000, accept = "*/*" } = {}) {
  assertAllowedUrl(url, blocked);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res, at = url;
    // Follow redirects by hand so every hop passes the guard before it is requested.
    for (let hop = 0; hop < 6; hop++) {
      res = await fetchImpl(at, { headers: { "user-agent": UA, accept }, redirect: "manual", signal: ctl.signal });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!loc) break;
      at = assertAllowedUrl(new URL(loc, at).href, blocked);
    }
    return { res, finalUrl: at, ctl };
  } finally {
    clearTimeout(t);
  }
}

/** SAM.gov: a notice's public attachments, from its public API (no key, no sign-in). */
export async function samAttachments(noticeId, { fetchImpl = fetch, blocked = [], max = 4 } = {}) {
  if (!/^[a-f0-9]{16,40}$/i.test(String(noticeId ?? ""))) return [];
  try {
    const { res } = await guardedFetch(`https://sam.gov/api/prod/opps/v3/opportunities/${noticeId}/resources?excludeDeleted=true&withScanResult=false`, { fetchImpl, blocked, accept: "application/hal+json, application/json;q=0.9", timeoutMs: 20000 });
    if (!res.ok) return [];
    const j = await res.json();
    const files = (j?._embedded?.opportunityAttachmentList ?? []).flatMap((x) => x.attachments ?? [])
      .filter((a) => a.type === "file" && a.accessLevel === "public" && a.fileExists !== "0" && a.deletedFlag !== "1" && /\.(pdf|docx|txt)$/i.test(a.name ?? "") && (a.size ?? 0) <= MAX_BYTES);
    return files.map((a) => ({ url: `https://sam.gov/api/prod/opps/v3/opportunities/resources/files/${a.resourceId}/download`, name: String(a.name).slice(0, 120), s: rank(a.name, "") + (a.attachmentOrder === 1 ? 0.5 : 0) }))
      .filter((d) => d.s > -2).sort((a, b) => b.s - a.s).slice(0, max);
  } catch {
    return [];
  }
}

const isPdf = (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
const isZip = (b) => b[0] === 0x50 && b[1] === 0x4b; // PK (docx)

/** Download one document through the guard, refusing anything over maxBytes. */
export async function fetchDocument(url, { fetchImpl = fetch, blocked = [], maxBytes = MAX_BYTES, timeoutMs = 45000 } = {}) {
  try {
    const { res } = await guardedFetch(url, { fetchImpl, blocked, timeoutMs });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > maxBytes) return { error: `too large (${Math.round(len / 1048576)} MB)` };
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.length > maxBytes) return { error: `too large (${Math.round(buffer.length / 1048576)} MB)` };
    const cd = res.headers.get("content-disposition") ?? "";
    let name = cd.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? cd.match(/filename="?([^";]+)"?/i)?.[1] ?? "";
    try { name = decodeURIComponent(name); } catch { /* keep */ }
    return { buffer, type: res.headers.get("content-type") ?? "", name };
  } catch (e) {
    return { error: /^Blocked:/.test(e.message) ? e.message : e.name === "AbortError" ? "timed out" : e.message };
  }
}

/** Text of a PDF, Word or plain-text document, with line breaks kept. */
export async function documentText(buffer, { type = "", name = "" } = {}) {
  const kind = isPdf(buffer) ? "pdf" : isZip(buffer) && /\.docx$|wordprocessingml/i.test(`${name} ${type}`) ? "docx" : /^text\/plain|\.txt$/i.test(`${type} ${name}`) ? "text" : null;
  if (!kind) return { error: /html/i.test(type) ? "a web page, not a document (probably a sign-in page)" : `not a PDF, Word or text file (${type || name || "unknown type"})` };
  if (kind === "text") return { kind, text: new TextDecoder().decode(buffer), pages: null };
  if (kind === "docx") {
    const mammoth = (await import("mammoth")).default;
    const r = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    return { kind, text: r.value, pages: null };
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js takes ownership of the bytes it is given: hand it a copy.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const lines = [];
  const n = Math.min(doc.numPages, MAX_PAGES);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let lastY = null, line = "";
    for (const it of tc.items) {
      const y = it.transform?.[5];
      if (lastY != null && Math.abs(y - lastY) > 2 && line.trim()) { lines.push(line); line = ""; }
      line += it.str ?? "";
      if (it.hasEOL && line.trim()) { lines.push(line); line = ""; }
      lastY = y;
    }
    if (line.trim()) lines.push(line);
    lines.push("");
    page.cleanup?.();
  }
  await doc.destroy?.();
  return { kind, text: lines.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n"), pages: doc.numPages, pagesRead: n };
}

/**
 * Read up to `max` documents. Each result names the document and what was read,
 * or why it could not be: nothing is silently dropped.
 */
export async function readDocuments(docs, { fetchImpl = fetch, blocked = [], max = 3, maxChars = 400000 } = {}) {
  const out = [];
  let chars = 0;
  for (const d of docs.slice(0, max)) {
    const f = await fetchDocument(d.url, { fetchImpl, blocked });
    if (f.error) { out.push({ name: d.name, url: d.url, error: f.error }); continue; }
    let t;
    try { t = await documentText(f.buffer, { type: f.type, name: f.name || d.name }); } catch (e) { t = { error: `could not read: ${e.message}` }; }
    if (t.error) { out.push({ name: f.name || d.name, url: d.url, error: t.error }); continue; }
    const text = t.text.slice(0, Math.max(0, maxChars - chars));
    chars += text.length;
    // The listed name is cleaner than a download header ("SOW+v2.pdf").
    const name = (/\.[a-z]{3,4}$/i.test(d.name ?? "") ? d.name : (f.name || d.name || "").replace(/\+/g, " ")).slice(0, 120);
    out.push({ name, url: d.url, kind: t.kind, pages: t.pages ?? null, words: text.split(/\s+/).filter(Boolean).length, text });
    if (chars >= maxChars) break;
  }
  return out;
}

export default { accountPortal, documentLinks, listedDocuments, samAttachments, fetchDocument, documentText, readDocuments, MAX_BYTES };
