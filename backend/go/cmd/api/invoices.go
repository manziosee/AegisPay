package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/mail"
	"strings"
	"time"
)

// Invoices are payment requests with a customer, a number, line items and
// tax. They keep the payment request's reference, so a bank or provider
// statement line with that reference marks them paid. A customer opens an
// invoice through an unguessable link without signing in; the link shows the
// invoice and the workspace's payment instructions and grants nothing else.

type invoiceLine struct {
	Description string  `json:"description"`
	Quantity    float64 `json:"quantity"`
	UnitAmount  int64   `json:"unit_amount"`
	Amount      int64   `json:"amount"`
}

const maxInvoiceAmount = int64(1e15)

// priceInvoice checks the lines and works out each line, the subtotal, the
// tax and the total, all in minor units.
func priceInvoice(lines []invoiceLine, taxBps int) ([]invoiceLine, int64, int64, error) {
	if len(lines) == 0 || len(lines) > 100 {
		return nil, 0, 0, errors.New("an invoice needs 1 to 100 lines")
	}
	if taxBps < 0 || taxBps > 10000 {
		return nil, 0, 0, errors.New("tax must be between 0% and 100%")
	}
	out := make([]invoiceLine, len(lines))
	var subtotal int64
	for i, line := range lines {
		line.Description = strings.TrimSpace(line.Description)
		if line.Description == "" || len(line.Description) > 300 {
			return nil, 0, 0, fmt.Errorf("line %d needs a description of up to 300 characters", i+1)
		}
		if line.Quantity <= 0 || line.Quantity > 1e6 || math.IsNaN(line.Quantity) {
			return nil, 0, 0, fmt.Errorf("line %d needs a quantity above 0", i+1)
		}
		// Up to three decimals, for hours or kilograms.
		line.Quantity = math.Round(line.Quantity*1000) / 1000
		if line.UnitAmount < 0 || line.UnitAmount > maxInvoiceAmount {
			return nil, 0, 0, fmt.Errorf("line %d has an invalid price", i+1)
		}
		amount := math.Round(line.Quantity * float64(line.UnitAmount))
		if amount > float64(maxInvoiceAmount) {
			return nil, 0, 0, fmt.Errorf("line %d is too large", i+1)
		}
		line.Amount = int64(amount)
		subtotal += line.Amount
		if subtotal > maxInvoiceAmount {
			return nil, 0, 0, errors.New("the invoice total is too large")
		}
		out[i] = line
	}
	tax := int64(math.Round(float64(subtotal) * float64(taxBps) / 10000))
	if subtotal+tax <= 0 {
		return nil, 0, 0, errors.New("the invoice total must be above zero")
	}
	return out, subtotal, tax, nil
}

// invoiceState is what people see: overdue is an open invoice past its due date.
func invoiceState(status string, due sql.NullTime, today time.Time) string {
	switch status {
	case "statement_confirmed", "marked_paid":
		return "paid"
	case "cancelled":
		return "cancelled"
	}
	if due.Valid && due.Time.Before(today) {
		return "overdue"
	}
	return "open"
}

func newShareToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "pay_" + newID() + newID()
	}
	return "pay_" + base64.RawURLEncoding.EncodeToString(b)
}

func payLink(token string) string { return dashboardURL() + "/pay/" + token }

const invoiceColumns = `r.id,COALESCE(r.invoice_number,''),r.reference,COALESCE(r.customer_id,''),COALESCE(c.name,''),COALESCE(c.email,''),
	r.amount_minor,r.tax_minor,r.tax_rate_bps,r.currency,r.description,r.line_items::text,r.notes,r.due_date,r.status,COALESCE(r.share_token,''),
	r.sent_at,r.paid_at,r.paid_note,r.reminder_count,COALESCE(r.recurring_id,''),r.created_at,r.updated_at`

const invoiceFrom = ` FROM bank_payment_requests r LEFT JOIN customers c ON c.organization_id=r.organization_id AND c.id=r.customer_id`

