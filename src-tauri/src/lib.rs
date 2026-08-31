use std::{fs, fs::File, io, path::{Path, PathBuf}, process::Command, sync::{atomic::{AtomicBool, Ordering}, Mutex}};
use serde::Serialize;
use tauri::{Emitter, Manager, State, WebviewWindow, WindowEvent};
use zip::ZipArchive;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Installation { install_path: String, executable_path: String }

#[derive(Default)]
struct LaunchState { game_is_running: Mutex<bool> }

#[derive(Default)]
struct ExitState { close_allowed: AtomicBool }

struct AdminPassword(String);

fn load_admin_password() -> String {
    // Em desenvolvimento, carrega o .env na raiz do projeto sem sobrescrever uma variável já definida pelo sistema.
    let _ = dotenvy::dotenv();
    std::env::var("LAUNCHER_ADMIN_PASSWORD").unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn wait_for_game_window(process_id: u32) -> bool {
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow};

    struct WindowSearch { process_id: u32, window: HWND }

    unsafe extern "system" fn find_window_owned_by_process(hwnd: HWND, context: LPARAM) -> BOOL {
        let search = unsafe { &mut *(context as *mut WindowSearch) };
        let mut window_process_id = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut window_process_id); }
        if window_process_id == search.process_id && unsafe { IsWindowVisible(hwnd) } != 0 {
            search.window = hwnd;
            return 0;
        }
        1
    }

    for _ in 0..50 {
        let mut search = WindowSearch { process_id, window: std::ptr::null_mut() };
        unsafe { EnumWindows(Some(find_window_owned_by_process), &mut search as *mut WindowSearch as isize); }
        if !search.window.is_null() {
            unsafe { SetForegroundWindow(search.window); }
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn safe_game_id(game_id: &str) -> Result<(), String> {
    if game_id.is_empty() || !game_id.chars().all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_') { return Err("Identificador de jogo inválido.".into()); }
    Ok(())
}

fn installation(app: &tauri::AppHandle, game_id: &str, executable: &str) -> Result<Installation, String> {
    safe_game_id(game_id)?;
    let base = app.path().app_data_dir().map_err(|error| error.to_string())?.join("games").join(game_id);
    let executable_path = base.join(executable);
    Ok(Installation { install_path: base.to_string_lossy().into_owned(), executable_path: executable_path.to_string_lossy().into_owned() })
}

#[tauri::command]
fn get_installation(app: tauri::AppHandle, game_id: String, executable: String) -> Result<Option<Installation>, String> {
    let installation = installation(&app, &game_id, &executable)?;
    Ok(Path::new(&installation.executable_path).is_file().then_some(installation))
}

#[tauri::command]
fn install_game(app: tauri::AppHandle, game_id: String, source_path: String, executable: String) -> Result<Installation, String> {
    let installation = installation(&app, &game_id, &executable)?;
    let source = PathBuf::from(source_path);
    if !source.is_file() { return Err("O arquivo ZIP do jogo não foi encontrado.".into()); }
    let install_path = PathBuf::from(&installation.install_path);
    fs::create_dir_all(&install_path).map_err(|error| error.to_string())?;
    let file = File::open(&source).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let relative_path = entry.enclosed_name().ok_or("O ZIP contém um caminho inválido.")?.to_owned();
        let destination = install_path.join(relative_path);
        if entry.is_dir() { fs::create_dir_all(destination).map_err(|error| error.to_string())?; }
        else {
            if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
            let mut output = File::create(destination).map_err(|error| error.to_string())?;
            io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
        }
    }
    if !Path::new(&installation.executable_path).is_file() { return Err("O executável declarado não existe dentro do ZIP.".into()); }
    Ok(installation)
}

#[tauri::command]
async fn launch_game(window: WebviewWindow, state: State<'_, LaunchState>, executable: String, working_directory: String) -> Result<(), String> {
    let executable = PathBuf::from(executable);
    let working_directory = PathBuf::from(working_directory);
    if !executable.is_file() { return Err("O executável do jogo não foi encontrado.".into()); }
    if !working_directory.is_dir() { return Err("A pasta de instalação do jogo não foi encontrada.".into()); }
    let mut game_is_running = state.game_is_running.lock().map_err(|_| "Não foi possível verificar o estado do jogo.")?;
    if *game_is_running { return Err("Já existe um jogo em execução.".into()); }
    let mut child = Command::new(&executable)
        .current_dir(&working_directory)
        .spawn()
        .map_err(|error| format!("Não foi possível executar {}: {error}", executable.display()))?;
    let process_id = child.id();
    *game_is_running = true;
    drop(game_is_running);
    let app_handle = window.app_handle().clone();
    let launcher = window.clone();
    std::thread::spawn(move || {
        #[cfg(target_os = "windows")]
        if wait_for_game_window(process_id) {
            // O launcher não é encerrado: ele só sai da frente quando a janela do jogo existe.
            let _ = launcher.hide();
        }
        if let Err(error) = child.wait() { eprintln!("O jogo foi iniciado, mas ocorreu um erro ao aguardar seu encerramento: {error}"); }
        if let Ok(mut game_is_running) = app_handle.state::<LaunchState>().game_is_running.lock() { *game_is_running = false; }
        let _ = app_handle.emit("game-ended", ());
        if let Some(launcher) = app_handle.get_webview_window("main") { let _ = launcher.show(); let _ = launcher.set_focus(); }
    });
    Ok(())
}

#[tauri::command]
fn exit_launcher(app: tauri::AppHandle, password: String, admin_password: State<AdminPassword>, exit_state: State<ExitState>) -> Result<(), String> {
    if admin_password.0.is_empty() { return Err("Senha administrativa não configurada. Defina LAUNCHER_ADMIN_PASSWORD antes de abrir o launcher.".into()); }
    if password != admin_password.0 { return Err("Senha administrativa incorreta.".into()); }
    exit_state.close_allowed.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(LaunchState::default())
        .manage(ExitState::default())
        .manage(AdminPassword(load_admin_password()))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_installation, install_game, launch_game, exit_launcher])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<ExitState>().close_allowed.load(Ordering::SeqCst) { api.prevent_close(); }
            }
        })
        .run(tauri::generate_context!())
        .expect("erro ao executar o launcher");
}
