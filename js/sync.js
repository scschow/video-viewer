import { clamp, formatTime } from './utils.js';

const DRIFT_CHECK_MS = 250;

/**
 * Drives two Players in sync over their trimmed ranges.
 *
 * Modes:
 *  - 'frame':    both videos advance the same number of frames past their start frames.
 *  - 'percent':  both videos move through their trimmed ranges at the same fraction.
 *  - 'keyframe': manual stepping; each video jumps to its next/prev tagged keyframe.
 *
 * Playback plays the "driver" video natively and slaves the other via
 * playbackRate plus periodic drift correction, which stays smooth.
 */
export class SyncEngine {
  constructor(a, b) {
    this.a = a;
    this.b = b;
    this.mode = 'frame';
    this.speed = 1;
    this.loop = false;
    this.playing = false;
    this._driftTimer = null;
    this._rafId = null;
    this._listeners = {};

    for (const p of [a, b]) {
      p.on('loaded', () => this._emit('change'));
      p.on('trim', () => { this.pause(); this._emit('change'); });
    }
  }

  on(event, cb) { (this._listeners[event] ??= []).push(cb); }
  _emit(event, ...args) { for (const cb of this._listeners[event] ?? []) cb(...args); }

  get ready() { return this.a.loaded && this.b.loaded; }

  get canPlay() { return this.ready && this.mode !== 'keyframe'; }

  /**
   * Master position m:
   *  - frame mode:   frames elapsed, in [0, maxRangeFrames]
   *  - percent mode: fraction, in [0, 1]
   */
  get masterLength() {
    if (this.mode === 'frame') return Math.max(this.a.rangeFrames, this.b.rangeFrames);
    return 1;
  }

  /** The video whose native playback defines the master clock. */
  get driver() {
    if (this.mode === 'frame') {
      return this.a.rangeFrames >= this.b.rangeFrames ? this.a : this.b;
    }
    // Percent mode: both ranges finish together; drive from the longer range
    // (in seconds) so the slave's playbackRate stays <= 1 and never clips at 16x.
    const secsA = this.a.rangeFrames / this.a.fps;
    const secsB = this.b.rangeFrames / this.b.fps;
    return secsA >= secsB ? this.a : this.b;
  }

  get slave() { return this.driver === this.a ? this.b : this.a; }

  /** Current master position derived from the driver's playhead. */
  get position() {
    const d = this.driver;
    // Seeks land at frame centers ((f + 0.5)/fps), so subtract the half frame back out.
    const framesElapsed = d.el.video.currentTime * d.fps - 0.5 - d.rangeStartFrame;
    if (this.mode === 'frame') return clamp(framesElapsed, 0, this.masterLength);
    return clamp(framesElapsed / d.rangeFrames, 0, 1);
  }

  get progress() { return this.masterLength ? this.position / this.masterLength : 0; }

  _timeFor(player, m) {
    let frame;
    if (this.mode === 'frame') {
      frame = player.rangeStartFrame + Math.min(m, player.rangeFrames);
    } else {
      frame = player.rangeStartFrame + m * player.rangeFrames;
    }
    return clamp((frame + 0.5) / player.fps, 0, Math.max(0, player.duration - 0.001));
  }

  /** Seek both videos to master position m (used for scrub and stepping). */
  applyPosition(m) {
    if (!this.ready) return;
    m = clamp(m, 0, this.masterLength);
    this.a.seekToTime(this._timeFor(this.a, m));
    this.b.seekToTime(this._timeFor(this.b, m));
    this._emit('position');
  }

  scrubToProgress(frac) {
    this.pause();
    this.applyPosition(clamp(frac, 0, 1) * this.masterLength);
  }

  setMode(mode) {
    this.pause();
    this.mode = mode;
    if (mode !== 'keyframe' && this.ready) this.applyPosition(0);
    this._emit('change');
  }

  setSpeed(speed) {
    this.speed = speed;
    if (this.playing) this._applyRates();
  }

