"""Integration checks against a running AegisPay API (no mocks).

Covers risk rules in the payment flow, the event log and webhook tools,
sessions, and the tamper-evident audit chain. Each run registers a fresh
workspace, so it is safe against a sandbox deployment.

    python3 scripts/api_integration_test.py http://127.0.0.1:8080

Set AUDIT_PSQL_URL to a database URL to also check that the database refuses
audit log edits, and AEGIS_API_KEY to verify the bootstrap organization's chain.
"""
import hashlib, json, os, subprocess, sys, uuid, urllib.request, urllib.error

API = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:58080"
results = []


def call(m, p, t=None, b=None, idem=False, ua=None):
    h = {"Content-Type": "application/json"}
    if t:
        h["Authorization"] = "Bearer " + t
    if idem:
        h["Idempotency-Key"] = "k_" + uuid.uuid4().hex
    if ua:
        h["User-Agent"] = ua
    r = urllib.request.Request(API + p, data=None if b is None else json.dumps(b).encode(), method=m, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=30) as x:
            return x.status, json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def ok(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {detail}"))


email = f"s3-{uuid.uuid4().hex[:8]}@example.com"
s, R = call("POST", "/v1/auth/register", b={"full_name": "Stage Three", "email": email, "password": "correct-horse-battery", "organization_name": "Stage Three Ltd", "country_code": "GB"}, ua="Mozilla/5.0 Firefox/140")
t = R["access_token"]
s, a1 = call("POST", "/v1/accounts", t, {"currency": "GBP"})
s, a2 = call("POST", "/v1/accounts", t, {"currency": "GBP"})
call("POST", f"/v1/accounts/{a1['id']}/sandbox-credit", t, {"amount": 10_000_000}, idem=True)
s, cust = call("POST", "/v1/customers", t, {"name": "Velocity Tester"})

# --- risk rules ---
s, block = call("POST", "/v1/risk-rules", t, {"name": "Block huge GBP transfers", "applies_to": ["transfer"], "currency": "GBP", "min_amount_minor": 5_000_000, "action": "block"})
ok("create block rule", s == 201 and block["action"] == "block", (s, block))
s, review = call("POST", "/v1/risk-rules", t, {"name": "Review mid transfers", "applies_to": ["transfer", "payout"], "min_amount_minor": 100_000, "action": "review", "priority": 50})
s, velocity = call("POST", "/v1/risk-rules", t, {"name": "Customer velocity", "applies_to": ["collection"], "velocity_count": 2, "velocity_window_minutes": 60, "action": "review"})
ok("create velocity rule", s == 201 and velocity["velocity_count"] == 2, (s, velocity))
s, bad = call("POST", "/v1/risk-rules", t, {"name": "bad", "applies_to": ["transfer"], "action": "hold"})
ok("invalid rule refused", s == 400, (s, bad))
s, lst = call("GET", "/v1/risk-rules", t)
ok("list rules ordered by priority", s == 200 and [r["name"] for r in lst["data"]][0] == "Review mid transfers", lst)

s, ev = call("POST", "/v1/risk-rules/evaluate", t, {"kind": "transfer", "amount": 6_000_000, "currency": "GBP"})
ok("dry run: block wins over review", ev.get("decision") == "block" and len(ev["matched_rules"]) == 2, ev)

ref = lambda: "R-" + uuid.uuid4().hex[:8]
s, tb = call("POST", "/v1/transfers", t, {"source_account_id": a1["id"], "destination_account_id": a2["id"], "amount": 6_000_000, "currency": "GBP", "reference": ref()}, idem=True)
ok("blocked transfer refused with reason", s == 422 and "Block huge GBP transfers" in tb.get("error", ""), (s, tb))
s, tr = call("POST", "/v1/transfers", t, {"source_account_id": a1["id"], "destination_account_id": a2["id"], "amount": 200_000, "currency": "GBP", "reference": ref()}, idem=True)
ok("review rule routes transfer to approval", s == 202 and tr["status"] == "pending_approval" and tr["risk"]["case_id"], (s, tr))
s, ts = call("POST", "/v1/transfers", t, {"source_account_id": a1["id"], "destination_account_id": a2["id"], "amount": 5_000, "currency": "GBP", "reference": ref()}, idem=True)
ok("small transfer passes", s == 201 and ts["status"] == "completed" and ts["risk"]["decision"] == "allow", (s, ts))

cols = []
for i in range(3):
    s, c = call("POST", "/v1/collections", t, {"amount": 1000 + i, "currency": "GBP", "reference": ref(), "customer_id": cust["id"]}, idem=True)
    cols.append(c)
ok("third collection for a customer within an hour is held", cols[0]["risk"]["decision"] == "allow" and cols[1]["risk"]["decision"] == "allow" and cols[2]["risk"]["decision"] == "review", [c["risk"]["decision"] for c in cols])
s, held = call("POST", f"/v1/collections/{cols[2]['id']}/sandbox-confirm", t, {"account_id": a2["id"]}, idem=True)
ok("held collection cannot be confirmed", s == 409 and "risk review" in held.get("error", ""), (s, held))
call("POST", f"/v1/fraud/cases/{cols[2]['risk']['case_id']}/resolve", t, {"note": "Customer verified by phone", "outcome": "false_positive"})
s, conf = call("POST", f"/v1/collections/{cols[2]['id']}/sandbox-confirm", t, {"account_id": a2["id"]}, idem=True)
ok("confirmable after the case is resolved", s == 200, (s, conf))

s, pay = call("POST", "/v1/bank-operations/payouts", t, {"beneficiary_name": "Supplier GmbH", "amount": 150_000, "currency": "EUR", "description": "Invoice 42"})
ok("payout review rule requires approval", s == 201 and pay["status"] == "pending_approval" and pay["risk"]["decision"] == "review", (s, pay))

disabled = dict(block, enabled=False)
for k in ("id", "created_at", "updated_at"):
    disabled.pop(k)
s, upd = call("PUT", f"/v1/risk-rules/{block['id']}", t, disabled)
ok("disable a rule", s == 200 and upd["enabled"] is False, (s, upd))
s, ev = call("POST", "/v1/risk-rules/evaluate", t, {"kind": "transfer", "amount": 6_000_000, "currency": "GBP"})
ok("disabled rule no longer blocks", ev["decision"] == "review", ev)
s, d = call("DELETE", f"/v1/risk-rules/{velocity['id']}", t)
ok("delete a rule", s == 200, (s, d))

# --- events and webhook tools ---
s, ep = call("POST", "/v1/webhook-endpoints", t, {"url": "https://example.com/stage3", "events": ["collection.succeeded", "transfer.completed"]})
s, events = call("GET", "/v1/events?limit=10", t)
ok("event log lists events", s == 200 and len(events["data"]) > 0 and "data" in events["data"][0], (s, events))
transfer_event = next(e for e in events["data"] if e["type"] == "transfer.completed")
s, rp = call("POST", f"/v1/events/{transfer_event['id']}/replay", t)
ok("replay queues delivery to a later-subscribed endpoint", s == 202 and rp["deliveries_queued"] == 1, (s, rp))
s, filtered = call("GET", "/v1/events?type=fraud.case.opened", t)
ok("filter events by type", s == 200 and all(e["type"] == "fraud.case.opened" for e in filtered["data"]) and filtered["data"], filtered)
s, test = call("POST", f"/v1/webhook-endpoints/{ep['id']}/test", t)
ok("test event queued for one endpoint", s == 202 and test["delivery_id"].startswith("whd_"), (s, test))
s, rot = call("POST", f"/v1/webhook-endpoints/{ep['id']}/rotate-secret", t)
ok("rotate signing secret", s == 200 and len(rot["signing_secret"]) == 64 and rot["signing_secret"] != ep["signing_secret"], (s, rot))

# --- sessions ---
s, L = call("POST", "/v1/auth/login", b={"email": email, "password": "correct-horse-battery"}, ua="Mozilla/5.0 Chrome/141")
t2 = L["access_token"]
s, sess = call("GET", "/v1/auth/sessions", t)
ok("session list shows device and current flag", s == 200 and len(sess["data"]) == 2 and sum(x["current"] for x in sess["data"]) == 1 and any("Chrome" in x["user_agent"] for x in sess["data"]), sess)
s, rv = call("POST", "/v1/auth/sessions/revoke-others", t)
ok("sign out everywhere else", s == 200 and rv["revoked"] == 1, (s, rv))
s, _ = call("GET", "/v1/auth/me", t2)
ok("other session no longer works", s == 401, s)
s, _ = call("GET", "/v1/auth/me", t)
ok("current session still works", s == 200, s)

# --- audit chain ---
s, v = call("GET", "/v1/audit-logs/verify", t)
ok("audit chain verifies (Go and SQL hashes agree)", s == 200 and v["valid"] is True and v["checked"] >= 5, (s, v))
if os.environ.get("AUDIT_PSQL_URL"):
    tamper = subprocess.run(["psql", os.environ["AUDIT_PSQL_URL"], "-tAc", "UPDATE audit_logs SET action='x' WHERE id=(SELECT id FROM audit_logs LIMIT 1)"], capture_output=True, text=True)
    ok("database refuses audit edits", "append-only" in tamper.stderr, tamper.stderr)
if os.environ.get("AEGIS_API_KEY"):
    s, boot = call("GET", "/v1/audit-logs/verify", os.environ["AEGIS_API_KEY"])
    ok("bootstrap organization audit chain verifies", s == 200 and boot["valid"] is True, (s, boot))


# --- statement files: CAMT.053, MT940, OFX ---------------------------------
def run_sql(query):
    """Runs SQL when the test has database access (CI: psql, local: docker)."""
    if os.environ.get("AUDIT_PSQL_URL"):
        out = subprocess.run(["psql", os.environ["AUDIT_PSQL_URL"], "-tAc", query], capture_output=True, text=True)
    elif os.environ.get("PG_CONTAINER"):
        out = subprocess.run(["docker", "exec", os.environ["PG_CONTAINER"], "psql", "-U", "postgres", "-d", os.environ.get("PG_DATABASE", "aegis"), "-tAc", query], capture_output=True, text=True)
    else:
        return None
    return out.stdout.strip()

s, a3 = call("POST", "/v1/accounts", t, {"currency": "GBP"})
refs = {}
for kind in ("camt", "mt940", "ofx"):
    r = f"{kind.upper()}-" + uuid.uuid4().hex[:6].upper()
    s, col = call("POST", "/v1/collections", t, {"amount": 120050, "currency": "GBP", "reference": r}, idem=True)
    call("POST", f"/v1/collections/{col['id']}/sandbox-confirm", t, {"account_id": a3["id"]}, idem=True)
    refs[kind] = r
camt = f"""<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt>
<Ntry><Amt Ccy="GBP">1200.50</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-01-20</Dt></BookgDt>
<NtryDtls><TxDtls><RmtInf><Ustrd>{refs['camt']}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>"""
mt940 = f":20:S1\n:25:GB00TEST\n:28C:1/1\n:60F:C260119GBP0,00\n:61:2601200120C1200,50NTRFNONREF//B1\n:86:{refs['mt940']}\n:62F:C260120GBP1200,50\n-"
ofx = f"OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><STMTRS><CURDEF>GBP<BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260120<TRNAMT>1200.50<FITID>X1<MEMO>{refs['ofx']}</STMTTRN></BANKTRANLIST></STMTRS></OFX>"
for kind, content in (("camt", camt), ("mt940", mt940), ("ofx", ofx)):
    s, imp = call("POST", "/v1/reconciliation/imports/file", t, {"source_name": f"bank.{kind}", "format": "auto", "content": content}, idem=True)
    ok(f"{kind} statement file matches its collection", s == 201 and imp.get("matched_count") == 1 and imp.get("exception_count") == 0, (s, imp))
s, bad_file = call("POST", "/v1/reconciliation/imports/file", t, {"content": "not a statement"}, idem=True)
ok("unrecognised statement file refused", s == 400, (s, bad_file))

# --- password reset --------------------------------------------------------
s, fp = call("POST", "/v1/auth/password/forgot", b={"email": email})
s2, fp2 = call("POST", "/v1/auth/password/forgot", b={"email": f"nobody-{uuid.uuid4().hex[:6]}@example.com"})
ok("forgot password answers the same for known and unknown emails", s == 202 and s2 == 202 and fp == fp2, (s, fp, s2, fp2))
token = "aegis_reset_" + uuid.uuid4().hex
inserted = run_sql(f"INSERT INTO password_reset_tokens(token_hash,user_id,expires_at) SELECT '{hashlib.sha256(token.encode()).hexdigest()}',id,now()+interval '1 hour' FROM users WHERE email='{email}' RETURNING 1")
if inserted is not None:
    s, short = call("POST", "/v1/auth/password/reset", b={"token": token, "password": "short"})
    ok("reset refuses a short password", s == 400, (s, short))
    s, done = call("POST", "/v1/auth/password/reset", b={"token": token, "password": "a-brand-new-password"})
    ok("reset with a valid token changes the password", s == 200, (s, done))
    s, _ = call("GET", "/v1/auth/me", t)
    ok("reset signs out existing sessions", s == 401, s)
    s, again = call("POST", "/v1/auth/password/reset", b={"token": token, "password": "another-new-password"})
    ok("reset token works only once", s == 400, (s, again))
    s, L = call("POST", "/v1/auth/login", b={"email": email, "password": "a-brand-new-password"})
    ok("sign in with the new password", s == 200, (s, L))
    t = L["access_token"]

# --- team chat channels -----------------------------------------------------
s, bad_channel = call("POST", "/v1/notification-channels", t, {"kind": "slack", "url": "https://evil.example.com/services/x"})
ok("chat channel refuses a non-Slack link", s == 400, (s, bad_channel))
s, ch = call("POST", "/v1/notification-channels", t, {"kind": "discord", "name": "Finance", "url": "https://discord.com/api/webhooks/1/integration-test-not-real"})
ok("chat channel saved with a masked link", s == 201 and "integration-test" not in json.dumps(ch), (s, ch))
s, lst = call("GET", "/v1/notification-channels", t)
ok("chat channels list default events", s == 200 and len(lst["data"]) == 1 and "transfer.approval_required" in lst["data"][0]["events"], (s, lst))
s, test = call("POST", f"/v1/notification-channels/{ch['id']}/test", t)
ok("test message to an invalid webhook reports the platform's error", s == 502 and "Discord" in test.get("error", ""), (s, test))
s, d = call("DELETE", f"/v1/notification-channels/{ch['id']}", t)
ok("remove chat channel", s == 200, (s, d))

# --- invitation and approval emails (logged when no email provider) -------
s, inv = call("POST", "/v1/invitations", t, {"email": f"invitee-{uuid.uuid4().hex[:6]}@example.com", "role": "auditor"})
ok("invitation still returns its one-time token", s == 201 and inv.get("invite_token", "").startswith("aegis_invite_"), (s, inv))


# --- risk evaluation without any external service ----------------------------
s, assess = call("POST", "/v1/fraud/analyze", t, {"transaction_reference": "MANUAL-1", "amount": 200_000, "currency": "EUR"})
ok("evaluate transaction works from the rules engine", s == 200 and assess["decision"] == "review" and assess["model_version"] == "rules-v1" and assess["matched_rules"], (s, assess))

# --- email verification, sample data, practice versus live ---------------------
fresh = f"fresh-{uuid.uuid4().hex[:8]}@example.com"
s, F = call("POST", "/v1/auth/register", b={"full_name": "Fresh User", "email": fresh, "password": "correct-horse-battery", "organization_name": "Fresh Ltd", "country_code": "KE", "accepted_terms": True})
ft = F["access_token"]
s, me = call("GET", "/v1/auth/me", ft)
ok("a new account starts unverified", me.get("email_verified") is False, me)
s, live = call("POST", "/v1/organizations", ft, {"name": "Fresh Live", "country_code": "KE", "environment": "live"})
ok("unverified accounts cannot create a live workspace", s == 403, (s, live))
vtoken = "aegis_verify_" + uuid.uuid4().hex
if run_sql(f"INSERT INTO email_verification_tokens(token_hash,user_id,expires_at) SELECT '{hashlib.sha256(vtoken.encode()).hexdigest()}',id,now()+interval '1 hour' FROM users WHERE email='{fresh}' RETURNING 1") is not None:
    s, v = call("POST", "/v1/auth/email/verify", b={"token": vtoken})
    ok("email confirmation link works", s == 200, (s, v))
    s, v = call("POST", "/v1/auth/email/verify", b={"token": vtoken})
    ok("email confirmation link works once", s == 400, (s, v))
    s, me = call("GET", "/v1/auth/me", ft)
    ok("account is verified afterwards", me.get("email_verified") is True, me)
    s, live = call("POST", "/v1/organizations", ft, {"name": "Fresh Live", "country_code": "KE", "environment": "live"})
    ok("verified account creates a live workspace", s == 201 and live["environment"] == "live", (s, live))
    lorg = live["id"]
    def lcall(m, p, b=None, idem=False):
        h_org = {"X-Organization-ID": lorg}
        h = {"Content-Type": "application/json", "Authorization": "Bearer " + ft, **h_org}
        if idem:
            h["Idempotency-Key"] = "k_" + uuid.uuid4().hex
        r = urllib.request.Request(API + p, data=None if b is None else json.dumps(b).encode(), method=m, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=30) as x:
                return x.status, json.loads(x.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")
    s, la = lcall("POST", "/v1/accounts", {"currency": "KES"})
    s, c = lcall("POST", f"/v1/accounts/{la['id']}/sandbox-credit", {"amount": 1000}, idem=True)
    ok("live workspace refuses simulated credits", s == 403, (s, c))
    lref = "LIVE-" + uuid.uuid4().hex[:6]
    s, lc = lcall("POST", "/v1/collections", {"amount": 50000, "currency": "KES", "reference": lref}, idem=True)
    s, c = lcall("POST", f"/v1/collections/{lc['id']}/sandbox-confirm", {"account_id": la["id"]}, idem=True)
    ok("live workspace refuses simulated confirmation", s == 403, (s, c))
    s, imp = lcall("POST", "/v1/reconciliation/imports", {"lines": [{"external_reference": lref, "amount": 49000, "provider_fee": 1000, "currency": "KES", "transaction_date": "2026-01-20T10:00:00Z"}]}, idem=True)
    ok("a bank statement line confirms a live collection", s == 201 and imp["matched_count"] == 1 and imp["collections_confirmed"] == 1 and imp["mode"] == "live", (s, imp))
    s, got = lcall("GET", f"/v1/collections/{lc['id']}")
    ok("the collection is now succeeded", got.get("status") == "succeeded", got)
    s, bal = lcall("GET", f"/v1/accounts/{la['id']}/balance")
    ok("the money reached the main account's balance", bal.get("balance_minor") == 50000, bal)
    s, key = lcall("POST", "/v1/api-keys", {"name": "live key"})
    ok("live workspace issues live API keys", s == 201 and key["secret"].startswith("aegis_live_") and key["environment"] == "live", (s, key))
    s, smp = lcall("POST", "/v1/onboarding/sample-data", {})
    ok("sample data is refused in a live workspace", s == 409, (s, smp))
s, st = call("GET", "/v1/onboarding/status", ft)
ok("onboarding status starts without sample data", s == 200 and st["sample_data_loaded"] is False, (s, st))
s, smp = call("POST", "/v1/onboarding/sample-data", ft, {})
ok("sample data loads in the workspace's currency", s == 201 and smp["currency"] == "KES", (s, smp))
s, smp2 = call("POST", "/v1/onboarding/sample-data", ft, {})
ok("sample data loads only once", s == 409, (s, smp2))
s, rep = call("GET", "/v1/reports/transactions", ft)
ok("sample activity appears in reports", s == 200 and any(x["reference"].startswith("SAMPLE-") for x in rep["data"]), (s, rep.get("summary")))
s, pend = call("GET", "/v1/transfers?limit=10", ft)
pending = next((x for x in pend["data"] if x["status"] == "pending_approval"), None)
s, ap = call("POST", f"/v1/transfers/{pending['id']}/approve", ft, {}, idem=True)
ok("owner can approve the sample transfer (it posts against sample funds)", s == 200 and ap["status"] == "completed", (s, ap))

# --- customers: view, edit, delete or archive -----------------------------------
s, cu = call("POST", "/v1/customers", ft, {"name": "Edit Me", "email": f"edit-{uuid.uuid4().hex[:6]}@example.com"})
s, ed = call("PATCH", f"/v1/customers/{cu['id']}", ft, {"name": "Edited Name", "phone": "+254700000001"})
ok("edit a customer", s == 200 and ed["name"] == "Edited Name" and ed["phone"] == "+254700000001", (s, ed))
s, bad_email = call("PATCH", f"/v1/customers/{cu['id']}", ft, {"email": "not-an-email"})
ok("customer email is validated", s == 400, (s, bad_email))
s, dl = call("DELETE", f"/v1/customers/{cu['id']}", ft)
ok("a customer with no history is deleted", s == 200 and dl["status"] == "deleted", (s, dl))
s, _ = call("GET", f"/v1/customers/{cu['id']}", ft)
ok("the deleted customer is gone", s == 404, s)
s, cu = call("POST", "/v1/customers", ft, {"name": "Has History"})
s, cacc = call("POST", "/v1/accounts", ft, {"currency": "KES", "customer_id": cu["id"]})
s, det = call("GET", f"/v1/customers/{cu['id']}", ft)
ok("customer detail lists their accounts", s == 200 and det["accounts"][0]["id"] == cacc["id"] and "recent_collections" in det, (s, det))
s, dl = call("DELETE", f"/v1/customers/{cu['id']}", ft)
ok("a customer with history is archived instead", s == 200 and dl["status"] == "archived", (s, dl))
s, blocked = call("POST", "/v1/accounts", ft, {"currency": "KES", "customer_id": cu["id"]})
ok("archived customers get no new accounts", s == 409, (s, blocked))
s, rs = call("PATCH", f"/v1/customers/{cu['id']}", ft, {"status": "active"})
ok("an archived customer can be restored", s == 200 and rs["status"] == "active", (s, rs))

# --- payment-provider statements and match suggestions --------------------------
s, kes = call("POST", "/v1/accounts", ft, {"currency": "KES"})
tag = uuid.uuid4().hex[:4].upper()
def succeeded_collection(ref, amount):
    s, c = call("POST", "/v1/collections", ft, {"amount": amount, "currency": "KES", "reference": ref}, idem=True)
    call("POST", f"/v1/collections/{c['id']}/sandbox-confirm", ft, {"account_id": kes["id"]}, idem=True)
    return c
num = str(uuid.uuid4().int)[:6]
exact = succeeded_collection(f"INV-{tag}1", 10_000)
fuzzy = succeeded_collection(f"INV-{num}", 2_550)
today = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%d")
mpesa = f"""Customer Name:,Fresh Ltd
Receipt No.,Completion Time,Details,Transaction Status,Paid In,Withdrawn,Balance,A/C No.
QX1,{today} 09:00:00,Pay Bill from 254700000000 - JANE,Completed,100.00,,500.00,INV-{tag}1
QX2,{today} 09:05:00,Pay Bill from 254711111111 - Acc. PAY-{num},Completed,25.50,,525.50,
QX3,{today} 09:06:00,Pay Bill Charge,Completed,,-1.00,524.50,
"""
s, imp = call("POST", "/v1/reconciliation/imports/provider", ft, {"provider": "auto", "csv": mpesa}, idem=True)
ok("M-Pesa statement imported and matched", s == 201 and imp["provider"] == "mpesa" and imp["matched_count"] == 1 and imp["skipped_rows"] == 1, (s, imp))
ok("a mistyped reference gets a suggested match", imp.get("suggested_count") == 1, imp)
s, detail = call("GET", f"/v1/reconciliation/imports/{imp['id']}", ft)
line = next((l for l in detail.get("lines", []) if l["match_status"] != "matched"), {})
ok("the suggestion names the request and explains why", line.get("suggested_collection_id") == fuzzy["id"] and num in line.get("suggestion_reason", ""), line)
s, acc = call("POST", f"/v1/reconciliation/imports/{imp['id']}/lines/{line.get('line_id')}/resolve", ft, {"resolution": "match", "collection_id": line.get("suggested_collection_id"), "note": "Accepted suggested match"})
ok("accepting the suggestion matches the line", s == 200, (s, acc))
stripe = "id,Type,Source,Amount,Fee,Net,Currency,Created (UTC),Description\ntxn_1,charge,ch_1,10.00,0.50,9.50,kes,2026-01-21 10:00,UNKNOWN-REF\n"
s, imp2 = call("POST", "/v1/reconciliation/imports/provider", ft, {"provider": "auto", "csv": stripe}, idem=True)
ok("Stripe export detected automatically", s == 201 and imp2["provider"] == "stripe", (s, imp2))
s, wrong = call("POST", "/v1/reconciliation/imports/provider", ft, {"provider": "flutterwave", "csv": stripe}, idem=True)
ok("a file from the wrong provider is explained", s == 400 and "Stripe" in wrong.get("error", ""), (s, wrong))
s, src = call("GET", "/v1/reconciliation/sources", ft)
providers = {row["provider"] for row in src.get("data", [])}
ok("every source is summarized side by side", s == 200 and {"mpesa", "stripe"} <= providers, (s, src))

# --- risk-rule templates --------------------------------------------------------------
s, tl = call("GET", "/v1/risk-rules/templates", ft)
ok("four rule templates priced in the workspace currency", s == 200 and len(tl["data"]) == 4 and tl["data"][0]["currency"] == "KES" and "KES" in tl["data"][0]["rules"][0]["name"], (s, tl))
s, ap = call("POST", "/v1/risk-rules/templates/cooperative/apply", ft, {})
ok("applying a template creates its rules", s == 201 and ap["created"] == 4, (s, ap))
s, ap = call("POST", "/v1/risk-rules/templates/cooperative/apply", ft, {})
ok("applying it again adds nothing", s == 201 and ap["created"] == 0 and ap["already_present"] == 4, (s, ap))

# --- charts and cash forecast ------------------------------------------------------------
s, act = call("GET", "/v1/reports/activity?days=30", ft)
ok("activity series for the charts", s == 200 and len(act["series"]) == 30 and act["total_in"] > 0 and act["balances"], (s, {k: act.get(k) for k in ("currency", "total_in", "total_out")}))
s, fc = call("GET", "/v1/reports/forecast?days=60", ft)
ok("cash forecast with history and projection", s == 200 and len(fc["projection"]) == 60 and len(fc["history"]) == 90 and fc["history"][-1]["balance"] == fc["balance_minor"], (s, {k: fc.get(k) for k in ("currency", "balance_minor", "runway_days", "note")}))

# --- public audit anchors and the audit pack ------------------------------------------
s, anchors = call("GET", "/v1/audit-logs/anchors", ft)
ok("audit anchors list", s == 200 and "data" in anchors, (s, anchors))
s, me = call("GET", "/v1/auth/me", ft)
forg = me["organization_id"]
if run_sql(f"INSERT INTO audit_anchors(id,organization_id,anchor_date,head_hash,last_entry_id,entry_count,statement,digest) SELECT 'anc_test_{tag}',organization_id,current_date-1,hash,id,1,'test','00' FROM audit_logs WHERE organization_id='{forg}' ORDER BY seq LIMIT 1 RETURNING 1") is not None:
    s, v = call("GET", "/v1/audit-logs/verify", ft)
    ok("chain verification checks public anchors", s == 200 and v["valid"] and v["anchors_checked"] == 1, (s, v))
    run_sql(f"UPDATE audit_anchors SET head_hash=repeat('f',64) WHERE id='anc_test_{tag}' RETURNING 1")
    s, v = call("GET", "/v1/audit-logs/verify", ft)
    ok("a chain that no longer matches its anchor is reported", s == 200 and v["valid"] is False and "anchor" in v.get("detail", ""), (s, v))
    run_sql(f"DELETE FROM audit_anchors WHERE id='anc_test_{tag}' RETURNING 1")
import datetime, io, zipfile
month = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m")
req = urllib.request.Request(API + f"/v1/reports/audit-pack?month={month}", headers={"Authorization": "Bearer " + ft})
with urllib.request.urlopen(req, timeout=60) as x:
    pack = zipfile.ZipFile(io.BytesIO(x.read()))
names = set(pack.namelist())
ok("audit pack has every file", {"ledger.csv", "approvals.csv", "reconciliation.csv", "risk-decisions.csv", "audit-log.csv", "manifest.json", "SHA256SUMS", "README.txt"} <= names, names)
manifest = json.loads(pack.read("manifest.json"))
sums_ok = all(hashlib.sha256(pack.read(f["name"])).hexdigest() == f["sha256"] for f in manifest["files"])
ok("audit pack file hashes match the manifest", sums_ok and manifest["audit_chain"]["valid"], manifest.get("audit_chain"))
with urllib.request.urlopen(API + "/audit-pack-keys", timeout=30) as x:
    keys = json.loads(x.read())["keys"]
if "manifest.sig" in names:
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        for n in ("manifest.json", "manifest.sig", "public_key.pem"):
            open(os.path.join(d, n), "wb").write(pack.read(n))
        published = any(k["public_key_pem"] == pack.read("public_key.pem").decode() for k in keys)
        check = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", "public_key.pem", "-rawin", "-in", "manifest.json", "-sigfile", "manifest.sig"], cwd=d, capture_output=True, text=True)
        ok("audit pack signature verifies with the published key", published and check.returncode == 0, (published, check.stdout, check.stderr))

# --- exports, feedback, deletion ------------------------------------------------
s, ex = call("GET", "/v1/auth/account/export", ft)
ok("personal data export", s == 200 and ex["profile"][0]["email"] == fresh and "password_hash" not in json.dumps(ex), (s, list(ex)[:6]))
s, wx = call("GET", "/v1/organizations/export", ft)
ok("workspace export has records and no secrets", s == 200 and len(wx["collections"]) >= 6 and "secret" not in json.dumps(wx), (s, list(wx)[:6]))
s, fb = call("POST", "/v1/feedback", ft, {"message": "   "})
ok("empty feedback refused", s == 400, (s, fb))
s, bad_del = call("POST", "/v1/auth/account/delete", ft, {"password": "wrong-password-value"})
ok("deleting an account needs the correct password", s == 401, (s, bad_del))
s, gone = call("POST", "/v1/auth/account/delete", ft, {"password": "correct-horse-battery"})
ok("account deletion closes solely owned workspaces", s == 200 and gone["workspaces_closed"] >= 1, (s, gone))
s, _ = call("GET", "/v1/auth/me", ft)
ok("sessions end after deletion", s == 401, s)
s, _ = call("POST", "/v1/auth/login", b={"email": fresh, "password": "correct-horse-battery"})
ok("a deleted account cannot sign in", s in (401, 429), s)  # 429: this run used up the per-IP login limit
s, again = call("POST", "/v1/auth/register", b={"full_name": "Fresh Again", "email": fresh, "password": "correct-horse-battery", "organization_name": "Fresh Again Ltd", "country_code": "KE"})
ok("the email address can be registered again", s == 201, (s, again))

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
