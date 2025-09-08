import { useEffect, useMemo, useRef, useState } from "react";
import logoUrl from "./cue-board.logo.png";
import WaveSurfer from "wavesurfer.js";
import "./App.css";

// APC40 mkII restricted color palette and helpers
const APC_COLOR_TABLE = [
  { name: "White", vel: 3, hex: "#FFFFFF" },
  { name: "Red", vel: 5, hex: "#FF0000" },
  { name: "Deep Red", vel: 106, hex: "#A00000" },
  { name: "Orange", vel: 9, hex: "#FF6A00" },
  { name: "Orange 2", vel: 96, hex: "#FF7F24" },
  { name: "Yellow", vel: 13, hex: "#FFFF00" },
  { name: "Bright Yellow", vel: 109, hex: "#FFFF66" },
  { name: "Green", vel: 21, hex: "#00FF00" },
  { name: "Bright Green", vel: 98, hex: "#00FF66" },
  { name: "Cyan", vel: 37, hex: "#00A9FF" },
  { name: "Aqua", vel: 90, hex: "#00FFFF" },
  { name: "Blue", vel: 45, hex: "#0000FF" },
  { name: "Light Blue", vel: 91, hex: "#66B2FF" },
  { name: "Purple", vel: 49, hex: "#a900ff" },
  { name: "Magenta", vel: 53, hex: "#FF00FF" },
  { name: "Bright Magenta", vel: 94, hex: "#FF66FF" },
];

const APC_HEX_TO_VEL = Object.fromEntries(
  APC_COLOR_TABLE.map((c) => [c.hex.toUpperCase(), c.vel])
);
const APC_NAME_TO_VEL = Object.fromEntries(
  APC_COLOR_TABLE.map((c) => [c.name, c.vel])
);
const APC_VEL_TO_HEX = Object.fromEntries(
  APC_COLOR_TABLE.map((c) => [c.vel, c.hex])
);

// Physical grid ordering (top to bottom rows)
const APC_ROWS = [
  [33, 34, 35, 36, 37, 38, 39, 40],
  [25, 26, 27, 28, 29, 30, 31, 32],
  [17, 18, 19, 20, 21, 22, 23, 24],
  [9, 10, 11, 12, 13, 14, 15, 16],
  [1, 2, 3, 4, 5, 6, 7, 8],
];

// Group selector buttons (top row -> bottom row)
// Notes provided: 82, 83, 84, 85, 86
const GROUP_SELECT_NOTES = [82, 83, 84, 85, 86];
// APC40 navigation buttons for scene switching (from user logs)
const APC_NAV_UP_NOTE = 94; // previous scene
const APC_NAV_DOWN_NOTE = 95; // next scene
const NOTE_TO_GROUP_KEY = {
  82: "background", // topmost row
  83: "ambients", // second row
  84: "sfx", // third row
  85: "group4", // placeholder for a future group
  86: "group5", // placeholder for a future group
};
const GROUP_KEY_TO_NOTE = Object.fromEntries(
  Object.entries(NOTE_TO_GROUP_KEY).map(([n, g]) => [g, Number(n)])
);
// Use channel 3 (0-based index 2) to match the provided image
const GROUP_LED_CHANNEL = 2;

function apcVelFromHex(hex) {
  if (!hex) return APC_NAME_TO_VEL.Green || 21;
  const key = hex.toUpperCase();
  return APC_HEX_TO_VEL[key] ?? 21;
}

function chooseDefaultOutput(access, preferId) {
  if (!access) return null;
  const outs = Array.from(access.outputs.values());
  let pick = null;
  if (preferId) pick = outs.find((o) => o.id === preferId) || null;
  if (!pick) pick = outs.find((o) => /APC|Akai/i.test(o.name)) || null;
  if (!pick) pick = outs[0] || null;
  return pick;
}

