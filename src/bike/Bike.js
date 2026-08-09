import * as THREE from 'three';

/**
 * Bike — arcade dirt-bike physics on a heightfield.
 *
 * Deliberately NOT a rigid-body motorcycle simulation: a scalar forward
 * speed + heading + heightfield contact model is stable, cheap and
 * predictable on low-end phones. The bike only talks to the world through
 * the sampling interface (getHeight/getNormal/getColliders), so a future
 * procedural chunk world can be swapped in without touching this file.
 */

const G = 18;                 // arcade gravity (m/s^2)
const MAX_SPEED = 26;         // ~94 km/h
const MAX_REVERSE = -4.5;
const ACCEL = 11;
const BRAKE_DECEL = 17;
const REVERSE_ACCEL = 4.5;
const WHEELBASE = 1.35;
const MAX_GROUND_SLOPE = 1.0;  // steepest rise (45°) ground-following may climb
const CRASH_LAND_VY = -12.0;  // downward speed + bad pitch => crash
const CRASH_LAND_PITCH = 0.9;
const CRASH_HIT_SPEED = 10;   // head-on prop hit above this => crash

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _qLean = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();
const _axisZ = new THREE.Vector3(0, 0, 1);
const _axisX = new THREE.Vector3(1, 0, 0);

export class Bike {
  constructor(world) {
    this.world = world;

    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3(); // used while airborne
    this.forward = new THREE.Vector3(0, 0, 1);
    this.groundNormal = new THREE.Vector3(0, 1, 0);

    this.yaw = 0;
    this.speed = 0;          // signed scalar, along forward, while grounded
    this.steer = 0;          // smoothed steering [-1, 1]
    this.roll = 0;           // lean, rad
    this.airPitch = 0;       // extra pitch while airborne, rad
    this.crashRoll = 0;      // tip-over animation when crashed
    this.grounded = true;
    this.crashed = false;
    this.crashTimer = 0;
    this.wheelSpin = 0;
    this.suspension = 0;     // visual spring value
    this._suspVel = 0;
    this._safeTimer = 0;
    this._safe = { x: 0, y: 0, z: 0, yaw: 0 };
    this.heightAboveGround = 0;

    this.onCrash = null;     // event hook (Game listens; no polling)

    this.fullReset();
  }

  /** Back to spawn (used by PLAY / RESTART). */
  fullReset() {
    const s = this.world.getSpawn();
    this._placeAt(s.x, s.y, s.z, s.yaw);
    this._safe = { x: s.x, y: s.y, z: s.z, yaw: s.yaw };
  }

  /** Back to last safe position (R key / reset button / after crash). */
  reset() {
    const s = this._safe;
    this._placeAt(s.x, this.world.getHeight(s.x, s.z), s.z, s.yaw);
  }

