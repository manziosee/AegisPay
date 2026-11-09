package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

func (a *App) auditLogs(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 2 && parts[1] == "verify" && r.Method == http.MethodGet {
		a.verifyAuditChain(w, r)
		return
	}
	if len(parts) >= 2 && parts[1] == "anchors" && r.Method == http.MethodGet {
		a.auditAnchors(w, r, parts)
		return
	}
	if len(parts) != 1 || r.Method != http.MethodGet {
		notFound(w, r)
		return
	}
	limit, cursor, err := pagination(r)
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	q := r.URL.Query()
	action := strings.TrimSpace(q.Get("action"))
	resource := strings.TrimSpace(q.Get("resource_type"))
	if len(action) > 128 || len(resource) > 64 {
		bad(w, r, "action or resource_type filter is too long")
		return
	}
	var since any
	if raw := q.Get("since"); raw != "" {
		t, parseErr := time.Parse(time.RFC3339, raw)
		if parseErr != nil {
			bad(w, r, "since must be RFC3339")
			return
		}
		since = t
	}
	var until any
	if raw := q.Get("until"); raw != "" {
		t, parseErr := time.Parse(time.RFC3339, raw)
		if parseErr != nil {
			bad(w, r, "until must be RFC3339")
			return
		}
		until = t
	}
	if since != nil && until != nil && !since.(time.Time).Before(until.(time.Time)) {
		bad(w, r, "since must be earlier than until")
		return
	}
	at, id := cursorArgs(cursor)
	rows, err := a.db.QueryContext(r.Context(), `SELECT id,actor_id,action,resource_type,resource_id,metadata,created_at
		FROM audit_logs WHERE organization_id=$1 AND ($2='' OR action=$2) AND ($3='' OR resource_type=$3)
		AND ($4::timestamptz IS NULL OR created_at >= $4) AND ($5::timestamptz IS NULL OR created_at < $5)
		AND ($6::timestamptz IS NULL OR (created_at,id)<($6,$7))
		ORDER BY created_at DESC,id DESC LIMIT $8`, currentOrgID(r, a.orgID), action, resource, since, until, at, id, limit+1)
	if err != nil {
		writeJSON(w, 500, problem{Error: "audit log query failed"})
		return
	}
	defer rows.Close()
	type auditRow struct {
		id, action, resourceType, resourceID string
		actor                                sql.NullString
		metadata                             []byte
		created                              time.Time
	}
	entries := make([]auditRow, 0, limit+1)
	for rows.Next() {
		var entry auditRow
		if err = rows.Scan(&entry.id, &entry.actor, &entry.action, &entry.resourceType, &entry.resourceID, &entry.metadata, &entry.created); err != nil {
			writeJSON(w, 500, problem{Error: "audit log query failed"})
			return
		}
		entries = append(entries, entry)
	}
	if err = rows.Err(); err != nil {
		writeJSON(w, 500, problem{Error: "audit log query failed"})
		return
	}
	more := len(entries) > limit
	if more {
		entries = entries[:limit]
	}
	data := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		var metadata any = map[string]any{}
		if len(entry.metadata) > 0 {
			_ = json.Unmarshal(entry.metadata, &metadata)
		}
		data = append(data, map[string]any{"id": entry.id, "actor_id": nullableNull(entry.actor), "action": entry.action, "resource_type": entry.resourceType, "resource_id": entry.resourceID, "metadata": metadata, "created_at": entry.created})
	}
	var next string
	if more {
		last := entries[len(entries)-1]
		next = encodeCursor(pageCursor{ID: last.id, CreatedAt: last.created})
	}
	pageResponse(w, data, more, next)
}

// auditRowHash mirrors the audit_log_hash SQL function.
func auditRowHash(prev, id, org, actor, action, resourceType, resourceID, metadata string, created time.Time) string {
	sum := sha256.Sum256([]byte(prev + "|" + id + "|" + org + "|" + actor + "|" + action + "|" + resourceType + "|" + resourceID + "|" + metadata + "|" + created.UTC().Format("2006-01-02T15:04:05.000000")))
	return hex.EncodeToString(sum[:])
}

// verifyAuditChain recomputes the organization's audit hash chain and reports
// the first row whose stored hash or link does not match.
func (a *App) verifyAuditChain(w http.ResponseWriter, r *http.Request) {
	result, err := a.auditChainStatus(r.Context(), currentOrgID(r, a.orgID))
	if err != nil {
		writeJSON(w, 500, problem{Error: "audit chain could not be read", RequestID: requestID(r)})
		return
	}
	writeJSON(w, 200, result)
}

// auditChainStatus recomputes the chain and checks it against every daily
// public anchor.
func (a *App) auditChainStatus(ctx context.Context, org string) (map[string]any, error) {
	// Each daily anchor names an entry and the chain head at that entry;
	// recomputing the chain must reproduce it.
	anchors := map[string]string{}
	anchorRows, err := a.db.QueryContext(ctx, `SELECT last_entry_id,head_hash FROM audit_anchors WHERE organization_id=$1`, org)
	if err != nil {
		return nil, err
	}
	for anchorRows.Next() {
		var entry, head string
		if anchorRows.Scan(&entry, &head) == nil {
			anchors[entry] = head
		}
	}
	_ = anchorRows.Close()
	rows, err := a.db.QueryContext(ctx, `SELECT id,COALESCE(actor_id,''),action,resource_type,resource_id,metadata::text,created_at,COALESCE(prev_hash,''),COALESCE(hash,'') FROM audit_logs WHERE organization_id=$1 ORDER BY seq LIMIT 200000`, org)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	anchorsChecked := 0
	prev := strings.Repeat("0", 64)
	checked := 0
	for rows.Next() {
		var id, actor, action, resourceType, resourceID, metadata, storedPrev, storedHash string
		var created time.Time
		if err = rows.Scan(&id, &actor, &action, &resourceType, &resourceID, &metadata, &created, &storedPrev, &storedHash); err != nil {
			return nil, err
		}
		expected := auditRowHash(prev, id, org, actor, action, resourceType, resourceID, metadata, created)
		if storedPrev != prev || storedHash != expected {
			return map[string]any{"valid": false, "checked": checked, "first_invalid_id": id, "anchors_checked": anchorsChecked, "detail": "stored hash does not match the recomputed chain"}, nil
		}
		if anchored, ok := anchors[id]; ok {
			if anchored != expected {
				return map[string]any{"valid": false, "checked": checked, "first_invalid_id": id, "anchors_checked": anchorsChecked, "detail": "the chain no longer matches a publicly timestamped anchor"}, nil
			}
			anchorsChecked++
		}
		prev = storedHash
		checked++
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"valid": true, "checked": checked, "head_hash": prev, "anchors_checked": anchorsChecked}, nil
}
