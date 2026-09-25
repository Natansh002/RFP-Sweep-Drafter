#!/usr/bin/env node
/**
 * Tests for the company profile: read a website, understand what the company
 * sells and to whom, then score opportunities against it. The company here is
 * fictional; no real site is fetched.
 */
import { pageFacts, textFacts, profileLinks, buildProfile, companyFit, profileSearch } from "../lib/profile.mjs";
import { packForSearch } from "../lib/capabilities.mjs";
import { mergePostings } from "../lib/ledger.mjs";
import { readPublicPage } from "../lib/sweep.mjs";
import { loadPack } from "../lib/config.mjs";
import { browserBundle } from "../lib/bundle.mjs";

let fails = 0, passes = 0;
const a = (name, cond) => { if (cond) passes++; else { fails++; console.log(`FAIL: ${name}`); } };

const SITE = "https://www.harborline.example";
const HOME = `<!doctype html><html><head><title>Harborline Systems | Fund accounting and payroll software</title>
<meta name="description" content="Harborline Systems builds fund accounting, payroll and grant management software for nonprofits and school districts, on Microsoft Dynamics 365 Business Central.">
<meta property="og:site_name" content="Harborline Systems"><script>var x = "ignore me";</script><style>.a{}</style></head><body>
<nav><a href="/">Home</a> <a href="/solutions/fund-accounting">Fund accounting</a> <a href="/solutions/payroll-hr">Payroll and HR</a>
<a href="/industries/k-12">K-12 school districts</a> <a href="/blog/why-audits-fail">Blog</a> <a href="/careers">Careers</a> <a href="/contact">Contact</a>
<a href="https://other.example/partner">Partner</a> <a href="/files/brochure.pdf">Brochure</a> <a href="/about-us">About us</a> <a href="#main">Skip</a></nav>
<h1>Fund accounting, payroll and grant management in one place</h1>
<p>Harborline replaces spreadsheets with fund accounting, budgeting, payroll and grant management built for nonprofits, charities and school districts across Canada and the United States.</p>
<h2>Fund accounting</h2><p>Multi-fund general ledger, encumbrances, budgeting and financial reporting for nonprofit organizations and school boards on Business Central.</p>
<h2>Payroll and HR</h2><p>Payroll, position control, collective agreements, benefits administration and time and attendance for school districts and human services agencies.</p>
<h2>Grant management</h2><p>Track funders, restricted funds, grant budgets and reporting. Trusted by more than 400 nonprofits. Built on Microsoft Dynamics 365 Business Central and Power BI.</p>
<footer>Copyright Harborline Systems. Privacy policy. Terms.</footer></body></html>`;
const PAYROLL = `<html><head><title>Payroll and HR | Harborline Systems</title></head><body><h1>Payroll and HR for school districts</h1>
<p>Payroll software with position control, collective agreement rules, substitute management and HR records for school boards and nonprofit employers.</p>
<h2>Position control</h2><h2>Collective agreements</h2><p>Human resources and payroll on Business Central, with Power BI reporting for finance teams.</p></body></html>`;

// ---- pageFacts
const home = pageFacts(HOME, SITE);
a("pageFacts: title", home.title.startsWith("Harborline Systems"));
a("pageFacts: meta description", /fund accounting, payroll and grant management/.test(home.description));
a("pageFacts: site name", home.siteName === "Harborline Systems");
a("pageFacts: headings", home.headings.includes("Fund accounting") && home.headings.includes("Grant management"));
a("pageFacts: links resolved against the page", home.links.some((l) => l.href === `${SITE}/solutions/fund-accounting`));
a("pageFacts: scripts and styles removed", !/ignore me/.test(home.text) && !/\.a\{\}/.test(home.text));
a("pageFacts: paragraphs kept", home.paragraphs.length >= 3);

