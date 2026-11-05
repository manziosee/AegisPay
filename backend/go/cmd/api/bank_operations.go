package main

import (
	"bytes"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (a *App) bankOperations(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) == 1 && parts[0] == "health" && r.Method == http.MethodGet {
		a.controlHealth(w, r, org)
		return
	}
	if len(parts) == 1 && parts[0] == "requests" {
		a.bankRequests(w, r, org)
		return
	}
	if len(parts) == 1 && parts[0] == "payouts" {
		a.bankPayouts(w, r, org)
		return
	}
	if len(parts) == 2 && parts[0] == "payouts" && parts[1] == "export" && r.Method == http.MethodPost {
		a.exportPayoutRegister(w, r, org)
		return
	}
	if len(parts) == 3 && parts[0] == "payouts" && parts[2] == "submit" && r.Method == http.MethodPost {
		a.markPayoutSubmitted(w, r, org, parts[1])
		return
	}
	if len(parts) == 3 && parts[0] == "payouts" && (parts[2] == "approve" || parts[2] == "reject") && r.Method == http.MethodPost {
		a.reviewBankPayout(w, r, org, parts[1], parts[2])
		return
	}
	if len(parts) == 1 && parts[0] == "periods" {
		a.closePeriods(w, r, org)
		return
	}
	if len(parts) == 3 && parts[0] == "periods" && (parts[2] == "close" || parts[2] == "reopen") && r.Method == http.MethodPost {
		a.changePeriodStatus(w, r, org, parts[1], parts[2])
		return
	}
	if len(parts) == 1 && parts[0] == "scenarios" {
		a.scenarioRuns(w, r, org)
		return
	}
	if len(parts) == 1 && parts[0] == "delegations" {
		a.approvalDelegations(w, r, org)
		return
	}
	if len(parts) == 3 && parts[0] == "delegations" && parts[2] == "revoke" && r.Method == http.MethodPost {
		a.revokeApprovalDelegation(w, r, org, parts[1])
		return
	}
	if len(parts) == 2 && parts[0] == "scenarios" && parts[1] == "simulate" && r.Method == http.MethodPost {
		a.simulateScenario(w, r, org)
		return
	}
	notFound(w, r)
}

func isWorkspaceAdmin(p principal) bool {
	return p.userID != "" && (p.role == "owner" || p.role == "admin")
}

