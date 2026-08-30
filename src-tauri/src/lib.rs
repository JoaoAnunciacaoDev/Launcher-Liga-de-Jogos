use std::{path::PathBuf, process::Command};
use tauri::{Manager, WebviewWindow};

/// Starts an installed game while keeping the launcher alive in the background.
/// When the child process ends, the launcher is shown and focused again.
#[tauri::command]
async fn launch_game(window: WebviewWindow, executable: String, working_directory: String) -> Result<(), String> {
    let executable = PathBuf::from(executable);
    let working_directory = PathBuf::from(working_directory);
    if executable.as_os_str().is_empty() || !executable.is_file() { return Err("O executável do jogo não foi encontrado.".into()); }
    if !working_directory.is_dir() { return Err("A pasta de instalação do jogo não foi encontrada.".into()); }
    window.hide().map_err(|error| error.to_string())?;
    let app_handle = window.app_handle().clone();
    std::thread::spawn(move || {
        let launch_result = Command::new(&executable).current_dir(&working_directory).spawn().and_then(|mut child| child.wait());
        if let Err(error) = launch_result { eprintln!("Não foi possível executar {}: {error}", executable.display()); }
        if let Some(launcher) = app_handle.get_webview_window("main") { let _ = launcher.show(); let _ = launcher.set_focus(); }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default().plugin(tauri_plugin_opener::init()).invoke_handler(tauri::generate_handler![launch_game]).run(tauri::generate_context!()).expect("erro ao executar o launcher");
}
