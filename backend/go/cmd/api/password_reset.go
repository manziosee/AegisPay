package main

import (
	"database/sql"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// forgotPassword emails a one-time reset link. The response is the same
// whether or not the address is registered, so it cannot be used to discover
// accounts.
func (a *App) forgotPassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
	}
	if decode(r, &in) != nil || !strings.Contains(in.Email, "@") {
		bad(w, r, "a valid email is required")
		return
	}
	address := strings.ToLower(strings.TrimSpace(in.Email))
	if !a.limitAttempt(w, r, "password-forgot:"+tokenHash(address), 5, time.Hour) {
		return
	}
	accepted := map[string]string{"status": "accepted", "message": "If an account uses this email, a reset link has been sent. It expires in one hour."}
	var userID, name string
	err := a.db.QueryRowContext(r.Context(), `SELECT id,full_name FROM users WHERE email=$1 AND status='active'`, address).Scan(&userID, &name)
	if err == sql.ErrNoRows {
		writeJSON(w, 202, accepted)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "password reset is unavailable", RequestID: requestID(r)})
		return
	}
	token := "aegis_reset_" + newID()
	if _, err = a.db.ExecContext(r.Context(), `INSERT INTO password_reset_tokens(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')`, tokenHash(token), userID); err != nil {
		writeJSON(w, 500, problem{Error: "password reset is unavailable", RequestID: requestID(r)})
		return
	}
	a.sendEmailAsync(email{
		To: address, ToName: name,
		Subject:     "Reset your AegisPay password",
		Heading:     "Reset your password",
		Paragraphs:  []string{"Hi " + name + ",", "Someone asked to reset the password for your AegisPay account. The link works once and expires in one hour."},
		ActionLabel: "Choose a new password",
		ActionURL:   dashboardURL() + "/reset-password?token=" + url.QueryEscape(token),
		Footer:      "If you did not ask for this, ignore this email; your password stays the same.",
	})
	writeJSON(w, 202, accepted)
}

