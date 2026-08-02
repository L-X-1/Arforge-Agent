use acceptance_service::Repository;

#[test]
fn rejects_blank_title_without_mutating_repository() {
    let mut repository = Repository::default();
    assert_eq!(repository.create("   "), Err("title is required"));
    assert!(repository.list().is_empty());
}
