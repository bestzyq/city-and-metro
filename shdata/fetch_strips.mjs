// shdata/fetch_strips.mjs — 获取新增区域的 OSM 数据
// 使用 curl 子进程通过 7890 代理访问 OSM API
// 旧地图 152×152 保持不变，新网格 172×232 = +20 西, +40 北, +40 南
'use strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';

const PROXY = 'http://127.0.0.1:7890';
const OSM_API = 'https://api.openstreetmap.org/api/0.6/map';

// 新投影参数
const PROJ = { lon0: 121.2584, lat0: 31.5100, kx: 380.6, ky: 442.3 };
const OLD_W = 152, OLD_H = 152;
const DX = 20, DY = 40;  // 旧地图在新网格中的偏移
const NEW_W = 172, NEW_H = 232;
const OLD_BOTTOM = DY + OLD_H; // 192

// 网格坐标 → 经纬度
function gridToLL(x, y) {
  return [PROJ.lat0 - y / PROJ.ky, PROJ.lon0 + x / PROJ.kx];
}

// 需要获取的条带（旧地图之外）
const strips = [
  { name: 'north', x0: 0, y0: 0, x1: NEW_W, y1: DY },
  { name: 'south', x0: 0, y0: OLD_BOTTOM, x1: NEW_W, y1: NEW_H },
  { name: 'west',  x0: 0, y0: DY, x1: DX, y1: OLD_BOTTOM },
];

// 分成小瓦片（约 0.015°×0.015°，避免超 50000 节点限制）
const TILE_DEG = 0.015;

function stripToTiles(strip) {
  const [lat0, lon0] = gridToLL(strip.x0, strip.y0);
  const [lat1, lon1] = gridToLL(strip.x1, strip.y1);
  const s = Math.min(lat0, lat1), n = Math.max(lat0, lat1);
  const w = Math.min(lon0, lon1), e = Math.max(lon0, lon1);
  const tiles = [];
  for (let lat = s; lat < n; lat += TILE_DEG) {
    for (let lon = w; lon < e; lon += TILE_DEG) {
      tiles.push({
        s: lat.toFixed(5), n: Math.min(lat + TILE_DEG, n).toFixed(5),
        w: lon.toFixed(5), e: Math.min(lon + TILE_DEG, e).toFixed(5),
        strip: strip.name,
        key: `${strip.name}_${lat.toFixed(3)}_${lon.toFixed(3)}`
      });
    }
  }
  return tiles;
}

function fetchTileCurl(tile, outFile) {
  const bbox = `${tile.w},${tile.s},${tile.e},${tile.n}`;
  const url = `${OSM_API}?bbox=${bbox}`;
  try {
    execFileSync('curl', [
      '-s', '-x', PROXY, '--max-time', '20',
      '-H', 'User-Agent: CityAndMetro-GeoBuilder/1.0',
      '-o', outFile, url
    ], { timeout: 25000, maxBuffer: 50 * 1024 * 1024 });
    return true;
  } catch (e) {
    return false;
  }
}

// 解析 OSM XML，提取 nodes/ways/relations
function parseOSMXML(xml) {
  const nodes = new Map(), ways = new Map(), rels = new Map();
  // 自闭合 node
  for (const m of xml.matchAll(/<node\s+[^>]*?id="(\d+)"[^>]*?\/>/g)) {
    const attrs = m[0];
    const lat = parseFloat(attrs.match(/lat="([-\d.]+)"/)?.[1] || 0);
    const lon = parseFloat(attrs.match(/lon="([-\d.]+)"/)?.[1] || 0);
    nodes.set(m[1], { id: +m[1], lat, lon, tags: {} });
  }
  // 带子元素的 node
  for (const m of xml.matchAll(/<node\s+[^>]*?id="(\d+)"[^>]*?>([\s\S]*?)<\/node>/g)) {
    const attrs = m[0];
    const lat = parseFloat(attrs.match(/lat="([-\d.]+)"/)?.[1] || 0);
    const lon = parseFloat(attrs.match(/lon="([-\d.]+)"/)?.[1] || 0);
    const tags = {};
    for (const tm of m[2].matchAll(/<tag\s+k="([^"]+)"\s+v="([^"]*)"/g)) tags[tm[1]] = tm[2];
    nodes.set(m[1], { id: +m[1], lat, lon, tags });
  }
  // ways
  for (const m of xml.matchAll(/<way\s+[^>]*?id="(\d+)"[^>]*?>([\s\S]*?)<\/way>/g)) {
    const nds = [];
    for (const nm of m[2].matchAll(/<nd\s+ref="(\d+)"/g)) nds.push(+nm[1]);
    const tags = {};
    for (const tm of m[2].matchAll(/<tag\s+k="([^"]+)"\s+v="([^"]*)"/g)) tags[tm[1]] = tm[2];
    ways.set(m[1], { id: +m[1], nodes: nds, tags });
  }
  // relations
  for (const m of xml.matchAll(/<relation\s+[^>]*?id="(\d+)"[^>]*?>([\s\S]*?)<\/relation>/g)) {
    const members = [];
    for (const mm of m[2].matchAll(/<member\s+type="([^"]+)"\s+ref="(\d+)"\s+role="([^"]*)"/g)) {
      members.push({ type: mm[1], ref: +mm[2], role: mm[3] });
    }
    const tags = {};
    for (const tm of m[2].matchAll(/<tag\s+k="([^"]+)"\s+v="([^"]*)"/g)) tags[tm[1]] = tm[2];
    rels.set(m[1], { id: +m[1], members, tags });
  }
  return { nodes, ways, rels };
}

