# How scoring works

One implementation, `lib/score.mjs`, used by the CLI and the dashboard and inlined into the n8n Score node by
`npm run build`. A bid scored at the desk and a bid scored by the scheduled run get
the same number, because there is only one scorer.

The pack decides how much each dimension counts. This file decides how each one is
measured. Those are different jobs and they are kept apart on purpose: tuning an
industry should never mean editing code.

## The gate comes first

`disqualify()` runs before any scoring. A bus-routing tender cannot accumulate
points for having a close date and a named buyer, because it never reaches the
scorer.

One nuance worth knowing: a disqualifier that hits only in the **body**, while a
qualifier hits in the **title**, is flagged rather than dropped. A genuine ERP RFP
often mentions janitorial contracts in a list of existing systems. Killing it on
that would be wrong, and so would ignoring it, so it is kept with a flag.

## Relevance is a gate too

A posting that matches **no** qualifier (no title keyword and no body keyword) is
dropped before scoring. This was found on the first live run: portal navigation links
such as "Terms of Service" and "Create an account" scored 38 on unknown credit alone,
and they flooded the review list.

Keywords match **whole words**. Substring matching let "SIS" match "Mississippi".

## Reading the posting page

For candidates that survive the first pass, the sweep reads the posting's own page
(`lib/enrich.mjs`). It pulls out the closing date, question deadline, pre-bid meeting,
site visit, incumbent phrasing, mandatory statements and competitor names, then
scores again. The scorer does not change; what changes is that fields the listing
left "unknown" now come from the posting itself.

## The six dimensions

Each returns 0 to 1. The pack's weight turns it into points. Weights must total 100.

| Dimension | 1.0 | 0.5 | 0.0 |
|---|---|---|---|
| `productFit` | Several title keywords matched | — | Nothing matched |
| `buyerFit` | Buyer matches a listed type | Buyer not published | Buyer is something else |
| `dealSize` | Four times the posting floor or more | Value not published | Below the floor |
| `timeline` | Over three weeks to close | Close date not published | Already closed |
| `incumbent` | Incumbent named | No signal | — |
| `geography` | In the tenant's geography | Country not published | Out of scope |

A title match is worth roughly five times a body match. Portals pad the body with
boilerplate; the title is what the buyer actually called it.

## Unknown is not zero

This is the rule that matters most and it is the one most scorers get wrong.

A posting with no published close date scores **0.5** on timeline, not 0, and the
reason string says "unknown". Punishing a posting for a field the portal did not
publish means the sweep systematically prefers portals with rich metadata over
portals with real opportunities.

The consequence: a score can be built mostly on absences. So when three or more
dimensions come back unknown, a `pursue` is downgraded to `review` and the flag says
why. A high score assembled from unknowns is not a confident score whatever the
number says, and it must not be marked pursue on its own say-so.

## Two dimensions veto

`timeline` and `geography` are gates wearing weights. A zero on either forces the
band to `no bid` regardless of the total.

This was found by test, not by design. A K-12 ERP bid that closed five days ago
scored **81** and would have been marked pursue, because the other five dimensions carried
it. Weighting cannot express "this one is a gate": ten points of timeline against
ninety points of everything else will always lose that argument.

The score is reported intact alongside the veto, so a reviewer can tell a good fit
that arrived too late from a bad fit:

```
VETOED: the solicitation has already closed (closed 5 days ago)
productFit 28/35 — title: ERP, HRIS; body: 0 match(es)
buyerFit   20/20 — buyer type: school district
...
```

`scripts/test-score.mjs` holds the cases that produced this rule. Keep them.

## Bands

| Band | When | What happens |
|---|---|---|
| `dropped` | Hit a disqualifier | Never reaches the digest |
| `no bid` | Below `autoNoBidBelow`, **or vetoed** | Counted, not listed |
| `review` | Between the two thresholds | Listed with a triage action; a draft on request |
| `pursue` | At or above `minScoreToPursue` | Gets a full response draft and action plan in the dashboard |

`autoNoBidBelow` must be below `minScoreToPursue`. The validator enforces it.

## Every score carries its reasons

```
productFit 28/35 — title: enterprise resource planning, payroll system; body: 4 match(es)
buyerFit   20/20 — buyer type: school board
dealSize    7/15 — value not published, unknown
timeline   10/10 — 34 days left
incumbent   5/10 — no incumbent signal
geography  10/10 — CA is in scope
```

Total 80, band `pursue`. A reviewer can see in four seconds that the only soft spot
is an unpublished value, and can decide whether to chase it.

This is not decoration. A score with no reason attached is a number nobody can
argue with, which means nobody trusts it, which means the sweep gets ignored.

## What the scorer does not do

- It does not decide bid or no-bid. `pursue` means "a person should own this", not
  "we are bidding". The go/no-go scorecard in the dashboard is where people decide.
- It does not read the solicitation document. It scores the posting. The document is
  read by a person. The sweep reads the posting page, not the PDF solicitation.
- It does not learn. Weights change when someone changes them, with a reason in
  `weightsNote`. There is no feedback loop and pretending otherwise would be worse
  than not having one.

## Changing it

Edit `lib/score.mjs`, run `npm run build`, commit both the script and the
regenerated `n8n/`. CI fails a `n8n/` that does not match a fresh build, which is
what stops the workflow's copy of the scorer from quietly forking.
