#!/usr/bin/env node
/**
 * Apply the access list (store/access.json, edited in the dashboard's Configuration tab)
 * to the private host: sets the Static Web App's RFP_ACCESS app setting, using your own
 * Azure CLI sign-in (az login). This script never sees or stores a password.
 *
 *   npm run access:apply -- --name <static-web-app> --resource-group <resource-group> [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { ROOT } from "../lib/config.mjs";
import { readStore } from "../lib/ledger.mjs";
import { validateAccess } from "../lib/access.mjs";

const opt = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const name = opt("name"), rg = opt("resource-group"), dry = process.argv.includes("--dry-run");
const { users, errors } = validateAccess(readStore(ROOT, "access.json", { users: [] }).users);
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
if (!users.length) { console.error("The access list is empty: add users in the dashboard's Configuration tab first (npm run dashboard)."); process.exit(1); }
if (!name || !rg) { console.error("Usage: npm run access:apply -- --name <static-web-app> --resource-group <resource-group> [--dry-run]"); process.exit(1); }
if (!/^[\w.-]{2,90}$/.test(name) || !/^[\w.()-]{1,90}$/.test(rg)) { console.error("That app or resource-group name does not look right."); process.exit(1); }

const value = JSON.stringify(users);
console.log(`${users.length} user(s): ${users.map((u) => `${u.email} (${u.role}${u.admin ? ", admin" : ""})`).join(", ")}`);
const args = ["staticwebapp", "appsettings", "set", "--name", name, "--resource-group", rg, "--setting-names", `RFP_ACCESS=${value}`];
if (dry) { console.log(`Dry run: would run az staticwebapp appsettings set --name ${name} --resource-group ${rg} --setting-names RFP_ACCESS=<the list above>`); process.exit(0); }
try {
  execFileSync("az", args, { stdio: ["ignore", "ignore", "inherit"] });
  console.log("Applied. Everyone not on the list sees the no-access page after signing in.");
} catch (e) {
  console.error(`Could not run the Azure CLI (${e.message}). Install it and run az login, or paste this into the RFP_ACCESS app setting in the Azure portal:\n${value}`);
  process.exit(1);
}
