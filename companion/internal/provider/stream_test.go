package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const completedPlan = `{"status":"completed","output":[{"content":[{"type":"output_text","text":"{\"summary\":\"safe draft\"}"}]}],"usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}`

func TestPlanningStreamOutlivesOrdinaryHTTPTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path != "/responses" || body["stream"] != true || body["model"] != "test/model" || body["max_output_tokens"] != float64(16000) {
			t.Error("planning changed model, routing, schema budget or streaming")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, ": keepalive\r\nevent: response.created\r\ndata: {\"type\":\"response.created\"}\r\n\r\n")
		w.(http.Flusher).Flush()
		select {
		case <-time.After(80 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "data: {\"type\":\"response.reasoning_text.delta\",\"delta\":\"private reasoning\"}\n\n")
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"unfinished\"}\n\n")
		fmt.Fprintf(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\ndata: \"response\":%s}\n\n", completedPlan)
	}))
	defer server.Close()
	c := New()
	c.BaseURL = server.URL
	c.HTTP.Timeout = 20 * time.Millisecond
	var phases []PlanProgress
	raw, usage, err := c.PlanStructured(context.Background(), "secret", "test/model", "rules", nil, Object(map[string]any{"summary": String()}), func(p PlanProgress) { phases = append(phases, p) })
	if err != nil || string(raw) != `{"summary":"safe draft"}` || usage["total_tokens"] != 16 {
		t.Fatal(string(raw), usage, err)
	}
	if c.HTTP.Timeout != 20*time.Millisecond {
		t.Fatal("ordinary HTTP timeout mutated")
	}
	if len(phases) != 2 || phases[0].Phase != "analyzing" || phases[1].Phase != "generating" || phases[1].ReceivedChars != len("unfinished") {
		t.Fatal("progress included reasoning or missed phases", phases)
	}
}

func TestPlanningStreamRejectsPartialAndContradictoryResponses(t *testing.T) {
	cases := []struct{ name, body string }{
		{"missing terminal", `data: {"type":"response.output_text.delta","delta":"{\"summary\":\"partial\"}"}` + "\n\n"},
		{"done only", "data: [DONE]\n\n"},
		{"malformed", "data: not-json\n\n"},
		{"mismatched event", "event: response.completed\ndata: {\"type\":\"response.created\"}\n\n"},
		{"missing response", "data: {\"type\":\"response.completed\"}\n\n"},
		{"contradictory terminal", fmt.Sprintf("data: {\"type\":\"response.incomplete\",\"response\":%s}\n\n", completedPlan)},
		{"incomplete", `data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}` + "\n\n"},
		{"failed", "data: {\"type\":\"response.failed\"}\n\n"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			data, err := readPlanStream(strings.NewReader(tt.body), nil)
			if err == nil {
				_, _, err = parseStructured(data, 16000)
			}
			if err == nil {
				t.Fatal("accepted an unfinished or contradictory plan")
			}
		})
	}
}

func TestPlanningStreamAndJSONAreBounded(t *testing.T) {
	if _, err := readPlanBody(strings.NewReader(strings.Repeat("x", 4*1024*1024+1))); err == nil {
		t.Fatal("unbounded JSON response")
	}
	if _, err := readPlanStream(strings.NewReader("data: "+strings.Repeat("x", 4*1024*1024+1)+"\n\n"), nil); err == nil {
		t.Fatal("unbounded event")
	}
	if _, err := readPlanStream(strings.NewReader(strings.Repeat(":"+strings.Repeat("x", 1023)+"\n", 8200)), nil); err == nil {
		t.Fatal("unbounded comments")
	}
}

func TestPlanningCancellationInterruptsStreamWithoutRetry(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"response.created\"}\n\n")
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	c := New()
	c.BaseURL = server.URL
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, _, err := c.PlanStructured(ctx, "secret", "model", "", nil, nil, nil); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not stop the stream")
	}
}

func TestPlanningCompatibleJSONAndKeyRedaction(t *testing.T) {
	for _, status := range []int{200, 401} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				if status == 200 {
					fmt.Fprint(w, completedPlan)
				} else {
					fmt.Fprint(w, `{"error":{"message":"secret rejected"}}`)
				}
			}))
			defer server.Close()
			c := New()
			c.BaseURL = server.URL
			raw, _, err := c.PlanStructured(context.Background(), "secret", "model", "", nil, nil, nil)
			if status == 200 && (err != nil || !json.Valid(raw)) {
				t.Fatal(string(raw), err)
			}
			if status == 401 && (err == nil || strings.Contains(err.Error(), "secret")) {
				t.Fatal("key leaked", err)
			}
		})
	}
}
