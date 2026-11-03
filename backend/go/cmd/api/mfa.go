package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"golang.org/x/crypto/bcrypt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (a *App) userMFA(w http.ResponseWriter, r *http.Request, parts []string) {
	p := principalFrom(r)
	if p.userID == "" || p.sessionID == "" {
		writeJSON(w, 403, problem{Error: "MFA management requires a user session"})
		return
	}
	if len(parts) != 1 {
		notFound(w, r)
		return
	}
	if (parts[0] == "verify" || parts[0] == "disable") && !a.limitAttempt(w, r, "mfa-manage:"+p.userID, 10, 15*time.Minute) {
		return
	}
	switch parts[0] {
	case "enroll":
		if r.Method != http.MethodPost {
			notFound(w, r)
			return
		}
		var enabled bool
		err := a.db.QueryRowContext(r.Context(), "SELECT enabled FROM user_mfa_factors WHERE user_id=$1", p.userID).Scan(&enabled)
		if err == nil && enabled {
			writeJSON(w, 409, problem{Error: "MFA is already enabled"})
			return
		}
		if err != nil && err != sql.ErrNoRows {
			writeJSON(w, 500, problem{Error: "MFA status unavailable"})
			return
		}
		key := make([]byte, 20)
		if _, err = rand.Read(key); err != nil {
			writeJSON(w, 500, problem{Error: "MFA secret generation failed"})
			return
		}
		secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(key)
		ciphertext, err := sealSecret(purposeMFASecret, secret)
		if err != nil {
			writeJSON(w, 503, problem{Error: "MFA encryption is not configured"})
			return
		}
		_, err = a.db.ExecContext(r.Context(), "INSERT INTO user_mfa_factors(user_id,secret_ciphertext,enabled,enabled_at) VALUES($1,$2,false,NULL) ON CONFLICT(user_id) DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext,enabled=false,enabled_at=NULL,created_at=now()", p.userID, ciphertext)
		if err != nil {
			writeJSON(w, 500, problem{Error: "MFA enrollment could not be saved"})
			return
		}
		uri := fmt.Sprintf("otpauth://totp/%s?secret=%s&issuer=AegisPay&algorithm=SHA1&digits=6&period=30", url.QueryEscape("AegisPay:"+p.userID), secret)
		writeJSON(w, 201, map[string]any{"status": "pending_verification", "secret": secret, "otpauth_uri": uri, "warning": "store this secret securely and verify a current code to enable MFA"})
	case "verify":
		if r.Method != http.MethodPost {
			notFound(w, r)
			return
		}
		var in struct {
			Code string `json:"code"`
		}
		if decode(r, &in) != nil || !validTOTPFormat(in.Code) {
			bad(w, r, "six-digit authenticator code is required")
			return
		}
		var ciphertext []byte
		var enabled bool
		err := a.db.QueryRowContext(r.Context(), "SELECT secret_ciphertext,enabled FROM user_mfa_factors WHERE user_id=$1", p.userID).Scan(&ciphertext, &enabled)
		if err != nil {
			notFound(w, r)
			return
		}
		secret, err := openSecret(purposeMFASecret, ciphertext)
		if err != nil || !verifyTOTP(secret, in.Code, time.Now()) {
			writeJSON(w, 401, problem{Error: "invalid authenticator code"})
			return
		}
		_, err = a.db.ExecContext(r.Context(), "UPDATE user_mfa_factors SET enabled=true,enabled_at=now() WHERE user_id=$1 AND enabled=false", p.userID)
		if err != nil {
			writeJSON(w, 500, problem{Error: "MFA could not be enabled"})
			return
		}
		writeJSON(w, 200, map[string]string{"status": "enabled"})
	case "disable":
		if r.Method != http.MethodPost {
			notFound(w, r)
			return
		}
		var in struct {
			Code     string `json:"code"`
			Password string `json:"password"`
		}
		if decode(r, &in) != nil || !validTOTPFormat(in.Code) || in.Password == "" {
			bad(w, r, "password and six-digit authenticator code are required")
			return
		}
		var hash string
		var ciphertext []byte
		var enabled bool
		err := a.db.QueryRowContext(r.Context(), "SELECT u.password_hash,f.secret_ciphertext,f.enabled FROM users u JOIN user_mfa_factors f ON f.user_id=u.id WHERE u.id=$1", p.userID).Scan(&hash, &ciphertext, &enabled)
		if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil {
			writeJSON(w, 401, problem{Error: "invalid credentials"})
			return
		}
		secret, err := openSecret(purposeMFASecret, ciphertext)
		if err != nil || !enabled || !verifyTOTP(secret, in.Code, time.Now()) {
			writeJSON(w, 401, problem{Error: "invalid authenticator code"})
			return
		}
		_, err = a.db.ExecContext(r.Context(), "DELETE FROM user_mfa_factors WHERE user_id=$1", p.userID)
		if err != nil {
			writeJSON(w, 500, problem{Error: "MFA could not be disabled"})
			return
		}
		writeJSON(w, 200, map[string]string{"status": "disabled"})
	default:
		notFound(w, r)
	}
}

