use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};
#[cfg(desktop)]
use tauri::{WebviewWindow, WindowEvent};

/// I file di Calchy stanno in ~/.local/share/io.github.calchy/ (su Android nella
/// cartella privata dell'app). Sono ammessi solo questi nomi, più i file dei tab
/// aggiunti dall'utente: tab-<lettere e cifre>.txt / .md
const ALLOWED_FILES: [&str; 4] = ["note.txt", "notes.md", "settings.json", "tabs.json"];

fn is_allowed(name: &str) -> bool {
    if ALLOWED_FILES.contains(&name) {
        return true;
    }
    let Some(rest) = name.strip_prefix("tab-") else { return false };
    let Some((id, ext)) = rest.rsplit_once('.') else { return false };
    matches!(ext, "txt" | "md")
        && (1..=32).contains(&id.len())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// Cartella dati letta prima che Tauri parta (serve solo su Linux per scegliere il backend)
#[cfg(target_os = "linux")]
fn data_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join("io.github.calchy"))
}

fn file_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !is_allowed(name) {
        return Err(format!("file non ammesso: {name}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

#[tauri::command]
fn load_file(app: AppHandle, name: String) -> Result<String, String> {
    let path = file_path(&app, &name)?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_file(app: AppHandle, name: String, text: String) -> Result<(), String> {
    let path = file_path(&app, &name)?;
    // Scrive prima su un file temporaneo e poi lo rinomina:
    // se il PC si spegne a metà salvataggio, il vecchio testo resta intatto.
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(app: AppHandle, name: String) -> Result<(), String> {
    // i due file iniziali non si cancellano mai davvero: restano come copia di sicurezza
    if ALLOWED_FILES.contains(&name.as_str()) {
        return Ok(());
    }
    let path = file_path(&app, &name)?;
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Su GNOME Wayland le app non possono mettersi "sempre in primo piano" da sole.
/// Per questo, salvo diversa scelta nelle impostazioni, Calchy gira tramite XWayland,
/// dove GNOME rispetta il "sempre in primo piano".
#[cfg(target_os = "linux")]
fn choose_display_backend() {
    if std::env::var_os("GDK_BACKEND").is_some() || std::env::var_os("DISPLAY").is_none() {
        return; // scelta già fatta dall'utente, oppure XWayland non disponibile
    }
    let native_wayland = data_dir()
        .and_then(|d| fs::read_to_string(d.join("settings.json")).ok())
        .map(|s| s.replace(' ', "").contains("\"nativeWayland\":true"))
        .unwrap_or(false);
    if !native_wayland {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    #[cfg(desktop)]
    if let Some(window) = main_window(&app) {
        let _ = window.hide();
    }
    #[cfg(mobile)]
    let _ = app; // su Android la finestra non si nasconde: ci pensa il tasto Indietro/Home
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Avvio automatico con Windows (in background): voce "Calchy" nella chiave Run del registro.
/// Sugli altri sistemi non c'è: su GNOME lo imposta "calchy --setup-gnome".
#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[tauri::command]
fn get_autostart() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000; // niente finestra nera del prompt
        return std::process::Command::new("reg")
            .args(["query", RUN_KEY, "/v", "Calchy"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

#[tauri::command]
fn set_autostart(on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let value = format!("\"{}\" --hidden", exe.display());
        let args: Vec<&str> = if on {
            vec!["add", RUN_KEY, "/v", "Calchy", "/t", "REG_SZ", "/d", &value, "/f"]
        } else {
            vec!["delete", RUN_KEY, "/v", "Calchy", "/f"]
        };
        let out = std::process::Command::new("reg")
            .args(&args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;
        return if out.status.success() || !on { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).into_owned()) };
    }
    #[allow(unreachable_code)]
    {
        let _ = on;
        Err("avvio automatico non disponibile su questo sistema".into())
    }
}

#[cfg(desktop)]
fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

#[cfg(desktop)]
fn show(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    #[cfg(target_os = "linux")]
    present_x11(window);
}

/// Con XWayland GNOME blocca le finestre che chiedono il primo piano senza un orario
/// valido (succede quando Calchy, già aperta, viene richiamata dalla scorciatoia):
/// la finestra resta dietro alle altre. Con l'orario attuale del server X la richiesta
/// è accettata. Su Wayland nativo non serve.
#[cfg(target_os = "linux")]
fn present_x11(window: &WebviewWindow) {
    use gtk::prelude::*;
    let window = window.clone();
    let _ = window.clone().run_on_main_thread(move || {
        let Ok(gtk_window) = window.gtk_window() else { return };
        let Some(x11_window) = gtk_window
            .window()
            .and_then(|w| w.downcast::<gdkx11::X11Window>().ok())
        else {
            return;
        };
        gtk_window.present_with_time(gdkx11::functions::x11_get_server_time(&x11_window));
    });
}

/// Richiamata dalla scorciatoia: se Calchy è in primo piano la nasconde,
/// altrimenti la mostra e le dà il focus.
#[cfg(desktop)]
fn toggle(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else {
            show(&window);
        }
    }
}

/// "calchy --setup-gnome [combinazione]": registra in GNOME la scorciatoia da tastiera
/// e l'avvio automatico in background. Basta lanciarlo una volta.
#[cfg(target_os = "linux")]
fn setup_gnome(combo: &str) {
    use std::process::Command;

    let base = "org.gnome.settings-daemon.plugins.media-keys";
    let path = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/calchy/";
    let gs = |args: &[&str]| -> Option<String> {
        let out = Command::new("gsettings").args(args).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };

    // 1. Aggiunge Calchy all'elenco delle scorciatoie personalizzate (senza toccare le altre)
    let Some(list) = gs(&["get", base, "custom-keybindings"]) else {
        eprintln!("gsettings non trovato: questa funzione richiede GNOME.");
        std::process::exit(1);
    };
    if !list.contains(path) {
        let new_list = if list.contains("[]") {
            format!("['{path}']")
        } else {
            format!("{}, '{path}']", list.trim_end_matches(']'))
        };
        gs(&["set", base, "custom-keybindings", &new_list]);
    }
    let schema = format!("{base}.custom-keybinding:{path}");
    gs(&["set", &schema, "name", "Calchy"]);
    gs(&["set", &schema, "command", "calchy"]);
    gs(&["set", &schema, "binding", combo]);

    // 2. Avvio automatico nascosto: al primo uso della scorciatoia la finestra appare subito
    if let Some(config) = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    {
        let dir = config.join("autostart");
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(
            dir.join("calchy.desktop"),
            "[Desktop Entry]\nType=Application\nName=Calchy\nExec=calchy --hidden\nIcon=calchy\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n",
        );
    }

    println!("Fatto! Premi {combo} per aprire o nascondere Calchy.");
    println!("Calchy partirà in background a ogni accesso.");
    println!("Per cambiare la combinazione: Impostazioni → Tastiera → Scorciatoie da tastiera → Scorciatoie personalizzate.");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        let args: Vec<String> = std::env::args().collect();
        if let Some(i) = args.iter().position(|a| a == "--setup-gnome") {
            let combo = args.get(i + 1).map(String::as_str).unwrap_or("<Super><Alt>c");
            setup_gnome(combo);
            return;
        }
        choose_display_backend();
    }

    let builder = tauri::Builder::default().invoke_handler(tauri::generate_handler![
        load_file,
        save_file,
        delete_file,
        hide_window,
        quit_app,
        get_autostart,
        set_autostart
    ]);

    // Su Windows la scorciatoia globale la registra Calchy stessa (su GNOME ci pensa
    // "calchy --setup-gnome"): Ctrl+Alt+C mostra o nasconde la finestra
    #[cfg(windows)]
    let builder = {
        use tauri_plugin_global_shortcut::{Builder, ShortcutState};
        builder.plugin(
            Builder::new()
                .with_shortcuts(["ctrl+alt+c"])
                .expect("scorciatoia non valida")
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle(app);
                    }
                })
                .build(),
        )
    };

    #[cfg(desktop)]
    let builder = {
        // "calchy --hidden" avvia l'app in background (utile per l'avvio automatico)
        let start_hidden = std::env::args().any(|a| a == "--hidden");
        builder
            // Una sola istanza: lanciare di nuovo "calchy" mostra/nasconde quella già aperta
            .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
                if args.iter().any(|a| a == "--quit") {
                    app.exit(0);
                } else {
                    toggle(app);
                }
            }))
            .setup(move |app| {
                if !start_hidden {
                    if let Some(window) = main_window(app.handle()) {
                        show(&window);
                    }
                }
                Ok(())
            })
            // Chiudere la finestra la nasconde soltanto: Calchy resta pronta in background
            .on_window_event(|window, event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            })
    };

    // Android applica alla WebView la dimensione carattere di sistema, ma non allo stesso
    // modo alla textarea e al testo colorato dietro: cursore e selezione finiscono sfasati.
    // Calchy ha già A−/A+ nelle impostazioni, quindi lo zoom del testo resta al 100%.
    #[cfg(target_os = "android")]
    let builder = builder.setup(|app| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.with_webview(|webview| {
                webview.jni_handle().exec(|env, _activity, webview| {
                    let settings = env
                        .call_method(webview, "getSettings", "()Landroid/webkit/WebSettings;", &[])
                        .and_then(|s| s.l());
                    if let Ok(settings) = settings {
                        let _ = env.call_method(&settings, "setTextZoom", "(I)V", &[100.into()]);
                    }
                });
            });
        }
        Ok(())
    });

    builder
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio di Calchy");
}
