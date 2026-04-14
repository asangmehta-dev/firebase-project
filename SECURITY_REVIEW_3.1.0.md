# Security Review — Deployment Portal
**Version:** v3.1.0
**Date:** 2026-04-13
**Primary URL:** https://deployment-portal-instrumental.web.app/ (Firebase Hosting — no IAP)
**Legacy URL:** https://deployment-portal-901459055521.us-central1.run.app/ (Cloud Run + Google IAP)
**Stack:** React 18 + Firebase Realtime Database + Firebase Hosting + Firebase Cloud Functions + Google OAuth + HubSpot CRM API

---

## What Changed in v3.1.0 (Security-Relevant)

| Change | Security Impact |
|--------|----------------|
| `appState/projects` restructured from array to object keyed by project ID | Enables per-project database rules that were impossible on array shape |
| Per-project read rules on `appState/projects/$pid` and `appState/docData/$pid` | External users can now only read data for projects they're explicitly assigned to (was: any authenticated user could read all data via direct Firebase API) |
| New `access/{projectId}/{userId}: true` map maintained by app, checked in DB rules | Provides rule-level source of truth for which users can read which projects |
| Per-project DB listeners for external users | Enforced read scope — listeners request only assigned projects, and would be blocked by rules even if tampered with |
| UI access control hardened — sidebar dropdown filters by `user.projects` with active-only restriction; view-level gates verify current project in user's allowed list | Defense in depth — prevents accidental navigation to unauthorized projects even if state is manipulated |
| `docData` write rule widened from admin-only to admin+Instrumental | Aligns DB rules with v3.0.0-era app behavior where Instrumental users edit docs; closes the prior gap where the app UI attempted writes that the rules would have blocked |
| New `appState/demandCustomTypes` node with admin+Instrumental read/write | New attack surface — locked to trusted roles |
| `_schemaVersion` and `_backup/` nodes introduced to support migration | Admin-only write; backup node admin-only read/write |
| Cloud Function `runSync` writes projects as object-keyed, and sets `_schemaVersion: v3.1.0` | Keeps DB shape consistent with app-side migration |

---

## Deployment Architecture Overview

Unchanged from v3.0.0 — see [SECURITY_REVIEW_3.0.0.md](SECURITY_REVIEW_3.0.0.md) § "Deployment Architecture Overview".

---

## 1. Authentication

Unchanged from v3.0.0.

---

## 2. Authorization (SIGNIFICANTLY STRENGTHENED)

| Item | v3.0.0 Status | v3.1.0 Status |
|------|--------------|--------------|
| Firebase Database rules | ✅ Strong baseline | ✅ **Strengthened** — per-project read enforcement |
| `appState/projects` read | ❌ Any authenticated user could read all projects | ✅ Admin/Instrumental read parent; external users can only read `$pid` nodes in `access/` |
| `appState/projects` write | ✅ Admin only | ✅ Admin only (unchanged) |
| `appState/docData` read | ❌ Any authenticated user could read all doc data | ✅ Admin/Instrumental read parent; external users can only read `$pid` nodes in `access/` |
| `appState/docData` write | ⚠️ Admin only (but app attempted Instrumental writes) | ✅ Admin + Instrumental (rule-app alignment fixed) |
| `users/` node | ✅ Restricted | ✅ Restricted (unchanged) |
| `pendingUsers/` node | ✅ Admin read only | ✅ Admin read only (unchanged) |
| `hubspotSync/status` | ⚠️ Flagged in v3.0.0 review as needing lockdown | ✅ Client read-only (`.write: false`); Cloud Functions write via admin SDK |
| `hubspotPreview/` | ⚠️ Flagged in v3.0.0 review as needing admin-only | ✅ Admin read only (`.write: false`); Cloud Functions write via admin SDK |
| `access/` map (new) | N/A | ✅ Read to all auth users (for rule self-references); write admin-only |
| `_schemaVersion` (new) | N/A | ✅ Read to all auth; admin write only |
| `_backup/` (new) | N/A | ✅ Admin read + write only |
| `appState/demandCustomTypes` (new) | N/A | ✅ Admin + Instrumental read/write |
| Cloud Function `manualHubspotSync` admin check | ✅ | ✅ (unchanged) |
| Cloud Function `applyChecklistTemplate` admin check | ✅ | ✅ (unchanged) |
| Party-level read isolation at DB level | ❌ Not enforced | ✅ **Enforced** — external users cannot bypass UI to read other parties' data from projects they're not assigned to |
| UI project-level access gate on views | ⚠️ Partial | ✅ Dashboard and Docs views verify `project.id` is in user's allowed list |

### How per-project rules work
Firebase Realtime Database rules:
```json
"appState/projects/$pid": {
  ".read": "auth != null && (isAdmin || isInstrumental || hasAccess)"
}
```
where `hasAccess` = `root.child('access').child($pid).hasChild(auth.uid)`.

The `access/` map is maintained by the app:
- When an admin approves a pending user → writes `access/{pid}/{uid}: true` for each assigned project
- When an admin adds a project to a user → writes `access/{pid}/{uid}: true`
- When an admin removes a project from a user → writes `access/{pid}/{uid}: null`
- When a user is removed → cleans up all their entries in `access/`
- Admin/Instrumental users are never added to the map (they have blanket access via parent rules)

