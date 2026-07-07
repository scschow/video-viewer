import {
  clamp, formatTime, detectFps, snapFps,
  videoKey, loadVideoMeta, saveVideoMeta,
  axisDelta, axisFraction,
} from './utils.js';

export const SPEEDS = [1, 0.5, 0.25, 0.125];
const SPEED_LABELS = { 1: '1×', 0.5: '½', 0.25: '¼', 0.125: '⅛' };
const DEFAULT_FPS = 30;
const SCRUB_PX_PER_FRAME = 5;

/**
 * A single video pane: loading, frame-accurate transport, drag scrubbing,
 * keyframe tagging, and (optionally) start/end trim markers for compare mode.
 */
export class Player {
  constructor(root, { label = '', showTrim = false } = {}) {
    this.root = root;
    this.label = label;
    this.showTrim = showTrim;

    this.fps = DEFAULT_FPS;
    this.fpsDetected = false;
    this.loaded = false;
    this._duration = 0;
    this.speed = 1;
    this.keyframes = [];       // sorted frame indices
    this.trimStart = null;     // frame index or null
    this.trimEnd = null;
    this.storageKey = null;
    this.objectUrl = null;

    this._targetTime = null;   // pending-seek coalescing
    this._seekBusy = false;
    this._listeners = {};

    this._buildDom();
    this._bindVideoEvents();
    this._bindScrub();
    this._bindControls();
    this._startUiLoop();
  }

  // ---------------- events ----------------

  on(event, cb) {
    (this._listeners[event] ??= []).push(cb);
  }

  _emit(event, ...args) {
    for (const cb of this._listeners[event] ?? []) cb(...args);
  }

  // ---------------- DOM ----------------

  _buildDom() {
    this.root.innerHTML = `
      <div class="player-card">
        <div class="player-title">
          ${this.label ? `<b>${this.label}</b>` : ''}
          <span class="file-name">No video loaded</span>
          <button class="load-link">Load video…</button>
        </div>
        <div class="video-shell">
          <video playsinline preload="auto"></video>
          <div class="scrub-layer" hidden></div>
          <div class="drop-hint">
            <span class="big">⇩</span>
            <span>Drop a video here or click to browse</span>
            <span class="sub" style="font-size:12px">MP4 · MOV · WebM</span>
            <span class="err" hidden></span>
          </div>
          <div class="scrub-badge"></div>
          <div class="kf-flash"></div>
        </div>
        <div class="timeline">
          <div class="tl-trim" hidden></div>
          <div class="tl-fill"></div>
          <div class="tl-markers"></div>
          <div class="tl-playhead"></div>
        </div>
        <div class="controls-row">
          <div class="btn-group">
            <button class="ctl-btn kf-prev" title="Previous keyframe (↓)">|◀</button>
            <button class="ctl-btn step-back" title="Back one frame (←)">‹</button>
            <button class="ctl-btn play-btn" title="Play / pause (Space)">►</button>
            <button class="ctl-btn step-fwd" title="Forward one frame (→)">›</button>
            <button class="ctl-btn kf-next" title="Next keyframe (↑)">▶|</button>
          </div>
          <button class="ctl-btn kf-btn" title="Tag / untag keyframe (K)">⚑</button>
          <div class="seg-group speed-group">
            ${SPEEDS.map((s, i) =>
              `<button class="seg-btn ${s === 1 ? 'active' : ''}" data-speed="${s}">${SPEED_LABELS[s]}</button>`
            ).join('')}
          </div>
          <label class="chk-label mute-label"><input type="checkbox" class="mute-chk" checked> Mute</label>
          <span class="fps-box">fps <input type="number" class="fps-input" min="1" max="480" step="0.01" value="${DEFAULT_FPS}"></span>
          <span class="readout">frame <b class="ro-frame">–</b> · <span class="ro-time">0:00.00</span> / <span class="ro-dur">0:00.00</span></span>
        </div>
        ${this.showTrim ? `
        <div class="trim-row">
          <button class="ctl-btn trim-start-btn" title="Use the current frame as this video's sync start">Set start</button>
          <button class="ctl-btn trim-end-btn" title="Use the current frame as this video's sync end">Set end</button>
          <button class="ctl-btn trim-clear-btn">Clear</button>
          <span class="trim-readout">range: <b class="ro-trim">full video</b></span>
        </div>` : ''}
        <input type="file" accept="video/*,.mov,.mp4,.m4v,.webm" hidden class="file-input">
      </div>`;

    const $ = (sel) => this.root.querySelector(sel);
    this.el = {
      card: $('.player-card'),
      video: $('video'),
      shell: $('.video-shell'),
      scrubLayer: $('.scrub-layer'),
      dropHint: $('.drop-hint'),
      dropErr: $('.drop-hint .err'),
      scrubBadge: $('.scrub-badge'),
      kfFlash: $('.kf-flash'),
      fileName: $('.file-name'),
      fileInput: $('.file-input'),
      loadLink: $('.load-link'),
      timeline: $('.timeline'),
      tlTrim: $('.tl-trim'),
      tlFill: $('.tl-fill'),
      tlMarkers: $('.tl-markers'),
      tlPlayhead: $('.tl-playhead'),
      playBtn: $('.play-btn'),
      stepBack: $('.step-back'),
      stepFwd: $('.step-fwd'),
      kfPrev: $('.kf-prev'),
      kfNext: $('.kf-next'),
      kfBtn: $('.kf-btn'),
      speedGroup: $('.speed-group'),
      muteChk: $('.mute-chk'),
      fpsInput: $('.fps-input'),
      roFrame: $('.ro-frame'),
      roTime: $('.ro-time'),
      roDur: $('.ro-dur'),
      roTrim: $('.ro-trim'),
      trimStartBtn: $('.trim-start-btn'),
      trimEndBtn: $('.trim-end-btn'),
      trimClearBtn: $('.trim-clear-btn'),
    };
    this.el.video.muted = true;
  }

