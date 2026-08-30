# Pre-Analysis Engine — asynchronous write-back

## Why this exists

`/pae/analyze` used to answer synchronously with the verdict in the HTTP
response body. Measured response times: **38.3s, 27.5s, 37.7s, 29.2s**.

GHL's custom-webhook action times out long before that. So
`custom_webhook.1.response.verdict` was always empty, PAE-W2's router matched
nothing, and every deal fell to the None catch-all. The branches were never
miswired — they were unreachable.

Verified end to end with four real payloads: all four returned webhook 200, all
four landed UNROUTED, and the note GHL wrote rendered `Verdict:` and
`Pipeline route:` as **blanks**. To a human skimming the card that looks fine.
That silent-blank failure is the class of defect this project exists to
eliminate, so the redesign treats *making failure visible* as a requirement, not
a nicety.

## The endpoint contract

`POST /pae/analyze`

**Auth:** `x-pae-secret` header, matched against `PAE_WEBHOOK_SECRET`.

**Required:** `opportunity_id` — a resolved GHL opportunity id. This is where the
result gets written. In PAE-W2 it is `{{opportunity.id}}`, which only resolves
once an opportunity has been created earlier in the workflow. An unresolved
merge token (`{{opportunity.id}}` arriving verbatim) is rejected, not accepted.

**Everything else** is deal data. The canonical set covers every field the
system prompt's Section 1 table names; anything else you send is carried through
as an extra (bounded at 60 extra fields, 2000 chars each) rather than dropped.

### Response — 200, in under a second, with no verdict

```json
{
  "status": "accepted",
  "request_id": "PAE-20260830-172943-ef53d086",
  "opportunity_id": "hBkHHNxqu3owNKXjgoTe",
  "accepted_at": "2026-08-30T17:29:43.181Z",
  "estimated_completion_seconds": 60,
  "result_fields": { "status": "paew2_status", "verdict": "paew2_verdict", "…": "…" },
  "financial_fields_present": ["asking_price", "annual_noi", "cap_rate"],
  "extra_fields_forwarded": [],
  "dropped_fields": [],
  "note": "Analysis runs asynchronously. …",
  "error": false
}
```

The response deliberately carries **no verdict and no pipeline_route**. Nothing
downstream may branch on it. 200 rather than 202 because GHL's custom-webhook
action treats a status it does not recognise as a failed step.

### Failure responses (all synchronous, all non-2xx so GHL flags the step)

| Status | `error_type` | Cause |
|---|---|---|
| 401 | `UNAUTHORIZED` | wrong or missing `x-pae-secret` |
| 400 | `VALIDATION_ERROR` | missing / unresolved `opportunity_id` |
| 500 | `CONFIG_ERROR` | no `ANTHROPIC_API_KEY`, or no `GHL_API_KEY`/`GHL_LOCATION_ID` |

The last one matters: without GHL credentials the result would have nowhere to
go, so the request is refused rather than accepted and silently dropped.

## Opportunity custom fields

Model: `opportunity`. Location `T0EYPXXzbxqjVy81nxnW`. Prefix `paew2_`, chosen
to avoid the prefixes already in use (`paew0_`, `paebp_`, `buyer_`, `buy_box_`).

Field IDs are resolved at runtime from `fieldKey`, not hardcoded, so recreating
a field in GHL does not silently break the write-back.

| Field key | GHL id | Type | Written |
|---|---|---|---|
| `paew2_status` | `BqtpGvygZRSdG153MUQQ` | TEXT | QUEUED by W2, then ANALYZING / COMPLETE / FAILED by the server |
| `paew2_verdict` | `mr8amrnczRmsDPbP9z0E` | TEXT | PROCEED \| WHOLESALE \| REVIEW \| PASS |
| `paew2_composite_score` | `32vRbfHzhtYDPsyKU4os` | NUMERICAL | sovereign composite score |
| `paew2_pipeline_route` | `WN3d2tSJYnXzzqc0haj2` | TEXT | mirrors the verdict; UNROUTED for anything unrecognised |
| `paew2_reasoning` | `Bis3dozgy9K2woBuGuNW` | LARGE_TEXT | verdict reasoning |
| `paew2_key_risks` | `HAMdLbRXwF34pSa55uWT` | LARGE_TEXT | pipe-joined risk list |
| `paew2_data_completeness` | `x1fLsUvOixnaTqVtkQFK` | NUMERICAL | percent of fields populated |
| `paew2_analysis_timestamp` | `NYoSdSUG9O8gtVOnH5s0` | TEXT | ISO 8601 |
| `paew2_request_id` | `CdXWhmWlkilYkZjVWrUu` | TEXT | ties the card to a run and to the acknowledgement |
| `paew2_error` | `EwUrys6gHRGr1x0uSLFG` | LARGE_TEXT | populated only on FAILED |

## Making failure visible

The whole point. `paew2_status` is a state machine, and **an unwritten verdict
and a genuine PASS are never the same state**:

