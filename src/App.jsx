import { useEffect, useMemo, useRef, useState } from "react";
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
  { name: "Purple", vel: 49, hex: "#5A00FF" },
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
  const [show, setShow] = useState(
    () => loadSavedShow() || createInitialShow()
  );
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
                }
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
    setShow((prev) => ({
      ...prev,
      scenes: prev.scenes.map((s) =>
        s.id === currentScene.id ? mutator(structuredClone(s)) : s
      ),
    }));
  }

  function togglePadPlayByKey(key) {
    const [group, id] = key.split(":");
    updateScene((scene) => {
      const pad = findPad(scene, group, id);
      if (!pad) return scene;
      if (!pad.assetUrl && !pad.assetPath) {
        setStatus("No audio attached to this pad");
        return scene;
      }
      const next = !pad.playing;
      pad.playing = next;
      handlePadAudio(scene, group, pad, next);
      setStatus(`${pad.label || pad.name} ${next ? "started" : "stopped"}`);
      return scene;
    });
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
    const idx = show.scenes.findIndex((s) => s.id === currentSceneId);
    const next = show.scenes[(idx + 1) % show.scenes.length];
    setCurrentSceneId(next.id);
  }
  function prevScene() {
    const idx = show.scenes.findIndex((s) => s.id === currentSceneId);
    const prev =
      show.scenes[(idx - 1 + show.scenes.length) % show.scenes.length];
    setCurrentSceneId(prev.id);
  }

  // --- APC mapping & LED helpers (component-scoped, use midiOut) ---
  function initApcIfNeeded() {
    if (!midiOut || apcInitedRef.current) return;
    try {
      midiOut.send(apcInitSysexMsg());
      apcInitedRef.current = true;
      setStatus((s) => `${s} — APC inited`);
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
    } catch {}
  }

  // Convert CC value (0..127) to linear volume 0..1
  function ccToVolume(cc) {
    return Math.max(0, Math.min(1, cc / 127));
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
  function ensureAudioContext() {
    if (!audioCtxRef.current) {
      // eslint-disable-next-line no-undef
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtxRef.current = new AC();
    }
    try {
      if (audioCtxRef.current.state === "suspended") {
        // Resume on user gesture (play button click)
        audioCtxRef.current.resume();
      }
    } catch {}
    return audioCtxRef.current;
  }

  function padKey(sceneId, groupKey, padId) {
    return `${sceneId}:${groupKey}:${padId}`;
  }

  function handlePadAudio(scene, groupKey, pad, shouldPlay) {
    if (!pad.assetUrl && !pad.assetPath) return;
    if (shouldPlay) {
      playPad(scene.id, groupKey, pad);
      runPadTriggers(scene, pad, "onStart");
    } else {
      stopPad(scene.id, groupKey, pad.id);
      runPadTriggers(scene, pad, "onStop");
    }
  }

  function playPad(sceneId, groupKey, pad) {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    const key = padKey(sceneId, groupKey, pad.id);
    stopPad(sceneId, groupKey, pad.id);
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
    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    gain.gain.value = clamp01(pad.level ?? 0.8);
    source.connect(gain).connect(ctx.destination);
    padAudioRef.current.set(key, { el, gain });
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
  }

  function stopPad(sceneId, groupKey, padId) {
    const key = padKey(sceneId, groupKey, padId);
    const ref = padAudioRef.current.get(key);
    if (!ref) return;
    try {
      ref.el.pause();
      ref.el.currentTime = 0;
    } catch {}
    try {
      ref.gain.disconnect();
    } catch {}
    padAudioRef.current.delete(key);
  }

  function applyPadVolume(sceneId, groupKey, padId, level) {
    const key = padKey(sceneId, groupKey, padId);
    const ref = padAudioRef.current.get(key);
    if (!ref) return;
    ref.gain.gain.value = clamp01(level);
  }

  function runPadTriggers(scene, pad, phase) {
    const t = pad.triggers?.[phase];
    if (!t || t.action === "none") return;
    const parts = (t.target || "").split(":");
    const targetScene = scene;
    const doFade = (p, ms, db) => {
      const id = p.id;
      const groupKey = p.groupKey || inferGroupKey(targetScene, id);
      if (!groupKey) return;
      const from = p.level ?? 0.8;
      const to = clamp01(dbToLinear(linearToDb(from) + (db || -12)));
      const steps = Math.max(1, Math.floor((ms || 200) / 16));
      let i = 0;
      const tick = () => {
        const v = from + (to - from) * (i / steps);
        setPadLevel(groupKey, id, v);
        i++;
        if (i <= steps) requestAnimationFrame(tick);
      };
      tick();
    };
    if (t.targetType === "pad" && parts.length >= 1) {
      const pid = parts[0] || pad.id;
      const [gk, p] = findPadByAny(targetScene, pid) || [];
      if (!p || !gk) return;
      if (t.action === "play") togglePadPlay(gk, p.id);
      else if (t.action === "stop") {
        if (p.playing) togglePadPlay(gk, p.id);
      } else if (t.action === "fade") {
        doFade(p, t.timeMs, t.amountDb);
      }
    }
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
            onPadToggle={(id) => togglePadPlay("background", id)}
            onSetPlaying={(id, playing) =>
              setPadPlaying("background", id, playing)
            }
            onLevelChange={(id, v) => setPadLevel("background", id, v)}
            onEdit={(id) => openEditor("background", id)}
            onDelete={(id) => deletePad("background", id)}
            selectedPadKey={selectedPadKey}
            setSelectedPadKey={setSelectedPadKey}
          />

          <GroupSection
            title="Ambient Noise"
            color={groupColors["grp-amb"] || "#FF6A00"}
            pads={currentScene.ambients}
            groupKey="ambients"
            mode={mode}
            active={activeGroupKey === "ambients"}
            onPadToggle={(id) => togglePadPlay("ambients", id)}
            onSetPlaying={(id, playing) =>
              setPadPlaying("ambients", id, playing)
            }
            onLevelChange={(id, v) => setPadLevel("ambients", id, v)}
            onEdit={(id) => openEditor("ambients", id)}
            onDelete={(id) => deletePad("ambients", id)}
            selectedPadKey={selectedPadKey}
            setSelectedPadKey={setSelectedPadKey}
          />

          <GroupSection
            title="Sound Effects"
            color={groupColors["grp-sfx"] || "#00FF00"}
            pads={currentScene.sfx}
            groupKey="sfx"
            mode={mode}
            active={activeGroupKey === "sfx"}
            onPadToggle={(id) => togglePadPlay("sfx", id)}
            onSetPlaying={(id, playing) => setPadPlaying("sfx", id, playing)}
            onLevelChange={(id, v) => setPadLevel("sfx", id, v)}
            onEdit={(id) => openEditor("sfx", id)}
            onDelete={(id) => deletePad("sfx", id)}
            selectedPadKey={selectedPadKey}
            setSelectedPadKey={setSelectedPadKey}
          />

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
            Soundboard — {mode.toUpperCase()} — Scene: {currentScene.name}
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
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
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
          onClose={() =>
            setEditor({ open: false, groupKey: null, padId: null })
          }
          onSave={saveEditor}
        />
      )}
    </div>
  );

  // Actions on pads
  function togglePadPlay(groupKey, id) {
    updateScene((scene) => {
      const pad = findPad(scene, groupKey, id);
      if (!pad) return scene;
      if (!pad.assetUrl && !pad.assetPath) {
        setStatus("No audio attached to this pad");
        return scene;
      }
      pad.playing = !pad.playing;
      setStatus(
        `${pad.label || pad.name} ${pad.playing ? "started" : "stopped"}`
      );
      return scene;
    });
  }

  function setPadLevel(groupKey, id, value) {
    updateScene((scene) => {
      const pad = findPad(scene, groupKey, id);
      if (!pad) return scene;
      pad.level = value;
      applyPadVolume(currentScene.id, groupKey, id, value);
      setStatus(`${pad.label || pad.name} level ${(value * 100) | 0}%`);
      return scene;
    });
  }

  function setPadPlaying(groupKey, id, playing) {
    updateScene((scene) => {
      const pad = findPad(scene, groupKey, id);
      if (!pad) return scene;
      pad.playing = !!playing;
      return scene;
    });
  }

  function openEditor(groupKey, id) {
    setEditor({ open: true, groupKey, padId: id });
  }

  function saveEditor(payload) {
    updateScene((scene) => {
      const arr = groupArray(scene, payload.groupKey);
      const idx = arr.findIndex((p) => p.id === payload.id);
      if (idx >= 0) {
        arr[idx] = { ...arr[idx], ...payload };
      } else {
        arr.push({ ...payload, playing: false, level: payload.level ?? 0.8 });
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
  onLevelChange,
  onEdit,
  onDelete,
  selectedPadKey,
  setSelectedPadKey,
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
                color: "#ff4d4d",
                fontWeight: 600,
                fontSize: 12,
                border: "1px solid #ff4d4d",
                borderRadius: 4,
                padding: "1px 6px",
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
            onToggle={() => onPadToggle(p.id)}
            onSetPlaying={(playing) => onSetPlaying?.(p.id, playing)}
            onLevelChange={(v) => onLevelChange(p.id, v)}
            selected={selectedPadKey === `${groupKey}:${p.id}`}
            onSelect={() => setSelectedPadKey(`${groupKey}:${p.id}`)}
            onEdit={() => onEdit?.(p.id)}
            onDelete={() => onDelete?.(p.id)}
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
  onToggle,
  onSetPlaying,
  onLevelChange,
  selected,
  onSelect,
  onEdit,
  onDelete,
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
    });
    wsRef.current.load(pad.assetUrl || pad.assetPath);
    const onPlay = () => onSetPlaying?.(true);
    const onPause = () => onSetPlaying?.(false);
    const onFinish = () => {
      if (pad.playbackMode === "loop") {
        try {
          wsRef.current?.play(0);
        } catch {}
      } else {
        onPause();
      }
    };
    wsRef.current.on("play", onPlay);
    wsRef.current.on("pause", onPause);
    wsRef.current.on("finish", onFinish);
    return () => {
      try {
        wsRef.current?.un("play", onPlay);
        wsRef.current?.un("pause", onPause);
        wsRef.current?.un("finish", onFinish);
        wsRef.current?.destroy();
      } catch {}
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pad.assetUrl, pad.assetPath, pad.playbackMode]);

  // Sync external playing state (e.g., MIDI toggle) to WaveSurfer instance
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    try {
      const isPlaying = typeof ws.isPlaying === "function" && ws.isPlaying();
      if (pad.playing && !isPlaying) {
        const target = pad.level || 0;
        const fadeMs = typeof pad.fadeInMs === "number" ? pad.fadeInMs : 0;
        if (fadeMs > 0) {
          ws.setVolume?.(0);
          ws.play?.(0);
          const t0 = performance.now();
          const step = (t) => {
            const p = Math.min(1, (t - t0) / fadeMs);
            const v = target * p;
            try {
              ws.setVolume?.(v);
            } catch {}
            if (p < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        } else {
          ws.setVolume?.(target);
          ws.play?.(0);
        }
      } else if (!pad.playing && isPlaying) {
        const startVol =
          (typeof ws.getVolume === "function"
            ? ws.getVolume()
            : pad.level || 0) || 0;
        const durationMs =
          typeof pad.fadeOutMs === "number" ? pad.fadeOutMs : 500;
        if (durationMs > 0) {
          const t0 = performance.now();
          const step = (t) => {
            const p = Math.min(1, (t - t0) / durationMs);
            const v = Math.max(0, startVol * (1 - p));
            try {
              ws.setVolume?.(v);
            } catch {}
            if (p < 1) requestAnimationFrame(step);
            else {
              try {
                ws.pause?.();
                ws.setVolume?.(startVol);
              } catch {}
            }
          };
          requestAnimationFrame(step);
        } else {
          ws.pause?.();
        }
      }
    } catch {}
  }, [pad.playing, pad.level, pad.fadeInMs, pad.fadeOutMs]);

  // Apply volume changes immediately to WaveSurfer when level changes
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    try {
      ws.setVolume?.(pad.level || 0);
    } catch {}
  }, [pad.level]);

  const handleContextMenu = (e) => {
    e.preventDefault();
    if (mode !== "edit") return;
    const next = prompt("Rename pad", pad.label || pad.name);
    if (next && next.trim()) {
      pad.label = next.trim();
    }
  };

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
              <div className="waveControls">
                <button
                  className="btn sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    try {
                      const ws = wsRef.current;
                      if (!ws) return;
                      if (ws.isPlaying && ws.isPlaying()) {
                        const startVol =
                          (typeof ws.getVolume === "function"
                            ? ws.getVolume()
                            : pad.level || 0) || 0;
                        const durationMs =
                          typeof pad.fadeOutMs === "number"
                            ? pad.fadeOutMs
                            : 500;
                        const t0 = performance.now();
                        const step = (t) => {
                          const p = Math.min(1, (t - t0) / durationMs);
                          const v = Math.max(0, startVol * (1 - p));
                          try {
                            ws.setVolume?.(v);
                          } catch {}
                          if (p < 1) requestAnimationFrame(step);
                          else {
                            try {
                              ws.pause?.();
                              // restore for next play
                              ws.setVolume?.(startVol);
                            } catch {}
                          }
                        };
                        requestAnimationFrame(step);
                      } else {
                        try {
                          const target = pad.level || 0;
                          const fadeMs =
                            typeof pad.fadeInMs === "number" ? pad.fadeInMs : 0;
                          if (fadeMs > 0) {
                            ws.setVolume?.(0);
                            ws.play?.(0);
                            const t0 = performance.now();
                            const step = (t) => {
                              const p = Math.min(1, (t - t0) / fadeMs);
                              const v = target * p;
                              try {
                                ws.setVolume?.(v);
                              } catch {}
                              if (p < 1) requestAnimationFrame(step);
                            };
                            requestAnimationFrame(step);
                          } else {
                            ws.setVolume?.(target);
                            ws.play?.(0);
                          }
                        } catch {}
                      }
                    } catch {}
                  }}
                >
                  {pad.playing ? "Pause" : "Play"}
                </button>
                {!pad.playing &&
                  (() => {
                    try {
                      const ws = wsRef.current;
                      const canResume =
                        !!ws &&
                        typeof ws.getCurrentTime === "function" &&
                        ws.getCurrentTime() > 0;
                      if (!canResume) return null;
                    } catch {
                      return null;
                    }
                    return (
                      <button
                        className="btn sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          try {
                            const ws = wsRef.current;
                            if (!ws) return;
                            const target = pad.level || 0;
                            const fadeMs =
                              typeof pad.fadeInMs === "number"
                                ? pad.fadeInMs
                                : 0;
                            if (fadeMs > 0) {
                              ws.setVolume?.(0);
                              ws.play?.();
                              const t0 = performance.now();
                              const step = (t) => {
                                const p = Math.min(1, (t - t0) / fadeMs);
                                const v = target * p;
                                try {
                                  ws.setVolume?.(v);
                                } catch {}
                                if (p < 1) requestAnimationFrame(step);
                              };
                              requestAnimationFrame(step);
                            } else {
                              ws.setVolume?.(target);
                              ws.play?.();
                            }
                          } catch {}
                        }}
                      >
                        Resume
                      </button>
                    );
                  })()}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={pad.level || 0}
                  onChange={(e) => {
                    onLevelChange(Number(e.target.value));
                    try {
                      wsRef.current?.setVolume(Number(e.target.value));
                    } catch {}
                  }}
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
      { id: "grp-bg", name: "Background", color: "#0000FF" },
      { id: "grp-amb", name: "Ambient", color: "#FF6A00" },
      { id: "grp-sfx", name: "Effects", color: "#00FF00" },
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
  const p1 = scene.background.find((p) => p.id === padId);
  if (p1) return [gk1, p1];
  const p2 = scene.ambients.find((p) => p.id === padId);
  if (p2) return [gk2, p2];
  const p3 = scene.sfx.find((p) => p.id === padId);
  if (p3) return [gk3, p3];
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

