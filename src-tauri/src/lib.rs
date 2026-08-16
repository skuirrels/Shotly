mod annotate;
mod build_info;
mod capture;
mod commands;
mod highlight;
mod markup;
mod platform;
mod update;

use capture::cli::ScreencaptureCli;
use commands::{AppState, CaptureMode};
use std::sync::Mutex;
use tauri::menu::{AboutMetadata, Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// System-wide hotkeys.
///
/// Deliberately on Ctrl+Shift rather than Cmd+Shift: macOS already owns
/// Cmd+Shift+3/4/5 for its own screenshot tools, and silently stealing them
/// would be hostile. Users who want them can rebind in Settings.
#[cfg(desktop)]
fn shortcuts() -> [(Shortcut, CaptureMode); 3] {
    let mods = Modifiers::CONTROL | Modifiers::SHIFT;
    [
        (Shortcut::new(Some(mods), Code::Digit4), CaptureMode::Region),
        (Shortcut::new(Some(mods), Code::Digit5), CaptureMode::Window),
        (Shortcut::new(Some(mods), Code::Digit3), CaptureMode::Fullscreen),
    ]
}

/// Toggles live screen annotation.
///
/// Owned by Rust rather than the annotation page, so it keeps working even if
/// that page has died — this is the escape hatch of last resort for a
/// full-screen window that accepts the mouse.
#[cfg(desktop)]
fn annotate_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyA)
}

/// Steps in and out of drawing without packing the drawings away.
///
/// Also owned by Rust, and for a sharper reason than the one above: while the
/// layer is letting clicks past, the pointer belongs to another app entirely
/// and the annotation page may never see a key again. This is the way back.
#[cfg(desktop)]
fn interact_shortcut() -> Shortcut {
    // Not Ctrl-Shift-S: Snagit claims that one, and a hotkey the machine
    // already answers with someone else's window is no way back at all.
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyD)
}

fn dispatch(app: &tauri::AppHandle, mode: CaptureMode) {
    let result = match mode {
        CaptureMode::Fullscreen => commands::capture_fullscreen(app.clone(), None).map(|_| ()),
        other => commands::start_capture(app, other),
    };

    if let Err(err) = result {
        eprintln!("[shotly] capture failed: {err}");
        let _ = tauri::Emitter::emit(app, "capture:error", err);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    // Fire on press only; the release event would double-trigger.
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    eprintln!("[annotate] hotkey fired: {shortcut:?}");
                    if shortcut == &annotate_shortcut() {
                        if let Err(err) = annotate::toggle(app) {
                            eprintln!("[shotly] annotation toggle failed: {err}");
                        }
                        return;
                    }
                    if shortcut == &interact_shortcut() {
                        // The page owns the decision — it knows whether it is
                        // already letting clicks past, and where its toolbar
                        // has been dragged to. A layer that has stopped
                        // answering simply doesn't toggle, and Ctrl-Shift-A
                        // remains the way out of that.
                        let _ = tauri::Emitter::emit_to(app, annotate::LABEL, "annotate:interact", ());
                        return;
                    }
                    if let Some((_, mode)) = shortcuts().iter().find(|(s, _)| s == shortcut) {
                        dispatch(app, *mode);
                    }
                })
                .build(),
        );
    }

    builder
        .manage(AppState {
            backend: ScreencaptureCli::new().expect("could not create scratch directory"),
            hid_editor: Mutex::new(false),
        })
        .manage(annotate::AnnotateState::default())
        .invoke_handler(tauri::generate_handler![
            commands::capture_permission_status,
            commands::request_capture_permission,
            commands::open_screen_recording_settings,
            commands::restart_app,
            commands::begin_capture,
            commands::cancel_capture,
            commands::capture_fullscreen,
            commands::list_windows,
            commands::open_image,
            commands::read_capture_bytes,
            commands::save_png,
            commands::save_editable_png,
            commands::save_to_library,
            commands::save_library_path,
            commands::list_library,
            commands::library_thumbnail,
            commands::trash_captures,
            commands::reveal_in_finder,
            commands::copy_png_to_clipboard,
            commands::copy_files_to_clipboard,
            commands::read_clipboard_image,
            commands::image_data_url,
            commands::hide_editor,
            update::check_for_updates,
            update::pending_update,
            annotate::annotate_toggle,
            annotate::annotate_stop,
            annotate::annotate_ready,
            annotate::annotate_beat,
            annotate::annotate_click_through,
            annotate::annotate_pass_through,
            annotate::annotate_save,
            annotate::annotate_screens,
            annotate::annotate_layout,
            annotate::annotate_move,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            #[cfg(desktop)]
            for (shortcut, _) in shortcuts() {
                if let Err(e) = app.global_shortcut().register(shortcut) {
                    eprintln!("[shotly] could not register {shortcut:?}: {e}");
                }
            }
            #[cfg(desktop)]
            if let Err(e) = app.global_shortcut().register(annotate_shortcut()) {
                eprintln!("[shotly] could not register the annotation hotkey: {e}");
            }
            #[cfg(desktop)]
            if let Err(e) = app.global_shortcut().register(interact_shortcut()) {
                eprintln!("[shotly] could not register the interact hotkey: {e}");
            }

            if let Err(e) = build_menu(&handle) {
                // The default menu stays in place, which costs the build line
                // in About and nothing else. Not worth refusing to start over.
                eprintln!("[shotly] could not install the app menu: {e}");
            }

            build_tray(&handle)?;

            #[cfg(desktop)]
            update::schedule(&handle);

            // The editor is visible on launch so a first run explains itself
            // and can walk the user through the Screen Recording prompt.
            // Closing it drops the app to the menu bar, where it stays.


            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing the editor should park the app in the menu bar, not
                // quit it — the hotkeys need to stay live.
                if window.label() == "editor" {
                    api.prevent_close();
                    let _ = window.hide();
                    platform::set_accessory_mode(window.app_handle(), true);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Shotly");
}

/// Swap the About item for one that says which build is running.
///
/// Surgery on the default menu rather than a menu of our own: the default
/// carries the whole standard set — Services, Hide Others, and an Edit menu
/// whose Cut/Copy/Paste items are what wire those shortcuts to the webview —
/// and rebuilding it by hand to change one item would mean owning all of that
/// for ever. `Menu::default` puts About first in the app submenu.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;

    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let about = PredefinedMenuItem::about(app, None, Some(about_metadata(app)))?;
        app_menu.remove_at(0)?;
        app_menu.insert(&about, 0)?;
    }

    app.set_menu(menu)?;
    Ok(())
}

