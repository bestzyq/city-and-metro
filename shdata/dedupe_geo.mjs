// shdata/dedupe_geo.mjs — 去掉跨省 PBF 重复导入的完全相同要素
// 用法：node shdata/dedupe_geo.mjs
// 说明：上海与江苏两份 PBF 都会返回跨越市界的同一条 OSM way（编码、名称、类别完全一致），
// 两次并入后会出现完全重复的行。这里按「整行内容」去重（保留先出现的一条），对渲染与逻辑无影响。
'use strict';
import { readFileSync, writeFileSync } from 'fs';

const path = 'js/geo_sh.js';
const text = readFileSync(path, 'utf8');
const start = text.indexOf('.sh = ') + '.sh = '.length;
const end = text.indexOf(';', start);
const geo = JSON.parse(text.slice(start, end));

const dedupe = function (rows, label) {
  const seen = new Set();
  const out = [];
  let dup = 0;
  for (const r of rows) {
    const key = JSON.stringify(r);
    if (seen.has(key)) { dup++; continue; }
    seen.add(key);
    out.push(r);
  }
  if (dup) console.log('  %s：%d 行 → %d 行（去掉 %d 条重复）', label, rows.length, out.length, dup);
  return out;
};

geo.roads = dedupe(geo.roads, '道路');
geo.rail = dedupe(geo.rail, '铁路');
geo.water = dedupe(geo.water, '水面/水系');
geo.parks = dedupe(geo.parks, '公园');
geo.woods = dedupe(geo.woods, '林地');
if (geo.admin) geo.admin = dedupe(geo.admin, '行政区');
geo.places = dedupe(geo.places, '地名');

writeFileSync(path, text.slice(0, start) + JSON.stringify(geo) + text.slice(end));
console.log('去重完成');
