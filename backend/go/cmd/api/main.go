package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/redis/go-redis/v9"
)

//go:embed migrations/*.sql
var migrations embed.FS

type App struct {
	db                   *sql.DB
	redis                *redis.Client
	orgID, apiKey        string
	requestsPerMinute    int
	registrationsPerHour int
	mail                 *mailer
}
type problem struct {
	Error     string `json:"error"`
	RequestID string `json:"request_id,omitempty"`
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		resp, err := (&http.Client{Timeout: 2 * time.Second}).Get("http://127.0.0.1" + env("HTTP_ADDR", ":8080") + "/health/ready")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		_ = resp.Body.Close()
		os.Exit(0)
	}
	dsn := os.Getenv("DATABASE_URL")
	key := os.Getenv("AEGIS_API_KEY")
	org := os.Getenv("AEGIS_ORGANIZATION_ID")
	if dsn == "" || key == "" || org == "" {
		slog.Error("DATABASE_URL, AEGIS_API_KEY and AEGIS_ORGANIZATION_ID are required")
		os.Exit(1)
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		slog.Error("database setup", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if len(os.Args) > 2 && os.Args[1] == "seed-sample-data" {
		seedCtx, seedCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer seedCancel()
		runSeedCommand(seedCtx, db, os.Args[2:])
		return
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err = db.PingContext(ctx); err != nil {
		slog.Error("database unavailable", "error", err)
		os.Exit(1)
	}
	redisOptions, err := redis.ParseURL(os.Getenv("REDIS_URL"))
	if err != nil {
		slog.Error("REDIS_URL is required", "error", err)
		os.Exit(1)
	}
	redisClient := redis.NewClient(redisOptions)
	if err = redisClient.Ping(ctx).Err(); err != nil {
		slog.Error("Redis unavailable", "error", err)
		os.Exit(1)
	}
	defer redisClient.Close()
	a := &App{db: db, redis: redisClient, orgID: org, apiKey: key, requestsPerMinute: envInt("RATE_LIMIT_PER_MINUTE", 600, 10, 100000), registrationsPerHour: envInt("REGISTER_LIMIT_PER_HOUR", 20, 1, 100000), mail: newMailer()}
	if err = runMigrations(ctx, db); err != nil {
		slog.Error("schema migration", "error", err)
		os.Exit(1)
	}
	if err = a.bootstrap(ctx); err != nil {
		slog.Error("bootstrap", "error", err)
		os.Exit(1)
	}
	if os.Getenv("ENCRYPTION_KEYS") != "" || os.Getenv("WEBHOOK_ENCRYPTION_KEY") != "" {
		if _, err = loadKeyRing(); err != nil {
			slog.Error("secret encryption keys", "error", err)
			os.Exit(1)
		}
	} else {
		slog.Warn("no ENCRYPTION_KEYS configured; webhook endpoints and MFA enrollment are unavailable")
	}
	_ = loadClientIPConfig()
	go a.runOutboxWorker(context.Background())
	go a.runMaintenance(context.Background())
	go a.runNotificationWorker(context.Background())
	if !a.mail.configured() {
		slog.Warn("email is not configured (BREVO_API_KEY, EMAIL_FROM); invitation, password reset and approval emails are logged only")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /health/ready", a.ready)
	mux.HandleFunc("GET /metrics", metricsHandler)
	mux.HandleFunc("GET /openapi.yaml", openAPIHandler)
	mux.HandleFunc("GET /docs", docsHandler)
	mux.HandleFunc("POST /v1/auth/register", a.register)
	mux.HandleFunc("POST /v1/auth/login", a.login)
	mux.HandleFunc("POST /v1/auth/mfa/verify-login", a.verifyMFALogin)
	mux.HandleFunc("POST /v1/auth/password/forgot", a.forgotPassword)
	mux.HandleFunc("POST /v1/auth/password/reset", a.resetPassword)
	mux.HandleFunc("POST /v1/auth/email/verify", a.verifyEmail)
	mux.Handle("/v1/", a.authenticate(http.HandlerFunc(a.route)))
	addr := env("HTTP_ADDR", ":8080")
	server := &http.Server{Addr: addr, Handler: requestIDs(securityHeaders(metrics(cors(a.rateLimit(mux))))), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	slog.Info("AegisPay API listening", "address", addr, "organization", org)
	if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("http server", "error", err)
		os.Exit(1)
	}
}
func runMigrations(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	files, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(files)
	for _, name := range files {
		version := strings.TrimSuffix(strings.TrimPrefix(name, "migrations/"), ".sql")
		var exists bool
		if err = db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)`, version).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		body, err := migrations.ReadFile(name)
		if err != nil {
			return err
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, string(body)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration %s: %w", version, err)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO schema_migrations(version) VALUES($1)`, version); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func (a *App) bootstrap(ctx context.Context) error {
	_, err := a.db.ExecContext(ctx, `INSERT INTO organizations(id,name,slug) VALUES($1,'AegisPay Sandbox','aegispay-sandbox') ON CONFLICT(id) DO NOTHING`, a.orgID)
	return err
}
func (a *App) ready(w http.ResponseWriter, r *http.Request) {
	if err := a.db.PingContext(r.Context()); err != nil {
		writeJSON(w, 503, problem{Error: "database unavailable"})
		return
	}
	if a.redis != nil {
		if err := a.redis.Ping(r.Context()).Err(); err != nil {
			writeJSON(w, 503, problem{Error: "rate limiting service unavailable"})
			return
		}
	}
	writeJSON(w, 200, map[string]string{"status": "ready"})
}
func requestIDs(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !validRequestID(id) {
			id = "req_" + newID()
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
}
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allowed := env("SWAGGER_ORIGIN", "http://localhost:8081")
		if origin != "" && origin == allowed {
			w.Header().Set("Access-Control-Allow-Origin", allowed)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Organization-ID, X-Request-ID")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

type requestIDKey struct{}

func requestID(r *http.Request) string { v, _ := r.Context().Value(requestIDKey{}).(string); return v }
func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(b)
}
func validRequestID(v string) bool {
	if len(v) < 1 || len(v) > 128 {
		return false
	}
	for _, c := range v {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func decode(r *http.Request, dst any) error { return decodeWithLimit(r, dst, 1<<20) }

// decodeWithLimit reads a JSON body of at most limit bytes into dst and
// records the request hash used for idempotency.
func decodeWithLimit(r *http.Request, dst any, limit int) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, int64(limit)+1))
	_ = r.Body.Close()
	if err != nil {
		return err
	}
	if len(body) > limit {
		return fmt.Errorf("request body exceeds %d bytes", limit)
	}
	fingerprint := r.Method + "\n" + r.URL.EscapedPath() + "\n"
	hash := sha256.Sum256(append([]byte(fingerprint), body...))
	*r = *r.WithContext(context.WithValue(r.Context(), bodyHashContextKey{}, hex.EncodeToString(hash[:])))
	r.Body = io.NopCloser(bytes.NewReader(body))
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}

// decodeOptional is decode for endpoints whose body may be omitted entirely.
func decodeOptional(r *http.Request, dst any) error {
	if err := decode(r, dst); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}
func (a *App) route(w http.ResponseWriter, r *http.Request) {
	p := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/"), "/")
	seg := strings.Split(p, "/")
	switch seg[0] {
	case "auth":
		if len(seg) == 2 && seg[1] == "me" && r.Method == "GET" {
			p := principalFrom(r)
			out := map[string]any{"organization_id": currentOrgID(r, a.orgID), "user_id": p.userID, "role": p.role, "credential_type": map[bool]string{true: "bootstrap", false: "user"}[p.bootstrap]}
			if p.sessionID != "" {
				var name, email string
				var expires time.Time
				var verified bool
				if err := a.db.QueryRowContext(r.Context(), `SELECT u.full_name,u.email,s.expires_at,u.email_verified_at IS NOT NULL FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1`, p.sessionID).Scan(&name, &email, &expires, &verified); err == nil {
					out["full_name"], out["email"], out["expires_at"], out["email_verified"] = name, email, expires, verified
				}
			}
			writeJSON(w, 200, out)
			return
		}
		if len(seg) == 2 && seg[1] == "organizations" && r.Method == http.MethodGet {
			a.userOrganizations(w, r)
			return
		}
		if len(seg) == 3 && seg[1] == "email" && seg[2] == "resend" && r.Method == http.MethodPost {
			a.resendVerification(w, r)
			return
		}
		if len(seg) == 3 && seg[1] == "account" && seg[2] == "export" && r.Method == http.MethodGet {
			a.exportAccount(w, r)
			return
		}
		if len(seg) == 3 && seg[1] == "account" && seg[2] == "delete" && r.Method == http.MethodPost {
			a.deleteAccount(w, r)
			return
		}
		if len(seg) >= 2 && seg[1] == "sessions" {
			a.userSessions(w, r, seg[2:])
			return
		}
		if len(seg) == 2 && seg[1] == "logout" && r.Method == "POST" {
			a.logout(w, r)
			return
		}
		if len(seg) == 3 && seg[1] == "mfa" {
			a.userMFA(w, r, seg[2:])
			return
		}
		notFound(w, r)
	case "api-keys":
		if len(seg) == 3 && seg[2] == "rotate" && r.Method == http.MethodPost {
			a.rotateAPIKey(w, r, currentOrgID(r, a.orgID), seg[1])
		} else {
			a.apiKeys(w, r, seg)
		}
	case "members":
		a.members(w, r, seg)
	case "invitations":
		a.invitations(w, r, seg)
	case "transaction-policies":
		a.transactionPolicies(w, r, seg)
	case "bank-operations":
		a.bankOperations(w, r, seg[1:])
	case "organizations":
		a.organizations(w, r, seg)
	case "customers":
		a.customers(w, r, seg)
	case "accounts":
		a.accounts(w, r, seg)
	case "collections":
		if len(seg) == 3 && seg[2] == "sandbox-confirm" && r.Method == http.MethodPost {
			a.confirmCollection(w, r, seg[1])
			return
		}
		if len(seg) == 3 && seg[2] == "refunds" && r.Method == http.MethodPost {
			a.refundCollection(w, r, seg[1])
			return
		}
		a.collections(w, r, seg)
	case "transfers":
		if len(seg) == 3 && (seg[2] == "approve" || seg[2] == "reject") {
			a.reviewTransfer(w, r, seg[1], seg[2])
			return
		}
		a.transfers(w, r, seg)
	case "ledger":
		a.ledger(w, r, seg)
	case "fraud":
		a.fraud(w, r, seg)
	case "reconciliation":
		a.reconciliation(w, r, seg)
	case "webhook-endpoints":
		if len(seg) == 3 && seg[2] == "test" && r.Method == http.MethodPost {
			a.testWebhookEndpoint(w, r, seg[1])
		} else if len(seg) == 3 && seg[2] == "rotate-secret" && r.Method == http.MethodPost {
			a.rotateWebhookSecret(w, r, seg[1])
		} else {
			a.webhookEndpoints(w, r, seg)
		}
	case "webhook-deliveries":
		if len(seg) == 3 && seg[2] == "retry" && r.Method == http.MethodPost {
			a.retryWebhookDelivery(w, r, seg[1])
		} else if len(seg) == 1 && r.Method == http.MethodGet {
			a.webhookDeliveries(w, r)
		} else {
			notFound(w, r)
		}
	case "audit-logs":
		a.auditLogs(w, r, seg)
	case "risk-rules":
		a.riskRules(w, r, seg)
	case "events":
		a.events(w, r, seg)
	case "notification-channels":
		a.notificationChannels(w, r, seg)
	case "onboarding":
		a.onboarding(w, r, seg)
	case "feedback":
		if len(seg) == 1 && r.Method == http.MethodPost {
			a.feedback(w, r)
		} else {
			notFound(w, r)
		}
	case "reports":
		if r.Method == "GET" && len(seg) == 2 && seg[1] == "transactions" {
			a.transactionReport(w, r)
			return
		}
		notFound(w, r)
	default:
		notFound(w, r)
	}
}
func notFound(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 404, problem{Error: "not found", RequestID: requestID(r)})
}
func bad(w http.ResponseWriter, r *http.Request, msg string) {
	writeJSON(w, 400, problem{Error: msg, RequestID: requestID(r)})
}
func (a *App) organizations(w http.ResponseWriter, r *http.Request, s []string) {
	if len(s) == 2 && s[1] == "export" && r.Method == http.MethodGet {
		a.exportWorkspace(w, r)
		return
	}
	if len(s) == 1 && r.Method == http.MethodGet {
		var x struct {
			ID            string    `json:"id"`
			Name          string    `json:"name"`
			WorkspaceType string    `json:"workspace_type"`
			Environment   string    `json:"environment"`
			Slug          string    `json:"slug"`
			Country       string    `json:"country_code"`
			Status        string    `json:"status"`
			CreatedAt     time.Time `json:"created_at"`
		}
		err := a.db.QueryRowContext(r.Context(), `SELECT id,name,workspace_type,environment,slug,country_code,status,created_at FROM organizations WHERE id=$1`, currentOrgID(r, a.orgID)).Scan(&x.ID, &x.Name, &x.WorkspaceType, &x.Environment, &x.Slug, &x.Country, &x.Status, &x.CreatedAt)
		if err == sql.ErrNoRows {
			notFound(w, r)
		} else if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
		} else {
			writeJSON(w, 200, x)
		}
		return
	}
	if len(s) == 1 && r.Method == http.MethodPost {
		p := principalFrom(r)
		if p.userID == "" || p.sessionID == "" {
			writeJSON(w, 403, problem{Error: "organization creation requires a signed-in user session", RequestID: requestID(r)})
			return
		}
		var in struct {
			Name          string `json:"name"`
			Slug          string `json:"slug"`
			Country       string `json:"country_code"`
			WorkspaceType string `json:"workspace_type"`
			Environment   string `json:"environment"`
		}
		if decode(r, &in) != nil || strings.TrimSpace(in.Name) == "" {
			bad(w, r, "name is required")
			return
		}
		in.Name = strings.TrimSpace(in.Name)
		in.Country = strings.ToUpper(strings.TrimSpace(in.Country))
		if len(in.Country) != 2 || !asciiCurrency(in.Country) {
			bad(w, r, "country_code must be a two-letter ISO 3166 code")
			return
		}
		if in.WorkspaceType == "" {
			in.WorkspaceType = "business"
		}
		if in.WorkspaceType != "business" && in.WorkspaceType != "personal" {
			bad(w, r, "workspace_type must be business or personal")
			return
		}
		if in.Environment == "" {
			in.Environment = "sandbox"
		}
		if in.Environment != "sandbox" && in.Environment != "live" {
			bad(w, r, "environment must be sandbox or live")
			return
		}
		if in.Environment == "live" {
			var verified bool
			if err := a.db.QueryRowContext(r.Context(), `SELECT email_verified_at IS NOT NULL FROM users WHERE id=$1`, p.userID).Scan(&verified); err != nil || !verified {
				writeJSON(w, 403, problem{Error: "confirm your email address before creating a live workspace", RequestID: requestID(r)})
				return
			}
		}
		slug := makeSlug(in.Slug)
		if slug == "" {
			slug = makeSlug(in.Name)
		}
		slug = slug + "-" + newID()[:8]
		orgID := "org_" + newID()
		tx, err := a.db.BeginTx(r.Context(), nil)
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO organizations(id,name,slug,country_code,workspace_type,environment) VALUES($1,$2,$3,$4,$5,$6)`, orgID, in.Name, slug, in.Country, in.WorkspaceType, in.Environment); err == nil {
			_, err = tx.ExecContext(r.Context(), `INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')`, "mem_"+newID(), orgID, p.userID)
		}
		if err != nil {
			writeJSON(w, 409, problem{Error: "organization could not be created"})
			return
		}
		if err = tx.Commit(); err != nil {
			writeJSON(w, 409, problem{Error: "organization creation conflict"})
			return
		}
		writeJSON(w, 201, map[string]any{"id": orgID, "name": in.Name, "slug": slug, "country_code": in.Country, "workspace_type": in.WorkspaceType, "environment": in.Environment, "status": "active", "role": "owner"})
		return
	}
	notFound(w, r)
}
func (a *App) customers(w http.ResponseWriter, r *http.Request, s []string) {
	if len(s) == 1 && r.Method == http.MethodGet {
		a.listCustomers(w, r, currentOrgID(r, a.orgID))
		return
	}
	if len(s) == 1 && r.Method == "POST" {
		var in struct {
			Name  string `json:"name"`
			Email string `json:"email"`
			Phone string `json:"phone"`
		}
		if decode(r, &in) != nil || strings.TrimSpace(in.Name) == "" {
			bad(w, r, "valid name is required")
			return
		}
		id := "cus_" + newID()
		_, e := a.db.ExecContext(r.Context(), `INSERT INTO customers(id,organization_id,name,email,phone) VALUES($1,$2,$3,NULLIF($4,''),NULLIF($5,''))`, id, currentOrgID(r, a.orgID), in.Name, in.Email, in.Phone)
		if e != nil {
			writeJSON(w, 409, problem{Error: "customer could not be created; email may already exist"})
			return
		}
		writeJSON(w, 201, map[string]any{"id": id, "name": in.Name, "email": in.Email, "phone": in.Phone, "status": "active"})
		return
	}
	if len(s) == 2 && r.Method == "GET" {
		var out struct {
			ID      string    `json:"id"`
			Name    string    `json:"name"`
			Email   *string   `json:"email"`
			Phone   *string   `json:"phone"`
			Status  string    `json:"status"`
			Created time.Time `json:"created_at"`
		}
		e := a.db.QueryRowContext(r.Context(), `SELECT id,name,email,phone,status,created_at FROM customers WHERE id=$1 AND organization_id=$2`, s[1], currentOrgID(r, a.orgID)).Scan(&out.ID, &out.Name, &out.Email, &out.Phone, &out.Status, &out.Created)
		if e == sql.ErrNoRows {
			notFound(w, r)
		} else if e != nil {
			writeJSON(w, 500, problem{Error: "database error"})
		} else {
			writeJSON(w, 200, out)
		}
		return
	}
	notFound(w, r)
}
func (a *App) accounts(w http.ResponseWriter, r *http.Request, s []string) {
	if len(s) == 1 && r.Method == http.MethodGet {
		a.listAccounts(w, r, currentOrgID(r, a.orgID))
		return
	}
	if len(s) == 1 && r.Method == "POST" {
		var in struct {
			CustomerID string `json:"customer_id"`
			Currency   string `json:"currency"`
			Type       string `json:"account_type"`
		}
		if decode(r, &in) != nil || len(in.Currency) != 3 {
			bad(w, r, "currency must be a three-letter code")
			return
		}
		id := "acc_" + newID()
		if in.Type == "" {
			in.Type = "wallet"
		}
		_, e := a.db.ExecContext(r.Context(), `INSERT INTO accounts(id,organization_id,customer_id,currency,account_type) VALUES($1,$2,NULLIF($3,''),upper($4),$5)`, id, currentOrgID(r, a.orgID), in.CustomerID, in.Currency, in.Type)
		if e != nil {
			writeJSON(w, 400, problem{Error: "account could not be created; verify customer belongs to organization"})
			return
		}
		writeJSON(w, 201, map[string]any{"id": id, "customer_id": in.CustomerID, "currency": strings.ToUpper(in.Currency), "account_type": in.Type, "status": "active", "balance_minor": 0})
		return
	}
	if len(s) == 3 && s[2] == "sandbox-credit" && r.Method == "POST" {
		if !a.requireSandbox(w, r, currentOrgID(r, a.orgID)) {
			return
		}
		var in struct {
			Amount int64 `json:"amount"`
		}
		if decode(r, &in) != nil || in.Amount <= 0 {
			bad(w, r, "positive amount is required")
			return
		}
		idemKey, requestHash, idemErr := requireIdempotencyKey(r)
		if idemErr != nil {
			bad(w, r, idemErr.Error())
			return
		}
		tx, e := a.db.BeginTx(r.Context(), nil)
		if e != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer tx.Rollback()
		cachedStatus, cachedBody, replayed, idemErr := reserveIdempotency(r.Context(), tx, currentOrgID(r, a.orgID), idemKey, requestHash)
		if idemErr != nil {
			idempotencyFailure(w, r, idemErr)
			return
		}
		if replayed {
			writeRawJSON(w, cachedStatus, cachedBody)
			return
		}
		if e = ensurePeriodOpen(r.Context(), tx, currentOrgID(r, a.orgID), time.Now()); e != nil {
			periodGuardFailure(w, r, e)
			return
		}
		var cur string
		if e = tx.QueryRowContext(r.Context(), `SELECT currency FROM accounts WHERE id=$1 AND organization_id=$2 AND status='active' FOR UPDATE`, s[1], currentOrgID(r, a.orgID)).Scan(&cur); e != nil {
			notFound(w, r)
			return
		}
		var clearing string
		e = tx.QueryRowContext(r.Context(), `SELECT id FROM accounts WHERE organization_id=$1 AND currency=$2 AND account_type='sandbox_clearing' LIMIT 1`, currentOrgID(r, a.orgID), cur).Scan(&clearing)
		if e == sql.ErrNoRows {
			clearing = "acc_sandbox_" + newID()
			_, e = tx.ExecContext(r.Context(), `INSERT INTO accounts(id,organization_id,currency,account_type) VALUES($1,$2,$3,'sandbox_clearing') ON CONFLICT(id) DO NOTHING`, clearing, currentOrgID(r, a.orgID), cur)
		}
		if e != nil {
			writeJSON(w, 500, problem{Error: "sandbox account setup failed"})
			return
		}
		entry := "jrn_" + newID()
		_, e = tx.ExecContext(r.Context(), `INSERT INTO journal_entries(id,organization_id,reference_type,reference_id,currency,amount_minor) VALUES($1,$2,'sandbox_credit',$3,$4,$5)`, entry, currentOrgID(r, a.orgID), s[1], cur, in.Amount)
		if e == nil {
			_, e = tx.ExecContext(r.Context(), `INSERT INTO journal_lines(journal_entry_id,organization_id,account_id,side,amount_minor,currency) VALUES($1,$2,$3,'debit',$5,$6),($1,$2,$4,'credit',$5,$6)`, entry, currentOrgID(r, a.orgID), clearing, s[1], in.Amount, cur)
		}
		if e != nil {
			writeJSON(w, 500, problem{Error: "ledger posting failed"})
			return
		}
		result := map[string]any{"account_id": s[1], "amount": in.Amount, "currency": cur, "mode": "sandbox", "notice": "simulated ledger credit; no funds were received"}
		if e = storeIdempotency(r.Context(), tx, currentOrgID(r, a.orgID), idemKey, 201, result); e != nil {
			idempotencyFailure(w, r, e)
			return
		}
		if e = tx.Commit(); e != nil {
			writeJSON(w, 409, problem{Error: "sandbox credit conflict"})
			return
		}
		writeJSON(w, 201, result)
		return
	}
	if len(s) >= 2 && r.Method == "GET" {
		if len(s) == 3 && s[2] == "balance" {
			var n int64
			e := a.db.QueryRowContext(r.Context(), `SELECT COALESCE(SUM(CASE side WHEN 'credit' THEN amount_minor ELSE -amount_minor END),0) FROM journal_lines l JOIN accounts ac ON ac.id=l.account_id WHERE ac.id=$1 AND ac.organization_id=$2`, s[1], currentOrgID(r, a.orgID)).Scan(&n)
			if e != nil {
				notFound(w, r)
				return
			}
			writeJSON(w, 200, map[string]any{"account_id": s[1], "balance_minor": n})
			return
		}
		var id, currency, typ, status string
		e := a.db.QueryRowContext(r.Context(), `SELECT id,currency,account_type,status FROM accounts WHERE id=$1 AND organization_id=$2`, s[1], currentOrgID(r, a.orgID)).Scan(&id, &currency, &typ, &status)
		if e == sql.ErrNoRows {
			notFound(w, r)
		} else if e != nil {
			writeJSON(w, 500, problem{Error: "database error"})
		} else {
			writeJSON(w, 200, map[string]any{"id": id, "currency": currency, "account_type": typ, "status": status})
		}
		return
	}
	notFound(w, r)
}
func (a *App) collections(w http.ResponseWriter, r *http.Request, s []string) {
	if len(s) == 1 && r.Method == http.MethodGet {
		a.listCollections(w, r, currentOrgID(r, a.orgID))
		return
	}
	if len(s) == 1 && r.Method == "POST" {
		var in struct {
			CustomerID  string `json:"customer_id"`
			Amount      int64  `json:"amount"`
			Currency    string `json:"currency"`
			Description string `json:"description"`
			Reference   string `json:"reference"`
		}
		if decode(r, &in) != nil || in.Amount <= 0 || len(in.Currency) != 3 || in.Reference == "" {
			bad(w, r, "amount, three-letter currency and reference are required")
			return
		}
		idemKey, requestHash, idemErr := requireIdempotencyKey(r)
		if idemErr != nil {
			bad(w, r, idemErr.Error())
			return
		}
		tx, e := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
		if e != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer tx.Rollback()
		cachedStatus, cachedBody, replayed, idemErr := reserveIdempotency(r.Context(), tx, currentOrgID(r, a.orgID), idemKey, requestHash)
		if idemErr != nil {
			idempotencyFailure(w, r, idemErr)
			return
		}
		if replayed {
			writeRawJSON(w, cachedStatus, cachedBody)
			return
		}
		if _, policyErr := a.enforceTransactionLimit(r.Context(), tx, currentOrgID(r, a.orgID), in.Currency, "collection", in.Amount); policyErr == errPolicyLimit {
			writeJSON(w, 409, problem{Error: policyErr.Error()})
			return
		} else if policyErr != nil {
			writeJSON(w, 500, problem{Error: "transaction policy check failed"})
			return
		}
		risk, riskErr := evaluateRisk(r.Context(), tx, currentOrgID(r, a.orgID), riskSubject{Kind: "collection", Amount: in.Amount, Currency: in.Currency, CustomerID: in.CustomerID})
		if riskErr != nil {
			writeJSON(w, 500, problem{Error: "risk check failed", RequestID: requestID(r)})
			return
		}
		if risk.Decision == "block" {
			riskBlocked(w, r, risk)
			return
		}
		id := "col_" + newID()
		_, e = tx.ExecContext(r.Context(), `INSERT INTO collections(id,organization_id,customer_id,amount_minor,currency,description,reference) VALUES($1,$2,NULLIF($3,''),$4,upper($5),$6,$7)`, id, currentOrgID(r, a.orgID), in.CustomerID, in.Amount, in.Currency, in.Description, in.Reference)
		if e != nil {
			writeJSON(w, 409, problem{Error: "collection could not be created; reference may already exist"})
			return
		}
		if e = recordRiskOutcome(r.Context(), tx, currentOrgID(r, a.orgID), "collection", id, in.Reference, &risk); e != nil {
			writeJSON(w, 500, problem{Error: "risk assessment could not be recorded", RequestID: requestID(r)})
			return
		}
		result := map[string]any{"id": id, "status": "pending", "amount": in.Amount, "currency": strings.ToUpper(in.Currency), "reference": in.Reference, "created_at": time.Now().UTC(), "risk": risk}
		if e = storeIdempotency(r.Context(), tx, currentOrgID(r, a.orgID), idemKey, 201, result); e != nil {
			idempotencyFailure(w, r, e)
			return
		}
		if e = tx.Commit(); e != nil {
			writeJSON(w, 409, problem{Error: "collection creation conflict"})
			return
		}
		writeJSON(w, 201, result)
		return
	}
	if len(s) == 3 && s[2] == "cancel" && r.Method == "POST" {
		res, e := a.db.ExecContext(r.Context(), `UPDATE collections SET status='cancelled' WHERE id=$1 AND organization_id=$2 AND status='pending'`, s[1], currentOrgID(r, a.orgID))
		if e != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			notFound(w, r)
		} else {
			writeJSON(w, 200, map[string]any{"id": s[1], "status": "cancelled"})
		}
		return
	}
	if len(s) == 2 && r.Method == "GET" {
		var id, status, cur, ref, desc string
		var amount int64
		var created time.Time
		e := a.db.QueryRowContext(r.Context(), `SELECT id,status,currency,reference,description,amount_minor,created_at FROM collections WHERE id=$1 AND organization_id=$2`, s[1], currentOrgID(r, a.orgID)).Scan(&id, &status, &cur, &ref, &desc, &amount, &created)
		if e == sql.ErrNoRows {
			notFound(w, r)
		} else if e != nil {
			writeJSON(w, 500, problem{Error: "database error"})
		} else {
			writeJSON(w, 200, map[string]any{"id": id, "status": status, "currency": cur, "reference": ref, "description": desc, "amount": amount, "created_at": created})
		}
		return
	}
	notFound(w, r)
}
func (a *App) ledger(w http.ResponseWriter, r *http.Request, s []string) {
	if len(s) != 2 || s[1] != "entries" || r.Method != "GET" {
		notFound(w, r)
		return
	}
	rows, e := a.db.QueryContext(r.Context(), `SELECT e.id,e.reference_type,e.reference_id,e.currency,e.amount_minor,e.created_at FROM journal_entries e WHERE e.organization_id=$1 ORDER BY e.created_at DESC LIMIT 100`, currentOrgID(r, a.orgID))
	if e != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, typ, ref, cur string
		var n int64
		var t time.Time
		if rows.Scan(&id, &typ, &ref, &cur, &n, &t) == nil {
			out = append(out, map[string]any{"id": id, "reference_type": typ, "reference_id": ref, "currency": cur, "amount": n, "created_at": t})
		}
	}
	writeJSON(w, 200, map[string]any{"data": out})
}
