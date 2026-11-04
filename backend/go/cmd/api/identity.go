package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type principal struct {
	orgID     string
	userID    string
	role      string
	scopes    []string
	bootstrap bool
	sessionID string
}
type principalContextKey struct{}

func principalFrom(r *http.Request) principal {
	p, _ := r.Context().Value(principalContextKey{}).(principal)
	return p
}
func currentOrgID(r *http.Request, fallback string) string {
	p := principalFrom(r)
	if p.orgID != "" {
		return p.orgID
	}
	return fallback
}
func tokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func (a *App) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "Bearer "
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, prefix) {
			writeJSON(w, 401, problem{Error: "unauthorized", RequestID: requestID(r)})
			return
		}
		token := strings.TrimSpace(strings.TrimPrefix(header, prefix))
		if token == "" {
			writeJSON(w, 401, problem{Error: "unauthorized", RequestID: requestID(r)})
			return
		}
		p := principal{}
		if subtle.ConstantTimeCompare([]byte(token), []byte(a.apiKey)) == 1 {
			p = principal{orgID: a.orgID, role: "owner", scopes: []string{"*"}, bootstrap: true}
		} else if strings.HasPrefix(token, "aegis_test_") || strings.HasPrefix(token, "aegis_live_") {
			var ok bool
			p, ok = a.apiKeyPrincipal(r, token)
			if !ok {
				writeJSON(w, 401, problem{Error: "unauthorized", RequestID: requestID(r)})
				return
			}
		} else {
			var ok bool
			p, ok = a.sessionPrincipal(r, token)
			if !ok {
				writeJSON(w, 401, problem{Error: "unauthorized", RequestID: requestID(r)})
				return
			}
		}
		r = r.WithContext(context.WithValue(r.Context(), principalContextKey{}, p))
		if !p.bootstrap && !roleAllows(p, r) {
			writeJSON(w, 403, problem{Error: "forbidden", RequestID: requestID(r)})
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (a *App) apiKeyPrincipal(r *http.Request, token string) (principal, bool) {
	if len(token) < 23 {
		return principal{}, false
	}
	prefix := token[:23]
	var id, org, secret, environment string
	var scopesJSON []byte
	var expires sql.NullTime
	err := a.db.QueryRowContext(r.Context(), `SELECT id,organization_id,secret_hash,environment,scopes,expires_at FROM api_keys WHERE key_prefix=$1 AND revoked_at IS NULL`, prefix).Scan(&id, &org, &secret, &environment, &scopesJSON, &expires)
	if err != nil || environment != "sandbox" || expires.Valid && time.Now().After(expires.Time) {
		return principal{}, false
	}
	got := tokenHash(token)
	if subtle.ConstantTimeCompare([]byte(got), []byte(secret)) != 1 {
		return principal{}, false
	}
	var scopes []string
	if json.Unmarshal(scopesJSON, &scopes) != nil {
		return principal{}, false
	}
	_, _ = a.db.ExecContext(r.Context(), `UPDATE api_keys SET last_used_at=now() WHERE id=$1`, id)
	return principal{orgID: org, scopes: scopes, role: "api_key"}, true
}
func (a *App) sessionPrincipal(r *http.Request, token string) (principal, bool) {
	var userID string
	var sessionID string
	err := a.db.QueryRowContext(r.Context(), `SELECT id,user_id FROM user_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`, tokenHash(token)).Scan(&sessionID, &userID)
	if err != nil {
		return principal{}, false
	}
	requested := strings.TrimSpace(r.Header.Get("X-Organization-ID"))
	var org, role string
	if requested != "" {
		err = a.db.QueryRowContext(r.Context(), `SELECT organization_id,role FROM memberships WHERE user_id=$1 AND organization_id=$2 AND status='active'`, userID, requested).Scan(&org, &role)
	} else {
		err = a.db.QueryRowContext(r.Context(), `SELECT organization_id,role FROM memberships WHERE user_id=$1 AND status='active' ORDER BY joined_at LIMIT 1`, userID).Scan(&org, &role)
	}
	if err != nil && requested != "" && strings.HasPrefix(r.URL.Path, "/v1/invitations/") && strings.HasSuffix(r.URL.Path, "/accept") {
		err = a.db.QueryRowContext(r.Context(), `SELECT i.organization_id,'invitee' FROM organization_invitations i JOIN users u ON lower(u.email)=lower(i.email) WHERE u.id=$1 AND i.organization_id=$2 AND i.accepted_at IS NULL AND i.expires_at>now() ORDER BY i.created_at DESC LIMIT 1`, userID, requested).Scan(&org, &role)
	}
	if err != nil {
		return principal{}, false
	}
	return principal{orgID: org, userID: userID, role: role, sessionID: sessionID}, true
}
func roleAllows(p principal, r *http.Request) bool {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/"), "/")
	parts := strings.Split(path, "/")
	scope := ""
	switch parts[0] {
	case "auth":
		if len(parts) == 2 && parts[1] == "logout" {
			return p.sessionID != ""
		}
		if len(parts) == 2 && parts[1] == "me" {
			return true
		}
		if len(parts) >= 3 && parts[1] == "mfa" {
			return p.sessionID != ""
		}
		if len(parts) == 2 && parts[1] == "organizations" {
			return p.sessionID != ""
		}
	case "organizations":
		// Any signed-in user may create a workspace of their own.
		if len(parts) == 1 && r.Method == http.MethodPost && p.sessionID != "" {
			return true
		}
		scope = "organization.read"
	case "members":
		if r.Method == http.MethodGet {
			scope = "members.read"
		} else {
			scope = "members.manage"
		}
	case "invitations":
		if len(parts) == 3 && parts[2] == "accept" && p.sessionID != "" {
			return true
		}
		scope = "members.manage"
	case "transaction-policies":
		if r.Method == http.MethodGet {
			scope = "transaction_policies.read"
		} else {
			scope = "transaction_policies.manage"
		}
	case "bank-operations":
		if len(parts) == 4 && parts[1] == "periods" && (parts[3] == "close" || parts[3] == "reopen") {
			scope = "bank_workflows.close"
		} else if r.Method == http.MethodGet {
			scope = "bank_workflows.read"
		} else {
			scope = "bank_workflows.manage"
		}
	case "api-keys":
		if r.Method == http.MethodGet {
			scope = "api_keys.read"
		} else if len(parts) > 2 && parts[len(parts)-1] == "revoke" {
			scope = "api_keys.revoke"
		} else if len(parts) > 2 && parts[len(parts)-1] == "rotate" {
			scope = "api_keys.revoke"
		} else {
			scope = "api_keys.create"
		}
	case "customers":
		if r.Method == http.MethodGet {
			scope = "customers.read"
		} else {
			scope = "customers.create"
		}
	case "accounts":
		if len(parts) > 2 && parts[2] == "sandbox-credit" {
			scope = "accounts.sandbox_credit"
		} else if r.Method == http.MethodGet {
			scope = "accounts.read"
		} else {
			scope = "accounts.create"
		}
	case "collections":
		if r.Method == http.MethodGet {
			scope = "collections.read"
		} else if len(parts) > 2 && parts[2] == "cancel" {
			scope = "collections.cancel"
		} else if len(parts) > 2 && parts[2] == "sandbox-confirm" {
			scope = "collections.confirm"
		} else if len(parts) > 2 && parts[2] == "refunds" {
			scope = "collections.refund"
		} else {
			scope = "collections.create"
		}
	case "transfers":
		if len(parts) > 2 && (parts[2] == "approve" || parts[2] == "reject") {
			scope = "transfers.approve"
		} else if r.Method == http.MethodGet {
			scope = "transfers.read"
		} else {
			scope = "transfers.create"
		}
	case "ledger":
		scope = "ledger.read"
	case "fraud":
		if len(parts) > 1 && parts[1] == "analyze" {
			scope = "fraud.analyze"
		} else if len(parts) > 3 && parts[1] == "cases" {
			scope = "fraud.investigate"
		} else {
			scope = "fraud.read"
		}
	case "reconciliation":
		scope = "reconciliation.manage"
	case "webhook-endpoints":
		if r.Method == http.MethodGet {
			scope = "webhooks.read"
		} else if len(parts) > 2 && parts[2] == "disable" {
			scope = "webhooks.manage"
		} else if r.Method == http.MethodPost {
			scope = "webhooks.manage"
		} else {
			scope = "webhooks.read"
		}
	case "webhook-deliveries":
		if r.Method == http.MethodGet {
			scope = "webhooks.read"
		} else {
			scope = "webhooks.manage"
		}
	case "audit-logs":
		scope = "audit.read"
	case "reports":
		scope = "reports.read"
	}
	if scope == "" {
		return false
	}
	if p.role == "api_key" {
		for _, s := range p.scopes {
			if s == "*" || s == scope {
				return true
			}
		}
		return false
	}
	switch p.role {
	case "owner", "admin":
		return true
	case "finance_operator":
		return scope == "transaction_policies.read" || strings.HasSuffix(scope, ".read") || scope == "bank_workflows.manage" || scope == "collections.create" || scope == "collections.cancel" || scope == "collections.confirm" || scope == "transfers.create" || scope == "transfers.approve" || scope == "accounts.read" || scope == "accounts.create" || scope == "customers.read" || scope == "customers.create" || scope == "reports.read" || scope == "reconciliation.manage"
	case "fraud_analyst":
		return scope == "fraud.read" || scope == "fraud.analyze" || scope == "fraud.investigate" || scope == "collections.read" || scope == "transfers.read" || scope == "ledger.read" || scope == "reports.read"
	case "developer":
		return scope == "api_keys.read" || scope == "api_keys.create" || scope == "api_keys.revoke" || scope == "webhooks.read" || scope == "webhooks.manage" || scope == "organization.read"
	case "auditor":
		return strings.HasSuffix(scope, ".read") || scope == "organization.read"
	}
	return false
}
func (a *App) register(w http.ResponseWriter, r *http.Request) {
	var in struct {
		OrganizationName string `json:"organization_name"`
		WorkspaceType    string `json:"workspace_type"`
		Email            string `json:"email"`
		Password         string `json:"password"`
		FullName         string `json:"full_name"`
		CountryCode      string `json:"country_code"`
	}
	if decode(r, &in) != nil || strings.TrimSpace(in.FullName) == "" || !strings.Contains(in.Email, "@") || len(in.Password) < 12 || len(in.Password) > 72 {
		bad(w, r, "full_name, valid email, and password (12-72 bytes) are required")
		return
	}
	in.WorkspaceType = strings.TrimSpace(in.WorkspaceType)
	if in.WorkspaceType == "" {
		in.WorkspaceType = "business"
	}
	if in.WorkspaceType != "personal" && in.WorkspaceType != "business" {
		bad(w, r, "workspace_type must be personal or business")
		return
	}
	in.OrganizationName = strings.TrimSpace(in.OrganizationName)
	if in.WorkspaceType == "business" && in.OrganizationName == "" {
		bad(w, r, "organization_name is required for a business workspace")
		return
	}
	if in.WorkspaceType == "personal" {
		in.OrganizationName = strings.TrimSpace(in.FullName) + "'s personal workspace"
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	in.CountryCode = strings.ToUpper(strings.TrimSpace(in.CountryCode))
	if len(in.CountryCode) != 2 || !asciiCurrency(in.CountryCode) {
		bad(w, r, "country_code must be a two-letter ISO 3166 code, for example US, GB, DE, KE or IN")
		return
	}
	pw, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, 500, problem{Error: "password hashing failed"})
		return
	}
	orgID := "org_" + newID()
	userID := "usr_" + newID()
	slug := makeSlug(in.OrganizationName) + "-" + newID()[:8]
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO organizations(id,name,slug,country_code,workspace_type) VALUES($1,$2,$3,upper($4),$5)`, orgID, in.OrganizationName, slug, in.CountryCode, in.WorkspaceType); err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO users(id,email,password_hash,full_name) VALUES($1,$2,$3,$4)`, userID, in.Email, string(pw), in.FullName)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')`, "mem_"+newID(), orgID, userID)
	}
	token := "aegis_session_" + newID()
	expires := time.Now().Add(12 * time.Hour)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)`, "ses_"+newID(), userID, tokenHash(token), expires)
	}
	if err != nil {
		writeJSON(w, 409, problem{Error: "account could not be registered; email may already be in use", RequestID: requestID(r)})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "registration conflict", RequestID: requestID(r)})
		return
	}
	writeJSON(w, 201, map[string]any{"user_id": userID, "organization_id": orgID, "organization_name": in.OrganizationName, "workspace_type": in.WorkspaceType, "role": "owner", "access_token": token, "token_type": "Bearer", "expires_at": expires})
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email          string `json:"email"`
		Password       string `json:"password"`
		OrganizationID string `json:"organization_id"`
	}
	if decode(r, &in) != nil || in.Email == "" || in.Password == "" {
		bad(w, r, "email and password are required")
		return
	}
	// Per-account limit: unlike the per-IP limit, this cannot be avoided by
	// spreading guesses across addresses.
	if !a.limitAttempt(w, r, "login:"+tokenHash(strings.ToLower(strings.TrimSpace(in.Email))), 10, 15*time.Minute) {
		return
	}
	var userID, hash, name string
	err := a.db.QueryRowContext(r.Context(), `SELECT id,password_hash,full_name FROM users WHERE email=$1 AND status='active'`, strings.ToLower(strings.TrimSpace(in.Email))).Scan(&userID, &hash, &name)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil {
		writeJSON(w, 401, problem{Error: "invalid credentials", RequestID: requestID(r)})
		return
	}
	var org, role string
	if in.OrganizationID != "" {
		err = a.db.QueryRowContext(r.Context(), `SELECT organization_id,role FROM memberships WHERE user_id=$1 AND organization_id=$2 AND status='active'`, userID, in.OrganizationID).Scan(&org, &role)
	} else {
		err = a.db.QueryRowContext(r.Context(), `SELECT organization_id,role FROM memberships WHERE user_id=$1 AND status='active' ORDER BY joined_at LIMIT 1`, userID).Scan(&org, &role)
	}
	if err != nil && in.OrganizationID != "" {
		err = a.db.QueryRowContext(r.Context(), `SELECT organization_id,'invitee' FROM organization_invitations WHERE lower(email)=lower($1) AND organization_id=$2 AND accepted_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`, strings.ToLower(strings.TrimSpace(in.Email)), in.OrganizationID).Scan(&org, &role)
	}
	if err != nil {
		writeJSON(w, 403, problem{Error: "no active organization membership or pending invitation", RequestID: requestID(r)})
		return
	}
	var enabled bool
	err = a.db.QueryRowContext(r.Context(), `SELECT enabled FROM user_mfa_factors WHERE user_id=$1`, userID).Scan(&enabled)
	if err != nil && err != sql.ErrNoRows {
		writeJSON(w, 500, problem{Error: "MFA status unavailable"})
		return
	}
	if enabled {
		challenge := "aegis_mfa_" + newID()
		expires := time.Now().UTC().Add(5 * time.Minute)
		_, err = a.db.ExecContext(r.Context(), `DELETE FROM mfa_login_challenges WHERE user_id=$1 AND expires_at<=now()`, userID)
		if err == nil {
			_, err = a.db.ExecContext(r.Context(), `INSERT INTO mfa_login_challenges(token_hash,user_id,organization_id,expires_at) VALUES($1,$2,$3,$4)`, tokenHash(challenge), userID, org, expires)
		}
		if err != nil {
			writeJSON(w, 500, problem{Error: "MFA challenge could not be created"})
			return
		}
		writeJSON(w, 200, map[string]any{"mfa_required": true, "mfa_token": challenge, "organization_id": org, "expires_at": expires, "method": "totp"})
		return
	}
	a.issueSession(w, r, userID, name, org, role)
}

func (a *App) issueSession(w http.ResponseWriter, r *http.Request, userID, name, org, role string) {
	token := "aegis_session_" + newID()
	expires := time.Now().UTC().Add(12 * time.Hour)
	_, err := a.db.ExecContext(r.Context(), `INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)`, "ses_"+newID(), userID, tokenHash(token), expires)
	if err != nil {
		writeJSON(w, 500, problem{Error: "session creation failed"})
		return
	}
	writeJSON(w, 200, map[string]any{"user_id": userID, "full_name": name, "organization_id": org, "role": role, "access_token": token, "token_type": "Bearer", "expires_at": expires})
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r)
	if p.sessionID == "" {
		writeJSON(w, 400, problem{Error: "this credential is not a user session"})
		return
	}
	_, err := a.db.ExecContext(r.Context(), `UPDATE user_sessions SET revoked_at=now() WHERE id=$1`, p.sessionID)
	if err != nil {
		writeJSON(w, 500, problem{Error: "session revocation failed"})
		return
	}
	writeJSON(w, 200, map[string]string{"status": "revoked"})
}
func makeSlug(s string) string {
	re := regexp.MustCompile(`[^a-z0-9]+`)
	s = re.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-")
	return strings.Trim(s, "-")
}
func (a *App) apiKeys(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) == 1 && r.Method == http.MethodPost {
		var in struct {
			Name        string     `json:"name"`
			Environment string     `json:"environment"`
			Scopes      []string   `json:"scopes"`
			ExpiresAt   *time.Time `json:"expires_at"`
		}
		if decode(r, &in) != nil || strings.TrimSpace(in.Name) == "" {
			bad(w, r, "name is required")
			return
		}
		if in.Environment == "" {
			in.Environment = "sandbox"
		}
		if in.Environment != "sandbox" {
			writeJSON(w, 403, problem{Error: "live credentials are disabled", RequestID: requestID(r)})
			return
		}
		if in.ExpiresAt != nil && (!in.ExpiresAt.After(time.Now()) || in.ExpiresAt.After(time.Now().AddDate(5, 0, 0))) {
			bad(w, r, "expires_at must be in the future and within five years")
			return
		}
		if len(in.Scopes) == 0 {
			in.Scopes = []string{"customers.read", "customers.create", "accounts.read", "accounts.create", "collections.read", "collections.create", "collections.cancel", "collections.confirm", "collections.refund", "transfers.read", "transfers.create", "ledger.read", "fraud.analyze", "fraud.read"}
		}
		for _, sc := range in.Scopes {
			if !validScope(sc) {
				bad(w, r, "unsupported API key scope: "+sc)
				return
			}
		}
		token := "aegis_test_" + newID()
		id := "key_" + newID()
		prefix := token[:23]
		p := principalFrom(r)
		_, err := a.db.ExecContext(r.Context(), `INSERT INTO api_keys(id,organization_id,name,key_prefix,secret_hash,environment,scopes,created_by,expires_at) VALUES($1,$2,$3,$4,$5,'sandbox',$6,$7,$8)`, id, org, in.Name, prefix, tokenHash(token), string(mustJSON(in.Scopes)), nullable(p.userID), nullableExpiry(in.ExpiresAt))
		if err != nil {
			writeJSON(w, 500, problem{Error: "API key could not be created"})
			return
		}
		writeJSON(w, 201, map[string]any{"id": id, "name": in.Name, "environment": "sandbox", "scopes": in.Scopes, "expires_at": in.ExpiresAt, "secret": token, "warning": "copy this secret now; it will not be shown again"})
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `SELECT id,name,key_prefix,environment,scopes,created_at,last_used_at,expires_at,revoked_at FROM api_keys WHERE organization_id=$1 ORDER BY created_at DESC`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer rows.Close()
		data := []map[string]any{}
		for rows.Next() {
			var id, name, prefix, environment string
			var scopes []byte
			var created time.Time
			var last, expires, revoked sql.NullTime
			if rows.Scan(&id, &name, &prefix, &environment, &scopes, &created, &last, &expires, &revoked) == nil {
				var decoded []string
				_ = json.Unmarshal(scopes, &decoded)
				data = append(data, map[string]any{"id": id, "name": name, "key_prefix": prefix, "environment": environment, "scopes": decoded, "created_at": created, "last_used_at": nullableTime(last), "expires_at": nullableTime(expires), "revoked_at": nullableTime(revoked)})
			}
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if len(parts) == 3 && parts[2] == "revoke" && r.Method == http.MethodPost {
		res, err := a.db.ExecContext(r.Context(), `UPDATE api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND organization_id=$2`, parts[1], org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			notFound(w, r)
		} else {
			writeJSON(w, 200, map[string]string{"id": parts[1], "status": "revoked"})
		}
		return
	}
	notFound(w, r)
}
func validScope(s string) bool {
	switch s {
	case "organization.read", "members.read", "members.manage", "api_keys.read", "api_keys.create", "api_keys.revoke", "customers.read", "customers.create", "accounts.read", "accounts.create", "accounts.sandbox_credit", "collections.read", "collections.create", "collections.cancel", "collections.confirm", "collections.refund", "transfers.read", "transfers.create", "ledger.read", "fraud.read", "fraud.analyze", "fraud.investigate", "reconciliation.manage", "webhooks.read", "webhooks.manage", "reports.read", "audit.read", "transaction_policies.read", "transaction_policies.manage", "*":
		return true
	}
	return false
}
func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
func nullable(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func (a *App) members(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) == 1 && r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `SELECT m.id,u.id,u.email,u.full_name,m.role,m.status,m.joined_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY m.joined_at`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer rows.Close()
		data := []map[string]any{}
		for rows.Next() {
			var membershipID, id, email, name, role, status string
			var joined time.Time
			if rows.Scan(&membershipID, &id, &email, &name, &role, &status, &joined) == nil {
				data = append(data, map[string]any{"membership_id": membershipID, "user_id": id, "email": email, "full_name": name, "role": role, "status": status, "joined_at": joined})
			}
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if len(parts) == 1 && r.Method == http.MethodPost {
		// Adding a user directly would join them without consent and reveal
		// which email addresses are registered. Invitations are the only way in.
		writeJSON(w, 410, problem{Error: "members join through invitations; use POST /v1/invitations", RequestID: requestID(r)})
		return
	}
	if len(parts) == 2 && (r.Method == http.MethodPatch || r.Method == http.MethodDelete) {
		actor := principalFrom(r)
		tx, err := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer tx.Rollback()
		var role, status string
		err = tx.QueryRowContext(r.Context(), `SELECT role,status FROM memberships WHERE id=$1 AND organization_id=$2 FOR UPDATE`, parts[1], org).Scan(&role, &status)
		if err == sql.ErrNoRows {
			notFound(w, r)
			return
		}
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		// Owners and admins can only be changed by an owner, so an admin cannot
		// remove the people above them or promote others to their own level.
		if (role == "owner" || role == "admin") && !actorIsOwner(actor) {
			writeJSON(w, 403, problem{Error: "only an owner can change an owner or admin membership", RequestID: requestID(r)})
			return
		}
		if r.Method == http.MethodDelete {
			if status == "active" && role == "owner" {
				var owners int
				if err = tx.QueryRowContext(r.Context(), `SELECT count(*) FROM memberships WHERE organization_id=$1 AND role='owner' AND status='active'`, org).Scan(&owners); err != nil {
					writeJSON(w, 500, problem{Error: "database error"})
					return
				}
				if owners <= 1 {
					writeJSON(w, 409, problem{Error: "the last active owner cannot be removed"})
					return
				}
			}
			_, err = tx.ExecContext(r.Context(), `UPDATE memberships SET status='suspended' WHERE id=$1 AND organization_id=$2`, parts[1], org)
			if err != nil {
				writeJSON(w, 500, problem{Error: "membership could not be suspended"})
				return
			}
			if err = tx.Commit(); err != nil {
				writeJSON(w, 409, problem{Error: "membership update conflict"})
				return
			}
			writeJSON(w, 200, map[string]string{"id": parts[1], "status": "suspended"})
			return
		}
		var in struct {
			Role   string `json:"role"`
			Status string `json:"status"`
		}
		if decode(r, &in) != nil {
			bad(w, r, "valid role or status is required")
			return
		}
		if in.Role != "" && (!validRole(in.Role) || in.Role == "owner") {
			bad(w, r, "role must be a non-owner role")
			return
		}
		if in.Status != "" && in.Status != "active" && in.Status != "suspended" {
			bad(w, r, "status must be active or suspended")
			return
		}
		if in.Role == "" && in.Status == "" {
			bad(w, r, "role or status is required")
			return
		}
		if in.Role == "admin" && !actorIsOwner(actor) {
			writeJSON(w, 403, problem{Error: "only an owner can grant the admin role", RequestID: requestID(r)})
			return
		}
		if role == "owner" && (in.Role != "" && in.Role != "owner" || in.Status == "suspended") {
			var owners int
			if err = tx.QueryRowContext(r.Context(), `SELECT count(*) FROM memberships WHERE organization_id=$1 AND role='owner' AND status='active'`, org).Scan(&owners); err != nil {
				writeJSON(w, 500, problem{Error: "database error"})
				return
			}
			if owners <= 1 {
				writeJSON(w, 409, problem{Error: "the last active owner cannot be demoted or suspended"})
				return
			}
		}
		nextRole, nextStatus := role, status
		if in.Role != "" {
			nextRole = in.Role
		}
		if in.Status != "" {
			nextStatus = in.Status
		}
		_, err = tx.ExecContext(r.Context(), `UPDATE memberships SET role=$3,status=$4 WHERE id=$1 AND organization_id=$2`, parts[1], org, nextRole, nextStatus)
		if err != nil {
			writeJSON(w, 500, problem{Error: "membership could not be updated"})
			return
		}
		if err = tx.Commit(); err != nil {
			writeJSON(w, 409, problem{Error: "membership update conflict"})
			return
		}
		writeJSON(w, 200, map[string]string{"id": parts[1], "role": nextRole, "status": nextStatus})
		return
	}
	notFound(w, r)
}
// actorIsOwner reports whether the caller holds owner authority. The bootstrap
// operator key is treated as an owner of the sandbox organization.
func actorIsOwner(p principal) bool {
	return p.bootstrap || p.role == "owner"
}

func validRole(r string) bool {
	switch r {
	case "owner", "admin", "finance_operator", "fraud_analyst", "developer", "auditor":
		return true
	}
	return false
}
