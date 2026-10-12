package provider

import (
	"fmt"
	"strings"
	"voiceqa/companion/internal/core"
)

func WorkspaceCoverageRequirements(request string) map[string]string {
	r := strings.ToLower(request)
	out := map[string]string{}
	if strings.Contains(r, "invoice") {
		out["invoice"] = "Use the captured order ID in the provided invoice route; independently assert invoice-id matches ${order-id} and invoice-total matches the calculated order total."
	}
	if strings.Contains(r, "multiple tabs") || strings.Contains(r, "multi-tab") {
		out["tabs"] = "Open an owned invoice tab and close it after checks. close_tab automatically returns to main; an explicit switch_tab main is optional."
	}
	if strings.Contains(r, "persistent settings") {
		out["settings"] = "Save a changed timezone/notification preference, navigate away and back without reset, and assert persisted state."
	}
	if strings.Contains(r, "order calculations") {
		out["totals"] = "Perform the order wizard and assert review-total/order-total with kind number before/after submission respectively."
	}
	if strings.Contains(r, "confirmation") || strings.Contains(r, "submission") && !strings.Contains(r, "duplicate") {
		out["confirmation"] = "Submit the order, wait for Order confirmed, and assert order-status."
	}
	if strings.Contains(r, "invalid inputs") {
		out["validation"] = "Attempt invalid/missing wizard inputs before asserting the specified wizard-error."
	}
	if strings.Contains(r, "captcha") {
		out["captcha"] = "Use human_checkpoint value=captcha for operator completion, followed by an independent challenge-result assertion."
	}
	return out
}

// These are minimum executable evidence checks for explicitly requested, known
// sandbox workflows. Passing them is not proof of exhaustive application QA.
func ValidateWorkspaceCoverage(p core.Plan, request string) error {
	r := strings.ToLower(request)
	seen := map[string]bool{}
	for _, c := range p.Cases {
		for _, a := range c.Steps {
			id := workspaceTargetID(a.Target)
			if a.Operation == "assert" && a.Assertion != nil {
				seen["assert:"+id] = true
			}
			if a.Operation == "click" {
				seen["click:"+id] = true
			}
			if a.Operation == "open_tab" {
				seen["open_tab"] = true
			}
			if a.Operation == "switch_tab" && a.Target == "main" {
				seen["return_main"] = true
			}
			if a.Operation == "close_tab" {
				seen["close_tab"] = true
				// The executor returns to main after closing an owned tab.
				seen["return_main"] = true
			}
			if a.Operation == "human_checkpoint" && a.Value == "captcha" {
				seen["captcha"] = true
			}
		}
	}
	var missing []string
	if strings.Contains(r, "invoice") && (!seen["assert:invoice-id"] || !seen["assert:invoice-total"]) {
		missing = append(missing, "invoice: open the provided invoice route and assert its actual captured ID and total")
	}
	if (strings.Contains(r, "multiple tabs") || strings.Contains(r, "multi-tab")) && (!seen["open_tab"] || !seen["return_main"] || !seen["close_tab"]) {
		missing = append(missing, "multiple tabs: open an owned invoice tab, return to main, close only that owned tab")
	}
	if strings.Contains(r, "persistent settings") && (!seen["click:save-settings"] || (!seen["assert:timezone"] && !seen["assert:notifications"])) {
		missing = append(missing, "persistent settings: save a changed preference, navigate away/back, then assert its persisted state")
	}
	if strings.Contains(r, "order calculations") && (!seen["assert:review-total"] && !seen["assert:order-total"]) {
		missing = append(missing, "order calculations: perform the wizard and assert the provided numeric total")
	}
	if (strings.Contains(r, "confirmation") || strings.Contains(r, "submission") && !strings.Contains(r, "duplicate")) && !seen["assert:order-status"] {
		missing = append(missing, "submission/confirmation: submit the order and assert order-status equals Order confirmed")
	}
	if strings.Contains(r, "invalid inputs") && !seen["assert:wizard-error"] {
		missing = append(missing, "invalid inputs: attempt invalid wizard data and assert the provided validation error")
	}
	if strings.Contains(r, "captcha") && (!seen["captcha"] || !seen["assert:challenge-result"]) {
		missing = append(missing, "CAPTCHA: operator human_checkpoint captcha followed by challenge-result completion assertion")
	}
	if len(missing) > 0 {
		return fmt.Errorf("Requested RelayDesk coverage is missing: %s. Include these journeys; do not substitute dashboard-only checks", strings.Join(missing, "; "))
	}
	return nil
}
