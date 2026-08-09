/**
 * Input — single abstraction for keyboard + touch HUD buttons.
 * Gameplay code only reads { throttle, brake, steer }; it never touches
 * DOM events or key codes directly.
 */
export class Input {
  constructor() {
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.enabled = true;

    this.onPause = null;
    this.onReset = null;

    this._keys = new Set();
    this._touch = { gas: false, brake: false, left: false, right: false };

    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      if (e.repeat) return;
      this._keys.add(e.code);
      if ((e.code === 'Escape' || e.code === 'KeyP') && this.onPause) this.onPause();
      if (e.code === 'KeyR' && this.onReset) this.onReset();
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
    window.addEventListener('blur', () => this.clear());
  }

  /** Attach a HUD element as a hold-button for a named control. */
  bindButton(el, control) {
    const set = (on) => {
      this._touch[control] = on;
      el.classList.toggle('active', on);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      set(true);
    });
    const off = (e) => { e.preventDefault(); set(false); };
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  clear() {
    this._keys.clear();
    for (const k in this._touch) this._touch[k] = false;
    document.querySelectorAll('.ctl.active').forEach((el) => el.classList.remove('active'));
  }

  /** Recompute the control state; called once per rendered frame. */
  update() {
    if (!this.enabled) {
      this.throttle = this.brake = this.steer = 0;
      return;
    }
    const k = this._keys, t = this._touch;
    this.throttle = k.has('KeyW') || k.has('ArrowUp') || t.gas ? 1 : 0;
    this.brake = k.has('KeyS') || k.has('ArrowDown') || t.brake ? 1 : 0;
    const left = k.has('KeyA') || k.has('ArrowLeft') || t.left;
    const right = k.has('KeyD') || k.has('ArrowRight') || t.right;
    this.steer = (right ? 1 : 0) - (left ? 1 : 0);
  }
}
