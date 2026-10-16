package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/provider"
	"voiceqa/companion/internal/visualagent"
)

type AgentEvidence struct {
	ID     string         `json:"id"`
	Tool   string         `json:"tool"`
	Page   string         `json:"page"`
	Result map[string]any `json:"result,omitempty"`
	Error  string         `json:"error,omitempty"`
}
type AgentAnswer struct {
	Error         string           `json:"error,omitempty"`
	RunID         string           `json:"runId,omitempty"`
	Assessment    *DebugAssessment `json:"assessment,omitempty"`
	ID            string           `json:"id"`
	Answer        string           `json:"answer"`
	Clarification string           `json:"clarification,omitempty"`
	Sources       []string         `json:"sources"`
	Evidence      []AgentEvidence  `json:"evidence"`
	Model         string           `json:"model"`
	Usage         map[string]int   `json:"usage"`
}
type agentArgs struct {
	Page   string `json:"page"`
	Target string `json:"target"`
	Query  string `json:"query"`
	URL    string `json:"url"`
}
type agentReply struct {
	Assessment *DebugAssessment `json:"assessment,omitempty"`
	Type       string           `json:"type"`
	Name       string           `json:"name,omitempty"`
	Args       agentArgs        `json:"args,omitempty"`
	Answer     string           `json:"answer,omitempty"`
	Sources    []string         `json:"sources,omitempty"`
	Question   string           `json:"question,omitempty"`
}

func publicAgentURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	u.User = nil
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

func (a *App) investigate(ctx context.Context, request, origin string, pages []core.Page, observation map[string]any, conversation []map[string]string, links bool, requestID string) (AgentAnswer, error) {
	return a.investigateWithRun(ctx, request, origin, pages, observation, conversation, links, requestID, nil)
}

