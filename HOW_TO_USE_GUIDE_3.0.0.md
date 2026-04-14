# How to Use — Deployment Portal v3.0.0
**Audience:** Instrumental team (admins + users)
**Last updated:** 2026-04-10

---

#Vision 
The goal of this Webapp is to have a consolidated "PMO" Style frontend UI that the Customer Experience team can use to track and proactively manage risks / issues with CMs/ customers. This will directly speak to Hubspot and provide real time information on all projects in the deploment and sales pipeline 

## Table of Contents

1. [Signing In](#1-signing-in)
2. [Navigating the Sidebar](#2-navigating-the-sidebar)
3. [Projects Overview (New in v3)](#3-projects-overview)
4. [Project Dashboard](#4-project-dashboard)
5. [Document Folders & Checklists](#5-document-folders--checklists)
6. [Checklist Milestones](#6-checklist-milestones)
7. [Program Details](#7-program-details)
8. [HubSpot Sync (New in v3)](#8-hubspot-sync)
9. [Admin Panel](#9-admin-panel)
10. [Managing Projects](#10-managing-projects)
11. [Training Section](#11-training-section)
12. [Multi-Language Support](#12-multi-language-support)
13. [Roles & Access Summary](#13-roles--access-summary)
14. [FAQ & Troubleshooting](#14-faq--troubleshooting)

---

## 1. Signing In

1. Go to **https://deployment-portal-instrumental.web.app/**
2. Click **Sign in with Google** — use your work Google account
3. Check **Remember me for 72 hours** if you don't want to re-login on every browser session

**@instrumental.com users:** You are automatically approved and added as an Instrumental user on first sign-in. An admin must explicitly grant you the Admin role if needed.

**All other users:** After signing in you'll see an "Access Pending" screen. An admin must approve your request and assign you to a project and party.

---

## 2. Navigating the Sidebar

The left sidebar contains everything you need to navigate:

| Element | What it does |
|---------|-------------|
| **🌐 Projects Overview** | (Instrumental/Admin only) See all HubSpot projects across all pipelines |
| **Project dropdown** | Select the active project you're working in |
| **⊙ Overview** | Dashboard view — party cards, milestone progress, customer view |
| **Party sections** (◉ ◈ ◆ ◇) | Jump to Instrumental / SI / Customer / CM document folders |
| **⊞ Admin Panel** | (Admin only) User management, HubSpot sync, restricted folder access |
| **⊕ Manage Projects** | (Admin only) Create/edit projects, apply checklist templates |
| **Language selector** | Switch UI language (EN / ES / VI / 繁 / 简) |
| **Sign Out** | Bottom of sidebar |

> **Tip:** The project dropdown only shows active and past (deprecated) projects. HubSpot-imported inactive/closed-stage projects are intentionally hidden from the dropdown to keep it clean.

---

## 3. Projects Overview

*Instrumental users and admins only.*

Click **🌐 Projects Overview** in the sidebar (above the project dropdown).

### Pipeline tabs
Click any pipeline tab at the top to filter:
- **Deploy** — Hardware Deployment Pipeline
- **Data Source** — Data Source Deployment Pipeline
- **MES** — MES Integration Pipeline
- **Return** — Station Return
- **Image Source** — Image Source Deployment Pipeline
- **Analytics** — Data Analytics

Each tab shows a green badge with the count of active projects in that pipeline.

### Stage groups
Projects are shown grouped by their HubSpot stage:

- **Active Projects** — stages that are open (not closed) in HubSpot, shown prominently in green
- **Inactive / Closed** — completed/cancelled/lost stages, shown greyed out below. Only stages with projects are shown in the inactive section.

### Project cards show:
- **Customer name** (decoded from HubSpot codename — e.g. "gobstoppers" → "Google")
- **SI name** if applicable
- **SI badge** (blue) if the project has `[SI]` in the HubSpot name
- **Station count** if set

> **Note:** If you see "No projects synced from this pipeline yet" — run the HubSpot Sync from Admin Panel first.

---

## 4. Project Dashboard

Select a project from the dropdown and click **⊙ Overview**.

### For Instrumental / Admin users:
- **Status Banner** — admin-editable broadcast message shown to all users (click ✎ Edit)
- **Party cards** (Instrumental, SI, Customer, CM) — click any card to jump directly to that party's folder view. Shows folder count, document count, and milestone progress %
- **Station count editor** — click ✎ Edit next to the station count to update it
- **Customer View** — preview of what the customer sees: station count + key milestones from Program Details

### For Customer users:
- Station count for the project
- Key milestone dates (pulled from Program Details)

---

## 5. Document Folders & Checklists

Click any party section in the sidebar (e.g. **◉ Instrumental**) to see that party's folders.

### Folder types:
| Icon | Type | Description |
|------|------|-------------|
| 📁 | Standard folder | Links and PDFs |
| ☑ | Checklist Milestones | Milestone tracking with checklists, signatures, and linked resources |
| 📋 | Program Details | Tasks and milestone timeline |
| 🔒 | Restricted | Admin must grant you explicit access |

### For Instrumental users (editing enabled):
- **+ Add Folder** — create a new folder (Open or Restricted access)
- **+ Add Link or PDF** — add a document to any open folder
- **Delete Folder** — remove a folder (cannot be undone)
- **Drag milestones** — reorder checklist milestones by dragging

### For external party users (SI, Customer, CM):
- Read-only access to open folders in their own party section
- Restricted folders show a 🔒 icon with "contact admin for access"

---

## 6. Checklist Milestones

Checklist folders (☑) contain milestone groups. Each milestone has:

### Checklist items
- Click any checklist item to toggle it checked/unchecked
- The milestone header shows **% complete** and the done/total count
- **Instrumental users:** Click the pencil icon (✎) next to a description or checklist label to edit it inline — press Enter or click away to save

### Adding / removing items (Instrumental users only)
- Expand a milestone, scroll to the bottom, type in the "Add a checklist item..." box and press Enter or click **+ Add Item**
- Click **✕** next to any item to delete it

### Linked Resources
- Attach reference links to any milestone (e.g. design doc, test report)
- Click **+ Add Link** and fill in the name and URL

### Signatures
- Each milestone has a signatures section for formal sign-off
- Click the signature row to toggle it signed (records your name + timestamp)
- Admins can add new signature roles or delete existing ones

### Checklist templates (HubSpot-imported projects)
New projects imported from HubSpot automatically receive:
- **Non-SI projects:** Internal Checklist (7 sections) + External Checklist (8 sections)
- **SI projects** (name contains `[SI]`): SI Deployment Checklist (13 pipeline stages)

For existing projects, go to **Manage Projects** and click **☑ Apply Checklist** to apply the template.

---

## 7. Program Details

Found inside the 📋 Program Details folder (inside Instrumental or Customer party folders).

### Adding tasks and milestones
1. Click **+ Add Task / Milestone**
2. Choose **📋 Task** (has start + end dates) or **🏁 Milestone** (single date)
3. Fill in the name and date(s), then click **Add**

### Reordering
Drag any row by the ⠿ handle to reorder.

### Key Milestones on Customer Dashboard
Any items marked as **Milestone** type automatically appear in:
- The Customer dashboard (visible to external customer users)
- The "Customer View" section of the Instrumental dashboard

### RACI & Program Documents
Below the task list, add links to RACI matrices, program plans, or other docs via **+ Add Document**.

---

## 8. HubSpot Sync

*Admin only.*

Go to **⊞ Admin Panel → 🔄 HubSpot Sync tab**.

### How it works
1. **Click "▶ Run Preview Sync"** — this fetches all projects from all 6 HubSpot pipelines and shows you a preview. Nothing is changed in the webapp yet.
2. **Review the preview list** — see how many projects were found, their status (active/inactive), and which pipeline they belong to.
3. **Click "✓ Confirm & Apply"** — this writes the projects to the webapp. New projects get checklist templates auto-applied. Existing projects are updated (name, stage, status) but their documents and checklists are preserved.

### Automatic sync schedule
Once Cloud Functions are deployed, sync runs automatically:
- **Every Tuesday at 9am PDT**
- **Every Friday at 9am PDT**

No action needed — the last sync time is shown at the top of the HubSpot Sync tab.

### What gets synced
| Field | Source |
|-------|--------|
| Project name | `project_name` HubSpot property |
| Customer name | Decoded from `company_codename` (candy → real name) |
| Pipeline | `hs_pipeline` |
| Stage / Status | `hs_pipeline_stage` → active (open stage) or inactive (closed stage) |
| Station count | `number_of_stations__c` or parsed from project name |
| SI flag | `[SI]` prefix in project name |
| Checklist template | Auto-applied to new projects only |

### What does NOT get overwritten
- Documents and links you've added manually
- Checklist items and their checked state
- Signatures
- Program Details tasks and milestones
- Party names you've customized

---

## 9. Admin Panel

*Admin only — click ⊞ Admin Panel in sidebar.*

### Tabs:

#### Pending
New users who signed in but haven't been approved yet. For each pending user:
1. Select their **party** (Customer, SI, or CM — not Instrumental)
2. Check which **projects** they should have access to
3. Click **✓ Approve** or **Deny**

#### User Access
Shows all approved users in three sections:
- **Admins** — full read/write access to everything
- **Instrumental Users** — @instrumental.com users with edit access to docs/checklists
- **External Users** — Customer, SI, or CM users with read-only access

Actions available:
- **⬆ Admin** — promote an Instrumental user to Admin (SuperAdmin only)
- **Remove** — revoke access (also disable in Firebase Auth Console for immediate effect)
- **Projects** — add or remove project access for external users

#### 🔄 HubSpot Sync
See [Section 8](#8-hubspot-sync) above.

#### Restricted Folders
Grant external users access to folders marked as "Restricted". Click a user's name button to toggle their access on/off for each restricted folder per project.

---

## 10. Managing Projects

*Admin only — click ⊕ Manage Projects in sidebar.*

### Creating a new project
1. Click **+ New Project**
2. Choose **Active** or **Past / Deprecated**
3. Fill in: Project Name, Customer, Systems Integrator, Contract Manufacturer, Station Count
4. Click **Create Active Project**

> **Note:** Projects imported from HubSpot via sync appear here automatically. Manually created projects do not appear in HubSpot (this is one-way sync: HubSpot → webapp).

### Editing a project
Click **✎ Edit** on any active project card to:
- Rename any party display name (e.g. rename "Customer" to the actual customer name)
- Update station count

### Applying checklist template
Click **☑ Apply Checklist** on any active project to add the appropriate checklist template. This is safe to run on existing projects — it will only add folders that don't already exist.

### Archiving / Reactivating
- **↓ Archive** — moves project to "Past" section; it stays in the dropdown with "(Past)" label
- **↑ Reactivate** — moves it back to active

### Bulk import past projects
Click **📋 Bulk Import** in the Past section and paste a CSV with format:
```
Name, Customer, SI, CM, Doc Link
```

---

## 11. Training Section

Each party folder (Instrumental, SI, Customer, CM) has a **Training** section at the bottom of the folder view.

### For Instrumental users (Admins):
1. **Enable Training** — toggle the switch to enable for a party
2. Add training materials organized by belt level:
   - ○ **White Belt** — introductory materials
   - ◐ **Blue Belt** — intermediate
   - ● **Black Belt** — advanced
3. Click **N/A** to mark a belt level as not applicable for this party
4. **+ Add Training Material** — enter a title and URL for each resource

### For external users:
- Training materials appear as clickable links organized by belt level
- If training is disabled for their party, they see "Training is not required"

---

## 12. Multi-Language Support

The UI supports 5 languages. Switch using the **Language** dropdown at the bottom of the sidebar:

| Flag | Language |
|------|----------|
| 🇺🇸 | English (US) — default |
| 🇪🇸 | Español |
| 🇻🇳 | Tiếng Việt |
| 🇹🇼 | 繁體中文 |
| 🇨🇳 | 简体中文 |

Your language preference is saved to your profile and persists across sessions.

> **Note:** Project names, customer names, and user-entered content are not translated — only the UI labels.

---

## 13. Roles & Access Summary

| Role | Who | Can Do |
|------|-----|--------|
| **SuperAdmin** | One designated person (`superAdmin: true` in DB) | Everything an Admin can do + promote others to Admin |
| **Admin** | Explicitly granted by SuperAdmin | Full read/write, user management, HubSpot sync, all parties |
| **Instrumental User** | @instrumental.com auto-approved, assigned by admin | Overview + all party docs + edit checklists/folders/milestones |
| **Customer** | Approved externally | Customer dashboard (stations + milestones) + Customer docs |
| **SI** | Approved externally | SI docs only |
| **CM** | Approved externally | CM docs only |

**Key difference in v3.0.0:** Instrumental users (non-admin) now have edit access to documents and checklists. Previously only Admins could edit.

---

## 14. FAQ & Troubleshooting

**Q: I signed in but I see "Access Pending"**
An admin needs to approve your account. Contact your Instrumental project manager.

**Q: I can see the portal but can't see my project**
An admin needs to assign you to the project. They can do this in Admin Panel → User Access → find you → click "Edit" → Add Project.

**Q: The Projects Overview shows no projects**
The HubSpot sync hasn't been run yet. An admin needs to go to Admin Panel → HubSpot Sync → Run Preview Sync → Confirm & Apply.

**Q: A project shows as "active" in HubSpot but "inactive" in the portal**
The sync maps closed HubSpot pipeline stages to `status: inactive`. If the project is in a stage marked as "closed" in HubSpot, it will be inactive in the portal even if work is ongoing. An admin can manually override the status in Manage Projects.

**Q: I applied a checklist template but the wrong one was applied**
SI detection is based on `[SI]` in the HubSpot project name. If the project name is missing this prefix, it will get the non-SI template. Contact admin to manually add/remove the appropriate milestone folders.

**Q: The auto-sync didn't run**
Scheduled Cloud Functions require the Firebase project to be on the Blaze (pay-as-you-go) plan and for functions to be deployed. Check Admin Panel → HubSpot Sync to see the last sync time and any errors.

**Q: I can't edit a checklist item**
Only Instrumental users (partyId: instrumental) and Admins can edit. If you're signed in as a Customer/SI/CM user, you have read-only access.

**Q: How do I add a new Instrumental team member?**
They sign in with their @instrumental.com Google account — they're auto-approved. If they need Admin access, a SuperAdmin must promote them via Admin Panel → User Access → ⬆ Admin.

**Q: The HubSpot codename isn't being decoded to the right customer name**
The codename map lives in `src/hubspotConfig.js` → `CODENAME_MAP`. Have an admin or developer add the mapping and redeploy.
