#!/usr/bin/env node
/**
 * The package for operations (SaaS Ops): everything needed to set up the internal host,
 * as one zip, built from the committed repository (git HEAD), so it always matches it.
 *
 *   npm run package:saas-ops      → dist/RFP-Sweep-and-Drafter-internal-hosting-<version>.zip
 *
 *   README-FIRST.md, app-settings.txt, SO-ticket.txt, screenshots/   from saas-ops/, at the top
 *   source/                                                          the repository at HEAD, plus COMMIT
 *
 * Uncommitted changes are left out: commit first. Nothing private can be in it, because
 * store/, library/private/ and output/ are never committed. The internal-host workflow
 * builds it on every push, as the run's "saas-ops-package" artifact.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import PizZip from "pizzip";
import { ROOT } from "../lib/config.mjs";

const git = (...args) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
const version = JSON.parse(git("show", "HEAD:package.json").toString("utf8")).version;
const commit = git("rev-parse", "HEAD").toString().trim();
if (git("status", "--porcelain", "--untracked-files=no").toString().trim()) console.warn("Note: uncommitted changes are not in the package; it is built from the last commit.");

const name = `RFP-Sweep-and-Drafter-internal-hosting-${version}`;
const zip = new PizZip(git("archive", "--format=zip", `--prefix=${name}/source/`, "HEAD"));
zip.file(`${name}/source/COMMIT`, `${commit}\n`);
const handoff = git("ls-tree", "-r", "--name-only", "HEAD", "saas-ops/").toString().split("\n").filter(Boolean);
if (!handoff.includes("saas-ops/README-FIRST.md")) throw new Error("saas-ops/README-FIRST.md is not committed.");
for (const f of handoff) zip.file(`${name}/${f.slice("saas-ops/".length)}`, git("show", `HEAD:${f}`));

const out = path.join(ROOT, "dist", `${name}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zip.generate({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX" }));
console.log(`${path.relative(ROOT, out)}: ${Math.round(fs.statSync(out).size / 1024)} KB, ${Object.keys(zip.files).filter((k) => !zip.files[k].dir).length} files, commit ${commit.slice(0, 7)}`);