func scanInvoice(row interface{ Scan(...any) error }, today time.Time) (map[string]any, error) {
	var id, number, reference, customerID, customerName, customerEmail, currency, description, lines, notes, status, token, paidNote, recurringID string
	var amount, tax int64
	var taxBps, reminders int
	var due, sent, paid, updated sql.NullTime
	var created time.Time
	if err := row.Scan(&id, &number, &reference, &customerID, &customerName, &customerEmail, &amount, &tax, &taxBps, &currency, &description, &lines, &notes, &due, &status, &token,
		&sent, &paid, &paidNote, &reminders, &recurringID, &created, &updated); err != nil {
		return nil, err
	}
	var items []invoiceLine
	_ = json.Unmarshal([]byte(lines), &items)
	if len(items) == 0 {
		items = []invoiceLine{{Description: firstNonEmpty(description, "Payment"), Quantity: 1, UnitAmount: amount - tax, Amount: amount - tax}}
	}
	out := map[string]any{
		"id": id, "invoice_number": nullable(number), "reference": reference, "customer_id": nullable(customerID),
		"customer_name": nullable(customerName), "customer_email": nullable(customerEmail),
		"amount": amount, "subtotal": amount - tax, "tax": tax, "tax_rate_bps": taxBps, "currency": strings.TrimSpace(currency),
		"description": description, "line_items": items, "notes": notes, "due_date": nil, "status": status,
		"state": invoiceState(status, due, today), "share_url": nil, "sent_at": nil, "paid_at": nil, "paid_note": paidNote,
		"reminder_count": reminders, "recurring_id": nullable(recurringID), "created_at": created, "updated_at": nil,
	}
	if due.Valid {
		out["due_date"] = due.Time.Format("2006-01-02")
	}
	if token != "" {
		out["share_url"] = payLink(token)
	}
	for key, v := range map[string]sql.NullTime{"sent_at": sent, "paid_at": paid, "updated_at": updated} {
		if v.Valid {
			out[key] = v.Time
		}
	}
	return out, nil
}

// invoiceDraft is a fully checked invoice ready to be written.
type invoiceDraft struct {
	customerID, currency, description, notes, recurringID string
	lines                                                 []invoiceLine
	taxBps                                                int
	subtotal, tax                                         int64
	due                                                   *time.Time
}

// createInvoiceTx writes a new invoice with the next invoice number.
func createInvoiceTx(ctx context.Context, tx *sql.Tx, org, actorID string, d invoiceDraft) (string, string, error) {
	var next int
	if err := tx.QueryRowContext(ctx, `UPDATE organizations SET invoice_next_number=invoice_next_number+1 WHERE id=$1 RETURNING invoice_next_number-1`, org).Scan(&next); err != nil {
		return "", "", err
	}
	number := fmt.Sprintf("INV-%04d", next)
	id := "req_" + newID()
	reference := "AR-" + strings.ToUpper(newID()[:12])
	lines, _ := json.Marshal(d.lines)
	description := firstNonEmpty(d.description, d.lines[0].Description)
	if len(description) > 500 {
		description = description[:500]
	}
	var due any
	if d.due != nil {
		due = *d.due
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO bank_payment_requests(id,organization_id,amount_minor,currency,reference,description,due_date,created_by,customer_id,invoice_number,line_items,tax_rate_bps,tax_minor,notes,recurring_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),$10,$11::jsonb,$12,$13,$14,NULLIF($15,''))`,
		id, org, d.subtotal+d.tax, d.currency, reference, description, due, nullable(actorID), d.customerID, number, string(lines), d.taxBps, d.tax, d.notes, d.recurringID)
	if err != nil {
		return "", "", err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'invoice.created','bank_payment_request',$4,jsonb_build_object('invoice_number',$5::text,'amount_minor',$6::bigint,'currency',$7::text,'recurring_id',$8::text))`,
		"aud_"+newID(), org, nullable(actorID), id, number, d.subtotal+d.tax, d.currency, d.recurringID)
	return id, number, err
}

type invoiceInput struct {
	CustomerID  *string       `json:"customer_id"`
	Currency    string        `json:"currency"`
	Amount      int64         `json:"amount"`
	Description *string       `json:"description"`
	LineItems   []invoiceLine `json:"line_items"`
	TaxRateBps  *int          `json:"tax_rate_bps"`
	DueDate     *string       `json:"due_date"`
	Notes       *string       `json:"notes"`
}

