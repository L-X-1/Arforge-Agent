#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkItem {
    pub id: usize,
    pub title: String,
    pub status: &'static str,
}

#[derive(Default)]
pub struct Repository {
    items: Vec<WorkItem>,
}

impl Repository {
    pub fn create(&mut self, title: &str) -> Result<WorkItem, &'static str> {
        let normalized = title.trim();
        if normalized.is_empty() {
            return Err("title is required");
        }
        let item = WorkItem {
            id: self.items.len() + 1,
            title: normalized.to_owned(),
            status: "open",
        };
        self.items.push(item.clone());
        Ok(item)
    }

    pub fn list(&self) -> &[WorkItem] {
        &self.items
    }
}

#[cfg(test)]
mod tests {
    use super::Repository;

    #[test]
    fn normalizes_title() {
        let mut repository = Repository::default();
        assert_eq!(
            repository.create("  depth  ").unwrap().title,
            "depth"
        );
    }
}
