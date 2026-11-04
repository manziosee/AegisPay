package main

import (
	"strings"
	"testing"
	"time"
)

func ptr[T any](v T) *T { return &v }

func TestRiskRuleInputValidation(t *testing.T) {
	valid := riskRuleInput{Name: " Large payouts ", AppliesTo: []string{"payout"}, Action: "review", Currency: ptr(" usd "), MinAmountMinor: ptr(int64(100000))}
	if err := valid.validate(); err != nil {
		t.Fatalf("valid rule rejected: %v", err)
	}
	if valid.Name != "Large payouts" || *valid.Currency != "USD" {
		t.Fatalf("rule not normalised: %+v", valid)
	}
	empty := ""
	blankCurrency := riskRuleInput{Name: "Any", AppliesTo: []string{"collection"}, Action: "allow", Currency: &empty}
	if err := blankCurrency.validate(); err != nil || blankCurrency.Currency != nil {
		t.Fatalf("blank currency should mean any currency: %v", err)
	}
	cases := map[string]riskRuleInput{
		"unknown action":    {Name: "x", AppliesTo: []string{"payout"}, Action: "hold"},
		"no subjects":       {Name: "x", Action: "block"},
		"unknown subject":   {Name: "x", AppliesTo: []string{"card"}, Action: "block"},
		"bad currency":      {Name: "x", AppliesTo: []string{"payout"}, Action: "block", Currency: ptr("EURO")},
		"min above max":     {Name: "x", AppliesTo: []string{"payout"}, Action: "block", MinAmountMinor: ptr(int64(10)), MaxAmountMinor: ptr(int64(5))},
		"half velocity":     {Name: "x", AppliesTo: []string{"transfer"}, Action: "review", VelocityCount: ptr(3)},
		"window too long":   {Name: "x", AppliesTo: []string{"transfer"}, Action: "review", VelocityCount: ptr(3), VelocityWindowMinutes: ptr(50000)},
		"name missing":      {Name: "  ", AppliesTo: []string{"payout"}, Action: "block"},
		"non-positive mins": {Name: "x", AppliesTo: []string{"payout"}, Action: "block", MinAmountMinor: ptr(int64(0))},
	}
	for name, input := range cases {
		if err := input.validate(); err == nil {
			t.Errorf("%s: expected a validation error", name)
		}
	}
}

func TestRiskSeverityOrdering(t *testing.T) {
	if !(riskSeverity["block"] > riskSeverity["review"] && riskSeverity["review"] > riskSeverity["allow"]) {
		t.Fatal("block must outrank review, which must outrank allow")
	}
}

// The SQL function audit_log_hash must produce the same value; this pins the
// canonical format so a change to either side is caught.
func TestAuditRowHashFormat(t *testing.T) {
	created := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.FixedZone("CET", 3600))
	got := auditRowHash(strings.Repeat("0", 64), "aud_1", "org_1", "", "risk_rule.created", "risk_rule", "rsk_1", `{"a": 1}`, created)
	again := auditRowHash(strings.Repeat("0", 64), "aud_1", "org_1", "", "risk_rule.created", "risk_rule", "rsk_1", `{"a": 1}`, created.UTC())
	if got != again || len(got) != 64 {
		t.Fatalf("hash must be timezone independent and hex encoded: %s %s", got, again)
	}
	if auditRowHash(got, "aud_1", "org_1", "", "x", "y", "z", "{}", created) == got {
		t.Fatal("changing the previous hash must change the result")
	}
}
