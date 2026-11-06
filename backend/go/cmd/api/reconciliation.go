package main

import (
	"database/sql"
	"net/http"
	"strings"
	"time"
)

func (a *App) reconciliation(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	if len(parts) == 3 && parts[1] == "imports" && parts[2] == "file" && r.Method == http.MethodPost {
		a.importStatementFile(w, r)
		return
	}
	if len(parts) == 3 && parts[1] == "imports" && parts[2] == "csv" && r.Method == http.MethodPost {
		a.importStatementCSV(w, r)
		return
	}
	if len(parts) == 2 && parts[1] == "imports" && r.Method == http.MethodGet {
		a.listReconciliationImports(w, r, org)
		return
	}
	if len(parts) == 6 && parts[1] == "imports" && parts[3] == "lines" && parts[5] == "resolve" && r.Method == http.MethodPost {
		a.resolveReconciliationLine(w, r, org, parts[2], parts[4])
		return
	}
	if len(parts) == 2 && parts[1] == "imports" && r.Method == http.MethodPost {
		a.createReconciliationImport(w, r, org)
		return
	}
	if len(parts) == 3 && parts[1] == "imports" && r.Method == http.MethodGet {
		var status, source string
		var count int
		var created time.Time
		err := a.db.QueryRowContext(r.Context(), `SELECT status,source_name,line_count,created_at FROM reconciliation_imports WHERE id=$1 AND organization_id=$2`, parts[2], org).Scan(&status, &source, &count, &created)
		if err == sql.ErrNoRows {
			notFound(w, r)
			return
		}
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		rows, err := a.db.QueryContext(r.Context(), `SELECT id,external_reference,amount_minor,currency,transaction_date,match_status,matched_collection_id,provider_fee_minor,matched_request_id,matched_payout_id,duplicate_of,suggestion_reason FROM reconciliation_lines WHERE import_id=$1 AND organization_id=$2 ORDER BY id`, parts[2], org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "database error"})
			return
		}
		defer rows.Close()
		lines := []map[string]any{}
		for rows.Next() {
			var ref, currency, match string
			var lineID int64
			var amount int64
			var providerFee int64
			var date time.Time
			var collection sql.NullString
			var requestID, payoutID sql.NullString
			var duplicateOf sql.NullInt64
			var suggestion string
			if rows.Scan(&lineID, &ref, &amount, &currency, &date, &match, &collection, &providerFee, &requestID, &payoutID, &duplicateOf, &suggestion) != nil {
				writeJSON(w, 500, problem{Error: "reconciliation lines could not be read"})
				return
			}
			var collectionID any
			if collection.Valid {
				collectionID = collection.String
			}
			lines = append(lines, map[string]any{"line_id": lineID, "external_reference": ref, "amount": amount, "provider_fee": providerFee, "gross_amount": amount + providerFee, "currency": strings.TrimSpace(currency), "transaction_date": date, "match_status": match, "collection_id": collectionID, "payment_request_id": nullableNull(requestID), "payout_id": nullableNull(payoutID), "duplicate_of": nullableInt64(duplicateOf), "suggestion_reason": suggestion})
		}
		if rows.Err() != nil {
			writeJSON(w, 500, problem{Error: "reconciliation lines could not be read"})
			return
		}
		writeJSON(w, 200, map[string]any{"id": parts[2], "status": status, "source_name": source, "line_count": count, "created_at": created, "lines": lines})
		return
	}
	notFound(w, r)
}

