package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// querier is satisfied by both *sql.DB and *sql.Tx.
type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

type riskRule struct {
	ID                    string    `json:"id"`
	Name                  string    `json:"name"`
	Enabled               bool      `json:"enabled"`
	Priority              int       `json:"priority"`
	AppliesTo             []string  `json:"applies_to"`
	Currency              *string   `json:"currency"`
	MinAmountMinor        *int64    `json:"min_amount_minor"`
	MaxAmountMinor        *int64    `json:"max_amount_minor"`
	VelocityCount         *int      `json:"velocity_count"`
	VelocityWindowMinutes *int      `json:"velocity_window_minutes"`
	Action                string    `json:"action"`
	CreatedAt             time.Time `json:"created_at"`
	UpdatedAt             time.Time `json:"updated_at"`
}

// riskSubject is the record being checked before it is written.
type riskSubject struct {
	Kind            string `json:"kind"`
	Amount          int64  `json:"amount"`
	Currency        string `json:"currency"`
	CustomerID      string `json:"customer_id,omitempty"`
	SourceAccountID string `json:"source_account_id,omitempty"`
}

type matchedRule struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Action string `json:"action"`
	Reason string `json:"reason"`
}

type riskOutcome struct {
	Decision     string        `json:"decision"`
	MatchedRules []matchedRule `json:"matched_rules"`
	AssessmentID string        `json:"assessment_id,omitempty"`
	CaseID       string        `json:"case_id,omitempty"`
}

var riskSeverity = map[string]int{"allow": 0, "review": 1, "block": 2}

var errRiskBlocked = errors.New("blocked by a risk rule")

const riskRuleColumns = `id,name,enabled,priority,array_to_json(applies_to),currency,min_amount_minor,max_amount_minor,velocity_count,velocity_window_minutes,action,created_at,updated_at`

func scanRiskRule(row interface{ Scan(...any) error }) (riskRule, error) {
	var rule riskRule
	var applies []byte
	var currency sql.NullString
	var minAmount, maxAmount sql.NullInt64
	var velocityCount, velocityWindow sql.NullInt32
	err := row.Scan(&rule.ID, &rule.Name, &rule.Enabled, &rule.Priority, &applies, &currency, &minAmount, &maxAmount, &velocityCount, &velocityWindow, &rule.Action, &rule.CreatedAt, &rule.UpdatedAt)
	if err != nil {
		return rule, err
	}
	if err = json.Unmarshal(applies, &rule.AppliesTo); err != nil {
		return rule, err
	}
	if currency.Valid {
		c := strings.TrimSpace(currency.String)
		rule.Currency = &c
	}
	if minAmount.Valid {
		rule.MinAmountMinor = &minAmount.Int64
	}
	if maxAmount.Valid {
		rule.MaxAmountMinor = &maxAmount.Int64
	}
	if velocityCount.Valid {
		v := int(velocityCount.Int32)
		rule.VelocityCount = &v
	}
	if velocityWindow.Valid {
		v := int(velocityWindow.Int32)
		rule.VelocityWindowMinutes = &v
	}
	return rule, nil
}

