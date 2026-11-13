// shdata/pbf.mjs — 极简 OSM PBF 读取（只依赖 Node 内置 zlib）
// PBF = 若干 Blob（4 字节大端头长度 + BlobHeader + Blob，zlib 压缩的 PrimitiveBlock）。
// 只解析游戏需要的部分：节点（含标签）、way（含节点引用与标签）、relation（成员与标签）。
'use strict';
import { readFileSync } from 'fs';
import { inflateSync } from 'zlib';

// ---------- protobuf 基础 ----------
function varint(buf, pos) {
  let result = 0, shift = 0, b;
  do {
    b = buf[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return [result, pos];
}

function zigzag(v) {
  return (v % 2 === 1) ? -(v + 1) / 2 : v / 2;
}

function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = varint(buf, pos);
    const field = key >>> 3, wire = key & 7;
    if (wire === 0) { let v; [v, pos] = varint(buf, pos); out.push([field, 0, v]); }
    else if (wire === 1) { out.push([field, 1, buf.subarray(pos, pos + 8)]); pos += 8; }
    else if (wire === 2) {
      let len; [len, pos] = varint(buf, pos);
      out.push([field, 2, buf.subarray(pos, pos + len)]);
      pos += len;
    } else if (wire === 5) { out.push([field, 5, buf.subarray(pos, pos + 4)]); pos += 4; }
    else throw new Error('未知 wire type ' + wire);
  }
  return out;
}

function packedVarints(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) { let v; [v, pos] = varint(buf, pos); out.push(v); }
  return out;
}

function asString(buf) { return buf.toString('utf8'); }

// ---------- Blob 层 ----------
export function* blobs(file) {
  const buf = readFileSync(file);
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const headLen = buf.readUInt32BE(pos); pos += 4;
    const head = fields(buf.subarray(pos, pos + headLen)); pos += headLen;
    let type = '', datasize = 0;
    for (const [f, , v] of head) {
      if (f === 1) type = asString(v);
      else if (f === 3) datasize = v;
    }
    const blobBuf = buf.subarray(pos, pos + datasize); pos += datasize;
    if (type !== 'OSMData') continue;
    let raw = null, size = 0;
    for (const [f, , v] of fields(blobBuf)) {
      if (f === 1) raw = v;
      else if (f === 2) size = v;
      else if (f === 3) raw = inflateSync(v, { finishFlush: 2 });
    }
    if (raw) yield size ? raw.subarray(0, size) : raw;
  }
}

