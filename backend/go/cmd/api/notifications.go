package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const purposeChannelURL = "notification-channel-url"

// Team chat notifications: the customer pastes an incoming-webhook URL from
// Slack, Microsoft Teams, Discord or Google Chat. Only each platform's own
// webhook hosts are accepted, and delivery goes through the guarded HTTP
// client that refuses private addresses.

var channelKinds = map[string]string{"slack": "Slack", "teams": "Microsoft Teams", "discord": "Discord", "google_chat": "Google Chat"}

var defaultChannelEvents = []string{"transfer.approval_required", "transfer.rejected", "fraud.case.opened", "reconciliation.import.completed"}

func validateChannelURL(kind, raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" {
		return errors.New("the webhook URL must be an https:// link copied from your chat app")
	}
	host := strings.ToLower(u.Hostname())
	ok := false
	switch kind {
	case "slack":
		ok = host == "hooks.slack.com" && strings.HasPrefix(u.Path, "/services/")
	case "discord":
		ok = (host == "discord.com" || host == "discordapp.com" || host == "ptb.discord.com" || host == "canary.discord.com") && strings.HasPrefix(u.Path, "/api/webhooks/")
	case "google_chat":
		ok = host == "chat.googleapis.com" && strings.HasPrefix(u.Path, "/v1/spaces/")
	case "teams":
		// Teams incoming webhooks (webhook.office.com) and Teams Workflows
		// webhooks (Power Automate / Logic Apps hosts).
		ok = strings.HasSuffix(host, ".webhook.office.com") || strings.HasSuffix(host, ".logic.azure.com") || strings.HasSuffix(host, ".powerplatform.com")
	default:
		return errors.New("kind must be slack, teams, discord or google_chat")
	}
	if !ok {
		return fmt.Errorf("that is not a %s incoming-webhook link", channelKinds[kind])
	}
	return nil
}

func urlHint(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	tail := u.Path
	if len(tail) > 4 {
		tail = tail[len(tail)-4:]
	}
	return u.Hostname() + "/…" + tail
}

type chatMessage struct{ Title, Body, Link string }

// describeEvent turns an outbox event into a short human message.
func describeEvent(eventType string, payload map[string]any, workspace string) chatMessage {
	amount := ""
	if v, ok := payload["amount"].(float64); ok {
		if c, ok := payload["currency"].(string); ok {
			amount = formatMinorAmount(int64(v), c)
		}
	}
	str := func(key string) string { v, _ := payload[key].(string); return v }
	base := dashboardURL()
	m := chatMessage{Title: eventType, Link: base + "/app"}
	switch eventType {
	case "transfer.approval_required":
		m = chatMessage{"Transfer needs approval", fmt.Sprintf("A transfer of %s in %s is waiting for a second reviewer.", amount, workspace), base + "/app/approvals"}
	case "transfer.completed":
		m = chatMessage{"Transfer completed", fmt.Sprintf("A transfer of %s was posted in %s.", amount, workspace), base + "/app/payments"}
	case "transfer.approved":
		m = chatMessage{"Transfer approved", "A transfer in " + workspace + " received its final approval and was posted.", base + "/app/payments"}
	case "transfer.rejected":
		m = chatMessage{"Transfer rejected", "A reviewer rejected a transfer in " + workspace + ".", base + "/app/payments"}
	case "collection.succeeded":
		m = chatMessage{"Payment received", fmt.Sprintf("A collection of %s was confirmed in %s.", amount, workspace), base + "/app/payments"}
	case "refund.completed":
		m = chatMessage{"Refund posted", fmt.Sprintf("A refund of %s was posted in %s.", amount, workspace), base + "/app/payments"}
	case "fraud.case.opened":
		m = chatMessage{"Risk case opened", fmt.Sprintf("A %s-priority risk case was opened in %s and needs review.", firstNonEmpty(str("priority"), "new"), workspace), base + "/app/intelligence"}
	case "fraud.case.resolved":
		m = chatMessage{"Risk case resolved", fmt.Sprintf("A risk case in %s was resolved (%s).", workspace, strings.ReplaceAll(firstNonEmpty(str("outcome"), "closed"), "_", " ")), base + "/app/intelligence"}
	case "reconciliation.import.completed":
		matched, _ := payload["matched_count"].(float64)
		exceptions, _ := payload["exception_count"].(float64)
		m = chatMessage{"Bank statement imported", fmt.Sprintf("%s: %.0f lines matched, %.0f need review.", workspace, matched, exceptions), base + "/app/reconciliation"}
	case "reconciliation.line.resolved":
		m = chatMessage{"Reconciliation exception resolved", "A statement line in " + workspace + " was resolved.", base + "/app/reconciliation"}
	case "test.notification":
		m = chatMessage{"AegisPay is connected", "This channel will receive AegisPay notifications for " + workspace + ".", base + "/app"}
	}
	return m
}

