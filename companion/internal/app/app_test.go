package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
	"time"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
	"voiceqa/companion/internal/provider"
	"voiceqa/companion/internal/store"
)

func newTestApp(t *testing.T) *App {
	t.Helper()
	s, e := store.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	return New(s, func(native.Message) error { return nil })
}
func message(typ string, p any) native.Message {
	b, _ := json.Marshal(p)
	return native.Message{Version: 1, ID: core.ID(), Type: typ, Payload: b}
}
func TestUploadRejectsOutOfOrderAndCorruption(t *testing.T) {
	a := newTestApp(t)
	data := []byte("evidence")
	hash := sha256.Sum256(data)
	r, e := a.dispatch(message("upload.begin", map[string]any{"size": len(data), "mime": "image/png", "sha": hex.EncodeToString(hash[:])}))
	if e != nil {
		t.Fatal(e)
	}
	id := r.(map[string]any)["id"].(string)
	if _, e = a.dispatch(message("upload.chunk", map[string]any{"id": id, "seq": 1, "data": base64.StdEncoding.EncodeToString(data)})); e == nil {
		t.Fatal("out-of-order upload accepted")
	}
	_, _ = a.dispatch(message("upload.chunk", map[string]any{"id": id, "seq": 0, "data": base64.StdEncoding.EncodeToString([]byte("EVIdence"))}))
	if _, e = a.dispatch(message("upload.complete", map[string]any{"id": id})); e == nil {
		t.Fatal("corrupted upload accepted")
	}
}
func TestUnconfirmedPlanCannotStart(t *testing.T) {
	a := newTestApp(t)
	p := provider.DemoPlan("http://localhost:4173/", "http://localhost:4173", "demo")
	_ = a.Store.Put("plan", p.ID, p)
	if _, e := a.dispatch(message("run.start", map[string]any{"planId": p.ID, "version": 1, "key": "test"})); e == nil {
		t.Fatal("unconfirmed plan executed")
	}
}
func TestCancellationInterruptsBrowserWait(t *testing.T) {
	a := newTestApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, e := a.browser(ctx, "run", "action", map[string]any{"operation": "execute"}); done <- e }()
	cancel()
	select {
	case e := <-done:
		if e != context.Canceled {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation stalled")
	}
}
func TestInterruptedRunIsNeverReplayed(t *testing.T) {
	a := newTestApp(t)
	r := core.Run{ID: "run", Status: "running", Steps: []core.Step{{Status: "dispatched"}}}
	_ = a.Store.Put("run", r.ID, r)
	b := New(a.Store, func(native.Message) error { t.Fatal("interrupted action replayed"); return nil })
	var saved core.Run
	_ = b.Store.Get("run", r.ID, &saved)
	if saved.Status != "error" || !strings.Contains(saved.Error, "unknown outcomes") {
		t.Fatal(saved)
	}
}
func pngBytes(c color.Color) []byte {
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	for y := 0; y < 10; y++ {
		for x := 0; x < 10; x++ {
			img.Set(x, y, c)
		}
	}
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}
func TestVisualComparisonDetectsChanges(t *testing.T) {
	a := pngBytes(color.White)
	ratio, _, e := ComparePNG(a, a)
	if e != nil || ratio != 0 {
		t.Fatal(ratio, e)
	}
	ratio, _, e = ComparePNG(a, pngBytes(color.Black))
	if e != nil || ratio != 1 {
		t.Fatal(ratio, e)
	}
}
func TestArtifactPathsCannotEscape(t *testing.T) {
	a := newTestApp(t)
	if _, e := a.Store.ReadArtifact("../../secret"); e == nil {
		t.Fatal("path traversal accepted")
	}
}
