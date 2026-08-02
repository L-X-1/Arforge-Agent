pub fn normalize_title(title: &str) -> Result<String, &'static str> {
    let normalized = title.trim();
    if normalized.is_empty() {
        return Err("title is required");
    }
    Ok(normalized.to_owned())
}

pub fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::<tauri::Wry>::default()
}

#[cfg(test)]
mod tests {
    use super::normalize_title;

    #[test]
    fn unit_policy_normalizes_title() {
        assert_eq!(normalize_title("  project depth  ").unwrap(), "project depth");
    }

    #[test]
    fn negative_policy_rejects_blank_title() {
        assert_eq!(normalize_title("   "), Err("title is required"));
    }
}
