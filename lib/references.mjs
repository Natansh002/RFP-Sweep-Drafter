/**
 * Reference library: articles about your offering and your past RFP responses,
 * split into passages the drafter can cite.
 *
 * A past response is split into question → answer pairs ("3.1 Describe your
 * approach…" followed by the answer). An article or brochure is split into
 * topics (a heading and the paragraphs under it). Passages are starting points,
 * not approved answers: an answer drafted from one is always marked for SME review.
 * Contact emails and phone numbers are removed.
 *
 * Import-free: the browser bundle inlines it.
 */

const NUM = /^(?:(?:\d+(?:\.\d+){0,4}|[A-Z]\.\d+(?:\.\d+)*|Q\s?\d+)[.):]?\s+)/i;
const ASK = /^(describe|explain|provide|outline|detail|identify|confirm|demonstrate|list|how|what|which|who|when|where|why|does|do|can|will|is|are|please|indicate|summari[sz]e|discuss|specify|state|include)\b/i;
const today = () => new Date().toISOString().slice(0, 10);
const words = (s) => String(s).split(/\s+/).filter(Boolean).length;
const redact = (s) => String(s ?? "").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]").replace(/(?:\+?1[-.\s]?)?\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, "[phone]");
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; return h.toString(36); }
const cap = (s, n) => { const w = String(s).split(/\s+/); return w.length > n ? `${w.slice(0, n).join(" ")}…` : String(s); };

/** Is this line a question or requirement a response answers? */
function isQuestion(line) {
  if (line.length < 15 || line.length > 400) return false;
  if (/\?$/.test(line)) return true;
  const rest = line.replace(NUM, "");
  return rest !== line ? ASK.test(rest) : ASK.test(line) && line.length <= 300 && /[.:]$|^(describe|explain|provide|outline)\b/i.test(line);
}
const isHeading = (l) => l.length >= 3 && l.length <= 90 && !/[.;,:!?]$/.test(l) && /^[A-Z0-9]/.test(l) && words(l) <= 12;

/**
 * Passages from one reference: question → answer pairs when it reads like a past
 * response, otherwise topics (heading + paragraphs). `source` is the link or file name.
 */
export function passagesFromText(text, { source = "", title = "", addedAt = today() } = {}) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  const id = (i) => `ref-${fnv(source || title || text.slice(0, 200))}-${i}`;
  const make = (question, answer, i, shape) => ({ id: id(i), question: redact(cap(question, 60)), answer: redact(cap(answer, 450)), source, title: title || source, kind: "reference", shape, approved: false, lastReviewed: addedAt });

  // 1. Past responses: a question line, then its answer until the next question.
  const pairs = [];
  let cur = null;
  for (const l of lines) {
    if (!l) { if (cur) cur.answer += "\n"; continue; }
    if (isQuestion(l)) { if (cur) pairs.push(cur); cur = { question: l, answer: "" }; }
    else if (cur) cur.answer += `${cur.answer && !cur.answer.endsWith("\n") ? " " : ""}${l}`;
  }
  if (cur) pairs.push(cur);
  const qa = pairs.map((p) => ({ ...p, answer: p.answer.replace(/\n+/g, "\n").trim() })).filter((p) => words(p.answer) >= 15);
  if (qa.length >= 2) return qa.slice(0, 400).map((p, i) => make(p.question, p.answer, i, "question"));

  // 2. Articles and brochures: a heading and the paragraphs under it, in chunks of up to ~220 words.
  const out = [];
  let heading = title || "", buf = [];
  const flush = () => {
    const body = buf.join(" ").trim();
    buf = [];
    if (words(body) < 15) return;
    const first = body.split(/(?<=[.!?])\s+/)[0];
    out.push(make(heading || first, body, out.length, "topic"));
  };
  for (const l of lines) {
    if (!l) { if (words(buf.join(" ")) >= 60) flush(); continue; }
    if (isHeading(l) && !buf.length) { heading = l; continue; }
    if (isHeading(l)) { flush(); heading = l; continue; }
    buf.push(l);
    if (words(buf.join(" ")) >= 220) flush();
  }
  flush();
  return out.slice(0, 400);
}

/** One stored reference: where it came from and its passages (or why it could not be read). */
export function makeReference({ source, title = "", kind, text = "", error = null, addedAt = today() }) {
  const passages = error ? [] : passagesFromText(text, { source, title, addedAt });
  return { id: `r-${fnv(source)}`, source, title: title || source, kind, addedAt, words: words(text), passages, error: error ?? (passages.length ? null : "No usable passages found (too short, or a scanned document without text).") };
}

/** Every passage in the library, as knowledge entries the drafter can cite. */
export const referenceKnowledge = (refs) => (refs ?? []).flatMap((r) => r.passages ?? []);

/** Links in a pasted block: one per line (or separated by spaces), http(s) only. */
export const linksIn = (text) => [...new Set(String(text ?? "").split(/\s+/).map((s) => s.trim().replace(/[),.;]+$/, "")).filter((s) => /^https?:\/\/[^\s]+$/i.test(s)))];

export default { passagesFromText, makeReference, referenceKnowledge, linksIn };