// resetPassword sets a new password with a reset token and signs the user out
// everywhere.
func (a *App) resetPassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if decode(r, &in) != nil || !strings.HasPrefix(in.Token, "aegis_reset_") {
		bad(w, r, "a valid reset token is required")
		return
	}
	if len(in.Password) < 12 || len(in.Password) > 72 {
		bad(w, r, "password must be 12 to 72 bytes")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, 500, problem{Error: "password hashing failed"})
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	var userID, address, name string
	err = tx.QueryRowContext(r.Context(), `SELECT t.user_id,u.email,u.full_name FROM password_reset_tokens t JOIN users u ON u.id=t.user_id
		WHERE t.token_hash=$1 AND t.used_at IS NULL AND t.expires_at>now() AND u.status='active' FOR UPDATE OF t`, tokenHash(in.Token)).Scan(&userID, &address, &name)
	if err == sql.ErrNoRows {
		writeJSON(w, 400, problem{Error: "this reset link is invalid, expired or already used; request a new one", RequestID: requestID(r)})
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	_, err = tx.ExecContext(r.Context(), `UPDATE users SET password_hash=$2 WHERE id=$1`, userID, string(hash))
	if err == nil {
		// Every outstanding link for this user stops working.
		_, err = tx.ExecContext(r.Context(), `UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, userID)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, userID)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "password could not be changed", RequestID: requestID(r)})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "password reset conflict"})
		return
	}
	a.sendEmailAsync(email{
		To: address, ToName: name,
		Subject:    "Your AegisPay password was changed",
		Heading:    "Your password was changed",
		Paragraphs: []string{"Hi " + name + ",", "The password for your AegisPay account was just changed, and every device was signed out."},
		Footer:     "If this was not you, reset your password again right away and turn on two-step sign-in.",
	})
	writeJSON(w, 200, map[string]string{"status": "password_changed"})
}

// emailInvitation sends the invitee a link that opens the dashboard's
// invitation page; the token in the link is single use and expires with the
// invitation.
func (a *App) emailInvitation(r *http.Request, org, invitationID, address, role, token string) {
	var workspace, inviter string
	_ = a.db.QueryRowContext(r.Context(), `SELECT name FROM organizations WHERE id=$1`, org).Scan(&workspace)
	if p := principalFrom(r); p.userID != "" {
		_ = a.db.QueryRowContext(r.Context(), `SELECT full_name FROM users WHERE id=$1`, p.userID).Scan(&inviter)
	}
	inviter = firstNonEmpty(inviter, "A teammate")
	link := dashboardURL() + "/invite?" + url.Values{"invitation": {invitationID}, "organization": {org}, "token": {token}}.Encode()
	a.sendEmailAsync(email{
		To:          address,
		Subject:     inviter + " invited you to " + workspace + " on AegisPay",
		Heading:     "You're invited to " + workspace,
		Paragraphs:  []string{inviter + " invited you to join " + workspace + " on AegisPay as " + strings.ReplaceAll(role, "_", " ") + ".", "Sign in, or create an account with this email address, to accept. The invitation expires in seven days."},
		ActionLabel: "Accept invitation",
		ActionURL:   link,
		Footer:      "If you were not expecting this, you can ignore this email.",
	})
}

// emailApprovers tells the people who can approve a transfer or payout that
// one is waiting. The initiator is excluded.
func (a *App) emailApprovers(r *http.Request, org, initiatorID, what, amount, reference, path string) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT DISTINCT u.email,u.full_name FROM memberships m JOIN users u ON u.id=m.user_id
		WHERE m.organization_id=$1 AND m.status='active' AND u.status='active' AND m.role IN ('owner','admin') AND u.id<>$2
		UNION SELECT u.email,u.full_name FROM approval_delegations d JOIN users u ON u.id=d.delegate_user_id
		WHERE d.organization_id=$1 AND d.revoked_at IS NULL AND d.expires_at>now() AND u.status='active' AND u.id<>$2
		LIMIT 25`, org, initiatorID)
	if err != nil {
		return
	}
	defer rows.Close()
	var workspace string
	_ = a.db.QueryRowContext(r.Context(), `SELECT name FROM organizations WHERE id=$1`, org).Scan(&workspace)
	for rows.Next() {
		var address, name string
		if rows.Scan(&address, &name) != nil {
			continue
		}
		a.sendEmailAsync(email{
			To: address, ToName: name,
			Subject:     "Approval needed: " + what + " " + amount,
			Heading:     "A " + what + " is waiting for your approval",
			Paragraphs:  []string{"Hi " + name + ",", "A " + what + " of " + amount + " (reference " + reference + ") in " + workspace + " needs a second reviewer before it can go ahead."},
			ActionLabel: "Review in AegisPay",
			ActionURL:   dashboardURL() + path,
			Footer:      "You receive this because you can approve payments in " + workspace + ".",
		})
	}
}

// formatMinorAmount renders 120050 EUR as "1,200.50 EUR".
func formatMinorAmount(amount int64, currency string) string {
	currency = strings.ToUpper(strings.TrimSpace(currency))
	digits := currencyMinorDigits(currency)
	negative := amount < 0
	if negative {
		amount = -amount
	}
	scale := int64(1)
	for i := 0; i < digits; i++ {
		scale *= 10
	}
	whole, frac := amount/scale, amount%scale
	s := groupThousands(whole)
	if digits > 0 {
		f := strings.Repeat("0", digits) + itoa64(frac)
		s += "." + f[len(f)-digits:]
	}
	if negative {
		s = "-" + s
	}
	return s + " " + currency
}

func itoa64(v int64) string {
	if v == 0 {
		return "0"
	}
	var b []byte
	for v > 0 {
		b = append([]byte{byte('0' + v%10)}, b...)
		v /= 10
	}
	return string(b)
}

func groupThousands(v int64) string {
	s := itoa64(v)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