  _placeAt(x, y, z, yaw) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.speed = 0;
    this.steer = 0;
    this.roll = 0;
    this.airPitch = 0;
    this.crashRoll = 0;
    this.grounded = true;
    this.crashed = false;
    this.crashTimer = 0;
    this.suspension = 0;
    this._suspVel = 0;
    this._safeTimer = 0;
    this.groundNormal.set(0, 1, 0);
    this._updateOrientation(1 / 60);
  }

  _crash() {
    if (this.crashed) return;
    this.crashed = true;
    this.crashTimer = 0;
    if (this.onCrash) this.onCrash();
  }

  /** Fixed-timestep update. input: { throttle, brake, steer } each frame. */
  update(dt, input) {
    const world = this.world;
    const throttle = this.crashed ? 0 : input.throttle;
    const brake = this.crashed ? 0 : input.brake;
    const steerIn = this.crashed ? 0 : input.steer;

    // Smooth the steering input so touch taps don't snap the bike.
    this.steer += (steerIn - this.steer) * Math.min(1, 10 * dt);

    if (this.grounded) {
      this._groundStep(dt, throttle, brake);
    } else {
      this._airStep(dt, throttle, brake);
    }

    if (this.crashed) {
      this.crashTimer += dt;
      // Tip over and grind to a stop.
      this.crashRoll += (Math.PI / 2.1 - this.crashRoll) * Math.min(1, 5 * dt);
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 14 * dt);
    }

    this._collideProps();
    this._recordSafePosition(dt);
    this._updateSuspension(dt);
    this._updateOrientation(dt);

    this.wheelSpin += (this.speed / 0.34) * dt;
    this.heightAboveGround = this.position.y - world.getHeight(this.position.x, this.position.z);

    // Out of the test area: snap back to safety (Phase 2 world removes this).
    if (!world.isInBounds(this.position.x, this.position.z) || this.position.y < -30) {
      this.reset();
    }
  }

  _groundStep(dt, throttle, brake) {
    // Forward on the ground plane.
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const n = this.groundNormal;
    _v1.copy(this.forward).addScaledVector(n, -this.forward.dot(n)).normalize();

    // Speed: throttle tapers near max, brake reverses slowly, drag otherwise.
    if (throttle > 0) {
      this.speed += ACCEL * (1 - Math.max(this.speed, 0) / MAX_SPEED) * throttle * dt;
    } else if (brake > 0) {
      if (this.speed > 0.3) this.speed -= BRAKE_DECEL * brake * dt;
      else this.speed = Math.max(this.speed - REVERSE_ACCEL * brake * dt, MAX_REVERSE);
    } else {
      this.speed *= 1 - Math.min(1, 0.5 * dt);
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 0.8 * dt);
    }
    // Slope resistance/assist along travel direction.
    this.speed -= 13 * _v1.y * dt;
    this.speed = Math.max(MAX_REVERSE, Math.min(MAX_SPEED, this.speed));

    // Steering: fades in with speed, tightens down at high speed.
    const turnFactor =
      Math.max(-1, Math.min(1, this.speed / 4)) / (1 + Math.abs(this.speed) * 0.025);
    this.yaw -= this.steer * 2.1 * turnFactor * dt;

    // Move along the slope.
    const prevY = this.position.y;
    this.position.x += _v1.x * this.speed * dt;
    this.position.z += _v1.z * this.speed * dt;
    const vy = _v1.y * this.speed;

    const groundY = this.world.getHeight(this.position.x, this.position.z);
    const predictedY = prevY + (vy - G * dt) * dt;

    if (predictedY > groundY + 0.06 && !this.crashed) {
      // Ground fell away faster than gravity: takeoff.
      this.grounded = false;
      this.velocity.copy(_v1).multiplyScalar(this.speed);
      this.velocity.y = Math.min(vy, 11);
      this.position.y = prevY + vy * dt;
    } else {
      const rise = groundY - prevY;
      const horiz = Math.abs(this.speed) * dt + 1e-6;
      if (rise > horiz * MAX_GROUND_SLOPE + 0.03) {
        // The terrain rises faster than any wheel could follow: that's a
        // wall, not a slope. Stay below the face and thud off it instead
        // of snapping upward onto higher ground.
        this.position.x -= _v1.x * this.speed * dt;
        this.position.z -= _v1.z * this.speed * dt;
        this.position.y = this.world.getHeight(this.position.x, this.position.z);
        this.speed *= 0.2;
        this._suspVel -= 2;
      } else {
        this.position.y = groundY;
        this._suspVel += THREE.MathUtils.clamp(rise * 6 - vy * 0.15, -3, 3) * dt * 12;
      }
    }

    // Lean into turns.
    const targetRoll =
      this.steer * 0.5 * Math.min(1, Math.abs(this.speed) / 9) * Math.sign(this.speed >= 0 ? 1 : -1);
    this.roll += (targetRoll - this.roll) * Math.min(1, 8 * dt);
    this.airPitch *= 1 - Math.min(1, 10 * dt);
  }

  _airStep(dt, throttle, brake) {
    this.velocity.y -= G * dt;
    this.position.addScaledVector(this.velocity, dt);

    // Light air control: throttle lifts the nose, brake drops it,
    // steering gives a slow air-turn plus lean. Rates tuned so holding
    // full throttle over a normal jump stays below the crash threshold.
    this.airPitch += (throttle * 0.9 - brake * 1.4) * dt;
    this.airPitch = THREE.MathUtils.clamp(this.airPitch, -1.0, 1.0);
    this.yaw -= this.steer * 0.8 * dt;
    this.roll += (this.steer * 0.35 - this.roll) * Math.min(1, 3 * dt);

    const groundY = this.world.getHeight(this.position.x, this.position.z);
    if (this.position.y <= groundY) {
      this.position.y = groundY;
      this.grounded = true;

      // Keep only the speed component along the bike's heading.
      this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.speed = this.velocity.x * this.forward.x + this.velocity.z * this.forward.z;
      this.speed = THREE.MathUtils.clamp(this.speed, MAX_REVERSE, MAX_SPEED);

      if (this.velocity.y < CRASH_LAND_VY && Math.abs(this.airPitch) > CRASH_LAND_PITCH) {
        this._crash();
      }
      this._suspVel += THREE.MathUtils.clamp(this.velocity.y * 0.25, -3.5, 0);
      this.velocity.set(0, 0, 0);
    }
  }

  _collideProps() {
    const colliders = this.world.getColliders();
    const px = this.position.x, pz = this.position.z;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      const dx = px - c.x, dz = pz - c.z;
      const rr = c.r + 0.45;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-6) continue;

      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      // Push out of the collider.
      this.position.x = c.x + nx * rr;
      this.position.z = c.z + nz * rr;

      // Head-on component of travel into the prop.
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const into = -(fx * nx + fz * nz) * this.speed;
      if (into > CRASH_HIT_SPEED && !this.crashed) this._crash();
      this.speed *= 0.35;
      if (!this.grounded) { this.velocity.x *= 0.2; this.velocity.z *= 0.2; }
    }
  }

  _recordSafePosition(dt) {
    if (!this.grounded || this.crashed || Math.abs(this.roll) > 0.4 || this.speed < 0) return;
    this._safeTimer += dt;
    if (this._safeTimer < 1.5) return;
    this._safeTimer = 0;
    // Only accept reasonably flat ground — never reset onto a ramp face
    // or a steep hillside where the bike would roll away.
    this.world.getNormal(this.position.x, this.position.z, _v2);
    if (_v2.y < 0.96) return;
    // Don't record a spot that touches a prop collider.
    const colliders = this.world.getColliders();
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      const dx = this.position.x - c.x, dz = this.position.z - c.z;
      if (dx * dx + dz * dz < (c.r + 2) * (c.r + 2)) return;
    }
    this._safe.x = this.position.x;
    this._safe.y = this.position.y;
    this._safe.z = this.position.z;
    this._safe.yaw = this.yaw;
  }

  _updateSuspension(dt) {
    // Critically-damped-ish spring for the visual chassis bob.
    const k = 60, damp = 9;
    this._suspVel += (-this.suspension * k - this._suspVel * damp) * dt;
    this.suspension = THREE.MathUtils.clamp(this.suspension + this._suspVel * dt, -0.14, 0.1);
  }

  _updateOrientation(dt) {
    const world = this.world;
    // Smoothly track the terrain normal (or world-up while airborne).
    if (this.grounded) {
      world.getNormal(this.position.x, this.position.z, _v2);
    } else {
      _v2.set(0, 1, 0);
    }
    const t = 1 - Math.exp(-(this.grounded ? 10 : 2.2) * dt);
    this.groundNormal.lerp(_v2, t).normalize();

    // Basis: up = smoothed normal, forward = heading projected on the plane.
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _v1.copy(this.forward)
      .addScaledVector(this.groundNormal, -this.forward.dot(this.groundNormal))
      .normalize();
    _v2.crossVectors(this.groundNormal, _v1); // right axis
    _m.makeBasis(_v2, this.groundNormal, _v1);
    this.quaternion.setFromRotationMatrix(_m);

    // Local lean (steer + crash tip) and airborne pitch.
    _qLean.setFromAxisAngle(_axisZ, this.roll + this.crashRoll);
    _qPitch.setFromAxisAngle(_axisX, -this.airPitch);
    this.quaternion.multiply(_qPitch).multiply(_qLean);
  }
}
