package main

import "testing"

func TestParseStatementAmount(t *testing.T) {
	tests := []struct {
		name     string
		raw      string
		currency string
		minor    bool
		want     int64
		wantErr  bool
	}{
		{name: "USD major units", raw: "1.23", currency: "USD", want: 123},
		{name: "RWF major units", raw: "1234", currency: "RWF", want: 1234},
		{name: "three decimal currency", raw: "1.234", currency: "KWD", want: 1234},
		{name: "minor units stay exact", raw: "101", currency: "USD", minor: true, want: 101},
		{name: "rejects fractional minor unit", raw: "1.5", currency: "USD", minor: true, wantErr: true},
		{name: "rejects excessive decimal places", raw: "1.234", currency: "USD", wantErr: true},
		{name: "rejects overflow", raw: "9223372036854775808", currency: "USD", minor: true, wantErr: true},
		{name: "rejects invalid amount", raw: "not-money", currency: "USD", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseStatementAmount(tt.raw, "", tt.currency, tt.minor)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parseStatementAmount() error = %v, wantErr %v", err, tt.wantErr)
			}
			if err == nil && got != tt.want {
				t.Fatalf("parseStatementAmount() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestParseStatementDate(t *testing.T) {
	tests := []struct {
		input string
		want  string
		ok    bool
	}{
		{input: "2026-03-19", want: "2026-03-19T00:00:00Z", ok: true},
		{input: "2026-03-19T10:15:00+02:00", want: "2026-03-19T08:15:00Z", ok: true},
		{input: "2026-03-19 10:15:00", want: "2026-03-19T10:15:00Z", ok: true},
		{input: "19/03/2026", ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, err := parseStatementDate(tt.input)
			if (err == nil) != tt.ok {
				t.Fatalf("parseStatementDate() error = %v, want success %t", err, tt.ok)
			}
			if err == nil && got != tt.want {
				t.Fatalf("parseStatementDate() = %q, want %q", got, tt.want)
			}
		})
	}
}
