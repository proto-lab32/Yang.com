#!/usr/bin/env node
// Convert "UFC <Event> Synopses.docx" → synopses.json for the analyses page.
// Usage: node tools/docx_to_synopses.js <path-to-docx>
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const docxPath = process.argv[2];
if (!docxPath) {
  console.error('Usage: node docx_to_synopses.js <path-to-docx>');
  process.exit(1);
}

const tmpDir = path.join(require('os').tmpdir(), 'docx_synopses_' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
execSync(`cd "${tmpDir}" && unzip -q "${docxPath}"`, { shell: true });

const xml = fs.readFileSync(path.join(tmpDir, 'word/document.xml'), 'utf8');
const paragraphs = (xml.match(/<w:p[^>]*>[\s\S]*?<\/w:p>/g) || []).map(p => {
  const texts = (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, ''));
  return texts.join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
});

let i = 0;
const peek = (n = 0) => paragraphs[i + n] || '';
const consume = () => paragraphs[i++];
const skipBlanks = () => { while (i < paragraphs.length && paragraphs[i].trim() === '') i++; };

const event = { title: '', generated: '', model: '', cardList: [], fights: [] };

while (i < paragraphs.length && peek() !== 'CARD') {
  const line = consume();
  if (/^FIGHT CARD SYNOPSES$/i.test(line)) event.title = line;
  else if (/^Generated /i.test(line)) {
    event.generated = line;
    const m = line.match(/Model (v[\d.]+[^•]*)/);
    if (m) event.model = m[1].trim();
  }
}

if (peek() === 'CARD') consume();
if (/^Click any matchup/i.test(peek())) consume();

while (i < paragraphs.length) {
  const line = peek();
  const m = line.match(/^(.+?)\s+vs\s+(.+?)\s+—\s+(\d+R),\s+([^()\[]+?)(?:\s+\[([^\]]+)\])?\s+\((.+?)\s+(\d+(?:\.\d+)?)%\s*\/\s*(.+?)\s+(\d+(?:\.\d+)?)%\)\s*$/i);
  if (m) {
    event.cardList.push({
      f1: m[1].trim(), f2: m[2].trim(),
      rounds: parseInt(m[3], 10), division: m[4].trim(),
      dataMode: m[5] || null,
      f1Short: m[6], f1Pct: parseFloat(m[7]),
      f2Short: m[8], f2Pct: parseFloat(m[9])
    });
    consume();
  } else if (line.trim() === '') consume();
  else break;
}

const SECTION_HEADERS = new Set(['MODEL PROJECTIONS', 'OVER/UNDER (TOTAL ROUNDS)', 'COMPOSITES (Z-SCORES VS WEIGHT CLASS)', 'STYLE PROFILES', 'MODIFIERS & TRUST', 'MATCHUP EDGES', 'FIGHTER PROFILES (UFC + DWCS/RTUF ONLY)', 'MATCHUP ANALYSIS', 'SYNOPSIS']);
const isFightHeader = (s) => / {2}vs {2}/.test(s);
const isSection = (s) => SECTION_HEADERS.has(s);
const isBoundary = (s) => isFightHeader(s) || isSection(s);

// Heuristic: "value-looking" line is a number, signed number, percent, "Δ ..." line, or a short
// stat-style string like "Allen 1943 (14 fts) / Costa 1970 (9 fts)".
function looksLikeValue(s) {
  if (!s) return false;
  const t = s.trim();
  if (/^[+-]?\d+(?:\.\d+)?%?$/.test(t)) return true;
  if (/^Δ\s/.test(t)) return true;
  if (/^[\d.]+%/.test(t)) return true;
  if (/^[+-]\d/.test(t)) return true;
  // "Allen 1943 (14 fts) / Costa 1970 (9 fts)" type
  if (/\(\d+\s+fts?\)/.test(t)) return true;
  // "1.000 (192.1 min)" type
  if (/^[\d.]+\s*\([\d.]+\s+min\)$/.test(t)) return true;
  return false;
}

