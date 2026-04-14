# Security Review — Deployment Portal
**Version:** v3.0.0
**Date:** 2026-04-10
**Primary URL:** https://deployment-portal-instrumental.web.app/ (Firebase Hosting — no IAP)
**Legacy URL:** https://deployment-portal-901459055521.us-central1.run.app/ (Cloud Run + Google IAP)
**Stack:** React 18 + Firebase Realtime Database + Firebase Hosting + Firebase Cloud Functions + Google OAuth + HubSpot CRM API

---

## What Changed in v3.0.0 (Security-Relevant)

| Change | Security Impact |
|--------|----------------|
| Firebase Cloud Functions added (HubSpot sync) | New attack surface — callable functions protected by Firebase Auth admin check |
| HubSpot Private App token stored in Functions config | **Not** in client bundle or source code — only accessible to Cloud Functions at runtime |
| Instrumental users can now edit (not admin-only) | Expanded write surface — all @instrumental.com users can now modify checklists/docs |
| `hubspotPreview/` and `hubspotSync/status` Firebase nodes added | New DB paths — should be locked to admin-only in database rules |

---

## Deployment Architecture Overview

| | Firebase Hosting (Primary) | Cloud Run (Legacy) |
|---|---|---|
| **URL** | `deployment-portal-instrumental.web.app` | `deployment-portal-901459055521.us-central1.run.app` |
| **IAP** | ❌ None | ✅ Google Identity-Aware Proxy |
| **Access gate** | Login page publicly reachable | Blocked at infra level before page loads |
| **Data backend** | Firebase Realtime Database (shared) | Firebase Realtime Database (shared) |
| **Functions** | Firebase Cloud Functions (Node 18, us-central1) | Same — Cloud Functions are project-scoped |
| **Status** | Active — primary URL | Active — legacy, higher security |

> **Key posture:** The primary URL has no infrastructure-level gate (IAP). Access is controlled entirely by Firebase Auth + Google OAuth + admin approval. The Cloud Run URL retains full IAP protection and is suitable for users requiring infra-level blocking.

---

## 1. Authentication

| Item | Status | Notes |
|------|--------|-------|
| Google OAuth (Sign in with Google) | ✅ Enforced | All users must authenticate via Google before accessing any data |
| @instrumental.com auto-approve | ✅ Implemented | These users are auto-created as `partyId: instrumental, role: user` — admin must be explicitly granted by SuperAdmin |
| Non-instrumental users require approval | ✅ Implemented | New users land in `pendingUsers/` and must be manually approved by an admin |
| Authorized domains | ✅ Configured | Firebase Auth authorized domains includes both live URLs |
| OAuth redirect URIs | ✅ Configured | `/__/auth/handler` registered for Firebase Hosting domain |

**Risk:** Anyone with a Google account can attempt sign-in via the Firebase Hosting URL and land in the pending queue. Admin must actively approve or deny. The Cloud Run URL blocks before login via IAP.

---

## 2. Authorization

| Item | Status | Notes |
|------|--------|-------|
| Firebase Database rules | ✅ Strong baseline | Server-side rules deny all by default; admin-only writes enforced |
| `appState/docData` | ✅ Instrumental + admin write | Editable by `isInst` users (partyId: instrumental or role: admin) |
| `appState/projects` | ✅ Admin write only | Only `role === 'admin'` in DB rules |
| `users/` node | ✅ Restricted | Only the user themselves or an admin can write |
| `pendingUsers/` node | ✅ Admin read only | Only admins can view pending queue |
| `hubspotSync/status` | ⚠️ Should be admin-only write | Cloud Function writes here; clients should be read-only |
| `hubspotPreview/` | ⚠️ Should be admin-only read/write | Contains preview of unconfirmed HubSpot data |
| Cloud Function — `manualHubspotSync` | ✅ Auth + admin check | Function verifies `auth.token.role === 'admin'` or `superAdmin === true` before running |
| Cloud Function — `applyChecklistTemplate` | ✅ Auth + admin check | Same admin check |
| Client-side role checks | ⚠️ Supplementary only | UI hides controls for non-admins, but enforcement is at DB rules + Functions level |
| Party-level read isolation | ❌ Not enforced at DB level | Any approved user can read all project/party data in Firebase |

