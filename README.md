# Qboard

cueBoard is a modern, browser-based soundboard for live performance, streaming, and rehearsals. Organize audio into scenes and groups, trigger pads from your keyboard or a MIDI controller, and get responsive waveform visualization.

## Features

- Keyboard hotkeys to trigger pads
- Web MIDI input for controller triggering (e.g., APC/Launchpad)
- Optional LED feedback for supported MIDI devices
- Waveform visualization and scrubbing (powered by WaveSurfer)
- Built with React and Vite; runs fully on the client

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
