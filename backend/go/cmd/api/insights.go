package main

import (
	"context"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Charts and cash forecasting from the ledger. Accounts whose type ends in
// "clearing" stand for the outside world (the bank, the sandbox); every other
// account holds the business's money. For each journal entry, credits minus
// debits on held accounts is money in (positive) or out (negative); internal
// transfers between held accounts net to zero and are not counted.

const heldAccount = `a.account_type NOT LIKE '%clearing'`

type dailyFlow struct {
	in, out int64
}

// dailyFlows returns money in and out per UTC day for one currency.
func (a *App) dailyFlows(ctx context.Context, org, currency string, from, to time.Time) (map[string]dailyFlow, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT to_char(day,'YYYY-MM-DD'),
		COALESCE(SUM(net) FILTER (WHERE net>0),0),COALESCE(-SUM(net) FILTER (WHERE net<0),0)
		FROM (SELECT (l.created_at AT TIME ZONE 'UTC')::date AS day,
			SUM(CASE l.side WHEN 'credit' THEN l.amount_minor ELSE -l.amount_minor END) AS net
			FROM journal_lines l JOIN accounts a ON a.id=l.account_id AND a.organization_id=l.organization_id
			WHERE l.organization_id=$1 AND l.currency=$2 AND l.created_at>=$3 AND l.created_at<$4 AND `+heldAccount+`
			GROUP BY l.journal_entry_id,day) e
		GROUP BY day`, org, currency, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]dailyFlow{}
	for rows.Next() {
		var day string
		var f dailyFlow
		if err = rows.Scan(&day, &f.in, &f.out); err != nil {
			return nil, err
		}
		out[day] = f
	}
	return out, rows.Err()
}

// heldBalances is the money held per currency right now.
func (a *App) heldBalances(ctx context.Context, org string) (map[string]int64, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT l.currency,SUM(CASE l.side WHEN 'credit' THEN l.amount_minor ELSE -l.amount_minor END)
		FROM journal_lines l JOIN accounts a ON a.id=l.account_id AND a.organization_id=l.organization_id
		WHERE l.organization_id=$1 AND `+heldAccount+` GROUP BY l.currency`, org)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var currency string
		var amount int64
		if err = rows.Scan(&currency, &amount); err != nil {
			return nil, err
		}
		out[strings.TrimSpace(currency)] = amount
	}
	return out, rows.Err()
}

// pickCurrency uses the requested currency, or the one with the most money.
func pickCurrency(requested string, balances map[string]int64, fallback string) string {
	requested = strings.ToUpper(strings.TrimSpace(requested))
	if len(requested) == 3 {
		return requested
	}
	best, bestAmount := "", int64(math.MinInt64)
	for currency, amount := range balances {
		if amount > bestAmount || (amount == bestAmount && currency < best) {
			best, bestAmount = currency, amount
		}
	}
	return firstNonEmpty(best, fallback)
}

func sortedCurrencies(balances map[string]int64) []map[string]any {
	keys := make([]string, 0, len(balances))
	for k := range balances {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]map[string]any, 0, len(keys))
	for _, k := range keys {
		out = append(out, map[string]any{"currency": k, "balance_minor": balances[k]})
	}
	return out
}

func boundedDays(raw string, def, lo, hi int) int {
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return max(lo, min(hi, n))
}

func (a *App) workspaceCurrency(ctx context.Context, org string) string {
	var country string
	_ = a.db.QueryRowContext(ctx, `SELECT country_code FROM organizations WHERE id=$1`, org).Scan(&country)
	return firstNonEmpty(countryCurrency[strings.ToUpper(strings.TrimSpace(country))], "USD")
}

// activityReport feeds the overview charts: money in and out per day,
// balances per currency, and payment requests by status.
func (a *App) activityReport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	org := currentOrgID(r, a.orgID)
	days := boundedDays(r.URL.Query().Get("days"), 30, 7, 365)
	balances, err := a.heldBalances(ctx, org)
	if err != nil {
		writeJSON(w, 500, problem{Error: "activity unavailable", RequestID: requestID(r)})
		return
	}
	currency := pickCurrency(r.URL.Query().Get("currency"), balances, a.workspaceCurrency(ctx, org))
	today := time.Now().UTC().Truncate(24 * time.Hour)
	from := today.AddDate(0, 0, -(days - 1))
	flows, err := a.dailyFlows(ctx, org, currency, from, today.AddDate(0, 0, 1))
	if err != nil {
		writeJSON(w, 500, problem{Error: "activity unavailable", RequestID: requestID(r)})
		return
	}
	series := make([]map[string]any, 0, days)
	var totalIn, totalOut int64
	for d := from; !d.After(today); d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		f := flows[key]
		totalIn += f.in
		totalOut += f.out
		series = append(series, map[string]any{"date": key, "money_in": f.in, "money_out": f.out})
	}
	statuses := []map[string]any{}
	rows, err := a.db.QueryContext(ctx, `SELECT status,COUNT(*),COALESCE(SUM(amount_minor),0) FROM collections
		WHERE organization_id=$1 AND currency=$2 AND created_at>=$3 GROUP BY status ORDER BY 3 DESC`, org, currency, from)
	if err != nil {
		writeJSON(w, 500, problem{Error: "activity unavailable", RequestID: requestID(r)})
		return
	}
	for rows.Next() {
		var status string
		var count, amount int64
		if rows.Scan(&status, &count, &amount) == nil {
			statuses = append(statuses, map[string]any{"status": status, "count": count, "amount_minor": amount})
		}
	}
	_ = rows.Close()
	writeJSON(w, 200, map[string]any{
		"currency": currency, "days": days, "series": series,
		"total_in": totalIn, "total_out": totalOut, "balances": sortedCurrencies(balances),
		"collections_by_status": statuses,
	})
}

