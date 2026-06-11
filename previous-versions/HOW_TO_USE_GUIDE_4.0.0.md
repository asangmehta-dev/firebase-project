# Deployment Portal — How to Use Guide

**Version:** v4.0.0
**Audience:** Customer Experience team + external stakeholders

---

## Logging in

1. Go to https://deployment-portal-instrumental.web.app/
2. Click **Sign in with Google**.
3. What happens next depends on your email domain:
   - **@instrumental.com**: You're auto-provisioned as an Instrumental user (role = user, partyId = instrumental) with access to all projects.
   - **Other email**: You're placed in a pending queue. An admin has to approve you and assign you to specific projects before you can see anything.

> **v4.0.0 change:** Provisioning now happens server-side (`provisionUser` Cloud Function). This closes the privilege-escalation route where users could write their own `users/{uid}/role = admin` via direct DB writes.

---

## Dashboard

For each project you're assigned to, the dashboard shows:
- **Mini-stats** — stations, status, pipeline stage, SI flag
- **Project Overview** (new in v4.0.0) — 8 key dates + status/next steps
- **Hardware** — HubSpot-synced values with override support (new in v4.0.0)
- **Gantt chart** — timeline built from Program Details + checklist dates

### Project Overview

| Field | Who owns it | Notes |
|---|---|---|
| CAD Complete Date | Webapp (edit in-app) | Will writeback to HubSpot in v4.1.0 |
| CAD Actual Finish Date | Webapp | Will writeback in v4.1.0 |
| Actual Service Start Date | Webapp | Will writeback in v4.1.0 |
| Target Build Date | Webapp | Will writeback in v4.1.0 |
| Actual Deploy Date | Webapp | Will writeback in v4.1.0 |
| Target Build Date at Deal Close | HubSpot (read-only) | Pulled on every sync |
| Associated CS Program ID | HubSpot (read-only) | Pulled on every sync |
| Project Status & Next Steps | Webapp / Bot-drafted | See below |

**Click ✎ Edit** to change the 5 webapp-owned dates. **Click 🤖 Ask Bot to draft** in the Project Status box to have the AI generate a concise status update from your checklists, program tasks, and HubSpot data — review and tweak before saving.

### Hardware (with override)

HubSpot-synced hardware counts are now treated as **suggestions**. Instrumental users can override any value:

1. Click the ✎ button on any hardware row
2. Enter the override value
3. Click **Save** — the override wins in the Demand Plan and SI Kanban totals
4. Click **Clear** to revert to the HubSpot value

Overridden rows show a blue background and "Override · was X from HubSpot" note.

---

## Project Bot (AI)

Click **🤖 Project Bot** on any project page to chat with an AI that has read your project's checklists, program tasks, HubSpot data, documents, and hardware. Works for Instrumental users only. Use it for:
- Status summaries
- "What's blocking deployment?"
- "Who owns the unchecked items on the SI checklist?"
- Draft suggestions for any section

The Bot runs on Claude Sonnet 4 via the `askProjectBot` Cloud Function.

---

## Admin panel (admins only)

Open the **Admin** tab in the sidebar. All sensitive operations now go through **Cloud Function callables** — each action is logged to `auditLog/` in the database.

| Action | What happens |
|---|---|
| Approve pending user | `adminApproveUser` CF creates user record + access entries, removes pending, logs |
| Deny pending user | `adminDenyUser` CF removes pending entry, logs |
| Delete user | `adminDeleteUser` CF removes user + all access/commercialAccess entries, logs |
| Promote to admin | `adminSetRole` CF (superAdmin-gated in UI). Only @instrumental.com users eligible. |
| Grant/revoke project access | `adminSetProjectAccess` CF updates user.projects + access map. |
| Grant/revoke commercial access | `adminSetCommercialAccess` CF updates commercialAccess map. |

Admins can read the audit log directly in Firebase Realtime Database under `auditLog/` — a v4.1.0 follow-up may add an Admin UI pane for it.

---

## Access scoping summary

| Path | Admin | Instrumental user | External user |
|---|---|---|---|
| `users/` | all | own only | own only |
| `pendingUsers/` | all | — | own |
| `access/$pid/` | all | implicit via rules | own entry on own projects |
| `commercialAccess/$pid/` | all | own entry (per-project) | own entry (per-project) |
| `appState/projects/$pid/` | read+write | read all, write via admin | read assigned only |
| `appState/docData/$pid/` | read+write | read/write all | read assigned only, no write |
| `appState/projectOverview/$pid/` | read+write | read/write all | read assigned only |
| `auditLog/` | read | — | — |

External users still have **read-only** access to their assigned projects. Doc structural writes (creating/moving tabs or folders) are admin/Instrumental-only at the DB rule level and have no UI affordance for externals.

---

## Languages

Sidebar language selector writes to `users/{uid}/langPref`. Supported: English, Español, Tiếng Việt, 繁體中文, 简体中文.

---

## Sign-out & session

- **Remember me** checked at sign-in → 72-hour session.
- Unchecked → 5-minute session idle timeout.
- **Sign out** via the sidebar footer or the stuck-screen fallback on the loading page.
