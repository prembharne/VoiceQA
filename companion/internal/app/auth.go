package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"voiceqa/companion/internal/auth"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
)

type AuthProfile struct {
	ID          string `json:"id"`
	Origin      string `json:"origin"`
	Label       string `json:"label"`
	Username    string `json:"username,omitempty"`
	Password    string `json:"password,omitempty"`
	TOTPSecret  string `json:"totpSecret,omitempty"`
	Algorithm   string `json:"algorithm"`
	Digits      int    `json:"digits"`
	Period      int    `json:"period"`
	HasUsername bool   `json:"hasUsername"`
	HasPassword bool   `json:"hasPassword"`
	HasTOTP     bool   `json:"hasTotp"`
}

func (p AuthProfile) public() AuthProfile {
	p.HasUsername = p.Username != ""
	p.HasPassword = p.Password != ""
	p.HasTOTP = p.TOTPSecret != ""
	p.Username = ""
	p.Password = ""
	p.TOTPSecret = ""
	return p
}
func (a *App) profile(id string) (AuthProfile, error) {
	var p AuthProfile
	if !core.AliasPattern.MatchString(id) {
		return p, errors.New("invalid test-profile alias")
	}
	raw := a.storedKey("auth-" + id + ".dpapi")
	if raw == "" {
		return p, errors.New("test profile is not configured")
	}
	e := json.Unmarshal([]byte(raw), &p)
	return p, e
}
func (a *App) authList() ([]AuthProfile, error) {
	rows, e := a.Store.List("auth-profile")
	if e != nil {
		return nil, e
	}
	out := []AuthProfile{}
	for _, row := range rows {
		var p AuthProfile
		if json.Unmarshal(row, &p) == nil {
			out = append(out, p.publicMetadata())
		}
	}
	return out, nil
}
func (p AuthProfile) publicMetadata() AuthProfile {
	p.Username = ""
	p.Password = ""
	p.TOTPSecret = ""
	return p
}
func (a *App) authDispatch(m native.Message) (any, error) {
	if m.Type == "auth.list" {
		return a.authList()
	}
	a.mu.Lock()
	active := a.activeID != ""
	a.mu.Unlock()
	if active {
		return nil, errors.New("finish or cancel the run before changing test credentials")
	}
	var p AuthProfile
	if e := decode(m, &p); e != nil {
		return nil, e
	}
	if !core.AliasPattern.MatchString(p.ID) {
		return nil, errors.New("profile alias must use lowercase letters, digits, underscores or hyphens")
	}
	if m.Type == "auth.delete" {
		e := os.Remove(filepath.Join(a.Store.Dir, "auth-"+p.ID+".dpapi"))
		if e != nil && !os.IsNotExist(e) {
			return nil, e
		}
		_, e = a.Store.DB.Exec("DELETE FROM records WHERE kind='auth-profile' AND id=?", p.ID)
		return map[string]bool{"deleted": e == nil}, e
	}
	if !core.AllowedURL(p.Origin+"/", p.Origin) || len(p.Label) > 100 || len(p.Password) > 4096 || len(p.Username) > 300 || len(p.TOTPSecret) > 2048 {
		return nil, errors.New("profile requires an exact HTTP(S) origin and bounded test credentials")
	}
	old, _ := a.profile(p.ID)
	if old.ID != "" && old.Origin != p.Origin {
		return nil, errors.New("delete the old profile before changing its bound origin")
	}
	if p.Username == "" {
		p.Username = old.Username
	}
	if p.Password == "" {
		p.Password = old.Password
	}
	if p.TOTPSecret == "" {
		p.TOTPSecret = old.TOTPSecret
	}
	if strings.HasPrefix(p.TOTPSecret, "otpauth://") {
		u, e := url.Parse(p.TOTPSecret)
		if e != nil || u.Host != "totp" {
			return nil, errors.New("use a TOTP otpauth URI")
		}
		q := u.Query()
		p.TOTPSecret = q.Get("secret")
		p.Algorithm = strings.ToLower(q.Get("algorithm"))
		p.Digits, _ = strconv.Atoi(q.Get("digits"))
		p.Period, _ = strconv.Atoi(q.Get("period"))
	}
	if p.Algorithm == "" {
		p.Algorithm = "sha1"
	}
	if p.Digits == 0 {
		p.Digits = 6
	}
	if p.Period == 0 {
		p.Period = 30
	}
	if p.Label == "" {
		p.Label = p.ID
	}
	if p.TOTPSecret != "" {
		if _, e := auth.TOTP(p.TOTPSecret, p.Algorithm, p.Digits, p.Period, time.Now()); e != nil {
			return nil, e
		}
	}
	p.HasUsername = false
	p.HasPassword = false
	p.HasTOTP = false
	raw, _ := json.Marshal(p)
	if e := a.saveSecret("auth-"+p.ID+".dpapi", string(raw)); e != nil {
		return nil, e
	}
	public := p.public()
	return public, a.Store.Put("auth-profile", p.ID, public)
}
func (a *App) secureAction(ctx context.Context, action core.Action, origin string) (core.Action, error) {
	id := strings.Split(action.Value, ":")[0]
	p, e := a.profile(id)
	if e != nil {
		return action, e
	}
	if p.Origin != origin {
		return action, errors.New("test credentials are bound to a different origin")
	}
	value := ""
	if action.Operation == "fill_totp" {
		if p.TOTPSecret == "" {
			return action, errors.New("test profile has no TOTP seed")
		}
		remaining := int64(p.Period) - time.Now().Unix()%int64(p.Period)
		if remaining < 10 {
			timer := time.NewTimer(time.Duration(remaining)*time.Second + 100*time.Millisecond)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return action, ctx.Err()
			case <-timer.C:
			}
		}
		value, e = auth.TOTP(p.TOTPSecret, p.Algorithm, p.Digits, p.Period, time.Now())
		if e != nil {
			return action, e
		}
	} else {
		parts := strings.Split(action.Value, ":")
		if len(parts) != 2 {
			return action, errors.New("invalid credential reference")
		}
		switch parts[1] {
		case "username":
			value = p.Username
		case "password":
			value = p.Password
		default:
			return action, errors.New("unknown credential field")
		}
	}
	if value == "" {
		return action, errors.New("the requested credential field is not configured")
	}
	action.Operation = "fill"
	action.Value = value
	return action, nil
}
