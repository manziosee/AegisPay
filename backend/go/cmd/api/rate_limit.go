package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

var errRateLimitUnavailable = errors.New("rate limiting service unavailable")

// allow counts one attempt in a fixed window and reports whether it is within
// limit. retryAfter is the number of seconds until the window resets.
func (a *App) allow(ctx context.Context, identity string, limit int, window time.Duration) (bool, int64, error) {
	seconds := int64(window.Seconds())
	now := time.Now().UTC().Unix()
	bucket := now / seconds
	key := fmt.Sprintf("aegispay:rate:%s:%d:%d", identity, seconds, bucket)
	count, err := a.redis.Incr(ctx, key).Result()
	if err != nil {
		return false, 0, errRateLimitUnavailable
	}
	if count == 1 {
		_ = a.redis.Expire(ctx, key, window+time.Second).Err()
	}
	return count <= int64(limit), seconds - now%seconds, nil
}

// limitAttempt applies a handler-level limit, such as attempts per email
// address or per MFA challenge, which a client cannot spread across IPs.
func (a *App) limitAttempt(w http.ResponseWriter, r *http.Request, identity string, limit int, window time.Duration) bool {
	ok, retryAfter, err := a.allow(r.Context(), identity, limit, window)
	if err != nil {
		writeJSON(w, 503, problem{Error: err.Error(), RequestID: requestID(r)})
		return false
	}
	if !ok {
		w.Header().Set("Retry-After", fmt.Sprint(retryAfter))
		writeJSON(w, 429, problem{Error: "too many attempts; try again later", RequestID: requestID(r)})
		return false
	}
	return true
}

func (a *App) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/v1/") {
			next.ServeHTTP(w, r)
			return
		}
		identity := "ip:" + clientIP(r)
		// A dashboard page issues several requests at once, so the per-credential
		// default allows bursts of interactive use (10 requests per second).
		limit := a.requestsPerMinute
		window := time.Minute
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/auth/register"):
			// Many mobile and home networks share one public address across
			// many people, so the per-IP sign-up allowance is generous.
			limit, window = a.registrationsPerHour, time.Hour
		case strings.HasPrefix(r.URL.Path, "/v1/auth/login") || strings.HasPrefix(r.URL.Path, "/v1/auth/mfa/verify-login") || strings.HasPrefix(r.URL.Path, "/v1/auth/password/") || strings.HasPrefix(r.URL.Path, "/v1/auth/email/verify"):
			// A separate counter: ordinary anonymous requests, such as the
			// session check on every page load, must not use up sign-in attempts.
			identity = "auth-ip:" + clientIP(r)
			limit, window = 10, time.Minute
		default:
			if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
				credential := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
				if credential != "" && credential != a.apiKey {
					identity = "credential:" + tokenHash(credential)
				}
			}
		}
		ok, retryAfter, err := a.allow(r.Context(), identity, limit, window)
		if err != nil {
			writeJSON(w, 503, problem{Error: err.Error(), RequestID: requestID(r)})
			return
		}
		if !ok {
			w.Header().Set("Retry-After", fmt.Sprint(retryAfter))
			writeJSON(w, 429, problem{Error: "rate limit exceeded", RequestID: requestID(r)})
			return
		}
		next.ServeHTTP(w, r)
	})
}
