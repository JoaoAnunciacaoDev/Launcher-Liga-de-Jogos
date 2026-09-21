mod admin;
mod catalog;
mod games;
mod launcher;
mod models;
mod state;

use state::{load_admin_password, AdminPassword, EventModeState, ExitState, LaunchState};
use std::sync::atomic::Ordering;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(LaunchState::default())
        .manage(ExitState::default())
        .manage(EventModeState::default())
        .manage(AdminPassword(load_admin_password()))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("A janela principal não foi encontrada.")?;

            window.set_decorations(false)?;
            window.set_resizable(false)?;
            window.set_fullscreen(true)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launcher::current_platform,
            catalog::load_catalog,
            catalog::get_catalog_json,
            catalog::save_catalog,
            catalog::sync_catalog_from_drive,
            games::get_cached_cover,
            games::get_installation,
            games::install_game,
            games::uninstall_game,
            launcher::launch_game,
            admin::event_mode_enabled,
            admin::toggle_event_mode,
            admin::exit_launcher
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let event_mode_enabled = window
                    .state::<EventModeState>()
                    .enabled
                    .load(Ordering::SeqCst);
                let close_allowed = window
                    .state::<ExitState>()
                    .close_allowed
                    .load(Ordering::SeqCst);
                if event_mode_enabled && !close_allowed {
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("erro ao executar o launcher");
}