func (a *App) approvalDelegations(w http.ResponseWriter, r *http.Request, org string) {
	p := principalFrom(r)
	if !isWorkspaceAdmin(p) {
		writeJSON(w, 403, problem{Error: "only an owner or admin can manage approval delegations"})
		return
	}
	if r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `SELECT d.id,d.expires_at,d.note,d.created_at,delegator.full_name,delegate.full_name,delegate.email FROM approval_delegations d JOIN users delegator ON delegator.id=d.delegator_user_id JOIN users delegate ON delegate.id=d.delegate_user_id WHERE d.organization_id=$1 AND d.revoked_at IS NULL AND d.expires_at>now() ORDER BY d.created_at DESC`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "approval delegations could not be loaded"})
			return
		}
		defer rows.Close()
		data := make([]map[string]any, 0)
		for rows.Next() {
			var id, note, delegator, delegate, email string
			var expires, created time.Time
			if err = rows.Scan(&id, &expires, &note, &created, &delegator, &delegate, &email); err != nil {
				writeJSON(w, 500, problem{Error: "approval delegations could not be read"})
				return
			}
			data = append(data, map[string]any{"id": id, "delegator_name": delegator, "delegate_name": delegate, "delegate_email": email, "expires_at": expires, "note": note, "created_at": created})
		}
		if err = rows.Err(); err != nil {
			writeJSON(w, 500, problem{Error: "approval delegations could not be read"})
			return
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if r.Method != http.MethodPost {
		notFound(w, r)
		return
	}
	var in struct {
		Email     string `json:"delegate_email"`
		ExpiresAt string `json:"expires_at"`
		Note      string `json:"note"`
	}
	if decode(r, &in) != nil || !strings.Contains(in.Email, "@") || strings.TrimSpace(in.Note) == "" || len(in.Note) > 500 {
		bad(w, r, "delegate_email and a review note of up to 500 characters are required")
		return
	}
	expires, err := time.Parse(time.RFC3339, in.ExpiresAt)
	if err != nil || !expires.After(time.Now()) || expires.After(time.Now().Add(30*24*time.Hour)) {
		bad(w, r, "expires_at must be within the next 30 days")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	var delegateID string
	err = tx.QueryRowContext(r.Context(), `SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.organization_id=$1 AND m.status='active' AND m.role='finance_operator' AND lower(u.email)=lower($2) FOR UPDATE OF m`, org, strings.TrimSpace(in.Email)).Scan(&delegateID)
	if err == sql.ErrNoRows {
		writeJSON(w, 404, problem{Error: "delegate must be an active finance operator in this workspace"})
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "delegate membership could not be checked"})
		return
	}
	id := "del_" + newID()
	_, err = tx.ExecContext(r.Context(), `INSERT INTO approval_delegations(id,organization_id,delegator_user_id,delegate_user_id,expires_at,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$3)`, id, org, p.userID, delegateID, expires, strings.TrimSpace(in.Note))
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'approval_delegation.created','approval_delegation',$4,jsonb_build_object('delegate_user_id',$5::text,'expires_at',$6::timestamptz,'note',$7::text))`, "aud_"+newID(), org, p.userID, id, delegateID, expires, strings.TrimSpace(in.Note))
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "approval delegation could not be created"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "approval delegation creation conflict"})
		return
	}
	writeJSON(w, 201, map[string]any{"id": id, "delegate_email": strings.ToLower(strings.TrimSpace(in.Email)), "expires_at": expires, "status": "active"})
}

func (a *App) revokeApprovalDelegation(w http.ResponseWriter, r *http.Request, org, id string) {
	p := principalFrom(r)
	if !isWorkspaceAdmin(p) {
		writeJSON(w, 403, problem{Error: "only an owner or admin can revoke approval delegations"})
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(r.Context(), `UPDATE approval_delegations SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL`, id, org)
	if err != nil {
		writeJSON(w, 500, problem{Error: "approval delegation could not be revoked"})
		return
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		notFound(w, r)
		return
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'approval_delegation.revoked','approval_delegation',$4,'{}'::jsonb)`, "aud_"+newID(), org, p.userID, id); err != nil {
		writeJSON(w, 500, problem{Error: "delegation revocation audit could not be recorded"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "delegation revocation conflict"})
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "status": "revoked"})
}

