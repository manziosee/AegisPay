package main

import (
	"encoding/csv"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Payment-provider exports, reconciled next to bank statements so a business
// sees Stripe, M-Pesa, Flutterwave and its bank in one place. Each parser
// reads the CSV the provider's dashboard exports, keeps completed incoming
// payments, and returns them as statement lines (net amount plus fee). Rows
// that are not customer payments (payouts to the bank, charges, failed
// attempts) are counted as skipped rather than imported.

// importMeta describes where statement lines came from.
type importMeta struct {
	provider string
	skipped  int
}

var providerNames = map[string]string{"stripe": "Stripe", "mpesa": "M-Pesa", "flutterwave": "Flutterwave"}

func (a *App) importProviderStatement(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Provider string `json:"provider"`
		Source   string `json:"source_name"`
		CSV      string `json:"csv"`
	}
	if decodeWithLimit(r, &in, reconciliationBodyLimit) != nil || strings.TrimSpace(in.CSV) == "" || len(in.CSV) > 2<<20 {
		bad(w, r, "a provider CSV export up to 2 MiB is required")
		return
	}
	provider, lines, skipped, err := parseProviderCSV(strings.ToLower(strings.TrimSpace(in.Provider)), in.CSV)
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	if len(lines) == 0 {
		bad(w, r, "no completed incoming payments were found in this "+providerNames[provider]+" export")
		return
	}
	if len(lines) > maxStatementLines {
		bad(w, r, "an export may contain at most 10000 payments")
		return
	}
	if strings.TrimSpace(in.Source) == "" {
		in.Source = provider + "-export.csv"
	}
	a.importStatementLinesFrom(w, r, currentOrgID(r, a.orgID), in.Source, lines, importMeta{provider: provider, skipped: skipped})
}

// normalizeHeader turns "Created (UTC)" into "createdutc".
func normalizeHeader(value string) string {
	value = strings.ToLower(strings.TrimPrefix(value, "\ufeff"))
	var b strings.Builder
	for _, c := range value {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			b.WriteRune(c)
		}
	}
	return b.String()
}

type headerIndex map[string]int

// pick returns the value of the first listed column present in the row.
func (h headerIndex) pick(record []string, names ...string) string {
	for _, name := range names {
		if i, ok := h[name]; ok && i < len(record) {
			if v := strings.TrimSpace(record[i]); v != "" {
				return v
			}
		}
	}
	return ""
}

func (h headerIndex) has(names ...string) bool {
	for _, name := range names {
		if _, ok := h[name]; ok {
			return true
		}
	}
	return false
}

// containing returns the first column whose name contains fragment.
func (h headerIndex) containing(record []string, fragment string) string {
	for name, i := range h {
		if strings.Contains(name, fragment) && i < len(record) {
			if v := strings.TrimSpace(record[i]); v != "" {
				return v
			}
		}
	}
	return ""
}

func detectProvider(h headerIndex) string {
	switch {
	case h.has("receiptno", "receiptnumber") && h.has("paidin", "withdrawn", "completiontime"):
		return "mpesa"
	case h.has("txref", "transactionref", "transactionreference", "flwref", "flutterwavereference", "flutterwaveref", "appfee", "amountsettled"):
		return "flutterwave"
	case h.has("balancetransactionid") || (h.has("net") && h.has("fee") && h.has("createdutc", "created")):
		return "stripe"
	}
	return ""
}

