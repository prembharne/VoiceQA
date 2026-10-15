package core

import "testing"

func TestPageScopeBoundaries(t *testing.T) {
	p := validPlan()
	p.Pages = []Page{{Alias: "main", URL: p.URL, Origin: p.Origin}, {Alias: "login", URL: "https://login.test/", Origin: "https://login.test"}}
	s, e := NewScope(p, "main")
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Advance(Action{Operation: "open_tab", Target: "child", Value: "https://example.test/child"}); e != nil {
		t.Fatal(e)
	}
	if e = s.Advance(Action{Operation: "navigate", Value: "https://login.test/"}); e != nil {
		t.Fatal("approved SSO origin rejected", e)
	}
	if e = s.Advance(Action{Operation: "navigate", Value: "https://evil.test/"}); e == nil {
		t.Fatal("unapproved origin allowed")
	}
	if e = s.Advance(Action{Operation: "close_tab", Target: "login"}); e == nil {
		t.Fatal("shared user tab can be closed")
	}
	if e = s.Advance(Action{Operation: "close_tab", Target: "child"}); e != nil || s.Current != "main" {
		t.Fatal(e)
	}
	p.Pages = append(p.Pages, p.Pages[0])
	if _, e = NewScope(p, "main"); e == nil {
		t.Fatal("duplicate main accepted")
	}
	p.Pages = nil
	for _, alias := range []string{"one", "two", "three", "four", "five"} {
		p.Pages = append(p.Pages, Page{Alias: alias, URL: p.URL, Origin: p.Origin})
	}
	if _, e = NewScope(p, "main"); e == nil {
		t.Fatal("implicit main exceeded the five-page limit")
	}
}
func TestAdvancedInputsStayBounded(t *testing.T) {
	p := validPlan()
	s, _ := NewScope(p, "main")
	for _, a := range []Action{{Operation: "fill_secret", Value: "../../bad:password"}, {Operation: "fill_secret", Value: "qa:cookie"}, {Operation: "fill_totp", Value: "raw secret"}, {Operation: "human_checkpoint", Value: "solve"}, {Operation: "wait_for", TimeoutMS: 120001}, {Operation: "assert", TimeoutMS: 40000}} {
		if s.Advance(a) == nil {
			t.Fatal("invalid advanced action accepted", a.Operation)
		}
	}
	if e := s.Advance(Action{Operation: "wait_for", TimeoutMS: 120000}); e != nil {
		t.Fatal("bounded slow-operation wait rejected", e)
	}
}
