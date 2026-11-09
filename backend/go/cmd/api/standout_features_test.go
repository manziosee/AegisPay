package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestStripeExportKeepsChargesAndUsesNetPlusFee(t *testing.T) {
	csv := `id,Type,Source,Amount,Fee,Net,Currency,Created (UTC),Available On (UTC),Description
txn_1,charge,ch_1,100.00,3.20,96.80,usd,2026-10-03 09:15,2026-10-05 00:00,INV-1042
txn_2,payout,po_1,-500.00,0.00,-500.00,usd,2026-10-04 00:00,2026-10-04 00:00,STRIPE PAYOUT
txn_3,refund,re_1,-20.00,0.00,-20.00,usd,2026-10-04 10:00,2026-10-04 10:00,INV-1001 refund
`
	provider, lines, skipped, err := parseProviderCSV("auto", csv)
	if err != nil {
		t.Fatal(err)
	}
	if provider != "stripe" || len(lines) != 1 || skipped != 2 {
		t.Fatalf("got provider %q, %d lines, %d skipped", provider, len(lines), skipped)
	}
	l := lines[0]
	if l.Reference != "INV-1042" || l.Amount != 9680 || l.Fee != 320 || l.Currency != "USD" || !strings.HasPrefix(l.Date, "2026-10-03T09:15") {
		t.Fatalf("unexpected line %+v", l)
	}
}

func TestMpesaStatementFindsHeaderAndAccountReference(t *testing.T) {
	csv := `Customer Name:,Acme Traders
Statement Period:,01 Oct 2026 - 31 Oct 2026

Receipt No.,Completion Time,Details,Transaction Status,Paid In,Withdrawn,Balance,A/C No.
SJK1A2B3C4,2026-10-03 14:30:22,Pay Bill from 254700000000 - JANE,Completed,"1,500.00",,"10,000.00",INV-2001
SJK1A2B3C5,2026-10-03 14:31:00,Pay Bill Charge,Completed,,-15.00,"9,985.00",
SJK1A2B3C6,03-10-2026 15:00:00,Pay Bill from 254711111111 - Acc. INV-2002,Completed,250.00,,"10,235.00",
SJK1A2B3C7,2026-10-03 16:00:00,Business Payment to 254722222222,Completed,,"-2,000.00","8,235.00",
SJK1A2B3C8,2026-10-03 17:00:00,Pay Bill from 254733333333,Failed,900.00,,,INV-2003
`
	provider, lines, skipped, err := parseProviderCSV("mpesa", csv)
	if err != nil {
		t.Fatal(err)
	}
	if provider != "mpesa" || len(lines) != 2 || skipped != 3 {
		t.Fatalf("got provider %q, %d lines, %d skipped: %+v", provider, len(lines), skipped, lines)
	}
	if lines[0].Reference != "INV-2001" || lines[0].Amount != 150000 || lines[0].Currency != "KES" {
		t.Fatalf("first line %+v", lines[0])
	}
	if lines[1].Reference != "INV-2002" || lines[1].Amount != 25000 || !strings.HasPrefix(lines[1].Date, "2026-10-03T15:00") {
		t.Fatalf("second line %+v", lines[1])
	}
}

func TestFlutterwaveExportUsesTxRefAndSettledAmount(t *testing.T) {
	csv := `Transaction Ref,Flutterwave Ref,Amount,App Fee,Amount Settled,Currency,Status,Date Created
INV-3001,FLW-MOCK-1,"10,000",140,9860,NGN,successful,2026-10-05 08:00:00
INV-3002,FLW-MOCK-2,5000,70,4930,NGN,failed,2026-10-05 09:00:00
`
	provider, lines, skipped, err := parseProviderCSV("", csv)
	if err != nil {
		t.Fatal(err)
	}
	if provider != "flutterwave" || len(lines) != 1 || skipped != 1 {
		t.Fatalf("got provider %q, %d lines, %d skipped", provider, len(lines), skipped)
	}
	if l := lines[0]; l.Reference != "INV-3001" || l.Amount != 986000 || l.Fee != 14000 || l.Currency != "NGN" {
		t.Fatalf("unexpected line %+v", l)
	}
}

func TestProviderMismatchAndUnknownFilesAreExplained(t *testing.T) {
	stripe := "id,Type,Amount,Fee,Net,Currency,Created (UTC),Description\ntxn_1,charge,1,0,1,usd,2026-10-01,X\n"
	if _, _, _, err := parseProviderCSV("mpesa", stripe); err == nil || !strings.Contains(err.Error(), "Stripe") {
		t.Fatalf("want a Stripe mismatch error, got %v", err)
	}
	if _, _, _, err := parseProviderCSV("auto", "reference,amount,currency\nA,1,USD\n"); err == nil {
		t.Fatal("a bank CSV must not be read as a provider export")
	}
}

