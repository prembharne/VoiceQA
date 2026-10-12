package provider

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"voiceqa/companion/internal/core"
)

var workspaceEmail = regexp.MustCompile(`^\S+@\S+\.\S+$`)

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
		quantity := "1"
		lastValidation := ""
		submitted := false
		for _, action := range test.Steps {
			id := workspaceTargetID(action.Target)
			if action.HTTP != nil && action.HTTP.AuthSource != "" {
				issues = append(issues, fmt.Sprintf("%s: RelayDesk uses its HttpOnly browser session automatically; authSource must be empty, never guess local:session or another bearer source", test.Name))
			}
			requiredStage := map[string]string{"customer-name": "customer", "customer-email": "customer", "shipping-method": "customer", "order-product": "items", "order-quantity": "items", "order-coupon": "items"}[id]
			if stageKnown && requiredStage != "" && stage != requiredStage && (action.Operation == "fill" || action.Operation == "select" || action.Operation == "click") {
				issues = append(issues, fmt.Sprintf("%s: %s is on the %s step, but this action is planned on %s. Select shipping before customer Next; product/quantity/coupon after it", test.Name, id, requiredStage, stage))
			}
			if (id == "auth-username" || id == "auth-password") && action.Operation == "fill" {
				issues = append(issues, fmt.Sprintf("%s: use fill_secret for %s with value=SUPPLIED_PROFILE_ALIAS:username or :password, never ordinary fill or a literal profile alias", test.Name, id))
			}
			if id == "auth-otp" && action.Operation == "fill" {
				issues = append(issues, fmt.Sprintf("%s: use fill_totp for auth-otp with the supplied profile id; never guess a literal OTP code", test.Name))
			}
			if action.Operation == "human_checkpoint" && id == "challenge-result" && action.Value != "captcha" {
				issues = append(issues, fmt.Sprintf("%s: the synthetic challenge uses human_checkpoint value=captcha, not mfa", test.Name))
			}
			if id == "identity" && action.Assertion != nil && action.Assertion.Kind == "text" && strings.HasPrefix(action.Assertion.Expected, "Authenticated as ") {
				issues = append(issues, fmt.Sprintf("%s: identity displays Alice Morgan; auth-result displays Authenticated as Alice Morgan. Choose the target matching the assertion", test.Name))
			}
			if action.Operation == "navigate" {
				stage = ""
				stageKnown = false
				customer, email, coupon, search = "", "", "", ""
				quantity = "1"
				lastValidation = ""
				submitted = false
				continue
			}
			if action.Operation == "key" && action.Value == "Escape" {
				stage = ""
				lastValidation = ""
			}
			if action.Operation == "fill" {
				if id == "customer-name" || id == "customer-email" || id == "order-coupon" || id == "order-quantity" {
					lastValidation = ""
				}
				switch id {
				case "customer-name":
					customer = action.Value
				case "customer-email":
					email = action.Value
				case "order-coupon":
					coupon = action.Value
				case "order-quantity":
					quantity = action.Value
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
					quantity = "1"
					lastValidation = ""
				case "wizard-next":
					lastValidation = ""
					switch stage {
					case "customer":
						if customer != "" && (workspaceEmail.MatchString(email) || strings.Contains(email, "${")) {
							stage = "items"
						} else {
							lastValidation = "customer"
						}
					case "items":
						n, err := strconv.Atoi(quantity)
						validQuantity := strings.Contains(quantity, "${") || err == nil && n >= 1 && n <= 5
						if !validQuantity {
							lastValidation = "quantity"
						} else if coupon == "" || coupon == "WELCOME10" {
							stage = "review"
						} else {
							lastValidation = "coupon"
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
				if stageKnown && !submitted && id == "order-id" && action.Operation == "capture_value" {
					issues = append(issues, fmt.Sprintf("%s: order-id exists only after submission. Customer Next opens items, items Next opens review, review Next submits; capture the ID only after confirmed readiness", test.Name))
				}
				continue
			}
			if stageKnown && !submitted && (id == "order-status" || id == "order-total" || id == "order-id") {
				expectsAbsence := action.Assertion.Kind == "hidden" && action.Assertion.Expected == "true" || action.Assertion.Kind == "visible" && action.Assertion.Expected == "false" || action.Assertion.Kind == "count" && action.Assertion.Expected == "0"
				if !expectsAbsence {
					issues = append(issues, fmt.Sprintf("%s: %s requires submission, but the planned wizard is still on %s. Customer Next opens items, items Next opens review, review Next submits; wait/assert confirmation only after that third Next", test.Name, id, stage))
				}
			}
			if id == "review-total" {
				expectsAbsence := (action.Assertion.Kind == "hidden" && action.Assertion.Expected == "true") || (action.Assertion.Kind == "visible" && action.Assertion.Expected == "false") || (action.Assertion.Kind == "count" && action.Assertion.Expected == "0")
				if !expectsAbsence && (!stageKnown || stage != "review") {
					issues = append(issues, fmt.Sprintf("%s: review-total exists only on the review step; assert it after the items Next and before the review Next submits the order", test.Name))
				}
			}
			if id == "wizard-error" && strings.Contains(action.Assertion.Expected, "Coupon not recognized") && lastValidation != "coupon" {
				issues = append(issues, fmt.Sprintf("%s: coupon validation runs only after clicking wizard-next with an invalid coupon on items; fill alone does not validate it. Click Next before asserting the coupon error", test.Name))
			}
			if id == "wizard-error" && strings.Contains(action.Assertion.Expected, "valid contact email") && lastValidation != "customer" {
				issues = append(issues, fmt.Sprintf("%s: click wizard-next with missing/invalid customer details before asserting the customer validation error", test.Name))
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
