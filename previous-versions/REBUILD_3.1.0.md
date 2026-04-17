# Rebuild Guide — Deployment Portal v3.1.0
**Purpose:** Step-by-step guide to rebuilding this project from scratch if the source is ever lost or needs to be recreated in a different environment.
**Last updated:** 2026-04-13
**Scope:** Full rebuild — Firebase project, auth, database, Cloud Functions, HubSpot integration, UI/formatting conventions, deployment, and the versioning workflow this project follows.

---

## 0. Prerequisites

You need:
- A Google account with permission to create Firebase projects
- Node 18+ locally
- `firebase-tools` CLI (`npm install -g firebase-tools`)
- A HubSpot account with admin access (to create a Private App)
- A Google Cloud Platform billing account (Blaze plan required for Cloud Functions external API calls)

---

## 1. Firebase Project Setup

1. Go to https://console.firebase.google.com and create a new project.
2. Enable **Authentication** → enable **Google** sign-in provider.
3. Enable **Realtime Database** (default region — in this project, us-central1).
4. Upgrade to **Blaze** plan (pay-as-you-go). Required for outbound HTTP from Cloud Functions.
5. Create a **Hosting site** (we used `deployment-portal-instrumental`).
6. Note the `firebaseConfig` from Project Settings → Your apps → Web app — you'll paste this into `src/firebase.js`.

---

## 2. Project Scaffolding

```bash
npm create vite@latest deployment-portal -- --template react
cd deployment-portal
npm install firebase
npm install --save-dev vite
```

Install Firebase CLI and log in:
```bash
npx firebase-tools login
npx firebase-tools init
# Select: Hosting, Realtime Database, Functions (Node 18)
```

---

## 3. Source Code Structure

```
firebase-project/
├── src/
│   ├── App.jsx           # Single-file app (~1900 lines in v3.1.0). Contains all components, auth, DB listeners, views.
│   ├── main.jsx          # React entry
│   ├── firebase.js       # Firebase SDK init — paste your firebaseConfig here
│   └── hubspotConfig.js  # Pipeline IDs, stage IDs, codename map, hardware parsing helpers
├── functions/
│   ├── index.js          # Cloud Functions: scheduledHubspotSync, manualHubspotSync, applyChecklistTemplate
│   ├── checklists.js     # Checklist template definitions (Internal/External/SI)
│   └── package.json
├── data/                 # Source CSVs — used to generate hubspotConfig.js constants
├── database.rules.json   # Security rules
├── firebase.json         # Hosting + DB + Functions config
└── package.json
```

### File size & single-file convention
The app is deliberately kept in a single `App.jsx` file. This is an intentional choice — it keeps the surface area small, avoids import overhead, and makes search-and-replace refactors trivial. The trade-off is a large file; the ratio is worth it for a project this size.

---

## 4. UI / Formatting Conventions (Decisions Captured)

These choices were made deliberately across versions and should be preserved unless there's a strong reason to deviate.

### Styling
- **No CSS files.** All styles inline (via JS objects like the `S` const at the bottom of App.jsx) or scoped `<style>` tags for globals (scrollbars, body bg). Reason: zero build-time CSS complexity, no selector specificity wars, theme values live with the component that uses them.
- **Color palette:** Primary `#00C9A7` (teal); neutrals `#0F172A`, `#1E293B`, `#475569`, `#64748B`, `#94A3B8`, `#CBD5E1`, `#E2E8F0`, `#F1F5F9`, `#F8FAFC`; accent colors `#3B82F6` (blue/SI), `#F59E0B` (amber/Customer), `#A855F7` (purple/CM), `#DC2626` (red/delete), `#FF7A59` (HubSpot orange), `#6366F1` (manual/custom indigo).
- **Typography:** Single font family — `'Times New Roman', Georgia, serif` (see `F` constant). All components use this.
- **Spacing:** Standardized on multiples of 2/4/8/12/16/24. Card padding 24, page padding `36px 40px 80px`.

### Component conventions
- Micro components at top: `<Bar>`, `<Chip>` — reused across views
- Style objects in a bottom-file `S` const — centralized theme values
- Icons are Unicode glyphs (◉ ◈ ◆ ◇ ⊙ ⊞ ⊕ 🌐 ☑ 📋 🔒 ✎ ✓ ✕) — no icon library
- Language-aware strings go through `t(key, lang)` — see `TRANSLATIONS` object in App.jsx

