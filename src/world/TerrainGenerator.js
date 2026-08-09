import { vnoise, fbm2, hash01, hashInt, sstep } from './noise.js';

/**
 * TerrainGenerator — the analytic heart of the endless world.
 *
 * Height, biome weights, trails, streams, terraces and jump features are all
 * pure functions of (x, z, seed). Chunk meshes merely SAMPLE this function,
 * which guarantees:
 *   - identical values on shared chunk edges (no seams),
 *   - physics that works even before a chunk mesh is built,
 *   - full determinism for a given seed.
 *
 * Biomes (blended smoothly, never square borders):
 *   green mid-hills / pine foothill forest / rural farm (terraces) /
 *   rocky hills / high mountain (ridged, snow-capped)
 * driven by two low-frequency fields: "mountainness" and "humidity".
 *
 * Trails and streams are level-sets of low-frequency noise: |n| < width.
 * Two independent trail channels cross each other, giving natural junctions,
 * splits and reconnections without any path-plotting.
 *
 * Jump features (dirt mounds, built kicker ramps) and bridges live on an
 * 80 m feature-cell grid; each cell decides its own content from its
 * coordinates alone, so any chunk can be generated in any order.
 *
 * MOUNTAIN DESTINATIONS (Phase 3B) live on a sparse 1200 m cell grid: rare,
 * named, climbable peaks added as an analytic radial dome with a spiral
 * dirt road that cancels the dome's cross-slope, so the route stays
 * rideable while the face remains steep. Generic trails/streams/terraces
 * fade out under a dome; the road takes over. Being part of the same
 * analytic height function, they stream through the normal chunk system
 * and cost nothing when far away.
 */

const CELL = 80; // feature-cell size (m)
const MCELL = 1200;           // mountain-destination cell size (m)
const ROAD_END_R = 16;        // spiral road ends this close to the summit
const MOUNTAIN_NAMES = [
  'Suryodaya', 'Ratnagiri', 'Megharaj', 'Seto Shikhar',
  'Bhalu Danda', 'Kalika Danda', 'Juneli Chuli', 'Indra Shikhar',
  'Phul Danda', 'Tara Chuli', 'Hariyo Danda', 'Chirbire Shikhar',
  'Sunkhani Peak', 'Dhunge Chuli', 'Bataas Danda', 'Kuhiro Shikhar',
];

export class TerrainGenerator {
  constructor(seed = 20) {
    this.seed = seed | 0;
    const s = this.seed * 13;
    // Channel salts (one per noise field).
    this.SM = s + 1;  // mountainness
    this.SU = s + 2;  // humidity
    this.SH = s + 3;  // height octaves
    this.SR = s + 7;  // ridges
    this.ST1 = s + 8; // trail channel A
    this.ST2 = s + 9; // trail channel B
    this.SW = s + 10; // trail width
    this.SS = s + 11; // streams
    this.STE = s + 12; // terrace mask
    this.SJ = s + 13; // color jitter
    this.SF = s + 14; // feature cells
    this.SMt = s + 15; // mountain destinations
    this._cells = new Map();
    this._mcells = new Map();
    this._mtnD = 0; // distance to the mountain returned by _mountainNear
    this._info = makeInfo(); // scratch for height-only sampling
  }

  // ---- Public sampling API ------------------------------------------------

  /** Height only (physics / camera / shadow hot path). */
  height(x, z) {
    const h = this._sample(x, z, this._info, true, true);
    return Number.isFinite(h) ? h : 0; // world-recovery guard
  }

  /** Full sample: height + biome weights + masks (mesh building, scatter). */
  sampleInfo(x, z, info) {
    info.h = this._sample(x, z, info, true, true);
    if (!Number.isFinite(info.h)) info.h = 0;
    return info;
  }

