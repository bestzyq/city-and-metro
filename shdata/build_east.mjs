// shdata/build_east.mjs — 从上海 PBF 抽取东扩区块（x ≥ 168 格，W: 172 → 276）的 OSM 要素
// 用法：node shdata/build_east.mjs [pbf 路径]
// 输出：shdata/east_block.json（名称表 + 已增量编码的各类要素），由 apply_east.mjs 合并进 geo_sh.js
// 数据 © OpenStreetMap 贡献者（ODbL）。
'use strict';
import { writeFileSync } from 'fs';
import { readOSM } from './pbf.mjs';
import { enc } from './sea.mjs';
import { PROJ } from './coast.mjs';

function argOf(name, def) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; }
const PBF = process.argv[2] && process.argv[2].endsWith('.pbf') ? process.argv[2] : 'shdata/shanghai-261112.osm.pbf';
const GRID = { W: 432, H: 488 };
// 抽取窗口（格坐标）与输出文件：东扩区块默认 x 168–280；北扩用 --box 0,-60,280,52
const [X0, Y0, X1, Y1] = String(argOf('--box', '168,-6,280,378')).split(',').map(Number);
// 读取窗口可以比输出窗口大：行政区（区/镇）的环常跨出图边，必须完整读取才能闭合
const [RX0, RY0, RX1, RY1] = String(argOf('--readbox', [X0, Y0, X1, Y1].join(','))).split(',').map(Number);
const OUT = argOf('--out', 'shdata/east_block.json');

const latOf = (y) => PROJ.lat0 - y / PROJ.ky;
const lonOf = (x) => PROJ.lon0 + x / PROJ.kx;
const bbox = [latOf(RY1), lonOf(RX0), latOf(RY0), lonOf(RX1)];   // s,w,n,e（读取窗口）
console.log('PBF:', PBF);
console.log('读取 bbox(格):', RX0, RY0, RX1, RY1, '→ 经纬度', bbox.map((v) => v.toFixed(4)).join(','));
console.log('输出窗口(格):', X0, Y0, X1, Y1);
// 非行政区要素只在输出窗口内保留
const inBox = function (p) { for (let i = 0; i < p.length; i += 2) if (p[i] >= X0 && p[i] <= X1 && p[i + 1] >= Y0 && p[i + 1] <= Y1) return true; return false; };

const names = [''];

function nameIdx(n) {
  if (!n) return 0;
  const i = names.indexOf(n);
  if (i >= 0) return i;
  names.push(n);
  return names.length - 1;
}

function project(lat, lon) {
  return [(lon - PROJ.lon0) * PROJ.kx, (PROJ.lat0 - lat) * PROJ.ky];
}

const roads = [], rail = [], water = [], waterLines = [], parks = [], woods = [], places = [], admin = [];
const waysById = new Map();
const nodeLL = new Map();

// ---- 第一次遍历：收集节点坐标与 way 定义（way 需要引用节点坐标）----
const nodeTags = [];
const t0 = Date.now();
const osm = readOSM(PBF, bbox, {
  onNode: function (id, lat, lon, tags) {
    if (tags.place && tags.name) nodeTags.push({ id: id, lat: lat, lon: lon, tags: tags });
  },
});
console.log(`PBF 读取完成（${((Date.now() - t0) / 1000).toFixed(1)}s）：way ${osm.ways.length}，relation ${osm.rels.length}，带地名节点 ${nodeTags.length}`);

for (const w of osm.ways) waysById.set(w.id, w);
const latMap = osm.nodes.lat, lonMap = osm.nodes.lon;

function wayPts(w) {
  const pts = [];
  for (const r of w.refs) {
    const la = latMap.get(r), lo = lonMap.get(r);
    if (la == null) continue;
    const p = project(la, lo);
    pts.push(p[0], p[1]);
  }
  return pts;
}

// ---- way 分类 ----
const CLS = {
  motorway: 2, trunk: 2, motorway_link: 2, trunk_link: 2, primary: 2, primary_link: 2,
  secondary: 3, secondary_link: 3, tertiary: 3, tertiary_link: 3,
  unclassified: 4, residential: 4, living_street: 4, service: 4, pedestrian: 4, track: 4,
};
const RAIL = ['rail', 'subway', 'light_rail', 'tram', 'monorail', 'disused', 'construction'];
const WAY_WATER = ['river', 'stream', 'canal', 'tidal_channel', 'ditch', 'drain'];

