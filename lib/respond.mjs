/**
 * Answer → Build → Red-team.
 *
 *   draftAnswers   for every requirement, the closest approved knowledge-base
 *                  answers (cited by id and review date), a confidence, the owner
 *                  role, and "SME validation required" wherever nothing approved fits
 *   buildProposal  a first-draft response in the customer's own section names and
 *                  wording: executive summary, understanding, responses, compliance
 *                  matrix, assumptions, risks; pricing is never drafted
 *   redTeam        readiness check before submission: Ready / Needs review, with
 *                  blocking issues and warnings
 *
 * Nothing here invents a reference, certification, capability, metric or case
 * study. Text comes from the solicitation, the knowledge base, or the company
 * profile a person wrote; everything else is marked for an SME.
 *
 * Import-free apart from sibling lib modules: the browser bundle inlines it.
 */
import { tokens } from "./analyze.mjs";
import { isStale } from "./library.mjs";
import { ownerForCategory, matchCapabilities } from "./capabilities.mjs";

export const RESPONSE_STATUSES = ["Not started", "Drafted", "SME review", "Approved", "Needs revision", "Final"];
const SME = "[SME validation required]";

function index(entries) {
  const docs = entries.map((e) => tokens(`${e.question} ${(e.tags ?? []).join(" ")} ${e.question} ${e.answer ?? ""}`));
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length || 1;
  const vec = (t) => {
    const tf = new Map();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    const v = new Map();
    let n = 0;
    for (const [w, c] of tf) { const x = (1 + Math.log(c)) * Math.log(1 + N / (1 + (df.get(w) ?? 0))); v.set(w, x); n += x * x; }
    return { v, n: Math.sqrt(n) || 1 };
  };
  const vecs = docs.map(vec);
  return (text, k = 3) => {
    const q = vec(tokens(text));
    return vecs.map((d, i) => {
      let dot = 0;
      for (const [w, x] of q.v) if (d.v.has(w)) dot += x * d.v.get(w);
      return { i, s: dot / (q.n * d.n) };
    }).filter((x) => x.s > 0.08).sort((a, b) => b.s - a.s).slice(0, k);
  };
}

/**
 * The sub-asks inside one RFP question, in the order asked: "explain how…",
 * "describe…", "include…", bullet lines. Answers address them in this order.
 */
export function subAsks(question) {
  const q = String(question).replace(/\s+/g, " ");
  const parts = q.split(/(?<=[.;?])\s+|\s+(?=(?:explain|describe|include|provide|identify|outline|also describe|additionally)\b)|\s*•\s*/i)
    .map((x) => x.replace(/^(in your response,?|additionally,?|also,?|and)\s*/i, "").trim()).filter((x) => x.length > 12);
  return parts.slice(0, 8);
}

/**
 * The answer pattern learned from SME-reviewed responses: approach in the buyer's
 * terms; each sub-ask addressed in order; an anonymized comparable example with a
 * measurable outcome; supplementary material when artifacts are requested.
 * Everything a person must supply is marked; nothing is invented.
 */
export function answerSkeleton(req, { buyer = "the buyer", owner = "the SME" } = {}) {
  const asks = subAsks(req.text);
  const wantsArtifacts = /supporting materials|sample|template|diagram|gantt|chart|plan|checklist|include .*(report|dashboard|framework)/i.test(req.text);
  const wantsExamples = /example|similar|comparable|other organi[sz]ations|case/i.test(req.text);
  return [
    `${SME} Draft for ${owner}. Follow the reviewed-answer pattern; 2–4 short paragraphs, ~150–220 words.`,
    "",
    `Approach, in ${buyer}'s own terms: [how we do this, naming ${buyer}'s processes and systems from the RFP].`,
    "",
    ...(asks.length > 1 ? ["Address each ask, in the order asked:", ...asks.map((x, i) => `${i + 1}. ${x} → [answer]`), ""] : []),
    wantsExamples ? `Comparable example, anonymized: "At a comparable [sector, country] organization, [what changed] — [measurable outcome]." Never name the customer.` : null,
    wantsArtifacts ? `"[Artifact] is included in the supplementary materials."` : null,
  ].filter((x) => x !== null).join("\n");
}