func parseDueDate(value *string) (*time.Time, bool, error) {
	if value == nil {
		return nil, false, nil
	}
	if strings.TrimSpace(*value) == "" {
		return nil, true, nil
	}
	parsed, err := time.Parse("2006-01-02", strings.TrimSpace(*value))
	if err != nil {
		return nil, true, errors.New("due_date must use YYYY-MM-DD")
	}
	return &parsed, true, nil
}

func (a *App) invoices(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	switch {
	case len(parts) == 2 && parts[1] == "settings":
		a.invoiceSettings(w, r, org)
	case len(parts) == 1 && r.Method == http.MethodGet:
		a.listInvoices(w, r, org)
	case len(parts) == 1 && r.Method == http.MethodPost:
		a.createInvoice(w, r, org)
	case len(parts) == 2 && r.Method == http.MethodGet:
		row := a.db.QueryRowContext(r.Context(), `SELECT `+invoiceColumns+invoiceFrom+` WHERE r.id=$1 AND r.organization_id=$2`, parts[1], org)
		inv, err := scanInvoice(row, time.Now().UTC().Truncate(24*time.Hour))
		if err == sql.ErrNoRows {
			notFound(w, r)
			return
		}
		if err != nil {
			writeJSON(w, 500, problem{Error: "invoice could not be loaded", RequestID: requestID(r)})
			return
		}
		writeJSON(w, 200, inv)
	case len(parts) == 2 && r.Method == http.MethodPatch:
		a.updateInvoice(w, r, org, parts[1])
	case len(parts) == 3 && r.Method == http.MethodPost && (parts[2] == "cancel" || parts[2] == "mark-paid"):
		a.closeInvoice(w, r, org, parts[1], parts[2])
	case len(parts) == 3 && parts[2] == "share" && (r.Method == http.MethodPost || r.Method == http.MethodDelete):
		a.shareInvoice(w, r, org, parts[1])
	case len(parts) == 3 && parts[2] == "send" && r.Method == http.MethodPost:
		a.sendInvoice(w, r, org, parts[1])
	default:
		notFound(w, r)
	}
}

func (a *App) listInvoices(w http.ResponseWriter, r *http.Request, org string) {
	q := r.URL.Query()
	state := q.Get("state")
	switch state {
	case "", "all", "open", "overdue", "paid", "cancelled":
	default:
		bad(w, r, "state must be open, overdue, paid, cancelled or all")
		return
	}
	search := strings.ToLower(strings.TrimSpace(q.Get("q")))
	if len(search) > 100 {
		bad(w, r, "search is too long")
		return
	}
	rows, err := a.db.QueryContext(r.Context(), `SELECT `+invoiceColumns+invoiceFrom+`
		WHERE r.organization_id=$1 AND ($2='' OR r.customer_id=$2) AND ($3='' OR lower(r.reference||' '||COALESCE(r.invoice_number,'')||' '||r.description||' '||COALESCE(c.name,'')) LIKE '%'||$3||'%')
		ORDER BY r.created_at DESC LIMIT 500`, org, q.Get("customer_id"), search)
	if err != nil {
		writeJSON(w, 500, problem{Error: "invoices could not be loaded", RequestID: requestID(r)})
		return
	}
	defer rows.Close()
	today := time.Now().UTC().Truncate(24 * time.Hour)
	monthAgo := today.AddDate(0, 0, -30)
	data := []map[string]any{}
	type totals struct{ outstanding, overdue, paid30 int64 }
	sums := map[string]*totals{}
	for rows.Next() {
		inv, err := scanInvoice(rows, today)
		if err != nil {
			writeJSON(w, 500, problem{Error: "invoices could not be read", RequestID: requestID(r)})
			return
		}
		cur, s := inv["currency"].(string), inv["state"].(string)
		if sums[cur] == nil {
			sums[cur] = &totals{}
		}
		amount := inv["amount"].(int64)
		switch s {
		case "open":
			sums[cur].outstanding += amount
		case "overdue":
			sums[cur].outstanding += amount
			sums[cur].overdue += amount
		case "paid":
			if at, ok := inv["paid_at"].(time.Time); ok && at.After(monthAgo) {
				sums[cur].paid30 += amount
			}
		}
		if state == "" || state == "all" || state == s {
			data = append(data, inv)
		}
	}
	if err = rows.Err(); err != nil {
		writeJSON(w, 500, problem{Error: "invoices could not be read", RequestID: requestID(r)})
		return
	}
	summary := []map[string]any{}
	for cur, s := range sums {
		summary = append(summary, map[string]any{"currency": cur, "outstanding": s.outstanding, "overdue": s.overdue, "paid_last_30_days": s.paid30})
	}
	writeJSON(w, 200, map[string]any{"data": data, "summary": summary})
}

