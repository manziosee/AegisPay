package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"
)

var errPeriodClosed = errors.New("the accounting period for this posting is closed; an owner or admin must reopen it first")

// ensurePeriodOpen rejects ledger postings dated inside a closed period.
// Covering periods are locked FOR SHARE, so closing one waits until in-flight
// postings commit, and a posting cannot slip in after the close is recorded.
// Period boundaries are UTC dates, matching reconciliation imports.
func ensurePeriodOpen(ctx context.Context, tx *sql.Tx, org string, at time.Time) error {
	rows, err := tx.QueryContext(ctx, `SELECT status FROM close_periods WHERE organization_id=$1 AND period_start <= ($2::timestamptz AT TIME ZONE 'UTC')::date AND period_end > ($2::timestamptz AT TIME ZONE 'UTC')::date FOR SHARE`, org, at.UTC())
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var status string
		if err = rows.Scan(&status); err != nil {
			return err
		}
		if status == "closed" {
			return errPeriodClosed
		}
	}
	return rows.Err()
}

// periodGuardFailure writes the response for an ensurePeriodOpen error.
func periodGuardFailure(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, errPeriodClosed) {
		writeJSON(w, 409, problem{Error: err.Error(), RequestID: requestID(r)})
		return
	}
	writeJSON(w, 500, problem{Error: "closed-period check failed", RequestID: requestID(r)})
}
