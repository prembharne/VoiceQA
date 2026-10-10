package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"voiceqa/companion/internal/app"
	"voiceqa/companion/internal/native"
	"voiceqa/companion/internal/store"
)

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, "VoiceQA:", e)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println("VoiceQA companion 0.1.0")
		return nil
	}
	if len(os.Args) < 2 || (!regexp.MustCompile(`^chrome-extension://[a-p]{32}/$`).MatchString(os.Args[1]) && os.Args[1] != "--stdio") {
		return errors.New("launch through Chrome Native Messaging, or use --stdio for the protocol test harness")
	}
	dir := os.Getenv("VOICEQA_DATA_DIR")
	if dir == "" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			var e error
			base, e = os.UserConfigDir()
			if e != nil {
				return e
			}
		}
		dir = filepath.Join(base, "VoiceQA")
	}
	s, e := store.Open(dir)
	if e != nil {
		return e
	}
	defer s.Close()
	t := native.New(os.Stdin, os.Stdout)
	a := app.New(s, t.Write)
	defer a.Close()
	for {
		m, e := t.Read()
		if errors.Is(e, io.EOF) {
			return nil
		}
		if e != nil {
			return e
		}
		a.Handle(m)
	}
}
