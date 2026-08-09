/**
 * Achievements — lightweight local achievement manager.
 * One record per conquered mountain summit plus count-based meta
 * achievements. Persists to localStorage; no backend, no per-frame work.
 * Kept UI-agnostic so a future dedicated achievements screen can read
 * `list()` without changes here.
 */
const KEY = 'wukali_achievements';

const META = [
  { count: 1, id: 'first_summit', title: 'First Summit' },
  { count: 3, id: 'mountain_rider', title: 'Mountain Rider' },
  { count: 5, id: 'king_of_mountains', title: 'King of the Mountains' },
];

export class Achievements {
  constructor() {
    try {
      this._data = JSON.parse(localStorage.getItem(KEY)) || {};
    } catch {
      this._data = {};
    }
    this._data.summits = this._data.summits || {};
    this._data.meta = this._data.meta || {};
  }

  get summitCount() {
    return Object.keys(this._data.summits).length;
  }

  hasSummit(id) {
    return !!this._data.summits[id];
  }

  /**
   * Register a summit. Returns null if already conquered, else
   * { name, meta: [newly unlocked meta titles] } for the UI banner.
   */
  reachSummit(mountain) {
    if (this._data.summits[mountain.id]) return null;
    this._data.summits[mountain.id] = mountain.name;
    const meta = [];
    for (const a of META) {
      if (!this._data.meta[a.id] && this.summitCount >= a.count) {
        this._data.meta[a.id] = true;
        meta.push(a.title);
      }
    }
    this._save();
    return { name: mountain.name, meta };
  }

  /** All unlocked achievements (for a future achievements screen). */
  list() {
    return {
      summits: { ...this._data.summits },
      meta: META.filter((a) => this._data.meta[a.id]).map((a) => a.title),
    };
  }

  _save() {
    localStorage.setItem(KEY, JSON.stringify(this._data));
  }
}
