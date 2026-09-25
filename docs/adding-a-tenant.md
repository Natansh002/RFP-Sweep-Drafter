# Adding a tenant (an Ionic operating company)

```bash
npm run new-tenant -- <id> "<Company name>" --industries k12,nonprofit --geo CA,US
npm run check
```

A tenant describes a **company**. Industry packs describe a **market**, and several
companies can share one pack.

## What to fill in

| Field | Why |
|---|---|
| `industries` | Pack ids from `industries/`. |
| `offerings.<industry>.productLines` | **Required.** Which of your products this sweep is for. The drafter names them. |
| `offerings.<industry>.extraTitleKeywords` / `extraBodyKeywords` / `extraDisqualifiers` | Your own keyword additions to the shared pack, without forking it. |
| `offerings.<industry>.defaultAssignee` | A role, shown as the suggested owner next to the empty Assignee field. |
| `offerings.<industry>.pitch` | Executive-summary text the drafter may use for this industry. |
| `team` | **Role titles only**: the four roles `"RFP Manager"`, `"Pre-sales Consultant"`, `"Account Executive"`, `"SME Contributor"`, never people's names or emails. Feeds the Assignee dropdown in the dashboard and the Excel `Team` sheet. The validator rejects emails. |
| `autoAssign` | `false` by default: a person assigns each finding. `true` fills in the suggested owner. |
| `profile` | What the drafter may say about the company: `oneLiner`, `summary`, `capabilities`, `differentiators`, `implementationApproach`, `referencesNote`. **Approved claims only.** Empty fields become `[TODO]`. |
| `competitors` | `[{ "name": "...", "aliases": [] }]`. When one is named on a posting page, the finding is tagged and the draft gets a Competitive notes section. |
| `goNoGo` | Optional weighted criteria (weights total 100) and a threshold. Omit it to use the defaults. |
| `excludeChannels` | Registry ids this company never sweeps. |
| `installedBaseWatch` | Optional path to a list of domains to sweep directly with `--direct`. **No customer data is committed to this repo**: keep any such list in the gitignored `data/private/` folder. |
| `detailPagesPerRun` | How many candidate posting pages to read per run (default 40). |
| `guard.extraBlockedHosts` | Your own intranet or internal domains, so they are never fetched or linked. |
| `safety.maxNewPursuePerRun` | Tripwire. If a run exceeds it, nothing is added and the run reports why. |

## What a tenant may not have

The validator fails a tenant that has `ticketSystem`, `jira`, `confluence`,
`notify.teams`, `crm.sweeperWrites: true`, or a link to any internal tool anywhere
in it. Findings are tracked in the dashboard and Excel only.

`crm.rule` can still record, in prose, how a person should create a CRM record after
go/no-go. The sweeper never does it.

## Answer library

```bash
cp library/_template.json library/<id>.json
```

Add approved answers with an `owner`, a `lastReviewed` date and `reviewEveryDays`.
The drafter cites the best matches in each pursue draft as `[library:<id>, reviewed <date>]`
and marks overdue entries **STALE**. The validator warns about stale entries.
