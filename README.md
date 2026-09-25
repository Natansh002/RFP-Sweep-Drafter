# RFP Sweep and Drafter

An RFP operating system for professional services: **Find → Understand → Qualify →
Assign → Answer → Proofread → Submit**. Give it your company's website and it works out
what you sell, then scores every RFP on that offering. Then say what you are looking for:

> **Industry → Geography → Capability → Date range** → **Run RFP Sweep**

and get a scored pipeline ("24 opportunities relevant to you: 8 Strong fit, 10 Possible fit").
Each RFP comes in with its public solicitation documents already read. Open any
opportunity and work it through **Qualify → Assign → Analyze RFP → Draft response →
Proofread → RFP submission status**, then **export the scoring file** (Excel) and the
proposal draft.

Live: **https://natansh002.github.io/RFP-Sweep-Drafter/** (read-only, refreshed by
GitHub Actions). Full editing: `npm run dashboard` on your machine.

| Step | What it does | Agent in the spec |
|---|---|---|
| Your company | Reads your website (home page plus its product, solution and about pages) and works out what you sell (capabilities), your own terms and product names, and the platforms you work with. You review it as toggle chips and edit the terms | Profile |
| Discover | Sweeps CanadaBuys open data, SAM.gov and public portals; de-duplicates; filters by industry, geography, capability, date; **scores every posting on your offering** and can show only the relevant ones | Scout |
| Fetch the RFP | Downloads each posting's **public solicitation documents** (SAM.gov attachments, the CanadaBuys attachment list, document links on the posting page) and reads them for the **questions deadline, budget, contract term and options, evaluation criteria and basis of award**, risks and response items. Never signs in | Lens |
| Understand | Reads the notice, the fetched documents or an uploaded RFP (PDF / DOCX / TXT / HTML). Extracts dates, term, value, evaluation weights, submission rules and requirements | Lens, Decomposer |
| Qualify | Fit / risk / timeline / coverage scores with reasons. **Fit is on your product offering** (what you sell 60, your terms and product names 25, platforms 15; an RFP whose title asks for what you sell is a strong fit, words only in its description count for little), never the buyer's industry. *Why it matters, why we may not qualify, key risks, information still required (and where the sweep looked), next action.* **Verified** facts (with source) kept apart from **inferred** ones | FitCheck |
| Assign | Four roles on every bid: **RFP Manager, Pre-sales Consultant, Account Executive, SME Contributor**, with the SME areas the RFP needs, from `config/capability-matrix.json` (roles only) | Route |
| Answer | Drafts each requirement from the approved knowledge base (`library/knowledge.json`), citing the source with a confidence level. **No approved source means "SME validation required", never invented text** | AnswerSmith, ProofPoint |
| Build | First-draft proposal in the customer's own section names: executive summary (problem → approach → outcomes → why us), responses, compliance matrix, assumptions, risks. Pricing is never drafted | ProposalBuilder |
| Proofread | Every answer and the proposal: placeholders left in, misspellings, doubled words, mixed spellings, undefined acronyms, long sentences, spacing, thin answers, generic phrasing. Flags only; a person fixes the text and signs off | Proofreader |
| RFP submission status | The submission check: signed-off proofreading, mandatory answers approved, no SME markers, stale sources, page limits, deadline. **Ready to submit** or what blocks it, then **Mark as submitted**. Nothing is sent from the tool | RedTeam |
| Learn | Won / lost / no-bid, loss reason and awardee on each finding, a Pipeline sheet with win rate, audit history and workspace versions | Learn |

