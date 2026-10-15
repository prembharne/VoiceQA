package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
)

func TestLiveReadActuallyDispatchesAndItsResultInformsTheNextDecision(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("NVIDIA_API_KEY", "nvapi-fixture")
	calls, reads, mutations := 0, 0, 0
	a.Provider.HTTP = &http.Client{Transport: automationReplyTransport(func(req *http.Request) (*http.Response, error) {
		calls++
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		messages := body["messages"].([]any)
		input := messages[1].(map[string]any)["content"].(string)
		if calls > 1 && !strings.Contains(input, "rel-[a-z]{4,8}") {
			t.Error("next model call did not receive the actual read result")
		}
		if calls == 3 && !strings.Contains(input, "already attempted") {
			t.Error("identical read did not receive rejection feedback")
		}
		content := `{"result":{"type":"tool","name":"inspect_element","args":{"page":"main","target":"#handle"}}}`
		if calls >= 3 {
			content = `{"result":{"type":"action","action":{"operation":"click","target":"#handle","label":"Focus the actual field"}}}`
		}
		encoded, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": "stop", "message": map[string]any{"content": content}}}})
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(encoded)))}, nil
	})}
	a.Send = func(m native.Message) error {
		if m.Type == "browser.request" {
			var p map[string]any
			_ = json.Unmarshal(m.Payload, &p)
			result := map[string]any{"page": "main", "url": "https://app.test/", "viewport": map[string]any{"width": 1280, "height": 720}}
			if p["operation"] == "automation_tool" {
				reads++
				result["pattern"] = "rel-[a-z]{4,8}"
				if p["tool"] != "inspect_element" || p["target"] != "#handle" {
					t.Error("wrong read dispatch", p)
				}
			}
			if p["operation"] == "execute" {
				mutations++
			}
			a.Handle(message("browser.result", map[string]any{"requestId": m.ID, "result": result}))
		}
		return nil
	}
	r := core.Run{ID: "live-read-feedback", Status: "running", Usage: map[string]int{}, Plan: core.Plan{AIProvider: "nvidia", Model: "nvidia/test", Mode: "automation", Origin: "https://app.test", URL: "https://app.test/", Automation: &core.AutomationPolicy{Live: true, MaxActions: 1}}}
	a.executeAutomation(context.Background(), &r)
	if reads != 1 || mutations != 1 || calls != 3 || len(r.ReadEvidence) != 1 || len(r.Steps) != 1 {
		t.Fatal("read was simulated, replayed, or consumed mutation slots", reads, mutations, calls, r.Error)
	}
	if r.DecisionErrors[0]["candidate"].(map[string]any)["name"] != "inspect_element" {
		t.Fatal("read rejection lost its actual tool candidate")
	}
}

func TestLiveReadsCannotMutateOrInspectUnselectedPages(t *testing.T) {
	p := core.Plan{Automation: &core.AutomationPolicy{Live: true}}
	d := automationDecision{Type: "tool", Name: "inspect_element", Args: agentArgs{Page: "main", Target: "node:8"}}
	if automationReadFingerprint(d, map[string]any{}, 0) == automationReadFingerprint(d, map[string]any{}, 1) {
		t.Fatal("inspection after an action cannot discover changed hidden constraints")
	}
	if err := validateAutomationRead(p, "main", d, 0); err != nil {
		t.Fatal(err)
	}
	cases := []automationDecision{d, d, d, d, d, d, d}
	cases[0].Args.Page = "other"
	cases[1].Args.URL = "https://outside.test/"
	cases[2].Action = core.Action{Operation: "click", Target: "#submit"}
	cases[3].Name = "evaluate"
	cases[4].Args.Query = "extra"
	cases[5].Name = "diagnostics"
	cases[6].Args.Target = "  "
	for _, bad := range cases {
		if validateAutomationRead(p, "main", bad, 0) == nil {
			t.Fatal("unapproved live read accepted", bad)
		}
	}
	if validateAutomationRead(p, "main", d, 24) == nil || validateAutomationRead(core.Plan{}, "main", d, 0) == nil {
		t.Fatal("read budget/mode ignored")
	}
	d.Name = "search_page"
	d.Args.Target = ""
	d.Args.Query = "Create release"
	if err := validateAutomationRead(p, "main", d, 0); err != nil {
		t.Fatal(err)
	}
	d.Name = "accessibility"
	d.Args.Query = ""
	if err := validateAutomationRead(p, "main", d, 0); err != nil {
		t.Fatal(err)
	}
}