export function draftAnswers(requirements, knowledge = [], { matrix, now = new Date(), buyer = "" } = {}) {
  const entries = knowledge.filter((e) => e && e.question);
  const search = entries.length ? index(entries) : () => [];
  return requirements.map((r) => {
    const hits = search(r.text);
    const sources = hits.map(({ i, s }) => ({ id: entries[i].id, question: entries[i].question, owner: entries[i].owner ?? null, lastReviewed: entries[i].lastReviewed ?? null, stale: isStale(entries[i], now), similarity: Math.round(s * 100) / 100, ...(entries[i].kind === "reference" ? { kind: "reference", title: entries[i].title ?? entries[i].source ?? null } : {}) }));
    const best = hits[0] ? entries[hits[0].i] : null;
    const bestSource = sources[0];
    const usable = best && best.answer && String(best.answer).trim();
    // A passage from the reference library (an article, a past response) is a starting point, never an
    // approved answer: at most medium confidence, so an SME always confirms it.
    const approved = best && best.kind !== "reference" && best.approved !== false;
    const confidence = !usable ? "low" : bestSource.similarity >= 0.45 && !bestSource.stale && approved ? "high" : bestSource.similarity >= 0.25 ? "medium" : "low";
    const owner = ownerForCategory(r.category, matrix);
    let draft;
    const fill = (t) => String(t).replace(/\{buyer\}/g, buyer || "the buyer");
    if (usable && confidence !== "low" && !approved) {
      draft = `${SME} Adapted from your reference library; confirm it fits this buyer.\n\n${fill(String(best.answer).trim())}\n\n[source: reference "${best.title ?? best.source ?? best.id}", added ${best.lastReviewed ?? "recently"}]`;
    } else if (usable && confidence !== "low") {
      draft = `${fill(String(best.answer).trim())}\n\n[source: knowledge ${best.id}${best.lastReviewed ? `, reviewed ${best.lastReviewed}` : ""}${bestSource.stale ? ", STALE: confirm before use" : ""}]`;
    } else if (r.level === "question") {
      draft = `${answerSkeleton(r, { buyer: buyer || "the buyer", owner })}${usable ? `\n\nClosest approved answer to start from: knowledge ${best.id} (similarity ${bestSource.similarity}).` : ""}`;
    } else {
      draft = `${SME} No approved answer fits this requirement closely enough. ${owner} to write it.${usable ? ` Closest approved answer: knowledge ${best.id} (similarity ${bestSource.similarity}).` : ""}`;
    }
    return {
      reqId: r.id,
      section: r.section,
      level: r.level,
      category: r.category,
      requirement: r.text,
      draft,
      sources,
      confidence,
      validationRequired: confidence !== "high",
      owner,
      status: usable && confidence !== "low" ? "Drafted" : "Not started",
    };
  });
}

