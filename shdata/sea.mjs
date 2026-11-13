// 海面（海域）多边形的拼装。
// 地图数据里没有「陆地多边形」，海域一直用奇偶填充技巧表示：海 = 整图矩形 − 陆地洞。
// 首选做法：用 OSM 海岸线（shdata/coastline.json，由 fetch_coastline.mjs 抓取）推导陆地环（见 coast.mjs）。
// 没有海岸线数据时退化为按地物反推：北面用地物闭包、南面用陆地地物包络、西面按陆地处理。
// 格网以 172×372 为准。

import { coastlineLandRings, traceRings, simplify, ringArea } from './coast.mjs';

export const GRID = { W: 432, H: 488 };
// 旧图（152×152）在新区格网中的范围：dx=20、dy=40，四周各留 2 格余量
export const OLD_BOX = [174, 154, 330, 310];   // 旧图范围：西扩 +156、北扩 +116

export function dec(s, from) {
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

export function enc(pts) {
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

function bboxOf(p) {
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < bb[0]) bb[0] = p[i];
    if (p[i + 1] < bb[1]) bb[1] = p[i + 1];
    if (p[i] > bb[2]) bb[2] = p[i];
    if (p[i + 1] > bb[3]) bb[3] = p[i + 1];
  }
  return bb;
}

// 从任意状态的海域环里取回旧图的陆地洞与岛屿洞（按几何特征识别，便于脚本反复运行）
export function extractOldLand(rings) {
  const inside = function (b) {
    return b[0] >= OLD_BOX[0] - 1 && b[1] >= OLD_BOX[1] - 1 && b[2] <= OLD_BOX[2] + 1 && b[3] <= OLD_BOX[3] + 1;
  };
  let land = null;
  const islands = [];
  for (const r of rings) {
    const p = dec(r.pts);
    if (p.length < 6) continue;
    const bb = bboxOf(p);
    if (!inside(bb)) continue;
    if (!land && bb[2] - bb[0] > OLD_BOX[2] - OLD_BOX[0] - 4 && bb[3] - bb[1] > OLD_BOX[3] - OLD_BOX[1] - 4 && p.length >= 200) land = p;
    else islands.push(p);
  }
  return land ? { land: land, islands: islands } : null;
}

// ---------------- 退化路径：地物 → 陆地 ----------------
function markLine(mask, W, H, p, flags) {
  if (flags & 3) return;   // 桥、隧穿水而建，不能当作陆地证据
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let t = 0; t <= n; t++) {
      const x = Math.floor(ax + (bx - ax) * t / n), y = Math.floor(ay + (by - ay) * t / n);
      if (x >= 0 && y >= 0 && x < W && y < H) mask[y * W + x] = 1;
    }
  }
}

function fillPoly(mask, W, H, p) {
  const n = p.length / 2;
  if (n < 3) return;
  const bb = bboxOf(p);
  const y0 = Math.max(0, Math.floor(bb[1])), y1 = Math.min(H - 1, Math.ceil(bb[3]));
  const ex = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * j], by = p[2 * j + 1];
    if (ay === by) continue;
    ex.push(ay < by ? [ay, by, ax, (bx - ax) / (by - ay)] : [by, ay, bx, (ax - bx) / (ay - by)]);
  }
  ex.sort(function (a, b) { return a[0] - b[0]; });
  const act = [], xs = [];
  let ei = 0;
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    while (ei < ex.length && ex[ei][0] <= cy) act.push(ex[ei++]);
    xs.length = 0;
    for (let k = act.length - 1; k >= 0; k--) {
      const e = act[k];
      if (e[1] <= cy) { act.splice(k, 1); continue; }
      if (e[0] <= cy) xs.push(e[2] + (cy - e[0]) * e[3]);
    }
    xs.sort(function (a, b) { return a - b; });
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      if (a <= b) mask.fill(1, y * W + a, y * W + b + 1);
    }
  }
}

function evidenceMask(geo, W, H) {
  const m = new Uint8Array(W * H);
  for (const r of geo.roads) markLine(m, W, H, dec(r[3]), r[2]);
  for (const r of geo.rail) markLine(m, W, H, dec(r[2]), r[1]);
  for (const r of geo.parks) fillPoly(m, W, H, dec(r[1], 1));
  for (const r of geo.woods) fillPoly(m, W, H, dec(r[1], 1));
  if (typeof geo.streets === 'string' && geo.streets) {
    for (const s of geo.streets.split('!')) if (s) markLine(m, W, H, dec(s), 0);
  }
  return m;
}

function distanceField(mask, W, H) {
  const INF = 1e9, d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  const D1 = 1, D2 = 1.4142;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + D1);
    if (y > 0) { v = Math.min(v, d[i - W] + D1); if (x > 0) v = Math.min(v, d[i - W - 1] + D2); if (x < W - 1) v = Math.min(v, d[i - W + 1] + D2); }
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; let v = d[i];
    if (x < W - 1) v = Math.min(v, d[i + 1] + D1);
    if (y < H - 1) { v = Math.min(v, d[i + W] + D1); if (x < W - 1) v = Math.min(v, d[i + W + 1] + D2); if (x > 0) v = Math.min(v, d[i + W - 1] + D2); }
    d[i] = v;
  }
  return d;
}

