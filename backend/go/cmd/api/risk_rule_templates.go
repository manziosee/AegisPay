package main

import (
	"net/http"
	"strings"
)

// Ready-made risk rules for common kinds of organizations. Amounts are given
// in US dollars and scaled to the workspace currency (sampleAmount), so a
// cooperative in Kenya and one in Peru both start with sensible limits.
// Every template rule asks for review rather than blocking, so applying one
// never stops payments on its own; owners can tighten them afterwards.

type templateRule struct {
	Name          string
	AppliesTo     []string
	MinUSD        int64
	VelocityCount int
	WindowMinutes int
	Action        string
}

type ruleTemplate struct {
	ID          string
	Name        string
	Description string
	Rules       []templateRule
}

var riskRuleTemplates = []ruleTemplate{
	{
		ID: "ngo", Name: "NGO and grant programmes",
		Description: "Second look at large disbursements and unusually large donations, which donors and auditors expect.",
		Rules: []templateRule{
			{Name: "Review grant disbursements of 5,000 USD or more", AppliesTo: []string{"payout"}, MinUSD: 5000, Action: "review"},
			{Name: "Review internal moves of 10,000 USD or more", AppliesTo: []string{"transfer"}, MinUSD: 10000, Action: "review"},
			{Name: "Review single donations of 10,000 USD or more", AppliesTo: []string{"collection"}, MinUSD: 10000, Action: "review"},
			{Name: "Review more than 5 disbursements in an hour", AppliesTo: []string{"payout"}, VelocityCount: 5, WindowMinutes: 60, Action: "review"},
		},
	},
	{
		ID: "retail", Name: "Retail shop",
		Description: "Catches unusually large sales, bursts of payments from one customer and large cash movements.",
		Rules: []templateRule{
			{Name: "Review sales of 2,000 USD or more", AppliesTo: []string{"collection"}, MinUSD: 2000, Action: "review"},
			{Name: "Review more than 10 payments from one customer in an hour", AppliesTo: []string{"collection"}, VelocityCount: 10, WindowMinutes: 60, Action: "review"},
			{Name: "Review supplier payments of 5,000 USD or more", AppliesTo: []string{"payout"}, MinUSD: 5000, Action: "review"},
			{Name: "Review internal moves of 10,000 USD or more", AppliesTo: []string{"transfer"}, MinUSD: 10000, Action: "review"},
		},
	},
	{
		ID: "freelancer", Name: "Freelancer or consultant",
		Description: "A light touch: flags unusually large invoices and payments out, and repeated payouts in a day.",
		Rules: []templateRule{
			{Name: "Review invoices paid of 5,000 USD or more", AppliesTo: []string{"collection"}, MinUSD: 5000, Action: "review"},
			{Name: "Review payments out of 3,000 USD or more", AppliesTo: []string{"payout"}, MinUSD: 3000, Action: "review"},
			{Name: "Review more than 3 payments out in a day", AppliesTo: []string{"payout"}, VelocityCount: 3, WindowMinutes: 1440, Action: "review"},
		},
	},
	{
		ID: "cooperative", Name: "Cooperative or savings group",
		Description: "Protects members' money: large or repeated withdrawals and large internal moves get a second reviewer.",
		Rules: []templateRule{
			{Name: "Review member withdrawals of 1,000 USD or more", AppliesTo: []string{"payout"}, MinUSD: 1000, Action: "review"},
			{Name: "Review more than 3 withdrawals in a day", AppliesTo: []string{"payout"}, VelocityCount: 3, WindowMinutes: 1440, Action: "review"},
			{Name: "Review internal moves of 2,000 USD or more", AppliesTo: []string{"transfer"}, MinUSD: 2000, Action: "review"},
			{Name: "Review single contributions of 5,000 USD or more", AppliesTo: []string{"collection"}, MinUSD: 5000, Action: "review"},
		},
	},
}

func findRuleTemplate(id string) (ruleTemplate, bool) {
	for _, t := range riskRuleTemplates {
		if t.ID == id {
			return t, true
		}
	}
	return ruleTemplate{}, false
}