**Filters:** Industry (the buyer's sector), Geography, Capability, Date range and
Status: **Active**, **Past due** (closing date passed while still open on our side),
**Closed**, All, plus **Show only RFPs relevant to us** once your company profile is set.
The workflow steps across the top filter the results when clicked.

**Your company profile:** enter your website and press **Understand my business**. It reads
the home page and up to six product and about pages, shows **What we understood** in plain
words (what you sell, to whom, on what platform, in your own words), and keeps those pages as
product knowledge that drafts can cite. The local dashboard reads the site itself, through the
same guard as every sweep. The published page reads it through **r.jina.ai**, a public reader
service: only the website's address is sent, the pages come back as text, internal and private
addresses are never sent, and its security policy allows no other outside connection. If a site
cannot be read, paste its text or upload a brochure. Every capability and match names the words
that produced it; the profile stays on your machine or in your browser.

**Working on the published page:** status (including Archived and Lost), owner, notes and action
items all work there, one at a time or by selecting several (Mark done, Archive, Closed lost). The
changes are kept in your browser; **Download my changes** turns them into an assignments sheet to
upload to `assignments/`, and the site rebuilds with them for everyone.

**Fetched with the RFP:** documents behind a sign-in (MERX, bids&tenders, Bonfire,
Biddingo, SAP Ariba) are named, not read: the sweeper never logs in. The full document text
is kept next to your local ledger (`store/text/`, gitignored) so the local workspace
analyzes the whole RFP; the published site carries only the extracted facts, response
items and risks. Contact names, emails and phone numbers are removed from anything stored.

**Writing responses:** the `rfp-response-writer` skill (`.claude/skills/`) encodes how
SME-reviewed answers are written: approach in the buyer's terms, every sub-ask in
order, an anonymized comparable example, supplementary materials. Export an **SME
review** workbook from any workspace, import it back, and `npm run learn` turns a
finished review into reusable answers that stay on your machine.

**How it analyzes:** pattern matching and TF-IDF text similarity, not a language
model, and every output says so. It is deterministic, explains each score, and
never fabricates a reference, certification, capability or metric.

## Your template, references and export

On the **Analyze a document** tab:

- **Response template.** Upload your own Word (.docx) or Excel (.xlsx) template. A Word template can use
  tags such as `{{title}}`, `{{buyer}}`, `{{closeDate}}`, `{{executiveSummary}}` and a
  `{{#responses}}{{reqId}} {{requirement}} {{answer}}{{/responses}}` loop; a Word template without tags
  gets the responses added after its own content, in its heading styles (letterhead, headers and footers
  stay). An Excel template is filled through its Question/Requirement and Answer/Response columns, and a
  buyer's questionnaire has each of its questions answered with the closest drafted response.
  **Download a sample template** to start from.
- **Reference articles and past RFP responses.** Paste links (one per line) and add files. Past responses
  are split into question → answer pairs, articles into topics. Drafts cite them by name and always go to
  an SME to confirm: a reference is never treated as an approved answer.
- **Export RFP responses.** Pick a pipeline and the opportunities (being worked, submitted, all open). One
  opportunity downloads its **Word document** directly; several come in a .zip (with a summary workbook if
  you ask). Each workspace also has **Export response (Word)**. Answers come from your approved answers,
  past responses, reference articles and your website's pages, and the document includes an **About your
  company** section from your profile. Saved drafts are used as they are; the rest are drafted at export.

The template and references stay private: in `library/private/` on your machine (local dashboard) or in
your browser (published page). They are never uploaded or published. The published page cannot read other
websites, so there links are listed but not read: add the file instead, or use the local dashboard.

## Configuration

The **Configuration** tab (local dashboard) holds two things:

- **Users and access.** Work email plus one of the four roles. No names are stored. On the **private host**
  (Azure Static Web Apps with Microsoft sign-in), only those emails get in; everyone else sees a
  no-access page. Set-up: [docs/private-hosting.md](docs/private-hosting.md). Once it works, set the
  repository variable `PUBLISH_PAGES=false` to retire the public copy.
- **Sales platform (MCP).** `npm run mcp` runs RFP Sweep and Drafter as an MCP server (registered in `.mcp.json`).
  Claude, with your Salesforce, HubSpot or Dynamics 365 connector, can list the best-fit RFPs, prepare
  the opportunity fields and, **after you confirm**, create the record and link it back. Links stay in
  `store/crm.json` on your machine. Details: [docs/sales-platform-mcp.md](docs/sales-platform-mcp.md).

## Quick start

```bash
npm install
npm run dashboard                               # http://127.0.0.1:4173 → RFP Sweep tab
npm run analyze -- --rfp path/to/rfp.pdf        # scoring .xlsx + summary .md in output/
npm run check                                   # build + validate + tests
npm run test:e2e                                # every screen, button and filter in a real browser
npm run learn -- --file SME_Review.xlsx         # learn reviewed answers (kept private, gitignored)
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
| Team | The assignee list: RFP Manager, Pre-sales Consultant, Account Executive, SME Contributor (roles, not names) | — |

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
| **Addenda / change detection** | Hashes each posting's own text, leaving out countdowns, clock times and page chrome, so only a real change counts. A changed posting, close date or key date raises a *changed* flag and one "review the addendum" action (updated, never duplicated) until someone acknowledges it. |
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
- **What could not be read is reported**, never dropped. `needs-browser`, `fetch-failed` and `blocked` channels are listed on the workbook's Coverage gaps sheet.
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

- **Subscription aggregators** (Biddingo, RFP School Watch for Canadian K-12) show open bids only to
  subscribers, and their terms forbid commercial copying, so they are listed for people to check, never read.
- **Client-rendered portals** (BC Bid, APC, SaskTenders, SEAO, Ontario Tenders, MERX, bids&tenders, Biddingo) return an empty shell to a plain fetch and are reported as `needs-browser`. On the first live run, most K-12 and nonprofit portals fell into this category or refused the fetch, and that run found no real postings. A browser step is still the biggest yield improvement available. The direct watch-list sweep (`--direct`) and posting-page enrichment are the next best.
- **Extraction is deliberately generic.** It harvests links and lets the scorer decide. Postings found only as links score mostly on unknowns until their page is read.
- **The two logistics packs are unvalidated.** Their first two sweeps are calibration.
- **Requirement extraction reads the posting page, not PDFs.** Always check the compliance matrix against the full solicitation and its addenda.