/// What the standard About panel shows.
///
/// The two version fields read backwards from their names: macOS renders
/// `version` as the marketing version and `short_version` as the build number
/// in parentheses. So "Version 0.1.6 (release)" — the slot where an Apple app
/// would put a build number is exactly the right place for which build this is.
fn about_metadata(app: &tauri::AppHandle) -> AboutMetadata<'_> {
    AboutMetadata {
        name: Some("Shotly".into()),
        version: Some(app.package_info().version.to_string()),
        short_version: Some(build_info::PROFILE.into()),
        credits: Some(build_info::summary(app)),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let region = MenuItem::with_id(app, "region", "Capture Region", true, Some("Ctrl+Shift+4"))?;
    let window = MenuItem::with_id(app, "window", "Capture Window", true, Some("Ctrl+Shift+5"))?;
    let screen = MenuItem::with_id(app, "screen", "Capture Screen", true, Some("Ctrl+Shift+3"))?;
    let annotate =
        MenuItem::with_id(app, "annotate", "Annotate Screen", true, Some("Ctrl+Shift+A"))?;
    let stop = MenuItem::with_id(app, "stop-annotate", "Exit Annotation Mode", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "update", "Check for Updates…", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Shotly", true, Some("Cmd+Q"))?;

    let menu = Menu::with_items(
        app,
        &[&region, &window, &screen, &sep, &annotate, &stop, &sep, &updates, &quit],
    )?;

    // A dedicated template glyph rather than the app icon. The menu bar renders
    // a template from its alpha channel alone, so handing it the app icon — a
    // filled orange square — puts a solid black block up there.
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))
        .expect("tray icon is not a readable PNG");

    TrayIconBuilder::with_id("shotly-tray")
        .icon(tray_icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "region" => dispatch(app, CaptureMode::Region),
            "window" => dispatch(app, CaptureMode::Window),
            "screen" => dispatch(app, CaptureMode::Fullscreen),
            "annotate" => {
                if let Err(err) = annotate::toggle(app) {
                    eprintln!("[shotly] annotation toggle failed: {err}");
                }
            }
            "stop-annotate" => annotate::stop(app),
            "update" => update::check_from_tray(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}
