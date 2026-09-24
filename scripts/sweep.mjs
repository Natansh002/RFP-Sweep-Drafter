#!/usr/bin/env node
/**
 * Run a sweep from the command line, merge it into the tenant's ledger and
 * write the Excel workbook.
 *
 *   npm run sweep -- --tenant <company-id>                 every subscribed industry
 *   npm run sweep -- --tenant <company-id> --industry k12 --width 1
 *   npm run sweep -- --tenant <company-id> --direct        also sweep watch-list sites
 *   npm run sweep -- --tenant <company-id> --dry-run       print, write nothing
 *   npm run sweep -- --tenant <company-id> --no-detail     do not read each posting's own page
 *
 * Nothing leaves this machine except GET requests to public procurement pages.
 */
import { runSweep } from "../lib/sweep.mjs";
import { loadTenant, outputFile, ROOT, tenantIds } from "../lib/config.mjs";
import { loadLedger, saveLedger, mergeRun } from "../lib/ledger.mjs";
import { writeWorkbook } from "../lib/excel.mjs";
import { buildCalendar } from "../lib/ics.mjs";
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(`--${name}`);

const tenantId = opt("tenant", "all");
if (!tenantId) { console.error(`--tenant is required. One of: ${tenantIds().join(", ")}`); process.exit(2); }
const tenant = loadTenant(tenantId);
const industries = opt("industry") ? [opt("industry")] : tenant.industries;
const width = Number(opt("width", 2));
const detail = !flag("no-detail");
const dryRun = flag("dry-run");

const ledger = loadLedger(ROOT, tenantId);
for (const ind of industries) {
  const run = await runSweep(tenantId, ind, { width, detail, direct: flag("direct"), log: (m) => console.log(m) });
  console.log(`\n${ind}: ${run.postingsSeen} link(s) seen, ${run.findings.filter((f) => f.band === "pursue").length} pursue, ${run.findings.filter((f) => f.band === "review").length} review, ${run.gaps.length} coverage gap(s)`);
  if (run.skipped.length) console.log(`  skipped: ${run.skipped.join("; ")}`);
  if (run.caveat) console.log(`  CAVEAT: ${run.caveat}`);
  if (run.halted) console.log(`  HALTED: ${run.haltReason}`);
  for (const f of run.findings.slice(0, 15)) console.log(`  ${String(f.score).padStart(3)}  ${f.band.padEnd(6)}  ${f.title.slice(0, 90)}`);
  if (!dryRun) {
    const { added, refreshed } = mergeRun(ledger, run);
    console.log(`  ledger: ${added} new, ${refreshed} refreshed`);
  }
}
if (dryRun) { console.log("\nDry run: ledger and workbook not written."); process.exit(0); }
saveLedger(ROOT, ledger);
const file = await writeWorkbook(ledger, tenant, outputFile(tenantId));
const ics = file.replace(/-rfp-findings\.xlsx$/, "-rfp-deadlines.ics");
fs.writeFileSync(ics, buildCalendar(ledger, tenant));
const changed = ledger.findings.filter((f) => f.changed);
if (changed.length) console.log(`\n${changed.length} finding(s) changed since the last sweep (possible addenda):\n${changed.map((f) => `  ${f.id} ${f.title.slice(0, 70)} — ${f.changed.what.join("; ")}`).join("\n")}`);
console.log(`\nWorkbook: ${file}\nCalendar: ${ics}\nDashboard: npm run dashboard`);
