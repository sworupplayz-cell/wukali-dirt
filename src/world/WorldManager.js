import * as THREE from 'three';
import { TerrainGenerator, makeInfo } from './TerrainGenerator.js';
import { ChunkManager, CHUNK_SIZE } from './ChunkManager.js';
import { Mountains } from './Mountains.js';
import { MountainImpostors } from './MountainImpostors.js';

/**
 * WorldManager — endless procedural world facade.
 *
 * Implements the exact world interface the Phase 1 bike/camera already use
 * ({ getHeight, getNormal, getColliders, getSpawn, isInBounds }), so the
 * bike physics is untouched. Adds update(pos) for chunk streaming, driven
 * by the game loop — the bike knows nothing about chunks.
 */
export class WorldManager {
  constructor(scene, seed = 20) {
    this.seed = seed;
    this.generator = new TerrainGenerator(seed);
    this.generator.getRegistry(); // eager: curated names apply from frame one
    this._buildLighting(scene);
    this.chunks = new ChunkManager(scene, this.generator);
    this.mountains = new Mountains(scene, seed);
    this.impostors = new MountainImpostors(scene, this.generator);
    this._n = new THREE.Vector3();
    this._spawn = null;
    this._pruneT = 0;
  }

  // ---- Interface used by Bike / FollowCamera / Game -----------------------

  getHeight(x, z) {
    return this.generator.height(x, z);
  }

  getNormal(x, z, out) {
    const e = 0.6;
    const hx = this.generator.height(x + e, z) - this.generator.height(x - e, z);
    const hz = this.generator.height(x, z + e) - this.generator.height(x, z - e);
    out.set(-hx, 2 * e, -hz).normalize();
    return out;
  }

  getColliders() {
    return this.chunks.activeColliders;
  }

  /** Deterministic spawn: nearest gentle trail point to the origin. */
  getSpawn() {
    if (this._spawn) return this._spawn;
    const gen = this.generator;
    const info = makeInfo();
    let best = { x: 0, z: 0 };
    let fallback = null;
    outer:
    for (let r = 0; r <= 1000; r += 8) {
      const steps = Math.max(1, Math.round((r * 6.28) / 14));
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        gen.masksAt(x, z, info);
        if (info.trail < 0.65 || info.stream > 0.1) continue;
        const slope = Math.abs(gen.height(x + 3, z) - gen.height(x - 3, z)) +
                      Math.abs(gen.height(x, z + 3) - gen.height(x, z - 3));
        if (slope > 1.2 || gen.nearFeature(x, z)) continue;
        if (!fallback) fallback = { x, z };
        if (info.lo < 0.85) continue; // start deep in the green lowlands
        best = { x, z };
        break outer;
      }
      if (r === 1000 && fallback) best = fallback;
    }
    const dir = gen._trailDir(best.x, best.z);
    this._spawn = {
      x: best.x,
      y: gen.height(best.x, best.z),
      z: best.z,
      yaw: Math.atan2(dir.x, dir.z),
    };
    return this._spawn;
  }

  isInBounds() {
    return true; // the world is endless; only the y < -30 failsafe remains
  }

  // ---- Mountain destinations ------------------------------------------------

  /** Mountain record if (x,z) is on a summit, else null. */
  summitAt(x, z) {
    return this.generator.summitAt(x, z);
  }

  /** Nearest mountain destination (tests/debug/future UI). */
  nearestMountain(x, z) {
    return this.generator.nearestMountain(x, z);
  }

  /** Curated destination registry (16 named mountains around the origin). */
  getMountainRegistry() {
    return this.generator.getRegistry();
  }

  /** All mountain destinations within maxDist of a point (metadata only). */
  mountainsNear(x, z, maxDist = 2500) {
    const out = [];
    const cellR = Math.ceil(maxDist / 1200);
    const mcx = Math.floor(x / 1200), mcz = Math.floor(z / 1200);
    for (let dx = -cellR; dx <= cellR; dx++) {
      for (let dz = -cellR; dz <= cellR; dz++) {
        const m = this.generator.mountainCell(mcx + dx, mcz + dz);
        if (m && Math.hypot(m.x - x, m.z - z) <= maxDist) out.push(m);
      }
    }
    return out;
  }

  /** Point + uphill heading on a mountain road (tests/debug). */
  roadPoint(mountain, frac) {
    return this.generator.roadPoint(mountain, frac);
  }

  // ---- Streaming -----------------------------------------------------------

  update(pos, dt = 0.016) {
    this.chunks.update(pos.x, pos.z);
    this.mountains.update(pos.x, pos.z);
    this.impostors.update(pos.x, pos.z);
    this._pruneT += dt;
    if (this._pruneT > 5) {
      this._pruneT = 0;
      this.generator.pruneCells(pos.x, pos.z); // bound feature-cell cache
    }
  }

  // ---- Debug / verification (used by automated tests) ----------------------

  debugInfo() {
    return this.chunks.debugInfo();
  }

  /** Find the nearest feature of a type; spiral cell search. Test/debug aid. */
  findFeature(type, x, z, maxCells = 30) {
    const gen = this.generator;
    const c0x = Math.floor(x / 80), c0z = Math.floor(z / 80);
    for (let r = 0; r <= maxCells; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const f = gen.cellFeature(c0x + dx, c0z + dz);
          if (f && f.type === type) return f;
        }
      }
    }
    return null;
  }

  _buildLighting(scene) {
    const sky = new THREE.Color(0x7ec4e8);
    scene.background = sky;
    // Fog hides the streaming edge (~128 m worst case) and doubles as
    // Himalayan valley haze under the distant peaks.
    scene.fog = new THREE.Fog(sky, 62, 158);
    scene.add(new THREE.HemisphereLight(0xd4ebff, 0x7d6a44, 0.92));
    const sun = new THREE.DirectionalLight(0xffedc9, 1.22);
    sun.position.set(60, 90, 30);
    scene.add(sun);
  }
}

export { CHUNK_SIZE };
