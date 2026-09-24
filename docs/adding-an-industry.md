# Adding an industry

An industry is one JSON file. No code changes, no workflow edits.

```bash
cp industries/_template.json industries/healthcare.json
# edit it
npm run check      # rebuilds the dropdowns and validates
git commit -am "Add healthcare pack" && git push
```

The CLI and dashboard pick it up immediately. For n8n, run `npm run build` and
re-import, because config is embedded in the workflows.

## Fill it in in this order

**1. Buyer, before anything else.** Who issues the RFP? Not who uses the product,
who signs the solicitation. For `logistics-lastmile-tms` these are different
people and getting it wrong is what produces a pack that sweeps the wrong sites
enthusiastically. Write the buyer types down before you pick a single channel.

**2. Channels.** Reference ids from `channels/registry.json`. If the portal you
need is not there, add it to the registry first with a `verified` date, then
reference it. Do not inline a URL in a pack.

Set `priority` honestly:

| Priority | Means |
|---|---|
| 1 | Highest yield. A run at any width includes it. |
| 2 | Normal. The default ceiling. |
| 3 | Wide. Paid aggregators, adjacent geographies, long tail. |

Three priority-1 channels is usually right. Ten means you have not decided.

**3. `directSites`, and take it seriously.** This is the list of buyers whose RFPs
never reach a portal. For nonprofits it is most of them. For K-12 it is everything
below the posting threshold. A pack with a full channel list and an empty
`directSites` will look like it is working and will be missing the majority of the
market. Seed the watch list in `data/` even if it starts at ten entries.

**4. Thresholds.** The value below which a buyer in this industry may award without
posting publicly. This is the honest explanation for what the sweep cannot see, and
it belongs in the pack so the digest can say so rather than implying the market is
quiet.

**5. Qualifiers.** `titleKeywords` carry far more weight than `bodyKeywords`,
because portals pad the body. Start narrow. It is much easier to widen a pack that
returns six good hits than to fix one that returns four hundred.

**6. Disqualifiers.** These are a hard gate applied before scoring. Write them from
the noise you actually expect: for K-12 that is construction, bussing and food
services, which outnumber the real hits by an order of magnitude. A term cannot be
both a qualifier and a disqualifier; the validator fails that.

**7. Scoring weights.** Must total exactly 100. The thresholds are `minScoreToPursue` and `autoNoBidBelow`. Change them only with a reason, and
put the reason in `weightsNote`. `logistics-lastmile-tms` weights `incumbent` higher
than the education and nonprofit packs because last-mile contracts are re-competed on a cycle and
the incumbent is usually named in the solicitation. That is a real difference. "It
felt right" is not.

**8. Keep it company-neutral.** A pack describes a market, not a company. Product
lines, owners, watch lists and company-specific keywords belong in each tenant's
`offerings.<industry>`. The validator fails a pack that has `productGuard`,
`routing`, `owner` or `installedBaseWatch`. This is what lets two Ionic companies
share one pack.

## Status, and being honest about it

| Status | Means |
|---|---|
| `draft` | Not swept by a scheduled run. |
| `unvalidated` | Channels are real and dated. Keywords have never met a live hit. |
| `proven` | Has run against live bids and the qualifier list has been cut at least once. |
| `retired` | No tenant may subscribe. |

**A new pack is `unvalidated`, not `proven`.** It becomes proven after two real
sweeps and at least one round of cutting qualifiers, not after it parses. The
digest carries a `caveat` field that names the status, so an unvalidated pack's
yield is never quietly compared against a proven one.

Record what you do not know in `openQuestions`. The validator surfaces them on
every run, which is the point: an open question that nobody sees is a decision
made by default.

## Calibrating a new pack

1. Run it on demand, report only, width 1.
2. Read every hit. Not the top ten, every one.
3. Anything wrong: is it a missing disqualifier, or a qualifier that is too loose?
   Fix that one, not both.
4. Repeat at width 2.
5. Only then set `status: "proven"` and let a schedule touch it.

Two passes is usually enough. If the third pass is still mostly noise, the buyer
definition in step 1 was wrong and no amount of keyword work will fix it.