func (a *App) bankRequests(w http.ResponseWriter, r *http.Request, org string) {
	if r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `SELECT id,amount_minor,currency,reference,description,due_date,status,created_at FROM bank_payment_requests WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "payment requests could not be loaded"})
			return
		}
		defer rows.Close()
		data := make([]map[string]any, 0)
		for rows.Next() {
			var id, currency, reference, description, status string
			var amount int64
			var dueDate sql.NullTime
			var created time.Time
			if err = rows.Scan(&id, &amount, &currency, &reference, &description, &dueDate, &status, &created); err != nil {
				writeJSON(w, 500, problem{Error: "payment requests could not be read"})
				return
			}
			var due any
			if dueDate.Valid {
				due = dueDate.Time.Format("2006-01-02")
			}
			data = append(data, map[string]any{"id": id, "amount": amount, "currency": strings.TrimSpace(currency), "reference": reference, "description": description, "due_date": due, "status": status, "created_at": created})
		}
		if err = rows.Err(); err != nil {
			writeJSON(w, 500, problem{Error: "payment requests could not be read"})
			return
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if r.Method != http.MethodPost {
		notFound(w, r)
		return
	}
	var in struct {
		Amount      int64  `json:"amount"`
		Currency    string `json:"currency"`
		Description string `json:"description"`
		DueDate     string `json:"due_date"`
	}
	if decode(r, &in) != nil || in.Amount <= 0 || len(strings.TrimSpace(in.Currency)) != 3 || len(in.Description) > 500 {
		bad(w, r, "positive amount, three-letter currency, and description up to 500 characters are required")
		return
	}
	in.Currency = strings.ToUpper(strings.TrimSpace(in.Currency))
	in.Description = strings.TrimSpace(in.Description)
	var due any
	if in.DueDate != "" {
		parsed, err := time.Parse("2006-01-02", in.DueDate)
		if err != nil {
			bad(w, r, "due_date must use YYYY-MM-DD")
			return
		}
		due = parsed
	}
	id := "req_" + newID()
	ref := "AR-" + strings.ToUpper(newID()[:12])
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	p := principalFrom(r)
	_, err = tx.ExecContext(r.Context(), `INSERT INTO bank_payment_requests(id,organization_id,amount_minor,currency,reference,description,due_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, org, in.Amount, in.Currency, ref, in.Description, due, nullable(p.userID))
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'bank_request.created','bank_payment_request',$4,jsonb_build_object('amount_minor',$5::bigint,'currency',$6::text))`, "aud_"+newID(), org, nullable(p.userID), id, in.Amount, in.Currency)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "payment request could not be recorded"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "payment request creation conflict"})
		return
	}
	writeJSON(w, 201, map[string]any{"id": id, "amount": in.Amount, "currency": in.Currency, "reference": ref, "description": in.Description, "due_date": in.DueDate, "status": "open", "settlement": "not_received"})
}

func (a *App) bankPayouts(w http.ResponseWriter, r *http.Request, org string) {
	if r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `SELECT p.id,p.beneficiary_name,p.amount_minor,p.currency,p.reference,p.description,p.status,p.created_at,
			(SELECT count(*) FROM bank_payout_approvals v WHERE v.organization_id=p.organization_id AND v.payout_id=p.id AND v.decision='approved'),p.required_approvals
			FROM bank_payout_instructions p WHERE p.organization_id=$1 ORDER BY p.created_at DESC LIMIT 200`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "payout register could not be loaded"})
			return
		}
		defer rows.Close()
		data := make([]map[string]any, 0)
		for rows.Next() {
			var id, beneficiary, currency, reference, description, status string
			var amount int64
			var approvals, required int
			var created time.Time
			if err = rows.Scan(&id, &beneficiary, &amount, &currency, &reference, &description, &status, &created, &approvals, &required); err != nil {
				writeJSON(w, 500, problem{Error: "payout register could not be read"})
				return
			}
			data = append(data, map[string]any{"id": id, "beneficiary_name": beneficiary, "amount": amount, "currency": strings.TrimSpace(currency), "reference": reference, "description": description, "status": status, "approvals_received": approvals, "required_approvals": required, "created_at": created})
		}
		if err = rows.Err(); err != nil {
			writeJSON(w, 500, problem{Error: "payout register could not be read"})
			return
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if r.Method != http.MethodPost {
		notFound(w, r)
		return
	}
	var in struct {
		Beneficiary string `json:"beneficiary_name"`
		Amount      int64  `json:"amount"`
		Currency    string `json:"currency"`
		Description string `json:"description"`
	}
	if decode(r, &in) != nil || strings.TrimSpace(in.Beneficiary) == "" || len(in.Beneficiary) > 160 || in.Amount <= 0 || len(strings.TrimSpace(in.Currency)) != 3 || len(in.Description) > 500 {
		bad(w, r, "beneficiary_name, positive amount, three-letter currency, and description up to 500 characters are required")
		return
	}
	in.Beneficiary = strings.TrimSpace(in.Beneficiary)
	in.Currency = strings.ToUpper(strings.TrimSpace(in.Currency))
	in.Description = strings.TrimSpace(in.Description)
	id := "pay_" + newID()
	ref := "AP-" + strings.ToUpper(newID()[:12])
	p := principalFrom(r)
	threshold := int64(100000000)
	if configured, parseErr := strconv.ParseInt(env("TRANSFER_APPROVAL_THRESHOLD_MINOR", "100000000"), 10, 64); parseErr == nil {
		threshold = configured
	}
	requiredApprovals := 1
	var configuredThreshold sql.NullInt64
	err := a.db.QueryRowContext(r.Context(), `SELECT approval_threshold_minor,required_approvals FROM transaction_policies WHERE organization_id=$1 AND currency=upper($2)`, org, in.Currency).Scan(&configuredThreshold, &requiredApprovals)
	if err != nil && err != sql.ErrNoRows {
		writeJSON(w, 500, problem{Error: "payout approval policy could not be loaded"})
		return
	}
	if configuredThreshold.Valid {
		threshold = configuredThreshold.Int64
	}
	if requiredApprovals < 1 || requiredApprovals > 3 {
		writeJSON(w, 500, problem{Error: "stored approval policy is invalid"})
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	risk, err := evaluateRisk(r.Context(), tx, org, riskSubject{Kind: "payout", Amount: in.Amount, Currency: in.Currency})
	if err != nil {
		writeJSON(w, 500, problem{Error: "risk check failed", RequestID: requestID(r)})
		return
	}
	if risk.Decision == "block" {
		riskBlocked(w, r, risk)
		return
	}
	status := "prepared"
	if payoutNeedsApproval(in.Amount, threshold) || risk.Decision == "review" {
		status = "pending_approval"
	}
	_, err = tx.ExecContext(r.Context(), `INSERT INTO bank_payout_instructions(id,organization_id,beneficiary_name,amount_minor,currency,reference,description,created_by,required_approvals,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, org, in.Beneficiary, in.Amount, in.Currency, ref, in.Description, nullable(p.userID), requiredApprovals, status)
	if err == nil {
		err = recordRiskOutcome(r.Context(), tx, org, "payout", id, ref, &risk)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'bank_payout.created','bank_payout',$4,jsonb_build_object('amount_minor',$5::bigint,'currency',$6::text,'status',$7::text,'required_approvals',$8::integer))`, "aud_"+newID(), org, nullable(p.userID), id, in.Amount, in.Currency, status, requiredApprovals)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "payout instruction could not be recorded"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "payout creation conflict"})
		return
	}
	if status == "pending_approval" {
		a.emailApprovers(r, org, p.userID, "payout", formatMinorAmount(in.Amount, in.Currency), ref, "/app/money")
	}
	writeJSON(w, 201, map[string]any{"id": id, "beneficiary_name": in.Beneficiary, "amount": in.Amount, "currency": in.Currency, "reference": ref, "description": in.Description, "status": status, "approvals_received": 0, "required_approvals": requiredApprovals, "settlement": "not_submitted", "risk": risk})
}

func payoutNeedsApproval(amount, threshold int64) bool {
	return threshold > 0 && amount >= threshold
}

func (a *App) reviewBankPayout(w http.ResponseWriter, r *http.Request, org, id, action string) {
	p := principalFrom(r)
	if p.userID == "" {
		writeJSON(w, 403, problem{Error: "an authenticated reviewer is required"})
		return
	}
	key, hash, err := requireIdempotencyKey(r)
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	var in struct {
		Note string `json:"note"`
	}
	if decode(r, &in) != nil || strings.TrimSpace(in.Note) == "" || len(in.Note) > 500 {
		bad(w, r, "a review note of up to 500 characters is required")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	code, body, replay, err := reserveIdempotency(r.Context(), tx, org, key, hash)
	if err != nil {
		idempotencyFailure(w, r, err)
		return
	}
	if replay {
		writeRawJSON(w, code, body)
		return
	}
	authorized, err := a.authorizedTransferReviewer(r, tx, org, p)
	if err != nil {
		writeJSON(w, 500, problem{Error: "reviewer authorization could not be checked"})
		return
	}
	if !authorized {
		writeJSON(w, 403, problem{Error: "payout review requires an owner/admin or an active delegation"})
		return
	}
	var creator sql.NullString
	var status string
	var required int
	err = tx.QueryRowContext(r.Context(), `SELECT created_by,status,required_approvals FROM bank_payout_instructions WHERE id=$1 AND organization_id=$2 FOR UPDATE`, id, org).Scan(&creator, &status, &required)
	if err == sql.ErrNoRows {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "payout could not be loaded"})
		return
	}
	if status != "pending_approval" {
		writeJSON(w, 409, problem{Error: "payout is not awaiting approval"})
		return
	}
	if !transferApprovalAllowed(creator, p.userID) {
		writeJSON(w, 403, problem{Error: "payout creator cannot approve their own payout"})
		return
	}
	var prior bool
	if err = tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM bank_payout_approvals WHERE organization_id=$1 AND payout_id=$2 AND approver_user_id=$3)`, org, id, p.userID).Scan(&prior); err != nil {
		writeJSON(w, 500, problem{Error: "prior payout review check failed"})
		return
	}
	if prior {
		writeJSON(w, 409, problem{Error: "this reviewer has already recorded a payout decision"})
		return
	}
	decision := "approved"
	nextStatus := "pending_approval"
	received := 0
	if err = tx.QueryRowContext(r.Context(), `SELECT count(*) FROM bank_payout_approvals WHERE organization_id=$1 AND payout_id=$2 AND decision='approved'`, org, id).Scan(&received); err != nil {
		writeJSON(w, 500, problem{Error: "payout approval count could not be loaded"})
		return
	}
	if action == "reject" {
		decision = "rejected"
		nextStatus = "rejected"
	} else {
		received++
		if approvalRequirementMet(received, required) {
			nextStatus = "prepared"
		}
	}
	_, err = tx.ExecContext(r.Context(), `INSERT INTO bank_payout_approvals(id,organization_id,payout_id,approver_user_id,decision,note) VALUES($1,$2,$3,$4,$5,$6)`, "pav_"+newID(), org, id, p.userID, decision, strings.TrimSpace(in.Note))
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `UPDATE bank_payout_instructions SET status=$3 WHERE id=$1 AND organization_id=$2`, id, org, nextStatus)
	}
	actionName := "bank_payout.approval.recorded"
	if decision == "rejected" {
		actionName = "bank_payout.rejected"
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,'bank_payout',$5,jsonb_build_object('decision',$6::text,'note',$7::text,'approvals_received',$8::integer,'required_approvals',$9::integer))`, "aud_"+newID(), org, p.userID, actionName, id, decision, strings.TrimSpace(in.Note), received, required)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "payout review could not be recorded"})
		return
	}
	result := map[string]any{"id": id, "status": nextStatus, "decision": decision, "approvals_received": received, "required_approvals": required}
	if err = storeIdempotency(r.Context(), tx, org, key, 200, result); err != nil {
		idempotencyFailure(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "payout review conflict"})
		return
	}
	writeJSON(w, 200, result)
}

func (a *App) exportPayoutRegister(w http.ResponseWriter, r *http.Request, org string) {
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(r.Context(), `SELECT id,beneficiary_name,amount_minor,currency,reference,description FROM bank_payout_instructions WHERE organization_id=$1 AND status='prepared' ORDER BY created_at,id FOR UPDATE`, org)
	if err != nil {
		writeJSON(w, 500, problem{Error: "payout register could not be exported"})
		return
	}
	type payout struct {
		id, beneficiary, currency, reference, description string
		amount                                            int64
	}
	items := make([]payout, 0)
	for rows.Next() {
		var item payout
		if err = rows.Scan(&item.id, &item.beneficiary, &item.amount, &item.currency, &item.reference, &item.description); err != nil {
			_ = rows.Close()
			writeJSON(w, 500, problem{Error: "payout register could not be read"})
			return
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		_ = rows.Close()
		writeJSON(w, 500, problem{Error: "payout register could not be read"})
		return
	}
	_ = rows.Close()
	if len(items) == 0 {
		writeJSON(w, 409, problem{Error: "there are no prepared payout instructions to export"})
		return
	}
	var output bytes.Buffer
	writer := csv.NewWriter(&output)
	if err = writer.Write([]string{"beneficiary_name", "amount_minor", "currency", "reference", "description"}); err == nil {
		for _, item := range items {
			if err = writer.Write([]string{csvSafe(item.beneficiary), fmt.Sprint(item.amount), strings.TrimSpace(item.currency), csvSafe(item.reference), csvSafe(item.description)}); err != nil {
				break
			}
		}
	}
	writer.Flush()
	if err == nil {
		err = writer.Error()
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "payout register CSV could not be generated"})
		return
	}
	p := principalFrom(r)
	for _, item := range items {
		if _, err = tx.ExecContext(r.Context(), `UPDATE bank_payout_instructions SET status='exported_for_manual_entry' WHERE id=$1 AND organization_id=$2 AND status='prepared'`, item.id, org); err != nil {
			writeJSON(w, 500, problem{Error: "payout export status could not be recorded"})
			return
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'bank_payout.register_exported','bank_payout',$4,'{}'::jsonb)`, "aud_"+newID(), org, nullable(p.userID), item.id); err != nil {
			writeJSON(w, 500, problem{Error: "payout export audit could not be recorded"})
			return
		}
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "payout export conflict"})
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="aegispay-payout-register.csv"`)
	w.Header().Set("X-Settlement-Status", "not-submitted-to-bank")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(output.Bytes())
}

func (a *App) markPayoutSubmitted(w http.ResponseWriter, r *http.Request, org, id string) {
	var in struct {
		Note string `json:"note"`
	}
	if decode(r, &in) != nil || strings.TrimSpace(in.Note) == "" || len(in.Note) > 500 {
		bad(w, r, "a note confirming the bank-portal action is required")
		return
	}
	p := principalFrom(r)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(r.Context(), `UPDATE bank_payout_instructions SET status='submitted_to_bank',submitted_by=$3,submitted_at=now() WHERE id=$1 AND organization_id=$2 AND status='exported_for_manual_entry'`, id, org, nullable(p.userID))
	if err != nil {
		writeJSON(w, 500, problem{Error: "payout status could not be updated"})
		return
	}
	count, _ := res.RowsAffected()
	if count == 0 {
		notFound(w, r)
		return
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'bank_payout.submitted_to_bank','bank_payout',$4,jsonb_build_object('note',$5::text))`, "aud_"+newID(), org, nullable(p.userID), id, strings.TrimSpace(in.Note)); err != nil {
		writeJSON(w, 500, problem{Error: "payout submission audit could not be recorded"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "payout status update conflict"})
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "status": "submitted_to_bank", "settlement": "awaiting_bank_statement"})
}

