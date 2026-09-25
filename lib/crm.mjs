/**
 * Sales-platform opportunity fields for an RFP, for Salesforce, HubSpot or
 * Dynamics 365. Used by the MCP server (and shown in the local dashboard): a
 * person confirms, their own sales-platform connector creates the record, and
 * the record's id is linked back locally. Nothing here calls a sales platform.
 *
 * Import-free: the browser bundle inlines it.
 */

export const CRM_PLATFORMS = ["salesforce", "hubspot", "dynamics365", "generic"];
export const CRM_NAMES = { salesforce: "Salesforce", hubspot: "HubSpot", dynamics365: "Dynamics 365", generic: "Other sales platform" };
const HOSTS = { salesforce: /(^|\.)(salesforce\.com|force\.com)$/i, hubspot: /(^|\.)hubspot\.com$/i, dynamics365: /(^|\.)dynamics\.com$/i, generic: /\./ };

const money = (v) => `$${Math.round(v).toLocaleString("en-US")}`;

/** The opportunity fields for one RFP finding on one platform, with what the person must still decide. */
export function crmPayload(f, platform = "salesforce", { profile = null } = {}) {
  const k = f.rfp?.keyData ?? {};
  const questions = k.dates?.questions ?? f.keyDates?.questions ?? null;
  const value = f.estimatedValue ?? k.value?.amount ?? null;
  const name = `RFP: ${f.title}`.slice(0, 120);
  const facts = [
    `Buyer: ${f.buyer ?? "not stated"}`,
    f.closeDate && `Closes: ${f.closeDate}`,
    questions && `Questions due: ${questions}`,
    value && `Stated value: ${money(value)}`,
    k.contractTerm && `Contract term: ${k.contractTerm}${k.renewals ? ` (${k.renewals})` : ""}`,
    k.evaluation?.length && `Evaluation: ${k.evaluation.map((e) => (e.weight != null ? `${e.criterion} ${e.weight}${e.unit === "%" ? "%" : " pts"}` : e.criterion)).join("; ")}`,
    k.evaluationBasis && `Basis of award: ${k.evaluationBasis}`,
    f.url && `Solicitation: ${f.url}`,
    `RFP Sweep id: ${f.id}`,
  ].filter(Boolean);
  const description = [`Public RFP found by RFP Sweep${profile?.name ? ` for ${profile.name}` : ""}.`, ...facts].join("\n").slice(0, 30000);
  const nextStep = (questions && questions >= new Date().toISOString().slice(0, 10) ? `Send questions by ${questions}` : f.closeDate ? `Go/no-go before ${f.closeDate}` : "Go/no-go").slice(0, 255);
  const stage = f.status === "Submitted" ? "proposal" : ["Pursuing", "Drafting"].includes(f.status) ? "qualified" : "prospecting";
  const decide = ["Check the stage, owner and record type against your own setup before creating."];
  if (value == null) decide.push("No value was published: leave Amount empty or enter your own estimate.");

  if (platform === "salesforce") return {
    platform, object: "Opportunity",
    fields: { Name: name, CloseDate: f.closeDate ?? null, StageName: { prospecting: "Prospecting", qualified: "Qualification", proposal: "Proposal/Price Quote" }[stage], Amount: value, LeadSource: "RFP", Type: "New Business", NextStep: nextStep, Description: description },
    lookups: { AccountId: `Look up the Account for "${f.buyer ?? "the buyer"}"; create it only if the person confirms` },
    decide,
  };
  if (platform === "hubspot") return {
    platform, object: "deal",
    properties: { dealname: name, closedate: f.closeDate ? `${f.closeDate}T17:00:00Z` : null, amount: value, dealstage: { prospecting: "appointmentscheduled", qualified: "qualifiedtobuy", proposal: "presentationscheduled" }[stage], pipeline: "default", description },
    associations: { company: `Find the company "${f.buyer ?? "the buyer"}"` },
    decide: [...decide, "Deal stage ids above are HubSpot's default pipeline; yours may differ."],
  };
  if (platform === "dynamics365") return {
    platform, entity: "opportunity",
    fields: { name, estimatedclosedate: f.closeDate ?? null, estimatedvalue: value, description, stepname: nextStep },
    lookups: { parentaccountid: `Find the account "${f.buyer ?? "the buyer"}"` },
    decide,
  };
  return { platform: "generic", fields: { name, account: f.buyer ?? null, closeDate: f.closeDate ?? null, amount: value, stage, nextStep, description }, decide };
}

/** A record id and link worth storing: a plain id, and an https link on that platform's own domain. */
export function validCrmLink({ platform, recordId, url } = {}) {
  if (!CRM_PLATFORMS.includes(platform)) return `Unknown platform "${platform}".`;
  if (!/^[A-Za-z0-9._:-]{3,64}$/.test(String(recordId ?? ""))) return "The record id should be the platform's id (letters, digits, dashes), up to 64 characters.";
  if (url) {
    let u;
    try { u = new URL(url); } catch { return "The link is not a valid URL."; }
    if (u.protocol !== "https:") return "The link must start with https://.";
    if (!HOSTS[platform].test(u.hostname)) return `That link is not on ${CRM_NAMES[platform]}'s domain.`;
  }
  return null;
}

export default { CRM_PLATFORMS, CRM_NAMES, crmPayload, validCrmLink };
