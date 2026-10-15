package app

import (
	"testing"
	"voiceqa/companion/internal/core"
)

func TestReviewRejectsInventedSourcesAndInvalidLocations(t *testing.T) {
	p := core.Plan{Cases: []core.Case{{Steps: []core.Action{{Operation: "http_check"}}}}}
	sources := []draftReviewSource{{ID: "guide-text", Text: "Same key and same payload returns the same order ID with HTTP 201."}}
	finding := draftReviewFinding{Location: "case:1:step:1", Source: "guide-text", Reason: "Use the documented replay status."}
	review := draftReview{Verdict: "revise", Findings: []draftReviewFinding{finding}}
	if err := validateDraftReview(review, p, sources); err != nil {
		t.Fatal(err)
	}
	for _, edit := range []func(*draftReviewFinding){
		func(f *draftReviewFinding) { f.Source = "invented" },
		func(f *draftReviewFinding) { f.Source = "" },
		func(f *draftReviewFinding) { f.Location = "case:2:step:1" },
		func(f *draftReviewFinding) { f.Location = "case:1:step:2" },
	} {
		changed := finding
		edit(&changed)
		if validateDraftReview(draftReview{Verdict: "revise", Findings: []draftReviewFinding{changed}}, p, sources) == nil {
			t.Fatal("Ungrounded reviewer accepted", changed)
		}
	}
	review.Verdict = "ready"
	if validateDraftReview(review, p, sources) == nil {
		t.Fatal("Ready verdict accepted with correction findings")
	}
}
