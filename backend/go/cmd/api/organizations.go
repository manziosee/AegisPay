package main

import (
	"net/http"
	"time"
)

// userOrganizations lists the workspaces the signed-in user can switch to.
// Clients select one by sending its ID in X-Organization-ID.
func (a *App) userOrganizations(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r)
	if p.userID == "" {
		writeJSON(w, 403, problem{Error: "listing workspaces requires a user session", RequestID: requestID(r)})
		return
	}
	rows, err := a.db.QueryContext(r.Context(), `SELECT o.id,o.name,o.workspace_type,o.country_code,m.role,m.joined_at
		FROM memberships m JOIN organizations o ON o.id=m.organization_id
		WHERE m.user_id=$1 AND m.status='active' AND o.status='active'
		ORDER BY m.joined_at`, p.userID)
	if err != nil {
		writeJSON(w, 500, problem{Error: "workspaces could not be loaded", RequestID: requestID(r)})
		return
	}
	defer rows.Close()
	type organization struct {
		ID            string    `json:"id"`
		Name          string    `json:"name"`
		WorkspaceType string    `json:"workspace_type"`
		CountryCode   string    `json:"country_code"`
		Role          string    `json:"role"`
		JoinedAt      time.Time `json:"joined_at"`
		Current       bool      `json:"current"`
	}
	data := []organization{}
	for rows.Next() {
		var item organization
		if err = rows.Scan(&item.ID, &item.Name, &item.WorkspaceType, &item.CountryCode, &item.Role, &item.JoinedAt); err != nil {
			writeJSON(w, 500, problem{Error: "workspaces could not be read", RequestID: requestID(r)})
			return
		}
		item.Current = item.ID == p.orgID
		data = append(data, item)
	}
	if err = rows.Err(); err != nil {
		writeJSON(w, 500, problem{Error: "workspaces could not be read", RequestID: requestID(r)})
		return
	}
	writeJSON(w, 200, map[string]any{"data": data})
}
