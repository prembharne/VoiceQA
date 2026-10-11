package provider

import "voiceqa/companion/internal/core"

func AdvancedDemoPlan(url, origin, request, profile string) core.Plan {
	act := func(op, target, value, label string) core.Action {
		return core.Action{Operation: op, Target: target, Value: value, Label: label}
	}
	check := func(target, kind, expected, label string) core.Action {
		return core.Action{Operation: "assert", Target: target, Label: label, Assertion: &core.Assertion{Kind: kind, Expected: expected}}
	}
	reset := act("navigate", "", url, "Reset the advanced QA lab")
	p := core.Plan{ID: core.ID(), Version: 1, URL: url, Origin: origin, Request: request, Model: "fixture-demo", CreatedAt: core.Now(), Summary: "Advanced deterministic fixture: secure test-account TOTP login, owned-tab isolation, readiness waits and an operator CAPTCHA checkpoint.", Viewports: []core.Viewport{{Width: 1440, Height: 900}}}
	if profile == "" {
		p.Clarification = "Create a test credential profile for this origin in Settings (username, password and TOTP seed), using the advanced demo's documented test account."
		p.Cases = []core.Case{}
		return p
	}
	wait := check("testid:async-result", "text", "Delayed result ready", "Wait for asynchronous readiness")
	wait.Operation = "wait_for"
	wait.TimeoutMS = 5000
	p.Cases = []core.Case{
		{Name: "Test-account MFA", Goal: "Verify authentication using a saved test profile and local TOTP", Source: "fixture contract", Steps: []core.Action{reset, act("fill_secret", "testid:auth-username", profile+":username", "Enter saved test username"), act("fill_secret", "testid:auth-password", profile+":password", "Enter saved test password"), act("fill_totp", "testid:auth-otp", profile, "Enter a locally generated TOTP"), act("click", "testid:verify-login", "", "Verify the test login"), check("testid:auth-result", "text", "Authenticated test account", "Verify signed-in application state")}},
		{Name: "Multi-tab isolation", Goal: "Create, switch and close only an owned tab", Source: "fixture contract", Steps: []core.Action{reset, act("click", "testid:increase-counter", "", "Increase the main counter"), act("open_tab", "child", origin+"/advanced/child", "Open owned child tab"), check("testid:child-status", "text", "Child page ready", "Verify child page"), act("click", "testid:increase-counter", "", "Increase the child counter"), check("testid:counter", "number", "1", "Verify child state"), act("switch_tab", "main", "", "Return to the main page"), check("testid:counter", "number", "1", "Verify main state stayed independent"), act("close_tab", "child", "", "Close only the owned child tab")}},
		{Name: "Readiness wait", Goal: "Wait for a delayed condition, then independently assert it", Source: "fixture contract", Steps: []core.Action{reset, act("click", "testid:load-result", "", "Load delayed content"), wait, check("testid:async-result", "text_contains", "ready", "Verify delayed result")}},
		{Name: "Operator CAPTCHA checkpoint", Goal: "Operator completion followed by an independent application check", Source: "fixture contract", Steps: []core.Action{reset, act("human_checkpoint", "", "captcha", "Complete the test CAPTCHA on the website, then click Continue in VoiceQA"), check("testid:captcha-result", "text", "CAPTCHA fixture completed", "Verify the operator completed the fixture")}},
	}
	return p
}
