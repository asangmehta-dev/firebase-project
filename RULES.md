# Deployment Portal — Agentic Rules

Rules evaluated by `scheduledMaintenance` every Tuesday and Friday at 3 PM PT (1 hour before the HubSpot sync).

Each rule has: **Trigger**, **Condition**, **Action**, **Added**.

---

## Rule 1 — Bug count threshold

- **Trigger:** Every maintenance run
- **Condition:** More than 2 entries in `bugs/log` with `status === "open"`
- **Action:** Write alert to `maintenance/alerts/bugCount`; surface in Admin Panel → Maintenance tab
- **Added:** v4.1.0

## Rule 2 — Sync error rate

- **Trigger:** Every maintenance run
- **Condition:** More than 10% of HubSpot syncs in the last 24 hours have `state === "error"`
- **Action:** Write alert to `maintenance/alerts/syncErrorRate` recommending sync pause
- **Added:** v4.1.0

## Rule 3 — Sync failure circuit breaker

- **Trigger:** Every maintenance run
- **Condition:** The 3 most recent *scheduled* syncs all have `state === "error"`
- **Action:** Auto-set `hubspotSync/paused: true`; write critical alert to `maintenance/alerts/circuitBreaker`. Admin must manually re-enable sync in Admin Panel → HubSpot Sync.
- **Added:** v4.1.0

---

## Logging bugs programmatically

Write to `bugs/log/{pushId}`:

```json
{
  "version": "4.1.0",
  "summary": "Short description of the bug",
  "openedAt": "2026-04-30T00:00:00.000Z",
  "status": "open"
}
```

Set `status` to `"resolved"` (or delete the entry) when fixed. Rule 1 counts only `"open"` entries.

The human-readable narrative log lives in `memory/bugs_and_known_issues.md`.
