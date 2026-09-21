use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub install_path: String,
    pub executable_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub game_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogBuild {
    pub download_url: String,
    pub executable: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogGame {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub accent: String,
    #[serde(default, alias = "cover_url")]
    pub cover_url: Option<String>,
    pub builds: BTreeMap<String, CatalogBuild>,
}

#[derive(Serialize)]
pub struct CatalogResponse {
    pub games: Vec<CatalogGame>,
    pub source: String,
    pub detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCatalogResponse {
    pub games: Vec<CatalogGame>,
    pub backup_path: String,
    pub catalog_path: String,
}
