// shdata/fix_sea_polygon.mjs — 按 172×372 网格重建 js/geo_sh.js 的海域要素
// 用法：node shdata/fix_sea_polygon.mjs
// 说明：扩容时海域多边形只被平移/扩框，新条带（北面长江口、南面杭州湾）没有陆地/海面范围，
//       于是北面整条被算成陆地、南面海岸线也偏北，铁路和道路被画在水里。
//       这里用 shdata/sea.mjs 从地物数据反推岸线后重新拼装：
//         整图矩形 −（旧图陆地/岛屿 + 西侧陆地 + 杭州湾北岸以北的陆地 + 北条带地物闭包）
//       脚本按几何特征识别旧环，可反复运行。
'use strict';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { enc, seaRings, extractOldLand } from './sea.mjs';

const SEA_NAME = '长江口';
const path = 'js/geo_sh.js';
const text = readFileSync(path, 'utf8');
const start = text.indexOf('.sh = ') + '.sh = '.length;
const end = text.indexOf(';', start);
if (start < 10 || end < start) throw new Error('未找到 geo 数据块（.sh = …;）');
const geo = JSON.parse(text.slice(start, end));
const names = geo.names;

const idx = geo.water.findIndex(function (row) { return typeof row[1] !== 'number' && names[row[0]] === SEA_NAME; });
if (idx < 0) throw new Error('未找到海域要素「' + SEA_NAME + '」');

const row = geo.water[idx];
const rings = [];
for (let k = 1; k < row.length; k++) rings.push({ tag: row[k][0], pts: row[k].slice(1) });
const coast = existsSync('shdata/coastline.json')
  ? JSON.parse(readFileSync('shdata/coastline.json', 'utf8')).ways
  : null;
const old = extractOldLand(rings);
if (!coast && !old) throw new Error('既没有 shdata/coastline.json，也无法从现有数据识别旧图陆地洞');
const out = seaRings({
  W: 172, H: 372, geo: geo, coast: coast,
  landRings: old ? [old.land] : [], islandRings: old ? old.islands : [],
});
console.log(coast ? '  使用 OSM 海岸线推导陆地（' + coast.length + ' 条 way）' : '  未找到 shdata/coastline.json，退化为按地物反推');
geo.water[idx] = [row[0]].concat(out.map(function (r) { return r.tag + enc(r.pts); }));
writeFileSync(path, text.slice(0, start) + JSON.stringify(geo) + text.slice(end));
console.log('海域要素已重建：%d 环 → %d 环（外环 %d / 陆地与岛屿洞 %d）',
  row.length - 1, out.length, out.filter(r => r.tag === 'o').length, out.filter(r => r.tag === 'i').length);
