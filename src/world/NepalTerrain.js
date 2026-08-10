import { vnoise, sstep } from './noise.js';
import { BLUEPRINT_SEED, WORLD_SIZE, REGIONS, RIVERS, LAKES, CITIES } from './NepalBlueprint.js';

/**
 * NepalMacro (Phase W-3B) — large-scale terrain foundation for the future
 * fixed 50×50 km Nepal world, driven entirely by NepalBlueprint data.
 *
 * OPT-IN ONLY: the game constructs this ONLY when the URL asks for
 * `?world=nepal`. In the default game the TerrainGenerator's macro hook is
 * null and the procedural world is bit-identical to before this phase.
 *
 * The macro layer transforms the existing procedural relief instead of
 * replacing it:   finalH = macroH(x,z) + proceduralH * detailMul(x,z)
 * so every existing system (streams, trails, features, mountain domes,
 * scatter, collision, the 2 m render lattice) keeps working self-
 * consistently on top — they all read the same height() function.
 *
 * Layers (all deterministic from BLUEPRINT_SEED, independent of game seed —
 * the fixed world is the same place for everyone):
 *   1. South→north BELT PROFILE (Terai → Chure → dun → Mahabharat →
 *      Middle Hills → High Mountains → Trans-Himalaya) with longitudinal
 *      drift, sampled from a control-point spline.
 *   2. Low-frequency RIDGE/VALLEY relief, amplitude + sharpness per belt
 *      (soft swells in the Terai, ridgelines in the hills, steep walls in
 *      the high belt, terraced plateaus in Mustang/Dolpo).
 *   3. VALLEY BOWLS for Kathmandu and Pokhara (flat floors from the
 *      blueprint elevation bands).
 *   4. RIVER CORRIDORS carved along the blueprint rivers — cross-belt
 *      valleys that stay gradual (these are the future highway corridors).
 *   5. LAKE BASINS flattened at the eight blueprint lakes.
 *
 * Cost: ~8 vnoise + a spline walk + ~30 segment distances per sample,
 * comparable to the existing per-sample noise budget. No allocations after
 * construction.
 */

// Belt spline: v, baseH, reliefAmp, detailMul, wall (ridge sharpness 0..1).
const BELT = [
  [0.00,   3,  2.5, 0.35, 0.0],  // outer Terai plain
  [0.10,   5,  3.5, 0.35, 0.0],
  [0.145,  9,  5.0, 0.40, 0.0],  // dun (inner Terai / Chitwan) floor
  [0.18,  40, 15.0, 0.60, 0.3],  // Chure / Siwalik crest
  [0.215, 26, 10.0, 0.60, 0.1],  // inner valley shelf
  [0.27,  88, 26.0, 0.85, 0.5],  // Mahabharat crest
  [0.33,  76, 22.0, 0.95, 0.3],
  [0.45, 112, 30.0, 1.00, 0.35], // Middle Hills
  [0.56, 142, 38.0, 1.05, 0.45],
  [0.66, 232, 72.0, 1.20, 0.85], // High Mountain belt: steep walls
  [0.76, 298, 88.0, 1.20, 0.9],
  [0.83, 252, 42.0, 0.80, 0.4],  // trans-Himalayan transition
  [0.92, 234, 30.0, 0.70, 0.25], // Mustang / Dolpo plateau country
  [1.00, 262, 40.0, 0.75, 0.35],
];

const S = BLUEPRINT_SEED * 13; // noise salts (fixed forever)

