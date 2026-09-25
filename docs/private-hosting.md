# Private host with company sign-in

The published copy on GitHub Pages is public. To limit the dashboard to named
people, it is also deployed to a **private host** (Azure Static Web Apps) where every
page needs **Microsoft sign-in** and an entry on the **access list**: work email plus
one of the four roles (RFP Manager, Pre-sales Consultant, Account Executive, SME
Contributor). No names are stored.

How it works:

- `site/staticwebapp.config.json` (written by every build) requires the `rfp_user`
  role on every page, sends people who are not signed in to Microsoft sign-in, and
  switches the other sign-in providers off.
- After sign-in, Static Web Apps asks `api/roles` which roles the person has. It
  answers from the `RFP_ACCESS` app setting: only listed emails get `rfp_user`
  (plus their role). Everyone else sees `no-access.html`.
- The access list is edited in the local dashboard (**Configuration** tab), saved in
  `store/access.json` on your machine (gitignored, never published), and applied with
  `npm run access:apply`.

These steps need your Azure and Microsoft Entra accounts, so the tool never does them
for you.

## 1. Create the Static Web App

1. Azure portal → **Create a resource** → **Static Web App**.
2. Plan: **Standard**. The role function (`rolesSource`) needs it.
3. Deployment source: **Other**. GitHub Actions deploys with a token.
4. After it is created: **Manage deployment token** → copy it.
5. GitHub repository → Settings → Secrets and variables → Actions:
   - secret **`AZURE_STATIC_WEB_APPS_API_TOKEN`**: the token.

## 2. Register the sign-in app (Microsoft Entra)

1. Entra admin center → App registrations → **New registration**.
   - Name: `RFP Sweep`.
   - Accounts in **this organizational directory only**.
   - Redirect URI (Web): `https://<your-app>.azurestaticapps.net/.auth/login/aad/callback`
     (and the same path on your custom domain, if you add one).
2. Certificates & secrets → **New client secret** → copy the value.
3. On the Static Web App → **Environment variables**:
   - `AAD_CLIENT_ID`: the app registration's Application (client) ID.
   - `AAD_CLIENT_SECRET`: the secret value.
4. GitHub → Settings → Secrets and variables → Actions → **Variables**:
   - `AAD_TENANT_ID`: your Directory (tenant) ID. The build writes it into the sign-in rules.

## 3. Add the people

1. `npm run dashboard` → **Configuration** → add each work email with its role → **Save access list**.
2. Apply it (uses your own `az login`):

   ```bash
   npm run access:apply -- --name <static-web-app> --resource-group <resource-group>
   ```

   Without the Azure CLI: paste the list the command prints into the `RFP_ACCESS`
   environment variable in the Azure portal.

Change the list the same way at any time. It takes effect at the person's next sign-in.

## 4. Deploy

Push to `main`, or run the **pages** workflow. With the token set, every build also
deploys `site/` and `api/` to the private host. Open
`https://<your-app>.azurestaticapps.net`:

- a listed email signs in and sees the dashboard, with **Your role** filled in;
- anyone else signs in and sees the no-access page.

## 5. Stop the public copy

When the private host works:

1. GitHub → Settings → Secrets and variables → Actions → Variables: set **`PUBLISH_PAGES`** to `false`.
   Builds stop deploying to GitHub Pages. Findings carry over between runs through the workflow cache.
2. GitHub → Settings → Pages → **Unpublish site**, to take down the copy already there.
3. Consider making the repository private as well.

## What stays true

- The sweep still reads only public procurement pages through `lib/guard.mjs`.
- The access list, company profile and sales-platform links never go into git or onto a page.
- No passwords or tokens are stored in the repository. The deployment token and the
  client secret live in GitHub secrets and in the Static Web App's settings.
