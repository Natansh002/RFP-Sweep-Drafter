# Linking with Salesforce (or another sales platform) through MCP

RFP Sweep and Drafter runs as an **MCP server** next to your sales platform's own MCP connector.
Claude reads an RFP from the sweep and prepares the opportunity. **You confirm**, then
Claude creates the record with *your* Salesforce (or HubSpot / Dynamics 365) connector
and records the link here.

RFP Sweep and Drafter never calls the sales platform itself and never sends anything. It stores the
link (record id and URL) in `store/crm.json` on your machine only: never in git, never on
a published page, never in the findings ledger.

## The server

```bash
npm run mcp          # stdio server; Claude starts it for you
```

Tools:

| Tool | What it does |
|---|---|
| `list_opportunities` | Open RFPs, best fit to your offering first (status, minimum fit, closing within N days) |
| `get_opportunity` | One RFP: key facts read from its documents (questions deadline, value, term, evaluation), fit and why, risks, the four roles, proofreading and submission status, linked record |
| `get_company_profile` | What your company sells, read from its website |
| `prepare_crm_opportunity` | The fields for a Salesforce Opportunity, HubSpot deal or Dynamics 365 opportunity. Nothing is created |
| `link_crm_opportunity` | After you confirmed and the record was created: record its id and link (local only) |
| `unlink_crm_opportunity` | Forget the recorded link. The sales-platform record is not touched |

## Connect it

**Claude Code**: open this folder. `.mcp.json` registers the `rfp-sweeper` server; approve it
when Claude Code asks.

**Claude Desktop**: add it to the MCP settings:

```json
{
  "mcpServers": {
    "rfp-sweeper": { "command": "node", "args": ["/full/path/to/RFP-Sweep-Drafter/scripts/mcp-server.mjs"] }
  }
}
```

Then connect your sales platform's connector in Claude (for example, Salesforce), and
choose the platform in the dashboard's **Configuration** tab.

## Use it

Ask Claude, for example:

- "Which RFPs closing this month fit us best?"
- "Create a Salesforce opportunity for the Kentucky Housing Corporation ERP RFP."
- "Which pursued RFPs are not in Salesforce yet?"

For a create, Claude calls `prepare_crm_opportunity`, shows you the fields (name, close
date, stage, amount only if the buyer published one, and a description with the key facts
and the solicitation link), and asks. Only after you say yes does it create the record with
your connector, then it calls `link_crm_opportunity`. Each record needs its own
confirmation, and records are never deleted.

Already created one by hand? Paste its id and link in the workspace's **Salesforce…**
panel, in the local dashboard.

## Rules that do not change

- The sweep never fetches sales-platform domains (`lib/guard.mjs`).
- Jira, Confluence and the other internal tools stay off limits.
- Links stay on your machine. The published copy has no sales-platform panel at all.
