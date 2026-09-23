mod actions;
mod intent;
mod native_settings;
mod provider;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            actions::catalog_snapshot,
            actions::catalog_health,
            native_settings::get_reasoning_settings,
            native_settings::save_reasoning_settings,
            native_settings::reset_reasoning_settings,
            actions::desktop_capabilities,
            actions::copy_catalog_command,
            actions::insert_catalog_command,
            intent::spark_intent_status,
            intent::reason_about_intent
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Operator Key");
}