**Action required:** Add rules to `database.rules.json` for the new nodes:
```json
"hubspotSync": { ".read": "auth != null", ".write": false },
"hubspotPreview": { ".read": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'", ".write": false }
```

**Risk (unchanged from v2.x):** Any approved user can read all project data regardless of assigned party. Acceptable if all approved users are trusted, but not suitable if customers/CMs should be siloed.

---

## 3. HubSpot API Token Security

| Item | Status | Notes |
|------|--------|-------|
| Token storage location | ✅ Firebase Functions config | `functions.config().hubspot.token` — never in source code or client bundle |
| Token in client bundle | ✅ Not present | The React app never receives or stores the HubSpot token |
| Token in source control | ✅ Not committed | Set via CLI: `firebase functions:config:set hubspot.token="..."` |
| Token rotation | ⚠️ Recommended | The token was shared in a chat session — rotate it in HubSpot before deploying |
| Token scope | ✅ Minimal | Read-only CRM scopes: `crm.objects.custom.read`, `crm.schemas.custom.read` |
| HubSpot Private App | ✅ Scoped | Created as a Private App with only necessary scopes — no OAuth flow |

**Action required before deploying:** Rotate the HubSpot Private App token in HubSpot → Settings → Integrations → Private Apps. The old token (`pat-na2-23f85bfa-...`) was shared in a chat session and should be considered potentially compromised. Generate a new token and set it:
```bash
firebase functions:config:set hubspot.token="pat-na2-NEWTOKEN"
```

---

## 4. Network & Transport Security

| Item | Status | Notes |
|------|--------|-------|
| HTTPS on Firebase Hosting | ✅ Enforced | Firebase Hosting serves exclusively over HTTPS |
| HTTPS on Cloud Run | ✅ Enforced | Google-managed TLS |
| Firebase SDK connections | ✅ Secure | All Realtime Database connections use WSS (WebSocket Secure) |
| Cloud Functions HTTPS | ✅ Secure | Callable functions served over HTTPS by Firebase |
| HubSpot API calls | ✅ Secure | All calls from Cloud Functions are outbound HTTPS to `api.hubapi.com` |
| IAP on Firebase Hosting | ❌ Removed | Firebase Hosting does not support Google Cloud IAP |
| IAP on Cloud Run | ✅ Active | Legacy URL retains full IAP protection |

---

## 5. Firebase API Key Exposure

Firebase config (API key, project ID, etc.) is embedded in the client bundle — this is **expected and normal** for Firebase web apps. The key identifies the project but does not grant access by itself. Enforcement is via Firebase Auth + Database rules.

**Action required:** Restrict the API key in Google Cloud Console → APIs & Services → Credentials → HTTP referrer restrictions:
```
https://deployment-portal-instrumental.web.app/*
https://deployment-portal-901459055521.us-central1.run.app/*
```

---

## 6. Input Validation & XSS

| Item | Status | Notes |
|------|--------|-------|
| `dangerouslySetInnerHTML` | ✅ Not used | No raw HTML injection in App.jsx |
| User-supplied text | ✅ Safe | React escapes all string values by default |
| HubSpot data rendered | ✅ Safe | Project names/customer fields from HubSpot are rendered as text, not HTML |
| Link URLs | ⚠️ Review | Admin-entered URLs rendered as `<a href>` — no protocol validation |
| HubSpot sync data | ✅ Sanitized in Cloud Function | `mapHubspotToProject` strips to known fields only before writing to DB |

**Recommendation:** Add `https://` prefix validation before saving milestone/document link URLs to prevent `javascript:` protocol injection.

---

## 7. Data Integrity

