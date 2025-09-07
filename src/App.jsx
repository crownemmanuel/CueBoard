import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

function App() {
  const [mode, setMode] = useState("show"); // "show" | "edit"
  const [status, setStatus] = useState("Ready");
  const [show, setShow] = useState(() => createInitialShow());
  const [currentSceneId, setCurrentSceneId] = useState(show.scenes[0]?.id);
  const [selectedPadKey, setSelectedPadKey] = useState(null);
  const [legendOpen, setLegendOpen] = useState(true);
  const [notesOpen, setNotesOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editor, setEditor] = useState({
    open: false,
    groupKey: null,
    padId: null,
  });

  const currentScene = useMemo(() => {
    return show.scenes.find((s) => s.id === currentSceneId) || show.scenes[0];
  }, [show, currentSceneId]);

  const groupColors = useMemo(() => {
    const map = {};
    (show.groups || []).forEach((g) => (map[g.id] = g.color));
    return map;
  }, [show.groups]);

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
      } else if (e.key.toLowerCase() === "f") {
        handleFadeAll();
      } else if (e.key.toLowerCase() === "p") {
        handlePanic();
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
      pad.playing = !pad.playing;
      setStatus(
        `${pad.label || pad.name} ${pad.playing ? "started" : "stopped"}`
      );
      return scene;
    });
  }

  function handleStopAll() {
    updateScene((scene) => {
      allPads(scene).forEach((p) => (p.playing = false));
      return scene;
    });
    setStatus("Stop all");
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
            {s.name}
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
                  <input
                    type="color"
                    value={g.color}
                    onChange={(e) =>
                      updateGroup(g.id, { color: e.target.value })
                    }
                  />
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
          <button className="btn gray" onClick={() => setMode("edit")}>
            Edit
          </button>
          <button className="btn gray" onClick={() => setMode("show")}>
            Show
          </button>
          <button className="btn blue" onClick={handleRememberCapture}>
            Remember
          </button>
          <button className="btn" onClick={handleStopAll}>
            Stop All
          </button>
          <button className="btn" onClick={handleFadeAll}>
            Fade All
          </button>
          <button className="btn red" onClick={handlePanic}>
            Panic
          </button>
          <button className="btn" onClick={nextScene}>
            Next Scene
          </button>
          <button className="btn" onClick={() => setNotesOpen((v) => !v)}>
            {notesOpen ? "Hide Notes" : "Show Notes"}
          </button>
          <button className="btn" onClick={() => setLegendOpen((v) => !v)}>
            {legendOpen ? "Hide Tips" : "Show Tips"}
          </button>
          <button className="btn" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <div className="spacer" />
          <span id="status">{status}</span>
        </div>

        <div className="content">
          {legendOpen && <Legend onClose={() => setLegendOpen(false)} />}

          <GroupSection
            title="Background Music"
            color="#2d6cdf"
            pads={currentScene.background}
            groupKey="background"
            mode={mode}
            onPadToggle={(id) => togglePadPlay("background", id)}
            onLevelChange={(id, v) => setPadLevel("background", id, v)}
            onEdit={(id) => openEditor("background", id)}
            onDelete={(id) => deletePad("background", id)}
            selectedPadKey={selectedPadKey}
            setSelectedPadKey={setSelectedPadKey}
          />

          <GroupSection
            title="Ambient Noise"
            color="#f2b84b"
            pads={currentScene.ambients}
            groupKey="ambients"
            mode={mode}
            onPadToggle={(id) => togglePadPlay("ambients", id)}
            onLevelChange={(id, v) => setPadLevel("ambients", id, v)}
            onEdit={(id) => openEditor("ambients", id)}
            onDelete={(id) => deletePad("ambients", id)}
            selectedPadKey={selectedPadKey}
            setSelectedPadKey={setSelectedPadKey}
          />

          <GroupSection
            title="Sound Effects"
            color="#4caf50"
            pads={currentScene.sfx}
            groupKey="sfx"
            mode={mode}
            onPadToggle={(id) => togglePadPlay("sfx", id)}
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
          <div>MIDI: Offline</div>
        </div>
      </div>
      {mode === "edit" && (
        <div
          style={{ position: "absolute", left: 0, bottom: 0, padding: 12 }}
        />
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
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
      setStatus(`${pad.label || pad.name} level ${(value * 100) | 0}%`);
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
  onPadToggle,
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
        <div className="title">{title}</div>
      </div>
      <div className="grid">
        {pads.map((p) => (
          <PadCard
            key={p.id}
            pad={p}
            groupKey={groupKey}
            mode={mode}
            onToggle={() => onPadToggle(p.id)}
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
  onLevelChange,
  selected,
  onSelect,
  onEdit,
  onDelete,
}) {
  const levelPercent = Math.max(6, Math.floor((pad.level || 0) * 100));
  const headerStyle = { background: "rgba(0,0,0,.18)", color: "#fff" };
  const resolvedBase = pad.color || "#2a2a2a";
  const bodyColor = pad.playing ? lighten(resolvedBase, 0.12) : resolvedBase;

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
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              className={"playButton" + (pad.playing ? " paused" : "")}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
            />
          </div>
          <div className="meterBar">
            <div className="meterFill" style={{ width: `${levelPercent}%` }} />
          </div>
        </div>
        <VSlider value={pad.level || 0} onChange={onLevelChange} />
      </div>
    </div>
  );
}

function VSlider({ value, onChange }) {
  const ref = useRef(null);
  const KNOB_H = 14;
  const HEIGHT = 80;
  const [dragging, setDragging] = useState(false);

  const valToY = (v) => (1 - v) * (HEIGHT - KNOB_H);
  const yToVal = (y) => {
    const clamped = Math.max(0, Math.min(HEIGHT - KNOB_H, y));
    return 1 - clamped / (HEIGHT - KNOB_H);
  };

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging) return;
      const rect = ref.current.getBoundingClientRect();
      const y = e.clientY - rect.top - KNOB_H / 2;
      onChange?.(yToVal(y));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, onChange]);

  return (
    <div
      ref={ref}
      className="vSlider"
      style={{ height: HEIGHT }}
      onMouseDown={(e) => {
        setDragging(true);
        const rect = ref.current.getBoundingClientRect();
        const y = e.clientY - rect.top - KNOB_H / 2;
        onChange?.(yToVal(y));
      }}
    >
      <div className="knob" style={{ top: valToY(value) }} />
    </div>
  );
}

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
        color: "#2d6cdf",
        groupId: "grp-bg",
        playbackMode: "loop",
        level: 0.75,
        baseLevel: 0.75,
        playing: false,
      },
      {
        id: "bg2",
        name: "Background 2",
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
        id: "amb1",
        name: "Market Crowd",
        color: "#f2b84b",
        groupId: "grp-amb",
        playbackMode: "loop",
        level: 0.6,
        baseLevel: 0.6,
        playing: false,
      },
      {
        id: "amb2",
        name: "Wind",
        color: "#f2b84b",
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
        color: "#e86f51",
        groupId: "grp-sfx",
        playbackMode: "once",
        level: 0.8,
        baseLevel: 0.8,
        playing: false,
      },
      {
        id: "sfx2",
        name: "Plate Break",
        color: "#4caf50",
        groupId: "grp-sfx",
        playbackMode: "once",
        level: 0.7,
        baseLevel: 0.7,
        playing: false,
      },
      {
        id: "sfx3",
        name: "Door Slam",
        color: "#4caf50",
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
      { id: "grp-bg", name: "Background", color: "#2d6cdf" },
      { id: "grp-amb", name: "Ambient", color: "#f2b84b" },
      { id: "grp-sfx", name: "Effects", color: "#4caf50" },
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

export default App;

function SettingsModal({ onClose }) {
  const [backend, setBackend] = useState("web");
  const [log, setLog] = useState([]);

  // Native (Rust) state
  const [inputs, setInputs] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [selectedIn, setSelectedIn] = useState(0);
  const [selectedOut, setSelectedOut] = useState(0);

  // Web MIDI state
  const [midiAccess, setMidiAccess] = useState(null);
  const [webInId, setWebInId] = useState("");
  const [webOutId, setWebOutId] = useState("");
  const [webSupported, setWebSupported] = useState(false);
  const webInputRef = useRef(null);

  useEffect(() => {
    if (backend === "native") {
      window.__TAURI__?.core
        ?.invoke("midi_refresh")
        .then((snap) => {
          setInputs(snap?.inputs || []);
          setOutputs(snap?.outputs || []);
        })
        .catch(() => {
          setInputs([]);
          setOutputs([]);
        });
      const unlisten = window.__TAURI__?.event?.listen?.(
        "midi://message",
        (event) => {
          setLog((l) => [event.payload, ...l].slice(0, 200));
        }
      );
      return () => {
        if (typeof unlisten === "function") unlisten();
      };
    } else {
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
            // force refresh
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
      };
    }
  }, [backend]);

  function connectInNative() {
    window.__TAURI__?.core?.invoke("midi_open_input", {
      inputIndex: Number(selectedIn),
    });
  }
  function sendTestNative() {
    const noteOn = [0x90, 60, 64];
    const noteOff = [0x80, 60, 0];
    window.__TAURI__?.core
      ?.invoke("midi_open_output", { outputIndex: Number(selectedOut) })
      .then(() => {
        window.__TAURI__?.core?.invoke("midi_send", { bytes: noteOn });
        setTimeout(() => {
          window.__TAURI__?.core?.invoke("midi_send", { bytes: noteOff });
        }, 200);
      });
  }

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
          <div style={{ marginBottom: 10, color: "#bbb" }}>Audio</div>
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
          <div style={{ margin: "16px 0", color: "#bbb" }}>MIDI</div>
          <div className="rowFlex">
            <div className="field">
              <label>Backend</label>
              <select
                value={backend}
                onChange={(e) => setBackend(e.target.value)}
              >
                <option value="web">Web MIDI (browser)</option>
                <option value="native">Native (Rust)</option>
              </select>
            </div>
          </div>

          {backend === "native" ? (
            <div className="rowFlex">
              <div className="field">
                <label>Input Device</label>
                <select
                  value={selectedIn}
                  onChange={(e) => setSelectedIn(e.target.value)}
                >
                  {inputs.map((d, i) => (
                    <option key={i} value={i}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn sm"
                  style={{ marginTop: 6 }}
                  onClick={connectInNative}
                >
                  Connect
                </button>
              </div>
              <div className="field">
                <label>Output Device</label>
                <select
                  value={selectedOut}
                  onChange={(e) => setSelectedOut(e.target.value)}
                >
                  {outputs.map((d, i) => (
                    <option key={i} value={i}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button className="btn sm" onClick={sendTestNative}>
                    Send Test Note
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
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
            </>
          )}

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
          ? "#2d6cdf"
          : editor.groupKey === "ambients"
          ? "#f2b84b"
          : "#4caf50",
      playbackMode: "once",
      level: 0.8,
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
                      color: useGroup ? undefined : s.color || "#4caf50",
                    }));
                  }}
                >
                  <option value="group">Use group color</option>
                  <option value="custom">Custom</option>
                </select>
                <input
                  type="color"
                  disabled={!state.color}
                  value={state.color || "#4caf50"}
                  onChange={(e) =>
                    setState((s) => ({ ...s, color: e.target.value }))
                  }
                />
              </div>
            </div>
          </div>
          <div className="field">
            <label>Audio File</label>
            <div className="rowFlex">
              <input
                placeholder="Select a file (mock)"
                value={state.assetPath || ""}
                onChange={(e) =>
                  setState((s) => ({ ...s, assetPath: e.target.value }))
                }
              />
              <button className="btn">Browse…</button>
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
