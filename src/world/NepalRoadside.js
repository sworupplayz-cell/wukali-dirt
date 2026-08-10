import { hash01 } from './noise.js';
import { CITIES } from './NepalBlueprint.js';

/**
 * NepalRoadside (Phase W-3F) — infrastructure along the planned Nepal road
 * network: bridges at river crossings, guardrails on drop-offs, route
 * signs, utility poles, bus stops, fuel stations, roadside rest areas and
 * scenic viewpoints.
 *
 * NEPAL MODE ONLY. Everything reuses the existing instanced prop pipeline:
 * items stream through ChunkManager's settlement `inject()` (props +
 * colliders + clearings), grouped per chunk. Placement is a pure function
 * of route node indices + fixed hashes — deterministic forever.
 *
 * Bridges: crossings are detected against the water module's river
 * channels; each gets a terrain deck pin (registered into NepalRoads so
 * the ground itself spans the river at water level + clearance) plus
 * visual deck planks and rail fences. The deck IS terrain: rideable,
 * seamlessly aligned with both the road and the river surface.
 * Guardrails and signs never collide (collR 0 / tiny) — nothing blocks
 * the bike.
 */

const SALT = 90210;

export class NepalRoadside {
  constructor(gen, macro, roads, water) {
    this.gen = gen;

    // ---- Bridges: where routes cross river channels ------------------------
    const bridges = [];
    for (const route of roads.routes) {
      let lastB = -1e9;
      for (let i = 0; i < route.pts.length - 1; i++) {
        const a = route.pts[i], b = route.pts[i + 1];
        const segLen = Math.hypot(b.x - a.x, b.z - a.z);
        for (let t = 0; t < 1; t += 24 / Math.max(24, segLen)) {
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          // Nearest river channel + width at this point.
          let best = Infinity, bw = 0, bLevel = 0;
          for (const segs of water.rivers) {
            for (const s of segs) {
              const apx = x - s.ax, apz = z - s.az;
              let tt = (apx * (s.bx - s.ax) + apz * (s.bz - s.az)) / s.len2;
              if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
              const cpx = s.ax + (s.bx - s.ax) * tt, cpz = s.az + (s.bz - s.az) * tt;
              const d = Math.hypot(x - cpx, z - cpz);
              if (d < best) {
                best = d;
                bw = s.wA + (s.wB - s.wA) * tt;
                bLevel = macro._macro(cpx, cpz, { h: 0, mul: 1 }).h + 0.9;
              }
            }
          }
          if (best < bw * 0.8) {
            const gx = x, gz = z;
            const d2last = Math.hypot(gx - lastB, 0);
            if (Math.abs(gx + gz - lastB) < 120) continue; // one bridge per crossing
            lastB = gx + gz;
            const len = Math.min(46, bw * 2.2 + 10);
            const dx = (b.x - a.x) / segLen, dz = (b.z - a.z) / segLen;
            bridges.push({ x: gx, z: gz, dx, dz, len, deckH: bLevel + 1.3,
              routeKind: route.kind });
            break;
          }
        }
      }
    }
    // W-3J-S safety net: any node where river water still stands over the
    // roadbed (crossings the transverse detector missed, or stretches that
    // run along a channel) gets a causeway deck — same terrain-pin
    // mechanism, so the road surface rises above the water everywhere.
    {
      const scr = { y: 0, foam: 0, inWater: false };
      for (const route of roads.routes) {
        let lastX = 1e9, lastZ = 1e9;
        for (let i = 1; i < route.pts.length - 1; i++) {
          const p = route.pts[i];
          const h = gen.height(p.x, p.z);
          water._riverLevel(p.x, p.z, scr);
          if (!(scr.inWater && scr.y > h + 0.3)) continue;
          if (Math.hypot(p.x - lastX, p.z - lastZ) < 70) continue;
          lastX = p.x; lastZ = p.z;
          const q = route.pts[i + 1];
          const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
          bridges.push({ x: p.x, z: p.z, dx: (q.x - p.x) / len, dz: (q.z - p.z) / len,
            len: 42, deckH: scr.y + 1.2, routeKind: route.kind });
        }
      }
    }
    roads.addBridges(bridges);
    this.bridges = bridges;

    // ---- Roadside items, indexed per 64 m chunk ----------------------------
    this._byChunk = new Map();
    const recFor = (x, z, r = -22) => {
      const key = Math.floor(x / 64) * 100003 + Math.floor(z / 64);
      let arr = this._byChunk.get(key);
      if (!arr) this._byChunk.set(key, (arr = []));
      if (r < 0) { // shared infra rec (no clearing)
        let rec = arr.find((q) => q.r === -22);
        if (!rec) arr.push((rec = { id: `R${key}`, x, z, r: -22, items: [] }));
        return rec;
      }
      const rec = { id: `S${key}-${arr.length}`, x, z, r, items: [] };
      arr.push(rec);
      return rec;
    };
    const put = (x, z, item) => recFor(x, z).items.push(item);
    const it = (type, x, z, yaw, s = 1, collR = 0, sink = 0.2) =>
      ({ type, x, z, yaw, s, collR, sink });
    const info = { h: 0, wH: 0, wF: 0, wFa: 0, wRk: 0, wMnt: 0, lo: 0, trail: 0, stream: 0,
      terr: 0, jit: 0, dry: 0, mtn: 0, mtnH: 0, mtnKind: 0, mtnRef: null, snowOff: 0 };
    const slopeOk = (x, z, lim) => {
      const sl = Math.abs(gen.height(x + 3, z) - gen.height(x - 3, z)) +
                 Math.abs(gen.height(x, z + 3) - gen.height(x, z - 3));
      return sl < lim;
    };
    const infraOk = (x, z) =>
      slopeOk(x, z, 0.6) && !water.submerged(x, z, gen.height(x, z));
    // W-3K: house size variants baked at generation time (same hash the
    // inject pass used) so the separation registry sees TRUE dimensions.
    const houseVar = (x, z) => {
      const hs = hash01(Math.round(x * 3), Math.round(z * 3), 20 * 37 + 91);
      return hs < 0.3 ? 0.85 : hs < 0.65 ? 1.0 : hs < 0.9 ? 1.15 : 1.3;
    };
    const thVar = (x, z) => {
      const hs = hash01(Math.round(x * 3), Math.round(z * 3), 20 * 37 + 91);
      return hs < 0.5 ? 0.95 : 1.08;
    };
    // W-3K: building separation registry — no overlapping structures, ever.
    const bGrid = new Map();
    const bKey = (x, z) => Math.floor(x / 32) * 100003 + Math.floor(z / 32);
    const bClear = (x, z, rad) => {
      for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
        const cell = bGrid.get(bKey(x + gx * 32, z + gz * 32));
        if (!cell) continue;
        for (const b of cell) {
          if (Math.hypot(x - b.x, z - b.z) < (rad + b.r) * 0.85) return false;
        }
      }
      return true;
    };
    const bAdd = (x, z, rad) => {
      const k = bKey(x, z);
      let cell = bGrid.get(k);
      if (!cell) bGrid.set(k, (cell = []));
      cell.push({ x, z, r: rad });
    };

