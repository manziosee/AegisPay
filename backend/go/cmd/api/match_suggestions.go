package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
	"unicode"
)

// Match suggestions for statement lines whose reference matches nothing.
// They are explained in plain words and never applied automatically: a person
// accepts one, which is recorded like any manual match.

type suggestionCandidate struct {
	id, reference, currency string
	amount                  int64
	created                 time.Time
}

type matchSuggestion struct {
	collectionID string
	score        int
	reason       string
}

// loadSuggestionCandidates returns collections that could still be matched:
// same currency and amount as some unmatched line, not already reconciled,
// and created in the 120 days before the statement.
func loadSuggestionCandidates(ctx context.Context, tx *sql.Tx, org string, amounts []int64, currencies []string, since time.Time) ([]suggestionCandidate, error) {
	rows, err := tx.QueryContext(ctx, `SELECT c.id,c.reference,c.currency,c.amount_minor,c.created_at FROM collections c
		WHERE c.organization_id=$1 AND c.amount_minor=ANY($2) AND c.currency=ANY($3) AND c.created_at>=$4
		AND (c.status='succeeded' OR (c.status='pending' AND (SELECT environment FROM organizations WHERE id=$1)='live'))
		AND NOT EXISTS(SELECT 1 FROM reconciliation_lines l WHERE l.organization_id=c.organization_id AND l.matched_collection_id=c.id AND l.match_status='matched')
		ORDER BY c.created_at DESC LIMIT 5000`, org, amounts, currencies, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []suggestionCandidate
	for rows.Next() {
		var c suggestionCandidate
		if err = rows.Scan(&c.id, &c.reference, &c.currency, &c.amount, &c.created); err != nil {
			return nil, err
		}
		c.currency = strings.TrimSpace(c.currency)
		out = append(out, c)
	}
	return out, rows.Err()
}

// referenceTokens splits "INV-2026/1042 J.Smith" into lowercase runs of
// letters or digits of three or more characters: inv, 2026, 1042, smith.
func referenceTokens(value string) []string {
	var tokens []string
	var b strings.Builder
	flush := func() {
		if b.Len() >= 3 {
			tokens = append(tokens, b.String())
		}
		b.Reset()
	}
	lastDigit := false
	for _, c := range strings.ToLower(value) {
		isDigit, isLetter := unicode.IsDigit(c), unicode.IsLetter(c)
		if !isDigit && !isLetter {
			flush()
			continue
		}
		if b.Len() > 0 && isDigit != lastDigit {
			flush()
		}
		b.WriteRune(c)
		lastDigit = isDigit
	}
	flush()
	return tokens
}

// sharedToken returns the most telling token of reference found in text:
// a number beats a word, a longer token beats a shorter one.
func sharedToken(reference, text string) string {
	textTokens := map[string]bool{}
	for _, t := range referenceTokens(text) {
		textTokens[t] = true
	}
	best := ""
	bestDigits := false
	for _, t := range referenceTokens(reference) {
		if !textTokens[t] {
			continue
		}
		digits := unicode.IsDigit(rune(t[0]))
		if best == "" || (digits && !bestDigits) || (digits == bestDigits && len(t) > len(best)) {
			best, bestDigits = t, digits
		}
	}
	return best
}

func daysBetween(a, b time.Time) int {
	d := a.Sub(b)
	if d < 0 {
		d = -d
	}
	return int(d.Hours() / 24)
}

// suggestCollection picks the best candidate for one statement line, or
// nothing when no candidate is convincing or two are equally likely.
func suggestCollection(line statementLine, gross int64, date time.Time, candidates []suggestionCandidate, taken map[string]bool) (matchSuggestion, bool) {
	best, second := -1, -1
	var bestCandidate suggestionCandidate
	var bestToken string
	for _, c := range candidates {
		if taken[c.id] || c.amount != gross || !strings.EqualFold(c.currency, line.Currency) {
			continue
		}
		score := 50
		days := daysBetween(date, c.created)
		switch {
		case days <= 3:
			score += 25
		case days <= 14:
			score += 15
		case days <= 45:
			score += 5
		}
		if date.Before(c.created.Add(-48 * time.Hour)) {
			// Paid well before it was asked for: possible, but unlikely.
			score -= 25
		}
		token := sharedToken(c.reference, line.Reference)
		if token != "" {
			score += 25
		}
		if score > best {
			second = best
			best, bestCandidate, bestToken = score, c, token
		} else if score > second {
			second = score
		}
	}
	if best < 60 || best == second {
		return matchSuggestion{}, false
	}
	parts := []string{"same amount and currency"}
	days := daysBetween(date, bestCandidate.created)
	switch {
	case days == 0:
		parts = append(parts, "requested the same day")
	case date.Before(bestCandidate.created):
		parts = append(parts, fmt.Sprintf("requested %d days after this payment", days))
	default:
		parts = append(parts, fmt.Sprintf("requested %d days before this payment", days))
	}
	if bestToken != "" {
		parts = append(parts, fmt.Sprintf("the statement reference contains %q from %s", bestToken, bestCandidate.reference))
	}
	confidence := "Possible match"
	if best >= 90 {
		confidence = "Likely match"
	}
	reason := fmt.Sprintf("%s: payment request %s for %s (%s). Accept it only if this is the same payment.",
		confidence, bestCandidate.reference, formatMinorAmount(bestCandidate.amount, bestCandidate.currency), strings.Join(parts, ", "))
	if best > 100 {
		best = 100
	}
	return matchSuggestion{collectionID: bestCandidate.id, score: best, reason: reason}, true
}
