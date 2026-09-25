/** Everything the browser needs to run the same steps: vocabularies, packs, the owner matrix, the knowledge base. */
import fs from "node:fs";
import { ROOT, industryIds, loadPack, loadData, loadRegistry } from "./config.mjs";
import { STATUSES, COMPLIANCE_STATUSES, privateFile } from "./ledger.mjs";
import { referenceKnowledge } from "./references.mjs";
import { RESPONSE_STATUSES } from "./respond.mjs";
import { CAPABILITIES, GEOGRAPHIES, DATE_RANGES, DEFAULT_MATRIX } from "./capabilities.mjs";
import { SECTORS } from "./sector.mjs";

/**
 * `includePrivate` adds the local, learned knowledge base (library/private/). Only
 * the local dashboard and CLI pass it; the published site never does.
 */
const readJson = (p) => { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null; } catch { return null; } };

export function sharedMeta({ includePrivate = false } = {}) {
  const packs = industryIds().map((id) => loadPack(id));
  return {
    statuses: STATUSES,
    complianceStatuses: COMPLIANCE_STATUSES,
    responseStatuses: RESPONSE_STATUSES,
    industries: packs.map((p) => ({ id: p.id, name: p.name, status: p.status })),
    packs,
    capabilities: CAPABILITIES.map(({ id, label }) => ({ id, label })),
    sectors: SECTORS.map(({ id, label, pack }) => ({ id, label, pack })),
    geographies: GEOGRAPHIES,
    dateRanges: DATE_RANGES,
    matrix: loadData("config/capability-matrix.json") ?? DEFAULT_MATRIX,
    // Private (local only): learned answers, and the reference library's passages (cited, never approved).
    knowledge: [...(loadData("library/knowledge.json")?.entries ?? []), ...(includePrivate ? [...(readJson(privateFile(ROOT, "knowledge.local.json"))?.entries ?? []), ...referenceKnowledge(readJson(privateFile(ROOT, "references.local.json"))?.references)] : [])],
    // Public portal links, for "check these directly" when a portal cannot be read automatically.
    channels: (loadRegistry().channels ?? []).map(({ id, name, url, country, region, render, access }) => ({ id, name, url, country, region: region ?? null, render, access })),
  };
}
