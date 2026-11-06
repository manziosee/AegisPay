package main

import (
	"encoding/csv"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// transactionReport exposes a tenant-scoped activity view across collections,
// transfers, and refunds. It intentionally describes ledger/sandbox records;
// it does not claim that a provider settled real funds.
func (a *App) transactionReport(w http.ResponseWriter, r *http.Request) {
	org := currentOrgID(r, a.orgID)
	limit, cursor, err := pagination(r)
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	query := r.URL.Query()
	from := time.Now().UTC().AddDate(0, 0, -30)
	if raw := query.Get("from"); raw != "" {
		from, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			bad(w, r, "from must be RFC3339")
			return
		}
	}
	to := time.Now().UTC()
	if raw := query.Get("to"); raw != "" {
		to, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			bad(w, r, "to must be RFC3339")
			return
		}
	}
	if !from.Before(to) || to.Sub(from) > 366*24*time.Hour {
		bad(w, r, "date range must be positive and no longer than 366 days")
		return
	}
	currency := strings.ToUpper(strings.TrimSpace(query.Get("currency")))
	if currency != "" && len(currency) != 3 {
		bad(w, r, "currency must be a three-letter code")
		return
	}
	typ := query.Get("type")
	if typ != "" && typ != "collection" && typ != "transfer" && typ != "refund" {
		bad(w, r, "type must be collection, transfer, or refund")
		return
	}

	// Use a single normalized source so filters and cursor pagination behave
	// consistently across the three transaction families.
	const source = `
		SELECT id, 'collection'::text AS type, status, reference, amount_minor, currency::text, created_at
		FROM collections WHERE organization_id=$1
		UNION ALL
		SELECT id, 'transfer', status, reference, amount_minor, currency::text, created_at
		FROM transfers WHERE organization_id=$1
		UNION ALL
		SELECT id, 'refund', status, reference, amount_minor, currency::text, created_at
		FROM refunds WHERE organization_id=$1`
	filters := ` WHERE created_at >= $2 AND created_at < $3 AND ($4='' OR currency=$4) AND ($5='' OR type=$5) AND ($6='' OR status=$6)`
	status := strings.TrimSpace(query.Get("status"))
	if len(status) > 32 {
		bad(w, r, "status is too long")
		return
	}
	format := query.Get("format")
	if format != "" && format != "json" && format != "csv" {
		bad(w, r, "format must be json or csv")
		return
	}

	// Summary covers the full selected date/filter range; the activity list is
	// cursor-paginated independently, so every page carries the same totals.
	summaryRows, err := a.db.QueryContext(r.Context(), `SELECT type,status,currency,COUNT(*),COALESCE(SUM(amount_minor),0) FROM (`+source+`) tx`+filters+` GROUP BY type,status,currency ORDER BY currency,type,status`, org, from, to, currency, typ, status)
	if err != nil {
		writeJSON(w, 500, problem{Error: "transaction summary unavailable"})
		return
	}
	summary := make([]map[string]any, 0)
	for summaryRows.Next() {
		var t, s, c string
		var count, amount int64
		if err = summaryRows.Scan(&t, &s, &c, &count, &amount); err != nil {
			_ = summaryRows.Close()
			writeJSON(w, 500, problem{Error: "transaction summary unavailable"})
			return
		}
		summary = append(summary, map[string]any{"type": t, "status": s, "currency": strings.TrimSpace(c), "count": count, "amount_minor": amount})
	}
	if err = summaryRows.Err(); err != nil {
		_ = summaryRows.Close()
		writeJSON(w, 500, problem{Error: "transaction summary unavailable"})
		return
	}
	_ = summaryRows.Close()

	cursorTime, cursorID := cursorArgs(cursor)
	rows, err := a.db.QueryContext(r.Context(), `SELECT id,type,status,reference,amount_minor,currency,created_at FROM (`+source+`) tx`+filters+` AND ($7::timestamptz IS NULL OR (created_at,id)<($7,$8)) ORDER BY created_at DESC,id DESC LIMIT $9`, org, from, to, currency, typ, status, cursorTime, cursorID, limit+1)
	if err != nil {
		writeJSON(w, 500, problem{Error: "transaction activity unavailable"})
		return
	}
	defer rows.Close()
	data := make([]map[string]any, 0, limit+1)
	for rows.Next() {
		var c pageCursor
		var t, s, reference, cur string
		var amount int64
		if err = rows.Scan(&c.ID, &t, &s, &reference, &amount, &cur, &c.CreatedAt); err != nil {
			writeJSON(w, 500, problem{Error: "transaction activity unavailable"})
			return
		}
		data = append(data, map[string]any{"id": c.ID, "type": t, "status": s, "reference": reference, "amount_minor": amount, "currency": strings.TrimSpace(cur), "created_at": c.CreatedAt})
	}
	if err = rows.Err(); err != nil {
		writeJSON(w, 500, problem{Error: "transaction activity unavailable"})
		return
	}
	more := len(data) > limit
	var next string
	if more {
		data = data[:limit]
		last := data[len(data)-1]
		next = encodeCursor(pageCursor{ID: last["id"].(string), CreatedAt: last["created_at"].(time.Time)})
	}
	if format == "csv" {
		w.Header().Set("X-AegisPay-From", from.Format(time.RFC3339))
		w.Header().Set("X-AegisPay-To", to.Format(time.RFC3339))
		w.Header().Set("X-AegisPay-Has-More", strconv.FormatBool(more))
		if more {
			w.Header().Set("X-AegisPay-Next-Cursor", next)
		}
		writeTransactionCSV(w, data)
		return
	}
	mode, notice := "sandbox", "Amounts describe recorded sandbox ledger activity; they do not represent provider settlement."
	if environment, envErr := organizationEnvironment(r.Context(), a.db, org); envErr == nil && environment == "live" {
		mode, notice = "live", "Amounts describe recorded ledger activity; your bank statements remain the record of settlement."
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"mode": mode, "from": from, "to": to,
		"notice":  notice,
		"summary": summary, "data": data, "has_more": more, "next_cursor": nullable(next),
	})
}

func writeTransactionCSV(w http.ResponseWriter, rows []map[string]any) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="aegispay-transactions.csv"`)
	w.WriteHeader(http.StatusOK)
	writer := csv.NewWriter(w)
	_ = writer.Write([]string{"id", "type", "status", "reference", "amount_minor", "currency", "created_at"})
	for _, row := range rows {
		_ = writer.Write([]string{
			csvSafe(row["id"].(string)), row["type"].(string), row["status"].(string),
			csvSafe(row["reference"].(string)), strconv.FormatInt(row["amount_minor"].(int64), 10),
			row["currency"].(string), row["created_at"].(time.Time).Format(time.RFC3339Nano),
		})
	}
	writer.Flush()
}

func csvSafe(value string) string {
	trimmed := strings.TrimLeft(value, " \t\r\n")
	if trimmed != "" && strings.ContainsRune("=+-@", rune(trimmed[0])) {
		return "'" + value
	}
	return value
}
