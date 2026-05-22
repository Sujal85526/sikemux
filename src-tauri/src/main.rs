// Prevent a console window from spawning alongside the app on Windows release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sikemux_lib::run();
}
