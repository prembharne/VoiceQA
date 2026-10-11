//go:build windows

package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestTestCredentialEncryptionAndOriginBinding(t *testing.T) {
	a := newTestApp(t)
	p := AuthProfile{ID: "qa", Origin: "https://example.test", Username: "test-user", Password: "private-password", TOTPSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"}
	result, e := a.dispatch(message("auth.save", p))
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(result)
	for _, v := range []string{p.Username, p.Password, p.TOTPSecret} {
		if bytes.Contains(raw, []byte(v)) {
			t.Fatal("profile secret exposed")
		}
	}
	disk, e := os.ReadFile(filepath.Join(a.Store.Dir, "auth-qa.dpapi"))
	if e != nil || bytes.Contains(disk, []byte(p.Password)) {
		t.Fatal("password not encrypted", e)
	}
	index, _ := a.Store.List("auth-profile")
	if bytes.Contains(index[0], []byte(p.Password)) {
		t.Fatal("plaintext index")
	}
	if _, e = a.secureAction(context.Background(), core.Action{Operation: "fill_secret", Value: "qa:password"}, "https://evil.test"); e == nil {
		t.Fatal("credential can cross origin")
	}
	entered, e := a.secureAction(context.Background(), core.Action{Operation: "fill_secret", Value: "qa:password"}, p.Origin)
	if e != nil || entered.Value != p.Password {
		t.Fatal("secure resolution failed", e)
	}
	p.Username = ""
	p.Password = ""
	p.TOTPSecret = ""
	if _, e = a.dispatch(message("auth.save", p)); e != nil {
		t.Fatal(e)
	}
	saved, _ := a.profile("qa")
	if saved.Password != "private-password" {
		t.Fatal("blank field erased password")
	}
}

func TestAdvancedPlannerUsesPublicProfilesAndSharedScopes(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	p := AuthProfile{ID: "qa", Origin: "https://login.test", Username: "secret-user", Password: "secret-password", TOTPSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"}
	if _, e := a.dispatch(message("auth.save", p)); e != nil {
		t.Fatal(e)
	}
	pages := []core.Page{{Alias: "main", URL: "https://example.test/", Origin: "https://example.test"}, {Alias: "login", URL: "https://login.test/", Origin: "https://login.test"}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Input string `json:"input"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		for _, secret := range []string{p.Username, p.Password, p.TOTPSecret} {
			if strings.Contains(body.Input, secret) {
				t.Error("secret reached model input")
			}
		}
		var input struct {
			Profiles []AuthProfile `json:"authProfiles"`
			Pages    []core.Page   `json:"sharedPages"`
		}
		_ = json.Unmarshal([]byte(body.Input), &input)
		if len(input.Profiles) != 1 || !input.Profiles[0].HasTOTP || len(input.Pages) != 2 {
			t.Error("missing public profile/page context")
		}
		mockStructured(w, map[string]any{"summary": "Test login", "result": map[string]any{"type": "plan", "cases": []any{map[string]any{"name": "MFA", "goal": "Verify login", "page": "login", "steps": []core.Action{
			{Operation: "navigate", Value: "https://login.test/", Label: "Reset"},
			{Operation: "fill_secret", Target: "#username", Value: "qa:username", Label: "Test username"},
			{Operation: "fill_totp", Target: "#otp", Value: "qa", Label: "TOTP"},
			{Operation: "assert", Target: "#success", Label: "Verify", Assertion: &core.Assertion{Kind: "visible", Expected: "true"}},
		}}}}})
	}))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	plan, e := a.draftPlan(context.Background(), "Verify MFA", "https://example.test/", "https://example.test", false, map[string]any{}, pages...)
	if e != nil || core.ValidatePlan(plan) != nil || plan.Cases[0].Page != "login" {
		t.Fatal("advanced model draft rejected", e)
	}
}