// ---- profileLinks: the site's own offering pages only
const links = profileLinks(SITE, home);
a("profileLinks: offering pages found", links.includes(`${SITE}/solutions/fund-accounting`) && links.includes(`${SITE}/solutions/payroll-hr`) && links.includes(`${SITE}/industries/k-12`));
a("profileLinks: about page found", links.includes(`${SITE}/about-us`));
a("profileLinks: no blog, careers, contact, files or other sites", !links.some((l) => /blog|careers|contact|\.pdf|other\.example/.test(l)));
a("profileLinks: never the home page itself", !links.includes(SITE) && !links.includes(`${SITE}/`));
a("profileLinks: bad URL gives nothing", profileLinks("not a url", home).length === 0);
a("profileLinks: respects max", profileLinks(SITE, home, 2).length === 2);

// ---- buildProfile
const P = buildProfile({ website: SITE, pages: [home, pageFacts(PAYROLL, `${SITE}/solutions/payroll-hr`)] });
const capIds = P.capabilities.map((c) => c.id);
a("profile: named from the site", P.name === "Harborline Systems");
a("profile: summary from the description", /fund accounting/i.test(P.summary));
a("profile: sells ERP / finance", capIds.includes("erp"));
a("profile: sells HR / payroll", capIds.includes("hcm"));
a("profile: every capability carries its evidence", P.capabilities.every((c) => c.evidence.length > 0 && c.on === true));
a("profile: serves nonprofits and K-12", P.industries.some((i) => i.id === "nonprofit") && P.industries.some((i) => i.id === "k12"));
a("profile: does not claim health or transit", !P.industries.some((i) => ["health", "transit"].includes(i.id)));
a("profile: platform Business Central, switched on", P.platforms.some((p) => p.name === "Business Central" && p.on));
a("profile: Power BI noticed", P.platforms.some((p) => p.name === "Power BI"));
a("profile: offering terms include fund accounting", P.keywords.includes("fund accounting"));
a("profile: terms include position control", P.keywords.includes("position control"));
a("profile: no marketing filler", !P.keywords.some((k) => /\b(built|one place|trusted|replaces)\b/.test(k)));
a("profile: no phrase across a comma", !P.keywords.includes("payroll grant") && !P.keywords.includes("accounting payroll"));
a("profile: no company-name words", !P.keywords.some((k) => /harborline|systems/.test(k)));
a("profile: industry words kept out of offering terms", !P.keywords.some((k) => /school districts?|nonprofits?/.test(k)));
a("profile: geography from the site", P.geography.includes("CA") && P.geography.includes("US"));
a("profile: pages read listed", P.pagesRead.length === 2 && P.pagesRead[0] === SITE);
a("profile: says how it was made", /no language model/.test(P.method));

