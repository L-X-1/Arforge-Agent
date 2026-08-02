use acceptance_service::Repository;

fn main() {
    let mut repository = Repository::default();
    repository.create("project depth").expect("valid work item");
    println!("{}", repository.list().len());
}
