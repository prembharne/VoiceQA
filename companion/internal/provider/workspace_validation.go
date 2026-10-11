package provider

import (
	"fmt"
	"net/url"
	"strings"
	"voiceqa/companion/internal/core"
)

// Validate only known RelayDesk fixture rules. Do not invent contracts for
// arbitrary websites or silently replace an agent's planned assertions.
func ValidateWorkspaceDraft(plan core.Plan) error {
	var issues []string
	for _, test := range plan.Cases {
		if len(test.Steps) == 0 {
			continue
		}
		start, err := url.Parse(test.Steps[0].Value)
		if err != nil || start.Query().Get("reset") != "1" {
			issues = append(issues, fmt.Sprintf("%s: start with the supplied reset URL (?reset=1) so each case starts with fresh fixture state", test.Name))
		}
		stage := ""
		stageKnown := false
		customer, email, coupon, search := "", "", "", ""
		submitted := false
		for _, action := range test.Steps {
			id := workspaceTargetID(action.Target)
			if action.Operation == "navigate" {
				stage = ""
				stageKnown = false
				customer, email, coupon, search = "", "", "", ""
				submitted = false
				continue
			}
			if action.Operation == "key" && action.Value == "Escape" {
				stage = ""
			}
			if action.Operation == "fill" {
				switch id {
				case "customer-name":
					customer = action.Value
				case "customer-email":
					email = action.Value
				case "order-coupon":
					coupon = action.Value
				case "order-search":
					search = action.Value
				}
			}
			if action.Operation == "click" {
				switch id {
				case "new-order":
					stage = "customer"
					stageKnown = true
					customer, email, coupon = "", "", ""
				case "wizard-next":
					switch stage {
					case "customer":
						if customer != "" && (strings.Contains(email, "@") || strings.Contains(email, "${")) {
							stage = "items"
						}
					case "items":
						if coupon == "" || coupon == "WELCOME10" {
							stage = "review"
						}
					case "review":
						stage = "submitted"
						submitted = true
					}
				case "next-page":
					if search == "Northstar" {
						issues = append(issues, fmt.Sprintf("%s: Northstar returns one result and one page; clear the filter and wait for all orders before testing Next page", test.Name))
					}
				}
			}
			if action.Assertion == nil {
				continue
			}
			if id == "review-total" {
				expectsAbsence := (action.Assertion.Kind == "hidden" && action.Assertion.Expected == "true") || (action.Assertion.Kind == "visible" && action.Assertion.Expected == "false") || (action.Assertion.Kind == "count" && action.Assertion.Expected == "0")
				if !expectsAbsence && (!stageKnown || stage != "review") {
					issues = append(issues, fmt.Sprintf("%s: review-total exists only on the review step; assert it after the items Next and before the review Next submits the order", test.Name))
				}
			}
			if id == "review-total" || id == "order-total" || id == "invoice-total" {
				if action.Assertion.Kind == "value" {
					issues = append(issues, fmt.Sprintf("%s: %s is formatted text, not an input value; use a number assertion for an amount", test.Name, id))
				}
			}
			rows := strings.Contains(action.Target, "orders-rows") && strings.HasSuffix(strings.TrimSpace(action.Target), " tr")
			if rows && action.Assertion.Kind == "count" && search == "" && !submitted && action.Assertion.Expected == "5" {
				issues = append(issues, fmt.Sprintf("%s: initial visible row count is 3 (page size), not 5 (all matching orders); check orders-summary separately for 5 matching orders", test.Name))
			}
			if id == "page-number" && action.Assertion.Kind == "text" && (action.Assertion.Expected == "1" || action.Assertion.Expected == "2") {
				issues = append(issues, fmt.Sprintf("%s: page-number text includes both numbers, such as Page 2 of 2; use the complete text or text_contains", test.Name))
			}
		}
	}
	if len(issues) > 0 {
		return fmt.Errorf("RelayDesk plan conflicts with the known fixture contract: %s", strings.Join(issues, "; "))
	}
	return nil
}
func workspaceTargetID(target string) string {
	if strings.HasPrefix(target, "testid:") {
		return strings.TrimPrefix(target, "testid:")
	}
	if strings.HasPrefix(target, "#") {
		return strings.TrimPrefix(target, "#")
	}
	for _, quote := range []string{"", "\"", "'"} {
		prefix := "[data-testid=" + quote
		if strings.HasPrefix(target, prefix) {
			value := strings.TrimPrefix(target, prefix)
			return strings.Split(value, quote+"]")[0]
		}
	}
	return ""
}
