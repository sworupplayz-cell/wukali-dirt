import { State } from '../core/Game.js';

/**
 * UI — wires the HTML overlays (menu / pause / crash / HUD) to the game.
 * Overlays are plain DOM: zero rendering cost for the 3D scene, crisp on
 * any screen density, and full-screen overlays naturally block the HUD
 * buttons underneath them.
 */
export class UI {
  constructor(game) {
    this.game = game;
    const $ = (id) => document.getElementById(id);

    this.menu = $('menu-overlay');
    this.about = $('about-overlay');
    this.pause = $('pause-overlay');
    this.gameover = $('gameover-overlay');
    this.hud = $('hud');
    this.speedo = $('speedo');
    this.distance = $('distance');
    this.score = $('score');
    this.stuntToast = $('stunt-toast');
    this.summitBanner = $('summit-banner');
    this.toast = $('toast');

    // Main menu
    $('btn-play').addEventListener('click', () => game.play());
    $('btn-about').addEventListener('click', () => {
      this.menu.classList.add('hidden');
      this.about.classList.remove('hidden');
    });
    $('btn-about-back').addEventListener('click', () => {
      this.about.classList.add('hidden');
      this.menu.classList.remove('hidden');
    });
    const musicBtn = $('btn-music');
    const musicLabel = () => {
      musicBtn.textContent = `MUSIC: ${game.audio.musicOn ? 'ON' : 'OFF'}`;
    };
    musicLabel();
    musicBtn.addEventListener('click', () => {
      game.audio.init();
      game.audio.setMusic(!game.audio.musicOn);
      musicLabel();
    });
    $('btn-exit').addEventListener('click', () => {
      window.close();
      setTimeout(() => this._toast('Running in a browser — close this tab to exit.'), 150);
    });

    // Pause overlay
    $('btn-resume').addEventListener('click', () => game.resume());
    $('btn-restart').addEventListener('click', () => game.restart());
    $('btn-main-menu').addEventListener('click', () => game.toMenu());

    // Game over overlay
    $('btn-go-restart').addEventListener('click', () => game.restart());
    $('btn-go-menu').addEventListener('click', () => game.toMenu());

    // Stunt notifications (event-driven; one reused DOM node).
    game.stunts.onStunt = (label, pts, combo) => {
      const failed = label === 'CRASHED';
      this.stuntToast.textContent = failed
        ? `CRASHED +${pts}`
        : `${label} +${pts}${combo > 1 ? '  x' + combo : ''}`;
      this.stuntToast.classList.toggle('bad', failed);
      this.stuntToast.classList.add('show');
      clearTimeout(this._stuntTimer);
      this._stuntTimer = setTimeout(() => this.stuntToast.classList.remove('show'), 1500);
    };

    // HUD
    $('btn-pause').addEventListener('click', () => game.togglePause());
    $('btn-reset').addEventListener('click', () => game.resetBike());
    document.querySelectorAll('[data-control]').forEach((el) => {
      game.input.bindButton(el, el.dataset.control);
    });

    game.onStateChange = (s) => this._applyState(s);
    this._applyState(game.state);

    // Summit banner (one reused node; event-driven).
    game.onSummit = (res) => {
      $('sb-name').textContent = `Mount ${res.name}`;
      $('sb-ach').textContent = res.meta.length
        ? `\u{1F3C6} ${res.meta.join(' \u00B7 ')}`
        : `\u{1F3C6} Mountain Conquered (${game.achievements.summitCount})`;
      this.summitBanner.classList.add('show');
      clearTimeout(this._summitTimer);
      this._summitTimer = setTimeout(() => this.summitBanner.classList.remove('show'), 3800);
    };

    // HUD readouts: update at 5 Hz, not per frame (avoids DOM churn).
    setInterval(() => {
      if (game.state !== State.PLAYING && game.state !== State.CRASHED) return;
      const bike = game.bike;
      // Actual movement speed: scalar on the ground, velocity length in air.
      const ms = bike.grounded
        ? Math.abs(bike.speed)
        : Math.hypot(bike.velocity.x, bike.velocity.y, bike.velocity.z);
      this.speedo.innerHTML = `${Math.round(ms * 3.6)} <span>km/h</span>`;
      this.distance.textContent = fmtDist(game.run.distance);
      this.score.textContent = game.stunts.score > 0 ? `${game.stunts.score} PTS` : '';
    }, 200);
  }

  _applyState(s) {
    this.menu.classList.toggle('hidden', s !== State.MENU);
    this.about.classList.add('hidden');
    this.pause.classList.toggle('hidden', s !== State.PAUSED);
    this.gameover.classList.toggle('hidden', s !== State.CRASHED);
    this.hud.classList.toggle('hidden', s === State.MENU);
    if (s === State.CRASHED) this._fillGameOver();
    if (s === State.PLAYING || s === State.MENU) {
      this.stuntToast.classList.remove('show');
    }
    if (s === State.MENU) this.summitBanner.classList.remove('show');
  }

  _fillGameOver() {
    const g = this.game;
    document.getElementById('go-distance').textContent = fmtDist(g.run.distance);
    const best = document.getElementById('go-best');
    best.textContent = g.newBest ? `${fmtDist(g.run.best)} — NEW BEST!` : fmtDist(g.run.best);
    best.classList.toggle('best-new', g.newBest);
    document.getElementById('go-score').textContent = String(g.stunts.score);
  }

  _toast(msg) {
    this.toast.textContent = msg;
    this.toast.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (this.toast.style.opacity = '0'), 2500);
  }
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}
