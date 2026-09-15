mod actions;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            actions::copy_catalog_command,
            actions::insert_catalog_command
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Operator Key");
}
