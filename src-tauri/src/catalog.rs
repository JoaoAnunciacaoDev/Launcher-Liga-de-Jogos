use crate::models::{CatalogGame, CatalogResponse};
use std::{fs, path::PathBuf, time::Duration};
use tauri::Manager;

const REMOTE_CATALOG_URL: &str = "https://drive.usercontent.google.com/download?id=151qlY18SLlxN5n6Yo3K9LeUfBWqYQQaX&export=download&confirm=t";
const BUNDLED_CATALOG: &str = include_str!("../../src/catalog.json");

fn parse_catalog(contents: &str) -> Result<Vec<CatalogGame>, String> {
    let games: Vec<CatalogGame> =
        serde_json::from_str(contents).map_err(|error| format!("Catálogo inválido: {error}"))?;
    if games.is_empty() {
        return Err("O catálogo não contém jogos.".into());
    }
    if games.iter().any(|game: &CatalogGame| {
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
pub async fn load_catalog(app: tauri::AppHandle) -> Result<CatalogResponse, String> {
    tauri::async_runtime::spawn_blocking(move || load_catalog_from_sources(app))
        .await
        .map_err(|error| format!("A atualização do catálogo foi interrompida: {error}"))?
}
