package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html/template"
	"image"
	"image/color"
	"image/png"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
)

func baselineKey(r *core.Run, idx int) string {
	step := r.Steps[idx]
	sum := sha256.Sum256([]byte(r.Plan.Origin + "|" + r.Plan.URL + "|" + step.Case + "|" + step.Action.Label + "|" + step.Viewport))
	return hex.EncodeToString(sum[:])
}
func (a *App) approveBaseline(m native.Message) (any, error) {
	var p struct {
		RunID  string `json:"runId"`
		StepID string `json:"stepId"`
	}
	if e := decode(m, &p); e != nil {
		return nil, e
	}
	var r core.Run
	if e := a.Store.Get("run", p.RunID, &r); e != nil {
		return nil, e
	}
	if r.Status != "passed" && r.Status != "needs_review" {
		return nil, errors.New("only completed healthy or review-needed runs can supply baselines")
	}
	for i, step := range r.Steps {
		if step.ID == p.StepID {
			capture, ok := step.Result["capture"].(map[string]any)
			if !ok || capture["artifactId"] == nil {
				return nil, errors.New("step has no capture")
			}
			return map[string]any{"approved": true}, a.Store.Put("baseline", baselineKey(&r, i), capture)
		}
	}
	return nil, errors.New("step not found")
}
func (a *App) compareBaseline(r *core.Run, idx int, capture map[string]any) (map[string]any, error) {
	var baseline map[string]any
	if e := a.Store.Get("baseline", baselineKey(r, idx), &baseline); e != nil {
		return nil, errors.New("No approved baseline. Review this screenshot and approve it explicitly.")
	}
	for _, key := range []string{"browserVersion", "platform", "width", "height", "dpr", "maskSelectors"} {
		if fmt.Sprint(baseline[key]) != fmt.Sprint(capture[key]) {
			return nil, fmt.Errorf("baseline environment mismatch: %s", key)
		}
	}
	old, e := a.Store.ReadArtifact(fmt.Sprint(baseline["artifactId"]))
	if e != nil {
		return nil, e
	}
	current, e := a.Store.ReadArtifact(fmt.Sprint(capture["artifactId"]))
	if e != nil {
		return nil, e
	}
	ratio, diff, e := ComparePNG(old, current)
	if e != nil {
		return nil, e
	}
	id := core.ID()
	if e = a.Store.WriteArtifact(id, diff); e != nil {
		return nil, e
	}
	status := "passed"
	if ratio > 0.005 {
		status = "failed"
	}
	return map[string]any{"status": status, "changedRatio": ratio, "threshold": 0.005, "diffArtifactId": id}, nil
}
func ComparePNG(old, current []byte) (float64, []byte, error) {
	a, e := png.Decode(bytes.NewReader(old))
	if e != nil {
		return 0, nil, e
	}
	b, e := png.Decode(bytes.NewReader(current))
	if e != nil {
		return 0, nil, e
	}
	if a.Bounds().Size() != b.Bounds().Size() {
		return 0, nil, errors.New("baseline dimensions differ")
	}
	width, height := a.Bounds().Dx(), a.Bounds().Dy()
	if width*height == 0 || width*height > 8_000_000 {
		return 0, nil, errors.New("image dimensions out of bounds")
	}
	diff := image.NewRGBA(image.Rect(0, 0, width, height))
	changed := 0
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			ar, ag, ab, _ := a.At(x, y).RGBA()
			br, bg, bb, _ := b.At(x, y).RGBA()
			if abs(int(ar>>8)-int(br>>8)) > 25 || abs(int(ag>>8)-int(bg>>8)) > 25 || abs(int(ab>>8)-int(bb>>8)) > 25 {
				changed++
				diff.Set(x, y, color.RGBA{255, 70, 90, 255})
			} else {
				v := uint8((br + bg + bb) / 3 >> 8)
				diff.Set(x, y, color.RGBA{v, v, v, 100})
			}
		}
	}
	var buf bytes.Buffer
	if e = png.Encode(&buf, diff); e != nil {
		return 0, nil, e
	}
	return float64(changed) / float64(width*height), buf.Bytes(), nil
}
func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

type junitSuite struct {
	XMLName  xml.Name    `xml:"testsuite"`
	Name     string      `xml:"name,attr"`
	Tests    int         `xml:"tests,attr"`
	Failures int         `xml:"failures,attr"`
	Errors   int         `xml:"errors,attr"`
	Cases    []junitCase `xml:"testcase"`
}
type junitCase struct {
	Name    string      `xml:"name,attr"`
	Class   string      `xml:"classname,attr"`
	Failure *junitIssue `xml:"failure,omitempty"`
	Error   *junitIssue `xml:"error,omitempty"`
	Skipped *junitIssue `xml:"skipped,omitempty"`
}
type junitIssue struct {
	Message string `xml:"message,attr"`
}

