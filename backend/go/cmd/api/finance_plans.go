package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maxFinanceEvidenceBytes = 4 << 20

func (a *App) financePlans(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) == 0 {
		notFound(w, r)
		return
	}
	switch parts[0] {
	case "funds":
		a.financeFunds(w, r, org, parts[1:])
	case "commitments":
		a.financeCommitments(w, r, org, parts[1:])
	case "advances":
		a.staffAdvances(w, r, org, parts[1:])
	case "evidence":
		a.financeEvidence(w, r, org, parts[1:])
	case "queue":
		if len(parts) == 1 && r.Method == http.MethodGet {
			a.financeQueue(w, r, org)
			return
		}
		notFound(w, r)
	default:
		notFound(w, r)
	}
}

func financeMutation(a *App, w http.ResponseWriter, r *http.Request, org string) (*sql.Tx, string, bool) {
	key, hash, err := requireIdempotencyKey(r)
	if err != nil {
		bad(w, r, err.Error())
		return nil, "", false
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, problem{Error: "database error"})
		return nil, "", false
	}
	status, body, replay, err := reserveIdempotency(r.Context(), tx, org, key, hash)
	if err != nil {
		_ = tx.Rollback()
		idempotencyFailure(w, r, err)
		return nil, "", false
	}
	if replay {
		_ = tx.Rollback()
		writeRawJSON(w, status, body)
		return nil, "", false
	}
	return tx, key, true
}

