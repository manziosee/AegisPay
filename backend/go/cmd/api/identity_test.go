package main

import (
	"net/http"
	"testing"
)

func TestRoleAllowsBusinessDashboardActions(t *testing.T) {
	tests := []struct {
		name   string
		role   string
		scopes []string
		method string
		path   string
		want   bool
	}{
		{name: "finance operator reads transactions", role: "finance_operator", method: http.MethodGet, path: "/v1/transfers", want: true},
		{name: "finance operator resolves reconciliation", role: "finance_operator", method: http.MethodPost, path: "/v1/reconciliation/imports/imp_1/lines/1/resolve", want: true},
		{name: "finance operator manages bank-file workflows", role: "finance_operator", method: http.MethodPost, path: "/v1/bank-operations/requests", want: true},
		{name: "finance operator approval is delegated at handler", role: "finance_operator", method: http.MethodPost, path: "/v1/transfers/trf_1/approve", want: true},
		{name: "auditor can read control health", role: "auditor", method: http.MethodGet, path: "/v1/bank-operations/health", want: true},
		{name: "auditor cannot prepare payouts", role: "auditor", method: http.MethodPost, path: "/v1/bank-operations/payouts", want: false},
		{name: "finance operator cannot close periods", role: "finance_operator", method: http.MethodPost, path: "/v1/bank-operations/periods/per_1/close", want: false},
		{name: "fraud analyst reviews cases", role: "fraud_analyst", method: http.MethodPost, path: "/v1/fraud/cases/case_1/resolve", want: true},
		{name: "fraud analyst cannot change organization policy", role: "fraud_analyst", method: http.MethodPut, path: "/v1/transaction-policies", want: false},
		{name: "auditor reads reports", role: "auditor", method: http.MethodGet, path: "/v1/reports/transactions", want: true},
		{name: "auditor cannot create transfers", role: "auditor", method: http.MethodPost, path: "/v1/transfers", want: false},
		{name: "scoped API key can read transfers", role: "api_key", scopes: []string{"transfers.read"}, method: http.MethodGet, path: "/v1/transfers", want: true},
		{name: "scoped API key cannot approve transfers", role: "api_key", scopes: []string{"transfers.read"}, method: http.MethodPost, path: "/v1/transfers/trf_1/approve", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, err := http.NewRequest(tt.method, tt.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			if got := roleAllows(principal{role: tt.role, scopes: tt.scopes}, r); got != tt.want {
				t.Fatalf("roleAllows() = %t, want %t", got, tt.want)
			}
		})
	}
}