export class NepalMacro {
  constructor() {
    // Rivers in metres: flat segment arrays + a bed level per vertex
    // (falls from the headwater belt toward ~2 m at the plains).
    this._rivers = RIVERS.map((r) => {
      const pts = r.points.map(([u, v]) => {
        const x = (u - 0.5) * WORLD_SIZE, z = (0.5 - v) * WORLD_SIZE;
        const bed = Math.max(2, this._beltAt(v, 0) * 0.55);
        return { x, z, bed };
      });
      return pts;
    });
    this._lakes = LAKES.map((l) => ({
      x: (l.u - 0.5) * WORLD_SIZE, z: (0.5 - l.v) * WORLD_SIZE,
      r: 130 + l.size * 110,
    }));
    // Valley bowls from the blueprint valley regions (floor = band mid).
    this._bowls = REGIONS.filter((r) => r.type === 'valley').map((r) => ({
      x: (r.center[0] - 0.5) * WORLD_SIZE, z: (0.5 - r.center[1]) * WORLD_SIZE,
      rx: r.extent[0] * WORLD_SIZE, rz: r.extent[1] * WORLD_SIZE,
      floor: (r.band[0] + r.band[1]) * 0.5,
    }));
    this._scratch = { h: 0, mul: 1 };
    this._scratch2 = { h: 0, mul: 1 };
    // Region ellipses for biome shaping (W-3C), from the blueprint.
    const ell = (id) => {
      const r = REGIONS.find((q) => q.id === id);
      return { cu: r.center[0], cv: r.center[1], ru: r.extent[0], rv: r.extent[1] };
    };
    this._eChitwan = ell('chitwan');
    this._eIlam = ell('ilam');
    this._eMustang = ell('mustang');
    this._eManang = ell('manang');
    this._eDolpo = ell('dolpo');
    this._eRara = ell('rara');
  }

  /** Belt spline base height at v (with optional index 1..4 for the other
   *  spline columns: 1=relief, 2=detailMul, 3=wall). */
  _beltAt(v, col) {
    const c = col + 1;
    if (v <= BELT[0][0]) return BELT[0][c];
    for (let i = 1; i < BELT.length; i++) {
      if (v <= BELT[i][0]) {
        const a = BELT[i - 1], b = BELT[i];
        const t = sstep(a[0], b[0], v);
        return a[c] + (b[c] - a[c]) * t;
      }
    }
    return BELT[BELT.length - 1][c];
  }

  /** The macro transform: final = macroH + proceduralH * detailMul.
   *  W-3E: planned roads cut a subtle hillside bench (cross-slope eased
   *  toward the route centerline) — how real hill roads are built. */
  apply(x, z, proceduralH) {
    const m = this._macro(x, z, this._scratch);
    let h = m.h, mul = m.mul;
    if (this.roads) {
      const q = this.roads.query(x, z);
      if (q.shelf > 0) {
        h += (q.centerH - h) * q.shelf * 0.75;
        mul *= 1 - 0.6 * q.shelf;
      }
      // W-3F: bridge decks — level terrain spans over river crossings,
      // pinned to water level + clearance (rideable, perfectly aligned).
      if (q.deck > 0 && q.deckH > h) {
        h += (q.deckH - h) * q.deck;
        mul *= 1 - 0.9 * q.deck;
      }
    }
    return h + proceduralH * mul;
  }

  /** Attach the planned road network (after construction; W-3E). */
  attachRoads(roads) {
    this.roads = roads;
  }

  /** Inverse of apply(): recover the PROCEDURAL height from a final one.
   *  Used when features (bridges/ramps) store absolute deck heights at
   *  creation time — they must be stored in procedural space, or the macro
   *  would be added twice on application (the W-3E needle-wall bug). */
  unapply(x, z, hTotal) {
    const m = this._macro(x, z, this._scratch2);
    let h = m.h, mul = m.mul;
    if (this.roads) {
      const q = this.roads.query(x, z);
      if (q.shelf > 0) {
        h += (q.centerH - h) * q.shelf * 0.75;
        mul *= 1 - 0.6 * q.shelf;
      }
      if (q.deck > 0 && q.deckH > h) {
        h += (q.deckH - h) * q.deck;
        mul *= 1 - 0.9 * q.deck;
      }
    }
    return (hTotal - h) / Math.max(0.2, mul);
  }

  /** Height RELATIVE to the macro surface — the local micro-relief the
   *  legacy agriculture rules were calibrated against (W-3C). */
  relHeight(x, z, h) {
    return h - this._macro(x, z, this._scratch2).h;
  }

