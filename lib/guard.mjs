/**
 * Hard boundary: the sweeper never links to, reads from or writes to an internal
 * tool. It reads public procurement pages and nothing else.
 *
 * "Internal tool" means anything a company runs its work in: ticketing and wiki
 * (Jira, Confluence), CRM (Salesforce, Certinia, HubSpot), Microsoft 365
 * (SharePoint, Teams, Outlook, OneDrive, Dynamics / Business Central), Slack,
 * Google Workspace, helpdesks, work managers, call recorders — and any private
 * or intranet address. Findings and action items live only in the local ledger,
 * the Excel workbook and the dashboard.
 *
 * Enforced in four places:
 *   1. every outbound fetch, and every redirect hop, goes through assertAllowedUrl()
 *   2. a finding whose link points at a blocked host has the link removed
 *   3. scripts/validate.mjs scans all config, data and generated workflows with
 *      findBlocked() and fails CI on any hit
 *   4. the Claude Code agent definition grants no MCP / connector tools at all
 *
 * A tenant can block more hosts with guard.extraBlockedHosts; it cannot unblock these.
 *
 * Import-free on purpose: build-workflows.mjs inlines it into the n8n Code nodes.
 */

const INTERNAL_TOOL_DOMAINS = [
  // Atlassian
  "atlassian.net", "atlassian.com", "jira.com", "bitbucket.org", "statuspage.io", "trello.com",
  // CRM / PSA
  "salesforce.com", "force.com", "salesforce-sites.com", "visualforce.com", "certinia.com", "financialforce.com",
  "hubspot.com", "hubapi.com", "hs-sites.com", "dynamics.com", "zoho.com", "pipedrive.com",
  // Microsoft 365
  "sharepoint.com", "sharepoint-df.com", "office.com", "office.net", "office365.com", "microsoft365.com",
  "teams.microsoft.com", "teams.live.com", "outlook.com", "outlook.office.com", "outlook.office365.com",
  "onedrive.live.com", "1drv.ms", "graph.microsoft.com", "powerbi.com", "powerapps.com", "powerautomate.com",
  "businesscentral.dynamics.com", "login.microsoftonline.com", "azurewebsites.net",
  // Google Workspace
  "docs.google.com", "drive.google.com", "sheets.google.com", "slides.google.com", "mail.google.com",
  "calendar.google.com", "chat.google.com", "sites.google.com",
  // Chat, work management, docs
  "slack.com", "slack-edge.com", "notion.so", "notion.site", "monday.com", "asana.com", "clickup.com",
  "airtable.com", "smartsheet.com", "coda.io", "box.com", "dropbox.com", "miro.com", "lucid.app", "loom.com",
  // Helpdesk / ITSM
  "freshdesk.com", "freshservice.com", "zendesk.com", "servicenow.com", "service-now.com",
  // Sales tooling
  "sybill.ai", "clay.com", "gong.io", "outreach.io", "salesloft.com", "zoominfo.com", "docusign.net", "docusign.com",
  // Automation consoles
  "n8n.cloud", "zapier.com", "make.com",
];

const INTERNAL_HOST_PATTERNS = [
  /(^|\.)jira\./i,
  /(^|\.)confluence\./i,
  /(^|\.)wiki\./i,
  /(^|\.)intranet\./i,
  /\.(local|localhost|internal|intranet|corp|lan|home|private)$/i,
  /^localhost$/i,
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./,
  /^\[(::1|::ffff:|f[cd][0-9a-f]{0,2}:|fe80:)/i,
];

const INTERNAL_PATHS = [/\/wiki\/spaces\//i, /\/rest\/api\/\d+\/issue/i, /\/browse\/[A-Z][A-Z0-9]+-\d+/, /\/lightning\/r\//i, /\/sites\/[^/]+\/_layouts\//i];

function hostBlocked(host, extra) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  const domains = [...INTERNAL_TOOL_DOMAINS, ...(extra ?? [])].map((d) => String(d).toLowerCase());
  if (domains.some((d) => h === d || h.endsWith(`.${d}`))) return `${h} is an internal tool`;
  if (INTERNAL_HOST_PATTERNS.some((re) => re.test(h))) return `${h} is a private or intranet address`;
  if (!h.includes(".")) return `${h} is a single-label intranet host`;
  return null;
}

/** Why a URL is refused, or null if it is a public page the sweeper may read. */
export function blockedReason(url, extraBlockedHosts = []) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return `${u.protocol} links are not allowed`;
  const byHost = hostBlocked(u.hostname, extraBlockedHosts);
  if (byHost) return byHost;
  if (INTERNAL_PATHS.some((re) => re.test(u.pathname))) return `${u.pathname} looks like an internal-tool path`;
  return null;
}

export function assertAllowedUrl(url, extraBlockedHosts = []) {
  const why = blockedReason(url, extraBlockedHosts);
  if (why) throw new Error(`Blocked: ${why}. The sweeper does not link to or read internal tools.`);
  return url;
}

/** A link that may be stored and shown, or null. Used on every finding. */
export function safeLink(url, extraBlockedHosts = []) {
  return url && !blockedReason(url, extraBlockedHosts) ? url : null;
}

/** Walk any JSON value and return every URL in it that points at an internal tool. */
export function findBlocked(value, where = "$", extraBlockedHosts = []) {
  const hits = [];
  const walk = (v, p) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
        const why = blockedReason(m[0], extraBlockedHosts);
        if (why) hits.push({ path: p, url: m[0], why });
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
  };
  walk(value, where);
  return hits;
}

export default { blockedReason, assertAllowedUrl, safeLink, findBlocked };
