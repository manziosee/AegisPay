package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Public proof that the audit log was not rewritten. Once a day, each
// workspace's audit-chain head (the hash of its latest entry) is written into
// a short statement, and the statement's SHA-256 is timestamped with
// OpenTimestamps, a free public service that commits it to the Bitcoin
// blockchain. Anyone holding the statement and its .ots proof can check, with
// the standard `ots verify` tool, that the chain head existed on that day.
// Because every audit entry hashes the one before it, changing any earlier
// entry would change the head and no longer match the stamped statement.

// otsHeaderMagic starts every detached OpenTimestamps proof file.
var otsHeaderMagic = []byte("\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94")

const otsOpSHA256 = 0x08

// anchorCalendars lists the OpenTimestamps calendars to use. Anchoring is off
// unless AUDIT_ANCHOR_CALENDARS is set, so local runs and tests stay offline.
func anchorCalendars() []string {
	var out []string
	for _, item := range strings.Split(env("AUDIT_ANCHOR_CALENDARS", ""), ",") {
		item = strings.TrimRight(strings.TrimSpace(item), "/")
		if strings.HasPrefix(item, "https://") {
			out = append(out, item)
		}
	}
	return out
}

func anchorStatement(org string, day time.Time, lastEntryID, head string, count int64) string {
	return "AegisPay audit log anchor\n" +
		"workspace: " + org + "\n" +
		"day (UTC): " + day.Format("2006-01-02") + "\n" +
		"entries up to the end of that day: " + fmt.Sprint(count) + "\n" +
		"last entry: " + lastEntryID + "\n" +
		"chain head: " + head + "\n" +
		"\n" +
		"Each audit entry's hash includes the hash of the entry before it, so this\n" +
		"chain head commits to every entry up to and including the last entry above.\n" +
		"Check this file with its .ots proof: ots verify <this file>.ots\n"
}

// otsProofFile builds a detached .ots proof from calendar responses. Each
// response is a serialized timestamp for the digest; several are merged as
// branches (0xff separates all but the last).
func otsProofFile(digest []byte, responses [][]byte) []byte {
	var b bytes.Buffer
	b.Write(otsHeaderMagic)
	b.WriteByte(0x01) // major version
	b.WriteByte(otsOpSHA256)
	b.Write(digest)
	for i, response := range responses {
		if i < len(responses)-1 {
			b.WriteByte(0xff)
		}
		b.Write(response)
	}
	return b.Bytes()
}

// submitToCalendars sends the digest to each calendar and keeps the answers
// that arrive. One calendar is enough for a valid proof.
func submitToCalendars(ctx context.Context, calendars []string, digest []byte) ([][]byte, []string, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	var responses [][]byte
	var used []string
	var lastErr error
	for _, calendar := range calendars {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, calendar+"/digest", bytes.NewReader(digest))
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("Accept", "application/vnd.opentimestamps.v1")
		req.Header.Set("User-Agent", "AegisPay audit anchor")
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 10000))
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK || readErr != nil || len(body) == 0 {
			lastErr = fmt.Errorf("%s answered %d", calendar, resp.StatusCode)
			continue
		}
		responses = append(responses, body)
		used = append(used, calendar)
	}
	if len(responses) == 0 {
		if lastErr == nil {
			lastErr = errors.New("no calendar configured")
		}
		return nil, nil, lastErr
	}
	return responses, used, nil
}