  // ---------------- loading ----------------

  _bindVideoEvents() {
    const { video, dropHint, dropErr, fileInput, loadLink, shell } = this.el;

    const openPicker = () => fileInput.click();
    dropHint.addEventListener('click', openPicker);
    loadLink.addEventListener('click', openPicker);
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) this.loadFile(fileInput.files[0]);
      fileInput.value = '';
    });

    shell.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropHint.classList.add('dragover');
    });
    shell.addEventListener('dragleave', () => dropHint.classList.remove('dragover'));
    shell.addEventListener('drop', (e) => {
      e.preventDefault();
      dropHint.classList.remove('dragover');
      const file = e.dataTransfer.files?.[0];
      if (file) this.loadFile(file);
    });

    video.addEventListener('error', () => {
      this.loaded = false;
      dropHint.hidden = false;
      this.el.scrubLayer.hidden = true;
      dropErr.hidden = false;
      dropErr.textContent =
        'This browser can\'t decode that video. HEVC (iPhone "High Efficiency") ' +
        'needs Safari; try Safari or re-export as H.264 MP4.';
      this._emit('loaded', false);
    });

    video.addEventListener('seeked', () => {
      this._seekBusy = false;
      if (this._targetTime !== null) {
        const t = this._targetTime;
        this._targetTime = null;
        this._issueSeek(t);
      }
    });

    video.addEventListener('play', () => this._emit('play'));
    video.addEventListener('pause', () => this._emit('pause'));
    video.addEventListener('ended', () => this._emit('pause'));
  }

  async loadFile(file) {
    const { video, dropHint, dropErr, fileName, scrubLayer } = this.el;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.loaded = false;
    dropErr.hidden = true;
    fileName.textContent = file.name;
    video.src = this.objectUrl;

    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', reject, { once: true });
    }).catch(() => null);

    // Some blobs (e.g. MediaRecorder output) report Infinity until the
    // playhead is forced to the end once.
    if (video.duration === Infinity) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        video.ondurationchange = () => {
          if (isFinite(video.duration)) {
            video.ondurationchange = null;
            clearTimeout(timer);
            resolve();
          }
        };
        video.currentTime = 1e7;
      });
      video.currentTime = 0;
    }
    if (!video.duration || !isFinite(video.duration)) return; // error path already handled
    // Cache it: Chrome reverts MediaRecorder-blob durations to Infinity after seeking back.
    this._duration = video.duration;

    this.loaded = true;
    dropHint.hidden = true;
    scrubLayer.hidden = false;
    this.storageKey = videoKey(file, video.duration);

    // Restore saved keyframes / trim / fps for this exact file if we have them.
    const saved = loadVideoMeta(this.storageKey);
    this.keyframes = saved?.keyframes ?? [];
    this.trimStart = saved?.trimStart ?? null;
    this.trimEnd = saved?.trimEnd ?? null;

    if (saved?.fps) {
      this._setFps(saved.fps, true);
    } else {
      const detected = await detectFps(video);
      this._setFps(detected ?? DEFAULT_FPS, !!detected);
    }

    this.el.roDur.textContent = formatTime(this.duration);
    this._renderKeyframes();
    this._renderTrim();
    this.seekToFrame(this.trimStart ?? 0);
    this._emit('loaded', true);
  }

  /** Load from a URL — used by tests and handy for local file servers. */
  async loadUrl(url, name = url.split('/').pop()) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return this.loadFile(new File([blob], name, { type: blob.type }));
  }

  _setFps(fps, detected) {
    this.fps = snapFps(fps);
    this.fpsDetected = detected;
    this.el.fpsInput.value = this.fps;
    this.el.fpsInput.title = detected ? 'Detected frame rate (editable)' : 'Assumed frame rate — edit if wrong';
  }

  _saveMeta() {
    if (!this.storageKey) return;
    saveVideoMeta(this.storageKey, {
      keyframes: this.keyframes,
      trimStart: this.trimStart,
      trimEnd: this.trimEnd,
      fps: this.fps,
    });
  }

  // ---------------- frame math & transport ----------------

  get duration() { return this._duration; }
  /** Width/height ratio of the loaded video; < 1 means portrait. */
  get aspect() {
    const v = this.el.video;
    return v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
  }
  get totalFrames() { return Math.max(1, Math.round(this.duration * this.fps)); }
  get currentFrame() { return clamp(Math.floor(this.el.video.currentTime * this.fps + 1e-4), 0, this.totalFrames - 1); }
  get playing() { return !this.el.video.paused && !this.el.video.ended; }

  frameToTime(frame) {
    // Seek to the middle of the frame interval so rounding lands on the intended frame.
    return clamp((frame + 0.5) / this.fps, 0, Math.max(0, this.duration - 0.001));
  }

  seekToFrame(frame) {
    if (!this.loaded) return;
    this._issueSeek(this.frameToTime(clamp(frame, 0, this.totalFrames - 1)));
  }

  seekToTime(t) {
    if (!this.loaded) return;
    this._issueSeek(clamp(t, 0, Math.max(0, this.duration - 0.001)));
  }

  /** Coalesce rapid seeks (scrubbing): never queue more than one pending target. */
  _issueSeek(t) {
    if (this._seekBusy) {
      this._targetTime = t;
      return;
    }
    this._seekBusy = true;
    this.el.video.currentTime = t;
  }

  stepFrames(delta) {
    if (!this.loaded) return;
    this.pause();
    this.seekToFrame(this.currentFrame + delta);
  }

  play() {
    if (!this.loaded) return;
    this.el.video.playbackRate = this.speed;
    this.el.video.play();
  }

  pause() { this.el.video.pause(); }

  togglePlay() { this.playing ? this.pause() : this.play(); }

  setSpeed(speed) {
    this.speed = speed;
    this.el.video.playbackRate = speed;
    for (const btn of this.el.speedGroup.querySelectorAll('.seg-btn')) {
      btn.classList.toggle('active', Number(btn.dataset.speed) === speed);
    }
  }

  // ---------------- keyframes ----------------

  toggleKeyframe() {
    if (!this.loaded) return;
    const f = this.currentFrame;
    const i = this.keyframes.indexOf(f);
    if (i >= 0) {
      this.keyframes.splice(i, 1);
      this._flashKf('⚑ keyframe removed');
    } else {
      this.keyframes.push(f);
      this.keyframes.sort((a, b) => a - b);
      this._flashKf(`⚑ keyframe @ ${f}`);
    }
    this._renderKeyframes();
    this._saveMeta();
    this._emit('keyframes');
  }

  nextKeyframe(withinTrim = false) {
    const f = this.currentFrame;
    const kf = this._trimmedKeyframes(withinTrim).find((k) => k > f);
    if (kf !== undefined) this.seekToFrame(kf);
    return kf;
  }

  prevKeyframe(withinTrim = false) {
    const f = this.currentFrame;
    const list = this._trimmedKeyframes(withinTrim);
    const kf = [...list].reverse().find((k) => k < f);
    if (kf !== undefined) this.seekToFrame(kf);
    return kf;
  }

  _trimmedKeyframes(withinTrim) {
    if (!withinTrim) return this.keyframes;
    const lo = this.trimStart ?? 0;
    const hi = this.trimEnd ?? this.totalFrames - 1;
    return this.keyframes.filter((k) => k >= lo && k <= hi);
  }

  _flashKf(text) {
    const el = this.el.kfFlash;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._kfFlashTimer);
    this._kfFlashTimer = setTimeout(() => el.classList.remove('show'), 900);
  }

  _renderKeyframes() {
    const box = this.el.tlMarkers;
    box.innerHTML = '';
    const total = this.totalFrames;
    for (const k of this.keyframes) {
      const m = document.createElement('div');
      m.className = 'tl-kf';
      m.style.left = `${(k / total) * 100}%`;
      box.appendChild(m);
    }
  }

  // ---------------- trim (compare mode) ----------------

  get rangeStartFrame() { return this.trimStart ?? 0; }
  get rangeEndFrame() { return this.trimEnd ?? this.totalFrames - 1; }
  get rangeFrames() { return Math.max(1, this.rangeEndFrame - this.rangeStartFrame); }

  setTrimStart() {
    this.trimStart = this.currentFrame;
    if (this.trimEnd !== null && this.trimEnd <= this.trimStart) this.trimEnd = null;
    this._afterTrimChange();
  }

  setTrimEnd() {
    this.trimEnd = this.currentFrame;
    if (this.trimStart !== null && this.trimStart >= this.trimEnd) this.trimStart = null;
    this._afterTrimChange();
  }

  clearTrim() {
    this.trimStart = this.trimEnd = null;
    this._afterTrimChange();
  }

  _afterTrimChange() {
    this._renderTrim();
    this._saveMeta();
    this._emit('trim');
  }

  _renderTrim() {
    const { tlTrim, roTrim } = this.el;
    if (!this.showTrim) return;
    const hasTrim = this.trimStart !== null || this.trimEnd !== null;
    tlTrim.hidden = !hasTrim;
    if (hasTrim) {
      const total = this.totalFrames;
      const lo = this.rangeStartFrame / total;
      const hi = this.rangeEndFrame / total;
      tlTrim.style.left = `${lo * 100}%`;
      tlTrim.style.width = `${(hi - lo) * 100}%`;
    }
    if (roTrim) {
      roTrim.textContent = hasTrim
        ? `${this.rangeStartFrame} → ${this.rangeEndFrame} (${this.rangeFrames} frames)`
        : 'full video';
    }
  }

  // ---------------- scrubbing ----------------

  _bindScrub() {
    const { scrubLayer, timeline, scrubBadge } = this.el;

    // Drag anywhere on the video: pixels along the UI's horizontal axis map to frames.
    let dragStart = { x: 0, y: 0 };
    let dragStartFrame = 0;
    let dragging = false;

    scrubLayer.addEventListener('pointerdown', (e) => {
      if (!this.loaded) return;
      dragging = true;
      dragStart = { x: e.clientX, y: e.clientY };
      dragStartFrame = this.currentFrame;
      this.pause();
      scrubLayer.setPointerCapture(e.pointerId);
      this._emit('interact');
    });
    scrubLayer.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const df = Math.round(axisDelta(e, dragStart) / SCRUB_PX_PER_FRAME);
      const frame = clamp(dragStartFrame + df, 0, this.totalFrames - 1);
      this.seekToFrame(frame);
      scrubBadge.textContent = `frame ${frame}  ·  ${formatTime(this.frameToTime(frame))}`;
      scrubBadge.classList.add('show');
    });
    const endDrag = () => {
      dragging = false;
      scrubBadge.classList.remove('show');
    };
    scrubLayer.addEventListener('pointerup', endDrag);
    scrubLayer.addEventListener('pointercancel', endDrag);

    // Click video toggles play only on quick tap without drag.
    scrubLayer.addEventListener('click', (e) => {
      if (Math.abs(axisDelta(e, dragStart)) < 4) this.togglePlay();
    });

    // Wheel steps frames.
    scrubLayer.addEventListener('wheel', (e) => {
      if (!this.loaded) return;
      e.preventDefault();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (d !== 0) this.stepFrames(d > 0 ? 1 : -1);
      this._emit('interact');
    }, { passive: false });

    // Timeline click/drag to seek.
    let tlDown = false;
    const tlSeek = (e) => {
      this.seekToFrame(Math.round(axisFraction(e, timeline) * (this.totalFrames - 1)));
    };
    timeline.addEventListener('pointerdown', (e) => {
      if (!this.loaded) return;
      tlDown = true;
      this.pause();
      timeline.setPointerCapture(e.pointerId);
      tlSeek(e);
      this._emit('interact');
    });
    timeline.addEventListener('pointermove', (e) => { if (tlDown) tlSeek(e); });
    timeline.addEventListener('pointerup', () => { tlDown = false; });
    timeline.addEventListener('pointercancel', () => { tlDown = false; });
  }

  // ---------------- controls & UI loop ----------------

  _bindControls() {
    const { playBtn, stepBack, stepFwd, kfPrev, kfNext, kfBtn, speedGroup,
            muteChk, fpsInput, trimStartBtn, trimEndBtn, trimClearBtn, card } = this.el;

    card.addEventListener('pointerdown', () => this._emit('interact'));

    playBtn.addEventListener('click', () => this.togglePlay());
    stepBack.addEventListener('click', () => this.stepFrames(-1));
    stepFwd.addEventListener('click', () => this.stepFrames(1));
    kfPrev.addEventListener('click', () => { this.pause(); this.prevKeyframe(); });
    kfNext.addEventListener('click', () => { this.pause(); this.nextKeyframe(); });
    kfBtn.addEventListener('click', () => this.toggleKeyframe());

    speedGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-speed]');
      if (btn) this.setSpeed(Number(btn.dataset.speed));
    });

    muteChk.addEventListener('change', () => { this.el.video.muted = muteChk.checked; });

    fpsInput.addEventListener('change', () => {
      const v = Number(fpsInput.value);
      if (v >= 1 && v <= 480) {
        this._setFps(v, false);
        this._renderKeyframes();
        this._renderTrim();
        this._saveMeta();
      } else {
        fpsInput.value = this.fps;
      }
    });

    if (this.showTrim) {
      trimStartBtn.addEventListener('click', () => { this.pause(); this.setTrimStart(); });
      trimEndBtn.addEventListener('click', () => { this.pause(); this.setTrimEnd(); });
      trimClearBtn.addEventListener('click', () => this.clearTrim());
    }
  }

  _startUiLoop() {
    const tick = () => {
      if (this.loaded) {
        const t = this.el.video.currentTime;
        if (t !== this._lastUiTime) {
          this._lastUiTime = t;
          const frame = this.currentFrame;
          this.el.roFrame.textContent = frame;
          this.el.roTime.textContent = formatTime(t);
          this.el.tlFill.style.width = `${(t / this.duration) * 100}%`;
          this.el.tlPlayhead.style.left = `${(t / this.duration) * 100}%`;
          this.el.kfBtn.classList.toggle('tagged', this.keyframes.includes(frame));
          this._emit('frame', frame, t);
        }
        this.el.playBtn.textContent = this.playing ? '❚❚' : '►';
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  setActive(active) {
    this.el.card.classList.toggle('active-player', active);
  }
}