func (a *App) closePeriods(w http.ResponseWriter, r *http.Request, org string) {
	if r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `SELECT id,period_start,period_end,status,close_note,created_at,closed_at FROM close_periods WHERE organization_id=$1 ORDER BY period_start DESC LIMIT 100`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "periods could not be loaded"})
			return
		}
		defer rows.Close()
		data := make([]map[string]any, 0)
		for rows.Next() {
			var id, status, note string
			var start, end time.Time
			var created time.Time
			var closed sql.NullTime
			if err = rows.Scan(&id, &start, &end, &status, &note, &created, &closed); err != nil {
				writeJSON(w, 500, problem{Error: "periods could not be read"})
				return
			}
			var closedAt any
			if closed.Valid {
				closedAt = closed.Time
			}
			data = append(data, map[string]any{"id": id, "period_start": start.Format("2006-01-02"), "period_end": end.Format("2006-01-02"), "status": status, "close_note": note, "created_at": created, "closed_at": closedAt})
		}
		if err = rows.Err(); err != nil {
			writeJSON(w, 500, problem{Error: "periods could not be read"})
			return
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if r.Method != http.MethodPost {
		notFound(w, r)
		return
	}
	var in struct {
		Start string `json:"period_start"`
		End   string `json:"period_end"`
	}
	if decode(r, &in) != nil {
		bad(w, r, "period_start and period_end are required")
		return
	}
	start, startErr := time.Parse("2006-01-02", in.Start)
	end, endErr := time.Parse("2006-01-02", in.End)
	if startErr != nil || endErr != nil || !start.Before(end) {
		bad(w, r, "period_start and period_end must be valid dates with start before end")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	var overlaps bool
	err = tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM close_periods WHERE organization_id=$1 AND period_start<$3 AND period_end>$2)`, org, start, end).Scan(&overlaps)
	if err != nil {
		writeJSON(w, 500, problem{Error: "period overlap check failed"})
		return
	}
	if overlaps {
		writeJSON(w, 409, problem{Error: "period overlaps an existing close period"})
		return
	}
	id := "per_" + newID()
	p := principalFrom(r)
	_, err = tx.ExecContext(r.Context(), `INSERT INTO close_periods(id,organization_id,period_start,period_end,created_by) VALUES($1,$2,$3,$4,$5)`, id, org, start, end, nullable(p.userID))
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'close_period.created','close_period',$4,jsonb_build_object('period_start',$5::date,'period_end',$6::date))`, "aud_"+newID(), org, nullable(p.userID), id, start, end)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "period could not be created"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "period creation conflict"})
		return
	}
	writeJSON(w, 201, map[string]any{"id": id, "period_start": in.Start, "period_end": in.End, "status": "open"})
}

