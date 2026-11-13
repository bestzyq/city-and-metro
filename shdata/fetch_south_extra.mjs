// shdata/fetch_south_extra.mjs — 获取新增南条带 (y=232..372) 的 OSM 数据
// 用法: node shdata/fetch_south_extra.mjs
'use strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';

const PROXY = 'http://127.0.0.1:7890';
const OSM_API = 'https://api.openstreetmap.org/api/0.6/map';

const PROJ = { lon0: 121.2584, lat0: 31.5100, kx: 380.6, ky: 442.3 };
const NEW_W = 172, NEW_H = 372;
const OLD_BOTTOM = 232; // 之前的南缘

function gridToLL(x, y) {
  return [PROJ.lat0 - y / PROJ.ky, PROJ.lon0 + x / PROJ.kx];
}

// 新增南条带: x=0..172, y=232..372
const [s, w] = gridToLL(0, OLD_BOTTOM);
const [n, e] = gridToLL(NEW_W, NEW_H);
console.log(`南条带: lat ${s.toFixed(4)}-${n.toFixed(4)}, lon ${w.toFixed(4)}-${e.toFixed(4)}`);

const TILE_DEG = 0.015;
const tiles = [];
for (let lat = Math.min(s, n); lat < Math.max(s, n); lat += TILE_DEG) {
  for (let lon = w; lon < e; lon += TILE_DEG) {
    tiles.push({
      s: lat.toFixed(5), n: Math.min(lat + TILE_DEG, Math.max(s, n)).toFixed(5),
      w: lon.toFixed(5), e: Math.min(lon + TILE_DEG, e).toFixed(5),
      key: `southextra_${lat.toFixed(3)}_${lon.toFixed(3)}`
    });
  }
}
console.log(`Tiles: ${tiles.length}`);

mkdirSync('shdata/tiles', { recursive: true });

const progressFile = 'shdata/progress_south_extra.json';
let progress = {};
if (existsSync(progressFile)) progress = JSON.parse(readFileSync(progressFile, 'utf8'));

function fetchTileCurl(tile, outFile) {
  const bbox = `${tile.w},${tile.s},${tile.e},${tile.n}`;
  const url = `${OSM_API}?bbox=${bbox}`;
  try {
    execFileSync('curl', ['-s', '-x', PROXY, '--max-time', '20', '-H', 'User-Agent: CityAndMetro-GeoBuilder/1.0', '-o', outFile, url], { timeout: 25000, maxBuffer: 50 * 1024 * 1024 });
    return true;
  } catch { return false; }
}

function parseOSMXML(xml) {
  const nodes = new Map(), ways = new Map(), rels = new Map();
  for (const m of xml.matchAll(/<node\s+[^>]*?id="(\d+)"[^>]*?\/>/g)) {
    const lat = parseFloat(m[0].match(/lat="([-\d.]+)"/)?.[1] || 0);
    const lon = parseFloat(m[0].match(/lon="([-\d.]+)"/)?.[1] || 0);
    nodes.set(m[1], { id: +m[1], lat, lon, tags: {} });
  }
  for (const m of xml.matchAll(/<node\s+[^>]*?id="(\d+)"[^>]*?>([\s\S]*?)<\/node>/g)) {
    const lat = parseFloat(m[0].match(/lat="([-\d.]+)"/)?.[1] || 0);
    const lon = parseFloat(m[0].match(/lon="([-\d.]+)"/)?.[1] || 0);
    const tags = {};
    for (const tm of m[2].matchAll(/<tag\s+k="([^"]+)"\s+v="([^"]*)"/g)) tags[tm[1]] = tm[2];
    nodes.set(m[1], { id: +m[1], lat, lon, tags });
  }
  for (const m of xml.matchAll(/<way\s+[^>]*?id="(\d+)"[^>]*?>([\s\S]*?)<\/way>/g)) {
    const nds = []; for (const nm of m[2].matchAll(/<nd\s+ref="(\d+)"/g)) nds.push(+nm[1]);
    const tags = {}; for (const tm of m[2].matchAll(/<tag\s+k="([^"]+)"\s+v="([^"]*)"/g)) tags[tm[1]] = tm[2];
    ways.set(m[1], { id: +m[1], nodes: nds, tags });
  }
  for (const m of xml.matchAll(/<relation\s+[^>]*?id="(\d+)"[^>]*?>([\s\S]*?)<\/relation>/g)) {
    const members = []; for (const mm of m[2].matchAll(/<member\s+type="([^"]+)"\s+ref="(\d+)"\s+role="([^"]*)"/g)) members.push({ type: mm[1], ref: +mm[2], role: mm[3] });
    const tags = {}; for (const tm of m[2].matchAll(/<tag\s+k="([^"]+)"\s+v="([^"]*)"/g)) tags[tm[1]] = tm[2];
    rels.set(m[1], { id: +m[1], members, tags });
  }
  return { nodes, ways, rels };
}

