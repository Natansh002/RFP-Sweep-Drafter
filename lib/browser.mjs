/**
 * Browser access for portals that render their listings with JavaScript
 * (registry render "client" or "mixed"), which return an empty shell to a
 * plain fetch.
 *
 * Headless Chromium through Playwright:
 *   - a fresh, throwaway profile every run: no cookies, no logins, never the
 *     user's own browser profile
 *   - every request the page makes goes through lib/guard.mjs; a request to an
 *     internal tool or private address is aborted before it leaves
 *   - images, fonts and media are not downloaded
 *   - a CAPTCHA or bot-challenge page is reported as "blocked-by-portal" and
 *     left alone; the sweeper never tries to get past one
 *
 * Playwright is an optional dependency. Without it the channel is reported as
 * "needs-browser", exactly as before.
 */
import { blockedReason } from "./guard.mjs";

let browserPromise = null;

async function launch() {
  let pw;
  try { pw = await import("playwright"); } catch { return null; }
  const opts = { headless: true, args: ["--disable-blink-features=AutomationControlled"] };
  const channel = process.env.RFP_BROWSER_CHANNEL;
  const attempts = channel ? [{ ...opts, channel }] : [opts, { ...opts, channel: "chrome" }, { ...opts, channel: "msedge" }];
  for (const o of attempts) {
    try { return await pw.chromium.launch(o); } catch { /* try the next one */ }
  }
  return null;
}

export async function browserAvailable() {
  if (!browserPromise) browserPromise = launch();
  return !!(await browserPromise);
}

const CHALLENGE = /captcha|are you a robot|verify you are human|cf-challenge|just a moment\.\.\.|access denied|request unsuccessful|incapsula|distil/i;

/**
 * Load one page in the browser and return its rendered HTML.
 * Returns { body } or { error, status } with status "blocked-by-portal" for challenges.
 */
export async function renderPage(url, { blocked = [], timeoutMs = 45000, waitFor = null } = {}) {
  if (!browserPromise) browserPromise = launch();
  const browser = await browserPromise;
  if (!browser) return { error: "no browser available (install Playwright or Chrome)", status: "needs-browser" };
  const why = blockedReason(url, blocked);
  if (why) return { error: `Blocked: ${why}`, status: "blocked" };
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 ionic-rfp-sweeper",
    locale: "en-CA",
    javaScriptEnabled: true,
    acceptDownloads: false,
  });
  try {
    await context.route("**/*", (route) => {
      const req = route.request();
      if (blockedReason(req.url(), blocked)) return route.abort("blockedbyclient");
      if (["image", "font", "media"].includes(req.resourceType())) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (blockedReason(page.url(), blocked)) return { error: `Blocked: redirected to ${new URL(page.url()).hostname}`, status: "blocked" };
    try { await page.waitForLoadState("networkidle", { timeout: 15000 }); } catch { /* busy pages never go idle; use what rendered */ }
    if (waitFor) { try { await page.waitForSelector(waitFor, { timeout: 10000 }); } catch { /* optional */ } }
    const html = await page.content();
    const text = (await page.evaluate(() => document.body?.innerText ?? "")).slice(0, 5000);
    if (CHALLENGE.test(text) && text.length < 3000) return { error: "the portal showed a bot check; not bypassed", status: "blocked-by-portal" };
    if (res && res.status() >= 400) return { error: `HTTP ${res.status()}`, status: "fetch-failed" };
    return { body: html };
  } catch (e) {
    return { error: e.message.split("\n")[0].slice(0, 200), status: "fetch-failed" };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise;
  browserPromise = null;
  await b?.close().catch(() => {});
}

export default { browserAvailable, renderPage, closeBrowser };
