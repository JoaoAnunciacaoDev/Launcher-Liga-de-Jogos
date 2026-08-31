use crate::state::LaunchState;
use std::{path::PathBuf, process::Command};
use tauri::{Emitter, Manager, State, WebviewWindow};

#[tauri::command]
pub fn current_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        "unsupported"
    }
}

#[cfg(target_os = "windows")]
fn wait_for_game_window(process_id: u32) -> bool {
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow,
    };

    struct WindowSearch {
        process_id: u32,
        window: HWND,
    }

    unsafe extern "system" fn find_window_owned_by_process(hwnd: HWND, context: LPARAM) -> BOOL {
        let search = unsafe { &mut *(context as *mut WindowSearch) };
        let mut window_process_id = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut window_process_id);
        }
        if window_process_id == search.process_id && unsafe { IsWindowVisible(hwnd) } != 0 {
            search.window = hwnd;
            return 0;
        }
        1
    }

    for _ in 0..50 {
        let mut search = WindowSearch {
            process_id,
            window: std::ptr::null_mut(),
        };
        unsafe {
            EnumWindows(
                Some(find_window_owned_by_process),
                &mut search as *mut WindowSearch as isize,
            );
        }
        if !search.window.is_null() {
            unsafe {
                SetForegroundWindow(search.window);
            }
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[tauri::command]
pub async fn launch_game(
    window: WebviewWindow,
    state: State<'_, LaunchState>,
    executable: String,
    working_directory: String,
) -> Result<(), String> {
    let executable = PathBuf::from(executable);
    let working_directory = PathBuf::from(working_directory);
    if !executable.is_file() {
        return Err("O executável do jogo não foi encontrado.".into());
    }
    if !working_directory.is_dir() {
        return Err("A pasta de instalação do jogo não foi encontrada.".into());
    }
    let mut game_is_running = state
        .game_is_running
        .lock()
        .map_err(|_| "Não foi possível verificar o estado do jogo.")?;
    if *game_is_running {
        return Err("Já existe um jogo em execução.".into());
    }
    let mut child = Command::new(&executable)
        .current_dir(&working_directory)
        .spawn()
        .map_err(|error| {
            format!(
                "Não foi possível executar {}: {error}",
                executable.display()
            )
        })?;
    #[cfg(target_os = "windows")]
    let process_id = child.id();
    *game_is_running = true;
    drop(game_is_running);
    let app_handle = window.app_handle().clone();
    #[cfg(target_os = "windows")]
    let launcher = window.clone();
    std::thread::spawn(move || {
        #[cfg(target_os = "windows")]
        if wait_for_game_window(process_id) {
            let _ = launcher.hide();
        }
        if let Err(error) = child.wait() {
            eprintln!(
                "O jogo foi iniciado, mas ocorreu um erro ao aguardar seu encerramento: {error}"
            );
        }
        if let Ok(mut game_is_running) = app_handle.state::<LaunchState>().game_is_running.lock() {
            *game_is_running = false;
        }
        let _ = app_handle.emit("game-ended", ());
        if let Some(launcher) = app_handle.get_webview_window("main") {
            let _ = launcher.show();
            let _ = launcher.set_focus();
        }
    });
    Ok(())
}