function App() {
  const [mode, setMode] = useState("show"); // "show" | "edit"
  const [status, setStatus] = useState("Ready");

  // Seek bar state for each pad (keyed by sceneId:groupKey:padId)
  const [seekStates, setSeekStates] = useState({});

  // Real-time seek bar updates
  useEffect(() => {
    const updateSeekBars = () => {
      // Update seek bar positions for all playing pads (only when not actively seeking)
      padAudioRef.current.forEach((audioRef, key) => {
        if (
          audioRef &&
          audioRef.el &&
          !audioRef.el.paused &&
          audioRef.el.duration > 0
        ) {
          const progress = audioRef.el.currentTime / audioRef.el.duration;
          const [sceneId, groupKey, padId] = key.split(":");
          const padSeekKey = `${sceneId}:${groupKey}:${padId}`;

          setSeekStates((prev) => {
            const currentState = prev[padSeekKey] || {};
            // Only update if user is not actively seeking
            if (!currentState.isSeeking) {
              return {
                ...prev,
                [padSeekKey]: {
                  ...currentState,
                  progress,
                },
              };
            }
            return prev;
          });
        }
      });
    };

    // Update every 100ms for smooth real-time updates
    const interval = setInterval(updateSeekBars, 100);

    return () => clearInterval(interval);
  }, []);

  const [show, setShow] = useState(() => {
    const saved = loadSavedShow() || createInitialShow();
    // Clear all playing states on app load to prevent stale ticker animations
    saved.scenes.forEach((scene) => {
      ["background", "ambients", "sfx"].forEach((groupKey) => {
        if (scene[groupKey]) {
          scene[groupKey].forEach((pad) => {
            pad.playing = false;
          });
        }
      });
    });
    return saved;
  });
  const [currentSceneId, setCurrentSceneId] = useState(show.scenes[0]?.id);
  const [selectedPadKey, setSelectedPadKey] = useState(null);
  const [notesOpen, setNotesOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editor, setEditor] = useState({
    open: false,
    groupKey: null,
    padId: null,
  });
  const [mapperOpen, setMapperOpen] = useState(false);
  // Active group selection (e.g., which row we are controlling)
  const [activeGroupKey, setActiveGroupKey] = useState("background");
  // Latest values for use inside MIDI handlers
  const activeGroupRef = useRef(activeGroupKey);
  useEffect(() => {
    activeGroupRef.current = activeGroupKey;
  }, [activeGroupKey]);
  // Soft-takeover latch map: `${groupKey}:${padId}` -> latched boolean
  const sliderLatchRef = useRef(new Map());
  useEffect(() => {
    // Reset latches whenever group or scene changes
    try {
      sliderLatchRef.current = new Map();
    } catch {}
  }, [activeGroupKey, currentSceneId]);

  // Web MIDI state for APC LED control
  const [midiAccess, setMidiAccess] = useState(null);
  const [midiOut, setMidiOut] = useState(null);
  const [midiOutName, setMidiOutName] = useState("Offline");
  const apcInitedRef = useRef(false);
  // APC40 mkII top encoder and ring control CCs (as per sample HTML5 app)
  const APC_TRACK_KNOB_CC = useRef([
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
  ]);
  const APC_TRACK_RINGTYPE_CC = useRef([
    0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f,
  ]);
  const APC_DEVICE_KNOB_CC = useRef([
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
  ]);
  const APC_DEVICE_RINGTYPE_CC = useRef([
    0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
  ]);
  const APC_ALT_RINGTYPE_A = useRef([
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47,
  ]);
  const APC_ALT_RINGTYPE_B = useRef([
    0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
  ]);

  function apcSendCC(cc, value, channel = 0) {
    if (!midiOut) return;
    const status = 0xb0 | (channel & 0x0f);
    try {
      midiOut.send([status & 0xff, cc & 0x7f, value & 0x7f]);
    } catch {}
  }

  function apcSetRingTypeAll(type /*0 off,1 single,2 volume,3 pan*/) {
    // Broadcast to candidate CC maps and channels 1..8, mirroring sample app's robustness
    const sets = [
      APC_TRACK_RINGTYPE_CC.current,
      APC_DEVICE_RINGTYPE_CC.current,
      APC_ALT_RINGTYPE_A.current,
      APC_ALT_RINGTYPE_B.current,
    ];
    sets.forEach((set) => {
      for (let ch = 0; ch < 8; ch++) {
        for (let i = 0; i < 8; i++) {
          const cc = set[i];
          if (typeof cc === "number") apcSendCC(cc, type, ch);
        }
      }
    });
  }

  function apcSendKnobValue(index /*0..7*/, ccValue /*0..127*/, channel = 0) {
    const cc = APC_TRACK_KNOB_CC.current[index];
    if (typeof cc !== "number") return;
    apcSendCC(cc, ccValue, channel);
  }

  function volumeToCc(vol /*0..1*/) {
    const clamped = Math.max(0, Math.min(1, Number(vol) || 0));
    return Math.round(clamped * 127);
  }
  const audioCtxRef = useRef(null);
  const padAudioRef = useRef(new Map());
  const apcNoteToPadRef = useRef(new Map());
  const apcInMapRef = useRef(null); // Map<incomingNote:number, padNumber:number>
  // Quick HTML5 test player (Show mode)
  const [quickUrl, setQuickUrl] = useState("");
  const [quickName, setQuickName] = useState("");
  const quickAudioRef = useRef(null);
  const importInputRef = useRef(null);
  const attemptedAutoRelinkRef = useRef(false);
  const [relinkRequired, setRelinkRequired] = useState(false);
  const [relinkMissingCount, setRelinkMissingCount] = useState(0);

  const currentScene = useMemo(() => {
    return show.scenes.find((s) => s.id === currentSceneId) || show.scenes[0];
  }, [show, currentSceneId]);

  // Ref mirror for MIDI handlers
  const currentSceneRef = useRef(currentScene);
  useEffect(() => {
    currentSceneRef.current = currentScene;
  }, [currentScene]);

  // Keep latest show in a ref for async callbacks (e.g., MIDI handlers)
  const showRef = useRef(show);
  useEffect(() => {
    showRef.current = show;
  }, [show]);

  const groupColors = useMemo(() => {
    const map = {};
    (show.groups || []).forEach((g) => (map[g.id] = g.color));
    return map;
  }, [show.groups]);

  // Restore last selected scene if available
  useEffect(() => {
    try {
      const saved = localStorage.getItem("soundboard.currentSceneId");
      if (saved && show.scenes.some((s) => s.id === saved)) {
        setCurrentSceneId(saved);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist selected scene
  useEffect(() => {
    try {
      if (currentSceneId)
        localStorage.setItem("soundboard.currentSceneId", currentSceneId);
    } catch {}
  }, [currentSceneId]);

  // Persist show to localStorage on every change
  useEffect(() => {
    try {
      const payload = serializeShowForSave(show);
      localStorage.setItem("soundboard.show.v1", JSON.stringify(payload));
    } catch {}
  }, [show]);

  // Apply Remember Mix on scene load if enabled
  useEffect(() => {
    if (!currentScene) return;
    if (show.settings.applyRememberOnSceneLoad && currentScene.remember?.mix) {
      setShow((prev) => ({
        ...prev,
        scenes: prev.scenes.map((s) =>
          s.id === currentScene.id
            ? applyRememberToScene(s, currentScene.remember.mix)
            : s
        ),
      }));
      setStatus("Applied Remember Mix on scene load");
    } else {
      setStatus(`Loaded scene: ${currentScene.name}`);
    }
    setSelectedPadKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSceneId]);

  // Initialize Web MIDI (with SysEx so we can init APC40)
  useEffect(() => {
    // Load saved APC input note mapping (if any)
    try {
      const raw = localStorage.getItem("apcInNoteMap");
      if (raw) {
        const obj = JSON.parse(raw);
        const m = new Map();
        Object.entries(obj).forEach(([k, v]) => m.set(Number(k), Number(v)));
        apcInMapRef.current = m;
      }
    } catch {}
    const supported =
      typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
    if (!supported) {
      setMidiAccess(null);
      setMidiOut(null);
      setMidiOutName("Not supported");
      return;
    }
    let mounted = true;
    function attachMidiInputHandlers(access) {
      access.inputs.forEach((inp) => {
        try {
          inp.onmidimessage = (e) => {
            const [status, d1, d2] = e.data;
            const statusHi = status & 0xf0;
            const ch = (status & 0x0f) + 1; // 1..16
            // Handle CC for volume faders (CC7 on channels 1..8)
            if (statusHi === 0xb0 && d1 === 7 /* CC7 */ && ch >= 1 && ch <= 8) {
              handleApcFader(ch, d2);
              return;
            }
            // Handle CC for top encoders (absolute 0..127 on CC 0x30..0x37)
            if (statusHi === 0xb0 && d1 >= 0x30 && d1 <= 0x37) {
              const idx = d1 - 0x30; // 0..7
              handleApcEncoder(idx, d2);
              return;
            }
            // Note On with velocity > 0
            if (statusHi === 0x90 && d2 > 0) {
              const note = d1 | 0; // 0..127
              // Handle group selection buttons first
              if (GROUP_SELECT_NOTES.includes(note)) {
                const key = NOTE_TO_GROUP_KEY[note];
                if (key) {
                  setActiveGroupKey(key);
                  // Visual feedback: set LED to Red (velocity 5) on channel 3
                  try {
                    midiOut?.send([
                      0x90 | (GROUP_LED_CHANNEL & 0x0f),
                      note & 0x7f,
                      5, // red velocity
                    ]);
                  } catch {}
                  // Sync knob rings to reflect active group's levels
                  try {
                    syncKnobRingsForActiveGroup();
                  } catch {}
                }
                return;
              }
              // Handle navigation buttons (Up/Down)
              if (note === APC_NAV_UP_NOTE) {
                prevScene();
                return;
              }
              if (note === APC_NAV_DOWN_NOTE) {
                nextScene();
                return;
              }
              // Map APC clip grid
              const padNumber = apcNoteToPadNumber(note);
              if (padNumber) handleApcPadPress(padNumber - 1);
            }
          };
        } catch {}
      });
    }

    function apcNoteToPadNumber(note) {
      // 1) User-provided mapping captured in Mapper modal
      const user = apcInMapRef.current;
      if (user && user.has(note)) return user.get(note);
      // 2) Dynamic mapping from last LED layout
      const memo = apcNoteToPadRef.current;
      if (memo && memo.has(note)) return memo.get(note);
      // 3) Heuristic fallback
      if (note >= 0 && note < 40) return note + 1;
      // Unknown mapping: log once to console and ignore
      try {
        if (typeof window !== "undefined")
          console.debug && console.debug("Unmapped APC note", note);
      } catch {}
      return null;
    }

    navigator
      .requestMIDIAccess({ sysex: true })
      .then((access) => {
        if (!mounted) return;
        setMidiAccess(access);
        const out = chooseDefaultOutput(access);
        setMidiOut(out);
        setMidiOutName(out ? out.name : "Offline");
        apcInitedRef.current = false;
        // Attach handlers for current inputs
        attachMidiInputHandlers(access);
        access.onstatechange = () => {
          const next = chooseDefaultOutput(access, out?.id);
          setMidiOut(next);
          setMidiOutName(next ? next.name : "Offline");
          apcInitedRef.current = false;
          // Re-attach input handlers on device changes
          attachMidiInputHandlers(access);
        };
      })
      .catch(() => {
        if (!mounted) return;
        setMidiAccess(null);
        setMidiOut(null);
        setMidiOutName("Permission blocked");
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Reapply LEDs and note mapping when the scene content or MIDI output changes
  useEffect(() => {
    applySceneToAPC(currentScene);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScene, midiOut]);

  // Keep group selection LED in sync (light selected, clear others)
  useEffect(() => {
    try {
      GROUP_SELECT_NOTES.forEach((n) => {
        const isActive = NOTE_TO_GROUP_KEY[n] === activeGroupKey;
        const status = isActive ? 0x90 : 0x80; // note on vs off
        const vel = isActive ? 5 : 0; // red when active
        midiOut?.send([
          (status | (GROUP_LED_CHANNEL & 0x0f)) & 0xff,
          n & 0x7f,
          vel & 0x7f,
        ]);
      });
    } catch {}
    // When active group changes, update knob rings to reflect levels
    try {
      syncKnobRingsForActiveGroup();
    } catch {}
  }, [activeGroupKey, midiOut]);

  // If group colors change, re-light current scene to reflect updates
  useEffect(() => {
    applySceneToAPC(currentScene);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show.groups]);

  // Also reapply mapping/LEDs when pads in the current scene change
  useEffect(() => {
    applySceneToAPC(currentScene);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScene.background, currentScene.ambients, currentScene.sfx]);

  // Revoke previous blob when quickUrl changes
  useEffect(() => {
    return () => {
      if (quickUrl && quickUrl.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(quickUrl);
        } catch {}
      }
    };
  }, [quickUrl]);

  // Listen for cross-component pad seek events from waveform UI
  useEffect(() => {
    const onPadSeek = (e) => {
      try {
        const detail = e?.detail || {};
        const gid = detail.groupKey;
        const pid = detail.padId;
        const progress = detail.progress;
        const sid =
          detail.sceneId ||
          (currentSceneRef.current && currentSceneRef.current.id) ||
          currentScene.id;
        if (gid && pid && typeof progress === "number") {
          seekPad(sid, gid, pid, progress);
        }
      } catch {}
    };
    window.addEventListener("padSeek", onPadSeek);
    return () => window.removeEventListener("padSeek", onPadSeek);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On initial load, try auto-relink using a previously saved directory handle.
  // If not possible or not permitted, offer to relink manually once.
  useEffect(() => {
    (async () => {
      if (attemptedAutoRelinkRef.current) return;
      attemptedAutoRelinkRef.current = true;
      const supported =
        typeof window !== "undefined" && !!window.showDirectoryPicker;
      let autoLinked = false;
      if (supported) {
        try {
          autoLinked = await autoRelinkFromStoredHandle(
            setShow,
            setStatus,
            show
          );
        } catch {}
      }
      const missing = countRelinkCandidates(show);
      if (!autoLinked && missing > 0 && supported) {
        setRelinkMissingCount(missing);
        setRelinkRequired(true);
        setStatus(`Missing ${missing} audio file(s) — click Relink Files`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === " ") {
        if (selectedPadKey) {
          togglePadPlayByKey(selectedPadKey);
        }
        e.preventDefault();
      } else if (e.key.toLowerCase() === "s") {
        handleStopAll();
      } else if (e.key.toLowerCase() === "n") {
        nextScene();
      } else if (e.key.toLowerCase() === "b") {
        prevScene();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedPadKey, currentSceneId, show]);

  function updateScene(mutator) {
    const selectedSceneId =
      (currentSceneRef.current && currentSceneRef.current.id) ||
      currentScene.id;
    setShow((prev) => ({
      ...prev,
      scenes: prev.scenes.map((s) =>
        s.id === selectedSceneId ? mutator(structuredClone(s)) : s
      ),
    }));
  }

  // Update a specific scene by id (used by cross-scene triggers)
  function updateSceneById(sceneId, mutator) {
    setShow((prev) => ({
      ...prev,
      scenes: prev.scenes.map((s) =>
        s.id === sceneId ? mutator(structuredClone(s)) : s
      ),
    }));
  }

  function togglePadPlayByKey(key) {
    const [group, id] = key.split(":");
    const sc = currentSceneRef.current;
    const pad = findPad(sc, group, id);
    if (!pad) return;
    if (!pad.assetUrl && !pad.assetPath) {
      setStatus("No audio attached to this pad");
      return;
    }
    const next = !pad.playing;
    setPadPlaying(group, id, next);
    setStatus(`${pad.label || pad.name} ${next ? "started" : "stopped"}`);
  }

  function handleStopAll() {
    updateScene((scene) => {
      allPads(scene).forEach((p) => (p.playing = false));
      return scene;
    });
    setStatus("Stop all");
    clearAllApcLeds();
    stopAllAudio();
  }

  function handleFadeAll() {
    let raf = 0;
    const step = () => {
      let any = false;
      updateScene((scene) => {
        allPads(scene).forEach((p) => {
          if (p.playing && p.level > 0.02) {
            p.level = Math.max(0, p.level - 0.02);
            any = true;
          }
        });
        return scene;
      });
      if (any) raf = requestAnimationFrame(step);
      else setStatus("Fade all complete");
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }

  function handlePanic() {
    if (show.settings.panicConfirm) {
      // eslint-disable-next-line no-alert
      if (!confirm("Stop all audio now")) return;
    }
    updateScene((scene) => {
      allPads(scene).forEach((p) => {
        p.playing = false;
        p.level = typeof p.baseLevel === "number" ? p.baseLevel : p.level;
      });
      return scene;
    });
    setStatus("PANIC executed");
    clearAllApcLeds();
    stopAllAudio();
  }

  function handleRememberCapture() {
    if (show.settings.confirmOverwriteRemember && currentScene.remember?.mix) {
      // eslint-disable-next-line no-alert
      const ok = confirm("Overwrite existing Remember Mix?");
      if (!ok) return;
    }
    updateScene((scene) => {
      scene.remember = {
        armed: true,
        savedAt: new Date().toISOString(),
        savedBy: "operator",
        mix: buildRememberFromScene(scene),
      };
      return scene;
    });
    setStatus("Remember mix captured");
  }

  function handleApplyRemember() {
    if (!currentScene.remember?.mix) return;
    updateScene((scene) =>
      applyRememberToScene(scene, currentScene.remember.mix)
    );
    setStatus("Applied Remember Mix");
  }

  function nextScene() {
    setCurrentSceneId((prevId) => {
      const scenes = showRef.current?.scenes || [];
      const idx = scenes.findIndex((s) => s.id === prevId);
      if (idx < 0 || scenes.length === 0) return prevId;
      const j = (idx + 1) % scenes.length;
      return scenes[j].id;
    });
  }
  function prevScene() {
    setCurrentSceneId((prevId) => {
      const scenes = showRef.current?.scenes || [];
      const idx = scenes.findIndex((s) => s.id === prevId);
      if (idx < 0 || scenes.length === 0) return prevId;
      const j = (idx - 1 + scenes.length) % scenes.length;
      return scenes[j].id;
    });
  }

  // --- APC mapping & LED helpers (component-scoped, use midiOut) ---
  function initApcIfNeeded() {
    if (!midiOut || apcInitedRef.current) return;
    try {
      midiOut.send(apcInitSysexMsg());
      apcInitedRef.current = true;
      setStatus((s) => `${s} — APC inited`);
      // Ensure knob rings are in Volume style (bar fill), mirroring the sample app
      try {
        apcSetRingTypeAll(2);
      } catch {}
      // Also refresh group selection LED state upon init
      GROUP_SELECT_NOTES.forEach((n) => {
        const isActive = NOTE_TO_GROUP_KEY[n] === activeGroupKey;
        const status = isActive ? 0x90 : 0x80;
        const vel = isActive ? 5 : 0;
        try {
          midiOut.send([
            (status | (GROUP_LED_CHANNEL & 0x0f)) & 0xff,
            n & 0x7f,
            vel & 0x7f,
          ]);
        } catch {}
      });
      // Light knob rings to current active group's first 8 pad levels
      try {
        syncKnobRingsForActiveGroup();
      } catch {}
    } catch {}
  }

  // Convert CC value (0..127) to linear volume 0..1
  function ccToVolume(cc) {
    return Math.max(0, Math.min(1, cc / 127));
  }

  // Map encoder index (0..7) to pad for active group
  function getPadForEncoder(index /*0..7*/) {
    const scene = currentSceneRef.current;
    const groupKey = activeGroupRef.current;
    if (!scene || !groupKey) return null;
    const arr = groupArray(scene, groupKey) || [];
    if (index < 0 || index >= 8) return null;
    const pad = arr[index];
    if (!pad) return null;
    return { pad, groupKey };
  }

  // Encoder handler: apply value immediately (direct mapping like sample)
  function handleApcEncoder(index /*0..7*/, value /*0..127*/) {
    const target = getPadForEncoder(index);
    if (!target) return;
    const { pad, groupKey } = target;
    const desired = ccToVolume(value);
    setPadLevel(groupKey, pad.id, desired);
    // Echo ring LED immediately
    try {
      apcSendKnobValue(index, value);
    } catch {}
  }

  // Map channel (1..8) and current active group to the pad in that column
  function getPadForFader(channel) {
    const scene = currentSceneRef.current;
    const groupKey = activeGroupRef.current;
    if (!scene || !groupKey) return null;
    const arr = groupArray(scene, groupKey) || [];
    const index = channel - 1; // 1..8 -> 0..7
    if (index < 0 || index >= 8) return null; // ignore >8
    const pad = arr[index];
    if (!pad) return null;
    return { pad, groupKey };
  }

  // Soft-takeover handler for CC7 faders
  function handleApcFader(channel, value /*0..127*/) {
    const target = getPadForFader(channel);
    if (!target) return;
    const { pad, groupKey } = target;
    const key = `${groupKey}:${pad.id}`;
    const desired = ccToVolume(value);
    const current = typeof pad.level === "number" ? pad.level : 0;
    const latched = sliderLatchRef.current.get(key) === true;
    // Threshold for matching before latch (to avoid sudden jumps)
    const threshold = 0.04; // ~5/127
    if (!latched) {
      if (Math.abs(desired - current) <= threshold) {
        sliderLatchRef.current.set(key, true);
      } else {
        return; // ignore until user matches current level
      }
    }
    // Apply new level once latched
    setPadLevel(groupKey, pad.id, desired);
  }

  function clearAllApcLeds(channel = 0) {
    if (!midiOut) return;
    for (let n = 0; n < 40; n++) {
      apcOffClipLed(midiOut, n, channel);
    }
  }

  function applySceneToAPC(scene) {
    if (!scene || !midiOut) return;
    initApcIfNeeded();
    // Clear first to avoid stale LEDs
    clearAllApcLeds(0);
    // Ensure ring type on each render of scene to keep in sync
    try {
      apcSetRingTypeAll(2);
    } catch {}
    try {
      apcNoteToPadRef.current = new Map();
    } catch {}

    // Map: background -> top row; ambients -> second row; sfx -> third row
    const groupHex = (gid) =>
      (show.groups || []).find((g) => g.id === gid)?.color;

    const mapGroupToRow = (pads, rowIndex) => {
      const row = APC_ROWS[rowIndex];
      if (!row) return;
      pads.forEach((p, i) => {
        if (!row[i]) return; // ignore overflow
        const hex = (p.color || groupHex(p.groupId) || "#00FF00").toUpperCase();
        const vel = apcVelFromHex(hex);
        const note = row[i] - 1; // 0..39
        try {
          apcNoteToPadRef.current.set(note, row[i]);
        } catch {}
        apcSendClipLed(midiOut, note, vel, 0);
      });
    };

    mapGroupToRow(scene.background || [], 0); // 33..40
    mapGroupToRow(scene.ambients || [], 1); // 25..32
    mapGroupToRow(scene.sfx || [], 2); // 17..24

    // Re-assert the currently selected group LED
    try {
      GROUP_SELECT_NOTES.forEach((n) => {
        const isActive = NOTE_TO_GROUP_KEY[n] === activeGroupKey;
        const status = isActive ? 0x90 : 0x80; // note on vs off
        const vel = isActive ? 5 : 0;
        midiOut?.send([
          (status | (GROUP_LED_CHANNEL & 0x0f)) & 0xff,
          n & 0x7f,
          vel & 0x7f,
        ]);
      });
    } catch {}

    // Sync the knob rings to reflect active group's first 8 pad levels
    try {
      syncKnobRingsForActiveGroup();
    } catch {}
  }

  function syncKnobRingsForActiveGroup() {
    if (!midiOut) return;
    const scene = currentSceneRef.current;
    const groupKey = activeGroupRef.current;
    if (!scene || !groupKey) return;
    const arr = groupArray(scene, groupKey) || [];
    for (let i = 0; i < 8; i++) {
      const p = arr[i];
      const level = typeof p?.level === "number" ? p.level : 0;
      apcSendKnobValue(i, volumeToCc(level));
    }
  }

  function handleApcPadPress(note /*0..39*/) {
    // Map incoming APC note back to group/pad index by our scene mapping
    const scene = currentSceneRef.current;
    if (!scene) return;
    const padNumber = note + 1; // 1..40
    // Determine row and col
    const rowIdx = APC_ROWS.findIndex((row) => row.includes(padNumber));
    if (rowIdx < 0) return;
    const colIdx = APC_ROWS[rowIdx].indexOf(padNumber);
    if (rowIdx === 0) {
      const p = (scene.background || [])[colIdx];
      if (p) togglePadPlay("background", p.id);
    } else if (rowIdx === 1) {
      const p = (scene.ambients || [])[colIdx];
      if (p) togglePadPlay("ambients", p.id);
    } else if (rowIdx === 2) {
      const p = (scene.sfx || [])[colIdx];
      if (p) togglePadPlay("sfx", p.id);
    }
  }

  // --- Audio engine ---
  // Routing helpers (use HTMLAudioElement.setSinkId when available)
  function ensureRoutingSettings() {
    const s = show?.settings || {};
    const audioRouting = s.audioRouting || {};
    const outputs = Array.isArray(audioRouting.outputs)
      ? audioRouting.outputs
      : [{ key: "master", label: "Master", deviceId: "default" }];
    const groupDefault = audioRouting.groupDefault || {
      background: "master",
      ambients: "master",
      sfx: "master",
    };
    return { outputs, groupDefault };
  }

  function getDeviceIdForRouteKey(routeKey) {
    try {
      const { outputs } = ensureRoutingSettings();
      const o = outputs.find((x) => x.key === routeKey);
      return o?.deviceId || "default";
    } catch {
      return "default";
    }
  }

  function getRouteKeyForPad(groupKey, pad) {
    try {
      if (pad?.routeKey) return pad.routeKey;
      const { groupDefault } = ensureRoutingSettings();
      return groupDefault?.[groupKey] || "master";
    } catch {
      return "master";
    }
  }
  function ensureAudioContext() {
    // Deprecated for routing: keep for potential future use; not required when using HTMLAudioElement routing
    return null;
  }

  function padKey(sceneId, groupKey, padId) {
    return `${sceneId}:${groupKey}:${padId}`;
  }

  function handlePadAudio(scene, groupKey, pad, shouldPlay, usePause = false) {
    if (!pad.assetUrl && !pad.assetPath) return;
    if (shouldPlay) {
      playPad(scene.id, groupKey, pad);
    } else {
      if (usePause) {
        pausePad(scene.id, groupKey, pad.id);
      } else {
        stopPad(scene.id, groupKey, pad.id);
      }
    }
  }

  function playPad(sceneId, groupKey, pad) {
    const key = padKey(sceneId, groupKey, pad.id);
    // Ensure any previous instance is fully stopped immediately to avoid overlapping
    stopPadImmediate(sceneId, groupKey, pad.id);
    const srcUrl =
      pad.assetUrl ||
      (/^(https?:|blob:|tauri:)/.test(pad.assetPath || "")
        ? pad.assetPath
        : null);
    if (!srcUrl) {
      setStatus(
        "Local file path cannot be played directly. Use the file chooser."
      );
      return;
    }
    const el = new Audio(srcUrl);
    el.crossOrigin = "anonymous";
    el.loop = pad.playbackMode === "loop";
    try {
      const routeKey = getRouteKeyForPad(groupKey, pad);
      const deviceId = getDeviceIdForRouteKey(routeKey);
      if (typeof el.setSinkId === "function" && deviceId) {
        Promise.resolve(el.setSinkId(deviceId)).catch(() => {});
      }
    } catch {}
    // Determine target level and whether to fade in
    const targetLevel =
      typeof pad.baseLevel === "number"
        ? pad.baseLevel
        : typeof pad.level === "number"
        ? pad.level
        : 0.8;
    const fadeInMs = Math.max(
      0,
      Number.isFinite(pad.fadeInMs) ? pad.fadeInMs : 0
    );
    el.volume = clamp01(fadeInMs > 0 ? 0 : targetLevel);
    padAudioRef.current.set(key, { el });
    el.onended = () => {
      if (!el.loop) {
        // Reflect stopped state in UI
        setShow((prev) => ({
          ...prev,
          scenes: prev.scenes.map((s) => {
            if (s.id !== sceneId) return s;
            const sc = structuredClone(s);
            const arr = groupArray(sc, groupKey);
            const p = arr.find((x) => x.id === pad.id);
            if (p) p.playing = false;
            return sc;
          }),
        }));
      }
    };

    // Sync WaveSurfer progress with HTML Audio element
    el.ontimeupdate = () => {
      try {
        const waveSurferMap = window.waveSurferInstances;
        if (!waveSurferMap) return;

        const padKey = `${sceneId}:${groupKey}:${pad.id}`;
        const ws = waveSurferMap.get(padKey);
        if (ws && el.duration > 0) {
          const progress = el.currentTime / el.duration;
          ws.seekTo(progress);
        }
      } catch (error) {
        // Silently handle any errors with progress sync
      }
    };
    el.onerror = () => {
      setStatus("Could not play this audio file");
    };
    try {
      const p = el.play();
      if (p && typeof p.then === "function")
        p.catch(() => setStatus("Playback was blocked"));
    } catch {
      setStatus("Playback error");
    }
    // Apply default fade-in if configured
    if (fadeInMs > 0) {
      // Ensure the audio element reference exists, then fade up
      const ensure = () => {
        const ref = padAudioRef.current.get(key);
        if (!ref) {
          requestAnimationFrame(ensure);
          return;
        }
        applyPadVolume(sceneId, groupKey, pad.id, 0);
        fadeVolume(sceneId, groupKey, pad.id, 0, targetLevel, fadeInMs);
      };
      ensure();
    }
  }

  function stopPad(sceneId, groupKey, padId) {
    const key = padKey(sceneId, groupKey, padId);
    const ref = padAudioRef.current.get(key);
    if (!ref) return;
    // Look up pad to fetch its fadeOutMs; fall back to immediate stop
    let fadeOutMs = 0;
    try {
      const sc =
        (show.scenes || []).find((s) => s.id === sceneId) ||
        currentSceneRef.current ||
        currentScene;
      const pad = findPad(sc, groupKey, padId);
      fadeOutMs = Math.max(
        0,
        Number.isFinite(pad?.fadeOutMs) ? pad.fadeOutMs : 0
      );
    } catch {}
    if (fadeOutMs > 0) {
      const currentVol = ref.el.volume;
      fadeVolume(sceneId, groupKey, padId, currentVol, 0, fadeOutMs, () => {
        stopPadImmediate(sceneId, groupKey, padId);
      });
    } else {
      stopPadImmediate(sceneId, groupKey, padId);
    }
  }

  // Immediate stop helper used internally to avoid overlap during retriggers
  function stopPadImmediate(sceneId, groupKey, padId) {
    const key = padKey(sceneId, groupKey, padId);
    const ref = padAudioRef.current.get(key);
    if (!ref) return;
    try {
      ref.el.pause();
      ref.el.currentTime = 0;
      // Reset WaveSurfer progress
      const waveSurferMap = window.waveSurferInstances;
      if (waveSurferMap) {
        const padKey = `${sceneId}:${key.split(":")[1]}:${padId}`;
        const ws = waveSurferMap.get(padKey);
        if (ws) {
          ws.seekTo(0);
        }
      }
      // Reset seek bar to 0
      const padSeekKey = `${sceneId}:${key.split(":")[1]}:${padId}`;
      setSeekStates((prev) => ({
        ...prev,
        [padSeekKey]: {
          ...prev[padSeekKey],
          progress: 0,
          isSeeking: false,
        },
      }));
    } catch {}
    padAudioRef.current.delete(key);
  }

  // Pause playback without resetting position (for resume functionality)
  function pausePad(sceneId, groupKey, padId) {
    const key = padKey(sceneId, groupKey, padId);
    console.log("pausePad called for key:", key);
    const ref = padAudioRef.current.get(key);
    if (!ref) {
      console.log("No ref found for pause");
      return;
    }
    try {
      console.log("Pausing audio at currentTime:", ref.el.currentTime);
      ref.el.pause();
      // Don't reset currentTime - keep position for resume
      // Update WaveSurfer progress to match paused position
      const waveSurferMap = window.waveSurferInstances;
      if (waveSurferMap && ref.el.duration > 0) {
        const padKey = `${sceneId}:${key.split(":")[1]}:${padId}`;
        const ws = waveSurferMap.get(padKey);
        if (ws) {
          const progress = ref.el.currentTime / ref.el.duration;
          ws.seekTo(progress);
        }
      }
    } catch (error) {
      console.log("Pause error:", error);
    }
  }

  // Resume playback from current position (doesn't reset to beginning)
  function resumePad(sceneId, groupKey, pad) {
    const key = padKey(sceneId, groupKey, pad.id);
    console.log("resumePad called for key:", key);
    let ref = padAudioRef.current.get(key);
    console.log("Existing ref found:", !!ref);

    // If no audio element exists, create one first (but don't play from beginning)
    if (!ref) {
      console.log("No existing ref, creating new audio element");
      const srcUrl =
        pad.assetUrl ||
        (/^(https?:|blob:|tauri:)/.test(pad.assetPath || "")
          ? pad.assetPath
          : null);

      if (!srcUrl) {
        setStatus("No audio file to resume");
        return;
      }

      const el = new Audio(srcUrl);
      el.crossOrigin = "anonymous";
      el.loop = pad.playbackMode === "loop";
      el.volume = clamp01(pad.level || 0.8);

      try {
        const routeKey = getRouteKeyForPad(groupKey, pad);
        const deviceId = getDeviceIdForRouteKey(routeKey);
        if (typeof el.setSinkId === "function" && deviceId) {
          Promise.resolve(el.setSinkId(deviceId)).catch(() => {});
        }
      } catch {}

      // Store seek position for later use
      const padSeekKey = `${sceneId}:${groupKey}:${pad.id}`;
      const seekState = seekStates[padSeekKey];
      const targetProgress =
        seekState && seekState.progress !== undefined && seekState.progress > 0
          ? seekState.progress
          : 0;

      // Set up load handler to seek to the correct position once audio loads
      el.addEventListener("loadedmetadata", () => {
        if (targetProgress > 0) {
          el.currentTime = targetProgress * el.duration;
          console.log(
            "Resume from seek bar position:",
            targetProgress,
            "->",
            el.currentTime
          );

          // Clear seeking state so real-time updates work
          setSeekStates((prev) => ({
            ...prev,
            [padSeekKey]: {
              ...prev[padSeekKey],
              isSeeking: false,
            },
          }));
        }
      });

      el.currentTime = 0; // Start from beginning initially
      ref = { el };
      padAudioRef.current.set(key, ref);

      el.onended = () => {
        if (!el.loop) {
          updateScene((scene) => {
            const sc = structuredClone(scene);
            const arr = groupArray(sc, groupKey);
            const p = arr.find((x) => x.id === pad.id);
            if (p) p.playing = false;
            return sc;
          });
        }
      };

      // Sync WaveSurfer progress with HTML Audio element
      el.ontimeupdate = () => {
        try {
          const waveSurferMap = window.waveSurferInstances;
          if (!waveSurferMap) return;

          const padKey = `${sceneId}:${groupKey}:${pad.id}`;
          const ws = waveSurferMap.get(padKey);
          if (ws && el.duration > 0) {
            const progress = el.currentTime / el.duration;
            ws.seekTo(progress);
          }
        } catch (error) {
          // Silently handle any errors with progress sync
        }
      };
    }

    try {
      console.log(
        "Attempting to resume audio, currentTime:",
        ref.el.currentTime,
        "duration:",
        ref.el.duration
      );

      // Check if there's a seek bar position set and seek to it
      const padSeekKey = `${sceneId}:${groupKey}:${pad.id}`;
      const seekState = seekStates[padSeekKey];
      if (
        seekState &&
        seekState.progress !== undefined &&
        seekState.progress > 0
      ) {
        const targetTime = seekState.progress * ref.el.duration;
        ref.el.currentTime = targetTime;
        console.log(
          "Resume existing audio from seek bar position:",
          seekState.progress,
          "->",
          targetTime
        );

        // Clear seeking state so real-time updates work
        setSeekStates((prev) => ({
          ...prev,
          [padSeekKey]: {
            ...prev[padSeekKey],
            isSeeking: false,
          },
        }));
      }

      // Just resume without resetting currentTime (unless we just set it above)
      const p = ref.el.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          console.log("Resume successful");
        }).catch((error) => {
          console.log("Resume failed:", error);
          setStatus("Playback was blocked");
        });
      } else {
        console.log("Resume play() returned synchronously");
      }
    } catch (error) {
      console.log("Resume error:", error);
      setStatus("Playback error");
    }
  }

  function applyPadVolume(sceneId, groupKey, padId, level) {
    const key = padKey(sceneId, groupKey, padId);
    const ref = padAudioRef.current.get(key);
    if (!ref) return;
    try {
      ref.el.volume = clamp01(level);
    } catch {}
  }

  function fadeVolume(sceneId, groupKey, padId, from, to, ms, onDone) {
    const steps = Math.max(1, Math.floor(Math.max(0, ms) / 16));
    let i = 0;
    const step = () => {
      const v = from + (to - from) * (i / steps);
      applyPadVolume(sceneId, groupKey, padId, v);
      i++;
      if (i <= steps) requestAnimationFrame(step);
      else onDone && onDone();
    };
    requestAnimationFrame(step);
  }

  // Seek currently playing audio for a pad to the given progress (0..1)
  function seekPad(sceneId, groupKey, padId, progress /*0..1*/) {
    const key = padKey(sceneId, groupKey, padId);
    const ref = padAudioRef.current.get(key);
    if (!ref) return;
    try {
      const p = Math.max(0, Math.min(1, Number(progress) || 0));
      const dur = Number(ref.el.duration);
      if (Number.isFinite(dur) && dur > 0) {
        ref.el.currentTime = dur * p;
      }
    } catch {}
  }

  // Seek bar handlers following web search results pattern
  function handleSeekStart(sceneId, groupKey, padId) {
    const key = padKey(sceneId, groupKey, padId);
    const ref = padAudioRef.current.get(key);
    if (!ref) return;

    // Store whether audio was playing before seek
    const wasPlaying = !ref.el.paused && !ref.el.ended;
    const padSeekKey = `${sceneId}:${groupKey}:${padId}`;

    setSeekStates((prev) => ({
      ...prev,
      [padSeekKey]: {
        ...prev[padSeekKey],
        wasPlaying,
        isSeeking: true,
      },
    }));

    // Pause audio during seek
    ref.el.pause();
  }

  function handleSeekChange(sceneId, groupKey, padId, progress) {
    const padSeekKey = `${sceneId}:${groupKey}:${padId}`;

    // Update seek bar position
    setSeekStates((prev) => ({
      ...prev,
      [padSeekKey]: {
        ...prev[padSeekKey],
        progress,
      },
    }));
  }

  function handleSeekEnd(sceneId, groupKey, padId, progress) {
    const key = padKey(sceneId, groupKey, padId);
    const ref = padAudioRef.current.get(key);
    if (!ref) return;

    const padSeekKey = `${sceneId}:${groupKey}:${padId}`;
    const seekState = seekStates[padSeekKey] || {};

    // Set the audio to the new position
    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    const dur = Number(ref.el.duration);
    if (Number.isFinite(dur) && dur > 0) {
      ref.el.currentTime = dur * p;
    }

    // Resume playback if it was playing before
    if (seekState.wasPlaying) {
      ref.el.play().catch(() => {});
    }

    // Update final seek state
    setSeekStates((prev) => ({
      ...prev,
      [padSeekKey]: {
        ...prev[padSeekKey],
        progress,
        isSeeking: false,
      },
    }));
  }

  function stopAllAudio() {
    try {
      padAudioRef.current.forEach((ref, key) => {
        try {
          ref.el.pause();
          ref.el.currentTime = 0;
        } catch {}
      });
    } catch {}
    try {
      padAudioRef.current.clear();
    } catch {}
  }

  function runPadTriggers(scene, pad, phase) {
    // New array-based triggers, with legacy fallback
    let list = [];
    const legacy =
      pad.triggers && !Array.isArray(pad.triggers) ? pad.triggers : null;
    if (Array.isArray(pad.triggers)) {
      list = (pad.triggers || []).filter((tr) => tr && tr.phase === phase);
    } else if (legacy && legacy[phase]) {
      const t = legacy[phase];
      if (t && t.action && t.action !== "none") {
        const parts = String(t.target || "").split(":");
        list = [
          {
            id: `trg-${Math.random().toString(36).slice(2, 8)}`,
            phase,
            action: t.action,
            sceneId: parts.length > 1 ? parts[0] : scene.id,
            padId: parts.length > 1 ? parts[1] : parts[0] || pad.id,
            timeMs: typeof t.timeMs === "number" ? t.timeMs : 200,
          },
        ];
      }
    }
    if (!list || list.length === 0) return;

    const findSceneById = (sid) => {
      // Use showRef for more reliable access to latest scenes
      const currentShow = showRef.current || show;
      const foundScene = (currentShow.scenes || []).find((s) => s.id === sid);
      if (!foundScene) {
        console.log(
          `Scene ${sid} not found in ${
            currentShow.scenes?.length || 0
          } scenes:`,
          currentShow.scenes?.map((s) => s.id)
        );
      } else {
        console.log(`Scene ${sid} found: ${foundScene.name}`);
      }
      return foundScene;
    };

    list.forEach((t) => {
      if (!t || t.action === "none") return;

      const targetSceneId = t.sceneId || scene.id;
      const targetScene = findSceneById(targetSceneId) || scene;
      const targetPadId = t.padId || pad.id;

      console.log(
        `Trigger: ${t.action} from scene ${scene.id} pad ${pad.id} to scene ${targetSceneId} pad ${targetPadId}`
      );

      const found = findPadByAny(targetScene, targetPadId);
      if (!found) {
        console.log(
          `Trigger failed: Could not find pad ${targetPadId} in scene ${targetScene.id}`
        );
        return;
      }
      const [gk, p] = found;
      console.log(
        `Trigger executing: ${t.action} on ${gk}:${p.id} (${p.name || p.label})`
      );
      if (t.action === "play") {
        setPadPlaying(gk, p.id, true, targetScene.id);
      } else if (t.action === "stop") {
        setPadPlaying(gk, p.id, false, targetScene.id);
      } else if (
        t.action === "fade" ||
        t.action === "fadeIn" ||
        t.action === "fadeOut"
      ) {
        const ms = Math.max(0, Number.isFinite(t.timeMs) ? t.timeMs : 200);
        const targetLevel =
          typeof p.baseLevel === "number"
            ? p.baseLevel
            : typeof p.level === "number"
            ? p.level
            : 0.8;

        const key = padKey(targetScene.id, gk, p.id);
        const ref = padAudioRef.current.get(key);
        const currentVol = ref ? ref.el.volume : targetLevel;

        const doFadeOut = () => {
          if (!ref) return; // nothing to fade
          fadeVolume(targetScene.id, gk, p.id, currentVol, 0, ms, () => {
            setPadPlaying(gk, p.id, false, targetScene.id);
          });
        };

        const doFadeIn = () => {
          if (!p.playing) {
            setPadPlaying(gk, p.id, true, targetScene.id);
          }
          // Ensure audio ref exists, then force to 0 and fade up
          const ensure = () => {
            const r = padAudioRef.current.get(key);
            if (!r) {
              requestAnimationFrame(ensure);
              return;
            }
            applyPadVolume(targetScene.id, gk, p.id, 0);
            fadeVolume(targetScene.id, gk, p.id, 0, targetLevel, ms);
          };
          ensure();
        };

        if (t.action === "fadeOut") {
          doFadeOut();
        } else if (t.action === "fadeIn") {
          doFadeIn();
        } else {
          // Legacy 'fade': pick direction based on current playing state
          if (p.playing) doFadeOut();
          else doFadeIn();
        }
      }
    });
  }

  // --- Persistence: export/import & relink ---
  function handleExport() {
    try {
      const data = serializeShowForSave(show);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().slice(0, 19).replace(/[.:T]/g, "-");
      a.href = url;
      a.download = `${(show.title || "soundboard").replace(
        /\s+/g,
        "_"
      )}-${ts}.json`;
      a.click();
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch {}
      }, 1000);
      setStatus("Exported settings");
    } catch {
      setStatus("Export failed");
    }
  }

  function handleNewShow() {
    // eslint-disable-next-line no-alert
    const ok = confirm(
      "Start a new show? This will clear all saved data and reset."
    );
    if (!ok) return;
    try {
      localStorage.clear();
    } catch {}
    const next = createInitialShow();
    setShow(next);
    setCurrentSceneId(next.scenes[0]?.id || null);
    setSelectedPadKey(null);
    setStatus("New show created");
  }

  function handleImportFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        const next = migrateLoadedShow(obj);
        setShow(next);
        setCurrentSceneId(next.scenes[0]?.id);
        setStatus("Imported settings");
      } catch {
        setStatus("Invalid JSON import");
      } finally {
        try {
          e.target.value = "";
        } catch {}
      }
    };
    try {
      reader.readAsText(f);
    } catch {
      setStatus("Import failed");
    }
  }

  async function relinkFromDirectory() {
    if (typeof window === "undefined" || !window.showDirectoryPicker) {
      try {
        alert(
          "Folder picker not supported in this browser. Use Edit to reattach files."
        );
      } catch {}
      return;
    }
    try {
      const dir = await window.showDirectoryPicker({});
      // Try to persist storage and remember handle for future auto-relink
      try {
        await navigator.storage?.persist?.();
      } catch {}
      try {
        await saveRootDirectoryHandle(dir);
      } catch {}
      setStatus("Indexing folder...");
      const index = await indexDirectoryFiles(dir);
      const needed = [];
      (show.scenes || []).forEach((scene) => {
        ["background", "ambients", "sfx"].forEach((gk) => {
          (scene[gk] || []).forEach((p) => {
            const name = fileNameFromPath(p.assetPath || "");
            if (!name || isUrlLike(name) || p.assetUrl) return;
            needed.push(name.toLowerCase());
          });
        });
      });
      const unique = Array.from(new Set(needed));
      const nameToUrl = new Map();
      let created = 0;
      for (const name of unique) {
        const handle = index.get(name);
        if (!handle) continue;
        try {
          const file = await handle.getFile();
          const url = URL.createObjectURL(file);
          nameToUrl.set(name, url);
          created++;
        } catch {}
      }
      let linked = 0;
      setShow((prev) => {
        const next = structuredClone(prev);
        (next.scenes || []).forEach((scene) => {
          ["background", "ambients", "sfx"].forEach((gk) => {
            (scene[gk] || []).forEach((p) => {
              const key = fileNameFromPath(p.assetPath || "");
              const url = nameToUrl.get(key);
              if (url) {
                p.assetUrl = url;
                linked++;
              }
            });
          });
        });
        return next;
      });
      setStatus(`Relinked ${linked}/${unique.length} file(s)`);
      // Close the modal after an attempt (user selected a folder)
      setRelinkRequired(false);
      setRelinkMissingCount(0);
    } catch {
      // user cancelled or error
    }
  }

  async function indexDirectoryFiles(dirHandle) {
    const map = new Map();
    async function walk(dh) {
      try {
        for await (const [name, handle] of dh.entries()) {
          if (handle && handle.kind === "file") {
            map.set(name.toLowerCase(), handle);
          } else if (handle && handle.kind === "directory") {
            await walk(handle);
          }
        }
      } catch {}
    }
    await walk(dirHandle);
    return map;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brandRow">
          <img src={logoUrl} alt="CueBoard" className="brandLogo" />
        </div>
        <h2>Scenes</h2>
        {mode === "edit" && (
          <div className="sceneControls">
            <button className="btn sm" onClick={addScene}>
              + Scene
            </button>
            <button className="btn sm" onClick={duplicateScene}>
              Duplicate
            </button>
            <button className="btn sm" onClick={renameScene}>
              Rename
            </button>
            <button className="btn sm" onClick={() => moveScene(-1)}>
              ↑
            </button>
            <button className="btn sm" onClick={() => moveScene(1)}>
              ↓
            </button>
            <button className="btn sm red" onClick={deleteScene}>
              Delete
            </button>
          </div>
        )}
        {show.scenes.map((s) => (
          <div
            key={s.id}
            className={"sceneItem" + (s.id === currentSceneId ? " active" : "")}
            onClick={() => setCurrentSceneId(s.id)}
          >
            <span
              style={s.id === currentSceneId ? { color: "#ffeb3b" } : undefined}
            >
              {s.name}
            </span>
          </div>
        ))}
        {mode === "edit" && (
          <>
            <div className="sectionLabel">Groups</div>
            <div className="groupList">
              {(show.groups || []).map((g) => (
                <div key={g.id} className="groupItem">
                  <div
                    className="groupSwatch"
                    style={{ background: g.color }}
                  />
                  <input
                    value={g.name}
                    onChange={(e) =>
                      updateGroup(g.id, { name: e.target.value })
                    }
                  />
                  <select
                    value={g.color}
                    onChange={(e) =>
                      updateGroup(g.id, { color: e.target.value })
                    }
                    style={{
                      background: g.color,
                      color: getReadableTextColor(g.color),
                    }}
                  >
                    {APC_COLOR_TABLE.map((c) => (
                      <option
                        key={c.vel}
                        value={c.hex}
                        style={{
                          background: c.hex,
                          color: getReadableTextColor(c.hex),
                        }}
                      >
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <div className="groupActions">
                    <button
                      className="btn sm"
                      onClick={() => duplicateGroup(g.id)}
                    >
                      Dup
                    </button>
                    <button
                      className="btn sm red"
                      onClick={() => deleteGroup(g.id)}
                    >
                      Del
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 6 }}>
              <button className="btn sm" onClick={addGroup}>
                + Group
              </button>
            </div>
          </>
        )}
      </aside>

      <div className="main">
        <div className="topbar">
          <button
            className={"btn gray" + (mode === "edit" ? " activeBtn" : "")}
            onClick={() => setMode("edit")}
          >
            Edit
          </button>
          <button
            className={"btn gray" + (mode === "show" ? " activeBtn" : "")}
            style={
              mode === "show"
                ? {
                    background: "rgba(242,184,75,0.25)",
                    boxShadow: "0 0 0 2px rgba(242,184,75,0.35) inset",
                  }
                : undefined
            }
            onClick={() => setMode("show")}
          >
            Show
          </button>
          <button
            className={"btn blue" + (mode === "edit" ? " activeBtn" : "")}
            onClick={handleRememberCapture}
          >
            Save Mix
          </button>
          <button className="btn red" onClick={handleStopAll}>
            Stop All (S)
          </button>
          <button
            className={"btn" + (mode === "show" ? " activeBtn" : "")}
            onClick={prevScene}
          >
            Prev Scene (B)
          </button>
          <button
            className={"btn" + (mode === "show" ? " activeBtn" : "")}
            onClick={nextScene}
          >
            Next Scene (N)
          </button>
          <button className="btn" onClick={() => setNotesOpen((v) => !v)}>
            {notesOpen ? "Hide Notes" : "Show Notes"}
          </button>
          <button className="btn" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <button className="btn" onClick={() => setMapperOpen(true)}>
            APC Mapper
          </button>
          <button className="btn red" onClick={handleNewShow}>
            New Show
          </button>
          <button className="btn" onClick={handleExport}>
            Export
          </button>
          <button
            className="btn"
            onClick={() => importInputRef.current?.click()}
          >
            Import
          </button>
          <button className="btn" onClick={relinkFromDirectory}>
            Relink Files
          </button>
          <div className="spacer" />
          <span id="status">{status}</span>
          <span style={{ marginLeft: 10, color: "#bbb", fontSize: 12 }}>
            MIDI: {midiOutName}
          </span>
        </div>

        <div className="content">
          {/* Tips panel removed per UI cleanup */}

          <GroupSection
            title="Background Music"
            color={groupColors["grp-bg"] || "#0000FF"}
            pads={currentScene.background}
            groupKey="background"
            mode={mode}
            active={activeGroupKey === "background"}
            sceneId={currentScene.id}
            onPadToggle={(id) => togglePadPlay("background", id)}
            onSetPlaying={(id, playing) =>
              setPadPlaying("background", id, playing)
            }
            onResume={(id) => setPadPlaying("background", id, true, null, true)}
            onLevelChange={(id, v) => setPadLevel("background", id, v)}
            onEdit={(id) => openEditor("background", id)}
            onDelete={(id) => deletePad("background", id)}
            selectedPadKey={selectedPadKey}
            setSelectedPadKey={setSelectedPadKey}
            seekStates={seekStates}
            onSeekStart={handleSeekStart}
            onSeekChange={handleSeekChange}
            onSeekEnd={handleSeekEnd}
            padAudioRef={padAudioRef}
            show={show}
          />

          <GroupSection
            title="Ambient Noise"
            color={groupColors["grp-amb"] || "#FF6A00"}
            pads={currentScene.ambients}
            groupKey="ambients"
            mode={mode}
            active={activeGroupKey === "ambients"}
            sceneId={currentScene.id}
            onPadToggle={(id) => togglePadPlay("ambients", id)}
            onSetPlaying={(id, playing) =>
              setPadPlaying("ambients", id, playing)
            }
            onResume={(id) => setPadPlaying("ambients", id, true, null, true)}
            onLevelChange={(id, v) => setPadLevel("ambients", id, v)}
            onEdit={(id) => openEditor("ambients", id)}
            onDelete={(id) => deletePad("ambients", id)}
            selectedPadKey={selectedPadKey}
            setSelectedPadKey={setSelectedPadKey}
            seekStates={seekStates}
            onSeekStart={handleSeekStart}
            onSeekChange={handleSeekChange}
            onSeekEnd={handleSeekEnd}
            padAudioRef={padAudioRef}
            show={show}
          />

          <GroupSection
            title="Sound Effects"
            color={groupColors["grp-sfx"] || "#00FF00"}
            pads={currentScene.sfx}
            groupKey="sfx"
            mode={mode}
            active={activeGroupKey === "sfx"}
            sceneId={currentScene.id}
            onPadToggle={(id) => togglePadPlay("sfx", id)}
            onSetPlaying={(id, playing) => setPadPlaying("sfx", id, playing)}
            onResume={(id) => setPadPlaying("sfx", id, true, null, true)}
            seekStates={seekStates}
            onSeekStart={handleSeekStart}
            onSeekChange={handleSeekChange}
            onSeekEnd={handleSeekEnd}
            padAudioRef={padAudioRef}
            show={show}
            onLevelChange={(id, v) => setPadLevel("sfx", id, v)}
            onEdit={(id) => openEditor("sfx", id)}
            onDelete={(id) => deletePad("sfx", id)}
            selectedPadKey={selectedPadKey}
            setSelectedPadKey={setSelectedPadKey}
          />

          {(show.groups || [])
            .filter((g) => !["grp-bg", "grp-amb", "grp-sfx"].includes(g.id))
            .map((g) => {
              const pads = [
                ...(currentScene.background || []),
                ...(currentScene.ambients || []),
                ...(currentScene.sfx || []),
              ].filter((p) => p.groupId === g.id);
              if (pads.length === 0 && mode !== "edit") return null;
              return (
                <GroupSection
                  key={g.id}
                  title={g.name}
                  color={g.color}
                  pads={pads}
                  groupKey={`group:${g.id}`}
                  mode={mode}
                  active={false}
                  sceneId={currentScene.id}
                  onPadToggle={(id) => {
                    const found = findPadByAny(currentScene, id);
                    if (!found) return;
                    const [gk] = found;
                    togglePadPlay(gk, id);
                  }}
                  onSetPlaying={(id, playing) => {
                    const found = findPadByAny(currentScene, id);
                    if (!found) return;
                    const [gk] = found;
                    setPadPlaying(gk, id, playing);
                  }}
                  onResume={(id) => {
                    const found = findPadByAny(currentScene, id);
                    if (!found) return;
                    const [gk] = found;
                    setPadPlaying(gk, id, true, null, true); // true for useResume
                  }}
                  onLevelChange={(id, v) => {
                    const found = findPadByAny(currentScene, id);
                    if (!found) return;
                    const [gk] = found;
                    setPadLevel(gk, id, v);
                  }}
                  onEdit={(id) => {
                    if (id) {
                      const found = findPadByAny(currentScene, id);
                      if (found) {
                        const [gk] = found;
                        openEditor(gk, id);
                      }
                    } else {
                      openEditor("sfx", null);
                    }
                  }}
                  onDelete={(id) => {
                    const found = findPadByAny(currentScene, id);
                    if (!found) return;
                    const [gk] = found;
                    deletePad(gk, id);
                  }}
                  selectedPadKey={selectedPadKey}
                  setSelectedPadKey={setSelectedPadKey}
                  seekStates={seekStates}
                  onSeekStart={handleSeekStart}
                  onSeekChange={handleSeekChange}
                  onSeekEnd={handleSeekEnd}
                  padAudioRef={padAudioRef}
                  show={show}
                />
              );
            })}

          {notesOpen && (
            <NotesPanel
              mode={mode}
              notes={currentScene.notes}
              onChange={(val) =>
                updateScene((scene) => {
                  scene.notes = val;
                  return scene;
                })
              }
            />
          )}
        </div>

        <div className="footer">
          <div>
            CueBoard — {mode.toUpperCase()} — Scene: {currentScene.name}
          </div>
          <div>MIDI: {midiOut ? midiOut.name : "Offline"}</div>
        </div>
      </div>
      {/* Hidden import input */}
      <input
        type="file"
        accept="application/json"
        ref={importInputRef}
        onChange={handleImportFile}
        style={{ display: "none" }}
      />
      {mode === "edit" && (
        <div
          style={{ position: "absolute", left: 0, bottom: 0, padding: 12 }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={show.settings}
          scene={currentScene}
          onUpdatePadRoute={(groupKey, id, routeKey) => {
            updateScene((scene) => {
              const pad = findPad(scene, groupKey, id);
              if (pad) pad.routeKey = routeKey || undefined;
              return scene;
            });
          }}
          onUpdateSettings={(updater) => {
            setShow((prev) => ({
              ...prev,
              settings:
                typeof updater === "function"
                  ? updater(structuredClone(prev.settings || {}))
                  : { ...prev.settings, ...updater },
            }));
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {mapperOpen && <ApcMapperModal onClose={() => setMapperOpen(false)} />}
      {relinkRequired && (
        <RelinkModal
          missingCount={relinkMissingCount}
          onRelink={relinkFromDirectory}
          onClose={() => setRelinkRequired(false)}
        />
      )}
      {editor.open && (
        <SoundEditorDrawer
          editor={editor}
          scene={currentScene}
          settings={show.settings}
          groups={show.groups}
          scenes={show.scenes}
          onClose={() =>
            setEditor({ open: false, groupKey: null, padId: null })
          }
          onSave={saveEditor}
        />
      )}
    </div>
  );

  // Actions on pads
  function togglePadPlay(groupKey, id, usePause = false) {
    updateScene((scene) => {
      const pad = findPad(scene, groupKey, id);
      if (!pad) return scene;
      if (!pad.assetUrl && !pad.assetPath) {
        setStatus("No audio attached to this pad");
        return scene;
      }
      const next = !pad.playing;
      setPadPlaying(groupKey, id, next, null, false, usePause);
      setStatus(
        `${pad.label || pad.name} ${
          next ? "started" : usePause ? "paused" : "stopped"
        }`
      );
      return scene;
    });
  }

  function setPadLevel(groupKey, id, value, sceneIdOverride) {
    const targetSceneId =
      sceneIdOverride ||
      (currentSceneRef.current && currentSceneRef.current.id) ||
      currentScene.id;
    const updater = (scene) => {
      const pad = findPad(scene, groupKey, id);
      if (!pad) return scene;
      pad.level = value;
      return scene;
    };
    if (
      targetSceneId !==
      ((currentSceneRef.current && currentSceneRef.current.id) ||
        currentScene.id)
    ) {
      updateSceneById(targetSceneId, updater);
    } else {
      updateScene(updater);
    }
    applyPadVolume(targetSceneId, groupKey, id, value);
    // If this pad is within the first 8 of the active group, echo the ring LED
    try {
      const scene = currentSceneRef.current;
      const group = activeGroupRef.current;
      if (scene && group && group === groupKey) {
        const arr = groupArray(scene, groupKey) || [];
        const idx = arr.findIndex((p) => p.id === id);
        if (idx >= 0 && idx < 8) {
          apcSendKnobValue(idx, volumeToCc(value));
        }
      }
    } catch {}
    try {
      const sc =
        (show.scenes || []).find((s) => s.id === targetSceneId) ||
        currentSceneRef.current ||
        currentScene;
      const pad = findPad(sc, groupKey, id);
      if (pad)
        setStatus(`${pad.label || pad.name} level ${(value * 100) | 0}%`);
    } catch {}
  }

  function setPadPlaying(
    groupKey,
    id,
    playing,
    sceneIdOverride,
    useResume = false,
    usePause = false
  ) {
    const targetSceneId =
      sceneIdOverride ||
      (currentSceneRef.current && currentSceneRef.current.id) ||
      currentScene.id;

    const updater = (scene) => {
      const pad = findPad(scene, groupKey, id);
      if (!pad) return scene;
      pad.playing = !!playing;

      // Initialize seek bar position when starting playback
      if (playing && !useResume) {
        const padSeekKey = `${targetSceneId}:${groupKey}:${id}`;
        setSeekStates((prev) => ({
          ...prev,
          [padSeekKey]: {
            ...prev[padSeekKey],
            progress: 0,
            isSeeking: false,
          },
        }));
      }

      if (useResume) {
        // Handle resume logic
        if (playing) {
          resumePad(targetSceneId, groupKey, pad);
          setStatus(`${pad.label || pad.name} resumed`);
        }
      } else {
        // Use pause when usePause is true, otherwise use stop (which includes fade out)
        const shouldUsePause = usePause && !playing;
        handlePadAudio(scene, groupKey, pad, !!playing, shouldUsePause);
      }
      return scene;
    };

    if (
      targetSceneId !==
      ((currentSceneRef.current && currentSceneRef.current.id) ||
        currentScene.id)
    )
      updateSceneById(targetSceneId, updater);
    else updateScene(updater);

    // Fire triggers for this pad state change
    try {
      // For cross-scene triggers, we need to find the correct scene after the update
      // Since React state updates are async, we try multiple approaches
      let targetScene = null;

      // First try to find the updated scene from show.scenes
      targetScene = (show.scenes || []).find((s) => s.id === targetSceneId);

      // Fallback to refs
      if (!targetScene) {
        targetScene = currentSceneRef.current;
      }

      // Final fallback to computed current scene
      if (!targetScene) {
        targetScene = currentScene;
      }

      const pad = findPad(targetScene, groupKey, id);
      if (pad) runPadTriggers(targetScene, pad, playing ? "onStart" : "onStop");
    } catch {}
  }

  function openEditor(groupKey, id) {
    setEditor({ open: true, groupKey, padId: id });
  }

  function saveEditor(payload) {
    updateScene((scene) => {
      // Ensure pad is stored only in the selected type lane (background/ambients/sfx)
      ["background", "ambients", "sfx"].forEach((gk) => {
        if (gk === payload.groupKey) return;
        const arr = groupArray(scene, gk);
        const i = arr.findIndex((p) => p.id === payload.id);
        if (i >= 0) arr.splice(i, 1);
      });
      const dest = groupArray(scene, payload.groupKey);
      const di = dest.findIndex((p) => p.id === payload.id);
      if (di >= 0) {
        dest[di] = { ...dest[di], ...payload };
      } else {
        dest.push({ ...payload, playing: false, level: payload.level ?? 0.8 });
      }
      return scene;
    });
    setEditor({ open: false, groupKey: null, padId: null });
    setStatus("Saved sound");
  }

  function deletePad(groupKey, id) {
    // eslint-disable-next-line no-alert
    if (!confirm("Delete this sound?")) return;
    updateScene((scene) => {
      const arr = groupArray(scene, groupKey);
      const i = arr.findIndex((p) => p.id === id);
      if (i >= 0) arr.splice(i, 1);
      return scene;
    });
  }

  // Scene manager (edit mode)
  function addScene() {
    const ns = createEmptyScene(`Scene ${show.scenes.length + 1}`);
    setShow((prev) => ({ ...prev, scenes: [...prev.scenes, ns] }));
    setCurrentSceneId(ns.id);
  }
  function duplicateScene() {
    const src = currentScene;
    const copy = structuredClone(src);
    copy.id = `scene-${Math.random().toString(36).slice(2, 8)}`;
    copy.name = `${src.name} Copy`;
    setShow((prev) => ({ ...prev, scenes: [...prev.scenes, copy] }));
    setCurrentSceneId(copy.id);
  }
  function renameScene() {
    const next = prompt("Rename scene", currentScene.name);
    if (!next || !next.trim()) return;
    setShow((prev) => ({
      ...prev,
      scenes: prev.scenes.map((s) =>
        s.id === currentSceneId ? { ...s, name: next.trim() } : s
      ),
    }));
  }
  function deleteScene() {
    // eslint-disable-next-line no-alert
    if (!confirm("Delete this scene?")) return;
    setShow((prev) => {
      const idx = prev.scenes.findIndex((s) => s.id === currentSceneId);
      const nextScenes = prev.scenes.filter((s) => s.id !== currentSceneId);
      const nextId = nextScenes[Math.max(0, idx - 1)]?.id;
      setCurrentSceneId(nextId || nextScenes[0]?.id || null);
      return { ...prev, scenes: nextScenes };
    });
  }
  function moveScene(delta) {
    setShow((prev) => {
      const arr = [...prev.scenes];
      const i = arr.findIndex((s) => s.id === currentSceneId);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= arr.length) return prev;
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
      return { ...prev, scenes: arr };
    });
  }

  // Group operations
  function addGroup() {
    setShow((prev) => ({
      ...prev,
      groups: [
        ...(prev.groups || []),
        {
          id: `grp-${Math.random().toString(36).slice(2, 6)}`,
          name: "New Group",
          color: "#8888ff",
        },
      ],
    }));
  }
  function updateGroup(id, patch) {
    setShow((prev) => ({
      ...prev,
      groups: (prev.groups || []).map((g) =>
        g.id === id ? { ...g, ...patch } : g
      ),
    }));
  }
  function duplicateGroup(id) {
    setShow((prev) => {
      const g = (prev.groups || []).find((x) => x.id === id);
      if (!g) return prev;
      const copy = {
        ...g,
        id: `grp-${Math.random().toString(36).slice(2, 6)}`,
        name: `${g.name} Copy`,
      };
      return { ...prev, groups: [...prev.groups, copy] };
    });
  }
  function deleteGroup(id) {
    setShow((prev) => ({
      ...prev,
      groups: (prev.groups || []).filter((g) => g.id !== id),
    }));
  }
}

// Sidebar group management helpers
function updateGroupState(setShow, updater) {
  setShow((prev) => ({
    ...prev,
    groups: updater(structuredClone(prev.groups || [])),
  }));
}

function GroupSection({
  title,
  color,
  pads,
  groupKey,
  mode,
  active,
  onPadToggle,
  onSetPlaying,
  onResume,
  onLevelChange,
  onEdit,
  onDelete,
  selectedPadKey,
  setSelectedPadKey,
  sceneId,
  seekStates,
  onSeekStart,
  onSeekChange,
  onSeekEnd,
  padAudioRef,
  show,
}) {
  return (
    <div className="groupBlock">
      <div className="groupHeader">
        <div className="dot" style={{ background: color }} />
        <div className="title">
          {title}
          {active && (
            <span
              style={{
                marginLeft: 8,
                color: "#ffffff",
                backgroundColor: "#ff4d4d",
                fontWeight: 700,
                fontSize: 16,
                border: "2px solid #ff4d4d",
                borderRadius: 6,
                padding: "4px 12px",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Active
            </span>
          )}
        </div>
      </div>
      <div className="grid">
        {pads.map((p) => (
          <PadCard
            key={p.id}
            pad={p}
            groupKey={groupKey}
            mode={mode}
            sceneId={sceneId}
            onToggle={() => onPadToggle(p.id)}
            onSetPlaying={(playing) => onSetPlaying?.(p.id, playing)}
            onResume={() => onResume?.(p.id)}
            onLevelChange={(v) => onLevelChange(p.id, v)}
            selected={selectedPadKey === `${groupKey}:${p.id}`}
            onSelect={() => setSelectedPadKey(`${groupKey}:${p.id}`)}
            onEdit={() => onEdit?.(p.id)}
            onDelete={() => onDelete?.(p.id)}
            seekStates={seekStates}
            onSeekStart={onSeekStart}
            onSeekChange={onSeekChange}
            onSeekEnd={onSeekEnd}
            padAudioRef={padAudioRef}
            show={show}
          />
        ))}
        {mode === "edit" && (
          <div className="addCard" onClick={() => onEdit?.(null)}>
            + Add Sound
          </div>
        )}
      </div>
    </div>
  );
}

function PadCard({
  pad,
  groupKey,
  mode,
  sceneId,
  onToggle,
  onSetPlaying,
  onResume,
  onLevelChange,
  selected,
  onSelect,
  onEdit,
  onDelete,
  seekStates,
  onSeekStart,
  onSeekChange,
  onSeekEnd,
  padAudioRef,
  show,
}) {
  const headerStyle = {
    background: "rgba(0,0,0,.18)",
    color: "#fff",
    fontSize: 20,
    fontWeight: 700,
    lineHeight: "28px",
    padding: "8px 10px",
  };
  const resolvedBase = pad.color || "#2a2a2a";
  const bodyColor = pad.playing ? lighten(resolvedBase, 0.12) : resolvedBase;

  const waveRef = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!waveRef.current || !(pad.assetUrl || pad.assetPath)) return;
    if (wsRef.current) {
      try {
        wsRef.current.destroy();
      } catch {}
      wsRef.current = null;
    }
    wsRef.current = WaveSurfer.create({
      container: waveRef.current,
      waveColor: "#4fc3f7",
      progressColor: "#03dac6",
      cursorColor: "#eee",
      height: 36,
      barWidth: 2,
      normalize: true,
      backend: "MediaElement",
      mediaControls: false,
      autoplay: false,
    });
    // Reflect seeks on the main audio element for this pad
    try {
      let wasPlayingBeforeSeek = false;

      wsRef.current.on("interaction", () => {
        // Store whether audio was playing before seek interaction
        const waveSurferMap = window.waveSurferInstances;
        if (waveSurferMap) {
          const padKey = `${sceneId}:${groupKey}:${pad.id}`;
          const audioRef = padAudioRef.current.get(padKey);
          if (audioRef) {
            wasPlayingBeforeSeek = !audioRef.el.paused && !audioRef.el.ended;
          }
        }
      });

      wsRef.current.on("seek", (progress) => {
        // Get the audio element
        const padKey = `${sceneId}:${groupKey}:${pad.id}`;
        const audioRef = padAudioRef.current.get(padKey);

        if (audioRef && audioRef.el) {
          // Pause audio during seek
          audioRef.el.pause();

          // Calculate and set the new time
          const newTime = progress * audioRef.el.duration;
          audioRef.el.currentTime = newTime;

          // Resume playback if it was playing before
          if (wasPlayingBeforeSeek) {
            audioRef.el.play().catch(() => {});
          }
        }
      });
    } catch {}
    try {
      const p = wsRef.current.load(pad.assetUrl || pad.assetPath);
      if (p && typeof p.catch === "function") {
        p.catch(() => {});
      }
    } catch {}
    return () => {
      try {
        wsRef.current?.destroy();
      } catch {}
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pad.assetUrl, pad.assetPath, pad.playbackMode]);

  // Drive WaveSurfer playback to visualize progress (audio remains muted)

  // Keep WaveSurfer muted so it doesn't emit audio (we use <audio> for sound)
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    try {
      ws.setVolume?.(0);
    } catch {}
  }, [pad.level]);

  // Create a global map to store WaveSurfer instances for progress sync
  useEffect(() => {
    if (!wsRef.current) return;

    // Store WaveSurfer instance in global map for progress sync
    const waveSurferMap = (window.waveSurferInstances =
      window.waveSurferInstances || new Map());
    const padKey = `${sceneId}:${groupKey}:${pad.id}`;
    waveSurferMap.set(padKey, wsRef.current);

    return () => {
      waveSurferMap.delete(padKey);
    };
  }, [sceneId, groupKey, pad.id]);

  // Sync waveform progress with pad play/pause
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    try {
      if (pad.playing) {
        // Just seek to start for visualization - progress will be synced manually
        try {
          ws.seekTo?.(0);
        } catch {}
      } else {
        // Pause and seek to start when not playing
        ws.pause?.();
        try {
          ws.seekTo?.(0);
        } catch {}
      }
    } catch {}
  }, [pad.playing]);

  const handleContextMenu = (e) => {
    e.preventDefault();
    if (mode !== "edit") return;
    const next = prompt("Rename pad", pad.label || pad.name);
    if (next && next.trim()) {
      pad.label = next.trim();
    }
  };

  const hasTriggers = (() => {
    if (!pad?.triggers) return false;
    if (Array.isArray(pad.triggers)) return pad.triggers.length > 0;
    const t = pad.triggers;
    const valid = (x) => x && x.action && x.action !== "none";
    return valid(t.onStart) || valid(t.onStop);
  })();

  return (
    <div
      className={"pad" + (pad.playing ? " playing" : "")}
      style={{
        background: bodyColor,
        outline: selected ? "1px solid #5a5a5a" : "none",
      }}
      onClick={() => onSelect?.()}
      onContextMenu={handleContextMenu}
    >
      <div className="padHeader" style={headerStyle}>
        {pad.label || pad.name}
      </div>
      {mode !== "edit" && hasTriggers && (
        <div className="padBadge" title="Has triggers">
          ⚡
        </div>
      )}
      {mode === "edit" && (
        <div className="padTools">
          <button
            className="iconBtn"
            title="Edit"
            onClick={(e) => {
              e.stopPropagation();
              onEdit?.();
            }}
          >
            ✎
          </button>
          <button
            className="iconBtn"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete?.();
            }}
          >
            ✕
          </button>
        </div>
      )}
      <div className="padBody">
        <div className="playArea">
          {pad.assetUrl || pad.assetPath ? (
            <>
              <div className="waveContainer" ref={waveRef} />
              {pad.playing && <div className="playingTicker" />}
              <div className="waveControls">
                {!pad.playing && (pad.assetUrl || pad.assetPath) ? (
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      className="btn sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Play from beginning (don't use pause)
                        onToggle?.();
                      }}
                    >
                      Play
                    </button>
                    <button
                      className="btn sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        console.log("Resume button clicked for pad:", pad.id);
                        // Resume from current position
                        onResume?.();
                      }}
                    >
                      Resume
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (pad.playing) {
                        // Pause (preserve position for resume)
                        onSetPlaying?.(false);
                      } else {
                        // Play from beginning
                        onToggle?.();
                      }
                    }}
                  >
                    {pad.playing ? "Pause" : "Play"}
                  </button>
                )}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={pad.level || 0}
                  onChange={(e) => {
                    onLevelChange(Number(e.target.value));
                  }}
                />
              </div>
              {/* External Seek Bar */}
              <div className="seekBarContainer">
                <input
                  type="range"
                  className="seekBar"
                  min="0"
                  max="1"
                  step="0.001"
                  value={(() => {
                    const padSeekKey = `${sceneId}:${groupKey}:${pad.id}`;
                    const seekState = seekStates[padSeekKey];
                    if (seekState && seekState.isSeeking) {
                      return seekState.progress || 0;
                    }
                    // Get current progress from audio element if playing
                    const key = `${sceneId}:${groupKey}:${pad.id}`;
                    const ref = padAudioRef.current.get(key);
                    if (ref && ref.el && ref.el.duration > 0) {
                      return ref.el.currentTime / ref.el.duration;
                    }
                    return 0;
                  })()}
                  onMouseDown={() => onSeekStart?.(sceneId, groupKey, pad.id)}
                  onChange={(e) =>
                    onSeekChange?.(
                      sceneId,
                      groupKey,
                      pad.id,
                      Number(e.target.value)
                    )
                  }
                  onMouseUp={(e) =>
                    onSeekEnd?.(
                      sceneId,
                      groupKey,
                      pad.id,
                      Number(e.target.value)
                    )
                  }
                  onKeyUp={(e) =>
                    onSeekEnd?.(
                      sceneId,
                      groupKey,
                      pad.id,
                      Number(e.target.value)
                    )
                  }
                  disabled={!pad.playing && !pad.assetUrl && !pad.assetPath}
                />
              </div>
            </>
          ) : (
            <div style={{ color: "#bbb" }}>No audio attached</div>
          )}
        </div>
      </div>
    </div>
  );
}

// removed VSlider component

function NotesPanel({ mode, notes, onChange }) {
  return (
    <div className="notesPanel">
      <div style={{ color: "#bbb", marginBottom: 6 }}>Scene Notes</div>
      {mode === "edit" ? (
        <textarea
          value={notes}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder="Operator notes here"
        />
      ) : (
        <div style={{ whiteSpace: "pre-wrap", color: "#ddd" }}>
          {notes || ""}
        </div>
      )}
    </div>
  );
}

function Legend({ onClose }) {
  return (
    <div className="legend">
      <div className="close" onClick={onClose}>
        ✕
      </div>
      Click a pad to toggle play
      <br />
      Drag slider to set level
      <br />
      Space toggles selected, S stop all, F fade all, P panic
    </div>
  );
}

function RelinkModal({ missingCount, onRelink, onClose }) {
  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560, minHeight: 320 }}
      >
        <div className="modalHeader" style={{ borderBottom: "none" }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>
            Relink Audio Files
          </div>
          <button className="btn sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modalBody" style={{ display: "flex", gap: 18 }}>
          <div
            style={{
              fontSize: 64,
              lineHeight: 1,
              color: "#03dac6",
              filter: "drop-shadow(0 0 10px rgba(3,218,198,0.25))",
            }}
            aria-hidden
          >
            🎵
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: "#ddd", fontSize: 16, marginBottom: 8 }}>
              {`We couldn't find ${missingCount} audio file(s).`}
            </div>
            <div style={{ color: "#bbb", lineHeight: 1.7 }}>
              Select the folder that contains your audio files. We'll
              automatically reconnect them by filename. This works best in
              Chrome or Edge.
            </div>
            <div style={{ marginTop: 12, color: "#8fd", fontSize: 12 }}>
              Tip: Keep filenames consistent across machines for seamless
              relinking.
            </div>
          </div>
        </div>
        <div className="modalFooter">
          <button className="btn" onClick={onClose}>
            Not now
          </button>
          <button className="btn blue" onClick={onRelink}>
            Relink Now
          </button>
        </div>
      </div>
    </div>
  );
}