### Data rendering conventions
- Empty states use `S.empty` — always friendly text, never raw "no data"
- Counts displayed with the `<Chip>` component
- Progress bars via `<Bar>` with value (0-100) and color
- Dates formatted via `fmtDate()` or `fmtDay()` helpers
- Money/counts formatted inline (no i18n number formatting yet)

### Adding a new view
1. Add a new function component before the `App()` export
2. Add a sidebar button in `Sidebar()` if needed
3. Add route handling in `renderMain()` in `App()`
4. Use `state`/`setState`/`user`/`project`/`lang` props pattern consistent with existing views

---

## 5. Firebase Realtime Database Structure

After v3.1.0 migration, the database looks like:

```
appState/
  projects/                        # Object keyed by project ID (v3.1.0 — was array in v3.0.0)
    {projectId}/
      id, name, customer, codename, appProjectId, stations, isSI,
      hubspotPipelineId, hubspotStageId, hubspotStageLabel, hubspotStageClosed,
      status ("active" | "inactive" | "deprecated"),
      partyNames/ {instrumental, si, customer, cm},
      hardware/ {cameras, lenses, tcLense, lensType, ledControllers, standardFrames, largeFrames, computers, monitors, barcodeScanner, bomDetails},
      syncedAt, source ("hubspot"), ...
  docData/                         # Per-project document data
    {projectId}/
      instrumental/ [categories...]
      si/ [categories...]
      customer/ [categories...]
      cm/ [categories...]
      _training/ {instrumental, si, customer, cm}
      _programDetails/ {tasks: [...]}
      _restrictedAccess/ {catId: [uid, uid, ...]}
      _siHardware/ [...]
      _siValidation/ {...}
  progress/                        # Per-user read state
    {userId}/ {...}
  statusMessage                    # Admin-editable banner text
  demandCustomTypes/               # v3.1.0 — Custom hardware types for Demand Plan
    {typeId}/ { label, counts: { projectId: count, ... } }

users/
  {userId}/ { id, name, email, photoURL, role ("admin"|"user"), partyId, projects: [pid, ...], superAdmin? }

pendingUsers/
  {userId}/ { id, name, email, photoURL, requestedAt }

access/                            # v3.1.0 — used by DB rules for per-project access checks
  {projectId}/
    {userId}: true

_schemaVersion: "v3.1.0"           # v3.1.0 — gates migration re-runs
_backup/
  pre_v3_1_0_projects: { projects: <legacy array>, backedUpAt }

hubspotSync/
  status: { state, count, lastSync, ... }  # Written by Cloud Functions only

hubspotPreview/                    # Written by Cloud Functions; admin-read-only
  {...preview data...}
```

### Security rules
See `database.rules.json`. Key design:
- External users (Customer/SI/CM) can only read `appState/projects/$pid` and `appState/docData/$pid` where they have an entry in `access/$pid/{uid}`
- Admin and Instrumental users can read parent nodes
- Writes to `appState/projects` restricted to admin
- Writes to `appState/docData` allowed to admin + Instrumental
- `hubspotSync` / `hubspotPreview` are `.write: false` for clients (Cloud Functions use admin SDK, which bypasses rules)

---

## 6. HubSpot Integration

### 6.1 Create a Private App in HubSpot

1. Log in to HubSpot → Settings → Integrations → Private Apps
2. Create a new app, name it (e.g., "Deployment Portal Sync")
3. Set scopes:
   - `crm.objects.custom.read`
   - `crm.schemas.custom.read`
   - (Future v3.2+: add `crm.objects.custom.write` when implementing 2-way sync)
4. Save and copy the token (`pat-na2-...`)
5. **Do not commit this token to source control.** Set it in Firebase Functions config:
   ```bash
   firebase functions:config:set hubspot.token="pat-na2-YOURTOKEN"
   ```

### 6.2 Obtain Pipeline and Stage IDs

HubSpot pipeline and stage IDs are numeric strings, not human-readable. To get them:

**Method 1 — HubSpot Developer Tools:**
1. In HubSpot, open any deal in the pipeline you want to sync
2. Open browser DevTools → Network tab
3. Refresh and look for API calls to `/pipelines/` — the response contains pipeline IDs and stage IDs

**Method 2 — HubSpot API directly:**
```bash
curl -H "Authorization: Bearer pat-na2-YOURTOKEN" \
  https://api.hubapi.com/crm/v3/pipelines/2-39524389
```
Replace `2-39524389` with your custom object type ID. The response lists all pipelines with their stages.