func chatPayload(kind string, m chatMessage) ([]byte, error) {
	switch kind {
	case "slack":
		return json.Marshal(map[string]any{"text": fmt.Sprintf("*%s*\n%s\n<%s|Open in AegisPay>", m.Title, m.Body, m.Link)})
	case "discord":
		return json.Marshal(map[string]any{"content": fmt.Sprintf("**%s**\n%s\n%s", m.Title, m.Body, m.Link), "allowed_mentions": map[string]any{"parse": []string{}}})
	case "google_chat":
		return json.Marshal(map[string]any{"text": fmt.Sprintf("*%s*\n%s\n%s", m.Title, m.Body, m.Link)})
	case "teams":
		return json.Marshal(map[string]any{"type": "message", "attachments": []any{map[string]any{
			"contentType": "application/vnd.microsoft.card.adaptive",
			"content": map[string]any{
				"$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard", "version": "1.4",
				"body": []any{
					map[string]any{"type": "TextBlock", "text": m.Title, "weight": "Bolder", "size": "Medium", "wrap": true},
					map[string]any{"type": "TextBlock", "text": m.Body, "wrap": true},
				},
				"actions": []any{map[string]any{"type": "Action.OpenUrl", "title": "Open in AegisPay", "url": m.Link}},
			},
		}}})
	}
	return nil, errors.New("unknown channel kind")
}

func (a *App) postToChannel(ctx context.Context, channelID, kind string, ciphertext []byte, m chatMessage) error {
	target, err := openSecret(purposeChannelURL, ciphertext)
	if err == nil {
		err = validateChannelURL(kind, target)
	}
	var body []byte
	if err == nil {
		body, err = chatPayload(kind, m)
	}
	if err == nil {
		var req *http.Request
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("User-Agent", "AegisPay-Notifications/1")
			var resp *http.Response
			resp, err = webhookHTTP.Do(req)
			if err == nil {
				detail, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
				_ = resp.Body.Close()
				if resp.StatusCode < 200 || resp.StatusCode >= 300 {
					err = fmt.Errorf("%s returned HTTP %d: %s", channelKinds[kind], resp.StatusCode, strings.TrimSpace(string(detail)))
				}
			}
		}
	}
	updateCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err != nil {
		_, _ = a.db.ExecContext(updateCtx, `UPDATE notification_channels SET last_error=$2 WHERE id=$1`, channelID, truncateReference(err.Error()))
		return err
	}
	_, _ = a.db.ExecContext(updateCtx, `UPDATE notification_channels SET last_error=NULL,last_delivered_at=now() WHERE id=$1`, channelID)
	return nil
}

// runNotificationWorker offers each new outbox event once to the matching
// chat channels. Delivery is best effort: chat messages are alerts, while
// signed webhooks remain the reliable integration channel.
func (a *App) runNotificationWorker(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		n, err := a.notifyBatch(ctx)
		if err != nil {
			slog.Error("chat notifications", "error", err)
		}
		if n == 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
	}
}

