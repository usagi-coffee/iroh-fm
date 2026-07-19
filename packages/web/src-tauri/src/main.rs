// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // Fedora registers pipewiresink with rank NONE, so WebKitGTK's
        // autoaudiosink otherwise prefers the PulseAudio compatibility layer.
        // Set this before Tauri starts any WebKit/GStreamer threads.
        let existing = std::env::var("GST_PLUGIN_FEATURE_RANK").unwrap_or_default();
        let ranks = if existing.is_empty() {
            "pipewiresink:MAX".to_string()
        } else if existing
            .split(',')
            .any(|entry| entry.trim_start().starts_with("pipewiresink:"))
        {
            existing
        } else {
            format!("pipewiresink:MAX,{existing}")
        };
        // SAFETY: this is the first operation in main, before Tauri, WebKit, or
        // any application threads are started.
        unsafe { std::env::set_var("GST_PLUGIN_FEATURE_RANK", ranks) };
    }
    iroh_fm_desktop::run();
}
