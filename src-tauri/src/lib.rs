use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State, WebviewWindow, WindowEvent};
use zip::ZipArchive;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Installation {
    install_path: String,
    executable_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    game_id: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogBuild {
    download_url: String,
    executable: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogGame {
    id: String,
    title: String,
    summary: String,
    accent: String,
    #[serde(default, alias = "cover_url")]
    cover_url: Option<String>,
    builds: BTreeMap<String, CatalogBuild>,
}

#[derive(Serialize)]
struct CatalogResponse {
    games: Vec<CatalogGame>,
    source: String,
    detail: Option<String>,
}

const REMOTE_CATALOG_URL: &str = "https://drive.usercontent.google.com/download?id=151qlY18SLlxN5n6Yo3K9LeUfBWqYQQaX&export=download&confirm=t";
const BUNDLED_CATALOG: &str = include_str!("../../src/catalog.json");

#[derive(Default)]
struct LaunchState {
    game_is_running: Mutex<bool>,
}

#[derive(Default)]
struct ExitState {
    close_allowed: AtomicBool,
}

#[derive(Default)]
struct UninstallModeState {
    enabled: AtomicBool,
}

struct AdminPassword(String);

fn load_admin_password() -> String {
    std::env::var("LAUNCHER_ADMIN_PASSWORD")
        .ok()
        .filter(|password| !password.is_empty())
        .unwrap_or_else(|| {
            option_env!("EMBEDDED_ADMIN_PASSWORD")
                .unwrap_or_default()
                .to_owned()
        })
}

#[tauri::command]
fn current_platform() -> &'static str {
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

fn parse_catalog(contents: &str) -> Result<Vec<CatalogGame>, String> {
    let games: Vec<CatalogGame> =
        serde_json::from_str(contents).map_err(|error| format!("Catálogo inválido: {error}"))?;
    if games.is_empty() {
        return Err("O catálogo não contém jogos.".into());
    }
    if games.iter().any(|game| {
        game.id.is_empty()
            || game.title.is_empty()
            || game
                .cover_url
                .as_deref()
                .is_some_and(|url| !url.starts_with("https://"))
            || game.builds.values().any(|build| {
                !build.download_url.starts_with("https://") || build.executable.is_empty()
            })
    }) {
        return Err("O catálogo contém dados obrigatórios inválidos.".into());
    }
    Ok(games)
}

fn catalog_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data).map_err(|error| error.to_string())?;
    Ok(app_data.join("catalog.json"))
}

fn cached_or_bundled(
    cached_catalog: Option<Vec<CatalogGame>>,
    fallback_catalog: Vec<CatalogGame>,
    detail: String,
) -> CatalogResponse {
    match cached_catalog {
        Some(games) => CatalogResponse {
            games,
            source: "cache".into(),
            detail: Some(detail),
        },
        None => CatalogResponse {
            games: fallback_catalog,
            source: "bundled".into(),
            detail: Some(detail),
        },
    }
}

fn load_catalog_from_sources(app: tauri::AppHandle) -> Result<CatalogResponse, String> {
    let cache_path = catalog_cache_path(&app)?;
    let cached_contents = fs::read_to_string(&cache_path).ok();
    let cached_catalog = cached_contents
        .as_deref()
        .and_then(|contents| parse_catalog(contents).ok());
    let fallback_catalog = parse_catalog(BUNDLED_CATALOG)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;
    let remote_contents = client
        .get(REMOTE_CATALOG_URL)
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.text());
    match remote_contents {
        Ok(contents) => match parse_catalog(&contents) {
            Ok(remote_catalog) => {
                if cached_contents.as_deref() != Some(contents.as_str()) {
                    fs::write(cache_path, contents).map_err(|error| error.to_string())?;
                }
                Ok(CatalogResponse {
                    games: remote_catalog,
                    source: "remote".into(),
                    detail: None,
                })
            }
            Err(error) => Ok(cached_or_bundled(cached_catalog, fallback_catalog, error)),
        },
        Err(error) => Ok(cached_or_bundled(
            cached_catalog,
            fallback_catalog,
            error.to_string(),
        )),
    }
}

#[tauri::command]
async fn load_catalog(app: tauri::AppHandle) -> Result<CatalogResponse, String> {
    tauri::async_runtime::spawn_blocking(move || load_catalog_from_sources(app))
        .await
        .map_err(|error| format!("A atualização do catálogo foi interrompida: {error}"))?
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

fn safe_game_id(game_id: &str) -> Result<(), String> {
    if game_id.is_empty()
        || !game_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("Identificador de jogo inválido.".into());
    }
    Ok(())
}

fn cover_directory(app: &tauri::AppHandle, game_id: &str) -> Result<PathBuf, String> {
    safe_game_id(game_id)?;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("covers")
        .join(game_id))
}

fn cover_as_data_url(cover_path: &Path, mime_path: &Path) -> Result<String, String> {
    let mime = fs::read_to_string(mime_path).map_err(|error| error.to_string())?;
    let bytes = fs::read(cover_path).map_err(|error| error.to_string())?;
    Ok(format!(
        "data:{};base64,{}",
        mime.trim(),
        STANDARD.encode(bytes)
    ))
}

