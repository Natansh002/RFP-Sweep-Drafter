#!/usr/bin/env node
/**
 * Regression tests for the scorer.
 *
 * Two of these exist because the first run of this file found real defects: a
 * solicitation that had already closed, and one outside the tenant's geography,
 * both scored high enough to file. That is what produced the VETO rule in
 * score.mjs. Keep them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { score } from '../lib/score.mjs';
import { effectivePack } from '../lib/pack.mjs';
const rawPack = id => JSON.parse(fs.readFileSync(path.join(ROOT,'industries',`${id}.json`),'utf8'));
const tenant = id => JSON.parse(fs.readFileSync(path.join(ROOT,'scripts','fixtures','tenants',`${id}.json`),'utf8'));
// Packs are scored as the tenant sees them: pack + the tenant's offering for it.
const TENANT_FOR = { k12: 'demo-edu', nonprofit: 'demo-edu', 'logistics-lastmile-tms': 'demo-logistics' };
const pack = id => effectivePack(rawPack(id), tenant(TENANT_FOR[id]));
const soon = n => new Date(Date.now()+n*86400000).toISOString().slice(0,10);

const cases = [
  ['k12 / real ERP bid', 'k12','demo-edu', {
    title:'Request for Proposal - Enterprise Resource Planning and Payroll System',
    summary:'The Board seeks a financial management system with position control and collective agreement support.',
    buyer:'Example School Board', buyerType:'school board', country:'CA',
    closeDate: soon(34), estimatedValue: 900000 }],
  ['k12 / bus routing (must drop)', 'k12','demo-edu', {
    title:'RFP - Student Transportation Bus Routing Services',
    summary:'Bussing contract for the 2027 school year.',
    buyer:'A School Division', buyerType:'school board', country:'CA', closeDate: soon(40) }],
  ['k12 / sparse posting', 'k12','demo-edu', {
    title:'RFP 2026-14 Financial Management System', summary:'', buyer:null, country:null, closeDate:null }],
  ['k12 / already closed', 'k12','demo-edu', {
    title:'ERP and HRIS Replacement', buyer:'District 99', buyerType:'school district',
    country:'CA', closeDate: soon(-5), estimatedValue: 500000 }],
  ['nonprofit / fund accounting', 'nonprofit','demo-edu', {
    title:'RFP for Enterprise Resource Planning - Fund Accounting and Payroll',
    summary:'Restricted funds, grant reporting, employee self service, union collective agreement.',
    buyer:'A Community Health Centre', buyerType:'community health centre', country:'CA',
    closeDate: soon(28), estimatedValue: 400000 }],
  ['lastmile / medical courier TMS', 'logistics-lastmile-tms','demo-logistics', {
    title:'RFP - Medical Courier Services and Delivery Management Software',
    summary:'Chain of custody, temperature controlled specimen transport, proof of delivery, driver mobile application, HIPAA.',
    buyer:'Regional Health Network', buyerType:'health authority', country:'US',
    closeDate: soon(30), estimatedValue: 2500000, incumbent:'Incumbent Courier Co' }],
  ['lastmile / long haul freight (must drop)', 'logistics-lastmile-tms','demo-logistics', {
    title:'Over the Road OTR Freight Brokerage Services',
    summary:'Long haul trucking and drayage.', buyer:'A Port', country:'US', closeDate: soon(45) }],
  ['lastmile / out of geography', 'logistics-lastmile-tms','demo-logistics', {
    title:'Last-Mile Delivery Management Software', buyer:'NHS Trust', buyerType:'hospital',
    country:'GB', closeDate: soon(30), estimatedValue: 1000000 }],
];

let fails = 0;
for (const [label, p, t, item] of cases) {
  const r = score(item, pack(p), tenant(t));
  console.log(`\n${label}\n  ${r.total}/100  band=${r.band}  unknowns=${r.unknowns ?? 0}`);
  for (const why of r.reasons) console.log('    ' + why);
  for (const f of r.flags) console.log('    FLAG ' + f);
}

// assertions
const a = (name, cond) => { if (!cond) { console.log('\nASSERT FAIL: ' + name); fails++; } };
a('bus routing drops', score(cases[1][3], pack('k12'), tenant('demo-edu')).band === 'dropped');
a('freight drops from lastmile', score(cases[6][3], pack('logistics-lastmile-tms'), tenant('demo-logistics')).band === 'dropped');
a('real ERP bid is pursue', score(cases[0][3], pack('k12'), tenant('demo-edu')).band === 'pursue');
a('closed bid is not pursue', score(cases[3][3], pack('k12'), tenant('demo-edu')).band !== 'pursue');
a('sparse posting downgraded to review', score(cases[2][3], pack('k12'), tenant('demo-edu')).band === 'review');
a('out of geography is not pursue', score(cases[7][3], pack('logistics-lastmile-tms'), tenant('demo-logistics')).band !== 'pursue');
a('portal nav link is dropped, not reviewed', score({ title:'Terms of Service', country:'CA' }, pack('k12'), tenant('demo-edu')).band === 'dropped');
a('acronym matches whole words only', score({ title:'Mississippi Purchasing Group', country:'CA' }, pack('k12'), tenant('demo-edu')).band === 'dropped');
a('acronym still matches as a word', score({ title:'RFP for a new SIS platform', country:'CA' }, pack('k12'), tenant('demo-edu')).band !== 'dropped');
console.log(fails ? `\n${fails} ASSERTION(S) FAILED` : '\nall assertions passed');
process.exit(fails ? 1 : 0);