// Utilities and data
function createInitialShow() {
  const opening = {
    id: "scene-01",
    name: "Opening",
    notes: "Operator notes here",
    remember: {
      armed: true,
      savedAt: new Date().toISOString(),
      savedBy: "operator",
      mix: {
        background: { bg1: { levelDb: -6, mute: false } },
        ambients: { amb1: { levelDb: -8, mute: false } },
        sfx: { sfx1: { levelDb: -3, mute: false } },
        buses: { Master: { levelDb: 0 }, Stage: { levelDb: -2 } },
      },
    },
    background: [
      {
        id: "bg1",
        name: "Background 1",
        color: "#0000FF",
        groupId: "grp-bg",
        playbackMode: "loop",
        level: 0.75,
        baseLevel: 0.75,
        playing: false,
      },
      {
        id: "bg2",
        name: "Background 2",
        color: "#0000FF",
        groupId: "grp-bg",
        playbackMode: "loop",
        level: 0.5,
        baseLevel: 0.5,
        playing: false,
      },
    ],
    ambients: [
      {
        id: "amb1",
        name: "Market Crowd",
        color: "#FF6A00",
        groupId: "grp-amb",
        playbackMode: "loop",
        level: 0.6,
        baseLevel: 0.6,
        playing: false,
      },
      {
        id: "amb2",
        name: "Wind",
        color: "#FF6A00",
        groupId: "grp-amb",
        playbackMode: "loop",
        level: 0.4,
        baseLevel: 0.4,
        playing: false,
      },
    ],
    sfx: [
      {
        id: "sfx1",
        name: "Crash",
        color: "#FF0000",
        groupId: "grp-sfx",
        playbackMode: "once",
        level: 0.8,
        baseLevel: 0.8,
        playing: false,
      },
      {
        id: "sfx2",
        name: "Plate Break",
        color: "#00FF00",
        groupId: "grp-sfx",
        playbackMode: "once",
        level: 0.7,
        baseLevel: 0.7,
        playing: false,
      },
      {
        id: "sfx3",
        name: "Door Slam",
        color: "#00FF00",
        groupId: "grp-sfx",
        playbackMode: "once",
        level: 0.65,
        baseLevel: 0.65,
        playing: false,
      },
    ],
  };

  const scene2 = {
    id: "scene-02",
    name: "Act 1, Scene 1",
    notes: "",
    remember: null,
    background: [
      {
        id: "bg1a",
        name: "Alt Bed A",
        color: "#2d6cdf",
        groupId: "grp-bg",
        playbackMode: "loop",
        level: 0.5,
        baseLevel: 0.5,
        playing: false,
      },
    ],
    ambients: [
      {
        id: "amb1a",
        name: "Room Tone",
        color: "#f2b84b",
        groupId: "grp-amb",
        playbackMode: "loop",
        level: 0.5,
        baseLevel: 0.5,
        playing: false,
      },
    ],
    sfx: [
      {
        id: "sfx1a",
        name: "Door Open",
        color: "#4caf50",
        groupId: "grp-sfx",
        playbackMode: "once",
        level: 0.7,
        baseLevel: 0.7,
        playing: false,
      },
    ],
  };

  return {
    title: "Production Name",
    scenes: [opening, scene2],
    groups: [
      { id: "grp-bg", name: "Background Music", color: "#0000FF" },
      { id: "grp-amb", name: "Ambient Noise", color: "#FF6A00" },
      { id: "grp-sfx", name: "Sound Effects", color: "#00FF00" },
    ],
    routing: { buses: ["Master", "Stage", "Booth"], assignments: {} },
    settings: {
      applyRememberOnSceneLoad: true,
      panicConfirm: true,
      confirmOverwriteRemember: true,
      theme: "dark",
    },
  };
}