func finishFinanceMutation(w http.ResponseWriter, r *http.Request, tx *sql.Tx, org, key string, status int, result any) {
	if err := storeIdempotency(r.Context(), tx, org, key, status, result); err != nil {
		writeJSON(w, http.StatusInternalServerError, problem{Error: "idempotency record failure"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSON(w, http.StatusConflict, problem{Error: "finance record update conflict"})
		return
	}
	writeJSON(w, status, result)
}

func (a *App) financeFunds(w http.ResponseWriter, r *http.Request, org string, parts []string) {
	if len(parts) == 0 && r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `
			SELECT f.id,f.name,f.fund_type,f.donor_name,f.project_code,f.restriction_note,
				f.currency,f.allocated_minor,f.period_start,f.period_end,f.status,f.created_at,
				COALESCE((SELECT sum(c.amount_minor) FROM finance_commitments c
					WHERE c.organization_id=f.organization_id AND c.fund_id=f.id
					AND c.status IN ('planned','linked')),0) AS committed_minor,
				COALESCE((SELECT sum(CASE WHEN c.commitment_type='staff_advance' THEN 0 ELSE c.amount_minor END)
					FROM finance_commitments c WHERE c.organization_id=f.organization_id AND c.fund_id=f.id
					AND c.status='settled'),0)
				+ COALESCE((SELECT sum(s.used_minor) FROM advance_settlements s
					JOIN staff_advances x ON x.organization_id=s.organization_id AND x.id=s.advance_id
					JOIN finance_commitments c ON c.organization_id=x.organization_id AND c.id=x.commitment_id
					WHERE c.organization_id=f.organization_id AND c.fund_id=f.id AND s.status='approved'),0) AS spent_minor
			FROM finance_funds f WHERE f.organization_id=$1
			ORDER BY CASE WHEN f.status='active' THEN 0 ELSE 1 END,f.name LIMIT 500`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "funds could not be loaded"})
			return
		}
		defer rows.Close()
		data := make([]map[string]any, 0)
		for rows.Next() {
			var id, name, kind, donor, projectCode, restriction, currency, status string
			var allocated, committed, spent int64
			var start, end sql.NullTime
			var created time.Time
			if err = rows.Scan(&id, &name, &kind, &donor, &projectCode, &restriction, &currency, &allocated, &start, &end, &status, &created, &committed, &spent); err != nil {
				writeJSON(w, 500, problem{Error: "funds could not be read"})
				return
			}
			data = append(data, map[string]any{
				"id": id, "name": name, "fund_type": kind, "donor_name": donor, "project_code": projectCode,
				"restriction_note": restriction, "currency": strings.TrimSpace(currency), "allocated_minor": allocated,
				"committed_minor": committed, "spent_minor": spent, "available_minor": allocated - committed - spent,
				"period_start": nullDate(start), "period_end": nullDate(end), "status": status, "created_at": created,
			})
		}
		if err = rows.Err(); err != nil {
			writeJSON(w, 500, problem{Error: "funds could not be read"})
			return
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if len(parts) == 2 && parts[1] == "close" && r.Method == http.MethodPost {
		if principalFrom(r).role != "owner" && principalFrom(r).role != "admin" {
			writeJSON(w, 403, problem{Error: "only an owner or admin can close a fund"})
			return
		}
		var in struct {
			Note string `json:"note"`
		}
		if decode(r, &in) != nil || len(strings.TrimSpace(in.Note)) < 3 || len(in.Note) > 500 {
			bad(w, r, "a fund closure note between 3 and 500 characters is required")
			return
		}
		tx, key, ok := financeMutation(a, w, r, org)
		if !ok {
			return
		}
		defer tx.Rollback()
		var fundStatus string
		err := tx.QueryRowContext(r.Context(), `SELECT status FROM finance_funds WHERE organization_id=$1 AND id=$2 FOR UPDATE`, org, parts[0]).Scan(&fundStatus)
		if errors.Is(err, sql.ErrNoRows) {
			notFound(w, r)
			return
		}
		if err != nil {
			writeJSON(w, 500, problem{Error: "fund could not be locked"})
			return
		}
		if fundStatus != "active" {
			writeJSON(w, 409, problem{Error: "fund is already closed"})
			return
		}
		var active int
		if err = tx.QueryRowContext(r.Context(), `SELECT count(*) FROM finance_commitments WHERE organization_id=$1 AND fund_id=$2 AND status IN ('planned','linked')`, org, parts[0]).Scan(&active); err != nil {
			writeJSON(w, 500, problem{Error: "fund commitments could not be checked"})
			return
		}
		if active > 0 {
			writeJSON(w, 409, problem{Error: "a fund with active commitments cannot be closed"})
			return
		}
		res, err := tx.ExecContext(r.Context(), `UPDATE finance_funds SET status='closed',updated_at=now() WHERE organization_id=$1 AND id=$2 AND status='active'`, org, parts[0])
		if err != nil {
			writeJSON(w, 500, problem{Error: "fund could not be closed"})
			return
		}
		count, _ := res.RowsAffected()
		if count == 0 {
			notFound(w, r)
			return
		}
		p := principalFrom(r)
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'finance_fund.closed','finance_fund',$4,jsonb_build_object('note',$5::text))`, "aud_"+newID(), org, nullable(p.userID), parts[0], strings.TrimSpace(in.Note)); err != nil {
			writeJSON(w, 500, problem{Error: "fund closure audit could not be recorded"})
			return
		}
		finishFinanceMutation(w, r, tx, org, key, 200, map[string]any{"id": parts[0], "status": "closed"})
		return
	}
	if len(parts) != 0 || r.Method != http.MethodPost {
		notFound(w, r)
		return
	}
	var in struct {
		Name            string `json:"name"`
		Type            string `json:"fund_type"`
		Donor           string `json:"donor_name"`
		ProjectCode     string `json:"project_code"`
		RestrictionNote string `json:"restriction_note"`
		Currency        string `json:"currency"`
		Allocated       int64  `json:"allocated_minor"`
		PeriodStart     string `json:"period_start"`
		PeriodEnd       string `json:"period_end"`
	}
	if decode(r, &in) != nil {
		bad(w, r, "invalid fund request")
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Type = strings.TrimSpace(in.Type)
	in.Currency = strings.ToUpper(strings.TrimSpace(in.Currency))
	in.Donor = strings.TrimSpace(in.Donor)
	in.ProjectCode = strings.TrimSpace(in.ProjectCode)
	in.RestrictionNote = strings.TrimSpace(in.RestrictionNote)
	if len(in.Name) < 2 || len(in.Name) > 120 || !containsString([]string{"general", "restricted", "grant", "project", "household"}, in.Type) ||
		len(in.Currency) != 3 || in.Allocated < 0 || len(in.Donor) > 160 || len(in.ProjectCode) > 80 || len(in.RestrictionNote) > 1000 {
		bad(w, r, "name, fund_type, three-letter currency, and non-negative allocated_minor are required")
		return
	}
	if (in.Type == "restricted" || in.Type == "grant") && in.RestrictionNote == "" {
		bad(w, r, "restricted and grant funds need a restriction note")
		return
	}
	start, err := parseOptionalDate(in.PeriodStart)
	if err != nil {
		bad(w, r, "period_start must be an ISO date")
		return
	}
	end, err := parseOptionalDate(in.PeriodEnd)
	if err != nil || start != nil && end != nil && !start.Before(*end) {
		bad(w, r, "period_end must be after period_start")
		return
	}
	id := "fnd_" + newID()
	p := principalFrom(r)
	tx, key, ok := financeMutation(a, w, r, org)
	if !ok {
		return
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(r.Context(), `INSERT INTO finance_funds(id,organization_id,name,fund_type,donor_name,project_code,restriction_note,currency,allocated_minor,period_start,period_end,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		id, org, in.Name, in.Type, in.Donor, in.ProjectCode, in.RestrictionNote, in.Currency, in.Allocated, start, end, nullable(p.userID))
	if err != nil {
		writeJSON(w, 500, problem{Error: "fund could not be saved"})
		return
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'finance_fund.created','finance_fund',$4,jsonb_build_object('name',$5::text,'fund_type',$6::text,'currency',$7::text,'allocated_minor',$8::bigint))`, "aud_"+newID(), org, nullable(p.userID), id, in.Name, in.Type, in.Currency, in.Allocated); err != nil {
		writeJSON(w, 500, problem{Error: "fund creation audit could not be recorded"})
		return
	}
	finishFinanceMutation(w, r, tx, org, key, 201, map[string]any{"id": id, "name": in.Name, "fund_type": in.Type, "currency": in.Currency, "allocated_minor": in.Allocated, "status": "active"})
}

func (a *App) financeCommitments(w http.ResponseWriter, r *http.Request, org string, parts []string) {
	if len(parts) == 0 && r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `SELECT c.id,c.fund_id,f.name,c.commitment_type,c.title,c.beneficiary_name,c.amount_minor,c.currency,c.status,c.payout_id,c.due_date,c.created_at,COALESCE(p.status,'') FROM finance_commitments c JOIN finance_funds f ON f.organization_id=c.organization_id AND f.id=c.fund_id LEFT JOIN bank_payout_instructions p ON p.organization_id=c.organization_id AND p.id=c.payout_id WHERE c.organization_id=$1 ORDER BY c.created_at DESC LIMIT 500`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "commitments could not be loaded"})
			return
		}
		defer rows.Close()
		data := make([]map[string]any, 0)
		for rows.Next() {
			var id, fundID, fundName, kind, title, beneficiary, currency, status, payoutStatus string
			var amount int64
			var payout sql.NullString
			var due sql.NullTime
			var created time.Time
			if err = rows.Scan(&id, &fundID, &fundName, &kind, &title, &beneficiary, &amount, &currency, &status, &payout, &due, &created, &payoutStatus); err != nil {
				writeJSON(w, 500, problem{Error: "commitments could not be read"})
				return
			}
			data = append(data, map[string]any{"id": id, "fund_id": fundID, "fund_name": fundName, "commitment_type": kind, "title": title, "beneficiary_name": beneficiary, "amount_minor": amount, "currency": strings.TrimSpace(currency), "status": status, "payout_id": nullString(payout), "payout_status": payoutStatus, "due_date": nullDate(due), "created_at": created})
		}
		if err = rows.Err(); err != nil {
			writeJSON(w, 500, problem{Error: "commitments could not be read"})
			return
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if len(parts) == 2 && parts[1] == "link-payout" && r.Method == http.MethodPost {
		a.linkCommitmentPayout(w, r, org, parts[0])
		return
	}
	if len(parts) != 0 || r.Method != http.MethodPost {
		notFound(w, r)
		return
	}
	var in struct {
		FundID      string `json:"fund_id"`
		Type        string `json:"commitment_type"`
		Title       string `json:"title"`
		Beneficiary string `json:"beneficiary_name"`
		Amount      int64  `json:"amount_minor"`
		Currency    string `json:"currency"`
		DueDate     string `json:"due_date"`
	}
	if decode(r, &in) != nil {
		bad(w, r, "invalid commitment request")
		return
	}
	in.FundID = strings.TrimSpace(in.FundID)
	in.Type = strings.TrimSpace(in.Type)
	in.Title = strings.TrimSpace(in.Title)
	in.Beneficiary = strings.TrimSpace(in.Beneficiary)
	in.Currency = strings.ToUpper(strings.TrimSpace(in.Currency))
	if in.FundID == "" || !containsString([]string{"supplier", "operating"}, in.Type) || len(in.Title) < 2 || len(in.Title) > 160 ||
		len(in.Beneficiary) > 160 || in.Amount <= 0 || len(in.Currency) != 3 {
		bad(w, r, "fund_id, commitment_type, title, positive amount_minor, and three-letter currency are required")
		return
	}
	due, err := parseOptionalDate(in.DueDate)
	if err != nil {
		bad(w, r, "due_date must be an ISO date")
		return
	}
	id := "cmt_" + newID()
	p := principalFrom(r)
	tx, key, ok := financeMutation(a, w, r, org)
	if !ok {
		return
	}
	defer tx.Rollback()
	fundCurrency, fundStatus, available, err := lockFinanceFund(r, tx, org, in.FundID)
	if errors.Is(err, sql.ErrNoRows) {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "fund balance could not be checked"})
		return
	}
	if fundStatus != "active" {
		writeJSON(w, 409, problem{Error: "commitments cannot be added to a closed fund"})
		return
	}
	if strings.TrimSpace(fundCurrency) != in.Currency {
		bad(w, r, "commitment currency must match the fund currency")
		return
	}
	if in.Amount > available {
		writeJSON(w, 409, problem{Error: "commitment exceeds available fund balance", RequestID: requestID(r)})
		return
	}
	_, err = tx.ExecContext(r.Context(), `INSERT INTO finance_commitments(id,organization_id,fund_id,commitment_type,title,beneficiary_name,amount_minor,currency,due_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, org, in.FundID, in.Type, in.Title, in.Beneficiary, in.Amount, in.Currency, due, nullable(p.userID))
	if err != nil {
		writeJSON(w, 500, problem{Error: "commitment could not be saved"})
		return
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'finance_commitment.created','finance_commitment',$4,jsonb_build_object('fund_id',$5::text,'amount_minor',$6::bigint,'currency',$7::text))`, "aud_"+newID(), org, nullable(p.userID), id, in.FundID, in.Amount, in.Currency); err != nil {
		writeJSON(w, 500, problem{Error: "commitment audit could not be recorded"})
		return
	}
	finishFinanceMutation(w, r, tx, org, key, 201, map[string]any{"id": id, "fund_id": in.FundID, "title": in.Title, "amount_minor": in.Amount, "currency": in.Currency, "status": "planned", "due_date": in.DueDate})
}

func (a *App) linkCommitmentPayout(w http.ResponseWriter, r *http.Request, org, commitmentID string) {
	var in struct {
		Note string `json:"note"`
	}
	if decode(r, &in) != nil || len(strings.TrimSpace(in.Note)) < 3 || len(in.Note) > 500 {
		bad(w, r, "a note explaining the payout request is required")
		return
	}
	p := principalFrom(r)
	if p.userID == "" {
		writeJSON(w, 403, problem{Error: "advance settlement requires a signed-in workspace user"})
		return
	}
	tx, key, ok := financeMutation(a, w, r, org)
	if !ok {
		return
	}
	defer tx.Rollback()
	var fundID, title, beneficiary, currency, status, commitmentType string
	var amount int64
	err := tx.QueryRowContext(r.Context(), `SELECT fund_id,title,beneficiary_name,currency,amount_minor,status,commitment_type FROM finance_commitments WHERE organization_id=$1 AND id=$2 FOR UPDATE`, org, commitmentID).Scan(&fundID, &title, &beneficiary, &currency, &amount, &status, &commitmentType)
	if errors.Is(err, sql.ErrNoRows) {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "commitment could not be loaded"})
		return
	}
	if status != "planned" || commitmentType == "staff_advance" || beneficiary == "" {
		writeJSON(w, 409, problem{Error: "only a planned supplier or operating commitment with a beneficiary can be linked"})
		return
	}
	if err = ensurePeriodOpen(r.Context(), tx, org, time.Now()); err != nil {
		periodGuardFailure(w, r, err)
		return
	}
	threshold := int64(100000000)
	if configured, parseErr := strconv.ParseInt(env("TRANSFER_APPROVAL_THRESHOLD_MINOR", "100000000"), 10, 64); parseErr == nil {
		threshold = configured
	}
	requiredApprovals := 1
	var configuredThreshold sql.NullInt64
	err = tx.QueryRowContext(r.Context(), `SELECT approval_threshold_minor,required_approvals FROM transaction_policies WHERE organization_id=$1 AND currency=upper($2)`, org, currency).Scan(&configuredThreshold, &requiredApprovals)
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
	payoutID := "pay_" + newID()
	reference := "AP-" + strings.ToUpper(newID()[:12])
	risk, err := evaluateRisk(r.Context(), tx, org, riskSubject{Kind: "payout", Amount: amount, Currency: currency})
	if err != nil {
		writeJSON(w, 500, problem{Error: "risk check failed", RequestID: requestID(r)})
		return
	}
	if risk.Decision == "block" {
		_ = tx.Rollback()
		riskBlocked(w, r, risk)
		return
	}
	payoutStatus := "prepared"
	if payoutNeedsApproval(amount, threshold) || risk.Decision == "review" {
		payoutStatus = "pending_approval"
	}
	description := title + " — " + strings.TrimSpace(in.Note)
	if len(description) > 500 {
		description = description[:500]
	}
	_, err = tx.ExecContext(r.Context(), `INSERT INTO bank_payout_instructions(id,organization_id,beneficiary_name,amount_minor,currency,reference,description,created_by,required_approvals,status,finance_commitment_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, payoutID, org, beneficiary, amount, currency, reference, description, nullable(p.userID), requiredApprovals, payoutStatus, commitmentID)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `UPDATE finance_commitments SET status='linked',payout_id=$3,updated_at=now() WHERE organization_id=$1 AND id=$2 AND status='planned'`, org, commitmentID, payoutID)
	}
	if err == nil {
		err = recordRiskOutcome(r.Context(), tx, org, "payout", payoutID, reference, &risk)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'finance_commitment.payout_linked','finance_commitment',$4,jsonb_build_object('payout_id',$5::text,'reference',$6::text,'status',$7::text))`, "aud_"+newID(), org, nullable(p.userID), commitmentID, payoutID, reference, payoutStatus)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "payout could not be linked to commitment"})
		return
	}
	result := map[string]any{"commitment_id": commitmentID, "payout_id": payoutID, "reference": reference, "status": payoutStatus, "settlement": "not_submitted"}
	finishFinanceMutation(w, r, tx, org, key, 201, result)
}

func (a *App) staffAdvances(w http.ResponseWriter, r *http.Request, org string, parts []string) {
	if len(parts) == 0 && r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `SELECT x.id,x.commitment_id,x.payout_id,x.staff_name,x.purpose,x.amount_minor,x.currency,x.status,x.created_at,
			c.fund_id,f.name,p.reference,p.status,COALESCE((SELECT sum(s.used_minor+s.returned_minor) FROM advance_settlements s WHERE s.organization_id=x.organization_id AND s.advance_id=x.id AND s.status='approved'),0),
			COALESCE((SELECT sum(s.used_minor) FROM advance_settlements s WHERE s.organization_id=x.organization_id AND s.advance_id=x.id AND s.status='approved'),0)
			FROM staff_advances x JOIN finance_commitments c ON c.organization_id=x.organization_id AND c.id=x.commitment_id
			JOIN finance_funds f ON f.organization_id=c.organization_id AND f.id=c.fund_id
			JOIN bank_payout_instructions p ON p.organization_id=x.organization_id AND p.id=x.payout_id
			WHERE x.organization_id=$1 ORDER BY x.created_at DESC LIMIT 500`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "staff advances could not be loaded"})
			return
		}
		defer rows.Close()
		data := make([]map[string]any, 0)
		for rows.Next() {
			var id, commitmentID, payoutID, staff, purpose, currency, status, fundID, fundName, reference, payoutStatus string
			var amount, settled, used int64
			var created time.Time
			if err = rows.Scan(&id, &commitmentID, &payoutID, &staff, &purpose, &amount, &currency, &status, &created, &fundID, &fundName, &reference, &payoutStatus, &settled, &used); err != nil {
				writeJSON(w, 500, problem{Error: "staff advances could not be read"})
				return
			}
			if payoutStatus == "statement_confirmed" && status == "awaiting_payout" {
				status = "outstanding"
			}
			data = append(data, map[string]any{"id": id, "commitment_id": commitmentID, "payout_id": payoutID, "staff_name": staff, "purpose": purpose, "amount_minor": amount, "currency": strings.TrimSpace(currency), "status": status, "fund_id": fundID, "fund_name": fundName, "payout_reference": reference, "payout_status": payoutStatus, "settled_minor": settled, "used_minor": used, "remaining_minor": amount - settled, "created_at": created})
		}
		if err = rows.Err(); err != nil {
			writeJSON(w, 500, problem{Error: "staff advances could not be read"})
			return
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if len(parts) == 2 && parts[1] == "settlements" && r.Method == http.MethodPost {
		a.submitAdvanceSettlement(w, r, org, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "settlements" && r.Method == http.MethodGet {
		a.listAdvanceSettlements(w, r, org, parts[0])
		return
	}
	if len(parts) == 4 && parts[1] == "settlements" && parts[3] == "review" && r.Method == http.MethodPost {
		a.reviewAdvanceSettlement(w, r, org, parts[0], parts[2])
		return
	}
	if len(parts) != 0 || r.Method != http.MethodPost {
		notFound(w, r)
		return
	}
	var in struct {
		FundID    string `json:"fund_id"`
		StaffName string `json:"staff_name"`
		Purpose   string `json:"purpose"`
		Amount    int64  `json:"amount_minor"`
		Currency  string `json:"currency"`
		Note      string `json:"note"`
	}
	if decode(r, &in) != nil {
		bad(w, r, "invalid staff advance request")
		return
	}
	in.FundID = strings.TrimSpace(in.FundID)
	in.StaffName = strings.TrimSpace(in.StaffName)
	in.Purpose = strings.TrimSpace(in.Purpose)
	in.Currency = strings.ToUpper(strings.TrimSpace(in.Currency))
	in.Note = strings.TrimSpace(in.Note)
	if in.FundID == "" || len(in.StaffName) < 2 || len(in.StaffName) > 160 || len(in.Purpose) < 3 || len(in.Purpose) > 500 ||
		in.Amount <= 0 || len(in.Currency) != 3 || len(in.Note) > 500 {
		bad(w, r, "fund_id, staff_name, purpose, positive amount_minor, and three-letter currency are required")
		return
	}
	p := principalFrom(r)
	tx, key, ok := financeMutation(a, w, r, org)
	if !ok {
		return
	}
	defer tx.Rollback()
	fundCurrency, fundStatus, available, err := lockFinanceFund(r, tx, org, in.FundID)
	if errors.Is(err, sql.ErrNoRows) {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "fund balance could not be checked"})
		return
	}
	if fundStatus != "active" || strings.TrimSpace(fundCurrency) != in.Currency {
		writeJSON(w, 409, problem{Error: "advance fund must be active and use the same currency"})
		return
	}
	if in.Amount > available {
		writeJSON(w, 409, problem{Error: "advance exceeds available fund balance"})
		return
	}
	if err = ensurePeriodOpen(r.Context(), tx, org, time.Now()); err != nil {
		periodGuardFailure(w, r, err)
		return
	}
	threshold := int64(100000000)
	if configured, parseErr := strconv.ParseInt(env("TRANSFER_APPROVAL_THRESHOLD_MINOR", "100000000"), 10, 64); parseErr == nil {
		threshold = configured
	}
	required := 1
	var configuredThreshold sql.NullInt64
	err = tx.QueryRowContext(r.Context(), `SELECT approval_threshold_minor,required_approvals FROM transaction_policies WHERE organization_id=$1 AND currency=upper($2)`, org, in.Currency).Scan(&configuredThreshold, &required)
	if err != nil && err != sql.ErrNoRows {
		writeJSON(w, 500, problem{Error: "payout approval policy could not be loaded"})
		return
	}
	if configuredThreshold.Valid {
		threshold = configuredThreshold.Int64
	}
	if required < 1 || required > 3 {
		writeJSON(w, 500, problem{Error: "stored approval policy is invalid"})
		return
	}
	risk, err := evaluateRisk(r.Context(), tx, org, riskSubject{Kind: "payout", Amount: in.Amount, Currency: in.Currency})
	if err != nil {
		writeJSON(w, 500, problem{Error: "risk check failed"})
		return
	}
	if risk.Decision == "block" {
		_ = tx.Rollback()
		riskBlocked(w, r, risk)
		return
	}
	status := "prepared"
	if payoutNeedsApproval(in.Amount, threshold) || risk.Decision == "review" {
		status = "pending_approval"
	}
	advanceID, commitmentID, payoutID := "adv_"+newID(), "cmt_"+newID(), "pay_"+newID()
	reference := "AA-" + strings.ToUpper(newID()[:12])
	description := "Staff advance: " + in.Purpose
	if in.Note != "" {
		description += " — " + in.Note
	}
	_, err = tx.ExecContext(r.Context(), `INSERT INTO finance_commitments(id,organization_id,fund_id,commitment_type,title,beneficiary_name,amount_minor,currency,status,created_by) VALUES($1,$2,$3,'staff_advance',$4,$5,$6,$7,'linked',$8)`, commitmentID, org, in.FundID, "Advance: "+in.Purpose, in.StaffName, in.Amount, in.Currency, nullable(p.userID))
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO bank_payout_instructions(id,organization_id,beneficiary_name,amount_minor,currency,reference,description,created_by,required_approvals,status,finance_commitment_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, payoutID, org, in.StaffName, in.Amount, in.Currency, reference, description, nullable(p.userID), required, status, commitmentID)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `UPDATE finance_commitments SET payout_id=$3 WHERE organization_id=$1 AND id=$2`, org, commitmentID, payoutID)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO staff_advances(id,organization_id,commitment_id,payout_id,staff_name,purpose,amount_minor,currency,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, advanceID, org, commitmentID, payoutID, in.StaffName, in.Purpose, in.Amount, in.Currency, nullable(p.userID))
	}
	if err == nil {
		err = recordRiskOutcome(r.Context(), tx, org, "payout", payoutID, reference, &risk)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'staff_advance.created','staff_advance',$4,jsonb_build_object('fund_id',$5::text,'amount_minor',$6::bigint,'currency',$7::text,'payout_reference',$8::text))`, "aud_"+newID(), org, nullable(p.userID), advanceID, in.FundID, in.Amount, in.Currency, reference)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "staff advance could not be saved"})
		return
	}
	finishFinanceMutation(w, r, tx, org, key, 201, map[string]any{"id": advanceID, "commitment_id": commitmentID, "payout_id": payoutID, "payout_reference": reference, "status": "awaiting_payout", "payout_status": status})
}

