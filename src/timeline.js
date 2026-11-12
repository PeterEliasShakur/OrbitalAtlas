/**
 * Simulation clock + bottom-bar timeline controls.
 *
 * The clock produces a UTC epoch-ms "simulation time". In live mode it equals
 * the system clock. All satellite positions are re-propagated from orbital
 * elements for whatever time the clock reports.
 */
import { TIMELINE } from './config.js';

const H = 3_600_000;

export class SimClock {
  constructor({ windowHours = TIMELINE.windowHours } = {}) {
    this.windowMs = windowHours * H;
    this.speed = 1;
    this.paused = false;
    this.anchorSim = Date.now();
    this.anchorReal = performance.now();
    this.listeners = new Set();
  }

  /** Current simulation time (ms). Clamped to the allowed window. */
  now() {
    if (this.paused) return this.anchorSim;
    const t = this.anchorSim + (performance.now() - this.anchorReal) * this.speed;
    const real = Date.now();
    if (t > real + this.windowMs || t < real - this.windowMs) {
      // reached the edge of the prediction window: stop there
      this._reanchor(Math.min(real + this.windowMs, Math.max(real - this.windowMs, t)));
      this.paused = true;
      this.emit('limit');
    }
    return this.paused ? this.anchorSim : t;
  }

  offsetMs() {
    return this.now() - Date.now();
  }

  /** "Live" = 1× speed, running, and within 2 s of the system clock. */
  isLive() {
    return !this.paused && this.speed === 1 && Math.abs(this.offsetMs()) < 2000;
  }

  _reanchor(simMs) {
    this.anchorSim = simMs;
    this.anchorReal = performance.now();
  }

  setSpeed(speed) {
    this._reanchor(this.now());
    this.speed = speed;
    this.emit('change');
  }

  setPaused(p) {
    this._reanchor(this.now());
    this.paused = p;
    this.emit('change');
  }

  setTime(ms) {
    const real = Date.now();
    const clamped = Math.min(real + this.windowMs, Math.max(real - this.windowMs, ms));
    this._reanchor(clamped);
    this.emit('jump');
  }

  goLive() {
    this.speed = 1;
    this.paused = false;
    this._reanchor(Date.now());
    this.emit('jump');
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type) {
    for (const fn of this.listeners) fn(type, this);
  }
}

export function formatOffset(ms) {
  const sign = ms < 0 ? '−' : '+';
  let s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Wire the bottom-bar controls to a SimClock.
 * Expects elements: #tl-play, #tl-live, #tl-slider, #tl-offset, .tl-speed[data-speed]
 */
export class TimelineControls {
  constructor(clock, root = document) {
    this.clock = clock;
    this.playBtn = root.querySelector('#tl-play');
    this.liveBtn = root.querySelector('#tl-live');
    this.slider = root.querySelector('#tl-slider');
    this.offsetEl = root.querySelector('#tl-offset');
    this.speedBtns = [...root.querySelectorAll('.tl-speed')];
    this.backBtn = root.querySelector('#tl-back');
    this.fwdBtn = root.querySelector('#tl-fwd');
    this.dragging = false;

    const winMin = clock.windowMs / 60_000;
    this.slider.min = String(-winMin);
    this.slider.max = String(winMin);
    this.slider.step = '1';
    const scale = root.querySelectorAll('.tl-scale span');
    if (scale.length === 3) {
      scale[0].textContent = `−${winMin / 60} h`;
      scale[2].textContent = `+${winMin / 60} h`;
    }

    this.playBtn.addEventListener('click', () => clock.setPaused(!clock.paused));
    this.liveBtn.addEventListener('click', () => clock.goLive());
    this.backBtn?.addEventListener('click', () => clock.setTime(clock.now() - H));
    this.fwdBtn?.addEventListener('click', () => clock.setTime(clock.now() + H));
    for (const b of this.speedBtns) {
      b.addEventListener('click', () => {
        if (clock.paused) clock.setPaused(false);
        clock.setSpeed(Number(b.dataset.speed));
      });
    }
    this.slider.addEventListener('pointerdown', () => (this.dragging = true));
    const endDrag = () => (this.dragging = false);
    this.slider.addEventListener('pointerup', endDrag);
    this.slider.addEventListener('change', endDrag);
    this.slider.addEventListener('input', () => {
      clock.setTime(Date.now() + Number(this.slider.value) * 60_000);
    });
    this.unsub = clock.on(() => this.render());
    this.render();
  }

  /** Called every frame from the main loop (cheap DOM updates only). */
  tick() {
    const off = this.clock.offsetMs();
    if (!this.dragging) this.slider.value = String(Math.round(off / 60_000));
    const pct = ((Number(this.slider.value) - Number(this.slider.min)) / (Number(this.slider.max) - Number(this.slider.min))) * 100;
    this.slider.style.setProperty('--fill', `${pct}%`);
    const live = this.clock.isLive();
    this.offsetEl.textContent = live ? 'LIVE · now' : `${formatOffset(off)} from now`;
    this.offsetEl.classList.toggle('is-live', live);
    this.liveBtn.classList.toggle('is-active', live);
  }

  render() {
    const c = this.clock;
    this.playBtn.setAttribute('aria-pressed', String(!c.paused));
    this.playBtn.querySelector('use')?.setAttribute('href', c.paused ? '#i-play' : '#i-pause');
    this.playBtn.title = c.paused ? 'Resume simulation' : 'Pause simulation';
    this.playBtn.setAttribute('aria-label', this.playBtn.title);
    for (const b of this.speedBtns) {
      const on = Number(b.dataset.speed) === c.speed;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  dispose() {
    this.unsub?.();
  }
}