**Method 3 — Use HubSpot's URL:**
When viewing a pipeline in HubSpot's UI, the URL contains the pipeline ID (e.g., `/contacts/pipelines/{PIPELINE_ID}`).

Once you have them, hard-code them in `src/hubspotConfig.js` (see `PIPELINES` and `STAGES` objects). **Duplicate them into `functions/index.js`** (the Cloud Functions can't import from the client-side config file).

### 6.3 Codename decoder

Internal HubSpot customers use candy-themed codenames instead of real customer names. The mapping lives in `CODENAME_MAP` in both `src/hubspotConfig.js` and `functions/index.js`. Source of truth is `data/Customer Codename Decoder.csv` — regenerate the JS maps from the CSV when adding mappings.

### 6.4 Custom object type

Projects are stored as a **Custom Object** in HubSpot (not deals). The object type ID is `2-39524389` (see `HUBSPOT_OBJECT_TYPE`). The properties synced are listed in `PROPERTIES` in `functions/index.js`.

### 6.5 Sync schedule

- **Automatic:** Tuesdays and Fridays at 9am PDT (16:00 UTC). See `scheduledHubspotSync` in `functions/index.js`.
- **Manual:** Via Admin Panel → HubSpot Sync → Run Preview Sync → Confirm & Apply. Uses the callable function `manualHubspotSync`.

### 6.6 What the sync does
1. Paginated fetch of all custom objects from HubSpot
2. Map each HubSpot object to the app's project shape (see `mapHubspotToProject` in `functions/index.js`)
3. Diff against existing DB state — identify new vs. updated projects
4. Preview mode writes to `hubspotPreview/` (no changes to live data)
5. Apply mode merges into `appState/projects`, preserving manually-set fields, writing as object keyed by project ID
6. New projects get checklist templates auto-applied (Internal + External for non-SI; SI Deployment Checklist for `[SI]`-prefixed names)

---

## 7. Cloud Functions

Functions live in `functions/index.js`:
- `scheduledHubspotSync` — pubsub-triggered cron
- `manualHubspotSync` — callable, admin-gated, supports `commit: false` preview mode
- `applyChecklistTemplate` — callable, admin-gated, applies checklist template to existing projects

All functions:
- Use `functions.config().hubspot.token` for the HubSpot token (never hard-coded)
- Verify caller is admin via `users/{uid}/role === 'admin'` or `superAdmin === true`
- Use admin SDK (`firebase-admin`) for DB access — bypasses security rules

Deploy:
```bash
cd functions && npm install && cd ..
npx firebase-tools deploy --only functions
```

---

## 8. Access Control Model

### Roles (hierarchy)
1. **SuperAdmin** (`superAdmin: true` in user record) — can promote others to admin
2. **Admin** (`role: "admin"`) — full read/write
3. **Instrumental User** (`partyId: "instrumental"`, `role: "user"`) — read all, write docs/checklists/custom hardware
4. **External User** (`partyId: "customer" | "si" | "cm"`) — read-only, restricted to assigned projects

### Approval flow
- `@instrumental.com` emails auto-approved as Instrumental (see `useEffect #2` in App.jsx)
- All other emails land in `pendingUsers/` and require admin action in Admin Panel → Pending
- Admin selects party + projects → approval writes to `users/{uid}` + `access/{pid}/{uid}` for each assigned project

### Access map maintenance
- `access/{pid}/{uid}: true` is maintained in parallel with `users/{uid}/projects` array
- Only external users have entries (admins/Instrumental have blanket access via rules)
- Helper `needsAccessMap(u)` in `AdminView` in App.jsx determines whether to write access entries

---

## 9. Versioning Workflow (Process Decision)

Every code change follows this workflow:

1. **Bump version** (patch or minor as appropriate):
   - Update the version number in `README.md` header and Version History table
2. **Update docs** if the change affects user-visible behavior or security:
   - `HOW_TO_USE_GUIDE_{VERSION}.md` — new file per minor version (e.g., 3.1.0)
   - `SECURITY_REVIEW_{VERSION}.md` — new file per minor version
   - `REBUILD_{VERSION}.md` — new file per minor version (this file)
3. **Build locally** to catch compile errors:
   ```bash
   npm run build
   ```
4. **Create zip** in Downloads folder:
   ```bash
   cd ~/Downloads
   rm -f deployment-portal-v<PREV>.zip
   cd firebase-project
   zip -r ~/Downloads/deployment-portal-v<NEW>.zip . -x 'node_modules/*' 'dist/*' '.git/*'
   ```
5. **Do not auto-deploy.** User explicitly approves each deploy. Deploy via:
   ```bash
   npm run build
   npx firebase-tools deploy --only hosting:deployment-portal-instrumental
   npx firebase-tools deploy --only functions
   npx firebase-tools deploy --only database   # if rules changed
   ```

> **Why this workflow:** The user tracks every version meticulously and this process ensures documentation, artifacts, and code stay in lock-step. Skipping steps leads to documentation drift.

---

## 10. Local Development

```bash
npm install
npm run dev   # http://localhost:5173

# Cloud Functions
cd functions && npm install && cd ..
```

The dev server connects to the **live Firebase project** (there is no local emulator setup currently). Be careful when testing — writes go to production data.

---

## 11. Deployment Targets

### Firebase Hosting (primary, public)
```bash
npm run build
npx firebase-tools deploy --only hosting:deployment-portal-instrumental
```

### Cloud Functions (HubSpot sync)
```bash
cd functions && npm install && cd ..
npx firebase-tools deploy --only functions
```

### Database rules
```bash
npx firebase-tools deploy --only database
```

### Cloud Run (legacy, IAP-protected)
```bash
docker build -t gcr.io/deploymentportal-5ec3a/deployment-portal .
docker push gcr.io/deploymentportal-5ec3a/deployment-portal
gcloud run deploy deployment-portal \
  --image gcr.io/deploymentportal-5ec3a/deployment-portal \
  --platform managed --region us-central1
```

---

## 12. Post-Deploy Checklist (v3.1.0 Specific)

After deploying v3.1.0 for the first time:
1. [ ] Rotated HubSpot token set in Functions config
2. [ ] Database rules deployed (`firebase-tools deploy --only database`)
3. [ ] Functions deployed (`firebase-tools deploy --only functions`)
4. [ ] Hosting deployed (`firebase-tools deploy --only hosting:deployment-portal-instrumental`)
5. [ ] **Admin opens the app immediately after deploy** to trigger the v3.1.0 migration (array→object for `appState/projects`, populate `access/` map). Migration log visible in browser console.
6. [ ] Verify `_schemaVersion` in DB is `"v3.1.0"` (Firebase Console → Realtime Database)
7. [ ] Verify `_backup/pre_v3_1_0_projects` exists (safety net)
8. [ ] Verify `access/` is populated for external users
9. [ ] Test as an external user — confirm only assigned projects visible, and direct DB queries for unassigned projects return permission denied

---

## 13. Known Limitations & Future Work

Tracked for v3.2.0+:
- HubSpot 2-way sync (write-back of milestone dates entered in app → HubSpot). Requires adding `crm.objects.custom.write` scope to the Private App token.
- Firebase App Check for API key abuse prevention
- Per-field audit log (who changed what, when)
- Google Drive or other external document integration (deferred — currently users upload docs into the portal directly)
- Rate limiting on Cloud Functions callable endpoints
- Grouping options on Demand Plan (by customer / by pipeline / time-phased) — design TBD based on usage feedback

---

## 14. Troubleshooting the Rebuild

**Q: Firebase CLI says the project doesn't exist**
Make sure you're logged into the right Google account. Run `firebase logout` then `firebase login`.

**Q: Cloud Functions deploy fails with "missing @google-cloud/scheduler"**
The Blaze plan must be activated. Go to Firebase Console → Usage and billing → Upgrade.

**Q: HubSpot sync returns 401**
Token is wrong or missing. Verify with `firebase functions:config:get` and reset if needed.

**Q: Database rules reject all my writes**
Verify your user record has `role: "admin"` in `users/{yourUid}`. The first user to sign in is auto-admin (see App.jsx first-time init logic).

**Q: Migration didn't run**
Check `_schemaVersion` in DB. If it's already `"v3.1.0"` the migration is skipped. To re-run, delete the `_schemaVersion` node and reload the app as admin. Pre-migration data is in `_backup/pre_v3_1_0_projects`.

**Q: External user sees empty project list even though they're assigned to projects**
Verify `access/{pid}/{uid}: true` exists for each assigned project. If missing, have admin remove and re-add the project assignment via Admin Panel → User Access.