// templateInputs turns a template into rule inputs in one currency.
func templateInputs(t ruleTemplate, currency string) []riskRuleInput {
	out := make([]riskRuleInput, 0, len(t.Rules))
	for i, rule := range t.Rules {
		priority := 200 + i
		in := riskRuleInput{Name: rule.Name, Priority: &priority, AppliesTo: rule.AppliesTo, Action: rule.Action}
		if rule.MinUSD > 0 {
			c := currency
			minimum := sampleAmount(rule.MinUSD, currency)
			in.Currency, in.MinAmountMinor = &c, &minimum
			// Name the limit in the workspace currency, not dollars.
			in.Name = strings.Replace(rule.Name, groupThousands(rule.MinUSD)+" USD", formatMinorAmount(minimum, currency), 1)
		}
		if rule.VelocityCount > 0 {
			count, window := rule.VelocityCount, rule.WindowMinutes
			in.VelocityCount, in.VelocityWindowMinutes = &count, &window
		}
		out = append(out, in)
	}
	return out
}

func (a *App) riskRuleTemplatesHandler(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	currency := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("currency")))
	if len(currency) != 3 {
		currency = a.workspaceCurrency(r.Context(), org)
	}
	if len(parts) == 2 && r.Method == http.MethodGet {
		data := make([]map[string]any, 0, len(riskRuleTemplates))
		for _, t := range riskRuleTemplates {
			rules := []map[string]any{}
			for _, in := range templateInputs(t, currency) {
				rules = append(rules, map[string]any{"name": in.Name, "applies_to": in.AppliesTo, "action": in.Action, "currency": in.Currency, "min_amount_minor": in.MinAmountMinor, "velocity_count": in.VelocityCount, "velocity_window_minutes": in.VelocityWindowMinutes})
			}
			data = append(data, map[string]any{"id": t.ID, "name": t.Name, "description": t.Description, "currency": currency, "rules": rules})
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if len(parts) != 4 || parts[3] != "apply" || r.Method != http.MethodPost {
		notFound(w, r)
		return
	}
	t, ok := findRuleTemplate(parts[2])
	if !ok {
		notFound(w, r)
		return
	}
	var in struct {
		Currency string `json:"currency"`
	}
	_ = decode(r, &in)
	if c := strings.ToUpper(strings.TrimSpace(in.Currency)); len(c) == 3 && asciiCurrency(c) {
		currency = c
	}
	ctx := r.Context()
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	p := principalFrom(r)
	created, skipped := 0, 0
	for _, rule := range templateInputs(t, currency) {
		if err = rule.validate(); err != nil {
			writeJSON(w, 500, problem{Error: "template rule is invalid: " + err.Error()})
			return
		}
		// Applying a template twice adds nothing new.
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM risk_rules WHERE organization_id=$1 AND name=$2)`, org, rule.Name).Scan(&exists); err != nil {
			writeJSON(w, 500, problem{Error: "risk rules could not be checked"})
			return
		}
		if exists {
			skipped++
			continue
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO risk_rules(id,organization_id,name,enabled,priority,applies_to,currency,min_amount_minor,max_amount_minor,velocity_count,velocity_window_minutes,action,created_by)
			VALUES($1,$2,$3,true,$4,$5,$6,$7,NULL,$8,$9,$10,$11)`,
			"rsk_"+newID(), org, rule.Name, *rule.Priority, rule.AppliesTo, rule.Currency, rule.MinAmountMinor, rule.VelocityCount, rule.VelocityWindowMinutes, rule.Action, nullable(p.userID)); err != nil {
			writeJSON(w, 500, problem{Error: "template rules could not be saved", RequestID: requestID(r)})
			return
		}
		created++
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'risk_rule.template_applied','risk_rule_template',$4,jsonb_build_object('created',$5::integer,'currency',$6::text))`,
		"aud_"+newID(), org, nullable(p.userID), t.ID, created, currency); err != nil {
		writeJSON(w, 500, problem{Error: "template could not be audited"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "template conflict; try again"})
		return
	}
	writeJSON(w, 201, map[string]any{"template": t.ID, "created": created, "already_present": skipped, "currency": currency})
}
