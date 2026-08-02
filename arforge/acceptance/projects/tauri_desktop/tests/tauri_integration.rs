#[test]
fn generated_context_contract_matches_frontend() {
    let config = include_str!("../tauri.conf.json");
    let frontend = include_str!("../dist/index.html");
    assert!(config.contains("\"frontendDist\": \"dist\""));
    assert!(config.contains("dev.arforge.acceptance"));
    assert!(frontend.contains("Arforge Tauri project depth"));
    assert_eq!(
        tauri_acceptance::normalize_title("desktop").unwrap(),
        "desktop"
    );
}
