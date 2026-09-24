# The workflows (optional scheduler)

**Generated. Do not hand-edit.** Run `npm run build` and commit the result. The
validator compiles every Code node and fails on any node that connects to an
internal tool or sends messages.

| File | Trigger | What it is |
|---|---|---|
| `sweep-core.json` | Execute Workflow | One channel: guarded fetch, extract, score, read posting pages, draft |
| `sweep-run.json` | Execute Workflow | One tenant × industry. Config is embedded. Outputs a findings `.xlsx` and a run `.json` |
| `sweep-on-demand.json` | Form | Pick a company, an industry and a width |
| `sweep-scheduled-<tenant>.json` | Cron | One per tenant, using its `schedule.cron` and `schedule.timezone` |

## Import

Import them all, then set two environment variables:

```
SWEEPER_CORE_WORKFLOW_ID   id of the imported sweep-core
SWEEPER_RUN_WORKFLOW_ID    id of the imported sweep-run
```

There is no config URL. Tenants, packs, the channel registry and answer libraries
are embedded when you run `npm run build`, so n8n never fetches config from a git
server or any internal host. After a config change: build, then re-import.

## Getting the results

Each run's last node carries two files:

- `data`: the findings spreadsheet
- `findings_json`: the run file. Upload it with the dashboard's **Import n8n run** button to merge it into the ledger. From there you get assignees, action items, drafts, compliance and the full workbook.

Nothing is posted to the dashboard over the network, and nothing is filed anywhere.

## Blind spots

Client-rendered portals come back as `needs-browser`, and the run file lists them
under `gaps`. A browser step between the fetch and extract nodes is the biggest yield
improvement available.
