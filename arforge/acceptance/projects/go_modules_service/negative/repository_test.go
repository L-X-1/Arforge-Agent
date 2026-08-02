package negative

import (
	"errors"
	"testing"

	"example.com/arforge/acceptance/internal/policy"
	"example.com/arforge/acceptance/service"
)

func TestInvalidTitleDoesNotMutateRepository(t *testing.T) {
	repository := service.Repository{}
	if _, err := repository.Create("   "); !errors.Is(err, policy.ErrBlankTitle) {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(repository.List()) != 0 {
		t.Fatal("invalid item mutated repository")
	}
}