func (a *App) listReconciliationImports(w http.ResponseWriter, r *http.Request, org string) {
	limit, cursor, err := pagination(r)
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	switch status {
	case "", "matching", "needs_review", "reconciled":
	default:
		bad(w, r, "status must be matching, needs_review, or reconciled")
		return
	}
	at, afterID := cursorArgs(cursor)
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT i.id,i.status,i.source_name,i.line_count,i.created_at,
			COUNT(l.id) FILTER (WHERE l.match_status='matched')::integer,
			COUNT(l.id) FILTER (WHERE l.match_status NOT IN ('matched','ignored'))::integer
		FROM reconciliation_imports i
		LEFT JOIN reconciliation_lines l
			ON l.import_id=i.id AND l.organization_id=i.organization_id
		WHERE i.organization_id=$1 AND ($2='' OR i.status=$2)
			AND ($3::timestamptz IS NULL OR (i.created_at,i.id)<($3,$4))
		GROUP BY i.id
		ORDER BY i.created_at DESC,i.id DESC
		LIMIT $5`, org, status, at, afterID, limit+1)
	if err != nil {
		writeJSON(w, 500, problem{Error: "reconciliation imports unavailable"})
		return
	}
	defer rows.Close()
	type importRow struct {
		pageCursor
		status, source string
		lineCount      int
		matched        int
		exceptions     int
	}
	imports := make([]importRow, 0, limit+1)
	for rows.Next() {
		var item importRow
		if err = rows.Scan(&item.ID, &item.status, &item.source, &item.lineCount, &item.CreatedAt, &item.matched, &item.exceptions); err != nil {
			writeJSON(w, 500, problem{Error: "reconciliation imports unavailable"})
			return
		}
		imports = append(imports, item)
	}
	if err = rows.Err(); err != nil {
		writeJSON(w, 500, problem{Error: "reconciliation imports unavailable"})
		return
	}
	more := len(imports) > limit
	if more {
		imports = imports[:limit]
	}
	data := make([]map[string]any, 0, len(imports))
	for _, item := range imports {
		data = append(data, map[string]any{
			"id": item.ID, "status": item.status, "source_name": item.source,
			"line_count": item.lineCount, "matched_count": item.matched,
			"exception_count": item.exceptions, "created_at": item.CreatedAt,
		})
	}
	var next string
	if more {
		last := imports[len(imports)-1]
		next = encodeCursor(pageCursor{ID: last.ID, CreatedAt: last.CreatedAt})
	}
	pageResponse(w, data, more, next)
}

func (a *App) resolveReconciliationLine(w http.ResponseWriter, r *http.Request, org, importID, lineID string) {
	var in struct {
		Resolution   string `json:"resolution"`
		CollectionID string `json:"collection_id"`
		Note         string `json:"note"`
	}
	if decode(r, &in) != nil || (in.Resolution != "match" && in.Resolution != "ignore") || strings.TrimSpace(in.Note) == "" || (in.Resolution == "match" && in.CollectionID == "") {
		bad(w, r, "resolution (match or ignore), a note, and collection_id for match are required")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	var status string
	var amount, fee int64
	var currency string
	err = tx.QueryRowContext(r.Context(), `SELECT match_status,amount_minor,provider_fee_minor,currency FROM reconciliation_lines WHERE id=$1 AND import_id=$2 AND organization_id=$3 FOR UPDATE`, lineID, importID, org).Scan(&status, &amount, &fee, &currency)
	if err == sql.ErrNoRows {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "reconciliation line could not be loaded"})
		return
	}
	if status == "matched" || status == "ignored" {
		writeJSON(w, 409, problem{Error: "reconciliation line has already been resolved"})
		return
	}
	if status == "duplicate" && in.Resolution == "match" {
		writeJSON(w, 409, problem{Error: "duplicate statement lines can only be ignored after review"})
		return
	}
	var collection any
	if in.Resolution == "match" {
		var collectionAmount int64
		var collectionCurrency, collectionStatus string
		err = tx.QueryRowContext(r.Context(), `SELECT amount_minor,currency,status FROM collections WHERE id=$1 AND organization_id=$2`, in.CollectionID, org).Scan(&collectionAmount, &collectionCurrency, &collectionStatus)
		if err == sql.ErrNoRows {
			notFound(w, r)
			return
		}

		if err != nil {
			writeJSON(w, 500, problem{Error: "collection lookup failed"})
			return
		}
		environment, envErr := organizationEnvironment(r.Context(), tx, org)
		if envErr != nil {
			writeJSON(w, 500, problem{Error: "workspace could not be loaded"})
			return
		}
		confirmable := collectionStatus == "pending" && environment == "live"
		if (collectionStatus != "succeeded" && !confirmable) || strings.TrimSpace(collectionCurrency) != strings.TrimSpace(currency) || collectionAmount != amount+fee {
			writeJSON(w, 409, problem{Error: "collection must be succeeded and match the statement gross amount and currency"})
			return
		}
		if confirmable {
			if err = confirmCollectionFromStatement(r.Context(), tx, org, in.CollectionID); err != nil {
				writeJSON(w, 500, problem{Error: "collection could not be confirmed from the statement"})
				return
			}
		}
		var reconciled bool
		if err = tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM reconciliation_lines WHERE organization_id=$1 AND matched_collection_id=$2 AND match_status='matched')`, org, in.CollectionID).Scan(&reconciled); err != nil {
			writeJSON(w, 500, problem{Error: "collection reconciliation check failed"})
			return
		}
		if reconciled {
			writeJSON(w, 409, problem{Error: "collection is already reconciled by another statement line"})
			return
		}
		collection = in.CollectionID
	}
	newStatus := "ignored"
	if in.Resolution == "match" {
		newStatus = "matched"
	}
	p := principalFrom(r)
	_, err = tx.ExecContext(r.Context(), `UPDATE reconciliation_lines SET match_status=$4,matched_collection_id=$5,resolution_note=$6,resolved_by=$7,resolved_at=now() WHERE id=$1 AND import_id=$2 AND organization_id=$3`, lineID, importID, org, newStatus, collection, strings.TrimSpace(in.Note), nullable(p.userID))
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `UPDATE reconciliation_imports SET status=CASE WHEN EXISTS (SELECT 1 FROM reconciliation_lines WHERE import_id=$1 AND organization_id=$2 AND match_status NOT IN ('matched','ignored')) THEN 'needs_review' ELSE 'reconciled' END WHERE id=$1 AND organization_id=$2`, importID, org)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'reconciliation.line.resolved','reconciliation_line',$4,jsonb_build_object('resolution',$5::text,'note',$6::text,'import_id',$7::text))`, "aud_"+newID(), org, nullable(p.userID), lineID, in.Resolution, strings.TrimSpace(in.Note), importID)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'reconciliation_line',$3,'reconciliation.line.resolved',jsonb_build_object('line_id',$3::text,'import_id',$4::text,'resolution',$5::text,'match_status',$6::text))`, "evt_"+newID(), org, lineID, importID, in.Resolution, newStatus)
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "reconciliation resolution could not be recorded"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "reconciliation resolution conflict"})
		return
	}
	writeJSON(w, 200, map[string]any{"import_id": importID, "line_id": lineID, "match_status": newStatus, "collection_id": collection, "resolution_note": strings.TrimSpace(in.Note)})
}

func nullableInt64(v sql.NullInt64) any {
	if !v.Valid {
		return nil
	}
	return v.Int64
}
