# Deployment Portal v3.2.0 — Rebuild Guide

**Date:** 2026-04-16

This document explains how to recreate the Deployment Portal project from scratch.

---

## 1. Prerequisites

- **Node.js 20+** (LTS recommended)
- **Firebase CLI** (`npm install -g firebase-tools`) — v13+
- **Firebase project** on the Blaze (pay-as-you-go) plan
- **HubSpot Private App** with read-only scopes for deals/pipelines
- A Google account with Owner/Editor access to the Firebase project

---

## 2. Firebase Project Setup

1. Go to https://console.firebase.google.com and create a new project (or use an existing one).
2. Enable the following services:
   - **Authentication** — Enable Email/Password sign-in provider.
   - **Realtime Database** — Create a database in the region closest to your users.
   - **Hosting** — Initialize a default hosting site.
3. Upgrade to the **Blaze plan** (required for Cloud Functions).
4. Under Project Settings, register a **Web App** and copy the Firebase config object.

---

## 3. Source Code Structure

```
firebase-project/
  firebase.json              — hosting/functions/database config
  database.rules.json        — Realtime DB security rules
  src/
    App.jsx                  — single-file React app (~2200 lines)
    firebase.js              — Firebase SDK init + config object
    hubspotConfig.js         — HubSpot pipeline/stage ID mappings
  functions/
    index.js                 — Cloud Functions entry point (HubSpot proxy, migrations)
    checklists.js            — checklist template definitions
    .env                     — contains HUBSPOT_TOKEN (not committed)
  dist/                      — build output (deployed to Hosting)
```

All UI logic lives in `src/App.jsx`. There are no separate component files or CSS files.

---

## 4. v3.2.0 Data Model

Schema version marker at the database root:

```
_schemaVersion: "v3.2.0"
```

### Projects

```
appState/projects/{pid}
```

Object-keyed project records. Each contains name, status, type, timestamps, and metadata.

### Document Data (per project)

All document/folder data lives under `appState/docData/{pid}/`:

| Path                        | Description                                      |
|-----------------------------|--------------------------------------------------|
| `projectDetails`            | Unified folders (replaces old party-based structure) |
| `commercial`                | Restricted folders (requires commercial access)  |
| `_training`                 | Training data with belt assignments              |
| `_programDetails`           | Program tasks and milestones                     |
| `_hardwareTracking`         | Hardware tracking data                           |
| `_validation`               | FAT/SAT status records                           |

### Access Maps

```
access/{pid}/{uid}: true
```

Grants a user access to a project.

```
commercialAccess/{pid}/{uid}: true
```

Grants a user access to the Commercial tab within a project. This is a separate admin grant — project access alone is not sufficient.

---

## 5. HubSpot Integration

### Private App Setup

1. In HubSpot, go to Settings > Integrations > Private Apps.
2. Create a new Private App with the following **read-only** scopes:
   - `crm.objects.deals.read`
   - `crm.schemas.deals.read`
3. Copy the access token.

### Functions Environment

Create `functions/.env`:

```
HUBSPOT_TOKEN=pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

This file must not be committed to version control.

### Pipeline/Stage IDs

The file `src/hubspotConfig.js` maps HubSpot pipeline and stage IDs to display labels. To obtain these IDs:

1. Call `GET /crm/v3/pipelines/deals` using the HubSpot API or the private app token.
2. Each pipeline object contains `stages` with `id` and `label` fields.
3. Update `hubspotConfig.js` with the relevant IDs for your HubSpot account.

---

## 6. UI / Formatting Conventions

- **No CSS files.** All styling is done with inline styles in JSX.
- **Font:** Times New Roman throughout.
- **Primary color:** `#00C9A7` (teal/green).
- **Icons:** Unicode characters only (no icon libraries).
- Keep all styles co-located with the components that use them inside `App.jsx`.

---

## 7. Access Model

Three tiers of user access, from highest to lowest:

| Role           | Criteria                              | Capabilities                        |
|----------------|---------------------------------------|-------------------------------------|
| **Admin**      | Manually flagged in database          | Full read/write, user management    |
| **Instrumental** | Email ends with `@instrumental.com` | Read/write on assigned projects     |
| **External**   | Any other authenticated user          | Read-only on assigned projects      |

**Commercial access** is independent of the above tiers. An admin must explicitly grant commercial access per user per project via the `commercialAccess` node.

---

## 8. Checklist Templates

Checklist templates are defined in `functions/checklists.js`.

### Standard Projects

- **Internal Checklist** — 6 sections covering internal deployment tasks.
- **External Checklist** — 9 sections covering customer-facing deployment tasks.

### SI (System Integrator) Projects

When the SI toggle is enabled on a project, the standard checklists are replaced with:

- **SI Deployment Checklist** — 13 stages covering the full SI deployment lifecycle.

### Item Schema

Each checklist item contains:

```json
{
  "label": "Task description",
  "checked": false,
  "na": false,
  "ownership": "",
  "dates": { "start": null, "end": null },
  "sopLink": ""
}
```

- `checked` — completion status
- `na` — not applicable flag (skips the item)
- `ownership` — assigned person or team
- `dates` — planned start/end dates
- `sopLink` — URL to the relevant SOP document

---

## 9. Deployment Steps

### Build

```bash
npm run build
```

This produces the `dist/` directory.

### Deploy

Deploy each component individually to control rollout:

```bash
# Database rules
firebase deploy --only database

# Cloud Functions
firebase deploy --only functions

# Hosting (the built frontend)
firebase deploy --only hosting
```

Or deploy everything at once:

```bash
firebase deploy
```

### Post-Deploy: Trigger Migration

After deploying a new schema version, an **admin user** must open the app first. The app detects the current `_schemaVersion` and runs any necessary migration logic before other users access the portal.

---

## 10. Versioning Workflow

Follow this sequence for every release:

1. **Bump the version** in the app source (version constant in `App.jsx`).
2. **Update README.md** with the new version number, changelog entry, and date.
3. **Update any related docs** (e.g., HOW_TO_USE_GUIDE, SECURITY_REVIEW) if behavior changed.
4. **Build** the project (`npm run build`).
5. **Create a zip** of the project for archival: `deployment-portal-v3.2.0.zip`.
6. **Do not auto-deploy.** Deployment is a separate, deliberate step.

---

## Quick Reference: Recreate from Zero

1. `npm create vite@latest deployment-portal -- --template react`
2. `cd deployment-portal && npm install firebase`
3. `firebase init` — select Database, Functions, Hosting; point hosting to `dist/`.
4. Copy `src/App.jsx`, `src/firebase.js`, `src/hubspotConfig.js` into place.
5. Copy `functions/index.js`, `functions/checklists.js` into the functions directory.
6. Run `cd functions && npm install` to install function dependencies.
7. Add `functions/.env` with your HubSpot token.
8. Copy `database.rules.json` to the project root.
9. Update Firebase config in `src/firebase.js` with your project credentials.
10. Update HubSpot IDs in `src/hubspotConfig.js`.
11. `npm run build && firebase deploy`
12. Sign in as admin to trigger schema migration.
