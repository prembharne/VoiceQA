package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// HTTP checks are a fixed same-origin browser operation, not an arbitrary HTTP client.
type HTTPCheck struct {
	AuthSource     string  `json:"authSource"`
	AuthPointer    string  `json:"authPointer"`
	ExpectedType   string  `json:"expectedType"`
	Tolerance      float64 `json:"tolerance"`
	CSRFSource     string  `json:"csrfSource"`
	CSRFHeader     string  `json:"csrfHeader"`
	CSRFBodyField  string  `json:"csrfBodyField"`
	Method         string  `json:"method"`
	URL            string  `json:"url"`
	Body           string  `json:"body"`
	ExpectedStatus int     `json:"expectedStatus"`
	JSONPointer    string  `json:"jsonPointer"`
	ExpectedValue  string  `json:"expectedValue"`
	SaveAs         string  `json:"saveAs"`
	IdempotencyKey string  `json:"idempotencyKey"`
}
type Diagnosis struct {
	Category  string `json:"category"`
	Summary   string `json:"summary"`
	NextCheck string `json:"nextCheck"`
	StepID    string `json:"stepId"`
}
type Finding struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Severity       string `json:"severity"`
	Evidence       string `json:"evidence"`
	Recommendation string `json:"recommendation"`
}

var templateVariable = regexp.MustCompile(`\$\{([a-z][a-z0-9_-]{0,31})\}`)
var sensitiveVariable = regexp.MustCompile(`(?i)password|secret|token|cookie|authorization|otp|api.?key|csrf|xsrf|bearer`)
var csrfReference = regexp.MustCompile(`^(meta|input|cookie):[A-Za-z_][A-Za-z0-9_.-]{0,99}$`)
var csrfNamePattern = regexp.MustCompile(`(?i)csrf|xsrf|^__RequestVerificationToken$`)
var privateAuthReference = regexp.MustCompile(`(?i)password|otp|secret|api.?key`)
var bearerReference = regexp.MustCompile(`^(local|session|cookie):[A-Za-z_][A-Za-z0-9_.:-]{0,99}$`)

func CSRFName(name string) bool { return csrfNamePattern.MatchString(name) }

func ValidVariable(name string) bool {
	return AliasPattern.MatchString(name) && !sensitiveVariable.MatchString(name)
}

func ValidatePlan(p Plan) error {
	if e := ValidateDataset(p.Dataset); e != nil {
		return e
	}
	rows := p.Dataset
	if len(rows) == 0 {
		rows = []map[string]string{{}}
	}
	for rowIndex, row := range rows {
		expanded := p
		expanded.Cases = append([]Case(nil), p.Cases...)
		for caseIndex, c := range p.Cases {
			variables := map[string]string{}
			for k, v := range row {
				variables[k] = v
			}
			steps := make([]Action, 0, len(c.Steps))
			for stepIndex, action := range c.Steps {
				resolved, e := ResolveAction(action, variables)
				if e != nil {
					return fmt.Errorf("data row %d, case %d, step %d: %w", rowIndex+1, caseIndex+1, stepIndex+1, e)
				}
				steps = append(steps, resolved)
				if action.Operation == "capture_value" {
					variables[action.Value] = "0"
				}
				if action.HTTP != nil && action.HTTP.SaveAs != "" {
					value := "0"
					switch action.HTTP.ExpectedType {
					case "boolean":
						value = "false"
					case "null":
						value = "null"
					}
					variables[action.HTTP.SaveAs] = value
				}
			}
			expanded.Cases[caseIndex].Steps = steps
		}
		if e := validateResolvedPlan(expanded); e != nil {
			return e
		}
	}
	return nil
}

func ValidateDataset(rows []map[string]string) error {
	if len(rows) > 5 {
		return errors.New("use at most five test-data rows")
	}
	for _, row := range rows {
		if len(row) > 20 {
			return errors.New("use at most twenty public variables per row")
		}
		for name, value := range row {
			if !ValidVariable(name) || len(value) > 1000 {
				return errors.New("test variables require bounded, non-secret names and values; use credential profiles for secrets")
			}
		}
	}
	return nil
}