func (a *App) exportReport(m native.Message) (any, error) {
	var p struct {
		ID     string `json:"id"`
		Format string `json:"format"`
	}
	if e := decode(m, &p); e != nil {
		return nil, e
	}
	var r core.Run
	if e := a.Store.Get("run", p.ID, &r); e != nil {
		return nil, e
	}
	var b []byte
	var e error
	mime := ""
	switch p.Format {
	case "json":
		b, e = json.MarshalIndent(r, "", "  ")
		mime = "application/json"
	case "xml":
		suite := junitSuite{Name: "VoiceQA " + r.ID, Tests: len(r.Steps)}
		for _, s := range r.Steps {
			c := junitCase{Name: s.Action.Label, Class: s.Case + " " + s.Viewport}
			switch s.Status {
			case "failed":
				suite.Failures++
				c.Failure = &junitIssue{Message: stepMessage(s)}
			case "error", "dispatched":
				suite.Errors++
				c.Error = &junitIssue{Message: stepMessage(s)}
			case "blocked", "needs_review", "cancelled":
				c.Skipped = &junitIssue{Message: stepMessage(s)}
			}
			suite.Cases = append(suite.Cases, c)
		}
		if r.Status != "passed" && suite.Failures == 0 && suite.Errors == 0 {
			suite.Tests++
			suite.Errors++
			suite.Cases = append(suite.Cases, junitCase{Name: "Run completion", Error: &junitIssue{Message: r.Status + ": " + r.Error}})
		}
		b, e = xml.MarshalIndent(suite, "", "  ")
		b = append([]byte(xml.Header), b...)
		mime = "application/xml"
	case "html":
		t := template.Must(template.New("report").Parse(reportTemplate))
		var out bytes.Buffer
		type reportStep struct {
			core.Step
			Details string
			Image   template.URL
		}
		steps := []reportStep{}
		for _, s := range r.Steps {
			details, _ := json.MarshalIndent(s.Result, "", "  ")
			rs := reportStep{Step: s, Details: string(details)}
			if c, ok := s.Result["capture"].(map[string]any); ok {
				if img, err := a.Store.ReadArtifact(fmt.Sprint(c["artifactId"])); err == nil {
					rs.Image = template.URL("data:image/png;base64," + base64.StdEncoding.EncodeToString(img))
				}
			}
			steps = append(steps, rs)
		}
		e = t.Execute(&out, map[string]any{"Run": r, "Steps": steps})
		b = out.Bytes()
		mime = "text/html"
	default:
		return nil, errors.New("format must be html, json, or xml")
	}
	if e != nil {
		return nil, e
	}
	id := core.ID()
	if e = a.Store.WriteArtifact(id, b); e != nil {
		return nil, e
	}
	return map[string]any{"artifactId": id, "mime": mime, "filename": "voiceqa-" + r.ID + "." + p.Format}, nil
}
func stepMessage(s core.Step) string {
	if s.Error != "" {
		return s.Error
	}
	b, _ := json.Marshal(s.Result)
	return string(b)
}

const reportTemplate = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>VoiceQA report</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:24px;background:#101820;color:#eef4f7}article{padding:24px;margin:20px 0;border:1px solid #52616b;border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}img{max-width:100%;border-radius:8px}small{color:#c1d0d8}</style><h1>VoiceQA · {{.Run.Status}}</h1><p>{{.Run.Plan.Request}}</p><p>{{.Run.Plan.Summary}}</p><small>Run {{.Run.ID}} · Model {{.Run.Plan.Model}} · {{.Run.DurationMS}} ms · {{.Run.StartedAt}}</small><p>{{.Run.Error}}</p><p>Coverage: selected tab, DOM-grounded workflows, named visual checkpoints and automated accessibility rules. Inconclusive findings require review.</p>{{range .Steps}}<article><h2>{{.Case}} — {{.Action.Label}}</h2><p>{{.Status}} · {{.Viewport}}</p><p>{{.Error}}</p><p>Reproduce: {{.Action.Operation}} {{.Action.Target}} {{.Action.Value}}</p><pre>{{.Details}}</pre>{{if .Image}}<img src="{{.Image}}" alt="Recorded browser evidence">{{end}}</article>{{end}}</html>`
