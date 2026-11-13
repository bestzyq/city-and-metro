// shdata/merge_block.mjs — 把某个条带区块（build_east.mjs 的产物）并入 js/geo_sh.js
// 用法：node shdata/merge_block.mjs shdata/west_js_block.json [标记名]
// 说明：不做坐标平移、不动海域，只做「名称表合并 + 各类要素追加」；同一标记重复运行会跳过，避免重复并入。
'use strict';
import { readFileSync, writeFileSync } from 'fs';

const file = process.argv[2];
if (!file) throw new Error('用法：node shdata/merge_block.mjs <block.json> [标记名]');
const tag = process.argv[3] || file.replace(/^.*\//, '').replace(/\.json$/, '');
const block = JSON.parse(readFileSync(file, 'utf8'));

const path = 'js/geo_sh.js';
const text = readFileSync(path, 'utf8');
const start = text.indexOf('.sh = ') + '.sh = '.length;
const end = text.indexOf(';', start);
const geo = JSON.parse(text.slice(start, end));
const names = geo.names;

geo._blocks = geo._blocks || [];
if (geo._blocks.indexOf(tag) >= 0) {
  console.log('区块「%s」已并入过（geo._blocks），跳过', tag);
  process.exit(0);
}

const map = new Int32Array(block.names.length);
for (let i = 0; i < block.names.length; i++) {
  const n = block.names[i];
  if (!n) { map[i] = 0; continue; }
  const k = names.indexOf(n);
  if (k >= 0) map[i] = k; else { names.push(n); map[i] = names.length - 1; }
}
const nIdx = function (i) { return map[i] || 0; };

const before = { roads: geo.roads.length, rail: geo.rail.length, water: geo.water.length, places: geo.places.length, admin: (geo.admin || []).length, parks: geo.parks.length, woods: geo.woods.length };
for (const r of block.roads || []) geo.roads.push([nIdx(r[0]), r[1], r[2], r[3]]);
for (const r of block.rail || []) geo.rail.push([nIdx(r[0]), r[1], r[2]]);
for (const r of block.water || []) {
  if (typeof r[1] === 'number') geo.water.push([nIdx(r[0]), r[1], r[2]]);
  else geo.water.push([nIdx(r[0])].concat(r.slice(1)));
}
for (const r of block.waterLines || []) geo.water.push([nIdx(r[0]), r[1], r[2]]);
for (const r of block.parks || []) geo.parks.push([nIdx(r[0])].concat(r.slice(1)));
for (const r of block.woods || []) geo.woods.push([nIdx(r[0])].concat(r.slice(1)));
for (const r of block.places || []) geo.places.push([r[0], r[1], r[2], r[3]]);
geo.admin = geo.admin || [];
for (const r of block.admin || []) geo.admin.push([r[0], nIdx(r[1])].concat(r.slice(2)));
geo._blocks.push(tag);

writeFileSync(path, text.slice(0, start) + JSON.stringify(geo) + text.slice(end));
console.log('已并入 %s（%s）：', file, tag);
console.log('  道路 %d → %d，铁路 %d → %d，水面 %d → %d', before.roads, geo.roads.length, before.rail, geo.rail.length, before.water, geo.water.length);
console.log('  公园 %d → %d，林地 %d → %d，地名 %d → %d，行政区 %d → %d，名称 %d',
  before.parks, geo.parks.length, before.woods, geo.woods.length, before.places, geo.places.length, before.admin, geo.admin.length, names.length);
