package main

import (
	"crypto/subtle"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
)

// clientIPConfig decides which network peers may report the original client
// address. Without configuration only the TCP peer address is used, so a
// client cannot choose its own rate-limit bucket by sending forwarding headers.
type clientIPConfig struct {
	trustedNets []*net.IPNet
	proxySecret string
	// header is set by an edge that every request passes through and that
	// overwrites any client-supplied value, such as Fly-Client-IP on Fly.io.
	header string
}

var (
	clientIPOnce   sync.Once
	clientIPLoaded clientIPConfig
)

func loadClientIPConfig() clientIPConfig {
	clientIPOnce.Do(func() {
		clientIPLoaded = parseClientIPConfig(env("TRUSTED_PROXY_CIDRS", ""), env("TRUSTED_PROXY_SECRET", ""))
		clientIPLoaded.header = strings.TrimSpace(env("TRUSTED_CLIENT_IP_HEADER", ""))
	})
	return clientIPLoaded
}

func parseClientIPConfig(cidrs, secret string) clientIPConfig {
	cfg := clientIPConfig{proxySecret: strings.TrimSpace(secret)}
	for _, raw := range strings.Split(cidrs, ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if !strings.Contains(raw, "/") {
			if ip := net.ParseIP(raw); ip != nil && ip.To4() != nil {
				raw += "/32"
			} else {
				raw += "/128"
			}
		}
		_, network, err := net.ParseCIDR(raw)
		if err != nil {
			slog.Warn("ignoring invalid TRUSTED_PROXY_CIDRS entry", "value", raw)
			continue
		}
		cfg.trustedNets = append(cfg.trustedNets, network)
	}
	if cfg.proxySecret != "" && len(cfg.proxySecret) < 32 {
		slog.Warn("TRUSTED_PROXY_SECRET is shorter than 32 characters; forwarded client addresses are ignored")
		cfg.proxySecret = ""
	}
	return cfg
}

func (c clientIPConfig) trusted(ip net.IP) bool {
	for _, network := range c.trustedNets {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// clientIP returns the address used for per-IP limits.
//
//   - A proxy that presents TRUSTED_PROXY_SECRET (the dashboard server) may
//     report the browser address in X-AegisPay-Client-IP. This works on any
//     hosting provider because it does not depend on the proxy's egress IP.
//   - TRUSTED_CLIENT_IP_HEADER names a header written by the hosting edge
//     (Fly-Client-IP on Fly.io); only set it when clients cannot reach the
//     API without passing through that edge.
//   - A peer inside TRUSTED_PROXY_CIDRS (a load balancer) may report the chain
//     in X-Forwarded-For; the right-most untrusted entry is the client.
//   - Otherwise the TCP peer address is used.
func (c clientIPConfig) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if c.proxySecret != "" {
		presented := r.Header.Get("X-AegisPay-Proxy-Secret")
		if presented != "" && subtle.ConstantTimeCompare([]byte(presented), []byte(c.proxySecret)) == 1 {
			if ip := net.ParseIP(strings.TrimSpace(r.Header.Get("X-AegisPay-Client-IP"))); ip != nil {
				return ip.String()
			}
		}
	}
	if c.header != "" {
		if ip := net.ParseIP(strings.TrimSpace(r.Header.Get(c.header))); ip != nil {
			return ip.String()
		}
	}
	peer := net.ParseIP(host)
	if peer == nil || !c.trusted(peer) {
		return host
	}
	hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		ip := net.ParseIP(strings.TrimSpace(hops[i]))
		if ip == nil {
			// A malformed hop means the remaining chain cannot be trusted.
			break
		}
		if !c.trusted(ip) {
			return ip.String()
		}
		peer = ip
	}
	return peer.String()
}

func clientIP(r *http.Request) string { return loadClientIPConfig().clientIP(r) }
