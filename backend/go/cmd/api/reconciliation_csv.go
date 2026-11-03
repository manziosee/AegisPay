package main

import (
	"encoding/csv"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (a *App) importStatementCSV(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Source string `json:"source_name"`
		CSV    string `json:"csv"`
	}
	if decodeWithLimit(r, &in, reconciliationBodyLimit) != nil || strings.TrimSpace(in.CSV) == "" || len(in.CSV) > 1<<20 {
		bad(w, r, "a CSV statement up to 1 MiB is required")
		return
	}
	reader := csv.NewReader(strings.NewReader(in.CSV))
	reader.FieldsPerRecord = -1
	reader.TrimLeadingSpace = true
	header, err := reader.Read()
	if err != nil {
		bad(w, r, "CSV header could not be read")
		return
	}
	columns := make(map[string]int, len(header))
	for i, value := range header {
		name := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(value, "\ufeff")))
		switch name {
		case "reference", "external_reference", "bank_reference":
			columns["reference"] = i
		case "amount", "amount_minor":
			columns[name] = i
		case "provider_fee", "provider_fee_minor":
			columns[name] = i
		case "currency":
			columns["currency"] = i
		case "date", "transaction_date", "booking_date":
			columns["date"] = i
		}
	}
	if _, ok := columns["reference"]; !ok {
		bad(w, r, "CSV needs a reference or external_reference column")
		return
	}
	if _, ok := columns["currency"]; !ok {
		bad(w, r, "CSV needs a currency column")
		return
	}
	_, hasAmount := columns["amount"]
	_, hasMinorAmount := columns["amount_minor"]
	if !hasAmount && !hasMinorAmount {
		bad(w, r, "CSV needs an amount or amount_minor column")
		return
	}
	lines := make([]statementLine, 0)
	for {
		record, readErr := reader.Read()
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			bad(w, r, "CSV contains malformed quoting or rows")
			return
		}
		if len(record) == 1 && strings.TrimSpace(record[0]) == "" {
			continue
		}
		if len(lines) >= maxStatementLines {
			bad(w, r, "CSV may contain at most 10000 statement lines")
			return
		}
		value := func(key string) string {
			index, ok := columns[key]
			if !ok || index >= len(record) {
				return ""
			}
			return strings.TrimSpace(record[index])
		}
		currency := strings.ToUpper(value("currency"))
		if len(currency) != 3 {
			bad(w, r, "each CSV row needs a three-letter currency")
			return
		}
		amount, amountErr := parseStatementAmount(value("amount_minor"), value("amount"), currency, hasMinorAmount)
		if amountErr != nil || amount <= 0 {
			bad(w, r, "each CSV row needs a positive amount; use amount_minor for amounts already in minor units")
			return
		}
		fee := int64(0)
		if feeValue := value("provider_fee_minor"); feeValue != "" {
			fee, amountErr = parseStatementAmount(feeValue, "", currency, true)
		} else if feeValue := value("provider_fee"); feeValue != "" {
			fee, amountErr = parseStatementAmount("", feeValue, currency, false)
		}
		if amountErr != nil || fee < 0 {
			bad(w, r, "provider_fee must be a non-negative amount")
			return
		}
		ref := value("reference")
		if ref == "" {
			bad(w, r, "each CSV row needs a reference")
			return
		}
		date := ""
		if raw := value("date"); raw != "" {
			date, err = parseStatementDate(raw)
			if err != nil {
				bad(w, r, "dates must use RFC3339, YYYY-MM-DD, or YYYY-MM-DD HH:MM:SS")
				return
			}
		}
		lines = append(lines, statementLine{Reference: ref, Amount: amount, Fee: fee, Currency: currency, Date: date})
	}
	if len(lines) == 0 {
		bad(w, r, "CSV must contain at least one statement line")
		return
	}
	if strings.TrimSpace(in.Source) == "" {
		in.Source = "bank-statement.csv"
	}
	a.importStatementLines(w, r, currentOrgID(r, a.orgID), in.Source, lines)
}

func parseStatementAmount(minor, major, currency string, hasMinor bool) (int64, error) {
	if hasMinor && strings.TrimSpace(minor) != "" {
		value, err := strconv.ParseInt(strings.TrimSpace(minor), 10, 64)
		if err != nil {
			return 0, err
		}
		return value, nil
	}
	amount := strings.TrimSpace(major)
	if amount == "" {
		amount = strings.TrimSpace(minor)
	}
	value, ok := new(big.Rat).SetString(amount)
	if !ok {
		return 0, fmt.Errorf("invalid decimal amount")
	}
	digits := 2
	switch currency {
	case "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF":
		digits = 0
	case "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND":
		digits = 3
	}
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)
	value.Mul(value, new(big.Rat).SetInt(scale))
	if !value.IsInt() || !value.Num().IsInt64() {
		return 0, fmt.Errorf("amount has too many decimal places or is too large")
	}
	return value.Num().Int64(), nil
}

func parseStatementDate(value string) (string, error) {
	for _, layout := range []string{time.RFC3339, "2006-01-02", "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC().Format(time.RFC3339), nil
		}
	}
	return "", fmt.Errorf("invalid date")
}
