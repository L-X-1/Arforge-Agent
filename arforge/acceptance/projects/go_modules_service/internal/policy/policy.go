package policy

import (
	"errors"
	"strings"
)

var ErrBlankTitle = errors.New("title is required")

func NormalizeTitle(title string) (string, error) {
	normalized := strings.TrimSpace(title)
	if normalized == "" {
		return "", ErrBlankTitle
	}
	return normalized, nil
}
