package provider

import (
	"net/url"
	"voiceqa/companion/internal/core"
)

func workspaceReset(origin, path, raw string, guest bool) string {
	u, _ := url.Parse(raw)
	q := url.Values{"reset": []string{"1"}}
	if guest {
		q.Set("guest", "1")
	}
	if u != nil && u.Query().Get("bug") != "" {
		q.Set("bug", u.Query().Get("bug"))
	}
	return origin + path + "?" + q.Encode()
}
func workspaceWait(target, kind, expected, label string) core.Action {
	a := labAssert(target, kind, expected, label)
	a.Operation = "wait_for"
	a.TimeoutMS = 8000
	return a
}
func WorkspaceDemoPlan(raw, origin, request string) core.Plan {
	p := core.Plan{ID: core.ID(), Version: 1, URL: raw, Origin: origin, Request: request, Model: "fixture-demo", CreatedAt: core.Now(), Mode: "qa", Summary: "RelayDesk application compatibility: asynchronous tables, keyboard/modal behavior, validated multi-step orders, captured IDs, server totals, an owned invoice tab and persistent settings. Deterministic fixture; desktop only. Use the separate responsive/auth/security suites for their additional coverage.", Viewports: []core.Viewport{{Width: 1440, Height: 900}}, Dataset: []map[string]string{{"quantity": "2", "total": "255"}}}
	reset := labAction("navigate", "", workspaceReset(origin, "/", raw, false), "Reset RelayDesk's synthetic workspace")
	click := func(id, label string) core.Action { return labAction("click", "testid:"+id, "", label) }
	p.Cases = []core.Case{
		{Name: "Async order discovery", Goal: "Paginate and search server-backed orders", Source: "RelayDesk fixture contract", Steps: []core.Action{reset, click("nav-orders", "Open orders"), workspaceWait("testid:orders-summary", "text", "5 matching orders", "Wait for server-backed orders"), labAssert("[data-testid=orders-rows] tr", "count", "3", "Verify page size"), click("next-page", "Go to the second page"), labAssert("testid:page-number", "text", "Page 2 of 2", "Verify pagination"), labAction("fill", "testid:order-search", "Northstar", "Search for Northstar"), workspaceWait("testid:orders-summary", "text", "1 matching orders", "Wait for filtered server results"), labAssert("[data-testid=orders-rows]", "text_contains", "Northstar Studio", "Verify the search result")}},
		{Name: "Validated order and invoice", Goal: "Validate a wizard, create an order, verify the server and inspect an owned invoice tab", Source: "RelayDesk fixture contract", Steps: []core.Action{reset, click("new-order", "Open the order wizard"), labAction("key", "", "Escape", "Close the dialog with Escape"), labAssert("#order-dialog", "hidden", "true", "Verify dialog dismissal"), labAssert("testid:new-order", "focus", "true", "Verify focus returns to the launcher"), click("new-order", "Reopen the order wizard"), click("wizard-next", "Attempt to continue without customer details"), labAssert("testid:wizard-error", "text", "Enter a customer name and valid contact email.", "Verify required-field validation"), labAction("fill", "testid:customer-name", "Northstar Studio", "Enter a synthetic customer"), labAction("fill", "testid:customer-email", "qa@relay.test", "Enter a synthetic contact email"), labAction("select", "testid:shipping-method", "express", "Choose express delivery"), click("wizard-next", "Continue to items"), labAction("fill", "testid:order-quantity", "${quantity}", "Enter the data-row quantity"), labAction("fill", "testid:order-coupon", "INVALID", "Enter an invalid discount"), click("wizard-next", "Validate the discount"), labAssert("testid:wizard-error", "text", "Coupon not recognized", "Verify discount rejection"), labAction("fill", "testid:order-coupon", "", "Remove the invalid discount"), click("wizard-next", "Review the order"), labAssert("testid:review-total", "number", "${total}", "Verify the reviewed total"), click("wizard-next", "Place a synthetic order"), workspaceWait("testid:order-status", "text", "Order confirmed", "Wait for server confirmation"), labAssert("testid:order-status", "text", "Order confirmed", "Verify the independent confirmation"), labAction("capture_value", "testid:order-id", "order-id", "Capture the actual order ID"), labAssert("testid:order-total", "number", "${total}", "Verify the displayed total"), labHTTP("GET", origin+"/workspace/api/orders/${order-id}", "", 200, "/total", "${total}", "", "", "Verify the server total"), labAction("open_tab", "invoice", origin+"/app/invoices/${order-id}", "Open an owned invoice tab"), labAssert("testid:invoice-id", "text", "${order-id}", "Verify the invoice identity"), labAssert("testid:invoice-total", "number", "${total}", "Verify the invoice total"), labAction("switch_tab", "main", "", "Return to the workspace"), labAssert("testid:order-status", "text", "Order confirmed", "Verify main-page state survived the tab switch"), labAction("close_tab", "invoice", "", "Close only the owned invoice tab")}},
		{Name: "Persistent workspace settings", Goal: "Preferences survive SPA navigation", Source: "RelayDesk fixture contract", Steps: []core.Action{reset, click("nav-settings", "Open settings"), click("notifications", "Disable order notifications"), labAction("select", "testid:timezone", "Asia/Kolkata", "Choose the India time zone"), click("save-settings", "Save preferences"), labAssert("testid:settings-result", "text", "Preferences saved", "Verify save feedback"), click("nav-overview", "Leave settings"), click("nav-settings", "Return to settings"), labAssert("testid:notifications", "selected", "false", "Verify persisted notification preference"), labAssert("testid:timezone", "value", "Asia/Kolkata", "Verify persisted time zone")}},
	}
	return p
}
func WorkspaceLayoutPlan(raw, origin, request string) core.Plan {
	p := core.Plan{ID: core.ID(), Version: 1, URL: raw, Origin: origin, Request: request, Model: "fixture-demo", CreatedAt: core.Now(), Summary: "RelayDesk layout/accessibility fixture at desktop and mobile widths. It does not run the functional, authentication or security suites.", Viewports: []core.Viewport{{Width: 1440, Height: 900}, {Width: 390, Height: 844}}}
	p.Cases = []core.Case{{Name: "Responsive workspace", Goal: "No horizontal overflow across a populated dashboard and table", Source: "RelayDesk fixture contract", Steps: []core.Action{labAction("navigate", "", workspaceReset(origin, "/app/layout", raw, false), "Reset the responsive workspace"), labAssert("", "no_overflow", "true", "Verify dashboard width"), labAction("click", "testid:nav-orders", "", "Open the responsive order table"), workspaceWait("testid:orders-summary", "text", "5 matching orders", "Wait for table readiness"), labAssert("", "no_overflow", "true", "Verify the populated table width")}}}
	return p
}
func WorkspaceAuthPlan(raw, origin, request, profile string) core.Plan {
	p := core.Plan{ID: core.ID(), Version: 1, URL: raw, Origin: origin, Request: request, Model: "fixture-demo", CreatedAt: core.Now(), Summary: "RelayDesk authentication fixture: saved credentials, server-verified TOTP and an operator-completed synthetic challenge. No production CAPTCHA bypass.", Viewports: []core.Viewport{{Width: 1440, Height: 900}}}
	if profile == "" {
		p.Clarification = "Save the RelayDesk test profile in Settings for this origin: qa@voiceqa.test / fixture-only, TOTP seed GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ (SHA-1, 6 digits, 30 seconds)."
		p.Cases = []core.Case{}
		return p
	}
	p.Cases = []core.Case{{Name: "Authentication and operator checkpoint", Goal: "Verify server authentication and independently verify an operator challenge", Source: "RelayDesk fixture contract", Steps: []core.Action{labAction("navigate", "", workspaceReset(origin, "/app/auth", raw, true), "Reset the authentication lab"), labAction("fill_secret", "testid:auth-username", profile+":username", "Enter saved test username"), labAction("fill_secret", "testid:auth-password", profile+":password", "Enter saved test password"), labAction("fill_totp", "testid:auth-otp", profile, "Enter local TOTP"), labAction("click", "testid:verify-login", "", "Sign in to the workspace"), workspaceWait("testid:auth-result", "text", "Authenticated as Alice Morgan", "Wait for server authentication"), labAssert("testid:identity", "text", "Alice Morgan", "Verify signed-in identity"), labAction("human_checkpoint", "", "captcha", "Complete the synthetic challenge checkbox on RelayDesk, then click Continue in VoiceQA"), labAssert("testid:challenge-result", "text", "Challenge completed", "Verify operator completion")}}}
	return p
}
func WorkspaceSecurityPlan(raw, origin, request string, authorized bool) core.Plan {
	p := core.Plan{ID: core.ID(), Version: 1, URL: raw, Origin: origin, Request: request, Model: "fixture-demo", CreatedAt: core.Now(), Mode: "security", SecurityAuthorized: authorized, Summary: "RelayDesk server controls: anonymous/ownership denials with positive controls, server roles, anti-CSRF writes, authoritative price and idempotency.", Viewports: []core.Viewport{{Width: 1440, Height: 900}}}
	if !authorized {
		p.Clarification = "Choose Logical security and confirm authorization for this synthetic workspace."
		p.Cases = []core.Case{}
		return p
	}
	reset := labAction("navigate", "", workspaceReset(origin, "/app/security", raw, true), "Reset the security workspace")
	alice := labAction("click", "testid:login-alice", "", "Use Alice test account")
	own := func() []core.Action {
		return []core.Action{reset, alice, workspaceWait("testid:identity", "text", "Alice Morgan", "Wait for Alice's server session")}
	}
	create := func(status int, ptr, expected, save, key, label string) core.Action {
		a := labHTTP("POST", origin+"/workspace/api/orders", `{"customer":"Northstar Studio","email":"qa@relay.test","product":"studio-display","quantity":2,"shipping":"express","price":0.01}`, status, ptr, expected, save, key, label)
		a.HTTP.CSRFSource = "meta:workspace-csrf"
		return a
	}
	p.Cases = []core.Case{
		{Name: "Resource ownership", Goal: "Anonymous and cross-account access are denied", Source: "RelayDesk fixture contract", Steps: []core.Action{reset, labHTTP("GET", origin+"/workspace/api/orders/ORD-2001", "", 401, "", "", "", "", "Verify anonymous denial"), alice, workspaceWait("testid:identity", "text", "Alice Morgan", "Wait for test session"), labHTTP("GET", origin+"/workspace/api/orders/ORD-2001", "", 200, "/owner", "alice", "", "", "Verify authorized positive control"), labHTTP("GET", origin+"/workspace/api/orders/ORD-2002", "", 403, "", "", "", "", "Verify cross-account denial"), labAction("security_audit", "", "", "Inspect main-document security indicators")}},
		{Name: "Server roles", Goal: "A client role claim never grants server administration", Source: "RelayDesk fixture contract", Steps: append(own(), labAction("click", "testid:client-admin", "", "Claim admin on the client"), labAssert("testid:client-role", "text", "Client claims admin", "Verify the client claim"), labHTTP("GET", origin+"/workspace/api/admin", "", 403, "", "", "", "", "Verify server admin denial"), labAction("click", "testid:login-bob", "", "Use the manager test account"), workspaceWait("testid:identity", "text", "Bob Chen", "Wait for the manager session"), labHTTP("GET", origin+"/workspace/api/admin", "", 200, "/allowed", "true", "", "", "Verify the authorized manager positive control"))},
		{Name: "CSRF and price integrity", Goal: "Tokenless writes fail; legitimate writes use server prices", Source: "RelayDesk fixture contract", Steps: append(own(), labHTTP("POST", origin+"/workspace/api/orders", `{"customer":"Northstar Studio","email":"qa@relay.test","product":"studio-display","quantity":2,"shipping":"express"}`, 403, "", "", "", "", "Verify tokenless write denial"), create(201, "/total", "255", "", "", "Verify server price integrity"))},
		{Name: "Idempotent order creation", Goal: "Repeated key returns the same server order", Source: "RelayDesk fixture contract", Steps: append(own(), create(201, "/id", "", "created-order", "relay-fixture", "Create an order with a submission key"), create(200, "/id", "${created-order}", "", "relay-fixture", "Verify duplicate submission returns the same order"), labHTTP("GET", origin+"/workspace/api/orders/${created-order}", "", 200, "/total", "255", "", "", "Verify original server record"))},
	}
	return p
}

