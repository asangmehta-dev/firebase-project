# How to Use — Deployment Portal v3.1.0
**Audience:** Instrumental team (admins + users)
**Last updated:** 2026-04-13

# Vision
The goal of this Webapp is to have a consolidated "PMO" Style frontend UI that the Customer Experience team can use to track and proactively manage risks / issues with CMs/ customers. This speaks directly to HubSpot and provides real time information on all projects in the deployment and sales pipeline.

---

## What's New in v3.1.0

| Change | Who's affected |
|--------|---------------|
| **Database-level access control** — external users (Customer/SI/CM) can now only read data for projects they've been assigned to, enforced at the Firebase Realtime Database rules level (not just UI) | All external users |
| **UI access control fix** — non-Instrumental users' project dropdown now strictly filters to the active projects their admin assigned them | Customer/SI/CM users |
| **Admin assign UI** — now only shows active projects when an admin assigns projects to a user | Admins |
| **Demand Plan** on Projects Overview — aggregated hardware requirements across all active projects, with support for custom manual types | Instrumental/admins |
| **Per-pipeline bar charts** on Projects Overview — visual distribution of active projects across each pipeline's stages | Instrumental/admins |
| **Per-project hardware section** on Overview — HubSpot-synced hardware values are now shown read-only per project; Instrumental users can add custom manual hardware types (counts per project) | Instrumental/admins |
| **"Active Projects Only" badges** throughout Projects Overview — the entire tab is now filtered to active projects (closed/cancelled excluded) | Instrumental/admins |

> **Important nomenclature:** "Projects Overview" (sidebar 🌐 button, Instrumental/admin only) is a summary of **all** projects across pipelines. It is distinct from the per-project "Overview" dashboard (⊙ button) which shows a single selected project.

---

## Table of Contents

