# Security

## Reporting a problem

Please do not open a public issue. Report it privately to the repository's owner: on a
public copy, use **Security → Report a vulnerability**; otherwise, contact the owner through
GitHub. Say what you found and how to reproduce it. Only the latest version on `main` is
supported.

## How it is protected

- **Sign-in and access (internal host).** Microsoft Entra sign-in through App Service
  authentication, your tenant only (`RFP_TENANT_ID`), then the access list: work email,
  one of four roles, admin or not. Only admins change the configuration, and changes are
  logged. If sign-in is ever switched off, every request is refused
  ([docs/internal-hosting.md](docs/internal-hosting.md)).
- **Local copy.** Binds to 127.0.0.1 and refuses foreign Host headers.
- **Requests the app makes.** Public internet only: never an internal tool, by name
  (`lib/guard.mjs`), and never a private, loopback, link-local or cloud-metadata address,
  checked when connecting (`lib/netguard.mjs`). Links people paste are never opened in the
  host's browser.
- **The browser side.** Strict Content-Security-Policy with no outside scripts, styles or
  frames. Writes need a custom header, cross-site writes are refused, and every response
  carries `nosniff`, `no-referrer`, `DENY` framing, same-origin opener and resource policies
  and a permissions policy (plus HSTS on the internal host). Text from RFPs is shown as
  text, never as HTML.
- **Data.** No customer data. The access list, company profile, response library and
  sales-platform links stay on the host or your machine; `.gitignore` keeps them, and
  keys, certificates and publish profiles, out of git.
- **Every push.** A secret check (`scripts/check-secrets.mjs`) runs in `npm run check` and
  CI. A high or critical advisory in a runtime dependency fails CI (`npm audit`). GitHub
  Actions are pinned to commits, run with least-privilege tokens and keep no git
  credentials. The container's base image is pinned to its digest, and the image is built
  and checked on every push (sign-in required, refused when sign-in is off, browser, network guard).
- **Known advisory.** `npm audit` reports a moderate one in uuid via exceljs
  (GHSA-w5hq-g745-h8pq): it affects uuid v3/v5/v6 called with a buffer, and exceljs calls
  only `uuid.v4()` without one, so it does not apply.

## Settings to switch on in GitHub

These are repository and account settings, so the owner switches them on:

- **Account:** two-factor authentication (Settings → Password and authentication).
- **Repository → Settings → Advanced Security** (named "Code security" on some accounts):
  Dependency graph, **Dependabot alerts** and **Dependabot security updates**. On a public
  repository also: **Secret scanning** with **Push protection**, **Private vulnerability
  reporting**, and **CodeQL** default setup. These last three are paid features on private
  repositories, which is why the secret check above exists.
- **Repository → Settings → Actions → General:** Workflow permissions **Read repository
  contents and packages permissions**; leave **Allow GitHub Actions to create and approve
  pull requests** unticked.
- **Branch protection for `main`** (no force pushes, no deletion): free on public
  repositories; on private repositories it needs GitHub Pro or Team.
