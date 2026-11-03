package main

import "net/http"

func (a *App) retryWebhookDelivery(w http.ResponseWriter, r *http.Request, deliveryID string) {
	org := currentOrgID(r, a.orgID)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(r.Context(), `UPDATE webhook_deliveries d
		SET status='queued',attempts=0,next_attempt_at=now(),last_http_status=NULL,last_error=NULL,updated_at=now()
		WHERE d.id=$1 AND d.organization_id=$2 AND d.status='failed'
		AND EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.id=d.endpoint_id AND e.organization_id=d.organization_id AND e.status='active')`, deliveryID, org)
	if err != nil {
		writeJSON(w, 500, problem{Error: "webhook delivery could not be queued"})
		return
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		notFound(w, r)
		return
	}
	p := principalFrom(r)
	_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'webhook.delivery.retried','webhook_delivery',$4,'{}'::jsonb)`, "aud_"+newID(), org, nullable(p.userID), deliveryID)
	if err != nil {
		writeJSON(w, 500, problem{Error: "webhook retry audit could not be recorded"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "webhook retry conflict"})
		return
	}
	writeJSON(w, 202, map[string]any{"id": deliveryID, "status": "queued", "notice": "delivery is queued for another attempt"})
}
