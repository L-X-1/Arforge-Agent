use acceptance_service::Repository;

#[test]
fn creates_multiple_items_in_order() {
    let mut repository = Repository::default();
    repository.create("first").unwrap();
    repository.create("second").unwrap();
    let titles: Vec<_> = repository
        .list()
        .iter()
        .map(|item| item.title.as_str())
        .collect();
    assert_eq!(titles, vec!["first", "second"]);
}
