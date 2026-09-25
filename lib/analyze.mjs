/**
 * RFP analyzer: five steps over one solicitation, optionally against a draft
 * proposal.
 *
 *   1. Requirement mapping      split into sections; every obligation statement,
 *                               tagged mandatory / desirable, with a category
 *   2. Compliance screening     for each requirement, is it addressed in the
 *                               proposal: addressed / partial / missing + evidence
 *   3. Analysis and scoring     fit, risk, timeline, coverage and an overall score,
 *                               every number with its reasons
 *   4. Data extraction & risks  dates, term, value, evaluation weights, submission
 *                               rules; red flags with severity and the sentence
 *   5. Summary                  a short evaluator summary in Markdown
 *
 * Deterministic. "Semantic" matching here is lexical similarity (TF-IDF cosine
 * over stemmed words), not a language model, and the output says so. It runs the
 * same in Node and in the browser (build bundles it with enrich.mjs); no file
 * leaves the machine it runs on.
 */
import { keyDates } from "./enrich.mjs";
import { companyFit } from "./profile.mjs";

const STOPWORDS = new Set(("a an the and or of to for in on at by with from as is are be been being will shall must should may can could would this that these those it its their our your we you they he she them his her " +
  "any all each such other than then there here into onto upon within without per via including include includes etc not no nor if when where which who whom whose what how also only more most less least very").split(" "));

// A few domain synonyms so "hosted in Canadian data centres" meets "stored in Canada".
const SYNONYMS = { canadian: "canada", american: "united", hosted: "store", hosting: "store", host: "store", stored: "store", storing: "store", centre: "center", centres: "center", staff: "employee", employees: "employee",
  personnel: "employee", vendor: "proponent", supplier: "proponent", contractor: "proponent", bidder: "proponent", respondent: "proponent", client: "customer", clients: "customer", customers: "customer",
  references: "reference", sso: "signon", "sign-on": "signon", encrypted: "encrypt", encryption: "encrypt", uptime: "availability", sla: "service", payroll: "payroll", timesheet: "time", timesheets: "time" };
const stem = (w) => w.replace(/(ies)$/, "y").replace(/(ing|ed|es|s)$/, "").replace(/(ation|ment)$/, "");
export function tokens(s) {
  return String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w)).map((w) => stem(SYNONYMS[w] ?? w));
}

// ------------------------------------------------------------------ 1. requirement mapping

const HEADING = /^\s*((?:section|part|article|schedule|appendix)\s+[\w.]+|\d{1,2}(?:\.\d{1,2}){0,3}\.?|[A-Z]\.)\s+([A-Z][^\n]{2,90})$/;
const MANDATORY = /\b(shall|must|is required to|are required to|required|mandatory|will be (?:rejected|disqualified)|at a minimum|no later than|must not|shall not|is responsible for)\b/i;
const DESIRABLE = /\b(should|preferred|preference|desirable|desired|nice to have|asset|may be considered|is encouraged|ideally|optional)\b/i;