func parseProviderCSV(provider, content string) (string, []statementLine, int, error) {
	reader := csv.NewReader(strings.NewReader(content))
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	reader.TrimLeadingSpace = true
	// M-Pesa statements start with a few lines about the account before the
	// table, so look for the header row in the first rows.
	var header headerIndex
	detected := ""
	for i := 0; i < 40; i++ {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", nil, 0, errors.New("the CSV could not be read; export it again from the provider dashboard")
		}
		candidate := headerIndex{}
		for j, value := range record {
			if name := normalizeHeader(value); name != "" {
				if _, seen := candidate[name]; !seen {
					candidate[name] = j
				}
			}
		}
		if found := detectProvider(candidate); found != "" {
			header, detected = candidate, found
			break
		}
	}
	if header == nil {
		return "", nil, 0, errors.New("this does not look like a Stripe, M-Pesa or Flutterwave export; for bank CSV files use the bank statement import")
	}
	if provider == "" || provider == "auto" {
		provider = detected
	} else if _, ok := providerNames[provider]; !ok {
		return "", nil, 0, errors.New("provider must be stripe, mpesa, flutterwave or auto")
	} else if provider != detected {
		return "", nil, 0, errors.New("this file looks like a " + providerNames[detected] + " export, not " + providerNames[provider])
	}
	var lines []statementLine
	skipped := 0
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", nil, 0, errors.New("the CSV has a malformed row; export it again from the provider dashboard")
		}
		if len(record) == 0 || (len(record) == 1 && strings.TrimSpace(record[0]) == "") {
			continue
		}
		var line statementLine
		var ok bool
		var rowErr error
		switch provider {
		case "stripe":
			line, ok, rowErr = stripeRow(header, record)
		case "mpesa":
			line, ok, rowErr = mpesaRow(header, record)
		case "flutterwave":
			line, ok, rowErr = flutterwaveRow(header, record)
		}
		if rowErr != nil {
			return "", nil, 0, rowErr
		}
		if !ok {
			skipped++
			continue
		}
		lines = append(lines, line)
	}
	return provider, lines, skipped, nil
}

// providerAmount parses "1,200.50", "-35.00" or "(35.00)" in major units and
// returns the absolute value in minor units.
func providerAmount(value, currency string) (int64, error) {
	value = strings.TrimSpace(value)
	value = strings.Trim(value, "()")
	value = strings.TrimPrefix(value, "-")
	value = strings.TrimPrefix(value, "+")
	value = strings.NewReplacer(",", "", " ", "", "\u00a0", "").Replace(value)
	if i := strings.IndexFunc(value, func(c rune) bool { return (c >= '0' && c <= '9') || c == '.' }); i > 0 {
		value = value[i:] // a leading currency symbol or code
	}
	if value == "" {
		return 0, nil
	}
	return parseStatementAmount("", value, currency, false)
}

var providerDateLayouts = []string{
	time.RFC3339, "2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02T15:04:05", "2006-01-02",
	"02-01-2006 15:04:05", "02/01/2006 15:04:05", "02-01-2006", "02/01/2006",
	"Jan 2, 2006, 3:04 PM", "Jan 2, 2006 3:04 PM", "2 Jan 2006 15:04", "02 Jan 2006",
}

func providerDate(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	for _, layout := range providerDateLayouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC().Format(time.RFC3339), nil
		}
	}
	return "", errors.New("the date " + value + " is in a format AegisPay does not read; use YYYY-MM-DD HH:MM:SS")
}

func rowError(provider string, err error) error {
	return errors.New(providerNames[provider] + " export: " + err.Error())
}

// stripeRow reads Stripe's balance history and itemized balance change
// exports. A column whose name contains "reference" (for example payment
// metadata) is preferred, then the description, then the source id.
func stripeRow(h headerIndex, record []string) (statementLine, bool, error) {
	kind := strings.ToLower(h.pick(record, "reportingcategory", "type"))
	if kind != "" && kind != "charge" && kind != "payment" {
		return statementLine{}, false, nil
	}
	if status := strings.ToLower(h.pick(record, "status")); status != "" && status != "available" && status != "pending" && status != "succeeded" && status != "paid" {
		return statementLine{}, false, nil
	}
	currency := strings.ToUpper(h.pick(record, "currency"))
	if len(currency) != 3 {
		return statementLine{}, false, rowError("stripe", errors.New("every row needs a three-letter currency"))
	}
	netRaw := h.pick(record, "net")
	if strings.HasPrefix(strings.TrimSpace(netRaw), "-") {
		return statementLine{}, false, nil
	}
	net, err := providerAmount(netRaw, currency)
	if err != nil {
		return statementLine{}, false, rowError("stripe", errors.New("an amount could not be read"))
	}
	fee, err := providerAmount(h.pick(record, "fee"), currency)
	if err != nil {
		return statementLine{}, false, rowError("stripe", errors.New("a fee could not be read"))
	}
	if net <= 0 {
		return statementLine{}, false, nil
	}
	ref := firstNonEmpty(h.containing(record, "reference"), h.pick(record, "description"), h.pick(record, "sourceid", "source", "id", "balancetransactionid"))
	if ref == "" {
		return statementLine{}, false, nil
	}
	date, err := providerDate(h.pick(record, "createdutc", "created", "availableonutc"))
	if err != nil {
		return statementLine{}, false, rowError("stripe", err)
	}
	return statementLine{Reference: truncateReference(ref), Amount: net, Fee: fee, Currency: currency, Date: date}, true, nil
}

