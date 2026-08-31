mod admin;
mod catalog;
mod games;
mod launcher;
mod models;
mod state;

use state::{load_admin_password, AdminPassword, ExitState, LaunchState, UninstallModeState};
use std::sync::atomic::Ordering;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(LaunchState::default())
        .manage(ExitState::default())
        .manage(UninstallModeState::default())
        .manage(AdminPassword(load_admin_password()))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            launcher::current_platform,
            catalog::load_catalog,
            games::get_cached_cover,
            games::get_installation,
            games::install_game,
            games::uninstall_game,
            launcher::launch_game,
            admin::set_uninstall_mode,
            admin::exit_launcher
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !window
                    .state::<ExitState>()
                    .close_allowed
                    .load(Ordering::SeqCst)
                {
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("erro ao executar o launcher");
}
