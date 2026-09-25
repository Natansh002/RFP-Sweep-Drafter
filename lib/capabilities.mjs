/**
 * What people search by: Industry → Geography → Capability → Date range.
 * No company or tenant needs configuring.
 *
 * A capability is a keyword set (what a solicitation says when it wants that
 * service) plus the roles who would own it. The roles come from the capability
 * matrix in config/capability-matrix.json when present; these are defaults.
 *
 * Import-free: runs in Node, in the n8n Code nodes and in the browser bundle.
 */

export const CAPABILITIES = [
  { id: "erp", label: "ERP / Finance implementation", practice: "Finance Practice",
    title: ["ERP", "enterprise resource planning", "financial management system", "financial system", "finance system", "accounting system", "accounting software", "general ledger", "Dynamics 365", "Dynamics GP", "Microsoft Dynamics", "Business Central", "fund accounting", "budgeting system"],
    body: ["end of life", "end-of-life", "consolidated reporting", "multi-entity", "intercompany", "chart of accounts", "accounts payable", "purchase order", "procure to pay", "fixed assets", "grant accounting", "fund accounting", "financial reporting"] },
  { id: "hcm", label: "HR / HCM implementation", practice: "HR Practice",
    title: ["HRIS", "HRMS", "HCM", "human resources information system", "human capital management", "human resources system", "talent management", "applicant tracking"],
    body: ["position control", "employee self service", "manager self service", "onboarding", "performance management", "collective agreement", "seniority"] },
  { id: "payroll", label: "Payroll implementation", practice: "Payroll Practice",
    title: ["payroll system", "payroll services", "payroll software", "payroll", "time and attendance", "timekeeping", "absence management", "scheduling and absence"],
    body: ["T4", "ROE", "W-2", "pay runs", "timesheets", "leave management", "garnishment"] },
  { id: "sis", label: "Student information system", practice: "Education Practice",
    title: ["student information system", "SIS", "student records system", "learning management system"],
    body: ["report cards", "attendance tracking", "timetabling", "enrolment", "enrollment", "gradebook"] },
  { id: "payments", label: "School / online payments", practice: "Payments Practice",
    title: ["cashless", "cashless transaction", "transaction management solution", "school cash", "online payments", "payment processing", "payment platform", "fee management", "student fees", "school fees", "e-commerce", "point of sale"],
    body: ["parent payments", "school activity fees", "field trip", "online store", "payment gateway", "merchant", "cash handling", "reconciliation of payments", "school generated funds"] },
  { id: "integration", label: "System integration", practice: "Technical Services",
    title: ["system integration", "systems integration", "integration services", "integration platform", "middleware"],
    body: ["interfaces", "integrate with", "single sign-on", "data exchange", "web services", "iPaaS", "API"] },
  { id: "migration", label: "Data migration", practice: "Data Practice",
    title: ["data migration", "data conversion", "legacy system replacement"],
    body: ["legacy data", "data cleansing", "historical data", "conversion of", "migrate data", "cutover", "modernization", "modernisation", "system replacement"] },
  { id: "saas", label: "SaaS implementation", practice: "Implementation Services",
    title: ["SaaS", "software as a service", "cloud solution", "cloud-based solution", "implementation services", "software implementation", "system implementation"],
    body: ["subscription", "hosted solution", "configuration", "go-live", "user acceptance testing", "implementation partner"] },
  { id: "managed", label: "Managed services / support", practice: "Support / Customer Success",
    title: ["managed services", "application support", "support and maintenance", "application management services", "help desk services"],
    body: ["service level", "SLA", "tier 2", "tier 3", "ongoing support", "maintenance and support"] },
  { id: "consulting", label: "Professional services / consulting", practice: "Professional Services",
    title: ["consulting services", "professional services", "advisory services", "business analysis", "digital transformation", "change management services"],
    body: ["requirements gathering", "business process", "fit-gap", "roadmap", "change management", "training services"] },
  { id: "payments", label: "School payments / cashless (SchoolDay)", practice: "Payments Practice",
    title: ["cashless", "cashless transaction", "school payments", "school cash", "online payments", "payment processing", "fee management", "transaction management", "student fees", "SchoolDay"],
    body: ["field trips", "cafeteria payments", "parent portal", "online payment", "fee collection", "point of sale", "payment gateway"] },
  { id: "tms", label: "Courier / delivery management software", practice: "Logistics Practice",
    title: ["courier", "delivery management", "last mile", "last-mile", "dispatch software", "route optimization", "transportation management system"],
    body: ["proof of delivery", "chain of custody", "driver app", "same-day delivery", "specimen transport"] },
];