// draftFromInput turns create input into a checked draft.
func (a *App) draftFromInput(ctx context.Context, org string, in invoiceInput) (invoiceDraft, error) {
	d := invoiceDraft{currency: strings.ToUpper(strings.TrimSpace(in.Currency))}
	if len(d.currency) != 3 || !asciiCurrency(d.currency) {
		return d, errors.New("currency must be a three-letter code")
	}
	if in.Description != nil {
		d.description = strings.TrimSpace(*in.Description)
	}
	lines := in.LineItems
	if len(lines) == 0 {
		if in.Amount <= 0 {
			return d, errors.New("add at least one line, or a positive amount")
		}
		lines = []invoiceLine{{Description: firstNonEmpty(d.description, "Payment"), Quantity: 1, UnitAmount: in.Amount}}
	}
	if in.TaxRateBps != nil {
		d.taxBps = *in.TaxRateBps
	}
	var err error
	if d.lines, d.subtotal, d.tax, err = priceInvoice(lines, d.taxBps); err != nil {
		return d, err
	}
	if in.Notes != nil {
		d.notes = strings.TrimSpace(*in.Notes)
	}
	if len(d.notes) > 2000 || len(d.description) > 500 {
		return d, errors.New("notes may be up to 2000 characters and the description up to 500")
	}
	if d.due, _, err = parseDueDate(in.DueDate); err != nil {
		return d, err
	}
	if in.CustomerID != nil && strings.TrimSpace(*in.CustomerID) != "" {
		d.customerID = strings.TrimSpace(*in.CustomerID)
		var status string
		if err = a.db.QueryRowContext(ctx, `SELECT status FROM customers WHERE id=$1 AND organization_id=$2`, d.customerID, org).Scan(&status); err == sql.ErrNoRows {
			return d, errors.New("that customer is not in this workspace")
		} else if err != nil {
			return d, err
		}
		if status == "archived" {
			return d, errors.New("that customer is archived; restore them first")
		}
	}
	return d, nil
}

func (a *App) createInvoice(w http.ResponseWriter, r *http.Request, org string) {
	var in invoiceInput
	if decode(r, &in) != nil {
		bad(w, r, "a JSON invoice is required")
		return
	}
	d, err := a.draftFromInput(r.Context(), org, in)
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	id, _, err := createInvoiceTx(r.Context(), tx, org, principalFrom(r).userID, d)
	if err != nil {
		writeJSON(w, 500, problem{Error: "invoice could not be created", RequestID: requestID(r)})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "invoice creation conflict; try again"})
		return
	}
	inv, err := scanInvoice(a.db.QueryRowContext(r.Context(), `SELECT `+invoiceColumns+invoiceFrom+` WHERE r.id=$1`, id), time.Now().UTC().Truncate(24*time.Hour))
	if err != nil {
		writeJSON(w, 500, problem{Error: "invoice could not be loaded", RequestID: requestID(r)})
		return
	}
	writeJSON(w, 201, inv)
}

