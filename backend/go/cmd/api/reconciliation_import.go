package main

import (
	"database/sql"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
)

const (
	reconciliationInsertChunk = 1000
	maxStatementLines         = 10000
	// A 10,000-line statement is about 1.2 MiB as JSON, above the default
	// request limit.
	reconciliationBodyLimit = 4 << 20
)

type statementLine struct {
	Reference string `json:"external_reference"`
	Amount    int64  `json:"amount"`
	Fee       int64  `json:"provider_fee"`
	Currency  string `json:"currency"`
	Date      string `json:"transaction_date"`
}

type reconciliationCandidate struct {
	id, currency, status string
	amount               int64
	alreadyMatched       bool
}

// lineOutcome is the matching decision for one statement line before it is
// written.
type lineOutcome struct {
	id                             int64
	status, reason                 string
	collectionID, requestID, payID *string
	duplicateOf                    *int64
}

func statementKey(reference string, amount int64, currency string, date time.Time) string {
	return fmt.Sprintf("%s|%d|%s|%s", reference, amount, strings.ToUpper(strings.TrimSpace(currency)), date.UTC().Format("2006-01-02"))
}

// createReconciliationImport matches statement lines against collections,
// bank payment requests and payout instructions. Lookups and writes are done
// in bulk so a 10,000-line statement needs a handful of queries rather than
// several per line.
func (a *App) createReconciliationImport(w http.ResponseWriter, r *http.Request, org string) {
	var in struct {
		Source string          `json:"source_name"`
		Lines  []statementLine `json:"lines"`
	}
	if decodeWithLimit(r, &in, reconciliationBodyLimit) != nil || len(in.Lines) == 0 || len(in.Lines) > maxStatementLines {
		bad(w, r, "between 1 and 10000 statement lines are required")
		return
	}
	a.importStatementLines(w, r, org, in.Source, in.Lines)
}