const CATEGORY = [
  ["insurance", /insurance|liability|bond\b|surety|wsib|workers'? comp|indemnif/i],
  ["legal", /term of the (contract|agreement)|option to (renew|extend)|contract terms|terms and conditions|governing law|termination|warrant|intellectual property|confidential/i],
  ["security", /security|encrypt|soc ?2|iso ?27001|penetration|mfa|multi-factor|access control|privacy|pipeda|fippa|hipaa|ferpa/i],
  ["data", /data (migration|conversion|residency|retention|backup)|stored in canada|stored in the united states|export|archiv/i],
  ["integration", /integrat|interface|api\b|single sign-on|sso\b|import|feed/i],
  ["implementation", /implement|deploy|go-live|project plan|milestone|timeline|phase/i],
  ["training", /train|documentation|user guide|knowledge transfer/i],
  ["support", /support|maintenance|sla\b|service level|uptime|availability|help ?desk|response time/i],
  ["pricing", /pric|cost|fee|invoice|payment|rate card/i],
  ["format", /page|font|format|copies|pdf|electronic submission|envelope|label|portal|submit/i],
  ["form", /sign|form\b|appendix|schedule|attach|certif|declaration|acknowledg/i],
  ["experience", /reference|experience|years|case stud|qualified|certified staff|resume/i],
  ["accessibility", /accessib|aoda|wcag|ada\b|section 508|french|bilingual|official languages/i],
  ["functional", /system|software|solution|module|functionality|report|workflow|dashboard|user/i],
];
const categorize = (s) => (CATEGORY.find(([, re]) => re.test(s)) ?? ["general"])[0];

const QUESTION = /^(describe|explain|provide|identify|outline|detail|list|include|confirm|indicate|demonstrate|discuss|state|summari[sz]e|what|how|please (describe|explain|provide|confirm|list|identify))\b/i;

function sentencesWithSections(text) {
  const out = [];
  let section = "";
  for (const raw of String(text).split(/\n+/)) {
    let line = raw.trim();
    if (!line) continue;
    const h = line.match(HEADING);
    if (h && line.length < 110 && !/[.;:]$/.test(line) && !QUESTION.test(h[2])) { section = `${h[1].replace(/\.$/, "")} ${h[2]}`.trim(); continue; }
    // A numbered question ("1.0.4 Describe your approach…") keeps its RFP number and stays whole.
    const num = line.match(/^(\d+(?:\.\d+){1,3})\.?\s+(.{20,})$/);
    if (num && QUESTION.test(num[2])) { out.push({ section, text: num[2].slice(0, 1500), number: num[1], question: true }); continue; }
    if (QUESTION.test(line) && line.length <= 1500) { out.push({ section, text: line, question: true }); continue; }
    for (const s of line.split(/(?<=[.;:!?])\s+(?=[A-Z(•\-–\d])/)) {
      const t = s.replace(/^[•\-–*]\s*/, "").trim();
      if (t.length >= 20 && t.length <= 600) out.push({ section, text: t });
    }
  }
  return out;
}

export function mapRequirements(text, limit = 300) {
  const out = [];
  const seen = new Set();
  let n = 0;
  const usedNums = new Set();
  for (const { section, text: s, number, question } of sentencesWithSections(text)) {
    const mand = MANDATORY.test(s), des = DESIRABLE.test(s);
    if (!mand && !des && !question) continue;
    const key = s.toLowerCase().replace(/\W+/g, " ").slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    n++;
    // RFP questions are response items; obligation sentences are requirements.
    const level = question ? "question" : mand ? "mandatory" : "desirable";
    const id = number && !usedNums.has(number) ? (usedNums.add(number), number) : `REQ-${String(n).padStart(3, "0")}`;
    out.push({ id, section: section || "—", text: s, level, category: categorize(s) });
    if (out.length >= limit) break;
  }
  return out;
}

// ------------------------------------------------------------------ 2. compliance screening

function paragraphs(text) {
  const paras = String(text).split(/\n\s*\n|\n(?=\s*(?:\d+(\.\d+)*|[•\-–*])\s)/).map((p) => p?.replace(/\s+/g, " ").trim()).filter((p) => p && p.length > 30);
  // Long unbroken text: fall back to ~3-sentence windows so a match points at something readable.
  if (paras.length <= 1) {
    const sents = String(text).split(/(?<=[.!?])\s+/);
    const win = [];
    for (let i = 0; i < sents.length; i += 2) win.push(sents.slice(i, i + 3).join(" "));
    return win.filter((p) => p.length > 30);
  }
  return paras;
}

function tfidfIndex(docs) {
  const toks = docs.map(tokens);
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  const idf = (w) => Math.log(1 + N / (1 + (df.get(w) ?? 0)));
  const vec = (t) => {
    const tf = new Map();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    const v = new Map();
    let norm = 0;
    for (const [w, c] of tf) { const x = (1 + Math.log(c)) * idf(w); v.set(w, x); norm += x * x; }
    return { v, norm: Math.sqrt(norm) || 1 };
  };
  const vecs = toks.map(vec);
  return {
    best(query) {
      const q = vec(tokens(query));
      let best = { i: -1, score: 0 };
      vecs.forEach((d, i) => {
        let dot = 0;
        for (const [w, x] of q.v) if (d.v.has(w)) dot += x * d.v.get(w);
        const s = dot / (q.norm * d.norm);
        if (s > best.score) best = { i, score: s };
      });
      return best;
    },
  };
}

export function screenCompliance(requirements, proposalText) {
  if (!proposalText || !String(proposalText).trim()) return null;
  const paras = paragraphs(proposalText);
  if (!paras.length) return null;
  const idx = tfidfIndex(paras);
  return requirements.map((r) => {
    const { i, score } = idx.best(r.text);
    const status = score >= 0.32 ? "addressed" : score >= 0.16 ? "partial" : "missing";
    return { reqId: r.id, level: r.level, status, similarity: Math.round(score * 100) / 100, evidence: i >= 0 && status !== "missing" ? paras[i].slice(0, 400) : "" };
  });
}

// ------------------------------------------------------------------ 4. data extraction and risk flagging

const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18, "twenty-four": 24, "thirty-six": 36, "forty-eight": 48, sixty: 60 };
const NUMW = "(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty-four|thirty-six|forty-eight|sixty)";
const toNum = (x) => Number(/^\d+$/.test(x) ? x : WORDNUM[String(x).toLowerCase()] ?? NaN);
const plural = (n, unit) => `${n} ${unit.toLowerCase().replace(/s$/, "")}${n === 1 ? "" : "s"}`;
const tidyCase = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s/(-])([a-z])/g, (m, p, c) => p + c.toUpperCase()) : s);
// Evaluation sections, and words a real criterion name contains.
const EVAL_HEAD = /(evaluation (criteria|factors?|matrix|process|methodology|plan|and selection)|scoring (criteria|matrix|grid|rubric)|basis (for|of) (award|selection)|selection criteria|rated (requirements|criteria)|point[- ]rated|proposal evaluation|^\s*(?:(?:section|part)\s+)?(?:[\dA-Z]{1,3}[.)]\s*)?(?:[\d.]+\s+)?evaluation\s*:?\s*$)/i;
const CRIT_WORD = /(technical|price|pricing|cost|experience|approach|methodolog|qualification|performance|reference|management|implementation|support|security|solution|functional|capabilit|plan\b|schedule|staff|personnel|team|value|innovation|presentation|demonstration|interview|project|understanding|quality|training|risk|sustainab|indigenous|social|accessib|financial|corporate|work ?plan|transition|service)/i;
const BAD_END = /\b(of|for|than|to|the|a|an|and|or|with|in|on|by|at|from|least|over|under|up|is|are|be|per)$/i;

