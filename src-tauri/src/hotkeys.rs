//! The system-wide hotkeys, and the user's choice of what they are.
//!
//! These are the keys that work with any app in front, so they are the ones
//! most likely to collide with something already installed — and macOS gives
//! no way to find out. `RegisterEventHotKey` happily succeeds for a
//! combination another process is already watching; whoever is listening
//! closest to the hardware simply eats it first, and Shotly never hears a
//! thing. That is not a failure we can detect, so the answer is to let the
//! user pick a different one, and to tell them when a key actually arrives.

use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

/// Everything that can be triggered from anywhere in the system.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Region,
    Window,
    Fullscreen,
    Scroll,
    Annotate,
    Interact,
    Record,
}

/// In the order they are shown, which is the order they are reached for.
pub const ACTIONS: [Action; 7] = [
    Action::Region,
    Action::Window,
    Action::Fullscreen,
    Action::Scroll,
    Action::Record,
    Action::Annotate,
    Action::Interact,
];

impl Action {
    /// Deliberately on Ctrl+Shift rather than Cmd+Shift: macOS already owns
    /// Cmd+Shift+3/4/5 for its own screenshot tools, and silently stealing
    /// them would be hostile.
    pub fn default_accelerator(self) -> &'static str {
        match self {
            Action::Region => "Ctrl+Shift+4",
            Action::Window => "Ctrl+Shift+5",
            Action::Fullscreen => "Ctrl+Shift+3",
            Action::Scroll => "Ctrl+Shift+6",
            Action::Annotate => "Ctrl+Shift+A",
            // Not Ctrl+Shift+S: Snagit answers that one on at least one
            // machine, and a hotkey the system answers with someone else's
            // window is no way back at all.
            Action::Interact => "Ctrl+Shift+D",
            Action::Record => "Ctrl+Shift+R",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Action::Region => "Capture region",
            Action::Window => "Capture window",
            Action::Fullscreen => "Capture full screen",
            Action::Scroll => "Scrolling capture",
            Action::Annotate => "Annotate the screen",
            Action::Interact => "Click through / back to drawing",
            Action::Record => "Record / stop recording",
        }
    }

    /// What the action is for, in one line, for the settings list.
    pub fn hint(self) -> &'static str {
        match self {
            Action::Region => "Drag out the part of the screen to keep.",
            Action::Window => "Pick a window; Shotly takes it whole.",
            Action::Fullscreen => "The whole display, straight to the library.",
            Action::Scroll => "Pick a region, scroll the page yourself; Shotly stitches it.",
            Action::Annotate => "Draw over the live screen. Also the way out.",
            Action::Interact => "Hand the mouse back to the desktop, drawings and all.",
            Action::Record => "Record an area, a window or the screen. Press again to stop.",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Action::Region => "region",
            Action::Window => "window",
            Action::Fullscreen => "fullscreen",
            Action::Scroll => "scroll",
            Action::Annotate => "annotate",
            Action::Interact => "interact",
            Action::Record => "record",
        }
    }
}

/// One row of the settings list.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub action: Action,
    pub label: &'static str,
    pub hint: &'static str,
    /// The accelerator in force, or `None` if the user has turned it off.
    pub accelerator: Option<String>,
    pub default_accelerator: &'static str,
}

#[derive(Default)]
pub struct HotkeyState {
    /// What is registered right now. Absent means deliberately unbound.
    bound: Mutex<BTreeMap<Action, (String, Shortcut)>>,
}

/// Where the choices live between runs.
///
/// Beside the app's own data rather than in the library folder: this is
/// configuration, and a user tidying up their screenshots should not be able
/// to reset their keyboard by accident.
fn store_path<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    Ok(dir.join("hotkeys.json"))
}

