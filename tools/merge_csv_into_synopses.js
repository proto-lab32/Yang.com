#!/usr/bin/env node
// Overwrite Moneyline + Method-of-Victory probabilities in synopses.json with values
// from data.csv. Drops fights not present in data.csv. Run AFTER docx_to_synopses.js
// when the CSV is newer than the docx.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const syn = JSON.parse(fs.readFileSync(path.join(ROOT, 'synopses.json'), 'utf8'));
const csvText = fs.readFileSync(path.join(ROOT, 'data.csv'), 'utf8').replace(/^﻿/, '');

function parseLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i+1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const lines = csvText.split(/\r?\n/).filter(Boolean);
let i = 0;
if (lines[i].startsWith('#')) i++;
const headers = parseLine(lines[i++]).map(h => h.replace(/^﻿/, '').trim().toLowerCase());
const col = {};
// Per-field accepted header names (first match wins).
const HEADERS = {
  fid:    ['fightid', 'fid', 'fight id', 'fight_id'],
  cat:    ['market', 'cat', 'category'],
  prop:   ['selection', 'prop'],
  prob:   ['yang probability', 'prob', 'model_prob', 'model prob', 'yang prob'],
  market: ['market probability', 'market_prob', 'market prob']
};
for (const field of Object.keys(HEADERS)) {
  for (const name of HEADERS[field]) {
    const j = headers.indexOf(name);
    if (j >= 0) { col[field] = j; break; }
  }
}
const stripPct = v => v == null ? null : parseFloat(String(v).replace(/%/g, '').trim());

const rows = [];
for (; i < lines.length; i++) {
  const c = parseLine(lines[i]);
  rows.push({
    fid: c[col.fid] || '',
    cat: c[col.cat] || '',
    prop: c[col.prop] || '',
    prob: stripPct(c[col.prob]),
    market: stripPct(c[col.market])
  });
}

// Group by fid, derive fighters from Moneyline rows
const byFid = {};
for (const r of rows) {
  if (!byFid[r.fid]) byFid[r.fid] = { fighters: [], all: [] };
  byFid[r.fid].all.push(r);
  if (r.cat === 'Moneyline' && r.prop) {
    const f = byFid[r.fid].fighters;
    if (f.length < 2 && !f.includes(r.prop)) f.push(r.prop);
  }
}

function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim(); }
function lastName(s) { const p = norm(s).split(/\s+/); return p[p.length - 1] || ''; }

// Build a map: normalized "f1+f2" sorted -> csvData
const csvByKey = {};
for (const fid of Object.keys(byFid)) {
  const data = byFid[fid];
  if (data.fighters.length < 2) continue;
  const key = [norm(data.fighters[0]), norm(data.fighters[1])].sort().join('|');
  csvByKey[key] = data;
}

const kept = [];
const dropped = [];
for (const fight of syn.fights) {
  const key = [norm(fight.f1), norm(fight.f2)].sort().join('|');
  let match = csvByKey[key];
  if (!match) {
    // Try matching by last names
    const keyShort = [lastName(fight.f1), lastName(fight.f2)].sort().join('|');
    for (const k of Object.keys(csvByKey)) {
      const parts = k.split('|');
      const altShort = parts.map(p => p.split(' ').pop()).sort().join('|');
      if (altShort === keyShort) { match = csvByKey[k]; break; }
    }
  }
  if (!match) { dropped.push(fight.f1 + ' vs ' + fight.f2); continue; }

  // Overwrite Moneyline modelProb
  const csvF1 = match.fighters[0], csvF2 = match.fighters[1];
  // We need to align CSV f1/f2 to synopses f1/f2 (by name)
  const synF1Norm = norm(fight.f1);
  const csvF1Norm = norm(csvF1);
  const swap = synF1Norm !== csvF1Norm && lastName(fight.f1) !== lastName(csvF1);
  const fighterF1 = swap ? csvF2 : csvF1;
  const fighterF2 = swap ? csvF1 : csvF2;

  const ml = match.all.filter(r => r.cat === 'Moneyline');
  const mlF1 = ml.find(r => r.prop === fighterF1);
  const mlF2 = ml.find(r => r.prop === fighterF2);
  if (fight.sections.modelProjections && mlF1 && mlF2) {
    fight.sections.modelProjections.modelProb = { f1: mlF1.prob, f2: mlF2.prob };
  }

  // Overwrite Method of Victory
  const methods = match.all.filter(r => r.cat === 'Method of Victory');
  const findMethod = (fighterName, suffix) => {
    const exact = new RegExp(`^${fighterName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s+by\\s+${suffix}$`, 'i');
    return methods.find(r => exact.test(r.prop));
  };
  if (fight.sections.modelProjections && fight.sections.modelProjections.method) {
    fight.sections.modelProjections.method = fight.sections.modelProjections.method.map(m => {
      const suffix = m.name.includes('KO') || m.name.includes('TKO') ? 'KO/TKO'
                   : m.name.toLowerCase().includes('sub') ? 'Submission'
                   : m.name.toLowerCase().includes('dec') ? 'Decision'
                   : m.name;
      const r1 = findMethod(fighterF1, suffix);
      const r2 = findMethod(fighterF2, suffix);
      return {
        name: m.name,
        f1: r1 ? r1.prob : m.f1,
        f2: r2 ? r2.prob : m.f2
      };
    });
    // Recalculate decisionPct from method totals
    const dec = fight.sections.modelProjections.method.find(m => /dec/i.test(m.name));
    if (dec) fight.sections.modelProjections.decisionPct = (dec.f1 || 0) + (dec.f2 || 0);
  }

  // Overwrite Over/Under from CSV
  const totals = match.all.filter(r => r.cat === 'Total Rounds');
  if (totals.length) {
    const ouMap = {};
    for (const t of totals) {
      const m = t.prop.match(/(Over|Under)\s+(\d+(?:\.\d+)?)/i);
      if (!m) continue;
      const dir = m[1].toLowerCase();
      const line = parseFloat(m[2]);
      if (!ouMap[line]) ouMap[line] = { line, under: null, over: null };
      ouMap[line][dir] = t.prob;
    }
    const newOU = Object.values(ouMap)
      .filter(o => o.under != null || o.over != null)
      .sort((a, b) => a.line - b.line);
    if (newOU.length) fight.sections.overUnder = newOU;
  }

  kept.push(fight.f1 + ' vs ' + fight.f2);
}

syn.fights = syn.fights.filter(f => {
  const key = [norm(f.f1), norm(f.f2)].sort().join('|');
  if (csvByKey[key]) return true;
  const keyShort = [lastName(f.f1), lastName(f.f2)].sort().join('|');
  for (const k of Object.keys(csvByKey)) {
    const parts = k.split('|');
    const altShort = parts.map(p => p.split(' ').pop()).sort().join('|');
    if (altShort === keyShort) return true;
  }
  return false;
});

fs.writeFileSync(path.join(ROOT, 'synopses.json'), JSON.stringify(syn, null, 2));
console.log(`Kept ${kept.length} fights, dropped ${dropped.length}.`);
if (dropped.length) console.log('Dropped:\n  ' + dropped.join('\n  '));