fn cache_cover(
    app: tauri::AppHandle,
    game_id: String,
    cover_url: String,
) -> Result<String, String> {
    if !cover_url.starts_with("https://") {
        return Err("O endereço da capa deve usar HTTPS.".into());
    }
    let directory = cover_directory(&app, &game_id)?;
    let cover_path = directory.join("cover");
    let source_path = directory.join("source.txt");
    let mime_path = directory.join("mime.txt");
    if fs::read_to_string(&source_path).ok().as_deref() == Some(cover_url.as_str())
        && cover_path.is_file()
        && mime_path.is_file()
    {
        return cover_as_data_url(&cover_path, &mime_path);
    }
    let response = reqwest::blocking::Client::new()
        .get(&cover_url)
        .send()
        .map_err(|error| format!("Não foi possível baixar a capa: {error}"))?
        .error_for_status()
        .map_err(|error| format!("O servidor recusou a capa: {error}"))?;
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !mime.starts_with("image/") {
        return Err("O arquivo da capa não é uma imagem válida.".into());
    }
    let bytes = response
        .bytes()
        .map_err(|error| format!("Não foi possível ler a capa: {error}"))?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(&cover_path, bytes).map_err(|error| error.to_string())?;
    fs::write(&source_path, cover_url).map_err(|error| error.to_string())?;
    fs::write(&mime_path, &mime).map_err(|error| error.to_string())?;
    cover_as_data_url(&cover_path, &mime_path)
}

#[tauri::command]
async fn get_cached_cover(
    app: tauri::AppHandle,
    game_id: String,
    cover_url: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || cache_cover(app, game_id, cover_url))
        .await
        .map_err(|error| format!("O cache da capa foi interrompido: {error}"))?
}

fn installation(
    app: &tauri::AppHandle,
    game_id: &str,
    executable: &str,
) -> Result<Installation, String> {
    safe_game_id(game_id)?;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("games")
        .join(game_id);
    let executable_path = base.join(executable);
    Ok(Installation {
        install_path: base.to_string_lossy().into_owned(),
        executable_path: executable_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn get_installation(
    app: tauri::AppHandle,
    game_id: String,
    executable: String,
) -> Result<Option<Installation>, String> {
    let installation = installation(&app, &game_id, &executable)?;
    Ok(Path::new(&installation.executable_path)
        .is_file()
        .then_some(installation))
}

fn download_and_install(
    app: tauri::AppHandle,
    game_id: String,
    download_url: String,
    executable: String,
) -> Result<Installation, String> {
    let installation = installation(&app, &game_id, &executable)?;
    if !download_url.starts_with("https://") {
        return Err("O endereço de download deve usar HTTPS.".into());
    }
    let install_path = PathBuf::from(&installation.install_path);
    fs::create_dir_all(&install_path).map_err(|error| error.to_string())?;
    let mut response = reqwest::blocking::Client::new()
        .get(download_url)
        .send()
        .map_err(|error| format!("Não foi possível baixar o jogo: {error}"))?
        .error_for_status()
        .map_err(|error| format!("O servidor recusou o download: {error}"))?;
    let total_bytes = response.content_length();
    let archive_path = install_path.join(".download.zip");
    let mut archive_file = File::create(&archive_path).map_err(|error| error.to_string())?;
    let mut downloaded_bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes_read = response
            .read(&mut buffer)
            .map_err(|error| format!("Erro durante o download: {error}"))?;
        if bytes_read == 0 {
            break;
        }
        archive_file
            .write_all(&buffer[..bytes_read])
            .map_err(|error| error.to_string())?;
        downloaded_bytes += bytes_read as u64;
        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                game_id: game_id.clone(),
                downloaded_bytes,
                total_bytes,
            },
        );
    }
    drop(archive_file);
    let file = File::open(&archive_path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let relative_path = entry
            .enclosed_name()
            .ok_or("O ZIP contém um caminho inválido.")?
            .to_owned();
        let destination = install_path.join(relative_path);
        if entry.is_dir() {
            fs::create_dir_all(destination).map_err(|error| error.to_string())?;
        } else {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut output = File::create(destination).map_err(|error| error.to_string())?;
            io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
        }
    }
    let _ = fs::remove_file(archive_path);
    if !Path::new(&installation.executable_path).is_file() {
        return Err("O executável declarado não existe dentro do ZIP.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable_path = Path::new(&installation.executable_path);
        let mut permissions = fs::metadata(executable_path)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(permissions.mode() | 0o111);
        fs::set_permissions(executable_path, permissions).map_err(|error| error.to_string())?;
    }
    Ok(installation)
}

#[tauri::command]
async fn install_game(
    app: tauri::AppHandle,
    game_id: String,
    download_url: String,
    executable: String,
) -> Result<Installation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        download_and_install(app, game_id, download_url, executable)
    })
    .await
    .map_err(|error| format!("A instalação foi interrompida: {error}"))?
}

#[tauri::command]
async fn uninstall_game(
    app: tauri::AppHandle,
    game_id: String,
    uninstall_mode: State<'_, UninstallModeState>,
) -> Result<(), String> {
    if !uninstall_mode.enabled.load(Ordering::SeqCst) {
        return Err("A desinstalação está bloqueada. Habilite o gerenciamento de instalações com a senha administrativa.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        safe_game_id(&game_id)?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        for path in [
            app_data.join("games").join(&game_id),
            app_data.join("covers").join(&game_id),
        ] {
            if path.exists() {
                fs::remove_dir_all(path).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("A desinstalação foi interrompida: {error}"))?
}

#[tauri::command]
async fn launch_game(
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

#[tauri::command]
fn set_uninstall_mode(
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
fn exit_launcher(
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(LaunchState::default())
        .manage(ExitState::default())
        .manage(UninstallModeState::default())
        .manage(AdminPassword(load_admin_password()))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            current_platform,
            load_catalog,
            get_cached_cover,
            get_installation,
            install_game,
            uninstall_game,
            launch_game,
            set_uninstall_mode,
            exit_launcher
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
