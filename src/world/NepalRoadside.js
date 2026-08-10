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
              // fence panels extend along local X: align with the road
              put(fx, fz, it('fence', fx, fz, yawR - Math.PI / 2, 0.8, 0, 0.3));
            }
          }
        }
        // Route markers/signs every ~9 nodes; poles on highways every 5.
        if (i % 9 === 4) {
          put(p.x + px * side * off, p.z + pz * side * off,
            it('roadsign', p.x + px * side * off, p.z + pz * side * off, yawR, 1, 0.2, 0.1));
        }
        if (hw && i % 5 === 2) {
          put(p.x + px * -side * (off + 0.8), p.z + pz * -side * (off + 0.8),
            it('pole', p.x + px * -side * (off + 0.8), p.z + pz * -side * (off + 0.8), yawR, 1, 0.25, 0.25));
        }
        // Bus stops on highways every ~22 nodes.
        if (hw && i % 22 === 11 && h < 0.8) {
          const bx = p.x + px * side * (off + 1.2), bz = p.z + pz * side * (off + 1.2);
          if (infraOk(bx, bz)) put(bx, bz, it('busstop', bx, bz, yawR + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 1, 0, 0.2));
        }
        // Fuel stations every ~37 highway nodes.
        if (hw && i % 37 === 18 && h < 0.7) {
          const fx = p.x + px * side * (off + 4), fz = p.z + pz * side * (off + 4);
          if (infraOk(fx, fz)) {
            put(fx, fz, it('fuel', fx, fz, yawR + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 1, 1.6, 0.2));
            put(fx, fz, it('parklot', fx + px * side * 6, fz + pz * side * 6, yawR, 1, 0, 0.12));
          }
        }
        // Rest areas (chiya pasal + parking) every ~29 nodes.
        if (i % 29 === 7 && h < 0.6) {
          const rx = p.x + px * side * (off + 3), rz = p.z + pz * side * (off + 3);
          if (infraOk(rx, rz)) {
            put(rx, rz, it('teashop', rx, rz, yawR + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 1, 2.2, 0.2));
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
      return h < 0.35 ? 0.95 : h < 0.7 ? 1.05 : 1.15;
    };
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
              const off = route.w + 7.5 + row * 9 + hh * 3;
              const hx = p.x + dx * along * len + px * side * off;
              const hz = p.z + dz * along * len + pz * side * off;
              if (!spotOk(hx, hz)) continue;
              const rec = recFor(hx, hz, 14);
              const yawFace = yawR + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
              const pickT = hash01(Math.round(hx), Math.round(hz), SALT + 47);
              const typ = kind === 'hamlet' || pickT < cfg.plainHouse ? 'house'
                : pickT < cfg.plainHouse + 0.5 * (1 - cfg.plainHouse) ? 'townhouseA' : 'townhouseB';
              rec.items.push(it(typ, hx, hz, yawFace, typ === 'house' ? 1 : hCls(hx, hz),
                typ === 'house' ? 2.4 : 2.6, 0.22));
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
            const sx = p.x + px * side * (route.w + 6.5) + dx * placedS * 9;
            const sz = p.z + pz * side * (route.w + 6.5) + dz * placedS * 9;
            if (spotOk(sx, sz, 0.5)) {
              const rec = recFor(sx, sz, 12);
              const collR = typ === 'school' ? 3.8 : typ === 'clinic' ? 2.4
                : typ === 'fuel' ? 1.6 : typ === 'stall' ? 1.2 : typ === 'stupa' ? 1.1
                : typ === 'busstop' || typ === 'flagpole' || typ === 'parklot' ? 0.3 : 2.2;
              rec.items.push(it(typ, sx, sz,
                Math.atan2(dx, dz) + (side > 0 ? -Math.PI / 2 : Math.PI / 2), 1, collR, 0.2));
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
        const i0 = Math.max(2, Math.min(bi - 3, best.pts.length - 9));
        buildSettlement(best, i0, 'anchor', {
          spanNodes: 6, sp: 13, rows: 2, density: 0.85, maxH: 55, minH: 12,
          plainHouse: 0.35,
          services: ['shop', 'shop', 'teashop', 'school', 'clinic', 'fuel',
            'busstop', 'busstop', 'stall', 'stall', 'parklot', 'stupa'],
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
          spanNodes: 4, sp: 15, rows: 2, density: 0.7,
          maxH: 20 + ((hash01(i, 3, SALT + 59) * 20) | 0), minH: 9,
          plainHouse: 0.5,
          services: ['shop', 'teashop', 'school', 'clinic', 'fuel', 'busstop', 'stall'],
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
          spanNodes: 2, sp: dry ? 9 : 13, rows: 1, density: dry ? 0.8 : 0.65,
          maxH: dry ? 8 : 8 + ((hash01(i, 5, SALT + 71) * 8) | 0), minH: 4,
          plainHouse: 1,
          services: dry ? ['stupa', 'wall'] : ['teashop', 'stall', 'stupa'],
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
        if (dry) pat = { n: 3 + (hGate * 7 | 0) % 2, sp: 7, row: false, clearR: 12, prob: 0.65, scale: 0.95 };
        else if (inValley) pat = { n: 5 + (hGate * 11 | 0) % 3, sp: 10, row: true, clearR: 14, prob: 0.75, scale: 1.05 };
        else if (inChitwan) pat = { n: 2 + (hGate * 9 | 0) % 2, sp: 13, row: false, clearR: 7, prob: 0.45, scale: 1 };
        else if (terai) pat = { n: 3 + (hGate * 13 | 0) % 3, sp: 17, row: false, clearR: 15, prob: 0.6, scale: 1.1 };
        else pat = { n: 4 + (hGate * 17 | 0) % 3, sp: 9.5, row: false, clearR: 13, prob: 0.5, scale: 1 };
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

        const cOff = route.w + 11 + hash01(i, 5, SALT + 17) * 8;
        const cx = p.x + px * side * cOff, cz = p.z + pz * side * cOff;
        if (water.submerged(cx, cz, gen.height(cx, cz))) continue;
        if (!slopeOk(cx, cz, 0.9)) continue;

        const rec = recFor(cx, cz, pat.clearR);
        let placed = 0;
        for (let k = 0; k < pat.n; k++) {
          let hx, hz;
          if (pat.row) { // valley roadside neighborhood: houses in a row
            hx = p.x + dx * (k - (pat.n - 1) / 2) * pat.sp + px * side * (route.w + 8.5);
            hz = p.z + dz * (k - (pat.n - 1) / 2) * pat.sp + pz * side * (route.w + 8.5);
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
          rec.items.push(it('house', hx, hz, yawFace, pat.scale, 2.4, 0.2));
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
        put(x, z, it('bridge', x, z, yawR, 1, 0, 0.12));
        for (const s of [-1, 1]) {
          const fx = x + -b.dz * s * 3.0, fz = z + b.dx * s * 3.0;
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
