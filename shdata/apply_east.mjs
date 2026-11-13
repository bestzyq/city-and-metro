// shdata/apply_east.mjs — 把东扩区块并入 js/geo_sh.js，并按新网格重建海域
// 用法：node shdata/apply_east.mjs
// 前置：shdata/build_east.mjs（生成 east_block.json）、shdata/fetch_coastline.mjs（生成 coastline.json）
// 说明：只追加 x ≥ 168 的新要素，已有要素与其坐标保持不变（网格向东扩，不涉及旧坐标平移）。
'use strict';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { seaRings, enc, extractOldLand } from './sea.mjs';

const W = 276, H = 372;
const path = 'js/geo_sh.js';
const text = readFileSync(path, 'utf8');
const start = text.indexOf('.sh = ') + '.sh = '.length;
const end = text.indexOf(';', start);
const geo = JSON.parse(text.slice(start, end));
const names = geo.names;

const east = JSON.parse(readFileSync('shdata/east_block.json', 'utf8'));
const coast = existsSync('shdata/coastline.json') ? JSON.parse(readFileSync('shdata/coastline.json', 'utf8')).ways : null;

// 名称表合并
const map = new Int32Array(east.names.length);
for (let i = 0; i < east.names.length; i++) {
  const n = east.names[i];
  if (!n) { map[i] = 0; continue; }
  const k = names.indexOf(n);
  if (k >= 0) map[i] = k;
  else { names.push(n); map[i] = names.length - 1; }
}
const nIdx = function (i) { return map[i] || 0; };

const before = { roads: geo.roads.length, rail: geo.rail.length, water: geo.water.length, parks: geo.parks.length, woods: geo.woods.length, places: geo.places.length, admin: (geo.admin || []).length };

for (const r of east.roads) geo.roads.push([nIdx(r[0]), r[1], r[2], r[3]]);
for (const r of east.rail) geo.rail.push([nIdx(r[0]), r[1], r[2]]);
for (const r of east.water) {
  if (typeof r[1] === 'number') geo.water.push([nIdx(r[0]), r[1], r[2]]);
  else geo.water.push([nIdx(r[0])].concat(r.slice(1)));
}
for (const r of east.waterLines) geo.water.push([nIdx(r[0]), r[1], r[2]]);
for (const r of east.parks) geo.parks.push([nIdx(r[0])].concat(r.slice(1)));
for (const r of east.woods) geo.woods.push([nIdx(r[0])].concat(r.slice(1)));
for (const r of east.places) geo.places.push([r[0], r[1], r[2], r[3]]);
geo.admin = geo.admin || [];
for (const r of east.admin) geo.admin.push([r[0], nIdx(r[1])].concat(r.slice(2)));

// 海域：按新网格与海岸线重建
const idx = geo.water.findIndex(function (row) { return typeof row[1] !== 'number' && names[row[0]] === '长江口'; });
if (idx < 0) throw new Error('未找到海域要素「长江口」');
const seaRow = geo.water[idx];
const rings = [];
for (let k = 1; k < seaRow.length; k++) rings.push({ tag: seaRow[k][0], pts: seaRow[k].slice(1) });
const old = extractOldLand(rings);
const out = seaRings({ W: W, H: H, geo: geo, coast: coast, landRings: old ? [old.land] : [], islandRings: old ? old.islands : [] });
geo.water[idx] = [seaRow[0]].concat(out.map(function (r) { return r.tag + enc(r.pts); }));

writeFileSync(path, text.slice(0, start) + JSON.stringify(geo) + text.slice(end));
console.log('东扩区块已并入 geo_sh.js：');
console.log(`  道路 ${before.roads} → ${geo.roads.length}，铁路 ${before.rail} → ${geo.rail.length}，水面 ${before.water} → ${geo.water.length}`);
console.log(`  公园 ${before.parks} → ${geo.parks.length}，林地 ${before.woods} → ${geo.woods.length}，地名 ${before.places} → ${geo.places.length}，行政区 ${before.admin} → ${geo.admin.length}`);
console.log(`  海域：${seaRow.length - 1} 环 → ${out.length} 环（${coast ? 'OSM 海岸线' : '退化'}），名称表 ${names.length}`);
