package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"time"
)

// Recurring invoices: rent, membership dues, retainers and school fees. The
// maintenance loop issues each one on its date, and can email it to the
// customer. It also sends overdue reminders for workspaces that turn them on.

// advanceSchedule returns the next issue date. Months keep the schedule's
// anchor day, clamped to the length of the month (31 Jan, 28 Feb, 31 Mar).
func advanceSchedule(day time.Time, frequency string, anchorDay int) time.Time {
	months := map[string]int{"monthly": 1, "quarterly": 3, "yearly": 12}[frequency]
	if months == 0 {
		return day.AddDate(0, 0, 7)
	}
	first := time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, months, 0)
	last := first.AddDate(0, 1, -1).Day()
	return first.AddDate(0, 0, min(max(anchorDay, 1), last)-1)
}

type recurringInput struct {
	CustomerID string        `json:"customer_id"`
	Currency   string        `json:"currency"`
	LineItems  []invoiceLine `json:"line_items"`
	TaxRateBps int           `json:"tax_rate_bps"`
	Notes      string        `json:"notes"`
	Frequency  string        `json:"frequency"`
	StartOn    string        `json:"start_on"`
	EndOn      string        `json:"end_on"`
	DueDays    *int          `json:"due_days"`
	AutoSend   bool          `json:"auto_send"`
	Status     string        `json:"status"`
}

func (in *recurringInput) check(today time.Time) (time.Time, *time.Time, error) {
	switch in.Frequency {
	case "weekly", "monthly", "quarterly", "yearly":
	default:
		return time.Time{}, nil, errors.New("frequency must be weekly, monthly, quarterly or yearly")
	}
	start, err := time.Parse("2006-01-02", in.StartOn)
	if err != nil {
		return time.Time{}, nil, errors.New("start_on must use YYYY-MM-DD")
	}
	if start.Before(today) {
		return time.Time{}, nil, errors.New("the first invoice date cannot be in the past")
	}
	var end *time.Time
	if in.EndOn != "" {
		parsed, err := time.Parse("2006-01-02", in.EndOn)
		if err != nil || parsed.Before(start) {
			return time.Time{}, nil, errors.New("end_on must be a date on or after start_on")
		}
		end = &parsed
	}
	if in.DueDays != nil && (*in.DueDays < 0 || *in.DueDays > 365) {
		return time.Time{}, nil, errors.New("due_days must be between 0 and 365")
	}
	return start, end, nil
}

const recurringColumns = `s.id,s.customer_id,COALESCE(c.name,''),COALESCE(c.email,''),s.currency,s.line_items::text,s.tax_rate_bps,s.notes,s.frequency,s.due_days,s.next_run_on,s.end_on,s.auto_send,s.status,s.issued_count,s.last_issued_at,s.created_at`

func scanRecurring(row interface{ Scan(...any) error }) (map[string]any, error) {
	var id, customerID, customerName, customerEmail, currency, lines, notes, frequency, status string
	var taxBps, dueDays, issued int
	var next time.Time
	var end, last sql.NullTime
	var autoSend bool
	var created time.Time
	if err := row.Scan(&id, &customerID, &customerName, &customerEmail, &currency, &lines, &taxBps, &notes, &frequency, &dueDays, &next, &end, &autoSend, &status, &issued, &last, &created); err != nil {
		return nil, err
	}
	var items []invoiceLine
	_ = json.Unmarshal([]byte(lines), &items)
	_, subtotal, tax, _ := priceInvoice(items, taxBps)
	out := map[string]any{
		"id": id, "customer_id": customerID, "customer_name": customerName, "customer_email": nullable(customerEmail),
		"currency": strings.TrimSpace(currency), "line_items": items, "tax_rate_bps": taxBps, "notes": notes,
		"amount": subtotal + tax, "frequency": frequency, "due_days": dueDays, "next_run_on": next.Format("2006-01-02"),
		"end_on": nil, "auto_send": autoSend, "status": status, "issued_count": issued, "last_issued_at": nil, "created_at": created,
	}
	if end.Valid {
		out["end_on"] = end.Time.Format("2006-01-02")
	}
	if last.Valid {
		out["last_issued_at"] = last.Time
	}
	return out, nil
}