func (a *App) verifyMFALogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"mfa_token"`
		Code  string `json:"code"`
	}
	if decode(r, &in) != nil || !strings.HasPrefix(in.Token, "aegis_mfa_") || !validTOTPFormat(in.Code) {
		bad(w, r, "mfa_token and six-digit authenticator code are required")
		return
	}
	// A challenge lives five minutes; five guesses keeps a six-digit code safe
	// no matter how many client addresses an attacker uses.
	if !a.limitAttempt(w, r, "mfa-login:"+tokenHash(in.Token), 5, 5*time.Minute) {
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	var userID, org string
	var ciphertext []byte
	err = tx.QueryRowContext(r.Context(), "SELECT c.user_id,c.organization_id,f.secret_ciphertext FROM mfa_login_challenges c JOIN user_mfa_factors f ON f.user_id=c.user_id WHERE c.token_hash=$1 AND c.expires_at>now() AND f.enabled=true FOR UPDATE OF c", tokenHash(in.Token)).Scan(&userID, &org, &ciphertext)
	if err != nil {
		writeJSON(w, 401, problem{Error: "invalid or expired MFA challenge"})
		return
	}
	secret, err := openSecret(purposeMFASecret, ciphertext)
	if err != nil || !verifyTOTP(secret, in.Code, time.Now()) {
		writeJSON(w, 401, problem{Error: "invalid authenticator code"})
		return
	}
	var name, role string
	err = tx.QueryRowContext(r.Context(), "SELECT u.full_name,COALESCE(m.role,'invitee') FROM users u LEFT JOIN memberships m ON m.user_id=u.id AND m.organization_id=$2 AND m.status='active' LEFT JOIN organization_invitations i ON lower(i.email)=lower(u.email) AND i.organization_id=$2 AND i.accepted_at IS NULL AND i.expires_at>now() WHERE u.id=$1 AND u.status='active' AND (m.user_id IS NOT NULL OR i.id IS NOT NULL) ORDER BY m.joined_at LIMIT 1", userID, org).Scan(&name, &role)
	if err != nil {
		writeJSON(w, 403, problem{Error: "no active organization membership"})
		return
	}
	if _, err = tx.ExecContext(r.Context(), "DELETE FROM mfa_login_challenges WHERE token_hash=$1", tokenHash(in.Token)); err != nil {
		writeJSON(w, 500, problem{Error: "MFA challenge could not be consumed"})
		return
	}
	token := "aegis_session_" + newID()
	expires := time.Now().UTC().Add(12 * time.Hour)
	if _, err = tx.ExecContext(r.Context(), "INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)", "ses_"+newID(), userID, tokenHash(token), expires); err != nil {
		writeJSON(w, 500, problem{Error: "session creation failed"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "MFA login conflict"})
		return
	}
	writeJSON(w, 200, map[string]any{"user_id": userID, "full_name": name, "organization_id": org, "role": role, "access_token": token, "token_type": "Bearer", "expires_at": expires})
}

func validTOTPFormat(code string) bool {
	if len(code) != 6 {
		return false
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
func verifyTOTP(secret, code string, now time.Time) bool {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil || len(key) == 0 {
		return false
	}
	current := now.Unix() / 30
	for offset := int64(-1); offset <= 1; offset++ {
		counter := current + offset
		if counter < 0 {
			continue
		}
		var msg [8]byte
		binary.BigEndian.PutUint64(msg[:], uint64(counter))
		mac := hmac.New(sha1.New, key)
		_, _ = mac.Write(msg[:])
		sum := mac.Sum(nil)
		i := sum[len(sum)-1] & 15
		value := binary.BigEndian.Uint32(sum[i:i+4]) & 0x7fffffff
		candidate := fmt.Sprintf("%06d", value%1000000)
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(code)) == 1 {
			return true
		}
	}
	return false
}