var mpesaAccountInDetails = regexp.MustCompile(`(?i)\bacc(?:ount)?\.?\s*(?:no\.?)?\s*[:#-]?\s*([A-Za-z0-9-]{2,40})`)

// mpesaRow reads a Safaricom M-PESA business statement. The paybill account
// number the customer typed is the reference; it is also found inside the
// details text ("Pay Bill from ... Acc. INV-1042").
func mpesaRow(h headerIndex, record []string) (statementLine, bool, error) {
	if status := strings.ToLower(h.pick(record, "transactionstatus", "status")); status != "" && status != "completed" && status != "success" && status != "successful" {
		return statementLine{}, false, nil
	}
	details := h.pick(record, "details", "description")
	reason := strings.ToLower(h.pick(record, "reasontype", "transactiontype") + " " + details)
	if strings.Contains(reason, "charge") || strings.Contains(reason, "fee") {
		return statementLine{}, false, nil
	}
	currency := strings.ToUpper(firstNonEmpty(h.pick(record, "currency"), "KES"))
	paidIn := h.pick(record, "paidin")
	if paidIn == "" || strings.Trim(paidIn, "0.,- ") == "" {
		// Money sent out (withdrawn) is not a customer payment.
		return statementLine{}, false, nil
	}
	amount, err := providerAmount(paidIn, currency)
	if err != nil {
		return statementLine{}, false, rowError("mpesa", errors.New("a Paid In amount could not be read"))
	}
	if amount <= 0 {
		return statementLine{}, false, nil
	}
	ref := h.pick(record, "acno", "accountno", "accountnumber", "billrefnumber", "accountreference")
	if ref == "" {
		if m := mpesaAccountInDetails.FindStringSubmatch(details); m != nil {
			ref = m[1]
		}
	}
	ref = firstNonEmpty(ref, h.pick(record, "receiptno", "receiptnumber"))
	if ref == "" {
		return statementLine{}, false, nil
	}
	date, err := providerDate(h.pick(record, "completiontime", "initiationtime", "date"))
	if err != nil {
		return statementLine{}, false, rowError("mpesa", err)
	}
	return statementLine{Reference: truncateReference(ref), Amount: amount, Currency: currency, Date: date}, true, nil
}

// flutterwaveRow reads a Flutterwave transactions export. tx_ref is the
// reference the business set when it asked for the payment.
func flutterwaveRow(h headerIndex, record []string) (statementLine, bool, error) {
	if status := strings.ToLower(h.pick(record, "status", "transactionstatus")); status != "" && status != "successful" && status != "success" && status != "completed" {
		return statementLine{}, false, nil
	}
	currency := strings.ToUpper(h.pick(record, "currency", "chargedcurrency"))
	if len(currency) != 3 {
		return statementLine{}, false, rowError("flutterwave", errors.New("every row needs a three-letter currency"))
	}
	gross, err := providerAmount(h.pick(record, "amount", "chargedamount", "amountcharged"), currency)
	if err != nil {
		return statementLine{}, false, rowError("flutterwave", errors.New("an amount could not be read"))
	}
	fee, err := providerAmount(h.pick(record, "appfee", "fee", "fees", "transactionfee"), currency)
	if err != nil {
		return statementLine{}, false, rowError("flutterwave", errors.New("a fee could not be read"))
	}
	net := gross - fee
	if settled := h.pick(record, "amountsettled", "settlementamount", "settledamount"); settled != "" {
		if net, err = providerAmount(settled, currency); err != nil {
			return statementLine{}, false, rowError("flutterwave", errors.New("a settled amount could not be read"))
		}
		if gross > net {
			fee = gross - net
		}
	}
	if net <= 0 {
		return statementLine{}, false, nil
	}
	ref := h.pick(record, "txref", "transactionref", "transactionreference", "reference", "merchantreference", "flwref", "flutterwavereference", "flutterwaveref")
	if ref == "" {
		return statementLine{}, false, nil
	}
	date, err := providerDate(h.pick(record, "createdat", "datecreated", "date", "transactiondate"))
	if err != nil {
		return statementLine{}, false, rowError("flutterwave", err)
	}
	return statementLine{Reference: truncateReference(ref), Amount: net, Fee: fee, Currency: currency, Date: date}, true, nil
}