// updateInvoice edits an open invoice. Its reference never changes, so a
// payment already on its way still matches.
func (a *App) updateInvoice(w http.ResponseWriter, r *http.Request, org, id string) {
	var in invoiceInput
	if decode(r, &in) != nil {
		bad(w, r, "a JSON invoice is required")
		return
	}
	ctx := r.Context()
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	inv, err := scanInvoice(tx.QueryRowContext(ctx, `SELECT `+invoiceColumns+invoiceFrom+` WHERE r.id=$1 AND r.organization_id=$2 FOR UPDATE OF r`, id, org), time.Now().UTC())
	if err == sql.ErrNoRows {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "invoice could not be loaded"})
		return
	}
	if inv["status"] != "open" {
		writeJSON(w, 409, problem{Error: "only an open invoice can be edited", RequestID: requestID(r)})
		return
	}
	// Start from what is stored and apply what was sent.
	merged := invoiceInput{Currency: inv["currency"].(string), LineItems: inv["line_items"].([]invoiceLine)}
	desc, notes := inv["description"].(string), inv["notes"].(string)
	taxBps := inv["tax_rate_bps"].(int)
	merged.Description, merged.Notes, merged.TaxRateBps = &desc, &notes, &taxBps
	if c, ok := inv["customer_id"].(string); ok {
		merged.CustomerID = &c
	}
	if d, ok := inv["due_date"].(string); ok {
		merged.DueDate = &d
	}
	if in.CustomerID != nil {
		merged.CustomerID = in.CustomerID
	}
	if in.Currency != "" {
		merged.Currency = in.Currency
	}
	if len(in.LineItems) > 0 {
		merged.LineItems = in.LineItems
	}
	if in.Description != nil {
		merged.Description = in.Description
	}
	if in.Notes != nil {
		merged.Notes = in.Notes
	}
	if in.TaxRateBps != nil {
		merged.TaxRateBps = in.TaxRateBps
	}
	if in.DueDate != nil {
		merged.DueDate = in.DueDate
	}
	d, err := a.draftFromInput(ctx, org, merged)
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	lines, _ := json.Marshal(d.lines)
	var due any
	if d.due != nil {
		due = *d.due
	}
	if _, err = tx.ExecContext(ctx, `UPDATE bank_payment_requests SET customer_id=NULLIF($3,''),currency=$4,amount_minor=$5,tax_minor=$6,tax_rate_bps=$7,line_items=$8::jsonb,description=$9,notes=$10,due_date=$11,updated_at=now()
		WHERE id=$1 AND organization_id=$2`, id, org, d.customerID, d.currency, d.subtotal+d.tax, d.tax, d.taxBps, string(lines), firstNonEmpty(d.description, d.lines[0].Description), d.notes, due); err != nil {
		writeJSON(w, 500, problem{Error: "invoice could not be saved", RequestID: requestID(r)})
		return
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'invoice.updated','bank_payment_request',$4,jsonb_build_object('amount_minor',$5::bigint,'previous_amount_minor',$6::bigint))`,
		"aud_"+newID(), org, nullable(principalFrom(r).userID), id, d.subtotal+d.tax, inv["amount"]); err != nil {
		writeJSON(w, 500, problem{Error: "invoice change could not be audited"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "invoice change conflict; try again"})
		return
	}
	updated, err := scanInvoice(a.db.QueryRowContext(ctx, `SELECT `+invoiceColumns+invoiceFrom+` WHERE r.id=$1`, id), time.Now().UTC().Truncate(24*time.Hour))
	if err != nil {
		writeJSON(w, 500, problem{Error: "invoice could not be loaded"})
		return
	}
	writeJSON(w, 200, updated)
}

// closeInvoice cancels an open invoice, or marks it paid by hand (cash,
// cheque, a payment that will never appear on a statement).
func (a *App) closeInvoice(w http.ResponseWriter, r *http.Request, org, id, action string) {
	var in struct {
		Note   string `json:"note"`
		PaidOn string `json:"paid_on"`
	}
	if decode(r, &in) != nil || strings.TrimSpace(in.Note) == "" || len(in.Note) > 500 {
		bad(w, r, "a note of up to 500 characters is required")
		return
	}
	paidAt := time.Now().UTC()
	if action == "mark-paid" && in.PaidOn != "" {
		parsed, err := time.Parse("2006-01-02", in.PaidOn)
		if err != nil || parsed.After(paidAt) {
			bad(w, r, "paid_on must be a past date in YYYY-MM-DD")
			return
		}
		paidAt = parsed
	}
	status, auditAction := "cancelled", "invoice.cancelled"
	query := `UPDATE bank_payment_requests SET status='cancelled',paid_note=$3,updated_at=now() WHERE id=$1 AND organization_id=$2 AND status='open'`
	args := []any{id, org, strings.TrimSpace(in.Note)}
	if action == "mark-paid" {
		status, auditAction = "marked_paid", "invoice.marked_paid"
		query = `UPDATE bank_payment_requests SET status='marked_paid',paid_note=$3,paid_at=$4,updated_at=now() WHERE id=$1 AND organization_id=$2 AND status='open'`
		args = append(args, paidAt)
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(r.Context(), query, args...)
	if err != nil {
		writeJSON(w, 500, problem{Error: "invoice could not be updated", RequestID: requestID(r)})
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, 409, problem{Error: "only an open invoice can be cancelled or marked paid", RequestID: requestID(r)})
		return
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,'bank_payment_request',$5,jsonb_build_object('note',$6::text))`,
		"aud_"+newID(), org, nullable(principalFrom(r).userID), auditAction, id, strings.TrimSpace(in.Note)); err != nil {
		writeJSON(w, 500, problem{Error: "invoice change could not be audited"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "invoice change conflict; try again"})
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "status": status})
}