  /** Vertex color for a sampled point; written into out = [r, g, b]. */
  colorFor(info, out) {
    const j = info.jit;
    const h = info.h;
    // Large-scale dry/lush ground patches (adds life to open ground).
    const dry = info.dry;
    // Biome base colors (kept saturated — distance fog desaturates plenty).
    // Rocky hills read brown (exposed dirt), high mountains read grey stone.
    let r = (0.31 + 0.10 * j) * info.wH + (0.19 + 0.05 * j) * info.wF +
            (0.44 + 0.06 * j) * info.wRk;
    let g = (0.47 + 0.08 * j) * info.wH + (0.31 + 0.06 * j) * info.wF +
            (0.36 + 0.05 * j) * info.wRk;
    let b = (0.17 + 0.04 * j) * info.wH + 0.13 * info.wF + (0.28 + 0.04 * j) * info.wRk;
    if (info.wFa > 0.001) {
      // Terraced field palette alternates with terrace level.
      const lvl = Math.floor((h + 40) / 1.1) & 3;
      const p = FARM_PALETTE[lvl];
      r += (p[0] + 0.05 * j) * info.wFa;
      g += (p[1] + 0.05 * j) * info.wFa;
      b += (p[2] + 0.03 * j) * info.wFa;
    }
    if (info.wMnt > 0.001) {
      const sn = sstep(13, 17, h + j * 3 - 1.5); // snow line with dithered edge
      r += (0.40 + (0.93 - 0.40) * sn) * info.wMnt;
      g += (0.41 + (0.94 - 0.41) * sn) * info.wMnt;
      b += (0.46 + (0.97 - 0.46) * sn) * info.wMnt;
    }
    // Dry-patch tint on open ground (hills/farm), fading under forest.
    const dryM = dry * (info.wH + info.wFa * 0.7) * 0.5;
    r += (0.55 - r) * dryM; g += (0.50 - g) * dryM; b += (0.30 - b) * dryM;
    // Mountain destination bands: forest low, rock mid, grey/snow top.
    if (info.mtn > 0.02) {
      const t = info.mtn;
      const forest = sstep(0.05, 0.16, t) * (1 - sstep(0.42, 0.58, t)) * 0.8;
      r += (0.21 - r) * forest; g += (0.34 - g) * forest; b += (0.15 - b) * forest;
      const rock = sstep(0.42, 0.62, t);
      r += (0.45 - r) * rock; g += (0.41 - g) * rock; b += (0.37 - b) * rock;
      const high = sstep(0.72, 0.9, t) * 0.75;
      r += (0.51 - r) * high; g += (0.51 - g) * high; b += (0.54 - b) * high;
      const snow = sstep(0.85, 0.95, t + (j - 0.5) * 0.06) * sstep(66, 78, info.mtnH);
      r += (0.93 - r) * snow; g += (0.94 - g) * snow; b += (0.97 - b) * snow;
    }
    // Dirt trail overlay (bright sandy — reads clearly against every biome).
    const t = info.trail * 0.88;
    r += (0.56 + 0.07 * j - r) * t;
    g += (0.44 + 0.05 * j - g) * t;
    b += (0.26 - b) * t;
    // Edge wear: slightly darker, rougher dirt along trail borders.
    const wear = sstep(0.3, 0.5, info.trail) * (1 - sstep(0.78, 0.95, info.trail)) * 0.35;
    r -= r * 0.10 * wear; g -= g * 0.11 * wear; b -= b * 0.08 * wear;
    // Stream bed: wet stones, watery center.
    const sm = info.stream;
    if (sm > 0.01) {
      r += (0.32 - r) * sm; g += (0.35 - g) * sm; b += (0.34 - b) * sm;
      const wet = sstep(0.72, 0.95, sm);
      r += (0.22 - r) * wet; g += (0.32 - g) * wet; b += (0.42 - b) * wet;
    }
    out[0] = r; out[1] = g; out[2] = b;
  }

  /** Cheap trail/stream/biome masks without feature pass (spawn search etc). */
  masksAt(x, z, out) {
    this._sample(x, z, out, false, true);
    return out;
  }