// importStatementLines validates and stores lines from either the JSON or the
// CSV endpoint. The caller must already have decoded the request body, which
// records the hash used for idempotency.
func (a *App) importStatementLines(w http.ResponseWriter, r *http.Request, org, source string, lines []statementLine) {
	in := struct {
		Source string
		Lines  []statementLine
	}{source, lines}
	dates := make([]time.Time, len(in.Lines))
	now := time.Now().UTC()
	for i := range in.Lines {
		line := &in.Lines[i]
		line.Reference = strings.TrimSpace(line.Reference)
		line.Currency = strings.ToUpper(strings.TrimSpace(line.Currency))
		if line.Reference == "" || len(line.Currency) != 3 || line.Amount <= 0 || line.Fee < 0 || line.Amount > math.MaxInt64-line.Fee {
			bad(w, r, "each line requires an external_reference, positive net amount, non-negative provider_fee, and three-letter currency")
			return
		}
		dates[i] = now
		if line.Date != "" {
			parsed, err := time.Parse(time.RFC3339, line.Date)
			if err != nil {
				bad(w, r, "transaction_date values must use RFC3339")
				return
			}
			dates[i] = parsed.UTC()
		}
	}
	key, hash, err := requireIdempotencyKey(r)
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	ctx := r.Context()
	tx, err := a.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	status, body, replay, err := reserveIdempotency(ctx, tx, org, key, hash)
	if err != nil {
		idempotencyFailure(w, r, err)
		return
	}
	if replay {
		writeRawJSON(w, status, body)
		return
	}
	var closed bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM close_periods c, unnest($2::timestamptz[]) AS d(at)
		WHERE c.organization_id=$1 AND c.status='closed' AND c.period_start <= (d.at AT TIME ZONE 'UTC')::date AND c.period_end > (d.at AT TIME ZONE 'UTC')::date)`, org, dates).Scan(&closed); err != nil {
		writeJSON(w, 500, problem{Error: "closed-period check failed"})
		return
	}
	if closed {
		writeJSON(w, 409, problem{Error: "statement contains activity in a closed period; an owner or admin must reopen it first"})
		return
	}

	refSet := map[string]bool{}
	references := make([]string, 0, len(in.Lines))
	for _, line := range in.Lines {
		if !refSet[line.Reference] {
			refSet[line.Reference] = true
			references = append(references, line.Reference)
		}
	}

	// Statement lines already imported with the same reference, amount,
	// currency and date are duplicates of the earliest such line.
	previous := map[string]int64{}
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT ON (external_reference,amount_minor,currency,(transaction_date AT TIME ZONE 'UTC')::date)
		id,external_reference,amount_minor,currency,transaction_date FROM reconciliation_lines
		WHERE organization_id=$1 AND external_reference=ANY($2)
		ORDER BY external_reference,amount_minor,currency,(transaction_date AT TIME ZONE 'UTC')::date,id`, org, references)
	if err != nil {
		writeJSON(w, 500, problem{Error: "duplicate statement lookup failed"})
		return
	}
	for rows.Next() {
		var id, amount int64
		var ref, currency string
		var date time.Time
		if err = rows.Scan(&id, &ref, &amount, &currency, &date); err != nil {
			_ = rows.Close()
			writeJSON(w, 500, problem{Error: "duplicate statement lookup failed"})
			return
		}
		previous[statementKey(ref, amount, currency, date)] = id
	}
	if err = rows.Close(); err != nil {
		writeJSON(w, 500, problem{Error: "duplicate statement lookup failed"})
		return
	}

	// References are unique per organization in each table, so each lookup
	// yields at most one candidate per reference.
	// In a live workspace the statement is what confirms money arrived, so
	// pending collections are candidates too.
	environment, err := organizationEnvironment(ctx, tx, org)
	if err != nil {
		writeJSON(w, 500, problem{Error: "workspace could not be loaded"})
		return
	}
	collections, err := loadCandidates(tx, r, `SELECT c.reference,c.id,c.amount_minor,c.currency,c.status,
		EXISTS(SELECT 1 FROM reconciliation_lines l WHERE l.organization_id=c.organization_id AND l.matched_collection_id=c.id AND l.match_status='matched')
		FROM collections c WHERE c.organization_id=$1 AND c.reference=ANY($2) AND (c.status='succeeded' OR (c.status='pending' AND (SELECT environment FROM organizations WHERE id=$1)='live'))`, org, references)
	if err != nil {
		writeJSON(w, 500, problem{Error: "reconciliation match lookup failed"})
		return
	}
	requests, err := loadCandidates(tx, r, `SELECT reference,id,amount_minor,currency,status,false FROM bank_payment_requests WHERE organization_id=$1 AND reference=ANY($2)`, org, references)
	if err != nil {
		writeJSON(w, 500, problem{Error: "payment-request match lookup failed"})
		return
	}
	payouts, err := loadCandidates(tx, r, `SELECT reference,id,amount_minor,currency,status,false FROM bank_payout_instructions WHERE organization_id=$1 AND reference=ANY($2)`, org, references)
	if err != nil {
		writeJSON(w, 500, problem{Error: "payout match lookup failed"})
		return
	}

	lineIDs := make([]int64, 0, len(in.Lines))
	rows, err = tx.QueryContext(ctx, `SELECT nextval(pg_get_serial_sequence('reconciliation_lines','id')) FROM generate_series(1,$1)`, len(in.Lines))
	if err != nil {
		writeJSON(w, 500, problem{Error: "reconciliation line IDs could not be allocated"})
		return
	}
	for rows.Next() {
		var id int64
		if err = rows.Scan(&id); err != nil {
			_ = rows.Close()
			writeJSON(w, 500, problem{Error: "reconciliation line IDs could not be allocated"})
			return
		}
		lineIDs = append(lineIDs, id)
	}
	if err = rows.Close(); err != nil || len(lineIDs) != len(in.Lines) {
		writeJSON(w, 500, problem{Error: "reconciliation line IDs could not be allocated"})
		return
	}
	sort.Slice(lineIDs, func(i, j int) bool { return lineIDs[i] < lineIDs[j] })

	outcomes := make([]lineOutcome, len(in.Lines))
	usedCollections, usedRequests, usedPayouts := map[string]bool{}, map[string]bool{}, map[string]bool{}
	var confirmedRequests, confirmedPayouts, confirmedCollections []string
	var auditActions, auditTypes, auditResources []string
	var auditLines []int64
	matched, exceptions := 0, 0
	for i, line := range in.Lines {
		out := lineOutcome{id: lineIDs[i], status: "unmatched"}
		k := statementKey(line.Reference, line.Amount, line.Currency, dates[i])
		gross := line.Amount + line.Fee
		if dup, ok := previous[k]; ok {
			out.status = "duplicate"
			out.duplicateOf = &dup
			out.reason = fmt.Sprintf("Duplicate of previously imported statement line %d", dup)
		} else if c, ok := collections[line.Reference]; ok {
			out.collectionID = &c.id
			switch {
			case c.alreadyMatched || usedCollections[c.id]:
				out.status = "exception"
				out.reason = "Reference matches a collection that is already reconciled by another statement line"
			case c.amount == gross && strings.EqualFold(c.currency, line.Currency):
				out.status = "matched"
				usedCollections[c.id] = true
				if c.status == "pending" {
					confirmedCollections = append(confirmedCollections, c.id)
				}
			default:
				out.status = "exception"
				out.reason = "Reference matches a succeeded collection, but amount or currency differs"
			}
		} else if req, ok := requests[line.Reference]; ok {
			if req.status == "open" && !usedRequests[req.id] && req.amount == gross && strings.EqualFold(req.currency, line.Currency) {
				out.status = "matched"
				out.requestID = &req.id
				usedRequests[req.id] = true
				confirmedRequests = append(confirmedRequests, req.id)
				auditActions, auditTypes, auditResources, auditLines = append(auditActions, "bank_request.statement_confirmed"), append(auditTypes, "bank_payment_request"), append(auditResources, req.id), append(auditLines, out.id)
			} else {
				out.status = "exception"
				out.reason = "Reference matches a payment request, but amount, currency, or request status differs"
			}
		} else if pay, ok := payouts[line.Reference]; ok {
			submittable := pay.status == "exported_for_manual_entry" || pay.status == "submitted_to_bank"
			if submittable && !usedPayouts[pay.id] && pay.amount == line.Amount && strings.EqualFold(pay.currency, line.Currency) {
				out.status = "matched"
				out.payID = &pay.id
				usedPayouts[pay.id] = true
				confirmedPayouts = append(confirmedPayouts, pay.id)
				auditActions, auditTypes, auditResources, auditLines = append(auditActions, "bank_payout.statement_confirmed"), append(auditTypes, "bank_payout"), append(auditResources, pay.id), append(auditLines, out.id)
			} else {
				out.status = "exception"
				out.reason = "Reference matches a payout instruction, but amount, currency, or payout status differs"
			}
		} else {
			out.reason = "No collection, payment request, or payout instruction has this reference"
		}
		if out.status == "matched" {
			matched++
		} else {
			exceptions++
		}
		if _, seen := previous[k]; !seen {
			// Later identical lines in this same statement are duplicates of this one.
			previous[k] = out.id
		}
		outcomes[i] = out
	}

	if in.Source == "" {
		in.Source = "sandbox-json"
	}
	id := "imp_" + newID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO reconciliation_imports(id,organization_id,status,source_name,line_count) VALUES($1,$2,'matching',$3,$4)`, id, org, in.Source, len(in.Lines)); err != nil {
		writeJSON(w, 500, problem{Error: "reconciliation import could not be created"})
		return
	}
	for start := 0; start < len(in.Lines); start += reconciliationInsertChunk {
		end := min(start+reconciliationInsertChunk, len(in.Lines))
		n := end - start
		ids, refs, currencies, statuses, reasons := make([]int64, n), make([]string, n), make([]string, n), make([]string, n), make([]string, n)
		amounts, fees := make([]int64, n), make([]int64, n)
		chunkDates := make([]time.Time, n)
		collectionIDs, requestIDs, payoutIDs := make([]*string, n), make([]*string, n), make([]*string, n)
		duplicates := make([]*int64, n)
		for j := 0; j < n; j++ {
			line, out := in.Lines[start+j], outcomes[start+j]
			ids[j], refs[j], currencies[j], statuses[j], reasons[j] = out.id, line.Reference, line.Currency, out.status, out.reason
			amounts[j], fees[j], chunkDates[j] = line.Amount, line.Fee, dates[start+j]
			collectionIDs[j], requestIDs[j], payoutIDs[j], duplicates[j] = out.collectionID, out.requestID, out.payID, out.duplicateOf
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO reconciliation_lines(id,import_id,organization_id,external_reference,amount_minor,currency,transaction_date,match_status,matched_collection_id,provider_fee_minor,matched_request_id,matched_payout_id,duplicate_of,suggestion_reason)
			SELECT l.id,$1,$2,l.ref,l.amount,l.currency,l.at,l.status,l.collection_id,l.fee,l.request_id,l.payout_id,l.duplicate_of,l.reason
			FROM unnest($3::bigint[],$4::text[],$5::bigint[],$6::text[],$7::timestamptz[],$8::text[],$9::text[],$10::bigint[],$11::text[],$12::text[],$13::bigint[],$14::text[])
			AS l(id,ref,amount,currency,at,status,collection_id,fee,request_id,payout_id,duplicate_of,reason)`,
			id, org, ids, refs, amounts, currencies, chunkDates, statuses, collectionIDs, fees, requestIDs, payoutIDs, duplicates, reasons); err != nil {
			writeJSON(w, 500, problem{Error: "reconciliation lines could not be stored"})
			return
		}
	}
	for _, collectionID := range confirmedCollections {
		if err = ensurePeriodOpen(ctx, tx, org, time.Now()); err != nil {
			periodGuardFailure(w, r, err)
			return
		}
		if err = confirmCollectionFromStatement(ctx, tx, org, collectionID); err != nil {
			writeJSON(w, 500, problem{Error: "collection could not be confirmed from the statement", RequestID: requestID(r)})
			return
		}
	}
	if len(confirmedRequests) > 0 {
		if _, err = tx.ExecContext(ctx, `UPDATE bank_payment_requests SET status='statement_confirmed' WHERE organization_id=$1 AND id=ANY($2) AND status='open'`, org, confirmedRequests); err != nil {
			writeJSON(w, 500, problem{Error: "payment request settlement status could not be updated"})
			return
		}
	}
	if len(confirmedPayouts) > 0 {
		if _, err = tx.ExecContext(ctx, `UPDATE bank_payout_instructions SET status='statement_confirmed' WHERE organization_id=$1 AND id=ANY($2) AND status<>'cancelled'`, org, confirmedPayouts); err != nil {
			writeJSON(w, 500, problem{Error: "payout settlement status could not be updated"})
			return
		}
	}
	if len(auditActions) > 0 {
		p := principalFrom(r)
		if _, err = tx.ExecContext(ctx, `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata)
			SELECT 'aud_'||replace(gen_random_uuid()::text,'-',''),$1,$2,a.action,a.resource_type,a.resource_id,jsonb_build_object('import_id',$3::text,'line_id',a.line_id)
			FROM unnest($4::text[],$5::text[],$6::text[],$7::bigint[]) AS a(action,resource_type,resource_id,line_id)`,
			org, nullable(p.userID), id, auditActions, auditTypes, auditResources, auditLines); err != nil {
			writeJSON(w, 500, problem{Error: "bank settlement decision could not be audited"})
			return
		}
	}
	importStatus := "reconciled"
	if exceptions > 0 {
		importStatus = "needs_review"
	}
	if _, err = tx.ExecContext(ctx, `UPDATE reconciliation_imports SET status=$3 WHERE id=$1 AND organization_id=$2`, id, org, importStatus); err != nil {
		writeJSON(w, 500, problem{Error: "reconciliation status could not be updated"})
		return
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'reconciliation_import',$3,'reconciliation.import.completed',jsonb_build_object('import_id',$3::text,'line_count',$4::integer,'matched_count',$5::integer,'exception_count',$6::integer,'status',$7::text))`, "evt_"+newID(), org, id, len(in.Lines), matched, exceptions, importStatus); err != nil {
		writeJSON(w, 500, problem{Error: "reconciliation event could not be stored"})
		return
	}
	result := map[string]any{"id": id, "status": importStatus, "source_name": in.Source, "line_count": len(in.Lines), "matched_count": matched, "exception_count": exceptions, "mode": environment, "collections_confirmed": len(confirmedCollections)}
	if err = storeIdempotency(ctx, tx, org, key, 201, result); err != nil {
		idempotencyFailure(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "reconciliation import conflict"})
		return
	}
	writeJSON(w, 201, result)
}

func loadCandidates(tx *sql.Tx, r *http.Request, query, org string, references []string) (map[string]reconciliationCandidate, error) {
	rows, err := tx.QueryContext(r.Context(), query, org, references)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]reconciliationCandidate{}
	for rows.Next() {
		var ref string
		var c reconciliationCandidate
		if err = rows.Scan(&ref, &c.id, &c.amount, &c.currency, &c.status, &c.alreadyMatched); err != nil {
			return nil, err
		}
		c.currency = strings.TrimSpace(c.currency)
		out[ref] = c
	}
	return out, rows.Err()
}
