package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

var webhookEvents = map[string]bool{"collection.succeeded": true, "refund.completed": true, "transfer.completed": true, "transfer.approval_required": true, "transfer.approved": true, "transfer.rejected": true, "fraud.case.opened": true, "fraud.case.resolved": true, "reconciliation.import.completed": true, "reconciliation.line.resolved": true}

var webhookHTTP = &http.Client{
	Timeout:       8 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	Transport: &http.Transport{
		Proxy:                 nil,
		DialContext:           guardedWebhookDial,
		TLSHandshakeTimeout:   4 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       30 * time.Second,
	},
}

// blockedWebhookNets are non-public ranges that the standard library helpers
// do not cover: shared carrier-grade NAT space (used for cloud metadata on
// some providers), benchmarking, documentation, reserved space, and IPv6
// translation prefixes that can embed an internal IPv4 address.
var blockedWebhookNets = mustCIDRs(
	"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15",
	"198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
	"64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/32", "2001:db8::/32", "2002::/16",
)

func mustCIDRs(values ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(values))
	for _, value := range values {
		_, network, err := net.ParseCIDR(value)
		if err != nil {
			panic(err)
		}
		out = append(out, network)
	}
	return out
}

func publicWebhookIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, network := range blockedWebhookNets {
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

func validateWebhookURL(raw string) error {
	u, err := url.ParseRequestURI(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return errors.New("webhook URL must be an HTTPS URL without credentials or a fragment")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, u.Hostname())
	if err != nil || len(ips) == 0 {
		return errors.New("webhook host must resolve to a public IP")
	}
	for _, item := range ips {
		if !publicWebhookIP(item.IP) {
			return errors.New("webhook host resolves to a non-public IP")
		}
	}
	return nil
}

// guardedWebhookDial resolves the host itself and connects only to the vetted
// addresses, so DNS rebinding after registration cannot reach internal hosts.
func guardedWebhookDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, errors.New("webhook host did not resolve")
	}
	for _, item := range ips {
		if !publicWebhookIP(item.IP) {
			return nil, errors.New("webhook DNS resolved to a blocked address")
		}
	}
	dialer := net.Dialer{Timeout: 4 * time.Second}
	var last error
	for _, item := range ips {
		conn, e := dialer.DialContext(ctx, network, net.JoinHostPort(item.IP.String(), port))
		if e == nil {
			return conn, nil
		}
		last = e
	}
	return nil, last
}

func (a *App) webhookEndpoints(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) == 1 && r.Method == http.MethodPost {
		var in struct {
			URL    string   `json:"url"`
			Events []string `json:"events"`
		}
		if decode(r, &in) != nil || len(in.Events) == 0 || len(in.Events) > 20 {
			bad(w, r, "an HTTPS URL and one or more event types are required")
			return
		}
		if err := validateWebhookURL(in.URL); err != nil {
			bad(w, r, err.Error())
			return
		}
		for _, event := range in.Events {
			if !webhookEvents[event] {
				bad(w, r, "unsupported webhook event: "+event)
				return
			}
		}
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
		id := "whk_" + newID()
		_, err = a.db.ExecContext(r.Context(), `INSERT INTO webhook_endpoints(id,organization_id,url,secret_ciphertext,events) VALUES($1,$2,$3,$4,$5::jsonb)`, id, org, in.URL, ciphertext, string(mustJSON(in.Events)))
		if err != nil {
			writeJSON(w, 500, problem{Error: "webhook endpoint could not be registered"})
			return
		}
		writeJSON(w, 201, map[string]any{"id": id, "url": in.URL, "events": in.Events, "status": "active", "signing_secret": secret, "warning": "copy this signing secret now; it will not be shown again"})
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `SELECT id,url,events,status,created_at FROM webhook_endpoints WHERE organization_id=$1 ORDER BY created_at DESC`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer rows.Close()
		data := []map[string]any{}
		for rows.Next() {
			var id, u, status string
			var events []byte
			var created time.Time
			if rows.Scan(&id, &u, &events, &status, &created) == nil {
				var list []string
				_ = json.Unmarshal(events, &list)
				data = append(data, map[string]any{"id": id, "url": u, "events": list, "status": status, "created_at": created})
			}
		}
		writeJSON(w, 200, map[string]any{"data": data})
		return
	}
	if len(parts) == 3 && parts[2] == "disable" && r.Method == http.MethodPost {
		res, err := a.db.ExecContext(r.Context(), `UPDATE webhook_endpoints SET status='disabled' WHERE id=$1 AND organization_id=$2`, parts[1], org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			notFound(w, r)
		} else {
			writeJSON(w, 200, map[string]string{"id": parts[1], "status": "disabled"})
		}
		return
	}
	notFound(w, r)
}

