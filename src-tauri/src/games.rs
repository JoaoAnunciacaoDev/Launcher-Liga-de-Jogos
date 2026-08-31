use crate::{
    models::{DownloadProgress, Installation},
    state::UninstallModeState,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs,
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};
use tauri::{Emitter, Manager, State};
use zip::ZipArchive;

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

fn app_data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

fn cover_directory(app: &tauri::AppHandle, game_id: &str) -> Result<PathBuf, String> {
    safe_game_id(game_id)?;
    Ok(app_data_directory(app)?.join("covers").join(game_id))
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
    fs::write(&mime_path, mime).map_err(|error| error.to_string())?;
    cover_as_data_url(&cover_path, &mime_path)
}

#[tauri::command]
pub async fn get_cached_cover(
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
    let install_path = app_data_directory(app)?.join("games").join(game_id);
    let executable_path = install_path.join(executable);
    Ok(Installation {
        install_path: install_path.to_string_lossy().into_owned(),
        executable_path: executable_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn get_installation(
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
pub async fn install_game(
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
pub async fn uninstall_game(
    app: tauri::AppHandle,
    game_id: String,
    uninstall_mode: State<'_, UninstallModeState>,
) -> Result<(), String> {
    if !uninstall_mode.enabled.load(Ordering::SeqCst) {
        return Err("A desinstalação está bloqueada. Habilite o gerenciamento de instalações com a senha administrativa.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        safe_game_id(&game_id)?;
        let app_data = app_data_directory(&app)?;
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
