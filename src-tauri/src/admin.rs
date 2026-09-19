use crate::state::{AdminPassword, EventModeState, ExitState};
use std::sync::atomic::Ordering;
use tauri::State;

#[tauri::command]
pub fn event_mode_enabled(event_mode: State<EventModeState>) -> bool {
    event_mode.enabled.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn toggle_event_mode(
    password: String,
    admin_password: State<AdminPassword>,
    event_mode: State<EventModeState>,
) -> Result<bool, String> {
    if admin_password.0.is_empty() {
        return Err("Senha administrativa não configurada.".into());
    }
    if password != admin_password.0 {
        return Err("Senha administrativa incorreta.".into());
    }
    let enabled = !event_mode.enabled.load(Ordering::SeqCst);
    event_mode.enabled.store(enabled, Ordering::SeqCst);
    Ok(enabled)
}

#[tauri::command]
pub fn exit_launcher(
    app: tauri::AppHandle,
    event_mode: State<EventModeState>,
    exit_state: State<ExitState>,
) -> Result<(), String> {
    if event_mode.enabled.load(Ordering::SeqCst) {
        return Err("Desative o modo evento para fechar o launcher.".into());
    }
    exit_state.close_allowed.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}