type expectedItem struct {
	Kind      string    `json:"kind"`
	ID        string    `json:"id"`
	Reference string    `json:"reference"`
	Amount    int64     `json:"amount_minor"`
	Expected  time.Time `json:"expected_on"`
	Overdue   bool      `json:"overdue"`
}

// cashForecast projects the balance of one currency forward. The "known"
// line uses only money already expected (open payment requests, payouts not
// yet confirmed) plus the usual daily spending; the "typical" line assumes
// the last 90 days' average money in continues. Runway is the number of days
// until the known line falls below zero.
func (a *App) cashForecast(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	org := currentOrgID(r, a.orgID)
	horizon := boundedDays(r.URL.Query().Get("days"), 90, 14, 365)
	balances, err := a.heldBalances(ctx, org)
	if err != nil {
		writeJSON(w, 500, problem{Error: "forecast unavailable", RequestID: requestID(r)})
		return
	}
	currency := pickCurrency(r.URL.Query().Get("currency"), balances, a.workspaceCurrency(ctx, org))
	balance := balances[currency]
	today := time.Now().UTC().Truncate(24 * time.Hour)
	const lookback = 90
	from := today.AddDate(0, 0, -(lookback - 1))
	flows, err := a.dailyFlows(ctx, org, currency, from, today.AddDate(0, 0, 1))
	if err != nil {
		writeJSON(w, 500, problem{Error: "forecast unavailable", RequestID: requestID(r)})
		return
	}
	// Average over the days since the first activity in the window, so a
	// new workspace is not diluted by empty days before it existed.
	first := today
	var sumIn, sumOut int64
	for key, f := range flows {
		if d, e := time.Parse("2006-01-02", key); e == nil && d.Before(first) {
			first = d
		}
		sumIn += f.in
		sumOut += f.out
	}
	observed := int(today.Sub(first).Hours()/24) + 1
	avgIn, avgOut := float64(sumIn)/float64(observed), float64(sumOut)/float64(observed)

	// History: walk back from today's balance.
	history := make([]map[string]any, lookback)
	running := balance
	for i := lookback - 1; i >= 0; i-- {
		d := from.AddDate(0, 0, i)
		key := d.Format("2006-01-02")
		history[i] = map[string]any{"date": key, "balance": running}
		f := flows[key]
		running -= f.in - f.out
	}

	expected := []expectedItem{}
	rows, err := a.db.QueryContext(ctx, `
		SELECT 'payment_request',id,reference,amount_minor,COALESCE(due_date::timestamptz,created_at+interval '14 days') FROM bank_payment_requests
			WHERE organization_id=$1 AND currency=$2 AND status='open'
		UNION ALL
		SELECT 'collection',id,reference,amount_minor,created_at+interval '7 days' FROM collections
			WHERE organization_id=$1 AND currency=$2 AND status='pending'
		UNION ALL
		SELECT 'payout',id,reference,amount_minor,COALESCE(submitted_at,created_at)+interval '2 days' FROM bank_payout_instructions
			WHERE organization_id=$1 AND currency=$2 AND status IN ('prepared','exported_for_manual_entry','submitted_to_bank')
		ORDER BY 5 LIMIT 2000`, org, currency)
	if err != nil {
		writeJSON(w, 500, problem{Error: "forecast unavailable", RequestID: requestID(r)})
		return
	}
	for rows.Next() {
		var item expectedItem
		if rows.Scan(&item.Kind, &item.ID, &item.Reference, &item.Amount, &item.Expected) == nil {
			item.Expected = item.Expected.UTC().Truncate(24 * time.Hour)
			if item.Expected.Before(today) {
				item.Overdue = true
				item.Expected = today // still expected; assume it lands now
			}
			expected = append(expected, item)
		}
	}
	_ = rows.Close()
	knownIn, knownOut := map[string]int64{}, map[string]int64{}
	var expectedIn, expectedOut int64
	for _, item := range expected {
		key := item.Expected.Format("2006-01-02")
		if item.Kind == "payout" {
			knownOut[key] += item.Amount
			expectedOut += item.Amount
		} else {
			knownIn[key] += item.Amount
			expectedIn += item.Amount
		}
	}
	projection := make([]map[string]any, 0, horizon)
	known, typical := float64(balance), float64(balance)
	var runway *int
	for i := 1; i <= horizon; i++ {
		d := today.AddDate(0, 0, i)
		key := d.Format("2006-01-02")
		if i == 1 {
			// Overdue items were moved to today; count them on the first day.
			key0 := today.Format("2006-01-02")
			known += float64(knownIn[key0] - knownOut[key0])
			typical -= float64(knownOut[key0])
		}
		known += float64(knownIn[key]-knownOut[key]) - avgOut
		typical += avgIn - avgOut - float64(knownOut[key])
		if runway == nil && known < 0 {
			n := i
			runway = &n
		}
		projection = append(projection, map[string]any{"date": key, "known": int64(math.Round(known)), "typical": int64(math.Round(typical))})
	}
	if len(expected) > 25 {
		expected = expected[:25]
	}
	note := "Based on the last " + strconv.Itoa(observed) + " days of ledger activity."
	if observed < 14 {
		note = "Only " + strconv.Itoa(observed) + " days of activity so far, so averages are rough."
	}
	writeJSON(w, 200, map[string]any{
		"currency": currency, "balance_minor": balance, "horizon_days": horizon,
		"average_daily_in": int64(math.Round(avgIn)), "average_daily_out": int64(math.Round(avgOut)),
		"expected_in": expectedIn, "expected_out": expectedOut,
		"runway_days": runway, "history": history, "projection": projection, "expected": expected,
		"balances": sortedCurrencies(balances), "note": note,
	})
}
