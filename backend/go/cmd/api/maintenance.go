package main

import (
	"context"
	"log/slog"
	"strconv"
	"time"
)

const maintenanceBatch = 5000

// runMaintenance removes records that are only needed for a bounded time and
// moves encrypted secrets to the active key. Every step works in small
// batches and is safe to run from several replicas at once.
func (a *App) runMaintenance(ctx context.Context) {
	interval := time.Duration(envInt("MAINTENANCE_INTERVAL_MINUTES", 60, 1, 24*60)) * time.Minute
	for {
		a.maintenancePass(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

func (a *App) maintenancePass(ctx context.Context) {
	// Idempotency keys only guard retries; 24 hours matches common payment
	// API practice. A key reused after this window is treated as new.
	idempotencyHours := envInt("IDEMPOTENCY_RETENTION_HOURS", 24, 1, 24*90)
	sessionDays := envInt("SESSION_RETENTION_DAYS", 30, 1, 3650)
	sweeps := []struct {
		name, query string
		arg         any
	}{
		{"idempotency_records", `DELETE FROM idempotency_records WHERE ctid IN (SELECT ctid FROM idempotency_records WHERE created_at < now() - make_interval(hours => $1) LIMIT ` + strconv.Itoa(maintenanceBatch) + `)`, idempotencyHours},
		{"mfa_login_challenges", `DELETE FROM mfa_login_challenges WHERE ctid IN (SELECT ctid FROM mfa_login_challenges WHERE expires_at < now() - make_interval(hours => $1) LIMIT ` + strconv.Itoa(maintenanceBatch) + `)`, 0},
		{"password_reset_tokens", `DELETE FROM password_reset_tokens WHERE ctid IN (SELECT ctid FROM password_reset_tokens WHERE created_at < now() - make_interval(days => $1) LIMIT ` + strconv.Itoa(maintenanceBatch) + `)`, 7},
		{"email_verification_tokens", `DELETE FROM email_verification_tokens WHERE ctid IN (SELECT ctid FROM email_verification_tokens WHERE created_at < now() - make_interval(days => $1) LIMIT ` + strconv.Itoa(maintenanceBatch) + `)`, 30},
		{"user_sessions", `DELETE FROM user_sessions WHERE ctid IN (SELECT ctid FROM user_sessions WHERE (expires_at < now() - make_interval(days => $1)) OR (revoked_at < now() - make_interval(days => $1)) LIMIT ` + strconv.Itoa(maintenanceBatch) + `)`, sessionDays},
	}
	for _, sweep := range sweeps {
		total := int64(0)
		for ctx.Err() == nil {
			res, err := a.db.ExecContext(ctx, sweep.query, sweep.arg)
			if err != nil {
				slog.Error("maintenance sweep failed", "table", sweep.name, "error", err)
				break
			}
			n, _ := res.RowsAffected()
			total += n
			if n < maintenanceBatch {
				break
			}
		}
		if total > 0 {
			slog.Info("maintenance sweep", "table", sweep.name, "deleted", total)
		}
	}
	a.reencryptSecrets(ctx, "webhook_endpoints", "id", "secret_ciphertext", purposeWebhookSecret)
	a.reencryptSecrets(ctx, "user_mfa_factors", "user_id", "secret_ciphertext", purposeMFASecret)
	a.reencryptSecrets(ctx, "notification_channels", "id", "url_ciphertext", purposeChannelURL)
	a.anchorAuditChains(ctx)
}

// reencryptSecrets re-seals ciphertexts that were not written by the active
// key (pre-versioning rows, or rows under a key being retired). Once a sweep
// reports nothing left, the old key can be removed from ENCRYPTION_KEYS.
func (a *App) reencryptSecrets(ctx context.Context, table, keyColumn, column, purpose string) {
	ring, err := loadKeyRing()
	if err != nil {
		return
	}
	header := ring.activeHeader()
	rotated, failed := 0, 0
	for ctx.Err() == nil {
		tx, err := a.db.BeginTx(ctx, nil)
		if err != nil {
			slog.Error("secret re-encryption", "table", table, "error", err)
			return
		}
		// Rows that cannot be opened are skipped by offset so they do not
		// block the rest of the table.
		rows, err := tx.QueryContext(ctx, `SELECT `+keyColumn+`,`+column+` FROM `+table+` WHERE substring(`+column+` from 1 for $1) IS DISTINCT FROM $2 ORDER BY `+keyColumn+` OFFSET $3 LIMIT 200 FOR UPDATE SKIP LOCKED`, len(header), header, failed)
		if err != nil {
			_ = tx.Rollback()
			slog.Error("secret re-encryption", "table", table, "error", err)
			return
		}
		type pending struct {
			id         string
			ciphertext []byte
		}
		batch := []pending{}
		for rows.Next() {
			var p pending
			if err = rows.Scan(&p.id, &p.ciphertext); err == nil {
				batch = append(batch, p)
			}
		}
		_ = rows.Close()
		if len(batch) == 0 {
			_ = tx.Rollback()
			break
		}
		for _, item := range batch {
			plain, err := ring.open(purpose, item.ciphertext)
			if err != nil {
				failed++
				slog.Warn("secret could not be opened for re-encryption; its key may be missing from ENCRYPTION_KEYS", "table", table, "id", item.id)
				continue
			}
			sealed, err := ring.seal(purpose, plain)
			if err == nil {
				_, err = tx.ExecContext(ctx, `UPDATE `+table+` SET `+column+`=$2 WHERE `+keyColumn+`=$1`, item.id, sealed)
			}
			if err != nil {
				failed++
				continue
			}
			rotated++
		}
		if err = tx.Commit(); err != nil {
			slog.Error("secret re-encryption commit", "table", table, "error", err)
			return
		}
	}
	if rotated > 0 || failed > 0 {
		slog.Info("secret re-encryption", "table", table, "rotated", rotated, "unreadable", failed, "active_key", ring.activeID)
	}
}
