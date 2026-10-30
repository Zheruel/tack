// Thin shell: opens the window and runs the Bun sidecar, which does all the real work.
// The UI asks for the sidecar's port and token with `server_info`.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{Manager, RunEvent};

#[derive(Clone, Serialize, serde::Deserialize)]
struct ServerInfo {
    port: u16,
    token: String,
}

#[derive(Default)]
struct Sidecar {
    info: Mutex<Option<Result<ServerInfo, String>>>,
    ready: Condvar,
    child: Mutex<Option<Child>>,
}

#[tauri::command]
async fn server_info(state: tauri::State<'_, Arc<Sidecar>>) -> Result<ServerInfo, String> {
    let sidecar = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = sidecar.info.lock().unwrap();
        let (guard, _) = sidecar
            .ready
            .wait_timeout_while(guard, Duration::from_secs(20), |info| info.is_none())
            .unwrap();
        guard.clone().unwrap_or_else(|| Err("Sidecar did not start in time".into()))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn sidecar_command() -> Command {
    if cfg!(debug_assertions) {
        // Dev: run the TypeScript source directly.
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
        let mut cmd = Command::new("bun");
        cmd.arg("server/index.ts").current_dir(root);
        cmd
    } else {
        // Release: the compiled binary bundled next to the app executable.
        let exe = std::env::current_exe().expect("current exe");
        Command::new(exe.with_file_name("tack-server"))
    }
}

fn start_sidecar(app: &tauri::AppHandle, sidecar: Arc<Sidecar>) {
    // TACK_DATA_DIR overrides the default, e.g. for a throwaway profile.
    let data_dir = std::env::var_os("TACK_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| app.path().app_data_dir().expect("app data dir"));
    let mut cmd = sidecar_command();
    cmd.env("TACK_DATA_DIR", data_dir)
        // Our stdin closing is the sidecar's signal to exit.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    let fail = |msg: String| {
        *sidecar.info.lock().unwrap() = Some(Err(msg));
        sidecar.ready.notify_all();
    };

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return fail(format!("Could not start sidecar: {e}")),
    };
    let stdout = child.stdout.take().unwrap();
    *sidecar.child.lock().unwrap() = Some(child);

    let sidecar = sidecar.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(json) = line.strip_prefix("TACK_READY ") {
                let info = serde_json::from_str::<ServerInfo>(json).map_err(|e| e.to_string());
                *sidecar.info.lock().unwrap() = Some(info);
                sidecar.ready.notify_all();
            } else {
                println!("{line}");
            }
        }
    });
}

pub fn run() {
    // macOS badges the text caret with an input-source indicator; off for Tack only.
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSString, NSUserDefaults};
        NSUserDefaults::standardUserDefaults().setBool_forKey(false, &NSString::from_str("TSMLanguageIndicatorEnabled"));
    }
    let sidecar = Arc::new(Sidecar::default());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(sidecar.clone())
        .invoke_handler(tauri::generate_handler![server_info])
        .setup({
            let sidecar = sidecar.clone();
            move |app| {
                start_sidecar(app.handle(), sidecar);
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tack");

    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = sidecar.child.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
