#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod renderer;

fn main() {
    #[cfg(target_os = "linux")]
    renderer::configure();
    operator_key_lib::run();
}
