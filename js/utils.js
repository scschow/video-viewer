export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- rotated-layout pointer mapping ----------
// When body.rotated is set (landscape layout forced on a portrait screen via a
// 90° CSS rotation), pointer events still arrive in screen coordinates: the
// UI's horizontal axis runs down the physical screen.

export const isRotatedLayout = () => document.body.classList.contains('rotated');

/** Pointer movement along the UI's horizontal axis since `start` ({x, y}). */
export function axisDelta(e, start) {
  return isRotatedLayout() ? e.clientY - start.y : e.clientX - start.x;
}

/** Pointer position as a 0..1 fraction across an element's UI-horizontal axis. */
export function axisFraction(e, el) {
  const r = el.getBoundingClientRect();
  const frac = isRotatedLayout()
    ? (e.clientY - r.top) / r.height
    : (e.clientX - r.left) / r.width;
  return clamp(frac, 0, 1);
}

export function formatTime(seconds) {
  if (!isFinite(seconds)) return '0:00.00';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

// Common camera frame rates; detection snaps to these when close.
const STANDARD_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120, 240];

export function snapFps(fps) {
  for (const r of STANDARD_RATES) {
    if (Math.abs(fps - r) / r < 0.03) return r;
  }
  return Math.round(fps * 100) / 100;
}

/**
 * Estimate the video's frame rate by sampling presented-frame timestamps
 * with requestVideoFrameCallback during a short muted playback.
 * Resolves to null if it can't get a reliable estimate.
 */
export function detectFps(video, { samples = 12, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
      resolve(null);
      return;
    }
    const times = [];
    let handle = 0;
    let done = false;
    const wasMuted = video.muted;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (handle) video.cancelVideoFrameCallback(handle);
      video.pause();
      video.muted = wasMuted;
      video.currentTime = 0;
      resolve(result);
    };
    const timer = setTimeout(() => finish(estimate()), timeoutMs);

    const estimate = () => {
      if (times.length < 4) return null;
      const deltas = [];
      for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1];
        if (d > 0.0001) deltas.push(d);
      }
      if (deltas.length < 3) return null;
      deltas.sort((a, b) => a - b);
      const median = deltas[Math.floor(deltas.length / 2)];
      return snapFps(1 / median);
    };

    const onFrame = (_now, meta) => {
      times.push(meta.mediaTime);
      if (times.length >= samples) {
        finish(estimate());
      } else {
        handle = video.requestVideoFrameCallback(onFrame);
      }
    };

    video.muted = true;
    video.currentTime = 0;
    handle = video.requestVideoFrameCallback(onFrame);
    video.play().catch(() => finish(null));
  });
}

// ---------- Per-video persistence (keyframes, trim, fps override) ----------

const STORE_PREFIX = 'frameview:';

export function videoKey(file, duration) {
  return `${STORE_PREFIX}${file.name}|${file.size}|${Math.round(duration * 1000)}`;
}

export function loadVideoMeta(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveVideoMeta(key, meta) {
  try {
    localStorage.setItem(key, JSON.stringify(meta));
  } catch {
    // Storage full or unavailable — tagging still works for the session.
  }
}