func TestReferenceTokensSplitLettersFromDigits(t *testing.T) {
	got := strings.Join(referenceTokens("INV-2026/1042 J.Smith AB"), ",")
	if got != "inv,2026,1042,smith" {
		t.Fatalf("got %s", got)
	}
	if sharedToken("INV-1042", "PAYMENT 1042 JANE") != "1042" {
		t.Fatal("expected the number to be the shared token")
	}
}

func TestSuggestionPrefersReferenceOverlapAndRefusesTies(t *testing.T) {
	day := time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)
	candidates := []suggestionCandidate{
		{id: "col_a", reference: "INV-1042", currency: "USD", amount: 5000, created: day.AddDate(0, 0, -2)},
		{id: "col_b", reference: "INV-1043", currency: "USD", amount: 5000, created: day.AddDate(0, 0, -2)},
		{id: "col_c", reference: "INV-9999", currency: "EUR", amount: 5000, created: day},
	}
	line := statementLine{Reference: "TRANSFER 1042 J SMITH", Amount: 5000, Currency: "USD"}
	got, ok := suggestCollection(line, 5000, day, candidates, map[string]bool{})
	if !ok || got.collectionID != "col_a" {
		t.Fatalf("want col_a, got %+v %v", got, ok)
	}
	if !strings.Contains(got.reason, `"1042"`) || !strings.Contains(got.reason, "50.00 USD") {
		t.Fatalf("reason does not explain itself: %s", got.reason)
	}
	// Without a telling reference, two equal candidates are a tie: no guess.
	if _, ok = suggestCollection(statementLine{Reference: "BANK TRANSFER", Amount: 5000, Currency: "USD"}, 5000, day, candidates, map[string]bool{}); ok {
		t.Fatal("a tie must not produce a suggestion")
	}
	// A candidate already suggested for another line is not offered again.
	if _, ok = suggestCollection(line, 5000, day, candidates[:1], map[string]bool{"col_a": true}); ok {
		t.Fatal("a taken candidate must not be suggested")
	}
}

func TestOTSProofFileLayout(t *testing.T) {
	digest := bytes.Repeat([]byte{0xab}, 32)
	file := otsProofFile(digest, [][]byte{{0xf0, 0x01}, {0xf1, 0x02}})
	if !bytes.HasPrefix(file, otsHeaderMagic) {
		t.Fatal("missing OpenTimestamps header")
	}
	rest := file[len(otsHeaderMagic):]
	if rest[0] != 0x01 || rest[1] != otsOpSHA256 || !bytes.Equal(rest[2:34], digest) {
		t.Fatal("version, hash op or digest misplaced")
	}
	if !bytes.Equal(rest[34:], []byte{0xff, 0xf0, 0x01, 0xf1, 0x02}) {
		t.Fatalf("branches not merged with 0xff: %x", rest[34:])
	}
}

func TestAuditPackMonthDefaultsToPreviousMonth(t *testing.T) {
	now := time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC)
	start, end, err := parsePackMonth("", now)
	if err != nil || start.Format("2006-01") != "2025-12" || end.Format("2006-01") != "2026-01" {
		t.Fatalf("got %v %v %v", start, end, err)
	}
	if _, _, err = parsePackMonth("2026-02", now); err == nil {
		t.Fatal("a future month must be refused")
	}
	if _, _, err = parsePackMonth("Oct 2026", now); err == nil {
		t.Fatal("a malformed month must be refused")
	}
}

func TestRuleTemplatesAreValidInEveryCurrency(t *testing.T) {
	for _, currency := range []string{"USD", "RWF", "KES", "JPY", "BHD", "EUR"} {
		for _, tmpl := range riskRuleTemplates {
			for _, in := range templateInputs(tmpl, currency) {
				if err := in.validate(); err != nil {
					t.Fatalf("%s/%s %q: %v", tmpl.ID, currency, in.Name, err)
				}
				if in.MinAmountMinor != nil && (strings.Contains(in.Name, "USD") != (currency == "USD")) {
					t.Fatalf("%s rule name not in the workspace currency: %q", currency, in.Name)
				}
			}
		}
	}
}

func TestPickCurrencyUsesLargestBalance(t *testing.T) {
	if got := pickCurrency("", map[string]int64{"USD": 10, "KES": 900}, "EUR"); got != "KES" {
		t.Fatalf("got %s", got)
	}
	if got := pickCurrency("gbp", map[string]int64{"USD": 10}, "EUR"); got != "GBP" {
		t.Fatalf("got %s", got)
	}
	if got := pickCurrency("", map[string]int64{}, "EUR"); got != "EUR" {
		t.Fatalf("got %s", got)
	}
}
