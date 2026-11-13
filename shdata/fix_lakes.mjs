// shdata/fix_lakes.mjs — 用 Overpass 补齐跨界的湖泊岸线（PBF 是上海专版，淀山湖的岸线有半环在江苏，缝合失败会被丢弃）
// 用法：node shdata/fix_lakes.mjs [--refresh]
// 缓存：shdata/lakes.json（首次或 --refresh 时抓取；已加入 .gitignore）
// 说明：只追加水面要素（natural=water 的 relation），不触碰其它数据；可重复运行（同名且同点数的要素会跳过）。
'use strict';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { enc } from './sea.mjs';
import { PROJ } from './coast.mjs';

const GRID = { W: 432, H: 488 };
const LAKES = ['淀山湖', '元荡'];
const CACHE = 'shdata/lakes.json';

async function fetchLakes() {
  const out = [];
  for (const name of LAKES) {
    const q = `[out:json][timeout:60];rel["natural"="water"]["name"="${name}"];out geom;`;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'CityAndMetro-GeoBuilder/1.0' },
          body: 'data=' + encodeURIComponent(q),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const rels = (json.elements || []).filter((e) => e.type === 'relation' && e.members);
        if (!rels.length) { console.log('  %s：Overpass 无结果，跳过', name); break; }
        out.push({ name: name, rels: rels });
        console.log('  %s：%d 个关系，成员 %d', name, rels.length, rels.reduce((s, r) => s + r.members.length, 0));
        break;
      } catch (e) {
        console.log('  第 %d 次失败（%s）：%s', attempt, name, e.message);
        await new Promise((r) => setTimeout(r, 4000 * attempt));
      }
    }
  }
  writeFileSync(CACHE, JSON.stringify(out));
  return out;
}

// 成员 way 缝合成环（端点精确匹配），保持方向
function stitch(members) {
  const segs = members.filter((m) => m.type === 'way' && m.geometry && m.geometry.length > 1)
    .map((m) => ({ role: m.role || 'outer', pts: m.geometry.slice() }));
  const key = (g) => g.lat.toFixed(7) + ',' + g.lon.toFixed(7);
  const rings = [];
  const used = new Array(segs.length).fill(false);
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const role = segs[i].role;
    let ring = segs[i].pts.slice();
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < segs.length; j++) {
        if (used[j] || segs[j].role !== role) continue;
        const s = segs[j].pts, head = key(ring[0]), tail = key(ring[ring.length - 1]);
        if (key(s[0]) === tail) { ring = ring.concat(s.slice(1)); used[j] = true; grew = true; }
        else if (key(s[s.length - 1]) === tail) { ring = ring.concat(s.slice(0, -1).reverse()); used[j] = true; grew = true; }
        else if (key(s[s.length - 1]) === head) { ring = s.slice(0, -1).concat(ring); used[j] = true; grew = true; }
        else if (key(s[0]) === head) { ring = s.slice(1).reverse().concat(ring); used[j] = true; grew = true; }
        if (grew) break;
      }
    }
    if (ring.length >= 4) rings.push({ role: role, pts: ring });
  }
  return rings;
}

const lakes = (!existsSync(CACHE) || process.argv.includes('--refresh')) ? await fetchLakes() : JSON.parse(readFileSync(CACHE, 'utf8'));

const path = 'js/geo_sh.js';
const text = readFileSync(path, 'utf8');
const start = text.indexOf('.sh = ') + '.sh = '.length;
const end = text.indexOf(';', start);
const geo = JSON.parse(text.slice(start, end));
const names = geo.names;

let added = 0, skipped = 0;
for (const lake of lakes) {
  for (const rel of lake.rels) {
    const rings = stitch(rel.members);
    const outs = rings.filter((r) => r.role !== 'inner');
    const ins = rings.filter((r) => r.role === 'inner');
    if (!outs.length) { console.log('  %s：未能闭合，跳过', lake.name); continue; }
    let ni = names.indexOf(lake.name);
    if (ni < 0) { names.push(lake.name); ni = names.length - 1; }
    const already = geo.water.some((r) => r[0] === ni && typeof r[1] !== 'number');
    if (already && !process.argv.includes('--force')) { skipped++; continue; }
    const row = [ni];
    const proj = (g) => { const x = (g.lon - PROJ.lon0) * PROJ.kx, y = (PROJ.lat0 - g.lat) * PROJ.ky; return [x, y]; };
    for (const r of outs) row.push('o' + enc([].concat.apply([], r.pts.map(proj))));
    for (const r of ins) row.push('i' + enc([].concat.apply([], r.pts.map(proj))));
    geo.water.push(row);
    added++;
    console.log('  加入 %s：外环 %d、内环 %d', lake.name, outs.length, ins.length);
  }
}
if (added) writeFileSync(path, text.slice(0, start) + JSON.stringify(geo) + text.slice(end));
console.log('完成：新增 %d 个水面要素，跳过 %d 个已存在', added, skipped);
void GRID;
