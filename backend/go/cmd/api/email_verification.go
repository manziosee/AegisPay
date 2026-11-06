package main

import (
	"context"
	"database/sql"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// sendVerificationEmail creates a one-time, 48-hour link. It runs outside
// request-critical paths: failure to send never blocks sign-up.
func (a *App) sendVerificationEmail(ctx context.Context, userID, address, name string) error {
	token := "aegis_verify_" + newID()
	if _, err := a.db.ExecContext(ctx, `INSERT INTO email_verification_tokens(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '48 hours')`, tokenHash(token), userID); err != nil {
		return err
	}
	a.sendEmailAsync(email{
		To: address, ToName: name,
		Subject:     "Confirm your email for AegisPay",
		Heading:     "Confirm your email address",
		Paragraphs:  []string{"Hi " + name + ",", "Confirm this address to create live workspaces and send invitations. The link expires in 48 hours."},
		ActionLabel: "Confirm email",
		ActionURL:   dashboardURL() + "/verify-email?token=" + url.QueryEscape(token),
		Footer:      "If you did not create an AegisPay account, ignore this email.",
	})
	return nil
}

// verifyEmail confirms an address with an emailed token. It is public so the
// link works on any device, signed in or not.
func (a *App) verifyEmail(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if decode(r, &in) != nil || !strings.HasPrefix(in.Token, "aegis_verify_") {
		bad(w, r, "a valid verification token is required")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	var userID string
	err = tx.QueryRowContext(r.Context(), `SELECT user_id FROM email_verification_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE`, tokenHash(in.Token)).Scan(&userID)
	if err == sql.ErrNoRows {
		writeJSON(w, 400, problem{Error: "this confirmation link is invalid, expired or already used; sign in to request a new one", RequestID: requestID(r)})
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	_, err = tx.ExecContext(r.Context(), `UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1`, userID)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `UPDATE email_verification_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, userID)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "email could not be confirmed"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "confirmation conflict"})
		return
	}
	writeJSON(w, 200, map[string]string{"status": "verified"})
}

// resendVerification sends a new link to the signed-in user.
func (a *App) resendVerification(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r)
	if p.userID == "" || !a.limitAttempt(w, r, "email-verify:"+p.userID, 5, time.Hour) {
		if p.userID == "" {
			writeJSON(w, 403, problem{Error: "a user session is required", RequestID: requestID(r)})
		}
		return
	}
	var address, name string
	var verified bool
	if err := a.db.QueryRowContext(r.Context(), `SELECT email,full_name,email_verified_at IS NOT NULL FROM users WHERE id=$1`, p.userID).Scan(&address, &name, &verified); err != nil {
		writeJSON(w, 500, problem{Error: "account could not be loaded", RequestID: requestID(r)})
		return
	}
	if verified {
		writeJSON(w, 200, map[string]string{"status": "already_verified"})
		return
	}
	if err := a.sendVerificationEmail(r.Context(), p.userID, address, name); err != nil {
		writeJSON(w, 500, problem{Error: "confirmation email could not be prepared", RequestID: requestID(r)})
		return
	}
	writeJSON(w, 202, map[string]string{"status": "sent"})
}

// feedback sends a signed-in user's message to the support inbox.
func (a *App) feedback(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r)
	if p.userID == "" {
		writeJSON(w, 403, problem{Error: "a user session is required", RequestID: requestID(r)})
		return
	}
	var in struct {
		Message string `json:"message"`
		Page    string `json:"page"`
	}
	if decode(r, &in) != nil || strings.TrimSpace(in.Message) == "" || len(in.Message) > 4000 || len(in.Page) > 200 {
		bad(w, r, "a message of up to 4000 characters is required")
		return
	}
	if !a.limitAttempt(w, r, "feedback:"+p.userID, 5, time.Hour) {
		return
	}
	var address, name string
	if err := a.db.QueryRowContext(r.Context(), `SELECT email,full_name FROM users WHERE id=$1`, p.userID).Scan(&address, &name); err != nil {
		writeJSON(w, 500, problem{Error: "account could not be loaded", RequestID: requestID(r)})
		return
	}
	support := firstNonEmpty(env("SUPPORT_EMAIL", ""), env("EMAIL_FROM", ""))
	if support == "" {
		writeJSON(w, 503, problem{Error: "support email is not configured", RequestID: requestID(r)})
		return
	}
	a.sendEmailAsync(email{
		To:         support,
		ReplyTo:    address,
		Subject:    "AegisPay feedback from " + name,
		Heading:    "Feedback from " + name,
		Paragraphs: []string{strings.TrimSpace(in.Message), "From: " + name + " <" + address + ">", "Workspace: " + p.orgID, "Page: " + in.Page},
	})
	writeJSON(w, 202, map[string]string{"status": "sent"})
}
