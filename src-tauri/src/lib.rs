use std::{
    env,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

#[derive(Clone)]
struct BackendConfig {
    port: u16,
    token: String,
    database_path: PathBuf,
}

#[derive(Clone)]
struct BackendState {
    child: Arc<Mutex<Option<Child>>>,
    config: BackendConfig,
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| error.to_string())
}

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must be inside the repository")
        .to_path_buf()
}

fn node_filename() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn desktop_resource_root(resource_dir: &Path) -> PathBuf {
    let candidates = [
        resource_dir.join("resources").join("desktop"),
        resource_dir.join("_up_").join("dist").join("desktop"),
        resource_dir.join("dist").join("desktop"),
        resource_dir.join("desktop"),
        resource_dir.to_path_buf(),
    ];
    candidates
        .into_iter()
        .find(|candidate| {
            candidate
                .join("backend")
                .join("desktop-backend.mjs")
                .exists()
        })
        .unwrap_or_else(|| resource_dir.join("dist").join("desktop"))
}

fn spawn_backend(app: &tauri::App, config: &BackendConfig) -> Result<Child, String> {
    let mut command = if cfg!(debug_assertions) {
        let mut command = Command::new("pnpm");
        command
            .arg("exec")
            .arg("tsx")
            .arg("src/desktop-backend.ts")
            .current_dir(repository_root());
        command
    } else {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        let desktop = desktop_resource_root(&resources);
        let mut command = Command::new(desktop.join("node").join(node_filename()));
        command
            .arg(desktop.join("backend").join("desktop-backend.mjs"))
            .current_dir(desktop);
        command
    };

    command
        .env("FINORA_HOST", "127.0.0.1")
        .env("FINORA_PORT", config.port.to_string())
        .env("FINORA_DATABASE_PATH", &config.database_path)
        .env("FINORA_DESKTOP_TOKEN", &config.token)
        .env("NODE_ENV", "production")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("failed to start the Finora backend: {error}"))
}

fn http_request(port: u16, request: &str, timeout: Duration) -> Result<String, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream =
        TcpStream::connect_timeout(&address, timeout).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    Ok(response)
}

fn wait_for_backend(port: u16, deadline: Duration) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < deadline {
        let request = "GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
        if let Ok(response) = http_request(port, request, Duration::from_millis(800)) {
            if response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200") {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("desktop backend did not become healthy before the startup timeout".into())
}

fn request_backend_shutdown(config: &BackendConfig) {
    let request = format!(
        "POST /v1/desktop/shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Finora-Desktop-Token: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        config.token
    );
    let _ = http_request(config.port, &request, Duration::from_secs(2));
}

fn stop_backend(state: &BackendState) {
    request_backend_shutdown(&state.config);
    let Ok(mut child_slot) = state.child.lock() else {
        return;
    };
    if let Some(child) = child_slot.as_mut() {
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < Duration::from_secs(4) => {
                    thread::sleep(Duration::from_millis(100));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                Err(_) => break,
            }
        }
    }
    *child_slot = None;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state_slot: Arc<Mutex<Option<BackendState>>> = Arc::new(Mutex::new(None));
    let cleanup_slot = state_slot.clone();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _directory| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_process::init());

    // The updater plugin backs the one-click "Update now" button in the UI:
    // it downloads the signed release artifact advertised by latest.json,
    // verifies it against the embedded public key, installs it, and the UI then
    // asks the process plugin to relaunch. Desktop targets only.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(move |app| {
            let data_directory = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            std::fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
            let config = BackendConfig {
                port: free_port()?,
                token: Uuid::new_v4().simple().to_string(),
                database_path: data_directory.join("finora.db"),
            };
            let child = spawn_backend(app, &config)?;
            let state = BackendState {
                child: Arc::new(Mutex::new(Some(child))),
                config: config.clone(),
            };
            *state_slot.lock().map_err(|error| error.to_string())? = Some(state);

            let app_handle = app.handle().clone();
            thread::spawn(move || {
                if let Err(error) = wait_for_backend(config.port, Duration::from_secs(30)) {
                    eprintln!("{error}");
                    app_handle.exit(1);
                    return;
                }
                let url = format!("http://127.0.0.1:{}/?session={}", config.port, config.token);
                let Ok(parsed_url) = url.parse() else {
                    eprintln!("failed to construct the desktop URL");
                    app_handle.exit(1);
                    return;
                };
                if let Err(error) =
                    WebviewWindowBuilder::new(&app_handle, "main", WebviewUrl::External(parsed_url))
                        .title("Finora - Local Finance")
                        .inner_size(1280.0, 840.0)
                        .min_inner_size(900.0, 620.0)
                        .resizable(true)
                        .build()
                {
                    eprintln!("failed to create the Finora window: {error}");
                    app_handle.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Finora desktop application")
        .run(move |_app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Ok(slot) = cleanup_slot.lock() {
                    if let Some(state) = slot.as_ref() {
                        stop_backend(state);
                    }
                }
            }
        });
}
