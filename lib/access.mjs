/**
 * Who can open the dashboard on the internal host, and with which of the four roles.
 *
 * The list is work email + role (+ whether the person is an admin), nothing else: no
 * names. It lives in the host's data folder (store/access.json), is edited by admins on
 * the Configuration page, and takes effect on the next request. Microsoft Entra sign-in
 * (App Service authentication) proves who someone is; this list decides whether they
 * get in. The first admins come from the RFP_ADMINS app setting, so the list can never
 * lock everyone out.
 *
 * Import-free: the browser bundle may inline it.
 */

export const ACCESS_ROLES = ["RFP Manager", "Pre-sales Consultant", "Account Executive", "SME Contributor"];
export const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

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

/**
 * What a signed-in email may do: { email, role, admin, source } or null (not on the list).
 * An email in `admins` (the RFP_ADMINS app setting) always gets in, as an admin, and as an
 * RFP Manager unless the list gives it another role.
 */
export function accessFor({ users = [], admins = [], email } = {}) {
  const e = String(email ?? "").trim().toLowerCase();
  if (!EMAIL.test(e)) return null;
  const u = (users ?? []).find((x) => x.email === e);
  const fixed = (admins ?? []).includes(e);
  if (u) return { email: e, role: u.role, admin: !!u.admin || fixed, source: fixed ? "list and RFP_ADMINS" : "list" };
  if (fixed) return { email: e, role: "RFP Manager", admin: true, source: "RFP_ADMINS" };
  return null;
}

/** What changed between two lists, in words, for the host's activity log. */
export function accessChanges(before = [], after = []) {
  const old = new Map(before.map((u) => [u.email, u])), out = [];
  for (const u of after) {
    const o = old.get(u.email);
    if (!o) out.push(`added ${u.email} (${u.role}${u.admin ? ", admin" : ""})`);
    else {
      if (o.role !== u.role) out.push(`${u.email}: ${o.role} → ${u.role}`);
      if (!!o.admin !== !!u.admin) out.push(`${u.email}: ${u.admin ? "now an admin" : "no longer an admin"}`);
    }
    old.delete(u.email);
  }
  for (const email of old.keys()) out.push(`removed ${email}`);
  return out;
}

export default { ACCESS_ROLES, EMAIL, validateAccess, accessFor, accessChanges };