function SettingsModal({ onClose }) {
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
          <div style={{ display: "none" }}>Audio</div>
          <div className="rowFlex">
            <div className="field">
              <label>Master Device</label>
              <select defaultValue="default">
                <option value="default">System Default</option>
              </select>
            </div>
            <div className="field">
              <label>Sample Rate</label>
              <select defaultValue="48000">
                <option value="44100">44.1 kHz</option>
                <option value="48000">48 kHz</option>
              </select>
            </div>
          </div>
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

function SoundEditorDrawer({ editor, scene, onClose, onSave }) {
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
      playbackMode: "once",
      level: 0.8,
      fadeInMs: 0,
      fadeOutMs: 500,
    }
  );
  const [triggers, setTriggers] = useState({
    onStart: {
      action: "none",
      targetType: "pad",
      target: "",
      timeMs: 200,
      amountDb: -12,
    },
    onStop: {
      action: "none",
      targetType: "pad",
      target: "",
      timeMs: 200,
      amountDb: -12,
    },
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
              <label>Type</label>
              <select value={editor.groupKey} onChange={() => {}} disabled>
                <option value="background">Background</option>
                <option value="ambients">Ambient</option>
                <option value="sfx">SFX</option>
              </select>
            </div>
            <div className="field">
              <label>Group</label>
              <select
                value={state.groupId || scene.groups?.[0]?.id || ""}
                onChange={(e) =>
                  setState((s) => ({ ...s, groupId: e.target.value }))
                }
              >
                {(scene.groups || []).map((g) => (
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
            <label>onStart</label>
            <div className="rowFlex">
              <select
                value={triggers.onStart.action}
                onChange={(e) =>
                  setTriggers((t) => ({
                    ...t,
                    onStart: { ...t.onStart, action: e.target.value },
                  }))
                }
              >
                <option value="none">None</option>
                <option value="play">Play</option>
                <option value="stop">Stop</option>
                <option value="fade">Fade</option>
              </select>
              <select
                value={triggers.onStart.targetType}
                onChange={(e) =>
                  setTriggers((t) => ({
                    ...t,
                    onStart: { ...t.onStart, targetType: e.target.value },
                  }))
                }
              >
                <option value="pad">Pad</option>
                <option value="group">Group</option>
                <option value="scene">Scene</option>
              </select>
              <input
                placeholder="target (sceneId:padId or group name)"
                value={triggers.onStart.target}
                onChange={(e) =>
                  setTriggers((t) => ({
                    ...t,
                    onStart: { ...t.onStart, target: e.target.value },
                  }))
                }
              />
            </div>
            <div className="rowFlex">
              <div className="field">
                <label>Time (ms)</label>
                <input
                  type="number"
                  placeholder="200"
                  value={triggers.onStart.timeMs}
                  onChange={(e) =>
                    setTriggers((t) => ({
                      ...t,
                      onStart: { ...t.onStart, timeMs: Number(e.target.value) },
                    }))
                  }
                />
              </div>
              <div className="field">
                <label>Amount (dB)</label>
                <input
                  type="number"
                  placeholder="-12"
                  value={triggers.onStart.amountDb}
                  onChange={(e) =>
                    setTriggers((t) => ({
                      ...t,
                      onStart: {
                        ...t.onStart,
                        amountDb: Number(e.target.value),
                      },
                    }))
                  }
                />
              </div>
            </div>
          </div>
          <div className="field">
            <label>onStop</label>
            <div className="rowFlex">
              <select
                value={triggers.onStop.action}
                onChange={(e) =>
                  setTriggers((t) => ({
                    ...t,
                    onStop: { ...t.onStop, action: e.target.value },
                  }))
                }
              >
                <option value="none">None</option>
                <option value="play">Play</option>
                <option value="stop">Stop</option>
                <option value="fade">Fade</option>
              </select>
              <select
                value={triggers.onStop.targetType}
                onChange={(e) =>
                  setTriggers((t) => ({
                    ...t,
                    onStop: { ...t.onStop, targetType: e.target.value },
                  }))
                }
              >
                <option value="pad">Pad</option>
                <option value="group">Group</option>
                <option value="scene">Scene</option>
              </select>
              <input
                placeholder="target (sceneId:padId or group name)"
                value={triggers.onStop.target}
                onChange={(e) =>
                  setTriggers((t) => ({
                    ...t,
                    onStop: { ...t.onStop, target: e.target.value },
                  }))
                }
              />
            </div>
            <div className="rowFlex">
              <div className="field">
                <label>Time (ms)</label>
                <input
                  type="number"
                  placeholder="200"
                  value={triggers.onStop.timeMs}
                  onChange={(e) =>
                    setTriggers((t) => ({
                      ...t,
                      onStop: { ...t.onStop, timeMs: Number(e.target.value) },
                    }))
                  }
                />
              </div>
              <div className="field">
                <label>Amount (dB)</label>
                <input
                  type="number"
                  placeholder="-12"
                  value={triggers.onStop.amountDb}
                  onChange={(e) =>
                    setTriggers((t) => ({
                      ...t,
                      onStop: { ...t.onStop, amountDb: Number(e.target.value) },
                    }))
                  }
                />
              </div>
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
                groupKey: editor.groupKey,
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
