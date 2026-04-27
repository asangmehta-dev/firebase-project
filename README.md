# Deployment Portal

**Version:** v4.0.1

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
- **HubSpot CRM sync** — Auto-imports all projects from 6 HubSpot pipelines (Tue/Fri 9am PDT); admin preview + manual trigger
- **Projects Overview** — Instrumental/admin-only summary view showing all **active** projects: Demand Plan (aggregated hardware requirements), per-pipeline stage-distribution bar charts, and stage-by-stage project breakdown
- **Per-project hardware section** — HubSpot-synced hardware values shown read-only; Instrumental users can add custom manual hardware types per project
- **DB-level access control** — External users can only read projects they've been explicitly assigned to (enforced at Firebase Realtime Database rules level, not just UI)
- **Checklist templates** — New projects auto-get Internal + External checklist folders; SI projects get SI Deployment Checklist; optional apply to existing projects
- **Codename decoding** — HubSpot candy codenames automatically mapped to real customer names

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
| CRM | HubSpot Custom Objects API (v3), 6 pipelines |
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
| User — Instrumental | Manually approved, `partyId: instrumental` | Overview + Instrumental docs |
| User — Customer | Manually approved, `partyId: customer` | Overview + Customer docs |
| User — SI | Manually approved, `partyId: si` | SI docs only |
| User — CM | Manually approved, `partyId: cm` | CM docs only |

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

---

## Documentation

- [HOW_TO_USE_GUIDE_4.0.0.md](HOW_TO_USE_GUIDE_4.0.0.md) — End-user guide (current)
- [SECURITY_REVIEW_4.0.0.md](SECURITY_REVIEW_4.0.0.md) — Response to 4/24 security review (current)
- [REBUILD_4.0.0.md](REBUILD_4.0.0.md) — Step-by-step guide to rebuilding the project from scratch
- [PRE_DEPLOY_RUNBOOK_4.0.0.md](PRE_DEPLOY_RUNBOOK_4.0.0.md) — Admin seed instructions + pre-deploy test checklist

---

## Security

See [SECURITY_REVIEW_4.0.0.md](SECURITY_REVIEW_4.0.0.md) for the current security assessment.
