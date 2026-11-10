package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// exportAccount returns the signed-in user's personal data as a JSON download.
func (a *App) exportAccount(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r)
	if p.userID == "" {
		writeJSON(w, 403, problem{Error: "a user session is required", RequestID: requestID(r)})
		return
	}
	out := map[string]any{"exported_at": time.Now().UTC()}
	sections := []struct {
		name, query string
	}{
		{"profile", `SELECT row_to_json(t) FROM (SELECT id,email,full_name,status,created_at,email_verified_at,terms_accepted_at FROM users WHERE id=$1) t`},
		{"memberships", `SELECT row_to_json(t) FROM (SELECT m.organization_id,o.name AS organization_name,m.role,m.status,m.joined_at FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1) t`},
		{"sessions", `SELECT row_to_json(t) FROM (SELECT user_agent,ip_address,created_at,expires_at,last_seen_at,revoked_at FROM user_sessions WHERE user_id=$1) t`},
		{"authenticator_mfa", `SELECT row_to_json(t) FROM (SELECT enabled,enabled_at,created_at FROM user_mfa_factors WHERE user_id=$1) t`},
		{"audit_events_you_performed", `SELECT row_to_json(t) FROM (SELECT organization_id,action,resource_type,resource_id,metadata,created_at FROM audit_logs WHERE actor_id=$1 ORDER BY seq DESC LIMIT 5000) t`},
	}
	for _, section := range sections {
		rows, err := a.db.QueryContext(r.Context(), section.query, p.userID)
		if err != nil {
			writeJSON(w, 500, problem{Error: "account data could not be exported", RequestID: requestID(r)})
			return
		}
		items := []json.RawMessage{}
		for rows.Next() {
			var raw []byte
			if rows.Scan(&raw) == nil {
				items = append(items, append(json.RawMessage{}, raw...))
			}
		}
		_ = rows.Close()
		out[section.name] = items
	}
	w.Header().Set("Content-Disposition", `attachment; filename="aegispay-account-export.json"`)
	writeJSON(w, 200, out)
}

// workspaceExportTables holds business records; tables with secrets (keys,
// webhook and chat credentials) are deliberately left out.
var workspaceExportTables = []string{
	"customers", "accounts", "collections", "transfers", "refunds", "journal_entries", "journal_lines",
	"bank_payment_requests", "bank_payout_instructions", "reconciliation_imports", "reconciliation_lines",
	"finance_funds", "finance_commitments", "staff_advances", "advance_settlements",
	"close_periods", "transaction_policies", "risk_rules", "risk_assessments", "fraud_cases", "fraud_case_notes", "audit_logs",
}

