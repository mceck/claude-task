package runner

import (
	"fmt"
	"path/filepath"
	"strings"
)

// within resolves rel against base and refuses anything that escapes base.
func within(base, rel string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) {
		return "", fmt.Errorf("path %q must be relative", rel)
	}
	p := filepath.Join(base, rel)
	r, err := filepath.Rel(base, p)
	if err != nil || r == "." || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q escapes %s", rel, base)
	}
	return p, nil
}
