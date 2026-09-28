# Internal hosting (company sign-in)

The team version of RFP Sweep and Drafter runs on your company's **Azure App Service**,
behind **Microsoft Entra sign-in**. Everyone shares one pipeline. Admins manage who can
open it and when it sweeps on its **Configuration** page. Once it works, the public
GitHub Pages copy is switched off.

Your operations team sets it up once. This page covers what they need. Creating Azure
and Entra resources needs your company's accounts, so the tool never does it itself.

## How it works

```
Browser ──HTTPS──▶ App Service ──────────────▶ container: Node + headless Chromium
                   Microsoft Entra sign-in       RFP_MODE=internal
                   (your tenant, required)       checks the access list on every request
                                                 sweeps on a schedule
                                                 └─▶ /home/data/rfp-sweep (kept across restarts)
```

- **Sign-in** is done by App Service (App Service authentication, Microsoft Entra, your
  tenant only). Nobody reaches the app without signing in.
- **The access list** then decides who gets in. It holds work email plus one of the four
  roles (RFP Manager, Pre-sales Consultant, Account Executive, SME Contributor), and
  whether the person is an **admin**. No names. Anyone else who signs in sees a
  no-access page.
- **The first admins** come from the `RFP_ADMINS` app setting. They always get in, and
  they add everyone else on the Configuration page. Changes take effect on the next click.
- **Admins alone** change the configuration: users, the sweep schedule, the sales
  platform, backups and the activity log. Everyone on the list works on the pipeline.
  Changes to opportunities are recorded with the person's role, never a name.
- **Fails closed.** If App Service authentication is ever switched off, the app refuses
  every request and shows "Company sign-in is not switched on". It does not trust
  sign-in headers it cannot vouch for. With `RFP_TENANT_ID` set, accounts from any other
  tenant are refused as well.
- **The scheduled sweep** runs inside the app, weekdays at 06:00 America/Toronto by
  default. Admins change it on the Configuration page. One sweep runs at a time. A
  sweep that outlasts App Service's 230-second request limit keeps running, and the page
  follows it to the end.
- **The headless browser** (Chromium, in the image) opens only the configured public
  procurement portals. A link someone pastes, such as the company website or a
  reference, is read as a plain page and never opened in the browser.
- **Outbound traffic** is HTTPS GETs to the public internet only: procurement portals,
  the company website, reference links. Every request is checked twice. By name: never
  internal tools such as Jira, Confluence, Salesforce or Microsoft 365 (`lib/guard.mjs`).
  By address, at connect time: never a private, loopback, link-local or cloud-metadata
  address (`lib/netguard.mjs`). The app needs no VNet and no access to internal networks,
  and should be given none.

## What operations creates

| Resource | Setting |
|---|---|
| Resource group | for example `rg-rfp-sweep`, region Canada Central |
| Azure Container Registry | Basic. The image is built in it from this repository with `az acr build`, so no Docker is needed |
| App Service plan | Linux, **B2** (Chromium needs the memory), **one instance**, no autoscale |
| Web App for Containers | image `<registry>.azurecr.io/rfp-sweep-drafter:latest`, pulled with its system-assigned managed identity (AcrPull). HTTPS only, minimum TLS 1.2, FTP disabled, **Always On** (the schedule needs it), health check path `/healthz` |
| App Service authentication | Microsoft identity provider, **current tenant only**, **require authentication**, unauthenticated requests get an HTTP 302 redirect to sign-in. Optional: *assignment required* on the enterprise app, with a security group |

App settings (no secrets among them):

| Setting | Value | Why |
|---|---|---|
| `RFP_MODE` | `internal` | sign-in, the access list and the schedule are on |
| `RFP_ADMINS` | `first.admin@yourcompany.com,second.admin@yourcompany.com` | the first admins |
| `RFP_TENANT_ID` | your Directory (tenant) ID | only accounts from your tenant |
| `RFP_DATA_DIR` | `/home/data/rfp-sweep` | the pipeline, users, settings, activity log and response library |
| `RFP_TIMEZONE` | `America/Toronto` | default time zone of the schedule |
| `WEBSITES_ENABLE_APP_SERVICE_STORAGE` | `true` | keeps `/home` when the container restarts |
| `WEBSITES_PORT` | `8080` | the port the container listens on |
| `RFP_DOCUMENTS_PER_RUN` | `20` (optional) | solicitation documents read per industry, per sweep |

App Service adds `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET` (the sign-in secret) and
`WEBSITE_AUTH_ENABLED` itself. The app never reads the secret.

## Option A: the script, in Azure Cloud Shell

[`infra/azure-internal-host.sh`](../infra/azure-internal-host.sh) creates all of the
above. It prints every command first, and changes nothing until you add `--apply`.
Upload the package zip to Cloud Shell (or clone the repository), unzip it, and run the
script from the app's folder. The image is built in your registry from those files, so
nothing needs to be fetched from GitHub.

```bash
unzip RFP-Sweep-and-Drafter-internal-hosting-*.zip && cd RFP-Sweep-and-Drafter-internal-hosting-*/source
ACR=<registry> APP=<web-app> ADMINS=first.admin@yourcompany.com bash infra/azure-internal-host.sh
ACR=<registry> APP=<web-app> ADMINS=first.admin@yourcompany.com bash infra/azure-internal-host.sh --apply
```

