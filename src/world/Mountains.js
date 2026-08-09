import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './noise.js';

/**
 * Mountains — a ring of very low-poly Himalayan silhouettes far beyond the
 * streamed terrain. One merged geometry, one unlit draw call, no collision.
 * The ring re-centers on the player every frame so the peaks stay "at
 * infinity" and are never reachable.
 */
export class Mountains {
  constructor(scene, seed) {
    const rng = mulberry32(seed ^ 0xbeef);
    const parts = [];
    // Two rows: big jagged peaks behind, smaller foothill ridges in front.
    for (let i = 0; i < 26; i++) {
      const back = i < 12;
      const n = back ? 12 : 14;
      const k = back ? i : i - 12;
      const ang = (k / n) * Math.PI * 2 + (rng() - 0.5) * 0.55 + (back ? 0.22 : 0);
      const R = back ? 1050 + rng() * 250 : 780 + rng() * 180;
      const baseR = back ? 280 + rng() * 260 : 200 + rng() * 160;
      const h = back ? 260 + rng() * 260 : 120 + rng() * 130;
      const snowFrom = back ? 0.22 + rng() * 0.15 : 0.55 + rng() * 0.4;
      const cone = new THREE.ConeGeometry(baseR, h, 7, 3);
      cone.deleteAttribute('uv');
      const p = cone.attributes.position;
      // Roughen the silhouette so peaks aren't perfect triangles.
      for (let vtx = 0; vtx < p.count; vtx++) {
        const t = (p.getY(vtx) + h / 2) / h;
        if (t < 0.95) {
          const j = (hashLike(vtx * 7 + i * 131) - 0.5) * baseR * 0.16 * (1 - t);
          p.setX(vtx, p.getX(vtx) + j);
          p.setZ(vtx, p.getZ(vtx) + (hashLike(vtx * 13 + i * 311) - 0.5) * baseR * 0.16 * (1 - t));
        }
      }
      const colors = new Float32Array(p.count * 3);
      for (let vtx = 0; vtx < p.count; vtx++) {
        const t = (p.getY(vtx) + h / 2) / h; // 0 base .. 1 peak
        // Hazy blue rock fading from the sky at the base, snow above.
        let r = 0.50 + (0.71 - 0.50) * (1 - t);
        let g = 0.56 + (0.79 - 0.56) * (1 - t);
        let b = 0.68 + (0.90 - 0.68) * (1 - t);
        const sn = smooth(snowFrom, snowFrom + 0.13, t);
        r += (0.95 - r) * sn; g += (0.96 - g) * sn; b += (0.99 - b) * sn;
        colors[vtx * 3] = r; colors[vtx * 3 + 1] = g; colors[vtx * 3 + 2] = b;
      }
      cone.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      cone.translate(Math.cos(ang) * R, h / 2 - 70 - rng() * 25, Math.sin(ang) * R);
      parts.push(cone);
    }
    const geo = mergeGeometries(parts);
    parts.forEach((g) => g.dispose());
    // Unlit + fog-exempt: silhouettes float above the distance haze.
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(x, z) {
    this.mesh.position.set(x, 0, z);
  }
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hashLike(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
