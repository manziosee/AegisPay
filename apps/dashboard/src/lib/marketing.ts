export type MegaMenuLink = {
  label: string;
  href: string;
  description: string;
  badge?: string;
};

export type MegaMenu = {
  label: string;
  columns: Array<{ heading: string; links: MegaMenuLink[] }>;
};

export const megaMenus: MegaMenu[] = [
  {
    label: "Product",
    columns: [
      {
        heading: "Financial operations",
        links: [
          {
            label: "Aegis Ledger",
            href: "/#platform",
            description: "Double-entry postings for collections, transfers and refunds."
          },
          {
            label: "Reconciliation",
            href: "/#transaction",
            description: "Match statement lines to ledger records, then resolve exceptions."
          },
          {
            label: "Approvals",
            href: "/#platform",
            description: "Maker-checker decisions with per-currency policy thresholds."
          }
        ]
      },
      {
        heading: "Intelligence",
        links: [
          {
            label: "Aegis Intelligence",
            href: "/#intelligence",
            description: "Score a transaction and keep the review decision."
          },
          {
            label: "Risk network",
            href: "/#intelligence",
            description: "See which records are connected to a review case."
          },
          {
            label: "Routing preview",
            href: "/#platform",
            description: "Evaluate ordered rules locally. No provider is connected.",
            badge: "Preview"
          }
        ]
      }
    ]
  },
  {
    label: "Developers",
    columns: [
      {
        heading: "Build",
        links: [
          {
            label: "API surface",
            href: "/#developers",
            description: "Collections, transfers, reconciliation, risk and webhooks."
          },
          {
            label: "Transaction timeline",
            href: "/#transaction",
            description: "One record across creation, risk, approval, ledger and match."
          },
          {
            label: "Webhook signature",
            href: "/#developers",
            description: "Timestamped HMAC-SHA256 with bounded retries."
          }
        ]
      },
      {
        heading: "Operate",
        links: [
          {
            label: "Webhook deliveries",
            href: "/#developers",
            description: "Attempts, HTTP status, last error and retry evidence."
          },
          {
            label: "Sandbox boundaries",
            href: "/#sandbox",
            description: "What this workspace does and does not do."
          },
          {
            label: "OpenAPI contract",
            href: "https://github.com/manziosee/AegisPay/blob/main/docs/api/openapi.yaml",
            description: "Request and response definitions in the repository."
          }
        ]
      }
    ]
  },
  {
    label: "Company",
    columns: [
      {
        heading: "AegisPay",
        links: [
          {
            label: "How the platform fits",
            href: "/#platform",
            description: "Ledger, intelligence and developer surfaces."
          },
          {
            label: "Security boundary",
            href: "/#sandbox",
            description: "Sandbox-only scope, tenant constraints and webhook controls."
          },
          {
            label: "Repository",
            href: "https://github.com/manziosee/AegisPay",
            description: "Go API, fraud service, infrastructure and dashboard."
          }
        ]
      },
      {
        heading: "Access",
        links: [
          {
            label: "Sign in",
            href: "/login",
            description: "Open an existing workspace."
          },
          {
            label: "Create sandbox account",
            href: "/register",
            description: "Register a business or personal sandbox."
          }
        ]
      }
    ]
  }
];

export const pillars = [
  {
    id: "ledger",
    title: "Aegis Ledger",
    summary: "One reliable financial record.",
    description:
      "Every collection, transfer and refund posts as a double-entry journal entry. Organization constraints keep each posting inside a single tenant.",
    bullets: [
      "Journal entries and lines written in one transaction",
      "Available balance accounts for transfers already pending approval",
      "Refunds cannot exceed the unrefunded collection amount"
    ]
  },
  {
    id: "intelligence",
    title: "Aegis Intelligence",
    summary: "Know the risk before you approve.",
    description:
      "A transaction reference is scored before review or finalization. The assessment stores score, level, decision and model version, and opens a case only when a reviewer is needed.",
    bullets: [
      "Risk score from 0 to 100 with allow, review or block",
      "Review cases carry priority, notes and an audited outcome",
      "Signals in this sandbox are derived from loaded records and labelled"
    ]
  },
  {
    id: "routing",
    title: "Aegis Routing",
    summary: "Integrate once. Route by rule.",
    description:
      "The routing surface is a preview in this build. Ordered rules are evaluated in the browser against amount, currency and country. No provider connector is configured.",
    bullets: [
      "Rules are stored in this browser, not sent to the server",
      "No provider availability, cost or success rate is claimed",
      "The result reads Preview, never Routed"
    ],
    badge: "Preview"
  },
  {
    id: "developers",
    title: "Developer platform",
    summary: "Sandbox APIs, webhooks and replayable events.",
    description:
      "The Go API exposes authenticated JSON endpoints for the operational record. Financial writes accept an idempotency key, and webhook deliveries carry a timestamped signature.",
    bullets: [
      "Cursor pagination on reports, transfers, imports and deliveries",
      "Idempotency replay for matching retries, conflict on reuse",
      "Failed webhook deliveries can be requeued with an audit record"
    ]
  }
];

export const signalExamples = [
  {
    code: "AMOUNT_ABOVE_BASELINE",
    description: "Amount is at or above the sandbox review baseline.",
    observed: "RWF 4,200",
    basis: "Baseline: 10,000,000 minor units",
    tone: "warning" as const
  },
  {
    code: "REPEATED_REFERENCE",
    description: "The reference already appears in loaded transaction records.",
    observed: "1 existing record",
    basis: "Exact reference match · last 100 records",
    tone: "critical" as const
  },
  {
    code: "POLICY_MISSING",
    description: "No transaction policy is configured for this currency.",
    observed: "RWF",
    basis: "Organization transaction policies",
    tone: "info" as const
  }
];

export const developerEndpoints = [
  {
    method: "POST",
    path: "/v1/collections",
    description: "Create a collection record. Requires an Idempotency-Key."
  },
  {
    method: "POST",
    path: "/v1/fraud/analyze",
    description: "Score a reference and store the risk assessment."
  },
  {
    method: "POST",
    path: "/v1/transfers/{id}/approve",
    description: "Record a reviewer decision; separate-user approval is enforced."
  },
  {
    method: "GET",
    path: "/v1/webhook-deliveries",
    description: "Inspect delivery attempts; retry a failed delivery."
  }
];

export const codeSamples = {
  request: `curl -X POST http://localhost:18080/v1/collections \\
  -H "Authorization: Bearer $AEGIS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{
    "amount": 4200,
    "currency": "RWF",
    "reference": "COL-2048",
    "description": "Order 2048"
  }'`,
  response: `{
  "id": "col_8f3a71c2d904",
  "status": "pending",
  "amount": 4200,
  "currency": "RWF",
  "reference": "COL-2048",
  "created_at": "2026-11-03T08:42:00Z"
}`,
  envelope: `POST /your-endpoint
Content-Type: application/json
X-AegisPay-Event-ID: evt_2f8c…
X-AegisPay-Timestamp: 1793729460
X-AegisPay-Signature: v1=6f1c…

{
  "id": "evt_2f8c…",
  "type": "collection.succeeded",
  "created_at": "2026-11-03T10:44:02Z",
  "data": { "collection_id": "col_8f3a…", "amount": 420000 }
}`
};

export const stockPhotos = {
  operator: "/images/operations-record.jpg",
  finance: "/images/finance-review.jpg"
};
