# CueBoard

CueBoard is a modern, browser-based soundboard for live performance, streaming, and rehearsals. Organize audio into scenes and groups, trigger pads from your keyboard or a MIDI controller, and get responsive waveform visualization.

## Features

- Keyboard hotkeys to trigger pads
- Web MIDI input for controller triggering (e.g., APC/Launchpad)
- Optional LED feedback for supported MIDI devices
- Waveform visualization and scrubbing (powered by WaveSurfer)
- Built with React and Vite; runs fully on the client

## Quick start

- Open the app and create your first show.
- Use the left sidebar to manage scenes.
- Click "+ Scene" to add a scene, then select it to edit.
- In the main panel, add pads to the three default groups:
  - **Background** (beds/loops)
  - **Ambients** (textures/underscores)
  - **SFX** (hits/stingers/one‑shots)
- Attach audio (drag‑drop WAV/MP3), set a color, and choose playback mode (once/loop).
- Press the pad header to play/stop. The footer shows the current scene and MIDI status.

## Keyboard shortcuts

- **Space**: Play/stop the currently selected pad
- **S**: Stop all pads
- **N**: Next scene
- **B**: Previous scene

## APC40 mkII guide (Web MIDI)

If your browser supports Web MIDI (Chromium-based recommended), CueBoard can light the APC40 mkII and respond to its controls.

- **Clip grid (pad triggers)**

  - Top three rows of the clip grid mirror the current scene:
    - Row 1 → Background
    - Row 2 → Ambients
    - Row 3 → SFX
  - Press a lit pad to start/stop that cue. LEDs reflect pad colors and state.

- **Scene navigation**

  - Use the hardware Scene Up/Down buttons to switch scenes:
    - Up → previous scene (note 95)
    - Down → next scene (note 94)

- **Active group selection**

  - Five buttons are listened to for group selection (notes 82–86). When you press one, that group becomes “active” and its select button lights red.
  - The active group determines which pads are controlled by the channel faders.

- **Channel faders (soft‑takeover)**

  - CC7 on channels 1–8 controls the level of the 1st–8th pad in the active group (left → right) in the current scene.
  - Movements use soft‑takeover: the fader must cross the current value before changing it, avoiding sudden jumps.

- **LED feedback**
  - On scene/app changes, LEDs are re-sent so the controller stays in sync (active group button red; pads show group colors; playing pads are highlighted).

If your APC sends different notes/CCs, you can remap on the device or in your MIDI routing software so the events above are produced (notably: group select 82–86, scene up/down 95/94, faders CC7 ch1–8).

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Browser support

- Web MIDI features work best in Chromium-based browsers. The app still functions without MIDI where unsupported.