| Item | Status | Notes |
|------|--------|-------|
| Schema validation on `users/` | ✅ Partial | DB rules require `id, name, email, role, partyId` |
| Schema validation on `docData/` | ❌ None | No server-side schema enforcement |
| HubSpot sync idempotency | ✅ Yes | `runSync` merges by project ID — re-running does not duplicate projects |
| Checklist template idempotency | ✅ Yes | `applyChecklistToProject` skips if template already applied |
| Audit log | ❌ Not present | No record of who changed what |

**Recommendation:** Enable Firebase Realtime Database scheduled exports (Firebase Console → Realtime Database → Backups) for point-in-time recovery.

---

## 8. Account & Session Management

| Item | Status | Notes |
|------|--------|-------|
| Session persistence | ✅ Firebase default | Sessions persist until sign-out or token expiry |
| Remember me (72h) | ✅ Implemented | Opt-in; defaults to session-only |
| Sign out | ✅ Available | Accessible from sidebar in all views |
| Token revocation on role change | ⚠️ Delayed | Removed users retain active session until next token refresh (~1 hour) |

**Recommendation:** When removing a user, also disable their account in Firebase Console → Authentication to immediately invalidate their token.

---

## 9. Cloud Functions Security

| Item | Status | Notes |
|------|--------|-------|
| `scheduledHubspotSync` | ✅ No user input | Triggered by Firebase scheduler only — no external HTTP surface |
| `manualHubspotSync` | ✅ Auth required | Firebase checks `auth` context; function additionally verifies admin role |
| `applyChecklistTemplate` | ✅ Auth required | Same admin check |
| HubSpot token in environment | ✅ Functions config | Not in source code or client |
| Rate limiting on callable functions | ⚠️ None | No explicit rate limit — Firebase callable functions have a default 1M invocations/month free tier |
| Function region | ✅ us-central1 | Consistent with Firebase project region |

---

## 10. Summary of Risks (Priority Order)

| Priority | Issue | Recommendation |
|----------|-------|---------------|
| 🔴 Critical | HubSpot token was shared in a chat session | **Rotate the token immediately before deploying** |
| 🔴 High | Login page publicly reachable (no IAP on primary URL) | Use Cloud Run + IAP for users requiring infra-level protection |
| 🔴 High | `hubspotPreview/` and `hubspotSync/status` not locked in DB rules | Add rules before deploying functions |
| 🟡 Medium | All approved users can read ALL project data | Add per-project read rules in `database.rules.json` |
| 🟡 Medium | Firebase API key unrestricted | Restrict to both live domains in Google Cloud Console |
| 🟡 Medium | No audit log | Enable Firebase backups; optionally log writes via Cloud Functions |
| 🟡 Medium | Token revocation not immediate | Disable accounts in Firebase Auth when removing access |
| 🟡 Medium | Instrumental users (non-admin) can now write docData | Previously admin-only — acceptable if all Instrumental users are trusted |
| 🟢 Low | Milestone/doc link URLs not validated | Add `https://` prefix check before saving |
| 🟢 Low | Pending user queue not monitored | Set up admin notification when new users request access |

---

## 11. Deployment-Specific Notes

### Firebase Hosting URL (primary — lower security tier)
- No IAP. Login screen is publicly reachable.
- Relies entirely on Firebase Auth + Google OAuth + admin approval.
- Suitable for general use where all stakeholders are known and trusted.

### Cloud Run URL (legacy — higher security tier)
- Protected by Google IAP. Unauthorized users see a Google 403 before the app loads.
- Shares the same Firebase database.
- Use for contexts requiring infrastructure-level access control.

### Cloud Functions
- Deployed to Firebase (Blaze plan required for external API calls — HubSpot).
- HubSpot token stored in Firebase Functions config, never in code.
- Scheduled sync runs automatically — no admin action required after deploy.

---

## 12. Out of Scope

- Penetration testing / dynamic analysis
- Google Cloud project IAM permissions (Firebase Console / Cloud Run access)
- Supply chain security (`npm audit` for dependency vulnerabilities)
- Firebase App Check (not yet implemented — would prevent unauthorized API key usage)
- HubSpot account security (separate from this app)