func (a *App) notifyBatch(ctx context.Context) (int, error) {
	// Events of organizations without active channels need no work.
	if _, err := a.db.ExecContext(ctx, `UPDATE outbox_events o SET notified_at=now() WHERE o.notified_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM notification_channels c WHERE c.organization_id=o.organization_id AND c.status='active')`); err != nil {
		return 0, err
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT o.id,o.organization_id,o.event_type,o.payload,COALESCE(g.name,'') FROM outbox_events o
		LEFT JOIN organizations g ON g.id=o.organization_id
		WHERE o.notified_at IS NULL ORDER BY o.created_at LIMIT 50 FOR UPDATE OF o SKIP LOCKED`)
	if err != nil {
		return 0, err
	}
	type pending struct {
		id, org, eventType, workspace string
		payload                       map[string]any
	}
	batch := []pending{}
	for rows.Next() {
		var p pending
		var raw []byte
		if err = rows.Scan(&p.id, &p.org, &p.eventType, &raw, &p.workspace); err != nil {
			_ = rows.Close()
			return 0, err
		}
		_ = json.Unmarshal(raw, &p.payload)
		batch = append(batch, p)
	}
	if err = rows.Close(); err != nil || len(batch) == 0 {
		return 0, err
	}
	ids := make([]string, len(batch))
	for i, p := range batch {
		ids[i] = p.id
	}
	if _, err = tx.ExecContext(ctx, `UPDATE outbox_events SET notified_at=now() WHERE id=ANY($1)`, ids); err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	for _, p := range batch {
		channels, err := a.db.QueryContext(ctx, `SELECT id,kind,url_ciphertext FROM notification_channels WHERE organization_id=$1 AND status='active' AND events ? $2`, p.org, p.eventType)
		if err != nil {
			return len(batch), err
		}
		type target struct {
			id, kind string
			cipher   []byte
		}
		targets := []target{}
		for channels.Next() {
			var t target
			if channels.Scan(&t.id, &t.kind, &t.cipher) == nil {
				targets = append(targets, t)
			}
		}
		_ = channels.Close()
		message := describeEvent(p.eventType, p.payload, p.workspace)
		for _, t := range targets {
			sendCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			if err := a.postToChannel(sendCtx, t.id, t.kind, t.cipher, message); err != nil {
				slog.Warn("chat notification failed", "channel_id", t.id, "event", p.eventType, "error", err)
			}
			cancel()
		}
	}
	return len(batch), nil
}

func (a *App) notificationChannels(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		rows, err := a.db.QueryContext(r.Context(), `SELECT id,kind,name,url_hint,events,status,last_delivered_at,COALESCE(last_error,''),created_at FROM notification_channels WHERE organization_id=$1 ORDER BY created_at DESC`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "notification channels unavailable", RequestID: requestID(r)})
			return
		}
		defer rows.Close()
		data := []map[string]any{}
		for rows.Next() {
			var id, kind, name, hint, status, lastError string
			var events []byte
			var delivered sql.NullTime
			var created time.Time
			if rows.Scan(&id, &kind, &name, &hint, &events, &status, &delivered, &lastError, &created) != nil {
				continue
			}
			list := []string{}
			_ = json.Unmarshal(events, &list)
			data = append(data, map[string]any{"id": id, "kind": kind, "name": name, "url_hint": hint, "events": list, "status": status, "last_delivered_at": nullableTime(delivered), "last_error": nullable(lastError), "created_at": created})
		}
		writeJSON(w, 200, map[string]any{"data": data, "kinds": channelKinds})
	case len(parts) == 1 && r.Method == http.MethodPost:
		var in struct {
			Kind   string   `json:"kind"`
			Name   string   `json:"name"`
			URL    string   `json:"url"`
			Events []string `json:"events"`
		}
		if decode(r, &in) != nil {
			bad(w, r, "kind, name, url and events are required")
			return
		}
		in.Name = strings.TrimSpace(in.Name)
		if _, ok := channelKinds[in.Kind]; !ok {
			bad(w, r, "kind must be slack, teams, discord or google_chat")
			return
		}
		if in.Name == "" {
			in.Name = channelKinds[in.Kind]
		}
		if len(in.Name) > 80 {
			bad(w, r, "name must be at most 80 characters")
			return
		}
		if err := validateChannelURL(in.Kind, in.URL); err != nil {
			bad(w, r, err.Error())
			return
		}
		if len(in.Events) == 0 {
			in.Events = defaultChannelEvents
		}
		for _, event := range in.Events {
			if !webhookEvents[event] {
				bad(w, r, "unsupported event: "+event)
				return
			}
		}
		cipher, err := sealSecret(purposeChannelURL, strings.TrimSpace(in.URL))
		if err != nil {
			writeJSON(w, 503, problem{Error: "encryption is not configured", RequestID: requestID(r)})
			return
		}
		id := "nch_" + newID()
		_, err = a.db.ExecContext(r.Context(), `INSERT INTO notification_channels(id,organization_id,kind,name,url_ciphertext,url_hint,events,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
			id, org, in.Kind, in.Name, cipher, urlHint(in.URL), string(mustJSON(in.Events)), nullable(principalFrom(r).userID))
		if err != nil {
			writeJSON(w, 500, problem{Error: "notification channel could not be saved", RequestID: requestID(r)})
			return
		}
		a.audit(r, org, "notification_channel.created", "notification_channel", id, map[string]any{"kind": in.Kind, "name": in.Name})
		writeJSON(w, 201, map[string]any{"id": id, "kind": in.Kind, "name": in.Name, "url_hint": urlHint(in.URL), "events": in.Events, "status": "active"})
	case len(parts) == 3 && parts[2] == "test" && r.Method == http.MethodPost:
		var kind, workspace string
		var cipher []byte
		err := a.db.QueryRowContext(r.Context(), `SELECT c.kind,c.url_ciphertext,o.name FROM notification_channels c JOIN organizations o ON o.id=c.organization_id WHERE c.id=$1 AND c.organization_id=$2`, parts[1], org).Scan(&kind, &cipher, &workspace)
		if err == sql.ErrNoRows {
			notFound(w, r)
			return
		}
		if err != nil {
			writeJSON(w, 500, problem{Error: "notification channel could not be loaded"})
			return
		}
		if err = a.postToChannel(r.Context(), parts[1], kind, cipher, describeEvent("test.notification", nil, workspace)); err != nil {
			writeJSON(w, 502, problem{Error: "test message failed: " + err.Error(), RequestID: requestID(r)})
			return
		}
		writeJSON(w, 200, map[string]string{"id": parts[1], "status": "delivered"})
	case len(parts) == 2 && r.Method == http.MethodDelete:
		res, err := a.db.ExecContext(r.Context(), `DELETE FROM notification_channels WHERE id=$1 AND organization_id=$2`, parts[1], org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "notification channel could not be removed"})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			notFound(w, r)
			return
		}
		a.audit(r, org, "notification_channel.deleted", "notification_channel", parts[1], map[string]any{})
		writeJSON(w, 200, map[string]string{"id": parts[1], "status": "deleted"})
	default:
		notFound(w, r)
	}
}
