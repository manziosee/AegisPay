package main

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

func (a *App) transactionPolicies(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) != 1 && !(len(parts) == 2 && r.Method == http.MethodDelete) {
		notFound(w, r)
		return
	}
	if len(parts) == 2 && r.Method == http.MethodDelete {
		currency := strings.ToUpper(strings.TrimSpace(parts[1]))
		if len(currency) != 3 || !asciiCurrency(currency) {
			bad(w, r, "currency must be a three-letter code")
			return
		}
		tx, err := a.db.BeginTx(r.Context(), nil)
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer tx.Rollback()
		res, err := tx.ExecContext(r.Context(), `DELETE FROM transaction_policies WHERE organization_id=$1 AND currency=$2`, org, currency)
		if err != nil {
			writeJSON(w, 500, problem{Error: "transaction policy could not be removed"})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			notFound(w, r)
			return
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'transaction_policy.deleted','transaction_policy',$4,jsonb_build_object('currency',$4::text))`, "aud_"+newID(), org, nullable(principalFrom(r).userID), currency); err != nil {
			writeJSON(w, 500, problem{Error: "transaction policy audit could not be recorded"})
			return
		}
		if err = tx.Commit(); err != nil {
			writeJSON(w, 409, problem{Error: "transaction policy deletion conflict"})
			return
		}
		writeJSON(w, 200, map[string]string{"currency": currency, "status": "deleted"})
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `SELECT currency,max_single_minor,daily_collection_minor,daily_transfer_minor,approval_threshold_minor,required_approvals,updated_at FROM transaction_policies WHERE organization_id=$1 ORDER BY currency`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "transaction policies unavailable"})
			return
		}
		defer rows.Close()
		data := make([]map[string]any, 0)
		for rows.Next() {
			var currency string
			var single, collection, transfer, approval sql.NullInt64
			var required int
			var updated time.Time
			if err = rows.Scan(&currency, &single, &collection, &transfer, &approval, &required, &updated); err != nil {
				writeJSON(w, 500, problem{Error: "transaction policies unavailable"})
				return
			}
			data = append(data, map[string]any{"currency": strings.TrimSpace(currency), "max_single_minor": nullInt(single), "daily_collection_minor": nullInt(collection), "daily_transfer_minor": nullInt(transfer), "approval_threshold_minor": nullInt(approval), "required_approvals": required, "updated_at": updated})
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if r.Method != http.MethodPut {
		notFound(w, r)
		return
	}
	var in struct {
		Currency          string `json:"currency"`
		MaxSingle         *int64 `json:"max_single_minor"`
		DailyCollection   *int64 `json:"daily_collection_minor"`
		DailyTransfer     *int64 `json:"daily_transfer_minor"`
		ApprovalThreshold *int64 `json:"approval_threshold_minor"`
		RequiredApprovals *int   `json:"required_approvals"`
	}
	if decode(r, &in) != nil {
		bad(w, r, "valid policy fields are required")
		return
	}
	in.Currency = strings.ToUpper(strings.TrimSpace(in.Currency))
	if len(in.Currency) != 3 || !asciiCurrency(in.Currency) || (in.MaxSingle == nil && in.DailyCollection == nil && in.DailyTransfer == nil && in.ApprovalThreshold == nil && in.RequiredApprovals == nil) {
		bad(w, r, "currency and at least one policy limit are required")
		return
	}
	if in.RequiredApprovals != nil && (*in.RequiredApprovals < 1 || *in.RequiredApprovals > 3) {
		bad(w, r, "required_approvals must be between 1 and 3")
		return
	}
	for _, value := range []*int64{in.MaxSingle, in.DailyCollection, in.DailyTransfer, in.ApprovalThreshold} {
		if value != nil && *value <= 0 {
			bad(w, r, "configured limits must be positive minor-unit amounts")
			return
		}
	}
	p := principalFrom(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	var savedSingle, savedCollection, savedTransfer, savedApproval sql.NullInt64
	var savedRequired int
	err = tx.QueryRowContext(r.Context(), `INSERT INTO transaction_policies(organization_id,currency,max_single_minor,daily_collection_minor,daily_transfer_minor,approval_threshold_minor,required_approvals,updated_by,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,1),$8,now()) ON CONFLICT(organization_id,currency) DO UPDATE SET
		max_single_minor=COALESCE(EXCLUDED.max_single_minor,transaction_policies.max_single_minor),
		daily_collection_minor=COALESCE(EXCLUDED.daily_collection_minor,transaction_policies.daily_collection_minor),
		daily_transfer_minor=COALESCE(EXCLUDED.daily_transfer_minor,transaction_policies.daily_transfer_minor),
		approval_threshold_minor=COALESCE(EXCLUDED.approval_threshold_minor,transaction_policies.approval_threshold_minor),
		required_approvals=COALESCE($7,transaction_policies.required_approvals),
		updated_by=EXCLUDED.updated_by,updated_at=now()
		RETURNING max_single_minor,daily_collection_minor,daily_transfer_minor,approval_threshold_minor,required_approvals`, org, in.Currency, in.MaxSingle, in.DailyCollection, in.DailyTransfer, in.ApprovalThreshold, in.RequiredApprovals, nullable(p.userID)).Scan(&savedSingle, &savedCollection, &savedTransfer, &savedApproval, &savedRequired)
	if err != nil {
		writeJSON(w, 500, problem{Error: "transaction policy could not be saved"})
		return
	}
	_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'transaction_policy.updated','transaction_policy',$4,jsonb_build_object('currency',$5::text,'max_single_minor',$6::bigint,'daily_collection_minor',$7::bigint,'daily_transfer_minor',$8::bigint,'approval_threshold_minor',$9::bigint,'required_approvals',$10::integer))`, "aud_"+newID(), org, nullable(p.userID), in.Currency, in.Currency, in.MaxSingle, in.DailyCollection, in.DailyTransfer, in.ApprovalThreshold, in.RequiredApprovals)
	if err != nil {
		writeJSON(w, 500, problem{Error: "transaction policy audit could not be recorded"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "transaction policy update conflict"})
		return
	}
	writeJSON(w, 200, map[string]any{"currency": in.Currency, "max_single_minor": nullInt(savedSingle), "daily_collection_minor": nullInt(savedCollection), "daily_transfer_minor": nullInt(savedTransfer), "approval_threshold_minor": nullInt(savedApproval), "required_approvals": savedRequired, "updated_at": time.Now().UTC()})
}

