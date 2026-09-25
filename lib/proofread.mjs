/**
 * Proofread a drafted response before it goes to the submission check.
 *
 * The checks a proofreader makes on every answer and the proposal text:
 * placeholders left in, misspellings, doubled words, mixed spellings, acronyms
 * never defined, sentences too long to skim, spacing and punctuation slips,
 * answers too thin to score, and generic phrasing. Each issue names where it is
 * and what to do. It flags; a person fixes the text and signs off. Nothing is
 * rewritten automatically.
 *
 * Deterministic and import-free: the browser bundle inlines it.
 */

const MISSPELT = {
  recieve: "receive", recieved: "received", seperate: "separate", seperately: "separately", occured: "occurred", occurence: "occurrence", ocurred: "occurred",
  accomodate: "accommodate", acheive: "achieve", adress: "address", begining: "beginning", beleive: "believe", calender: "calendar", comittee: "committee",
  commited: "committed", concensus: "consensus", definately: "definitely", enviroment: "environment", existance: "existence", goverment: "government",
  guarentee: "guarantee", implemention: "implementation", independant: "independent", maintainance: "maintenance", managment: "management",
  neccessary: "necessary", necesary: "necessary", occassion: "occasion", perfomance: "performance", persue: "pursue", prefered: "preferred",
  priviledge: "privilege", proffesional: "professional", recomend: "recommend", reccomend: "recommend", responsability: "responsibility",
  succesful: "successful", sucess: "success", tommorow: "tomorrow", untill: "until", wich: "which", withold: "withhold", acknowlege: "acknowledge",
  aquire: "acquire", buisness: "business", colaborate: "collaborate", compatable: "compatible", comunication: "communication", critera: "criteria",
  stakholder: "stakeholder", stakholders: "stakeholders", porposal: "proposal", proposel: "proposal", requirments: "requirements", requirment: "requirement",
  schedual: "schedule", teh: "the", adn: "and", thier: "their", accross: "across", completly: "completely", curently: "currently",
  developement: "development", equiptment: "equipment", finaly: "finally", immediatly: "immediately", knowlege: "knowledge", liason: "liaison",
  noticable: "noticeable", paralell: "parallel", publically: "publicly", relevent: "relevant", resourse: "resource", similiar: "similar",
  sofware: "software", suport: "support", techincal: "technical", transfered: "transferred", truely: "truly", usefull: "useful", vender: "vendor",
  intergration: "integration", intergrate: "integrate", migraton: "migration", excercise: "exercise", reciept: "receipt", mantain: "maintain",
  benifit: "benefit", benifits: "benefits", comitment: "commitment", conveinent: "convenient", experiance: "experience", facilitiate: "facilitate",
};
// Both spellings are right somewhere; using both in one response is not.
const VARIANTS = [["organization", "organisation"], ["organizations", "organisations"], ["prioritize", "prioritise"], ["color", "colour"], ["center", "centre"],
  ["behavior", "behaviour"], ["analyze", "analyse"], ["optimize", "optimise"], ["favor", "favour"], ["labor", "labour"], ["catalog", "catalogue"],
  ["defense", "defence"], ["fulfill", "fulfil"], ["enroll", "enrol"], ["modeling", "modelling"], ["canceled", "cancelled"], ["e-mail", "email"],
  ["web site", "website"], ["on-line", "online"], ["log-in", "login"]];
// Acronyms evaluators know without a definition.
const KNOWN = new Set(("RFP RFQ RFI RFSQ RFO SOW ERP HR HRIS IT USA US CA UK EU PDF API SSO ID AI PM UAT KPI SLA FAQ CEO CFO CIO CTO VP Q&A QA " +
  "SaaS SQL HTML CSS XML JSON CSV PST EST EDT PDT UTC GST HST PST TBD N/A OK FY ISO SOC GDPR CPU GB TB MB ETA ROI TCO AODA WCAG MFA VPN LAN " +
  "WAN DNS HTTPS HTTP URL CRM BI GIS K-12 K12 PO CAD USD NA SME").split(" "));
const GENERIC = ["best-in-class", "world-class", "cutting-edge", "state-of-the-art", "seamless", "seamlessly", "robust solution", "synergy", "synergies",
  "leverage", "game-changer", "unparalleled", "industry-leading", "holistic", "one-stop shop", "in today's fast-paced", "second to none", "turnkey"];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const excerpt = (text, i, len = 70) => {
  const s = Math.max(0, i - 30);
  return `${s ? "…" : ""}${text.slice(s, i + len).replace(/\s+/g, " ").trim()}${i + len < text.length ? "…" : ""}`;
};
const sentencesOf = (t) => String(t).replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).map((s) => s.trim()).filter((s) => s.length > 1);

/**
 * `answers`: drafted answers ({ reqId, level, draft, status }); `proposal`: the proposal text.
 * Returns issues (most severe first), counts, simple readability stats and a verdict.
 */