func Expand(value string, variables map[string]string, encodeURL bool) (string, error) {
	var missing string
	queryAt := strings.Index(value, "?")
	position := 0
	out := templateVariable.ReplaceAllStringFunc(value, func(match string) string {
		at := strings.Index(value[position:], match) + position
		position = at + len(match)
		name := templateVariable.FindStringSubmatch(match)[1]
		v, ok := variables[name]
		if !ok {
			missing = name
			return match
		}
		if encodeURL {
			if queryAt >= 0 && at > queryAt {
				return url.QueryEscape(v)
			}
			return url.PathEscape(v)
		}
		return v
	})
	if missing != "" {
		return "", fmt.Errorf("test variable %s is not available yet", missing)
	}
	return out, nil
}

func ResolveAction(action Action, variables map[string]string) (Action, error) {
	var e error
	action.Target, e = Expand(action.Target, variables, false)
	if e != nil {
		return action, e
	}
	// Capture names are identifiers; credential references can use public profile aliases from a data row.
	if action.Operation != "capture_value" {
		action.Value, e = Expand(action.Value, variables, action.Operation == "navigate" || action.Operation == "open_tab")
		if e != nil {
			return action, e
		}
	}
	if action.Assertion != nil {
		check := *action.Assertion
		check.Expected, e = Expand(check.Expected, variables, false)
		if e != nil {
			return action, e
		}
		action.Assertion = &check
	}
	if action.HTTP != nil {
		check := *action.HTTP
		check.URL, e = Expand(check.URL, variables, true)
		if e != nil {
			return action, e
		}
		check.ExpectedValue, e = Expand(check.ExpectedValue, variables, false)
		if e != nil {
			return action, e
		}
		check.IdempotencyKey, e = Expand(check.IdempotencyKey, variables, false)
		if e != nil {
			return action, e
		}
		if check.Body != "" {
			var body any
			if json.Unmarshal([]byte(check.Body), &body) != nil {
				return action, errors.New("HTTP body must be JSON")
			}
			var replace func(any) (any, error)
			replace = func(v any) (any, error) {
				switch value := v.(type) {
				case string:
					return Expand(value, variables, false)
				case map[string]any:
					for k, x := range value {
						updated, err := replace(x)
						if err != nil {
							return nil, err
						}
						value[k] = updated
					}
				case []any:
					for i, x := range value {
						updated, err := replace(x)
						if err != nil {
							return nil, err
						}
						value[i] = updated
					}
				}
				return v, nil
			}
			body, e = replace(body)
			if e != nil {
				return action, e
			}
			raw, _ := json.Marshal(body)
			check.Body = string(raw)
		}
		action.HTTP = &check
	}
	return action, nil
}

