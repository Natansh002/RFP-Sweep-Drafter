# RFP Sweep & Drafter

An RFP operating system for professional services: **Find → Understand → Qualify →
Assign → Answer → Review → Respond**. Nobody configures a company first. You
say what you are looking for:

> **Industry → Geography → Capability → Date range** → **Run RFP Sweep**

and get a scored pipeline ("24 opportunities found: 8 High fit, 10 Review"). Open
any opportunity and work it through **Qualify → Assign → Analyze RFP → Draft
response → Red-team**, then **export the scoring file** (Excel) and the
proposal draft.

Live: **https://natansh002.github.io/RFP-Sweep-Drafter/** (read-only, refreshed by
GitHub Actions). Full editing: `npm run dashboard` on your machine.

| Step | What it does | Agent in the spec |
|---|---|---|
| Discover | Sweeps CanadaBuys open data, SAM.gov and public portals; de-duplicates; filters by industry, geography, capability, date | Scout |
| Understand | Reads the notice or the uploaded RFP (PDF / DOCX / TXT / HTML, in the browser). Extracts dates, term, value, evaluation weights, submission rules and requirements | Lens, Decomposer |
| Qualify | Fit / risk / timeline / coverage scores with reasons. *Why it matters, why we may not qualify, key risks, information still required, next action.* **Verified** facts (with source) kept apart from **inferred** ones | FitCheck |
| Assign | Recommends opportunity owner, solution lead, technical lead, commercial owner, SMEs and sponsor from `config/capability-matrix.json` (roles only). Override any of them | Route |
| Answer | Drafts each requirement from the approved knowledge base (`library/knowledge.json`), citing the source with a confidence level. **No approved source means "SME validation required", never invented text** | AnswerSmith, ProofPoint |
| Build | First-draft proposal in the customer's own section names: executive summary (problem → approach → outcomes → why us), responses, compliance matrix, assumptions, risks. Pricing is never drafted | ProposalBuilder |
| Review | Red-team check: unanswered or unapproved mandatory items, SME markers, stale sources, page limits, generic phrasing, repetition. **Ready / Needs review** with blocking issues | RedTeam |
| Learn | Won / lost / no-bid, loss reason and awardee on each finding, a Pipeline sheet with win rate, audit history and workspace versions | Learn |

**How it analyzes:** pattern matching and TF-IDF text similarity, not a language
model, and every output says so. It is deterministic, explains each score, and
never fabricates a reference, certification, capability or metric.

## Quick start

```bash
npm install
npm run dashboard                               # http://127.0.0.1:4173 → RFP Sweep tab
npm run analyze -- --rfp path/to/rfp.pdf        # scoring .xlsx + summary .md in output/
npm run check                                   # build + validate + tests
npm run new-tenant -- acme "Acme" --industries k12   # add your company first
npm run sweep -- --tenant acme --width 1        # writes store/ and output/
npm run dashboard                               # http://127.0.0.1:4173
```

Add another operating company:

```bash
npm run new-tenant -- acme-health "Acme Health" --industries nonprofit --geo US,CA
# fill offerings.<industry>.productLines, team, profile, then:
npm run check && npm run sweep -- --tenant acme-health --width 1
```

## What you get

**Excel workbook**, `output/<tenant>-rfp-findings.xlsx`

| Sheet | What it holds | You edit (yellow ✎) |
|---|---|---|
| Findings | Score, band, reasons, close date, Q&A deadline, go/no-go, competitors, change flag | Status, **Assignee** (dropdown of roles from Team), Notes, Est. value, Loss reason, Awardee |
| Actions | Every action item with due date | Action, **Assignee**, Due, Done. Add rows to add actions |
| Compliance | Mandatory "shall/must" statements from each posting page | Owner, Status, Response section |
| Drafts | Bid/no-bid brief and first-draft response | Edit drafts in the dashboard |
| Pipeline | Count and value by status and industry, win rate | — |
| Coverage gaps / Runs | What could not be read, and the run history | — |
| Team | The assignee list (role titles, not names) | Add roles |

Import edits back with `npm run import -- --tenant <id>` or the dashboard's
**Import Excel** button. If a row was changed in the dashboard after you exported
the sheet, the import skips that row and reports a conflict, so it never overwrites the newer edit.

**Dashboard**, `npm run dashboard`

- KPIs: open findings, pursue vs review, unassigned, actions due or overdue, changed since the last sweep, open pipeline value, win rate
- Findings table with inline Status and **Assignee**, plus filters (industry, band, status, assignee, changed)
- Detail panel for each finding:
  - brief and notes
  - key dates
  - go/no-go scorecard
  - outcome and value
  - action items (add them, assign them, set due dates, tick them off)
  - editable response draft, with library citations
  - compliance matrix with an owner and status per requirement
- **Action items** tab: every open item across findings, filterable by *Mine* or *Unassigned*. This replaces Jira tasks.
- Buttons: Run sweep, Download Excel, Deadlines (.ics), Import Excel, Import n8n run

## What makes a finding good

