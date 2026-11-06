package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

var fraudClient = &http.Client{
	Timeout:       3 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

type riskAssessment struct {
	Score        int
	Level        string
	Decision     string
	Model        string
	MatchedRules []matchedRule
}

// assessWithRules scores a hypothetical payment with the organization's rules.
// Without a kind it checks every payment type and keeps the strictest result.
func assessWithRules(ctx context.Context, q querier, org, kind string, amount int64, currency string) (riskAssessment, error) {
	kinds := []string{"collection", "transfer", "payout"}
	if kind != "" {
		kinds = []string{kind}
	}
	result := riskAssessment{Decision: "allow", Level: "low", Model: "rules-v1", MatchedRules: []matchedRule{}}
	seen := map[string]bool{}
	for _, k := range kinds {
		outcome, err := evaluateRisk(ctx, q, org, riskSubject{Kind: k, Amount: amount, Currency: currency})
		if err != nil {
			return result, err
		}
		for _, match := range outcome.MatchedRules {
			if !seen[match.ID] {
				seen[match.ID] = true
				result.MatchedRules = append(result.MatchedRules, match)
			}
		}
		if riskSeverity[outcome.Decision] > riskSeverity[result.Decision] {
			result.Decision = outcome.Decision
		}
	}
	switch result.Decision {
	case "review":
		result.Score, result.Level = 60, "medium"
	case "block":
		result.Score, result.Level = 100, "high"
	}
	return result, nil
}

// assessWithService calls the optional external scoring service.
func assessWithService(ctx context.Context, serviceURL string, amount int64, currency, reference string) (riskAssessment, error) {
	body, _ := json.Marshal(map[string]any{"amount": amount, "currency": currency, "transaction_reference": reference})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(serviceURL, "/")+"/v1/analyze", bytes.NewReader(body))
	if err != nil {
		return riskAssessment{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := fraudClient.Do(req)
	if err != nil {
		return riskAssessment{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return riskAssessment{}, errors.New("scoring service returned an error")
	}
	var result struct {
		Score    int    `json:"risk_score"`
		Level    string `json:"risk_level"`
		Decision string `json:"decision"`
		Model    string `json:"model_version"`
	}
	if err = json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(&result); err != nil {
		return riskAssessment{}, err
	}
	if result.Score < 0 || result.Score > 100 || result.Model == "" || (result.Decision != "allow" && result.Decision != "review" && result.Decision != "block") {
		return riskAssessment{}, errors.New("scoring service returned an invalid assessment")
	}
	return riskAssessment{Score: result.Score, Level: result.Level, Decision: result.Decision, Model: result.Model, MatchedRules: []matchedRule{}}, nil
}

func (a *App) fraud(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) == 2 && parts[1] == "analyze" && r.Method == http.MethodPost {
		var in struct {
			Amount    int64  `json:"amount"`
			Currency  string `json:"currency"`
			Reference string `json:"transaction_reference"`
			Kind      string `json:"kind"`
		}
		if decode(r, &in) != nil || in.Amount <= 0 || len(in.Currency) != 3 || strings.TrimSpace(in.Reference) == "" {
			bad(w, r, "positive amount, three-letter currency, and transaction_reference are required")
			return
		}
		if in.Kind != "" && in.Kind != "collection" && in.Kind != "transfer" && in.Kind != "payout" {
			bad(w, r, "kind must be collection, transfer or payout")
			return
		}
		rules, err := assessWithRules(r.Context(), a.db, org, in.Kind, in.Amount, in.Currency)
		if err != nil {
			writeJSON(w, 500, problem{Error: "risk evaluation failed", RequestID: requestID(r)})
			return
		}
		result := rules
		// An external scorer is optional. Its opinion only ever makes the
		// outcome stricter, and if it is down the rules still decide.
		if service := strings.TrimSpace(env("FRAUD_SERVICE_URL", "")); service != "" {
			scored, serviceErr := assessWithService(r.Context(), service, in.Amount, in.Currency, in.Reference)
			if serviceErr != nil {
				slog.Warn("fraud scoring service unavailable; using risk rules only", "error", serviceErr)
			} else if riskSeverity[scored.Decision] > riskSeverity[rules.Decision] {
				scored.MatchedRules = rules.MatchedRules
				result = scored
			}
		}
		assessmentID := "ras_" + newID()
		tx, err := a.db.BeginTx(r.Context(), nil)
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer tx.Rollback()
		_, err = tx.ExecContext(r.Context(), `INSERT INTO risk_assessments(id,organization_id,transaction_reference,risk_score,risk_level,decision,model_version,subject_type,matched_rules) VALUES($1,$2,$3,$4,$5,$6,$7,'manual',$8::jsonb)`, assessmentID, org, in.Reference, result.Score, result.Level, result.Decision, result.Model, string(mustJSON(result.MatchedRules)))
		if err != nil {
			writeJSON(w, 500, problem{Error: "risk assessment could not be recorded"})
			return
		}
		var caseID any
		if result.Decision == "review" || result.Decision == "block" {
			id := "case_" + newID()
			if _, err = tx.ExecContext(r.Context(), `INSERT INTO fraud_cases(id,organization_id,assessment_id,priority) VALUES($1,$2,$3,$4)`, id, org, assessmentID, result.Level); err != nil {
				writeJSON(w, 500, problem{Error: "fraud review case could not be created"})
				return
			}
			caseID = id
			if _, err = tx.ExecContext(r.Context(), `INSERT INTO outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'fraud_case',$3,'fraud.case.opened',jsonb_build_object('case_id',$3::text,'assessment_id',$4::text,'priority',$5::text))`, "evt_"+newID(), org, id, assessmentID, result.Level); err != nil {
				writeJSON(w, 500, problem{Error: "fraud case event could not be recorded"})
				return
			}
		}
		if err = tx.Commit(); err != nil {
			writeJSON(w, 409, problem{Error: "risk assessment conflict"})
			return
		}
		writeJSON(w, 200, map[string]any{"id": assessmentID, "transaction_reference": in.Reference, "risk_score": result.Score, "risk_level": result.Level, "decision": result.Decision, "model_version": result.Model, "matched_rules": result.MatchedRules, "case_id": caseID})
		return
	}
	if len(parts) == 4 && parts[1] == "cases" && parts[3] == "resolve" && r.Method == http.MethodPost {
		var in struct {
			Note    string `json:"note"`
			Outcome string `json:"outcome"`
		}
		if decode(r, &in) != nil || strings.TrimSpace(in.Note) == "" || (in.Outcome != "confirmed" && in.Outcome != "false_positive") {
			bad(w, r, "note and outcome (confirmed or false_positive) are required")
			return
		}
		tx, err := a.db.BeginTx(r.Context(), nil)
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer tx.Rollback()
		res, err := tx.ExecContext(r.Context(), `UPDATE fraud_cases SET status='resolved',resolved_at=now() WHERE id=$1 AND organization_id=$2 AND status<>'resolved'`, parts[2], org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "case update failed"})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			notFound(w, r)
			return
		}
		p := principalFrom(r)
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO fraud_case_notes(id,organization_id,case_id,author_id,note) VALUES($1,$2,$3,$4,$5)`, "note_"+newID(), org, parts[2], nullable(p.userID), in.Note); err != nil {
			writeJSON(w, 500, problem{Error: "case note could not be saved"})
			return
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'fraud.case.resolved','fraud_case',$4,jsonb_build_object('outcome',$5::text))`, "aud_"+newID(), org, nullable(p.userID), parts[2], in.Outcome); err != nil {
			writeJSON(w, 500, problem{Error: "audit record could not be saved"})
			return
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'fraud_case',$3,'fraud.case.resolved',jsonb_build_object('case_id',$3::text,'outcome',$4::text))`, "evt_"+newID(), org, parts[2], in.Outcome); err != nil {
			writeJSON(w, 500, problem{Error: "event could not be saved"})
			return
		}
		if err = tx.Commit(); err != nil {
			writeJSON(w, 409, problem{Error: "case review conflict"})
			return
		}
		writeJSON(w, 200, map[string]any{"id": parts[2], "status": "resolved", "outcome": in.Outcome})
		return
	}
	if len(parts) == 2 && parts[1] == "cases" && r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `SELECT c.id,c.status,c.priority,c.created_at,a.transaction_reference,a.risk_score,a.risk_level FROM fraud_cases c JOIN risk_assessments a ON a.id=c.assessment_id AND a.organization_id=c.organization_id WHERE c.organization_id=$1 ORDER BY c.created_at DESC LIMIT 100`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer rows.Close()
		data := []map[string]any{}
		for rows.Next() {
			var id, status, priority, reference, level string
			var score int
			var created time.Time
			if rows.Scan(&id, &status, &priority, &created, &reference, &score, &level) == nil {
				data = append(data, map[string]any{"id": id, "status": status, "priority": priority, "created_at": created, "transaction_reference": reference, "risk_score": score, "risk_level": level})
			}
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	notFound(w, r)
}