  /**
   * Biome shaping (W-3C): reshape the procedural surface weights so ground
   * cover, trees, crops, colors and even tyre grip follow Nepal's regions.
   * NEVER touches heights — vegetation/appearance only. Weight mass is
   * re-normalized so overall prop density stays in the engine's budget.
   */
  shapeInfo(x, z, info) {
    let u = x / WORLD_SIZE + 0.5, v = 0.5 - z / WORLD_SIZE;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    info.snowOff = 285; // gameplay snowline ~300 m (trans mesas stay bare)

    const sum0 = info.wH + info.wF + info.wFa + info.wRk + info.wMnt;
    if (sum0 < 0.001) return;
    const eW = (e) => {
      const du = (u - e.cu) / e.ru, dv = (v - e.cv) / e.rv;
      return sstep(1.35, 0.75, du * du + dv * dv);
    };
    const terai = 1 - sstep(0.12, 0.165, v);
    const chure = sstep(0.13, 0.165, v) * (1 - sstep(0.21, 0.25, v));
    const highBelt = sstep(0.58, 0.66, v) * (1 - sstep(0.79, 0.84, v));
    const trans = sstep(0.79, 0.85, v);
    const chitwan = eW(this._eChitwan);
    const ilam = eW(this._eIlam);
    const dryZone = Math.min(1, Math.max(trans, eW(this._eMustang), eW(this._eManang),
      eW(this._eDolpo) * 0.9));
    const alpine = Math.min(1, Math.max(highBelt, eW(this._eRara) * 0.7,
      eW(this._eDolpo) * 0.6));

    let wH = info.wH, wF = info.wF, wFa = info.wFa, wRk = info.wRk, wMnt = info.wMnt;
    // Terai: broad warm farmland, scattered trees, no rock outcrops; any
    // procedural massif that strays into the plain reads as green hills,
    // never as snow biome.
    if (terai > 0) {
      wFa += (wFa + wH) * 1.1 * terai;
      wF *= 1 - 0.35 * terai;
      wRk *= 1 - 0.9 * terai;
      wH += wMnt * 0.85 * terai;
      wMnt *= 1 - 0.85 * terai;
    }
    // Chure: scrubby mixed transition (drier ground tint).
    if (chure > 0) {
      wF *= 1 + 0.35 * chure;
      info.dry = Math.min(1, info.dry + 0.3 * chure);
    }
    // Chitwan: dense subtropical forest swallows farms and rock.
    if (chitwan > 0) {
      wF += (Math.max(wF, info.lo * 0.85) - wF) * chitwan;
      wFa *= 1 - 0.7 * chitwan;
      wRk *= 1 - 0.8 * chitwan;
    }
    // Ilam: lush green tea hills (wH is the tea trigger downstream).
    if (ilam > 0) {
      wH += (Math.max(wH, info.lo * 0.75) - wH) * ilam;
      wF *= 1 + 0.4 * ilam;
      info.dry *= 1 - ilam;
    }
    // High-mountain belt + Rara/Dolpo highlands: alpine fade to rock.
    if (alpine > 0) {
      const move = 0.75 * alpine;
      const lost = (wH + wF + wFa) * move;
      wH *= 1 - move; wF *= 1 - 0.9 * move; wFa *= 1 - move;
      wRk += lost * 0.45; wMnt += lost * 0.55;
    }
    // Trans-Himalayan rain shadow: barren slopes, sparse dry grass — the
    // vegetation mass genuinely MOVES to exposed rock (not renormalized back).
    if (dryZone > 0) {
      const lost = (wF * 0.88 + wFa * 0.92 + wH * 0.55) * dryZone;
      wF *= 1 - 0.88 * dryZone;
      wFa *= 1 - 0.92 * dryZone;
      wH *= 1 - 0.55 * dryZone;
      wRk += lost * 0.85; wMnt += lost * 0.15;
      info.dry = Math.max(info.dry, dryZone * 0.9);
    }
    // Preserve total weight mass (keeps scatter density budgeted).
    const sum1 = wH + wF + wFa + wRk + wMnt;
    if (sum1 > 0.001) {
      const k = sum0 / sum1;
      // Rock/alpine zones deliberately keep a little extra exposure.
      const kk = k + (1 - k) * 0.25 * Math.max(alpine, dryZone);
      info.wH = wH * kk; info.wF = wF * kk; info.wFa = wFa * kk;
      info.wRk = wRk * kk; info.wMnt = wMnt * kk;
    }
  }

