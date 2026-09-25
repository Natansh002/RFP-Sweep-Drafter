/**
 * Browser bundle of the analysis modules, so the dashboard (local and the
 * published GitHub Pages site) runs the same five steps as the CLI, in the
 * browser, with no server and no upload.
 *
 * Each module gets its own scope (no name clashes); its imports are read from,
 * and its exports written to, one shared window.RFP namespace.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";

const ORDER = ["enrich.mjs", "library.mjs", "capabilities.mjs", "sector.mjs", "profile.mjs", "analyze.mjs", "respond.mjs", "proofread.mjs", "crm.mjs", "access.mjs", "references.mjs", "export.mjs", "analysis-excel.mjs", "smereview.mjs"];

export function browserBundle() {
  const parts = ORDER.map((f) => {
    let src = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
    const imports = [...src.matchAll(/^import\s*\{([^}]+)\}\s*from\s*["']\.\/[\w.-]+["'];?\s*$/gm)].flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean));
    src = src.replace(/^import .*$/gm, "").replace(/^export default .*$/gm, "");
    const exported = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    src = src.replace(/^export\s+/gm, "");
    return `// ---- lib/${f}\n(function () {\n  const { ${imports.join(", ")} } = window.RFP;\n${src}\n  Object.assign(window.RFP, { ${exported.join(", ")} });\n})();`;
  });
  return `// Generated from lib/ by lib/bundle.mjs. Do not edit.\n"use strict";\nwindow.RFP = window.RFP || {};\n${parts.join("\n\n")}\n`;
}

/** Third-party browser libraries, served from node_modules and copied into the site. */
export const VENDOR = {
  "pdf.min.mjs": "node_modules/pdfjs-dist/build/pdf.min.mjs",
  "pdf.worker.min.mjs": "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  "mammoth.browser.min.js": "node_modules/mammoth/mammoth.browser.min.js",
  "exceljs.min.js": "node_modules/exceljs/dist/exceljs.min.js",
  "pizzip.min.js": "node_modules/pizzip/dist/pizzip.min.js",
  "docxtemplater.min.js": "node_modules/docxtemplater/build/docxtemplater.min.js",
};
