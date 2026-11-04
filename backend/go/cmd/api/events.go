package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// events lists the organization's event log and replays events to webhook
// endpoints.
func (a *App) events(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) == 1 && r.Method == http.MethodGet {
		limit, cursor, err := pagination(r)
		if err != nil {
			bad(w, r, err.Error())
			return
		}
		eventType := strings.TrimSpace(r.URL.Query().Get("type"))
		at, afterID := cursorArgs(cursor)
		rows, err := a.db.QueryContext(r.Context(), `SELECT o.id,o.event_type,o.aggregate_type,o.aggregate_id,o.payload,o.created_at,o.published_at,
			(SELECT count(*) FROM webhook_deliveries d WHERE d.organization_id=o.organization_id AND d.event_id=o.id),
			(SELECT count(*) FROM webhook_deliveries d WHERE d.organization_id=o.organization_id AND d.event_id=o.id AND d.status='delivered')
			FROM outbox_events o WHERE o.organization_id=$1 AND ($2='' OR o.event_type=$2)
			AND ($3::timestamptz IS NULL OR (o.created_at,o.id)<($3,$4))
			ORDER BY o.created_at DESC,o.id DESC LIMIT $5`, org, eventType, at, afterID, limit+1)
		if err != nil {
			writeJSON(w, 500, problem{Error: "events unavailable", RequestID: requestID(r)})
			return
		}
		defer rows.Close()
		data := []map[string]any{}
		for rows.Next() {
			var id, typ, aggregateType, aggregateID string
			var payload []byte
			var created time.Time
			var published sql.NullTime
			var deliveries, delivered int
			if err = rows.Scan(&id, &typ, &aggregateType, &aggregateID, &payload, &created, &published, &deliveries, &delivered); err != nil {
				writeJSON(w, 500, problem{Error: "events unavailable", RequestID: requestID(r)})
				return
			}
			data = append(data, map[string]any{"id": id, "type": typ, "aggregate_type": aggregateType, "aggregate_id": aggregateID, "data": json.RawMessage(payload), "created_at": created, "published_at": nullableTime(published), "deliveries": deliveries, "delivered": delivered})
		}
		more := len(data) > limit
		var next string
		if more {
			data = data[:limit]
			last := data[len(data)-1]
			next = encodeCursor(pageCursor{ID: last["id"].(string), CreatedAt: last["created_at"].(time.Time)})
		}
		pageResponse(w, data, more, next)
		return
	}
	if len(parts) == 3 && parts[2] == "replay" && r.Method == http.MethodPost {
		tx, err := a.db.BeginTx(r.Context(), nil)
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer tx.Rollback()
		var eventType string
		if err = tx.QueryRowContext(r.Context(), `SELECT event_type FROM outbox_events WHERE id=$1 AND organization_id=$2`, parts[1], org).Scan(&eventType); err == sql.ErrNoRows {
			notFound(w, r)
			return
		} else if err != nil {
			writeJSON(w, 500, problem{Error: "event could not be loaded"})
			return
		}
		// Requeue existing deliveries and add deliveries for endpoints
		// subscribed since the event was published.
		res, err := tx.ExecContext(r.Context(), `UPDATE webhook_deliveries d SET status='queued',attempts=0,next_attempt_at=now(),last_http_status=NULL,last_error=NULL,updated_at=now()
			FROM webhook_endpoints e WHERE e.id=d.endpoint_id AND e.organization_id=d.organization_id AND e.status='active' AND d.organization_id=$1 AND d.event_id=$2 AND d.status<>'sending'`, org, parts[1])
		var requeued int64
		if err == nil {
			requeued, _ = res.RowsAffected()
			res, err = tx.ExecContext(r.Context(), `INSERT INTO webhook_deliveries(id,organization_id,endpoint_id,event_id,event_type)
				SELECT 'whd_'||replace(gen_random_uuid()::text,'-',''),$1,w.id,$2,$3 FROM webhook_endpoints w
				WHERE w.organization_id=$1 AND w.status='active' AND w.events ? $3 ON CONFLICT(organization_id,endpoint_id,event_id) DO NOTHING`, org, parts[1], eventType)
		}
		var added int64
		if err == nil {
			added, _ = res.RowsAffected()
			_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'event.replayed','event',$4,jsonb_build_object('deliveries',$5::bigint))`, "aud_"+newID(), org, nullable(principalFrom(r).userID), parts[1], requeued+added)
		}
		if err != nil {
			writeJSON(w, 500, problem{Error: "event could not be replayed", RequestID: requestID(r)})
			return
		}
		if err = tx.Commit(); err != nil {
			writeJSON(w, 409, problem{Error: "event replay conflict"})
			return
		}
		writeJSON(w, 202, map[string]any{"id": parts[1], "deliveries_queued": requeued + added})
		return
	}
	notFound(w, r)
}

// testWebhookEndpoint sends a signed test.ping event to one endpoint only.
func (a *App) testWebhookEndpoint(w http.ResponseWriter, r *http.Request, endpointID string) {
	org := currentOrgID(r, a.orgID)
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	var status string
	if err = tx.QueryRowContext(r.Context(), `SELECT status FROM webhook_endpoints WHERE id=$1 AND organization_id=$2`, endpointID, org).Scan(&status); err == sql.ErrNoRows {
		notFound(w, r)
		return
	} else if err != nil {
		writeJSON(w, 500, problem{Error: "endpoint could not be loaded"})
		return
	}
	if status != "active" {
		writeJSON(w, 409, problem{Error: "endpoint is disabled", RequestID: requestID(r)})
		return
	}
	eventID := "evt_" + newID()
	deliveryID := "whd_" + newID()
	// published_at is set so the outbox worker does not fan the test out to
	// other endpoints.
	_, err = tx.ExecContext(r.Context(), `INSERT INTO outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,payload,published_at) VALUES($1,$2,'webhook_endpoint',$3,'test.ping',jsonb_build_object('message','Test event from AegisPay','endpoint_id',$3::text),now())`, eventID, org, endpointID)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO webhook_deliveries(id,organization_id,endpoint_id,event_id,event_type) VALUES($1,$2,$3,$4,'test.ping')`, deliveryID, org, endpointID, eventID)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "test event could not be queued", RequestID: requestID(r)})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "test event conflict"})
		return
	}
	writeJSON(w, 202, map[string]any{"event_id": eventID, "delivery_id": deliveryID, "status": "queued"})
}

