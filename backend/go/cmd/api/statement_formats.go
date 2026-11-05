package main

import (
	"bufio"
	"encoding/xml"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Bank statement formats used by banks worldwide. Each parser turns a
// statement into statement lines for importStatementLines; credits and debits
// are both kept as positive amounts because matching works on reference,
// amount and currency (collections and payment requests are credits, payouts
// are debits).

// importStatementFile accepts CAMT.053, MT940 or OFX content.
func (a *App) importStatementFile(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Source  string `json:"source_name"`
		Format  string `json:"format"`
		Content string `json:"content"`
	}
	if decodeWithLimit(r, &in, reconciliationBodyLimit) != nil || strings.TrimSpace(in.Content) == "" {
		bad(w, r, "a statement file (content) is required")
		return
	}
	format := strings.ToLower(strings.TrimSpace(in.Format))
	if format == "" || format == "auto" {
		format = detectStatementFormat(in.Content)
	}
	var lines []statementLine
	var err error
	switch format {
	case "camt053":
		lines, err = parseCAMT053(in.Content)
	case "mt940":
		lines, err = parseMT940(in.Content)
	case "ofx":
		lines, err = parseOFX(in.Content)
	default:
		bad(w, r, "format must be camt053, mt940 or ofx (or auto); use /v1/reconciliation/imports/csv for CSV files")
		return
	}
	if err != nil {
		bad(w, r, err.Error())
		return
	}
	if len(lines) == 0 {
		bad(w, r, "the statement contains no transactions")
		return
	}
	if len(lines) > maxStatementLines {
		bad(w, r, "a statement may contain at most 10000 transactions")
		return
	}
	if strings.TrimSpace(in.Source) == "" {
		in.Source = "bank-statement." + format
	}
	a.importStatementLines(w, r, currentOrgID(r, a.orgID), in.Source, lines)
}

func detectStatementFormat(content string) string {
	head := content
	if len(head) > 4096 {
		head = head[:4096]
	}
	switch {
	case strings.Contains(head, "BkToCstmrStmt") || strings.Contains(head, "camt.053"):
		return "camt053"
	case strings.Contains(head, "OFXHEADER") || strings.Contains(strings.ToUpper(head), "<OFX>"):
		return "ofx"
	case strings.Contains(head, ":20:") && (strings.Contains(content, ":61:") || strings.Contains(content, ":60F:")):
		return "mt940"
	}
	return ""
}

// --- CAMT.053 (ISO 20022 bank-to-customer statement) ----------------------

type camtAmount struct {
	Currency string `xml:"Ccy,attr"`
	Value    string `xml:",chardata"`
}

// camtStatus covers both forms: <Sts>BOOK</Sts> (older versions) and
// <Sts><Cd>BOOK</Cd></Sts> (newer versions).
type camtStatus struct {
	Text string `xml:",chardata"`
	Code string `xml:"Cd"`
}

type camtDate struct {
	Date     string `xml:"Dt"`
	DateTime string `xml:"DtTm"`
}

type camtEntry struct {
	Amount       camtAmount `xml:"Amt"`
	Indicator    string     `xml:"CdtDbtInd"`
	Status       camtStatus `xml:"Sts"`
	BookingDate  camtDate   `xml:"BookgDt"`
	ValueDate    camtDate   `xml:"ValDt"`
	EntryRef     string     `xml:"NtryRef"`
	ServicerRef  string     `xml:"AcctSvcrRef"`
	Unstructured []string   `xml:"NtryDtls>TxDtls>RmtInf>Ustrd"`
	Structured   []string   `xml:"NtryDtls>TxDtls>RmtInf>Strd>CdtrRefInf>Ref"`
	EndToEnd     []string   `xml:"NtryDtls>TxDtls>Refs>EndToEndId"`
	AddtlInfo    string     `xml:"AddtlNtryInf"`
}

type camtDocument struct {
	Statements []struct {
		Entries []camtEntry `xml:"Ntry"`
	} `xml:"BkToCstmrStmt>Stmt"`
}

