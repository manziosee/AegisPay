package main

import "testing"

func TestAvailableFinanceBudget(t *testing.T) {
	tests := []struct {
		name        string
		allocated   int64
		committed   int64
		spent       int64
		advanceUsed int64
		want        int64
	}{
		{name: "allocation remains available", allocated: 1000, want: 1000},
		{name: "subtracts commitments and spend", allocated: 1000, committed: 300, spent: 200, want: 500},
		{name: "approved advance use counts as spend", allocated: 1000, committed: 100, advanceUsed: 250, want: 650},
		{name: "never disguises an over-allocation", allocated: 100, committed: 130, want: -30},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := availableFinanceBudget(tt.allocated, tt.committed, tt.spent, tt.advanceUsed); got != tt.want {
				t.Fatalf("availableFinanceBudget() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestAdvanceSettlementRequiresIndependentOwnerOrAdmin(t *testing.T) {
	tests := []struct {
		name        string
		submitterID string
		reviewerID  string
		role        string
		want        bool
	}{
		{name: "different owner may review", submitterID: "usr_1", reviewerID: "usr_2", role: "owner", want: true},
		{name: "different admin may review", submitterID: "usr_1", reviewerID: "usr_2", role: "admin", want: true},
		{name: "submitter cannot review own request", submitterID: "usr_1", reviewerID: "usr_1", role: "admin", want: false},
		{name: "finance operator cannot review settlement", submitterID: "usr_1", reviewerID: "usr_2", role: "finance_operator", want: false},
		{name: "missing reviewer identity is rejected", submitterID: "usr_1", role: "owner", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := canReviewAdvanceSettlement(tt.submitterID, tt.reviewerID, tt.role); got != tt.want {
				t.Fatalf("canReviewAdvanceSettlement() = %t, want %t", got, tt.want)
			}
		})
	}
}