  // ---------------- stepping ----------------

  step(delta) {
    if (!this.ready) return;
    this.pause();
    if (this.mode === 'keyframe') {
      this.stepKeyframe(Math.sign(delta));
      return;
    }
    const inc = this.mode === 'frame' ? delta : delta / this.masterFrameCount();
    this.applyPosition(this.position + inc);
  }

  /** Finest-grained frame count across both ranges, for percent-mode stepping. */
  masterFrameCount() {
    return Math.max(this.a.rangeFrames, this.b.rangeFrames);
  }

  /** Each video jumps to its own next/previous tagged keyframe inside its range. */
  stepKeyframe(dir) {
    for (const p of [this.a, this.b]) {
      const target = dir > 0 ? p.nextKeyframe(true) : p.prevKeyframe(true);
      if (target === undefined && dir < 0) p.seekToFrame(p.rangeStartFrame);
    }
    this._emit('position');
  }

  // ---------------- synced playback ----------------

  play() {
    if (!this.canPlay || this.playing) return;
    // If we're at (or past) the end, restart from the top of the ranges.
    if (this.position >= this.masterLength - 1e-6) this.applyPosition(0);
    this.playing = true;
    this._applyRates();
    this.a.el.video.play();
    this.b.el.video.play();
    this._driftTimer = setInterval(() => this._correctDrift(), DRIFT_CHECK_MS);
    const watchEnd = () => {
      if (!this.playing) return;
      if (this.position >= this.masterLength - 1e-6 || this._driverAtEnd()) {
        if (this.loop) {
          this.applyPosition(0);
        } else {
          this.pause();
          this.applyPosition(this.masterLength);
        }
      }
      this._rafId = requestAnimationFrame(watchEnd);
    };
    this._rafId = requestAnimationFrame(watchEnd);
    this._emit('playstate');
  }

  pause() {
    if (this._driftTimer) clearInterval(this._driftTimer);
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._driftTimer = this._rafId = null;
    if (!this.playing) return;
    this.playing = false;
    this.a.pause();
    this.b.pause();
    this._emit('playstate');
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  _driverAtEnd() {
    const d = this.driver;
    const endTime = (d.rangeEndFrame + 0.5) / d.fps;
    return d.el.video.currentTime >= Math.min(endTime, d.duration - 0.05) || d.el.video.ended;
  }

  _applyRates() {
    const d = this.driver, s = this.slave;
    d.el.video.playbackRate = this.speed;
    let ratio;
    if (this.mode === 'frame') {
      // Same frames/sec in master units; slave seconds advance fps_d/fps_s as fast.
      ratio = d.fps / s.fps;
    } else {
      // Ranges complete together: slave covers rangeS seconds while driver covers rangeD.
      ratio = (s.rangeFrames / s.fps) / (d.rangeFrames / d.fps);
    }
    s.el.video.playbackRate = clamp(this.speed * ratio, 0.0625, 16);
  }

  _correctDrift() {
    if (!this.playing) return;
    const s = this.slave;
    const expected = this._timeFor(s, this.position);
    const actual = s.el.video.currentTime;
    // Re-sync when off by more than half of the slave's frame interval.
    if (Math.abs(expected - actual) > 0.5 / s.fps) {
      s.seekToTime(expected);
    }
  }

  statusText() {
    if (!this.ready) return 'Load both videos to sync';
    if (this.mode === 'keyframe') {
      const ka = this.a._trimmedKeyframes(true).length;
      const kb = this.b._trimmedKeyframes(true).length;
      if (!ka || !kb) return 'Tag keyframes in both videos, then step with ‹ ›';
      return `keyframes: A ${ka} · B ${kb}`;
    }
    if (this.mode === 'frame') {
      return `frame ${Math.round(this.position)} / ${this.masterLength}`;
    }
    return `${(this.progress * 100).toFixed(1)}%  ·  ${formatTime(this.a.el.video.currentTime)} | ${formatTime(this.b.el.video.currentTime)}`;
  }
}
