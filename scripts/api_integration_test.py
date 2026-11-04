"""Integration checks against a running AegisPay API (no mocks).

Covers risk rules in the payment flow, the event log and webhook tools,
sessions, and the tamper-evident audit chain. Each run registers a fresh
workspace, so it is safe against a sandbox deployment.

    python3 scripts/api_integration_test.py http://127.0.0.1:8080

Set AUDIT_PSQL_URL to a database URL to also check that the database refuses
audit log edits, and AEGIS_API_KEY to verify the bootstrap organization's chain.
"""
import json, os, subprocess, sys, uuid, urllib.request, urllib.error

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

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
