//go:build !windows

package visualagent

import "os/exec"

func hideWindow(_ *exec.Cmd) {}