function allPads(scene) {
  return [...scene.background, ...scene.ambients, ...scene.sfx];
}

function findPad(scene, groupKey, id) {
  const arr = groupArray(scene, groupKey);
  return arr.find((p) => p.id === id);
}

function groupArray(scene, groupKey) {
  return groupKey === "background"
    ? scene.background
    : groupKey === "ambients"
    ? scene.ambients
    : scene.sfx;
}

function buildRememberFromScene(scene) {
  const toDb = (v) => linearToDb(v);
  const mix = {
    background: {},
    ambients: {},
    sfx: {},
    buses: { Master: { levelDb: 0 } },
  };
  scene.background.forEach(
    (p) => (mix.background[p.id] = { levelDb: toDb(p.level), mute: false })
  );
  scene.ambients.forEach(
    (p) => (mix.ambients[p.id] = { levelDb: toDb(p.level), mute: false })
  );
  scene.sfx.forEach(
    (p) => (mix.sfx[p.id] = { levelDb: toDb(p.level), mute: false })
  );
  return mix;
}

function applyRememberToScene(scene, mix) {
  const fromDb = (db) => dbToLinear(db);
  scene.background.forEach((p) => {
    const r = mix.background?.[p.id];
    if (r) p.level = clamp01(fromDb(r.levelDb));
  });
  scene.ambients.forEach((p) => {
    const r = mix.ambients?.[p.id];
    if (r) p.level = clamp01(fromDb(r.levelDb));
  });
  scene.sfx.forEach((p) => {
    const r = mix.sfx?.[p.id];
    if (r) p.level = clamp01(fromDb(r.levelDb));
  });
  return scene;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
function dbToLinear(db) {
  return Math.pow(10, db / 20);
}
function linearToDb(v) {
  return v <= 0 ? -60 : 20 * Math.log10(v);
}
function lighten(hex, amt) {
  const c = hex.replace("#", "");
  let r = parseInt(c.substring(0, 2), 16),
    g = parseInt(c.substring(2, 4), 16),
    b = parseInt(c.substring(4, 6), 16);
  r = Math.min(255, Math.floor(r + 255 * amt));
  g = Math.min(255, Math.floor(g + 255 * amt));
  b = Math.min(255, Math.floor(b + 255 * amt));
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function getReadableTextColor(hex) {
  if (!hex) return "#000";
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  // Perceived luminance
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111" : "#fff";
}

// Helpers to locate pads by id and infer their group
function findPadByAny(scene, padId) {
  const gk1 = "background";
  const gk2 = "ambients";
  const gk3 = "sfx";

  console.log(`Looking for pad ${padId} in scene ${scene.id} (${scene.name})`);

  const p1 = scene.background.find((p) => p.id === padId);
  if (p1) {
    console.log(`Found pad ${padId} in background: ${p1.name || p1.label}`);
    return [gk1, p1];
  }
  const p2 = scene.ambients.find((p) => p.id === padId);
  if (p2) {
    console.log(`Found pad ${padId} in ambients: ${p2.name || p2.label}`);
    return [gk2, p2];
  }
  const p3 = scene.sfx.find((p) => p.id === padId);
  if (p3) {
    console.log(`Found pad ${padId} in sfx: ${p3.name || p3.label}`);
    return [gk3, p3];
  }

  console.log(
    `Pad ${padId} not found in scene ${scene.id}. Available pads:`,
    [...scene.background, ...scene.ambients, ...scene.sfx].map(
      (p) => `${p.id}: ${p.name || p.label}`
    )
  );

  return null;
}

function inferGroupKey(scene, padId) {
  const found = findPadByAny(scene, padId);
  return found ? found[0] : null;
}

export default App;

// --- APC40 LED control helpers (Web MIDI) ---
function apcInitSysexMsg(mode = 0x42) {
  // 0x41 Live, 0x42 Alt Live; both enable host LED control
  const verHigh = 1,
    verLow = 0,
    bugfix = 0;
  return [
    0xf0,
    0x47,
    0x7f,
    0x29,
    0x60,
    0x00,
    0x04,
    mode,
    verHigh,
    verLow,
    bugfix,
    0xf7,
  ];
}

function apcSendClipLed(
  midiOut,
  note /*0..39*/,
  velocity /*palette idx*/,
  channel = 0
) {
  if (!midiOut) return;
  const status = 0x90 | (channel & 0x0f);
  try {
    midiOut.send([status, note & 0x7f, velocity & 0x7f]);
  } catch {}
}

function apcOffClipLed(midiOut, note /*0..39*/, channel = 0) {
  if (!midiOut) return;
  const status = 0x80 | (channel & 0x0f);
  try {
    midiOut.send([status, note & 0x7f, 0]);
  } catch {}
}

// Map current React scene to APC LEDs
function useApcSceneMapper(currentScene, midiOut, apcInitedRef) {
  // not a React hook in file bottom, but used via applySceneToAPC call sites
}

// --- Persistence helpers ---
function serializeShowForSave(show) {
  const safe = structuredClone(show || {});
  // Strip ephemeral object URLs (blob:) so imports are portable across sessions
  (safe.scenes || []).forEach((scene) => {
    ["background", "ambients", "sfx"].forEach((gk) => {
      (scene[gk] || []).forEach((p) => {
        if (typeof p.assetUrl === "string" && p.assetUrl.startsWith("blob:")) {
          delete p.assetUrl;
        }
      });
    });
  });
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    show: safe,
  };
}

function loadSavedShow() {
  try {
    const raw = localStorage.getItem("soundboard.show.v1");
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return migrateLoadedShow(obj);
  } catch {
    return null;
  }
}

function migrateLoadedShow(obj) {
  if (!obj) return createInitialShow();
  // Support both wrapped {version, show} and raw show objects
  const data = obj.show ? obj.show : obj;
  // Basic shape checks
  if (!data || !Array.isArray(data.scenes)) return createInitialShow();
  // Ensure required arrays/fields exist
  (data.scenes || []).forEach((scene) => {
    scene.background = Array.isArray(scene.background) ? scene.background : [];
    scene.ambients = Array.isArray(scene.ambients) ? scene.ambients : [];
    scene.sfx = Array.isArray(scene.sfx) ? scene.sfx : [];
  });
  data.groups = Array.isArray(data.groups) ? data.groups : [];
  data.settings = data.settings || { theme: "dark" };
  return data;
}

function isUrlLike(path) {
  return /^(https?:|blob:|tauri:)/.test(path || "");
}

function countRelinkCandidates(show) {
  let n = 0;
  try {
    (show.scenes || []).forEach((scene) => {
      ["background", "ambients", "sfx"].forEach((gk) => {
        (scene[gk] || []).forEach((p) => {
          const name = fileNameFromPath(p.assetPath || "");
          if (!name) return;
          if (isUrlLike(name) || p.assetUrl) return;
          n++;
        });
      });
    });
  } catch {}
  return n;
}

function fileNameFromPath(pathLike) {
  if (!pathLike) return "";
  const s = String(pathLike);
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return (idx >= 0 ? s.slice(idx + 1) : s).toLowerCase();
}

// Attempt to re-link using a previously saved directory handle from IndexedDB
async function autoRelinkFromStoredHandle(setShow, setStatus, show) {
  try {
    const dir = await loadRootDirectoryHandle();
    if (!dir) return false;
    let perm = "granted";
    try {
      if (typeof dir.queryPermission === "function") {
        perm = await dir.queryPermission({ mode: "read" });
      }
    } catch {}
    if (perm !== "granted") return false;
    setStatus && setStatus("Re-linking from saved folder...");
    const index = await indexDirectoryFiles(dir);
    const needed = new Set();
    (show.scenes || []).forEach((scene) => {
      ["background", "ambients", "sfx"].forEach((gk) => {
        (scene[gk] || []).forEach((p) => {
          const name = fileNameFromPath(p.assetPath || "");
          if (!name || isUrlLike(name) || p.assetUrl) return;
          needed.add(name);
        });
      });
    });
    if (needed.size === 0) return false;
    const nameToUrl = new Map();
    for (const name of needed) {
      const handle = index.get(name);
      if (!handle) continue;
      try {
        const file = await handle.getFile();
        const url = URL.createObjectURL(file);
        nameToUrl.set(name, url);
      } catch {}
    }
    let linked = 0;
    setShow((prev) => {
      const next = structuredClone(prev);
      (next.scenes || []).forEach((scene) => {
        ["background", "ambients", "sfx"].forEach((gk) => {
          (scene[gk] || []).forEach((p) => {
            const key = fileNameFromPath(p.assetPath || "");
            const url = nameToUrl.get(key);
            if (url) {
              p.assetUrl = url;
              linked++;
            }
          });
        });
      });
      return next;
    });
    if (linked > 0) setStatus && setStatus(`Auto-relinked ${linked} file(s)`);
    return linked > 0;
  } catch {
    return false;
  }
}

// IDB helpers to save/load a directory handle
function openIdb() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open("soundboard-db", 1);
      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains("handles")) {
            db.createObjectStore("handles");
          }
        } catch {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

async function saveRootDirectoryHandle(handle) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      const store = tx.objectStore("handles");
      const req = store.put(handle, "rootDir");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    try {
      db.close();
    } catch {}
  } catch {}
}

