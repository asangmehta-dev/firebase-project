# Security Review: Deployment Portal v3.2.0

**Date:** 2026-04-16
**Reviewer:** Internal Security Review
**Stack:** React 18 + Firebase Realtime Database + Firebase Hosting + Firebase Cloud Functions + Google OAuth + HubSpot CRM API
**Primary URL:** https://deployment-portal-instrumental.web.app/
**Legacy URL:** https://deployment-portal-901459055521.us-central1.run.app/

---

## What Changed in v3.2.0 (Security-Relevant)

| Area | v3.1.0 | v3.2.0 | Impact |
|------|--------|--------|--------|
| Access model | 4-party system (partyId-based) | 3-role system: admin, instrumental, external | Simplifies authorization; removes partyId as attack surface |
| Commercial tab access | Controlled by party membership | Explicit `commercialAccess/{projectId}/{userId}` map, admin-only write | Tighter least-privilege; even Instrumental staff need explicit grant |
| Document structure | `docData/{pid}/{party}` | `docData/{pid}/projectDetails` and `docData/{pid}/commercial` | Data segregation between general and sensitive commercial data |
| External user onboarding | Required partyId assignment | Auto-classified as "external" on approval | Reduces admin error; no orphaned partyId grants |
| Training data | Not present | `docData/{pid}/_training` with belt assignments | New node; must be covered by DB rules |
| HubSpot token storage | `functions/.env` (migrated from functions.config()) | No change from v3.1.0 | Token remains server-side only |
| DB rules (access/) | Per-project read via `access/` map | Unchanged; still enforced | Foundation of read authorization intact |
| Schema/backup guards | `_schemaVersion`, `_backup` locked | Unchanged | Integrity controls remain |

---

## Authorization Matrix

| Resource | Admin | Instrumental (non-admin) | External | Unauthenticated |
|----------|-------|--------------------------|----------|-----------------|
| Read project list | Yes | Own projects (via access/) | Own projects (via access/) | No |
| Read projectDetails | Yes | If in access/ map | If in access/ map | No |
| Read commercial data | Yes | If in access/ AND commercialAccess/ | If in access/ AND commercialAccess/ | No |
| Write commercialAccess/ | Yes | No | No | No |
| Write docData/ | Yes | Own project fields only | Own project fields only | No |
| Read/write _training | Yes | If in access/ map | If in access/ map | No |
| hubspotSync (Cloud Function) | Yes (server trigger) | No | No | No |
| hubspotPreview (Cloud Function) | Yes | No | No | No |
| Manage users / approve access | Yes | No | No | No |
| Write _schemaVersion, _backup | No (system only) | No | No | No |

---

## Summary of Risks (Priority Order)

### 1. Firebase API Key Restriction (HIGH — Carried Forward)

The Firebase API key embedded in the client bundle is currently unrestricted. While this key is designed to be public, an unrestricted key allows abuse of Firebase Auth and Realtime Database quotas by third parties. **Action required:** restrict the key in the Google Cloud Console to the two known domains and to only the Firebase APIs in use (Auth, RTDB, Hosting).

### 2. Commercial Access Bypass via Direct DB Path (MEDIUM)

The new `commercialAccess/` map is enforced by DB rules, but any misconfiguration (e.g., a wildcard rule at a parent node) could allow unauthorized reads of `docData/{pid}/commercial`. Verify that no `.read: true` rule exists at or above the `docData/` level, and that `commercial` children explicitly check `commercialAccess/{pid}/{auth.uid}`.

### 3. Training Data Node Permissions (MEDIUM)

The new `docData/{pid}/_training` node stores belt assignments. Confirm that:
- DB rules require `access/{pid}/{auth.uid}` for reads.
- Write rules restrict belt assignment changes to admins or authorized Instrumental users.
- Underscore-prefixed nodes are not inadvertently excluded by wildcard rules.

### 4. Role Determination Logic (MEDIUM)

Users are now classified as admin, instrumental (@instrumental.com), or external based on email domain and a server-side admin list. If role classification happens only on the client, it can be spoofed. Verify that DB rules independently check role (e.g., admin status from a DB node, @instrumental.com from `auth.token.email`) and do not trust client-supplied role claims.

### 5. HubSpot Token Exposure (LOW — Mitigated)

The HubSpot token was rotated for v3.1.0 and remains in `functions/.env`, which is gitignored and deployed only via `firebase deploy --only functions`. Risk is low as long as `.env` never enters version control and the token is scoped to the minimum required HubSpot permissions.

### 6. Legacy URL Still Active (LOW)

The Cloud Run URL (`deployment-portal-901459055521.us-central1.run.app`) may still resolve. If it points to an older build, it could serve code without v3.2.0 security controls. Confirm whether this URL should be decommissioned or redirected.

### 7. Stale Party References in Database (LOW)

Migration from 4-party to 3-role model may leave orphaned `partyId` entries in the database. These are inert if no rules reference them, but they add confusion during audits. Plan a cleanup pass.

---

## Testing Recommendations

### Authorization Tests

1. **commercialAccess enforcement** — As a non-admin Instrumental user without a commercialAccess grant, attempt to read `docData/{pid}/commercial` directly via the Firebase SDK or REST API. Expect: permission denied.
2. **commercialAccess grant restriction** — As a non-admin user, attempt to write to `commercialAccess/{pid}/{targetUid}`. Expect: permission denied.
3. **External user auto-classification** — Register a new external (non-@instrumental.com) user, get approved, and confirm the user is classified as external with no residual partyId.
4. **Training data isolation** — As a user without access to project X, attempt to read `docData/X/_training`. Expect: permission denied.
5. **Admin-only operations** — As a non-admin user, attempt hubspotSync, hubspotPreview, and user management actions. Expect: all denied.

### Database Rule Tests

6. **No open wildcards** — Export current DB rules and audit for any `.read: true` or `.write: true` at the root or `docData/` level.
7. **Schema and backup immutability** — Attempt to write to `_schemaVersion` and `_backup` as an admin. Expect: permission denied (system-only).
8. **Cross-project isolation** — As a user with access to project A but not project B, attempt reads and writes on project B paths. Expect: all denied.

### Infrastructure Tests

9. **API key restriction** — After restricting the Firebase API key, confirm the app still functions on both the primary and legacy URLs (if legacy is retained).
10. **HubSpot token audit** — Verify `functions/.env` is in `.gitignore`, confirm the token is not present in any client bundle (search dist/ output), and validate that the token has minimum required HubSpot scopes.
11. **Legacy URL** — Visit the Cloud Run URL and confirm it either returns the current build or is decommissioned.

---

## Out of Scope

The following items are acknowledged but not evaluated in this review:

- **Penetration testing** — This review covers architecture and configuration; no active exploitation was attempted.
- **Firebase Hosting CDN configuration** — Cache headers, CORS, and CDN edge behavior are not assessed.
- **Client-side dependency vulnerabilities** — npm audit / Snyk scanning of React and other frontend packages is not covered here.
- **HubSpot webhook security** — If HubSpot sends webhooks to Cloud Functions, signature verification is not evaluated in this review.
- **Rate limiting and DDoS protection** — Firebase's built-in protections apply, but custom rate limiting is not assessed.
- **Data retention and GDPR compliance** — Policies around data deletion, export, and user consent are outside this scope.
- **Mobile or offline access patterns** — Only browser-based access on the two listed URLs is considered.

---

*End of Security Review v3.2.0*
