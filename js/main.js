import { Player, SPEEDS } from './player.js';
import { SyncEngine } from './sync.js';
import { clamp } from './utils.js';
import { APP_VERSION } from './version.js';

// ---------------- players ----------------

const singlePlayer = new Player(document.getElementById('single-player'));
const playerA = new Player(document.getElementById('player-a'), { label: 'A', showTrim: true });
const playerB = new Player(document.getElementById('player-b'), { label: 'B', showTrim: true });
const sync = new SyncEngine(playerA, playerB);

let mode = 'single';
let activePlayer = singlePlayer;
singlePlayer.setActive(true);

for (const p of [singlePlayer, playerA, playerB]) {
  p.on('interact', () => setActivePlayer(p));
}

function setActivePlayer(p) {
  activePlayer = p;
  for (const q of [singlePlayer, playerA, playerB]) q.setActive(q === p);
}

// ---------------- mode switching ----------------

const singleView = document.getElementById('single-view');
const compareView = document.getElementById('compare-view');
const modeSingleBtn = document.getElementById('mode-single');
const modeCompareBtn = document.getElementById('mode-compare');

function setMode(next) {
  mode = next;
  singlePlayer.pause();
  playerA.pause();
  playerB.pause();
  sync.pause();
  singleView.hidden = next !== 'single';
  compareView.hidden = next !== 'compare';
  modeSingleBtn.classList.toggle('active', next === 'single');
  modeCompareBtn.classList.toggle('active', next === 'compare');
  setActivePlayer(next === 'single' ? singlePlayer : playerA);
  if (next === 'compare') enforceLandscape();
  else releaseLandscape();
}

modeSingleBtn.addEventListener('click', () => setMode('single'));
modeCompareBtn.addEventListener('click', () => setMode('compare'));

// ---------------- landscape enforcement (compare mode on phones) ----------------
// Side-by-side comparison needs a landscape screen. Where the browser allows
// it (Android, fullscreen) we lock the orientation; elsewhere (iOS) we show a
// "rotate your phone" prompt until the device is turned.

const portraitMq = window.matchMedia('(orientation: portrait)');
const coarseMq = window.matchMedia('(pointer: coarse)');
const rotateOverlay = document.getElementById('rotate-overlay');
let rotateDismissed = false;
let lockedByApp = false;

let forceTouchForTesting = false;

function needsLandscapePrompt() {
  return mode === 'compare' && (coarseMq.matches || forceTouchForTesting) && portraitMq.matches;
}

function updateRotateOverlay() {
  rotateOverlay.hidden = !(needsLandscapePrompt() && !rotateDismissed);
}

async function enforceLandscape() {
  if (!needsLandscapePrompt()) return;
  try {
    // Orientation lock requires fullscreen; both must come from a user gesture.
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    await screen.orientation.lock('landscape');
    lockedByApp = true;
  } catch {
    updateRotateOverlay(); // browser won't let us force it — ask the user
  }
}

function releaseLandscape() {
  rotateDismissed = false;
  rotateOverlay.hidden = true;
  if (!lockedByApp) return;
  lockedByApp = false;
  try { screen.orientation.unlock(); } catch { /* not supported */ }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

portraitMq.addEventListener('change', updateRotateOverlay);
rotateOverlay.querySelector('.rotate-dismiss').addEventListener('click', () => {
  rotateDismissed = true;
  updateRotateOverlay();
});

// ---------------- sync bar ----------------

const syncPlayBtn = document.getElementById('sync-play');
const syncPrevBtn = document.getElementById('sync-prev');
const syncNextBtn = document.getElementById('sync-next');
const syncModeGroup = document.getElementById('sync-mode-group');
const syncSpeedGroup = document.getElementById('sync-speed-group');
const syncLoopChk = document.getElementById('sync-loop');
const syncStatus = document.getElementById('sync-status');
const syncTimeline = document.getElementById('sync-timeline');
const syncTlFill = syncTimeline.querySelector('.tl-fill');
const syncTlPlayhead = syncTimeline.querySelector('.tl-playhead');

syncPlayBtn.addEventListener('click', () => sync.toggle());
syncPrevBtn.addEventListener('click', (e) => sync.step(e.shiftKey ? -10 : -1));
syncNextBtn.addEventListener('click', (e) => sync.step(e.shiftKey ? 10 : 1));
syncLoopChk.addEventListener('change', () => { sync.loop = syncLoopChk.checked; });

syncModeGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-syncmode]');
  if (!btn) return;
  sync.setMode(btn.dataset.syncmode);
  for (const b of syncModeGroup.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b === btn);
  }
  refreshSyncUi();
});

syncSpeedGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-speed]');
  if (!btn) return;
  sync.setSpeed(Number(btn.dataset.speed));
  for (const b of syncSpeedGroup.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b === btn);
  }
});

// Master timeline scrubbing.
let syncTlDown = false;
const syncTlSeek = (e) => {
  const rect = syncTimeline.getBoundingClientRect();
  sync.scrubToProgress((e.clientX - rect.left) / rect.width);
};
syncTimeline.addEventListener('pointerdown', (e) => {
  if (!sync.ready || sync.mode === 'keyframe') return;
  syncTlDown = true;
  syncTimeline.setPointerCapture(e.pointerId);
  syncTlSeek(e);
});
syncTimeline.addEventListener('pointermove', (e) => { if (syncTlDown) syncTlSeek(e); });
syncTimeline.addEventListener('pointerup', () => { syncTlDown = false; });
syncTimeline.addEventListener('pointercancel', () => { syncTlDown = false; });

function refreshSyncUi() {
  const kfMode = sync.mode === 'keyframe';
  syncPlayBtn.disabled = !sync.canPlay;
  syncPrevBtn.disabled = !sync.ready;
  syncNextBtn.disabled = !sync.ready;
  syncTimeline.style.opacity = sync.ready && !kfMode ? '1' : '0.35';
  syncPlayBtn.textContent = sync.playing ? '❚❚' : '►';
}

sync.on('change', refreshSyncUi);
sync.on('playstate', refreshSyncUi);
refreshSyncUi();

// Sync bar status/progress loop.
(function syncUiLoop() {
  if (mode === 'compare') {
    syncStatus.textContent = sync.statusText();
    if (sync.ready && sync.mode !== 'keyframe') {
      const pct = sync.progress * 100;
      syncTlFill.style.width = `${pct}%`;
      syncTlPlayhead.style.left = `${pct}%`;
    }
  }
  requestAnimationFrame(syncUiLoop);
})();

// ---------------- keyboard shortcuts ----------------

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  const compareTransport = mode === 'compare';
  const step = e.shiftKey ? 10 : 1;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      compareTransport && sync.ready ? sync.toggle() : activePlayer.togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      compareTransport && sync.ready ? sync.step(-step) : activePlayer.stepFrames(-step);
      break;
    case 'ArrowRight':
      e.preventDefault();
      compareTransport && sync.ready ? sync.step(step) : activePlayer.stepFrames(step);
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (compareTransport && sync.ready) sync.stepKeyframe(1);
      else { activePlayer.pause(); activePlayer.nextKeyframe(); }
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (compareTransport && sync.ready) sync.stepKeyframe(-1);
      else { activePlayer.pause(); activePlayer.prevKeyframe(); }
      break;
    case 'k': case 'K':
      activePlayer.toggleKeyframe();
      break;
    case '1': case '2': case '3': case '4': {
      const speed = SPEEDS[Number(e.key) - 1];
      if (compareTransport) {
        sync.setSpeed(speed);
        for (const b of syncSpeedGroup.querySelectorAll('.seg-btn')) {
          b.classList.toggle('active', Number(b.dataset.speed) === speed);
        }
      } else {
        activePlayer.setSpeed(speed);
      }
      break;
    }
  }
});

// ---------------- help dialog ----------------

const helpDialog = document.getElementById('help-dialog');
document.getElementById('help-btn').addEventListener('click', () => helpDialog.showModal());
document.getElementById('app-version').textContent = `v${APP_VERSION}`;

// Install tips only make sense in a mobile browser — hide them in the
// installed (Home Screen / standalone) app.
const isInstalled =
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: fullscreen)').matches ||
  window.navigator.standalone === true;
if (coarseMq.matches && !isInstalled) {
  for (const tip of document.querySelectorAll('.install-tip')) tip.hidden = false;
}

// ---------------- debug/test hooks ----------------

window.__frameview = {
  singlePlayer, playerA, playerB, sync, setMode, clamp,
  simulateTouch(on) { forceTouchForTesting = on; updateRotateOverlay(); },
};