    for (const route of roads.routes) {
      const hw = route.kind === 'highway';
      const pts = route.pts;
      for (let i = 1; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        const dx = (q.x - p.x) / len, dz = (q.z - p.z) / len;
        const px = -dz, pz = dx;                      // road-perpendicular
        const side = (i & 1) ? 1 : -1;
        const yawR = Math.atan2(dx, dz);
        const h = hash01(i, Math.round(p.x * 0.01), SALT + 1);
        const off = route.w + 2.6;

        // Guardrails where the road edge drops away (mountain drop-offs).
        for (const s of [-1, 1]) {
          const ex = p.x + px * s * (route.w + 1.8), ez = p.z + pz * s * (route.w + 1.8);
          const drop = this.gen.height(p.x, p.z) -
                       this.gen.height(ex + px * s * 8, ez + pz * s * 8);
          if (drop > 3.0) {
            for (const u of [-6.5, 0, 6.5]) {
              const fx = ex + dx * u, fz = ez + dz * u;
              // fence panels extend along local X: align with the road.
              // Skip watery ground — causeway decks carry their own rails.
              if (water.submerged(fx, fz, gen.height(fx, fz))) continue;
              put(fx, fz, it('fence', fx, fz, yawR - Math.PI / 2, 0.8, 0, 0.3));
            }
          }
        }
        // Route markers/signs every ~9 nodes; poles on highways every 5.
        if (i % 9 === 4) {
          const gx = p.x + px * side * off, gz = p.z + pz * side * off;
          if (infraOk(gx, gz)) put(gx, gz, it('roadsign', gx, gz, yawR, 1, 0.2, 0.1));
        }
        if (hw && i % 5 === 2) {
          const gx = p.x + px * -side * (off + 0.8), gz = p.z + pz * -side * (off + 0.8);
          if (infraOk(gx, gz)) put(gx, gz, it('poleN', gx, gz, yawR, 1, 0.3, 0.3));
        }
        // Bus stops on highways every ~22 nodes.
        if (hw && i % 22 === 11 && h < 0.8) {
          const bx = p.x + px * side * (off + 1.2), bz = p.z + pz * side * (off + 1.2);
          if (infraOk(bx, bz) && bClear(bx, bz, 2.4)) {
            bAdd(bx, bz, 2.4);
            put(bx, bz, it('busstopN', bx, bz, yawR + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 1, 0.5, 0.2));
          }
        }
        // Fuel stations every ~37 highway nodes.
        if (hw && i % 37 === 18 && h < 0.7) {
          const fx = p.x + px * side * (off + 8), fz = p.z + pz * side * (off + 8);
          if (infraOk(fx, fz) && bClear(fx, fz, 7)) {
            bAdd(fx, fz, 7);
            put(fx, fz, it('fuelN', fx, fz, yawR + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 1, 2.0, 0.2));
            put(fx, fz, it('parklot', fx + px * side * 6, fz + pz * side * 6, yawR, 1, 0, 0.12));
          }
        }
        // Rest areas (chiya pasal + parking) every ~29 nodes.
        if (i % 29 === 7 && h < 0.6) {
          const rx = p.x + px * side * (off + 5.5), rz = p.z + pz * side * (off + 5.5);
          if (infraOk(rx, rz) && bClear(rx, rz, 3.2)) {
            bAdd(rx, rz, 3.2);
            put(rx, rz, it('teashopN', rx, rz, yawR + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 1, 2.6, 0.2));
            put(rx, rz, it('parklot', rx + dx * 9, rz + dz * 9, yawR, 1, 0, 0.12));
          }
        }
        // Scenic viewpoints: mountain nodes standing proud of their neighbors.
        if (!hw && i % 13 === 6) {
          const prom = p.h - (pts[i - 1].h + pts[i + 1].h) * 0.5 +
            (p.h - this.gen.macro._macro(p.x + px * side * 60, p.z + pz * side * 60,
              { h: 0, mul: 1 }).h) * 0.25;
          if (prom > 3) {
            const vx = p.x + px * side * (off + 3.5), vz = p.z + pz * side * (off + 3.5);
            put(vx, vz, it('flagpole', vx, vz, yawR, 1, 0.3, 0.15));
            put(vx, vz, it('flagpole', vx + dx * 4, vz + dz * 4, yawR + 0.5, 1, 0.3, 0.15));
            put(vx, vz, it('wall', vx + px * side * 2.2, vz + pz * side * 2.2, yawR, 1.1, 0, 0.15));
            put(vx, vz, it('parklot', vx - px * side * 4, vz - pz * side * 4, yawR, 1, 0, 0.12));
          }
        }
      }
    }
    // ---- W-3H: settlement hierarchy ----------------------------------------
    // Anchors (the six blueprint cities) → towns → villages, placed along
    // the roads with believable spacing; the W-3G hamlet pass below fills
    // the rural gaps and thickens near towns (gradual rural → urban).
    // No detailed city cores yet — anchors are large town-scale fields.
    this.settlements = [];
    const nearSettlement = (x, z, minD) => {
      for (const s of this.settlements) {
        if (Math.hypot(x - s.x, z - s.z) < Math.max(minD, s.r * 0.5 + minD * 0.5)) return true;
      }
      return false;
    };
    const spotOk = (x, z, slopeLim = 0.55) => {
      if (!slopeOk(x, z, slopeLim)) return false;
      if (water.submerged(x, z, gen.height(x, z))) return false;
      if (roads.query(x, z).mask > 0.25) return false;
      gen.masksAt(x, z, info);
      return info.trail < 0.3 && info.stream < 0.3 && info.mtn < 0.02;
    };
    const hCls = (x, z) => {
      const h = hash01(Math.round(x * 3), Math.round(z * 3), SALT + 41);
      return h < 0.35 ? 0.9 : h < 0.7 ? 1.0 : 1.1; // townhouseN is real-scale
    };
    const SVC_S = { schoolN: 1, clinicN: 1, shopN: 1, teashopN: 1, stall: 1.2,
      fuelN: 1, stupa: 1.2, busstopN: 1, parklot: 1.3, wall: 1.1, flagpole: 1 };
    const SVC_R = { schoolN: 7.5, clinicN: 4.6, shopN: 3.4, teashopN: 2.6, stall: 1.2,
      fuelN: 2.0, stupa: 1.1, busstopN: 0.5, parklot: 0, wall: 0.9, flagpole: 0.3 };
    /** Lay a settlement strip along `route` starting at node i0. */
    const buildSettlement = (route, i0, kind, cfg) => {
      const pts = route.pts;
      const iEnd = Math.min(pts.length - 2, i0 + cfg.spanNodes);
      const c = pts[(i0 + iEnd) >> 1];
      let placedH = 0, placedS = 0;
      const sList = cfg.services.slice();
      const nodeBudget = Math.ceil(cfg.maxH / (cfg.spanNodes + 1));
      for (let i = i0; i <= iEnd; i++) {
        let nodeH = 0;
        const p = pts[i], q = pts[i + 1];
        const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        const dx = (q.x - p.x) / len, dz = (q.z - p.z) / len;
        const px = -dz, pz = dx;
        const yawR = Math.atan2(dx, dz);
        const nPer = Math.ceil(len / cfg.sp);
        for (let k = 0; k < nPer; k++) {
          const along = (k + 0.5) / nPer;
          for (const side of [-1, 1]) {
            for (let row = 0; row < cfg.rows; row++) {
              if (placedH >= cfg.maxH || nodeH >= nodeBudget) break;
              const hh = hash01(i * 31 + k * 7 + row * 3 + side + 1,
                Math.round(p.x * 0.01), SALT + 43);
              if (hh > cfg.density) continue;
              const off = route.w + 13 + row * 14 + hh * 3; // real setbacks
              const hx = p.x + dx * along * len + px * side * off;
              const hz = p.z + dz * along * len + pz * side * off;
              if (!spotOk(hx, hz)) continue;
              const rec = recFor(hx, hz, 20);
              const yawFace = yawR + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
              const pickT = hash01(Math.round(hx), Math.round(hz), SALT + 47);
              const typ = kind === 'hamlet' || pickT < cfg.plainHouse ? 'houseN' : 'townhouseN';
              const sB = typ === 'houseN' ? houseVar(hx, hz) : hCls(hx, hz) * thVar(hx, hz);
              const rB = (typ === 'houseN' ? 4.3 : 4.6) * sB;
              if (!bClear(hx, hz, rB)) continue;
              bAdd(hx, hz, rB);
              rec.items.push(it(typ, hx, hz, yawFace, sB,
                typ === 'houseN' ? 4.3 : 4.6, 0.28));
              placedH++;
              nodeH++;
            }
          }
        }
        // Services face the road near the settlement middle.
        if (sList.length && Math.abs(i - ((i0 + iEnd) >> 1)) <= 2) {
          while (sList.length && placedS < cfg.services.length) {
            const typ = sList.shift();
            const side = (placedS & 1) ? -1 : 1;
            const sx = p.x + px * side * (route.w + 9) + dx * placedS * 13;
            const sz = p.z + pz * side * (route.w + 9) + dz * placedS * 13;
            if (spotOk(sx, sz, 0.5) && bClear(sx, sz, (SVC_R[typ] || 2.2) * (SVC_S[typ] || 1))) {
              bAdd(sx, sz, (SVC_R[typ] || 2.2) * (SVC_S[typ] || 1));
              const rec = recFor(sx, sz, 16);
              rec.items.push(it(typ, sx, sz,
                Math.atan2(dx, dz) + (side > 0 ? -Math.PI / 2 : Math.PI / 2),
                SVC_S[typ] || 1, SVC_R[typ] !== undefined ? SVC_R[typ] : 2.2, 0.2));
              placedS++;
            } else {
              placedS++;
            }
          }
        }
      }
      if (placedH >= cfg.minH) {
        this.settlements.push({ kind, x: c.x, z: c.z, r: cfg.spanNodes * 55, houses: placedH });
        return true;
      }
      return false;
    };

