#!/usr/bin/env node
/**
 * RFP Sweep and Drafter as an MCP server, so Claude (or another MCP client) can work with the
 * pipeline next to your sales platform's own MCP connector.
 *
 *   npm run mcp        (stdio; registered for Claude Code in .mcp.json)
 *
 * It reads the local ledger and company profile, prepares the fields for a
 * Salesforce / HubSpot / Dynamics 365 opportunity, and records the link once a
 * person has confirmed and created the record with their own connector. It never
 * calls a sales platform itself, never sends anything anywhere, and the links it
 * records stay in store/crm.json on this machine (gitignored, never published).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ROOT, GENERAL_ID } from "../lib/config.mjs";
import { loadLedger, readStore, writeStore } from "../lib/ledger.mjs";
import { companyFit } from "../lib/profile.mjs";
import { crmPayload, CRM_PLATFORMS, validCrmLink } from "../lib/crm.mjs";

const OPEN = new Set(["New", "Qualifying", "Pursuing", "Drafting"]);
const today = () => new Date().toISOString().slice(0, 10);
const daysLeft = (d) => (d ? Math.round((new Date(`${d}T00:00:00Z`) - new Date(`${today()}T00:00:00Z`)) / 86400000) : null);
const lifecycle = (f) => { const passed = f.closeDate && f.closeDate < today(); return OPEN.has(f.status ?? "New") ? (passed ? "pastdue" : "active") : "closed"; };
const ledger = () => loadLedger(ROOT, GENERAL_ID);
const profile = () => { const p = readStore(ROOT, "profile.json", null); return p?.name ? p : null; };
const crm = () => readStore(ROOT, "crm.json", { links: {} });
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fitOf = (f, p) => (p ? { ...companyFit({ ...f, sourceText: String(f.sourceText ?? "").slice(0, 6000) }, p), basis: `fit to what ${p.name} sells` } : { score: f.score, band: f.band, reasons: f.reasons ?? [], basis: "sweep score (no company profile yet)" });
const find = (id) => { const f = ledger().findings.find((x) => x.id === id); if (!f) throw new Error(`No opportunity ${id}. Use list_opportunities to find ids.`); return f; };

const server = new McpServer({ name: "rfp-sweeper", title: "RFP Sweep and Drafter", version: "1.0.0" }, {
  instructions: "RFP opportunities found by the sweep, scored on the company's offering. To put one into a sales platform: call prepare_crm_opportunity, show the fields to the person, create the record with their sales-platform connector only after they confirm, then call link_crm_opportunity with the new record id. Never create, update or delete sales-platform records without the person's explicit confirmation.",
});

server.registerTool("list_opportunities", {
  title: "List RFP opportunities",
  description: "Open RFP opportunities from the latest sweep, best fit first. Fit is on the company's product offering when a company profile exists.",
  inputSchema: {
    status: z.enum(["active", "pastdue", "closed", "all"]).default("active").describe("active = still open; pastdue = closing date passed while still open on our side"),
    minFit: z.number().min(0).max(100).default(0).describe("Only opportunities scoring at least this"),
    closingWithinDays: z.number().int().positive().optional().describe("Only those closing within this many days"),
    limit: z.number().int().min(1).max(100).default(25),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ status, minFit, closingWithinDays, limit }) => {
  const p = profile(), links = crm().links ?? {};
  const rows = ledger().findings
    .filter((f) => status === "all" || lifecycle(f) === status)
    .filter((f) => closingWithinDays == null || (daysLeft(f.closeDate) != null && daysLeft(f.closeDate) >= 0 && daysLeft(f.closeDate) <= closingWithinDays))
    .map((f) => ({ f, fit: fitOf(f, p) }))
    .filter((x) => (x.fit.score ?? 0) >= minFit)
    .sort((a, b) => (b.fit.score ?? 0) - (a.fit.score ?? 0))
    .slice(0, limit)
    .map(({ f, fit }) => ({ id: f.id, title: f.title, buyer: f.buyer, closeDate: f.closeDate, daysLeft: daysLeft(f.closeDate), fit: fit.score, fitBand: fit.band, status: f.status, assignee: f.assignee || null, url: f.url, crm: links[f.id] ?? null }));
  return text({ fitBasis: p ? `fit to what ${p.name} sells (from its website)` : "sweep score; add a company profile for fit on your offering", count: rows.length, opportunities: rows });
});

server.registerTool("get_opportunity", {
  title: "Get one RFP opportunity",
  description: "Everything known about one opportunity: key facts read from the RFP documents (questions deadline, value, term, evaluation criteria), fit and why, risks, the four roles, proofreading and submission status, and any linked sales-platform record.",
  inputSchema: { id: z.string().min(3).max(80) },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ id }) => {
  const f = find(id), p = profile(), ws = f.workspace ?? {}, r = f.rfp ?? {};
  return text({
    id: f.id, title: f.title, buyer: f.buyer, buyerIndustry: f.sector?.label ?? null, url: f.url, publishedDate: f.publishedDate, closeDate: f.closeDate, daysLeft: daysLeft(f.closeDate), status: f.status, assignee: f.assignee || null,
    fit: fitOf(f, p),
    keyFacts: { ...(r.keyData ?? {}), questionsDeadline: r.keyData?.dates?.questions ?? f.keyDates?.questions ?? null, estimatedValue: f.estimatedValue ?? r.keyData?.value?.amount ?? null },
    documentsRead: (r.sources ?? []).filter((s) => s.kind === "document").map((s) => ({ name: s.name, pages: s.pages, error: s.error ?? null })),
    notes: r.notes ?? [],
    risks: (r.risks ?? ws.analysis?.risks ?? []).map((x) => `${x.severity}: ${x.label}`),
    requirementCounts: r.requirementCounts ?? null,
    team: f.team ?? null,
    proofread: ws.proofread ? { verdict: ws.proofread.verdict, counts: ws.proofread.counts, signedOff: ws.proofread.signedOff ?? null } : null,
    submissionStatus: f.status === "Submitted" ? "Submitted" : ws.redTeam ? (ws.redTeam.readiness === "Ready" ? "Ready to submit" : `Not ready: ${ws.redTeam.blocking.join("; ")}`) : "not checked",
    crm: crm().links?.[f.id] ?? null,
  });
});

server.registerTool("get_company_profile", {
  title: "Get the company profile",
  description: "What the company sells, read from its website: capabilities, its own terms and product names, platforms. Fit is scored against this.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const p = profile();
  if (!p) return text("No company profile yet. In the dashboard, enter the company website under Your company.");
  return text({ name: p.name, website: p.website, summary: p.summary, capabilities: (p.capabilities ?? []).filter((c) => c.on !== false).map((c) => c.label), terms: p.keywords, platforms: (p.platforms ?? []).filter((x) => x.on !== false).map((x) => x.name), products: p.products });
});

server.registerTool("prepare_crm_opportunity", {
  title: "Prepare a sales-platform opportunity",
  description: "The fields to create an opportunity for this RFP in Salesforce, HubSpot or Dynamics 365. Show them to the person; create the record with their connector only after they confirm, then call link_crm_opportunity.",
  inputSchema: { id: z.string().min(3).max(80), platform: z.enum(CRM_PLATFORMS).default("salesforce") },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ id, platform }) => {
  const f = find(id);
  const existing = crm().links?.[f.id];
  return text({ ...crmPayload(f, platform, { profile: profile() }), alreadyLinked: existing ?? null });
});

server.registerTool("link_crm_opportunity", {
  title: "Record the linked sales-platform record",
  description: "After the person confirmed and the record was created with their connector, record its id (and link) against the RFP. Stored locally only.",
  inputSchema: { id: z.string().min(3).max(80), platform: z.enum(CRM_PLATFORMS), recordId: z.string().min(3).max(64), url: z.string().url().optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ id, platform, recordId, url }) => {
  const f = find(id);
  const err = validCrmLink({ platform, recordId, url });
  if (err) throw new Error(err);
  const store = crm();
  store.links = { ...(store.links ?? {}), [f.id]: { platform, recordId, url: url ?? null, linkedAt: new Date().toISOString() } };
  writeStore(ROOT, "crm.json", store);
  return text(`Linked ${f.id} ("${f.title}") to ${platform} record ${recordId}. Stored on this machine only.`);
});

server.registerTool("unlink_crm_opportunity", {
  title: "Remove a recorded sales-platform link",
  description: "Forget the recorded link for this RFP (the sales-platform record itself is not touched).",
  inputSchema: { id: z.string().min(3).max(80) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ id }) => {
  const store = crm();
  const had = !!store.links?.[id];
  if (had) { delete store.links[id]; writeStore(ROOT, "crm.json", store); }
  return text(had ? `Removed the link for ${id}.` : `No link recorded for ${id}.`);
});

await server.connect(new StdioServerTransport());
console.error("RFP Sweep and Drafter MCP server ready (stdio). Reads the local ledger; never calls a sales platform.");