// rotateWebhookSecret replaces an endpoint's signing secret and returns the
// new one once.
func (a *App) rotateWebhookSecret(w http.ResponseWriter, r *http.Request, endpointID string) {
	org := currentOrgID(r, a.orgID)
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		writeJSON(w, 500, problem{Error: "secret generation failed"})
		return
	}
	secret := hex.EncodeToString(raw)
	ciphertext, err := sealSecret(purposeWebhookSecret, secret)
	if err != nil {
		writeJSON(w, 503, problem{Error: "webhook secret encryption is not configured", RequestID: requestID(r)})
		return
	}
	res, err := a.db.ExecContext(r.Context(), `UPDATE webhook_endpoints SET secret_ciphertext=$3 WHERE id=$1 AND organization_id=$2 AND status='active'`, endpointID, org, ciphertext)
	if err != nil {
		writeJSON(w, 500, problem{Error: "signing secret could not be rotated", RequestID: requestID(r)})
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		notFound(w, r)
		return
	}
	a.audit(r, org, "webhook_endpoint.secret_rotated", "webhook_endpoint", endpointID, map[string]any{})
	writeJSON(w, 200, map[string]any{"id": endpointID, "signing_secret": secret, "warning": "the previous secret stopped working; copy this one now, it will not be shown again"})
}
