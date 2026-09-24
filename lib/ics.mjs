/**
 * Deadline calendar (.ics) for open findings: closing dates, question deadlines,
 * pre-bid meetings, site visits and action-item due dates.
 *
 * A file a person downloads and imports into their own calendar. Nothing is
 * sent: no invites, no attendees, no organiser, no links to internal tools.
 */
import { isOpen } from "./ledger.mjs";

const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const day = (d) => String(d).slice(0, 10).replace(/-/g, "");
const next = (d) => { const t = new Date(`${String(d).slice(0, 10)}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
/** RFC 5545 lines are folded at 75 octets. */
const fold = (line) => { const out = []; let s = line; while (Buffer.byteLength(s) > 74) { let n = 74; while (Buffer.byteLength(s.slice(0, n)) > 74) n--; out.push(s.slice(0, n)); s = " " + s.slice(n); } out.push(s); return out.join("\r\n"); };

const LABEL = { closing: "CLOSES", questions: "Questions due", preBid: "Pre-bid meeting", siteVisit: "Site visit", award: "Expected award" };

export function buildCalendar(ledger, tenant, { includeActions = true } = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const events = [];
  const add = (uid, date, summary, description, url) => {
    if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return;
    events.push(["BEGIN:VEVENT", `UID:${uid}@ionic-rfp-sweeper`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(date)}`, `DTEND;VALUE=DATE:${day(next(date))}`, `SUMMARY:${esc(summary)}`, `DESCRIPTION:${esc(description)}`, ...(url ? [`URL:${url}`] : []), "TRANSP:TRANSPARENT", "END:VEVENT"]);
  };
  for (const f of ledger.findings.filter(isOpen)) {
    const dates = { ...(f.keyDates ?? {}), ...(f.closeDate ? { closing: f.closeDate } : {}) };
    for (const [k, d] of Object.entries(dates)) add(`${f.id}-${k}`, d, `${LABEL[k] ?? k}: ${f.title.slice(0, 90)}`, `${f.buyer ?? ""}\nScore ${f.score} (${f.band}) · ${f.status}${f.assignee ? ` · ${f.assignee}` : ""}\n${f.id}`, f.url);
    if (includeActions) for (const a of (f.actions ?? []).filter((x) => !x.done)) add(`${f.id}-${a.id}`, a.due, `☐ ${a.title.slice(0, 70)}${a.assignee ? ` (${a.assignee})` : ""}`, `${f.title}\n${f.id}`, null);
  }
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ionic-rfp-sweeper//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${esc(`RFP deadlines — ${tenant.name}`)}`, ...events.flat(), "END:VCALENDAR"].map(fold).join("\r\n") + "\r\n";
}

export default { buildCalendar };
