# RFP Sweep and Drafter: internal hosting request

**What:** please host the RFP Sweep and Drafter web app on our Azure, behind Microsoft
Entra sign-in, for the RFP and pre-sales team. It finds public RFPs, scores them against
our offering, and drafts responses. The team shares one pipeline. It is an internal tool
and holds no customer data.

**Version:** in `source/package.json`, and the commit is in `source/COMMIT`. The running
app shows both on its Configuration page. Everything needed is in this package; nothing
has to be fetched from GitHub.

| In this package | What it is |
|---|---|
| `source/` | The app, with its `Dockerfile` (Node + headless Chromium) |
| `source/infra/azure-internal-host.sh` | Azure Cloud Shell script that creates everything below. A dry run by default: it prints each command and changes nothing until `--apply` |
| `source/docs/internal-hosting.md` | The full runbook: portal steps, updating, troubleshooting |
| `app-settings.txt` | The app settings (no secrets) |
| `SO-ticket.txt` | The request as a ticket: summary, description, acceptance criteria |
| `screenshots/` | The Configuration page admins will use, and what someone not on the access list sees |

## What to create

| Resource | Setting |
|---|---|
| Resource group | e.g. `rg-rfp-sweep`, Canada Central |
| Azure Container Registry | Basic. The image is built in it from `source/` with `az acr build`, so no Docker is needed |
| App Service plan | Linux, **B2** (Chromium needs the memory), **one instance**, no autoscale |
| Web App for Containers | image `<registry>.azurecr.io/rfp-sweep-drafter:latest`, pulled with its system-assigned managed identity (AcrPull). HTTPS only, TLS 1.2 minimum, FTP disabled, **Always On** (the sweep schedule needs it), health check `/healthz` |
| App Service authentication | Microsoft identity provider, **current tenant only**, **require authentication**, HTTP 302 redirect to sign-in. Optional: *assignment required* with a security group for the RFP team |
| App settings | see `app-settings.txt`. `RFP_ADMINS` = the first admin(s); they add everyone else on the app's Configuration page |

## Quickest path (Azure Cloud Shell, Bash)

```bash
unzip RFP-Sweep-and-Drafter-internal-hosting-*.zip && cd RFP-Sweep-and-Drafter-internal-hosting-*/source
ACR=<registry> APP=<web-app> ADMINS=<first admin email> bash infra/azure-internal-host.sh           # dry run
ACR=<registry> APP=<web-app> ADMINS=<first admin email> bash infra/azure-internal-host.sh --apply   # create it
```

Optional: `ACCESS_GROUP=<group object id>` (only that group's members can sign in at all),
and `RG`, `LOCATION`, `PLAN`, `SKU`, `TIMEZONE` to change the defaults. The sign-in secret
goes straight into an app setting and is never printed.

## Network and security

- **Inbound:** only through App Service over HTTPS, after Microsoft sign-in with a company account.
- **Outbound:** HTTPS (443) to the public internet: public procurement portals, our website,
  reference links. No VNet and no access to internal networks are needed. Please grant none.
- **Access:** only accounts from our tenant (`RFP_TENANT_ID`) and on the app's access list
  get in. Admins manage the list on the Configuration page, and changes are logged.
- **Fails closed:** if App Service authentication is ever switched off, the app refuses every
  request. It never trusts sign-in headers it cannot vouch for.
- **Its own requests** reach public addresses only. Private, loopback, link-local and
  cloud-metadata addresses are refused when connecting, and internal tools are never contacted.
- **Data:** public procurement data, the access list (work email + role, no names) and the
  team's response library, in `/home/data/rfp-sweep`. Admins can download a backup zip.
- **One secret:** the sign-in client secret, kept by App Service
  (`MICROSOFT_PROVIDER_AUTHENTICATION_SECRET`). The script sets a one-year expiry.
- **Container user:** root, because App Service's `/home` storage needs it. Chromium opens
  only the configured public procurement portals. Links people paste are read as plain pages.
- **Dependencies:** `npm audit` reports one moderate advisory, in uuid via exceljs
  (GHSA-w5hq-g745-h8pq). It affects uuid v3/v5/v6 called with a buffer. exceljs calls only
  `uuid.v4()` without one, so it does not apply.

## Acceptance criteria

- Opening the site while signed out goes to Microsoft sign-in (company accounts only).
- The first admin signs in, and **Configuration → This host** shows the checks green:
  sign-in on, tenant locked, an admin, data kept across restarts, schedule on, headless
  browser. "No sweep has run yet" turns green after **Run now**.
- A colleague who is not on the access list sees "You are signed in, but not on the access list".
- **Run now** finishes and appears under Recent sweeps.
- **Download a backup** works for an admin.

## Please send back

- The app's URL.
- The registry name, so new versions can be built and rolled out.
- A reminder date for renewing the sign-in secret.

The screenshots were taken outside the container, so the headless-browser check shows a
warning there. In the container it is green: the image is built and checked on every
commit (the internal-host workflow checks sign-in, access, the browser and the network guard).
