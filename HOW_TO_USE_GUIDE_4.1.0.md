# Deployment Portal — How to Use Guide

**Version:** v4.1.0
**Audience:** Customer Experience team + external stakeholders

---

## What's new in v4.1.0

- **Sidebar navigation for Project Details** — all project tabs (Design Specs, CAD, Checklists, etc.) are now listed as collapsible sub-items in the left sidebar. No more horizontal tab bar — just click the category directly from the nav.
- **External users now see three categories**: Design Specifications & Integration Docs, CAD & Drawings, and Hardware & MES Deployment Requirements. Everything else remains Instrumental-only.
- **Non-PDF file uploads** — the upload button now accepts DOCX, XLSX, PPTX, CSV, images, and `.lbx` label files in addition to PDFs (50 MB cap). Each file type shows its own icon.
- **Gantt chart toggle** — "📊 Show Gantt Chart" button on each project's Overview. Disabled with a tooltip if fewer than 3 dates/milestones are available.
- **HubSpot project links** — 🔗 icon next to every project name in Overview, Manage Projects, and All Projects; opens the HubSpot record in a new tab.
- **Date writeback to HubSpot** — editing CAD Complete, CAD Actual Finish, Actual Service Start, Target Build, or Actual Deploy in Project Overview now patches HubSpot automatically on save. The header shows `↑ Syncing…` → `✓ HubSpot updated` or `⚠ HubSpot writeback failed — saved locally` if the API call errors.
- **All SI Projects view** — new sub-tab under All Projects Overview, visible to all Instrumental users, editable by SI Admins. Shows risk flag, last contact, next milestone, and notes per SI Partner Deployment project.
- **`si_admin` role** — grants edit access to the SI tracker without full admin powers.
- **Pre-uploaded deployment requirement docs** — 10 standard Instrumental documents (installation guides, site readiness specs, MES questionnaire, etc.) auto-appear in every project's "Hardware & MES Deployment Requirements" folder on first open.
- **Scheduled maintenance** — automatic cleanup runs Tue & Fri at 3 PM PT; results visible in Admin Panel → 🔧 Maintenance.

---

## Logging in

1. Go to https://deployment-portal-instrumental.web.app/
2. Click **Sign in with Google**.
3. What happens next:
   - **@instrumental.com** → auto-provisioned, immediate access to all projects.
   - **Other email** → placed in pending queue until an admin approves you.

---

## Sidebar navigation

| Item | What it shows | Who |
|---|---|---|
| 🌐 All Projects Overview | Demand plan, pipeline bar charts | Instrumental |
| &nbsp;&nbsp;&nbsp;🤝 All SI Projects | SI tracker + Kanban (sub-tab) | Instrumental (edit: SI Admin) |
| ⊙ Overview | Per-project landing: stats, dates, hardware, Gantt | Everyone with project access |
| 📋 Project Details ▾ | Expands to list all categories | Everyone |
| &nbsp;&nbsp;&nbsp;📁 Design Specs & Integration Docs | Specs, integration, validation | Everyone |
| &nbsp;&nbsp;&nbsp;📁 CAD & Drawings | CAD files and drawings | Everyone |
| &nbsp;&nbsp;&nbsp;📁 Hardware & MES Deployment Req. | Pre-uploaded Instrumental docs | Everyone |
| &nbsp;&nbsp;&nbsp;📊 Station Kits, Camera Settings, etc. | Editable data tables | Instrumental only |
| &nbsp;&nbsp;&nbsp;📋 Internal / External / SI Checklist | Task checklists with progress | Instrumental (external: read-only) |
| 📂 Commercial | Agreements, pricing, legal (restricted) | Granted by admin |
| 🎓 Training | Belt assignments + materials | Everyone |
| 💬 AI Chat | Conversational assistant scoped to your projects | Everyone |
| ⊞ Admin Panel | Users, access, HubSpot sync, maintenance | Admin only |
| ⊕ Manage Projects | Project list + SI toggle | Admin only |

Click the **▾ / ▸** chevron next to "Project Details" (or "All Projects Overview") to collapse/expand the sub-items.

---

## Project Details categories

When you click a sub-item in the sidebar, the main area jumps directly to that category — no scrolling needed.

**Instrumental users** see all categories in this order:
1. Editable data tables (Station Kits, In-Factory Install, Camera Settings, LED Settings, SOP Plan, MES Station Plan, Serialization, SKU Configs, Shipment Details, Team)
2. Folders (Design Specs, Program Docs, CAD & Drawings, Hardware & MES Deployment Req., Reference Info)
3. Checklists (Internal, External, or SI Deployment)

**External users** see only: Design Specs & Integration Docs · CAD & Drawings · Hardware & MES Deployment Requirements.

---

## Hardware & MES Deployment Requirements folder

10 Instrumental-standard documents auto-appear in this folder for every project on first open:
- Self-Deploy Main Installation Document
- Internet Requirements
- Station Space Requirements
- MES Questionnaire v4
- Network Requirements (OPS-00003)
- Facility Requirements Intro Slides (OPS-00004)
- Site Readiness Spec (APAC / EU / US)
- Regional Power Slides

