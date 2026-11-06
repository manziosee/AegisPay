package main

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
)

// organizationEnvironment reports whether a workspace is 'sandbox' (practice)
// or 'live'.
func organizationEnvironment(ctx context.Context, q querier, org string) (string, error) {
	var environment string
	err := q.QueryRowContext(ctx, `SELECT environment FROM organizations WHERE id=$1`, org).Scan(&environment)
	return environment, err
}

// requireSandbox refuses simulation tools in live workspaces, where money is
// only confirmed by bank statements or provider connectors.
func (a *App) requireSandbox(w http.ResponseWriter, r *http.Request, org string) bool {
	environment, err := organizationEnvironment(r.Context(), a.db, org)
	if err != nil {
		writeJSON(w, 500, problem{Error: "workspace could not be loaded", RequestID: requestID(r)})
		return false
	}
	if environment != "sandbox" {
		writeJSON(w, 403, problem{Error: "this is a live workspace: simulated money is not available. Collections are confirmed when a bank statement line matches them", RequestID: requestID(r)})
		return false
	}
	return true
}

// confirmCollectionFromStatement records money a bank statement proved was
// received: it credits the workspace's main account in that currency and
// marks the collection succeeded.
func confirmCollectionFromStatement(ctx context.Context, tx *sql.Tx, org, collectionID string) error {
	var amount int64
	var currency string
	if err := tx.QueryRowContext(ctx, `SELECT amount_minor,currency FROM collections WHERE id=$1 AND organization_id=$2 AND status='pending' FOR UPDATE`, collectionID, org).Scan(&amount, &currency); err != nil {
		return err
	}
	currency = strings.TrimSpace(currency)
	account, err := statementAccount(ctx, tx, org, currency, "wallet", "acc_")
	if err != nil {
		return err
	}
	clearing, err := statementAccount(ctx, tx, org, currency, "bank_clearing", "acc_bank_")
	if err != nil {
		return err
	}
	entry := "jrn_" + newID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO journal_entries(id,organization_id,reference_type,reference_id,currency,amount_minor) VALUES($1,$2,'collection',$3,$4,$5)`, entry, org, collectionID, currency, amount); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO journal_lines(journal_entry_id,organization_id,account_id,side,amount_minor,currency) VALUES($1,$2,$3,'debit',$5,$6),($1,$2,$4,'credit',$5,$6)`, entry, org, clearing, account, amount, currency); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE collections SET status='succeeded',credited_account_id=$3 WHERE id=$1 AND organization_id=$2`, collectionID, org, account); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'collection',$3,'collection.succeeded',jsonb_build_object('collection_id',$3::text,'status','succeeded','amount',$4::bigint,'currency',$5::text,'confirmed_by','bank_statement'))`, "evt_"+newID(), org, collectionID, amount, currency)
	return err
}

// statementAccount finds or creates the workspace's oldest active account of a
// type in a currency, preferring accounts not tied to one customer.
func statementAccount(ctx context.Context, tx *sql.Tx, org, currency, accountType, idPrefix string) (string, error) {
	var id string
	err := tx.QueryRowContext(ctx, `SELECT id FROM accounts WHERE organization_id=$1 AND currency=$2 AND account_type=$3 AND status='active' ORDER BY customer_id NULLS FIRST,created_at LIMIT 1`, org, currency, accountType).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != sql.ErrNoRows {
		return "", err
	}
	id = idPrefix + newID()
	_, err = tx.ExecContext(ctx, `INSERT INTO accounts(id,organization_id,currency,account_type) VALUES($1,$2,$3,$4)`, id, org, currency, accountType)
	return id, err
}
