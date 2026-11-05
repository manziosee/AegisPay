package main

import "testing"

const sampleCAMT053 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <Stmt>
      <Ntry>
        <Amt Ccy="EUR">1200.50</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts><Cd>BOOK</Cd></Sts>
        <BookgDt><Dt>2026-03-02</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>E2E-1</EndToEndId></Refs>
          <RmtInf><Ustrd>INV-2026-001</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">80.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><DtTm>2026-03-03T10:15:00+01:00</DtTm></BookgDt>
        <NtryDtls><TxDtls><Refs><EndToEndId>AP-PAYOUT42</EndToEndId></Refs></TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">5.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts><Cd>PDNG</Cd></Sts>
        <BookgDt><Dt>2026-03-04</Dt></BookgDt>
        <NtryRef>PENDING-1</NtryRef>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`

const sampleMT940 = `:20:STMT20260302
:25:DE89370400440532013000
:28C:00001/001
:60F:C260301EUR1000,00
:61:2603020302C1200,50NTRFINV-2026-001//BANKREF1
:86:Payment from Ada Lovelace
:61:260303D80,NTRFNONREF//BANKREF2
:86:AP-PAYOUT42
supplier payout
:62F:C260303EUR2120,50
-`

const sampleOFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260302120000[-5:EST]
<TRNAMT>1200.50
<FITID>F1
<NAME>Ada Lovelace
<MEMO>INV-2026-001
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260303
<TRNAMT>-80.00
<FITID>F2
<NAME>Supplier
<REFNUM>AP-PAYOUT42
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`

func TestDetectStatementFormat(t *testing.T) {
	for name, want := range map[string]string{sampleCAMT053: "camt053", sampleMT940: "mt940", sampleOFX: "ofx", "reference,amount\nx,1": ""} {
		if got := detectStatementFormat(name); got != want {
			t.Errorf("detect: got %q want %q", got, want)
		}
	}
}

func checkLines(t *testing.T, format string, got []statementLine, want []statementLine) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: got %d lines %+v, want %d", format, len(got), got, len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%s line %d: got %+v want %+v", format, i+1, got[i], want[i])
		}
	}
}

func TestParseCAMT053SkipsPendingAndReadsReferences(t *testing.T) {
	lines, err := parseCAMT053(sampleCAMT053)
	if err != nil {
		t.Fatal(err)
	}
	checkLines(t, "camt053", lines, []statementLine{
		{Reference: "INV-2026-001", Amount: 120050, Currency: "EUR", Date: "2026-03-02T00:00:00Z"},
		{Reference: "AP-PAYOUT42", Amount: 8000, Currency: "EUR", Date: "2026-03-03T09:15:00Z"},
	})
}

func TestParseMT940UsesInformationWhenNoReference(t *testing.T) {
	lines, err := parseMT940(sampleMT940)
	if err != nil {
		t.Fatal(err)
	}
	checkLines(t, "mt940", lines, []statementLine{
		{Reference: "INV-2026-001", Amount: 120050, Currency: "EUR", Date: "2026-03-02T00:00:00Z"},
		{Reference: "AP-PAYOUT42", Amount: 8000, Currency: "EUR", Date: "2026-03-03T00:00:00Z"},
	})
}

func TestParseOFXHandlesSGMLDatesAndSigns(t *testing.T) {
	lines, err := parseOFX(sampleOFX)
	if err != nil {
		t.Fatal(err)
	}
	checkLines(t, "ofx", lines, []statementLine{
		{Reference: "INV-2026-001", Amount: 120050, Currency: "USD", Date: "2026-03-02T17:00:00Z"},
		{Reference: "AP-PAYOUT42", Amount: 8000, Currency: "USD", Date: "2026-03-03T00:00:00Z"},
	})
}

func TestStatementParsersRejectBrokenFiles(t *testing.T) {
	if _, err := parseCAMT053("<Document><BkToCstmrStmt><Stmt><Ntry><Amt Ccy=\"EUR\">abc</Amt></Ntry></Stmt></BkToCstmrStmt></Document>"); err == nil {
		t.Error("invalid CAMT amount must fail")
	}
	if _, err := parseMT940(":20:X\n:61:2603020302C1200,50NTRFREF\n"); err == nil {
		t.Error("MT940 without an opening balance currency must fail")
	}
	if _, err := parseOFX("<OFX><STMTTRN><TRNAMT>1.00</STMTTRN></OFX>"); err == nil {
		t.Error("OFX without CURDEF must fail")
	}
	if got := currencyMinorDigits("jpy"); got != 0 {
		t.Errorf("JPY has 0 decimals, got %d", got)
	}
}

func TestParseMT940FallsBackToBankReference(t *testing.T) {
	lines, err := parseMT940(":20:X\n:60F:C260301KES0,\n:61:260302C500,NTRFNONREF//MPESA123\n:62F:C260302KES500,\n-")
	if err != nil || len(lines) != 1 || lines[0].Reference != "MPESA123" || lines[0].Amount != 50000 {
		t.Fatalf("got %+v %v", lines, err)
	}
}
