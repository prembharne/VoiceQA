package provider

import "voiceqa/companion/internal/core"

func labAction(op, target, value, label string) core.Action {
	return core.Action{Operation: op, Target: target, Value: value, Label: label}
}
func labAssert(target, kind, expected, label string) core.Action {
	return core.Action{Operation: "assert", Target: target, Label: label, Assertion: &core.Assertion{Kind: kind, Expected: expected}}
}
func labHTTP(method, url, body string, status int, pointer, expected, save, key, label string) core.Action {
	check := &core.HTTPCheck{Method: method, URL: url, Body: body, ExpectedStatus: status, JSONPointer: pointer, ExpectedValue: expected, SaveAs: save, IdempotencyKey: key}
	if pointer == "/total" {
		check.ExpectedType = "number"
	}
	if pointer == "/id" || pointer == "/owner" {
		check.ExpectedType = "string"
	}
	if pointer == "/accepted" {
		check.ExpectedType = "boolean"
	}
	return core.Action{Operation: "http_check", Label: label, HTTP: check}
}

func WorkflowDemoPlan(url, origin, request string) core.Plan {
	p := core.Plan{ID: core.ID(), Version: 1, URL: url, Origin: origin, Request: request, Model: "fixture-demo", CreatedAt: core.Now(), Mode: "qa", Summary: "Deterministic data-driven workflow: create test orders, capture their IDs and verify server totals across two input rows.", Viewports: []core.Viewport{{Width: 1440, Height: 900}}, Dataset: []map[string]string{{"quantity": "1", "total": "12"}, {"quantity": "2", "total": "24"}}}
	p.Cases = []core.Case{{Name: "Order workflow", Goal: "Carry an order ID from UI creation into a server check", Source: "synthetic fixture contract", Steps: []core.Action{
		labAction("navigate", "", url, "Reset the workflow lab"), labAction("click", "testid:login-alice", "", "Use Alice test account"), labAssert("testid:identity", "text", "Alice test account", "Verify the test identity"),
		labAction("fill", "testid:order-quantity", "${quantity}", "Enter this row's order quantity"), labAction("click", "testid:create-order", "", "Create a synthetic order"), labAssert("testid:order-result", "text", "Test order created", "Verify order creation"),
		labAction("capture_value", "testid:order-id", "order-id", "Capture the created order ID"), labAssert("testid:order-total", "number", "${total}", "Verify the visible order total"),
		labHTTP("GET", origin+"/security/api/orders/${order-id}", "", 200, "/total", "${total}", "", "", "Verify the created order on the server"),
	}}}
	return p
}

func SecurityDemoPlan(url, origin, request string, authorized bool) core.Plan {
	p := core.Plan{ID: core.ID(), Version: 1, URL: url, Origin: origin, Request: request, Model: "fixture-demo", CreatedAt: core.Now(), Mode: "security", SecurityAuthorized: authorized, Summary: "Deterministic logical security fixture: anonymous and cross-user access, price integrity, client-role tampering, CSRF and duplicate-order prevention. Only synthetic test systems are used.", Viewports: []core.Viewport{{Width: 1440, Height: 900}}}
	if !authorized {
		p.Clarification = "Choose Logical security in Test options and confirm you are authorized to check this test system."
		p.Cases = []core.Case{}
		return p
	}
	reset := labAction("navigate", "", url, "Reset the security lab")
	alice := labAction("click", "testid:login-alice", "", "Use Alice test account")
	csrf := labHTTP("POST", origin+"/security/api/transfer", `{"amount":1}`, 200, "/accepted", "true", "", "", "Verify protected API flow using a private CSRF reference")
	csrf.HTTP.CSRFSource = "meta:lab-csrf"
	bearerOwn := labHTTP("GET", origin+"/security/api/bearer/orders/alice-order", "", 200, "/owner", "alice", "", "", "Verify the bearer-authenticated positive control")
	bearerOther := labHTTP("GET", origin+"/security/api/bearer/orders/bob-order", "", 403, "", "", "", "", "Verify bearer-authenticated cross-user access is denied")
	for _, check := range []*core.HTTPCheck{bearerOwn.HTTP, bearerOther.HTTP} {
		check.AuthSource = "session:voiceqa-access"
		check.AuthPointer = "/accessToken"
	}
	p.Cases = []core.Case{
		{Name: "Resource authorization", Goal: "Anonymous access is denied and Alice cannot read Bob's order", Source: "synthetic fixture contract", Steps: []core.Action{reset, labHTTP("GET", origin+"/security/api/orders/alice-order", "", 401, "", "", "", "", "Verify anonymous access is denied"), alice, labAssert("testid:identity", "text", "Alice test account", "Verify Alice's session"), labHTTP("GET", origin+"/security/api/orders/alice-order", "", 200, "/owner", "alice", "", "", "Verify the positive authorized control"), labHTTP("GET", origin+"/security/api/orders/bob-order", "", 403, "", "", "", "", "Verify cross-user order access is denied"), labAction("security_audit", "", "", "Inspect response and session configuration")}},
		{Name: "Server price integrity", Goal: "Client-supplied prices cannot override server prices", Source: "synthetic fixture contract", Steps: []core.Action{reset, alice, labHTTP("POST", origin+"/security/api/orders", `{"sku":"studio-mug","quantity":1,"price":0.01}`, 201, "/total", "12", "", "", "Verify the server ignores a tampered price")}},
		{Name: "Server role enforcement", Goal: "A client admin claim does not grant server access", Source: "synthetic fixture contract", Steps: []core.Action{reset, alice, labAction("click", "testid:client-admin", "", "Change the client role claim"), labAssert("testid:client-role", "text", "Client claims admin", "Verify the client claim was changed"), labHTTP("GET", origin+"/security/api/admin", "", 403, "", "", "", "", "Verify the server still denies admin access")}},
		{Name: "CSRF enforcement", Goal: "A tokenless operation is denied while the legitimate fixture flow succeeds", Source: "synthetic fixture contract", Steps: []core.Action{reset, alice, labHTTP("POST", origin+"/security/api/transfer", `{"amount":1}`, 403, "", "", "", "", "Verify the tokenless operation is denied"), csrf, labAction("click", "testid:genuine-transfer", "", "Submit the legitimate protected fixture flow"), labAssert("testid:transfer-result", "text", "Transfer fixture accepted", "Verify the positive CSRF control")}},
		{Name: "Idempotency integrity", Goal: "Repeated submission with one key cannot create duplicate orders", Source: "synthetic fixture contract", Steps: []core.Action{reset, alice, labHTTP("POST", origin+"/security/api/orders", `{"sku":"studio-mug","quantity":1}`, 201, "/id", "", "created-order", "voiceqa-fixture-order", "Create an order with an idempotency key"), labHTTP("POST", origin+"/security/api/orders", `{"sku":"studio-mug","quantity":1}`, 200, "/id", "${created-order}", "", "voiceqa-fixture-order", "Verify the repeated key returns the original order"), labHTTP("GET", origin+"/security/api/orders/${created-order}", "", 200, "/total", "12", "", "", "Verify the original order remains correct")}},
	}
	p.Cases = append(p.Cases, core.Case{Name: "Bearer session authorization", Goal: "Use a named browser token without persisting it and enforce ownership", Source: "synthetic fixture contract", Steps: []core.Action{reset, alice, bearerOwn, bearerOther}})
	return p
}