func parseCAMT053(content string) ([]statementLine, error) {
	var doc camtDocument
	if err := xml.Unmarshal([]byte(content), &doc); err != nil {
		return nil, fmt.Errorf("the CAMT.053 file could not be read: %v", err)
	}
	var lines []statementLine
	for _, stmt := range doc.Statements {
		for i, entry := range stmt.Entries {
			status := strings.ToUpper(strings.TrimSpace(entry.Status.Text + entry.Status.Code))
			if status != "" && !strings.Contains(status, "BOOK") {
				continue // pending or informational entries are not settled
			}
			currency := strings.ToUpper(strings.TrimSpace(entry.Amount.Currency))
			amount, err := parseStatementAmount("", strings.TrimSpace(entry.Amount.Value), currency, false)
			if err != nil || amount <= 0 || len(currency) != 3 {
				return nil, fmt.Errorf("CAMT.053 entry %d has an invalid amount or currency", i+1)
			}
			reference := firstNonEmpty(entry.Structured...)
			if reference == "" {
				reference = firstNonEmpty(entry.Unstructured...)
			}
			if reference == "" {
				reference = firstNonEmpty(append(entry.EndToEnd, entry.EntryRef, entry.ServicerRef, entry.AddtlInfo)...)
			}
			if strings.EqualFold(reference, "NOTPROVIDED") {
				reference = firstNonEmpty(entry.EntryRef, entry.ServicerRef)
			}
			if reference == "" {
				return nil, fmt.Errorf("CAMT.053 entry %d has no reference", i+1)
			}
			date := firstNonEmpty(entry.BookingDate.Date, entry.BookingDate.DateTime, entry.ValueDate.Date, entry.ValueDate.DateTime)
			normalized, err := normalizeStatementDate(date)
			if err != nil {
				return nil, fmt.Errorf("CAMT.053 entry %d has an invalid booking date", i+1)
			}
			lines = append(lines, statementLine{Reference: truncateReference(reference), Amount: amount, Currency: currency, Date: normalized})
		}
	}
	return lines, nil
}

// --- MT940 (SWIFT customer statement) -------------------------------------

// :61:YYMMDD[MMDD]<D|C|RD|RC>[funds code]<amount>N<type><customer ref>[//<bank ref>]
var mt940Line = regexp.MustCompile(`^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+,\d*)([A-Z]\w{3})([^\n/]*)(?://(.*))?`)

func parseMT940(content string) ([]statementLine, error) {
	var lines []statementLine
	currency := ""
	var pending *statementLine
	bankRef := ""
	inInfo := false
	// Reference priority: the customer reference on :61:, then the payment
	// details in :86: (which carry the payer's reference), then the bank's
	// own reference.
	flush := func() {
		if pending != nil {
			if pending.Reference == "" {
				pending.Reference = bankRef
			}
			lines = append(lines, *pending)
			pending = nil
		}
	}
	scanner := bufio.NewScanner(strings.NewReader(strings.ReplaceAll(content, "\r\n", "\n")))
	scanner.Buffer(make([]byte, 1024*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, ":60F:"), strings.HasPrefix(line, ":60M:"):
			// :60F:C231101EUR1000,00  (mark, date, currency, amount)
			value := line[5:]
			if len(value) >= 10 {
				currency = strings.ToUpper(value[7:10])
			}
			inInfo = false
		case strings.HasPrefix(line, ":61:"):
			flush()
			inInfo = false
			m := mt940Line.FindStringSubmatch(line[4:])
			if m == nil {
				return nil, fmt.Errorf("MT940 transaction line could not be read: %q", truncateReference(line))
			}
			if currency == "" {
				return nil, errors.New("MT940 statement has no opening balance (:60F:) with a currency")
			}
			amount, err := parseStatementAmount("", strings.Replace(m[5], ",", ".", 1)+"0", currency, false)
			if err != nil {
				// Amounts like "1234," have no decimals; the appended 0 keeps them valid.
				return nil, fmt.Errorf("MT940 amount %q is invalid", m[5])
			}
			date, err := time.Parse("060102", m[1])
			if err != nil {
				return nil, fmt.Errorf("MT940 value date %q is invalid", m[1])
			}
			reference := strings.TrimSpace(m[7])
			if strings.EqualFold(reference, "NONREF") {
				reference = ""
			}
			bankRef = strings.TrimSpace(m[8])
			pending = &statementLine{Reference: reference, Amount: amount, Currency: currency, Date: date.UTC().Format(time.RFC3339)}
		case strings.HasPrefix(line, ":86:"):
			inInfo = true
			if pending != nil && pending.Reference == "" {
				pending.Reference = strings.TrimSpace(line[4:])
			}
		case strings.HasPrefix(line, ":62F:"), strings.HasPrefix(line, ":62M:"), strings.HasPrefix(line, "-"):
			inInfo = false
			flush()
		default:
			// Continuation of :86: information.
			if inInfo && pending != nil && pending.Reference == "" {
				pending.Reference = strings.TrimSpace(line)
			}
		}
	}
	flush()
	for i := range lines {
		if lines[i].Reference == "" {
			return nil, fmt.Errorf("MT940 transaction %d has no reference", i+1)
		}
		lines[i].Reference = truncateReference(lines[i].Reference)
	}
	return lines, scanner.Err()
}

