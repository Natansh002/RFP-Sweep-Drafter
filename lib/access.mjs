/**
 * Who can open the dashboard on the private host, and with which of the four roles.
 *
 * The list is work email + role, nothing else: no names. It lives in
 * store/access.json on the admin's machine (gitignored, never published) and is
 * applied to the private host as its RFP_ACCESS app setting (npm run access:apply).
 * The host's sign-in (Microsoft Entra) proves who someone is; api/roles turns this
 * list into roles, and every page requires the rfp_user role.
 *
 * Import-free: api/roles/index.js carries a copy of rolesFor(), kept in step by the tests.
 */

export const ACCESS_ROLES = ["RFP Manager", "Pre-sales Consultant", "Account Executive", "SME Contributor"];
export const roleSlug = (role) => String(role).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Clean and check a list: valid work emails, one of the four roles, no duplicates. Returns { users, errors }. */
export function validateAccess(list) {
  const users = [], errors = [], seen = new Set();
  for (const [i, u] of (Array.isArray(list) ? list : []).entries()) {
    const email = String(u?.email ?? "").trim().toLowerCase();
    const role = ACCESS_ROLES.find((r) => r.toLowerCase() === String(u?.role ?? "").trim().toLowerCase());
    if (!EMAIL.test(email)) { errors.push(`Row ${i + 1}: "${u?.email ?? ""}" is not an email address.`); continue; }
    if (!role) { errors.push(`Row ${i + 1}: ${email} needs one of the four roles (${ACCESS_ROLES.join(", ")}).`); continue; }
    if (seen.has(email)) { errors.push(`Row ${i + 1}: ${email} is listed twice.`); continue; }
    seen.add(email);
    users.push({ email, role, admin: u?.admin === true });
  }
  return { users, errors };
}

/** Roles the private host grants a signed-in email: none unless it is on the list. */
export function rolesFor(users, email) {
  const u = (users ?? []).find((x) => x.email === String(email ?? "").trim().toLowerCase());
  if (!u) return [];
  return ["rfp_user", `rfp_${roleSlug(u.role).replace(/-/g, "_")}`, ...(u.admin ? ["rfp_admin"] : [])];
}

/** The private host's route rules (staticwebapp.config.json): sign in with Microsoft, then the list decides. */
export function hostConfig({ tenantId = null } = {}) {
  return {
    $comment: "Private host (Azure Static Web Apps). Every page needs the rfp_user role, which api/roles grants only to emails on the access list (RFP_ACCESS app setting).",
    auth: {
      rolesSource: "/api/roles",
      identityProviders: {
        azureActiveDirectory: {
          registration: {
            openIdIssuer: tenantId ? `https://login.microsoftonline.com/${tenantId}/v2.0` : "https://login.microsoftonline.com/<your-tenant-id>/v2.0",
            clientIdSettingName: "AAD_CLIENT_ID",
            clientSecretSettingName: "AAD_CLIENT_SECRET",
          },
        },
      },
    },
    routes: [
      { route: "/.auth/login/github", statusCode: 404 },
      { route: "/.auth/login/twitter", statusCode: 404 },
      { route: "/api/roles", allowedRoles: ["authenticated"] },
      { route: "/no-access.html", allowedRoles: ["authenticated"] },
      { route: "/*", allowedRoles: ["rfp_user"] },
    ],
    responseOverrides: {
      401: { redirect: "/.auth/login/aad?post_login_redirect_uri=.referrer", statusCode: 302 },
      403: { rewrite: "/no-access.html" },
    },
    globalHeaders: { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" },
  };
}

export default { ACCESS_ROLES, roleSlug, validateAccess, rolesFor, hostConfig };