func (a *App) submitAdvanceSettlement(w http.ResponseWriter, r *http.Request, org, advanceID string) {
	var in struct {
		Used     int64  `json:"used_minor"`
		Returned int64  `json:"returned_minor"`
		Note     string `json:"note"`
	}
	if decode(r, &in) != nil || in.Used < 0 || in.Returned < 0 || in.Used+in.Returned <= 0 || len(strings.TrimSpace(in.Note)) < 3 || len(in.Note) > 1000 {
		bad(w, r, "non-negative used_minor and returned_minor, a positive total, and a settlement note are required")
		return
	}
	p := principalFrom(r)
	if p.userID == "" {
		writeJSON(w, 403, problem{Error: "advance settlement requires a signed-in workspace user"})
		return
	}
	tx, key, ok := financeMutation(a, w, r, org)
	if !ok {
		return
	}
	defer tx.Rollback()
	var original int64
	var status string
	err := tx.QueryRowContext(r.Context(), `SELECT amount_minor,status FROM staff_advances WHERE organization_id=$1 AND id=$2 FOR UPDATE`, org, advanceID).Scan(&original, &status)
	if errors.Is(err, sql.ErrNoRows) {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "advance could not be loaded"})
		return
	}
	if status != "outstanding" {
		writeJSON(w, 409, problem{Error: "only a statement-confirmed outstanding advance can be settled"})
		return
	}
	var approved int64
	err = tx.QueryRowContext(r.Context(), `SELECT COALESCE(sum(used_minor+returned_minor),0) FROM advance_settlements WHERE organization_id=$1 AND advance_id=$2 AND status='approved'`, org, advanceID).Scan(&approved)
	if err != nil {
		writeJSON(w, 500, problem{Error: "prior advance settlements could not be checked"})
		return
	}
	if in.Used+in.Returned > original-approved {
		writeJSON(w, 409, problem{Error: "settlement exceeds the advance amount still outstanding"})
		return
	}
	id := "stl_" + newID()
	_, err = tx.ExecContext(r.Context(), `INSERT INTO advance_settlements(id,organization_id,advance_id,used_minor,returned_minor,note,submitted_by) VALUES($1,$2,$3,$4,$5,$6,$7)`, id, org, advanceID, in.Used, in.Returned, strings.TrimSpace(in.Note), p.userID)
	if err != nil {
		writeJSON(w, 500, problem{Error: "settlement could not be submitted"})
		return
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'staff_advance.settlement_submitted','advance_settlement',$4,jsonb_build_object('advance_id',$5::text,'used_minor',$6::bigint,'returned_minor',$7::bigint,'note',$8::text))`, "aud_"+newID(), org, nullable(p.userID), id, advanceID, in.Used, in.Returned, strings.TrimSpace(in.Note)); err != nil {
		writeJSON(w, 500, problem{Error: "settlement audit could not be recorded"})
		return
	}
	finishFinanceMutation(w, r, tx, org, key, 201, map[string]any{"id": id, "advance_id": advanceID, "status": "pending_review", "used_minor": in.Used, "returned_minor": in.Returned})
}

func (a *App) listAdvanceSettlements(w http.ResponseWriter, r *http.Request, org, advanceID string) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT id,advance_id,used_minor,returned_minor,note,status,submitted_by,reviewed_by,reviewed_at,created_at
		FROM advance_settlements WHERE organization_id=$1 AND advance_id=$2 ORDER BY created_at DESC LIMIT 100`, org, advanceID)
	if err != nil {
		writeJSON(w, 500, problem{Error: "advance settlements could not be loaded"})
		return
	}
	defer rows.Close()
	data := make([]map[string]any, 0)
	for rows.Next() {
		var id, advance, note, status, submitted string
		var reviewed sql.NullString
		var used, returned int64
		var reviewedAt sql.NullTime
		var created time.Time
		if err = rows.Scan(&id, &advance, &used, &returned, &note, &status, &submitted, &reviewed, &reviewedAt, &created); err != nil {
			writeJSON(w, 500, problem{Error: "advance settlements could not be read"})
			return
		}
		data = append(data, map[string]any{"id": id, "advance_id": advance, "used_minor": used, "returned_minor": returned, "note": note, "status": status, "submitted_by": submitted, "reviewed_by": nullString(reviewed), "reviewed_at": nullTime(reviewedAt), "created_at": created})
	}
	if err = rows.Err(); err != nil {
		writeJSON(w, 500, problem{Error: "advance settlements could not be read"})
		return
	}
	writeJSON(w, 200, map[string]any{"data": data})
}

