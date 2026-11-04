package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (a *App) transfers(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) == 1 && r.Method == http.MethodGet {
		a.listTransfers(w, r, org)
		return
	}
	if len(parts) == 1 && r.Method == http.MethodPost {
		var in struct {
			Source      string `json:"source_account_id"`
			Destination string `json:"destination_account_id"`
			Amount      int64  `json:"amount"`
			Currency    string `json:"currency"`
			Reference   string `json:"reference"`
		}
		if decode(r, &in) != nil || in.Amount <= 0 || in.Source == "" || in.Destination == "" || in.Source == in.Destination || len(in.Currency) != 3 || in.Reference == "" {
			bad(w, r, "source, destination, positive amount, currency and reference are required")
			return
		}
		idemKey, hash, err := requireIdempotencyKey(r)
		if err != nil {
			bad(w, r, err.Error())
			return
		}
		tx, err := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer tx.Rollback()
		status, body, replay, err := reserveIdempotency(r.Context(), tx, org, idemKey, hash)
		if err != nil {
			idempotencyFailure(w, r, err)
			return
		}
		if replay {
			writeRawJSON(w, status, body)
			return
		}
		var srcCur, dstCur string
		err = tx.QueryRowContext(r.Context(), `SELECT currency FROM accounts WHERE id=$1 AND organization_id=$2 AND status='active' FOR UPDATE`, in.Source, org).Scan(&srcCur)
		if err != nil {
			notFound(w, r)
			return
		}
		err = tx.QueryRowContext(r.Context(), `SELECT currency FROM accounts WHERE id=$1 AND organization_id=$2 AND status='active' FOR UPDATE`, in.Destination, org).Scan(&dstCur)
		if err != nil {
			notFound(w, r)
			return
		}
		currency := strings.ToUpper(in.Currency)
		if srcCur != currency || dstCur != currency {
			bad(w, r, "account currency mismatch")
			return
		}
		var balance, reserved int64
		err = tx.QueryRowContext(r.Context(), `SELECT COALESCE(SUM(CASE side WHEN 'credit' THEN amount_minor ELSE -amount_minor END),0) FROM journal_lines WHERE organization_id=$1 AND account_id=$2`, org, in.Source).Scan(&balance)
		if err == nil {
			err = tx.QueryRowContext(r.Context(), `SELECT COALESCE(SUM(amount_minor),0) FROM transfers WHERE organization_id=$1 AND source_account_id=$2 AND status='pending_approval'`, org, in.Source).Scan(&reserved)
		}
		if err != nil || balance-reserved < in.Amount {
			writeJSON(w, 409, problem{Error: "insufficient available funds"})
			return
		}
		threshold, policyErr := a.enforceTransactionLimit(r.Context(), tx, org, currency, "transfer", in.Amount)
		if policyErr == errPolicyLimit {
			writeJSON(w, 409, problem{Error: policyErr.Error()})
			return
		}
		if policyErr != nil {
			writeJSON(w, 500, problem{Error: "transaction policy check failed"})
			return
		}
		if threshold == 0 {
			threshold, _ = strconv.ParseInt(env("TRANSFER_APPROVAL_THRESHOLD_MINOR", "100000000"), 10, 64)
		}
		risk, riskErr := evaluateRisk(r.Context(), tx, org, riskSubject{Kind: "transfer", Amount: in.Amount, Currency: currency, SourceAccountID: in.Source})
		if riskErr != nil {
			writeJSON(w, 500, problem{Error: "risk check failed", RequestID: requestID(r)})
			return
		}
		if risk.Decision == "block" {
			riskBlocked(w, r, risk)
			return
		}
		// A review decision always routes the transfer to a second reviewer.
		needsApproval := threshold > 0 && in.Amount >= threshold || risk.Decision == "review"
		state := "completed"
		httpStatus := 201
		if needsApproval {
			state = "pending_approval"
			httpStatus = 202
		}
		if !needsApproval {
			if err = ensurePeriodOpen(r.Context(), tx, org, time.Now()); err != nil {
				periodGuardFailure(w, r, err)
				return
			}
		}
		id := "trf_" + newID()
		entry := "jrn_" + newID()
		actor := principalFrom(r)
		_, err = tx.ExecContext(r.Context(), `INSERT INTO transfers(id,organization_id,source_account_id,destination_account_id,amount_minor,currency,status,reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, org, in.Source, in.Destination, in.Amount, currency, state, in.Reference, nullable(actor.userID))
		if err != nil {
			writeJSON(w, 409, problem{Error: "transfer could not be created; reference may already exist"})
			return
		}
		if err == nil {
			err = recordRiskOutcome(r.Context(), tx, org, "transfer", id, in.Reference, &risk)
		}
		if err == nil && !needsApproval {
			_, err = tx.ExecContext(r.Context(), `INSERT INTO journal_entries(id,organization_id,reference_type,reference_id,currency,amount_minor) VALUES($1,$2,'transfer',$3,$4,$5)`, entry, org, id, currency, in.Amount)
			if err == nil {
				_, err = tx.ExecContext(r.Context(), `INSERT INTO journal_lines(journal_entry_id,organization_id,account_id,side,amount_minor,currency) VALUES($1,$2,$3,'debit',$5,$6),($1,$2,$4,'credit',$5,$6)`, entry, org, in.Source, in.Destination, in.Amount, currency)
			}
		}
		eventType := "transfer.completed"
		if needsApproval {
			eventType = "transfer.approval_required"
		}
		if err == nil {
			_, err = tx.ExecContext(r.Context(), `INSERT INTO outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'transfer',$3,$4,jsonb_build_object('transfer_id',$3::text,'status',$5::text,'amount',$6::bigint,'currency',$7::text))`, "evt_"+newID(), org, id, eventType, state, in.Amount, currency)
		}
		if err != nil {
			writeJSON(w, 500, problem{Error: "transfer posting failed"})
			return
		}
		result := map[string]any{"id": id, "status": state, "transfer_type": "internal", "amount": in.Amount, "currency": currency, "reference": in.Reference, "risk": risk}
		if err = storeIdempotency(r.Context(), tx, org, idemKey, httpStatus, result); err != nil {
			idempotencyFailure(w, r, err)
			return
		}
		if err = tx.Commit(); err != nil {
			writeJSON(w, 409, problem{Error: "transfer conflict; retry safely"})
			return
		}
		writeJSON(w, httpStatus, result)
		return
	}
	if len(parts) == 2 && r.Method == http.MethodGet {
		var id, status, currency, reference string
		var amount int64
		err := a.db.QueryRowContext(r.Context(), `SELECT id,status,currency,reference,amount_minor FROM transfers WHERE id=$1 AND organization_id=$2`, parts[1], org).Scan(&id, &status, &currency, &reference, &amount)
		if err == sql.ErrNoRows {
			notFound(w, r)
		} else if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
		} else {
			writeJSON(w, 200, map[string]any{"id": id, "status": status, "currency": currency, "reference": reference, "amount": amount})
		}
		return
	}
	notFound(w, r)
}

func (a *App) reviewTransfer(w http.ResponseWriter, r *http.Request, id, action string) {
	p := principalFrom(r)
	if p.userID == "" {
		writeJSON(w, 403, problem{Error: "a distinct authenticated user must approve transfers"})
		return
	}
	var in struct {
		Note string `json:"note"`
	}
	if decodeOptional(r, &in) != nil {
		bad(w, r, "request body must be a JSON object with an optional note")
		return
	}
	in.Note = strings.TrimSpace(in.Note)
	if len(in.Note) > 500 || action == "reject" && in.Note == "" {
		bad(w, r, "a note of up to 500 characters is required to reject a transfer")
		return
	}
	key, hash, err := requireIdempotencyKey(r)
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	org := currentOrgID(r, a.orgID)
	tx, err := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	status, body, replay, err := reserveIdempotency(r.Context(), tx, org, key, hash)
	if err != nil {
		idempotencyFailure(w, r, err)
		return
	}
	if replay {
		writeRawJSON(w, status, body)
		return
	}
	authorized, authErr := a.authorizedTransferReviewer(r, tx, org, p)
	if authErr != nil {
		writeJSON(w, 500, problem{Error: "approval authorization could not be checked"})
		return
	}
	if !authorized {
		writeJSON(w, 403, problem{Error: "transfer approval requires an owner/admin or an active delegation"})
		return
	}
	var source, destination, currency, state string
	var amount int64
	var creator sql.NullString
	err = tx.QueryRowContext(r.Context(), `SELECT source_account_id,destination_account_id,currency,status,amount_minor,created_by FROM transfers WHERE id=$1 AND organization_id=$2 FOR UPDATE`, id, org).Scan(&source, &destination, &currency, &state, &amount, &creator)
	if err == sql.ErrNoRows {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	if state != "pending_approval" {
		writeJSON(w, 409, problem{Error: "transfer is not awaiting approval"})
		return
	}
	if !transferApprovalAllowed(creator, p.userID) {
		writeJSON(w, 403, problem{Error: "initiator cannot approve their own transfer"})
		return
	}
	var priorVote bool
	if err = tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM transfer_approvals WHERE organization_id=$1 AND transfer_id=$2 AND approver_user_id=$3)`, org, id, p.userID).Scan(&priorVote); err != nil {
		writeJSON(w, 500, problem{Error: "prior approval check failed"})
		return
	}
	if priorVote {
		writeJSON(w, 409, problem{Error: "this reviewer has already recorded a decision"})
		return
	}
	requiredApprovals := 1
	err = tx.QueryRowContext(r.Context(), `SELECT required_approvals FROM transaction_policies WHERE organization_id=$1 AND currency=upper($2)`, org, currency).Scan(&requiredApprovals)
	if err != nil && err != sql.ErrNoRows {
		writeJSON(w, 500, problem{Error: "approval policy could not be loaded"})
		return
	}
	if requiredApprovals < 1 || requiredApprovals > 3 {
		writeJSON(w, 500, problem{Error: "stored approval policy is invalid"})
		return
	}
	decision := "approved"
	newStatus := "pending_approval"
	result := map[string]any{"id": id, "status": newStatus}
	if action == "reject" {
		decision = "rejected"
		newStatus = "rejected"
		result["status"] = newStatus
	}
	receivedApprovals := 0
	finalApproval := false
	if decision == "approved" {
		if err = tx.QueryRowContext(r.Context(), `SELECT count(*) FROM transfer_approvals WHERE organization_id=$1 AND transfer_id=$2 AND decision='approved'`, org, id).Scan(&receivedApprovals); err != nil {
			writeJSON(w, 500, problem{Error: "approval count could not be loaded"})
			return
		}
		receivedApprovals++
		finalApproval = approvalRequirementMet(receivedApprovals, requiredApprovals)
		if finalApproval {
			newStatus = "completed"
			result["status"] = newStatus
		}
		result["approvals_received"] = receivedApprovals
		result["required_approvals"] = requiredApprovals
	}
	if decision == "approved" && finalApproval {
		if err = ensurePeriodOpen(r.Context(), tx, org, time.Now()); err != nil {
			periodGuardFailure(w, r, err)
			return
		}
		var c string
		err = tx.QueryRowContext(r.Context(), `SELECT currency FROM accounts WHERE id=$1 AND organization_id=$2 AND status='active' FOR UPDATE`, source, org).Scan(&c)
		if err != nil || strings.TrimSpace(c) != strings.TrimSpace(currency) {
			writeJSON(w, 409, problem{Error: "source account is unavailable or currency changed"})
			return
		}
		err = tx.QueryRowContext(r.Context(), `SELECT currency FROM accounts WHERE id=$1 AND organization_id=$2 AND status='active' FOR UPDATE`, destination, org).Scan(&c)
		if err != nil || strings.TrimSpace(c) != strings.TrimSpace(currency) {
			writeJSON(w, 409, problem{Error: "destination account is unavailable or currency changed"})
			return
		}
		var balance, otherReserved int64
		err = tx.QueryRowContext(r.Context(), `SELECT COALESCE(SUM(CASE side WHEN 'credit' THEN amount_minor ELSE -amount_minor END),0) FROM journal_lines WHERE organization_id=$1 AND account_id=$2`, org, source).Scan(&balance)
		if err == nil {
			err = tx.QueryRowContext(r.Context(), `SELECT COALESCE(SUM(amount_minor),0) FROM transfers WHERE organization_id=$1 AND source_account_id=$2 AND status='pending_approval' AND id<>$3`, org, source, id).Scan(&otherReserved)
		}
		if err != nil || balance-otherReserved < amount {
			writeJSON(w, 409, problem{Error: "insufficient available funds at approval"})
			return
		}
		entry := "jrn_" + newID()
		_, err = tx.ExecContext(r.Context(), `INSERT INTO journal_entries(id,organization_id,reference_type,reference_id,currency,amount_minor) VALUES($1,$2,'transfer',$3,$4,$5)`, entry, org, id, currency, amount)
		if err == nil {
			_, err = tx.ExecContext(r.Context(), `INSERT INTO journal_lines(journal_entry_id,organization_id,account_id,side,amount_minor,currency) VALUES($1,$2,$3,'debit',$5,$6),($1,$2,$4,'credit',$5,$6)`, entry, org, source, destination, amount, currency)
		}
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `UPDATE transfers SET status=$3 WHERE id=$1 AND organization_id=$2`, id, org, newStatus)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO transfer_approvals(id,organization_id,transfer_id,approver_user_id,decision,note) VALUES($1,$2,$3,$4,$5,$6)`, "apv_"+newID(), org, id, p.userID, decision, in.Note)
	}
	eventType := "transfer.approval_recorded"
	if decision == "approved" && finalApproval {
		eventType = "transfer.approved"
	} else if decision == "rejected" {
		eventType = "transfer.rejected"
	}
	if err == nil {
		actionName := "transfer.approval.recorded"
		if decision == "rejected" {
			actionName = "transfer.rejected"
		} else if finalApproval {
			actionName = "transfer.approved"
		}
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,'transfer',$5,jsonb_build_object('decision',$6::text,'approvals_received',$7::integer,'required_approvals',$8::integer,'note',$9::text))`, "aud_"+newID(), org, p.userID, actionName, id, decision, receivedApprovals, requiredApprovals, in.Note)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "transfer review audit could not be recorded"})
		return
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'transfer',$3,$4,jsonb_build_object('transfer_id',$3::text,'status',$5::text))`, "evt_"+newID(), org, id, eventType, newStatus)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "transfer review failed"})
		return
	}
	if err = storeIdempotency(r.Context(), tx, org, key, 200, result); err != nil {
		idempotencyFailure(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "transfer review conflict"})
		return
	}
	writeJSON(w, 200, result)
}

func transferApprovalAllowed(creator sql.NullString, approverID string) bool {
	return approverID != "" && (!creator.Valid || creator.String != approverID)
}

func approvalRequirementMet(received, required int) bool {
	return required > 0 && received >= required
}

func (a *App) authorizedTransferReviewer(r *http.Request, tx *sql.Tx, org string, p principal) (bool, error) {
	if p.role == "owner" || p.role == "admin" {
		return true, nil
	}
	if p.role != "finance_operator" {
		return false, nil
	}
	var delegated bool
	err := tx.QueryRowContext(r.Context(), `SELECT EXISTS(
		SELECT 1 FROM approval_delegations d
		JOIN memberships delegator ON delegator.organization_id=d.organization_id AND delegator.user_id=d.delegator_user_id AND delegator.status='active' AND delegator.role IN ('owner','admin')
		JOIN memberships delegate ON delegate.organization_id=d.organization_id AND delegate.user_id=d.delegate_user_id AND delegate.status='active' AND delegate.role='finance_operator'
		WHERE d.organization_id=$1 AND d.delegate_user_id=$2 AND d.revoked_at IS NULL AND d.expires_at>now()
	)`, org, p.userID).Scan(&delegated)
	return delegated, err
}