// --- OFX / QFX (Open Financial Exchange, SGML v1 and XML v2) --------------

var ofxTag = regexp.MustCompile(`(?is)<([A-Z0-9.]+)>([^<\r\n]*)`)

func parseOFX(content string) ([]statementLine, error) {
	upper := strings.ToUpper(content)
	currency := ""
	if m := regexp.MustCompile(`(?i)<CURDEF>\s*([A-Z]{3})`).FindStringSubmatch(content); m != nil {
		currency = strings.ToUpper(m[1])
	}
	if currency == "" {
		return nil, errors.New("OFX statement has no currency (CURDEF)")
	}
	var lines []statementLine
	rest := content
	for {
		start := strings.Index(strings.ToUpper(rest), "<STMTTRN>")
		if start < 0 {
			break
		}
		rest = rest[start+len("<STMTTRN>"):]
		end := strings.Index(strings.ToUpper(rest), "</STMTTRN>")
		block := rest
		if end >= 0 {
			block = rest[:end]
			rest = rest[end+len("</STMTTRN>"):]
		} else if next := strings.Index(strings.ToUpper(rest), "<STMTTRN>"); next >= 0 {
			block = rest[:next]
			rest = rest[next:]
		} else {
			rest = ""
		}
		fields := map[string]string{}
		for _, m := range ofxTag.FindAllStringSubmatch(block, -1) {
			key := strings.ToUpper(m[1])
			if _, seen := fields[key]; !seen {
				fields[key] = strings.TrimSpace(m[2])
			}
		}
		raw := strings.TrimPrefix(strings.TrimPrefix(fields["TRNAMT"], "-"), "+")
		amount, err := parseStatementAmount("", strings.ReplaceAll(raw, ",", "."), currency, false)
		if err != nil || amount <= 0 {
			return nil, fmt.Errorf("OFX transaction %d has an invalid amount", len(lines)+1)
		}
		date, err := parseOFXDate(fields["DTPOSTED"])
		if err != nil {
			return nil, fmt.Errorf("OFX transaction %d has an invalid posting date", len(lines)+1)
		}
		reference := firstNonEmpty(fields["REFNUM"], fields["MEMO"], fields["NAME"], fields["CHECKNUM"], fields["FITID"])
		if reference == "" {
			return nil, fmt.Errorf("OFX transaction %d has no reference", len(lines)+1)
		}
		lineCurrency := currency
		if c := strings.ToUpper(fields["CURRENCY"]); len(c) == 3 {
			lineCurrency = c
		}
		lines = append(lines, statementLine{Reference: truncateReference(reference), Amount: amount, Currency: lineCurrency, Date: date})
	}
	if len(lines) == 0 && !strings.Contains(upper, "STMTTRN") {
		return nil, errors.New("the OFX file contains no transactions (STMTTRN)")
	}
	return lines, nil
}

// parseOFXDate reads YYYYMMDD[HHMMSS[.XXX]][[offset:TZ]].
func parseOFXDate(value string) (string, error) {
	value = strings.TrimSpace(value)
	offset := 0
	if i := strings.Index(value, "["); i >= 0 {
		zone := strings.TrimSuffix(value[i+1:], "]")
		value = value[:i]
		if j := strings.Index(zone, ":"); j >= 0 {
			zone = zone[:j]
		}
		var hours float64
		if _, err := fmt.Sscanf(zone, "%g", &hours); err == nil {
			offset = int(hours * 3600)
		}
	}
	if i := strings.Index(value, "."); i >= 0 {
		value = value[:i]
	}
	var layout string
	switch len(value) {
	case 8:
		layout = "20060102"
	case 12:
		layout = "200601021504"
	case 14:
		layout = "20060102150405"
	default:
		return "", errors.New("invalid OFX date")
	}
	t, err := time.ParseInLocation(layout, value, time.FixedZone("ofx", offset))
	if err != nil {
		return "", err
	}
	return t.UTC().Format(time.RFC3339), nil
}

func normalizeStatementDate(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("missing date")
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, value); err == nil {
			return t.UTC().Format(time.RFC3339), nil
		}
	}
	return "", errors.New("invalid date")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

// truncateReference keeps references within a reasonable length for storage
// and display.
func truncateReference(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if len(value) > 140 {
		return value[:140]
	}
	return value
}
