package main

import (
	"archive/zip"
	"context"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"
)

// The month-end audit pack: one ZIP with the ledger, approvals,
// reconciliations, risk decisions and audit log for a month, the result of
// re-checking the audit chain, the public timestamp proofs for that month,
// and a manifest listing every file's SHA-256. The manifest is signed with
// an Ed25519 key derived from the server's encryption key; anyone can check
// the signature against the public key published at /audit-pack-keys.

const auditPackRowLimit = 200000

func signingSeed(master []byte) ([]byte, error) {
	return hkdf.Key(sha256.New, master, nil, "aegispay audit-pack-signing", ed25519.SeedSize)
}

// auditSigningKey returns the active signing key and its id.
func auditSigningKey() (string, ed25519.PrivateKey, error) {
	ring, err := loadKeyRing()
	if err != nil || ring == nil {
		return "", nil, errors.New("signing is not configured")
	}
	id, master := ring.activeID, ring.keys[ring.activeID]
	if master == nil && ring.legacy != nil {
		id, master = "legacy", ring.legacy
	}
	if master == nil {
		return "", nil, errors.New("signing is not configured")
	}
	seed, err := signingSeed(master)
	if err != nil {
		return "", nil, err
	}
	return "audit-" + id, ed25519.NewKeyFromSeed(seed), nil
}

func publicKeyPEM(key ed25519.PublicKey) string {
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return ""
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

// auditPackKeys publishes the public half of every signing key, so a pack
// can be checked by someone who does not trust the file it arrived in.
func auditPackKeys(w http.ResponseWriter, r *http.Request) {
	ring, err := loadKeyRing()
	keys := []map[string]any{}
	if err == nil && ring != nil {
		ids := make([]string, 0, len(ring.keys))
		for id := range ring.keys {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			if seed, seedErr := signingSeed(ring.keys[id]); seedErr == nil {
				pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
				keys = append(keys, map[string]any{"key_id": "audit-" + id, "algorithm": "Ed25519", "active": id == ring.activeID, "public_key_pem": publicKeyPEM(pub)})
			}
		}
		if ring.legacy != nil && len(keys) == 0 {
			if seed, seedErr := signingSeed(ring.legacy); seedErr == nil {
				pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
				keys = append(keys, map[string]any{"key_id": "audit-legacy", "algorithm": "Ed25519", "active": true, "public_key_pem": publicKeyPEM(pub)})
			}
		}
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	writeJSON(w, 200, map[string]any{"keys": keys})
}

// packFile tracks one file written into the ZIP.
type packFile struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Rows   int    `json:"rows,omitempty"`
	Bytes  int64  `json:"bytes"`
}

type packWriter struct {
	zip   *zip.Writer
	files []packFile
	when  time.Time
}

type countingHash struct {
	hash.Hash
	n int64
}

func (c *countingHash) Write(p []byte) (int, error) {
	c.n += int64(len(p))
	return c.Hash.Write(p)
}

func (p *packWriter) create(name string) (io.Writer, *countingHash, error) {
	out, err := p.zip.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: p.when})
	if err != nil {
		return nil, nil, err
	}
	h := &countingHash{Hash: sha256.New()}
	return io.MultiWriter(out, h), h, nil
}

func (p *packWriter) add(name string, content []byte) error {
	out, h, err := p.create(name)
	if err != nil {
		return err
	}
	if _, err = out.Write(content); err != nil {
		return err
	}
	p.files = append(p.files, packFile{Name: name, SHA256: hex.EncodeToString(h.Sum(nil)), Bytes: h.n})
	return nil
}

