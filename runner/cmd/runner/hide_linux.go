package main

import "syscall"

// hideMemory keeps processes of the same user, i.e. the agent's tools, out of the Runner's
// memory and /proc/<pid>/environ, which hold the runner token and the Job's secrets.
func hideMemory() {
	syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_SET_DUMPABLE, 0, 0)
}