func (a *App) reviewAdvanceSettlement(w http.ResponseWriter, r *http.Request, org, advanceID, settlementID string) {
	p := principalFrom(r)
	if !canReviewAdvanceSettlement("", p.userID, p.role) {
		writeJSON(w, 403, problem{Error: "only an owner or admin can review an advance settlement"})
		return
	}
	var in struct {
		Decision string `json:"decision"`
		Note     string `json:"note"`
	}
	if decode(r, &in) != nil {
		bad(w, r, "invalid settlement decision")
		return
	}
	in.Decision = strings.TrimSpace(in.Decision)
	in.Note = strings.TrimSpace(in.Note)
	if !containsString([]string{"approve", "reject"}, in.Decision) || len(in.Note) < 3 || len(in.Note) > 1000 {
		bad(w, r, "decision must be approve or reject and include a review note")
		return
	}
	tx, key, ok := financeMutation(a, w, r, org)
	if !ok {
		return
	}
	defer tx.Rollback()
	var status, submitter string
	var used, returned int64
	err := tx.QueryRowContext(r.Context(), `SELECT status,submitted_by,used_minor,returned_minor FROM advance_settlements WHERE organization_id=$1 AND advance_id=$2 AND id=$3 FOR UPDATE`, org, advanceID, settlementID).Scan(&status, &submitter, &used, &returned)
	if errors.Is(err, sql.ErrNoRows) {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "settlement could not be loaded"})
		return
	}
	if status != "pending_review" {
		writeJSON(w, 409, problem{Error: "settlement is not awaiting review"})
		return
	}
	if !canReviewAdvanceSettlement(submitter, p.userID, p.role) {
		writeJSON(w, 403, problem{Error: "the person who submitted a settlement cannot approve it"})
		return
	}
	nextStatus := "approved"
	action := "staff_advance.settlement_approved"
	if in.Decision == "reject" {
		nextStatus = "rejected"
		action = "staff_advance.settlement_rejected"
	} else {
		var fundID string
		err = tx.QueryRowContext(r.Context(), `SELECT c.fund_id FROM staff_advances x JOIN finance_commitments c ON c.organization_id=x.organization_id AND c.id=x.commitment_id WHERE x.organization_id=$1 AND x.id=$2`, org, advanceID).Scan(&fundID)
		if err != nil {
			writeJSON(w, 500, problem{Error: "advance fund could not be loaded"})
			return
		}
		var lockedFund string
		err = tx.QueryRowContext(r.Context(), `SELECT id FROM finance_funds WHERE organization_id=$1 AND id=$2 FOR UPDATE`, org, fundID).Scan(&lockedFund)
		if err != nil {
			writeJSON(w, 500, problem{Error: "advance fund could not be locked"})
			return
		}
	}
	_, err = tx.ExecContext(r.Context(), `UPDATE advance_settlements SET status=$4,reviewed_by=$5,reviewed_at=now() WHERE organization_id=$1 AND advance_id=$2 AND id=$3`, org, advanceID, settlementID, nextStatus, p.userID)
	if err == nil && nextStatus == "approved" {
		_, err = tx.ExecContext(r.Context(), `UPDATE finance_commitments c
			SET amount_minor=c.amount_minor-$3-$4,
				status=CASE WHEN c.amount_minor-$3-$4=0 THEN 'settled' ELSE 'linked' END,updated_at=now()
			FROM staff_advances x WHERE x.organization_id=$1 AND x.id=$2 AND c.organization_id=x.organization_id AND c.id=x.commitment_id`,
			org, advanceID, used, returned)
	}
	if err == nil && nextStatus == "approved" {
		_, err = tx.ExecContext(r.Context(), `UPDATE staff_advances x SET status=CASE WHEN x.amount_minor<=COALESCE((SELECT sum(s.used_minor+s.returned_minor) FROM advance_settlements s WHERE s.organization_id=x.organization_id AND s.advance_id=x.id AND s.status='approved'),0) THEN 'settled' ELSE 'outstanding' END,updated_at=now() WHERE x.organization_id=$1 AND x.id=$2`, org, advanceID)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,'advance_settlement',$5,jsonb_build_object('advance_id',$6::text,'decision',$7::text,'note',$8::text,'used_minor',$9::bigint,'returned_minor',$10::bigint))`, "aud_"+newID(), org, nullable(p.userID), action, settlementID, advanceID, nextStatus, in.Note, used, returned)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "settlement review could not be recorded"})
		return
	}
	finishFinanceMutation(w, r, tx, org, key, 200, map[string]any{"id": settlementID, "advance_id": advanceID, "status": nextStatus})
}

func (a *App) financeEvidence(w http.ResponseWriter, r *http.Request, org string, parts []string) {
	if len(parts) == 0 && r.Method == http.MethodGet {
		resourceType, resourceID := r.URL.Query().Get("resource_type"), r.URL.Query().Get("resource_id")
		if !containsString([]string{"commitment", "advance", "settlement"}, resourceType) || resourceID == "" {
			bad(w, r, "resource_type and resource_id are required")
			return
		}
		rows, err := a.db.QueryContext(r.Context(), `SELECT id,file_name,content_type,file_size,sha256,note,uploaded_by,created_at FROM finance_evidence WHERE organization_id=$1 AND resource_type=$2 AND resource_id=$3 ORDER BY created_at DESC LIMIT 100`, org, resourceType, resourceID)
		if err != nil {
			writeJSON(w, 500, problem{Error: "evidence list could not be loaded"})
			return
		}
		defer rows.Close()
		data := make([]map[string]any, 0)
		for rows.Next() {
			var id, name, contentType, hash, note string
			var size int64
			var uploader sql.NullString
			var created time.Time
			if err = rows.Scan(&id, &name, &contentType, &size, &hash, &note, &uploader, &created); err != nil {
				writeJSON(w, 500, problem{Error: "evidence list could not be read"})
				return
			}
			data = append(data, map[string]any{"id": id, "file_name": name, "content_type": contentType, "file_size": size, "sha256": hash, "note": note, "uploaded_by": nullString(uploader), "created_at": created})
		}
		if err = rows.Err(); err != nil {
			writeJSON(w, 500, problem{Error: "evidence list could not be read"})
			return
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		a.downloadFinanceEvidence(w, r, org, parts[0])
		return
	}
	if len(parts) != 0 || r.Method != http.MethodPost {
		notFound(w, r)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxFinanceEvidenceBytes+(64<<10))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		bad(w, r, "evidence upload must be a multipart file no larger than 4 MiB")
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()
	resourceType, resourceID := strings.TrimSpace(r.FormValue("resource_type")), strings.TrimSpace(r.FormValue("resource_id"))
	note := strings.TrimSpace(r.FormValue("note"))
	if !containsString([]string{"commitment", "advance", "settlement"}, resourceType) || resourceID == "" || len(note) > 500 {
		bad(w, r, "valid resource_type, resource_id, and note up to 500 characters are required")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		bad(w, r, "an evidence file is required")
		return
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxFinanceEvidenceBytes+1))
	if err != nil || len(content) == 0 || len(content) > maxFinanceEvidenceBytes {
		bad(w, r, "evidence file must be between 1 byte and 4 MiB")
		return
	}
	contentType := http.DetectContentType(content)
	if !containsString([]string{"application/pdf", "image/png", "image/jpeg", "text/plain", "text/csv", "application/zip"}, contentType) {
		bad(w, r, "only PDF, PNG, JPEG, text, CSV, and ZIP evidence is accepted")
		return
	}
	name := filepath.Base(strings.ReplaceAll(header.Filename, "\\", "/"))
	if name == "." || name == "" || len(name) > 180 {
		bad(w, r, "evidence filename is invalid")
		return
	}
	sum := sha256.Sum256(content)
	hash := hex.EncodeToString(sum[:])
	exists, err := financeResourceExists(r, a.db, org, resourceType, resourceID)
	if err != nil {
		writeJSON(w, 500, problem{Error: "evidence resource could not be checked"})
		return
	}
	if !exists {
		notFound(w, r)
		return
	}
	id := "evd_" + newID()
	p := principalFrom(r)
	_, err = a.db.ExecContext(r.Context(), `INSERT INTO finance_evidence(id,organization_id,resource_type,resource_id,file_name,content_type,file_size,sha256,content,note,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(organization_id,resource_type,resource_id,sha256) DO NOTHING`, id, org, resourceType, resourceID, name, contentType, len(content), hash, content, note, nullable(p.userID))
	if err != nil {
		writeJSON(w, 500, problem{Error: "evidence could not be saved"})
		return
	}
	var savedID string
	err = a.db.QueryRowContext(r.Context(), `SELECT id FROM finance_evidence WHERE organization_id=$1 AND resource_type=$2 AND resource_id=$3 AND sha256=$4`, org, resourceType, resourceID, hash).Scan(&savedID)
	if err != nil {
		writeJSON(w, 500, problem{Error: "saved evidence could not be loaded"})
		return
	}
	a.audit(r, org, "finance_evidence.uploaded", resourceType, resourceID, map[string]any{"evidence_id": savedID, "sha256": hash, "file_name": name})
	writeJSON(w, 201, map[string]any{"id": savedID, "resource_type": resourceType, "resource_id": resourceID, "file_name": name, "content_type": contentType, "file_size": len(content), "sha256": hash})
}

func (a *App) downloadFinanceEvidence(w http.ResponseWriter, r *http.Request, org, id string) {
	var name, contentType string
	var content []byte
	err := a.db.QueryRowContext(r.Context(), `SELECT file_name,content_type,content FROM finance_evidence WHERE organization_id=$1 AND id=$2`, org, id).Scan(&name, &contentType, &content)
	if errors.Is(err, sql.ErrNoRows) {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "evidence file could not be loaded"})
		return
	}
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": name})
	if disposition == "" {
		writeJSON(w, 500, problem{Error: "evidence filename is invalid"})
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", disposition)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

func (a *App) financeQueue(w http.ResponseWriter, r *http.Request, org string) {
	items := make([]map[string]any, 0)
	rows, err := a.db.QueryContext(r.Context(), `SELECT p.id,p.reference,p.amount_minor,p.currency,p.status,p.created_at,
		(SELECT count(*) FROM bank_payout_approvals v WHERE v.organization_id=p.organization_id AND v.payout_id=p.id AND v.decision='approved'),
		p.required_approvals
		FROM bank_payout_instructions p WHERE p.organization_id=$1 AND p.status='pending_approval' ORDER BY p.created_at LIMIT 100`, org)
	if err != nil {
		writeJSON(w, 500, problem{Error: "approval queue could not be loaded"})
		return
	}
	for rows.Next() {
		var id, reference, currency, status string
		var amount int64
		var created time.Time
		var received, required int
		if err = rows.Scan(&id, &reference, &amount, &currency, &status, &created, &received, &required); err != nil {
			rows.Close()
			writeJSON(w, 500, problem{Error: "approval queue could not be read"})
			return
		}
		items = append(items, map[string]any{"id": id, "type": "payout_approval", "reference": reference, "amount_minor": amount, "currency": strings.TrimSpace(currency), "status": status, "created_at": created, "reason": fmt.Sprintf("Waiting for %d of %d required approvals", received, required), "priority": queuePriority(created, "payout_approval")})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		writeJSON(w, 500, problem{Error: "approval queue could not be read"})
		return
	}
	rows, err = a.db.QueryContext(r.Context(), `SELECT s.id,x.id,x.staff_name,s.used_minor,s.returned_minor,x.currency,s.created_at
		FROM advance_settlements s JOIN staff_advances x ON x.organization_id=s.organization_id AND x.id=s.advance_id
		WHERE s.organization_id=$1 AND s.status='pending_review' ORDER BY s.created_at LIMIT 100`, org)
	if err != nil {
		writeJSON(w, 500, problem{Error: "settlement review queue could not be loaded"})
		return
	}
	for rows.Next() {
		var settlementID, advanceID, staff, currency string
		var used, returned int64
		var created time.Time
		if err = rows.Scan(&settlementID, &advanceID, &staff, &used, &returned, &currency, &created); err != nil {
			rows.Close()
			writeJSON(w, 500, problem{Error: "settlement review queue could not be read"})
			return
		}
		items = append(items, map[string]any{"id": settlementID, "advance_id": advanceID, "type": "advance_settlement", "reference": staff, "amount_minor": used + returned, "currency": strings.TrimSpace(currency), "status": "pending_review", "created_at": created, "reason": "Staff advance settlement needs an independent review", "priority": queuePriority(created, "advance_settlement")})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		writeJSON(w, 500, problem{Error: "settlement review queue could not be read"})
		return
	}
	var exceptions int
	err = a.db.QueryRowContext(r.Context(), `SELECT count(*) FROM reconciliation_lines l JOIN reconciliation_imports i ON i.id=l.import_id WHERE i.organization_id=$1 AND l.match_status IN ('unmatched','exception')`, org).Scan(&exceptions)
	if err != nil {
		writeJSON(w, 500, problem{Error: "reconciliation queue could not be loaded"})
		return
	}
	if exceptions > 0 {
		items = append(items, map[string]any{"id": "reconciliation-exceptions", "type": "reconciliation_exceptions", "reference": "Statement exceptions", "amount_minor": 0, "currency": "", "status": "needs_review", "reason": fmt.Sprintf("%d statement lines are unmatched or flagged", exceptions), "priority": 2})
	}
	sort.SliceStable(items, func(i, j int) bool {
		pi, _ := items[i]["priority"].(int)
		pj, _ := items[j]["priority"].(int)
		if pi != pj {
			return pi < pj
		}
		ti, _ := items[i]["created_at"].(time.Time)
		tj, _ := items[j]["created_at"].(time.Time)
		return ti.Before(tj)
	})
	if len(items) > 200 {
		items = items[:200]
	}
	writeJSON(w, 200, map[string]any{"data": items})
}

func queuePriority(created time.Time, kind string) int {
	priority := 3
	if kind == "advance_settlement" {
		priority = 2
	}
	if time.Since(created) > 48*time.Hour {
		priority--
	}
	if priority < 1 {
		return 1
	}
	return priority
}

func lockFinanceFund(r *http.Request, tx *sql.Tx, org, fundID string) (currency, status string, available int64, err error) {
	var allocated int64
	err = tx.QueryRowContext(r.Context(), `SELECT currency,status,allocated_minor FROM finance_funds WHERE organization_id=$1 AND id=$2 FOR UPDATE`, org, fundID).Scan(&currency, &status, &allocated)
	if err != nil {
		return "", "", 0, err
	}
	var committed, spent int64
	err = tx.QueryRowContext(r.Context(), `SELECT
		COALESCE(sum(amount_minor) FILTER (WHERE status IN ('planned','linked')),0),
		COALESCE(sum(CASE WHEN commitment_type='staff_advance' THEN 0 ELSE amount_minor END) FILTER (WHERE status='settled'),0)
		FROM finance_commitments WHERE organization_id=$1 AND fund_id=$2`, org, fundID).Scan(&committed, &spent)
	if err != nil {
		return "", "", 0, err
	}
	var advanceSpend int64
	err = tx.QueryRowContext(r.Context(), `SELECT COALESCE(sum(s.used_minor),0)
		FROM advance_settlements s JOIN staff_advances x ON x.organization_id=s.organization_id AND x.id=s.advance_id
		JOIN finance_commitments c ON c.organization_id=x.organization_id AND c.id=x.commitment_id
		WHERE c.organization_id=$1 AND c.fund_id=$2 AND s.status='approved'`, org, fundID).Scan(&advanceSpend)
	if err != nil {
		return "", "", 0, err
	}
	return strings.TrimSpace(currency), status, availableFinanceBudget(allocated, committed, spent, advanceSpend), nil
}

func availableFinanceBudget(allocated, committed, spent, advanceSpend int64) int64 {
	return allocated - committed - spent - advanceSpend
}

func canReviewAdvanceSettlement(submitterID, reviewerID, role string) bool {
	return reviewerID != "" && reviewerID != submitterID && (role == "owner" || role == "admin")
}

func financeResourceExists(r *http.Request, db *sql.DB, org, kind, id string) (bool, error) {
	table, ok := map[string]string{"commitment": "finance_commitments", "advance": "staff_advances", "settlement": "advance_settlements"}[kind]
	if !ok {
		return false, errors.New("invalid evidence resource type")
	}
	var exists bool
	err := db.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM `+table+` WHERE organization_id=$1 AND id=$2)`, org, id).Scan(&exists)
	return exists, err
}

func parseOptionalDate(raw string) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	value, err := time.Parse("2006-01-02", raw)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func nullDate(value sql.NullTime) any {
	if !value.Valid {
		return nil
	}
	return value.Time.Format("2006-01-02")
}

func nullTime(value sql.NullTime) any {
	if !value.Valid {
		return nil
	}
	return value.Time
}

func nullString(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
