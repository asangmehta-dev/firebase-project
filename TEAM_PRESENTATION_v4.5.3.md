# Deployment Portal — Team Presentation Content

> **How to use this file**: each `## Slide N — Title` section is the content for one slide. Copy/paste into your Google Slides deck (Instrumental themed: green left bar, INSTRUMENTAL footer logo, page number). `[BLANK — ...]` markers are spots I deliberately didn't fill — please add your own content there before presenting.

---

## Slide 1 — What is it & why I built it

**Title:** Deployment Portal — A PMO frontend for Customer Experience

**Subtitle:** React webapp that turns HubSpot into a deployment-management tool

**What it is**
- React 18 web app at https://deployment-portal-instrumental.web.app
- Consolidated PMO-style UI for tracking projects, station kits, shipments, deployment milestones
- Speaks bidirectionally with HubSpot — pulls projects on a schedule, writes back edits instantly

**APIs it connects to**
- HubSpot Custom Objects API (Projects, Shipments, Station Kits, Fleet Assets, CS Programs)
- HubSpot v4 Associations API (kit ↔ fleet asset labeled associations)
- HubSpot Owners API (DRI sync)
- HubSpot Pipelines API (stage Kanban)
- Firebase Realtime Database (data store)
- Firebase Authentication (Google OAuth)
- Anthropic Claude API (in-app Project Bot / chat)
- Slack incoming webhooks (feedback routing)

**Why I built it — friction in using HubSpot alone as the PMO tool**
- Hard to share project documents with external stakeholders (CMs, SIs) without HubSpot licenses
- Not AI-native — no inline Claude-assisted project status drafts or chat
- Challenging UI — HubSpot is CRM-first; project tracking views are clunky to assemble
- No place for non-CRM data (checklists, training materials, internal hardware overrides)

**Two workflows in one UI today**
- **Instrumental Hardware Deployment** — primary workflow (what most of v4.x covers)
- **SI Partner Deployment** — built by Sneha; uses the HubSpot "SI Partner Deployment" pipeline (8 stages: SIRD → DFM → Quote → PO → Build → FAT → SAT → Live), has the `si_admin` role and the All SI Projects view with risk flag / contact / milestones / SI Kanban

---

## Slide 2 — Table of contents

**Title:** What we'll cover

1. What is the Deployment Portal & why I built it
2. Long-term vision (PLM + AI OS + workflow split)
3. Hosting, auth, free vs paid
4. Frontend + backend under the hood
5. Built with Claude Code: workflow, learnings, security, version history
6. Where it fits in the OPS workflow + what to connect next

---

## Slide 3 — Long-term vision

**Title:** Where this goes next

**Vision**
- Build into a **Product Lifecycle Management (PLM) tool** — replace Odoo / Arena for inventory, BOM, and ECO (Engineering Change Order) workflows. Parked v5/v6 backlog.
- Integrate with **Instrumental AI OS** — `[BLANK — Asang to add specific integration vision / endpoints once OS scope is defined]`
- **Need more people to use it** — broader rollout across Instrumental + customers + SIs

**Splitting the Instrumental + SI workflows into separate UIs**
- Today both workflows live in the same app (toggled by role / sidebar tab)
- **Plan:** separate UI experiences — same backend / same data store, but distinct routes and navigation per workflow
- **Why:** the workflows are different enough (different stages, different milestone definitions, different stakeholders) that one merged UI adds confusion. Separating lets each team optimize their view without stepping on the other.
- Sneha owns the SI side; Asang owns the Instrumental side; backend stays shared

**Immediate next steps**
- Adoption push across CX team
- Connect adjacent workstreams (see Slide 7)
- `[BLANK — your fill-in: any other near-term goals]`

---

## Slide 4 — How it's hosted + how auth works

**Title:** Hosting, auth, and what's free vs paid

**Hosting stack**