    // ---- W-3I: real-scale city cores at the six urban anchors --------------
    // Dense multi-storey core → commercial band → residential rows, with
    // perpendicular side streets (pitched rideable strips) branching off
    // the real highway, public services, a bus terminal, a park, parking,
    // per-city landmarks and a light-industrial edge where appropriate.
    // All dimensions in real metres (scale audit: base props were 1.5-2x
    // undersized; corrected via per-type scales — KTM towers ≈ 9x8 m
    // footprint and 18-22 m tall, shops ≈ 4.5-6 m fronts, streets 6.2 m).
    const CITY_CFG = {
      kathmandu: { towerS: 1.2, dense: 1.0, industrial: false, landmark: 'temple' },
      pokhara: { towerS: 1.0, dense: 0.8, industrial: false, landmark: 'lakeside' },
      bharatpur: { towerS: 0.9, dense: 0.75, industrial: true, landmark: 'market' },
      butwal: { towerS: 1.0, dense: 0.8, industrial: true, landmark: 'stupa' },
      biratnagar: { towerS: 0.9, dense: 0.8, industrial: 'heavy', landmark: 'stadium' },
      nepalgunj: { towerS: 0.9, dense: 0.75, industrial: true, landmark: 'market' },
    };
    const buildCity = (route, iC, cityId, cfg) => {
      const pts = route.pts;
      const cC = pts[iC];
      const H = (a, b) => hash01(a, Math.round(b), SALT + 101);
      let nB = 0;
      const putB = (typ, x, z, yaw, sc, collR) => {
        if (!spotOk(x, z, 0.5)) return false;
        if (!bClear(x, z, collR * sc)) return false; // W-3K: no overlaps, ever
        bAdd(x, z, collR * sc);
        recFor(x, z, 18).items.push(it(typ, x, z, yaw, sc, collR, 0.25));
        nB++;
        return true;
      };
      for (let i = Math.max(2, iC - 8); i <= Math.min(pts.length - 2, iC + 8); i++) {
        const p = pts[i], q = pts[i + 1];
        const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        const dx = (q.x - p.x) / len, dz = (q.z - p.z) / len;
        const px = -dz, pz = dx;
        const yawR = Math.atan2(dx, dz);
        const alongM = (i - iC) * 110;
        const zone = Math.abs(alongM) < 340 ? 'core'
          : Math.abs(alongM) < 560 ? 'commercial' : 'residential';

        // Main-street frontage.
        for (const side of [-1, 1]) {
          const face = yawR + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
          const nPos = zone === 'core' ? 4 : 5; // 16 m blocks need ~27 m pitch
          for (let row = 0; row < 2; row++) { // W-3K: two building rows deep
          for (let k = 0; k < nPos; k++) {
            const h = H(i * 41 + k * 7 + row * 13 + side + 1, p.x);
            if (h > (zone === 'core' ? 0.92 : 0.78) * cfg.dense) continue;
            const along = (k + 0.5) / nPos;
            const core = zone === 'core';
            const rowOff = row * (core ? 21 : 18);
            const bx = p.x + dx * along * len + px * side * ((core ? 17 : 15) + rowOff + h * 3);
            const bz = p.z + dz * along * len + pz * side * ((core ? 17 : 15) + rowOff + h * 3);
            if (core) {
              const typ = h < 0.45 ? 'cityAN' : 'cityBN';
              putB(typ, bx, bz, face, cfg.towerS * (0.93 + h * 0.18),
                typ === 'cityAN' ? 8.5 : 6.8);
            } else if (zone === 'commercial') {
              const typ = h < 0.3 ? 'shopN' : h < 0.45 ? 'teashopN' : 'townhouseN';
              putB(typ, bx, bz, face, 1, typ === 'shopN' ? 3.4 : typ === 'teashopN' ? 2.6 : 4.6);
            } else {
              const typ = h < 0.55 ? 'houseN' : 'townhouseN';
              putB(typ, bx, bz, face,
                typ === 'houseN' ? houseVar(bx, bz) : thVar(bx, bz),
                typ === 'houseN' ? 4.3 : 4.6);
            }
          }
          }
          // Sidewalk poles along the core/commercial main street.
          if (zone !== 'residential' && i % 1 === 0) {
            const lx = p.x + px * side * 8.6, lz = p.z + pz * side * 8.6;
            if (spotOk(lx, lz, 0.7)) recFor(lx, lz, -22).items.push(it('poleN', lx, lz, yawR, 1, 0.3, 0.3));
          }
        }

        // Side streets: perpendicular rideable strips + their buildings.
        if (Math.abs(alongM) <= 700) {
          for (const side of [-1, 1]) {
            const nSeg = zone === 'core' ? 7 : 4;
            for (let sg = 1; sg <= nSeg; sg++) {
              const off = side * (8 + sg * 7.6);
              const sx2 = p.x + px * off, sz2 = p.z + pz * off;
              if (!spotOk(sx2, sz2, 0.5)) break;
              const hA = gen.height(sx2 - px * 4, sz2 - pz * 4);
              const hB = gen.height(sx2 + px * 4, sz2 + pz * 4);
              recFor(sx2, sz2, -22).items.push({ type: 'roadseg', x: sx2, z: sz2,
                yaw: yawR, s: 1.2, collR: 0, sink: 0.02, rx: Math.atan2(hA - hB, 8) });
              // Buildings lining the side street.
              if (sg >= 2) {
                for (const bs of [-1, 1]) {
                  const hh = H(i * 67 + sg * 11 + side * 3 + bs + 5, p.z);
                  if (hh >= 0.68 * cfg.dense) continue;
                  const bx = sx2 + dx * 11 * bs, bz = sz2 + dz * 11 * bs;
                  const typ = zone === 'core' ? (hh < 0.4 ? 'cityBN' : 'shopN')
                    : hh < 0.5 ? 'houseN' : 'townhouseN';
                  putB(typ, bx, bz, yawR + (bs > 0 ? Math.PI : 0),
                    typ === 'cityBN' ? cfg.towerS * 0.85
                    : typ === 'houseN' ? houseVar(bx, bz) : 1,
                    typ === 'cityBN' ? 6.8 : typ === 'shopN' ? 3.4
                    : typ === 'houseN' ? 4.3 : 4.6);
                }
              }
            }
            // Street sign at the junction.
            const jx = p.x + px * side * 9.2, jz = p.z + pz * side * 9.2;
            if (Math.abs(alongM) < 250 && spotOk(jx, jz, 0.7)) {
              recFor(jx, jz, -22).items.push(it('roadsign', jx, jz, yawR, 1, 0.2, 0.1));
            }
          }
        }
      }

      // ---- Public services + open spaces (fixed slots, validated) ----------
      const slot = (typ, along, off, sc, collR) => {
        const i = iC + Math.round(along / 110);
        if (i < 2 || i >= pts.length - 1) return false;
        const p = pts[i], q = pts[i + 1];
        const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        const dx = (q.x - p.x) / len, dz = (q.z - p.z) / len;
        const x = p.x + -dz * off, z = p.z + dx * off;
        return putB(typ, x, z, Math.atan2(dx, dz) + (off > 0 ? -Math.PI / 2 : Math.PI / 2), sc, collR);
      };
      slot('schoolN', 260, 32, 1, 7.5) || slot('schoolN', -260, -32, 1, 7.5);
      slot('clinicN', -230, 28, 1, 4.6);
      slot('clinicN', 370, -28, 1, 4.6);
      slot('fuelN', -310, 17, 1, 2.0);
      slot('busstopN', 65, 10.5, 1, 0.5);
      slot('busstopN', -65, -10.5, 1, 0.5);
      // Bus terminal: parking row + double stop.
      for (let k = 0; k < 3; k++) slot('parklot', -150 - k * 14, 27, 1.4, 0);
      slot('busstopN', -150, 19, 1, 0.5);
      // Park: green square with trees, walls and a flag.
      for (let k = 0; k < 6; k++) {
        slot('tree', 150 + (k % 3) * 12, -30 - Math.floor(k / 3) * 11, 1.3, 0.5);
      }
      slot('wall', 138, -24, 1.4, 0.9);
      slot('flagpole', 162, -36, 1.2, 0.3);
      slot('parklot', 95, 14, 1.3, 0);
      slot('parklot', -95, -14, 1.3, 0);

      // ---- Landmarks ---------------------------------------------------------
      if (cfg.landmark === 'temple') {
        slot('pagoda', 0, 34, 1.8, 3.6) || slot('pagoda', 30, -34, 1.8, 3.6);
        slot('stupa', 22, 30, 1.5, 1.4);
        slot('flagpole', -14, 30, 1.2, 0.3);
        slot('parklot', 12, 44, 1.3, 0);
      } else if (cfg.landmark === 'lakeside') {
        for (let k = 0; k < 4; k++) {
          slot('teashopN', -70 - k * 24, 12, 1, 2.6);
          slot('stall', -82 - k * 24, 11, 1.2, 1.1);
        }
        slot('pagoda', 20, 32, 1.6, 3.2);
        slot('flagpole', -60, 14, 1.2, 0.3);
      } else if (cfg.landmark === 'market') {
        for (let k = 0; k < 9; k++) {
          slot('stall', 115 + (k % 3) * 9, 22 + Math.floor(k / 3) * 8, 1.25, 1.1) ||
            slot('stall', -115 - (k % 3) * 9, -(22 + Math.floor(k / 3) * 8), 1.25, 1.1);
        }
        slot('shopN', 100, 22, 1, 3.4) || slot('shopN', -100, -22, 1, 3.4);
      } else if (cfg.landmark === 'stupa') {
        slot('stupa', 0, 36, 2.2, 2.0) || slot('stupa', 40, -36, 2.2, 2.0);
        slot('flagpole', 10, 32, 1.3, 0.3);
        slot('flagpole', -10, 32, 1.3, 0.3);
      } else if (cfg.landmark === 'stadium') {
        const i = Math.min(pts.length - 2, iC + 5);
        const p = pts[i], q = pts[i + 1];
        const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        const sx = p.x + -((q.z - p.z) / len) * 62, sz = p.z + ((q.x - p.x) / len) * 62;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const x = sx + Math.cos(a) * 30, z = sz + Math.sin(a) * 25;
          if (spotOk(x, z, 0.5)) {
            recFor(x, z, 14).items.push(it('stand', x, z,
              Math.atan2(sx - x, sz - z) + Math.PI, 1.3, 2.6, 0.3));
            nB++;
          }
        }
        slot('parklot', 440, 30, 1.4, 0);
      }