func (a *App) changePeriodStatus(w http.ResponseWriter, r *http.Request, org, id, action string) {
	p := principalFrom(r)
	if p.userID == "" || p.role != "owner" && p.role != "admin" {
		writeJSON(w, 403, problem{Error: "period close and reopen require an owner or admin"})
		return
	}
	var in struct {
		Note string `json:"note"`
	}
	if decode(r, &in) != nil || strings.TrimSpace(in.Note) == "" || len(in.Note) > 500 {
		bad(w, r, "a review note of up to 500 characters is required")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	var start, end time.Time
	var status string
	if err = tx.QueryRowContext(r.Context(), `SELECT period_start,period_end,status FROM close_periods WHERE id=$1 AND organization_id=$2 FOR UPDATE`, id, org).Scan(&start, &end, &status); err == sql.ErrNoRows {
		notFound(w, r)
		return
	} else if err != nil {
		writeJSON(w, 500, problem{Error: "period could not be loaded"})
		return
	}
	if action == "close" {
		if status != "open" {
			writeJSON(w, 409, problem{Error: "period is not open"})
			return
		}
		var exceptions, approvals int
		if err = tx.QueryRowContext(r.Context(), `SELECT count(*) FROM reconciliation_lines l JOIN reconciliation_imports i ON i.id=l.import_id WHERE i.organization_id=$1 AND l.organization_id=$1 AND l.transaction_date >= $2 AND l.transaction_date < $3 AND l.match_status NOT IN ('matched','ignored')`, org, start, end).Scan(&exceptions); err != nil {
			writeJSON(w, 500, problem{Error: "period exception check failed"})
			return
		}
		if err = tx.QueryRowContext(r.Context(), `SELECT
			(SELECT count(*) FROM transfers WHERE organization_id=$1 AND created_at >= $2 AND created_at < $3 AND status='pending_approval') +
			(SELECT count(*) FROM bank_payout_instructions WHERE organization_id=$1 AND created_at >= $2 AND created_at < $3 AND status='pending_approval')`, org, start, end).Scan(&approvals); err != nil {
			writeJSON(w, 500, problem{Error: "period approval check failed"})
			return
		}
		if exceptions > 0 || approvals > 0 {
			writeJSON(w, 409, map[string]any{"error": "period has unresolved controls", "open_reconciliation_exceptions": exceptions, "pending_approvals": approvals})
			return
		}
		_, err = tx.ExecContext(r.Context(), `UPDATE close_periods SET status='closed',closed_by=$3,closed_at=now(),close_note=$4 WHERE id=$1 AND organization_id=$2`, id, org, p.userID, strings.TrimSpace(in.Note))
	} else {
		if status != "closed" {
			writeJSON(w, 409, problem{Error: "period is not closed"})
			return
		}
		_, err = tx.ExecContext(r.Context(), `UPDATE close_periods SET status='open',reopened_by=$3,reopened_at=now(),reopen_note=$4 WHERE id=$1 AND organization_id=$2`, id, org, p.userID, strings.TrimSpace(in.Note))
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "period status could not be updated"})
		return
	}
	actionName := "close_period.closed"
	status = "closed"
	if action == "reopen" {
		actionName = "close_period.reopened"
		status = "open"
	}
	_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,'close_period',$5,jsonb_build_object('note',$6::text))`, "aud_"+newID(), org, p.userID, actionName, id, strings.TrimSpace(in.Note))
	if err != nil {
		writeJSON(w, 500, problem{Error: "period decision could not be audited"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "period status update conflict"})
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "status": status, "review_note": strings.TrimSpace(in.Note)})
}

func (a *App) controlHealth(w http.ResponseWriter, r *http.Request, org string) {
	var exceptions, approvals, periods, payouts int
	err := a.db.QueryRowContext(r.Context(), `SELECT
	 (SELECT count(*) FROM reconciliation_lines l JOIN reconciliation_imports i ON i.id=l.import_id WHERE i.organization_id=$1 AND l.organization_id=$1 AND l.match_status NOT IN ('matched','ignored')),
	 (SELECT count(*) FROM transfers WHERE organization_id=$1 AND status='pending_approval') +
	 (SELECT count(*) FROM bank_payout_instructions WHERE organization_id=$1 AND status='pending_approval'),
	 (SELECT count(*) FROM close_periods WHERE organization_id=$1 AND status='open'),
	 (SELECT count(*) FROM bank_payout_instructions WHERE organization_id=$1 AND status IN ('prepared','exported_for_manual_entry','submitted_to_bank'))`, org).Scan(&exceptions, &approvals, &periods, &payouts)
	if err != nil {
		writeJSON(w, 500, problem{Error: "control health could not be calculated"})
		return
	}
	writeJSON(w, 200, map[string]any{"open_reconciliation_exceptions": exceptions, "pending_approvals": approvals, "open_periods": periods, "payouts_awaiting_statement": payouts, "settlement_mode": "bank_file_only"})
}

var scenarioResults = map[string]map[string]any{
	"duplicate_statement_lines": {
		"title": "Duplicate statement lines", "risk": "A repeated bank reference can inflate a reconciliation count if it is accepted twice.",
		"expected_controls": []string{"Flag the repeated reference", "Keep both source rows for evidence", "Resolve or ignore the duplicate with a reviewer note"},
	},
	"mismatched_totals": {
		"title": "Statement total mismatch", "risk": "The statement total differs from the sum of its imported lines.",
		"expected_controls": []string{"Compare source total to imported rows", "Keep the period open", "Record the correction and reviewer decision"},
	},
	"suspicious_transfer": {
		"title": "Suspicious transfer request", "risk": "An unusual payee or amount requires additional review before bank submission.",
		"expected_controls": []string{"Hold the payout register entry", "Require an independent reviewer", "Record evidence before marking submitted"},
	},
}

func (a *App) scenarioRuns(w http.ResponseWriter, r *http.Request, org string) {
	if r.Method != http.MethodGet {
		notFound(w, r)
		return
	}
	rows, err := a.db.QueryContext(r.Context(), `SELECT id,scenario_type,result,created_by,created_at FROM scenario_runs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`, org)
	if err != nil {
		writeJSON(w, 500, problem{Error: "scenario history could not be loaded"})
		return
	}
	defer rows.Close()
	data := make([]map[string]any, 0)
	for rows.Next() {
		var id, typ string
		var raw []byte
		var actor sql.NullString
		var created time.Time
		if err = rows.Scan(&id, &typ, &raw, &actor, &created); err != nil {
			writeJSON(w, 500, problem{Error: "scenario history could not be read"})
			return
		}
		var result any
		if err = json.Unmarshal(raw, &result); err != nil {
			writeJSON(w, 500, problem{Error: "scenario result could not be decoded"})
			return
		}
		data = append(data, map[string]any{"id": id, "scenario_type": typ, "result": result, "created_by": nullableNull(actor), "created_at": created})
	}
	if err = rows.Err(); err != nil {
		writeJSON(w, 500, problem{Error: "scenario history could not be read"})
		return
	}
	writeJSON(w, 200, map[string]any{"data": data})
}

func (a *App) simulateScenario(w http.ResponseWriter, r *http.Request, org string) {
	var in struct {
		Type string `json:"scenario_type"`
	}
	if decode(r, &in) != nil {
		bad(w, r, "scenario_type is required")
		return
	}
	result, ok := scenarioResults[in.Type]
	if !ok {
		bad(w, r, "scenario_type must be duplicate_statement_lines, mismatched_totals, or suspicious_transfer")
		return
	}
	id := "sim_" + newID()
	p := principalFrom(r)
	raw, err := json.Marshal(result)
	if err != nil {
		writeJSON(w, 500, problem{Error: "scenario result could not be encoded"})
		return
	}
	_, err = a.db.ExecContext(r.Context(), `INSERT INTO scenario_runs(id,organization_id,scenario_type,result,created_by) VALUES($1,$2,$3,$4,$5)`, id, org, in.Type, raw, nullable(p.userID))
	if err != nil {
		writeJSON(w, 500, problem{Error: "scenario run could not be recorded"})
		return
	}
	writeJSON(w, 201, map[string]any{"id": id, "scenario_type": in.Type, "result": result, "mode": "simulation_only", "ledger_changed": false, "funds_moved": false})
}
