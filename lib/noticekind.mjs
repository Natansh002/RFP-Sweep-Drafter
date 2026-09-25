/**
 * Contractor roles: notices that rent a person, not buy a solution.
 *
 * Federal resource requests read like job ads: "A.6 Programmer / Software Developer –
 * Level 3 (Senior)" under TBIPS or ProServices, staff augmentation, "one (1) senior
 * developer". A software or services company rarely bids on them, so the sweep keeps
 * them out of the pipeline, company fit caps them, and the results hide them unless
 * asked. Deliberately narrow: a services RFP (an ERP implementation, a CMS rebuild) is
 * not a contractor role.
 *
 * Import-free: the browser bundle inlines it.
 */

const ROLE = "(programmers?|software developers?|developers?|programmer\\s*/\\s*analysts?|analysts?|architects?|project (managers?|leaders?|coordinators?)|business analysts?|systems analysts?|data analysts?|testers?|quality assurance (analysts?|specialists?)|technical writers?|consultants?|specialists?|administrators?|designers?|engineers?|trainers?|scrum masters?|product owners?|technicians?)";
// TBIPS / ProServices stream codes before a role: "A.6 Programmer", "B.7 Business Analyst".
const STREAM = new RegExp(`\\b[A-I]\\.\\d{1,2}\\b\\s*[-–:,]?\\s*(senior\\s+|junior\\s+|intermediate\\s+)?${ROLE}`, "i");
// A role at a set level: "Developer(s) – Level 3 (Senior)", "Business Analyst Level 2".
const LEVEL = new RegExp(`${ROLE}\\)?[^.;]{0,80}?\\b(level\\s*[1-4]\\b|\\((junior|intermediate|senior)\\))`, "i");
// Resource-based programmes (SBIPS, being solutions-based, is left out on purpose).
const PROGRAMME = /\b(TBIPS|ProServices|task[- ]based informatics professional services|temporary help services|staff augmentation|resource augmentation|contractor resources?|resource requirements?)\b/i;
const COUNTED = new RegExp(`\\b(one|two|three|four|five|\\d+)\\s*(\\(\\d+\\)\\s*)?(full[- ]time\\s+|part[- ]time\\s+)?(senior\\s+|intermediate\\s+|junior\\s+)?${ROLE}\\b`, "i");
const ONLY_ROLE = new RegExp(`^\\s*(\\d{4,}\\s+)?(senior\\s+|junior\\s+|intermediate\\s+)?${ROLE}\\b`, "i");

/** Why a notice is a contractor role (a plain reason), or null when it is not one. */
export function contractorRole(title, text = "") {
  const t = String(title ?? ""), body = String(text ?? "");
  if (STREAM.test(t)) return "a TBIPS / ProServices resource request for a named contractor role";
  if (LEVEL.test(t)) return "a request for a contractor at a set level (a role, not a solution)";
  if (PROGRAMME.test(t)) return "a staff-augmentation (resource) request";
  if (ONLY_ROLE.test(t) && (PROGRAMME.test(body) || COUNTED.test(body))) return "a request for contractor resources";
  return null;
}

export default { contractorRole };
