// shdata/build_geo.mjs — 合并现有 geo_sh.js 数据 + 新增区域 OSM 数据 → 新 geo_sh.js
// 策略：
//   1. 读取现有 geo_sh.js 的所有数据，解码所有坐标
//   2. 将所有坐标平移 (DX, DY) = (20, 40) 以适配新投影
//   3. 从 strips_features.json 读取新增区域的 OSM 要素
//   4. 将新增要素投影到新网格坐标
//   5. 合并 names 表，追加新要素
//   6. 重新编码输出
'use strict';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ============================================================
// 投影参数
// ============================================================
const OLD_PROJ = { lon0: 121.31, lat0: 31.42, kx: 380.6, ky: 442.3 };
const NEW_PROJ = { lon0: 121.2584, lat0: 31.5100, kx: 380.6, ky: 442.3 };
const DX = 20, DY = 40;
const OLD_W = 152, OLD_H = 152;
const NEW_W = 172, NEW_H = 372;

// ============================================================
// 增量编解码（与 js/geo.js 完全一致）
// ============================================================
function dec(s, from) {
  const out = []; let i = from || 0, x = 0, y = 0;
  while (i < s.length) {
    let r = 0, sh = 0, b;
    do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
    x += (r & 1) ? ~(r >> 1) : (r >> 1);
    r = 0; sh = 0;
    do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
    y += (r & 1) ? ~(r >> 1) : (r >> 1);
    out.push(x / 64, y / 64);
  }
  return out;
}

function enc(pts) {
  let s = '', px = 0, py = 0;
  const put = function (v) {
    let u = v < 0 ? ~(v << 1) : (v << 1);
    while (u >= 32) { s += String.fromCharCode((32 | (u & 31)) + 63); u >>>= 5; }
    s += String.fromCharCode(u + 63);
  };
  for (let k = 0; k + 1 < pts.length; k += 2) {
    const x = Math.round(pts[k] * 64), y = Math.round(pts[k + 1] * 64);
    put(x - px); put(y - py); px = x; py = y;
  }
  return s;
}

function encRing(pts, isOuter) {
  return (isOuter ? 'o' : 'i') + enc(pts);
}

// 平移坐标数组
function shiftPts(pts, dx, dy) {
  const out = new Array(pts.length);
  for (let k = 0; k < pts.length; k += 2) {
    out[k] = pts[k] + dx;
    out[k + 1] = pts[k + 1] + dy;
  }
  return out;
}

// WGS-84 经纬度 → 新网格坐标
function project(lat, lon) {
  return [(lon - NEW_PROJ.lon0) * NEW_PROJ.kx, (NEW_PROJ.lat0 - lat) * NEW_PROJ.ky];
}

// ============================================================
// 名称表管理
// ============================================================
class NameTable {
  constructor(initialNames) {
    this.names = initialNames || [''];
    this.map = new Map();
    for (let i = 0; i < this.names.length; i++) {
      if (this.names[i]) this.map.set(this.names[i], i);
    }
  }
  add(name) {
    if (!name) return 0;
    if (this.map.has(name)) return this.map.get(name);
    const idx = this.names.length;
    this.names.push(name);
    this.map.set(name, idx);
    return idx;
  }
}

// ============================================================
// 读取现有 geo_sh.js
// ============================================================
function loadOldGeo() {
  // 在 node 中加载 geo_sh.js 的数据（通过模拟 window.CM）
  const code = readFileSync('js/geo_sh.js', 'utf8');
  // 提取 JS 对象（在 (CM.GEOS = ...).sh = 和 ; 之间）
  // 由于 geo_sh.js 使用 JS 对象字面量（非 JSON），我们需要执行它
  const CM = { GEOS: {} };
  // 用 Function 执行 IIFE
  const fn = new Function('CM', code.replace('window.CM', 'CM'));
  fn(CM);
  return CM.GEOS.sh;
}