  _macro(x, z, out) {
    // Normalized map coords, clamped so the endless world continues its
    // edge belts beyond the 50 km square instead of breaking.
    let u = x / WORLD_SIZE + 0.5, v = 0.5 - z / WORLD_SIZE;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    if (v < 0) v = 0; else if (v > 1) v = 1;

    // 1. Belt profile + longitudinal drift (2.5–7 km wavelengths).
    let base = this._beltAt(v, 0);
    const relief = this._beltAt(v, 1);
    let mul = this._beltAt(v, 2);
    const wall = this._beltAt(v, 3);
    base += (vnoise(x * 0.00015 + 3.7, z * 0.00015 - 8.1, S + 1) - 0.5) * base * 0.5;
    base += (vnoise(x * 0.0004 - 12.9, z * 0.0004 + 5.3, S + 2) - 0.5) * relief * 0.9;

    // 2. Ridge/valley relief: ridged noise, sharpened into walls in the
    // high belt, softened to swells in the plains.
    let rr = 1 - Math.abs(2 * vnoise(x * 0.00055 + 21.4, z * 0.00055 + 9.8, S + 3) - 1);
    rr = rr * rr * (1 + wall) - 0.42;                       // ridges AND valleys
    let rel = rr * relief;
    const r2 = 1 - Math.abs(2 * vnoise(x * 0.0013 - 7.7, z * 0.0013 + 15.2, S + 4) - 1);
    rel += (r2 * r2 - 0.4) * relief * 0.35;
    // Steep mountain walls: an extra cliff term where ridges crest in the
    // high belt (kept off the plains entirely).
    if (wall > 0.5) rel += sstep(0.55, 0.95, rr + 0.42) * relief * wall * 0.8;
    let h = base + rel;

    // Trans-Himalayan plateaus: soft height terracing (mesa country).
    if (v > 0.80) {
      const q = h / 16;
      const fq = q - Math.floor(q);
      const hq = (Math.floor(q) + sstep(0.4, 1, fq)) * 16;
      h += (hq - h) * 0.55 * sstep(0.80, 0.86, v);
    }

    // 3. Valley bowls (Kathmandu / Pokhara): flat floors, soft rims.
    for (let i = 0; i < this._bowls.length; i++) {
      const b = this._bowls[i];
      const du = (x - b.x) / b.rx, dv = (z - b.z) / b.rz;
      const d = Math.sqrt(du * du + dv * dv);
      if (d < 1.15) {
        const w = sstep(1.1, 0.6, d);
        const floor = b.floor +
          (vnoise(x * 0.002 + 9.1, z * 0.002 - 4.4, S + 5) - 0.5) * 6;
        h += (floor - h) * w;
        mul += (0.45 - mul) * w;
      }
    }

    // 4. River corridors: gradual cross-belt valleys down to the bed line.
    for (let i = 0; i < this._rivers.length; i++) {
      const pts = this._rivers[i];
      let best = 1e18, bedH = 0;
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        const abx = b.x - a.x, abz = b.z - a.z;
        const apx = x - a.x, apz = z - a.z;
        let t = (apx * abx + apz * abz) / (abx * abx + abz * abz);
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const dx = apx - abx * t, dz = apz - abz * t;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; bedH = a.bed + (b.bed - a.bed) * t; }
      }
      const d = Math.sqrt(best);
      if (d < 750) {
        const w = sstep(750, 140, d);
        if (h > bedH) h += (bedH - h) * w * 0.9;
        mul += (Math.min(mul, 0.5) - mul) * w;
      }
    }

    // 5. Lake basins: flat floors slightly below their surroundings.
    for (let i = 0; i < this._lakes.length; i++) {
      const l = this._lakes[i];
      const dx = x - l.x, dz = z - l.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < l.r * 1.6) {
        const w = sstep(l.r * 1.5, l.r * 0.7, d);
        h += (Math.min(h, this._beltAt(0.5 - z / WORLD_SIZE, 0)) - 3 - h) * w * 0.85;
        mul += (0.3 - mul) * w;
      }
    }

    out.h = h;
    out.mul = Math.max(0.25, mul);
    return out;
  }
}

/** Anchor world positions (metres) for probes/tests: city + region centers. */
export function nepalAnchors() {
  const out = {};
  for (const c of CITIES) {
    out[c.id] = { x: (c.u - 0.5) * WORLD_SIZE, z: (0.5 - c.v) * WORLD_SIZE };
  }
  for (const r of REGIONS) {
    out[r.id] = { x: (r.center[0] - 0.5) * WORLD_SIZE, z: (0.5 - r.center[1]) * WORLD_SIZE };
  }
  return out;
}