// shareInvoice creates (POST) or switches off (DELETE) the customer link.
func (a *App) shareInvoice(w http.ResponseWriter, r *http.Request, org, id string) {
	ctx := r.Context()
	if r.Method == http.MethodDelete {
		res, err := a.db.ExecContext(ctx, `UPDATE bank_payment_requests SET share_token=NULL,updated_at=now() WHERE id=$1 AND organization_id=$2`, id, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "link could not be switched off"})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			notFound(w, r)
			return
		}
		a.audit(r, org, "invoice.link_disabled", "bank_payment_request", id, map[string]any{})
		writeJSON(w, 200, map[string]any{"id": id, "share_url": nil})
		return
	}
	token, err := a.ensureShareToken(ctx, org, id)
	if err == sql.ErrNoRows {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "link could not be created", RequestID: requestID(r)})
		return
	}
	a.audit(r, org, "invoice.link_created", "bank_payment_request", id, map[string]any{})
	writeJSON(w, 200, map[string]any{"id": id, "share_url": payLink(token)})
}

func (a *App) ensureShareToken(ctx context.Context, org, id string) (string, error) {
	var token string
	err := a.db.QueryRowContext(ctx, `UPDATE bank_payment_requests SET share_token=COALESCE(share_token,$3) WHERE id=$1 AND organization_id=$2 RETURNING share_token`, id, org, newShareToken()).Scan(&token)
	return token, err
}

// emailAllowance stops a workspace being used to send bulk mail: the sender
// must have confirmed their email, and each workspace may send up to 100
// invoice emails a day.
func (a *App) emailAllowance(ctx context.Context, org, userID string) error {
	var verified bool
	if userID != "" {
		if err := a.db.QueryRowContext(ctx, `SELECT email_verified_at IS NOT NULL FROM users WHERE id=$1`, userID).Scan(&verified); err != nil {
			return err
		}
	} else if err := a.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.role='owner' AND m.status='active' AND u.email_verified_at IS NOT NULL)`, org).Scan(&verified); err != nil {
		return err
	}
	if !verified {
		return errors.New("confirm your email address before AegisPay sends invoices for you")
	}
	var sent int
	if err := a.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_logs WHERE organization_id=$1 AND action IN ('invoice.sent','invoice.reminded') AND created_at>now()-interval '1 day'`, org).Scan(&sent); err != nil {
		return err
	}
	if sent >= 100 {
		return errors.New("this workspace has sent 100 invoice emails today; try again tomorrow")
	}
	return nil
}

type invoiceEmailData struct {
	workspace, environment, replyTo, number, customerName, customerEmail, amount, due, reference, token, message string
}

