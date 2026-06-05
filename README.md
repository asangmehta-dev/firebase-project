# Deployment Portal

**Version:** v4.3.2

A React 18 web application serving as a consolidated PMO-style frontend UI for the Customer Experience team to track and proactively manage risks/issues with CMs and customers. Speaks directly to HubSpot to provide real-time information on all projects in the deployment and sales pipeline. Coordinates documentation, milestones, and program details across Instrumental, Systems Integrator (SI), Customer, and CM stakeholders via a unified Project Details / Commercial / Training model.

#Vision 
The goal of this Webapp is to have a consolidated "PMO" Style frontend UI that the Customer Experience team can use to track and proactively manage risks / issues with CMs/ customers. This will directly speak to Hubspot and provide real time information on all projects in the deploment and sales pipeline 

---

## Live URL

**Primary:** https://deployment-portal-instrumental.web.app/
**Legacy (Cloud Run + IAP):** https://deployment-portal-901459055521.us-central1.run.app/

---

## Features

- **Unified project structure** — Project Details, Commercial (restricted), and Training sections per project (v3.2.0 — replaces old 4-party system)
- **Project overview dashboard** — Per-party folder/document counts and milestone progress bars
- **Checklist milestones** — OK2Contract, OK2Ship, OK2Build with checklists, signatures, and linked resources
- **Program Details** — Task and milestone timeline with drag-to-reorder
- **Customer dashboard** — Station count and key milestone dates pulled from Program Details
- **Document management** — Upload links and PDFs per folder, with per-document language tagging
- **Training section** — White / Blue / Black Belt training materials per party
- **Admin panel** — User approval, role management, restricted folder access grants, HubSpot sync control
- **Multi-language UI** — English, Español, Tiếng Việt, 繁體中文, 简体中文
- **Site status banner** — Admin-editable broadcast message shown to all users
- **Inline editing** — Admins can edit milestone descriptions and checklist labels in place
- **HubSpot CRM sync** — Auto-imports all projects from 7 HubSpot pipelines (Tue/Fri 9am PDT); admin preview + manual trigger
- **Projects Overview** — Instrumental/admin-only summary view showing all **active** projects: Demand Plan (aggregated hardware requirements), per-pipeline stage-distribution bar charts, and stage-by-stage project breakdown
- **Per-project hardware section** — HubSpot-synced hardware values shown read-only; Instrumental users can add custom manual hardware types per project
- **DB-level access control** — External users can only read projects they've been explicitly assigned to (enforced at Firebase Realtime Database rules level, not just UI)
- **Checklist templates** — New projects auto-get Internal + External checklist folders; SI projects get SI Deployment Checklist; optional apply to existing projects
- **Codename decoding** — HubSpot candy codenames automatically mapped to real customer names
- **HubSpot writeback** — Editing date fields (CAD Complete, CAD Actual Finish, Actual Service Start, Target Build, Actual Deploy) in Project Overview patches the HubSpot custom object record automatically on save, with "↑ Syncing / ✓ HubSpot updated / ⚠ failed — saved locally" indicator
- **`si_admin` role** — New role between `user` and `admin`; grants edit access to the All SI Projects tracker without full admin powers
- **All SI Projects view** — Sidebar sub-tab under All Projects Overview (Instrumental-visible, si_admin-editable); shows only SI Partner Deployment pipeline projects with per-project risk flag, last contact, next milestone, notes, and custom columns; includes the SI Kanban at the top
- **Sidebar sub-navigation** — Project Details categories listed as collapsible sub-items in the left sidebar; external users see only Design Specs & Integration Docs, CAD & Drawings, and Hardware & MES Deployment Requirements
- **Non-PDF file uploads** — Upload button extended to DOCX, XLSX, PPTX, images, CSV, and `.lbx` label files (50 MB cap); per-file icon by type
- **Gantt chart toggle** — "📊 Show Gantt Chart" button on Project Overview; disabled with tooltip if < 3 dates available
- **HubSpot project hyperlinks** — 🔗 icons on project names in Overview, Manage Projects, and All Projects; open HubSpot record in new tab
- **Scheduled maintenance** — Runs Tue & Fri at 3 PM PT; sweeps old sync/audit/writeback logs; evaluates 3 agentic rules (bug threshold, sync error rate, circuit breaker); results in Admin Panel → 🔧 Maintenance tab
- **Pre-uploaded deployment requirement docs** — 10 master files auto-linked into every project's "Hardware & MES Deployment Requirements" folder at first open; external users can download
- **Performance** — Code-split bundle (react-vendor + firebase-vendor chunks); function memory bumps; memoized heavy views
- **Shipment Details sync** — HubSpot sync auto-populates `item_num` rows in each project's Shipment Details tab from associated HubSpot Shipments records (INxxx); no duplicates; other columns left blank for manual fill-in

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite |
| Database | Firebase Realtime Database |
| Auth | Firebase Authentication (Google OAuth) |
| Hosting | Firebase Hosting |
| Cloud Functions | Firebase Functions (Node 20) — HubSpot sync, AI Bot (Claude), admin callables, provisioning |
| AI | Anthropic Claude API (`claude-sonnet-4-20250514`) — Project Bot, drafted project status |
| CRM | HubSpot Custom Objects API (v3), 7 pipelines |
| Legacy hosting | Docker + Nginx on Google Cloud Run (with IAP) |
| Styles | Inline styles only (no CSS files) |

