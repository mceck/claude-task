package runner

import (
	"os"
	"path/filepath"
	"syscall"
)

// lockRepo takes an exclusive lock on a Bare Clone for the git commands that change it. Every
// Worker Container of a Worker shares the volume that holds it, and two `git fetch` or
// `git worktree` commands on one repository at once fail on its ref and index locks.
func lockRepo(repo string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(repo), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(repo+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return func() {
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}, nil
}
