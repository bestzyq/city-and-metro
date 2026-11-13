// shdata/apply_west.mjs — 网格向西扩 156 格：既有数据整体右移、并入西扩区块、按新范围重建海域
// 用法：node shdata/apply_west.mjs
// 前置：shdata/build_east.mjs --box -8,0,132,488 --readbox -70,-280,200,520 --out shdata/west_block.json
//       shdata/fetch_coastline.mjs（新范围海岸线）
// 说明：投影只改 lon0（121.2584 → 120.8486），kx/ky 不变；既有要素 x += 156，与存档迁移 dx=156 一致。
'use strict';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { seaRings, enc, dec, extractOldLand } from './sea.mjs';
import { PROJ } from './coast.mjs';

const W = 432, H = 488, DX = 156;
const path = 'js/geo_sh.js';
const text = readFileSync(path, 'utf8');
const start = text.indexOf('.sh = ') + '.sh = '.length;
const end = text.indexOf(';', start);
const geo = JSON.parse(text.slice(start, end));
const names = geo.names;

const shiftPts = function (p) { const q = new Array(p.length); for (let i = 0; i < p.length; i += 2) { q[i] = p[i] + DX; q[i + 1] = p[i + 1]; } return q; };
const shiftRing = function (s) { return s[0] + enc(shiftPts(dec(s, 1))); };

let nRoad = geo.roads.length, nRail = geo.rail.length, nWater = geo.water.length, nPark = geo.parks.length, nWood = geo.woods.length, nAdmin = (geo.admin || []).length;

geo.roads = geo.roads.map(function (r) { return [r[0], r[1], r[2], enc(shiftPts(dec(r[3])))]; });
geo.rail = geo.rail.map(function (r) { const out = [r[0], r[1], enc(shiftPts(dec(r[2])))]; if (r[3] != null) out.push(r[3]); return out; });
geo.water = geo.water.map(function (r) {
  if (typeof r[1] === 'number') return [r[0], r[1], enc(shiftPts(dec(r[2])))];
  return [r[0]].concat(r.slice(1).map(shiftRing));
});
geo.parks = geo.parks.map(function (r) { return [r[0]].concat(r.slice(1).map(shiftRing)); });
if (geo.reserves) geo.reserves = geo.reserves.map(function (r) { return [r[0]].concat(r.slice(1).map(shiftRing)); });
geo.woods = geo.woods.map(function (r) { return [r[0]].concat(r.slice(1).map(shiftRing)); });
geo.admin = (geo.admin || []).map(function (r) { return [r[0], r[1]].concat(r.slice(2).map(shiftRing)); });
geo.places = geo.places.map(function (p) { return [p[0], +(p[1] + DX).toFixed(2), p[2], p[3]]; });
if (typeof geo.streets === 'string' && geo.streets) {
  geo.streets = geo.streets.split('!').map(function (s) { return s ? enc(shiftPts(dec(s))) : s; }).join('!');
}
geo.proj.lon0 = PROJ.lon0;

// 并入西扩区块
const west = JSON.parse(readFileSync('shdata/west_block.json', 'utf8'));
const map = new Int32Array(west.names.length);
for (let i = 0; i < west.names.length; i++) {
  const n = west.names[i];
  if (!n) { map[i] = 0; continue; }
  const k = names.indexOf(n);
  if (k >= 0) map[i] = k; else { names.push(n); map[i] = names.length - 1; }
}
const nIdx = function (i) { return map[i] || 0; };
for (const r of west.roads) geo.roads.push([nIdx(r[0]), r[1], r[2], r[3]]);
for (const r of west.rail) geo.rail.push([nIdx(r[0]), r[1], r[2]]);
for (const r of west.water) {
  if (typeof r[1] === 'number') geo.water.push([nIdx(r[0]), r[1], r[2]]);
  else geo.water.push([nIdx(r[0])].concat(r.slice(1)));
}
for (const r of west.waterLines) geo.water.push([nIdx(r[0]), r[1], r[2]]);
for (const r of west.parks) geo.parks.push([nIdx(r[0])].concat(r.slice(1)));
for (const r of west.woods) geo.woods.push([nIdx(r[0])].concat(r.slice(1)));
for (const r of west.places) geo.places.push([r[0], r[1], r[2], r[3]]);
for (const r of west.admin) geo.admin.push([r[0], nIdx(r[1])].concat(r.slice(2)));

// 海域：按新网格与海岸线重建
const coast = existsSync('shdata/coastline.json') ? JSON.parse(readFileSync('shdata/coastline.json', 'utf8')).ways : null;
const idx = geo.water.findIndex(function (row) { return typeof row[1] !== 'number' && names[row[0]] === '长江口'; });
if (idx < 0) throw new Error('未找到海域要素「长江口」');
const seaRow = geo.water[idx];
const rings = [];
for (let k = 1; k < seaRow.length; k++) rings.push({ tag: seaRow[k][0], pts: seaRow[k].slice(1) });
const old = extractOldLand(rings);
const out = seaRings({ W: W, H: H, geo: geo, coast: coast, landRings: old ? [old.land] : [], islandRings: old ? old.islands : [] });
geo.water[idx] = [seaRow[0]].concat(out.map(function (r) { return r.tag + enc(r.pts); }));

writeFileSync(path, text.slice(0, start) + JSON.stringify(geo) + text.slice(end));
console.log('西扩完成（dx=%d，lon0=%s，W=%d）：', DX, geo.proj.lon0, W);
console.log(`  既有要素右移：道路 ${nRoad}、铁路 ${nRail}、水面 ${nWater}、公园 ${nPark}、林地 ${nWood}、行政区 ${nAdmin}`);
console.log(`  并入西扩：道路 +${west.roads.length}、铁路 +${west.rail.length}、水面 +${west.water.length + west.waterLines.length}、行政区 +${west.admin.length}`);
console.log(`  合计：道路 ${geo.roads.length}、铁路 ${geo.rail.length}、水面 ${geo.water.length}、地名 ${geo.places.length}、名称 ${names.length}`);
console.log(`  海域：${seaRow.length - 1} 环 → ${out.length} 环（${coast ? 'OSM 海岸线' : '退化'}）`);