function roadFlags(t) {
  let f = 0;
  if (t.bridge && t.bridge !== 'no') f |= 1;
  if (t.tunnel && t.tunnel !== 'no') f |= 2;
  if (/_link$/.test(t.highway || '')) f |= 4;
  return f;
}

function railFlags(t) {
  let f = 0;
  if (t.bridge && t.bridge !== 'no') f |= 1;
  if (t.tunnel && t.tunnel !== 'no') f |= 2;
  if (/^(disused|abandoned)$/.test(t.railway || '')) f |= 4;
  if (t.highspeed === 'yes' || /高速/.test(t.name || '')) f |= 16;
  return f;
}

function isWater(t) {
  return t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin';
}
function isPark(t) {
  return ['park', 'garden', 'playground', 'recreation_ground', 'nature_reserve'].indexOf(t.leisure) >= 0;
}
function isWood(t) {
  return t.natural === 'wood' || t.landuse === 'forest';
}
function widthOf(t) {
  if (t.waterway === 'canal') return 0.088;
  if (t.waterway === 'river') return 0.08;
  return 0.048;
}

const usedWays = new Set();
for (const w of osm.ways) {
  const t = w.tags;
  if (CLS[t.highway]) {
    const pts = wayPts(w);
    if (pts.length >= 4 && inBox(pts)) { roads.push([nameIdx(t.name), CLS[t.highway], roadFlags(t), enc(pts)]); usedWays.add(w.id); }
  }
  if (t.railway && RAIL.indexOf(t.railway) >= 0) {
    const pts = wayPts(w);
    if (pts.length >= 4 && inBox(pts)) { rail.push([nameIdx(t.name), railFlags(t), enc(pts)]); usedWays.add(w.id); }
  }
  if (t.natural === 'coastline') continue;   // 海岸线交给 coast.mjs 推陆地，不当水面
  if (WAY_WATER.indexOf(t.waterway) >= 0 && !t.natural) {
    const pts = wayPts(w);
    if (pts.length >= 4 && inBox(pts)) { waterLines.push([nameIdx(t.name), widthOf(t), enc(pts)]); usedWays.add(w.id); }
  } else if (isWater(t)) {
    const pts = wayPts(w);
    if (pts.length >= 6 && inBox(pts)) { water.push([nameIdx(t.name), 'o' + enc(pts)]); usedWays.add(w.id); }
  }
  if (isPark(t)) {
    const pts = wayPts(w);
    if (pts.length >= 6 && inBox(pts)) { parks.push([nameIdx(t.name), 'o' + enc(pts)]); usedWays.add(w.id); }
  }
  if (isWood(t)) {
    const pts = wayPts(w);
    if (pts.length >= 6 && inBox(pts)) { woods.push([nameIdx(t.name), 'o' + enc(pts)]); usedWays.add(w.id); }
  }
}