/** Sentences that say what the buyer wants: the raw material for the executive summary. */
function problemStatements(text, k = 4) {
  const sents = String(text ?? "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const want = /\b(seek|seeking|looking for|intends to|objective|purpose|replace|replacement|modernize|modernise|goal|require[sd]? a|invites proposals|requests proposals)\b/i;
  return sents.filter((s) => want.test(s) && s.length > 40 && s.length < 400).slice(0, k);
}

export function buildProposal(analysis, answers, { text = "", companyName = "", profile = {}, buyer = "" } = {}) {
  const us = companyName || profile.companyName || "[Company name]";
  const them = buyer || "[Buyer]";
  const d = analysis.keyData?.dates ?? {};
  const caps = matchCapabilities(analysis.title, text).slice(0, 4);
  const problems = problemStatements(text);
  const bySection = new Map();
  for (const a of answers) {
    if (!bySection.has(a.section)) bySection.set(a.section, []);
    bySection.get(a.section).push(a);
  }
  const mand = answers.filter((a) => a.level === "mandatory");
  const pending = answers.filter((a) => a.validationRequired).length;

  const out = [
    `# Response to ${analysis.title}`,
    "",
    `Prepared for: ${them}`,
    `Prepared by: ${us}`,
    `Status: FIRST DRAFT. ${pending} of ${answers.length} answer(s) need SME validation. Not for submission until the red-team check reads Ready and a person approves it.`,
    "",
    "## 1. Executive summary",
    "",
    "**The customer's problem, in their words.**",
    ...(problems.length ? problems.map((p) => `> ${p}`) : [`> ${SME} State the buyer's problem in their own words, taken from the solicitation's background section.`]),
    "",
    "**Our proposed approach.**",
    caps.length ? `${us} proposes ${caps.map((c) => c.label.toLowerCase()).join(", ")} services scoped to the requirements below.` : `${SME} Describe the proposed approach.`,
    profile.summary ? `\n${profile.summary}` : "",
    "",
    "**Expected outcomes.**",
    `${SME} Outcomes tied to the buyer's stated objectives. Measurable where an approved metric exists; never an invented one.`,
    "",
    "**Why us.**",
    ...(profile.differentiators?.length ? profile.differentiators.map((x) => `- ${x}`) : [`${SME} Differentiators from approved claims only.`]),
    "",
    "## 2. Understanding of requirements",
    "",
    `The solicitation sets out ${answers.length} requirement(s), ${mand.length} of them mandatory, across ${bySection.size} section(s).${d.closing ? ` Responses close ${d.closing}.` : ""}${d.questions ? ` Questions are due ${d.questions}.` : ""}`,
    "",
    "## 3. Responses",
    "",
  ];
  for (const [section, list] of bySection) {
    out.push(`### ${section === "—" ? "General requirements" : section}`, "");
    for (const a of list) {
      out.push(`**${a.reqId}${a.level === "mandatory" ? " (mandatory)" : ""}.** ${a.requirement}`, "", a.draft, "", `_Confidence: ${a.confidence} · owner: ${a.owner} · status: ${a.status}_`, "");
    }
  }
  out.push(
    "## 4. Compliance matrix",
    "",
    "| Req | Mandatory | Status | Confidence | Owner |",
    "|---|---|---|---|---|",
    ...answers.map((a) => `| ${a.reqId} | ${a.level === "mandatory" ? "Yes" : "No"} | ${a.status} | ${a.confidence} | ${a.owner} |`),
    "",
    "## 5. Assumptions",
    "",
    `- ${SME} List the assumptions behind scope, timeline and pricing.`,
    "",
    "## 6. Risks and mitigations",
    "",
    ...(analysis.risks?.length ? analysis.risks.slice(0, 8).map((r) => `- **${r.label}** (${r.severity}). Mitigation: ${SME}`) : ["- None flagged by pattern matching. Legal still reviews the terms."]),
    "",
    "## 7. Commercial response",
    "",
    "Pricing is never drafted automatically. The commercial owner prepares it.",
  );
  return out.filter((x) => x !== null).join("\n").replace(/\n{3,}/g, "\n\n");
}

const GENERIC = ["best-in-class", "world-class", "cutting-edge", "state-of-the-art", "seamless", "seamlessly", "robust solution", "synergy", "synergies", "leverage", "game-changer", "unparalleled", "industry-leading", "holistic", "one-stop shop", "in today's fast-paced"];

export function redTeam(analysis, answers, proposalText = "", { now = new Date() } = {}) {
  const blocking = [], warnings = [];
  const mandOpen = answers.filter((a) => (a.level === "mandatory" || a.level === "question") && !["Approved", "Final"].includes(a.status));
  if (mandOpen.length) blocking.push(`${mandOpen.length} mandatory requirement(s) are not Approved or Final: ${mandOpen.slice(0, 8).map((a) => a.reqId).join(", ")}${mandOpen.length > 8 ? "…" : ""}`);
  const sme = answers.filter((a) => a.validationRequired && !["Approved", "Final"].includes(a.status));
  if (sme.length) blocking.push(`${sme.length} answer(s) still need SME validation`);
  const markers = (String(proposalText).match(/\[SME validation required\]|\[TODO[^\]]*\]/g) ?? []).length;
  if (markers) blocking.push(`${markers} [SME validation required] / [TODO] marker(s) remain in the proposal text`);
  const stale = new Set(answers.flatMap((a) => a.sources.filter((s) => s.stale).map((s) => s.id)));
  if (stale.size) blocking.push(`Cites ${stale.size} STALE knowledge entr(y/ies): ${[...stale].slice(0, 6).join(", ")}`);
  const close = analysis.keyData?.dates?.closing;
  if (close) {
    const days = Math.round((new Date(`${close}T00:00:00Z`) - now) / 86400000);
    if (days < 0) blocking.push(`The solicitation closed on ${close}`);
    else if (days <= 2) warnings.push(`Closes in ${days} day(s)`);
  }
  for (const r of (analysis.risks ?? []).filter((x) => x.severity === "high")) warnings.push(`High risk not yet signed off by legal or commercial: ${r.label}`);

  const used = {};
  for (const a of answers) if (a.sources[0] && a.status !== "Not started") used[a.sources[0].id] = (used[a.sources[0].id] ?? 0) + 1;
  for (const [id, n] of Object.entries(used)) if (n >= 4) warnings.push(`Knowledge entry ${id} answers ${n} different requirements; answers may be repetitive`);
  // SMEs' most frequent edit: "remove customer names". Name a comparable organization by type, never by name.
  const named = namedOrganizations(`${answers.map((a) => a.draft).join("\n")}\n${proposalText}`, analysis.buyer ?? "");
  if (named.length) blocking.push(`Named organization(s) in answers; anonymize as "a comparable [sector] organization": ${named.slice(0, 6).join(", ")}`);
  const low = String(proposalText).toLowerCase();
  const gen = GENERIC.filter((g) => low.includes(g));
  if (gen.length) warnings.push(`Generic phrasing to rewrite for this customer: ${gen.join(", ")}`);
  const pageLimit = analysis.keyData?.pageLimit;
  if (pageLimit) {
    const est = Math.ceil(String(proposalText).split(/\s+/).filter(Boolean).length / 450);
    if (est > pageLimit) blocking.push(`Estimated ${est} pages against a ${pageLimit}-page limit`);
  }
  if (analysis.keyData?.evaluation?.length) warnings.push(`Check the response is weighted to the evaluation criteria: ${analysis.keyData.evaluation.map((e) => `${e.criterion} ${e.weight}${e.unit === "%" ? "%" : " pts"}`).join("; ")}`);
  if (analysis.keyData?.submission?.includes("hard copy")) warnings.push("Hard-copy delivery required: book the courier and confirm copies");
  return {
    readiness: blocking.length ? "Needs review" : "Ready",
    blocking,
    warnings,
    checkedAt: now.toISOString(),
    note: "Ready still means a person approves the submission. Nothing is sent from this tool.",
  };
}

