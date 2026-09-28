/**
 * Secrets that must never be committed: tokens, keys, passwords in connection strings.
 * `npm run check` and CI run scripts/check-secrets.mjs over every file git would commit,
 * because GitHub's own secret scanning is not available on a private repository without
 * a paid plan. It reports where, never the secret itself.
 */

export const SECRET_PATTERNS = [
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Azure storage key or connection string", /AccountKey=[A-Za-z0-9+/]{60,}={0,2}/],
  ["Microsoft Entra client secret", /(?:^|[^A-Za-z0-9_~.-])[A-Za-z0-9_~.-]{3}\dQ~[A-Za-z0-9_~.-]{31,34}(?![A-Za-z0-9_~.-])/],
  ["Azure publish profile password", /userPWD="[^"]{20,}"/],
  ["Private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe live key", /\b[rs]k_live_[0-9A-Za-z]{24,}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
];

/** Files that hold secrets by their nature, whatever is in them. */
export const SECRET_FILES = /(?:^|\/)(?:\.env(?:\.[\w.-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|pfx|p12|jks|keystore|publishsettings))$/i;
const ALLOWED_FILES = /(?:^|\/)\.env\.(?:example|sample|template)$/i;

/** What in one file looks like a secret: [{ kind, line }]. */
export function findSecrets(name, text) {
  const hits = [];
  if (SECRET_FILES.test(name) && !ALLOWED_FILES.test(name)) hits.push({ kind: "a file type that holds secrets", line: 0 });
  const lines = String(text ?? "").split("\n");
  for (const [i, line] of lines.entries()) {
    for (const [kind, re] of SECRET_PATTERNS) if (re.test(line)) hits.push({ kind, line: i + 1 });
  }
  return hits;
}

export default { SECRET_PATTERNS, SECRET_FILES, findSecrets };