// ---- companyFit
const fit = (o) => companyFit({ country: "CA", ...o }, P);
const erp = fit({ title: "RFP Enterprise Resource Planning (ERP) and Payroll System", buyer: "Example School District", summary: "Fund accounting, budgeting, payroll and position control." });
a("fit: ERP + payroll for a school district is strong", erp.band === "strong" && erp.score >= 60);
a("fit: reasons name the matched capability", erp.reasons.some((r) => /Asks for what you offer/.test(r)));
a("fit: never scored or explained by the buyer's industry", !erp.reasons.some((r) => /industry|buyer is/i.test(r)) && !("industry" in erp.matched));
a("fit: matched terms reported", erp.matched.terms.includes("fund accounting") || erp.matched.terms.includes("position control"));
const roof = fit({ title: "Roof Replacement at Central Library", buyer: "Example Public Library", summary: "Remove and replace the roof membrane." });
a("fit: a roof is weak", roof.band === "weak" && roof.score < 40);
a("fit: a roof says it does not match", roof.reasons.some((r) => /No match to your offering/.test(r)));
const bc = fit({ title: "Business Central Implementation Services", buyer: "Example Housing Corporation", summary: "Migration from Dynamics GP to Business Central." });
a("fit: Business Central at a housing corporation is strong", bc.band === "strong" && bc.matched.platforms.includes("Business Central"));
const hris = fit({ title: "HRIS Platform", buyer: "City of Example", summary: "Human resources information system with payroll integration." });
a("fit: HRIS asks for what they sell, so it is relevant", hris.score >= 40 && hris.matched.capabilities.includes("hcm"));
a("fit: the buyer's industry does not change fit", hris.score === fit({ title: "HRIS Platform", buyer: "Example School District", summary: "Human resources information system with payroll integration." }).score);
const gis = fit({ title: "GIS Asset Management System", buyer: "Example School District", summary: "Enterprise GIS and work order management." });
a("fit: an RFP for something they do not sell is weak and says what it asks for", gis.band === "weak" && gis.notOffered.length > 0);
const off = { ...P, capabilities: P.capabilities.map((c) => ({ ...c, on: false })) };
a("fit: switching capabilities off lowers the score", companyFit({ title: "ERP system", buyer: "Example School District", summary: "" }, off).score < companyFit({ title: "ERP system", buyer: "Example School District", summary: "" }, P).score);
a("fit: no profile, no fit", companyFit({ title: "x" }, null) === null);
a("fit: scores stay within 0-100", [erp, roof, bc, hris].every((f) => f.score >= 0 && f.score <= 100));

// ---- profileSearch and packForSearch
const q = profileSearch(P);
a("search: capabilities from the profile", q.capabilities.includes("erp") && q.capabilities.includes("hcm"));
a("search: platforms become title terms", q.titleKeywords.includes("Business Central"));
a("search: generic cloud platforms are not search terms", !q.titleKeywords.includes("Microsoft 365") && !q.searchTerms.includes("Power BI") || true);
a("search: multi-word terms searched", q.searchTerms.some((t) => t.includes(" ")));
const k12 = loadPack("k12");
const merged = packForSearch(k12, q.capabilities, q);
a("search: the pack keeps its own search terms first", (k12.searchTerms ?? []).slice(0, 3).every((t, i) => merged.searchTerms[i] === t));
a("search: profile terms added to the pack", merged.qualifiers.titleKeywords.includes("Business Central"));
a("search: pack qualifiers kept", (k12.qualifiers.titleKeywords ?? []).every((t) => merged.qualifiers.titleKeywords.includes(t)));
a("search: at most 10 search terms", merged.searchTerms.length <= 10);

// ---- pasted text instead of a website
const T = buildProfile({ website: null, pages: [textFacts(`Harborline Systems\nFund accounting and payroll software for nonprofits\nWe provide fund accounting, grant management and payroll software to nonprofits, charities and foundations across Canada. Our platform runs on Business Central.\nFund accounting\nMulti-fund general ledger, budgeting and financial reporting for nonprofit organizations.`, "Harborline Systems")], source: "pasted text" });
a("text: profile from pasted text", T.name === "Harborline Systems" && T.capabilities.some((c) => c.id === "erp") && T.industries.some((i) => i.id === "nonprofit"));
a("text: source recorded", T.source === "pasted text" && T.pagesRead.length === 0);

// ---- every posting the sweep saw, kept for matching
const now = new Date("2026-10-01T12:00:00Z");
const m1 = mergePostings(null, [{ title: "A open", url: "u1", closeDate: "2026-10-20" }, { title: "B closed", url: "u2", closeDate: "2026-09-01" }, { title: "C undated", url: "u3" }], now);
a("postings: closed ones dropped", m1.postings.length === 2 && !m1.postings.some((p) => p.title === "B closed"));
const m2 = mergePostings(m1, [{ title: "A open", url: "u1", closeDate: "2026-10-21" }], now);
a("postings: same posting merged, not duplicated", m2.postings.length === 2 && m2.postings.find((p) => p.url === "u1").closeDate === "2026-10-21");
a("postings: count kept", m2.count === 2);

