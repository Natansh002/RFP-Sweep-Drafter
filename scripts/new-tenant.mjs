#!/usr/bin/env node
/**
 * Scaffold a tenant for another Ionic operating company.
 *
 *   npm run new-tenant -- acme-health "Acme Health" --industries nonprofit --geo US,CA
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, industryIds } from "../lib/config.mjs";

const [id, name, ...rest] = process.argv.slice(2);
const opt = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
if (!id || !name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
  console.error('usage: npm run new-tenant -- <kebab-id> "<Company name>" --industries k12,nonprofit [--geo CA,US]');
  process.exit(2);
}
const file = path.join(ROOT, "tenants", `${id}.json`);
if (fs.existsSync(file)) { console.error(`${file} already exists`); process.exit(1); }

const industries = (opt("industries") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const unknown = industries.filter((i) => !industryIds().includes(i));
if (!industries.length || unknown.length) {
  console.error(`--industries must list one or more of: ${industryIds().join(", ")}${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}`);
  process.exit(2);
}

const t = JSON.parse(fs.readFileSync(path.join(ROOT, "tenants", "_template.json"), "utf8"));
delete t.$comment;
const offering = t.offerings["<industry-id>"];
Object.assign(t, {
  id,
  name,
  lastReviewed: new Date().toISOString().slice(0, 10),
  industries,
  geography: (opt("geo") ?? "CA,US").split(",").map((s) => s.trim().toUpperCase()),
  offerings: Object.fromEntries(industries.map((i) => [i, { ...offering }])),
});
t.profile.companyName = name;
fs.writeFileSync(file, JSON.stringify(t, null, 2) + "\n");
console.log(`wrote tenants/${id}.json

Fill in before the first sweep:
  offerings.<industry>.productLines   required, the validator fails without them
  team                                role titles (not names) for the Assignee dropdown
  profile                             what the drafter may say about ${name}; empty fields become [TODO]

Then:  npm run check  &&  npm run sweep -- --tenant ${id} --width 1`);
