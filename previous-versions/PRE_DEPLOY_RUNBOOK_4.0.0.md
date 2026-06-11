# Pre-Deploy Runbook — v4.0.0

**Do not skip any step.** v4.0.0 removes the client-side first-user bootstrap, so if the first admin isn't manually seeded before deploy, sign-in will fail cleanly (the account lands in `pendingUsers` with nobody to approve it).

---

## 0. Pre-flight checks

Run locally, from the repo root:

```bash
# Rules JSON parses
node -e "JSON.parse(require('fs').readFileSync('database.rules.json','utf8'))"

# Functions build
node --check functions/index.js

# Vite build
npm run build
```

All three must succeed.

---

## 1. First admin seed (Firebase Console)

If v3.1.0 is already deployed and you have an existing admin: **skip to step 2** — your record already exists; v4.0.0 rules won't remove it.

If this is a brand-new Firebase project:

1. Open the [Firebase Console](https://console.firebase.google.com) → your project → **Realtime Database**.
2. Choose **Rules** tab. Temporarily set the rules to:
   ```json
   { "rules": { ".read": true, ".write": "auth != null" } }
   ```
   Click **Publish**. (This is for the seed window only. We tighten back below.)
3. Open **Authentication** → **Users** tab → note your own UID (sign in once via the app in step 7 if your UID doesn't exist yet, then sign out).
4. Back in Realtime Database → **Data** tab. Add this node at the root:
   ```json
   {
     "users": {
       "<YOUR_UID>": {
         "id": "<YOUR_UID>",
         "name": "Your Name",
         "email": "you@instrumental.com",
         "role": "admin",
         "partyId": "instrumental",
         "superAdmin": true,
         "projects": [],
         "createdAt": "2026-04-24T00:00:00.000Z"
       }
     }
   }
   ```
5. **Re-deploy the real rules** (step 2 below). Confirm the temporary open rules are gone.

---

## 2. Deploy security rules

```bash
npx firebase-tools deploy --only database
```

Expected: `✔  Deploy complete!`. The temporary open rules (if you set them above) are now overwritten with the v4.0.0 locked-down ruleset.

---

## 3. Deploy Cloud Functions

```bash
cd functions && npm install && cd ..
npx firebase-tools deploy --only functions
```

Expected new functions in the output:
- `provisionUser`
- `adminApproveUser`
- `adminDenyUser`
- `adminDeleteUser`
- `adminSetRole`
- `adminSetProjectAccess`
- `adminSetCommercialAccess`

Plus the existing ones (`scheduledHubspotSync`, `manualHubspotSync`, `applyChecklistTemplate`, `askProjectBot`).

---

## 4. Build + deploy hosting

```bash
npm run build
npx firebase-tools deploy --only hosting:deployment-portal-instrumental
```

---

## 5. Pre-deploy test checklist (run together with admin)

Open the deployed app in an **incognito window**. Before inviting users, walk through the entire list. ✅ = passes; ❌ = stop and diagnose.

### A. Sign-in

- [ ] Sign in with your admin Google account. App loads past the "Loading your data…" screen.
- [ ] Admin tab is visible in the sidebar.
- [ ] Sign out via sidebar footer.

### B. New Instrumental user auto-provision

- [ ] Open a second incognito window. Sign in with a **different** @instrumental.com account.
- [ ] App loads with all projects visible. No pending screen. No manual approval needed.
- [ ] `auditLog/` has a `provision_instrumental` entry for that user (check Firebase Console → Realtime Database).

### C. External user pending flow

- [ ] Sign in with a non-@instrumental.com Google account.
- [ ] Pending approval screen shows.
- [ ] Back in admin window: Admin → Pending tab shows the new request.
- [ ] Approve them with access to 1 project. Verify:
  - `users/{uid}` created with `role: user`, `partyId: external`
  - `access/{pid}/{uid}: true` set
  - `pendingUsers/{uid}` removed
  - `auditLog/` has `approve_user` entry

### D. External user scope

Log in as the external user:
- [ ] Only the assigned project is visible.
- [ ] Commercial tab shows lock icon (no access by default).
- [ ] No upload/edit buttons visible on Project Details.
- [ ] Attempt to read `users/` via browser console (`firebase.database().ref('users').once('value')`) — should fail with `PERMISSION_DENIED`.

### E. Privilege escalation attempt (curl)

```bash
# Should all return PERMISSION_DENIED. Replace <YOUR_ID_TOKEN> with a non-admin user's token.
curl -X PUT 'https://<your-project>.firebaseio.com/users/<external-uid>/role.json?auth=<YOUR_ID_TOKEN>' \
  -d '"admin"'

curl -X PUT 'https://<your-project>.firebaseio.com/users/<external-uid>/partyId.json?auth=<YOUR_ID_TOKEN>' \
  -d '"instrumental"'

curl -X PUT 'https://<your-project>.firebaseio.com/users/<external-uid>/superAdmin.json?auth=<YOUR_ID_TOKEN>' \
  -d 'true'
```

- [ ] All three return permission denied.

### F. URL validation

On Project Details, try to add a link with URL `javascript:alert(1)`:
- [ ] Blocked with "Invalid URL" alert.

Try `http://example.com`:
- [ ] Blocked (must be https).

Try `https://docs.google.com/…`:
- [ ] Accepted.

### G. Hardware override

As admin, on a project dashboard:
- [ ] Hardware section shows "HubSpot suggestion" badge.
- [ ] Click ✎ on a row with a HubSpot value. Enter a different number. Save.
- [ ] Row shows blue background + "Override · was X from HubSpot".
- [ ] Navigate to Projects Overview → Demand Plan. Confirm the row uses the override value (not the HubSpot value) in aggregation.
- [ ] Click ✎ → Clear. Row reverts to HubSpot value.

### H. Project Overview

- [ ] Click ✎ Edit on Project Overview.
- [ ] Fill in 3 date fields. Save. Values persist.
- [ ] Click 🤖 Ask Bot to draft. Bot returns a status and populates the textarea.
- [ ] Save. Refresh page. Status persists.
- [ ] "Target Build Date at Deal Close" and "CS Program ID" are shown with orange "HubSpot" badge and are read-only.

### I. Admin callable audit

As admin, revoke and re-grant a project access for the external user. Check `auditLog/`:
- [ ] `revoke_project` entry with actor, target, meta.projectId present.
- [ ] `grant_project` entry immediately after.

### J. External user doc-move hardening

- [ ] External user UI has NO buttons for "move between sections", "rename folder", "delete folder".
- [ ] From external user's browser console, attempt `firebase.database().ref('appState/docData/<pid>').set({...})`. Should fail with `PERMISSION_DENIED`.

### K. Existing features still work

- [ ] Manual HubSpot sync completes, projects refresh.
- [ ] SI Kanban drag-and-drop still moves cards between stages.
- [ ] Gantt chart renders on projects with dated items.
- [ ] Training belts can be assigned.
- [ ] Manage Projects tabs (active / inactive / past) render.
- [ ] Checklists (Internal, External, SI) still render with ownership + dates + SOP link columns.

---

## 6. If a step fails

**DO NOT roll forward.** Stop, diagnose, and if needed:
- Roll back hosting: `npx firebase-tools hosting:rollback`
- Keep rules + functions deployed (they're additive-compatible with v3.1.0 data).
- Ping me with the exact failure — most likely causes are (a) missing env var in `functions/.env`, (b) stale browser cache (force refresh), (c) Firebase Functions cold start timing out — retry once.

---

## 7. Post-deploy

Once the checklist above passes:
- [ ] Email existing users a short "v4.0.0 shipped" note with the new Project Overview feature.
- [ ] Monitor `auditLog/` for any unexpected `delete_user` or `set_role` entries in the first 24 hours.
- [ ] Tag git: `git tag -a v4.0.0 -m "v4.0.0"` and push.
