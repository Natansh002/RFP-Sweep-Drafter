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
    body: ["end of life", "end-of-life", "consolidated reporting", "multi-entity", "intercompany", "chart of accounts", "accounts payable", "purchase order", "procure to pay", "fixed assets", "grant accounting", "fund accounting", "financial reporting", "financial management", "budgeting", "grant management", "procurement", "expense management", "accounting"] },
  { id: "hcm", label: "HR / HCM implementation", practice: "HR Practice",
    title: ["HRIS", "HRMS", "HCM", "human resources information system", "human capital management", "human resources system", "HR system", "HR software", "HR and payroll", "talent management", "applicant tracking"],
    body: ["position control", "employee self service", "manager self service", "onboarding", "performance management", "collective agreement", "seniority", "human resources", "HR", "workforce management", "recruiting", "benefits administration"] },
  { id: "payroll", label: "Payroll implementation", practice: "Payroll Practice",
    title: ["payroll system", "payroll services", "payroll software", "payroll", "time and attendance", "timekeeping", "absence management", "scheduling and absence"],
    body: ["T4", "ROE", "W-2", "pay runs", "timesheets", "leave management", "garnishment"] },
  { id: "sis", label: "Student information system", practice: "Education Practice",
    title: ["student information system", "SIS", "student records system", "learning management system"],
    body: ["report cards", "attendance tracking", "timetabling", "enrolment", "enrollment", "gradebook"] },
  { id: "payments", label: "School / online payments (SchoolDay)", practice: "Payments Practice",
    title: ["cashless", "cashless transaction", "transaction management", "transaction management solution", "school payments", "school cash", "online payments", "payment processing", "payment platform", "fee management", "student fees", "school fees", "e-commerce", "point of sale", "SchoolDay"],
    body: ["parent payments", "school activity fees", "field trip", "field trips", "cafeteria payments", "parent portal", "online payment", "fee collection", "online store", "payment gateway", "merchant", "cash handling", "reconciliation of payments", "school generated funds"] },
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
  { id: "security", label: "Cybersecurity", practice: "Security Practice",
    title: ["cybersecurity", "cyber security", "security operations", "managed detection", "penetration testing", "vulnerability assessment", "SOC services", "identity and access management"],
    body: ["threat detection", "incident response", "SIEM", "endpoint protection", "zero trust", "security awareness", "phishing", "ransomware"] },
  { id: "crm", label: "CRM / constituent management", practice: "CRM Practice",
    title: ["CRM", "customer relationship management", "constituent relationship management", "donor management", "fundraising software", "contact centre", "contact center"],
    body: ["donor", "fundraising", "constituent", "case tracking", "customer service", "outreach", "membership management"] },
  { id: "casemgmt", label: "Case management", practice: "Case Management Practice",
    title: ["case management system", "case management software", "client management system", "electronic health record", "EHR", "grants management system", "licensing system", "permitting system"],
    body: ["case notes", "client records", "intake", "eligibility", "referrals", "service delivery", "permits", "inspections"] },
  { id: "gis", label: "GIS / asset management", practice: "Asset Practice",
    title: ["GIS", "geographic information system", "asset management system", "enterprise asset management", "CMMS", "work order management", "facility management system", "fleet management system"],
    body: ["work orders", "preventive maintenance", "asset register", "mapping", "ArcGIS", "Esri", "fleet", "facilities"] },
  { id: "docmgmt", label: "Document / records management", practice: "Content Practice",
    title: ["document management system", "records management system", "enterprise content management", "electronic records", "digitization services", "scanning services"],
    body: ["retention schedule", "records retention", "document imaging", "e-signature", "workflow automation", "metadata"] },
  { id: "analytics", label: "Data, analytics and BI", practice: "Data Practice",
    title: ["business intelligence", "data analytics", "data warehouse", "analytics platform", "reporting solution", "data platform", "dashboards"],
    body: ["Power BI", "Tableau", "data visualization", "KPI", "data governance", "predictive analytics", "machine learning"] },
  { id: "web", label: "Web, digital and CMS", practice: "Digital Practice",
    title: ["website redesign", "website development", "content management system", "web portal", "digital services", "mobile app development", "accessibility audit"],
    body: ["WCAG", "user experience", "UX", "Drupal", "WordPress", "hosting", "SEO"] },
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