func TestResolvedControlPreflightRejectsWrongOperationBeforeDispatch(t *testing.T) {
	for _, a := range []core.Action{{Operation: "select"}, {Operation: "fill"}, {Operation: "fill_totp"}} {
		if validateResolvedAutomationControl(a, map[string]any{"tag": "BUTTON"}) == nil {
			t.Fatal("non-input reached mutation", a.Operation)
		}
	}
	if validateResolvedAutomationControl(core.Action{Operation: "fill"}, map[string]any{"tag": "INPUT", "inputType": "checkbox"}) == nil {
		t.Fatal("text fill could toggle checkbox")
	}
	for _, test := range []struct {
		a    core.Action
		meta map[string]any
	}{
		{core.Action{Operation: "select"}, map[string]any{"tag": "SELECT"}},
		{core.Action{Operation: "fill"}, map[string]any{"tag": "TEXTAREA"}},
		{core.Action{Operation: "fill"}, map[string]any{"tag": "DIV", "editable": true}},
		{core.Action{Operation: "click"}, map[string]any{"tag": "BUTTON"}},
	} {
		if err := validateResolvedAutomationControl(test.a, test.meta); err != nil {
			t.Fatal(err)
		}
	}
}

func TestNativeValidationFeedsBackBeforeSubmission(t *testing.T) {
	meta := map[string]any{"nativeForm": map[string]any{"valid": false, "fields": []any{map[string]any{"target": "#handle", "pattern": "rel-[a-z]{4,8}", "reasons": []string{"patternMismatch"}}}}}
	if err := validateAutomationSubmission(meta); err == nil || !strings.Contains(err.Error(), "rel-[a-z]{4,8}") {
		t.Fatal("missing actionable form feedback", err)
	}
	if err := validateAutomationSubmission(map[string]any{"nativeForm": map[string]any{"valid": true}}); err != nil {
		t.Fatal(err)
	}
}

func TestSelectOnCustomOptionIsCorrectedBeforeAnyClick(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("NVIDIA_API_KEY", "nvapi-fixture")
	calls := 0
	executed := []string{}
	a.Provider.HTTP = &http.Client{Transport: automationReplyTransport(func(req *http.Request) (*http.Response, error) {
		calls++
		operation := "select"
		if calls > 1 {
			operation = "click"
		}
		action := map[string]any{"operation": operation, "target": "role:option|Ready", "label": "Choose Ready"}
		if operation == "select" {
			action["value"] = "Ready"
		}
		content, _ := json.Marshal(map[string]any{"result": map[string]any{"type": "action", "action": action}})
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": "stop", "message": map[string]any{"content": string(content)}}}})
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})}
	a.Send = func(m native.Message) error {
		if m.Type == "browser.request" {
			var p map[string]any
			_ = json.Unmarshal(m.Payload, &p)
			if p["operation"] == "execute" {
				executed = append(executed, p["action"].(map[string]any)["operation"].(string))
			}
			a.Handle(message("browser.result", map[string]any{"requestId": m.ID, "result": map[string]any{"tag": "BUTTON", "page": "main", "url": "https://app.test/"}}))
		}
		return nil
	}
	r := core.Run{ID: "custom-option-preflight", Status: "running", Usage: map[string]int{}, Plan: core.Plan{AIProvider: "nvidia", Model: "nvidia/test", Mode: "automation", Origin: "https://app.test", URL: "https://app.test/", Automation: &core.AutomationPolicy{Live: true, MaxActions: 1}}}
	a.executeAutomation(context.Background(), &r)
	if calls != 2 || strings.Join(executed, ",") != "click" || len(r.DecisionErrors) != 1 {
		t.Fatal("invalid select mutated before correction", calls, executed, r.Error)
	}
}

func TestLiveReadEvidenceIsBoundedDurableAndAvailableToDebugging(t *testing.T) {
	r := &core.Run{ID: "read-history"}
	for i := 0; i < 24; i++ {
		rememberAutomationRead(r, map[string]any{"page": "main", "tool": "inspect_element", "url": "https://app.test/input?token=secret-sentinel", "arguments": map[string]any{"target": "#handle"}, "toolResult": map[string]any{"text": strings.Repeat("x", 18000), "pattern": "rel-[a-z]{4,8}"}})
	}
	encoded, _ := json.Marshal(r.ReadEvidence)
	if len(encoded) > 48*1024 || len(r.ReadEvidence) != 24 || !r.EvidenceOmitted || strings.Contains(string(encoded), "secret-sentinel") {
		t.Fatal("unbounded/unsafe read history", len(encoded))
	}
	summary, err := recordedRunEvidence(r, "summary")
	if err != nil || len(summary["observations"].([]map[string]any)) != 24 {
		t.Fatal("read references missing", err)
	}
	read, err := recordedRunEvidence(r, "observation:R1")
	if err != nil || read["observation"] == nil {
		t.Fatal("read details missing", err)
	}
	if _, err = recordedRunEvidence(r, "observation:R99"); err == nil {
		t.Fatal("read outside selected run accepted")
	}
}
