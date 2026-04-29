# Deployment Portal — How to Use Guide

**Version:** v4.0.3
**Audience:** Customer Experience team + external stakeholders

---

## What's new in v4.0.3

This is a stability + features release on top of v4.0.0/v4.0.1/v4.0.2:

- **Checklists actually work now.** A Rules-of-Hooks bug in the previous checklist UI caused random crashes (including, in some cases, the browser tab recovering into a Google search). The checklist component has been rewritten — each task is a clean checkbox + label row.
- **Editable checklists.** Instrumental users can `+ Add task` to any milestone (inline input, Enter to save) and delete tasks with the × button on the right of each row.
- **PDF upload directly to Firebase Storage** — new "📎 Upload PDF" button next to the URL input on the three file-add forms (Project Details, Commercial, Training). 50 MB max, PDF-only.
- **`[SI]` Hardware Deployment projects are now correctly classified as Hardware** (not SI). The `isSI` flag is set strictly from HubSpot pipeline membership.
- **A standalone "Backfill Checklists Now" button** in the Admin Panel applies Internal/External/SI templates to every project missing them — no HubSpot sync required.
- **The SI Kanban is visually separated** from the rest of the All Projects Overview with a blue gradient barricade.
- **The Sync History "Recent errors" panel** auto-clears errors older than 24h.

---

## Logging in

1. Go to https://deployment-portal-instrumental.web.app/
2. Click **Sign in with Google**.
3. What happens next:
   - **@instrumental.com** → auto-provisioned as Instrumental user, immediate access to all projects.
   - **Other email** → placed in pending queue until an admin approves you.

---

## Sidebar navigation

| Item | What it shows |
|---|---|
| 🌐 All Projects Overview | Cross-project demand plan, per-pipeline charts, **SI Kanban** (in blue barricade) — admin/instrumental only |
| ⊙ Overview | Per-project landing page: mini-stats, Project Overview (8 fields), Hardware (with override), Gantt |
| 📋 Project Details | **Folders + Internal/External (or SI) Checklists** — the place to track milestones |
| 📂 Commercial | Restricted: agreements, pricing, legal — admin grants access per-user per-project |
| 🎓 Training | Belt assignments + training materials |
| 💬 AI Chat | Conversational assistant scoped to your projects |
| ⊞ Admin Panel | (admin only) Pending users, user access, commercial access, **HubSpot Sync + Sync History + Backfill Checklists** |
| ⊕ Manage Projects | (admin only) Active / inactive / past tabs, SI toggle, "Apply Checklist" per project |

---

## Checklists (v4.0.3 redesign)

**Where:** click a project → 📋 Project Details → scroll past the folders.

**What you see:** each milestone is a collapsible section with a progress badge (e.g. `4/12 (33%)`). Click the row to expand. Inside, every task is its own row:

```
[✓]  Confirm BOM with CM         · TPM
[ ]  Verify shipping lane
[—]  (Lane B not used)            (struck through if N/A)
```

**To check off a task:** click anywhere on the row. Instrumental users (admin or @instrumental.com) can tick — external users see read-only.

**To add a task** (Instrumental only): expand the milestone, scroll to the bottom of its task list, click the dashed **`+ Add task`** button. Type the task label, hit Enter (or click Add). The new task is saved to the project's `docData/{pid}/projectDetails` and is project-specific — it doesn't change the master template. For permanent template changes (applied to new projects on sync), edit `functions/checklists.js` and redeploy functions.

**To delete a task** (Instrumental only): hover the row → click the **×** on the right.

**Templates come from `functions/checklists.js`:**
- **Non-SI projects** (Hardware Deployment, Data Source, MES, etc.) → Internal Checklist (6 sections) + External Checklist (9 sections)
- **SI Partner Deployment projects only** → SI Deployment Checklist (13 stages)

**If checklists are missing on existing projects:**
1. Go to Admin Panel → HubSpot Sync tab.
2. Click the green **"📋 Backfill Project Checklists"** card → "Backfill Checklists Now".
3. Wait 1–3 minutes (it's writing templates for all projects missing them; preserves existing folders).
4. Hard refresh and re-open the project.

---

## Adding files (Project Details, Commercial, Training)

Each file-add form now offers two ways to attach a document:

1. **Paste a URL** in the URL field (e.g. a Google Doc / Sheet / shared link). Must start with `https://`.
2. **📎 Upload PDF** button — opens a file picker. Pick a PDF (max 50 MB). The file is uploaded to Firebase Storage at `gs://<bucket>/uploads/{projectId}/{timestamp}_{filename}`, and the resulting download URL is automatically set in the form. The Name field auto-populates from the filename if blank. Click **Add** to save.

After the upload:
- The document appears in the folder with a 📄 icon (vs 🔗 for link-only entries).
- Anyone with project access can open the PDF — the download URL is signed by Firebase.
- Click the ✕ icon on the row to delete (Instrumental only).

**Why PDFs only?** Storage rules enforce `contentType == "application/pdf"` so users can't upload arbitrary binaries. If you need to share Excel/Word files, link to a Google Doc / Drive instead.

---

## Project Overview section (in ⊙ Overview)

8 fields per project:

| Field | Source |
|---|---|
| CAD Complete Date | Webapp (edit in-app) |
| CAD Actual Finish Date | Webapp |
| Actual Service Start Date | Webapp |
| Target Build Date | Webapp |
| Actual Deploy Date | Webapp |
| Target Build Date at Deal Close | HubSpot (read-only) |
| Associated CS Program ID | HubSpot (read-only) |
| Project Status & Next Steps | Webapp / Bot-drafted |

Click ✎ Edit to change webapp-owned dates. Click 🤖 Ask Bot to draft to generate a status update from your checklists, hardware, and HubSpot stage.

---

## Hardware (with override)

HubSpot-synced hardware counts shown as **suggestions**. Click ✎ on any row to override. Override wins in Demand Plan and SI Kanban totals. Click "Clear" to revert to HubSpot value.

---

## SI Kanban (All Projects Overview)

Now wrapped in a clearly-labelled **blue gradient panel** to separate it from Hardware Deployment data. Only shows projects in HubSpot's "SI Partner Deployment" pipeline (8 stages: SIRD → DFM → Quote → PO → Build → FAT → SAT → Live). Stage comes from HubSpot — auto-updates on every sync. Drag-and-drop is local-only (HubSpot writeback ships in v4.1.0).

`[SI]`-tagged projects in Hardware Deployment Pipeline stay in Hardware (per your spec) — they don't appear here.

---

## HubSpot Sync (admin only)

**Two distinct cards in Admin Panel → HubSpot Sync:**

1. **Orange "HubSpot Sync"** — pulls projects from HubSpot. Preview first, then Confirm & Apply.
2. **Green "📋 Backfill Project Checklists"** — applies Internal/External/SI templates to all projects missing them. **No HubSpot involved.**

Plus the **Sync History table** showing every sync (Manual=blue, Scheduled=purple) with state, counts, duration, actor. The Recent Errors panel filters to last 24h.

---

## AI features (recap)

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
