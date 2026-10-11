package core

import (
	"encoding/json"
	"testing"
)

func TestVariableExpansionPreservesJSONAndURLBoundaries(t *testing.T) {
	action := Action{Operation: "http_check", HTTP: &HTTPCheck{URL: "https://example.test/orders/${order-id}", Body: `{"comment":"${comment}"}`}}
	resolved, e := ResolveAction(action, map[string]string{"order-id": "x/y?role=admin", "comment": "quotes \" and \\ are data"})
	if e != nil || resolved.HTTP.URL != "https://example.test/orders/x%2Fy%3Frole=admin" || !json.Valid([]byte(resolved.HTTP.Body)) {
		t.Fatal(resolved, e)
	}
	if action.HTTP.URL != "https://example.test/orders/${order-id}" {
		t.Fatal("template mutated")
	}
	if _, e = ResolveAction(action, nil); e == nil {
		t.Fatal("unknown variable silently accepted")
	}
	query, e := Expand("https://example.test/search?q=${search}", map[string]string{"search": "book&admin=true"}, true)
	if e != nil || query != "https://example.test/search?q=book%26admin%3Dtrue" {
		t.Fatal("query data became URL syntax", query, e)
	}
}
func TestDatasetsAndCapturedValuesAreCheckedInExecutionOrder(t *testing.T) {
	p := validPlan()
	p.Dataset = []map[string]string{{"total": "12"}, {"total": "24"}}
	p.Cases[0].Steps[1] = Action{Operation: "assert", Target: "#total", Assertion: &Assertion{Kind: "number", Expected: "${total}"}}
	if e := ValidatePlan(p); e != nil {
		t.Fatal(e)
	}
	p.Dataset[1]["total"] = "not a number"
	if ValidatePlan(p) == nil {
		t.Fatal("invalid second row accepted")
	}
	p.Dataset = nil
	p.Cases[0].Steps = []Action{{Operation: "navigate", Value: p.URL}, {Operation: "capture_value", Target: "#order", Value: "order-id"}, {Operation: "assert", Target: "#status", Assertion: &Assertion{Kind: "text", Expected: "${order-id}"}}}
	if e := ValidatePlan(p); e != nil {
		t.Fatal(e)
	}
	p.Cases[0].Steps[1], p.Cases[0].Steps[2] = p.Cases[0].Steps[2], p.Cases[0].Steps[1]
	if ValidatePlan(p) == nil {
		t.Fatal("capture consumed before creation")
	}
}
func TestSecurityRequestsRequireAuthorizationAndActiveOrigin(t *testing.T) {
	p := validPlan()
	p.Cases[0].Steps[1] = Action{Operation: "http_check", HTTP: &HTTPCheck{Method: "POST", URL: p.URL, Body: `{"price":0.01}`, ExpectedStatus: 403}}
	if ValidatePlan(p) == nil {
		t.Fatal("mutating HTTP request allowed in QA mode")
	}
	p.Mode = "security"
	if ValidatePlan(p) == nil {
		t.Fatal("missing security authorization")
	}
	p.SecurityAuthorized = true
	if e := ValidatePlan(p); e != nil {
		t.Fatal(e)
	}
	p.Cases[0].Steps[1].HTTP.URL = "https://other.test/api"
	if ValidatePlan(p) == nil {
		t.Fatal("unapproved security target")
	}
	p.Cases[0].Steps[1].HTTP.URL = p.URL
	p.Cases[0].Steps[1].HTTP.JSONPointer = "/sessionToken"
	if ValidatePlan(p) == nil {
		t.Fatal("session token capture allowed")
	}
}

func TestNamedPrivateReferencesAndTypedJSONExpectations(t *testing.T) {
	p := validPlan()
	p.Mode = "security"
	p.SecurityAuthorized = true
	h := &HTTPCheck{Method: "POST", URL: p.URL, Body: `{"quantity":1}`, ExpectedStatus: 200, JSONPointer: "/ok", ExpectedType: "boolean", ExpectedValue: "true", SaveAs: "ok", AuthSource: "session:app-auth", AuthPointer: "/accessToken", CSRFSource: "meta:csrf-token", CSRFHeader: "X-CSRF-Token"}
	p.Cases[0].Steps = append(p.Cases[0].Steps, Action{Operation: "http_check", HTTP: h})
	if e := ValidatePlan(p); e != nil {
		t.Fatal(e)
	}
	for _, mutate := range []func(*HTTPCheck){
		func(h *HTTPCheck) { h.AuthSource = "local:apiKey" },
		func(h *HTTPCheck) { h.AuthPointer = "/password" },
		func(h *HTTPCheck) { h.CSRFSource = "input:password" },
		func(h *HTTPCheck) { h.CSRFBodyField = "csrf" },
		func(h *HTTPCheck) { h.ExpectedValue = "yes" },
		func(h *HTTPCheck) { h.Tolerance = 1 },
		func(h *HTTPCheck) { h.ExpectedType = "null" },
	} {
		changed := *h
		mutate(&changed)
		p.Cases[0].Steps[len(p.Cases[0].Steps)-1].HTTP = &changed
		if ValidatePlan(p) == nil {
			t.Fatalf("invalid private reference or JSON expectation accepted: %+v", changed)
		}
	}
}

func TestTypedPublicCapturesCanSupplyLaterExpectations(t *testing.T) {
	p := validPlan()
	for _, typ := range []string{"boolean", "null", "number", "string"} {
		p.Cases[0].Steps = []Action{{Operation: "navigate", Value: p.URL}, {Operation: "http_check", HTTP: &HTTPCheck{Method: "GET", URL: p.URL, ExpectedStatus: 200, JSONPointer: "/public", ExpectedType: typ, SaveAs: "captured"}}, {Operation: "http_check", HTTP: &HTTPCheck{Method: "GET", URL: p.URL, ExpectedStatus: 200, JSONPointer: "/public", ExpectedType: typ, ExpectedValue: "${captured}"}}}
		if err := ValidatePlan(p); err != nil {
			t.Fatal(typ, err)
		}
	}
}