| `paew2_status` | Means |
|---|---|
| *(empty)* | PAE-W2 never even stamped the card — the workflow died before the webhook step |
| `QUEUED` | W2 stamped it, but `/pae/analyze` was never reached (network, auth, or the endpoint refused) |
| `ANALYZING` | The endpoint accepted the work and it never finished — the run died mid-analysis |
| `FAILED` | The run ended in a handled error. `paew2_error` says which |
| `COMPLETE` | A verdict was written. **Only in this state is `paew2_verdict` trustworthy** — including when it reads PASS |

`QUEUED` is written by GHL itself, not by the server, which is what separates
"the server never heard about this deal" from "the server heard and then died".

A genuine PASS therefore carries `status = COMPLETE, verdict = PASS` and lands
in its own workflow branch with source `Pre-Analysis Engine — PASS`. An analysis
that never landed carries no verdict, falls to the None branch, gets source
`Pre-Analysis Engine — UNROUTED`, and **notifies Steven** with a subject that
says ANALYSIS DID NOT COMPLETE and a note that spells out what the status value
means. The one failure that cannot be made visible in GHL — the opportunity not
being writable at all — is logged as an error and leaves the card on QUEUED,
which the None branch still catches.

## PAE-W2 structure (workflow `d2a02519-bc49-4f5b-bd04-4a1b77182a71`, v14)

Defined in [`scripts/pae-w2-workflow.mjs`](../scripts/pae-w2-workflow.mjs).

```
inbound_webhook trigger
  └─ Create/Update Contact
     └─ PAE — Create Deal Record            internal_create_opportunity
     │                                      pipeline 82R6U3R253VjBuEA8OY0
     │                                      stage REVIEW, source "… — PENDING"
     └─ PAE — Mark Analysis Queued          paew2_status = QUEUED
     └─ PAE Analyze                         POST /pae/analyze, 45-key body
     └─ Wait 5 Minutes for Analysis
     └─ Verdict Router                      if_else on opportunity.paew2_verdict
        ├─ PROCEED    == "PROCEED"    → stage da53850d-96a3-4781-b672-0898e14867a2
        ├─ WHOLESALE  == "WHOLESALE"  → stage ea47f1e4-ed55-441f-b071-bfc32baf5798
        ├─ REVIEW     == "REVIEW"     → stage 1a528963-698f-403f-abfe-411542a710b9
        ├─ PASS       == "PASS"       → REVIEW stage, source "… — PASS", NO notification
        └─ None       (else)          → REVIEW stage, source "… — UNROUTED", NOTIFIES
```

The opportunity moves up front so it exists when the webhook fires; each branch
then moves it to its stage with `internal_update_opportunity` rather than
creating a second card.

`allowMultipleOpportunity` is now **true** on this workflow. With it false a
`create_opportunity` action updates the contact's existing card instead of
creating one — which is why four test submissions from one bird-dog all wrote to
the same opportunity record, each silently renaming the last.

PASS gets no notification, per the engine's Section 7 rule 6 ("PASS is silent").
It still gets a card and a note, because the card already exists by then.

## The deal payload

The handler used to project `req.body` onto a fixed 20-key allowlist and discard
everything else without a word. Real deals carry `annual_noi`, `cap_rate`,
`mortgage_balance`, `property_taxes`, `insurance_estimate`, `occupancy_rate`,
`revenue_current`, `operating_expenses`, `monthly_rent_actual`,
`seller_equity_pct`, `condition` and `financing_terms` — every one of them
dropped. Crazy Horse missed PROCEED at 62 while naming exactly those in its own
`missing_fields`, on a property with five years of P&Ls on file.

Now: canonical fields always render (as `MISSING` when absent), legacy aliases
fill their canonical targets without overwriting anything the caller sent
directly, and unknown fields pass through.

| Alias sent by older callers | Fills |
|---|---|
| `arv` | `estimated_value` |
| `repair_estimate` | `rehab_estimate` |
| `purchase_price` | `asking_price` |
| `motivation_level` | `seller_motivation` |
| `submitter_name` | `submitter` |
| `notes` | `additional_notes` |
| `market` | `geography` |

### The five-financial-fields gate

Section 1 of the prompt refuses PROCEED or WHOLESALE when fewer than 5 of ten
financial fields are present. Under the old allowlist only `asking_price`
survived, so the gate was **unsatisfiable no matter how complete the
submission**. All ten now survive, and the engine counts them itself and states
the answer in the user message:

```
ENGINE-COMPUTED DATA COMPLETENESS (authoritative …):
  financial_fields_present (6 of 10): asking_price, estimated_value, annual_noi, …
  financial_gate_satisfied: true
```

The prompt tells the model to use those numbers rather than re-count, so the
gate is deterministic and auditable instead of re-derived per run.

## Verifying a deploy

`/health` reports the commit the running build came from. Do not assume a push
deployed:

```bash
git rev-parse HEAD
curl -s https://ghlmcp.real-solutions-llc.com/health | grep -o '"commit":"[^"]*"'
```

`commit_source` should read `RAILWAY_GIT_COMMIT_SHA` in production.
