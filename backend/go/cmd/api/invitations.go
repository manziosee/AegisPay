package main

import (
	"database/sql"
	"net/http"
	"strings"
	"time"
)

func (a *App) invitations(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) == 1 && r.Method == http.MethodGet {
		limit, cursor, err := pagination(r)
		if err != nil {
			bad(w, r, err.Error())
			return
		}
		at, afterID := cursorArgs(cursor)
		rows, err := a.db.QueryContext(r.Context(), `SELECT id,email,role,expires_at,accepted_at,created_at FROM organization_invitations WHERE organization_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3)) ORDER BY created_at DESC,id DESC LIMIT $4`, org, at, afterID, limit+1)
		if err != nil {
			writeJSON(w, 500, problem{Error: "invitation list unavailable"})
			return
		}
		defer rows.Close()
		type invitationRow struct {
			id, email, role string
			expires         time.Time
			accepted        sql.NullTime
			created         time.Time
		}
		entries := make([]invitationRow, 0, limit+1)
		for rows.Next() {
			var entry invitationRow
			if err = rows.Scan(&entry.id, &entry.email, &entry.role, &entry.expires, &entry.accepted, &entry.created); err != nil {
				writeJSON(w, 500, problem{Error: "invitation list unavailable"})
				return
			}
			entries = append(entries, entry)
		}
		if err = rows.Err(); err != nil {
			writeJSON(w, 500, problem{Error: "invitation list unavailable"})
			return
		}
		more := len(entries) > limit
		if more {
			entries = entries[:limit]
		}
		data := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			data = append(data, map[string]any{"id": entry.id, "email": entry.email, "role": entry.role, "expires_at": entry.expires, "accepted_at": nullableTime(entry.accepted), "created_at": entry.created})
		}
		var next string
		if more {
			last := entries[len(entries)-1]
			next = encodeCursor(pageCursor{ID: last.id, CreatedAt: last.created})
		}
		pageResponse(w, data, more, next)
		return
	}
	if len(parts) == 1 && r.Method == http.MethodPost {
		var in struct {
			Email string `json:"email"`
			Role  string `json:"role"`
		}
		if decode(r, &in) != nil || !strings.Contains(in.Email, "@") || !validRole(in.Role) || in.Role == "owner" {
			bad(w, r, "a valid email and non-owner role are required")
			return
		}
		p := principalFrom(r)
		if in.Role == "admin" && !actorIsOwner(p) {
			writeJSON(w, 403, problem{Error: "only an owner can invite an admin", RequestID: requestID(r)})
			return
		}
		in.Email = strings.ToLower(strings.TrimSpace(in.Email))
		token := "aegis_invite_" + newID()
		id := "inv_" + newID()
		expires := time.Now().UTC().Add(7 * 24 * time.Hour)
		_, err := a.db.ExecContext(r.Context(), `INSERT INTO organization_invitations(id,organization_id,email,role,token_hash,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`, id, org, in.Email, in.Role, tokenHash(token), expires, nullable(p.userID))
		if err != nil {
			writeJSON(w, 409, problem{Error: "invitation could not be created; check for an existing user or invitation"})
			return
		}
		writeJSON(w, 201, map[string]any{"id": id, "email": in.Email, "role": in.Role, "expires_at": expires, "invite_token": token, "delivery": "manual", "warning": "deliver this token to the invitee over a trusted channel; it will not be shown again"})
		return
	}
	if len(parts) == 3 && parts[2] == "accept" && r.Method == http.MethodPost {
		p := principalFrom(r)
		if p.userID == "" || p.sessionID == "" {
			writeJSON(w, 403, problem{Error: "acceptance requires a signed-in user session"})
			return
		}
		var in struct {
			Token string `json:"invite_token"`
		}
		if decode(r, &in) != nil || !strings.HasPrefix(in.Token, "aegis_invite_") {
			bad(w, r, "valid invite_token is required")
			return
		}
		tx, err := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer tx.Rollback()
		var invitationID, email, role string
		err = tx.QueryRowContext(r.Context(), `SELECT i.id,i.email,i.role FROM organization_invitations i JOIN users u ON lower(u.email)=lower(i.email) WHERE i.id=$1 AND i.organization_id=$2 AND i.token_hash=$3 AND i.accepted_at IS NULL AND i.expires_at>now() AND u.id=$4 FOR UPDATE OF i`, parts[1], org, tokenHash(in.Token), p.userID).Scan(&invitationID, &email, &role)
		if err == sql.ErrNoRows {
			writeJSON(w, 404, problem{Error: "invitation is invalid, expired, already used, or belongs to another account"})
			return
		}
		if err != nil {
			writeJSON(w, 500, problem{Error: "invitation could not be verified"})
			return
		}
		membershipID := "mem_" + newID()
		_, err = tx.ExecContext(r.Context(), `INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)`, membershipID, org, p.userID, role)
		if err == nil {
			_, err = tx.ExecContext(r.Context(), `UPDATE organization_invitations SET accepted_at=now() WHERE id=$1 AND organization_id=$2`, invitationID, org)
		}
		if err == nil {
			_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'invitation.accepted','membership',$4,jsonb_build_object('role',$5::text))`, "aud_"+newID(), org, p.userID, membershipID, role)
		}
		if err != nil {
			writeJSON(w, 409, problem{Error: "invitation acceptance conflict"})
			return
		}
		if err = tx.Commit(); err != nil {
			writeJSON(w, 409, problem{Error: "invitation acceptance conflict"})
			return
		}
		writeJSON(w, 200, map[string]any{"invitation_id": invitationID, "organization_id": org, "membership_id": membershipID, "role": role, "status": "accepted"})
		return
	}
	notFound(w, r)
}