1. [Signing In](#1-signing-in)
2. [Navigating the Sidebar](#2-navigating-the-sidebar)
3. [Projects Overview (All Projects Summary)](#3-projects-overview)
4. [Project Dashboard (Per-Project Overview)](#4-project-dashboard)
5. [Per-Project Hardware Section (New in v3.1)](#5-per-project-hardware-section)
6. [Document Folders & Checklists](#6-document-folders--checklists)
7. [Checklist Milestones](#7-checklist-milestones)
8. [Program Details](#8-program-details)
9. [HubSpot Sync](#9-hubspot-sync)
10. [Admin Panel](#10-admin-panel)
11. [Managing Projects](#11-managing-projects)
12. [Training Section](#12-training-section)
13. [Multi-Language Support](#13-multi-language-support)
14. [Roles & Access Summary](#14-roles--access-summary)
15. [FAQ & Troubleshooting](#15-faq--troubleshooting)

---

## 1. Signing In

1. Go to **https://deployment-portal-instrumental.web.app/**
2. Click **Sign in with Google** — use your work Google account
3. Check **Remember me for 72 hours** if you don't want to re-login on every browser session

**@instrumental.com users:** Automatically approved as Instrumental on first sign-in. Admin role must be granted separately by the SuperAdmin.

**All other users:** You'll see "Access Pending" until an admin approves you and assigns you to one or more **active** projects.

---

## 2. Navigating the Sidebar

| Element | What it does |
|---------|-------------|
| **🌐 Projects Overview** | (Instrumental/Admin only) Summary of all active projects across pipelines |
| **Project dropdown** | Select the active project you're working in. **v3.1 change:** External users only see projects they've been explicitly assigned to; non-instrumental users only see **active** projects. |
| **⊙ Overview** | Per-project dashboard — party cards, milestone progress, customer view, and the new Hardware section |
| **Party sections** (◉ ◈ ◆ ◇) | Jump to Instrumental / SI / Customer / CM document folders |
| **⊞ Admin Panel** | (Admin only) User management, HubSpot sync, restricted folder access |
| **⊕ Manage Projects** | (Admin only) Create/edit projects, apply checklist templates |
| **Language selector** | Switch UI language |
| **Sign Out** | Bottom of sidebar |

> **v3.1 security note:** If an external user tries to navigate (via URL manipulation or stale browser state) to a project they aren't assigned to, they will now see "Access denied — you are not assigned to this project." The database also rejects unauthorized reads.

---

## 3. Projects Overview

*Instrumental users and admins only. Click **🌐 Projects Overview** in the sidebar.*

**This tab shows ACTIVE projects only.** Closed, cancelled, and lost-stage projects are excluded throughout the tab. A green badge at the top confirms the active-only filter.

### Sections on this tab (v3.1 layout):

#### 3.1 Demand Plan
Aggregated hardware requirements across all active projects.

- **HubSpot-sourced rows** — automatically totaled from HubSpot fields (Cameras, Lenses Regular/TC, LED Controllers, Frames, Computers, Monitors, Barcode Scanners). These are read-only in the app. To correct a value, edit the source in HubSpot and wait for the next sync.
- **Manual (custom) rows** — any Instrumental user can add custom hardware types (e.g., "GPU Modules") via the input at the bottom of the table. Per-project counts for custom types are entered from each project's Overview page (Section 5).

#### 3.2 Pipeline Stage Distribution (Bar Charts)
One bar chart per pipeline (Hardware, Data Source, MES, Station Return, Image Source, Data Analytics).

- X-axis: pipeline stages (active stages only — closed stages excluded)
- Y-axis: count of active projects in that stage
- Only shown if the pipeline has at least one active project
- Clear "active" badge displays total active project count per pipeline

#### 3.3 Projects by Stage (Detailed List)
Same as v3.0.0, but **now filtered to active projects only**. Select a pipeline from the tabs to drill in. The Inactive/Closed section has been removed from this tab — those projects no longer appear here at all.

---

## 4. Project Dashboard

Select a project from the dropdown and click **⊙ Overview**. This is the **per-project** dashboard (distinct from the all-projects Projects Overview described above).

### For Instrumental / Admin users:
- **Status Banner** (admin only) — broadcast message shown to all users
- **Party cards** — click any card to jump to that party's folder view
- **Station count editor** (admin only)
- **Customer View** preview — what the customer sees
- **Hardware section** (new in v3.1) — see Section 5

### For Customer users:
- Station count and key milestone dates
- Hardware section is not shown (Instrumental-only)

### For SI / CM users:
- Overview is not shown. Users go directly to their party's document folders via the sidebar.

---

## 5. Per-Project Hardware Section

*New in v3.1. Visible only to Instrumental users and admins on each project's Overview tab.*

### HubSpot-synced (read-only)
Shows all hardware quantities synced from HubSpot for this project — Cameras, Lenses, LED Controllers, Frames, Computers, Monitors, Barcode Scanners. Values are displayed as numbers parsed from HubSpot (original text shown underneath if different).

> **Important:** These values are **read-only by design**. HubSpot is the source of truth for hardware data. If you see a discrepancy, fix it in HubSpot — the next sync (auto or manual) will update the app.

### Custom / Manual hardware
For hardware types that aren't tracked in HubSpot, any Instrumental user can:
1. Define the type at Projects Overview → Demand Plan → "+ Add Type"
2. Set the per-project count from that project's Overview → Hardware → Custom section

Custom types are **never overwritten by HubSpot sync**. They feed into the Demand Plan totals automatically.

---

## 6. Document Folders & Checklists

Same as v3.0.0. External users can only access their own party's folders, and (new in v3.1) can only access folders for projects they've been assigned to — enforced both in UI and at the database level.

---

## 7. Checklist Milestones

Same as v3.0.0.

---

## 8. Program Details

Same as v3.0.0.

---

## 9. HubSpot Sync

Same as v3.0.0. Admin Panel → 🔄 HubSpot Sync tab. Preview, then Confirm & Apply.

**v3.1 storage change:** Projects are now stored in the database as an object keyed by project ID (previously an array). The Cloud Function handles this automatically. The app-side also migrates existing array-shaped data to object-shape on the first admin login after v3.1.0 is deployed. A backup of pre-migration state is written to `_backup/pre_v3_1_0_projects` in the database.

---

## 10. Admin Panel

### Pending tab
**v3.1 change:** The project-selection list on the approval form now shows **only active projects**. Deprecated/inactive projects can't be assigned to new users.

### User Access tab
**v3.1 change:** The "+ Add project" dropdown for existing external users also only shows active projects now.

**v3.1 behind-the-scenes:** When an admin approves an external user or assigns them a project, the app writes an entry to the `access/` map in the database. This is what the new per-project database rules check. Removing a user or un-assigning a project cleans up the map automatically.

### HubSpot Sync tab
Same as v3.0.0.

### Restricted Folders tab
Same as v3.0.0.

---

## 11. Managing Projects

Same as v3.0.0.

---

## 12. Training Section

Same as v3.0.0.

---

## 13. Multi-Language Support

Same as v3.0.0.

---

## 14. Roles & Access Summary

| Role | Who | Can Do |
|------|-----|--------|
| **SuperAdmin** | One designated person (`superAdmin: true` in DB) | Everything an Admin can do + promote others to Admin |
| **Admin** | Explicitly granted by SuperAdmin | Full read/write, user management, HubSpot sync, all parties, all projects |
| **Instrumental User** | @instrumental.com auto-approved | Overview + all party docs + edit checklists/folders/milestones + add custom hardware types, edit per-project custom hardware counts |
| **Customer** | Approved externally | Customer dashboard (stations + milestones) + Customer docs **for assigned projects only** |
| **SI** | Approved externally | SI docs **for assigned projects only** |
| **CM** | Approved externally | CM docs **for assigned projects only** |

**v3.1 key difference:** External users (Customer/SI/CM) are now restricted at the database level to projects they've been assigned to — not just in the UI. Attempting to read unauthorized data results in a permission-denied error from Firebase.

---

## 15. FAQ & Troubleshooting

**Q: I'm an external user and my project disappeared from the dropdown after v3.1.0 was deployed**
The v3.1.0 rollout triggers a one-time migration on the first admin login that populates an access-control map in the database. If you loaded the app before an admin did, you may see an empty list temporarily. Ask an admin to open the app once, then refresh your page.

**Q: I can't edit a HubSpot-synced hardware value**
This is intentional. HubSpot is the source of truth. Edit the value in HubSpot and wait for the next sync. Auto-sync runs Tuesday and Friday at 9am PDT; admins can trigger manual sync from the Admin Panel.

**Q: I added a custom hardware type but the Demand Plan total is 0**
The total only counts per-project quantities. Go to each project's Overview → Hardware → Custom section and set the count for that project. Totals update immediately.

**Q: The bar chart for a pipeline is missing**
Bar charts only render for pipelines with at least one active project. If all projects in that pipeline are closed/cancelled, no chart is shown.

**Q: Why can external users still see the project name in the sidebar even though they're not assigned?**
They can't. External users only see projects in their `user.projects` list in the sidebar dropdown, and the database rules reject unauthorized reads of other projects. If you see a user seeing a project they shouldn't, verify their assignment in Admin Panel → User Access.

**Q: What happens if I un-assign a project from an external user while they're logged in?**
Their next data read from that project will fail with a permission-denied error and the app will show "Access denied". They may need to refresh to reset the UI state.

**Q: Why did the "Inactive / Closed" section disappear from Projects Overview?**
v3.1.0 moves the entire Projects Overview tab to active-only. Closed/cancelled projects are still accessible via the per-project Overview dashboard (if they're in the dropdown) but are excluded from all aggregate views. To see historical projects, go to Manage Projects → Past section.

**Q: Common questions from v3.0.0 that still apply**
- Pending approval, assigning users to projects, HubSpot sync flow, codename mapping, Auto-sync schedule — all same as v3.0.0.
