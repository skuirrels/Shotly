mod annotate;
mod ax;
mod backup;
mod build_info;
mod capture;
mod combine;
mod commands;
mod hotkeys;
mod markup;
mod ocr;
mod pin;
mod scroll;
mod snap;
mod platform;
mod update;

use capture::cli::ScreencaptureCli;
use commands::{AppState, CaptureMode};
use std::sync::Mutex;
use tauri::menu::{AboutMetadata, Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

#[cfg(desktop)]
use hotkeys::Action;
#[cfg(desktop)]
use tauri_plugin_global_shortcut::ShortcutState;

fn dispatch(app: &tauri::AppHandle, mode: CaptureMode) {
    let result = match mode {
        CaptureMode::Fullscreen => commands::capture_fullscreen(app.clone(), None).map(|_| ()),
        // Window capture included: `start_capture` sends it to `snap`, so the
        // hotkey, the tray and the editor's toolbar all take the same route.
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
                    // Escape is borrowed by the annotation layer while it is
                    // on screen and owns the mouse, because WKWebView eats it
                    // before the page can see it. It belongs to no action and
                    // never reaches the settings list.
                    if annotate::is_escape(shortcut) {
                        annotate::on_escape(app);
                        return;
                    }

                    let Some(action) = hotkeys::resolve(app, shortcut) else {
                        return;
                    };

                    // Said out loud before it is acted on, so the settings list
                    // can show that the key arrived even when the action it
                    // triggers is invisible from there.
                    hotkeys::announce(app, action);

                    match action {
                        Action::Region => dispatch(app, CaptureMode::Region),
                        Action::Window => dispatch(app, CaptureMode::Window),
                        Action::Fullscreen => dispatch(app, CaptureMode::Fullscreen),
                        Action::Scroll => {
                            if let Err(err) = scroll::scroll_begin(app.clone()) {
                                eprintln!("[shotly] scrolling capture failed: {err}");
                                let _ = tauri::Emitter::emit(app, "capture:error", err);
                            }
                        }
                        Action::Annotate => {
                            if let Err(err) = annotate::toggle(app) {
                                eprintln!("[shotly] annotation toggle failed: {err}");
                            }
                        }
                        // The page owns this decision — it knows whether it is
                        // already letting clicks past, and where its toolbar
                        // has been dragged to. A layer that has stopped
                        // answering simply doesn't toggle, and the annotate
                        // hotkey remains the way out of that.
                        Action::Interact => {
                            let _ =
                                tauri::Emitter::emit_to(app, annotate::LABEL, "annotate:interact", ());
                        }
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
        .manage(hotkeys::HotkeyState::default())
        .manage(scroll::ScrollState::default())
        .manage(snap::SnapState::default())
        .invoke_handler(tauri::generate_handler![
            commands::capture_permission_status,
            commands::request_capture_permission,
            commands::open_screen_recording_settings,
            commands::restart_app,
            commands::begin_capture,
            commands::cancel_capture,
            commands::capture_fullscreen,
            commands::list_windows,
            commands::window_thumbnail,
            commands::capture_window,
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
            commands::copy_file_image_to_clipboard,
            commands::read_clipboard_image,
            commands::image_data_url,
            commands::hide_editor,
            update::check_for_updates,
            update::pending_update,
            backup::backup_targets,
            backup::backup_settings,
            backup::backup_configure,
            backup::backup_now,
            ocr::scan_image,
            combine::combine_captures,
            scroll::scroll_begin,
            scroll::scroll_ready,
            scroll::scroll_beat,
            scroll::scroll_layout,
            scroll::scroll_start,
            scroll::scroll_finish,
            scroll::scroll_cancel,
            snap::snap_ready,
            snap::snap_beat,
            pin::pin_open,
            pin::pin_png,
            pin::pin_close,
            pin::pin_close_all,
            hotkeys::hotkeys_list,
            hotkeys::hotkeys_set,
            hotkeys::hotkeys_reset,
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
            hotkeys::install(&handle);

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
            //
            // And it follows the user between Spaces, because a menu-bar app
            // that does not is one you can open and never see. See
            // `platform::follow_active_space`.
            if let Some(editor) = handle.get_webview_window("editor") {
                if let Err(err) = platform::follow_active_space(&editor) {
                    eprintln!("[shotly] the editor will not follow Spaces: {err}");
                }
            }


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

/// The tray menu, with whatever hotkeys are in force written beside its items.
///
/// Built separately from the tray itself so a rebind can replace it — a menu
/// still advertising Ctrl-Shift-D after the user has moved that key somewhere
/// else is worse than no hint at all.
fn tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let accel = |action: Action| {
        hotkeys::hotkeys_list(app.clone())
            .into_iter()
            .find(|b| b.action == action)
            .and_then(|b| b.accelerator)
    };

    let region =
        MenuItem::with_id(app, "region", "Capture Region", true, accel(Action::Region))?;
    let window =
        MenuItem::with_id(app, "window", "Capture Window", true, accel(Action::Window))?;
    // The outline can only offer what the pointer can reach. This is the way to
    // a window that is behind another one, on another Space, or fully covered —
    // and the way to capture at all without granting Accessibility access.
    let window_list =
        MenuItem::with_id(app, "window-list", "Capture Window from List…", true, None::<&str>)?;
    let screen =
        MenuItem::with_id(app, "screen", "Capture Screen", true, accel(Action::Fullscreen))?;
    let scroll =
        MenuItem::with_id(app, "scroll", "Scrolling Capture", true, accel(Action::Scroll))?;
    let annotate =
        MenuItem::with_id(app, "annotate", "Annotate Screen", true, accel(Action::Annotate))?;
    let stop = MenuItem::with_id(app, "stop-annotate", "Exit Annotation Mode", true, None::<&str>)?;
    // The way out of a screen covered in pins — and the way to shut one whose
    // page has stopped answering its own close button.
    let unpin = MenuItem::with_id(app, "close-pins", "Close All Pins", true, None::<&str>)?;
    // Only shown when it would do something. macOS puts its Accessibility
    // dialog up once and never again, so anyone who dismissed it that first time
    // has no way back except knowing where to look — this is that way, and it
    // disappears the moment it is no longer needed.
    let accessibility = MenuItem::with_id(
        app,
        "accessibility",
        "Allow Scrolling Into Windows…",
        true,
        None::<&str>,
    )?;
    let updates = MenuItem::with_id(app, "update", "Check for Updates…", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Shotly", true, Some("Cmd+Q"))?;

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![
        &region, &window, &window_list, &screen, &scroll, &sep, &annotate, &stop, &unpin, &sep,
    ];
    if !crate::ax::trusted() {
        items.push(&accessibility);
    }
    items.push(&updates);
    items.push(&quit);

    Menu::with_items(app, &items)
}

/// Put the current hotkeys back into the tray menu, after a rebind.
pub fn refresh_tray(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id("shotly-tray") else {
        return;
    };
    match tray_menu(app) {
        // Costs the hint beside the menu item and nothing else, so it is not
        // worth failing a rebind that has otherwise already worked.
        Err(e) => eprintln!("[shotly] could not rebuild the tray menu: {e}"),
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                eprintln!("[shotly] could not install the tray menu: {e}");
            }
        }
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app)?;

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
            "window-list" => {
                if let Err(err) = commands::request_window_pick(app) {
                    eprintln!("[shotly] could not open the window list: {err}");
                    let _ = tauri::Emitter::emit(app, "capture:error", err);
                }
            }
            "accessibility" => {
                // Asking registers Shotly in the list; opening the pane is what
                // makes something visibly happen for anyone whose dialog has
                // already been spent. Neither grants anything — the tick is the
                // user's, in System Settings, as it has to be.
                crate::ax::request_trust();
                let _ = std::process::Command::new("/usr/bin/open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
                    .spawn();
            }
            "screen" => dispatch(app, CaptureMode::Fullscreen),
            "scroll" => {
                if let Err(err) = scroll::scroll_begin(app.clone()) {
                    eprintln!("[shotly] scrolling capture failed: {err}");
                    let _ = tauri::Emitter::emit(app, "capture:error", err);
                }
            }
            "annotate" => {
                if let Err(err) = annotate::toggle(app) {
                    eprintln!("[shotly] annotation toggle failed: {err}");
                }
            }
            "stop-annotate" => annotate::stop(app),
            "close-pins" => pin::close_all(app),
            "update" => update::check_from_tray(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}