---

## Project Structure

```
firebase-project/
├── src/
│   ├── App.jsx           # Entire application (single file)
│   ├── main.jsx          # React entry point
│   ├── firebase.js       # Firebase SDK init (auth, db, functions)
│   └── hubspotConfig.js  # Pipeline/stage definitions, codename map
├── functions/
│   ├── index.js          # Cloud Functions: HubSpot sync, checklist template
│   ├── checklists.js     # Checklist template data (Internal/External/SI)
│   └── package.json      # Node 18, firebase-admin, node-fetch
├── data/                 # Source CSV files (codename decoder, checklists)
├── public/
├── firebase.json         # Firebase Hosting + Functions config
├── .firebaserc           # Firebase project + hosting target
├── database.rules.json   # Firebase Realtime Database security rules
├── Dockerfile            # For Cloud Run deployment
├── nginx.conf            # Nginx config for Docker container
├── vite.config.js
└── package.json
```

---

## Local Development

```bash
# Install client dependencies
npm install

# Start dev server (http://localhost:5173)
npm run dev

# Install Cloud Functions dependencies (one-time)
cd functions && npm install && cd ..
```

### Functions `.env` (one-time setup — do NOT commit)

Create `functions/.env`:

```
HUBSPOT_TOKEN=pat-na2-YOURTOKEN
ANTHROPIC_API_KEY=sk-ant-YOURKEY
```

`.env` is gitignored. The legacy `firebase functions:config:*` API is deprecated — we use `process.env` in `functions/index.js`.

---

## Deployment

### Firebase Hosting (primary)

```bash
npm run build
npx firebase-tools deploy --only hosting:deployment-portal-instrumental
```

### Cloud Functions (HubSpot sync)

```bash
cd functions && npm install && cd ..
npx firebase-tools deploy --only functions
```

### Cloud Run (legacy — keeps IAP protection)

```bash
docker build -t gcr.io/deploymentportal-5ec3a/deployment-portal .
docker push gcr.io/deploymentportal-5ec3a/deployment-portal
gcloud run deploy deployment-portal \
  --image gcr.io/deploymentportal-5ec3a/deployment-portal \
  --platform managed \
  --region us-central1
```

### One-time Firebase Hosting setup (already done)

```bash
npx firebase-tools login
npx firebase-tools hosting:sites:create deployment-portal-instrumental
npx firebase-tools target:apply hosting deployment-portal-instrumental deployment-portal-instrumental
```

---

## Access Control

| Role | Who | Access |
|------|-----|--------|
| SuperAdmin | One designated user (`superAdmin: true` in DB) | All admin powers + can promote others to admin |
| Admin | Explicitly granted by SuperAdmin | Full read/write, user management, all parties |
| SI Admin | Granted by Admin (`role: "si_admin"`) | Edit SI tracker; same Instrumental read-access elsewhere |
| User — Instrumental | Auto-provisioned `@instrumental.com` | All projects read + write for Instrumental-owned fields |
| User — External | Manually approved by admin | Assigned projects only; read-only for Design Specs, CAD, Deployment Docs |

New users sign in with Google and land in a pending queue until an admin approves them and assigns a party.