// evaluateRisk applies the organization's enabled rules to a subject. Every
// condition a rule sets must hold for it to match.
func evaluateRisk(ctx context.Context, q querier, org string, s riskSubject) (riskOutcome, error) {
	outcome := riskOutcome{Decision: "allow", MatchedRules: []matchedRule{}}
	rows, err := q.QueryContext(ctx, `SELECT `+riskRuleColumns+` FROM risk_rules WHERE organization_id=$1 AND enabled AND $2=ANY(applies_to) ORDER BY priority,created_at`, org, s.Kind)
	if err != nil {
		return outcome, err
	}
	rules := []riskRule{}
	for rows.Next() {
		rule, scanErr := scanRiskRule(rows)
		if scanErr != nil {
			_ = rows.Close()
			return outcome, scanErr
		}
		rules = append(rules, rule)
	}
	if err = rows.Close(); err != nil {
		return outcome, err
	}
	currency := strings.ToUpper(strings.TrimSpace(s.Currency))
	for _, rule := range rules {
		reasons := []string{}
		if rule.Currency != nil {
			if *rule.Currency != currency {
				continue
			}
			reasons = append(reasons, "currency "+currency)
		}
		if rule.MinAmountMinor != nil {
			if s.Amount < *rule.MinAmountMinor {
				continue
			}
			reasons = append(reasons, fmt.Sprintf("amount ≥ %d", *rule.MinAmountMinor))
		}
		if rule.MaxAmountMinor != nil {
			if s.Amount > *rule.MaxAmountMinor {
				continue
			}
			reasons = append(reasons, fmt.Sprintf("amount ≤ %d", *rule.MaxAmountMinor))
		}
		if rule.VelocityCount != nil && rule.VelocityWindowMinutes != nil {
			recent, countErr := recentActivity(ctx, q, org, s, *rule.VelocityWindowMinutes)
			if countErr != nil {
				return outcome, countErr
			}
			// This record would be number recent+1 in the window.
			if recent+1 <= *rule.VelocityCount {
				continue
			}
			reasons = append(reasons, fmt.Sprintf("%d %ss within %d minutes (limit %d)", recent+1, s.Kind, *rule.VelocityWindowMinutes, *rule.VelocityCount))
		}
		if len(reasons) == 0 {
			reasons = append(reasons, "applies to every "+s.Kind)
		}
		outcome.MatchedRules = append(outcome.MatchedRules, matchedRule{ID: rule.ID, Name: rule.Name, Action: rule.Action, Reason: strings.Join(reasons, "; ")})
		if riskSeverity[rule.Action] > riskSeverity[outcome.Decision] {
			outcome.Decision = rule.Action
		}
	}
	return outcome, nil
}

// recentActivity counts records of the subject's kind in the window, scoped to
// the customer (collections) or source account (transfers) when known.
func recentActivity(ctx context.Context, q querier, org string, s riskSubject, minutes int) (int, error) {
	var count int
	var err error
	window := time.Duration(minutes) * time.Minute
	since := time.Now().UTC().Add(-window)
	switch s.Kind {
	case "collection":
		err = q.QueryRowContext(ctx, `SELECT count(*) FROM collections WHERE organization_id=$1 AND created_at>=$2 AND ($3='' OR customer_id=$3) AND status<>'cancelled'`, org, since, s.CustomerID).Scan(&count)
	case "transfer":
		err = q.QueryRowContext(ctx, `SELECT count(*) FROM transfers WHERE organization_id=$1 AND created_at>=$2 AND ($3='' OR source_account_id=$3) AND status<>'rejected'`, org, since, s.SourceAccountID).Scan(&count)
	case "payout":
		err = q.QueryRowContext(ctx, `SELECT count(*) FROM bank_payout_instructions WHERE organization_id=$1 AND created_at>=$2 AND status NOT IN ('rejected','cancelled')`, org, since).Scan(&count)
	}
	return count, err
}

// recordRiskOutcome stores an assessment for a subject that matched rules and
// opens a review case for review or block decisions.
func recordRiskOutcome(ctx context.Context, tx *sql.Tx, org, subjectType, subjectID, reference string, outcome *riskOutcome) error {
	if len(outcome.MatchedRules) == 0 {
		return nil
	}
	score, level := 0, "low"
	switch outcome.Decision {
	case "review":
		score, level = 60, "medium"
	case "block":
		score, level = 100, "high"
	}
	outcome.AssessmentID = "ras_" + newID()
	_, err := tx.ExecContext(ctx, `INSERT INTO risk_assessments(id,organization_id,transaction_reference,risk_score,risk_level,decision,model_version,subject_type,subject_id,matched_rules) VALUES($1,$2,$3,$4,$5,$6,'rules-v1',$7,$8,$9::jsonb)`,
		outcome.AssessmentID, org, reference, score, level, outcome.Decision, subjectType, subjectID, string(mustJSON(outcome.MatchedRules)))
	if err != nil || outcome.Decision == "allow" {
		return err
	}
	outcome.CaseID = "case_" + newID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO fraud_cases(id,organization_id,assessment_id,priority) VALUES($1,$2,$3,$4)`, outcome.CaseID, org, outcome.AssessmentID, level); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'fraud_case',$3,'fraud.case.opened',jsonb_build_object('case_id',$3::text,'assessment_id',$4::text,'priority',$5::text,'subject_type',$6::text,'subject_id',$7::text))`,
		"evt_"+newID(), org, outcome.CaseID, outcome.AssessmentID, level, subjectType, subjectID)
	return err
}