// anchorAuditChains stamps yesterday's chain head for every workspace whose
// audit log changed since its previous anchor. It runs from the maintenance
// loop; the unique (workspace, day) row stops two machines stamping twice.
func (a *App) anchorAuditChains(ctx context.Context) {
	calendars := anchorCalendars()
	if len(calendars) == 0 {
		return
	}
	today := time.Now().UTC().Truncate(24 * time.Hour)
	day := today.AddDate(0, 0, -1)
	rows, err := a.db.QueryContext(ctx, `SELECT o.id FROM organizations o
		WHERE EXISTS(SELECT 1 FROM audit_logs l WHERE l.organization_id=o.id AND l.created_at<$1)
		AND NOT EXISTS(SELECT 1 FROM audit_anchors x WHERE x.organization_id=o.id AND x.anchor_date=$2)
		LIMIT 200`, today, day)
	if err != nil {
		slog.Error("audit anchor scan failed", "error", err)
		return
	}
	var orgs []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			orgs = append(orgs, id)
		}
	}
	_ = rows.Close()
	for _, org := range orgs {
		if ctx.Err() != nil {
			return
		}
		var head, lastID string
		var count int64
		err = a.db.QueryRowContext(ctx, `SELECT COALESCE(hash,''),id,(SELECT COUNT(*) FROM audit_logs c WHERE c.organization_id=$1 AND c.created_at<$2)
			FROM audit_logs WHERE organization_id=$1 AND created_at<$2 ORDER BY seq DESC LIMIT 1`, org, today).Scan(&head, &lastID, &count)
		if err != nil || head == "" {
			continue
		}
		var previous string
		_ = a.db.QueryRowContext(ctx, `SELECT head_hash FROM audit_anchors WHERE organization_id=$1 ORDER BY anchor_date DESC LIMIT 1`, org).Scan(&previous)
		if previous == head {
			continue // nothing new to prove
		}
		statement := anchorStatement(org, day, lastID, head, count)
		sum := sha256.Sum256([]byte(statement))
		id := "anc_" + newID()
		res, err := a.db.ExecContext(ctx, `INSERT INTO audit_anchors(id,organization_id,anchor_date,head_hash,last_entry_id,entry_count,statement,digest)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (organization_id,anchor_date) DO NOTHING`, id, org, day, head, lastID, count, statement, hex.EncodeToString(sum[:]))
		if err != nil {
			slog.Error("audit anchor could not be recorded", "organization_id", org, "error", err)
			continue
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue
		}
		a.stampAnchor(ctx, id, sum[:], calendars)
	}
	// Retry recent anchors that no calendar accepted.
	retry, err := a.db.QueryContext(ctx, `SELECT id,digest FROM audit_anchors WHERE status IN ('pending','failed') AND created_at>now()-interval '3 days' AND created_at<now()-interval '30 minutes' LIMIT 50`)
	if err != nil {
		return
	}
	type pending struct{ id, digest string }
	var again []pending
	for retry.Next() {
		var p pending
		if retry.Scan(&p.id, &p.digest) == nil {
			again = append(again, p)
		}
	}
	_ = retry.Close()
	for _, p := range again {
		if digest, err := hex.DecodeString(p.digest); err == nil {
			a.stampAnchor(ctx, p.id, digest, calendars)
		}
	}
}

func (a *App) stampAnchor(ctx context.Context, id string, digest []byte, calendars []string) {
	responses, used, err := submitToCalendars(ctx, calendars, digest)
	if err != nil {
		_, _ = a.db.ExecContext(ctx, `UPDATE audit_anchors SET status='failed',error=$2 WHERE id=$1`, id, truncateText(err.Error(), 300))
		slog.Warn("audit anchor not stamped", "anchor_id", id, "error", err)
		return
	}
	_, _ = a.db.ExecContext(ctx, `UPDATE audit_anchors SET status='stamped',proof=$2,calendars=$3,error='' WHERE id=$1`, id, otsProofFile(digest, responses), used)
}

func truncateText(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

// auditAnchors lists a workspace's anchors and serves each statement and
// proof file.
func (a *App) auditAnchors(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) == 2 {
		rows, err := a.db.QueryContext(r.Context(), `SELECT anchor_date,head_hash,last_entry_id,entry_count,digest,status,calendars,created_at FROM audit_anchors
			WHERE organization_id=$1 ORDER BY anchor_date DESC LIMIT 120`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "audit anchors unavailable"})
			return
		}
		defer rows.Close()
		data := []map[string]any{}
		for rows.Next() {
			var day, created time.Time
			var head, lastID, digest, status string
			var count int64
			var calendars []string
			if err = rows.Scan(&day, &head, &lastID, &count, &digest, &status, &calendars, &created); err != nil {
				writeJSON(w, 500, problem{Error: "audit anchors unavailable"})
				return
			}
			data = append(data, map[string]any{"date": day.Format("2006-01-02"), "head_hash": head, "last_entry_id": lastID, "entry_count": count, "digest": digest, "status": status, "calendars": calendars, "created_at": created})
		}
		writeJSON(w, 200, map[string]any{"data": data, "enabled": len(anchorCalendars()) > 0})
		return
	}
	if len(parts) != 4 || (parts[3] != "proof" && parts[3] != "statement") {
		notFound(w, r)
		return
	}
	day, err := time.Parse("2006-01-02", parts[2])
	if err != nil {
		bad(w, r, "the date must look like 2026-11-08")
		return
	}
	var statement string
	var proof []byte
	err = a.db.QueryRowContext(r.Context(), `SELECT statement,proof FROM audit_anchors WHERE organization_id=$1 AND anchor_date=$2`, org, day).Scan(&statement, &proof)
	if err == sql.ErrNoRows {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "audit anchor unavailable"})
		return
	}
	name := "aegispay-audit-" + day.Format("2006-01-02") + ".txt"
	if parts[3] == "statement" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		_, _ = io.WriteString(w, statement)
		return
	}
	if len(proof) == 0 {
		writeJSON(w, 409, problem{Error: "this day's proof is not ready yet; try again later"})
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.ots"`)
	_, _ = w.Write(proof)
}