/// The saved accelerators, by action key. Missing entries take the default;
/// an explicit `null` means the user turned that hotkey off.
fn load<R: Runtime>(app: &AppHandle<R>) -> BTreeMap<String, Option<String>> {
    let Ok(path) = store_path(app) else {
        return BTreeMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save<R: Runtime>(app: &AppHandle<R>, state: &BTreeMap<String, Option<String>>) -> Result<(), String> {
    let path = store_path(app)?;
    let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("could not write {path:?}: {e}"))
}

/// Read the stored choice for one action, falling back to its default.
fn chosen(stored: &BTreeMap<String, Option<String>>, action: Action) -> Option<String> {
    match stored.get(action.key()) {
        // Present and null: switched off on purpose.
        Some(None) => None,
        Some(Some(accel)) => Some(accel.clone()),
        None => Some(action.default_accelerator().to_string()),
    }
}

/// Register every hotkey the user has asked for. Called once, at startup.
///
/// A combination that will not even parse is skipped rather than fatal — a
/// hand-edited config file should cost one hotkey, not the whole app.
pub fn install(app: &AppHandle) {
    let stored = load(app);
    for action in ACTIONS {
        let Some(accel) = chosen(&stored, action) else {
            continue;
        };
        if let Err(err) = bind(app, action, Some(&accel)) {
            eprintln!("[shotly] could not bind {}: {err}", action.key());
        }
    }
}

/// Point one action at one accelerator, replacing whatever it had.
///
/// `None` unbinds it. The registration is done before the bookkeeping so a
/// combination the system refuses outright leaves the old key still working.
fn bind(app: &AppHandle, action: Action, accelerator: Option<&str>) -> Result<(), String> {
    let next = match accelerator {
        Some(accel) => {
            let parsed = Shortcut::from_str(accel)
                .map_err(|_| format!("\"{accel}\" is not a key combination Shotly understands"))?;
            Some((accel.to_string(), parsed))
        }
        None => None,
    };

    let state = app.state::<HotkeyState>();
    let mut bound = state.bound.lock().unwrap();

    // Registering the new one first means a rejected combination costs
    // nothing: the old hotkey is still live and still registered.
    if let Some((_, shortcut)) = &next {
        // Another action already on this key would otherwise be silently
        // shadowed — the same combination registered twice fires once.
        if let Some((other, _)) = bound.iter().find(|(a, (_, s))| **a != action && s == shortcut) {
            return Err(format!("{} already uses that combination", other.label()));
        }
        app.global_shortcut()
            .register(*shortcut)
            .map_err(|e| format!("the system would not take that combination: {e}"))?;
    }

    if let Some((_, old)) = bound.remove(&action) {
        let _ = app.global_shortcut().unregister(old);
    }
    if let Some(entry) = next {
        bound.insert(action, entry);
    }

    Ok(())
}

/// Which action a fired shortcut belongs to.
pub fn resolve(app: &AppHandle, shortcut: &Shortcut) -> Option<Action> {
    let state = app.state::<HotkeyState>();
    let bound = state.bound.lock().unwrap();
    bound
        .iter()
        .find(|(_, (_, s))| s == shortcut)
        .map(|(action, _)| *action)
}

/// Say that a hotkey arrived.
///
/// The settings list listens for this and lights the row up. It is the only
/// honest way to answer "is this combination actually reaching Shotly?", given
/// that a clash with another app is invisible to us until a key goes missing.
pub fn announce(app: &AppHandle, action: Action) {
    let _ = app.emit("hotkey:fired", action);
}

#[tauri::command]
pub fn hotkeys_list(app: AppHandle) -> Vec<Binding> {
    let state = app.state::<HotkeyState>();
    let bound = state.bound.lock().unwrap();
    ACTIONS
        .into_iter()
        .map(|action| Binding {
            action,
            label: action.label(),
            hint: action.hint(),
            accelerator: bound.get(&action).map(|(accel, _)| accel.clone()),
            default_accelerator: action.default_accelerator(),
        })
        .collect()
}

/// Rebind one action, and remember it.
///
/// Live: the new combination works the moment this returns, with no restart.
#[tauri::command]
pub fn hotkeys_set(app: AppHandle, action: Action, accelerator: Option<String>) -> Result<(), String> {
    bind(&app, action, accelerator.as_deref())?;
    crate::refresh_tray(&app);

    let mut stored = load(&app);
    stored.insert(action.key().to_string(), accelerator);
    save(&app, &stored)
}

/// Put every hotkey back to the combination it shipped with.
#[tauri::command]
pub fn hotkeys_reset(app: AppHandle) -> Result<(), String> {
    for action in ACTIONS {
        bind(&app, action, Some(action.default_accelerator()))?;
    }
    crate::refresh_tray(&app);
    save(&app, &BTreeMap::new())
}