/** The four roles on every bid. Roles only, never people. */
export const ROLES = ["RFP Manager", "Pre-sales Consultant", "Account Executive", "SME Contributor"];

/** Default capability → role matrix: who owns the response, the solution, the customer and the subject answers. */
export const DEFAULT_MATRIX = {
  roles: { rfpManager: "RFP Manager", presales: "Pre-sales Consultant", accountExecutive: "Account Executive", sme: "SME Contributor" },
  // The subject area an SME Contributor answers for, per capability.
  byCapability: Object.fromEntries(CAPABILITIES.map((c) => [c.id, { area: c.label }])),
  byCategory: {
    security: "Pre-sales Consultant", legal: "Account Executive", insurance: "Account Executive", pricing: "Account Executive", data: "Pre-sales Consultant",
    integration: "Pre-sales Consultant", implementation: "Pre-sales Consultant", training: "SME Contributor", support: "SME Contributor",
    format: "RFP Manager", form: "RFP Manager", experience: "Account Executive", accessibility: "Pre-sales Consultant", functional: "SME Contributor", general: "RFP Manager",
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
export function packForSearch(pack, capabilityIds = [], extra = null) {
  const caps = CAPABILITIES.filter((c) => capabilityIds.includes(c.id));
  if (!caps.length && !extra) return pack;
  // `extra` carries a company profile's own terms (lib/profile.mjs profileSearch).
  const titleKw = [...caps.flatMap((c) => c.title), ...(extra?.titleKeywords ?? [])], bodyKw = [...caps.flatMap((c) => c.body), ...(extra?.bodyKeywords ?? [])];
  const anyIndustry = pack.id === "any";
  return {
    ...pack,
    qualifiers: {
      ...(pack.qualifiers ?? {}),
      // "Any industry": the capability is the whole query. An industry pack: the capability adds to it.
      titleKeywords: [...new Set([...(anyIndustry ? [] : pack.qualifiers?.titleKeywords ?? []), ...titleKw])],
      bodyKeywords: [...new Set([...(anyIndustry ? [] : pack.qualifiers?.bodyKeywords ?? []), ...bodyKw])],
    },
    // The pack's own terms first (a sweep reads only the first few), then the company's, then the capabilities'.
    searchTerms: [...new Set([...(anyIndustry ? [] : (pack.searchTerms ?? []).slice(0, 3)), ...(extra?.searchTerms ?? []).slice(0, 3), ...caps.flatMap((c) => c.title.slice(0, 2))])].slice(0, 10),
    capabilityFilter: caps.map((c) => c.id),
  };
}

/** Recommended team for an opportunity, from the capabilities it asks for: the four roles, and the SME areas needed. */
export function recommendTeam(capabilityMatches, matrix = DEFAULT_MATRIX) {
  const r = { ...DEFAULT_MATRIX.roles, ...(matrix.roles?.rfpManager ? matrix.roles : {}) };
  const top = capabilityMatches[0];
  const byCap = (id) => matrix.byCapability?.[id] ?? DEFAULT_MATRIX.byCapability[id] ?? {};
  return {
    rfpManager: r.rfpManager,
    presales: r.presales,
    accountExecutive: r.accountExecutive,
    sme: r.sme,
    smeAreas: [...new Set(capabilityMatches.slice(0, 4).map((m) => byCap(m.id).area ?? m.label).filter(Boolean))],
    why: top ? `Mainly ${top.label} (matched ${top.matched.slice(0, 4).join(", ")})` : "No capability matched clearly; the RFP Manager triages.",
  };
}

/** Owner role for one requirement, by its category. */
export function ownerForCategory(category, matrix = DEFAULT_MATRIX) {
  return matrix.byCategory?.[category] ?? DEFAULT_MATRIX.byCategory[category] ?? "RFP Manager";
}

export default { CAPABILITIES, GEOGRAPHIES, DATE_RANGES, ROLES, DEFAULT_MATRIX, matchCapabilities, packForSearch, recommendTeam, ownerForCategory };