// exportWorkspace streams a workspace's business records as a JSON download.
func (a *App) exportWorkspace(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r)
	if !isWorkspaceAdmin(p) {
		writeJSON(w, 403, problem{Error: "only an owner or admin can export a workspace", RequestID: requestID(r)})
		return
	}
	org := currentOrgID(r, a.orgID)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="aegispay-workspace-export.json"`)
	_, _ = w.Write([]byte(`{"organization_id":` + string(mustJSON(org)) + `,"exported_at":` + string(mustJSON(time.Now().UTC()))))
	for _, table := range workspaceExportTables {
		_, _ = w.Write([]byte(`,"` + table + `":[`))
		rows, err := a.db.QueryContext(r.Context(), `SELECT row_to_json(t) FROM `+table+` t WHERE t.organization_id=$1`, org)
		if err == nil {
			first := true
			for rows.Next() {
				var raw []byte
				if rows.Scan(&raw) != nil {
					continue
				}
				if !first {
					_, _ = w.Write([]byte(","))
				}
				first = false
				_, _ = w.Write(raw)
			}
			_ = rows.Close()
		}
		_, _ = w.Write([]byte("]"))
	}
	_, _ = w.Write([]byte("}\n"))
	a.audit(r, org, "workspace.exported", "organization", org, map[string]any{})
}

// deleteAccount removes a user's personal data. Financial and audit records
// stay because businesses must keep them, but they only reference the user's
// now-anonymous ID. Workspaces the user alone owns are closed.
func (a *App) deleteAccount(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r)
	if p.userID == "" || p.sessionID == "" {
		writeJSON(w, 403, problem{Error: "deleting an account requires a user session", RequestID: requestID(r)})
		return
	}
	var in struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if decode(r, &in) != nil || in.Password == "" {
		bad(w, r, "your password is required")
		return
	}
	if !a.limitAttempt(w, r, "account-delete:"+p.userID, 10, 15*time.Minute) {
		return
	}
	var hash, address, name string
	if err := a.db.QueryRowContext(r.Context(), `SELECT password_hash,email,full_name FROM users WHERE id=$1 AND status='active'`, p.userID).Scan(&hash, &address, &name); err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil {
		writeJSON(w, 401, problem{Error: "that password is not correct", RequestID: requestID(r)})
		return
	}
	var cipher []byte
	var mfaEnabled bool
	err := a.db.QueryRowContext(r.Context(), `SELECT secret_ciphertext,enabled FROM user_mfa_factors WHERE user_id=$1`, p.userID).Scan(&cipher, &mfaEnabled)
	if err != nil && err != sql.ErrNoRows {
		writeJSON(w, 500, problem{Error: "account could not be checked", RequestID: requestID(r)})
		return
	}
	if mfaEnabled {
		secret, openErr := openSecret(purposeMFASecret, cipher)
		if openErr != nil || !validTOTPFormat(in.Code) || !verifyTOTP(secret, in.Code, time.Now()) {
			writeJSON(w, 401, problem{Error: "a current authenticator code is required", RequestID: requestID(r)})
			return
		}
	}
	tx, err := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	// A workspace others still use must not lose its only owner.
	rows, err := tx.QueryContext(r.Context(), `SELECT o.id,o.name,
		(SELECT count(*) FROM memberships x WHERE x.organization_id=o.id AND x.status='active' AND x.user_id<>$1),
		(SELECT count(*) FROM memberships x WHERE x.organization_id=o.id AND x.status='active' AND x.role='owner' AND x.user_id<>$1)
		FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.status='active' AND m.role='owner'`, p.userID)
	if err != nil {
		writeJSON(w, 500, problem{Error: "workspaces could not be checked", RequestID: requestID(r)})
		return
	}
	closing, blocked := []string{}, []string{}
	for rows.Next() {
		var id, workspace string
		var others, otherOwners int
		if rows.Scan(&id, &workspace, &others, &otherOwners) != nil {
			continue
		}
		if otherOwners == 0 && others > 0 {
			blocked = append(blocked, workspace)
		} else if otherOwners == 0 {
			closing = append(closing, id)
		}
	}
	_ = rows.Close()
	if len(blocked) > 0 {
		writeJSON(w, 409, problem{Error: "you are the only owner of " + strings.Join(blocked, ", ") + ". Remove its other members on the Team page first, so nobody loses access unexpectedly", RequestID: requestID(r)})
		return
	}
	statements := []struct {
		query string
		args  []any
	}{
		{`UPDATE organizations SET status='closed' WHERE id=ANY($1)`, []any{closing}},
		{`UPDATE memberships SET status='suspended' WHERE user_id=$1`, []any{p.userID}},
		{`UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, []any{p.userID}},
		{`DELETE FROM user_mfa_factors WHERE user_id=$1`, []any{p.userID}},
		{`DELETE FROM mfa_login_challenges WHERE user_id=$1`, []any{p.userID}},
		{`DELETE FROM password_reset_tokens WHERE user_id=$1`, []any{p.userID}},
		{`DELETE FROM email_verification_tokens WHERE user_id=$1`, []any{p.userID}},
		{`UPDATE user_sessions SET user_agent='',ip_address='' WHERE user_id=$1`, []any{p.userID}},
		{`UPDATE users SET email='deleted-'||id||'@deleted.invalid',full_name='Deleted user',password_hash='!',status='deleted',deleted_at=now() WHERE id=$1`, []any{p.userID}},
	}
	for _, statement := range statements {
		if _, err = tx.ExecContext(r.Context(), statement.query, statement.args...); err != nil {
			writeJSON(w, 500, problem{Error: "account could not be deleted", RequestID: requestID(r)})
			return
		}
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "account deletion conflict; try again", RequestID: requestID(r)})
		return
	}
	a.sendEmailAsync(email{
		To: address, ToName: name,
		Subject:    "Your AegisPay account was deleted",
		Heading:    "Your account was deleted",
		Paragraphs: []string{"Your personal details were removed and every device was signed out. Financial and audit records that businesses must keep remain, without your name or email."},
	})
	writeJSON(w, 200, map[string]any{"status": "deleted", "workspaces_closed": len(closing)})
}
