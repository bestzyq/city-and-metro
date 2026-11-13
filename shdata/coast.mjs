// 由 OSM 海岸线（natural=coastline）推导陆地多边形。
// 海岸线是「陆地永远在左侧」的定向折线：把 way 按端点缝合成链，开链沿端点切线外推到远处再闭合，
// 然后按绕数栅格化（陆地 = 绕数 > 0），沿格边描出轮廓并简化。
// 这样长江口、杭州湾、长兴/崇明一带的陆海就都来自真实海岸线，不再靠猜。

// v2.11：再向西扩 156 格（dx=156），lon0 西移到 120.8486，W 432；东/南边界不变
export const PROJ = { lon0: 120.8486, lat0: 31.7723, kx: 380.6, ky: 442.3 };

export function project(lat, lon, proj) {
  const p = proj || PROJ;
  return [(lon - p.lon0) * p.kx, (p.lat0 - lat) * p.ky];
}

// way → 链（保持 OSM 方向；不反转，因为左右决定陆海）
export function stitchChains(ways) {
  const key = function (g) { return g.lat.toFixed(7) + ',' + g.lon.toFixed(7); };
  const pool = ways.map(function (w) { return { pts: w.geometry.slice(), used: false }; });
  const chains = [];
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].used) continue;
    pool[i].used = true;
    const ch = pool[i].pts.slice();
    let changed = true;
    while (changed) {
      changed = false;
      for (const w of pool) {
        if (w.used || w.pts.length < 2) continue;
        const head = key(ch[0]), tail = key(ch[ch.length - 1]);
        if (key(w.pts[0]) === tail) { ch.push.apply(ch, w.pts.slice(1)); w.used = true; changed = true; }
        else if (key(w.pts[w.pts.length - 1]) === tail) { ch.push.apply(ch, w.pts.slice(0, -1).reverse()); w.used = true; changed = true; }
        else if (key(w.pts[w.pts.length - 1]) === head) { ch.unshift.apply(ch, w.pts.slice(0, -1)); w.used = true; changed = true; }
        else if (key(w.pts[0]) === head) { ch.unshift.apply(ch, w.pts.slice(1).reverse()); w.used = true; changed = true; }
      }
    }
    if (ch.length >= 2) chains.push(ch);
  }
  return chains;
}

const FAR = 1e5;

// 链 → 闭合环（格坐标）。开链把两个端点沿各自切线外推到远处再连起来。
export function chainsToRings(chains, proj) {
  const rings = [];
  for (const ch of chains) {
    const pts = ch.map(function (g) { return project(g.lat, g.lon, proj); });
    const closed = ch.length > 2 &&
      ch[0].lat.toFixed(7) === ch[ch.length - 1].lat.toFixed(7) &&
      ch[0].lon.toFixed(7) === ch[ch.length - 1].lon.toFixed(7);
    if (closed) { rings.push(pts); continue; }
    const a = pts[0], b = pts[1], e1 = pts[pts.length - 1], e2 = pts[pts.length - 2];
    const da = [a[0] - b[0], a[1] - b[1]], db = [e1[0] - e2[0], e1[1] - e2[1]];
    const la = Math.hypot(da[0], da[1]) || 1, lb = Math.hypot(db[0], db[1]) || 1;
    const out = [[a[0] + da[0] / la * FAR, a[1] + da[1] / la * FAR]];
    for (const p of pts) out.push(p);
    out.push([e1[0] + db[0] / lb * FAR, e1[1] + db[1] / lb * FAR]);
    rings.push(out);
  }
  return rings;
}

// 绕数栅格化：陆地 = 绕数 > 0（海岸线左侧为陆地）
export function windingMask(rings, W, H, S) {
  const FW = W * S, FH = H * S;
  const mask = new Uint8Array(FW * FH);
  const rows = new Map();
  for (const pts of rings) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const ay = a[1] * S, by = b[1] * S;
      if (ay === by) continue;
      const lo = Math.min(ay, by), hi = Math.max(ay, by);
      const y0 = Math.max(0, Math.ceil(lo - 0.5)), y1 = Math.min(FH - 1, Math.floor(hi - 0.5));
      for (let y = y0; y <= y1; y++) {
        const cy = y + 0.5;
        if (cy <= lo || cy > hi) continue;
        const x = (a[0] + (b[0] - a[0]) * (cy - ay) / (by - ay)) * S;
        const dir = by > ay ? 1 : -1;
        let arr = rows.get(y);
        if (!arr) { arr = []; rows.set(y, arr); }
        arr.push([x, dir]);
      }
    }
  }
  for (const [y, arr] of rows) {
    arr.sort(function (p, q) { return p[0] - q[0]; });
    let w = 0;
    for (let i = 0; i < arr.length; i++) {
      w += arr[i][1];
      const x0 = Math.max(0, Math.ceil(arr[i][0] - 0.5));
      const x1 = i + 1 < arr.length ? Math.min(FW - 1, Math.ceil(arr[i + 1][0] - 0.5) - 1) : FW - 1;
      if (w > 0 && x0 <= x1) mask.fill(1, y * FW + x0, y * FW + x1 + 1);
    }
  }
  return mask;
}