func (a *App) webhookDeliveries(w http.ResponseWriter, r *http.Request) {
	org := currentOrgID(r, a.orgID)
	limit, cursor, err := pagination(r)
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	at, id := cursorArgs(cursor)
	rows, err := a.db.QueryContext(r.Context(), `SELECT id,endpoint_id,event_id,event_type,attempts,status,next_attempt_at,last_http_status,last_error,created_at FROM webhook_deliveries WHERE organization_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3)) ORDER BY created_at DESC,id DESC LIMIT $4`, org, at, id, limit+1)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer rows.Close()
	data := []map[string]any{}
	for rows.Next() {
		var id, endpoint, event, eventType, status string
		var attempts int
		var next, created time.Time
		var code sql.NullInt64
		var last sql.NullString
		if rows.Scan(&id, &endpoint, &event, &eventType, &attempts, &status, &next, &code, &last, &created) == nil {
			data = append(data, map[string]any{"id": id, "endpoint_id": endpoint, "event_id": event, "event_type": eventType, "attempt_count": attempts, "status": status, "next_attempt_at": next, "last_http_status": nullableInt(code), "last_error": nullableNull(last), "created_at": created})
		}
	}
	more := len(data) > limit
	var nextCursor string
	if more {
		data = data[:limit]
		last := data[len(data)-1]
		nextCursor = encodeCursor(pageCursor{ID: last["id"].(string), CreatedAt: last["created_at"].(time.Time)})
	}
	pageResponse(w, data, more, nextCursor)
}

func nullableInt(v sql.NullInt64) any {
	if !v.Valid {
		return nil
	}
	return v.Int64
}

const (
	webhookMaxAttempts = 12
	// webhookPerEndpointBatch caps how many deliveries for one endpoint are
	// claimed together, so a slow endpoint cannot take every worker.
	webhookPerEndpointBatch = 4
)

func envInt(key string, fallback, minValue, maxValue int) int {
	value, err := strconv.Atoi(env(key, ""))
	if err != nil {
		return fallback
	}
	return max(minValue, min(maxValue, value))
}

// runOutboxWorker publishes outbox events to webhook deliveries in batches and
// sends deliveries with a bounded worker pool. Rows are claimed with
// SKIP LOCKED, so several API replicas can run the worker concurrently.
func (a *App) runOutboxWorker(ctx context.Context) {
	concurrency := envInt("WEBHOOK_WORKER_CONCURRENCY", 16, 1, 256)
	batch := envInt("OUTBOX_BATCH_SIZE", 200, 1, 5000)
	slots := make(chan struct{}, concurrency)
	for {
		if ctx.Err() != nil {
			return
		}
		published, err := a.publishOutboxBatch(ctx, batch)
		if err != nil {
			slog.Error("outbox publish", "error", err)
		}
		claimed := 0
		if free := concurrency - len(slots); free > 0 {
			deliveries, err := a.claimDeliveries(ctx, free)
			if err != nil {
				slog.Error("webhook claim", "error", err)
			}
			claimed = len(deliveries)
			for _, d := range deliveries {
				slots <- struct{}{}
				go func(d claimedDelivery) {
					defer func() { <-slots }()
					if err := a.deliverWebhook(ctx, d); err != nil {
						slog.Error("webhook delivery", "delivery_id", d.id, "error", err)
					}
				}(d)
			}
		}
		if published < batch && claimed == 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
		}
	}
}

