use std::sync::{atomic::AtomicBool, Mutex};

#[derive(Default)]
pub struct LaunchState {
    pub game_is_running: Mutex<bool>,
}

#[derive(Default)]
pub struct ExitState {
    pub close_allowed: AtomicBool,
}

#[derive(Default)]
pub struct UninstallModeState {
    pub enabled: AtomicBool,
}

pub struct AdminPassword(pub String);

pub fn load_admin_password() -> String {
    std::env::var("LAUNCHER_ADMIN_PASSWORD")
        .ok()
        .filter(|password| !password.is_empty())
        .unwrap_or_else(|| {
            option_env!("EMBEDDED_ADMIN_PASSWORD")
                .unwrap_or_default()
                .to_owned()
        })
}
