import * as THREE from 'three';

/**
 * FollowCamera — lightweight third-person chase camera.
 * Frame-rate-independent exponential smoothing, terrain clearance clamp,
 * no allocations per frame.
 */
export class FollowCamera {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this._pos = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._heading = 0;
    this._initialized = false;
  }

  snapTo(bike) {
    this._heading = bike.yaw;
    this._computeDesired(bike);
    this._pos.copy(this._desired);
    this._initialized = true;
    this._apply(bike);
  }

  _computeDesired(bike) {
    const dist = 6.2, height = 2.6;
    const sx = Math.sin(this._heading), cz = Math.cos(this._heading);
    this._desired.set(
      bike.position.x - sx * dist,
      bike.position.y + height,
      bike.position.z - cz * dist
    );
    // Keep the camera above the terrain.
    const groundY = this.world.getHeight(this._desired.x, this._desired.z);
    if (this._desired.y < groundY + 1.1) this._desired.y = groundY + 1.1;
  }

  update(bike, dt) {
    if (!this._initialized) { this.snapTo(bike); return; }

    // Smoothly track the bike heading (shortest angular path).
    let d = bike.yaw - this._heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this._heading += d * Math.min(1, 4.5 * dt);

    this._computeDesired(bike);
    const t = 1 - Math.exp(-8 * dt);
    this._pos.lerp(this._desired, t);
    this._apply(bike);
  }

  _apply(bike) {
    this.camera.position.copy(this._pos);
    this._target.set(
      bike.position.x + Math.sin(this._heading) * 2.0,
      bike.position.y + 1.0,
      bike.position.z + Math.cos(this._heading) * 2.0
    );
    this.camera.lookAt(this._target);
  }

  /** Slow orbit around the spawn area for the main-menu backdrop. */
  menuOrbit(bike, time) {
    const a = time * 0.15;
    const r = 7;
    this.camera.position.set(
      bike.position.x + Math.sin(a) * r,
      bike.position.y + 2.8,
      bike.position.z + Math.cos(a) * r
    );
    this.camera.lookAt(bike.position.x, bike.position.y + 0.8, bike.position.z);
    this._initialized = false; // force a snap when gameplay starts
  }
}
