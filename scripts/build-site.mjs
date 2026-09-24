#!/usr/bin/env node
/**
 * Build the published site into site/: the dashboard in read-only mode, each
 * tenant's findings as JSON, and the Excel workbook and .ics calendar to download.
 *
 *   node scripts/build-site.mjs
 *
 * The site is static and public (GitHub Pages). It holds public procurement
 * postings, role-based assignments and drafts built from the tenant profile.
 * It never holds customer data, people's names or links to internal tools; this
 * script checks the last one before writing anything.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, tenantIds, loadTenant } from "../lib/config.mjs";
import { loadLedger, STATUSES, COMPLIANCE_STATUSES, DEFAULT_GO_NO_GO } from "../lib/ledger.mjs";
import { workbookBuffer } from "../lib/excel.mjs";
import { buildCalendar } from "../lib/ics.mjs";
import { findBlocked } from "../lib/guard.mjs";

const OUT = path.join(ROOT, "site");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "data"), { recursive: true });
fs.mkdirSync(path.join(OUT, "downloads"), { recursive: true });

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";

const tenants = [];
for (const id of tenantIds()) {
  const t = loadTenant(id);
  const ledger = loadLedger(ROOT, id);
  const hits = findBlocked(ledger, `store/${id}.json`);
  if (hits.length) {
    console.error(hits.map((h) => `${h.path}: ${h.url} — ${h.why}`).join("\n"));
    throw new Error(`Refusing to publish ${id}: the ledger links to an internal tool.`);
  }
  fs.writeFileSync(path.join(OUT, "data", `${id}.json`), JSON.stringify(ledger));
  fs.writeFileSync(path.join(OUT, "downloads", `${id}-rfp-findings.xlsx`), await workbookBuffer(ledger, t));
  fs.writeFileSync(path.join(OUT, "downloads", `${id}-rfp-deadlines.ics`), buildCalendar(ledger, t));
  tenants.push({
    id: t.id, name: t.name, status: t.status, industries: t.industries,
    team: (t.team ?? []).map((m) => (typeof m === "string" ? { name: m } : { name: m.name })).filter((m) => m.name),
    defaultOwner: t.owners?.default ?? "",
    goNoGo: t.goNoGo ?? DEFAULT_GO_NO_GO,
    findings: ledger.findings.length,
    updatedAt: ledger.updatedAt,
  });
}

const meta = {
  mode: "static",
  builtAt: new Date().toISOString(),
  repo: process.env.GITHUB_REPOSITORY ?? null,
  tenants,
  statuses: STATUSES,
  complianceStatuses: COMPLIANCE_STATUSES,
};
fs.writeFileSync(path.join(OUT, "data", "meta.json"), JSON.stringify(meta, null, 2));

const html = fs.readFileSync(path.join(ROOT, "dashboard", "index.html"), "utf8")
  .replace("<head>", `<head>\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">\n  <meta name="rfp-mode" content="static">`)
  .replace(/href="\/style\.css"/, 'href="style.css"')
  .replace(/src="\/app\.js"/, 'src="app.js"');
fs.writeFileSync(path.join(OUT, "index.html"), html);
for (const f of ["app.js", "style.css"]) fs.copyFileSync(path.join(ROOT, "dashboard", f), path.join(OUT, f));
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

console.log(`site/ built: ${tenants.map((t) => `${t.id} (${t.findings})`).join(", ")}`);
