package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// mailer sends transactional email through Brevo's HTTP API. Without
// BREVO_API_KEY it only logs that an email would have been sent, so local
// development and tests never deliver real mail.
type mailer struct {
	apiKey, from, fromName string
	client                 *http.Client
}

func newMailer() *mailer {
	return &mailer{
		apiKey:   strings.TrimSpace(env("BREVO_API_KEY", "")),
		from:     strings.TrimSpace(env("EMAIL_FROM", "")),
		fromName: strings.TrimSpace(env("EMAIL_FROM_NAME", "AegisPay")),
		client:   &http.Client{Timeout: 15 * time.Second},
	}
}

func (m *mailer) configured() bool { return m != nil && m.apiKey != "" && m.from != "" }

type email struct {
	To, ToName, Subject string
	Heading             string
	Paragraphs          []string
	ActionLabel         string
	ActionURL           string
	Footer              string
}

func (e email) text() string {
	var b strings.Builder
	b.WriteString(e.Heading + "\n\n")
	for _, p := range e.Paragraphs {
		b.WriteString(p + "\n\n")
	}
	if e.ActionURL != "" {
		b.WriteString(e.ActionLabel + ": " + e.ActionURL + "\n\n")
	}
	if e.Footer != "" {
		b.WriteString(e.Footer + "\n")
	}
	return b.String()
}

func (e email) html() string {
	var b strings.Builder
	b.WriteString(`<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">`)
	b.WriteString(`<p style="font-size:13px;color:#64748b;margin:0 0 16px">AegisPay</p>`)
	b.WriteString(`<h1 style="font-size:20px;margin:0 0 16px">` + html.EscapeString(e.Heading) + `</h1>`)
	for _, p := range e.Paragraphs {
		b.WriteString(`<p style="font-size:14px;line-height:1.6;margin:0 0 12px">` + html.EscapeString(p) + `</p>`)
	}
	if e.ActionURL != "" {
		b.WriteString(`<p style="margin:24px 0"><a href="` + html.EscapeString(e.ActionURL) + `" style="background:#5b4bff;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:bold">` + html.EscapeString(e.ActionLabel) + `</a></p>`)
		b.WriteString(`<p style="font-size:12px;color:#64748b;word-break:break-all">Or open: ` + html.EscapeString(e.ActionURL) + `</p>`)
	}
	if e.Footer != "" {
		b.WriteString(`<p style="font-size:12px;color:#64748b;margin-top:24px">` + html.EscapeString(e.Footer) + `</p>`)
	}
	b.WriteString(`</div>`)
	return b.String()
}

func (m *mailer) send(ctx context.Context, e email) error {
	if !m.configured() {
		slog.Info("email not sent: BREVO_API_KEY or EMAIL_FROM is not configured", "subject", e.Subject)
		return nil
	}
	to := map[string]string{"email": e.To}
	if e.ToName != "" {
		to["name"] = e.ToName
	}
	body, _ := json.Marshal(map[string]any{
		"sender":      map[string]string{"email": m.from, "name": m.fromName},
		"to":          []map[string]string{to},
		"subject":     e.Subject,
		"textContent": e.text(),
		"htmlContent": e.html(),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.brevo.com/v3/smtp/email", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("api-key", m.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("email provider returned %d: %s", resp.StatusCode, strings.TrimSpace(string(detail)))
	}
	return nil
}

// sendEmailAsync sends without delaying the API response. Failures are
// logged; callers never depend on delivery.
func (a *App) sendEmailAsync(e email) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := a.mail.send(ctx, e); err != nil {
			slog.Warn("email delivery failed", "subject", e.Subject, "error", err)
		}
	}()
}

// dashboardURL is the public address of the dashboard, used in email links.
func dashboardURL() string {
	return strings.TrimRight(env("DASHBOARD_URL", "http://localhost:3000"), "/")
}