func invoiceEmail(d invoiceEmailData, reminder int) email {
	practice := d.environment != "live"
	subject := "Invoice " + d.number + " from " + d.workspace + ": " + d.amount
	heading := "Invoice " + d.number
	paragraphs := []string{"Hello " + firstNonEmpty(d.customerName, "there") + ","}
	if reminder > 0 {
		subject = "Reminder: invoice " + d.number + " from " + d.workspace + " is overdue"
		heading = "Invoice " + d.number + " is overdue"
		paragraphs = append(paragraphs, d.workspace+" has not yet received payment of "+d.amount+", which was due on "+d.due+".")
	} else {
		line := d.workspace + " has sent you an invoice for " + d.amount
		if d.due != "" {
			line += ", due on " + d.due
		}
		paragraphs = append(paragraphs, line+".")
	}
	if d.message != "" {
		paragraphs = append(paragraphs, d.message)
	}
	paragraphs = append(paragraphs, "When you pay, use the reference "+d.reference+" so the payment is matched to this invoice. The link below shows how to pay.")
	if practice {
		subject = "[Practice] " + subject
		paragraphs = append(paragraphs, "This invoice comes from a practice workspace. No real payment is being requested.")
	}
	return email{
		To: d.customerEmail, ToName: d.customerName, ReplyTo: d.replyTo,
		Subject: subject, Heading: heading, Paragraphs: paragraphs,
		ActionLabel: "View invoice", ActionURL: payLink(d.token),
		Footer: "Sent by " + d.workspace + " using AegisPay. Reply to this email to contact them.",
	}
}

// loadInvoiceEmail gathers what an invoice email needs and makes sure the
// invoice has a customer link.
func (a *App) loadInvoiceEmail(ctx context.Context, org, id string) (invoiceEmailData, string, error) {
	var d invoiceEmailData
	var amount int64
	var currency, status string
	var due sql.NullTime
	err := a.db.QueryRowContext(ctx, `SELECT o.name,o.environment,COALESCE(r.invoice_number,r.reference),COALESCE(c.name,''),COALESCE(c.email,''),r.amount_minor,r.currency,r.due_date,r.reference,r.status,
		COALESCE((SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=o.id AND m.role='owner' AND m.status='active' AND u.email_verified_at IS NOT NULL ORDER BY m.joined_at LIMIT 1),'')
		FROM bank_payment_requests r JOIN organizations o ON o.id=r.organization_id LEFT JOIN customers c ON c.organization_id=r.organization_id AND c.id=r.customer_id
		WHERE r.id=$1 AND r.organization_id=$2`, id, org).Scan(&d.workspace, &d.environment, &d.number, &d.customerName, &d.customerEmail, &amount, &currency, &due, &d.reference, &status, &d.replyTo)
	if err != nil {
		return d, "", err
	}
	d.amount = formatMinorAmount(amount, currency)
	if due.Valid {
		d.due = due.Time.Format("2 January 2006")
	}
	if d.token, err = a.ensureShareToken(ctx, org, id); err != nil {
		return d, "", err
	}
	return d, status, nil
}

func (a *App) sendInvoice(w http.ResponseWriter, r *http.Request, org, id string) {
	var in struct {
		Message string `json:"message"`
	}
	_ = decode(r, &in)
	if len(in.Message) > 1000 {
		bad(w, r, "the message may be up to 1000 characters")
		return
	}
	ctx := r.Context()
	p := principalFrom(r)
	if err := a.emailAllowance(ctx, org, p.userID); err != nil {
		writeJSON(w, 403, problem{Error: err.Error(), RequestID: requestID(r)})
		return
	}
	d, status, err := a.loadInvoiceEmail(ctx, org, id)
	if err == sql.ErrNoRows {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "invoice could not be loaded", RequestID: requestID(r)})
		return
	}
	if status != "open" {
		writeJSON(w, 409, problem{Error: "only an open invoice can be sent", RequestID: requestID(r)})
		return
	}
	if _, err = mail.ParseAddress(d.customerEmail); err != nil {
		bad(w, r, "add an email address to this invoice's customer first")
		return
	}
	if p.userID != "" {
		_ = a.db.QueryRowContext(ctx, `SELECT email FROM users WHERE id=$1`, p.userID).Scan(&d.replyTo)
	}
	d.message = strings.TrimSpace(in.Message)
	a.sendEmailAsync(invoiceEmail(d, 0))
	_, _ = a.db.ExecContext(ctx, `UPDATE bank_payment_requests SET sent_at=now() WHERE id=$1 AND organization_id=$2`, id, org)
	a.audit(r, org, "invoice.sent", "bank_payment_request", id, map[string]any{"to": d.customerEmail})
	writeJSON(w, 202, map[string]any{"id": id, "status": "sent", "to": d.customerEmail, "share_url": payLink(d.token)})
}

