package core

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

type Page struct {
	Alias  string `json:"alias"`
	URL    string `json:"url"`
	Origin string `json:"origin"`
	Title  string `json:"title,omitempty"`
}
type Handoff struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Label string `json:"label"`
	Page  string `json:"page"`
}

var AliasPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

type Scope struct {
	Current  string
	Origins  map[string]string
	Created  map[string]bool
	Approved map[string]bool
}

func NewScope(p Plan, page string) (*Scope, error) {
	s := &Scope{Current: "main", Origins: map[string]string{"main": p.Origin}, Created: map[string]bool{}, Approved: map[string]bool{p.Origin: true}}
	if len(p.Pages) > 5 {
		return nil, errors.New("share at most five pages")
	}
	seen := map[string]bool{}
	for _, v := range p.Pages {
		if seen[v.Alias] {
			return nil, errors.New("duplicate page alias")
		}
		seen[v.Alias] = true
		if !AliasPattern.MatchString(v.Alias) || !AllowedURL(v.URL, v.Origin) {
			return nil, errors.New("invalid approved page")
		}
		if v.Alias == "main" {
			if v.Origin != p.Origin || v.URL != p.URL {
				return nil, errors.New("main page does not match the selected website")
			}
		} else if s.Origins[v.Alias] != "" {
			return nil, errors.New("duplicate page alias")
		}
		s.Origins[v.Alias] = v.Origin
		s.Approved[v.Origin] = true
	}
	if page != "" {
		s.Current = page
	}
	if len(s.Origins) > 5 {
		return nil, errors.New("share at most five pages including main")
	}
	if s.Origins[s.Current] == "" {
		return nil, errors.New("case starts on an unshared page")
	}
	return s, nil
}
func (s *Scope) Advance(a Action) error {
	if a.TimeoutMS != 0 && (a.TimeoutMS < 500 || a.TimeoutMS > 30000) {
		return errors.New("step timeout must be 500–30000 milliseconds")
	}
	switch a.Operation {
	case "navigate":
		u, e := url.Parse(a.Value)
		if e != nil {
			return errors.New("invalid navigation URL")
		}
		if u.Scheme == "" || u.Host == "" {
			return errors.New("navigate.value must contain an absolute HTTP(S) URL; target is not the navigation URL field")
		}
		origin := u.Scheme + "://" + u.Host
		if !s.Approved[origin] || !AllowedURL(a.Value, origin) {
			return errors.New("navigation outside explicitly approved origins")
		}
		s.Origins[s.Current] = origin
	case "open_tab":
		u, e := url.Parse(a.Value)
		if e != nil {
			return errors.New("invalid new-tab URL")
		}
		origin := u.Scheme + "://" + u.Host
		if !AliasPattern.MatchString(a.Target) {
			return errors.New("open_tab.target must be a new lowercase page alias such as review, not a selector, label or URL")
		}
		if s.Origins[a.Target] != "" {
			return errors.New("open_tab.target already exists; use switch_tab for that alias or choose a new alias")
		}
		if len(s.Origins) >= 5 {
			return errors.New("new tab exceeds the five-page scope limit")
		}
		if !s.Approved[origin] || !AllowedURL(a.Value, origin) {
			return errors.New("open_tab.value must be an absolute URL on an explicitly approved origin")
		}
		s.Origins[a.Target] = origin
		s.Created[a.Target] = true
		s.Current = a.Target
	case "switch_tab":
		if s.Origins[a.Target] == "" {
			return errors.New("cannot switch to an unknown page")
		}
		s.Current = a.Target
	case "close_tab":
		if !s.Created[a.Target] {
			return errors.New("only run-created tabs can be closed")
		}
		delete(s.Origins, a.Target)
		delete(s.Created, a.Target)
		s.Current = "main"
	case "fill_secret":
		parts := strings.Split(a.Value, ":")
		if len(parts) != 2 || !AliasPattern.MatchString(parts[0]) || (parts[1] != "username" && parts[1] != "password") {
			return errors.New("secure entry requires profile:username or profile:password")
		}
	case "fill_totp":
		if !AliasPattern.MatchString(a.Value) {
			return errors.New("TOTP entry requires a saved profile alias")
		}
	case "human_checkpoint":
		if a.Value != "mfa" && a.Value != "captcha" && a.Value != "approval" {
			return errors.New("human checkpoint kind must be mfa, captcha, or approval")
		}
	}
	return nil
}
func (p Plan) UsesPageScopes() bool {
	if len(p.Pages) > 1 {
		return true
	}
	for _, c := range p.Cases {
		for _, a := range c.Steps {
			if a.Operation == "open_tab" || a.Operation == "switch_tab" || a.Operation == "close_tab" {
				return true
			}
		}
	}
	return false
}

func (s *Scope) Clone() *Scope {
	copy := &Scope{Current: s.Current, Origins: map[string]string{}, Created: map[string]bool{}, Approved: map[string]bool{}}
	for key, value := range s.Origins {
		copy.Origins[key] = value
	}
	for key, value := range s.Created {
		copy.Created[key] = value
	}
	for key, value := range s.Approved {
		copy.Approved[key] = value
	}
	return copy
}