      // ---- Light-industrial edge --------------------------------------------
      if (cfg.industrial) {
        const sides = cfg.industrial === 'heavy' ? [-1, 1] : [1];
        for (const sd of sides) {
          slot('factory', 640, sd * 22, 1.3, 4.6);
          slot('warehouse', 690, sd * 24, 1.3, 4.6);
          slot('warehouse', 600, sd * 26, 1.25, 4.4);
          slot('silo', 670, sd * 33, 1.1, 1.7);
          slot('truck', 655, sd * 15, 1.1, 2.0);
          slot('truck', 620, sd * 17, 1.1, 2.0);
          for (let k = 0; k < 4; k++) slot('fence', 615 + k * 6.5, sd * 40, 0.9, 0);
          slot('parklot', 610, sd * 13, 1.4, 0);
        }
      }
      this.settlements.push({ kind: 'city', id: cityId, x: cC.x, z: cC.z, r: 620, houses: nB });
      return nB;
    };

    // Pass 1: urban anchors at the six blueprint cities.
    for (const city of CITIES) {
      const ax = (city.u - 0.5) * 50000, az = (0.5 - city.v) * 50000;
      let best = null, bi = 0, bd = 1e18;
      for (const route of roads.routes) {
        for (let i = 2; i < route.pts.length - 1; i++) {
          const d = (route.pts[i].x - ax) ** 2 + (route.pts[i].z - az) ** 2;
          if (d < bd) { bd = d; best = route; bi = i; }
        }
      }
      if (best && bd < 600 * 600) {
        // W-3I: full real-scale city core replaces the W-3H anchor strip.
        buildCity(best, Math.max(6, Math.min(bi, best.pts.length - 8)), city.id,
          CITY_CFG[city.id] || CITY_CFG.bharatpur);
        // Residential outskirt strips beyond the core (rural transition).
        buildSettlement(best, Math.max(2, bi - 10), 'anchor-outskirt', {
          spanNodes: 3, sp: 19, rows: 1, density: 0.5, maxH: 10, minH: 3,
          plainHouse: 0.7, services: [],
        });
        buildSettlement(best, Math.min(best.pts.length - 5, bi + 7), 'anchor-outskirt', {
          spanNodes: 3, sp: 19, rows: 1, density: 0.5, maxH: 10, minH: 3,
          plainHouse: 0.7, services: [],
        });
      }
    }
    // Pass 2: towns along highways (spacing-controlled; none in the dry zone).
    for (const route of roads.routes) {
      if (route.kind !== 'highway') continue;
      for (let i = 6; i < route.pts.length - 10; i += 4) {
        const p = route.pts[i];
        const v = 0.5 - p.z / 50000;
        if (hash01(i, Math.round(p.x * 0.01), SALT + 53) > 0.45) continue;
        const spacing = v < 0.155 ? 3600 : 2400; // Terai towns spread farther
        if (nearSettlement(p.x, p.z, spacing)) continue;
        gen.sampleInfo(p.x, p.z, info);
        if (info.dry > 0.6 || info.wRk + info.wMnt > 0.6) continue;
        buildSettlement(route, i, 'town', {
          spanNodes: 4, sp: 19, rows: 2, density: 0.7,
          maxH: 20 + ((hash01(i, 3, SALT + 59) * 20) | 0), minH: 9,
          plainHouse: 0.5,
          services: ['shopN', 'teashopN', 'schoolN', 'clinicN', 'fuelN', 'busstopN', 'stall'],
        });
      }
    }
    // Pass 3: villages along all routes (sparse + huddled in the dry zone).
    for (const route of roads.routes) {
      for (let i = 4; i < route.pts.length - 6; i += 3) {
        const p = route.pts[i];
        if (hash01(i * 7, Math.round(p.z * 0.01), SALT + 61) > 0.4) continue;
        if (nearSettlement(p.x, p.z, 850)) continue;
        gen.sampleInfo(p.x, p.z, info);
        if (info.wRk + info.wMnt > (info.dry > 0.6 ? 0.85 : 0.6)) continue;
        const dry = info.dry > 0.6;
        if (dry && hash01(i, 11, SALT + 67) > 0.4) continue; // Mustang: rare
        buildSettlement(route, i, 'village', {
          spanNodes: 2, sp: dry ? 11 : 17, rows: 1, density: dry ? 0.8 : 0.65,
          maxH: dry ? 8 : 8 + ((hash01(i, 5, SALT + 71) * 8) | 0), minH: 4,
          plainHouse: 1,
          services: dry ? ['stupa', 'wall'] : ['teashopN', 'stall', 'stupa'],
        });
      }
    }

    // ---- W-3G: road-based settlement clusters ------------------------------
    // Houses grow in believable clusters beside the roads, patterned by
    // region: spread Terai farmsteads, tight Middle-Hills clusters, dense
    // valley roadside rows, forest-swallowed Chitwan homes, huddled dry-
    // zone mountain hamlets. Every house is terrain/water/road validated
    // and FACES the road. Scatter houses are disabled in nepal mode — this
    // is where the population lives now.
    const W = 50000;
    const eW2 = (e, u, v) => {
      const du = (u - e.cu) / e.ru, dv = (v - e.cv) / e.rv;
      return du * du + dv * dv < 1.1;
    };
    let clusterCount = 0;
    for (const route of roads.routes) {
      const pts = route.pts;
      const every = route.kind === 'mountain' ? 5 : 7;
      for (let i = 3; i < pts.length - 3; i += 1) {
        if (i % every !== 3) continue;
        const hGate = hash01(i * 3, Math.round(pts[i].x * 0.01), SALT + 11);
        const p = pts[i], q = pts[i + 1];
        const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        const dx = (q.x - p.x) / len, dz = (q.z - p.z) / len;
        const px = -dz, pz = dx;
        const side = hGate < 0.5 ? 1 : -1;
        const u = p.x / W + 0.5, v = 0.5 - p.z / W;

        // Regional pattern.
        gen.sampleInfo(p.x + px * side * 26, p.z + pz * side * 26, info);
        if (info.mtn > 0.02 || info.stream > 0.25) continue;
        if (info.wRk + info.wMnt > (info.dry > 0.6 ? 0.85 : 0.6)) continue; // alpine rock: nobody builds
        const dry = info.dry > 0.6;
        const inValley = macro._bowls.some((b) =>
          ((p.x - b.x) / b.rx) ** 2 + ((p.z - b.z) / b.rz) ** 2 < 1.6);
        const inChitwan = eW2(macro._eChitwan, u, v);
        const terai = v < 0.155 && info.h < 20;
        let pat;
        if (dry) pat = { n: 3 + (hGate * 7 | 0) % 2, sp: 10, row: false, clearR: 16, prob: 0.65, scale: 0.7 }; // small stone/earth houses
        else if (inValley) pat = { n: 5 + (hGate * 11 | 0) % 3, sp: 14, row: true, clearR: 18, prob: 0.75, scale: 1.0 };
        else if (inChitwan) pat = { n: 2 + (hGate * 9 | 0) % 2, sp: 20, row: false, clearR: 10, prob: 0.45, scale: 1 };
        else if (terai) pat = { n: 3 + (hGate * 13 | 0) % 3, sp: 26, row: false, clearR: 20, prob: 0.6, scale: 1.1 }; // wide Terai properties
        else pat = { n: 4 + (hGate * 17 | 0) % 3, sp: 15, row: false, clearR: 18, prob: 0.5, scale: 0.95 }; // compact hill clusters
        // W-3H: hamlets keep clear of villages/towns/anchors, but thicken
        // in the 260-700 m outskirt belt (gradual rural -> urban feel).
        let distS = 1e9;
        for (const st of this.settlements) {
          const d = Math.hypot(p.x - st.x, p.z - st.z);
          if (d < distS) distS = d;
        }
        if (distS < 260) continue;
        const prob = pat.prob * (distS < 700 ? 1.5 : 1);
        if (hash01(i, Math.round(p.z * 0.01), SALT + 13) > prob) continue;

        const cOff = route.w + 15 + hash01(i, 5, SALT + 17) * 8;
        const cx = p.x + px * side * cOff, cz = p.z + pz * side * cOff;
        if (water.submerged(cx, cz, gen.height(cx, cz))) continue;
        if (!slopeOk(cx, cz, 0.9)) continue;

        const rec = recFor(cx, cz, pat.clearR);
        let placed = 0;
        for (let k = 0; k < pat.n; k++) {
          let hx, hz;
          if (pat.row) { // valley roadside neighborhood: houses in a row
            hx = p.x + dx * (k - (pat.n - 1) / 2) * pat.sp + px * side * (route.w + 13.5);
            hz = p.z + dz * (k - (pat.n - 1) / 2) * pat.sp + pz * side * (route.w + 13.5);
          } else {      // cluster: ring + jitter around the center
            const a = hash01(i * 5 + k, 1, SALT + 19) * Math.PI * 2;
            const rr = pat.sp * (0.55 + hash01(i * 5 + k, 2, SALT + 23) * 0.8);
            hx = cx + Math.cos(a) * rr;
            hz = cz + Math.sin(a) * rr;
          }
          const hy = gen.height(hx, hz);
          if (!slopeOk(hx, hz, 0.55)) continue;            // gentle ground only
          if (water.submerged(hx, hz, hy)) continue;       // never underwater
          const rq = roads.query(hx, hz);
          if (rq.mask > 0.25) continue;                    // never ON the road
          gen.masksAt(hx, hz, info);
          if (info.trail > 0.3 || info.stream > 0.3) continue;
          // Face the road.
          const yawFace = Math.atan2(p.x + dx * ((hx - p.x) * dx + (hz - p.z) * dz) - hx,
                                     p.z + dz * ((hx - p.x) * dx + (hz - p.z) * dz) - hz);
          const sHV = pat.scale * houseVar(hx, hz);
          if (!bClear(hx, hz, 4.3 * sHV)) continue;
          bAdd(hx, hz, 4.3 * sHV);
          rec.items.push(it('houseN', hx, hz, yawFace, sHV, 4.3, 0.28));
          placed++;
        }
        if (placed === 0) { rec.items.length = 0; rec.r = -22; continue; }
        clusterCount++;
        // Rural accents: haystacks/walls (corn rows come free from crops).
        if (!inValley && placed >= 2) {
          const axx = cx + px * side * 6, azz = cz + pz * side * 6;
          if (slopeOk(axx, azz, 0.6) && !water.submerged(axx, azz, gen.height(axx, azz))) {
            rec.items.push(it(dry ? 'wall' : 'haystack', axx, azz,
              hash01(i, 9, SALT + 29) * 6.28, 0.9 + hash01(i, 10, SALT + 31) * 0.4,
              dry ? 0.9 : 0.6, 0.15));
          }
        }
      }
    }
    this.clusterCount = clusterCount;

    // Bridge visual props: deck planks + rail fences along the span.
    for (const b of bridges) {
      const yawR = Math.atan2(b.dx, b.dz);
      const nDeck = Math.max(1, Math.round(b.len / 12));
      for (let k = 0; k < nDeck; k++) {
        const u = (k - (nDeck - 1) / 2) * 12;
        const x = b.x + b.dx * u, z = b.z + b.dz * u;
        put(x, z, it('bridgeN', x, z, yawR, 1, 0, 0.12));
        for (const s of [-1, 1]) {
          const fx = x + -b.dz * s * 3.9, fz = z + b.dx * s * 3.9;
          put(fx, fz, it('fence', fx, fz, yawR - Math.PI / 2, 0.8, 0, 0.25));
        }
      }
    }
  }

  /** Settlement-shaped recs for ChunkManager.inject. */
  forChunk(ox, oz) {
    const arr = this._byChunk.get(Math.floor(ox / 64) * 100003 + Math.floor(oz / 64));
    return arr || [];
  }
}