// addCSV writes the rows of a query as CSV.
func (p *packWriter) addCSV(ctx context.Context, db *sql.DB, name string, header []string, query string, args ...any) error {
	out, h, err := p.create(name)
	if err != nil {
		return err
	}
	writer := csv.NewWriter(out)
	if err = writer.Write(header); err != nil {
		return err
	}
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	count := 0
	values := make([]sql.NullString, len(header))
	pointers := make([]any, len(header))
	for i := range values {
		pointers[i] = &values[i]
	}
	record := make([]string, len(header))
	for rows.Next() {
		if err = rows.Scan(pointers...); err != nil {
			return err
		}
		for i, v := range values {
			record[i] = csvSafe(v.String)
		}
		if err = writer.Write(record); err != nil {
			return err
		}
		count++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	writer.Flush()
	if err = writer.Error(); err != nil {
		return err
	}
	p.files = append(p.files, packFile{Name: name, SHA256: hex.EncodeToString(h.Sum(nil)), Rows: count, Bytes: h.n})
	return nil
}

// parsePackMonth reads "2026-10"; the default is the previous month.
func parsePackMonth(value string, now time.Time) (time.Time, time.Time, error) {
	var start time.Time
	if strings.TrimSpace(value) == "" {
		first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		start = first.AddDate(0, -1, 0)
	} else {
		parsed, err := time.Parse("2006-01", strings.TrimSpace(value))
		if err != nil {
			return time.Time{}, time.Time{}, errors.New("month must look like 2026-10")
		}
		start = parsed.UTC()
	}
	end := start.AddDate(0, 1, 0)
	if start.After(now) {
		return time.Time{}, time.Time{}, errors.New("that month has not started yet")
	}
	return start, end, nil
}

func (a *App) auditPack(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	org := currentOrgID(r, a.orgID)
	now := time.Now().UTC()
	start, end, err := parsePackMonth(r.URL.Query().Get("month"), now)
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	var orgName, environment string
	if err = a.db.QueryRowContext(ctx, `SELECT name,environment FROM organizations WHERE id=$1`, org).Scan(&orgName, &environment); err != nil {
		writeJSON(w, 500, problem{Error: "workspace could not be loaded"})
		return
	}
	// Check the chain before anything is sent, so the result is in the pack.
	chain, err := a.auditChainStatus(ctx, org)
	if err != nil {
		writeJSON(w, 500, problem{Error: "audit chain could not be checked", RequestID: requestID(r)})
		return
	}
	period := start.Format("2006-01")
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="aegispay-audit-pack-`+period+`.zip"`)
	w.Header().Set("Cache-Control", "no-store")
	pack := &packWriter{zip: zip.NewWriter(w), when: now}
	limit := fmt.Sprint(auditPackRowLimit)
	steps := []struct {
		name   string
		header []string
		query  string
	}{
		{"ledger.csv", []string{"entry_id", "created_at", "reference_type", "reference_id", "account_id", "account_label", "side", "amount_minor", "currency"},
			`SELECT e.id,to_char(l.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),e.reference_type,e.reference_id,l.account_id,COALESCE(a.label,''),l.side,l.amount_minor::text,l.currency
			FROM journal_lines l JOIN journal_entries e ON e.id=l.journal_entry_id AND e.organization_id=l.organization_id
			LEFT JOIN accounts a ON a.id=l.account_id AND a.organization_id=l.organization_id
			WHERE l.organization_id=$1 AND l.created_at>=$2 AND l.created_at<$3 ORDER BY l.created_at,l.id LIMIT ` + limit},
		{"approvals.csv", []string{"kind", "record_id", "decision", "approver", "note", "decided_at"},
			`SELECT * FROM (
				SELECT 'transfer',t.transfer_id,t.decision,COALESCE(u.email,t.approver_user_id),'',to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
				FROM transfer_approvals t LEFT JOIN users u ON u.id=t.approver_user_id WHERE t.organization_id=$1 AND t.created_at>=$2 AND t.created_at<$3
				UNION ALL
				SELECT 'payout',p.payout_id,p.decision,COALESCE(u.email,p.approver_user_id),p.note,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
				FROM bank_payout_approvals p LEFT JOIN users u ON u.id=p.approver_user_id WHERE p.organization_id=$1 AND p.created_at>=$2 AND p.created_at<$3
			) x ORDER BY at LIMIT ` + limit},
		{"reconciliation.csv", []string{"import_id", "source", "provider", "line_id", "reference", "net_amount_minor", "provider_fee_minor", "currency", "transaction_date", "status", "matched_record", "note"},
			`SELECT i.id,i.source_name,i.provider,l.id::text,l.external_reference,l.amount_minor::text,l.provider_fee_minor::text,l.currency,
				to_char(l.transaction_date AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),l.match_status,
				COALESCE(l.matched_collection_id,l.matched_request_id,l.matched_payout_id,''),l.suggestion_reason
			FROM reconciliation_lines l JOIN reconciliation_imports i ON i.id=l.import_id AND i.organization_id=l.organization_id
			WHERE l.organization_id=$1 AND i.created_at>=$2 AND i.created_at<$3 ORDER BY i.created_at,l.id LIMIT ` + limit},
		{"funds.csv", []string{"fund_id", "name", "fund_type", "donor_name", "project_code", "restriction_note", "currency", "allocated_minor", "status", "created_at"},
			`SELECT id,name,fund_type,donor_name,project_code,restriction_note,currency,allocated_minor::text,status,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
			FROM finance_funds WHERE organization_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at LIMIT ` + limit},
		{"commitments.csv", []string{"commitment_id", "fund_id", "type", "title", "beneficiary", "amount_minor", "currency", "status", "payout_id", "due_date", "created_at"},
			`SELECT id,fund_id,commitment_type,title,beneficiary_name,amount_minor::text,currency,status,COALESCE(payout_id,''),COALESCE(to_char(due_date,'YYYY-MM-DD'),''),to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
			FROM finance_commitments WHERE organization_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at LIMIT ` + limit},
		{"staff-advances.csv", []string{"advance_id", "commitment_id", "payout_id", "staff_name", "purpose", "amount_minor", "currency", "status", "created_at"},
			`SELECT id,commitment_id,payout_id,staff_name,purpose,amount_minor::text,currency,status,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
			FROM staff_advances WHERE organization_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at LIMIT ` + limit},
		{"advance-settlements.csv", []string{"settlement_id", "advance_id", "used_minor", "returned_minor", "note", "status", "submitted_by", "reviewed_by", "reviewed_at", "created_at"},
			`SELECT id,advance_id,used_minor::text,returned_minor::text,note,status,submitted_by,COALESCE(reviewed_by,''),COALESCE(to_char(reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),''),to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
			FROM advance_settlements WHERE organization_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at LIMIT ` + limit},
		{"finance-evidence.csv", []string{"evidence_id", "resource_type", "resource_id", "file_name", "content_type", "file_size", "sha256", "note", "uploaded_by", "created_at"},
			`SELECT id,resource_type,resource_id,file_name,content_type,file_size::text,sha256,note,COALESCE(uploaded_by,''),to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
			FROM finance_evidence WHERE organization_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at LIMIT ` + limit},
		{"risk-decisions.csv", []string{"assessment_id", "reference", "subject_type", "subject_id", "score", "level", "decision", "matched_rules", "model", "assessed_at", "case_status", "case_resolved_at"},
			`SELECT r.id,r.transaction_reference,COALESCE(r.subject_type,''),COALESCE(r.subject_id,''),r.risk_score::text,r.risk_level,r.decision,r.matched_rules::text,r.model_version,
				to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),COALESCE(c.status,''),COALESCE(to_char(c.resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'')
			FROM risk_assessments r LEFT JOIN fraud_cases c ON c.assessment_id=r.id AND c.organization_id=r.organization_id
			WHERE r.organization_id=$1 AND r.created_at>=$2 AND r.created_at<$3 ORDER BY r.created_at LIMIT ` + limit},
		{"audit-log.csv", []string{"seq", "id", "created_at", "actor", "action", "resource_type", "resource_id", "metadata", "prev_hash", "hash"},
			`SELECT l.seq::text,l.id,to_char(l.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),COALESCE(u.email,l.actor_id,''),l.action,l.resource_type,l.resource_id,l.metadata::text,COALESCE(l.prev_hash,''),COALESCE(l.hash,'')
			FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id
			WHERE l.organization_id=$1 AND l.created_at>=$2 AND l.created_at<$3 ORDER BY l.seq LIMIT ` + limit},
	}
	fail := func(err error) {
		// Headers are already sent; an incomplete ZIP fails to open, which is
		// the safe outcome.
		slog.Error("audit pack failed", "organization_id", org, "error", err)
	}
	for _, step := range steps {
		if err = pack.addCSV(ctx, a.db, step.name, step.header, step.query, org, start, end); err != nil {
			fail(err)
			return
		}
	}
	evidenceRows, err := a.db.QueryContext(ctx, `SELECT id,resource_type,resource_id,file_name,content FROM finance_evidence
		WHERE organization_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at LIMIT 1000`, org, start, end)
	if err != nil {
		fail(err)
		return
	}
	var evidenceBytes int64
	for evidenceRows.Next() {
		var id, resourceType, resourceID, fileName string
		var content []byte
		if err = evidenceRows.Scan(&id, &resourceType, &resourceID, &fileName, &content); err != nil {
			_ = evidenceRows.Close()
			fail(err)
			return
		}
		evidenceBytes += int64(len(content))
		if evidenceBytes > 25<<20 {
			_ = evidenceRows.Close()
			fail(errors.New("finance evidence for the audit pack exceeds 25 MiB"))
			return
		}
		fileName = strings.ReplaceAll(fileName, "\\", "/")
		fileName = strings.TrimPrefix(fileName, "/")
		if fileName == "" || fileName == "." || strings.Contains(fileName, "../") {
			fileName = "evidence.bin"
		}
		if err = pack.add("evidence/"+resourceType+"/"+resourceID+"/"+id+"-"+fileName, content); err != nil {
			_ = evidenceRows.Close()
			fail(err)
			return
		}
	}
	if err = evidenceRows.Err(); err != nil {
		_ = evidenceRows.Close()
		fail(err)
		return
	}
	_ = evidenceRows.Close()
	anchorRows, err := a.db.QueryContext(ctx, `SELECT anchor_date,statement,proof FROM audit_anchors WHERE organization_id=$1 AND anchor_date>=$2 AND anchor_date<$3 ORDER BY anchor_date`, org, start, end)
	if err != nil {
		fail(err)
		return
	}
	anchors := 0
	for anchorRows.Next() {
		var day time.Time
		var statement string
		var proof []byte
		if err = anchorRows.Scan(&day, &statement, &proof); err != nil {
			_ = anchorRows.Close()
			fail(err)
			return
		}
		name := "anchors/aegispay-audit-" + day.Format("2006-01-02") + ".txt"
		if err = pack.add(name, []byte(statement)); err == nil && len(proof) > 0 {
			err = pack.add(name+".ots", proof)
		}
		if err != nil {
			_ = anchorRows.Close()
			fail(err)
			return
		}
		anchors++
	}
	_ = anchorRows.Close()

	readme := "AegisPay audit pack for " + orgName + ", " + period + " (UTC)\n\n" +
		"Files\n" +
		"  ledger.csv          every ledger line posted in the month\n" +
		"  approvals.csv       transfer and payout approval decisions\n" +
		"  reconciliation.csv  bank and payment-provider statement lines and how each was matched\n" +
		"  funds.csv           restricted and general fund allocations\n" +
		"  commitments.csv     planned and bank-linked budget commitments\n" +
		"  staff-advances.csv  advances linked to payout and statement status\n" +
		"  advance-settlements.csv reviewed receipts, use, and returns\n" +
		"  finance-evidence.csv evidence metadata; evidence/ contains uploaded files\n" +
		"  risk-decisions.csv  risk assessments and the outcome of any case they opened\n" +
		"  audit-log.csv       the month's audit entries, each with its hash and the previous entry's hash\n" +
		"  anchors/            daily public timestamps of the audit chain (OpenTimestamps)\n" +
		"  manifest.json       what was generated, the audit-chain check and each file's SHA-256\n" +
		"  manifest.sig        Ed25519 signature of manifest.json\n\n" +
		"How to check this pack\n" +
		"  1. File integrity: sha256sum -c SHA256SUMS\n" +
		"  2. Signature: compare public_key.pem with the key published at\n" +
		"     https://aegispay.fly.dev/audit-pack-keys, then run\n" +
		"     openssl pkeyutl -verify -pubin -inkey public_key.pem -rawin -in manifest.json -sigfile manifest.sig\n" +
		"  3. Timestamps: pip install opentimestamps-client, then in anchors/ run\n" +
		"     ots verify aegispay-audit-YYYY-MM-DD.txt.ots\n" +
		"  4. Audit chain: in audit-log.csv each row's prev_hash equals the hash of the row before it.\n\n" +
		"Amounts are in each currency's smallest unit (for example cents). Workspace kind: " + map[string]string{"live": "live (real records)", "sandbox": "practice (simulated money)"}[environment] + ".\n"
	if err = pack.add("README.txt", []byte(readme)); err != nil {
		fail(err)
		return
	}
	var sums strings.Builder
	for _, f := range pack.files {
		sums.WriteString(f.SHA256 + "  " + f.Name + "\n")
	}
	if err = pack.add("SHA256SUMS", []byte(sums.String())); err != nil {
		fail(err)
		return
	}
	p := principalFrom(r)
	var generatedBy string
	if p.userID != "" {
		_ = a.db.QueryRowContext(ctx, `SELECT email FROM users WHERE id=$1`, p.userID).Scan(&generatedBy)
	}
	keyID, key, keyErr := auditSigningKey()
	manifest := map[string]any{
		"format": "aegispay-audit-pack/1", "workspace_id": org, "workspace_name": orgName, "workspace_kind": environment,
		"period": period, "period_start": start, "period_end": end, "generated_at": now, "generated_by": firstNonEmpty(generatedBy, "api key"),
		"audit_chain": chain, "anchors_included": anchors, "files": pack.files,
		"row_limit_per_file": auditPackRowLimit,
	}
	if keyErr == nil {
		manifest["signature"] = map[string]any{"algorithm": "Ed25519", "key_id": keyID, "public_keys_url": "https://aegispay.fly.dev/audit-pack-keys"}
	} else {
		manifest["signature"] = map[string]any{"algorithm": "none", "detail": "signing is not configured on this server"}
	}
	manifestJSON, _ := json.MarshalIndent(manifest, "", "  ")
	if err = pack.add("manifest.json", manifestJSON); err != nil {
		fail(err)
		return
	}
	if keyErr == nil {
		if err = pack.add("manifest.sig", ed25519.Sign(key, manifestJSON)); err == nil {
			err = pack.add("public_key.pem", []byte(publicKeyPEM(key.Public().(ed25519.PublicKey))))
		}
		if err != nil {
			fail(err)
			return
		}
	}
	if err = pack.zip.Close(); err != nil {
		fail(err)
		return
	}
	a.audit(r, org, "audit_pack.generated", "audit_pack", period, map[string]any{"files": len(pack.files), "chain_valid": chain["valid"]})
}
