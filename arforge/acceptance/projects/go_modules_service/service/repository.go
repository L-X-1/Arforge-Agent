package service

import "example.com/arforge/acceptance/internal/policy"

type WorkItem struct {
	ID     int
	Title  string
	Status string
}

type Repository struct {
	items []WorkItem
}

func (repository *Repository) Create(title string) (WorkItem, error) {
	normalized, err := policy.NormalizeTitle(title)
	if err != nil {
		return WorkItem{}, err
	}
	item := WorkItem{ID: len(repository.items) + 1, Title: normalized, Status: "open"}
	repository.items = append(repository.items, item)
	return item, nil
}

func (repository *Repository) List() []WorkItem {
	return append([]WorkItem(nil), repository.items...)
}