export function extractKeyData(text) {
  const t = String(text);
  const flat = t.replace(/\s+/g, " ");
  const find = (re) => flat.match(re);
  const data = { dates: keyDates(t) };

  // Contract term: "ordering period is five (5) years", "Contract Duration: 36 months",
  // "the term of the agreement shall be three (3) years".
  const term = find(new RegExp(`\\b(?:ordering period|period of performance|contract term|contract period|contract duration|duration of (?:the )?(?:contract|agreement|services)|term of (?:the |this )?(?:contract|agreement|standing offer|supply arrangement|services)|initial (?:contract )?(?:term|period)|base (?:contract )?(?:term|period))\\b[^.\\d$]{0,45}?${NUMW}\\s*(?:\\(\\s*\\d+\\s*\\)\\s*)?[- ]?(years?|months?)\\b`, "i"))
    ?? find(new RegExp(`\\b(?:term|period|duration)\\s+of\\s+(?:the\\s+)?(?:(?:contract|agreement)\\s+)?(?:shall\\s+be\\s+|will\\s+be\\s+|is\\s+)?(?:for\\s+)?${NUMW}\\s*(?:\\(\\d+\\)\\s*)?(years?|months?)\\b`, "i"))
    ?? find(new RegExp(`\\b(?:contract|agreement|standing offer|arrangement)\\b[^.]{0,80}?for a (?:period|term) of (?:up to )?${NUMW}\\s*(?:\\(\\d+\\)\\s*)?(years?|months?)\\b`, "i"));
  if (term) {
    const n = toNum(term[1]);
    if (n) data.contractTerm = plural(n, term[2]);
  }
  // Options: "Base Year and Option Years 1 through 4", "two (2) additional one-year option periods".
  const optYears = find(/\boption years? 1 (?:through|to|-|–)\s*(\d{1,2})\b/i);
  const optN = find(new RegExp(`\\b${NUMW}\\s*(?:\\(\\d+\\)\\s*)?(?:additional\\s+|further\\s+|optional\\s+|consecutive\\s+)?(?:(?:one|two|three|1|2|3|twelve|12|six|6)[- ](?:year|month)\\s+)?(?:option(?:al)?|renewal|extension)\\s+(?:periods?|terms?|years?)\\b`, "i"));
  const optTo = find(new RegExp(`\\boptions? to (?:renew|extend)\\b[^.]{0,30}?(?:for\\s+)?(?:up to\\s+)?${NUMW}\\s*(?:\\(\\d+\\)\\s*)?(?:additional\\s+)?(?:(?:one|two|\\d+)[- ])?(?:years?|months?|periods?|terms?)\\b[^.;]{0,40}`, "i"));
  if (optYears) data.renewals = `${optYears[1]} option year${optYears[1] === "1" ? "" : "s"}`;
  else if (optN && toNum(optN[1])) data.renewals = optN[0].replace(/\s+/g, " ").trim().slice(0, 90);
  else if (optTo) data.renewals = optTo[0].replace(/\s+/g, " ").trim().slice(0, 90);
  if (!data.contractTerm && /\bbase (?:year|period of (?:12|twelve) months)\b/i.test(flat) && data.renewals) data.contractTerm = "1 year base";

  const money = [...flat.matchAll(/(budget|estimated|value|not to exceed|maximum|upset limit|ceiling)[^$.]{0,60}\$\s?([\d,]+(?:\.\d+)?)\s*(million|m\b|k\b)?/gi)];
  if (money.length) {
    const [, label, amt, unit] = money[0];
    let v = Number(amt.replace(/,/g, ""));
    if (/million|^m$/i.test(unit ?? "")) v *= 1e6;
    if (/^k$/i.test(unit ?? "")) v *= 1e3;
    data.value = { amount: v, context: label.toLowerCase() };
  }

  const subm = [];
  if (/electronic(ally)?|online portal|bidding system|e-?bid|upload/i.test(flat)) subm.push("electronic / portal");
  if (/by e-?mail|via e-?mail|emailed to/i.test(flat)) subm.push("email");
  if (/sealed envelope|hard cop(y|ies)|courier(ed)? to|delivered to the office/i.test(flat)) subm.push("hard copy");
  if (subm.length) data.submission = subm;
  const pages = find(/\b(?:not exceed|maximum of|no more than|limited to)\s+(\d{1,3})\s+pages?/i);
  if (pages) data.pageLimit = Number(pages[1]);
  const copies = find(/\b(\w+)\s*(?:\(\d+\)\s*)?(?:hard\s+)?(?:copies|originals)\b/i);
  if (copies && (WORDNUM[copies[1].toLowerCase()] || /^\d+$/.test(copies[1]))) data.copies = WORDNUM[copies[1].toLowerCase()] ?? Number(copies[1]);
  const valid = find(/\b(?:irrevocable|remain (?:valid|open)|valid)\s+(?:and\s+open\s+)?(?:for\s+(?:a\s+period\s+of\s+)?)?(\d{2,3})\s+days/i);
  if (valid) data.validityDays = Number(valid[1]);
  const refs = find(/\b(\w+)\s*(?:\(\d+\)\s*)?(?:client\s+|customer\s+)?references\b/i);
  if (refs && (WORDNUM[refs[1].toLowerCase()] || /^\d+$/.test(refs[1]))) data.references = WORDNUM[refs[1].toLowerCase()] ?? Number(refs[1]);
  const ins = [...flat.matchAll(/(general liability|professional liability|errors and omissions|cyber|automobile)[^$.]{0,60}\$\s?([\d,]+(?:\.\d+)?)\s*(million)?/gi)]
    .map(([, kind, amt, mil]) => ({ kind: kind.toLowerCase(), amount: Number(amt.replace(/,/g, "")) * (mil ? 1e6 : 1) }));
  if (ins.length) data.insurance = ins;

  // Evaluation criteria with weights ("Technical approach ... 40%", "Price 30 points"), read
  // inside an evaluation section, and only names that read like criteria (not "of 100%").
  const lines = t.split(/\n+/);
  const heads = lines.map((ln, i) => (EVAL_HEAD.test(ln) ? i : -1)).filter((i) => i >= 0);
  const weighted = [];
  lines.forEach((line, i) => {
    const m = line.trim().match(/^(?:[\d.]+\s+|[•\-–*]\s*|\(?[a-z]\)\s*)?([A-Za-z][A-Za-z ,&/()'-]{2,70}?)\s*[:\-–|.]*\s*(\d{1,3})(?:\.\d+)?\s*(%|percent\b|points?\b|pts\b)/i);
    if (!m) return;
    const crit = m[1].trim().replace(/\s+/g, " "), w = Number(m[2]);
    if (w < 1 || w > 100 || BAD_END.test(crit) || /page|day|year|month|hour|minute/i.test(crit) || !CRIT_WORD.test(crit)) return;
    // A threshold or a tax, not a criterion: "must include 13% HST", "minimum technical score 70%".
    if (/\b(must|shall|will|includ\w*|required|minimum|maximum|at least|achieve\w*|greater|less than|more than|tax|hst|gst|pst|vat|discount|markup|holdback|interest|uptime|availability|pass mark)\b/i.test(crit)) return;
    weighted.push({ criterion: tidyCase(crit), weight: w, unit: /%|percent/i.test(m[3]) ? "%" : "points", near: heads.some((hd) => i >= hd && i - hd <= 150) });
  });
  const pct = weighted.filter((e) => e.unit === "%"), sum = pct.reduce((a, e) => a + e.weight, 0);
  const keep = weighted.filter((e) => e.near || (pct.length >= 2 && sum >= 95 && sum <= 105));
  const evals = [];
  for (const e of keep) if (!evals.some((x) => x.criterion.toLowerCase() === e.criterion.toLowerCase())) evals.push({ criterion: e.criterion, weight: e.weight, unit: e.unit });
  // Factors without weights: "M.3 FACTOR #1 – PAST PERFORMANCE", "Criterion 2: Technical approach".
  if (!evals.length) {
    for (const m of t.matchAll(/^\s*(?:[A-Z]\.\d+(?:\.\d+)?\s+)?(?:evaluation\s+)?(?:factor|criterion)\s*#?\s*(\d+|[A-H]|one|two|three|four|five|six)\s*[:\-–—.]+\s*([A-Za-z][^\n]{2,80})$/gim)) {
      const name = tidyCase(m[2].replace(/\s+/g, " ").replace(/[.:]+$/, "").trim());
      if (!evals.some((x) => x.criterion.toLowerCase() === name.toLowerCase())) evals.push({ criterion: name, weight: null, unit: null, rank: evals.length + 1 });
    }
  }
  if (evals.length) data.evaluation = evals.slice(0, 20);
  // How the winner is chosen, and how the factors compare when no weights are given.
  const near = (re) => new RegExp(`(award|selection|evaluat|basis)[^.]{0,200}${re.source}|${re.source}[^.]{0,200}(award|selection|evaluat)`, "i").test(flat);
  data.evaluationBasis = /lowest price technically acceptable|\bLPTA\b/i.test(flat) ? "Lowest price technically acceptable (LPTA)"
    : /highest combined rating of technical merit and price/i.test(flat) ? "Highest combined rating of technical merit and price"
    : /lowest cost[- ]per[- ]point/i.test(flat) ? "Lowest cost per point"
    : /highest technical merit within a (?:stipulated )?maximum budget/i.test(flat) ? "Highest technical merit within a maximum budget"
    : near(/best[- ]value/) ? (/trade-?off/i.test(flat) ? "Best value (trade-off)" : "Best value")
    : /technical acceptability and price reasonableness/i.test(flat) ? "Technically acceptable, then lowest price"
    : near(/lowest (?:compliant |responsive |evaluated |priced )?(?:bid|price|offer|tender|proposal)/) ? "Lowest compliant price"
    : undefined;
  if (!data.evaluationBasis) delete data.evaluationBasis;
  const importance = flat.match(/\b(?:factor|criterion)\s*#?\s*\d+\s+is\s+(?:significantly\s+|slightly\s+|substantially\s+)?more important than[^.]{0,200}\./i)
    ?? flat.match(/\b(?:all\s+)?(?:non-?price|technical)\s+(?:evaluation\s+)?factors?,?\s*(?:when\s+)?combined,?\s*(?:are|is)\s+(?:significantly\s+|approximately\s+)?(?:more important than|equal to|less important than)\s+(?:cost or\s+)?price[^.]{0,60}\./i);
  if (importance) data.evaluationNote = importance[0].trim().slice(0, 240);
  return data;
}

const RISKS = [
  ["unlimited-liability", "high", "Unlimited or uncapped liability", /\b(unlimited|uncapped)\s+liability|liability\s+(?:shall\s+)?not\s+be\s+limited/i],
  ["indemnity", "medium", "Broad indemnification", /\bindemnif(y|ication)\b[^.]{0,120}\b(any and all|all claims|whatsoever)/i],
  ["liquidated-damages", "high", "Liquidated damages or financial penalties", /liquidated damages|penalt(y|ies) of \$|service credits? of/i],
  ["performance-bond", "medium", "Performance, bid or labour bond required", /(performance|bid|labour and material|payment)\s+(bond|security)/i],
  ["holdback", "low", "Payment holdback", /holdback/i],
  ["termination-convenience", "medium", "Termination for convenience by the buyer", /terminat\w+\s+(?:this\s+\w+\s+)?for\s+(?:its\s+)?convenience|terminate\s+at\s+any\s+time\s+without\s+cause/i],
  ["ip-transfer", "high", "Intellectual property transferred to the buyer", /(intellectual property|all rights, title)[^.]{0,120}\b(vest|become the property|assign(ed)?|belong)\b[^.]{0,40}\b(buyer|owner|board|district|city|client|agency|crown)/i],
  ["source-escrow", "medium", "Source code escrow or delivery", /source code[^.]{0,60}(escrow|deliver|provide)/i],
  ["data-residency", "medium", "Data residency requirement", /(data|information)[^.]{0,80}(stored|hosted|reside|remain)[^.]{0,40}(in|within)\s+(canada|the united states|the us|the province|ontario|british columbia)/i],
  ["fixed-price", "medium", "Fixed price or firm price for the full term", /(fixed|firm)\s+(price|fee|rate)s?\b[^.]{0,60}(entire|full|term|duration)/i],
  ["mandatory-meeting", "medium", "Mandatory pre-bid meeting or site visit", /mandatory\s+(pre-?bid|pre-?proposal|site\s+visit|information\s+session|bidders'? (conference|meeting))/i],
  ["pass-fail", "medium", "Pass/fail mandatory criteria (non-compliance means rejection)", /(pass\s*\/\s*fail|will be (rejected|disqualified)|deemed non-?compliant|shall be rejected)/i],
  ["background-checks", "low", "Background or vulnerable-sector checks for staff", /(criminal|background|vulnerable sector|security)\s+(record\s+)?(check|clearance|screening)/i],
  ["language", "low", "Bilingual or French-language requirement", /\b(bilingual|french language|in both official languages)\b/i],
  ["payment-terms", "medium", "Long payment terms", /(net|within)\s+(60|75|90|120)\s+days/i],
  ["mfn", "medium", "Most-favoured-customer pricing clause", /most[- ]favou?red|best pricing offered to any other/i],
  ["audit", "low", "Audit rights over supplier records", /right to audit|audit (?:the )?(?:supplier|contractor|vendor)'?s? (?:records|books)/i],
  ["accessibility", "low", "Accessibility standard (AODA / WCAG / Section 508)", /\b(aoda|wcag|section 508|accessibility for ontarians)\b/i],
  ["insurance-high", "medium", "Insurance of $5M or more", /\$\s?(5|10|15|20|25)[,.]?0{0,3}[,.]?0{3}[,.]?0{3}|\$\s?(5|10|15|20|25)\s*million/i],
  ["no-questions", "low", "Questions not permitted or very short Q&A window", /no questions will be (accepted|answered)|questions will not be accepted/i],
  ["exclusivity", "low", "Exclusivity or non-compete", /\bexclusiv(e|ity)\b|non-?compete/i],
];

export function flagRisks(text, dates = {}, now = new Date()) {
  const flat = String(text).replace(/\s+/g, " ");
  const sentences = flat.split(/(?<=[.;!?])\s+/);
  const out = [];
  for (const [id, severity, label, re] of RISKS) {
    const s = sentences.find((x) => re.test(x));
    if (s) out.push({ id, severity, label, evidence: s.slice(0, 300) });
  }
  const close = dates.closing ? new Date(`${dates.closing}T00:00:00Z`) : null;
  if (close) {
    const days = Math.round((close - now) / 86400000);
    if (days < 0) out.unshift({ id: "closed", severity: "high", label: `Closed ${-days} day(s) ago`, evidence: `Closing date ${dates.closing}` });
    else if (days < 14) out.unshift({ id: "short-timeline", severity: days < 7 ? "high" : "medium", label: `Only ${days} day(s) to respond`, evidence: `Closing date ${dates.closing}` });
  } else {
    out.push({ id: "no-close-date", severity: "low", label: "No closing date found", evidence: "Confirm the closing date and time in the solicitation." });
  }
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ------------------------------------------------------------------ 3. analysis and scoring

/**
 * `packs` is the list of industry packs, `tenant` optional. Without a tenant the
 * fit is measured against every pack and the best-matching industry is reported.
 */
export function scoreRfp({ text, title = "", buyer = null, requirements, compliance, risks, keyData, packs = [], tenant = null, profile = null, now = new Date() }) {
  const reasons = [];
  const lower = String(text).toLowerCase();
  const has = (k) => new RegExp(`(^|[^a-z0-9])${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(lower);

  // Fit: with a company profile, how much of the RFP asks for what the company sells
  // (read from its website). Without one, general capability terms from the packs.
  const company = profile ? companyFit({ title, buyer, sourceText: text }, profile) : null;
  const candidates = packs.filter((p) => !tenant || tenant.industries?.includes(p.id));
  let best = { pack: null, title: [], body: [], disq: [], score: 0 };
  for (const p of candidates) {
    const tHits = (p.qualifiers?.titleKeywords ?? []).filter(has);
    const bHits = (p.qualifiers?.bodyKeywords ?? []).filter(has);
    const dHits = (p.disqualifiers ?? []).filter(has);
    const s = Math.min(1, tHits.length * 0.18 + bHits.length * 0.06) * (dHits.length > tHits.length ? 0.5 : 1);
    if (s > best.score) best = { pack: p, title: tHits, body: bHits, disq: dHits, score: s };
  }
  const offering = tenant && best.pack ? tenant.offerings?.[best.pack.id] : null;
  const productHits = [...(offering?.productLines ?? []), ...(tenant?.profile?.capabilities ?? [])].filter((x) => tokens(x).some((w) => tokens(lower).includes(w)));
  let fit = Math.round(best.score * 100);
  if (productHits.length) fit = Math.min(100, fit + 10);
  if (company) {
    fit = company.score;
    reasons.push(`Fit ${fit}: ${company.reasons.join("; ")}`);
  } else {
    reasons.push(best.pack
      ? `Fit ${fit}: matched ${best.title.slice(0, 6).join(", ") || "no headline terms"}${best.body.length ? ` and ${best.body.length} supporting term(s)` : ""}${best.disq.length ? `; also mentions ${best.disq.slice(0, 3).join(", ")}` : ""}. General capability terms: add your company website to score fit on what you sell`
      : "Fit 0: the document matches none of the capability terms. Add your company website to score fit on what you sell");
  }

  // Risk (higher is safer).
  const penalty = risks.reduce((a, r) => a + (r.severity === "high" ? 18 : r.severity === "medium" ? 8 : 3), 0);
  const risk = Math.max(0, 100 - penalty);
  reasons.push(`Risk ${risk}: ${risks.filter((r) => r.severity === "high").length} high, ${risks.filter((r) => r.severity === "medium").length} medium, ${risks.filter((r) => r.severity === "low").length} low flag(s)`);

  // Timeline.
  const close = keyData.dates?.closing ? new Date(`${keyData.dates.closing}T00:00:00Z`) : null;
  const days = close ? Math.round((close - now) / 86400000) : null;
  const timeline = days == null ? 50 : days < 0 ? 0 : days < 7 ? 20 : days < 14 ? 50 : days < 21 ? 75 : 100;
  reasons.push(`Timeline ${timeline}: ${days == null ? "closing date not found" : days < 0 ? "already closed" : `${days} day(s) to close`}`);

  // Coverage: only with a proposal.
  let coverage = null;
  if (compliance) {
    const w = (c) => (c.level === "mandatory" ? 2 : 1);
    const tot = compliance.reduce((a, c) => a + w(c), 0) || 1;
    const got = compliance.reduce((a, c) => a + w(c) * (c.status === "addressed" ? 1 : c.status === "partial" ? 0.5 : 0), 0);
    coverage = Math.round((got / tot) * 100);
    const missingM = compliance.filter((c) => c.level === "mandatory" && c.status === "missing").length;
    reasons.push(`Coverage ${coverage}: ${compliance.filter((c) => c.status === "addressed").length} addressed, ${compliance.filter((c) => c.status === "partial").length} partial, ${compliance.filter((c) => c.status === "missing").length} missing (${missingM} mandatory)`);
  }

  const weights = coverage == null ? { fit: 45, risk: 35, timeline: 20 } : { fit: 30, risk: 25, timeline: 15, coverage: 30 };
  const parts = { fit, risk, timeline, ...(coverage == null ? {} : { coverage }) };
  const overall = Math.round(Object.entries(weights).reduce((a, [k, w]) => a + parts[k] * w, 0) / 100);
  const band = days != null && days < 0 ? "closed" : overall >= 70 ? "strong" : overall >= 50 ? "worth a look" : "weak";
  reasons.unshift(`Overall ${overall} (${band}); weights ${Object.entries(weights).map(([k, w]) => `${k} ${w}`).join(", ")}`);
  return { overall, band, fit, fitBasis: company ? "offering" : "capability terms", company, risk, timeline, coverage, weights, industry: best.pack ? { id: best.pack.id, name: best.pack.name } : null, reasons, mandatory: requirements.filter((r) => r.level === "mandatory").length, desirable: requirements.filter((r) => r.level === "desirable").length, questions: requirements.filter((r) => r.level === "question").length };
}

// ------------------------------------------------------------------ 5. summary

const money = (v) => (v == null ? "not stated" : `$${Math.round(v).toLocaleString("en-US")}`);

export function summarize({ title, source, scores, keyData, requirements, compliance, risks }) {
  const d = keyData.dates ?? {};
  const cats = {};
  for (const r of requirements) cats[r.category] = (cats[r.category] ?? 0) + 1;
  const topCats = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c} (${n})`).join(", ");
  const gaps = compliance ? compliance.filter((c) => c.level === "mandatory" && c.status !== "addressed") : [];
  const reqById = Object.fromEntries(requirements.map((r) => [r.id, r]));
  const lines = [
    `# ${title || "RFP analysis"}`,
    "",
    `**Overall ${scores.overall}/100: ${scores.band}.** Fit ${scores.fit} · Risk ${scores.risk} · Timeline ${scores.timeline}${scores.coverage == null ? "" : ` · Coverage ${scores.coverage}`}${scores.company ? " · fit scored on your product offering" : ""}`,
    source ? `Source: ${source}` : "",
    "",
    "## Key facts",
    `- Closing: ${d.closing ?? "not found"}${d.questions ? ` · questions due ${d.questions}` : ""}${d.preBid ? ` · pre-bid ${d.preBid}` : ""}${d.siteVisit ? ` · site visit ${d.siteVisit}` : ""}`,
    `- Value: ${keyData.value ? `${money(keyData.value.amount)} (${keyData.value.context})` : "not stated"} · Term: ${keyData.contractTerm ?? "not stated"}${keyData.renewals ? ` · ${keyData.renewals}` : ""}`,
    `- Submission: ${keyData.submission?.join(", ") ?? "not stated"}${keyData.pageLimit ? ` · max ${keyData.pageLimit} pages` : ""}${keyData.copies ? ` · ${keyData.copies} copies` : ""}${keyData.validityDays ? ` · valid ${keyData.validityDays} days` : ""}${keyData.references ? ` · ${keyData.references} references` : ""}`,
    keyData.evaluation?.length ? `- Evaluation: ${keyData.evaluation.map((e) => `${e.criterion} ${e.weight}${e.unit === "%" ? "%" : " pts"}`).join("; ")}` : "- Evaluation criteria: not found",
    "",
    "## Requirements",
    `- ${requirements.length} found: ${scores.questions ? `${scores.questions} response question(s), ` : ""}${scores.mandatory} mandatory, ${scores.desirable} desirable. Most in: ${topCats || "—"}.`,
    compliance ? `- Proposal coverage ${scores.coverage}%. ${gaps.length ? `${gaps.length} mandatory requirement(s) not fully addressed:` : "Every mandatory requirement is addressed."}` : "- No proposal supplied, so compliance was not screened.",
    ...gaps.slice(0, 10).map((g) => `  - ${g.reqId} (${g.status}): ${reqById[g.reqId]?.text.slice(0, 160)}`),
    "",
    "## Risks",
    ...(risks.length ? risks.slice(0, 10).map((r) => `- **${r.severity.toUpperCase()}**: ${r.label}`) : ["- No risk patterns found. Still read the terms and conditions."]),
    "",
    "## Suggested next steps",
    `- ${scores.band === "closed" ? "Closed: record it and move on." : scores.overall >= 50 ? "Hold a go/no-go with a named sponsor." : "Likely pass unless there is a relationship or strategic reason."}`,
    risks.some((r) => r.severity === "high") ? "- Take the high-severity terms to legal before investing in a response." : "",
    d.questions ? `- Send clarification questions before ${d.questions}.` : "- Confirm the question deadline.",
    compliance && gaps.length ? "- Close the mandatory gaps above before the internal review." : "",
    "",
    "_Generated by pattern matching and lexical similarity, not by a person or a language model. Check every item against the full solicitation and its addenda._",
  ];
  return lines.filter((x, i, a) => !(x === "" && a[i - 1] === "")).filter((x) => x !== null).join("\n").replace(/\n{3,}/g, "\n\n");
}

/** First one or two short, title-like lines of the document. */
function guessTitle(text) {
  const lines = String(text).split(/\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 6);
  const titleish = lines.filter((l) => l.length <= 120 && !/[.;]$/.test(l)).slice(0, 2);
  return (titleish.join(" — ") || lines[0] || "RFP").slice(0, 160);
}

// ------------------------------------------------------------------ qualification view

/**
 * What a person needs to decide: why it matters, why we may not qualify, key
 * risks, what is still unknown, and a recommended next action. Facts are split
 * into verified (read from the source, with the text they came from) and
 * inferred (computed by this tool). An inference is never shown as a fact.
 */
export function qualify(analysis, meta = {}) {
  const a = analysis, k = a.keyData ?? {}, d = k.dates ?? {}, sc = a.scores ?? {};
  const verified = [], inferred = [];
  const v = (label, value, from) => value != null && value !== "" && verified.push({ label, value: String(value), from });
  v("Buyer", meta.buyer, meta.channel ? `notice on ${meta.channel}` : "notice");
  v("Published", meta.publishedDate, "notice");
  v("Closing date", d.closing ?? meta.closeDate, d.closing && k.closingFrom !== "notice" ? "solicitation text" : "notice");
  const swept = new Set(k.fromSweep ?? []);
  const docsRead = (meta.rfp?.sources ?? []).filter((x) => x.kind === "document" && !x.error).map((x) => x.name);
  const src = (field) => (swept.has(field) ? (docsRead.length ? `RFP document${docsRead.length > 1 ? "s" : ""} read by the sweep` : "the notice feed") : "solicitation text");
  v("Questions deadline", d.questions, src("dates.questions"));
  v("Pre-bid meeting", d.preBid, src("dates.preBid"));
  v("Contract term", k.contractTerm ? `${k.contractTerm}${k.contractDates ? ` (${k.contractDates})` : ""}` : null, src("contractTerm"));
  v("Options / renewals", k.renewals, src("renewals"));
  v("Stated value", k.value ? `$${Math.round(k.value.amount).toLocaleString("en-US")} (${k.value.context})` : meta.estimatedValue, src("value"));
  v("Evaluation criteria", k.evaluation?.length ? k.evaluation.map((e) => (e.weight != null ? `${e.criterion} ${e.weight}${e.unit === "%" ? "%" : " pts"}` : `${e.rank}. ${e.criterion}`)).join(" · ") : null, src("evaluation"));
  v("Basis of award", k.evaluationBasis ? `${k.evaluationBasis}${k.evaluationNote ? `. ${k.evaluationNote}` : ""}` : null, src("evaluationBasis"));
  v("Submission", k.submission?.join(", "), src("submission"));
  v("Source", meta.url ?? a.source, "link");
  inferred.push({ label: "Fit score", value: `${sc.fit}/100`, how: sc.company ? "match to your product offering, from your website" : "general capability terms (add your website for a product-offering fit)" });
  if (sc.company?.matched?.capabilities?.length) inferred.push({ label: "Offerings it asks for", value: sc.company.matched.capabilities.map((id) => (meta.capabilityLabels?.[id] ?? id)).join(", "), how: "your offerings named in the RFP" });
  if (meta.sector) inferred.push({ label: "Buyer's industry", value: meta.sector.label, how: meta.sector.basis });
  if (meta.capabilities?.length) inferred.push({ label: "Capabilities asked for", value: meta.capabilities.map((c) => c.label).join(", "), how: "capability keyword sets" });
  inferred.push({ label: "Overall", value: `${sc.overall}/100 (${sc.band})`, how: `weights ${Object.entries(sc.weights ?? {}).map(([x, w]) => `${x} ${w}`).join(", ")}` });

  const matters = [];
  if (sc.company && sc.fit >= 40) matters.push(`${sc.fit >= 60 ? "Strong" : "Possible"} match to what you sell (fit ${sc.fit}): ${sc.company.reasons[0] ?? ""}`.replace(/: $/, "."));
  else if (!sc.company && sc.fit >= 50) matters.push(`Strong match to the capability terms (fit ${sc.fit}).`);
  if (meta.capabilities?.length) matters.push(`Asks for ${meta.capabilities.slice(0, 3).map((c) => c.label.toLowerCase()).join(", ")}.`);
  if (k.value?.amount >= 250000) matters.push(`Stated value of $${Math.round(k.value.amount).toLocaleString("en-US")}.`);
  if (k.contractTerm) matters.push(`Multi-period contract: ${k.contractTerm}${k.renewals ? `, ${k.renewals}` : ""}.`);
  if (/managed|support|maintenance/i.test(a.requirements?.map((r) => r.category).join(" ") ?? "")) matters.push("Includes ongoing support, so there is recurring services potential.");
  if (!matters.length) matters.push("No strong signal yet. Read the solicitation before deciding.");

  const hard = (a.requirements ?? []).filter((r) => r.level === "mandatory" && ["insurance", "experience", "security", "accessibility", "legal"].includes(r.category));
  const mayNot = hard.slice(0, 6).map((r) => `${r.id} [${r.category}]: ${r.text.slice(0, 180)}`);
  if (sc.fit < (sc.company ? 40 : 35)) mayNot.unshift(sc.company ? "Weak fit: the RFP asks for little of what you sell, per your website profile." : "Weak fit: the document matches few capability terms.");
  if (a.compliance) for (const c of a.compliance.filter((c) => c.level === "mandatory" && c.status === "missing").slice(0, 4)) mayNot.push(`Proposal does not yet address mandatory ${c.reqId}.`);

  // Only what is still missing after reading the notice and its public documents, and where it was looked for.
  const infoWhere = meta.rfp ? (docsRead.length ? `None of these is stated in the notice or ${docsRead.length === 1 ? `the RFP document the sweep read (${docsRead[0]})` : `the ${docsRead.length} RFP documents the sweep read`}.` : "None of these is stated in the notice, and no public RFP document could be read.") : "";
  const infoRequired = [];
  if (!d.closing && !meta.closeDate) infoRequired.push("Closing date and time");
  if (!d.questions) infoRequired.push(`Deadline for questions${meta.rfp ? " (ask the contact named in the notice, or check the addenda)" : ""}`);
  if (!k.value && !meta.estimatedValue) infoRequired.push(`Budget or estimated value${meta.rfp ? " (many buyers do not publish one)" : ""}`);
  if (!k.contractTerm) infoRequired.push("Contract term");
  if (!k.evaluation?.length && !k.evaluationBasis) infoRequired.push("Evaluation criteria and weights");
  if (!k.submission) infoRequired.push("Submission method and format");
  for (const n of meta.rfp?.notes ?? []) if (!/^No public solicitation document/.test(n)) infoRequired.push(n);
  if ((a.words ?? 0) < 400 && !a.readBySweep) infoRequired.push("The full solicitation document. Only a notice summary was analyzed; upload the RFP for a complete read.");

  const high = (a.risks ?? []).filter((r) => r.severity === "high");
  const next = sc.band === "closed" ? "Closed. Record it and move on."
    : (a.words ?? 0) < 400 && !a.readBySweep ? "Get the full RFP document from the source link, then run Analyze RFP on it."
    : sc.overall >= 70 && !high.length ? "Qualify now: go/no-go with a named sponsor this week, then assign the team."
    : sc.overall >= 50 ? `Qualify with caution: ${high.length ? `resolve ${high.length} high risk(s) with legal first` : "confirm fit with the solution lead"}.`
    : "Likely no-bid unless there is a relationship or strategic reason. Record why.";
  return { matters, mayNotQualify: mayNot.length ? mayNot : ["Nothing obvious. Confirm mandatory requirements against the full document."], keyRisks: (a.risks ?? []).slice(0, 6), infoRequired, infoWhere: infoRequired.length ? infoWhere : "", nextAction: next, verified, inferred };
}

// ------------------------------------------------------------------ all five

/**
 * `known`: what the sweep read with the RFP (finding.rfp: key facts, risks and requirements
 * from the notice and its public documents). It fills what this text does not state, so a
 * workspace holding only the notice summary still shows the questions deadline, term,
 * value and evaluation criteria found in the documents.
 */
export function analyzeRfp({ text, title = "", source = "", proposalText = "", packs = [], tenant = null, profile = null, buyer = null, now = new Date(), closeDate = null, known = null }) {
  const words = String(text).split(/\s+/).filter(Boolean).length;
  let requirements = mapRequirements(text);
  if (known?.requirements?.length && words < 400) {
    const seen = new Set(known.requirements.map((r) => r.text.toLowerCase().slice(0, 80)));
    requirements = [...known.requirements, ...requirements.filter((r) => !seen.has(r.text.toLowerCase().slice(0, 80)))];
  }
  const compliance = screenCompliance(requirements, proposalText);
  const keyData = extractKeyData(text);
  // A closing date published on the notice counts when the text itself does not state one.
  if (!keyData.dates.closing && closeDate) { keyData.dates.closing = String(closeDate).slice(0, 10); keyData.closingFrom = "notice"; }
  if (known?.keyData) {
    const fromSweep = [];
    for (const [k, v] of Object.entries(known.keyData)) {
      if (k === "dates") { for (const [dk, dv] of Object.entries(v ?? {})) if (!keyData.dates[dk]) { keyData.dates[dk] = dv; fromSweep.push(`dates.${dk}`); } }
      else if (keyData[k] == null && v != null) { keyData[k] = v; fromSweep.push(k); }
    }
    if (fromSweep.length) keyData.fromSweep = fromSweep;
  }
  let risks = flagRisks(text, keyData.dates, now);
  if (known?.risks?.length) risks = [...risks, ...known.risks.filter((r) => !risks.some((x) => x.id === r.id))];
  const scores = scoreRfp({ text, title: title || guessTitle(text), buyer, requirements, compliance, risks, keyData, packs, tenant, profile, now });
  const heading = title || guessTitle(text);
  const summary = summarize({ title: heading, source, scores, keyData, requirements, compliance, risks });
  return {
    kind: "ionic-rfp-sweeper/analysis",
    version: 1,
    title: heading,
    source: source || null,
    analyzedAt: now.toISOString(),
    words,
    readBySweep: known?.fullText ? { words: known.words ?? null, documents: (known.sources ?? []).filter((x) => x.kind === "document" && !x.error).map((x) => x.name) } : null,
    method: "pattern matching + TF-IDF lexical similarity (no language model)",
    requirements,
    compliance,
    scores,
    keyData,
    risks,
    summary,
  };
}

export default { qualify, tokens, mapRequirements, screenCompliance, extractKeyData, flagRisks, scoreRfp, summarize, analyzeRfp };
