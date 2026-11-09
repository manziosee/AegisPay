package main

import (
	"context"
	"database/sql"
	"net/http"
	"net/mail"
	"strings"
	"time"
)

// archivedCustomer reports whether a customer exists in the workspace and is
// archived. New accounts and payment requests are refused for them.
func archivedCustomer(ctx context.Context, q querier, org, customerID string) bool {
	if strings.TrimSpace(customerID) == "" {
		return false
	}
	var status string
	if err := q.QueryRowContext(ctx, `SELECT status FROM customers WHERE id=$1 AND organization_id=$2`, customerID, org).Scan(&status); err != nil {
		return false
	}
	return status == "archived"
}

// customerDetail returns a customer with their accounts, balances and
// payment-request history.
func (a *App) customerDetail(w http.ResponseWriter, r *http.Request, org, id string) {
	ctx := r.Context()
	var out struct {
		ID      string     `json:"id"`
		Name    string     `json:"name"`
		Email   *string    `json:"email"`
		Phone   *string    `json:"phone"`
		Status  string     `json:"status"`
		Created time.Time  `json:"created_at"`
		Updated *time.Time `json:"updated_at"`
	}
	err := a.db.QueryRowContext(ctx, `SELECT id,name,email,phone,status,created_at,updated_at FROM customers WHERE id=$1 AND organization_id=$2`, id, org).
		Scan(&out.ID, &out.Name, &out.Email, &out.Phone, &out.Status, &out.Created, &out.Updated)
	if err == sql.ErrNoRows {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	accounts := []map[string]any{}
	rows, err := a.db.QueryContext(ctx, `SELECT a.id,a.currency,a.account_type,a.status,COALESCE(a.label,''),
		COALESCE((SELECT SUM(CASE l.side WHEN 'credit' THEN l.amount_minor ELSE -l.amount_minor END) FROM journal_lines l WHERE l.organization_id=a.organization_id AND l.account_id=a.id),0)
		FROM accounts a WHERE a.organization_id=$1 AND a.customer_id=$2 ORDER BY a.created_at`, org, id)
	if err != nil {
		writeJSON(w, 500, problem{Error: "customer accounts could not be loaded"})
		return
	}
	for rows.Next() {
		var accountID, currency, kind, status, label string
		var balance int64
		if rows.Scan(&accountID, &currency, &kind, &status, &label, &balance) == nil {
			accounts = append(accounts, map[string]any{"id": accountID, "currency": strings.TrimSpace(currency), "account_type": kind, "status": status, "label": nullable(label), "balance_minor": balance})
		}
	}
	_ = rows.Close()
	totals := []map[string]any{}
	rows, err = a.db.QueryContext(ctx, `SELECT currency,status,COUNT(*),COALESCE(SUM(amount_minor),0) FROM collections WHERE organization_id=$1 AND customer_id=$2 GROUP BY currency,status ORDER BY currency,status`, org, id)
	if err != nil {
		writeJSON(w, 500, problem{Error: "customer activity could not be loaded"})
		return
	}
	for rows.Next() {
		var currency, status string
		var count, amount int64
		if rows.Scan(&currency, &status, &count, &amount) == nil {
			totals = append(totals, map[string]any{"currency": strings.TrimSpace(currency), "status": status, "count": count, "amount_minor": amount})
		}
	}
	_ = rows.Close()
	recent := []map[string]any{}
	rows, err = a.db.QueryContext(ctx, `SELECT id,reference,amount_minor,currency,status,created_at FROM collections WHERE organization_id=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 10`, org, id)
	if err != nil {
		writeJSON(w, 500, problem{Error: "customer activity could not be loaded"})
		return
	}
	for rows.Next() {
		var collectionID, reference, currency, status string
		var amount int64
		var created time.Time
		if rows.Scan(&collectionID, &reference, &amount, &currency, &status, &created) == nil {
			recent = append(recent, map[string]any{"id": collectionID, "reference": reference, "amount": amount, "currency": strings.TrimSpace(currency), "status": status, "created_at": created})
		}
	}
	_ = rows.Close()
	writeJSON(w, 200, map[string]any{
		"id": out.ID, "name": out.Name, "email": out.Email, "phone": out.Phone, "status": out.Status,
		"created_at": out.Created, "updated_at": out.Updated,
		"accounts": accounts, "collection_totals": totals, "recent_collections": recent,
	})
}

// changeCustomer edits (PATCH) or removes (DELETE) a customer. A customer
// with accounts or payment requests is archived rather than deleted, because
// the ledger must keep pointing at them.
func (a *App) changeCustomer(w http.ResponseWriter, r *http.Request, org, id string) {
	var in struct {
		Name   *string `json:"name"`
		Email  *string `json:"email"`
		Phone  *string `json:"phone"`
		Status *string `json:"status"`
	}
	if r.Method == http.MethodPatch {
		if decode(r, &in) != nil || (in.Name == nil && in.Email == nil && in.Phone == nil && in.Status == nil) {
			bad(w, r, "name, email, phone or status is required")
			return
		}
		if in.Name != nil {
			*in.Name = strings.TrimSpace(*in.Name)
			if *in.Name == "" || len(*in.Name) > 200 {
				bad(w, r, "name must be 1 to 200 characters")
				return
			}
		}
		if in.Email != nil {
			*in.Email = strings.ToLower(strings.TrimSpace(*in.Email))
			if *in.Email != "" {
				if _, err := mail.ParseAddress(*in.Email); err != nil || len(*in.Email) > 254 {
					bad(w, r, "email is not a valid address")
					return
				}
			}
		}
		if in.Phone != nil {
			*in.Phone = strings.TrimSpace(*in.Phone)
			if len(*in.Phone) > 40 {
				bad(w, r, "phone must be at most 40 characters")
				return
			}
		}
		if in.Status != nil && *in.Status != "active" && *in.Status != "archived" {
			bad(w, r, "status must be active or archived")
			return
		}
	}
	ctx := r.Context()
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	defer tx.Rollback()
	var name, status string
	var email, phone sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT name,email,phone,status FROM customers WHERE id=$1 AND organization_id=$2 FOR UPDATE`, id, org).Scan(&name, &email, &phone, &status)
	if err == sql.ErrNoRows {
		notFound(w, r)
		return
	}
	if err != nil {
		writeJSON(w, 500, problem{Error: "database error"})
		return
	}
	actor := nullable(principalFrom(r).userID)
	if r.Method == http.MethodDelete {
		var used bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM accounts WHERE organization_id=$1 AND customer_id=$2) OR EXISTS(SELECT 1 FROM collections WHERE organization_id=$1 AND customer_id=$2)`, org, id).Scan(&used); err != nil {
			writeJSON(w, 500, problem{Error: "customer history could not be checked"})
			return
		}
		result := "deleted"
		if used {
			result = "archived"
			_, err = tx.ExecContext(ctx, `UPDATE customers SET status='archived',updated_at=now() WHERE id=$1 AND organization_id=$2`, id, org)
		} else {
			_, err = tx.ExecContext(ctx, `DELETE FROM customers WHERE id=$1 AND organization_id=$2`, id, org)
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,'customer',$5,jsonb_build_object('name',$6::text))`,
				"aud_"+newID(), org, actor, "customer."+result, id, name)
		}
		if err != nil {
			writeJSON(w, 500, problem{Error: "customer could not be removed", RequestID: requestID(r)})
			return
		}
		if err = tx.Commit(); err != nil {
			writeJSON(w, 409, problem{Error: "customer change conflict; try again"})
			return
		}
		message := "Customer deleted."
		if used {
			message = "Customer archived. They have accounts or payment requests, so their history is kept."
		}
		writeJSON(w, 200, map[string]any{"id": id, "status": result, "message": message})
		return
	}
	nextName, nextEmail, nextPhone, nextStatus := name, email.String, phone.String, status
	if in.Name != nil {
		nextName = *in.Name
	}
	if in.Email != nil {
		nextEmail = *in.Email
	}
	if in.Phone != nil {
		nextPhone = *in.Phone
	}
	if in.Status != nil {
		nextStatus = *in.Status
	}
	_, err = tx.ExecContext(ctx, `UPDATE customers SET name=$3,email=NULLIF($4,''),phone=NULLIF($5,''),status=$6,updated_at=now() WHERE id=$1 AND organization_id=$2`, id, org, nextName, nextEmail, nextPhone, nextStatus)
	if err != nil {
		writeJSON(w, 409, problem{Error: "customer could not be updated; another customer may already use that email", RequestID: requestID(r)})
		return
	}
	action := "customer.updated"
	if nextStatus != status {
		action = map[string]string{"archived": "customer.archived", "active": "customer.restored"}[nextStatus]
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,'customer',$5,jsonb_build_object('name',$6::text,'status',$7::text))`,
		"aud_"+newID(), org, actor, action, id, nextName, nextStatus); err != nil {
		writeJSON(w, 500, problem{Error: "customer audit could not be recorded"})
		return
	}
	if err = tx.Commit(); err != nil {
		writeJSON(w, 409, problem{Error: "customer change conflict; try again"})
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "name": nextName, "email": nullable(nextEmail), "phone": nullable(nextPhone), "status": nextStatus})
}