// 沿格边描出掩膜边界（4 邻接），返回格坐标（未除以 S）的环
export function traceRings(mask, W, H) {
  const FW = W, FH = H;
  const next = new Map();
  const push = function (x1, y1, x2, y2) {
    const k = x1 + ',' + y1;
    const list = next.get(k);
    if (list) list.push([x2, y2]); else next.set(k, [[x2, y2]]);
  };
  const at = function (x, y) { return (x >= 0 && y >= 0 && x < FW && y < FH) ? mask[y * FW + x] : 0; };
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    if (!mask[y * FW + x]) continue;
    if (!at(x, y - 1)) push(x, y, x + 1, y);
    if (!at(x + 1, y)) push(x + 1, y, x + 1, y + 1);
    if (!at(x, y + 1)) push(x + 1, y + 1, x, y + 1);
    if (!at(x - 1, y)) push(x, y + 1, x, y);
  }
  const rings = [];
  for (const startKey of Array.from(next.keys())) {
    while (next.get(startKey) && next.get(startKey).length) {
      const pts = [];
      const s = startKey.split(',');
      const sx = +s[0], sy = +s[1];
      let cx = sx, cy = sy;
      for (let guard = 0; guard < 2000000; guard++) {
        pts.push(cx, cy);
        const list = next.get(cx + ',' + cy);
        if (!list || !list.length) break;
        const nx = list.pop();
        cx = nx[0]; cy = nx[1];
        if (cx === sx && cy === sy) break;
      }
      if (pts.length >= 8) rings.push(pts);
    }
  }
  return rings;
}

export function ringArea(p) {
  let a = 0;
  const n = p.length / 2;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    a += p[2 * k] * p[2 * j + 1] - p[2 * j] * p[2 * k + 1];
  }
  return Math.abs(a / 2);
}

// 去共线点 + Douglas-Peucker（tol 与坐标同单位）
export function simplify(p, tol) {
  const n0 = p.length / 2;
  if (n0 <= 3) return p.slice();
  const thin = [];
  for (let i = 0; i < n0; i++) {
    const pi = (i + n0 - 1) % n0, ni = (i + 1) % n0;
    const px = p[2 * pi], py = p[2 * pi + 1], cx = p[2 * i], cy = p[2 * i + 1], nx = p[2 * ni], ny = p[2 * ni + 1];
    if ((cx - px) * (ny - cy) - (cy - py) * (nx - cx) !== 0) thin.push(cx, cy);
  }
  const cnt = thin.length / 2;
  if (cnt <= 3) return thin;
  const keep = new Uint8Array(cnt);
  keep[0] = 1; keep[cnt - 1] = 1;
  const stack = [[0, cnt - 1]];
  while (stack.length) {
    const seg = stack.pop(), a = seg[0], b = seg[1];
    const ax = thin[2 * a], ay = thin[2 * a + 1], bx = thin[2 * b], by = thin[2 * b + 1];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((thin[2 * i] - ax) * dy - (thin[2 * i + 1] - ay) * dx) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < cnt; i++) if (keep[i]) out.push(thin[2 * i], thin[2 * i + 1]);
  return out;
}

// 主入口：coastline ways → 陆地环（格坐标，1/1 单位）
export function coastlineLandRings(ways, opts) {
  const o = opts || {};
  const W = o.W, H = o.H, S = o.S == null ? 2 : o.S;
  const tol = o.tol == null ? 1.2 : o.tol;
  const minArea = o.minArea == null ? 3 : o.minArea;
  const rings = chainsToRings(stitchChains(ways), o.proj || PROJ);
  const mask = windingMask(rings, W, H, S);
  const traced = traceRings(mask, W * S, H * S);
  const out = [];
  for (const r of traced) {
    if (ringArea(r) / (S * S) < minArea) continue;
    const pts = new Array(r.length);
    for (let i = 0; i < r.length; i += 2) { pts[i] = r[i] / S; pts[i + 1] = r[i + 1] / S; }
    out.push(simplify(pts, tol / S));
  }
  return { rings: out, mask: mask, S: S };
}