Optional: `ACCESS_GROUP=<group object id>` makes the enterprise app *assignment
required*, so only members of that security group can sign in at all. The admins must
be members too. `RG`, `LOCATION`, `PLAN`, `SKU` and `TIMEZONE` change the defaults.
The sign-in secret goes straight into the app setting and is never printed.

## Option B: the Azure portal

1. **Container registry** → Create (Basic). In Cloud Shell, from the app's folder
   (the package's `source/`, or a clone), build the image:
   `az acr build --registry <registry> --image rfp-sweep-drafter:latest --build-arg RFP_COMMIT=$(cat COMMIT) .`
2. **App Service plan**: Linux, B2.
3. **Web App**: Publish *Container*, the plan above, image from the registry. Then:
   - *Identity*: system-assigned **On**. On the registry, give it the **AcrPull** role.
     In *Deployment Center*, choose managed identity for the registry.
   - *Configuration → General settings*: Always On **On**, HTTPS only, minimum TLS 1.2,
     FTP state **Disabled**.
   - *Health check*: path `/healthz`.
   - *Environment variables*: the app settings above.
4. **Authentication** → Add identity provider → **Microsoft**:
   - App registration: create new, supported account types **Current tenant – Single tenant**.
   - Restrict access: **Require authentication**. Unauthenticated requests: **HTTP 302 Found redirect**.
   - This creates the app registration and its secret, and stores the secret as an app setting.
5. Optional: Entra admin center → Enterprise applications → the new app → Properties:
   **Assignment required = Yes**. Under Users and groups, add the security group.

## First sign-in

1. Open `https://<web-app host>` and sign in as one of the `RFP_ADMINS`.
2. **Configuration → This host**: every check should be green. Sign-in on, tenant
   locked, an admin, data kept across restarts, schedule on, headless browser installed.
   "No sweep has run yet" turns green after the first sweep; press **Run now** to start one.
3. **Users and access**: add each person's work email with their role. Tick **Admin** for
   anyone else who should manage this page. **Save access list**.
4. **Your company**, on the RFP Sweep tab: enter the company website, so fit and the
   scheduled searches follow what the company sells.

## Acceptance checks

- Opening the site while signed out goes to Microsoft sign-in.
- A colleague who is not on the list sees "You are signed in, but not on the access list".
- A Pre-sales Consultant on the list can work on opportunities but sees the configuration read-only.
- **Run now** adds a line under Recent sweeps, and the pipeline updates.
- **Download a backup** gives a zip with `store/access.json`, `store/settings.json` and `store/all.json`.

## Updating

Each commit to `main` is built and checked by the **internal-host** workflow
(`.github/workflows/internal-host.yml`). It starts the image, checks sign-in is required,
checks that everyone is refused when sign-in is off, and checks that the browser works.
To roll a new version out:

- **By hand**: from the new package (or an updated clone), run the `az acr build` command
  above again, then restart the web app.
- **Automatically (optional)**: create a Microsoft Entra app registration for deployment,
  with a federated credential for this repository. The subject is
  `repo:<owner>/<repo>:environment:internal-host`. Give it *Contributor* on the registry
  and *Website Contributor* on the web app. In GitHub, set the variables
  `AZURE_WEBAPP_NAME`, `AZURE_RESOURCE_GROUP` and `AZURE_CONTAINER_REGISTRY`, and the
  secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`. Each push
  to `main` then builds the image in the registry and points the web app at it. The
  deploy fails if the site answers anyone without sign-in. No password is stored.

## Switch off the public copy

When the internal host works:

1. GitHub → Settings → Secrets and variables → Actions → Variables: set **`PUBLISH_PAGES`** to `false`.
2. GitHub → Settings → Pages → **Unpublish site**.
3. Consider making the repository private. Builds from the package or a clone are not affected.
   On GitHub's free plan a private repository has no Pages, so this also takes the public copy
   down. The pages workflow then skips publishing (and its scheduled runs do nothing), while
   pushes still run every test.

## Running it

- **One instance only.** The data is a folder of files, so two instances would write the
  same files. Do not scale out.
- **Backups**: Configuration → *Download a backup* (admins), or App Service backups where
  your plan has them. Everything lives in `/home/data/rfp-sweep`.
- **The sign-in secret expires** (one year with the script). Renew it under the app
  registration's *Certificates & secrets* and update `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET`.
- **Logs**: App Service log stream. The app logs its start-up status and errors, not requests.
- **Local copy**: `npm run dashboard` still runs a one-person copy on 127.0.0.1.

| Symptom | Fix |
|---|---|
| "Company sign-in is not switched on" | Turn on App Service authentication (Microsoft, require authentication) |
| "You are signed in, but not on the access list" | An admin adds the email on the Configuration page |
| "This account is not from your company's Microsoft Entra tenant" | Sign in with a company account, or check `RFP_TENANT_ID` |
| Data check red | `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` and `RFP_DATA_DIR` under `/home` |
| Browser check red | Run the container image, not a code deployment |
| Sweeps never run | Always On must be on. Check the schedule on the Configuration page |

Without containers: App Service on Node 22 LTS with startup command
`node scripts/dashboard.mjs` and the same settings also works. It has no headless browser,
so portals that build their listings with JavaScript are reported as not read. The
container is recommended.
