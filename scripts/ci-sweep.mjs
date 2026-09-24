#!/usr/bin/env node
/**
 * The published-site pipeline, run by .github/workflows/pages.yml:
 *
 *   1. restore each tenant's ledger from the currently published site, so
 *      "first seen", change detection and action items carry over between runs
 *   2. apply the spreadsheet a person committed to assignments/<tenant>.xlsx
 *      (assignee, status, notes, actions, compliance); it is authoritative
 *   3. sweep every subscribed industry (skipped with --no-sweep)
 *   4. build site/
 *
 *   SITE_URL=https://<user>.github.io/<repo>/ node scripts/ci-sweep.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, tenantIds, loadTenant } from "../lib/config.mjs";
import { loadLedger, saveLedger, mergeRun } from "../lib/ledger.mjs";
import { importWorkbook } from "../lib/excel.mjs";
import { runSweep } from "../lib/sweep.mjs";

const args = process.argv.slice(2);
const SWEEP = !args.includes("--no-sweep");
const SITE = (process.env.SITE_URL ?? "").replace(/\/?$/, "/");
const width = Number(process.env.SWEEP_WIDTH ?? 2);

for (const id of tenantIds()) {
  const tenant = loadTenant(id);
  if (id === "all" && process.env.SKIP_GENERAL === "1") continue;
  console.log(`\n=== ${tenant.name}`);

  // 1. restore (skipped on a fresh start: FRESH=1)
  if (process.env.FRESH !== "1" && SITE.startsWith("https://") && !fs.existsSync(path.join(ROOT, "store", `${id}.json`))) {
    try {
      const res = await fetch(`${SITE}data/${id}.json`, { headers: { "cache-control": "no-cache" } });
      if (res.ok) {
        const prev = await res.json();
        if (prev?.tenant === id && Array.isArray(prev.findings)) {
          saveLedger(ROOT, prev);
          console.log(`restored ${prev.findings.length} finding(s) from the published site`);
        }
      } else console.log(`no published ledger yet (HTTP ${res.status}); starting fresh`);
    } catch (e) {
      console.log(`could not restore from the published site (${e.message}); starting fresh`);
    }
  }
  const ledger = loadLedger(ROOT, id);

  // 2. committed assignments
  const sheet = path.join(ROOT, "assignments", `${id}.xlsx`);
  if (fs.existsSync(sheet)) {
    const r = await importWorkbook(ledger, sheet, { by: "assignments sheet", authoritative: true });
    console.log(`assignments/${id}.xlsx: ${r.applied.length} change(s), ${r.added.length} new action(s), ${r.errors.length} error(s)`);
    for (const e of r.errors) console.log(`  error: ${e}`);
  }

  // 3. sweep
  if (SWEEP) {
    for (const ind of tenant.industries) {
      try {
        const run = await runSweep(id, ind, { width, source: "github-actions" });
        const { added, refreshed } = mergeRun(ledger, run);
        console.log(`${ind}: ${run.postingsSeen} link(s), ${added} new, ${refreshed} refreshed, ${run.gaps.length} gap(s)${run.halted ? `, HALTED: ${run.haltReason}` : ""}`);
      } catch (e) {
        console.log(`${ind}: sweep failed — ${e.message}`);
      }
    }
  }
  // Closed findings nobody touched leave the list; anything a person worked on stays.
  const today = new Date().toISOString().slice(0, 10);
  const before = ledger.findings.length;
  ledger.findings = ledger.findings.filter((f) => !(f.closeDate && f.closeDate < today && (f.rev ?? 0) === 0 && !f.workspace && f.status === "New"));
  if (before !== ledger.findings.length) console.log(`pruned ${before - ledger.findings.length} closed, untouched finding(s)`);
  saveLedger(ROOT, ledger);
}

// 4. build
execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-site.mjs")], { stdio: "inherit" });
