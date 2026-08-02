package integration

import (
	"testing"

	"example.com/arforge/acceptance/service"
)

func TestRepositoryWorkflow(t *testing.T) {
	repository := service.Repository{}
	first, err := repository.Create("first")
	if err != nil || first.ID != 1 {
		t.Fatalf("create first: %#v %v", first, err)
	}
	if _, err := repository.Create("second"); err != nil {
		t.Fatal(err)
	}
	if len(repository.List()) != 2 {
		t.Fatalf("expected two items")
	}
}
