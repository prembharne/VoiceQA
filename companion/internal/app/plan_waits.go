package app

import "voiceqa/companion/internal/core"

// Compile a redundant wait/assert pair without inventing an expectation. The
// following assertion is still executed and recorded independently. No actions
// or tab transitions may occur between the wait and its matching assertion.
func normalizeDraftWaits(cases []core.Case) {
	for ci := range cases {
		steps := cases[ci].Steps
		for si := 0; si < len(steps); si++ {
			wait := &steps[si]
			if wait.Operation != "wait_for" || wait.Assertion != nil {
				continue
			}
			for next := si + 1; next < len(steps); next++ {
				check := steps[next]
				if check.Operation != "assert" && check.Operation != "wait_for" {
					break
				}
				if check.Operation == "assert" && check.Target == wait.Target && check.Assertion != nil {
					condition := *check.Assertion
					wait.Assertion = &condition
					break
				}
			}
			if wait.Assertion == nil && wait.Target != "" {
				// The conventional element-readiness default is visibility. This
				// is a precondition, never a substituted business-result assertion.
				wait.Assertion = &core.Assertion{Kind: "visible", Expected: "true"}
			}
		}
	}
}
