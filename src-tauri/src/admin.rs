use crate::state::{AdminPassword, ExitState, UninstallModeState};
use std::sync::atomic::Ordering;
use tauri::State;

#[tauri::command]
pub fn set_uninstall_mode(
    password: String,
    admin_password: State<AdminPassword>,
    uninstall_mode: State<UninstallModeState>,
) -> Result<bool, String> {
    if uninstall_mode.enabled.load(Ordering::SeqCst) {
        uninstall_mode.enabled.store(false, Ordering::SeqCst);
        return Ok(false);
    }
    if admin_password.0.is_empty() {
        return Err("Senha administrativa não configurada.".into());
    }
    if password != admin_password.0 {
        return Err("Senha administrativa incorreta.".into());
    }
    uninstall_mode.enabled.store(true, Ordering::SeqCst);
    Ok(true)
}

#[tauri::command]
pub fn exit_launcher(
    app: tauri::AppHandle,
    password: String,
    admin_password: State<AdminPassword>,
    exit_state: State<ExitState>,
) -> Result<(), String> {
    if admin_password.0.is_empty() {
        return Err("Senha administrativa não configurada. Defina LAUNCHER_ADMIN_PASSWORD antes de abrir o launcher.".into());
    }
    if password != admin_password.0 {
        return Err("Senha administrativa incorreta.".into());
    }
    exit_state.close_allowed.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}