---

## Firebase Project

**Project ID:** `deploymentportal-5ec3a`
**Hosting site:** `deployment-portal-instrumental`
**Database:** Firebase Realtime Database (default)

---

## Version History

| Version | Description |
|---------|-------------|
| v2.0.0 | Baseline — multi-party portal with milestones, documents, training, admin panel |
| v2.1.0 | Firebase Hosting URL, multi-language UI, Instrumental/Customer dashboards, milestone % progress, inline editing |
| v2.1.1 | Chronological milestone sort, drag-to-reorder for Program Details and Checklist Milestones |
| v2.2.0 | Language dropdown moved to sidebar bottom, clickable party cards, item count fix, superAdmin role, @instrumental.com no longer auto-admin |
| v2.2.1 | Fixed broken IIFE in overview party cards — non-admin users can only navigate to their own party |
| v3.0.0 | HubSpot CRM sync (6 pipelines, auto Tue/Fri 9am + manual), Projects Overview tab, checklist templates (Internal/External/SI), codename decoding, admin panel HubSpot sync UI, Instrumental/External user split |
| v3.1.0 | DB-level access control, Demand Plan, per-pipeline bar charts, per-project hardware section |
| v3.2.0 | Remove 4-party system, unified Project Details/Commercial/Training, new checklist template, searchable dropdown |
| v3.3.0 | Security lockdowns, Manage Projects overhaul, SI Kanban, Gantt chart, hardware demand forecast, App Scripts links, AI Project Bot, URL redirect |
| v4.0.0 | **Security review response** (7 findings) — `users/` read locked to admin + own; `access/` and `commercialAccess/` reads scoped; client-side bootstrap removed (manual admin seed); `provisionUser` Cloud Function for sign-in; admin callables (`adminApprove`/`Deny`/`Delete`/`SetRole`/`SetProjectAccess`/`SetCommercialAccess`) with **audit log** on all sensitive ops; URL validation (https-only, `javascript:`/`data:`/`file:` blocked). **Hardware manual override** (HubSpot value = suggestion; Instrumental users can override per-field, override wins in Demand Plan). **Project Overview** section with 8 fields — CAD Complete, CAD Actual Finish, Actual Service Start, Target Build, Actual Deploy (webapp source of truth) + Target Build at Deal Close + CS Program ID (HubSpot pull-only) + Project Status/Next Steps (Bot-drafted). **AI-drafted Project Status** button wires to existing Project Bot. Folds in uncommitted v3.2.0 + v3.3.0 + Apr 22 sign-in hotfixes. |
| v4.0.1 | **HubSpot Sync history log** (Admin Panel → HubSpot Sync) — every sync (manual or scheduled) writes an entry to `hubspotSync/log/` with type, actor, state, counts, duration; rendered as a table in the admin UI. **SI Kanban now driven by HubSpot** — added "SI Partner Deployment" pipeline (ID `2206979797`) with 8 stages (SIRD → DFM → Quote → PO → Build → FAT → SAT → Live). Projects in this pipeline auto-populate `siStage` from HubSpot's stage on every sync. SI Kanban filters by pipeline membership (no longer by `[SI]` name pattern), so `[SI]` projects in Hardware Deployment Pipeline stay in Hardware. `hubspotSync/.read` tightened to admin-only. |
| v4.0.2 | **Hotfixes**: (1) `writeSyncLogEntry` and `writeAuditEntry` were building DB keys from ISO timestamps (containing `.`), which Firebase Realtime Database forbids in path segments. Both now use `db.ref(...).push(entry)` — Firebase auto-generates path-safe, time-sortable keys. (2) HubSpot sync apply errored with `set failed: value argument contains undefined in property '...siStage'` for legacy projects (synced before SI Partner pipeline support) where both `incoming_p.siStage` and `merged[idx].siStage` were missing — coerced fallback to `?? null` and added `sanitizeForFirebase()` recursive helper applied to project writes (defensive guard against any future undefined-value writes). (3) Admin panel copy updated from "6 HubSpot pipelines" → "7" to reflect the SI Partner Deployment addition. |
| v4.0.4 | **HubSpot sync bug fixes**: (1) "Last sync Never" — UI read `syncStatus.lastSync`/`.count` but CF writes `syncedAt`/`total`; field names corrected. (2) Preview always showed "2 projects found" — `Object.values(data)` on `{ projects, summary }` returned 2 entries; fixed to `Object.values(data.projects \|\| {})`. (3) "Error: internal" on any sync failure — `manualHubspotSync` propagated plain JS errors as opaque Firebase "internal"; now wrapped in try/catch that rethrows with real message. (4) Hardware tracking not populating — `fetchAllStationKits` used v3 inline association key `2-39524389` which doesn't reliably map for custom-to-custom objects; replaced with `fetchKitsForProjects` using v4 batch associations API (project → kit direction). **Validation tab**: FAT/SAT status fields now have × clear buttons (Instrumental only) to reset back to "Not started". |
| v4.1.0 | **Major feature release** — 9 workstreams shipped: (1) **Sidebar sub-nav**: all Project Details categories listed as collapsible sub-items; external users scoped to 3 folders. (2) **Non-PDF uploads**: DOCX/XLSX/PPTX/images/CSV/.lbx allowed; external users read-only. (3) **Gantt toggle**: "📊 Show Gantt" button, disabled <3 dates. (4) **HubSpot project links**: 🔗 on project names in 4 views. (5) **Pre-uploaded deployment docs**: 10 system docs auto-linked per project via `ensureProjectTemplate` CF. (6) **`si_admin` role + All SI Projects view**: editable SI tracker (risk, contact, milestone, notes), SI Kanban moved here, sub-item under All Projects Overview. (7) **HubSpot writeback**: date field saves PATCH HubSpot custom object; `getHubspotCustomObjectSchema` diagnostic CF; fail-safe local save. (8) **Scheduled maintenance CF** (Tue/Fri 3 PM PT): sweeps old logs, evaluates 3 agentic rules (bug count, sync error rate, circuit breaker auto-pause); Admin Panel → 🔧 Maintenance tab. (9) **Performance**: code-split vendor chunks (react/firebase), memoization, function memory bumps. |
| v4.3.2 | **Internal Checklist content update** (Deployment Checklist Consolidated v1.2) — 5 new items added across milestones 1, 3, and 4 (final config confirmation, optics/hardware compatibility, mounting design finalization, computer provisioning, Lastpass + Station SOP setup). Existing projects auto-inject the new items via `CHECKLIST_PATCHES` on next page load; projects with user-customized checklists keep their existing items untouched (additive-only). Source-of-truth labels in `functions/checklists.js` updated for new projects (line-visit-by-TPM in mounting validation, calibration boards in extra hardware, buffer language in daily schedule). **Ownership field inline-editable** — the `ck.ownership` field on each checklist task is now click-to-edit for Instrumental users (mirrors the existing label and notes edit patterns). Empty ownership shows a "· + owner" placeholder; populated ownership is clickable. No UI layout changes — same position, same styling. Uses the v4.0.3 functional-updater pattern so rapid edits don't race. |
| v4.3.1 | **Audit Log browser** (Admin Panel → 🔍 Audit Log) — surfaces both the User Action Log (`auditLog/`) and the HubSpot Writeback Log (`hubspotWriteback/log/`) so admins can see actual HubSpot error responses when writebacks fail. Filter by action type or writeback status. **Slack feedback** — new "💬 Send Feedback" button at the bottom of the sidebar opens a modal that routes SI feedback to Sneha's channel and everything else to Asang's, via new `sendSlackFeedback` CF + `SLACK_WEBHOOK_ASANG` / `SLACK_WEBHOOK_SNEHA` secrets. **Schema diagnostic now multi-object** — Admin Panel → HubSpot Sync → Schema buttons for Projects, Shipments, and Station Kits (custom object types `2-39524389`, `2-39524475`, `2-39260531`); `getHubspotCustomObjectSchema` CF now accepts `objectTypeId` param. |
| v4.3.0 | **Non-SI Kanban drag-and-drop stage writeback** — Instrumental users can drag project cards between stage columns in All Projects Overview → Kanban mode; drop writes the new stage to HubSpot via new `writeStageToHubspot` CF (`PATCH /crm/v3/objects/${OBJECT_TYPE}/${hubspotId}`) with optimistic update + revert-on-error. SI pipeline excluded (not in `PIPELINE_LIST`). Error banner shows on writeback failure. **Remove SI from main project dropdown** — admin's sidebar project combobox now filters out SI Partner Deployment pipeline projects; they remain accessible via All SI Projects and All Projects Overview. |
| v4.2.9 | **MES Integration Checklist** — new sub-tab under Project Details for all projects (standard and SI), sourced from `MES_Integration_Setup_Checklist_external.docx`; 9 milestone sections (Network & Connectivity, SSL Certificate, API Endpoints, Station Names & Route Config, Auth & Credentials, Test Environment, Error Handling, Data Format & Serial Numbers, Go-Live Readiness) with ~70 checkbox items; check-off records timestamp and owner. Checklist auto-injected client-side for existing projects via `APP_MES_CHECKLIST_TEMPLATE` in `getProjectDetails`; `backfillChecklists` CF also picks it up for server-side persistence. **Webapp Project ID field** — new Instrumental-only editable field in Project Overview (not visible to external users); stored in `projectOverview` alongside other date fields. **Tab reorder sidebar fix** — sidebar sub-nav now sorts by `TAB_ORDER` (matching the main tab bar). |
| v4.2.8 | **Checklist check-off audit** — checking a task now records `checkedBy` (user name) and `checkedAt` (timestamp); displayed below the task label in teal as "✓ Name · Jan 1, 2026 at 9:30am". Unchecking clears both fields. **Add Row/Station at top** — `TableSection` and `TransposedTableSection` now show `+ Add Row` / `+ Add Station` + `📥 Import` buttons above the table (in addition to below) when there are existing rows, so users don't have to scroll down on long tables. **Pipeline Kanban in All Projects Overview** — "Projects by Stage" section now has a ☰ List / ⬛ Kanban toggle; Kanban mode shows one column per pipeline stage with color-coded project cards (customer, station count, SI flag); switching pipelines updates the Kanban live. |
| v4.2.7 | **Fix sync hang — `fetchWithTimeout` helper** — all HubSpot API calls in the sync path (`fetchAllHubspotObjects`, `discoverStationObjectTypes`, `fetchKitsForProjects`, `fetchComponentsForKits`, `fetchShipmentsViaKits`) now time out at 15s via a shared `fetchWithTimeout` wrapper using `AbortController`. Previously, any single silent HubSpot API hang could consume the full 300s function window before any log output appeared, causing every sync to time out. **Fix hardware docs** — system docs in "Hardware & MES Deployment Requirements" folder now open via `getDownloadURL()` on click (resolves a download-token URL the browser can follow without auth headers), replacing the old `<a href="?alt=media">` approach which required Firebase Auth in the request header. `checklists.js` updated to store `storagePath` instead of `url` for new projects; legacy items with `url` field handled via path extraction fallback. Dead code removed from `App.jsx` (`storageBaseUrl`, `APP_DEPLOY_REQ_FOLDER`). |
| v4.2.6 | **Fix shipment sync hang** — rewrote `fetchShipmentsViaKits`: HubSpot has no direct Project→Shipment association; shipments are linked to Station Kits. Old code queried a non-existent association endpoint that hung indefinitely (no `node-fetch` timeout), causing every apply sync to time out at 300s. New code traverses Kit→Shipment using kit IDs already fetched by the station kits block, with 15s AbortController timeouts on every fetch call. Also hoisted `kitsByProject` to share it between both blocks. **Fix Hardware docs 404** — storage bucket URL in `checklists.js` was `deploymentportal-5ec3a.appspot.com` (non-existent) instead of `deploymentportal-5ec3a.firebasestorage.app`; uploaded all 10 docs to the correct bucket path. **Fix client deadline-exceeded** — both `manualHubspotSync` callable invocations now pass `{ timeout: 300000 }` to match the 300s server timeout. |
| v4.2.5 | **Fix sync OOM + timeout** — `manualHubspotSync` and `scheduledHubspotSync` bumped to `memory: "8GB", timeoutSeconds: 300` (was 512 MB / 60s default); fixes "Error: Internal" caused by OOM crash and 60s timeout when syncing 305+ projects with station kits + shipments. Eliminated redundant 3rd full docData read in `runSync` (station kits snapshot now shared with shipments block, saving one Firebase round trip and one in-memory copy). |
| v4.2.4 | **Error: Internal fix** — wrapped `runSync` secondary ops (preview clear, status write, log entry) in individual try/catch so a post-sync Firebase write failure no longer surfaces as "Error: Internal" to the user; sync data was already persisted. **`listHubspotSchemas` CF** — new admin diagnostic that calls `GET /crm/v3/schemas` and returns all custom object type IDs, names, and properties; surfaced as "🗂️ All HubSpot Object Types" button in Admin Panel → HubSpot Sync tab (used to discover the Shipments object). **Shipment Details HubSpot sync** — each HubSpot sync now also batch-reads project → Shipments associations (object type `2-39524475`, property `shipment_tracking_number`), and upserts the INxxx numbers as new rows in each project's Shipment Details tab (`item_num` only, no duplicates, leaves all other columns blank for manual fill-in). |
| v4.2.3 | **Station Kits complete attribute list** — expanded from 35 to 63 columns to match full Excel layout. Added to Cameras: `cameras_present` bool, `no_camera_brackets`. Added to Lenses: `lenses_present` bool. Added to Lights: UV/white light rotational notch #s, no. LED cables/length, LED cables bool, Wordop automated/manual controller bools, UV light intensity, LEDC power cable, 4x LED controller ext. cables. New **Station Components** section (16 rows): Station SN, Andon/Stack Light+Bracket, Keyboard/Mouse Tray, Monitor Bracket, Barcode Scanner Mount, Cable Ties & Wrap, Baseboard/Mainboard 3D/CNC nests, Power Converter (Brazil) 2x, Instrumental Sign, NBR cable, NEMA adapter, Brazil power cord. Mirrored in `functions/checklists.js`. No migration needed — additive columns only. |
| v4.0.3 | **Critical UX fix — Checklists**: previous `ChecklistSection` had a Rules of Hooks violation (`useState` inside an IIFE inside a conditional render). When milestones expanded/collapsed, React's hook order shifted between renders → state corruption → infinite re-render loops → Chrome tab crashes (and one user reported the tab recovering into a Google search). Rewritten cleanly: each task is now a `<button type="button">` row with checkbox + label, no broken hooks. **Editable checklists** — Instrumental users can now `+ Add task` per milestone (inline input) and delete tasks via the × button. Add/delete tasks persist to `docData/{pid}/projectDetails`. **PDF uploads to Firebase Storage** — new `PdfUploadButton` component wired into the three file-add forms (Project Details, Commercial, Training). Files go to `gs://<bucket>/uploads/{projectId}/...` (50 MB max, content-type enforced). New `storage.rules` gates writes to authenticated users + PDF-only + size cap; client-side validator mirrors the same limits. **Strict-SI**: `isSI` is now ONLY true for projects in the SI Partner Deployment pipeline. **Dead-code purge**: removed ~558 lines of unreachable v3.x components (`DocsView`, `MilestoneCard`, `SIValidation`, `SIHardware`, `ProgramDetails`) that referenced the long-deleted `PARTY_DEFS` constant. **Sync log polish**: "Recent errors" panel filters to last 24h. **SI Kanban barricade**: blue gradient panel with "SI PARTNER DEPLOYMENT PIPELINE" label tab. **Standalone checklist backfill**: new `backfillChecklists` Cloud Function + Admin Panel button applies templates to all projects missing them — no HubSpot sync required. Multi-path Firebase update batched in chunks of 100; client timeout bumped to 9 minutes. |

---

## Documentation

- [HOW_TO_USE_GUIDE_4.1.0.md](HOW_TO_USE_GUIDE_4.1.0.md) — End-user guide (current)
- [HOW_TO_USE_GUIDE_4.0.3.md](HOW_TO_USE_GUIDE_4.0.3.md) — End-user guide (previous)
- [SECURITY_REVIEW_4.0.0.md](SECURITY_REVIEW_4.0.0.md) — Response to 4/24 security review
- [REBUILD_4.0.0.md](REBUILD_4.0.0.md) — Step-by-step guide to rebuilding the project from scratch
- [PRE_DEPLOY_RUNBOOK_4.0.0.md](PRE_DEPLOY_RUNBOOK_4.0.0.md) — Admin seed instructions + pre-deploy test checklist

---

## Security

See [SECURITY_REVIEW_4.0.0.md](SECURITY_REVIEW_4.0.0.md) for the current security assessment.
