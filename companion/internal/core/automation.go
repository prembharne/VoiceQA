package core

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

var interactionCriterion = regexp.MustCompile(`(?i)^(click|enter|fill|select|proceed|navigate|press|set)\s`)
var viewportPolicyCriterion = regexp.MustCompile(`(?i)\b(viewport|browser width|screen width)\b`)

func ValidateAutomationPlan(p Plan) error {
	policy := p.Automation
	if policy == nil || p.Mode != "automation" || len(p.Cases) != 0 || len(p.Dataset) != 0 || p.Visual || !p.PreserveViewport || len(p.Viewports) != 1 {
		return errors.New("automation uses a reviewed goal, one current viewport and no fixed cases, data replay or baselines")
	}
	if policy.MaxActions < 1 || policy.MaxActions > 120 || len(policy.Criteria) < 1 || len(policy.Criteria) > 10 {
		return errors.New("automation requires 1-10 success criteria and an action budget of 1-120")
	}
	for _, criterion := range policy.Criteria {
		if viewportPolicyCriterion.MatchString(criterion) {
			return errors.New("browser width is an enforced policy invariant, not a completion criterion; describe only the requested application outcomes")
		}
		if interactionCriterion.MatchString(strings.TrimSpace(criterion)) {
			return errors.New("success criteria must describe observable final outcomes, not interaction instructions")
		}
		if strings.TrimSpace(criterion) == "" || len(criterion) > 500 {
			return errors.New("automation success criterion is empty or exceeds 500 characters")
		}
	}
	if _, err := NewScope(p, "main"); err != nil {
		return err
	}
	v := p.Viewports[0]
	if v.Width < 1 || v.Width > 16384 || v.Height < 1 || v.Height > 16384 {
		return errors.New("current viewport is out of bounds")
	}
	return nil
}

func ValidateAutomationAction(p Plan, scope *Scope, action Action) error {
	if p.Automation == nil || action.Operation == "security_audit" {
		return errors.New("operation is not enabled in browser automation")
	}
	if !p.Automation.AllowConsequential {
		if action.HTTP != nil && action.HTTP.Method == "DELETE" {
			return errors.New("DELETE requires consequential-action permission")
		}
		if action.Operation == "navigate" || action.Operation == "open_tab" || action.HTTP != nil {
			raw := action.Value
			if action.HTTP != nil {
				raw = action.HTTP.URL
			}
			u, err := url.Parse(raw)
			if err != nil {
				return err
			}
			path, _ := url.PathUnescape(u.Path)
			for _, part := range strings.Split(strings.ToLower(path), "/") {
				switch part {
				case "delete", "remove", "logout", "signout", "pay", "purchase", "transfer", "publish", "send", "reset":
					return errors.New("action route requires consequential-action permission")
				}
			}
		}
	}
	return ValidateScopedAction(p, scope, action)
}