  // ---- Feature access (chunk manager places deck props on these) ----------

  /** Feature record of a cell, or null. Cached; computed deterministically. */
  cellFeature(cx, cz) {
    const key = (cx + 8192) * 16384 + (cz + 8192);
    let f = this._cells.get(key);
    if (f === undefined) {
      f = this._computeCell(cx, cz);
      this._cells.set(key, f);
    }
    return f;
  }

  /** Iterate features of the cells overlapping a world-space rectangle. */
  featuresInRect(x0, z0, x1, z1, cb) {
    const ca = Math.floor(x0 / CELL), cb2 = Math.floor(x1 / CELL);
    const cc = Math.floor(z0 / CELL), cd = Math.floor(z1 / CELL);
    for (let cx = ca; cx <= cb2; cx++) {
      for (let cz = cc; cz <= cd; cz++) {
        const f = this.cellFeature(cx, cz);
        if (f) cb(f);
      }
    }
  }

  /** True if (x,z) is inside a feature's footprint or its landing zone. */
  nearFeature(x, z) {
    const ccx = Math.floor(x / CELL), ccz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const f = this.cellFeature(ccx + dx, ccz + dz);
        if (!f) continue;
        const rx = x - f.x, rz = z - f.z;
        if (f.type === 'mound') {
          if (rx * rx + rz * rz < 196) return true;
        } else if (f.type === 'ramp') {
          const u = rx * f.dx + rz * f.dz, v = -rx * f.dz + rz * f.dx;
          if (u > -5 && u < 38 && Math.abs(v) < 9) return true; // incl. landing
        } else if (rx * rx + rz * rz < 100) {
          return true; // bridge
        }
      }
    }
    return false;
  }

  // ---- Mountain destinations (Phase 3B) -----------------------------------

  /** Mountain record of a 1200 m cell, or null. Deterministic; cached. */
  mountainCell(cx, cz) {
    const key = (cx + 8192) * 16384 + (cz + 8192);
    let mn = this._mcells.get(key);
    if (mn === undefined) {
      if (hash01(cx, cz, this.SMt) > 0.52) {
        mn = null;
      } else {
        const R = 260 + 80 * hash01(cx, cz, this.SMt + 3);
        const H = 55 + 32 * hash01(cx, cz, this.SMt + 4);
        const turns = 1.5 + 0.8 * hash01(cx, cz, this.SMt + 5);
        const rStart = R + 100;
        const uMax = turns * 2 * Math.PI;
        mn = {
          id: `${this.seed}:${cx},${cz}`,
          name: MOUNTAIN_NAMES[(hashInt(cx, cz, this.SMt + 7) >>> 4) % MOUNTAIN_NAMES.length],
          x: (cx + 0.3 + 0.4 * hash01(cx, cz, this.SMt + 1)) * MCELL,
          z: (cz + 0.3 + 0.4 * hash01(cx, cz, this.SMt + 2)) * MCELL,
          R, H, uMax,
          phi: hash01(cx, cz, this.SMt + 6) * 2 * Math.PI,
          rStart,
          k: (rStart - ROAD_END_R) / uMax,
          // Fixed modulation used along the road so the spiral never
          // inherits the flank shape-noise as sudden pitch changes.
          modC: 0.85 + 0.34 * hash01(cx, cz, this.SMt + 9),
        };
      }
      this._mcells.set(key, mn);
    }
    return mn;
  }

  /** Mountain whose influence covers (x,z), or null; distance in _mtnD. */
  _mountainNear(x, z) {
    const ccx = Math.floor(x / MCELL), ccz = Math.floor(z / MCELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const mn = this.mountainCell(ccx + dx, ccz + dz);
        if (!mn) continue;
        const d = Math.hypot(x - mn.x, z - mn.z);
        if (d < mn.rStart + 30) {
          this._mtnD = d;
          return mn;
        }
      }
    }
    return null;
  }

  /** The mountain whose summit is at (x,z), within `radius` m; else null. */
  summitAt(x, z, radius = 18) {
    const mn = this._mountainNear(x, z);
    return mn && this._mtnD < radius ? mn : null;
  }

  /** Nearest mountain record via spiral cell search (UI/debug/tests). */
  nearestMountain(x, z, maxCells = 4) {
    const c0x = Math.floor(x / MCELL), c0z = Math.floor(z / MCELL);
    let best = null, bd = Infinity;
    for (let r = 0; r <= maxCells; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const mn = this.mountainCell(c0x + dx, c0z + dz);
          if (!mn) continue;
          const d = Math.hypot(x - mn.x, z - mn.z);
          if (d < bd) { bd = d; best = mn; }
        }
      }
      if (best && r > 0) break; // one extra ring is enough for "nearest"
    }
    return best;
  }

  /** Point + uphill heading on a mountain's road; frac 0 = base, 1 = summit. */
  roadPoint(mn, frac) {
    const u = frac * mn.uMax;
    const r = mn.rStart - mn.k * u;
    const a = mn.phi + u;
    const cos = Math.cos(a), sin = Math.sin(a);
    // Tangent for increasing u (uphill).
    const dx = -mn.k * cos - r * sin;
    const dz = -mn.k * sin + r * cos;
    return {
      x: mn.x + cos * r,
      z: mn.z + sin * r,
      yaw: Math.atan2(dx, dz),
    };
  }

  /** Drop far-away cached cells; called occasionally to bound memory. */
  pruneCells(x, z) {
    if (this._mcells.size > 64) {
      const mcx = Math.floor(x / MCELL), mcz = Math.floor(z / MCELL);
      for (const key of this._mcells.keys()) {
        const cx = Math.floor(key / 16384) - 8192;
        const cz = (key % 16384) - 8192;
        if (Math.abs(cx - mcx) > 4 || Math.abs(cz - mcz) > 4) this._mcells.delete(key);
      }
    }
    if (this._cells.size < 320) return;
    const pcx = Math.floor(x / CELL), pcz = Math.floor(z / CELL);
    for (const key of this._cells.keys()) {
      const cx = Math.floor(key / 16384) - 8192;
      const cz = (key % 16384) - 8192;
      if (Math.abs(cx - pcx) > 7 || Math.abs(cz - pcz) > 7) this._cells.delete(key);
    }
  }

  // ---- Internals -----------------------------------------------------------

  /**
   * The single sampling pipeline. `info` receives biome weights and masks.
   * `withFeatures`/`withStream` allow feature cells to query "plain" terrain
   * without recursing into themselves.
   */
  _sample(x, z, info, withFeatures, withStream) {
    // Mountain destination influence (computed first: it attenuates the
    // generic masks and damps high-frequency detail under the dome).
    const mtn = this._mountainNear(x, z);
    const mtnD = this._mtnD;
    let mProf = 0, mMod = 1, mCore = 0;
    let roadMask = 0, roadDelta = 0, modBlend = 0;
    if (mtn) {
      const t = mtnD / mtn.R;
      if (t < 1) {
        const q = 1 - t * t;
        mProf = q * q;
      }
      mMod = 0.85 + 0.34 * vnoise(x * 0.0045 + 3.3, z * 0.0045 - 7.7, this.SMt + 8);
      mCore = sstep(0.02, 0.22, mProf);

      // Spiral road: nearest winding at this angle. The narrow band cancels
      // the dome's radial slope; a wider shoulder blends the flank shape-
      // modulation toward a per-mountain constant so the road itself climbs
      // steadily (bench-cut look on strong flanks).
      let u = Math.atan2(z - mtn.z, x - mtn.x) - mtn.phi;
      u -= Math.floor(u / (2 * Math.PI)) * 2 * Math.PI; // 0..2π
      let bestDr = Infinity, bestRk = 0;
      for (; u <= mtn.uMax; u += 2 * Math.PI) {
        const rk = mtn.rStart - mtn.k * u;
        const dr = Math.abs(mtnD - rk);
        if (dr < bestDr) { bestDr = dr; bestRk = rk; }
      }
      if (bestDr < 26) {
        roadMask = sstep(6.2, 3.6, bestDr);
        modBlend = sstep(26, 7, bestDr);
        const tk = bestRk / mtn.R;
        const qk = tk < 1 ? 1 - tk * tk : 0;
        roadDelta = (qk * qk - mProf) * mtn.H;
      }
      if (modBlend > 0) mMod += (mtn.modC - mMod) * modBlend;
    }

    // Biome fields.
    const m = fbm2(x * 0.0016, z * 0.0016, this.SM);
    const u = fbm2(x * 0.0020 + 7.3, z * 0.0020 - 3.1, this.SU);
    const a = sstep(0.50, 0.62, m);
    const mnt = sstep(0.64, 0.76, m);
    const lo = 1 - a;
    const wMnt = mnt;
    const wRk = a * (1 - mnt);
    const wF = lo * sstep(0.57, 0.67, u);
    const wFa = lo * (1 - sstep(0.33, 0.43, u));
    const wH = Math.max(0, lo - wF - wFa);

    // Height octaves (manual so a "gentle" 2-octave version is free —
    // trails flatten toward it).
    const n1 = vnoise(x * 0.008, z * 0.008, this.SH) - 0.5;
    const n2 = vnoise(x * 0.016 + 13.7, z * 0.016 - 8.1, this.SH + 1) - 0.5;
    const n3 = vnoise(x * 0.034 - 5.2, z * 0.034 + 19.3, this.SH + 2) - 0.5;
    const n4 = vnoise(x * 0.07 + 27.9, z * 0.07 + 6.6, this.SH + 3) - 0.5;
    const amp = 7 * wH + 9 * wF + 4.4 * wFa + 13 * wRk + 17 * wMnt;
    // Damp high-frequency detail under destination domes: the 2 m mesh
    // cannot represent it, and the visual/collision gap it causes is far
    // more noticeable on steep slopes than the detail itself.
    const rockDetail = (wRk + wMnt * 1.5 + 0.3) * (1 - 0.75 * mCore);
    const hSmooth = n1 * amp; // single-octave base: mountain roads ride this
    let hGentle = (n1 + 0.5 * n2) * amp;
    let h = hGentle + (0.25 * n3 * (rockDetail + 0.4) + 0.11 * n4 * rockDetail) * amp;

    // Ridged mountains.
    if (wMnt + wRk > 0.001) {
      let rr = 1 - Math.abs(2 * vnoise(x * 0.0055 + 3.1, z * 0.0055 - 12.7, this.SR) - 1);
      rr *= rr;
      const ridge = rr * (20 * wMnt + 3.5 * wRk) * (1 - mCore);
      h += ridge;
      hGentle += ridge * 0.8;
    }

    // Terraced farmland (quantize height on masked farm slopes).
    const terr = wFa * sstep(0.35, 0.50, vnoise(x * 0.006 + 31, z * 0.006 - 17, this.STE)) *
      (1 - mCore);
    if (terr > 0.01) {
      const q = h / 1.1;
      const fq = q - Math.floor(q);
      const hq = (Math.floor(q) + sstep(0.55, 1, fq)) * 1.1;
      h += (hq - h) * Math.min(1, terr * 1.15);
    }

    // Streams (lowland level-set carve; rideable dip, crossable).
    let streamM = 0;
    if (withStream && lo > 0.05) {
      const sN = vnoise(x * 0.004 - 11.3, z * 0.004 + 23.7, this.SS) - 0.5;
      streamM = sstep(0.034, 0.011, Math.abs(sN)) * lo * (1 - mCore);
      h -= 1.35 * streamM;
      hGentle -= 1.35 * streamM;
    }

    // Trails: two crossing level-set networks with varying width.
    const t1 = vnoise(x * 0.0033 + 5.1, z * 0.0033 - 9.7, this.ST1) - 0.5;
    const t2 = vnoise(x * 0.0046 - 21.4, z * 0.0046 + 13.9, this.ST2) - 0.5;
    const wV = 0.013 + 0.009 * vnoise(x * 0.02, z * 0.02, this.SW);
    let trailM = Math.max(
      sstep(wV, wV * 0.4, Math.abs(t1)),
      sstep(wV * 0.85, wV * 0.35, Math.abs(t2))
    ) * (1 - mCore);
    // The mountain road flattens base-terrain detail along its band both on
    // and off the dome (the dome's own slope is cancelled separately below);
    // on the dome it references the smoothest single-octave base so the
    // climb never inherits base bumps as sudden pitch changes.
    const flattenM = Math.max(trailM, roadMask);
    const hRef = (hGentle + (hSmooth - hGentle) * mCore) * 0.92;
    h += (hRef - h) * flattenM * 0.85;

    // Mountain dome + rideable spiral road.
    if (mtn) {
      h += mtn.H * mProf * mMod;
      if (roadMask > 0) {
        h += roadDelta * mMod * roadMask;
        if (roadMask * 0.95 > trailM) trailM = roadMask * 0.95; // dirt color
      }
    }

    if (info) {
      info.wH = wH; info.wF = wF; info.wFa = wFa; info.wRk = wRk; info.wMnt = wMnt;
      info.lo = lo; info.trail = trailM; info.stream = streamM; info.terr = terr;
      info.jit = vnoise(x * 0.13, z * 0.13, this.SJ);
      info.dry = sstep(0.55, 0.8, vnoise(x * 0.03 + 17.3, z * 0.03 - 9.9, this.SJ + 5));
      info.mtn = mProf;
      info.mtnH = mtn ? mtn.H : 0;
    }

    if (withFeatures) h = this._features(x, z, h);
    return h;
  }

  /** Apply mound/ramp/bridge height contributions from the 3x3 nearby cells. */
  _features(x, z, h) {
    const ccx = Math.floor(x / CELL), ccz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const f = this.cellFeature(ccx + dx, ccz + dz);
        if (!f) continue;
        const rx = x - f.x, rz = z - f.z;
        if (f.type === 'mound') {
          const u = rx * f.dx + rz * f.dz, v = -rx * f.dz + rz * f.dx;
          if (u > -11 && u < 11 && v > -7 && v < 7) {
            const cu = Math.cos((u / 22) * Math.PI), cv = Math.cos((v / 14) * Math.PI);
            h += 1.8 * cu * cu * cv * cv;
          }
        } else if (f.type === 'ramp') {
          const u = rx * f.dx + rz * f.dz, v = -rx * f.dz + rz * f.dx;
          // Kicker: rises to 2.9 m over 9 m, sharp drop past the lip.
          if (u > -1.5 && u < 9.4 && Math.abs(v) < 3.4) {
            const t = Math.min(1, Math.max(0, u / 9));
            const prof = 2.9 * Math.pow(t, 1.8);
            const w = sstep(-1.5, 0.5, u) * sstep(3.4, 2.2, Math.abs(v));
            const target = f.h0 + prof;
            if (target > h) h += (target - h) * w;
          }
        } else { // bridge: flat deck over the stream, ends blend into banks
          const u = rx * f.dx + rz * f.dz, v = -rx * f.dz + rz * f.dx;
          if (Math.abs(u) < 6.5 && Math.abs(v) < 2.6) {
            const e = sstep(6.5, 5.0, Math.abs(u)) * sstep(2.6, 1.8, Math.abs(v));
            if (f.h0 > h) h += (f.h0 - h) * e;
          }
        }
      }
    }
    return h;
  }

  _computeCell(cx, cz) {
    const r0 = hash01(cx, cz, this.SF);
    const px = (cx + 0.2 + 0.6 * hash01(cx, cz, this.SF + 1)) * CELL;
    const pz = (cz + 0.2 + 0.6 * hash01(cx, cz, this.SF + 2)) * CELL;
    const info = makeInfo();

    // Bridge: scan the cell coarsely for a trail/stream crossing.
    if (r0 < 0.55) {
      for (let gi = 0; gi < 5; gi++) {
        for (let gj = 0; gj < 5; gj++) {
          const bx = (cx + (gi + 0.5) / 5) * CELL;
          const bz = (cz + (gj + 0.5) / 5) * CELL;
          this._sample(bx, bz, info, false, true);
          if (info.trail > 0.5 && info.stream > 0.62) {
            const d = this._trailDir(bx, bz);
            const h0 = this._sample(bx, bz, null, false, false) + 0.12; // bank height (no carve)
            return { type: 'bridge', x: bx, z: bz, dx: d.x, dz: d.z, h0 };
          }
        }
      }
    }

    if (r0 < 0.05) {
      // Built kicker ramp: only on trails, gentle ground, with a safe landing.
      this._sample(px, pz, info, false, true);
      if (info.trail > 0.45 && info.lo > 0.35) {
        const d = this._trailDir(px, pz);
        if (hash01(cx, cz, this.SF + 3) < 0.5) { d.x = -d.x; d.z = -d.z; }
        const h0 = this._sample(px, pz, null, false, true);
        const hLand = this._sample(px + d.x * 18, pz + d.z * 18, null, false, true);
        if (hLand < h0 + 1.8 && hLand > h0 - 9) {
          return { type: 'ramp', x: px, z: pz, dx: d.x, dz: d.z, h0 };
        }
      }
      return null;
    }
    if (r0 < 0.30) {
      // Natural dirt mound (jumpable from both sides).
      this._sample(px, pz, info, false, true);
      if (info.lo > 0.3 && info.stream < 0.1) {
        const ang = hash01(cx, cz, this.SF + 4) * Math.PI * 2;
        return { type: 'mound', x: px, z: pz, dx: Math.sin(ang), dz: Math.cos(ang), h0: 0 };
      }
    }
    return null;
  }

  /** Unit direction along the locally dominant trail (perpendicular to its gradient). */
  _trailDir(x, z) {
    const e = 1.5;
    const c1 = Math.abs(vnoise(x * 0.0033 + 5.1, z * 0.0033 - 9.7, this.ST1) - 0.5);
    const c2 = Math.abs(vnoise(x * 0.0046 - 21.4, z * 0.0046 + 13.9, this.ST2) - 0.5);
    const sc = c1 < c2 ? 0.0033 : 0.0046;
    const ox = c1 < c2 ? 5.1 : -21.4, oz = c1 < c2 ? -9.7 : 13.9;
    const salt = c1 < c2 ? this.ST1 : this.ST2;
    const gx = vnoise((x + e) * sc + ox, z * sc + oz, salt) - vnoise((x - e) * sc + ox, z * sc + oz, salt);
    const gz = vnoise(x * sc + ox, (z + e) * sc + oz, salt) - vnoise(x * sc + ox, (z - e) * sc + oz, salt);
    const len = Math.hypot(gz, gx) || 1;
    return { x: -gz / len, z: gx / len };
  }
}

const FARM_PALETTE = [
  [0.47, 0.52, 0.22],
  [0.68, 0.58, 0.26], // ripe mustard/paddy gold
  [0.36, 0.48, 0.20],
  [0.58, 0.53, 0.24],
];

export function makeInfo() {
  return {
    h: 0, wH: 0, wF: 0, wFa: 0, wRk: 0, wMnt: 0, lo: 0,
    trail: 0, stream: 0, terr: 0, jit: 0, dry: 0, mtn: 0, mtnH: 0,
  };
}
