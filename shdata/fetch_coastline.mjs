// shdata/fetch_coastline.mjs — 抓取地图范围（含外扩余量）的 OSM 海岸线，写入 shdata/coastline.json
// 用法：node shdata/fetch_coastline.mjs [--bbox s,w,n,e]
// 只用 Overpass 的 natural=coastline（数据量很小），用于推导陆地多边形（见 coast.mjs）。
// 数据 © OpenStreetMap 贡献者（ODbL）。
'use strict';
import { writeFileSync } from 'fs';
import { PROJ } from './coast.mjs';

const GRID = { W: 432, H: 488 };
const MARGIN = 0.09;   // 经纬度外扩（约 8-10 km），让海岸线链伸出地图边界，闭合时不会切进图内

function mapBBox() {
  const latN = PROJ.lat0, latS = PROJ.lat0 - GRID.H / PROJ.ky;
  const lonW = PROJ.lon0, lonE = PROJ.lon0 + GRID.W / PROJ.kx;
  return [latS - MARGIN, lonW - MARGIN, latN + MARGIN, lonE + MARGIN];
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function query(bbox) {
  const q = `[out:json][timeout:90];way["natural"="coastline"](${bbox.map((v) => v.toFixed(4)).join(',')});out geom;`;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const url = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'CityAndMetro-GeoBuilder/1.0' },
        body: 'data=' + encodeURIComponent(q),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const ways = (json.elements || []).filter((e) => e.type === 'way' && e.geometry && e.geometry.length > 1);
      if (!ways.length) throw new Error('返回 0 条海岸线');
      return ways;
    } catch (e) {
      console.log(`  第 ${attempt} 次失败（${url}）：${e.message}`);
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    } finally { clearTimeout(timer); }
  }
  throw new Error('Overpass 多次失败，可稍后重试，或手动下载 Geofabrik 的 shanghai-latest.osm.pbf 后用 osmium 导出 coastline');
}

const argBBox = (function () {
  const i = process.argv.indexOf('--bbox');
  if (i < 0) return null;
  const v = (process.argv[i + 1] || '').split(',').map(Number);
  if (v.length !== 4 || v.some((n) => !isFinite(n))) throw new Error('--bbox 需要 s,w,n,e 四个数字');
  return v;
})();

const bbox = argBBox || mapBBox();
console.log('抓取海岸线 bbox =', bbox.map((v) => v.toFixed(4)).join(','));
const ways = await query(bbox);
const json = { source: 'OpenStreetMap via Overpass API', license: 'ODbL 1.0', bbox: bbox, ways: ways.map((w) => ({ id: w.id, geometry: w.geometry })) };
writeFileSync('shdata/coastline.json', JSON.stringify(json));
console.log(`写入 shdata/coastline.json：${ways.length} 条 way，${ways.reduce((s, w) => s + w.geometry.length, 0)} 个节点`);