| Feature | What it does |
|---|---|
| **Posting-page enrichment** | Reads each candidate's own page for the closing date, question deadline, pre-bid meeting, site visit, incumbent, requirements and competitors, then re-scores. Unknowns become facts. |
| **Addenda / change detection** | Hashes each posting page. A changed page, close date or key date raises a *changed* flag and adds a "review the addendum" action until someone acknowledges it. |
| **Go/no-go scorecard** | Weighted criteria per company. People answer yes, partial or no. The score informs the decision, and a person makes it. |
| **Answer library** | `library/<tenant>.json` holds approved answers with review dates. The drafter cites matches by id and marks overdue ones **STALE**. |
| **Compliance matrix** | Mandatory statements, typed as insurance, format, experience, form, pricing or technical, each with an owner and status. |
| **Win/loss and pipeline** | Value, loss reason and awardee for each finding. Pipeline sheet and win-rate KPI. |
| **Deadline calendar** | `.ics` file of closing dates, Q&A deadlines, meetings and action due dates, for people to import themselves. No invites are sent. |

`docs/feature-review.md` compares this tool with Loopio, Responsive, GovWin, GovSpend,
BidPrime, HigherGov and others. It covers what was adopted, what was left out on purpose, and what comes next.

## The rules it holds to

- **No internal tools.** `lib/guard.mjs` blocks Atlassian, Salesforce/Certinia, HubSpot, Microsoft 365 / Dynamics, Google Workspace, Slack, Notion, helpdesks, sales tooling and every private or intranet address. It applies to every fetch and every redirect hop, and removes any stored finding link that points at one. `npm run validate` fails if any config, data, library or generated workflow links to one, or if a tenant has a `ticketSystem`, `jira` or `confluence` block. A tenant can block more hosts with `guard.extraBlockedHosts`.
- **A sweep never overwrites a person's work.** Assignee, status, notes, go/no-go answers, compliance owners, action items, an edited draft and a value a person entered all survive every re-sweep.
- **A tripwire, not a flood.** If a run scores more `pursue` findings than `safety.maxNewPursuePerRun`, it adds nothing and reports why.
- **Relevance is a gate.** A posting that matches no product keyword is dropped, however much "unknown" credit it would collect. Keywords match whole words, so "SIS" does not match "Mississippi".
- **Closed and out-of-geography bids are vetoed**, whatever they scored.
- **Unknown is not zero**, and a score built on three or more unknowns is capped at `review`.
- **What could not be read is reported**, never dropped. `needs-browser`, `fetch-failed` and `blocked` channels appear under Coverage gaps.
- **Drafts invent nothing.** They use only the tenant's `profile`, its `offerings`, the library and the public posting. Everything else stays `[TODO]`. Pricing is never drafted.
- **Findings stay local.** `store/` and `output/` are gitignored. The dashboard binds to 127.0.0.1, rejects foreign Host headers, requires a custom header on every write, and serves a strict CSP.

## Layout

```
channels/registry.json    every public portal, once, with a verified date
industries/*.json         company-neutral market packs
tenants/*.json            one per operating company: offerings, team, profile, go/no-go
library/*.json            approved answers per company (template: library/_template.json)
data/*.json               direct-sweep watch lists
lib/                      guard, pack, extract, enrich, score, draft, library, ledger, excel, ics, sweep
scripts/                  sweep, dashboard, import, export, new-tenant, validate, build,
                          build-site, ci-sweep (Pages), deploy-n8n, tests
assignments/              committed spreadsheets that drive the published site
dashboard/                the local UI (no external scripts)
n8n/                      generated workflows (optional scheduler)
.claude/agents/           rfp-sweeper agent for Claude Code (no connector tools)
store/  output/           ledger and workbooks (gitignored)
```

## Published site (GitHub Pages)

`.github/workflows/pages.yml` publishes a read-only dashboard, the Excel workbook and
the deadline calendar to **https://natansh002.github.io/RFP-Sweep-Drafter/**, the same
way ps-intelligence is published:

- It runs on weekdays at 09:00 Toronto time, on every push to `main`, and on demand (Actions → pages → Run workflow, with a width choice and a "re-publish without sweeping" option).
- `npm run check` must pass first. If it fails, nothing publishes.
- Each run starts from the previously published findings, so "first seen", change detection and action items carry over.
- **To assign or update findings:** download the Excel from the site, edit the yellow ✎ columns, and upload it as `assignments/<company-id>.xlsx`. The next build applies it, and the committed sheet is authoritative for those columns. See `assignments/README.md`.

The site and the repo are **public**. They hold public procurement postings, role-based
assignments and drafts built from the tenant profile. No customer data, no people's
names, no links to internal tools: the build refuses to publish a ledger that links to one.
For editing in a browser, use the local dashboard (`npm run dashboard`).

## n8n (optional)

If you want scheduled runs, `npm run build` generates the n8n workflows with config
embedded, so n8n fetches no config and links to nothing internal. Each run outputs
a findings `.xlsx` and a run `.json`. Import the `.json` with the dashboard's
**Import n8n run** button. See `n8n/README.md`.

## Honest limits

- **Client-rendered portals** (BC Bid, APC, SaskTenders, SEAO, Ontario Tenders, MERX, bids&tenders, Biddingo) return an empty shell to a plain fetch and are reported as `needs-browser`. On the first live run, most K-12 and nonprofit portals fell into this category or refused the fetch, and that run found no real postings. A browser step is still the biggest yield improvement available. The direct watch-list sweep (`--direct`) and posting-page enrichment are the next best.
- **Extraction is deliberately generic.** It harvests links and lets the scorer decide. Postings found only as links score mostly on unknowns until their page is read.
- **The two logistics packs are unvalidated.** Their first two sweeps are calibration.
- **Requirement extraction reads the posting page, not PDFs.** Always check the compliance matrix against the full solicitation and its addenda.
