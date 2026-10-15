package app

import (
	"voiceqa/companion/internal/core"
)

// progressRouter switches the live actor when DOM evidence stops advancing.
// Reviewed QA uses pre-dispatch target failure; investigations expose a
// read-only visual tool. All three paths share visualAvailable's model policy.
type progressRouter struct {
	fingerprint                   string
	unchanged, reads, visualTurns int
	visual                        bool
}

func (p *progressRouter) observe(observation map[string]any) {
	// Focus and snapshot ordering alone do not establish workflow progress.
	hash := automationStateFingerprint(core.Action{}, map[string]any{"url": observation["url"], "controls": observation["controls"], "results": observation["results"], "text": observation["text"]})
	if hash == p.fingerprint {
		p.unchanged++
	} else {
		p.fingerprint = hash
		p.unchanged = 0
		p.reads = 0
	}
}
func (p *progressRouter) reason(available bool, rejected bool, readBudget int) string {
	if !available {
		return ""
	}
	if rejected {
		return "DOM target/decision rejected before dispatch"
	}
	if readBudget <= 2 {
		return "DOM read budget nearly exhausted"
	}
	if p.reads >= 4 {
		return "Repeated DOM reads without an executed action"
	}
	if p.unchanged >= 2 {
		return "Page evidence unchanged across repeated decisions"
	}
	return ""
}