// ---------- PrimitiveBlock ----------
export function parseBlock(buf) {
  const strings = [];
  const groups = [];
  let granularity = 100, latOffset = 0, lonOffset = 0;
  for (const [f, , v] of fields(buf)) {
    if (f === 1) { for (const [sf, , sv] of fields(v)) if (sf === 1) strings.push(asString(sv)); }
    else if (f === 2) groups.push(v);
    else if (f === 17) granularity = v;
    else if (f === 19) latOffset = v;
    else if (f === 20) lonOffset = v;
  }
  const nodes = [], ways = [], rels = [];
  const coord = function (raw, offset) { return 1e-9 * (offset + granularity * raw); };
  for (const g of groups) {
    for (const [f, , v] of fields(g)) {
      if (f === 1) {   // Node（非 dense）
        let id = 0, lat = 0, lon = 0; const keys = [], vals = [];
        for (const [sf, , sv] of fields(v)) {
          if (sf === 1) id = zigzag(sv);
          else if (sf === 8) lat = zigzag(sv);
          else if (sf === 9) lon = zigzag(sv);
          else if (sf === 2) keys.push.apply(keys, packedVarints(sv));
          else if (sf === 3) vals.push.apply(vals, packedVarints(sv));
        }
        nodes.push({ id: id, lat: coord(lat, latOffset), lon: coord(lon, lonOffset), keys: keys, vals: vals });
      } else if (f === 2) {   // DenseNodes
        let ids = [], lats = [], lons = [], kv = [];
        for (const [sf, , sv] of fields(v)) {
          if (sf === 1) ids = packedVarints(sv).map(zigzag);
          else if (sf === 8) lats = packedVarints(sv).map(zigzag);
          else if (sf === 9) lons = packedVarints(sv).map(zigzag);
          else if (sf === 10) kv = packedVarints(sv);
        }
        let id = 0, lat = 0, lon = 0, k = 0;
        for (let i = 0; i < ids.length; i++) {
          id += ids[i]; lat += lats[i]; lon += lons[i];
          const keys = [], vals = [];
          if (kv.length) {
            while (k < kv.length && kv[k] !== 0) { keys.push(kv[k]); vals.push(kv[k + 1]); k += 2; }
            k++;
          }
          nodes.push({ id: id, lat: coord(lat, latOffset), lon: coord(lon, lonOffset), keys: keys, vals: vals });
        }
      } else if (f === 3) {   // Way
        let id = 0, refs = []; const keys = [], vals = [];
        for (const [sf, , sv] of fields(v)) {
          if (sf === 1) id = sv;
          else if (sf === 2) keys.push.apply(keys, packedVarints(sv));
          else if (sf === 3) vals.push.apply(vals, packedVarints(sv));
          else if (sf === 8) {
            refs = packedVarints(sv).map(zigzag);
            let acc = 0;
            for (let i = 0; i < refs.length; i++) { acc += refs[i]; refs[i] = acc; }
          }
        }
        ways.push({ id: id, refs: refs, keys: keys, vals: vals });
      } else if (f === 4) {   // Relation
        let id = 0; const roles = [], memids = [], types = [], keys = [], vals = [];
        for (const [sf, , sv] of fields(v)) {
          if (sf === 1) id = sv;
          else if (sf === 2) keys.push.apply(keys, packedVarints(sv));
          else if (sf === 3) vals.push.apply(vals, packedVarints(sv));
          else if (sf === 8) roles.push.apply(roles, packedVarints(sv));
          else if (sf === 9) {
            const d = packedVarints(sv).map(zigzag);
            let acc = 0;
            for (const x of d) { acc += x; memids.push(acc); }
          } else if (sf === 10) types.push.apply(types, packedVarints(sv));
        }
        rels.push({ id: id, roles: roles, memids: memids, types: types, keys: keys, vals: vals });
      }
    }
  }
  return { strings: strings, nodes: nodes, ways: ways, rels: rels };
}

function tagOf(rec, strings) {
  const t = {};
  for (let i = 0; i < rec.keys.length; i++) t[strings[rec.keys[i]]] = strings[rec.vals[i]];
  return t;
}

// 读取整个 PBF：bbox = [south, west, north, east]（含外扩），返回带标签的要素
export function readOSM(file, bbox, opts) {
  const o = opts || {};
  const [s, w, n, e] = bbox;
  const inside = function (lat, lon) { return lat >= s && lat <= n && lon >= w && lon <= e; };
  const nodeLat = new Map();   // id → lat（只存在 bbox 内的，用于 way 裁剪）
  const nodeLon = new Map();
  const ways = [];
  const rels = [];
  for (const block of blobs(file)) {
    const { strings, nodes, ways: ws, rels: rs } = parseBlock(block);
    for (const nd of nodes) {
      if (!inside(nd.lat, nd.lon)) continue;
      nodeLat.set(nd.id, nd.lat);
      nodeLon.set(nd.id, nd.lon);
      if (o.onNode && nd.keys.length) o.onNode(nd.id, nd.lat, nd.lon, tagOf(nd, strings));
    }
    for (const wy of ws) {
      let hit = false;
      for (const r of wy.refs) if (nodeLat.has(r)) { hit = true; break; }
      if (!hit) continue;
      const tags = tagOf(wy, strings);
      if (!Object.keys(tags).length && !o.keepUntagged) continue;
      ways.push({ id: wy.id, refs: wy.refs, tags: tags });
    }
    for (const rl of rs) {
      const tags = tagOf(rl, strings);
      if (!Object.keys(tags).length) continue;
      const members = [];
      for (let i = 0; i < rl.memids.length; i++) members.push({ type: rl.types[i], ref: rl.memids[i], role: strings[rl.roles[i]] || '' });
      rels.push({ id: rl.id, members: members, tags: tags });
    }
  }
  return { nodes: { lat: nodeLat, lon: nodeLon }, ways: ways, rels: rels };
}
