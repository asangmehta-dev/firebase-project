# Deployment Portal — How to Use Guide

**Version:** v4.5.3
**Audience:** Customer Experience team + external stakeholders

> **Where to find earlier feature docs:** v4.1.0 and earlier features (sidebar nav, file uploads, Gantt, project-level HubSpot link, date writeback, All SI Projects, scheduled maintenance) are still active — see `HOW_TO_USE_GUIDE_4.1.0.md` for those details. This guide focuses on what's new since v4.1.0.

---

## What's new since v4.1.0

### v4.4.0 — Shipment Details ↔ HubSpot writeback

The **Shipment Details** table inside each project's Project Details now syncs both directions with HubSpot.

- **Inbound (HubSpot → app)**: every sync (Tue & Fri 3 PM PT, or click Manual Sync) pulls Shipment objects from HubSpot and creates one row per shipment in your project's Shipment Details. The shipment's INxxx number lands in the `item_num` column.
- **Outbound (app → HubSpot)**: edit any of these 5 fields and it writes back to HubSpot within ~1 second:
  - `contents` → HubSpot `Shipment Contents`
  - `carrier` → HubSpot `Logistics Company`
  - `tracking_num` → HubSpot `Internal Shipment ID` (the carrier's tracking number)
  - `ship_date` → HubSpot `Date Shipped`
  - `notes` → HubSpot `Notes`
- **Renaming an INxxx**: editing the `item_num` cell updates HubSpot's `Shipment Tracking Number` field — the SAME HubSpot record gets renamed (no duplicate created).
- **Creating a brand new INxxx**: type a new INxxx into a new row; the app creates a fresh Shipment record in HubSpot on save.
- **Per-row status indicator** next to the row: `↑` (writing), `✓` (HubSpot updated), `⚠` (failed — hover for the error).
- **Other columns** (box_size, weight) are app-only — never written to HubSpot.

Errors are recorded in **Admin Panel → 🔍 Audit Log** with the raw HubSpot response for diagnosis.

### v4.4.1 — Shipments associated directly to a Project also sync now

If a Shipment in HubSpot is linked directly to a Project (not to a Station Kit), the app now picks it up. Previously these were silently dropped.

### v4.5.0 — Station Kit + Fleet Asset writeback (Hardware Tracking)

The **Hardware Tracking** subsection (visible on every project) was rewritten:

- **Per-kit grouped layout**: each Station Kit from HubSpot gets its own card with editable kit-level fields (Name, Kit SN, Computer SN, Status, Type) at the top, then a table of its fleet assets below.
- **Inline serial number edits**: click any serial number on a Camera / Lens / Computer / LED Light Controller row to edit it. On blur (Tab or click outside), the app:
  1. Searches HubSpot for a Fleet Asset with that new serial number.
  2. If found → re-points the Kit↔FleetAsset association to that asset, with the same labeled slot (Camera 1, Lens 1, etc.). Safe **PUT-then-DELETE** order so the slot is never empty mid-swap.
  3. If not found → friendly error "No Fleet Asset with SN X exists in HubSpot. Create it first, then sync." Your local edit reverts.
- **Kit-level field edits** (Name, Kit SN, etc.) PATCH the HubSpot Kit object directly. The **first kit-field edit per session** shows a confirm prompt — "You're about to write back to HubSpot's Kit record. This change is immediate and affects the source of truth." After confirming once, no more prompts that session.
- **Per-row indicator** (`↑` / `✓` / `⚠`) on every editable cell.
- **Manual entries** stay in their own group at the bottom — never written back to HubSpot.

Bidirectional sync: editing a Fleet Asset SN in HubSpot directly flows back to the app on the next sync.

### v4.5.1 — Data safety fix (no user-visible change, but important)

A latent bug in how the app persisted local edits could, in rare timing windows, overwrite an entire project's data store with partial state — silently wiping user-typed rows in tables like Team or Notes. Fixed in v4.5.1: the app now writes only the specific field you edited, leaving everything else untouched in the database. **Firebase Realtime Database Backups have been enabled** (Admin → Realtime Database → Backups tab) so any future incident is recoverable.

### v4.5.2 — Station Kits table auto-populates from HubSpot

The 63-column `Station Kits` table inside Project Details is no longer manual-only. Every sync now writes one row per Station Kit on the project, auto-filling **16 HubSpot-derived columns**:

- `Fixture Name` (kit's station_kit_sn), `Station Name`
- `Computer SN`, `Computer Service Tag`, `MAC Address` (from the Computer fleet asset)
- `Camera #1 SN`, `Lens #1 SN`, `Barcode Scanner SN`, `Monitor SN`, `LED Controller SN`
- Booleans: `Cameras`, `Lenses`, `Barcode Scanner`, `Monitor`, `LEDs`
- `No. Cameras` (count)

**All ~48 manual columns** (Keyboard, Mouse, USB Button, all cables, Notch numbers, Camera Type, Notes, Ship Date, Station #, Line Name, brackets, nests, etc.) **are preserved across syncs**. Sync only manages the HubSpot allow-list; everything else is yours to type and edit.

Rows match by a hidden `_kitHubspotId` field. New kits in HubSpot append fresh rows on the next sync; deleted/renamed kits leave existing rows untouched (manual cleanup if needed).

### v4.5.3 — Team table auto-populates 4 DRI rows from HubSpot

The **Team** table in Project Details now auto-fills the 4 DRI roles from HubSpot's project record:

| Role | HubSpot property |
|---|---|
| `HDE (Hardware Design Engineer)` | DRIs section → HDE |
| `SIE (Software Integration Engineer)` | DRIs section → SIE |
| `SA (Solutions Architect)` | DRIs section → SA |
| `CS (Customer Success)` | DRIs section → CS |

Each role row gets `role`, `name`, and `email` populated from the HubSpot Owner selected for that DRI. **You can still add more team members manually** — just click "Add row" and fill anything. Manual rows are never touched by sync.

If you edit `company`, `location`, `phone`, or `description` on a DRI row, **those edits are preserved** across syncs (only role/name/email are overwritten from HubSpot).

If a DRI is unset in HubSpot, the row still appears with empty name/email — signals "no one assigned yet".

To assign a DRI: open the project in HubSpot → DRIs section → pick a HubSpot Owner. Next sync (or manual sync) pulls it into the app.

---

## Quick reference — bidirectional sync paths

| App field | HubSpot direction | Notes |
|---|---|---|
| Project dates (CAD, Actual Service Start, Target Build, Actual Deploy) | App ↔ HubSpot | Instantaneous on edit |
| Project stage (Kanban drag) | App ↔ HubSpot | Instantaneous on drop |
| Shipment Details cells | App ↔ HubSpot | Instantaneous on cell blur |
| Hardware Tracking serial cells (4 types) | App ↔ HubSpot | Instantaneous on cell blur |
| Hardware Tracking kit-level cells | App ↔ HubSpot | Instantaneous on cell blur (with first-edit confirm) |
| Station Kits table (HubSpot-derived columns) | HubSpot → App | On sync only — edit Hardware Tracking for writeback |
| Team table (4 DRI rows) | HubSpot → App | On sync only — edit DRIs in HubSpot |

Read direction (HubSpot → app) happens on:
- **Scheduled syncs**: Tue & Fri at 3 PM PT
- **Manual sync**: Admin Panel → 🔄 HubSpot Sync → Manual Sync button

Write direction (app → HubSpot) happens within ~1 second of each cell edit. Check **Admin Panel → 🔍 Audit Log** to confirm or diagnose failures — every writeback attempt is logged with status and HubSpot's response body.

---

## Troubleshooting

- **A cell looks editable but nothing writes back**: ensure the project has been synced at least once since the relevant release was deployed. The writeback CFs need rows to carry hidden HubSpot IDs (`_kitHubspotId`, `hubspotShipmentId`) that only the sync sets.
- **Hardware row shows under "__unknown__" kit group**: the row's `_kitHubspotId` is missing — re-run a manual sync to refresh.
- **Editing an SN says "No Fleet Asset with SN X exists"**: create the asset in HubSpot first (Fleet Assets → New), then sync, then retry.
- **A column you edited reverts after sync**: that column is in the HubSpot-driven allow-list for that table — edit in HubSpot or via the canonical UI (Hardware Tracking for fleet/kit fields, the DRIs section for team) instead.
- **Data appears wiped**: check Firebase Console → Realtime Database directly. If data is in RTDB but not in the app, hard refresh (Cmd+Shift+R) and re-sign-in. If data is truly missing from RTDB, restore from the daily backup (Realtime Database → Backups tab).

---

## Where to find this guide and earlier versions

- This guide: `HOW_TO_USE_GUIDE_4.5.3.md` in the repo root
- v4.1.0 (sidebar nav, Gantt, file uploads, date writeback, All SI Projects, si_admin): `HOW_TO_USE_GUIDE_4.1.0.md`
- v4.0.0 (security review response, hardware override, Project Overview, AI bot): `HOW_TO_USE_GUIDE_4.0.0.md`
- Full version history with code-level detail: `README.md`