### Migration safety
- Runs once per database, gated by `_schemaVersion === "v3.1.0"`
- Triggered only by admin login (externals can't trigger it even if tampered)
- Pre-migration state backed up to `_backup/pre_v3_1_0_projects`
- Migration is idempotent — safe to re-run if interrupted

**Residual risk (acknowledged):** Between the moment v3.1.0 is deployed and the first admin login triggering the migration, external users who load the app will see an empty project list (their per-`$pid` listeners will return null against the legacy array-shaped data). This is a temporary degradation, not a security hole — in fact it's fail-safe (default deny).

---

## 3. HubSpot API Token Security

**Action required before deploying v3.1.0:** The HubSpot Private App token must still be rotated (flagged in v3.0.0 review). User has indicated a rotated token will be provided before deployment. Do not deploy v3.1.0 until the new token is in place and set via:
```bash
firebase functions:config:set hubspot.token="pat-na2-NEWTOKEN"
```

All other HubSpot token protections from v3.0.0 remain unchanged.

---

## 4. Network & Transport Security

Unchanged from v3.0.0.

---

## 5. Firebase API Key Exposure

Unchanged from v3.0.0 — API key restriction in Google Cloud Console is still recommended but not yet applied. Restrict to:
```
https://deployment-portal-instrumental.web.app/*
https://deployment-portal-901459055521.us-central1.run.app/*
```

---

## 6. Input Validation & XSS

Unchanged from v3.0.0.

---

## 7. Data Integrity

| Item | v3.1.0 Status |
|------|--------------|
| Schema validation on `users/` | ✅ Unchanged |
| Schema validation on `docData/` | ❌ Still no server-side schema |
| HubSpot sync idempotency | ✅ Unchanged |
| Checklist template idempotency | ✅ Unchanged |
| **Migration backup** (new) | ✅ Pre-v3.1.0 array-shape state saved to `_backup/pre_v3_1_0_projects` before migration |
| Audit log | ❌ Still not present |

---

## 8. Account & Session Management

Unchanged from v3.0.0.

---

## 9. Cloud Functions Security

| Item | v3.1.0 Status |
|------|--------------|
| `scheduledHubspotSync` | ✅ Unchanged — writes projects in new object-keyed format |
| `manualHubspotSync` | ✅ Unchanged — auth + admin check |
| `applyChecklistTemplate` | ✅ Unchanged — auth + admin check |
| Rate limiting | ⚠️ Still none |

---

## 10. Summary of Risks (Priority Order)

| Priority | Issue | v3.1.0 Status | Recommendation |
|----------|-------|---------------|---------------|
| 🔴 Critical | HubSpot token was shared in a chat session | **Still open** | Rotate before deploying v3.1.0 |
| 🔴 High | Login page publicly reachable (no IAP on primary URL) | Unchanged — architectural | Use Cloud Run + IAP for users requiring infra-level protection |
| 🔴 High | `hubspotPreview/` and `hubspotSync/status` not locked in DB rules | ✅ **Resolved in v3.1.0** | — |
| 🟡 Medium | All approved users could read ALL project data | ✅ **Resolved in v3.1.0** (per-project rules + access map) | — |
| 🟡 Medium | Firebase API key unrestricted | Still open | Restrict to both live domains in Google Cloud Console |
| 🟡 Medium | No audit log | Still open | Enable Firebase backups; optionally log writes via Cloud Functions |
| 🟡 Medium | Token revocation not immediate | Unchanged | Disable accounts in Firebase Auth when removing access |
| 🟡 Medium | Instrumental users can write docData | Accepted — now properly reflected in rules (was app/rule drift in v3.0.0) | — |
| 🟢 Low | Milestone/doc link URLs not validated | Still open | Add `https://` prefix check before saving |
| 🟢 Low | Pending user queue not monitored | Still open | Set up admin notification when new users request access |
| 🟢 Low | Migration window (first external users see empty state until admin logs in) | Acknowledged, fail-safe | Admin should open the app immediately after v3.1.0 deploy |

---

## 11. Testing Recommendations for Internal Security Review

For the internal security review the user has planned, we recommend the reviewer verify the following **by direct database access** (not just UI):

1. **External user cannot read other projects:** Sign in as a Customer user assigned to Project A. Attempt to read `appState/projects/{projectB_id}` via the Firebase console or REST API. Expected result: permission denied.

2. **External user cannot read other projects' docData:** Same as above for `appState/docData/{projectB_id}`. Expected: permission denied.

3. **External user cannot write to appState:** Attempt `appState/projects` write. Expected: permission denied.

4. **Admin can still read/write everything** including `hubspotPreview` and `_backup/`.

5. **Non-admin Instrumental user can read all projects** but cannot write to `appState/projects` (admin-only).

6. **Un-assigning a project removes access:** Admin un-assigns Project A from Customer user; user's next read of Project A fails with permission denied.

7. **Removed user loses access map entries:** Admin removes a user; the `access/{pid}/{uid}` entries for that user are cleaned up.

8. **Migration backup exists:** Confirm `_backup/pre_v3_1_0_projects` is present after first admin login post-deploy.

---

## 12. Out of Scope

Same as v3.0.0 plus:
- Firebase App Check (still not implemented — would prevent API key abuse from unauthorized client apps)
- Per-field audit logging (still not implemented)
- Rate limiting on Cloud Functions
- Compromise-detection or anomaly alerting
