package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"time"
)

func (a *App) rotateAPIKey(w http.ResponseWriter, r *http.Request, org, oldID string) {
	tx, err := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	var name, environment string
	var scopes []byte
	var expires sql.NullTime
	err = tx.QueryRowContext(r.Context(), `SELECT name,environment,scopes,expires_at FROM api_keys WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL FOR UPDATE`, oldID, org).Scan(&name, &environment, &scopes, &expires)
	if err == sql.ErrNoRows {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "API key could not be loaded"})
		return
	}
	if expires.Valid && !expires.Time.After(time.Now()) {
		writeJSON(w, 409, problem{Error: "expired API keys cannot be rotated; create a replacement key"})
		return
	}
	var decodedScopes []string
	if json.Unmarshal(scopes, &decodedScopes) != nil {
		writeJSON(w, 500, problem{Error: "API key scopes could not be decoded"})
		return
	}
	token := "aegis_test_" + newID()
	newIDValue := "key_" + newID()
	_, err = tx.ExecContext(r.Context(), `UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND organization_id=$2`, oldID, org)
	if err == nil {
		p := principalFrom(r)
		_, err = tx.ExecContext(r.Context(), `INSERT INTO api_keys(id,organization_id,name,key_prefix,secret_hash,environment,scopes,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, newIDValue, org, name, token[:23], tokenHash(token), environment, string(scopes), nullableTime(expires), nullable(p.userID))
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'api_key.rotated','api_key',$4,jsonb_build_object('replacement_id',$5::text))`, "aud_"+newID(), org, nullable(principalFrom(r).userID), oldID, newIDValue)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "API key rotation failed"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "API key rotation conflict"})
		return
	}
	writeJSON(w, 201, map[string]any{"id": newIDValue, "replaces": oldID, "name": name, "environment": environment, "scopes": decodedScopes, "expires_at": nullableTime(expires), "secret": token, "warning": "the previous key was revoked; copy this replacement secret now because it will not be shown again"})
}

func nullableTime(value sql.NullTime) any {
	if !value.Valid {
		return nil
	}
	return value.Time
}

func nullableExpiry(value *time.Time) any {
	if value == nil {
		return nil
	}
	return *value
}
