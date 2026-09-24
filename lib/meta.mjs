/** Everything the browser needs to run the same steps: vocabularies, packs, the owner matrix, the knowledge base. */
import { industryIds, loadPack, loadData, loadRegistry } from "./config.mjs";
import { STATUSES, COMPLIANCE_STATUSES } from "./ledger.mjs";
import { RESPONSE_STATUSES } from "./respond.mjs";
import { CAPABILITIES, GEOGRAPHIES, DATE_RANGES, DEFAULT_MATRIX } from "./capabilities.mjs";
import { SECTORS } from "./sector.mjs";

export function sharedMeta() {
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
    knowledge: loadData("library/knowledge.json")?.entries ?? [],
    // Public portal links, for "check these directly" when a portal cannot be read automatically.
    channels: (loadRegistry().channels ?? []).map(({ id, name, url, country, region, render, access }) => ({ id, name, url, country, region: region ?? null, render, access })),
  };
}