// Give AI the business contract and known controls, not a lengthy prerecorded suite.
func WorkspaceRequirements(raw, origin string) map[string]any {
	return map[string]any{
		"application": "RelayDesk synthetic operations workspace",
		"resetURL":    workspaceReset(origin, "/", raw, false),
		"sessionRule": "The main resetURL starts an authenticated synthetic Alice session. Only the authentication lab requires a saved credential/TOTP profile. Security lab loginAlice/loginBob buttons establish authorized fixture sessions without that profile.",
		"navigation":  map[string]string{"orders": "testid:nav-orders", "settings": "testid:nav-settings", "overview": "testid:nav-overview"},
		"orderWizard": map[string]any{
			"open": "testid:new-order", "next": "testid:wizard-next", "error": "testid:wizard-error",
			"customerStep":       map[string]any{"customer": "testid:customer-name", "email": "testid:customer-email", "shipping": "testid:shipping-method", "shippingValues": []string{"standard", "express"}, "requiredError": "Enter a customer name and valid contact email."},
			"itemsStep":          map[string]any{"product": "testid:order-product", "quantity": "testid:order-quantity", "coupon": "testid:order-coupon", "products": map[string]int{"studio-display": 120, "usb-dock": 80, "desk-lamp": 45}, "defaultProduct": "studio-display", "quantityBounds": []int{1, 5}, "invalidCouponError": "Coupon not recognized", "discount": "WELCOME10 gives 10 percent off items; empty means no discount", "expressShipping": 15},
			"reviewStep":         map[string]string{"total": "testid:review-total", "submit": "testid:wizard-next"},
			"result":             map[string]string{"status": "testid:order-status", "confirmedText": "Order confirmed", "id": "testid:order-id", "total": "testid:order-total"},
			"serverVerification": map[string]any{"method": "GET", "urlTemplate": origin + "/workspace/api/orders/${order-id}", "expectedStatus": 200, "totalPointer": "/total", "totalType": "number"},
			"invoice":            map[string]string{"urlTemplate": origin + "/app/invoices/${order-id}", "id": "testid:invoice-id", "total": "testid:invoice-total", "tabRule": "Use an owned tab, return to main, then close only that owned tab"},
		},
		"orderTable":  map[string]any{"search": "testid:order-search", "filter": "testid:order-filter", "nextPage": "testid:next-page", "summary": "testid:orders-summary", "rows": "[data-testid=orders-rows] tr", "page": "testid:page-number", "initialMatching": 5, "pageSize": 3, "NorthstarResult": "Northstar Studio", "empty": "testid:empty-orders"},
		"preferences": map[string]any{"notifications": "testid:notifications", "initialNotifications": true, "timezone": "testid:timezone", "timezoneValues": []string{"UTC", "Asia/Kolkata", "America/New_York"}, "save": "testid:save-settings", "feedback": "testid:settings-result", "savedText": "Preferences saved", "persistence": "Settings persist after navigation; reset restores defaults"},
		"authentication": map[string]any{
			"resetURL": workspaceReset(origin, "/app/auth", raw, true),
			"username": "testid:auth-username", "password": "testid:auth-password", "otp": "testid:auth-otp", "submit": "testid:verify-login",
			"profileRule": "Use only a supplied origin-bound authProfiles alias with username, password and TOTP. If unavailable, explicitly defer authentication or ask for a saved test profile; never invent a secret.",
			"result":      "testid:auth-result", "authenticatedText": "Authenticated as Alice Morgan", "identity": "testid:identity",
			"challenge": "An operator completes the synthetic checkbox during human_checkpoint captcha; independently verify testid:challenge-result text Challenge completed. Never automate a production CAPTCHA bypass.",
		},
		"security": map[string]any{
			"resetURL": workspaceReset(origin, "/app/security", raw, true), "loginAlice": "testid:login-alice", "loginBob": "testid:login-bob", "identity": "testid:identity",
			"access":        "GET /workspace/api/orders/ORD-2001: guest 401, Alice 200 /owner=alice. Alice GET ORD-2002: 403. Bob owns ORD-2002.",
			"roles":         "testid:client-admin claims admin only in testid:client-role. GET /workspace/api/admin: Alice 403; Bob manager 200 /allowed=true.",
			"writes":        "POST /workspace/api/orders needs server session and CSRF source meta:workspace-csrf, header X-CSRF-Token. Guest 401; authenticated but missing token 403; legitimate authenticated creation 201. Only when apiWritesAllowed.",
			"orderBody":     map[string]any{"customer": "Northstar Studio", "email": "qa@relay.test", "product": "studio-display", "quantity": 2, "shipping": "express"},
			"price":         "Server ignores client price; studio-display costs 120 and express shipping 15. Quantity 2 total 255, even with client price 0.01. JSON pointers /total, /id.",
			"idempotency":   "Header Idempotency-Key: first valid POST 201; identical body and key replay 200 with same /id; changed body with same key 409. Capture actual ID before comparison.",
			"authorization": "Security requests require explicitly selected security mode and securityAuthorized. Do not silently broaden authorization.",
		},
	}
}
