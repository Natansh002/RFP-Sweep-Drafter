/**
 * Private host roles (Azure Static Web Apps "rolesSource").
 *
 * After someone signs in with Microsoft, Static Web Apps posts who they are here;
 * the answer is the roles they get. Only emails on the access list (the RFP_ACCESS
 * app setting, applied with `npm run access:apply`) get rfp_user, which every page
 * requires. Everyone else gets no role and sees no-access.html.
 *
 * rolesFor() is a copy of lib/access.mjs rolesFor(); scripts/test-access.mjs keeps them in step.
 */
const roleSlug = (role) => String(role).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function rolesFor(users, email) {
  const u = (users || []).find((x) => x.email === String(email || "").trim().toLowerCase());
  if (!u) return [];
  return ["rfp_user", `rfp_${roleSlug(u.role).replace(/-/g, "_")}`].concat(u.admin ? ["rfp_admin"] : []);
}

function accessList() {
  try { const list = JSON.parse(process.env.RFP_ACCESS || "[]"); return Array.isArray(list) ? list : []; } catch { return []; }
}

module.exports = async function (context, req) {
  const b = (req && req.body) || {};
  const claims = Array.isArray(b.claims) ? b.claims : [];
  const claim = (t) => (claims.find((c) => c.typ === t) || {}).val;
  // Only the company's Microsoft sign-in counts; other providers are switched off in the route rules.
  let email = b.identityProvider === "aad" ? (b.userDetails || claim("preferred_username") || claim("email") || claim("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress") || "") : "";
  // Called through the site by a signed-in person: they may only ask about themselves.
  const principal = req && req.headers && req.headers["x-ms-client-principal"];
  if (principal) {
    try { const p = JSON.parse(Buffer.from(principal, "base64").toString("utf8")); if (String(p.userDetails || "").toLowerCase() !== String(email).toLowerCase()) email = ""; } catch { email = ""; }
  }
  context.res = { headers: { "content-type": "application/json", "cache-control": "no-store" }, body: { roles: rolesFor(accessList(), email) } };
};

module.exports.rolesFor = rolesFor;