func nullInt(value sql.NullInt64) any {
	if !value.Valid {
		return nil
	}
	return value.Int64
}

func asciiCurrency(value string) bool {
	for _, r := range value {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

func (a *App) enforceTransactionLimit(ctx context.Context, tx *sql.Tx, org, currency, kind string, amount int64) (int64, error) {
	var maxSingle, dailyCollection, dailyTransfer, approval sql.NullInt64
	err := tx.QueryRowContext(ctx, `SELECT max_single_minor,daily_collection_minor,daily_transfer_minor,approval_threshold_minor FROM transaction_policies WHERE organization_id=$1 AND currency=upper($2)`, org, currency).Scan(&maxSingle, &dailyCollection, &dailyTransfer, &approval)
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	if maxSingle.Valid && amount > maxSingle.Int64 {
		return 0, errPolicyLimit
	}
	var dailyLimit sql.NullInt64
	var query string
	switch kind {
	case "collection":
		dailyLimit = dailyCollection
		query = `SELECT COALESCE(SUM(amount_minor),0) FROM collections WHERE organization_id=$1 AND currency=upper($2) AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND status<>'cancelled'`
	case "transfer":
		dailyLimit = dailyTransfer
		query = `SELECT COALESCE(SUM(amount_minor),0) FROM transfers WHERE organization_id=$1 AND currency=upper($2) AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND status NOT IN ('rejected','cancelled')`
	}
	if dailyLimit.Valid {
		var used int64
		if err = tx.QueryRowContext(ctx, query, org, currency).Scan(&used); err != nil {
			return 0, err
		}
		if amount > dailyLimit.Int64-used {
			return 0, errPolicyLimit
		}
	}
	if approval.Valid {
		return approval.Int64, nil
	}
	return 0, nil
}

var errPolicyLimit = policyLimitError{}

type policyLimitError struct{}

func (policyLimitError) Error() string { return "transaction exceeds the organization policy limit" }
