# Deployment Portal v3.2.0 — How to Use Guide

**Date:** April 16, 2026
**Audience:** Instrumental Team
**Version:** 3.2.0

---

## Vision

The goal of this Webapp is to have a consolidated PMO Style frontend UI that the Customer Experience team can use to track and proactively manage risks/issues with CMs/customers. This speaks directly to HubSpot and provides real time information on all projects in the deployment and sales pipeline.

---

## Table of Contents

1. [What Changed in v3.2.0](#what-changed-in-v320)
2. [Sidebar Navigation](#sidebar-navigation)
3. [Dashboard Views](#dashboard-views)
4. [Project Details](#project-details)
5. [Checklist Milestones](#checklist-milestones)
6. [Commercial Tab](#commercial-tab)
7. [Training](#training)
8. [Admin Panel](#admin-panel)
9. [External User Experience](#external-user-experience)
10. [FAQ](#faq)

---

## 1. What Changed in v3.2.0

The 4-party document segregation system (Instrumental / SI / Customer / CM) has been **removed entirely**. In its place:

- All content is organized into **unified sections** rather than being split by party.
- External users are now classified simply as **"external"** — there is no more Customer, SI, or CM distinction.
- The sidebar, dashboard, project details, checklists, commercial access, and training have all been restructured around this simplified model.

---

## 2. Sidebar Navigation

The sidebar contains the following items, top to bottom:

| Sidebar Item | Description |
|---|---|
| **All Projects Overview** | Displayed in large font at the top. Shows the cross-project summary dashboard. |
| Project Dropdown | Searchable dropdown to select a specific project. |
| **Overview** | Displayed in larger font. Project-level overview for the selected project. |
| Project Details | Hardware, design specs, program info, checklists, CAD, tracking, validation. |
| Commercial | Restricted tab for agreements, pricing, and legal. |
| Training | Per-project training materials organized by belt level. |

The sidebar updates dynamically based on the selected project. Admin Panel access (if applicable) appears separately.

---

## 3. Dashboard Views

### Instrumental / Admin Dashboard

Instrumental users (`@instrumental.com`) with admin privileges see the **full dashboard**, which includes:

- Section cards for each area (Overview, Project Details, Commercial, Training).
- Quick-access links into sub-sections.
- Full project metadata and status indicators.

### External User Dashboard (Simplified)

All external users (any email that is not `@instrumental.com`) receive a **simplified dashboard** that shows:

- **Station count** — current deployed station totals.
- **Milestones** — high-level milestone status and dates.

No section cards, no sub-navigation into restricted areas.

---

## 4. Project Details

The Project Details view is organized into the following sub-sections:

### Hardware & MES Deployments
Current hardware deployment status and MES integration details for the selected project.

### Design Specs
Design specification documents and revision history.

### Program Details
Program-level metadata: timelines, contacts, scope, and key dates.

### Checklist Milestones
See [Section 5](#checklist-milestones) for full details on the new checklist system.

### CAD
CAD file uploads and version management.

### Hardware Tracking
Track individual hardware units, serial numbers, shipping, and installation status.

### Validation
Validation records, test results, and sign-off tracking.

---

## 5. Checklist Milestones

Checklists have been redesigned with a new template system.

### Checklist Templates

Each project uses one of two checklist templates:

1. **Internal + External Checklists** — Separate checklists for internal Instrumental tasks and external-facing tasks.
2. **SI Checklist with Toggle** — A single SI-focused checklist with a toggle to switch between views.

The template is selected at project setup by an admin.

### Checklist Item Fields

Every checklist item includes:

| Field | Description |
|---|---|
| Label | Description of the task or milestone. |
| Check | Checkbox to mark complete. |
| Ownership | Who is responsible for this item. |
| Projected Date | Target completion date. |
| Actual Date | Date the item was actually completed. |
| SOP Link | Link to the relevant SOP document. |
| N/A Toggle | Mark an item as not applicable for this project. |

Admins and authorized users can edit checklist items. External users see checklists in read-only mode (where granted access).

---

## 6. Commercial Tab

The Commercial tab contains three sub-sections:

- **Agreements** — Contract documents and status.
- **Pricing Details** — Pricing breakdowns and terms.
- **Legal** — Legal documents and compliance records.

### Access Control

The Commercial tab is **restricted by default**. Access rules:

- An admin must explicitly grant access to any user, including Instrumental non-admin users.
- External users can be granted access on a per-user basis through the Admin Panel.
- Access is managed via the new **Commercial Access** tab in the Admin Panel.

If a user does not have commercial access, the Commercial sidebar item appears grayed out or hidden depending on their role.

---

## 7. Training

Training is managed **per-project** with an enable/disable toggle controlled by admins.

### Belt Levels

Users are assigned to one of three belt levels by an admin:

| Belt | Description |
|---|---|
| White | Introductory materials and onboarding content. |
| Blue | Intermediate training for active project participants. |
| Black | Advanced training for leads and power users. |

### How It Works

- An admin assigns each user to a belt level for a given project.
- Users **only see training materials for their assigned belt level** — they cannot browse other levels.
- **Any Instrumental user** (admin or not) can upload training materials to any belt level.
- External users can be assigned belt levels and will see only their assigned content.

---

## 8. Admin Panel

The Admin Panel has been reorganized into four tabs:

### Pending

Manage pending user registrations. Changes from previous versions:

- **Removed:** Party ID selection (no more Instrumental/SI/Customer/CM assignment).
- Admins now assign a pending user to a **project** only. The user is classified as Instrumental (if `@instrumental.com`) or external (all others) automatically.

### User Access

View and manage all registered users, their project assignments, and role settings.

### Commercial Access (New)

Dedicated tab for managing who can view the Commercial tab. Admins grant or revoke commercial access on a per-user, per-project basis. This applies to both external users and Instrumental non-admin users.

### HubSpot Sync

Configure and trigger synchronization with HubSpot. View sync status, resolve conflicts, and check last-sync timestamps.

---

## 9. External User Experience

External users (non `@instrumental.com`) see a streamlined version of the portal:

- **Dashboard:** Station count and milestones only.
- **Sidebar:** Reduced navigation — no Commercial tab unless explicitly granted access.
- **Project Details:** Read-only access to sections they have been granted.
- **Training:** Only their assigned belt level materials.
- **No admin panel access.**

There is no longer a distinction between Customer, SI, and CM users. All external users are treated identically and receive access on a per-project, per-feature basis as configured by an admin.

---

## 10. FAQ

**Q: What happened to the 4-party system?**
A: It has been removed. All content is now in unified sections. External users are simply classified as "external" with no sub-categories.

**Q: I am an Instrumental user but I cannot see the Commercial tab. Why?**
A: Commercial access must be granted by an admin, even for Instrumental users who are not admins. Ask your admin to grant you access via Admin Panel > Commercial Access.

**Q: How do I assign a pending user to a project?**
A: Go to Admin Panel > Pending. Select the user and assign them to one or more projects. Party selection is no longer required — the system determines Instrumental vs. external automatically from the email domain.

**Q: Can external users upload training materials?**
A: No. Only Instrumental users (any Instrumental user, admin or not) can upload training materials. External users can only view materials for their assigned belt level.

**Q: How do I enable training for a project?**
A: Go to the Training section for the project and use the per-project toggle. Only admins can enable or disable training.

**Q: Where did the SI/Customer/CM document folders go?**
A: They have been replaced by the unified sub-sections under Project Details. All documents are now organized by type (Hardware, Design Specs, CAD, etc.) rather than by party.

**Q: Can I still restrict what external users see?**
A: Yes. Access is now managed per-project and per-feature through the Admin Panel. You have more granular control than before — you just no longer categorize users by party type.

---

*Deployment Portal v3.2.0 — Instrumental, April 2026*