/** Organization names written out in text (e.g. "at Lakeside School District"), other than the buyer's. */
export function namedOrganizations(text, buyer = "") {
  const ORG = /(School District|District School Board|School Board|Board of Education|Public Library|Library|University|College|Foundation|Society|Association|Authority|Corporation|Council|Hospital|Health|City of [A-Z]\w+|Town of [A-Z]\w+|County|Municipality|Inc\.?|Ltd\.?|LLC)/;
  const hits = new Set();
  for (const m of String(text).matchAll(/\b(?:[Aa]t|[Ff]or|[Ww]ith|[Bb]y|[Ii]ncluding|[Ss]uch as)\s+(?:the\s+)?((?:[A-Z][\w&.'’-]*\s){0,5}(?:School District|District School Board|School Board|Board of Education|Public Library|Library|University|College|Foundation|Society|Association|Authority|Corporation|Council|Hospital|City of [A-Z]\w+|Town of [A-Z]\w+|County|Municipality|Inc\.?|Ltd\.?|LLC)(?:\s(?:of\s)?[A-Z]\w+)?)/g)) {
    const name = m[1].trim();
    if (!ORG.test(name) || /^(A|An|Comparable|Our|Their|The)\b/.test(name)) continue;
    if (buyer && name.toLowerCase().includes(String(buyer).toLowerCase())) continue;
    if (/^(Customer Success|Steering|Project|Customer Support|Advisory|Canadian Payments Association)\b/.test(name)) continue;
    hits.add(name);
  }
  return [...hits];
}

export default { RESPONSE_STATUSES, subAsks, answerSkeleton, draftAnswers, buildProposal, redTeam, namedOrganizations };