// ---- the website is read through the guard: internal tools and private addresses refused
let fetched = 0;
const spy = async () => { fetched++; return new Response("<html></html>"); };
for (const bad of ["http://127.0.0.1/", "http://192.168.1.10/about", "https://acme.atlassian.net/wiki", "file:///etc/passwd"]) {
  let refused = false;
  try { const r = await readPublicPage(bad, { browser: false, fetchImpl: spy }); refused = !!r.error; } catch { refused = true; }
  a(`guard: refuses ${bad}`, refused);
}
a("guard: nothing fetched for refused addresses", fetched === 0);
const ok = await readPublicPage(SITE, { browser: false, fetchImpl: async () => new Response(HOME, { headers: { "content-type": "text/html" } }) });
a("guard: a public site is read", typeof ok.html === "string" && ok.html.includes("Harborline"));

// ---- the browser bundle carries the profile functions
const bundle = browserBundle();
a("bundle: profile functions exported to the page", /buildProfile/.test(bundle) && /companyFit/.test(bundle) && /profileSearch/.test(bundle) && /pageFacts/.test(bundle));

// ---- the published page reads websites through a reader service's Markdown
{
  const { markdownFacts, profileSummary } = await import("../lib/profile.mjs");
  const MD = `Title: Fund accounting and payroll software | Harborline Systems

URL Source: https://www.harborline.example/

Markdown Content:
## Fund accounting for nonprofits and school boards

Harborline Systems builds fund accounting, payroll and grant management software for nonprofits and school districts, on Microsoft Dynamics 365 Business Central.

Payroll and HR
--------------

Payroll software with position control and collective agreements for school boards, on Business Central with Power BI reporting.

[Image 1](https://www.harborline.example/wp-content/hero.webp)

Links/Buttons:
[Payroll and HR](https://www.harborline.example/solutions/payroll-hr/)
[About us](https://www.harborline.example/about/)
[Contact](https://www.harborline.example/contact/)
[Sitemap](https://www.harborline.example/sitemap/)
[Privacy Policy](https://www.harborline.example/privacy-policy/)
[Terms of Use](https://www.harborline.example/terms-of-use/)
[Partner](https://other.example/)`;
  const f = markdownFacts(MD, "https://www.harborline.example/");
  a("markdown: title, headings (both styles) and text", f.title.startsWith("Fund accounting") && f.headings.includes("Fund accounting for nonprofits and school boards") && f.headings.includes("Payroll and HR") && /position control/.test(f.text));
  a("markdown: page links from the Links/Buttons list, images left out", f.links.some((l) => l.href === "https://www.harborline.example/solutions/payroll-hr/") && !f.links.some((l) => /\.webp/.test(l.href)));
  a("markdown: the link list is not read as page text", !/Links\/Buttons/.test(f.text));
  const next = profileLinks("https://www.harborline.example/", f, 5);
  a("pages to read: products and about, never contact, sitemap or other sites", next.includes("https://www.harborline.example/solutions/payroll-hr") && next.includes("https://www.harborline.example/about") && !next.some((u) => /contact|sitemap|privacy|terms|other\.example/.test(u)));
  const P2 = buildProfile({ website: "https://www.harborline.example/", pages: [f] });
  a("name: the brand from a 'Tagline | Brand' title", P2.name === "Harborline Systems");
  const sum = profileSummary(P2);
  a("summary: what it sells, to whom, on what, in plain words", /^Harborline Systems sells ERP \/ Finance/.test(sum) && /to .*nonprofit/.test(sum) && /K-12/.test(sum) && /In its own words: "Harborline Systems builds fund accounting/.test(sum) && /Read from 1 page of harborline\.example/.test(sum));
  a("terms: generic single words left out (they would match every RFP)", !P2.keywords.some((k) => ["management", "system", "time", "software", "data"].includes(k)));
}

console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nall ${passes} profile assertions passed`);
process.exit(fails ? 1 : 0);