async function main() {
  console.log('=== Fetch OSM strips (new areas only) ===');
  console.log(`New grid: ${NEW_W}×${NEW_H}, old at (${DX},${DY})`);

  // 计算所有瓦片
  let allTiles = [];
  for (const strip of strips) {
    const tiles = stripToTiles(strip);
    console.log(`Strip "${strip.name}": ${tiles.length} tiles`);
    allTiles = allTiles.concat(tiles);
  }
  console.log(`Total tiles: ${allTiles.length}\n`);

  // 缓存目录
  mkdirSync('shdata/tiles', { recursive: true });

  // 进度文件
  const progressFile = 'shdata/progress.json';
  let progress = {};
  if (existsSync(progressFile)) {
    progress = JSON.parse(readFileSync(progressFile, 'utf8'));
  }

  // 合并的 OSM 数据
  const merged = { nodes: new Map(), ways: new Map(), rels: new Map() };
  let fetched = 0, skipped = 0, failed = 0;

  for (let i = 0; i < allTiles.length; i++) {
    const tile = allTiles[i];
    const tileFile = `shdata/tiles/${tile.key}.osm`;

    if (progress[tile.key]) {
      skipped++;
      // 从缓存文件读取并合并
      if (existsSync(tileFile)) {
        const xml = readFileSync(tileFile, 'utf8');
        if (xml.length > 100) {
          const parsed = parseOSMXML(xml);
          for (const [k, v] of parsed.nodes) merged.nodes.set(k, v);
          for (const [k, v] of parsed.ways) merged.ways.set(k, v);
          for (const [k, v] of parsed.rels) merged.rels.set(k, v);
        }
      }
      continue;
    }

    process.stdout.write(`\r  [${i + 1}/${allTiles.length}] ${tile.strip} (${tile.s},${tile.w}) fetched=${fetched} skip=${skipped} fail=${failed}`);

    const ok = fetchTileCurl(tile, tileFile);
    if (ok && existsSync(tileFile)) {
      const xml = readFileSync(tileFile, 'utf8');
      if (xml.length > 100 && !xml.includes('too many nodes')) {
        progress[tile.key] = true;
        fetched++;
        const parsed = parseOSMXML(xml);
        for (const [k, v] of parsed.nodes) merged.nodes.set(k, v);
        for (const [k, v] of parsed.ways) merged.ways.set(k, v);
        for (const [k, v] of parsed.rels) merged.rels.set(k, v);
      } else {
        failed++;
        progress[tile.key] = 'failed';
      }
    } else {
      failed++;
    }

    // 每 20 个 tile 保存进度
    if (fetched % 20 === 0 && fetched > 0) {
      writeFileSync(progressFile, JSON.stringify(progress));
    }

    // 速率限制
    await new Promise(r => setTimeout(r, 300));
  }

  writeFileSync(progressFile, JSON.stringify(progress));

  console.log(`\n\nDone: fetched=${fetched} skipped=${skipped} failed=${failed}`);
  console.log(`Merged: nodes=${merged.nodes.size} ways=${merged.ways.size} relations=${merged.rels.size}`);

  // 保存合并后的 JSON
  const features = {
    nodes: [...merged.nodes.values()],
    ways: [...merged.ways.values()],
    relations: [...merged.rels.values()],
  };
  writeFileSync('shdata/strips_features.json', JSON.stringify(features));
  console.log(`Written shdata/strips_features.json (${(JSON.stringify(features).length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