while (i < paragraphs.length) {
  while (i < paragraphs.length && !isFightHeader(peek())) consume();
  if (i >= paragraphs.length) break;
  const header = consume();
  const [f1, f2] = header.split(/ {2}vs {2}/).map(s => s.trim());
  const sub = consume();
  const subM = sub.match(/^(\d+)\s+rounds\s+•\s+(.+?)(?:\s+\((.+?)\s+data mode\))?$/i);
  const fight = {
    f1, f2,
    rounds: subM ? parseInt(subM[1], 10) : null,
    division: subM ? subM[2].trim() : null,
    dataMode: subM ? (subM[3] || null) : null,
    sections: {}
  };

  while (i < paragraphs.length && !isFightHeader(peek())) {
    const cur = peek();
    if (cur === 'MODEL PROJECTIONS') {
      consume();
      const probLine = consume();
      const pm = probLine.match(/^(.+?):\s+([\d.]+)%\s+\|\s+(.+?):\s+([\d.]+)%/);
      const f1Short = pm ? pm[1] : f1.split(' ').pop();
      const f2Short = pm ? pm[3] : f2.split(' ').pop();
      const modelProb = pm ? { f1: parseFloat(pm[2]), f2: parseFloat(pm[4]) } : null;
      skipBlanks();
      consume(); consume(); // f1 / f2 column headers
      const method = [];
      for (let k = 0; k < 3 && i < paragraphs.length; k++) {
        if (isBoundary(peek())) break;
        if (peek().trim() === '') { consume(); k--; continue; }
        const name = consume();
        if (isBoundary(peek())) break;
        const v1 = consume();
        if (isBoundary(peek())) break;
        const v2 = consume();
        method.push({ name, f1: parseFloat(v1), f2: parseFloat(v2) });
      }
      const dec = consume();
      const decM = dec.match(/Goes to decision:\s*([\d.]+)%/);
      const decisionPct = decM ? parseFloat(decM[1]) : null;
      const roundsFinish = [];
      const rfRe = /R(\d+)\s+([\d.]+)%/g;
      let rm;
      while ((rm = rfRe.exec(dec)) !== null) {
        roundsFinish.push({ r: parseInt(rm[1], 10), pct: parseFloat(rm[2]) });
      }
      fight.sections.modelProjections = { f1Short, f2Short, modelProb, method, decisionPct, roundsFinish };
    } else if (cur === 'OVER/UNDER (TOTAL ROUNDS)') {
      consume();
      skipBlanks();
      consume(); consume(); consume();
      const overUnder = [];
      while (i < paragraphs.length && /^\d+(?:\.\d+)?$/.test(peek())) {
        const line = parseFloat(consume());
        const under = parseFloat(consume());
        const over = parseFloat(consume());
        overUnder.push({ line, under, over });
      }
      fight.sections.overUnder = overUnder;
    } else if (cur === 'COMPOSITES (Z-SCORES VS WEIGHT CLASS)') {
      consume();
      skipBlanks();
      const note = consume();
      skipBlanks();
      consume(); consume(); consume(); consume();
      const composites = [];
      while (i < paragraphs.length && !isBoundary(peek()) && peek().trim() !== '') {
        const name = consume();
        if (isBoundary(peek())) break;
        const f1v = consume();
        if (isBoundary(peek())) break;
        const f2v = consume();
        if (isBoundary(peek())) break;
        const dv = consume();
        composites.push({ name, f1: parseFloat(f1v), f2: parseFloat(f2v), delta: parseFloat(dv) });
      }
      fight.sections.composites = { note, rows: composites };
    } else if (cur === 'STYLE PROFILES') {
      consume();
      skipBlanks();
      consume(); consume(); consume();
      const styles = [];
      while (i < paragraphs.length && !isBoundary(peek()) && peek().trim() !== '') {
        const name = consume();
        if (isBoundary(peek())) break;
        const f1v = consume();
        if (isBoundary(peek())) break;
        const f2v = consume();
        styles.push({ name, f1: parseFloat(f1v), f2: parseFloat(f2v) });
      }
      fight.sections.styleProfiles = styles;
    } else if (cur === 'MODIFIERS & TRUST') {
      consume();
      while (i < paragraphs.length && peek().trim() === '') consume(); // skip blanks
      consume(); consume(); // F1, F2 column headers
      const modifiers = [];
      while (i < paragraphs.length && !isBoundary(peek()) && peek().trim() !== '') {
        const name = consume();
        if (isBoundary(peek())) break;
        const f1v = consume();
        if (isBoundary(peek())) break;
        const f2v = consume();
        modifiers.push({ name, f1: f1v, f2: f2v });
      }
      fight.sections.modifiers = modifiers;
    } else if (cur === 'MATCHUP EDGES') {
      consume();
      skipBlanks();
      consume(); consume(); consume(); // Edge / Value / Reads as headers
      // Known edge-name patterns. Anything that doesn't match is a value or reads-as cell.
      const isEdgeName = (s) => /^(Decision edge|KO threat|Sub threat|Ground % of fight|Standing % of fight|Elo \(WC-specific\)|GBM P\(.+? wins\))/.test(s);
      const cells = [];
      while (i < paragraphs.length && !isBoundary(peek())) {
        if (peek().trim() === '') { consume(); continue; } // tolerate blanks within edges
        cells.push(consume());
      }
      const edges = [];
      let cur2 = null;
      for (const c of cells) {
        if (isEdgeName(c)) {
          if (cur2) edges.push(cur2);
          cur2 = { name: c, value: '', reads: '' };
        } else if (cur2) {
          if (!cur2.value) cur2.value = c;
          else cur2.reads = cur2.reads ? cur2.reads + ' ' + c : c;
        }
      }
      if (cur2) edges.push(cur2);
      fight.sections.matchupEdges = edges;
    } else if (cur === 'FIGHTER PROFILES (UFC + DWCS/RTUF ONLY)') {
      consume();
      skipBlanks();
      const profiles = [];
      // Two profiles: each begins with a fighter name (matches f1 or f2), followed by lines until empty / boundary / other-name.
      const namesNorm = [f1, f2].map(n => n.toLowerCase());
      while (i < paragraphs.length && !isBoundary(peek()) && profiles.length < 2) {
        if (peek().trim() === '') { consume(); continue; }
        const name = consume();
        const lines = [];
        while (i < paragraphs.length && !isBoundary(peek())) {
          const nxt = peek().trim();
          if (nxt === '') break;
          if (namesNorm.includes(nxt.toLowerCase()) && nxt.toLowerCase() !== name.toLowerCase()) break;
          lines.push(consume());
        }
        profiles.push({ name, lines });
      }
      fight.sections.profiles = profiles;
    } else if (cur === 'MATCHUP ANALYSIS') {
      consume();
      const paras = [];
      while (i < paragraphs.length && !isBoundary(peek())) {
        const t = consume().trim();
        if (t) paras.push(t);
      }
      fight.sections.matchupAnalysis = paras;
    } else if (cur === 'SYNOPSIS') {
      consume();
      const paras = [];
      while (i < paragraphs.length && !isBoundary(peek())) {
        const t = consume().trim();
        if (t) paras.push(t);
      }
      // First paragraph starts with "Lean: <Name>." — parse it out for prominence.
      const body = paras.join(' ');
      const leanMatch = body.match(/^Lean:\s+([^.]+)\.\s*/);
      fight.sections.synopsis = {
        lean: leanMatch ? leanMatch[1].trim() : null,
        body: leanMatch ? body.slice(leanMatch[0].length).trim() : body
      };
    } else {
      consume();
    }
  }

  event.fights.push(fight);
}

const outPath = path.join(__dirname, '..', 'synopses.json');
fs.writeFileSync(outPath, JSON.stringify(event, null, 2));
console.log(`Wrote ${event.fights.length} fights to ${outPath}`);
fs.rmSync(tmpDir, { recursive: true, force: true });
