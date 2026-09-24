#!/usr/bin/env node
/**
 * Read edits made in the Excel workbook (status, assignee, notes, action items)
 * back into the ledger, then rewrite the workbook.
 *
 *   npm run import -- --tenant <company-id> [--file output/<company-id>-rfp-findings.xlsx]
 */
import { loadTenant, outputFile, ROOT } from "../lib/config.mjs";
import { loadLedger, saveLedger } from "../lib/ledger.mjs";
import { importWorkbook, writeWorkbook } from "../lib/excel.mjs";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const tenantId = opt("tenant");
if (!tenantId) { console.error("--tenant is required"); process.exit(2); }
const tenant = loadTenant(tenantId);
const file = opt("file") ?? outputFile(tenantId);

const ledger = loadLedger(ROOT, tenantId);
const r = await importWorkbook(ledger, file);
for (const x of r.applied) console.log(`  applied   ${x}`);
for (const x of r.added) console.log(`  added     ${x}`);
for (const x of r.conflicts) console.log(`  CONFLICT  ${x}`);
for (const x of r.errors) console.log(`  error     ${x}`);
console.log(`\n${r.applied.length} change(s), ${r.added.length} new action(s), ${r.conflicts.length} conflict(s), ${r.errors.length} error(s)`);
if (r.applied.length || r.added.length) {
  saveLedger(ROOT, ledger);
  await writeWorkbook(ledger, tenant, outputFile(tenantId));
  console.log(`Ledger saved and workbook regenerated: ${outputFile(tenantId)}`);
}
if (r.conflicts.length) console.log("Conflicted rows were changed in the dashboard after the sheet was exported. Re-export, re-apply those edits, import again.");
