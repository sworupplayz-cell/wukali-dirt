/**
 * StuntTracker — detects meaningful jumps purely by observing the bike's
 * existing physics state (grounded / crashed / heightAboveGround / yaw).
 * No changes to bike physics, no allocations per step.
 *
 * A stunt = airborne phase with enough air time or height. Landing clean
 * awards base points x combo; crashing the landing awards only 25% and
 * resets the combo. The combo also decays after 8 s without a stunt.
 */
const MIN_AIR_TIME = 0.45; // s
const MIN_AIR_HEIGHT = 1.1; // m
const COMBO_WINDOW = 8;    // s
const MAX_COMBO = 5;

export class StuntTracker {
  constructor() {
    this.score = 0;
    this.combo = 1;
    this.onStunt = null; // (label, points, combo) — UI shows the toast

    this._air = false;
    this._t = 0;
    this._peak = 0;
    this._sx = 0;
    this._sz = 0;
    this._rot = 0;
    this._prevYaw = 0;
    this._comboT = 0;
  }

  /** New run. */
  reset() {
    this.score = 0;
    this.combo = 1;
    this._air = false;
    this._comboT = 0;
  }

  /** Abort any in-flight tracking (manual bike reset / teleport). */
  cancel() {
    this._air = false;
    this.combo = 1;
    this._comboT = 0;
  }

  /** Per fixed step, after bike.update(). */
  step(bike, dt) {
    if (!this._air) {
      if (!bike.grounded && !bike.crashed) {
        this._air = true;
        this._t = 0;
        this._peak = 0;
        this._sx = bike.position.x;
        this._sz = bike.position.z;
        this._rot = 0;
        this._prevYaw = bike.yaw;
      } else if (this._comboT > 0) {
        this._comboT -= dt;
        if (this._comboT <= 0) this.combo = 1;
      }
      return;
    }

    this._t += dt;
    if (bike.heightAboveGround > this._peak) this._peak = bike.heightAboveGround;
    let dy = bike.yaw - this._prevYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this._rot += dy;
    this._prevYaw = bike.yaw;

    if (bike.grounded) this._land(bike);
  }

  _land(bike) {
    this._air = false;
    const dist = Math.hypot(bike.position.x - this._sx, bike.position.z - this._sz);
    if (dist > 60) return; // teleport mid-"flight": not a stunt

    if (this._t < MIN_AIR_TIME && this._peak < MIN_AIR_HEIGHT) return; // small hop

    const base = 10 * Math.round((this._t * 90 + this._peak * 45 + dist * 4) / 10);
    const whip = Math.abs(this._rot) > 0.7;

    if (bike.crashed) {
      // Crashed the landing: quarter points, combo gone, no celebration.
      const pts = 10 * Math.round(base * 0.25 / 10);
      this.score += pts;
      this.combo = 1;
      this._comboT = 0;
      if (this.onStunt && pts > 0) this.onStunt('CRASHED', pts, 0);
      return;
    }

    let label = 'AIR';
    if (this._t >= 1.9 || this._peak >= 5) label = 'HUGE AIR';
    else if (this._t >= 1.2 || this._peak >= 3) label = 'BIG AIR';
    if (whip) label = 'WHIP ' + label;

    const pts = (base + (whip ? 100 : 0)) * this.combo;
    this.score += pts;
    if (this.onStunt) this.onStunt(label, pts, this.combo);
    this.combo = Math.min(this.combo + 1, MAX_COMBO);
    this._comboT = COMBO_WINDOW;
  }
}