// openRiskCase reports whether a record is held by an unresolved risk case.
func openRiskCase(ctx context.Context, q querier, org, subjectType, subjectID string) (bool, error) {
	var open bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM fraud_cases c JOIN risk_assessments a ON a.id=c.assessment_id AND a.organization_id=c.organization_id WHERE c.organization_id=$1 AND a.subject_type=$2 AND a.subject_id=$3 AND c.status<>'resolved')`, org, subjectType, subjectID).Scan(&open)
	return open, err
}

func riskBlocked(w http.ResponseWriter, r *http.Request, outcome riskOutcome) {
	names := []string{}
	for _, rule := range outcome.MatchedRules {
		if rule.Action == "block" {
			names = append(names, rule.Name)
		}
	}
	writeJSON(w, 422, map[string]any{"error": "blocked by risk rule: " + strings.Join(names, ", "), "risk": outcome, "request_id": requestID(r)})
}

type riskRuleInput struct {
	Name                  string   `json:"name"`
	Enabled               *bool    `json:"enabled"`
	Priority              *int     `json:"priority"`
	AppliesTo             []string `json:"applies_to"`
	Currency              *string  `json:"currency"`
	MinAmountMinor        *int64   `json:"min_amount_minor"`
	MaxAmountMinor        *int64   `json:"max_amount_minor"`
	VelocityCount         *int     `json:"velocity_count"`
	VelocityWindowMinutes *int     `json:"velocity_window_minutes"`
	Action                string   `json:"action"`
}

func (in *riskRuleInput) validate() error {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 120 {
		return errors.New("name is required (up to 120 characters)")
	}
	if _, ok := riskSeverity[in.Action]; !ok {
		return errors.New("action must be allow, review or block")
	}
	if len(in.AppliesTo) == 0 {
		return errors.New("applies_to needs at least one of collection, transfer, payout")
	}
	for _, kind := range in.AppliesTo {
		if kind != "collection" && kind != "transfer" && kind != "payout" {
			return errors.New("applies_to accepts collection, transfer and payout")
		}
	}
	if in.Currency != nil {
		c := strings.ToUpper(strings.TrimSpace(*in.Currency))
		if c == "" {
			in.Currency = nil
		} else if len(c) != 3 || !asciiCurrency(c) {
			return errors.New("currency must be a three-letter ISO 4217 code")
		} else {
			in.Currency = &c
		}
	}
	for _, v := range []*int64{in.MinAmountMinor, in.MaxAmountMinor} {
		if v != nil && *v <= 0 {
			return errors.New("amount bounds must be positive minor-unit amounts")
		}
	}
	if in.MinAmountMinor != nil && in.MaxAmountMinor != nil && *in.MinAmountMinor > *in.MaxAmountMinor {
		return errors.New("min_amount_minor cannot exceed max_amount_minor")
	}
	if (in.VelocityCount == nil) != (in.VelocityWindowMinutes == nil) {
		return errors.New("velocity_count and velocity_window_minutes must be set together")
	}
	if in.VelocityCount != nil && (*in.VelocityCount < 1 || *in.VelocityWindowMinutes < 1 || *in.VelocityWindowMinutes > 43200) {
		return errors.New("velocity needs a positive count and a window of 1 to 43200 minutes")
	}
	return nil
}

func (a *App) riskRules(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	p := principalFrom(r)
	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		rows, err := a.db.QueryContext(r.Context(), `SELECT `+riskRuleColumns+` FROM risk_rules WHERE organization_id=$1 ORDER BY priority,created_at`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "risk rules unavailable", RequestID: requestID(r)})
			return
		}
		defer rows.Close()
		data := []riskRule{}
		for rows.Next() {
			rule, scanErr := scanRiskRule(rows)
			if scanErr != nil {
				writeJSON(w, 500, problem{Error: "risk rules unavailable", RequestID: requestID(r)})
				return
			}
			data = append(data, rule)
		}
		writeJSON(w, 200, map[string]any{"data": data})
	case len(parts) == 2 && parts[1] == "evaluate" && r.Method == http.MethodPost:
		var in riskSubject
		if decode(r, &in) != nil || in.Amount <= 0 || len(strings.TrimSpace(in.Currency)) != 3 || (in.Kind != "collection" && in.Kind != "transfer" && in.Kind != "payout") {
			bad(w, r, "kind (collection, transfer or payout), positive amount and three-letter currency are required")
			return
		}
		outcome, err := evaluateRisk(r.Context(), a.db, org, in)
		if err != nil {
			writeJSON(w, 500, problem{Error: "risk evaluation failed", RequestID: requestID(r)})
			return
		}
		writeJSON(w, 200, map[string]any{"decision": outcome.Decision, "matched_rules": outcome.MatchedRules, "mode": "dry_run"})
	case len(parts) == 1 && r.Method == http.MethodPost, len(parts) == 2 && r.Method == http.MethodPut:
		var in riskRuleInput
		if decode(r, &in) != nil {
			bad(w, r, "a JSON risk rule is required")
			return
		}
		if err := in.validate(); err != nil {
			bad(w, r, err.Error())
			return
		}
		enabled, priority := true, 100
		if in.Enabled != nil {
			enabled = *in.Enabled
		}
		if in.Priority != nil {
			priority = *in.Priority
		}
		var row *sql.Row
		action := "risk_rule.created"
		if r.Method == http.MethodPost {
			row = a.db.QueryRowContext(r.Context(), `INSERT INTO risk_rules(id,organization_id,name,enabled,priority,applies_to,currency,min_amount_minor,max_amount_minor,velocity_count,velocity_window_minutes,action,created_by)
				VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING `+riskRuleColumns,
				"rsk_"+newID(), org, in.Name, enabled, priority, in.AppliesTo, in.Currency, in.MinAmountMinor, in.MaxAmountMinor, in.VelocityCount, in.VelocityWindowMinutes, in.Action, nullable(p.userID))
		} else {
			action = "risk_rule.updated"
			row = a.db.QueryRowContext(r.Context(), `UPDATE risk_rules SET name=$3,enabled=$4,priority=$5,applies_to=$6,currency=$7,min_amount_minor=$8,max_amount_minor=$9,velocity_count=$10,velocity_window_minutes=$11,action=$12,updated_at=now()
				WHERE id=$1 AND organization_id=$2 RETURNING `+riskRuleColumns,
				parts[1], org, in.Name, enabled, priority, in.AppliesTo, in.Currency, in.MinAmountMinor, in.MaxAmountMinor, in.VelocityCount, in.VelocityWindowMinutes, in.Action)
		}
		rule, err := scanRiskRule(row)
		if err == sql.ErrNoRows {
			notFound(w, r)
			return
		}
		if err != nil {
			writeJSON(w, 500, problem{Error: "risk rule could not be saved", RequestID: requestID(r)})
			return
		}
		a.audit(r, org, action, "risk_rule", rule.ID, map[string]any{"name": rule.Name, "action": rule.Action, "enabled": rule.Enabled})
		status := 200
		if r.Method == http.MethodPost {
			status = 201
		}
		writeJSON(w, status, rule)
	case len(parts) == 2 && r.Method == http.MethodDelete:
		res, err := a.db.ExecContext(r.Context(), `DELETE FROM risk_rules WHERE id=$1 AND organization_id=$2`, parts[1], org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "risk rule could not be deleted", RequestID: requestID(r)})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			notFound(w, r)
			return
		}
		a.audit(r, org, "risk_rule.deleted", "risk_rule", parts[1], map[string]any{})
		writeJSON(w, 200, map[string]string{"id": parts[1], "status": "deleted"})
	default:
		notFound(w, r)
	}
}

// audit records a configuration change outside a transaction. It is best
// effort; financial state changes write their audit rows in the same
// transaction instead.
func (a *App) audit(r *http.Request, org, action, resourceType, resourceID string, metadata map[string]any) {
	encoded, _ := json.Marshal(metadata)
	_, _ = a.db.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
		"aud_"+newID(), org, nullable(principalFrom(r).userID), action, resourceType, resourceID, string(encoded))
}