// invoiceSettings holds what every invoice shows: how to pay, a footer, and
// whether overdue reminders go out automatically.
func (a *App) invoiceSettings(w http.ResponseWriter, r *http.Request, org string) {
	ctx := r.Context()
	if r.Method == http.MethodPut {
		var in struct {
			PaymentInstructions string `json:"payment_instructions"`
			Footer              string `json:"invoice_footer"`
			Reminders           bool   `json:"reminders_enabled"`
		}
		if decode(r, &in) != nil || len(in.PaymentInstructions) > 2000 || len(in.Footer) > 500 {
			bad(w, r, "payment instructions may be up to 2000 characters and the footer up to 500")
			return
		}
		if _, err := a.db.ExecContext(ctx, `UPDATE organizations SET payment_instructions=$2,invoice_footer=$3,invoice_reminders=$4 WHERE id=$1`, org, strings.TrimSpace(in.PaymentInstructions), strings.TrimSpace(in.Footer), in.Reminders); err != nil {
			writeJSON(w, 500, problem{Error: "invoice settings could not be saved"})
			return
		}
		a.audit(r, org, "invoice.settings_updated", "organization", org, map[string]any{"reminders_enabled": in.Reminders})
	} else if r.Method != http.MethodGet {
		notFound(w, r)
		return
	}
	var instructions, footer string
	var reminders bool
	var next int
	if err := a.db.QueryRowContext(ctx, `SELECT payment_instructions,invoice_footer,invoice_reminders,invoice_next_number FROM organizations WHERE id=$1`, org).Scan(&instructions, &footer, &reminders, &next); err != nil {
		writeJSON(w, 500, problem{Error: "invoice settings could not be loaded"})
		return
	}
	writeJSON(w, 200, map[string]any{"payment_instructions": instructions, "invoice_footer": footer, "reminders_enabled": reminders, "next_invoice_number": fmt.Sprintf("INV-%04d", next)})
}

// publicInvoice serves the customer's view of an invoice. No sign-in: the
// token in the link is the only key, and it shows only this invoice.
func (a *App) publicInvoice(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if !a.limitAttempt(w, r, "public-invoice:"+clientIP(r), 120, 10*time.Minute) {
		return
	}
	token := r.PathValue("token")
	if !strings.HasPrefix(token, "pay_") || len(token) > 80 {
		notFound(w, r)
		return
	}
	var workspace, environment, country, instructions, footer string
	var orgID string
	err := a.db.QueryRowContext(r.Context(), `SELECT r.organization_id,o.name,o.environment,COALESCE(o.country_code,''),o.payment_instructions,o.invoice_footer FROM bank_payment_requests r JOIN organizations o ON o.id=r.organization_id WHERE r.share_token=$1`, token).
		Scan(&orgID, &workspace, &environment, &country, &instructions, &footer)
	if err == sql.ErrNoRows {
		writeJSON(w, 404, problem{Error: "this invoice link is not valid or was switched off", RequestID: requestID(r)})
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "invoice unavailable", RequestID: requestID(r)})
		return
	}
	inv, err := scanInvoice(a.db.QueryRowContext(r.Context(), `SELECT `+invoiceColumns+invoiceFrom+` WHERE r.share_token=$1`, token), time.Now().UTC().Truncate(24*time.Hour))
	if err != nil {
		writeJSON(w, 500, problem{Error: "invoice unavailable", RequestID: requestID(r)})
		return
	}
	writeJSON(w, 200, map[string]any{
		"business":       map[string]any{"name": workspace, "country_code": country, "practice": environment != "live"},
		"invoice_number": inv["invoice_number"], "reference": inv["reference"], "customer_name": inv["customer_name"],
		"amount": inv["amount"], "subtotal": inv["subtotal"], "tax": inv["tax"], "tax_rate_bps": inv["tax_rate_bps"], "currency": inv["currency"],
		"description": inv["description"], "line_items": inv["line_items"], "notes": inv["notes"], "due_date": inv["due_date"],
		"state": inv["state"], "issued_at": inv["created_at"], "paid_at": inv["paid_at"],
		"payment_instructions": instructions, "footer": footer,
	})
}
