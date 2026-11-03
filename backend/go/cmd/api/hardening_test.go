package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestClientIPIgnoresForwardingFromUntrustedPeers(t *testing.T) {
	cfg := parseClientIPConfig("", "")
	r := httptest.NewRequest("GET", "/v1/auth/login", nil)
	r.RemoteAddr = "203.0.113.9:4321"
	r.Header.Set("X-Forwarded-For", "198.51.100.7")
	r.Header.Set("X-AegisPay-Client-IP", "198.51.100.8")
	if got := cfg.clientIP(r); got != "203.0.113.9" {
		t.Fatalf("got %s, want TCP peer", got)
	}
}

func TestClientIPUsesRightmostUntrustedForwardedHop(t *testing.T) {
	cfg := parseClientIPConfig("10.0.0.0/8, 172.16.0.5", "")
	r := httptest.NewRequest("GET", "/v1/auth/login", nil)
	r.RemoteAddr = "10.1.2.3:4321"
	// The left-most value is client-controlled; the proxy chain appends.
	r.Header.Set("X-Forwarded-For", "1.1.1.1, 198.51.100.7, 172.16.0.5")
	if got := cfg.clientIP(r); got != "198.51.100.7" {
		t.Fatalf("got %s, want 198.51.100.7", got)
	}
}

func TestClientIPAcceptsProxySecretHeader(t *testing.T) {
	secret := strings.Repeat("s", 40)
	cfg := parseClientIPConfig("", secret)
	r := httptest.NewRequest("GET", "/v1/auth/login", nil)
	r.RemoteAddr = "52.1.2.3:4321"
	r.Header.Set("X-AegisPay-Client-IP", "198.51.100.7")
	r.Header.Set("X-AegisPay-Proxy-Secret", "wrong")
	if got := cfg.clientIP(r); got != "52.1.2.3" {
		t.Fatalf("wrong secret: got %s", got)
	}
	r.Header.Set("X-AegisPay-Proxy-Secret", secret)
	if got := cfg.clientIP(r); got != "198.51.100.7" {
		t.Fatalf("valid secret: got %s", got)
	}
	if parseClientIPConfig("", "short").proxySecret != "" {
		t.Fatal("short proxy secrets must be rejected")
	}
}