// 北条带陆地（退化路径）：地物闭包，只取 y ≤ clipY 的部分
export function northLandRings(geo, opts) {
  const o = opts || {}, W = o.W || GRID.W, H = o.H || GRID.H;
  const R = o.R == null ? 4 : o.R, clipY = o.clipY == null ? OLD_BOX[1] : o.clipY;
  const mask = new Uint8Array(W * H);
  const d = distanceField(evidenceMask(geo, W, H), W, H);
  for (let y = 0; y < Math.min(H, Math.round(clipY)); y++) for (let x = 0; x < W; x++) if (d[y * W + x] <= R) mask[y * W + x] = 1;
  return traceRings(mask, W, H).filter(function (r) { return ringArea(r) >= 4; }).map(function (r) { return simplify(r, 0.8); });
}

// 南条带岸线（退化路径）：逐列取陆地地物的最南端，取分位数抑制码头等离群点
export function southCoastLine(geo, opts) {
  const o = opts || {}, W = o.W || GRID.W, H = o.H || GRID.H;
  const margin = o.margin == null ? 2 : o.margin, step = o.step || 6, win = o.win || 7;
  const best = new Float32Array(W).fill(-Infinity);
  const add = function (p, flags) {
    if (flags & 3) return;
    for (let i = 0; i + 1 < p.length; i += 2) {
      const x = Math.round(p[i]), y = p[i + 1];
      if (x < 0 || x >= W || y <= OLD_BOX[3] || y >= H) continue;
      if (y > best[x]) best[x] = y;
    }
  };
  for (const r of geo.roads) add(dec(r[3]), r[2]);
  for (const r of geo.rail) add(dec(r[2]), r[1]);
  for (const r of geo.parks) add(dec(r[1], 1), 0);
  for (const r of geo.woods) add(dec(r[1], 1), 0);
  const sample = [];
  for (let x = 0; x < W; x += step) {
    const win2 = [];
    for (let k = x - win; k <= x + win; k++) if (k >= 0 && k < W && best[k] > -Infinity) win2.push(best[k]);
    if (!win2.length) { sample.push(null); continue; }
    win2.sort(function (a, b) { return a - b; });
    sample.push(win2[Math.min(win2.length - 1, Math.floor(win2.length * 0.7))]);
  }
  const clean = [];
  for (let i = 0; i < sample.length; i++) {
    let v = sample[i];
    if (v == null) {
      let a = i - 1, b = i + 1;
      while ((a >= 0 && sample[a] == null) && b < sample.length) { a--; b++; }
      v = sample[i - 1] != null ? sample[i - 1] : (sample[b] != null ? sample[b] : null);
      if (v == null) continue;
    }
    clean.push([i * step, Math.min(H - 2, v + margin)]);
  }
  if (!clean.length) return [];
  if (clean[0][0] > 0) clean.unshift([0, clean[0][1]]);
  const last = clean[clean.length - 1];
  if (last[0] < W - 1) clean.push([W - 1, last[1]]);
  return clean;
}

// 返回 [{ tag:'o'|'i', pts:[x0,y0,…] }, …]
export function seaRings(opts) {
  const o = opts || {};
  const W = o.W || GRID.W, H = o.H || GRID.H, M = o.margin == null ? 4 : o.margin;
  const rings = [];
  rings.push({ tag: 'o', pts: [-M, -M, W + M, -M, W + M, H + M, -M, H + M] });   // 整图矩形（默认全是海）

  // 首选：真实海岸线推导的陆地
  if (o.coast && o.coast.length) {
    const land = coastlineLandRings(o.coast, { W: W, H: H, S: o.S || 2, tol: o.tol });
    for (const p of land.rings) rings.push({ tag: 'i', pts: p });
    return rings;
  }

  // 退化：沿用旧图陆地/岛屿 + 地物反推
  const ox0 = OLD_BOX[0], oy0 = OLD_BOX[1], oy1 = OLD_BOX[3];
  for (const p of o.landRings || []) rings.push({ tag: 'i', pts: p });
  for (const p of o.islandRings || []) rings.push({ tag: 'i', pts: p });
  rings.push({ tag: 'i', pts: [-M, oy0, ox0, oy0, ox0, oy1, -M, oy1] });          // 西侧（安亭方向）
  if (o.geo) {
    const coast = southCoastLine(o.geo, { W: W, H: H });
    if (coast.length >= 2) {
      const pts = [-M, oy1, -M, coast[0][1]];
      for (const p of coast) pts.push(p[0], p[1]);
      pts.push(W + M, coast[coast.length - 1][1], W + M, oy1);
      rings.push({ tag: 'i', pts: pts });
    }
    for (const p of northLandRings(o.geo, { W: W, H: H, clipY: oy0 })) rings.push({ tag: 'i', pts: p });
  }
  return rings;
}

