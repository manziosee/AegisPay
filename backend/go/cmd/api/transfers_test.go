package main

import (
	"database/sql"
	"testing"
)

func TestTransferApprovalRequiresDifferentAuthenticatedUser(t *testing.T) {
	tests := []struct {
		name      string
		creator   sql.NullString
		approver  string
		wantAllow bool
	}{
		{name: "initiator cannot approve own transfer", creator: sql.NullString{String: "usr_1", Valid: true}, approver: "usr_1", wantAllow: false},
		{name: "different member can approve", creator: sql.NullString{String: "usr_1", Valid: true}, approver: "usr_2", wantAllow: true},
		{name: "missing session user cannot approve", creator: sql.NullString{String: "usr_1", Valid: true}, approver: "", wantAllow: false},
		{name: "legacy transfer can be approved by signed-in member", creator: sql.NullString{}, approver: "usr_2", wantAllow: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := transferApprovalAllowed(tt.creator, tt.approver); got != tt.wantAllow {
				t.Fatalf("transferApprovalAllowed() = %t, want %t", got, tt.wantAllow)
			}
		})
	}
}

func TestApprovalRequirementMet(t *testing.T) {
	tests := []struct {
		name     string
		received int
		required int
		want     bool
	}{
		{name: "one approval policy", received: 1, required: 1, want: true},
		{name: "awaits second reviewer", received: 1, required: 2, want: false},
		{name: "second reviewer completes", received: 2, required: 2, want: true},
		{name: "invalid zero policy never completes", received: 4, required: 0, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := approvalRequirementMet(tt.received, tt.required); got != tt.want {
				t.Fatalf("approvalRequirementMet() = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestPayoutNeedsApproval(t *testing.T) {
	tests := []struct {
		name      string
		amount    int64
		threshold int64
		want      bool
	}{
		{name: "amount below threshold", amount: 99, threshold: 100, want: false},
		{name: "amount at threshold requires review", amount: 100, threshold: 100, want: true},
		{name: "zero disables threshold review", amount: 100, threshold: 0, want: false},
		{name: "negative disables threshold review", amount: 100, threshold: -1, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := payoutNeedsApproval(tt.amount, tt.threshold); got != tt.want {
				t.Fatalf("payoutNeedsApproval() = %t, want %t", got, tt.want)
			}
		})
	}
}
