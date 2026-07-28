#[cfg(mobile)]
use tauri::Manager;

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.handle().plugin(
                tauri_plugin_stronghold::Builder::with_argon2(
                    &dir.join("yurumeet-stronghold-salt.bin"),
                )
                .build(),
            )?;
            app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
            app.handle().plugin(tauri_plugin_biometric::init())?;
            app.handle().plugin(tauri_plugin_keystore::init())?;
            app.handle().plugin(tauri_plugin_mobile_push::init())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Yurumeet mobile");
}

#[cfg(not(mobile))]
pub fn run() {
    eprintln!("Yurumeet is mobile-only; build the iOS or Android target.");
}