| Layer | Tech | Cost tier |
|---|---|---|
| Frontend | Firebase Hosting (Vite-built React) | Spark (free) |
| Database | Firebase Realtime Database | Spark (free) |
| Cloud Functions | Firebase Functions (Node 20) | Spark (free) |
| Auth | Firebase Authentication (Google OAuth) | Spark (free) |
| AI Bot | Anthropic Claude API | Pay per token |
| HubSpot | Private App token | Existing HubSpot license |

**When we'd move to paid Firebase (Blaze)**
- Cloud Function invocations exceed Spark's 2M/month free quota
- RTDB storage > 1 GB or simultaneous connections > 100
- Need outbound network from Functions at scale (HubSpot/Claude/Slack calls already need this — verify current quota)
- `[BLANK — current quota usage % from Firebase Console → Usage tab]`

**When we'd move to AWS:** `[BLANK — your fill-in: criteria, e.g., if Firebase outgrows us or company-wide infra mandate]`

**JWT — how auth flows**
- User signs in with Google → Firebase Auth issues a JWT
- Every RTDB read/write + Cloud Function call carries the JWT in the Authorization header
- RTDB security rules (`database.rules.json`) check `auth.uid` + look up the user's role to allow/deny
- Cloud Functions check `context.auth.uid` then re-verify role from `users/{uid}/role`
- Tokens auto-refresh in the browser; no server-side session needed

---

## Slide 5 — Frontend + backend technical details

**Title:** What's under the hood

**Frontend**
- React 18 + Vite
- Single file `src/App.jsx` (~11,000 lines) — to be split as it grows
- State: React `useState` + Firebase RTDB `onValue` listeners (no Redux / Zustand)
- Bundle: ~770 KB main (gzip ~208 KB), code-split into react-vendor + firebase-vendor + xlsx-vendor chunks
- UI: custom CSS-in-JS objects (no Tailwind), Instrumental color palette baked in
- Multi-language UI (English, Español, Tiếng Việt, 繁體中文, 简体中文)

**Backend** (`functions/index.js`, ~85 KB packaged)
- Firebase Cloud Functions (Node 20)
- **20+ callable functions** spanning admin actions, HubSpot sync, writebacks, AI bot, Slack feedback
- HubSpot sync: scheduled Tue/Fri 3 PM PT (`scheduledHubspotSync`) + on-demand (`manualHubspotSync`)
- Writeback CFs: `writeProjectDateToHubspot`, `writeStageToHubspot`, `writeShipmentToHubspot`, `writeStationKitToHubspot`, `writeFleetAssetAssociation`
- Admin callables with audit logging on every sensitive op
- `provisionUser` CF auto-creates @instrumental.com accounts on first sign-in

**Data model**
- `appState/projects/` — project list (synced from HubSpot)
- `appState/docData/{pid}/` — per-project state (projectDetails, hardware tracking, validation, etc.)
- `users/{uid}` — user records + role
- `hubspotSync/log/` — every sync attempt
- `hubspotWriteback/log/` — every writeback attempt
- `auditLog/` — sensitive admin actions

**Database-level access control** (security review v3.0.0 finding)

Rules enforce role + per-project grants at the RTDB layer, not just in the UI. External users physically cannot read other projects.

---

## Slide 6 — How it was built, release workflow, security, version history

**Title:** Built with Claude Code — workflow, learnings, history

**Built with Claude Code (Anthropic)**
- Most of the codebase written via AI pair programming in Claude Code
- Iterative: feature → deploy → test in production → fix → next feature
- 30+ versions shipped April 2026 – June 2026

**Common pitfalls when building with Claude Code (real lessons)**
- **Nested React components defined inside the parent** cause rapid remount/unmount, swallowing local state → always define components at module scope
- **Whole-node DB writes** (e.g. `db.ref('appState/docData/{pid}').set(state.docData[pid])`) can wipe RTDB if local state is partial → write field-level diffs only (v4.5.1 lesson)
- **Hardcoded "first non-X association" heuristics** break when HubSpot reorders schemas → use stable known type IDs as consts (v4.5.2 lesson)
- **Server-side fetches need explicit error handling for HubSpot 429 / 5xx**; otherwise sync silently produces partial data