func ValidateHTTP(check *HTTPCheck, mode string, scope *Scope) error {
	if check == nil {
		return errors.New("HTTP check requires request details")
	}
	if check.AuthSource != "" {
		if !bearerReference.MatchString(check.AuthSource) || privateAuthReference.MatchString(check.AuthSource) {
			return errors.New("use a named browser bearer-token reference, never a provider API key")
		}
		if check.AuthPointer != "" && (!strings.HasPrefix(check.AuthPointer, "/") || len(check.AuthPointer) > 300 || privateAuthReference.MatchString(check.AuthPointer)) {
			return errors.New("invalid bearer-token JSON pointer")
		}
	} else if check.AuthPointer != "" {
		return errors.New("bearer-token pointer requires a browser source")
	}
	if check.ExpectedType != "" && check.ExpectedType != "number" && check.ExpectedType != "string" && check.ExpectedType != "boolean" && check.ExpectedType != "null" {
		return errors.New("unsupported expected JSON type")
	}
	if check.ExpectedType != "" && check.JSONPointer == "" {
		return errors.New("JSON type requires a checked JSON pointer")
	}
	if check.Tolerance < 0 || math.IsNaN(check.Tolerance) || math.IsInf(check.Tolerance, 0) {
		return errors.New("invalid JSON numeric tolerance")
	}
	if check.Tolerance != 0 && check.ExpectedType != "number" {
		return errors.New("numeric tolerance requires expected JSON type number")
	}
	if check.ExpectedType == "number" && (check.ExpectedValue != "" || check.SaveAs == "") {
		n, e := strconv.ParseFloat(check.ExpectedValue, 64)
		if e != nil || math.IsInf(n, 0) || math.IsNaN(n) {
			return errors.New("expected JSON number must be finite")
		}
	}
	if check.ExpectedType == "boolean" && check.ExpectedValue != "true" && check.ExpectedValue != "false" && (check.ExpectedValue != "" || check.SaveAs == "") {
		return errors.New("expected JSON boolean must be true or false")
	}
	if check.ExpectedType == "null" && check.ExpectedValue != "null" && (check.ExpectedValue != "" || check.SaveAs == "") {
		return errors.New("expected JSON null must be null")
	}
	if check.CSRFSource != "" {
		if !csrfReference.MatchString(check.CSRFSource) || !CSRFName(strings.SplitN(check.CSRFSource, ":", 2)[1]) {
			return errors.New("use a named anti-CSRF meta, input or cookie reference")
		}
		if check.CSRFHeader != "" && check.CSRFHeader != "X-CSRF-Token" && check.CSRFHeader != "X-CSRFToken" && check.CSRFHeader != "X-XSRF-TOKEN" && check.CSRFHeader != "RequestVerificationToken" && check.CSRFHeader != "CSRF-Token" {
			return errors.New("unsupported anti-CSRF header")
		}
		if check.CSRFBodyField != "" && (!CSRFName(check.CSRFBodyField) || len(check.CSRFBodyField) > 100 || check.CSRFHeader != "") {
			return errors.New("choose a named anti-CSRF body field or a header, not both")
		}
	} else if check.CSRFHeader != "" || check.CSRFBodyField != "" {
		return errors.New("anti-CSRF transport requires a source reference")
	}
	u, e := url.Parse(check.URL)
	if e != nil {
		return errors.New("invalid HTTP check URL")
	}
	origin := u.Scheme + "://" + u.Host
	if !scope.Approved[origin] || !AllowedURL(check.URL, origin) {
		return errors.New("HTTP check leaves explicitly approved origins")
	}
	if origin != scope.Origins[scope.Current] {
		return errors.New("HTTP check must use the active page's origin; switch or navigate first")
	}
	if check.Method != "GET" && check.Method != "HEAD" && check.Method != "POST" && check.Method != "PUT" && check.Method != "PATCH" && check.Method != "DELETE" {
		return errors.New("unsupported HTTP check method")
	}
	if check.Method != "GET" && check.Method != "HEAD" && mode != "security" {
		return errors.New("mutating HTTP checks require authorized logical security mode")
	}
	if (check.Method == "GET" || check.Method == "HEAD") && check.Body != "" {
		return errors.New("GET and HEAD checks cannot send a body")
	}
	if len(check.URL) > 2000 || len(check.Body) > 8000 || len(check.JSONPointer) > 300 || len(check.ExpectedValue) > 1000 || len(check.IdempotencyKey) > 100 || strings.ContainsAny(check.IdempotencyKey, "\r\n") {
		return errors.New("HTTP check exceeds its bounded input limits")
	}
	if check.Body != "" && !json.Valid([]byte(check.Body)) {
		return errors.New("HTTP body must be JSON")
	}
	if check.Body != "" {
		var body any
		_ = json.Unmarshal([]byte(check.Body), &body)
		var private func(any) bool
		private = func(v any) bool {
			switch value := v.(type) {
			case map[string]any:
				for k, x := range value {
					if sensitiveVariable.MatchString(k) || private(x) {
						return true
					}
				}
			case []any:
				for _, x := range value {
					if private(x) {
						return true
					}
				}
			}
			return false
		}
		if private(body) {
			return errors.New("HTTP bodies cannot contain credential or session-token fields; use secure browser profile entry")
		}
	}
	if check.ExpectedStatus < 100 || check.ExpectedStatus > 599 {
		return errors.New("HTTP check needs an explicit expected status")
	}
	if check.SaveAs != "" && (!ValidVariable(check.SaveAs) || check.JSONPointer == "") {
		return errors.New("HTTP capture needs a public variable name and JSON pointer")
	}
	if check.JSONPointer != "" && (!strings.HasPrefix(check.JSONPointer, "/") || sensitiveVariable.MatchString(check.JSONPointer)) {
		return errors.New("JSON pointer must reference public data, never credentials or session tokens")
	}
	return nil
}