const merged = { nodes: new Map(), ways: new Map(), rels: new Map() };
let fetched = 0, skipped = 0, failed = 0;

for (let i = 0; i < tiles.length; i++) {
  const tile = tiles[i];
  const tileFile = `shdata/tiles/${tile.key}.osm`;
  if (progress[tile.key]) { skipped++; if (existsSync(tileFile)) { const xml = readFileSync(tileFile, 'utf8'); if (xml.length > 100) { const p = parseOSMXML(xml); for (const [k,v] of p.nodes) merged.nodes.set(k,v); for (const [k,v] of p.ways) merged.ways.set(k,v); for (const [k,v] of p.rels) merged.rels.set(k,v); } } continue; }
  process.stdout.write(`\r  [${i+1}/${tiles.length}] (${tile.s},${tile.w}) fetched=${fetched} skip=${skipped} fail=${failed}`);
  const ok = fetchTileCurl(tile, tileFile);
  if (ok && existsSync(tileFile)) {
    const xml = readFileSync(tileFile, 'utf8');
    if (xml.length > 100 && !xml.includes('too many nodes')) { progress[tile.key] = true; fetched++; const p = parseOSMXML(xml); for (const [k,v] of p.nodes) merged.nodes.set(k,v); for (const [k,v] of p.ways) merged.ways.set(k,v); for (const [k,v] of p.rels) merged.rels.set(k,v); }
    else { failed++; progress[tile.key] = 'failed'; }
  } else { failed++; }
  if (fetched % 20 === 0 && fetched > 0) writeFileSync(progressFile, JSON.stringify(progress));
  await new Promise(r => setTimeout(r, 300));
}
writeFileSync(progressFile, JSON.stringify(progress));
console.log(`\n\nDone: fetched=${fetched} skipped=${skipped} failed=${failed}`);
console.log(`Merged: nodes=${merged.nodes.size} ways=${merged.ways.size} relations=${merged.rels.size}`);

// 读取已有的 strips_features.json，合并新数据
let existing = { nodes: [], ways: [], relations: [] };
if (existsSync('shdata/strips_features.json')) {
  existing = JSON.parse(readFileSync('shdata/strips_features.json', 'utf8'));
  console.log(`Existing: nodes=${existing.nodes.length} ways=${existing.ways.length} relations=${existing.relations.length}`);
}
// 合并去重
const allNodes = new Map([...existing.nodes.map(n => [n.id, n]), ...merged.nodes]);
const allWays = new Map([...existing.ways.map(w => [w.id, w]), ...merged.ways]);
const allRels = new Map([...existing.relations.map(r => [r.id, r]), ...merged.rels]);
const features = { nodes: [...allNodes.values()], ways: [...allWays.values()], relations: [...allRels.values()] };
writeFileSync('shdata/strips_features.json', JSON.stringify(features));
console.log(`Written shdata/strips_features.json (${(JSON.stringify(features).length/1024/1024).toFixed(1)} MB)`);
console.log(`Total: nodes=${features.nodes.length} ways=${features.ways.length} relations=${features.relations.length}`);