**Release workflow** (every release)
1. Bump `package.json` version + add row to README version history
2. `npm run build` — verify clean
3. `firebase deploy --only [scoped to changed pieces]`
4. Test in production via Admin Panel → Manual Sync + targeted UI checks
5. Verify RTDB state directly via `firebase database:get`
6. `git commit` with detailed message + co-author tag
7. Build versioned zip into `previous-versions/` for archive
8. `git push origin main`
9. Update auto-memory file with learnings

**Security**
- **Passed security review v3.0.0** (April 2026) — 7 findings addressed in v4.0.0; see `previous-versions/SECURITY_REVIEW_4.0.0.md`
- DB-level access rules (admin / instrumental / external party / explicit grant)
- All admin actions go through Cloud Functions with audit log
- HubSpot tokens stored as Cloud Functions env secrets — never in client
- URL validation: https-only; `javascript:` / `data:` / `file:` schemes blocked
- Backups: Firebase RTDB daily snapshots, 7-day retention (enabled 2026-06-11 after the Sunnyhills data wipe incident)

**Version history — key milestones**
- **v2.x** — Original 4-party portal (parties + checklists + training)
- **v3.0.0** — HubSpot CRM sync (6 pipelines), Projects Overview, **security review passed**
- **v3.1.0** — DB-level access control, Demand Plan, per-pipeline bar charts
- **v3.2.0** — Removed 4-party system, unified Project Details model
- **v3.3.0** — SI Kanban, Gantt chart, AI Project Bot
- **v4.0.0** — Security review response, Project Overview section, hardware override, AI-drafted status
- **v4.1.0** — Sidebar nav, file uploads beyond PDF, **HubSpot date writeback**, All SI Projects, `si_admin` role, scheduled maintenance
- **v4.3.x** — Audit Log browser, Slack feedback, multi-object schema diagnostic, **MES Integration Checklist** template
- **v4.4.x** — Stage 6A Shipment Details writeback + direct Project↔Shipment association sync fix
- **v4.5.x** (current) — Stage 6B Kit + Fleet Asset writeback, pd_station_kits auto-sync, **pd_team DRI sync** from HubSpot Owners, critical save() data-safety fix

**Links for the team**
- App: https://deployment-portal-instrumental.web.app
- Repo: https://github.com/asangmehta-dev/firebase-project
- How-to-use: `HOW_TO_USE_GUIDE_4.5.3.md` and `HOW_TO_USE_GUIDE_4.1.0.md`
- Full per-version detail: `README.md`

---

## Slide 7 — OPS workflow integration

**Title:** Where this fits in the OPS workflow + what's next to connect

**Where this webapp sits in the Lucidchart OPS workflow**

The webapp acts as the **frontend layer** for several of the HubSpot custom objects in the diagram:
- **Projects** (the 5 project types) → read + write project metadata, dates, stages
- **Station Kits** + **Fleet Assets** → bidirectional sync for SNs, kit-level fields, and hardware tracking
- **Shipments** (`Auto trigger workflow` to/from Station Kits) → read INxxx + write back shipment edits
- **CS Programs** (Kickoff → Onboarding → Final Value Complete → Program Terminated) → `[BLANK — Asang to fill in: which CS Program data flows into the webapp vs stays HubSpot-only]`
- **SalesHub Deals** → `[BLANK — currently no integration; possible future]`

> **Annotation suggestion for the embedded Lucidchart**: draw a labeled box around **Projects + Station Kits + Shipments + Fleet Assets** and label it **"Deployment Portal (this webapp)"** — those are the 3 object families it currently reads/writes.

**Workstreams to connect next**

| Workstream | Owner | Status | What to connect |
|---|---|---|---|
| Cert / learning platform | Michael | `[BLANK]` | `[BLANK — Asang to add platform name, endpoints, what data we want shared]` |
| Customer tracking process | Amy | `[BLANK]` | `[BLANK — Asang to add what Amy tracks today + where it lives]` |
| Amplitude success metrics | `[BLANK — owner]` | Not started | Track: project opens, manual syncs triggered, writeback success rate, AI bot queries, time-to-first-edit per project, user activation by role |
