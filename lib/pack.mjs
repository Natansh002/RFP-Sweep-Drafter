/**
 * Industry pack + tenant = what a run actually sweeps for.
 *
 * Packs are company-neutral: they describe a market. Tenants describe a company:
 * which products it sells into that market, extra keywords its products care
 * about, channels it never wants, who owns the finds. This file joins the two,
 * so two Ionic operating companies can share one industry pack without forking it.
 *
 * Import-free on purpose: build-workflows.mjs inlines it into the n8n Code nodes.
 */

const uniq = (xs) => [...new Set((xs ?? []).filter(Boolean))];

/** The tenant's offering for one industry, with defaults filled in. */
export function offeringFor(tenant, industryId) {
  const o = tenant?.offerings?.[industryId] ?? {};
  return {
    productLines: o.productLines ?? [],
    defaultAssignee: o.defaultAssignee ?? tenant?.owners?.default ?? "",
    extraTitleKeywords: o.extraTitleKeywords ?? [],
    extraBodyKeywords: o.extraBodyKeywords ?? [],
    extraDisqualifiers: o.extraDisqualifiers ?? [],
    excludeChannels: uniq([...(tenant?.excludeChannels ?? []), ...(o.excludeChannels ?? [])]),
    pitch: o.pitch ?? "",
  };
}

/** The pack with the tenant's per-industry keyword and disqualifier additions merged in. */
export function effectivePack(pack, tenant) {
  const o = offeringFor(tenant, pack.id);
  return {
    ...pack,
    qualifiers: {
      ...(pack.qualifiers ?? {}),
      titleKeywords: uniq([...(pack.qualifiers?.titleKeywords ?? []), ...o.extraTitleKeywords]),
      bodyKeywords: uniq([...(pack.qualifiers?.bodyKeywords ?? []), ...o.extraBodyKeywords]),
    },
    disqualifiers: uniq([...(pack.disqualifiers ?? []), ...o.extraDisqualifiers]),
    offering: o,
  };
}

/**
 * Join the pack's channel list to the registry and filter by width, tenant
 * geography and the tenant's exclusions. Returns what will run and, just as
 * important, what will not and why.
 */
export function resolveChannels(pack, registry, tenant, maxPriority = 2) {
  const byId = Object.fromEntries((registry.channels ?? []).map((c) => [c.id, c]));
  const geo = tenant?.geography ?? pack.geography ?? [];
  const exclude = new Set(offeringFor(tenant, pack.id).excludeChannels);
  const run = [];
  const skipped = [];
  for (const ref of pack.channels ?? []) {
    const c = byId[ref.ref];
    if (!c) { skipped.push(`${ref.ref}: not in registry`); continue; }
    if (exclude.has(ref.ref)) { skipped.push(`${ref.ref}: excluded by tenant`); continue; }
    if (ref.priority > maxPriority) { skipped.push(`${ref.ref}: priority ${ref.priority} is wider than ${maxPriority}`); continue; }
    if (c.country && !geo.includes(c.country)) { skipped.push(`${ref.ref}: ${c.country} is outside tenant geography`); continue; }
    run.push({ ...c, priority: ref.priority, note: ref.note ?? null });
  }
  return { run, skipped };
}

export default { offeringFor, effectivePack, resolveChannels };