// ---- multipolygon 关系：把成员 way 缝合成环 ----
function stitchRings(wayIds) {
  const segs = wayIds.map(function (id) { return waysById.get(id); }).filter(Boolean)
    .map(function (w) { return w.refs.slice(); });
  const rings = [];
  const key = function (n) { return n; };
  while (segs.length) {
    let ring = segs.shift();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (key(s[0]) === key(ring[ring.length - 1])) { ring = ring.concat(s.slice(1)); segs.splice(i, 1); grew = true; break; }
        if (key(s[s.length - 1]) === key(ring[ring.length - 1])) { ring = ring.concat(s.slice(0, -1).reverse()); segs.splice(i, 1); grew = true; break; }
        if (key(s[s.length - 1]) === key(ring[0])) { ring = s.slice(0, -1).concat(ring); segs.splice(i, 1); grew = true; break; }
        if (key(s[0]) === key(ring[0])) { ring = s.slice(1).reverse().concat(ring); segs.splice(i, 1); grew = true; break; }
      }
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

function ringPts(refs) {
  const pts = [];
  for (const r of refs) {
    const la = latMap.get(r), lo = lonMap.get(r);
    if (la == null) continue;
    const p = project(la, lo);
    pts.push(p[0], p[1]);
  }
  return pts;
}

let mpWater = 0, mpPark = 0, mpWood = 0, mpAdmin = 0;
for (const rel of osm.rels) {
  const at = rel.tags;
  if (at.boundary === 'administrative' && at.admin_level) {
    const lv = parseInt(at.admin_level, 10);
    if (lv <= 10) {
      const outer = rel.members.filter(function (m) { return m.type === 1 && m.role !== 'inner'; }).map(function (m) { return m.ref; });
      const inner = rel.members.filter(function (m) { return m.type === 1 && m.role === 'inner'; }).map(function (m) { return m.ref; });
      const row = [lv, nameIdx(at.name)];
      let touches = false;
      const near = function (p) { for (let i = 0; i < p.length; i += 2) if (p[i] >= X0 - 4 && p[i] <= X1 + 4 && p[i + 1] >= Y0 - 4 && p[i + 1] <= Y1 + 4) return true; return false; };
      for (const r of stitchRings(outer)) { const p = ringPts(r); if (p.length >= 6) { row.push('o' + enc(p)); if (near(p)) touches = true; } }
      // 只保留与本条带相交的行政区（读取窗口为了闭合环放大到全岛/全市，不裁剪会把整座城市重复并入）
      if (!touches) continue;
      if (row.length > 2) {
        for (const r of stitchRings(inner)) { const p = ringPts(r); if (p.length >= 6) row.push('i' + enc(p)); }
        admin.push(row); mpAdmin++;
        for (const m of rel.members) usedWays.add(m.ref);
        continue;
      }
    }
  }
  if (rel.tags.type !== 'multipolygon') continue;
  const t = rel.tags;
  const target = isWater(t) ? water : isPark(t) ? parks : isWood(t) ? woods : null;
  if (!target) continue;
  const outer = rel.members.filter(function (m) { return m.type === 1 && m.role !== 'inner'; }).map(function (m) { return m.ref; });
  const inner = rel.members.filter(function (m) { return m.type === 1 && m.role === 'inner'; }).map(function (m) { return m.ref; });
  const row = [nameIdx(t.name)];
  for (const r of stitchRings(outer)) { const p = ringPts(r); if (p.length >= 6) row.push('o' + enc(p)); }
  if (row.length < 2) continue;
  for (const r of stitchRings(inner)) { const p = ringPts(r); if (p.length >= 6) row.push('i' + enc(p)); }
  target.push(row);
  if (target === water) mpWater++; else if (target === parks) mpPark++; else mpWood++;
  for (const m of rel.members) usedWays.add(m.ref);
}
void mpWater; void mpPark; void mpWood;

// ---- 地名 ----
const PLACE_TYPE = { city: 2, town: 2, suburb: 2, quarter: 2, neighbourhood: 2, village: 3, hamlet: 3, isolated_dwelling: 3 };
for (const nd of nodeTags) {
  const p = project(nd.lat, nd.lon);
  if (p[0] < X0 || p[0] > X1 || p[1] < Y0 || p[1] > Y1) continue;
  const ty = PLACE_TYPE[nd.tags.place];
  if (ty == null) continue;
  places.push([nd.tags.name, +p[0].toFixed(2), +p[1].toFixed(2), ty]);
}

const out = { bbox: { X0: X0, Y0: Y0, X1: X1, Y1: Y1 }, proj: PROJ, names: names, roads: roads, rail: rail, water: water, waterLines: waterLines, parks: parks, woods: woods, places: places, admin: admin };
writeFileSync(OUT, JSON.stringify(out));
console.log(`写入 ${OUT}：道路 ${roads.length}，铁路 ${rail.length}，水面 ${water.length}（含关系 ${mpWater}），水系 ${waterLines.length}，公园 ${parks.length}，林地 ${woods.length}，行政区 ${admin.length}（含关系 ${mpAdmin}），地名 ${places.length}，名称 ${names.length - 1}`);
