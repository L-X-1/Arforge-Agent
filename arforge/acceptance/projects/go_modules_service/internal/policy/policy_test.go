package policy

import "testing"

func TestNormalizeTitle(t *testing.T) {
	title, err := NormalizeTitle("  project depth  ")
	if err != nil || title != "project depth" {
		t.Fatalf("unexpected result: %q %v", title, err)
	}
}
