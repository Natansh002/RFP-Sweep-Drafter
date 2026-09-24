# Feature review against the market (September 2026)

This compares the tool with the leading RFP discovery and RFP-response tools, based
on their public sites. Vendor claims are marketing claims, not independent tests.

## Who does what

**Response and drafting:**
- **Loopio.** Answer library, freshness review cycles, win-rate reporting.
- **Responsive (RFPIO).** Go/no-go analysis and requirement extraction.
- **Inventive AI.** Flags stale or conflicting answers and gives confidence ratings.
- **AutoRFP.ai.** Screening questions for go/no-go.
- **Arphie.** Marks answers stale when their source changes.
- **1up.** A citation on every answer; question assignment.
- **DeepRFP.** An "RFP shredder" that builds a compliance matrix.
- **Upland Qvidian.** Enterprise answer library.

**Discovery and intelligence:**
- **Deltek GovWin IQ.** Pre-RFP signals from budgets and board documents; incumbents.
- **GovSpend.** Purchase-order history and board-meeting transcripts.
- **BidPrime.** Fast alerts and search inside spec documents.
- **HigherGov.** Saved searches and expiring contracts.
- **Periscope / BidNet Direct.** Include/exclude matching; addenda and award notices.
- **Euna (Bonfire) / OpenGov / MERX.** Follow a bid to get addenda, Q&A and key dates.
- **Mercell.** Award analysis.
- **Starbridge, CivicIQ, NationGraph.** Buying signals 6–18 months before the RFP.

## Adopted in this version

| Idea | Seen in | Here |
|---|---|---|
| Read the posting, not just the listing | BidPrime (spec search), DeepRFP | `lib/enrich.mjs`: dates, requirements, incumbent, competitors; then re-score |
| Addenda / change detection | MERX, OpenGov, Euna, BidNet | Page hash plus date comparison. A *changed* flag and a review action until acknowledged |
| Key dates and a deadline calendar | Euna, OpenGov | Closing, questions, pre-bid, site visit. Countdown in the dashboard, `.ics` download, dated action items |
| Go/no-go scorecard | AutoRFP, Responsive, SiftHub | Weighted criteria per tenant, answered by people as yes, partial or no |
| Compliance matrix | DeepRFP, Inventive, AutogenAI | Typed "shall/must" statements, owner and status. Excel sheet and dashboard |
| Answer library with freshness | Loopio, Arphie, Inventive | `library/<tenant>.json`, cited by id in drafts, STALE flag after the review date |
| Citations in drafts | 1up, AutoRFP | Library ids and review dates inline. `[TODO]` wherever there is no approved source |
| Win/loss and pipeline | Loopio, GovTribe | Value, loss reason, awardee. Pipeline sheet and win-rate KPI |
| Competitor mentions | Inventive, GovWin | `tenant.competitors`, tagged on findings, Competitive notes in the draft |
| Assignment without a task system | 1up, Loopio | Assignee on findings, actions and requirements. *Mine* and *Unassigned* views |
| Coverage honesty | BidPrime | Gaps by channel: `needs-browser`, `fetch-failed`, `blocked` |

## Left out on purpose

These break the tool's rules: no internal tools, nothing sent, no CRM writes.

- Email, Slack or Teams alerts. Use the dashboard's *Changed* filter and KPIs instead.
- CRM sync (Salesforce, HubSpot).
- Portal auto-submission, auto-fill, or logging in and registering on portals.
- Contact enrichment and outreach drafting.
- Ingesting knowledge from Confluence, Jira or wikis. The library is local JSON.
- "Follow" buttons on buyer portals. Following is an account action, so it stays manual.

## Next, by value

1. **Browser step for client-rendered portals** (L). The biggest yield gap. The live run confirmed it.
2. **Pre-RFP signals** (L). Watch board agendas, minutes and budgets for target buyers ("ERP replacement", "RFP to be issued"), and let a person promote a signal to a finding.
3. **Award history and incumbents** (M). Parse public award notices into `awards.json` and show "likely incumbent, contract ends" on each finding.
4. **Saved searches and a "new since last run" inbox** (S).
5. **Commodity codes** (NIGP, UNSPSC, CPV) in packs for portals that support them (S).
6. **PDF solicitation reading** for the compliance matrix (M).
