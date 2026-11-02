package main

import (
	"database/sql"
	"net/http"
	"strings"
	"time"
)

func (a *App) reconciliation(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) == 2 && parts[1] == "imports" && r.Method == http.MethodPost {
		var in struct {
			Source string `json:"source_name"`
			Lines []struct {
				Reference string `json:"external_reference"`
				Amount int64 `json:"amount"`
				Currency string `json:"currency"`
				Date string `json:"transaction_date"`
			} `json:"lines"`
		}
		if decode(r, &in) != nil || len(in.Lines) == 0 || len(in.Lines) > 10000 {
			bad(w, r, "between 1 and 10000 statement lines are required")
			return
		}
		dates := make([]time.Time, len(in.Lines))
		for i, line := range in.Lines {
			if strings.TrimSpace(line.Reference) == "" || len(line.Currency) != 3 || line.Amount <= 0 {
				bad(w, r, "each line requires an external_reference, positive amount, and three-letter currency")
				return
			}
			dates[i] = time.Now().UTC()
			if line.Date != "" {
				var err error
				dates[i], err = time.Parse(time.RFC3339, line.Date)
				if err != nil {
					bad(w, r, "transaction_date values must use RFC3339")
					return
				}
			}
		}
		key, hash, err := requireIdempotencyKey(r)
		if err != nil { bad(w, r, err.Error()); return }
		tx, err := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
		if err != nil { writeJSON(w, 500, problem{Error: "database error"}); return }
		defer tx.Rollback()
		status, body, replay, err := reserveIdempotency(r.Context(), tx, org, key, hash)
		if err != nil { idempotencyFailure(w, r, err); return }
		if replay { writeRawJSON(w, status, body); return }
		if in.Source == "" { in.Source = "sandbox-json" }
		id := "imp_" + newID()
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO reconciliation_imports(id,organization_id,status,source_name,line_count) VALUES($1,$2,'matching',$3,$4)`, id, org, in.Source, len(in.Lines)); err != nil { writeJSON(w, 500, problem{Error: "reconciliation import could not be created"}); return }
		matched, exceptions := 0, 0
		for i, line := range in.Lines {
			var collectionID sql.NullString
			var exact bool
			err = tx.QueryRowContext(r.Context(), `SELECT id,(amount_minor=$3 AND currency=upper($4)) FROM collections WHERE organization_id=$1 AND reference=$2 AND status='succeeded' ORDER BY created_at DESC LIMIT 1`, org, line.Reference, line.Amount, line.Currency).Scan(&collectionID, &exact)
			if err != nil && err != sql.ErrNoRows { writeJSON(w, 500, problem{Error: "reconciliation match lookup failed"}); return }
			matchStatus := "unmatched"
			var linked any
			if err == nil && collectionID.Valid {
				if exact { matchStatus = "matched"; matched++ } else { matchStatus = "exception"; exceptions++ }
				linked = collectionID.String
			}
			_, err = tx.ExecContext(r.Context(), `INSERT INTO reconciliation_lines(import_id,external_reference,amount_minor,currency,transaction_date,match_status,matched_collection_id,organization_id) VALUES($1,$2,$3,upper($4),$5,$6,$7,$8)`, id, strings.TrimSpace(line.Reference), line.Amount, line.Currency, dates[i], matchStatus, linked, org)
			if err != nil { writeJSON(w, 500, problem{Error: "reconciliation line could not be stored"}); return }
			if matchStatus == "unmatched" { exceptions++ }
		}
		importStatus := "reconciled"
		if exceptions > 0 { importStatus = "needs_review" }
		if _, err = tx.ExecContext(r.Context(), `UPDATE reconciliation_imports SET status=$3 WHERE id=$1 AND organization_id=$2`, id, org, importStatus); err != nil { writeJSON(w, 500, problem{Error: "reconciliation status could not be updated"}); return }
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'reconciliation_import',$3,'reconciliation.import.completed',jsonb_build_object('import_id',$3::text,'line_count',$4::integer,'matched_count',$5::integer,'exception_count',$6::integer,'status',$7::text))`, "evt_"+newID(), org, id, len(in.Lines), matched, exceptions, importStatus); err != nil { writeJSON(w, 500, problem{Error: "reconciliation event could not be stored"}); return }
		result := map[string]any{"id": id, "status": importStatus, "source_name": in.Source, "line_count": len(in.Lines), "matched_count": matched, "exception_count": exceptions, "mode": "sandbox"}
		if err = storeIdempotency(r.Context(), tx, org, key, 201, result); err != nil { idempotencyFailure(w, r, err); return }
		if err = tx.Commit(); err != nil { writeJSON(w, 409, problem{Error: "reconciliation import conflict"}); return }
		writeJSON(w, 201, result)
		return
	}
	if len(parts) == 3 && parts[1] == "imports" && r.Method == http.MethodGet {
		var status, source string
		var count int
		var created time.Time
		err := a.db.QueryRowContext(r.Context(), `SELECT status,source_name,line_count,created_at FROM reconciliation_imports WHERE id=$1 AND organization_id=$2`, parts[2], org).Scan(&status, &source, &count, &created)
		if err == sql.ErrNoRows { notFound(w, r); return }
		if err != nil { writeJSON(w, 500, problem{Error: "database error"}); return }
		rows, err := a.db.QueryContext(r.Context(), `SELECT external_reference,amount_minor,currency,transaction_date,match_status,matched_collection_id FROM reconciliation_lines WHERE import_id=$1 ORDER BY id`, parts[2])
		if err != nil { writeJSON(w, 500, problem{Error: "database error"}); return }
		defer rows.Close()
		lines := []map[string]any{}
		for rows.Next() {
			var ref, currency, match string
			var amount int64
			var date time.Time
			var collection sql.NullString
			if rows.Scan(&ref, &amount, &currency, &date, &match, &collection) != nil { writeJSON(w, 500, problem{Error: "reconciliation lines could not be read"}); return }
			var collectionID any
			if collection.Valid { collectionID = collection.String }
			lines = append(lines, map[string]any{"external_reference": ref, "amount": amount, "currency": strings.TrimSpace(currency), "transaction_date": date, "match_status": match, "collection_id": collectionID})
		}
		if rows.Err() != nil { writeJSON(w, 500, problem{Error: "reconciliation lines could not be read"}); return }
		writeJSON(w, 200, map[string]any{"id": parts[2], "status": status, "source_name": source, "line_count": count, "created_at": created, "lines": lines})
		return
	}
	notFound(w, r)
}