export const GEOGRAPHIES = [
  { id: "na", label: "North America", countries: ["CA", "US"] },
  { id: "ca", label: "Canada", countries: ["CA"] },
  { id: "us", label: "United States", countries: ["US"] },
];

export const DATE_RANGES = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
  { id: "any", label: "Any open opportunity", days: null },
];

/** Default capability → role matrix. Roles only, never people. */
export const DEFAULT_MATRIX = {
  roles: {
    opportunityOwner: "Sales Exec",
    commercialOwner: "Commercial Lead",
    executiveSponsor: "Practice Director",
    technicalLead: "Solutions Architect",
    bidManager: "RFP Manager",
  },
  byCapability: Object.fromEntries(CAPABILITIES.map((c) => [c.id, { solutionLead: `${c.practice} Lead`, sme: `${c.practice} SME` }])),
  byCategory: {
    security: "Security SME", legal: "Legal", insurance: "Legal", pricing: "Commercial Lead", data: "Data Practice SME",
    integration: "Technical Services SME", implementation: "Delivery Lead", training: "Training Lead", support: "Support / Customer Success",
    format: "RFP Manager", form: "RFP Manager", experience: "RFP Manager", accessibility: "Delivery Lead", functional: "Solution Lead", general: "RFP Manager",
  },
};

const lower = (s) => String(s ?? "").toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hit = (text, k) => new RegExp(`(^|[^a-z0-9])${esc(lower(k))}($|[^a-z0-9])`).test(text);

/** Which capabilities a title + text asks for, strongest first, with the words that matched. */
export function matchCapabilities(title, text = "") {
  const t = lower(title), b = lower(text);
  return CAPABILITIES.map((c) => {
    const th = c.title.filter((k) => hit(t, k));
    const bh = [...c.title, ...c.body].filter((k) => hit(b, k));
    return { id: c.id, label: c.label, score: th.length * 3 + new Set(bh).size, matched: [...new Set([...th, ...bh])].slice(0, 8) };
  }).filter((m) => m.score >= 2).sort((a, b) => b.score - a.score);
}

/**
 * Merge chosen capabilities into a pack, so a sweep for "K-12 + Payroll" or
 * "Any industry + Data migration" searches for exactly that.
 */
export function packForSearch(pack, capabilityIds = []) {
  const caps = CAPABILITIES.filter((c) => capabilityIds.includes(c.id));
  if (!caps.length) return pack;
  const titleKw = caps.flatMap((c) => c.title), bodyKw = caps.flatMap((c) => c.body);
  const anyIndustry = pack.id === "any";
  return {
    ...pack,
    qualifiers: {
      ...(pack.qualifiers ?? {}),
      // "Any industry": the capability is the whole query. An industry pack: the capability adds to it.
      titleKeywords: [...new Set([...(anyIndustry ? [] : pack.qualifiers?.titleKeywords ?? []), ...titleKw])],
      bodyKeywords: [...new Set([...(anyIndustry ? [] : pack.qualifiers?.bodyKeywords ?? []), ...bodyKw])],
    },
    searchTerms: [...new Set([...caps.flatMap((c) => c.title.slice(0, 3)), ...(anyIndustry ? [] : (pack.searchTerms ?? []).slice(0, 3))])].slice(0, 10),
    capabilityFilter: caps.map((c) => c.id),
  };
}

/** Recommended team for an opportunity, from the capabilities it asks for. Roles only. */
export function recommendTeam(capabilityMatches, matrix = DEFAULT_MATRIX) {
  const r = matrix.roles ?? DEFAULT_MATRIX.roles;
  const top = capabilityMatches[0];
  const byCap = (id) => matrix.byCapability?.[id] ?? DEFAULT_MATRIX.byCapability[id] ?? {};
  return {
    opportunityOwner: r.opportunityOwner,
    bidManager: r.bidManager,
    solutionLead: top ? byCap(top.id).solutionLead : "Solution Lead",
    technicalLead: r.technicalLead,
    commercialOwner: r.commercialOwner,
    executiveSponsor: r.executiveSponsor,
    smes: [...new Set(capabilityMatches.slice(0, 4).map((m) => byCap(m.id).sme).filter(Boolean))],
    why: top ? `Leads on ${top.label} (matched ${top.matched.slice(0, 4).join(", ")})` : "No capability matched clearly; the bid manager triages.",
  };
}

/** Owner role for one requirement, by its category. */
export function ownerForCategory(category, matrix = DEFAULT_MATRIX) {
  return matrix.byCategory?.[category] ?? DEFAULT_MATRIX.byCategory[category] ?? "RFP Manager";
}

export default { CAPABILITIES, GEOGRAPHIES, DATE_RANGES, DEFAULT_MATRIX, matchCapabilities, packForSearch, recommendTeam, ownerForCategory };
