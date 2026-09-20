use crate::{
    models::{CatalogGame, CatalogResponse, SavedCatalogResponse},
    state::AdminPassword,
};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

const REMOTE_CATALOG_URL: &str = "https://drive.usercontent.google.com/download?id=151qlY18SLlxN5n6Yo3K9LeUfBWqYQQaX&export=download&confirm=t";
const BUNDLED_CATALOG: &str = include_str!("../../src/catalog.json");

const DRIVE_DOWNLOAD_BASE: &str = "https://drive.usercontent.google.com/download?id=";

fn is_drive_file_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn resolve_download_reference(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.starts_with("https://") {
        return Ok(value.to_owned());
    }
    if is_drive_file_id(value) {
        return Ok(format!(
            "{DRIVE_DOWNLOAD_BASE}{value}&export=download&confirm=t"
        ));
    }
    Err(format!(
        "Referência de download inválida: use um ID do Google Drive ou uma URL HTTPS ({value})."
    ))
}

fn parse_catalog(contents: &str) -> Result<Vec<CatalogGame>, String> {
    let mut games: Vec<CatalogGame> =
        serde_json::from_str(contents).map_err(|error| format!("Catálogo inválido: {error}"))?;
    if games.is_empty() {
        return Err("O catálogo não contém jogos.".into());
    }
    if games.iter().any(|game| {
        !is_drive_file_id(&game.id)
            || game.title.trim().is_empty()
            || game
                .builds
                .values()
                .any(|build| build.executable.trim().is_empty())
    }) {
        return Err("O catálogo contém dados obrigatórios inválidos.".into());
    }

    let mut identifiers = std::collections::HashSet::new();
    for game in &mut games {
        if !identifiers.insert(game.id.clone()) {
            return Err(format!("O catálogo contém o ID duplicado '{}'.", game.id));
        }
        if let Some(cover_url) = &mut game.cover_url {
            *cover_url = resolve_download_reference(cover_url)?;
        }
        for build in game.builds.values_mut() {
            build.download_url = resolve_download_reference(&build.download_url)?;
        }
    }
    Ok(games)
}

fn catalog_data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data).map_err(|error| error.to_string())?;
    Ok(app_data)
}

fn catalog_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(catalog_data_directory(app)?.join("catalog.json"))
}

fn catalog_override_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(catalog_data_directory(app)?.join("catalog.override.json"))
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
    let override_path = catalog_override_path(&app)?;
    if override_path.exists() {
        let contents = fs::read_to_string(&override_path).map_err(|error| error.to_string())?;
        return match parse_catalog(&contents) {
            Ok(games) => Ok(CatalogResponse {
                games,
                source: "local".into(),
                detail: None,
            }),
            Err(error) => Err(format!(
                "O catálogo editado localmente está inválido: {error}"
            )),
        };
    }

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

fn current_catalog_contents(app: &tauri::AppHandle) -> Result<String, String> {
    let override_path = catalog_override_path(app)?;
    if override_path.exists() {
        return fs::read_to_string(override_path).map_err(|error| error.to_string());
    }
    let cache_path = catalog_cache_path(app)?;
    if cache_path.exists() {
        return fs::read_to_string(cache_path).map_err(|error| error.to_string());
    }
    Ok(BUNDLED_CATALOG.to_owned())
}

fn backup_catalog(app: &tauri::AppHandle, contents: &str) -> Result<PathBuf, String> {
    let backup_directory = catalog_data_directory(app)?.join("catalog-backups");
    fs::create_dir_all(&backup_directory).map_err(|error| error.to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let backup_path = backup_directory.join(format!("catalog-{timestamp}.json"));
    fs::write(&backup_path, contents).map_err(|error| error.to_string())?;
    Ok(backup_path)
}

fn write_local_catalog(
    app: &tauri::AppHandle,
    contents: &str,
) -> Result<SavedCatalogResponse, String> {
    let games = parse_catalog(contents)?;
    let formatted = serde_json::to_string_pretty(
        &serde_json::from_str::<serde_json::Value>(contents)
            .map_err(|error| format!("Catálogo inválido: {error}"))?,
    )
    .map_err(|error| error.to_string())?;
    let previous_contents = current_catalog_contents(app)?;
    let backup_path = backup_catalog(app, &previous_contents)?;
    fs::write(catalog_override_path(app)?, format!("{formatted}\n"))
        .map_err(|error| error.to_string())?;
    Ok(SavedCatalogResponse {
        games,
        backup_path: backup_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn load_catalog(app: tauri::AppHandle) -> Result<CatalogResponse, String> {
    tauri::async_runtime::spawn_blocking(move || load_catalog_from_sources(app))
        .await
        .map_err(|error| format!("A atualização do catálogo foi interrompida: {error}"))?
}

#[tauri::command]
pub fn get_catalog_json(app: tauri::AppHandle) -> Result<String, String> {
    current_catalog_contents(&app)
}

#[tauri::command]
pub fn save_catalog(
    app: tauri::AppHandle,
    password: String,
    contents: String,
    admin_password: State<AdminPassword>,
) -> Result<SavedCatalogResponse, String> {
    if admin_password.0.is_empty() {
        return Err("Senha administrativa não configurada.".into());
    }
    if password != admin_password.0 {
        return Err("Senha administrativa incorreta.".into());
    }
    write_local_catalog(&app, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ids_and_expands_them_to_drive_urls() {
        let catalog = r##"[{"id":"game-1","title":"Game","summary":"Summary","accent":"#fff","coverUrl":"cover_1","builds":{"windows":{"downloadUrl":"build-1","executable":"game.exe"}}}]"##;
        let games = parse_catalog(catalog).unwrap();
        assert_eq!(
            games[0].cover_url.as_deref(),
            Some("https://drive.usercontent.google.com/download?id=cover_1&export=download&confirm=t")
        );
        assert_eq!(
            games[0].builds["windows"].download_url,
            "https://drive.usercontent.google.com/download?id=build-1&export=download&confirm=t"
        );
    }

    #[test]
    fn keeps_existing_https_urls_unchanged() {
        let url = "https://example.com/game.zip";
        assert_eq!(resolve_download_reference(url).unwrap(), url);
        assert!(!parse_catalog(BUNDLED_CATALOG).unwrap().is_empty());
    }

    #[test]
    fn rejects_unsafe_references_and_duplicate_game_ids() {
        assert!(resolve_download_reference("http://example.com/file").is_err());
        let catalog = r##"[{"id":"same","title":"One","summary":"Summary","accent":"#fff","builds":{"windows":{"downloadUrl":"build-1","executable":"one.exe"}}},{"id":"same","title":"Two","summary":"Summary","accent":"#fff","builds":{"windows":{"downloadUrl":"build-2","executable":"two.exe"}}}]"##;
        assert!(parse_catalog(catalog).unwrap_err().contains("duplicado"));
    }
}