func testKey() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func TestKeyRingSeparatesPurposesAndRotates(t *testing.T) {
	k1, k2 := testKey(), testKey()
	old, err := parseKeyRing("k1:"+k1, "")
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := old.seal(purposeWebhookSecret, []byte("whsec"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = old.open(purposeMFASecret, sealed); err == nil {
		t.Fatal("a webhook ciphertext must not open as an MFA secret")
	}
	rotated, err := parseKeyRing("k2:"+k2+",k1:"+k1, "")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := rotated.open(purposeWebhookSecret, sealed)
	if err != nil || string(plain) != "whsec" {
		t.Fatalf("retired key must still open old ciphertexts: %v", err)
	}
	if bytes.HasPrefix(sealed, rotated.activeHeader()) {
		t.Fatal("old ciphertext should be flagged for re-encryption")
	}
	resealed, _ := rotated.seal(purposeWebhookSecret, plain)
	if !bytes.HasPrefix(resealed, rotated.activeHeader()) {
		t.Fatal("new ciphertexts must use the active key")
	}
	only2, _ := parseKeyRing("k2:"+k2, "")
	if _, err = only2.open(purposeWebhookSecret, sealed); err == nil {
		t.Fatal("removed keys must not open ciphertexts")
	}
}

func TestKeyRingKeepsLegacyIDReadableAfterAddingEncryptionKeys(t *testing.T) {
	legacyHex := testKey()
	before, _ := parseKeyRing("", legacyHex)
	sealed, _ := before.seal(purposeMFASecret, []byte("seed"))
	after, err := parseKeyRing("k2:"+testKey(), legacyHex)
	if err != nil || after.activeID != "k2" {
		t.Fatalf("ring: %v %q", err, after.activeID)
	}
	if plain, err := after.open(purposeMFASecret, sealed); err != nil || string(plain) != "seed" {
		t.Fatalf("secrets sealed under the legacy ID must stay readable: %v", err)
	}
}

func TestKeyRingOpensPreVersioningCiphertext(t *testing.T) {
	legacyHex := testKey()
	legacy, _ := hex.DecodeString(legacyHex)
	block, _ := aes.NewCipher(legacy)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	_, _ = rand.Read(nonce)
	old := append(nonce, gcm.Seal(nil, nonce, []byte("JBSWY3DP"), nil)...)

	ring, err := parseKeyRing("", legacyHex)
	if err != nil || ring.activeID != "legacy" {
		t.Fatalf("legacy-only ring: %v %q", err, ring.activeID)
	}
	plain, err := ring.open(purposeMFASecret, old)
	if err != nil || string(plain) != "JBSWY3DP" {
		t.Fatalf("pre-versioning ciphertext must stay readable: %v", err)
	}
	if _, err = parseKeyRing("bad id!:"+legacyHex, ""); err == nil {
		t.Fatal("invalid key IDs must be rejected")
	}
	if _, err = parseKeyRing("", ""); err == nil {
		t.Fatal("an empty key ring must be an error")
	}
}

func TestPublicWebhookIPBlocksNonPublicRanges(t *testing.T) {
	for _, ip := range []string{"100.64.0.1", "100.100.100.200", "10.0.0.1", "127.0.0.1", "169.254.169.254", "198.18.0.1", "192.0.2.1", "::1", "fd00::1", "64:ff9b::a00:1", "2002:a00:1::1", "::ffff:10.0.0.1"} {
		if publicWebhookIP(net.ParseIP(ip)) {
			t.Errorf("%s must be blocked", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !publicWebhookIP(net.ParseIP(ip)) {
			t.Errorf("%s must be allowed", ip)
		}
	}
}

func TestWebhookRetryDelayIsJitteredAndBounded(t *testing.T) {
	for attempt := 1; attempt <= webhookMaxAttempts; attempt++ {
		base := 30 * time.Second << uint(attempt-1)
		if base > 6*time.Hour {
			base = 6 * time.Hour
		}
		for i := 0; i < 20; i++ {
			d := webhookRetryDelay(attempt)
			if d < base/2 || d > base {
				t.Fatalf("attempt %d: delay %s outside [%s, %s]", attempt, d, base/2, base)
			}
		}
	}
}

func TestOnlyOwnersHoldOwnerAuthority(t *testing.T) {
	if !actorIsOwner(principal{role: "owner"}) || !actorIsOwner(principal{bootstrap: true}) {
		t.Fatal("owners and the bootstrap key hold owner authority")
	}
	if actorIsOwner(principal{role: "admin"}) {
		t.Fatal("admins must not change owner or admin memberships")
	}
}

func TestStatementKeyNormalisesDateAndCurrency(t *testing.T) {
	at := time.Date(2026, 3, 1, 23, 30, 0, 0, time.FixedZone("UTC-2", -2*3600))
	if got := statementKey("REF", 100, " usd", at); got != "REF|100|USD|2026-03-02" {
		t.Fatalf("got %s", got)
	}
}

func TestCSVSafeNeutralisesFormulas(t *testing.T) {
	for _, value := range []string{"=HYPERLINK(\"x\")", "+1", "-2", "@SUM(A1)", " \t=1"} {
		if !strings.HasPrefix(csvSafe(value), "'") {
			t.Errorf("%q must be escaped", value)
		}
	}
	if csvSafe("Acme Ltd") != "Acme Ltd" {
		t.Error("plain values must be unchanged")
	}
}

func TestClientIPUsesEdgeHeaderButPrefersProxySecret(t *testing.T) {
	secret := strings.Repeat("s", 40)
	cfg := parseClientIPConfig("", secret)
	cfg.header = "Fly-Client-IP"
	r := httptest.NewRequest("GET", "/v1/auth/login", nil)
	r.RemoteAddr = "[fdaa::3]:4321"
	r.Header.Set("Fly-Client-IP", "52.1.2.3")
	if got := cfg.clientIP(r); got != "52.1.2.3" {
		t.Fatalf("edge header: got %s", got)
	}
	// The dashboard server is the edge client; it reports the browser address.
	r.Header.Set("X-AegisPay-Proxy-Secret", secret)
	r.Header.Set("X-AegisPay-Client-IP", "198.51.100.7")
	if got := cfg.clientIP(r); got != "198.51.100.7" {
		t.Fatalf("proxy secret: got %s", got)
	}
}

func TestEmbeddedOpenAPIMatchesDocs(t *testing.T) {
	docs, err := os.ReadFile("../../../../docs/api/openapi.yaml")
	if err != nil {
		t.Skip("docs/api/openapi.yaml is not available in this build context")
	}
	if !bytes.Equal(docs, openAPISpec) {
		t.Fatal("backend/go/cmd/api/openapi.yaml is out of date; copy docs/api/openapi.yaml over it")
	}
}

func TestDocsEndpointsServeSpecAndSwaggerUI(t *testing.T) {
	rec := httptest.NewRecorder()
	openAPIHandler(rec, httptest.NewRequest("GET", "/openapi.yaml", nil))
	if rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), "openapi: 3.0.3") {
		t.Fatalf("spec: %d %.40q", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	docsHandler(rec, httptest.NewRequest("GET", "/docs", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `url: "/openapi.yaml"`) || !strings.Contains(rec.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatalf("docs page: %d", rec.Code)
	}
}
