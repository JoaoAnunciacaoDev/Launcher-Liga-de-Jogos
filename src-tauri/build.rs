use std::{env, fs, path::PathBuf};

fn password_from_dotenv() -> Option<String> {
    let dotenv_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.env");
    let contents = fs::read_to_string(dotenv_path).ok()?;
    contents.lines().find_map(|line| {
        let line = line.trim();
        let value = line.strip_prefix("LAUNCHER_ADMIN_PASSWORD=")?.trim();
        let value = value.trim_matches('"').trim_matches('\'');
        (!value.is_empty()).then(|| value.to_owned())
    })
}

fn main() {
    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-env-changed=LAUNCHER_ADMIN_PASSWORD");

    let password = env::var("LAUNCHER_ADMIN_PASSWORD").ok().filter(|value| !value.is_empty())
        .or_else(password_from_dotenv)
        .expect("Defina LAUNCHER_ADMIN_PASSWORD no ambiente ou no arquivo .env antes de compilar o launcher.");

    // A senha é uma barreira de administração para o modo quiosque. Ela é incorporada ao binário por decisão do projeto.
    println!("cargo:rustc-env=EMBEDDED_ADMIN_PASSWORD={password}");
    tauri_build::build()
}
