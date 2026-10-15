// Package visualagent isolates the pinned Agent S Python worker from the Go
// controller. The worker proposes typed intents and never executes browser input.
package visualagent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
)

const Model = "qwen/qwen3.7-flash"

type Intent struct {
	Operation   string `json:"operation"`
	Description string `json:"description,omitempty"`
	Text        string `json:"text,omitempty"`
	Value       string `json:"value,omitempty"`
	X           int    `json:"x,omitempty"`
	Y           int    `json:"y,omitempty"`
	Width       int    `json:"width,omitempty"`
	Height      int    `json:"height,omitempty"`
}
type Reply struct {
	Agent      string         `json:"agent"`
	Model      string         `json:"model"`
	Result     Intent         `json:"result"`
	Usage      map[string]int `json:"usage"`
	ModelCalls int            `json:"modelCalls"`
	Error      string         `json:"error"`
	ErrorClass string         `json:"errorClass"`
}
type Client struct {
	cmd    *exec.Cmd
	input  io.WriteCloser
	output *bufio.Scanner
}

func Paths() (string, string) {
	exe, _ := os.Executable()
	root := filepath.Dir(exe)
	python := os.Getenv("VOICEQA_AGENT_S_PYTHON")
	if python == "" {
		python = filepath.Join(root, "agent-s-runtime", "Scripts", "python.exe")
	}
	return python, filepath.Join(root, "agent-s", "worker.py")
}
func Available() bool {
	p, w := Paths()
	_, e := os.Stat(p)
	_, f := os.Stat(w)
	return e == nil && f == nil
}
func Start(ctx context.Context) (*Client, error) {
	p, w := Paths()
	if !Available() {
		return nil, errors.New("Agent S runtime is unavailable. Run scripts/install-agent-s.ps1 to enable visual recovery")
	}
	cmd := exec.CommandContext(ctx, p, "-I", w)
	hideWindow(cmd)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return nil, err
	}
	cmd.Stderr = io.Discard // SDK errors can contain raw prompts; IPC reports safe errors.
	if err = cmd.Start(); err != nil {
		in.Close()
		return nil, errors.New("Agent S worker could not start")
	}
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 4096), 64*1024)
	return &Client{cmd: cmd, input: in, output: scanner}, nil
}
func (c *Client) Close() {
	_ = c.input.Close()
	if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	_ = c.cmd.Wait()
}
func (c *Client) Call(ctx context.Context, payload any) (Reply, error) {
	var r Reply
	data, err := json.Marshal(payload)
	if err != nil {
		return r, err
	}
	if len(data) > 12*1024*1024 {
		return r, errors.New("Visual request exceeds allowance")
	}
	done := make(chan error, 1)
	go func() {
		_, e := c.input.Write(append(data, '\n'))
		if e == nil {
			if !c.output.Scan() {
				e = errors.New("Agent S worker ended before replying")
			} else {
				e = json.Unmarshal(c.output.Bytes(), &r)
			}
		}
		done <- e
	}()
	select {
	case <-ctx.Done():
		_ = c.cmd.Process.Kill()
		<-done
		return Reply{}, ctx.Err()
	case err = <-done:
	}
	if err != nil {
		return Reply{}, errors.New("Agent S worker returned invalid IPC")
	}
	if r.Error != "" {
		return r, errors.New(r.Error + " (" + r.ErrorClass + ")")
	}
	if r.Agent != "agent-s3" || r.Model != Model {
		return r, errors.New("Unexpected visual agent/model identity")
	}
	return r, nil
}
