package main

import (
	"database/sql"
	"net/http"
	"time"
)

// sessionMeta describes the device creating a session, for the session list.
func sessionMeta(r *http.Request) (userAgent, ip string) {
	userAgent = r.UserAgent()
	if len(userAgent) > 300 {
		userAgent = userAgent[:300]
	}
	return userAgent, clientIP(r)
}

// userSessions lists, revokes one of, or revokes all other sessions of the
// signed-in user.
func (a *App) userSessions(w http.ResponseWriter, r *http.Request, parts []string) {
	p := principalFrom(r)
	if p.userID == "" || p.sessionID == "" {
		writeJSON(w, 403, problem{Error: "session management requires a user session", RequestID: requestID(r)})
		return
	}
	switch {
	case len(parts) == 0 && r.Method == http.MethodGet:
		rows, err := a.db.QueryContext(r.Context(), `SELECT id,user_agent,ip_address,created_at,expires_at,last_seen_at FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 100`, p.userID)
		if err != nil {
			writeJSON(w, 500, problem{Error: "sessions unavailable", RequestID: requestID(r)})
			return
		}
		defer rows.Close()
		data := []map[string]any{}
		for rows.Next() {
			var id, agent, ip string
			var created, expires time.Time
			var seen sql.NullTime
			if err = rows.Scan(&id, &agent, &ip, &created, &expires, &seen); err != nil {
				writeJSON(w, 500, problem{Error: "sessions unavailable", RequestID: requestID(r)})
				return
			}
			data = append(data, map[string]any{"id": id, "user_agent": agent, "ip_address": ip, "created_at": created, "expires_at": expires, "last_seen_at": nullableTime(seen), "current": id == p.sessionID})
		}
		writeJSON(w, 200, map[string]any{"data": data})
	case len(parts) == 1 && parts[0] == "revoke-others" && r.Method == http.MethodPost:
		res, err := a.db.ExecContext(r.Context(), `UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`, p.userID, p.sessionID)
		if err != nil {
			writeJSON(w, 500, problem{Error: "sessions could not be revoked", RequestID: requestID(r)})
			return
		}
		n, _ := res.RowsAffected()
		a.audit(r, p.orgID, "session.revoked_others", "user", p.userID, map[string]any{"revoked": n})
		writeJSON(w, 200, map[string]any{"revoked": n})
	case len(parts) == 2 && parts[1] == "revoke" && r.Method == http.MethodPost:
		res, err := a.db.ExecContext(r.Context(), `UPDATE user_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, parts[0], p.userID)
		if err != nil {
			writeJSON(w, 500, problem{Error: "session could not be revoked", RequestID: requestID(r)})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			notFound(w, r)
			return
		}
		writeJSON(w, 200, map[string]any{"id": parts[0], "status": "revoked", "current": parts[0] == p.sessionID})
	default:
		notFound(w, r)
	}
}