These are shared master files — the same file across all projects. External users with project access can open/download them. Instrumental users can delete them per-project (they won't come back). To replace one with a project-specific version, upload a file with the same name — the manual upload takes display priority.

---

## Uploading files

The "📎 Upload File" button (was "Upload PDF") now accepts:

| Type | Extensions |
|---|---|
| PDF | .pdf |
| Word | .doc, .docx |
| Excel | .xls, .xlsx |
| PowerPoint | .ppt, .pptx |
| Images | .png, .jpg, .gif |
| Text / CSV | .txt, .csv |
| Label files | .lbx (Brother P-touch / Brady Workstation) |

50 MB cap retained. External users can **view/download** files but cannot upload or delete.

---

## Project Overview (⊙ Overview)

**Date fields — now sync to HubSpot:**

| Field | Source |
|---|---|
| CAD Complete Date | Webapp → HubSpot on save |
| CAD Actual Finish Date | Webapp → HubSpot on save |
| Actual Service Start Date | Webapp → HubSpot on save |
| Target Build Date | Webapp → HubSpot on save |
| Actual Deploy Date | Webapp → HubSpot on save |
| Target Build Date at Deal Close | HubSpot pull-only (read-only) |
| Associated CS Program ID | HubSpot pull-only (read-only) |
| Project Status & Next Steps | Webapp / Bot-drafted |

Click **✎ Edit**, change dates, then **Save**. The header briefly shows `↑ Syncing…` then `✓ HubSpot updated`. If HubSpot is unreachable the local change still saves and you'll see `⚠ HubSpot writeback failed — saved locally`.

**Gantt chart:** click "📊 Show Gantt Chart" below the date fields. Button is greyed out and shows "Need at least 3 dates/milestones" if fewer than 3 dated items exist across the project.

---

## All SI Projects view

Accessible from the sidebar: **All Projects Overview → 🤝 All SI Projects**.

Shows only projects in the SI Partner Deployment HubSpot pipeline. At the top: the SI Kanban by stage. Below: a per-project tracker table.

**What SI Admins can edit per project:**
- Risk flag: 🟢 Healthy / 🟡 Watch / 🔴 At-risk
- Last contact date
- Next milestone
- Notes (free text)

Click **✎** on any row to edit, **Save** to persist. Changes write to `appState/siTracker/{projectId}` in Firebase.

**Who sees what:**
- All `@instrumental.com` users: read-only view
- SI Admin or Admin: edit access
- External users: this view is not visible

---

## Admin Panel additions

### 🔧 Maintenance tab (new)

Shows:
- **Active alerts** — rules that fired on the last maintenance run (color-coded: yellow = warn, red = critical)
- **Last run summary** — timestamp, duration, tasks completed, alerts fired, and a per-task log
- **"Run Maintenance Now"** button — triggers the same routine as the scheduled run immediately

**What the maintenance run does:**
1. Deletes `hubspotSync/log` entries older than 30 days
2. Deletes `auditLog` entries older than 90 days
3. Deletes `hubspotWriteback/log` entries older than 30 days
4. **Rule 1**: alerts if > 2 open bugs are logged in `bugs/log`
5. **Rule 2**: alerts if > 10% of syncs in the last 24 h errored
6. **Rule 3**: auto-pauses the scheduled sync if the last 3 consecutive scheduled syncs all failed (circuit breaker — requires admin to manually re-enable)

Runs automatically every Tuesday and Friday at 3 PM PT.

### 🔄 HubSpot Sync tab — new diagnostic

A new **"🔍 HubSpot Property Schema"** card fetches all property internal names, types, and labels from HubSpot for the custom Projects object. Use it to verify the internal names used by the date writeback feature (e.g. `cad_complete_date__c`). If property names differ, update the `HUBSPOT_DATE_PROPS` constant in `functions/index.js` and redeploy.

### Roles

A new **SI Admin** role is available in the "Set Role" dropdown in Admin Panel → User Access. SI Admin can edit the All SI Projects tracker but has no extra power on regular projects.

---

## HubSpot project links

Every project name in these views now has a 🔗 icon:
- ⊙ Overview header
- ⊕ Manage Projects rows
- 🌐 All Projects Overview pipeline breakdown
- 🤝 All SI Projects tracker

Click the icon to open the project's HubSpot record in a new tab.

---

## AI features

| Surface | Where | Who |
|---|---|---|
| 🤖 Project Bot (floating) | Every project page | Instrumental |
| 🤖 Global Search Bar | Sticky at top of main area | Instrumental |
| 💬 AI Chat tab | Sidebar | Everyone (scoped to user's projects) |
| 🤖 Ask Bot to draft | Project Overview → Project Status box | Instrumental |

All powered by Claude Sonnet 4.

---

## Sign-out & session

- "Remember me" at sign-in → 72-hour session.
- Unchecked → 5-minute idle timeout.
- Sign out via the sidebar footer.
