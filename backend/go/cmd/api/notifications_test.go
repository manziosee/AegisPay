package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateChannelURLAcceptsOnlyOfficialWebhookHosts(t *testing.T) {
	good := map[string]string{
		"slack":       "https://hooks.slack.com/services/T000/B000/XXXX",
		"discord":     "https://discord.com/api/webhooks/123/abc",
		"google_chat": "https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t",
		"teams":       "https://contoso.webhook.office.com/webhookb2/abc",
	}
	for kind, link := range good {
		if err := validateChannelURL(kind, link); err != nil {
			t.Errorf("%s: %v", kind, err)
		}
	}
	if err := validateChannelURL("teams", "https://prod-12.westus.logic.azure.com:443/workflows/x/triggers/manual/paths/invoke"); err != nil {
		t.Errorf("teams workflows: %v", err)
	}
	bad := map[string]string{
		"slack":       "https://evil.example.com/services/x",
		"discord":     "https://discord.com/channels/123",
		"google_chat": "http://chat.googleapis.com/v1/spaces/AAA/messages",
		"teams":       "https://webhook.office.com.evil.com/x",
		"email":       "https://hooks.slack.com/services/x",
	}
	for kind, link := range bad {
		if err := validateChannelURL(kind, link); err == nil {
			t.Errorf("%s %s must be refused", kind, link)
		}
	}
	if err := validateChannelURL("slack", "https://user:pass@hooks.slack.com/services/x"); err == nil {
		t.Error("credentials in the URL must be refused")
	}
}

func TestFormatMinorAmount(t *testing.T) {
	cases := map[string]string{
		formatMinorAmount(120050, "eur"):    "1,200.50 EUR",
		formatMinorAmount(1500000, "RWF"):   "1,500,000 RWF",
		formatMinorAmount(5, "KWD"):         "0.005 KWD",
		formatMinorAmount(-99, "USD"):       "-0.99 USD",
		formatMinorAmount(100000000, "KES"): "1,000,000.00 KES",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("got %q want %q", got, want)
		}
	}
}

func TestDescribeEventAndChatPayloads(t *testing.T) {
	m := describeEvent("transfer.approval_required", map[string]any{"amount": float64(250000), "currency": "USD"}, "Acme")
	if m.Title != "Transfer needs approval" || !strings.Contains(m.Body, "2,500.00 USD") || !strings.HasSuffix(m.Link, "/app/approvals") {
		t.Fatalf("unexpected message: %+v", m)
	}
	recon := describeEvent("reconciliation.import.completed", map[string]any{"matched_count": float64(9), "exception_count": float64(1)}, "Acme")
	if !strings.Contains(recon.Body, "9 lines matched, 1 need review") {
		t.Fatalf("unexpected reconciliation message: %+v", recon)
	}
	for _, kind := range []string{"slack", "discord", "google_chat", "teams"} {
		raw, err := chatPayload(kind, m)
		if err != nil || !json.Valid(raw) || !strings.Contains(string(raw), "Transfer needs approval") {
			t.Errorf("%s payload invalid: %s %v", kind, raw, err)
		}
	}
	discord, _ := chatPayload("discord", chatMessage{Title: "@everyone", Body: "x", Link: "y"})
	if !strings.Contains(string(discord), `"allowed_mentions"`) {
		t.Error("discord messages must not ping @everyone")
	}
	if urlHint("https://hooks.slack.com/services/T000/B000/SECRETVALUE") != "hooks.slack.com/…ALUE" {
		t.Errorf("hint must not expose the secret path: %s", urlHint("https://hooks.slack.com/services/T000/B000/SECRETVALUE"))
	}
}

func TestEmailRenderingEscapesContent(t *testing.T) {
	e := email{Heading: "Hi <b>", Paragraphs: []string{"a & b"}, ActionLabel: "Go", ActionURL: "https://x/reset?token=a&b=1"}
	html := e.html()
	if strings.Contains(html, "<b>") || !strings.Contains(html, "&lt;b&gt;") || !strings.Contains(html, "a &amp; b") {
		t.Fatalf("html not escaped: %s", html)
	}
	if !strings.Contains(e.text(), "Go: https://x/reset?token=a&b=1") {
		t.Fatalf("text version missing link: %s", e.text())
	}
	if (&mailer{}).configured() {
		t.Fatal("a mailer without a key must not be configured")
	}
}
