use crate::{
    admin::verify_admin_password,
    launcher::current_platform,
    models::{LocalGame, LocalGameRecord},
    state::{AdminPassword, EventModeState},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

fn data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn registry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_directory(app)?.join("local-games.json"))
}

fn read_records(app: &tauri::AppHandle) -> Result<Vec<LocalGameRecord>, String> {
    let path = registry_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("O cadastro de jogos locais está inválido: {error}"))
}

fn write_records(app: &tauri::AppHandle, records: &[LocalGameRecord]) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(records).map_err(|error| error.to_string())?;
    fs::write(registry_path(app)?, format!("{contents}\n")).map_err(|error| error.to_string())
}

fn response(record: LocalGameRecord) -> LocalGame {
    let executable_exists = Path::new(&record.executable_path).is_file();
    LocalGame {
        record,
        executable_exists,
    }
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Identificador de jogo local inválido.".into());
    }
    Ok(())
}

fn validate_executable(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Selecione um caminho absoluto para o executável.".into());
    }
    if !path.is_file() {
        return Err("O executável selecionado não foi encontrado.".into());
    }

    #[cfg(target_os = "windows")]
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| !extension.eq_ignore_ascii_case("exe"))
        .unwrap_or(true)
    {
        return Err("No Windows, selecione um arquivo .exe.".into());
    }

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let valid_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".x86_64"));
        if !valid_name {
            return Err("No Linux, selecione um arquivo terminado em .x86_64.".into());
        }
        let mode = fs::metadata(path)
            .map_err(|error| error.to_string())?
            .permissions()
            .mode();
        if mode & 0o111 == 0 {
            return Err("O arquivo .x86_64 não possui permissão de execução.".into());
        }
    }

    Ok(path.to_path_buf())
}

fn validate_color(accent: &str) -> Result<(), String> {
    if accent.len() == 7
        && accent.starts_with('#')
        && accent[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err("A cor de destaque deve usar o formato #RRGGBB.".into())
    }
}

fn cover_directory(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(data_directory(app)?.join("local-covers").join(id))
}

fn copy_cover(app: &tauri::AppHandle, id: &str, source: &Path) -> Result<(), String> {
    if !source.is_file() {
        return Err("A capa selecionada não foi encontrada.".into());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or("A capa precisa ser PNG, JPG, JPEG ou WEBP.")?;
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return Err("A capa precisa ser PNG, JPG, JPEG ou WEBP.".into()),
    };
    let directory = cover_directory(app, id)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::copy(source, directory.join("cover")).map_err(|error| error.to_string())?;
    fs::write(directory.join("mime.txt"), mime).map_err(|error| error.to_string())
}

fn new_id() -> Result<String, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    Ok(format!("local-{}-{nanos}", std::process::id()))
}

fn ensure_mutation_allowed(
    password: &str,
    admin_password: &AdminPassword,
    event_mode: &EventModeState,
) -> Result<(), String> {
    if event_mode.enabled.load(Ordering::SeqCst) {
        return Err("Desative o modo evento para alterar os jogos locais.".into());
    }
    verify_admin_password(password, admin_password)
}

#[tauri::command]
pub fn load_local_games(app: tauri::AppHandle) -> Result<Vec<LocalGame>, String> {
    Ok(read_records(&app)?.into_iter().map(response).collect())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_local_game(
    app: tauri::AppHandle,
    password: String,
    id: Option<String>,
    title: String,
    summary: String,
    accent: String,
    executable_path: String,
    cover_path: Option<String>,
    admin_password: State<AdminPassword>,
    event_mode: State<EventModeState>,
) -> Result<LocalGame, String> {
    ensure_mutation_allowed(&password, &admin_password, &event_mode)?;
    let title = title.trim();
    if title.is_empty() {
        return Err("Informe o título do jogo.".into());
    }
    validate_color(&accent)?;
    let executable = validate_executable(Path::new(executable_path.trim()))?;
    let working_directory = executable
        .parent()
        .ok_or("Não foi possível determinar a pasta do executável.")?
        .to_path_buf();
    let mut records = read_records(&app)?;
    let editing_existing = id.is_some();
    let id = id.unwrap_or(new_id()?);
    let existing_index = records.iter().position(|record| record.id == id);
    validate_id(&id)?;
    if editing_existing && existing_index.is_none() {
        return Err("O jogo local que seria editado não foi encontrado.".into());
    }
    let mut has_cover = existing_index
        .and_then(|index| records.get(index))
        .is_some_and(|record| record.has_cover);
    if let Some(path) = cover_path.filter(|path| !path.trim().is_empty()) {
        copy_cover(&app, &id, Path::new(path.trim()))?;
        has_cover = true;
    }
    let record = LocalGameRecord {
        id,
        title: title.to_owned(),
        summary: summary.trim().to_owned(),
        accent,
        platform: current_platform().to_owned(),
        executable_path: executable.to_string_lossy().into_owned(),
        working_directory: working_directory.to_string_lossy().into_owned(),
        has_cover,
    };
    match existing_index {
        Some(index) => records[index] = record.clone(),
        None => records.push(record.clone()),
    }
    write_records(&app, &records)?;
    Ok(response(record))
}

#[tauri::command]
pub fn remove_local_game(
    app: tauri::AppHandle,
    password: String,
    id: String,
    admin_password: State<AdminPassword>,
    event_mode: State<EventModeState>,
) -> Result<(), String> {
    ensure_mutation_allowed(&password, &admin_password, &event_mode)?;
    validate_id(&id)?;
    let mut records = read_records(&app)?;
    let previous_len = records.len();
    records.retain(|record| record.id != id);
    if records.len() == previous_len {
        return Err("O jogo local não foi encontrado.".into());
    }
    write_records(&app, &records)?;
    let cover = cover_directory(&app, &id)?;
    if cover.exists() {
        let _ = fs::remove_dir_all(cover);
    }
    Ok(())
}

#[tauri::command]
pub fn get_local_cover(app: tauri::AppHandle, id: String) -> Result<String, String> {
    validate_id(&id)?;
    let directory = cover_directory(&app, &id)?;
    let mime = fs::read_to_string(directory.join("mime.txt")).map_err(|error| error.to_string())?;
    let bytes = fs::read(directory.join("cover")).map_err(|error| error.to_string())?;
    Ok(format!(
        "data:{};base64,{}",
        mime.trim(),
        STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_hex_colors() {
        assert!(validate_color("#f6a43a").is_ok());
        assert!(validate_color("orange").is_err());
        assert!(validate_color("#12345").is_err());
    }
}
