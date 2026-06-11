# Deployment Portal — Security Review Response

**Version:** v4.0.0
**Date:** 2026-04-24
**Basis:** PMO Deployment Portal Security Review (7 findings)

This document maps each finding to the concrete mitigation shipped in v4.0.0.

---

## Finding 1 — Role / partyId / superAdmin writable from client

**Status:** ✅ Mitigated (originally Apr 22 hotfix in v3.1.0; retained in v4.0.0)

Field-level `.validate` rules in `database.rules.json`:

```jsonc
"role": {
  ".validate": "newData.val() === 'user' || newData.val() === 'admin' && root.child('users').child(auth.uid).child('role').val() === 'admin'"
},
"partyId": {
  ".validate": "newData.val() !== 'instrumental' || auth.token.email.matches(/.*@instrumental\\.com$/) || root.child('users').child(auth.uid).child('role').val() === 'admin'"
},
"superAdmin": {
  ".validate": "root.child('users').child(auth.uid).child('superAdmin').val() === true"
}
```

Additionally in v4.0.0, `users/$uid/.write` is admin-only (only `users/$uid/langPref` allows self-write). Role changes only happen via `adminSetRole` Cloud Function, which also writes an audit entry.

---

## Finding 2 — `users/` readable by any authenticated user

**Status:** ✅ Mitigated

v4.0.0 `database.rules.json`:

```jsonc
"users": {
  ".read": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'",
  "$uid": {
    ".read": "auth != null && ($uid === auth.uid || root.child('users').child(auth.uid).child('role').val() === 'admin')"
  }
}
```

Non-admin users now get permission-denied on the top-level `users/` path. The client (`App.jsx`) subscribes to `users/{user.id}` only for non-admin roles.

---

## Finding 3 — `access/` and `commercialAccess/` readable by any authed user

**Status:** ✅ Mitigated

Top-level `.read` is admin-only. Per-project reads are scoped:

```jsonc
"access": {
  ".read": "admin",
  "$pid": { ".read": "admin || data.child(auth.uid).val() === true" }
},
"commercialAccess": {
  ".read": "admin",
  "$pid": {
    "$uid": { ".read": "$uid === auth.uid || admin" }
  }
}
```

`App.jsx` subscribes to the most specific path per user role. Non-admins see only their own entry on their own projects.

---

## Finding 4 — Client-side first-user bootstrap

**Status:** ✅ Mitigated (bootstrap removed entirely)

The old flow let the first user to sign in write `appState/projects`, `_schemaVersion`, and `users/{own uid}` with `role: admin`. This was an attack surface if `users/` was ever cleared.

v4.0.0 changes:
- Client code removed — no more `isFirst` branch.
- DB rules: `users/$uid/.write` is admin-only. `appState/*` writes require admin (unchanged). `_schemaVersion/.write` is admin-only.
- First admin is **manually seeded** in the Firebase Console (see `PRE_DEPLOY_RUNBOOK_4.0.0.md`).

---

## Finding 5 — `@instrumental.com` auto-provisioning trusted to client

**Status:** ✅ Mitigated

`provisionUser` Cloud Function (`functions/index.js`) is now the single entry point:
- Idempotent: if user record exists, returns it.
- If `auth.token.email` ends in `@instrumental.com`: creates `users/{uid}` with `role: user`, `partyId: instrumental`.
- Otherwise: creates `pendingUsers/{uid}` entry.
- Every call writes to `auditLog/`.

Client never writes `users/{uid}` directly. DB rules enforce this.

---

## Finding 6 — URL fields accept `javascript:` / `data:` schemes

**Status:** ✅ Mitigated (code-level)

`commitUrl(raw)` helper in `App.jsx` validates:
- Empty string allowed (clears field).
- Must start with `https://` (case-insensitive).
- Rejects `javascript:`, `data:`, `vbscript:`, `file:`.
- Max length 2048 chars.

Applied at every URL-commit site: document items (Project Details + Commercial), Training materials + links, Program doc links, SOP links in checklists, past-project doc links.

**Known limitation:** Firebase Realtime Database `.validate` regex doesn't easily express URL validation at arbitrary depths. Code-level validation is the primary enforcement. The server-side mirror lives in `functions/index.js` `validateUrl()` for Cloud Function call paths.

---

## Finding 7 — No audit log on sensitive writes

**Status:** ✅ Mitigated

New `auditLog/` node in DB, client write-blocked (`".write": false`). Cloud Functions use admin SDK to append entries (bypasses rules). Every sensitive action now flows through a Cloud Function callable:

| Action | Callable | Log entry |
|---|---|---|
| First-time sign-in (Inst) | `provisionUser` | `provision_instrumental` |
| External user requests access | `provisionUser` | `request_access` |
| Approve pending user | `adminApproveUser` | `approve_user` |
| Deny pending user | `adminDenyUser` | `deny_user` |
| Delete user | `adminDeleteUser` | `delete_user` |
| Change role | `adminSetRole` | `set_role` |
| Grant/revoke project access | `adminSetProjectAccess` | `grant_project` / `revoke_project` |
| Grant/revoke commercial access | `adminSetCommercialAccess` | `grant_commercial` / `revoke_commercial` |

Entry shape:
```json
{ "ts": "ISO-8601", "actor": "uid", "action": "<action>", "target": "<uid-or-null>", "meta": { ... } }
```

Read-accessible to admins only. A v4.1.0 follow-up may add a dedicated Admin UI pane for browsing the log.

---

## Residual items / deferred

| Item | Why deferred | Target |
|---|---|---|
| HubSpot writeback for Project Overview fields | HubSpot write scopes not yet granted by IT | v4.1.0 |
| HubSpot files → webapp AI classification | HubSpot `files` scope not yet granted | v4.1.0 |
| Audit-log browser UI pane | Raw DB node is sufficient for now | v4.1.0+ |
| Rate limiting on callables | Firebase App Check recommended | v4.1.0+ |

---

## Testing the hardening

See `PRE_DEPLOY_RUNBOOK_4.0.0.md` for the pre-deploy test checklist including:
- Verify bootstrap path is dead (attempted sign-in as non-seeded admin fails cleanly).
- Verify `curl`-based privilege escalation attempts return `PERMISSION_DENIED`.
- Verify external user cannot read other users, other projects' access maps, or the audit log.
- Verify `javascript:` URL input is rejected.
- Verify admin actions produce audit entries.
