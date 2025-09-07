use serde::{Deserialize, Serialize};
use tauri::Emitter;
use once_cell::sync::Lazy;
use std::sync::Mutex;

// MIDI state
// (Reserved for future persistent state)

#[derive(Serialize, Deserialize, Debug)]
struct MidiDeviceInfo {
    id: usize,
    name: String,
    kind: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct MidiMessage {
    timestamp_ms: u128,
    data: Vec<u8>,
}

#[derive(Serialize, Deserialize, Debug)]
struct MidiSnapshot {
    inputs: Vec<MidiDeviceInfo>,
    outputs: Vec<MidiDeviceInfo>,
}

#[tauri::command]
fn midi_list_inputs() -> Result<Vec<MidiDeviceInfo>, String> {
    let mut out: Vec<MidiDeviceInfo> = Vec::new();
    let midi_in = midir::MidiInput::new("wc-midi-in").map_err(|e| e.to_string())?;
    for (i, port) in midi_in.ports().iter().enumerate() {
        let name = midi_in.port_name(port).unwrap_or_else(|_| "Unknown".to_string());
        out.push(MidiDeviceInfo { id: i, name, kind: "input".into() });
    }
    Ok(out)
}

#[tauri::command]
fn midi_list_outputs() -> Result<Vec<MidiDeviceInfo>, String> {
    let mut out: Vec<MidiDeviceInfo> = Vec::new();
    let midi_out = midir::MidiOutput::new("wc-midi-out").map_err(|e| e.to_string())?;
    for (i, port) in midi_out.ports().iter().enumerate() {
        let name = midi_out.port_name(port).unwrap_or_else(|_| "Unknown".to_string());
        out.push(MidiDeviceInfo { id: i, name, kind: "output".into() });
    }
    Ok(out)
}

static INPUT_CONN: Lazy<Mutex<Option<midir::MidiInputConnection<()>>>> = Lazy::new(|| Mutex::new(None));
static OUTPUT_CONN: Lazy<Mutex<Option<midir::MidiOutputConnection>>> = Lazy::new(|| Mutex::new(None));

#[tauri::command]
fn midi_open_input(window: tauri::Window, input_index: usize) -> Result<(), String> {
    let mut midi_in = midir::MidiInput::new("wc-midi-in").map_err(|e| e.to_string())?;
    midi_in.ignore(midir::Ignore::None);
    let ports = midi_in.ports();
    let port = ports.get(input_index).ok_or_else(|| "Invalid input index".to_string())?;

    // Drop old connection (if any)
    {
        let mut guard = INPUT_CONN.lock().map_err(|_| "Lock poisoned")?;
        *guard = None;
    }

    let conn = midi_in
        .connect(
            port,
            "wc-midi-in-conn",
            move |_, message, _| {
                let payload = MidiMessage {
                    timestamp_ms: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis(),
                    data: message.to_vec(),
                };
                let _ = window.emit("midi://message", &payload);
            },
            (),
        )
        .map_err(|e| e.to_string())?;

    // Keep connection alive
    let mut guard = INPUT_CONN.lock().map_err(|_| "Lock poisoned")?;
    *guard = Some(conn);
    Ok(())
}

#[tauri::command]
fn midi_open_output(output_index: usize) -> Result<(), String> {
    let midi_out = midir::MidiOutput::new("wc-midi-out").map_err(|e| e.to_string())?;
    let ports = midi_out.ports();
    let port = ports.get(output_index).ok_or_else(|| "Invalid output index".to_string())?;
    // Drop old
    {
        let mut g = OUTPUT_CONN.lock().map_err(|_| "Lock poisoned")?;
        *g = None;
    }
    let conn = midi_out.connect(port, "wc-midi-out-conn").map_err(|e| e.to_string())?;
    let mut g = OUTPUT_CONN.lock().map_err(|_| "Lock poisoned")?;
    *g = Some(conn);
    Ok(())
}

#[tauri::command]
fn midi_send(bytes: Vec<u8>) -> Result<(), String> {
    let mut g = OUTPUT_CONN.lock().map_err(|_| "Lock poisoned")?;
    if let Some(conn) = g.as_mut() {
        conn.send(&bytes).map_err(|e| e.to_string())
    } else {
        Err("Output not connected".into())
    }
}

#[tauri::command]
fn midi_refresh() -> Result<MidiSnapshot, String> {
    Ok(MidiSnapshot { inputs: midi_list_inputs()?, outputs: midi_list_outputs()? })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![midi_list_inputs, midi_list_outputs, midi_open_input, midi_open_output, midi_send, midi_refresh])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