func (a *App) recurringInvoices(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	ctx := r.Context()
	today := time.Now().UTC().Truncate(24 * time.Hour)
	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		rows, err := a.db.QueryContext(ctx, `SELECT `+recurringColumns+` FROM recurring_invoices s LEFT JOIN customers c ON c.organization_id=s.organization_id AND c.id=s.customer_id
			WHERE s.organization_id=$1 ORDER BY (s.status='ended'),s.next_run_on LIMIT 500`, org)
		if err != nil {
			writeJSON(w, 500, problem{Error: "recurring invoices could not be loaded"})
			return
		}
		defer rows.Close()
		data := []map[string]any{}
		for rows.Next() {
			item, err := scanRecurring(rows)
			if err != nil {
				writeJSON(w, 500, problem{Error: "recurring invoices could not be read"})
				return
			}
			data = append(data, item)
		}
		writeJSON(w, 200, map[string]any{"data": data})
	case len(parts) == 1 && r.Method == http.MethodPost:
		var in recurringInput
		if decode(r, &in) != nil {
			bad(w, r, "a JSON schedule is required")
			return
		}
		start, end, err := in.check(today)
		if err != nil {
			bad(w, r, err.Error())
			return
		}
		draft, err := a.draftFromInput(ctx, org, invoiceInput{CustomerID: &in.CustomerID, Currency: in.Currency, LineItems: in.LineItems, TaxRateBps: &in.TaxRateBps, Notes: &in.Notes})
		if err != nil {
			bad(w, r, err.Error())
			return
		}
		if draft.customerID == "" {
			bad(w, r, "a recurring invoice needs a customer")
			return
		}
		dueDays := 14
		if in.DueDays != nil {
			dueDays = *in.DueDays
		}
		lines, _ := json.Marshal(draft.lines)
		id := "rec_" + newID()
		var endValue any
		if end != nil {
			endValue = *end
		}
		if _, err = a.db.ExecContext(ctx, `INSERT INTO recurring_invoices(id,organization_id,customer_id,currency,line_items,tax_rate_bps,notes,frequency,due_days,next_run_on,end_on,auto_send,created_by,anchor_day)
			VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, id, org, draft.customerID, draft.currency, string(lines), draft.taxBps, draft.notes, in.Frequency, dueDays, start, endValue, in.AutoSend, nullable(principalFrom(r).userID), start.Day()); err != nil {
			writeJSON(w, 500, problem{Error: "recurring invoice could not be saved", RequestID: requestID(r)})
			return
		}
		a.audit(r, org, "recurring_invoice.created", "recurring_invoice", id, map[string]any{"frequency": in.Frequency, "amount_minor": draft.subtotal + draft.tax, "currency": draft.currency})
		a.writeRecurring(w, r, org, id, 201)
	case len(parts) == 2 && r.Method == http.MethodPatch:
		// Pause, resume or end a schedule, or change whether it emails.
		var in struct {
			Status   *string `json:"status"`
			AutoSend *bool   `json:"auto_send"`
		}
		if decode(r, &in) != nil || (in.Status == nil && in.AutoSend == nil) {
			bad(w, r, "status or auto_send is required")
			return
		}
		if in.Status != nil && *in.Status != "active" && *in.Status != "paused" && *in.Status != "ended" {
			bad(w, r, "status must be active, paused or ended")
			return
		}
		res, err := a.db.ExecContext(ctx, `UPDATE recurring_invoices SET status=COALESCE($3,status),auto_send=COALESCE($4,auto_send),
			next_run_on=CASE WHEN $3='active' AND next_run_on<current_date THEN current_date ELSE next_run_on END,updated_at=now()
			WHERE id=$1 AND organization_id=$2 AND status<>'ended'`, parts[1], org, in.Status, in.AutoSend)
		if err != nil {
			writeJSON(w, 500, problem{Error: "recurring invoice could not be updated"})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeJSON(w, 409, problem{Error: "this schedule does not exist or has ended", RequestID: requestID(r)})
			return
		}
		a.audit(r, org, "recurring_invoice.updated", "recurring_invoice", parts[1], map[string]any{"status": in.Status, "auto_send": in.AutoSend})
		a.writeRecurring(w, r, org, parts[1], 200)
	default:
		notFound(w, r)
	}
}

func (a *App) writeRecurring(w http.ResponseWriter, r *http.Request, org, id string, status int) {
	item, err := scanRecurring(a.db.QueryRowContext(r.Context(), `SELECT `+recurringColumns+` FROM recurring_invoices s LEFT JOIN customers c ON c.organization_id=s.organization_id AND c.id=s.customer_id WHERE s.id=$1 AND s.organization_id=$2`, id, org))
	if err != nil {
		writeJSON(w, 500, problem{Error: "recurring invoice could not be loaded"})
		return
	}
	writeJSON(w, status, item)
}

// runInvoiceSchedules issues due recurring invoices (one period per pass, so
// a missed day catches up) and sends overdue reminders.
func (a *App) runInvoiceSchedules(ctx context.Context) {
	for i := 0; i < 200 && ctx.Err() == nil; i++ {
		issued, err := a.issueNextRecurring(ctx)
		if err != nil {
			slog.Error("recurring invoice failed", "error", err)
			break
		}
		if !issued {
			break
		}
	}
	a.sendOverdueReminders(ctx)
}

func (a *App) issueNextRecurring(ctx context.Context) (bool, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var id, org, customerID, currency, lines, notes, frequency, customerStatus string
	var taxBps, dueDays, anchorDay int
	var next time.Time
	var end sql.NullTime
	var autoSend bool
	err = tx.QueryRowContext(ctx, `SELECT s.id,s.organization_id,s.customer_id,s.currency,s.line_items::text,s.tax_rate_bps,s.notes,s.frequency,s.due_days,s.next_run_on,s.end_on,s.auto_send,c.status,s.anchor_day
		FROM recurring_invoices s JOIN customers c ON c.organization_id=s.organization_id AND c.id=s.customer_id
		WHERE s.status='active' AND s.next_run_on<=current_date ORDER BY s.next_run_on LIMIT 1 FOR UPDATE OF s SKIP LOCKED`).
		Scan(&id, &org, &customerID, &currency, &lines, &taxBps, &notes, &frequency, &dueDays, &next, &end, &autoSend, &customerStatus, &anchorDay)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if end.Valid && next.After(end.Time) {
		_, err = tx.ExecContext(ctx, `UPDATE recurring_invoices SET status='ended',updated_at=now() WHERE id=$1`, id)
		return err == nil, firstErr(err, tx.Commit())
	}
	if customerStatus == "archived" {
		_, err = tx.ExecContext(ctx, `UPDATE recurring_invoices SET status='paused',updated_at=now() WHERE id=$1`, id)
		return err == nil, firstErr(err, tx.Commit())
	}
	var items []invoiceLine
	if err = json.Unmarshal([]byte(lines), &items); err != nil {
		return false, err
	}
	priced, subtotal, tax, err := priceInvoice(items, taxBps)
	if err != nil {
		return false, err
	}
	due := next.AddDate(0, 0, dueDays)
	invoiceID, _, err := createInvoiceTx(ctx, tx, org, "", invoiceDraft{customerID: customerID, currency: strings.TrimSpace(currency), notes: notes, recurringID: id, lines: priced, taxBps: taxBps, subtotal: subtotal, tax: tax, due: &due})
	if err != nil {
		return false, err
	}
	following := advanceSchedule(next, frequency, anchorDay)
	status := "active"
	if end.Valid && following.After(end.Time) {
		status = "ended"
	}
	if _, err = tx.ExecContext(ctx, `UPDATE recurring_invoices SET next_run_on=$2,status=$3,issued_count=issued_count+1,last_issued_at=now(),updated_at=now() WHERE id=$1`, id, following, status); err != nil {
		return false, err
	}
	if err = tx.Commit(); err != nil {
		return false, err
	}
	if autoSend && a.emailAllowance(ctx, org, "") == nil {
		if d, _, err := a.loadInvoiceEmail(ctx, org, invoiceID); err == nil {
			if _, mailErr := mail.ParseAddress(d.customerEmail); mailErr == nil {
				a.sendEmailAsync(invoiceEmail(d, 0))
				_, _ = a.db.ExecContext(ctx, `UPDATE bank_payment_requests SET sent_at=now() WHERE id=$1`, invoiceID)
				_, _ = a.db.ExecContext(ctx, `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,NULL,'invoice.sent','bank_payment_request',$3,jsonb_build_object('to',$4::text,'recurring_id',$5::text))`,
					"aud_"+newID(), org, invoiceID, d.customerEmail, id)
			}
		}
	}
	return true, nil
}

func firstErr(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// reminderDue reports whether an open invoice should get its next reminder:
// one day, seven days and fourteen days after the due date, three at most.
func reminderDue(due time.Time, sent int, last sql.NullTime, now time.Time) bool {
	steps := []int{1, 7, 14}
	if sent >= len(steps) || now.Before(due.AddDate(0, 0, steps[sent])) {
		return false
	}
	return !last.Valid || now.Sub(last.Time) > 20*time.Hour
}

func (a *App) sendOverdueReminders(ctx context.Context) {
	rows, err := a.db.QueryContext(ctx, `SELECT r.id,r.organization_id,r.due_date,r.reminder_count,r.last_reminder_at FROM bank_payment_requests r
		JOIN organizations o ON o.id=r.organization_id JOIN customers c ON c.organization_id=r.organization_id AND c.id=r.customer_id
		WHERE o.invoice_reminders AND r.status='open' AND r.due_date<current_date AND r.reminder_count<3 AND c.email IS NOT NULL AND c.status='active'
		ORDER BY r.due_date LIMIT 300`)
	if err != nil {
		slog.Error("invoice reminder scan failed", "error", err)
		return
	}
	type candidate struct {
		id, org string
		due     time.Time
		sent    int
		last    sql.NullTime
	}
	var due []candidate
	now := time.Now().UTC()
	for rows.Next() {
		var c candidate
		if rows.Scan(&c.id, &c.org, &c.due, &c.sent, &c.last) == nil && reminderDue(c.due, c.sent, c.last, now) {
			due = append(due, c)
		}
	}
	_ = rows.Close()
	for _, c := range due {
		if ctx.Err() != nil || a.emailAllowance(ctx, c.org, "") != nil {
			continue
		}
		// Claim the reminder first so two machines never both send it.
		res, err := a.db.ExecContext(ctx, `UPDATE bank_payment_requests SET reminder_count=reminder_count+1,last_reminder_at=now() WHERE id=$1 AND reminder_count=$2 AND status='open'`, c.id, c.sent)
		if err != nil {
			continue
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue
		}
		d, _, err := a.loadInvoiceEmail(ctx, c.org, c.id)
		if err != nil {
			continue
		}
		if _, err = mail.ParseAddress(d.customerEmail); err != nil {
			continue
		}
		a.sendEmailAsync(invoiceEmail(d, c.sent+1))
		_, _ = a.db.ExecContext(ctx, `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,NULL,'invoice.reminded','bank_payment_request',$3,jsonb_build_object('reminder',$4::integer,'to',$5::text))`,
			"aud_"+newID(), c.org, c.id, c.sent+1, d.customerEmail)
	}
}
