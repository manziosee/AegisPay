package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

var errSampleNotAllowed = errors.New("sample data can only be added once, to a practice workspace")

// countryCurrency picks a sample currency from the workspace's country.
var countryCurrency = map[string]string{
	"RW": "RWF", "KE": "KES", "UG": "UGX", "TZ": "TZS", "NG": "NGN", "GH": "GHS", "ZA": "ZAR", "SN": "XOF", "CI": "XOF", "CM": "XAF",
	"IN": "INR", "JP": "JPY", "GB": "GBP", "CA": "CAD", "AU": "AUD", "DE": "EUR", "FR": "EUR", "NL": "EUR", "ES": "EUR", "IT": "EUR", "BE": "EUR", "IE": "EUR",
}

// currencyScale makes sample amounts look sensible in each currency, roughly
// relative to the US dollar. It is only used for sample data.
var currencyScale = map[string]int64{"RWF": 1400, "KES": 130, "UGX": 3700, "TZS": 2600, "NGN": 1500, "GHS": 12, "ZAR": 18, "XOF": 600, "XAF": 600, "INR": 85, "JPY": 150}

func sampleAmount(major int64, currency string) int64 {
	scale := currencyScale[currency]
	if scale == 0 {
		scale = 1
	}
	amount := major * scale
	for i := 0; i < currencyMinorDigits(currency); i++ {
		amount *= 10
	}
	return amount
}

