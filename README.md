# FrameView

A browser-based video analysis and comparison tool inspired by CoachView. Load a
video, scrub it frame by frame, tag keyframes, and compare two videos side by
side with synchronized playback.

Everything runs client-side — videos never leave your machine. No build step,
no dependencies.

## Running

Serve the folder with any static file server and open it in a browser:

```sh
cd video-viewer
python3 -m http.server 8000
# then open http://localhost:8000
```

(A plain `file://` open won't work because the app uses ES modules.)

## Features

### Single viewer
- Load a video via the file picker or drag & drop.
- Playback at 1×, ½, ¼, or ⅛ speed.
- Frame-accurate scrubbing:
  - **Drag horizontally on the video** to scrub frame by frame (like CoachView).
  - **Mouse wheel** over the video steps one frame at a time.
  - **← / →** step one frame; **⇧← / ⇧→** step 10 frames.
  - Click/drag the timeline for coarse seeking.
- Frame rate is detected automatically (`requestVideoFrameCallback` sampling)
  and shown in the **fps** box — edit it if the detection is off.
- **Keyframes**: press **K** (or the ⚑ button) to tag the current frame.
  Tags show as gold markers on the timeline; **↑ / ↓** (or the |◀ ▶| buttons)
  jump between them. Keyframes are saved in `localStorage` per video file, so
  they come back the next time you load the same file.

### Compare mode
- Two players (A and B) side by side, each with its own full set of controls.
- On each video, scrub to your reference points and click **Set start** /
  **Set end** to define its sync range (shown in green on the timeline).
- Sync playback modes:
  - **Frame** — both videos advance the same number of frames from their start
    frames (accounts for different fps between the two videos).
  - **Percent** — both videos move through their ranges proportionally, so they
    reach their end frames at the same instant even if the ranges differ in length.
  - **Keyframes** — the ‹ › buttons step each video to its next/previous tagged
    keyframe within its range (e.g. address → top of backswing → impact).
- Shared transport: play/pause, speed (1× … ⅛), frame stepping, loop, and a
  master scrub bar. Playback keeps the two videos locked with automatic drift
  correction.

## Video format support

The app plays anything your browser can decode:

| Source | Typical format | Support |
|---|---|---|
| iPhone ("Most Compatible") | H.264 MP4/MOV | All browsers |
| iPhone ("High Efficiency") | HEVC MOV | Safari; Chrome/Edge with hardware HEVC |
| Android | H.264/H.265 MP4 | H.264 everywhere; H.265 like HEVC above |

If a video won't decode, the app tells you. Easiest fixes: use Safari for HEVC
files, set the iPhone camera to Settings → Camera → Formats → Most Compatible,
or re-export as H.264 MP4.

## Code layout

- [index.html](index.html) — page shell, compare sync bar, help dialog
- [js/player.js](js/player.js) — `Player`: one video pane (transport, scrub, keyframes, trim)
- [js/sync.js](js/sync.js) — `SyncEngine`: dual-video synchronized playback
- [js/main.js](js/main.js) — wiring, mode switch, keyboard shortcuts
- [js/utils.js](js/utils.js) — fps detection, formatting, localStorage persistence
