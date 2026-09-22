mod actions;
mod intent;
mod provider;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            actions::catalog_snapshot,
            actions::desktop_capabilities,
            actions::copy_catalog_command,
            actions::insert_catalog_command,
            intent::spark_intent_status,
            intent::reason_about_intent
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Operator Key");
}