export function proofread(answers = [], proposal = "", { companyName = "", now = new Date() } = {}) {
  const issues = [];
  const add = (where, severity, kind, text, suggestion) => issues.push({ where, severity, kind, text, suggestion });
  const parts = [...(answers ?? []).map((a) => ({ where: `Answer ${a.reqId}`, text: String(a.draft ?? ""), a })), ...(proposal ? [{ where: "Proposal", text: String(proposal) }] : [])];
  const all = parts.map((p) => p.text).join("\n\n");

  for (const { where, text, a } of parts) {
    if (!text.trim()) { if (a && ["mandatory", "question"].includes(a.level)) add(where, "high", "missing answer", "No answer written yet.", "Write the answer or mark the requirement as not applicable with the buyer's agreement."); continue; }
    for (const m of text.matchAll(/\[SME validation required\]|\[TODO[^\]]*\]|\[(?:Company name|Buyer|Client|Customer|Insert[^\]]*|XX+)\]|\{buyer\}|\bTBD\b|\bXXX+\b|lorem ipsum/gi))
      add(where, "high", "placeholder", excerpt(text, m.index), `Replace "${m[0]}" with the real content before submission.`);
    for (const m of text.matchAll(/\b([A-Za-z]+)\b/g)) {
      const fix = MISSPELT[m[1].toLowerCase()];
      if (fix) add(where, "medium", "spelling", excerpt(text, m.index), `"${m[1]}" → "${fix}"`);
    }
    for (const m of text.matchAll(/\b([A-Za-z]{2,})\s+\1\b/gi)) if (!/^(had|that|is)$/i.test(m[1])) add(where, "medium", "doubled word", excerpt(text, m.index), `Remove the repeated "${m[1]}".`);
    if (a && ["mandatory", "question"].includes(a.level)) {
      const words = text.replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter(Boolean).length;
      if (words < 25) add(where, "medium", "thin answer", `${words} word(s).`, "Too short for an evaluator to score: answer every part of the requirement, with how and an example.");
    }
    for (const s of sentencesOf(text)) {
      const w = s.split(/\s+/).length;
      if (w > 40) add(where, "low", "long sentence", `${s.slice(0, 90)}… (${w} words)`, "Split it: evaluators skim, and long sentences hide the answer.");
    }
    for (const m of text.matchAll(/ {2,}(?=\S)|\s+[,.;:](?!\d)|[a-z][.!?][A-Z][a-z]/g)) add(where, "low", "spacing", excerpt(text, m.index, 40), "Fix the spacing around the punctuation.");
    if (/!/.test(text.replace(/\[[^\]]*\]/g, ""))) add(where, "low", "tone", excerpt(text, text.indexOf("!")), "Avoid exclamation marks in a proposal.");
    const open = (text.match(/\(/g) ?? []).length, close = (text.match(/\)/g) ?? []).length;
    if (open !== close) add(where, "low", "punctuation", `${open} "(" and ${close} ")".`, "Close every bracket.");
    const low = text.toLowerCase();
    const gen = GENERIC.filter((g) => low.includes(g));
    if (gen.length) add(where, "low", "generic phrasing", gen.join(", "), "Say what you will do for this buyer instead.");
  }

  // Across the whole response: mixed spellings, undefined acronyms, the company's own name.
  const lowAll = all.toLowerCase();
  for (const [x, y] of VARIANTS) {
    const nx = (lowAll.match(new RegExp(`\\b${esc(x)}\\b`, "g")) ?? []).length, ny = (lowAll.match(new RegExp(`\\b${esc(y)}\\b`, "g")) ?? []).length;
    if (nx && ny) add("Whole response", "low", "mixed spelling", `"${x}" ×${nx} and "${y}" ×${ny}`, `Use one spelling throughout (${nx >= ny ? x : y}).`);
  }
  const defined = new Set([...all.matchAll(/\(([A-Z][A-Za-z0-9&-]{1,7})\)/g)].map((m) => m[1]));
  const seen = new Set();
  const plain = all.replace(/\[[^\]]*\]/g, " ");
  for (const m of plain.matchAll(/\b([A-Z][A-Z0-9&]{1,4}s?)\b/g)) {
    const ac = m[1].replace(/s$/, "");
    if (ac.length < 2 || KNOWN.has(ac) || KNOWN.has(m[1]) || defined.has(ac) || seen.has(ac) || /^\d/.test(ac)) continue;
    // A word in an all-caps heading or name ("HARBORLINE SYSTEMS") is not an acronym.
    const before = plain.slice(Math.max(0, m.index - 20), m.index).match(/([A-Za-z]+)\W*$/)?.[1] ?? "", after = plain.slice(m.index + m[0].length, m.index + m[0].length + 20).match(/^\W*([A-Za-z]+)/)?.[1] ?? "";
    if ((before.length >= 3 && before === before.toUpperCase()) || (after.length >= 3 && after === after.toUpperCase())) continue;
    seen.add(ac);
    add("Whole response", "low", "acronym", excerpt(all, m.index, 40), `Define "${ac}" on first use, e.g. "Full Name (${ac})".`);
    if (seen.size >= 8) break;
  }
  if (companyName && companyName.length >= 3) {
    const forms = new Set([...all.matchAll(new RegExp(`\\b${esc(companyName)}\\b`, "gi"))].map((m) => m[0]));
    forms.delete(companyName);
    if (forms.size) add("Whole response", "low", "company name", [...forms].slice(0, 3).join(", "), `Write the company name as "${companyName}" every time.`);
  }

  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((p, q) => order[p.severity] - order[q.severity]);
  const sentences = sentencesOf(all), words = all.split(/\s+/).filter(Boolean).length;
  const counts = { high: issues.filter((i) => i.severity === "high").length, medium: issues.filter((i) => i.severity === "medium").length, low: issues.filter((i) => i.severity === "low").length };
  return {
    checkedAt: now.toISOString(),
    issues: issues.slice(0, 200),
    counts,
    stats: { words, sentences: sentences.length, avgWords: sentences.length ? Math.round(words / sentences.length) : 0, longSentences: issues.filter((i) => i.kind === "long sentence").length },
    verdict: counts.high ? "Fix before submission" : counts.medium ? "Needs a pass" : "Clean",
    note: "Proofreading flags; a person fixes the text and signs off. Nothing is changed automatically.",
  };
}

export default { proofread };
