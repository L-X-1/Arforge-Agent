fn main() {
    tauri_acceptance::builder()
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