// seedSampleData fills a practice workspace with a month of realistic,
// clearly labelled activity: every reference starts with SAMPLE-.
func seedSampleData(ctx context.Context, db *sql.DB, org, userID string) (map[string]any, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var environment, country string
	var loaded sql.NullTime
	if err = tx.QueryRowContext(ctx, `SELECT environment,country_code,sample_data_loaded_at FROM organizations WHERE id=$1 FOR UPDATE`, org).Scan(&environment, &country, &loaded); err != nil {
		return nil, err
	}
	if environment != "sandbox" || loaded.Valid {
		return nil, errSampleNotAllowed
	}
	currency := countryCurrency[strings.ToUpper(strings.TrimSpace(country))]
	if currency == "" {
		currency = "USD"
	}
	now := time.Now().UTC()
	ago := func(days int) time.Time { return now.AddDate(0, 0, -days) }
	amount := func(major int64) int64 { return sampleAmount(major, currency) }
	do := func(query string, args ...any) {
		if err == nil {
			_, err = tx.ExecContext(ctx, query, args...)
		}
	}
	var clearing string
	if clearing, err = statementAccount(ctx, tx, org, currency, "sandbox_clearing", "acc_sandbox_"); err != nil {
		return nil, err
	}
	operating, reserve := "acc_"+newID(), "acc_"+newID()
	do(`INSERT INTO accounts(id,organization_id,currency,account_type,created_at) VALUES($1,$2,$3,'wallet',$4),($5,$2,$3,'wallet',$4)`, operating, org, currency, ago(32), reserve)

	customers := []struct{ id, name, email, phone string }{
		{"cus_" + newID(), "Northwind Trading (sample)", "accounts@northwind.example.com", "+1 555 0100"},
		{"cus_" + newID(), "Blue Lake Coffee Co-op (sample)", "finance@bluelake.example.com", "+1 555 0101"},
		{"cus_" + newID(), "Riverside Clinic (sample)", "billing@riverside.example.com", "+1 555 0102"},
		{"cus_" + newID(), "Sunrise School (sample)", "bursar@sunrise.example.com", "+1 555 0103"},
	}
	for i, c := range customers {
		do(`INSERT INTO customers(id,organization_id,name,email,phone,created_at) VALUES($1,$2,$3,$4,$5,$6)`, c.id, org, c.name, c.email, c.phone, ago(31-i))
	}

	post := func(referenceType, referenceID string, debit, credit string, minor int64, at time.Time) {
		entry := "jrn_" + newID()
		do(`INSERT INTO journal_entries(id,organization_id,reference_type,reference_id,currency,amount_minor,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, entry, org, referenceType, referenceID, currency, minor, at)
		do(`INSERT INTO journal_lines(journal_entry_id,organization_id,account_id,side,amount_minor,currency,created_at) VALUES($1,$2,$3,'debit',$5,$6,$7),($1,$2,$4,'credit',$5,$6,$7)`, entry, org, debit, credit, minor, currency, at)
	}
	collections := []struct {
		reference, description string
		customer               int
		major                  int64
		status                 string
		days                   int
	}{
		{"SAMPLE-INV-1001", "Invoice 1001, October supply", 0, 12400, "succeeded", 26},
		{"SAMPLE-INV-1002", "Invoice 1002, coffee export deposit", 1, 8600, "succeeded", 21},
		{"SAMPLE-INV-1003", "Invoice 1003, equipment service", 2, 3200, "succeeded", 16},
		{"SAMPLE-INV-1004", "Invoice 1004, term fees", 3, 5400, "succeeded", 9},
		{"SAMPLE-INV-1005", "Invoice 1005, November supply", 0, 9800, "pending", 3},
		{"SAMPLE-INV-1006", "Invoice 1006, cancelled order", 1, 1500, "cancelled", 12},
	}
	ids := map[string]string{}
	for _, c := range collections {
		id := "col_" + newID()
		ids[c.reference] = id
		var credited any
		if c.status == "succeeded" {
			credited = operating
		}
		do(`INSERT INTO collections(id,organization_id,customer_id,amount_minor,currency,status,description,reference,created_at,credited_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, org, customers[c.customer].id, amount(c.major), currency, c.status, c.description, c.reference, ago(c.days), credited)
		if c.status == "succeeded" {
			post("collection", id, clearing, operating, amount(c.major), ago(c.days))
		}
	}
	refund := "ref_" + newID()
	do(`INSERT INTO refunds(id,organization_id,collection_id,amount_minor,currency,reference,created_by,created_at) VALUES($1,$2,$3,$4,$5,'SAMPLE-RFD-2001',$6,$7)`, refund, org, ids["SAMPLE-INV-1003"], amount(400), currency, nullable(userID), ago(14))
	post("refund", refund, operating, clearing, amount(400), ago(14))

	done := "trf_" + newID()
	do(`INSERT INTO transfers(id,organization_id,source_account_id,destination_account_id,amount_minor,currency,status,reference,created_at) VALUES($1,$2,$3,$4,$5,$6,'completed','SAMPLE-TRF-3001',$7)`, done, org, operating, reserve, amount(2500), currency, ago(11))
	post("transfer", done, operating, reserve, amount(2500), ago(11))
	// No creator, so the workspace owner can try approving it.
	do(`INSERT INTO transfers(id,organization_id,source_account_id,destination_account_id,amount_minor,currency,status,reference,created_at) VALUES($1,$2,$3,$4,$5,$6,'pending_approval','SAMPLE-TRF-3002',$7)`, "trf_"+newID(), org, operating, reserve, amount(7500), currency, ago(1))

	do(`INSERT INTO transaction_policies(organization_id,currency,approval_threshold_minor,required_approvals,updated_by) VALUES($1,$2,$3,1,$4) ON CONFLICT(organization_id,currency) DO NOTHING`, org, currency, amount(5000), nullable(userID))
	do(`INSERT INTO risk_rules(id,organization_id,name,priority,applies_to,currency,min_amount_minor,action,created_by) VALUES($1,$2,'Sample: review large payouts',50,ARRAY['payout','transfer'],$3,$4,'review',$5)`, "rsk_"+newID(), org, currency, amount(20000), nullable(userID))
	do(`INSERT INTO risk_rules(id,organization_id,name,priority,applies_to,velocity_count,velocity_window_minutes,action,created_by) VALUES($1,$2,'Sample: many collections from one customer in an hour',60,ARRAY['collection'],5,60,'review',$3)`, "rsk_"+newID(), org, nullable(userID))

	do(`INSERT INTO bank_payment_requests(id,organization_id,amount_minor,currency,reference,description,due_date,status,created_by,created_at) VALUES($1,$2,$3,$4,'SAMPLE-AR-4001','Consulting retainer, November',$5,'open',$6,$7)`, "req_"+newID(), org, amount(4200), currency, now.AddDate(0, 0, 10), nullable(userID), ago(2))
	do(`INSERT INTO bank_payment_requests(id,organization_id,amount_minor,currency,reference,description,due_date,status,created_by,created_at) VALUES($1,$2,$3,$4,'SAMPLE-AR-4002','Workshop fees, overdue',$5,'open',$6,$7)`, "req_"+newID(), org, amount(1800), currency, now.AddDate(0, 0, -4), nullable(userID), ago(20))

	payouts := []struct {
		beneficiary, reference, description string
		major                               int64
		status                              string
		days                                int
	}{
		{"Harbor Packaging Ltd (sample)", "SAMPLE-AP-5001", "Packaging invoice 88", 2100, "prepared", 2},
		{"Atlas Freight (sample)", "SAMPLE-AP-5002", "Freight, October shipment", 6800, "pending_approval", 1},
		{"Office Rent (sample)", "SAMPLE-AP-5003", "Office rent, November", 1900, "submitted_to_bank", 5},
	}
	for _, p := range payouts {
		do(`INSERT INTO bank_payout_instructions(id,organization_id,beneficiary_name,amount_minor,currency,reference,description,status,required_approvals,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9)`, "pay_"+newID(), org, p.beneficiary, amount(p.major), currency, p.reference, p.description, p.status, ago(p.days))
	}

	imported := "imp_" + newID()
	do(`INSERT INTO reconciliation_imports(id,organization_id,status,source_name,line_count,created_at) VALUES($1,$2,'needs_review','sample-bank-statement.csv',4,$3)`, imported, org, ago(7))
	fee := amount(3)
	line := func(reference string, net, providerFee int64, status string, collection any, reason string, days int) {
		do(`INSERT INTO reconciliation_lines(import_id,organization_id,external_reference,amount_minor,provider_fee_minor,currency,transaction_date,match_status,matched_collection_id,suggestion_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, imported, org, reference, net, providerFee, currency, ago(days), status, collection, reason)
	}
	line("SAMPLE-INV-1001", amount(12400)-fee, fee, "matched", ids["SAMPLE-INV-1001"], "", 25)
	line("SAMPLE-INV-1002", amount(8600)-fee, fee, "matched", ids["SAMPLE-INV-1002"], "", 20)
	line("SAMPLE-INV-1004", amount(5000), 0, "exception", ids["SAMPLE-INV-1004"], "Reference matches a succeeded collection, but amount or currency differs", 8)
	line("SAMPLE-UNKNOWN-77", amount(640), 0, "unmatched", nil, "No collection, payment request, or payout instruction has this reference", 8)

	assessment := "ras_" + newID()
	do(`INSERT INTO risk_assessments(id,organization_id,transaction_reference,risk_score,risk_level,decision,model_version,subject_type,matched_rules,created_at) VALUES($1,$2,'SAMPLE-TRF-3002',60,'medium','review','rules-v1','manual',$3::jsonb,$4)`, assessment, org, `[{"id":"sample","name":"Sample: review large payouts","action":"review","reason":"amount above your review threshold"}]`, ago(1))
	do(`INSERT INTO fraud_cases(id,organization_id,assessment_id,priority,created_at) VALUES($1,$2,$3,'medium',$4)`, "case_"+newID(), org, assessment, ago(1))

	do(`INSERT INTO audit_logs(id,organization_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'sample_data.loaded','organization',$2,jsonb_build_object('currency',$4::text))`, "aud_"+newID(), org, nullable(userID), currency)
	do(`UPDATE organizations SET sample_data_loaded_at=now() WHERE id=$1`, org)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{"status": "loaded", "currency": currency, "customers": len(customers), "collections": len(collections), "payouts": len(payouts)}, nil
}

// onboarding reports first-run progress and loads sample data on request.
func (a *App) onboarding(w http.ResponseWriter, r *http.Request, parts []string) {
	org := currentOrgID(r, a.orgID)
	p := principalFrom(r)
	switch {
	case len(parts) == 2 && parts[1] == "status" && r.Method == http.MethodGet:
		var environment string
		var sampleLoaded, verified, hasStatement, hasCollection, hasTeammate, hasChat bool
		err := a.db.QueryRowContext(r.Context(), `SELECT o.environment,o.sample_data_loaded_at IS NOT NULL,
			COALESCE((SELECT u.email_verified_at IS NOT NULL FROM users u WHERE u.id=$2),false),
			EXISTS(SELECT 1 FROM reconciliation_imports i WHERE i.organization_id=o.id AND i.source_name<>'sample-bank-statement.csv'),
			EXISTS(SELECT 1 FROM collections c WHERE c.organization_id=o.id AND c.reference NOT LIKE 'SAMPLE-%'),
			EXISTS(SELECT 1 FROM organization_invitations i WHERE i.organization_id=o.id) OR (SELECT count(*) FROM memberships m WHERE m.organization_id=o.id)>1,
			EXISTS(SELECT 1 FROM notification_channels n WHERE n.organization_id=o.id)
			FROM organizations o WHERE o.id=$1`, org, p.userID).Scan(&environment, &sampleLoaded, &verified, &hasStatement, &hasCollection, &hasTeammate, &hasChat)
		if err != nil {
			writeJSON(w, 500, problem{Error: "onboarding status unavailable", RequestID: requestID(r)})
			return
		}
		writeJSON(w, 200, map[string]any{"environment": environment, "sample_data_loaded": sampleLoaded, "email_verified": verified, "imported_statement": hasStatement, "created_collection": hasCollection, "invited_teammate": hasTeammate, "connected_chat": hasChat})
	case len(parts) == 2 && parts[1] == "sample-data" && r.Method == http.MethodPost:
		if !isWorkspaceAdmin(p) {
			writeJSON(w, 403, problem{Error: "only an owner or admin can add sample data", RequestID: requestID(r)})
			return
		}
		result, err := seedSampleData(r.Context(), a.db, org, p.userID)
		if errors.Is(err, errSampleNotAllowed) {
			writeJSON(w, 409, problem{Error: err.Error(), RequestID: requestID(r)})
			return
		}
		if err != nil {
			slog.Error("sample data", "error", err)
			writeJSON(w, 500, problem{Error: "sample data could not be added", RequestID: requestID(r)})
			return
		}
		writeJSON(w, 201, result)
	default:
		notFound(w, r)
	}
}

// runSeedCommand is an operator command: aegispay-api seed-sample-data EMAIL...
// It adds sample data to each user's oldest practice workspace they own.
func runSeedCommand(ctx context.Context, db *sql.DB, emails []string) {
	for _, address := range emails {
		address = strings.ToLower(strings.TrimSpace(address))
		var userID, org, name string
		err := db.QueryRowContext(ctx, `SELECT u.id,o.id,o.name FROM users u JOIN memberships m ON m.user_id=u.id AND m.status='active' AND m.role='owner'
			JOIN organizations o ON o.id=m.organization_id AND o.environment='sandbox' AND o.status='active' AND o.sample_data_loaded_at IS NULL
			WHERE u.email=$1 ORDER BY m.joined_at LIMIT 1`, address).Scan(&userID, &org, &name)
		if err == sql.ErrNoRows {
			fmt.Printf("%s: skipped (no such user, or no practice workspace without sample data)\n", address)
			continue
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", address, err)
			continue
		}
		result, err := seedSampleData(ctx, db, org, userID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", address, err)
			continue
		}
		fmt.Printf("%s: sample data added to %q in %v\n", address, name, result["currency"])
	}
}

