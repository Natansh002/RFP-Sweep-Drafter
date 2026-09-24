#!/usr/bin/env node
/** Regenerate the Excel workbook from the ledger.  npm run export -- --tenant <company-id> [--file out.xlsx] */
import { loadTenant, outputFile, ROOT } from "../lib/config.mjs";
import { loadLedger } from "../lib/ledger.mjs";
import { writeWorkbook } from "../lib/excel.mjs";
import { buildCalendar } from "../lib/ics.mjs";
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const tenantId = opt("tenant");
if (!tenantId) { console.error("--tenant is required"); process.exit(2); }
const file = await writeWorkbook(loadLedger(ROOT, tenantId), loadTenant(tenantId), opt("file") ?? outputFile(tenantId));
const ics = file.replace(/\.xlsx$/, "").replace(/-rfp-findings$/, "") + "-rfp-deadlines.ics";
fs.writeFileSync(ics, buildCalendar(loadLedger(ROOT, tenantId), loadTenant(tenantId)));
console.log(`wrote ${file}\nwrote ${ics}`);