// ============================================================
// 处理新增区域的 OSM 数据
// ============================================================
function processStrips(features, names) {
  const newWater = [], newWaterLines = [], newRoads = [], newRail = [];
  const newParks = [], newWoods = [], newPlaces = [], newAdmin = [];

  const nodeMap = new Map();
  for (const n of features.nodes) nodeMap.set(n.id, n);

  function wayToGrid(way) {
    const pts = [];
    for (const nid of way.nodes) {
      const n = nodeMap.get(nid);
      if (n) pts.push(...project(n.lat, n.lon));
    }
    return pts;
  }

  function relationRings(rel) {
    const wayMap = new Map();
    for (const w of features.ways) wayMap.set(w.id, w);
    const rings = [];
    for (const m of rel.members) {
      if (m.type !== 'way') continue;
      const way = wayMap.get(m.ref);
      if (!way) continue;
      const pts = wayToGrid(way);
      if (pts.length >= 6) rings.push(pts);
    }
    return rings;
  }

  for (const way of features.ways) {
    if (!way.tags) continue;
    const pts = wayToGrid(way);
    if (pts.length < 4) continue;

    // 水体多边形
    if (way.tags.natural === 'water' || way.tags.waterway === 'riverbank' || way.tags.natural === 'coastline') {
      if (pts.length >= 6) {
        const nameIdx = names.add(way.tags.name || '');
        newWater.push([nameIdx, encRing(pts, true)]);
      }
    }
    // 水系线
    if (['river', 'stream', 'canal', 'tidal_channel'].includes(way.tags.waterway)) {
      const nameIdx = names.add(way.tags.name || '');
      const width = way.tags.waterway === 'canal' ? 0.08 : 0.04;
      newWaterLines.push([nameIdx, width, enc(pts)]);
    }
    // 道路
    if (way.tags.highway) {
      const clsMap = { motorway: 2, trunk: 2, motorway_link: 2, trunk_link: 2,
        primary: 2, primary_link: 2, secondary: 3, secondary_link: 3,
        tertiary: 3, tertiary_link: 3, unclassified: 4, residential: 4,
        living_street: 4, service: 4, pedestrian: 4, track: 4 };
      const cls = clsMap[way.tags.highway] || 4;
      const nameIdx = names.add(way.tags.name || '');
      let flags = 0;
      if (way.tags.bridge && way.tags.bridge !== 'no') flags |= 1;
      if (way.tags.tunnel && way.tags.tunnel !== 'no') flags |= 2;
      newRoads.push([nameIdx, cls, flags, enc(pts)]);
    }
    // 铁路
    if (way.tags.railway && ['rail', 'subway', 'light_rail', 'tram', 'monorail', 'disused', 'construction'].includes(way.tags.railway)) {
      const nameIdx = names.add(way.tags.name || '');
      let flags = 0;
      if (way.tags.tunnel && way.tags.tunnel !== 'no') flags |= 2;
      if (way.tags.bridge && way.tags.bridge !== 'no') flags |= 1;
      if (['disused', 'abandoned'].includes(way.tags.railway)) flags |= 4;
      newRail.push([nameIdx, flags, enc(pts)]);
    }
    // 公园
    if (['park', 'garden', 'playground', 'recreation_ground', 'nature_reserve'].includes(way.tags.leisure)) {
      if (pts.length >= 6) {
        const nameIdx = names.add(way.tags.name || '');
        newParks.push([nameIdx, encRing(pts, true)]);
      }
    }
    // 林地
    if (way.tags.natural === 'wood' || way.tags.landuse === 'forest') {
      if (pts.length >= 6) {
        const nameIdx = names.add(way.tags.name || '');
        newWoods.push([nameIdx, encRing(pts, true)]);
      }
    }
  }

  // 处理 relations
  for (const rel of features.relations) {
    if (!rel.tags) continue;
    const rings = relationRings(rel);
    if (!rings.length) continue;

    if (rel.tags.natural === 'water' || rel.tags.waterway === 'riverbank') {
      const nameIdx = names.add(rel.tags.name || '');
      const row = [nameIdx];
      rings.forEach((r, i) => row.push(encRing(r, i === 0)));
      newWater.push(row);
    }
    if (['park', 'nature_reserve'].includes(rel.tags.leisure)) {
      const nameIdx = names.add(rel.tags.name || '');
      const row = [nameIdx];
      rings.forEach((r, i) => row.push(encRing(r, i === 0)));
      newParks.push(row);
    }
    if (rel.tags.natural === 'wood' || rel.tags.landuse === 'forest') {
      const nameIdx = names.add(rel.tags.name || '');
      const row = [nameIdx];
      rings.forEach((r, i) => row.push(encRing(r, i === 0)));
      newWoods.push(row);
    }
    if (rel.tags.boundary === 'administrative' && rel.tags.admin_level) {
      const level = parseInt(rel.tags.admin_level);
      if (level <= 10) {
        const nameIdx = names.add(rel.tags.name || '');
        const row = [level, nameIdx];
        rings.forEach((r, i) => row.push(encRing(r, i === 0)));
        newAdmin.push(row);
      }
    }
  }

  // 地名
  for (const node of features.nodes) {
    if (!node.tags?.name || !node.tags?.place) continue;
    const [x, y] = project(node.lat, node.lon);
    if (x < -2 || x > NEW_W + 2 || y < -2 || y > NEW_H + 2) continue;
    let type = 2;
    if (['village', 'hamlet'].includes(node.tags.place)) type = 3;
    else if (['suburb', 'quarter', 'neighbourhood'].includes(node.tags.place)) type = 2;
    newPlaces.push([node.tags.name, +x.toFixed(2), +y.toFixed(2), type]);
  }

  return { newWater, newWaterLines, newRoads, newRail, newParks, newWoods, newPlaces, newAdmin };
}