func (a *App) publishOutboxBatch(ctx context.Context, limit int) (int, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`, limit)
	if err != nil {
		return 0, err
	}
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			_ = rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	if err = rows.Close(); err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, nil
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO webhook_deliveries(id,organization_id,endpoint_id,event_id,event_type)
		SELECT 'whd_'||replace(gen_random_uuid()::text,'-',''),o.organization_id,w.id,o.id,o.event_type
		FROM outbox_events o JOIN webhook_endpoints w ON w.organization_id=o.organization_id AND w.status='active' AND w.events ? o.event_type
		WHERE o.id=ANY($1)
		ON CONFLICT(organization_id,endpoint_id,event_id) DO NOTHING`, ids); err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE outbox_events SET published_at=now() WHERE id=ANY($1)`, ids); err != nil {
		return 0, err
	}
	return len(ids), tx.Commit()
}

type claimedDelivery struct {
	id, endpointID, eventID, eventType, url string
	secretCipher                            []byte
	payload                                 []byte
	created                                 time.Time
	attempt                                 int
}

// claimDeliveries marks up to limit due deliveries as sending. Deliveries
// stuck in sending for two minutes (a worker crashed mid-request) are due
// again.
func (a *App) claimDeliveries(ctx context.Context, limit int) ([]claimedDelivery, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Window functions cannot be combined with FOR UPDATE, so candidates are
	// chosen first and then locked; rows taken by another worker are skipped.
	rows, err := tx.QueryContext(ctx, `WITH candidates AS (
			SELECT id FROM (
				SELECT d.id,d.next_attempt_at,row_number() OVER (PARTITION BY d.endpoint_id ORDER BY d.next_attempt_at) AS rank
				FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id=d.endpoint_id AND w.organization_id=d.organization_id
				WHERE w.status='active' AND ((d.status IN ('queued','retrying') AND d.next_attempt_at<=now()) OR (d.status='sending' AND d.updated_at<now()-interval '2 minutes'))
			) ranked WHERE rank<=$2 ORDER BY next_attempt_at LIMIT $1
		), locked AS (
			SELECT d.id FROM webhook_deliveries d JOIN candidates c ON c.id=d.id
			WHERE (d.status IN ('queued','retrying') AND d.next_attempt_at<=now()) OR (d.status='sending' AND d.updated_at<now()-interval '2 minutes')
			FOR UPDATE OF d SKIP LOCKED
		)
		UPDATE webhook_deliveries d SET status='sending',attempts=d.attempts+1,updated_at=now()
		FROM locked l, webhook_endpoints w, outbox_events o
		WHERE d.id=l.id AND w.id=d.endpoint_id AND w.organization_id=d.organization_id AND o.id=d.event_id AND o.organization_id=d.organization_id
		RETURNING d.id,d.endpoint_id,d.event_id,d.event_type,d.attempts,w.url,w.secret_ciphertext,o.payload,o.created_at`, limit, webhookPerEndpointBatch)
	if err != nil {
		return nil, err
	}
	out := make([]claimedDelivery, 0, limit)
	for rows.Next() {
		var d claimedDelivery
		if err = rows.Scan(&d.id, &d.endpointID, &d.eventID, &d.eventType, &d.attempt, &d.url, &d.secretCipher, &d.payload, &d.created); err != nil {
			_ = rows.Close()
			return nil, err
		}
		out = append(out, d)
	}
	if err = rows.Close(); err != nil {
		return nil, err
	}
	return out, tx.Commit()
}

// webhookRetryDelay grows from 30 seconds to a six-hour ceiling, spreading
// twelve attempts over about a day. Each delay is randomised between half and
// the full value so many failed deliveries do not retry in lockstep.
func webhookRetryDelay(attempt int) time.Duration {
	base := 30 * time.Second << uint(min(max(attempt-1, 0), 20))
	if ceiling := 6 * time.Hour; base > ceiling || base <= 0 {
		base = ceiling
	}
	half := int64(base / 2)
	jitter, err := rand.Int(rand.Reader, big.NewInt(half+1))
	if err != nil {
		return base
	}
	return time.Duration(half + jitter.Int64())
}

func (a *App) deliverWebhook(ctx context.Context, d claimedDelivery) error {
	secret, err := openSecret(purposeWebhookSecret, d.secretCipher)
	var statusCode int
	if err == nil {
		var data json.RawMessage = d.payload
		envelope, _ := json.Marshal(map[string]any{"id": d.eventID, "type": d.eventType, "created_at": d.created, "data": data})
		timestamp := time.Now().UTC().Unix()
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write([]byte(strconv.FormatInt(timestamp, 10) + "."))
		_, _ = mac.Write(envelope)
		signature := hex.EncodeToString(mac.Sum(nil))
		var req *http.Request
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, d.url, bytes.NewReader(envelope))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("User-Agent", "AegisPay-Webhooks/1")
			req.Header.Set("X-AegisPay-Event-ID", d.eventID)
			req.Header.Set("X-AegisPay-Delivery-Attempt", strconv.Itoa(d.attempt))
			req.Header.Set("X-AegisPay-Timestamp", strconv.FormatInt(timestamp, 10))
			req.Header.Set("X-AegisPay-Signature", "v1="+signature)
			var resp *http.Response
			resp, err = webhookHTTP.Do(req)
			if err == nil {
				statusCode = resp.StatusCode
				_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
				_ = resp.Body.Close()
				if statusCode < 200 || statusCode >= 300 {
					err = errors.New("endpoint returned non-success status")
				}
			}
		}
	}
	nextStatus := "delivered"
	var deliveryErr string
	var nextAttempt any
	if err != nil {
		deliveryErr = err.Error()
		if d.attempt >= webhookMaxAttempts {
			nextStatus = "failed"
		} else {
			nextStatus = "retrying"
			nextAttempt = time.Now().Add(webhookRetryDelay(d.attempt))
		}
		slog.Warn("webhook endpoint delivery failed", "delivery_id", d.id, "attempt", d.attempt, "error", deliveryErr)
	}
	// Use a fresh context so a shutdown does not leave the row in sending.
	updateCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, dbErr := a.db.ExecContext(updateCtx, `UPDATE webhook_deliveries SET status=$2,last_http_status=NULLIF($3,0),last_error=NULLIF($4,''),next_attempt_at=COALESCE($5,next_attempt_at),updated_at=now() WHERE id=$1`, d.id, nextStatus, statusCode, deliveryErr, nextAttempt)
	return dbErr
}