async function loadRootDirectoryHandle() {
  try {
    const db = await openIdb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readonly");
      const store = tx.objectStore("handles");
      const req = store.get("rootDir");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    try {
      db.close();
    } catch {}
    return handle || null;
  } catch {
    return null;
  }
}

function SettingsModal({
  settings,
  scene,
  onUpdateSettings,
  onUpdatePadRoute,
  onClose,
}) {
  const [log, setLog] = useState([]);
  const [midiAccess, setMidiAccess] = useState(null);
  const [webInId, setWebInId] = useState("");
  const [webOutId, setWebOutId] = useState("");
  const [webSupported, setWebSupported] = useState(false);
  const webInputRef = useRef(null);
  const [testUrl, setTestUrl] = useState("");
  const [testName, setTestName] = useState("");
  const [testMsg, setTestMsg] = useState("");
  const audioRef = useRef(null);
  const [audioOutputs, setAudioOutputs] = useState([]);
  const [showPerPadRouting, setShowPerPadRouting] = useState(false);

  const routing = settings?.audioRouting || {};
  const outputs = Array.isArray(routing.outputs)
    ? routing.outputs
    : [{ key: "master", label: "Master", deviceId: "default" }];
  const groupDefault = routing.groupDefault || {
    background: "master",
    ambients: "master",
    sfx: "master",
  };

  useEffect(() => {
    const supported =
      typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
    setWebSupported(!!supported);
    if (!supported) return;
    navigator
      .requestMIDIAccess({ sysex: false })
      .then((a) => {
        setMidiAccess(a);
        const ins = Array.from(a.inputs.values());
        const outs = Array.from(a.outputs.values());
        setWebInId(ins[0]?.id || "");
        setWebOutId(outs[0]?.id || "");
        a.onstatechange = () => {
          setWebInId((id) => id);
          setWebOutId((id) => id);
        };
      })
      .catch(() => setMidiAccess(null));
    return () => {
      if (webInputRef.current) {
        try {
          webInputRef.current.onmidimessage = null;
        } catch {}
        webInputRef.current = null;
      }
      if (testUrl && testUrl.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(testUrl);
        } catch {}
      }
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        // In some browsers, device labels require prior permission
        try {
          await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {}
        const list = await navigator.mediaDevices.enumerateDevices();
        const outs = list.filter((d) => d.kind === "audiooutput");
        setAudioOutputs(outs);
      } catch {}
    })();
  }, []);

  function connectInWeb() {
    if (!midiAccess) return;
    if (webInputRef.current) {
      try {
        webInputRef.current.onmidimessage = null;
      } catch {}
    }
    for (const input of midiAccess.inputs.values()) {
      if (input.id === webInId) {
        webInputRef.current = input;
        input.onmidimessage = (e) => {
          setLog((l) => [{ data: Array.from(e.data) }, ...l].slice(0, 200));
        };
        break;
      }
    }
  }

  function sendTestWeb() {
    if (!midiAccess) return;
    let out = null;
    for (const o of midiAccess.outputs.values()) {
      if (o.id === webOutId) {
        out = o;
        break;
      }
    }
    if (!out) return;
    const noteOn = [0x90, 60, 64];
    const noteOff = [0x80, 60, 0];
    try {
      out.send(noteOn);
      setTimeout(() => out.send(noteOff), 200);
    } catch {}
  }

  function onPickTestFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const url = URL.createObjectURL(f);
      setTestUrl(url);
      setTestName(f.name);
      setTestMsg("");
      setTimeout(() => audioRef.current?.load(), 0);
    } catch {
      setTestMsg("Could not create object URL for file");
    }
  }

  function onAudioError() {
    setTestMsg("HTML5 <audio> failed to load/play this file");
  }

  function onAudioCanPlay() {
    setTestMsg("Ready to play");
  }

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <div style={{ fontWeight: 600 }}>Settings</div>
          <button className="btn sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modalBody">
          <div style={{ marginBottom: 6, color: "#bbb" }}>Audio</div>
          <div className="rowFlex">
            <div className="field" style={{ flex: 2 }}>
              <label>Master Sound Output</label>
              <select
                value={outputs[0]?.deviceId || "default"}
                onChange={(e) => {
                  const deviceId = e.target.value;
                  onUpdateSettings((prev) => {
                    const next = structuredClone(prev || {});
                    const list = Array.isArray(next.audioRouting?.outputs)
                      ? next.audioRouting.outputs
                      : [
                          {
                            key: "master",
                            label: "Master",
                            deviceId: "default",
                          },
                        ];
                    list[0] = {
                      ...(list[0] || { key: "master", label: "Master" }),
                      deviceId,
                    };
                    next.audioRouting = {
                      ...(next.audioRouting || {}),
                      outputs: list,
                      groupDefault:
                        next.audioRouting?.groupDefault || groupDefault,
                    };
                    return next;
                  });
                }}
              >
                <option value="default">System Default</option>
                {audioOutputs.map((d) => (
                  <option
                    key={d.deviceId || d.label}
                    value={d.deviceId || "default"}
                  >
                    {d.label || `Device ${d.deviceId || ""}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Sample Rate</label>
              <select
                value={String(settings?.sampleRate || 48000)}
                onChange={(e) =>
                  onUpdateSettings({ sampleRate: Number(e.target.value) })
                }
              >
                <option value="44100">44.1 kHz</option>
                <option value="48000">48 kHz</option>
              </select>
            </div>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <button
              className="btn sm"
              onClick={() => {
                onUpdateSettings((prev) => {
                  const next = structuredClone(prev || {});
                  const list = Array.isArray(next.audioRouting?.outputs)
                    ? next.audioRouting.outputs
                    : [
                        {
                          key: "master",
                          label: "Master",
                          deviceId: outputs[0]?.deviceId || "default",
                        },
                      ];
                  const idx = list.length + 1;
                  const key = idx === 1 ? "master" : `out${idx}`;
                  const label = idx === 1 ? "Master" : `Output ${idx}`;
                  list.push({ key, label, deviceId: "default" });
                  next.audioRouting = {
                    ...(next.audioRouting || {}),
                    outputs: list,
                    groupDefault:
                      next.audioRouting?.groupDefault || groupDefault,
                  };
                  return next;
                });
              }}
            >
              + Add New Output
            </button>
          </div>
          {outputs.slice(1).length > 0 && (
            <div className="field" style={{ marginTop: 8 }}>
              <label>Additional Outputs</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {outputs.slice(1).map((o, i) => (
                  <div key={o.key} className="rowFlex">
                    <input
                      style={{ flex: 1 }}
                      value={o.label || `Output ${i + 2}`}
                      onChange={(e) => {
                        onUpdateSettings((prev) => {
                          const next = structuredClone(prev || {});
                          const list = Array.isArray(next.audioRouting?.outputs)
                            ? next.audioRouting.outputs
                            : outputs;
                          const idx = 1 + i;
                          list[idx] = { ...list[idx], label: e.target.value };
                          next.audioRouting = {
                            ...(next.audioRouting || {}),
                            outputs: list,
                            groupDefault,
                          };
                          return next;
                        });
                      }}
                    />
                    <select
                      style={{ flex: 2 }}
                      value={o.deviceId || "default"}
                      onChange={(e) => {
                        const deviceId = e.target.value;
                        onUpdateSettings((prev) => {
                          const next = structuredClone(prev || {});
                          const list = Array.isArray(next.audioRouting?.outputs)
                            ? next.audioRouting.outputs
                            : outputs;
                          const idx = 1 + i;
                          list[idx] = { ...list[idx], deviceId };
                          next.audioRouting = {
                            ...(next.audioRouting || {}),
                            outputs: list,
                            groupDefault,
                          };
                          return next;
                        });
                      }}
                    >
                      <option value="default">System Default</option>
                      {audioOutputs.map((d) => (
                        <option
                          key={d.deviceId || d.label}
                          value={d.deviceId || "default"}
                        >
                          {d.label || `Device ${d.deviceId || ""}`}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ margin: "16px 0", color: "#bbb" }}>Default Routing</div>
          <div className="rowFlex">
            <div className="field">
              <label>Background</label>
              <select
                value={groupDefault.background || "master"}
                onChange={(e) =>
                  onUpdateSettings((prev) => {
                    const next = structuredClone(prev || {});
                    const gd = {
                      ...(next.audioRouting?.groupDefault || groupDefault),
                      background: e.target.value,
                    };
                    next.audioRouting = {
                      ...(next.audioRouting || {}),
                      outputs,
                      groupDefault: gd,
                    };
                    return next;
                  })
                }
              >
                {outputs.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Ambient</label>
              <select
                value={groupDefault.ambients || "master"}
                onChange={(e) =>
                  onUpdateSettings((prev) => {
                    const next = structuredClone(prev || {});
                    const gd = {
                      ...(next.audioRouting?.groupDefault || groupDefault),
                      ambients: e.target.value,
                    };
                    next.audioRouting = {
                      ...(next.audioRouting || {}),
                      outputs,
                      groupDefault: gd,
                    };
                    return next;
                  })
                }
              >
                {outputs.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>SFX</label>
              <select
                value={groupDefault.sfx || "master"}
                onChange={(e) =>
                  onUpdateSettings((prev) => {
                    const next = structuredClone(prev || {});
                    const gd = {
                      ...(next.audioRouting?.groupDefault || groupDefault),
                      sfx: e.target.value,
                    };
                    next.audioRouting = {
                      ...(next.audioRouting || {}),
                      outputs,
                      groupDefault: gd,
                    };
                    return next;
                  })
                }
              >
                {outputs.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div
            className="accordionHeader"
            onClick={() => setShowPerPadRouting((v) => !v)}
            style={{ margin: "16px 0" }}
          >
            <div style={{ color: "#bbb", fontWeight: 600 }}>
              Per-Pad Routing (Current Scene)
            </div>
            <div className={"chev" + (showPerPadRouting ? " open" : "")}>▸</div>
          </div>
          {showPerPadRouting && (
            <div className="rowFlex">
              <div className="field" style={{ flex: 1 }}>
                <label>Background</label>
                {(scene?.background || []).map((p) => (
                  <div
                    key={p.id}
                    className="rowFlex"
                    style={{ gap: 6, marginBottom: 6 }}
                  >
                    <div style={{ width: 140, color: "#ddd" }}>
                      {p.label || p.name}
                    </div>
                    <select
                      style={{ flex: 1 }}
                      value={p.routeKey || "master"}
                      onChange={(e) =>
                        onUpdatePadRoute?.("background", p.id, e.target.value)
                      }
                    >
                      {outputs.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Ambient</label>
                {(scene?.ambients || []).map((p) => (
                  <div
                    key={p.id}
                    className="rowFlex"
                    style={{ gap: 6, marginBottom: 6 }}
                  >
                    <div style={{ width: 140, color: "#ddd" }}>
                      {p.label || p.name}
                    </div>
                    <select
                      style={{ flex: 1 }}
                      value={p.routeKey || "master"}
                      onChange={(e) =>
                        onUpdatePadRoute?.("ambients", p.id, e.target.value)
                      }
                    >
                      {outputs.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>SFX</label>
                {(scene?.sfx || []).map((p) => (
                  <div
                    key={p.id}
                    className="rowFlex"
                    style={{ gap: 6, marginBottom: 6 }}
                  >
                    <div style={{ width: 140, color: "#ddd" }}>
                      {p.label || p.name}
                    </div>
                    <select
                      style={{ flex: 1 }}
                      value={p.routeKey || "master"}
                      onChange={(e) =>
                        onUpdatePadRoute?.("sfx", p.id, e.target.value)
                      }
                    >
                      {outputs.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Audio Test Player removed per UI cleanup */}
          <div style={{ margin: "16px 0", color: "#bbb" }}>MIDI (Web MIDI)</div>
          <div className="rowFlex">
            <div className="field">
              <label>Web MIDI Input</label>
              <select
                value={webInId}
                onChange={(e) => setWebInId(e.target.value)}
              >
                {midiAccess ? (
                  Array.from(midiAccess.inputs.values()).map((d) => (
                    <option key={d.id} value={d.id}>{`${
                      d.manufacturer ? d.manufacturer + " " : ""
                    }${d.name}`}</option>
                  ))
                ) : (
                  <option value="">
                    {webSupported ? "No inputs" : "Not supported"}
                  </option>
                )}
              </select>
              <button
                className="btn sm"
                style={{ marginTop: 6 }}
                onClick={connectInWeb}
                disabled={!midiAccess}
              >
                Connect
              </button>
            </div>
            <div className="field">
              <label>Web MIDI Output</label>
              <select
                value={webOutId}
                onChange={(e) => setWebOutId(e.target.value)}
              >
                {midiAccess ? (
                  Array.from(midiAccess.outputs.values()).map((d) => (
                    <option key={d.id} value={d.id}>{`${
                      d.manufacturer ? d.manufacturer + " " : ""
                    }${d.name}`}</option>
                  ))
                ) : (
                  <option value="">
                    {webSupported ? "No outputs" : "Not supported"}
                  </option>
                )}
              </select>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button
                  className="btn sm"
                  onClick={sendTestWeb}
                  disabled={!midiAccess}
                >
                  Send Test Note
                </button>
              </div>
            </div>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label>Incoming MIDI</label>
            <div
              style={{
                height: 140,
                overflow: "auto",
                background: "#0f0f0f",
                border: "1px solid #333",
                borderRadius: 6,
                padding: 8,
              }}
            >
              {log.map((m, idx) => (
                <div
                  key={idx}
                  style={{ fontFamily: "monospace", fontSize: 12 }}
                >
                  {Array.isArray(m.data) ? m.data.join(" ") : JSON.stringify(m)}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="modalFooter">
          <button className="btn">Test Tone</button>
          <button className="btn blue" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function ApcMapperModal({ onClose }) {
  const [midiAccess, setMidiAccess] = useState(null);
  const [inId, setInId] = useState("");
  const [log, setLog] = useState([]);
  const [mapJson, setMapJson] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    const supported =
      typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
    if (!supported) return;
    navigator
      .requestMIDIAccess({ sysex: false })
      .then((a) => {
        setMidiAccess(a);
        const ins = Array.from(a.inputs.values());
        setInId(ins[0]?.id || "");
      })
      .catch(() => setMidiAccess(null));
    return () => {
      if (inputRef.current) {
        try {
          inputRef.current.onmidimessage = null;
        } catch {}
        inputRef.current = null;
      }
    };
  }, []);

  function connect() {
    if (!midiAccess) return;
    if (inputRef.current) {
      try {
        inputRef.current.onmidimessage = null;
      } catch {}
    }
    for (const input of midiAccess.inputs.values()) {
      if (input.id === inId) {
        inputRef.current = input;
        input.onmidimessage = (e) => {
          const [s, d1, d2] = e.data;
          const type = s & 0xf0;
          const ch = (s & 0x0f) + 1;
          const entry = {
            raw: Array.from(e.data),
            type,
            note: d1,
            vel: d2,
            ch,
            ts: new Date().toLocaleTimeString(),
          };
          setLog((l) => [entry, ...l].slice(0, 200));
        };
        break;
      }
    }
  }

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <div style={{ fontWeight: 600 }}>APC40 mkII Mapper</div>
          <button className="btn sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modalBody">
          <div className="rowFlex">
            <div className="field">
              <label>Input</label>
              <select value={inId} onChange={(e) => setInId(e.target.value)}>
                {midiAccess ? (
                  Array.from(midiAccess.inputs.values()).map((d) => (
                    <option key={d.id} value={d.id}>{`
                      ${d.manufacturer ? d.manufacturer + " " : ""}${d.name}
                    `}</option>
                  ))
                ) : (
                  <option value="">No inputs</option>
                )}
              </select>
              <button
                className="btn sm"
                style={{ marginTop: 6 }}
                onClick={connect}
              >
                Connect
              </button>
            </div>
            <div className="field" style={{ flex: 2 }}>
              <label>Instructions</label>
              <div style={{ color: "#bbb" }}>
                Use this panel to monitor captured input from your MIDI
                controller. Interact with your device (pads/keys/knobs/faders)
                and observe the incoming NOTE/CC/channel data in the log below.
              </div>
            </div>
          </div>
          <div className="field">
            <label>Captured Messages</label>
            <div
              style={{
                height: 220,
                overflow: "auto",
                background: "#0f0f0f",
                border: "1px solid #333",
                borderRadius: 6,
                padding: 8,
                fontFamily: "monospace",
                fontSize: 12,
              }}
            >
              {log.map((m, i) => (
                <div key={i}>
                  {`${m.ts}  type:0x${m.type.toString(16)}  note:${
                    m.note
                  }  vel:${m.vel}  ch:${m.ch}  raw:[${m.raw.join(", ")}]`}
                </div>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Custom Input Note → Pad Map (JSON)</label>
            <textarea
              placeholder='{"39":33, "38":34, ...} (note -> padNumber 1..40)'
              value={mapJson}
              onChange={(e) => setMapJson(e.target.value)}
              rows={4}
            />
          </div>
        </div>
        <div className="modalFooter">
          <button
            className="btn"
            onClick={() => {
              try {
                const text = log
                  .filter((x) => x.type === 0x90 && x.vel > 0)
                  .map((x) => `${x.note}`)
                  .join(", ");
                navigator.clipboard?.writeText(text);
              } catch {}
            }}
          >
            Copy NOTE list
          </button>
          <button
            className="btn"
            onClick={() => {
              try {
                const obj = JSON.parse(mapJson || "{}");
                localStorage.setItem("apcInNoteMap", JSON.stringify(obj));
                onClose();
                try {
                  alert("Saved APC input note map");
                } catch {}
              } catch {
                try {
                  alert("Invalid JSON mapping");
                } catch {}
              }
            }}
          >
            Save Mapping
          </button>
          <button className="btn blue" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function SoundEditorDrawer({
  editor,
  scene,
  settings,
  groups,
  scenes,
  onClose,
  onSave,
}) {
  const pad = editor.padId
    ? findPad(scene, editor.groupKey, editor.padId)
    : null;
  const [state, setState] = useState(
    pad || {
      id: `snd-${Math.random().toString(36).slice(2, 8)}`,
      name: "New Sound",
      color:
        editor.groupKey === "background"
          ? "#0000FF" // Blue (APC)
          : editor.groupKey === "ambients"
          ? "#FF6A00" // Orange (APC)
          : "#00FF00", // Green (APC)
      groupId:
        editor.groupKey === "background"
          ? scene?.groups?.find?.((g) => g.id === "grp-bg")?.id || "grp-bg"
          : editor.groupKey === "ambients"
          ? scene?.groups?.find?.((g) => g.id === "grp-amb")?.id || "grp-amb"
          : scene?.groups?.find?.((g) => g.id === "grp-sfx")?.id || "grp-sfx",
      playbackMode: "once",
      level: 0.8,
      fadeInMs: 0,
      fadeOutMs: 500,
    }
  );
  useEffect(() => {
    const gs = groups || [];
    if (gs.length === 0) return;
    setState((s) => {
      const exists = s.groupId && gs.some((g) => g.id === s.groupId);
      if (exists) return s;
      return { ...s, groupId: s.groupId || gs[0].id };
    });
  }, [groups]);
  const [laneKey, setLaneKey] = useState(editor.groupKey);
  const baseGroupIdSet = useMemo(
    () => new Set(["grp-bg", "grp-amb", "grp-sfx"]),
    []
  );
  const [selectionValue, setSelectionValue] = useState(
    pad?.groupId && !baseGroupIdSet.has(pad.groupId)
      ? pad.groupId
      : editor.groupKey
  );
  const [triggers, setTriggers] = useState(() => {
    if (Array.isArray(pad?.triggers)) {
      return pad.triggers;
    }
    if (pad?.triggers && typeof pad.triggers === "object") {
      const legacy = pad.triggers;
      const coerce = (phase, t) => ({
        id: `trg-${Math.random().toString(36).slice(2, 8)}`,
        phase,
        action: t?.action || "none",
        sceneId: t?.sceneId || scene.id,
        padId: t?.padId || pad?.id || "",
        timeMs: typeof t?.timeMs === "number" ? t.timeMs : 200,
      });
      const arr = [];
      if (legacy.onStart) arr.push(coerce("onStart", legacy.onStart));
      if (legacy.onStop) arr.push(coerce("onStop", legacy.onStop));
      return arr;
    }
    return [];
  });

  const ensureTrigger = (overrides = {}) => ({
    id: `trg-${Math.random().toString(36).slice(2, 8)}`,
    phase: "onStart", // or "onStop"
    action: "none", // none | play | stop | fade | fadeIn | fadeOut
    sceneId: scene.id,
    padId: pad?.id || "",
    timeMs: 200,
    ...overrides,
  });

  return (
    <>
      <div className="drawerBackdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawerHeader">
          <div style={{ fontWeight: 600 }}>Sound Editor</div>
          <button className="btn sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="drawerBody">
          <div className="field">
            <label>Label</label>
            <input
              value={state.name || state.label}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  name: e.target.value,
                  label: e.target.value,
                }))
              }
            />
          </div>
          <div className="rowFlex">
            <div className="field">
              <label>Group</label>
              <select
                value={selectionValue}
                onChange={(e) => {
                  const val = e.target.value;
                  if (
                    val === "background" ||
                    val === "ambients" ||
                    val === "sfx"
                  ) {
                    setLaneKey(val);
                    setSelectionValue(val);
                  } else {
                    setSelectionValue(val);
                    setState((s) => ({ ...s, groupId: val }));
                  }
                }}
              >
                <option value="background">Background Music</option>
                <option value="ambients">Ambient Noise</option>
                <option value="sfx">Sound Effects</option>
                {(groups || [])
                  .filter(
                    (g) => !["grp-bg", "grp-amb", "grp-sfx"].includes(g.id)
                  )
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <div className="rowFlex">
            <div className="field">
              <label>Playback Mode</label>
              <select
                value={state.playbackMode}
                onChange={(e) =>
                  setState((s) => ({ ...s, playbackMode: e.target.value }))
                }
              >
                <option value="once">Play once</option>
                <option value="loop">Loop until stopped</option>
              </select>
            </div>
            <div className="field">
              <label>Pad Color</label>
              <div className="rowFlex">
                <select
                  value={state.color ? "custom" : "group"}
                  onChange={(e) => {
                    const useGroup = e.target.value === "group";
                    setState((s) => ({
                      ...s,
                      color: useGroup ? undefined : s.color || "#0000FF",
                    }));
                  }}
                >
                  <option value="group">Use group color</option>
                  <option value="custom">APC color override</option>
                </select>
                <select
                  disabled={!state.color}
                  value={state.color || "#0000FF"}
                  onChange={(e) =>
                    setState((s) => ({ ...s, color: e.target.value }))
                  }
                  style={{
                    background: state.color || "#0000FF",
                    color: getReadableTextColor(state.color || "#0000FF"),
                  }}
                >
                  {APC_COLOR_TABLE.map((c) => (
                    <option
                      key={c.vel}
                      value={c.hex}
                      style={{
                        background: c.hex,
                        color: getReadableTextColor(c.hex),
                      }}
                    >
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="field">
            <label>Audio File</label>
            <div className="rowFlex">
              <input
                placeholder="Choose audio file"
                value={state.assetPath || ""}
                onChange={(e) =>
                  setState((s) => ({ ...s, assetPath: e.target.value }))
                }
              />
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const url = URL.createObjectURL(f);
                  setState((s) => ({ ...s, assetPath: f.name, assetUrl: url }));
                }}
              />
            </div>
          </div>
          <div className="rowFlex">
            <div className="field">
              <label>Fade In (ms)</label>
              <input
                type="number"
                placeholder="0"
                value={state.fadeInMs || 0}
                onChange={(e) =>
                  setState((s) => ({ ...s, fadeInMs: Number(e.target.value) }))
                }
              />
            </div>
            <div className="field">
              <label>Fade Out (ms)</label>
              <input
                type="number"
                placeholder="0"
                value={state.fadeOutMs || 0}
                onChange={(e) =>
                  setState((s) => ({ ...s, fadeOutMs: Number(e.target.value) }))
                }
              />
            </div>
          </div>
          <div style={{ margin: "8px 0", color: "#bbb" }}>Triggers</div>
          <div className="field">
            {triggers.length === 0 && (
              <div style={{ color: "#888", marginBottom: 8 }}>No triggers</div>
            )}
            {triggers.map((tr) => (
              <div key={tr.id} className="triggerRow">
                <div className="rowFlex">
                  <div className="field">
                    <label>Phase</label>
                    <select
                      value={tr.phase}
                      onChange={(e) =>
                        setTriggers((arr) =>
                          arr.map((x) =>
                            x.id === tr.id ? { ...x, phase: e.target.value } : x
                          )
                        )
                      }
                    >
                      <option value="onStart">On Start</option>
                      <option value="onStop">On Stop</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Action</label>
                    <select
                      value={tr.action}
                      onChange={(e) =>
                        setTriggers((arr) =>
                          arr.map((x) =>
                            x.id === tr.id
                              ? { ...x, action: e.target.value }
                              : x
                          )
                        )
                      }
                    >
                      <option value="none">None</option>
                      <option value="play">Play</option>
                      <option value="stop">Stop</option>
                      {/* Legacy 'fade' removed from UI per request */}
                      <option value="fadeIn">Fade In</option>
                      <option value="fadeOut">Fade Out</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Scene</label>
                    <select
                      value={tr.sceneId || scene.id}
                      onChange={(e) =>
                        setTriggers((arr) =>
                          arr.map((x) =>
                            x.id === tr.id
                              ? { ...x, sceneId: e.target.value }
                              : x
                          )
                        )
                      }
                    >
                      {(scenes || []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Pad</label>
                    <select
                      value={tr.padId || ""}
                      onChange={(e) =>
                        setTriggers((arr) =>
                          arr.map((x) =>
                            x.id === tr.id ? { ...x, padId: e.target.value } : x
                          )
                        )
                      }
                    >
                      {(() => {
                        const targetSceneId = tr.sceneId || scene.id;
                        const s =
                          (scenes || []).find((s) => s.id === targetSceneId) ||
                          scene;
                        console.log(
                          `Trigger config: Looking for pads in scene ${targetSceneId}, found scene: ${s.id} (${s.name})`
                        );
                        const pads = [
                          ...(s.background || []),
                          ...(s.ambients || []),
                          ...(s.sfx || []),
                        ];
                        console.log(
                          `Trigger config: Found ${pads.length} pads in scene ${s.id}`
                        );
                        return [
                          <option key="" value="">
                            Select pad
                          </option>,
                          ...pads.map((p) => {
                            console.log(
                              `Trigger config pad: ${p.id} - ${
                                p.name || p.label
                              }`
                            );
                            return (
                              <option key={p.id} value={p.id}>
                                {p.name || p.label || p.id}
                              </option>
                            );
                          }),
                        ];
                      })()}
                    </select>
                  </div>
                  {(tr.action === "fade" ||
                    tr.action === "fadeIn" ||
                    tr.action === "fadeOut") && (
                    <div className="field">
                      <label>Time (ms)</label>
                      <input
                        type="number"
                        value={typeof tr.timeMs === "number" ? tr.timeMs : 200}
                        onChange={(e) =>
                          setTriggers((arr) =>
                            arr.map((x) =>
                              x.id === tr.id
                                ? { ...x, timeMs: Number(e.target.value) }
                                : x
                            )
                          )
                        }
                      />
                    </div>
                  )}
                  <div className="field" style={{ alignSelf: "flex-end" }}>
                    <button
                      className="btn sm red"
                      onClick={() =>
                        setTriggers((arr) => arr.filter((x) => x.id !== tr.id))
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
            <div>
              <button
                className="btn sm"
                onClick={() => setTriggers((arr) => [...arr, ensureTrigger()])}
              >
                + Add Trigger
              </button>
            </div>
          </div>
        </div>
        <div className="drawerFooter">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn blue"
            onClick={() =>
              onSave({
                ...state,
                triggers,
                id: state.id,
                groupKey: laneKey,
              })
            }
          >
            Save
          </button>
        </div>
      </div>
    </>
  );
}

function createEmptyScene(name) {
  return {
    id: `scene-${Math.random().toString(36).slice(2, 8)}`,
    name,
    notes: "",
    remember: null,
    background: [],
    ambients: [],
    sfx: [],
  };
}