// ============================================================
// 主函数
// ============================================================
function main() {
  console.log('=== Building geo_sh.js ===');
  console.log(`New grid: ${NEW_W}×${NEW_H}, old shifted by (${DX},${DY})`);

  // 1. 读取现有 geo 数据
  console.log('Loading existing geo_sh.js...');
  const oldGeo = loadOldGeo();
  console.log(`  water: ${oldGeo.water.length}, roads: ${oldGeo.roads.length}, rail: ${oldGeo.rail.length}`);
  console.log(`  parks: ${oldGeo.parks.length}, woods: ${oldGeo.woods.length}, places: ${oldGeo.places.length}`);
  console.log(`  names: ${oldGeo.names.length}, streets: ${oldGeo.streets ? oldGeo.streets.length : 0} chars`);

  // 2. 初始化名称表（保留旧名称）
  const names = new NameTable(oldGeo.names);

  // 3. 平移现有数据
  console.log('Shifting existing data...');
  // water: 多边形 [nameIdx, ring1, ring2, ...] 或线 [nameIdx, width, encoded]
  const shiftedWater = oldGeo.water.map(row => {
    if (typeof row[1] === 'number') {
      // 线: [nameIdx, width, encoded]
      const pts = dec(row[2]);
      return [row[0], row[1], enc(shiftPts(pts, DX, DY))];
    } else {
      // 多边形: [nameIdx, ring1, ring2, ...]
      const newRow = [row[0]];
      for (let k = 1; k < row.length; k++) {
        const isOuter = row[k][0] === 'o';
        const pts = dec(row[k], 1);
        newRow.push(encRing(shiftPts(pts, DX, DY), isOuter));
      }
      return newRow;
    }
  });

  // roads: [nameIdx, cls, flags, encoded]
  const shiftedRoads = oldGeo.roads.map(row => {
    const pts = dec(row[3]);
    return [row[0], row[1], row[2], enc(shiftPts(pts, DX, DY))];
  });

  // streets: 用 ! 分隔的编码折线字符串
  let shiftedStreets = '';
  if (oldGeo.streets) {
    const parts = oldGeo.streets.split('!');
    shiftedStreets = parts.map(s => {
      const pts = dec(s);
      return enc(shiftPts(pts, DX, DY));
    }).join('!');
  }

  // rail: [nameIdx, flags, encoded, year?]
  const shiftedRail = oldGeo.rail.map(row => {
    const pts = dec(row[2]);
    const newRow = [row[0], row[1], enc(shiftPts(pts, DX, DY))];
    if (row[3] != null) newRow.push(row[3]);
    return newRow;
  });

  // parks/reserves/woods: [nameIdx, ring1, ring2, ...]
  function shiftPolyFeat(rows) {
    return rows.map(row => {
      const newRow = [row[0]];
      for (let k = 1; k < row.length; k++) {
        const isOuter = row[k][0] === 'o';
        const pts = dec(row[k], 1);
        newRow.push(encRing(shiftPts(pts, DX, DY), isOuter));
      }
      return newRow;
    });
  }
  const shiftedParks = shiftPolyFeat(oldGeo.parks);
  const shiftedReserves = shiftPolyFeat(oldGeo.reserves || []);
  const shiftedWoods = shiftPolyFeat(oldGeo.woods);

  // admin: [level, nameIdx, ring1, ring2, ...]
  const shiftedAdmin = (oldGeo.admin || []).map(row => {
    const newRow = [row[0], row[1]];
    for (let k = 2; k < row.length; k++) {
      const isOuter = row[k][0] === 'o';
      const pts = dec(row[k], 1);
      newRow.push(encRing(shiftPts(pts, DX, DY), isOuter));
    }
    return newRow;
  });

  // places: [name, x, y, type]
  const shiftedPlaces = oldGeo.places.map(p => [p[0], +(p[1] + DX).toFixed(2), +(p[2] + DY).toFixed(2), p[3]]);

  console.log('  Shifted all existing data');

  // 4. 处理新增区域
  let newFeatures = { nodes: [], ways: [], relations: [] };
  if (existsSync('shdata/strips_features.json')) {
    console.log('Loading strips features...');
    newFeatures = JSON.parse(readFileSync('shdata/strips_features.json', 'utf8'));
    console.log(`  nodes: ${newFeatures.nodes.length}, ways: ${newFeatures.ways.length}, relations: ${newFeatures.relations.length}`);
  }

  console.log('Processing new area features...');
  const new_ = processStrips(newFeatures, names);
  console.log(`  New: water=${new_.newWater.length} roads=${new_.newRoads.length} rail=${new_.newRail.length} parks=${new_.newParks.length} woods=${new_.newWoods.length} places=${new_.newPlaces.length} admin=${new_.newAdmin.length}`);

  // 5. 合并
  const allWater = [...shiftedWater, ...new_.newWater, ...new_.newWaterLines];
  const allRoads = [...shiftedRoads, ...new_.newRoads];
  const allRail = [...shiftedRail, ...new_.newRail];
  const allParks = [...shiftedParks, ...new_.newParks];
  const allWoods = [...shiftedWoods, ...new_.newWoods];
  const allPlaces = [...shiftedPlaces, ...new_.newPlaces];
  const allAdmin = [...shiftedAdmin, ...new_.newAdmin];
  const allReserves = shiftedReserves;

  // 6. 生成输出
  const geo = {
    proj: NEW_PROJ,
    water: allWater,
    roads: allRoads,
    streets: shiftedStreets,
    rail: allRail,
    parks: allParks,
    reserves: allReserves,
    woods: allWoods,
    admin: allAdmin,
    places: allPlaces,
    names: names.names,
  };

  console.log('\nFinal counts:');
  console.log(`  water: ${allWater.length}, roads: ${allRoads.length}, streets: ${shiftedStreets.length} chars`);
  console.log(`  rail: ${allRail.length}, parks: ${allParks.length}, woods: ${allWoods.length}`);
  console.log(`  places: ${allPlaces.length}, admin: ${allAdmin.length}, names: ${names.names.length}`);

  const js = `'use strict';
// 由 OpenStreetMap 数据生成（© OpenStreetMap 贡献者，ODbL）。坐标为游戏格（250 m），折线为增量编码，1/64 格精度。地名为简体中文。
// 上海（v2.8）：范围约北纬 31.01°–31.60°、东经 121.21°–121.71°；向北覆盖长江口与崇明岛南缘，向南覆盖浦东南部与奉贤北缘，向西覆盖安亭方向
// 旧地图 152×152 平移至新网格 (20,40)，新增数据来自 Overpass API
(function (CM) {
  (CM.GEOS = CM.GEOS || {}).sh = ${JSON.stringify(geo)};
})(window.CM);
`;

  writeFileSync('js/geo_sh.js', js);
  console.log(`\nWritten js/geo_sh.js (${(js.length / 1024).toFixed(0)} KB)`);
}

main();