func (a *App) investigateWithRun(ctx context.Context, request, origin string, pages []core.Page, observation map[string]any, conversation []map[string]string, links bool, requestID string, recorded *core.Run) (out AgentAnswer, returnedErr error) {
	ctx, cancel := context.WithTimeout(ctx, provider.PlanningTimeout)
	defer cancel()
	result := AgentAnswer{ID: core.ID(), Evidence: []AgentEvidence{{ID: "E0", Tool: "observe_page", Page: "main", Result: agentPublicEvidence(observation)}}, Usage: map[string]int{}}
	defer func() {
		if returnedErr != nil {
			out.Error = recordedText(returnedErr.Error(), 1200)
		}
		if err := a.Store.Put("investigation", result.ID, out); err != nil && returnedErr == nil {
			returnedErr = fmt.Errorf("Could not persist investigation evidence: %w", err)
			out.Error = recordedText(returnedErr.Error(), 1200)
		}
	}()
	publicPages := append([]core.Page(nil), pages...)
	for i := range publicPages {
		publicPages[i].URL = publicAgentURL(publicPages[i].URL)
	}
	settings := a.getSettings()
	result.Model = settings.Model
	visualEnabled := recorded == nil && a.visualAvailable(settings.AIProvider, settings.Model)
	visual := &visualSession{}
	defer visual.close()
	names := []string{"observe_page", "inspect_element", "search_page", "diagnostics", "accessibility"}
	if links {
		names = append(names, "read_link")
	}
	registry := []map[string]string{
		{"name": "observe_page", "purpose": "Read fresh redacted controls, results, links, constraints and visible text from an already shared page alias."},
		{"name": "inspect_element", "purpose": "Inspect one observed selector on a shared page, including input constraints, options and public attributes. Private values remain redacted."},
		{"name": "search_page", "purpose": "Search visible public page text for a phrase; return bounded matching elements and selectors."},
		{"name": "diagnostics", "purpose": "Read captured network status/timing and sanitized runtime exception locations on the primary shared page. Collection starts on demand; absent events do not establish health."},
		{"name": "accessibility", "purpose": "Read automated accessibility findings on the primary shared page. Rule checks are partial accessibility coverage."},
	}
	if visualEnabled {
		names = append(names, "visual_inspect")
		registry = append(registry, map[string]string{"name": "visual_inspect", "purpose": "Use Agent S screenshot inspection when DOM evidence cannot explain canvas controls, code editors or complex visual UI. Read-only: never clicks or enters text. page=main, query=short inspection objective, target/url empty. Visual interpretation is not an assertion."})
	}
	if links {
		registry = append(registry, map[string]string{"name": "read_link", "purpose": "Preview a previously observed parameter-free HTTP(S) link on an approved origin in a temporary inactive tab. Never submit/click; close the preview after observing it. At most three link reads."})
	}
	if recorded != nil {
		result.RunID = recorded.ID
		names = append(names, "read_run")
		registry = append(registry, map[string]string{"name": "read_run", "purpose": "Read ONLY the operator-selected historical run. page=main, target/url empty. query=summary, failures, steps:OFFSET, step:STEP_ID or observation:OBSERVATION_ID. Summary/failures list IDs; nextStepQuery pages long timelines. Step reads include full diagnostics. Results are historical evidence, not current page state. Never rerun or mutate the application."})
	}
	profiles, profileErr := a.authList()
	if profileErr != nil {
		return result, fmt.Errorf("Could not read credential availability: %w", profileErr)
	}
	publicProfiles := []AuthProfile{}
	for _, profile := range profiles {
		if profile.Origin == origin {
			publicProfiles = append(publicProfiles, profile)
			continue
		}
		for _, page := range pages {
			if page.Origin == profile.Origin {
				publicProfiles = append(publicProfiles, profile)
				break
			}
		}
	}
	seen := map[string]bool{}
	linkReads := 0
	assessmentRepair := false
	contractRepair := false
	for turn := 0; turn < 9; turn++ {
		ids := make([]string, 0, len(result.Evidence))
		for _, e := range result.Evidence {
			ids = append(ids, e.ID)
		}
		input := map[string]any{"request": request, "approvedOrigin": origin, "sharedPages": publicPages, "conversation": conversation, "tools": registry, "evidence": result.Evidence, "remainingToolCalls": 8 - turn, "credentialProfiles": publicProfiles, "permissions": map[string]bool{"linkedPageReads": links, "mutations": false, "arbitraryCode": false}}
		schema := provider.AgentSchema(names, ids)
		if recorded != nil {
			input["selectedRun"] = map[string]any{"id": recorded.ID, "status": recorded.Status, "startedAt": recorded.StartedAt, "completedAt": recorded.CompletedAt}
			schema = provider.AgentDebugSchema(names, ids)
		}
		raw, usage, err := a.aiClient(settings.AIProvider).PlanStructured(ctx, a.keyFor(settings.AIProvider), settings.Model, provider.AgentInstructions, input, schema, func(p provider.PlanProgress) {
			_ = a.emit("plan.progress", map[string]any{"requestId": requestID, "phase": p.Phase, "receivedChars": p.ReceivedChars}, "", "")
		})
		for name, n := range usage {
			result.Usage[name] += n
		}
		if err != nil {
			if provider.IsResponseContractError(err) && !contractRepair && turn < 8 && ctx.Err() == nil {
				contractRepair = true
				result.Evidence = append(result.Evidence, AgentEvidence{ID: fmt.Sprintf("E%d", turn+1), Tool: "response_validation", Page: "main", Error: "The previous model response was invalid; no tool ran. Use the recorded evidence to choose a supported read or produce a grounded answer."})
				continue
			}
			return result, agentResponseError(err, "investigation", false)
		}
		var packet struct {
			Result agentReply `json:"result"`
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		decodeErr := decoder.Decode(&packet)
		reply := packet.Result
		contractError := ""
		if decodeErr != nil {
			contractError = "Reply does not match the tool, answer or clarification schema. Use only the declared fields."
		} else {
			switch reply.Type {
			case "clarification":
				if strings.TrimSpace(reply.Question) == "" || len(reply.Question) > 2000 {
					contractError = "Clarification requires one nonempty essential question of at most 2000 characters. If evidence is sufficient, return an answer with sources, not an empty clarification."
				}
			case "answer":
				if strings.TrimSpace(reply.Answer) == "" || len(reply.Answer) > 12000 || len(reply.Sources) == 0 {
					contractError = "An answer requires bounded nonempty text and at least one supplied evidence source ID."
				}
			case "tool":
			default:
				contractError = "Return exactly one tool, answer or essential clarification."
			}
		}
		if contractError != "" {
			if contractRepair || turn == 8 {
				return result, errors.New("AI investigation reply failed validation after correction: " + contractError)
			}
			contractRepair = true
			result.Evidence = append(result.Evidence, AgentEvidence{ID: fmt.Sprintf("E%d", turn+1), Tool: "response_validation", Page: "main", Error: contractError})
			continue
		}
		switch reply.Type {
		case "answer":
			if strings.TrimSpace(reply.Answer) == "" || len(reply.Answer) > 12000 || len(reply.Sources) == 0 {
				return result, errors.New("Agent answer requires bounded text and evidence sources")
			}
			for _, id := range reply.Sources {
				found := false
				for _, e := range result.Evidence {
					if e.ID == id {
						found = true
					}
				}
				if !found {
					return result, errors.New("Agent cited unavailable evidence")
				}
			}
			if recorded != nil {
				assessmentErr := validateDebugAssessment(reply.Assessment, result.Evidence, reply.Sources)
				if assessmentErr == nil && reply.Assessment.Category == "application_behavior" {
					measuredFailure := false
					for _, step := range recorded.Steps {
						if step.Status == "failed" {
							measuredFailure = true
						}
					}
					if !measuredFailure {
						assessmentErr = errors.New("The record has no measured failed check. Successful actions followed by a blocked/invalid selector decision do not establish an application defect. Classify the actual recorded failure mechanism, not normal application behavior")
					}
				}
				if assessmentErr != nil {
					if assessmentRepair || turn == 8 {
						return result, assessmentErr
					}
					assessmentRepair = true
					result.Evidence = append(result.Evidence, AgentEvidence{ID: fmt.Sprintf("E%d", turn+1), Tool: "assessment_validation", Page: "main", Error: assessmentErr.Error()})
					continue
				}
				result.Assessment = reply.Assessment
			}
			result.Answer = reply.Answer
			result.Sources = reply.Sources
			return result, nil
		case "clarification":
			if strings.TrimSpace(reply.Question) == "" || len(reply.Question) > 2000 {
				return result, errors.New("Agent clarification is invalid")
			}
			result.Clarification = reply.Question
			return result, nil
		case "tool":
			if turn == 8 {
				return result, errors.New("Agent exhausted its investigation budget; no test actions were executed")
			}
			if reply.Args.Page == "" {
				reply.Args.Page = "main"
			}
			fingerprint, _ := json.Marshal(struct {
				Name string
				Args agentArgs
			}{reply.Name, reply.Args})
			e := AgentEvidence{ID: fmt.Sprintf("E%d", turn+1), Tool: reply.Name, Page: reply.Args.Page}
			known := false
			for _, name := range names {
				if reply.Name == name {
					known = true
				}
			}
			allowedPage := reply.Args.Page == "main"
			for _, page := range pages {
				if page.Alias == reply.Args.Page {
					allowedPage = true
				}
			}
			if !known || !allowedPage || len(reply.Args.Target) > 500 || len(reply.Args.Query) > 200 || len(reply.Args.URL) > 2000 {
				e.Error = "Tool name, page alias or argument exceeds approved scope"
			} else if seen[string(fingerprint)] {
				e.Error = "Identical tool call already attempted; use existing evidence or choose another tool"
			} else {
				seen[string(fingerprint)] = true
				if reply.Name == "read_link" {
					approved := false
					for _, page := range pages {
						if core.AllowedURL(reply.Args.URL, page.Origin) {
							approved = true
						}
					}
					if core.AllowedURL(reply.Args.URL, origin) {
						approved = true
					}
					if !approved || linkReads >= 3 {
						e.Error = "Link is outside approved origins or link budget"
					} else {
						linkReads++
					}
				}
				if e.Error == "" {
					var view map[string]any
					var toolErr error
					if reply.Name == "read_run" {
						if recorded == nil || reply.Args.Page != "main" || reply.Args.Target != "" || reply.Args.URL != "" {
							toolErr = errors.New("Read-run accepts only the selected run and its evidence query")
						} else {
							view, toolErr = recordedRunEvidence(recorded, reply.Args.Query)
						}
					} else if reply.Name == "visual_inspect" {
						if !visualEnabled || reply.Args.Page != "main" || reply.Args.Target != "" || reply.Args.URL != "" {
							toolErr = errors.New("Visual investigation accepts only a read objective on the primary shared page")
						} else {
							var visualReply visualagent.Reply
							var image map[string]any
							visualReply, image, toolErr = visual.call(ctx, a, "", origin, "Read the current screenshot without any interaction. Report only observable facts relevant to: "+request+". Inspection objective: "+reply.Args.Query+". Use agent.report for the factual observation; no clicks, typing, navigation or success claims.", "", true, result.Usage)
							if toolErr == nil && visualReply.Result.Operation != "report" {
								toolErr = errors.New("Visual investigator returned no factual report")
							}
							view = map[string]any{"agent": "agent-s3", "model": visualReply.Model, "observation": visualReply.Result.Text, "capture": image, "limitation": "Screenshot interpretation only; independently verify application state"}
						}
					} else {
						view, toolErr = a.browser(ctx, "", "", map[string]any{"operation": "agent_tool", "tool": reply.Name, "page": reply.Args.Page, "target": reply.Args.Target, "query": reply.Args.Query, "url": reply.Args.URL, "origin": origin, "allowLinks": links})
					}
					if toolErr != nil {
						if reply.Name == "visual_inspect" {
							visual.close()
						}
						e.Error = toolErr.Error()
					} else {
						e.Result = agentPublicEvidence(view)
					}
				}
			}
			result.Evidence = append(result.Evidence, e)
			_ = a.emit("agent.tool", map[string]any{"requestId": requestID, "id": e.ID, "tool": e.Tool, "page": e.Page, "failed": e.Error != ""}, "", "")
		default:
			return result, errors.New("Agent must return a tool, answer or essential clarification")
		}
	}
	return result, errors.New("Agent did not finish investigation")
}

func agentPublicEvidence(view map[string]any) map[string]any {
	raw, _ := json.Marshal(view)
	var copy map[string]any
	_ = json.Unmarshal(raw, &copy)
	var redact func(any)
	redact = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			for key, entry := range v {
				navigationValue := key == "value" && (v["operation"] == "navigate" || v["operation"] == "open_tab")
				if key == "url" || key == "href" || navigationValue {
					if raw, ok := entry.(string); ok && (strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://")) {
						v[key] = publicAgentURL(raw)
					}
				}
				redact(entry)
			}
		case []any:
			for _, entry := range v {
				redact(entry)
			}
		}
	}
	redact(copy)
	compactControlRows(copy)
	for _, name := range []string{"controls", "results", "matches", "violations"} {
		if list, ok := copy[name].([]any); ok && len(list) > 40 {
			copy[name] = list[:40]
			copy["truncated"] = true
		}
	}
	for {
		body, _ := json.Marshal(copy)
		if len(body) <= 24000 {
			break
		}
		reduced := false
		for _, name := range []string{"controls", "results", "matches", "violations", "options"} {
			if list, ok := copy[name].([]any); ok && len(list) > 1 {
				copy[name] = list[:len(list)/2]
				copy["truncated"] = true
				reduced = true
				break
			}
		}
		if !reduced {
			return map[string]any{"truncated": true, "url": copy["url"], "title": copy["title"], "limitation": "Tool output exceeded its 24KB evidence allowance. Request a narrower inspection."}
		}
	}
	return copy
}
