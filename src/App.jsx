import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from "react";
import * as XLSX from "xlsx";
import { auth, db, functions, storage, googleProvider } from "./firebase";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { ref, onValue, set, push, remove, update, get } from "firebase/database";
import { httpsCallable } from "firebase/functions";
import { ref as sRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { Document as DocxDocument, Packer as DocxPacker, Paragraph as DocxParagraph, TextRun as DocxTextRun, HeadingLevel as DocxHeadingLevel } from "docx";
import { PIPELINES, STAGES, PIPELINE_LIST } from "./hubspotConfig";

/* ═══ DB HELPERS ═══ */
const dbRead = (p) => new Promise((resolve, reject) => { onValue(ref(db, p), (s) => resolve(s.val()), (e) => reject(e), { onlyOnce: true }); });
const dbWrite = (p, d) => set(ref(db, p), d);

// Append one entry to the SI project activity log. Fire-and-forget so a
// rules failure or network blip doesn't block the underlying write. Pass
// in user.uid + a display name so the entry survives without joining.
function logSIActivity(pid, type, summary, actor) {
  if (!pid) return;
  const key = push(ref(db, `appState/siActivityLog/${pid}`)).key;
  set(ref(db, `appState/siActivityLog/${pid}/${key}`), {
    timestamp: Date.now(),
    type,
    summary: (summary || "").slice(0, 300),
    actor: actor || "unknown",
  }).catch(() => { /* tolerate */ });
}

/* URL validation — block javascript:/data:/vbscript:/file:, require https://. Empty string allowed (clears field). */
const sanitizeUrl = (u) => {
  if (u == null || u === "") return "";
  const t = String(u).trim();
  if (!t) return "";
  if (/^(javascript|data|vbscript|file):/i.test(t)) return null;
  if (!/^https:\/\//i.test(t)) return null;
  if (t.length > 2048) return null;
  return t;
};
// Wrap input handlers for URL fields. Returns null if invalid (caller alerts + rejects).
const commitUrl = (raw) => {
  if (raw === "" || raw == null) return "";
  const clean = sanitizeUrl(raw);
  if (clean === null) { alert("Invalid URL. Must start with https:// — javascript:, data:, and file: are blocked."); return null; }
  return clean;
};

/* v4.1.0 — File upload to Firebase Storage. Returns the download URL on success, null on cancel/error.
   Accepts PDF, Office (DOCX/XLSX/PPTX/DOC/XLS/PPT), images, text/CSV, and .lbx label files.
   .lbx files have no standard MIME (browsers send application/octet-stream); accepted by extension. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/octet-stream",
  "text/csv",
  "text/plain",
]);
const isAllowedFile = (file) => {
  if (!file) return false;
  if (file.type?.startsWith("image/")) return true;
  if (file.type?.startsWith("text/")) return true;
  if (ALLOWED_MIMES.has(file.type)) return true;
  // Fallback: check extension for .lbx (label files often have empty MIME)
  if ((file.name || "").toLowerCase().endsWith(".lbx")) return true;
  return false;
};
const fileIcon = (filename) => {
  const ext = (filename || "").toLowerCase().split(".").pop();
  if (ext === "pdf") return "📄";
  if (["xlsx", "xls", "csv"].includes(ext)) return "📊";
  if (["docx", "doc"].includes(ext)) return "📝";
  if (["pptx", "ppt"].includes(ext)) return "📋";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "🖼️";
  if (ext === "lbx") return "🏷️";
  return "📁";
};
const uploadFileToStorage = async (file, projectId) => {
  if (!file) return null;
  if (!isAllowedFile(file)) { alert(`File type not allowed: ${file.type || "unknown"}. Allowed: PDF, Office docs, images, text/CSV, .lbx`); return null; }
  if (file.size > MAX_FILE_BYTES) { alert(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 50 MB.`); return null; }
  const safeName = (file.name || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const path = `uploads/${projectId || "global"}/${Date.now()}_${safeName}`;
  const fileRef = sRef(storage, path);
  // For .lbx and other extensionless types, fall back to octet-stream so storage rules accept it
  const contentType = file.type || "application/octet-stream";
  await uploadBytes(fileRef, file, { contentType });
  return await getDownloadURL(fileRef);
};
// Back-compat alias — older code may still call uploadPdfToStorage
const uploadPdfToStorage = uploadFileToStorage;

/* Cloud Function callables — v4.0.0 admin + provisioning */
const callProvisionUser = () => httpsCallable(functions, "provisionUser")();
const callAdminApprove = (pendingId, projectIds) => httpsCallable(functions, "adminApproveUser")({ pendingId, projectIds });
const callAdminDeny = (pendingId) => httpsCallable(functions, "adminDenyUser")({ pendingId });
const callAdminDelete = (uid) => httpsCallable(functions, "adminDeleteUser")({ uid });
const callAdminSetRole = (uid, role) => httpsCallable(functions, "adminSetRole")({ uid, role });
const callAdminSetProjectAccess = (uid, projectId, grant) => httpsCallable(functions, "adminSetProjectAccess")({ uid, projectId, grant });
const callAdminSetCommercialAccess = (uid, projectId, grant) => httpsCallable(functions, "adminSetCommercialAccess")({ uid, projectId, grant });

/* ═══ CONSTANTS ═══ */
const BELT_LEVELS = { white: { name: "White Belt", color: "#64748B", icon: "○" }, blue: { name: "Blue Belt", color: "#3B82F6", icon: "◐" }, black: { name: "Black Belt", color: "#1E293B", icon: "●" } };
const LANGUAGES = [
  { id: "en", label: "English (US)", flag: "🇺🇸", short: "EN" },
  { id: "es", label: "Español", flag: "🇪🇸", short: "ES" },
  { id: "vi", label: "Tiếng Việt", flag: "🇻🇳", short: "VI" },
  { id: "zh-tw", label: "繁體中文", flag: "🇹🇼", short: "繁" },
  { id: "zh-cn", label: "简体中文", flag: "🇨🇳", short: "简" },
];
const HW_TYPES = ["Camera", "Lens", "Station Computer", "Frame", "Monitor", "LED Controller", "Barcode Scanner", "Other"];
// v4.0.1: 8-stage SI Partner Deployment pipeline (matches HubSpot's "SI Partner Deployment" pipeline)
const SI_PIPELINE_STAGES = [
  { id: "sird",  label: "SIRD",  color: "#00C9A7" },
  { id: "dfm",   label: "DFM",   color: "#3B82F6" },
  { id: "quote", label: "Quote", color: "#F59E0B" },
  { id: "po",    label: "PO",    color: "#A855F7" },
  { id: "build", label: "Build", color: "#0284C7" },
  { id: "fat",   label: "FAT",   color: "#DC2626" },
  { id: "sat",   label: "SAT",   color: "#059669" },
  { id: "live",  label: "Live",  color: "#10B981" },
];
// Fixture-tracker timeline stages (separate from HubSpot pipeline above). 9 stages with spec colors; used only by the Timeline view.
const SI_TIMELINE_STAGES = [
  { id: "SIRD",       label: "SIRD",       color: "#6366F1" },
  { id: "DFM",        label: "DFM",        color: "#A855F7" },
  { id: "Quote",      label: "Quote",      color: "#EC4899" },
  { id: "PO",         label: "PO",         color: "#F59E0B" },
  { id: "Build",      label: "Build",      color: "#3B82F6" },
  { id: "FAT",        label: "FAT",        color: "#10B981" },
  { id: "InTransit",  label: "In Transit", color: "#F97316" },
  { id: "SAT",        label: "SAT",        color: "#14B8A6" },
  { id: "Live",       label: "Live",       color: "#22C55E" },
];
// HubSpot pipeline ID for "SI Partner Deployment". Mirrored in functions/index.js.
const SI_PARTNER_PIPELINE_ID = "2206979797";
// Backward-compat: map legacy 13-stage siStage keys to the new 8-stage keys (for projects that had old stage saved).
const LEGACY_SI_STAGE_MAP = {
  sird_drafting: "sird", sird_approved: "sird",
  dfm_si: "dfm", dfm_approved: "dfm",
  quote_received: "quote", quote_approved: "quote",
  po_issued: "po",
  build: "build", fat: "fat",
  shipped: "sat", sat: "sat",
  warranty: "live", complete: "live",
};
const normalizeSiStage = (s) => LEGACY_SI_STAGE_MAP[s] || s || "sird";
const SEED_PROJECTS = [
  { id: "proj_nvidia_1", name: "NVIDIA — HGX B200 Inspection", customer: "NVIDIA", status: "active", stations: 0, isSI: true },
  { id: "proj_aws_1", name: "AWS — Trainium Board QC", customer: "AWS", status: "active", stations: 0, isSI: false },
];
/* v3.2.0: Default project-details folders (applied to new projects). Checklist templates come from Cloud Functions. */
const DEFAULT_PROJECT_DETAILS = [
  { id: "pd_specs", name: "Design Specifications & Integration Docs", accessLevel: "open", items: [] },
  { id: "pd_program", name: "Program Details & Timelines", accessLevel: "open", items: [], type: "program" },
  { id: "pd_cad", name: "CAD & Drawings", accessLevel: "open", items: [] },
];


const APP_TABLE_TEMPLATES = [
  { id: "pd_station_kits", name: "Station Kits", type: "table", accessLevel: "open", columns: [
    { key: "station_num",           label: "Station #",                            section: "Station" },
    { key: "line",                  label: "Line Name",                            section: "Station" },
    { key: "station_name",          label: "Station Name",                         section: "Station" },
    { key: "fixture_name",          label: "Fixture Name",                         section: "Station" },
    { key: "computer_service_tag",  label: "Computer ServiceTag",                  section: "Computer" },
    { key: "mac_address",           label: "MAC Address",                          section: "Computer" },
    { key: "computer_sn",           label: "Computer SN",                          section: "Computer" },
    { key: "computer_deployed",     label: "Computer Deployed?",                   section: "Computer",           type: "boolean" },
    { key: "keyboard",              label: "Keyboard",                             section: "Peripherals",        type: "boolean" },
    { key: "mouse",                 label: "Mouse",                                section: "Peripherals",        type: "boolean" },
    { key: "usb_button",            label: "USB Button",                           section: "Peripherals",        type: "boolean" },
    { key: "ethernet_cable",        label: "Ethernet Cable",                       section: "Peripherals",        type: "boolean" },
    { key: "power_cable",           label: "Power Cable",                          section: "Peripherals",        type: "boolean" },
    { key: "barcode_scanner",       label: "BarCode Scanner",                      section: "Peripherals",        type: "boolean" },
    { key: "barcode_scanner_sn",    label: "BarCode Scanner SN",                   section: "Peripherals" },
    { key: "monitor",               label: "Monitor",                              section: "Monitor",            type: "boolean" },
    { key: "monitor_sn",            label: "Monitor SN",                           section: "Monitor" },
    { key: "hdmi_dp_cable",         label: "HDMI to DP Cable",                     section: "Monitor",            type: "boolean" },
    { key: "cameras_present",       label: "Cameras",                              section: "Cameras",            type: "boolean" },
    { key: "camera_1_sn",           label: "Camera #1 SN",                         section: "Cameras" },
    { key: "no_cameras",            label: "No. Cameras",                          section: "Cameras" },
    { key: "camera_type",           label: "Camera Type",                          section: "Cameras" },
    { key: "no_camera_brackets",    label: "No. Camera Brackets",                  section: "Cameras" },
    { key: "camera_brackets",       label: "Camera Brackets",                      section: "Cameras",            type: "boolean" },
    { key: "camera_bracket_notch",  label: "Camera Bracket Notch #",               section: "Cameras" },
    { key: "camera_usb_cable",      label: "Camera USB Cable",                     section: "Cameras",            type: "boolean" },
    { key: "lenses_present",        label: "Lenses",                               section: "Lenses",             type: "boolean" },
    { key: "lens_1_type",           label: "Lens #1 Type",                         section: "Lenses" },
    { key: "lens_1_sn",             label: "Lens #1 SN",                           section: "Lenses" },
    { key: "no_leds",               label: "No. LEDs/Type",                        section: "Lights" },
    { key: "uv_light",              label: "UV Light",                             section: "Lights" },
    { key: "uv_light_notch",        label: "UV Light Rotational Notch #",          section: "Lights" },
    { key: "leds",                  label: "LEDs",                                 section: "Lights",             type: "boolean" },
    { key: "white_light_notch",     label: "White Light Rotational Notch #",       section: "Lights" },
    { key: "no_led_cables",         label: "No. LED Cables/Length",                section: "Lights" },
    { key: "led_cables",            label: "LED Cables",                           section: "Lights",             type: "boolean" },
    { key: "led_brackets",          label: "LED Brackets",                         section: "Lights",             type: "boolean" },
    { key: "led_controller_sn",     label: "LED Controller SN",                    section: "Lights" },
    { key: "light_ctrl_automated",  label: "Light Controller (Wordop, automated)", section: "Lights",             type: "boolean" },
    { key: "light_ctrl_manual",     label: "Light Controller (Wordop, manual)",    section: "Lights",             type: "boolean" },
    { key: "manual_controller_sn",  label: "Manual Controller SN",                 section: "Lights" },
    { key: "led_white_intensity",   label: "LED White Intensity",                  section: "Lights" },
    { key: "uv_light_intensity",    label: "UV Light Intensity",                   section: "Lights" },
    { key: "ledc_power_cable",      label: "LEDC Power Cable",                     section: "Lights",             type: "boolean" },
    { key: "led_ctrl_ext_cables",   label: "4x LED Controller Ext. Cables",        section: "Lights",             type: "boolean" },
    { key: "station_sn",            label: "Station SN",                           section: "Station Components" },
    { key: "andon_stack_light",     label: "Andon/Stack Light",                    section: "Station Components", type: "boolean" },
    { key: "andon_stack_bracket",   label: "Andon/Stack Bracket",                  section: "Station Components", type: "boolean" },
    { key: "keyboard_mouse_tray",   label: "Keyboard/Mouse Tray",                  section: "Station Components", type: "boolean" },
    { key: "monitor_bracket",       label: "Monitor Bracket",                      section: "Station Components", type: "boolean" },
    { key: "barcode_scanner_mount", label: "Barcode Scanner Mount",                section: "Station Components", type: "boolean" },
    { key: "cable_ties",            label: "Cable Ties & Wrap",                    section: "Station Components", type: "boolean" },
    { key: "baseboard_3d_nest",     label: "Baseboard 3D Printed Nest",            section: "Station Components", type: "boolean" },
    { key: "mainboard_3d_nest",     label: "Mainboard 3D Printed Nest",            section: "Station Components", type: "boolean" },
    { key: "baseboard_cnc_nest",    label: "Baseboard CNC Machined Nest",          section: "Station Components", type: "boolean" },
    { key: "mainboard_cnc_nest",    label: "Mainboard CNC Machined Nest",          section: "Station Components", type: "boolean" },
    { key: "power_converter",       label: "Power Converter & Cable (Brazil) 2x",  section: "Station Components", type: "boolean" },
    { key: "instrumental_sign",     label: "Instrumental Sign [optional]",         section: "Station Components", type: "boolean" },
    { key: "nbr_cable",             label: "NBR 14136-to-C13 10A/250V",            section: "Station Components", type: "boolean" },
    { key: "nema_adapter",          label: "4x NEMA-to-NBR Adapter",               section: "Station Components", type: "boolean" },
    { key: "brazil_power_cord",     label: "4x Brazil Power Cord - 6 ft",          section: "Station Components", type: "boolean" },
    { key: "ship_date",             label: "Ship Date",                            section: "Logistics",          type: "date" },
    { key: "notes",                 label: "Notes",                                section: "Logistics" },
  ], rows: [] },
  { id: "pd_in_factory_install", name: "In-Factory Install", type: "table", accessLevel: "open", columns: [
    { key: "station",            label: "Station",            section: "Station" },
    { key: "line",               label: "Line",               section: "Station" },
    { key: "station_name",       label: "Station Name",       section: "Station" },
    { key: "fixture_name",       label: "Fixture Name",       section: "Station" },
    { key: "internet_confirmed", label: "Internet Confirmed", section: "Network",  type: "boolean" },
    { key: "ip_address",         label: "IP Address",         section: "Network" },
    { key: "gateway",            label: "Gateway",            section: "Network" },
    { key: "mask",               label: "Mask",               section: "Network" },
    { key: "nameserver_1",       label: "Nameserver 1",       section: "Network" },
    { key: "nameserver_2",       label: "Nameserver 2",       section: "Network" },
    { key: "camera_mounted",     label: "Camera Mounted",     section: "Install",  type: "boolean" },
    { key: "led_mounted",        label: "LED Mounted",        section: "Install",  type: "boolean" },
    { key: "fov_confirmed",      label: "FOV Confirmed",      section: "Install",  type: "boolean" },
    { key: "notes",              label: "Notes",              section: "Install" },
  ], rows: [] },
  { id: "pd_camera_settings", name: "Camera Settings", type: "table", accessLevel: "open", columns: [
    { key: "station",         label: "Station",           section: "Station" },
    { key: "camera_id",       label: "Camera ID",         section: "Camera" },
    { key: "camera_model",    label: "Camera Model",      section: "Camera" },
    { key: "serial_num",      label: "Serial #",          section: "Camera" },
    { key: "lens",            label: "Lens",              section: "Camera" },
    { key: "focal_length_mm", label: "Focal Length (mm)", section: "Optics" },
    { key: "working_dist_mm", label: "Working Dist (mm)", section: "Optics" },
    { key: "aperture",        label: "Aperture (f/)",     section: "Optics" },
    { key: "gain",            label: "Gain",              section: "Capture" },
    { key: "exposure_us",     label: "Exposure (μs)",     section: "Capture" },
    { key: "fps",             label: "FPS",               section: "Capture" },
    { key: "trigger_mode",    label: "Trigger Mode",      section: "Capture" },
    { key: "resolution_w",    label: "Res. W",            section: "Capture" },
    { key: "resolution_h",    label: "Res. H",            section: "Capture" },
    { key: "lighting_type",   label: "Lighting Type",     section: "Lighting" },
    { key: "lighting_pos",    label: "Lighting Position", section: "Lighting" },
    { key: "verified_by",     label: "Verified By",       section: "Verification" },
    { key: "verified_date",   label: "Verified Date",     section: "Verification", type: "date" },
  ], rows: [] },
  { id: "pd_led_settings", name: "LED Settings", type: "table", accessLevel: "open", columns: [
    { key: "station",        label: "Station",        section: "Station" },
    { key: "line",           label: "Line",           section: "Station" },
    { key: "station_name",   label: "Station Name",   section: "Station" },
    { key: "fixture_name",   label: "Fixture Name",   section: "Station" },
    { key: "led_controller", label: "LED Controller", section: "Controller", type: "boolean" },
    { key: "l1_brightness",  label: "L1 Brightness",  section: "Light 1" },
    { key: "l1_type",        label: "L1 Type",        section: "Light 1" },
    { key: "l2_brightness",  label: "L2 Brightness",  section: "Light 2" },
    { key: "l2_type",        label: "L2 Type",        section: "Light 2" },
    { key: "l3_brightness",  label: "L3 Brightness",  section: "Light 3" },
    { key: "l3_type",        label: "L3 Type",        section: "Light 3" },
    { key: "l4_brightness",  label: "L4 Brightness",  section: "Light 4" },
    { key: "l4_type",        label: "L4 Type",        section: "Light 4" },
    { key: "notes",          label: "Notes",          section: "Notes" },
  ], rows: [] },
  { id: "pd_sop_plan", name: "SOP Plan", type: "table", accessLevel: "open", columns: [
    { key: "location",   label: "Location",     width: 100 },
    { key: "line",       label: "Line",         width: 80  },
    { key: "station",    label: "Station",      width: 80  },
    { key: "sop_number", label: "SOP Number",   width: 110 },
    { key: "image_1",    label: "Image Name 1", width: 130 },
    { key: "image_2",    label: "Image Name 2", width: 130 },
    { key: "image_3",    label: "Image Name 3", width: 130 },
    { key: "sop_created",label: "SOP Created?", width: 100, type: "boolean" },
    { key: "created_by", label: "Created By",   width: 110 },
    { key: "notes",      label: "Notes",        width: 200 },
  ], rows: [] },
  { id: "pd_mes_station_plan", name: "MES Station Plan", type: "table", accessLevel: "open", columns: [
    { key: "sop_number",       label: "SOP Number",      width: 110 },
    { key: "location",         label: "Location",         width: 100 },
    { key: "line",             label: "Line",             width: 80  },
    { key: "fixture_id",       label: "Fixture ID",       width: 100 },
    { key: "station",          label: "Station",          width: 80  },
    { key: "image_name",       label: "Image Name",       width: 130 },
    { key: "mes_station_name", label: "MES Station Name", width: 150 },
    { key: "qr_code",          label: "QR Code",          width: 120 },
    { key: "sop_updated",      label: "SOP Updated?",     width: 105, type: "boolean" },
    { key: "created_in_sfc",   label: "Created in SFC?",  width: 115, type: "boolean" },
    { key: "live_in_sfc",      label: "Live in SFC?",     width: 105, type: "boolean" },
  ], rows: [] },
  { id: "pd_serialization", name: "Serialization", type: "table", accessLevel: "open", columns: [
    { key: "component_type", label: "Component Type", width: 140 }, { key: "sn_format", label: "SN Format", width: 130 },
    { key: "config", label: "Config", width: 130 }, { key: "example_sn", label: "Example SN", width: 130 },
    { key: "notes", label: "Notes", width: 200 },
  ], rows: [] },
  { id: "pd_sku_configs", name: "SKU Configs", type: "table", accessLevel: "open", columns: [
    { key: "sku", label: "SKU", width: 120 }, { key: "config_1", label: "Config 1", width: 120 },
    { key: "config_2", label: "Config 2", width: 120 }, { key: "config_3", label: "Config 3", width: 120 },
    { key: "config_4", label: "Config 4", width: 120 }, { key: "config_5", label: "Config 5", width: 120 },
    { key: "notes", label: "Notes", width: 200 },
  ], rows: [] },
  { id: "pd_shipment_details", name: "Shipment Details", type: "table", accessLevel: "open", columns: [
    { key: "item_num", label: "Item #", width: 70 }, { key: "contents", label: "Contents", width: 160 },
    { key: "box_size_in", label: "Box Size (in)", width: 110 }, { key: "box_size_mm", label: "Box Size (mm)", width: 110 },
    { key: "weight_lbs", label: "Weight (lbs)", width: 100 }, { key: "weight_kg", label: "Weight (kg)", width: 90 },
    { key: "carrier", label: "Carrier", width: 90 }, { key: "tracking_num", label: "Tracking #", width: 120 },
    { key: "ship_date", label: "Ship Date", width: 100, type: "date" }, { key: "notes", label: "Notes", width: 200 },
  ], rows: [] },
  { id: "pd_team", name: "Team", type: "table", accessLevel: "open", columns: [
    { key: "role", label: "Role", width: 120 }, { key: "name", label: "Name", width: 130 },
    { key: "email", label: "Email", width: 180 }, { key: "company", label: "Company", width: 120 },
    { key: "location", label: "Location", width: 120 }, { key: "phone", label: "Phone", width: 120 },
    { key: "description", label: "Description", width: 200 },
  ], rows: [] },
];

const APP_REFERENCE_INFO_FOLDER = { id: "pd_reference_info", name: "Reference Info", type: "folder", accessLevel: "open", items: [] };
const APP_MES_CHECKLIST_TEMPLATE = (() => {
  const ck = (id, label, o = "") => ({ id, label, checked: false, na: false, ownership: o, startDate: null, projectedDate: null, actualDate: null, sopLink: null });
  return {
    id: "inst_mes_integration_checklist", name: "MES Integration Checklist", accessLevel: "open", type: "checklist", items: [],
    milestones: [
      { id: "mes_ms_1", name: "1. Network & Connectivity", description: "Confirm server access, protocols, and network topology.", color: "#00C9A7", checklist: [
        ck("mes_1_1", "MES/SFC server hostname provided"),
        ck("mes_1_2", "MES/SFC server IP address provided (fallback)"),
        ck("mes_1_3", "Port number confirmed"),
        ck("mes_1_4", "Protocol confirmed (HTTP or HTTPS)"),
        ck("mes_1_5", "SSL certificate bundle (.pem) confirmed (if HTTPS)"),
        ck("mes_1_6", "Network topology documented (direct access or proxy/firewall)"),
        ck("mes_1_7", "IP allowlisting requirements for Instrumental stations confirmed"),
        ck("mes_1_8", "Dual Ethernet requirement confirmed (Instrumental Cloud vs MES network)"),
      ], links: [], signatures: [] },
      { id: "mes_ms_2", name: "2. SSL Certificate", description: "Provide SSL certificate for HTTPS MES connections.", color: "#3B82F6", checklist: [
        ck("mes_2_1", "CA bundle / certificate file (.pem) provided for MES server"),
        ck("mes_2_2", "Certificate expiration date confirmed"),
        ck("mes_2_3", "Certificate renewal contact provided (Name / Email)"),
      ], links: [], signatures: [] },
      { id: "mes_ms_3", name: "3. API Endpoints", description: "Document all endpoints: health check, route validation, result reporting, serial lookup.", color: "#A855F7", checklist: [
        ck("mes_3_1_1", "Health Check — Full URL provided"),
        ck("mes_3_1_2", "Health Check — HTTP method confirmed (GET / POST)"),
        ck("mes_3_1_3", "Health Check — Expected success response documented"),
        ck("mes_3_2_1", "Route Validation (Before Check) — Full URL provided"),
        ck("mes_3_2_2", "Route Validation — HTTP method confirmed"),
        ck("mes_3_2_3", "Route Validation — Request payload fields documented"),
        ck("mes_3_2_4", "Route Validation — Example request provided"),
        ck("mes_3_2_5", "Route Validation — Example success response provided"),
        ck("mes_3_2_6", "Route Validation — Example failure response provided"),
        ck("mes_3_2_7", "Route Validation — Success vs. failure field identified"),
        ck("mes_3_3_1", "Result Reporting (After Test) — Full URL provided"),
        ck("mes_3_3_2", "Result Reporting — HTTP method confirmed"),
        ck("mes_3_3_3", "Result Reporting — Request payload fields documented"),
        ck("mes_3_3_4", "Result Reporting — Example PASS request provided"),
        ck("mes_3_3_5", "Result Reporting — Example FAIL request provided"),
        ck("mes_3_3_6", "Result Reporting — Example success response provided"),
        ck("mes_3_3_7", "Result Reporting — Example failure response provided"),
        ck("mes_3_3_8", "Result Reporting — Error codes for failures confirmed"),
        ck("mes_3_3_9", "Result Reporting — Sub-test vs overall PASS/FAIL reporting confirmed"),
        ck("mes_3_4_1", "Serial Lookup — Dedicated endpoint availability confirmed"),
        ck("mes_3_4_2", "Serial Lookup — Full URL provided (if applicable)"),
        ck("mes_3_4_3", "Serial Lookup — Source confirmed (dedicated endpoint or route validation response)"),
        ck("mes_3_4_4", "Serial Lookup — Returned fields per unit documented"),
        ck("mes_3_4_5", "Serial Lookup — Example request provided"),
        ck("mes_3_4_6", "Serial Lookup — Example response provided"),
      ], links: [], signatures: [] },
      { id: "mes_ms_4", name: "4. Station Names & Route Configuration", description: "Document exact MES station names and routing logic.", color: "#F59E0B", checklist: [
        ck("mes_4_1",  "All MES/SFC station names and descriptions documented"),
        ck("mes_4_9",  "Rework / fail route handling confirmed"),
        ck("mes_4_10", "Multi-MES-name mapping per physical station confirmed"),
        ck("mes_4_11", "MACHINE_CODE or STATION_ID values confirmed per station"),
      ], links: [], signatures: [] },
      { id: "mes_ms_5", name: "5. Authentication & Credentials", description: "Provide API credentials and authentication method.", color: "#DC2626", checklist: [
        ck("mes_5_1", "MES API authentication method confirmed (API key, token, basic auth, etc.)"),
        ck("mes_5_2", "Credentials provided or acquisition process documented"),
        ck("mes_5_3", "Employee ID requirement confirmed"),
        ck("mes_5_4", "Employee ID value or assignment process provided (if required)"),
        ck("mes_5_5", "Separate credentials for test vs. production environments confirmed"),
      ], links: [], signatures: [] },
      { id: "mes_ms_6", name: "6. Test Environment", description: "Provide test server details and sample serial numbers.", color: "#0284C7", checklist: [
        ck("mes_6_1", "Test / staging MES server availability confirmed"),
        ck("mes_6_2", "Test server URL provided"),
        ck("mes_6_3", "Test station name for development provided"),
        ck("mes_6_4", "2–3 valid test serial numbers provided"),
        ck("mes_6_5", "Test environment restrictions documented (hours, rate limits, etc.)"),
      ], links: [], signatures: [] },
      { id: "mes_ms_7", name: "7. Error Handling & Edge Cases", description: "Confirm behavior for all failure and edge-case scenarios.", color: "#64748B", checklist: [
        ck("mes_7_1", "Wrong station scan behavior confirmed (error code / message)"),
        ck("mes_7_2", "Unknown unit in MES behavior confirmed"),
        ck("mes_7_3", "Duplicate result submission behavior confirmed"),
        ck("mes_7_4", "Retest / retry policy documented"),
        ck("mes_7_5", "MES unreachable behavior confirmed (block line or allow inspection to continue)"),
        ck("mes_7_6", "Expected API response time confirmed (for setting timeout values)"),
        ck("mes_7_7", "API rate limits confirmed"),
      ], links: [], signatures: [] },
      { id: "mes_ms_8", name: "8. Data Format & Serial Number Details", description: "Confirm serial number formats, barcodes, and timezone.", color: "#059669", checklist: [
        ck("mes_8_1", "Unit serial number format and 2–3 examples provided"),
        ck("mes_8_2", "Serial number case-sensitivity confirmed"),
        ck("mes_8_3", "Config / SKU barcodes confirmed (in addition to serial numbers)"),
        ck("mes_8_4", "Config / SKU barcode format and examples provided (if applicable)"),
        ck("mes_8_5", "Subassembly serial numbers linked to units confirmed"),
        ck("mes_8_6", "Subassembly types and serial formats documented (if applicable)"),
        ck("mes_8_7", "Timestamp timezone confirmed"),
      ], links: [], signatures: [] },
      { id: "mes_ms_9", name: "9. Go-Live Readiness", description: "Final validation sign-off before production go-live.", color: "#00C9A7", checklist: [
        ck("mes_9_1", "Network connectivity confirmed — stations can reach MES server"),
        ck("mes_9_2", "SSL certificate provided and installed on stations"),
        ck("mes_9_3", "Test serial numbers validated against test environment"),
        ck("mes_9_4", "Route validation tested for all station names"),
        ck("mes_9_5", "Result reporting tested — PASS and FAIL scenarios"),
        ck("mes_9_6", "Serial lookup tested (if applicable)"),
        ck("mes_9_7", "Error scenarios tested (wrong station, unknown SN, MES down)"),
        ck("mes_9_8", "Production MES credentials provided to Instrumental"),
        ck("mes_9_9", "Customer sign-off on integration behavior obtained"),
      ], links: [], signatures: [
        { id: "mes_sig_customer", role: "Customer",         name: "", email: "", signed: false, signedAt: null },
        { id: "mes_sig_tpm",      role: "Instrumental TPM", name: "", email: "", signed: false, signedAt: null },
      ] },
    ],
  };
})();
// Additive patches for existing checklist milestones — applied in getProjectDetails so existing projects
// pick up new items and name changes without a backfill run.
const mk = (id, label, o = "") => ({ id, label, checked: false, na: false, ownership: o, startDate: null, projectedDate: null, actualDate: null, sopLink: null });
const CHECKLIST_PATCHES = [
  {
    catId: "inst_external_checklist", msId: "ext_ms_6",
    newName: "6. Validation & Production Integration (SAT / FAT)",
    newItems: [
      mk("ext_6_5", "Check and pass: calibration", "FDE"),
      mk("ext_6_6", "Check and pass: alignment", "FDE"),
      mk("ext_6_7", "Check and pass with CSE: product image taken post calibration", "FDE, CSE"),
      mk("ext_6_8", "Any additional on-site testing for motion sensing, pneumatic control / movement, custom nest / station press fit design or others (add details in notes)", "FDE, TPM"),
    ],
  },
];
// Standard folder templates auto-injected for any project missing them (e.g. older projects pre-dating the folder)
const STANDARD_FOLDER_TEMPLATES = [
  { id: "pd_specs", name: "Design Specifications & Integration Docs", accessLevel: "open", items: [] },
  { id: "pd_cad",   name: "CAD & Drawings",                           accessLevel: "open", items: [] },
  APP_REFERENCE_INFO_FOLDER,
];
// These 4 tabs use a transposed layout: attributes as rows, stations as columns (mirrors Excel format)
const TRANSPOSED_TABLE_IDS = new Set(["pd_station_kits", "pd_in_factory_install", "pd_camera_settings", "pd_led_settings"]);
const DEFAULT_COMMERCIAL = [
  { id: "comm_agreements", name: "Agreements", accessLevel: "restricted", items: [] },
  { id: "comm_pricing", name: "Pricing Details", accessLevel: "restricted", items: [] },
  { id: "comm_legal", name: "Legal", accessLevel: "restricted", items: [] },
];
/* ═══ TRANSLATIONS ═══ */
const TRANSLATIONS = {
  es: {
    "Deployment Portal": "Portal de Despliegue",
    "Project": "Proyecto", "Language": "Idioma",
    "Overview": "Resumen", "Admin Panel": "Panel de Administración",
    "Manage Projects": "Gestionar Proyectos", "Sign Out": "Cerrar Sesión",
    "Deployment overview": "Resumen de despliegue",
    "Folders": "Carpetas", "Documents": "Documentos",
    "Milestone Progress": "Progreso de Hitos",
    "Add checklist items to track progress": "Añadir elementos para seguir el progreso",
    "Stations": "Estaciones", "inspection stations for this project": "estaciones de inspección para este proyecto",
    "Key Milestones": "Hitos Clave", "Customer View": "Vista del Cliente",
    "Add milestones in Program Details to display here": "Añadir hitos en Detalles del Programa para mostrar aquí",
    "📢 Site Status Banner": "📢 Banner de Estado del Sitio",
    "No status message set.": "Sin mensaje de estado.",
    "Cancel": "Cancelar", "Save": "Guardar", "Clear": "Limpiar", "✎ Edit": "✎ Editar",
    "Hardware & MES Deployments": "Despliegues de Hardware y MES",
    "Specifications & Integration Docs": "Especificaciones y Docs de Integración",
    "Program Details & Timelines": "Detalles del Programa y Cronogramas",
    "Training Documentation": "Documentación de Capacitación",
    "Checklist Milestones": "Hitos de Lista de Verificación",
    "CAD & Drawings": "CAD y Planos", "Agreements": "Acuerdos", "Pricing": "Precios",
    "Legal Documents": "Documentos Legales", "Program Details": "Detalles del Programa",
    "CAD & Specifications": "CAD y Especificaciones", "Process Specifications": "Especificaciones de Proceso",
    "Restricted — contact admin for access": "Restringido — contacte al administrador",
    "items": "elementos", "+ Add Folder": "+ Agregar Carpeta", "Folder Name": "Nombre de Carpeta",
    "Access": "Acceso", "Open": "Abierto", "Restricted": "Restringido", "Create": "Crear",
    "No documents yet.": "Sin documentos aún.", "Link": "Enlace",
    "+ Add Link or PDF": "+ Agregar Enlace o PDF", "Delete Folder": "Eliminar Carpeta",
    "Name": "Nombre", "URL (any format)": "URL (cualquier formato)",
    "PDF URL (must be .pdf)": "URL PDF (debe ser .pdf)", "Document Language": "Idioma del Documento",
    "Add": "Agregar", "Training": "Capacitación", "Enabled": "Habilitado", "Disabled": "Deshabilitado",
    "N/A": "N/A", "Enable": "Habilitar", "+ Add Training Material": "+ Agregar Material de Capacitación",
    "Title": "Título", "Select a project from the sidebar.": "Seleccione un proyecto de la barra lateral.",
    "Access denied.": "Acceso denegado.", "Dashboard": "Panel",
    "Specs, CAD, and business deal locked.": "Especificaciones, CAD y acuerdo comercial cerrados.",
    "Ship hardware + software/ML. Includes FAT criteria.": "Envío de hardware + software/ML. Incluye criterios FAT.",
    "OK to build at CM. SAT criteria.": "Aprobado para fabricar en CM. Criterios SAT.",
    "Specifications finalized and signed off": "Especificaciones finalizadas y aprobadas",
    "CAD files reviewed and approved": "Archivos CAD revisados y aprobados",
    "Business deal / contract locked": "Acuerdo comercial / contrato cerrado",
    "NDA and IP agreements executed": "Acuerdos NDA y PI ejecutados",
    "Pricing and payment terms agreed": "Precios y términos de pago acordados",
    "Stakeholder sign-off obtained": "Aprobación de partes interesadas obtenida",
    "All hardware sourced and assembled": "Todo el hardware adquirido y ensamblado",
    "Software / ML packaged and validated": "Software / ML empaquetado y validado",
    "FAT criteria defined": "Criterios FAT definidos", "FAT executed and passed": "FAT ejecutado y aprobado",
    "FAT report documented and signed": "Informe FAT documentado y firmado",
    "Shipping logistics confirmed": "Logística de envío confirmada",
    "SAT criteria defined": "Criterios SAT definidos", "SAT executed and passed": "SAT ejecutado y aprobado",
    "SAT report documented and signed": "Informe SAT documentado y firmado",
    "CM line readiness confirmed": "Preparación de línea CM confirmada",
    "Hardware installed and calibrated": "Hardware instalado y calibrado",
    "Operator training completed": "Capacitación de operadores completada",
    "Add a checklist item...": "Agregar un elemento de lista...",
    "+ Add Item": "+ Agregar Elemento", "Linked Resources": "Recursos Vinculados",
    "+ Add Link": "+ Agregar Enlace", "Signatures": "Firmas", "+ Add Signature": "+ Agregar Firma",
    "No materials yet.": "Sin materiales aún.",
    "Training is disabled for this party. Toggle above to enable.": "Capacitación deshabilitada para este grupo. Active arriba para habilitar.",
    "Training is not required.": "Capacitación no requerida.",
  },
  vi: {
    "Deployment Portal": "Cổng Triển Khai",
    "Project": "Dự án", "Language": "Ngôn ngữ",
    "Overview": "Tổng quan", "Admin Panel": "Bảng Quản Trị",
    "Manage Projects": "Quản Lý Dự Án", "Sign Out": "Đăng Xuất",
    "Deployment overview": "Tổng quan triển khai",
    "Folders": "Thư mục", "Documents": "Tài liệu",
    "Milestone Progress": "Tiến độ Cột Mốc",
    "Add checklist items to track progress": "Thêm mục kiểm tra để theo dõi tiến độ",
    "Stations": "Trạm", "inspection stations for this project": "trạm kiểm tra cho dự án này",
    "Key Milestones": "Cột Mốc Chính", "Customer View": "Xem của Khách hàng",
    "Add milestones in Program Details to display here": "Thêm cột mốc vào Chi tiết Chương trình để hiển thị ở đây",
    "📢 Site Status Banner": "📢 Thông Báo Trạng Thái Trang",
    "No status message set.": "Chưa có thông báo trạng thái.",
    "Cancel": "Hủy", "Save": "Lưu", "Clear": "Xóa", "✎ Edit": "✎ Chỉnh sửa",
    "Hardware & MES Deployments": "Triển khai Phần cứng & MES",
    "Specifications & Integration Docs": "Tài liệu Thông số & Tích hợp",
    "Program Details & Timelines": "Chi tiết Chương trình & Tiến độ",
    "Training Documentation": "Tài liệu Đào tạo",
    "Checklist Milestones": "Cột Mốc Danh Sách Kiểm Tra",
    "CAD & Drawings": "CAD & Bản vẽ", "Agreements": "Thỏa thuận", "Pricing": "Báo giá",
    "Legal Documents": "Tài liệu Pháp lý", "Program Details": "Chi tiết Chương trình",
    "CAD & Specifications": "CAD & Thông số kỹ thuật", "Process Specifications": "Thông số Quy trình",
    "Restricted — contact admin for access": "Bị hạn chế — liên hệ quản trị viên để truy cập",
    "items": "mục", "+ Add Folder": "+ Thêm Thư mục", "Folder Name": "Tên Thư mục",
    "Access": "Quyền truy cập", "Open": "Mở", "Restricted": "Bị hạn chế", "Create": "Tạo",
    "No documents yet.": "Chưa có tài liệu.", "Link": "Liên kết",
    "+ Add Link or PDF": "+ Thêm Liên kết hoặc PDF", "Delete Folder": "Xóa Thư mục",
    "Name": "Tên", "URL (any format)": "URL (bất kỳ định dạng nào)",
    "PDF URL (must be .pdf)": "URL PDF (phải là .pdf)", "Document Language": "Ngôn ngữ Tài liệu",
    "Add": "Thêm", "Training": "Đào tạo", "Enabled": "Đã bật", "Disabled": "Đã tắt",
    "N/A": "N/A", "Enable": "Bật", "+ Add Training Material": "+ Thêm Tài liệu Đào tạo",
    "Title": "Tiêu đề", "Select a project from the sidebar.": "Chọn một dự án từ thanh bên.",
    "Access denied.": "Truy cập bị từ chối.", "Dashboard": "Bảng điều khiển",
    "Specs, CAD, and business deal locked.": "Thông số, CAD và thỏa thuận kinh doanh đã được chốt.",
    "Ship hardware + software/ML. Includes FAT criteria.": "Vận chuyển phần cứng + phần mềm/ML. Bao gồm tiêu chí FAT.",
    "OK to build at CM. SAT criteria.": "Được phép sản xuất tại CM. Tiêu chí SAT.",
    "Specifications finalized and signed off": "Thông số đã hoàn thiện và được ký duyệt",
    "CAD files reviewed and approved": "Tệp CAD đã được xem xét và phê duyệt",
    "Business deal / contract locked": "Hợp đồng / thỏa thuận kinh doanh đã chốt",
    "NDA and IP agreements executed": "NDA và thỏa thuận IP đã ký kết",
    "Pricing and payment terms agreed": "Đã thống nhất về giá và điều khoản thanh toán",
    "Stakeholder sign-off obtained": "Đã có sự phê duyệt từ các bên liên quan",
    "All hardware sourced and assembled": "Tất cả phần cứng đã được cung cấp và lắp ráp",
    "Software / ML packaged and validated": "Phần mềm / ML đã được đóng gói và xác nhận",
    "FAT criteria defined": "Tiêu chí FAT đã được xác định", "FAT executed and passed": "FAT đã thực hiện và vượt qua",
    "FAT report documented and signed": "Báo cáo FAT đã được ghi lại và ký",
    "Shipping logistics confirmed": "Hậu cần vận chuyển đã được xác nhận",
    "SAT criteria defined": "Tiêu chí SAT đã được xác định", "SAT executed and passed": "SAT đã thực hiện và vượt qua",
    "SAT report documented and signed": "Báo cáo SAT đã được ghi lại và ký",
    "CM line readiness confirmed": "Sẵn sàng dây chuyền CM đã được xác nhận",
    "Hardware installed and calibrated": "Phần cứng đã được lắp đặt và hiệu chỉnh",
    "Operator training completed": "Đào tạo người vận hành đã hoàn thành",
    "Add a checklist item...": "Thêm mục kiểm tra...",
    "+ Add Item": "+ Thêm Mục", "Linked Resources": "Tài nguyên Liên kết",
    "+ Add Link": "+ Thêm Liên kết", "Signatures": "Chữ ký", "+ Add Signature": "+ Thêm Chữ ký",
    "No materials yet.": "Chưa có tài liệu.",
    "Training is disabled for this party. Toggle above to enable.": "Đào tạo đã tắt cho nhóm này. Bật ở trên để kích hoạt.",
    "Training is not required.": "Không cần đào tạo.",
  },
  "zh-tw": {
    "Deployment Portal": "部署門戶",
    "Project": "專案", "Language": "語言",
    "Overview": "概覽", "Admin Panel": "管理面板",
    "Manage Projects": "管理專案", "Sign Out": "登出",
    "Deployment overview": "部署概覽",
    "Folders": "資料夾", "Documents": "文件",
    "Milestone Progress": "里程碑進度",
    "Add checklist items to track progress": "新增清單項目以追蹤進度",
    "Stations": "站點", "inspection stations for this project": "本專案的檢測站",
    "Key Milestones": "關鍵里程碑", "Customer View": "客戶視角",
    "Add milestones in Program Details to display here": "在計劃詳情中新增里程碑以在此顯示",
    "📢 Site Status Banner": "📢 網站狀態橫幅",
    "No status message set.": "未設置狀態訊息。",
    "Cancel": "取消", "Save": "儲存", "Clear": "清除", "✎ Edit": "✎ 編輯",
    "Hardware & MES Deployments": "硬體與 MES 部署",
    "Specifications & Integration Docs": "規格與整合文件",
    "Program Details & Timelines": "計劃詳情與時程",
    "Training Documentation": "培訓文件",
    "Checklist Milestones": "清單里程碑",
    "CAD & Drawings": "CAD 與圖紙", "Agreements": "協議", "Pricing": "定價",
    "Legal Documents": "法律文件", "Program Details": "計劃詳情",
    "CAD & Specifications": "CAD 與規格", "Process Specifications": "流程規格",
    "Restricted — contact admin for access": "受限 — 請聯絡管理員以獲取訪問權限",
    "items": "項目", "+ Add Folder": "+ 新增資料夾", "Folder Name": "資料夾名稱",
    "Access": "訪問", "Open": "開放", "Restricted": "受限", "Create": "建立",
    "No documents yet.": "尚無文件。", "Link": "連結",
    "+ Add Link or PDF": "+ 新增連結或 PDF", "Delete Folder": "刪除資料夾",
    "Name": "名稱", "URL (any format)": "URL（任何格式）",
    "PDF URL (must be .pdf)": "PDF URL（必須為 .pdf）", "Document Language": "文件語言",
    "Add": "新增", "Training": "培訓", "Enabled": "已啟用", "Disabled": "已停用",
    "N/A": "不適用", "Enable": "啟用", "+ Add Training Material": "+ 新增培訓材料",
    "Title": "標題", "Select a project from the sidebar.": "從側邊欄選擇一個專案。",
    "Access denied.": "訪問被拒絕。", "Dashboard": "儀表板",
    "Specs, CAD, and business deal locked.": "規格、CAD 和商業協議已鎖定。",
    "Ship hardware + software/ML. Includes FAT criteria.": "出貨硬體 + 軟體/ML。包含 FAT 標準。",
    "OK to build at CM. SAT criteria.": "可在 CM 開始生產。SAT 標準。",
    "Specifications finalized and signed off": "規格已完成並簽核",
    "CAD files reviewed and approved": "CAD 檔案已審查並批准",
    "Business deal / contract locked": "商業協議/合約已鎖定",
    "NDA and IP agreements executed": "NDA 和 IP 協議已執行",
    "Pricing and payment terms agreed": "價格和付款條件已議定",
    "Stakeholder sign-off obtained": "已獲得利益相關者的簽核",
    "All hardware sourced and assembled": "所有硬體已採購並組裝",
    "Software / ML packaged and validated": "軟體 / ML 已打包並驗證",
    "FAT criteria defined": "FAT 標準已定義", "FAT executed and passed": "FAT 已執行並通過",
    "FAT report documented and signed": "FAT 報告已記錄並簽署",
    "Shipping logistics confirmed": "物流安排已確認",
    "SAT criteria defined": "SAT 標準已定義", "SAT executed and passed": "SAT 已執行並通過",
    "SAT report documented and signed": "SAT 報告已記錄並簽署",
    "CM line readiness confirmed": "CM 產線準備就緒已確認",
    "Hardware installed and calibrated": "硬體已安裝並校準",
    "Operator training completed": "操作員培訓已完成",
    "Add a checklist item...": "新增清單項目...",
    "+ Add Item": "+ 新增項目", "Linked Resources": "相關資源",
    "+ Add Link": "+ 新增連結", "Signatures": "簽署", "+ Add Signature": "+ 新增簽署",
    "No materials yet.": "尚無材料。",
    "Training is disabled for this party. Toggle above to enable.": "已為此方停用培訓。點擊上方切換以啟用。",
    "Training is not required.": "不需要培訓。",
  },
  "zh-cn": {
    "Deployment Portal": "部署门户",
    "Project": "项目", "Language": "语言",
    "Overview": "概览", "Admin Panel": "管理面板",
    "Manage Projects": "管理项目", "Sign Out": "退出登录",
    "Deployment overview": "部署概览",
    "Folders": "文件夹", "Documents": "文件",
    "Milestone Progress": "里程碑进度",
    "Add checklist items to track progress": "添加清单项目以跟踪进度",
    "Stations": "站点", "inspection stations for this project": "本项目的检测站",
    "Key Milestones": "关键里程碑", "Customer View": "客户视图",
    "Add milestones in Program Details to display here": "在计划详情中添加里程碑以在此显示",
    "📢 Site Status Banner": "📢 网站状态横幅",
    "No status message set.": "未设置状态消息。",
    "Cancel": "取消", "Save": "保存", "Clear": "清除", "✎ Edit": "✎ 编辑",
    "Hardware & MES Deployments": "硬件与MES部署",
    "Specifications & Integration Docs": "规格与集成文档",
    "Program Details & Timelines": "计划详情与时间线",
    "Training Documentation": "培训文档",
    "Checklist Milestones": "清单里程碑",
    "CAD & Drawings": "CAD与图纸", "Agreements": "协议", "Pricing": "定价",
    "Legal Documents": "法律文件", "Program Details": "计划详情",
    "CAD & Specifications": "CAD与规格", "Process Specifications": "流程规格",
    "Restricted — contact admin for access": "受限 — 请联系管理员获取访问权限",
    "items": "项目", "+ Add Folder": "+ 添加文件夹", "Folder Name": "文件夹名称",
    "Access": "访问", "Open": "开放", "Restricted": "受限", "Create": "创建",
    "No documents yet.": "暂无文件。", "Link": "链接",
    "+ Add Link or PDF": "+ 添加链接或PDF", "Delete Folder": "删除文件夹",
    "Name": "名称", "URL (any format)": "URL（任何格式）",
    "PDF URL (must be .pdf)": "PDF URL（必须为 .pdf）", "Document Language": "文件语言",
    "Add": "添加", "Training": "培训", "Enabled": "已启用", "Disabled": "已停用",
    "N/A": "不适用", "Enable": "启用", "+ Add Training Material": "+ 添加培训材料",
    "Title": "标题", "Select a project from the sidebar.": "从侧边栏选择一个项目。",
    "Access denied.": "访问被拒绝。", "Dashboard": "仪表板",
    "Specs, CAD, and business deal locked.": "规格、CAD和商业协议已锁定。",
    "Ship hardware + software/ML. Includes FAT criteria.": "发货硬件+软件/ML。包含FAT标准。",
    "OK to build at CM. SAT criteria.": "可在CM处开始生产。SAT标准。",
    "Specifications finalized and signed off": "规格已最终确定并签批",
    "CAD files reviewed and approved": "CAD文件已审查并批准",
    "Business deal / contract locked": "商业协议/合同已锁定",
    "NDA and IP agreements executed": "NDA和IP协议已签署",
    "Pricing and payment terms agreed": "价格和付款条款已商定",
    "Stakeholder sign-off obtained": "已获得利益相关者批准",
    "All hardware sourced and assembled": "所有硬件已采购并组装",
    "Software / ML packaged and validated": "软件/ML已打包并验证",
    "FAT criteria defined": "FAT标准已定义", "FAT executed and passed": "FAT已执行并通过",
    "FAT report documented and signed": "FAT报告已记录并签署",
    "Shipping logistics confirmed": "物流安排已确认",
    "SAT criteria defined": "SAT标准已定义", "SAT executed and passed": "SAT已执行并通过",
    "SAT report documented and signed": "SAT报告已记录并签署",
    "CM line readiness confirmed": "CM产线就绪已确认",
    "Hardware installed and calibrated": "硬件已安装并校准",
    "Operator training completed": "操作员培训已完成",
    "Add a checklist item...": "添加清单项目...",
    "+ Add Item": "+ 添加项目", "Linked Resources": "相关资源",
    "+ Add Link": "+ 添加链接", "Signatures": "签署", "+ Add Signature": "+ 添加签署",
    "No materials yet.": "暂无材料。",
    "Training is disabled for this party. Toggle above to enable.": "已为此方停用培训。点击上方切换以启用。",
    "Training is not required.": "不需要培训。",
  },
};
const t = (key, lang = "en") => { if (!lang || lang === "en" || !key) return key; return TRANSLATIONS[lang]?.[key] ?? key; };

const getDefault = () => ({ projects: SEED_PROJECTS, progress: {}, docData: {}, statusMessage: "", siProjects: {} });

/* ═══ HELPERS ═══ */
const F = "'Times New Roman', Georgia, serif";
const fmtDate = (iso) => { if (!iso) return "—"; return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
const fmtDay = (iso) => { if (!iso) return "—"; return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
const genId = () => `id_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const getProjectDetails = (dd, pid) => {
  const cats = dd?.[pid]?.projectDetails || DEFAULT_PROJECT_DETAILS;
  const merged = cats.map(cat => {
    const tmpl = APP_TABLE_TEMPLATES.find(t => t.id === cat.id);
    if (!tmpl || cat.type !== "table") return cat;
    // Additive column merge: keep Firebase cols, append new template cols not yet present
    const deletedKeys = new Set(cat.deletedCols || []);
    const existingKeys = new Set((cat.columns || []).map(c => c.key));
    const newCols = tmpl.columns.filter(c => !existingKeys.has(c.key) && !deletedKeys.has(c.key));
    return { ...cat, columns: [...(cat.columns || []), ...newCols] };
  });
  // Also inject any template cats missing from Firebase entirely (e.g. added after ensureProjectTemplate last ran)
  const existingIds = new Set(merged.map(c => c.id));
  const missingTmplCats = APP_TABLE_TEMPLATES.filter(t => !existingIds.has(t.id));
  const missingFolderCats = STANDARD_FOLDER_TEMPLATES.filter(t => !existingIds.has(t.id));
  const missingChecklistCats = [APP_MES_CHECKLIST_TEMPLATE].filter(t => !existingIds.has(t.id));
  // Apply additive patches: rename milestones + inject new checklist items for existing projects
  const patched = [...merged, ...missingTmplCats, ...missingFolderCats, ...missingChecklistCats].map(cat => {
    const patch = CHECKLIST_PATCHES.find(p => p.catId === cat.id);
    if (!patch || cat.type !== "checklist") return cat;
    return {
      ...cat,
      milestones: (cat.milestones || []).map(ms => {
        if (ms.id !== patch.msId) return ms;
        const existingItemIds = new Set((ms.checklist || []).map(ck => ck.id));
        const newItems = patch.newItems.filter(ni => !existingItemIds.has(ni.id));
        return { ...ms, name: patch.newName || ms.name, checklist: [...(ms.checklist || []), ...newItems] };
      }),
    };
  });
  return patched;
};
const getCommercial = (dd, pid) => dd?.[pid]?.commercial || DEFAULT_COMMERCIAL;
const isInst = (u) => u?.role === "admin" || (u?.email || "").endsWith("@instrumental.com");
const isExternal = (u) => u && u.role !== "admin" && !(u.email || "").endsWith("@instrumental.com");
// Normalize projects from DB (may be array or object-keyed) into an array
const projectsToArray = (v) => !v ? [] : (Array.isArray(v) ? v : Object.values(v));
// Parse hardware field from HubSpot — could be number, numeric string, or descriptive string
const parseHwCount = (v) => { if (v == null || v === "") return 0; if (typeof v === "number") return v; const m = String(v).match(/\d+/); return m ? parseInt(m[0]) : 0; };
// v4.0.0: effective hardware count — docData override (Instrumental-writable) wins over HubSpot suggestion.
const getEffectiveHw = (project, key, docData) => {
  const ov = docData?.[project?.id]?._hardwareOverride?.[key];
  if (ov && ov.value != null) return ov.value;
  return project?.hardware?.[key];
};
const getEffectiveHwCount = (project, key, docData) => parseHwCount(getEffectiveHw(project, key, docData));

// v4.1.0 — HubSpot project record hyperlinks (Instrumental portal — na2 region)
const HUBSPOT_PORTAL_ID = "46433248";
const HUBSPOT_HOST = "app-na2.hubspot.com";
const HUBSPOT_OBJECT_TYPE = "2-39524389";
const hubspotProjectUrl = (project) =>
  project?.hubspotId
    ? `https://${HUBSPOT_HOST}/contacts/${HUBSPOT_PORTAL_ID}/record/${HUBSPOT_OBJECT_TYPE}/${project.hubspotId}`
    : null;
const HubspotLinkIcon = ({ project, style }) => {
  const url = hubspotProjectUrl(project);
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
       title="Open in HubSpot"
       style={{ marginLeft: 6, color: "#FF7A59", textDecoration: "none", fontSize: 13, ...style }}
       onClick={e => e.stopPropagation()}>
      🔗
    </a>
  );
};

// Standard HubSpot-synced hardware fields → display labels
const HUBSPOT_HW_FIELDS = [
  { key: "cameras", label: "Cameras" },
  { key: "lenses", label: "Lenses (Regular)" },
  { key: "tcLense", label: "Lenses (TC)" },
  { key: "ledControllers", label: "LED Light Controllers" },
  { key: "standardFrames", label: "Station Frames (Standard)" },
  { key: "largeFrames", label: "Station Frames (Large)" },
  { key: "computers", label: "Station Computers" },
  { key: "monitors", label: "Monitors" },
  { key: "barcodeScanner", label: "Barcode Scanners" },
];

/* ═══ MICRO COMPONENTS ═══ */
const Bar = ({ value, color = "#3B82F6", h = 6 }) => (
  <div style={{ width: "100%", borderRadius: 99, background: "#E2E8F0", height: h, overflow: "hidden" }}>
    <div style={{ height: h, borderRadius: 99, width: `${Math.min(100, Math.max(0, value))}%`, background: color, transition: "width .5s ease" }} />
  </div>
);
const Chip = ({ children, color = "#F1F5F9", fg = "#475569", small }) => (
  <span style={{ display: "inline-flex", alignItems: "center", padding: small ? "2px 8px" : "4px 12px", borderRadius: 8, background: color, color: fg, fontSize: small ? 11 : 12, fontWeight: 600, fontFamily: F }}>{children}</span>
);

/* v4.1.0 — File upload button. Accepts PDF, Office docs, images, text/CSV, .lbx label files.
   Wraps a hidden <input type="file"> with progress feedback. */
function FileUploadButton({ projectId, onUploaded, label = "📎 Upload File", style }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    if (file) e.target.value = ""; // reset so same file can be re-selected
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadFileToStorage(file, projectId);
      if (url) onUploaded(url, file.name);
    } catch (err) {
      console.error("File upload failed:", err);
      alert("Upload failed: " + (err?.message || String(err)));
    }
    setBusy(false);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        style={{
          padding: "6px 12px", fontSize: 12, fontWeight: 600,
          border: "1px solid #C7D2FE", borderRadius: 6,
          background: busy ? "#E0E7FF" : "#EEF2FF", color: "#4338CA",
          cursor: busy ? "wait" : "pointer", fontFamily: F,
          ...style,
        }}
      >
        {busy ? "Uploading…" : label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.csv,.txt,.lbx,image/*"
        onChange={handleChange}
        style={{ display: "none" }}
      />
    </>
  );
}
// Back-compat alias — older JSX may still use <PdfUploadButton>
const PdfUploadButton = FileUploadButton;

/* ═══ LOGIN ═══ */
function Login({ err }) {
  const [loading, setLoading] = useState(false);
  const [rem, setRem] = useState(false);
  const go = async () => { setLoading(true); try { localStorage.setItem("dp_remember", rem ? "72" : "0"); await signInWithPopup(auth, googleProvider); } catch(e) { console.error(e); setLoading(false); } };
  return (
    <div style={S.loginWrap}>
      <div style={S.loginCard}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 44, color: "#00C9A7", marginBottom: 10 }}>◎</div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: "#0F172A", fontFamily: F }}>Deployment Portal</h1>
          <p style={{ fontSize: 16, color: "#64748B", marginTop: 8, fontFamily: F }}>Documentation · Training · Tracking</p>
        </div>
        {err && <p style={{ color: "#DC2626", fontSize: 14, textAlign: "center", marginBottom: 16 }}>{err}</p>}
        <button style={{ ...S.btnMain, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 0, fontSize: 16, padding: "16px 0" }} onClick={go} disabled={loading}>
          <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0124 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>
          {loading ? "Signing in…" : "Sign in with Google"}
        </button>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 16, cursor: "pointer" }} onClick={() => setRem(!rem)}>
          <div style={{ width: 20, height: 20, borderRadius: 5, border: `2px solid ${rem ? "#00C9A7" : "#CBD5E1"}`, background: rem ? "#00C9A7" : "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: "#FFF", transition: "all .15s" }}>{rem ? "✓" : ""}</div>
          <span style={{ fontSize: 14, color: "#64748B", fontFamily: F }}>Remember me for 72 hours</span>
        </div>
      </div>
    </div>
  );
}

function PendingApproval({ authUser, onLogout }) {
  return (
    <div style={S.loginWrap}>
      <div style={S.loginCard}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⏳</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#0F172A", fontFamily: F }}>Access Pending</h1>
          <p style={{ fontSize: 15, color: "#64748B", margin: "12px 0", fontFamily: F }}>Signed in as <b>{authUser.email}</b>.<br/>Your admin needs to approve your account.</p>
          <button style={{ ...S.btnFlat, marginTop: 8 }} onClick={onLogout}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

/* ═══ SIDEBAR — v3.2.0: unified sections (no party tabs) ═══ */
function Sidebar({ view, setView, user, project, projects, setProject, onLogout, lang, setLang, hasCommercialAccess, cats, setDetailTab }) {
  const admin = isInst(user);
  const [subOpen, setSubOpen] = useState(true);
  const dropdownProjects = admin ? projects.filter(p => p.status !== "inactive" && p.hubspotPipelineId !== SI_PARTNER_PIPELINE_ID) : projects.filter(p => p.status === "active");
  // v4.0.2 — single-control combobox replaces the old <input>+<select> pair (which was glitchy on macOS browsers).
  const [projSearch, setProjSearch] = useState("");
  const [projOpen, setProjOpen] = useState(false);
  const filteredProjects = projSearch.trim() ? dropdownProjects.filter(p => p.name.toLowerCase().includes(projSearch.trim().toLowerCase())) : dropdownProjects;
  const pickProject = (p) => { setProject(p); setProjSearch(""); setProjOpen(false); };
  const navActive = (v) => view === v ? { background: "rgba(255,255,255,.1)", color: "#F1F5F9", borderLeftColor: "#00C9A7" } : {};
  return (
    <aside style={S.side}>
      <div style={S.sideHead}><span style={{ fontSize: 24, color: "#00C9A7" }}>◎</span><span style={S.sideTitle}>{t("Deployment Portal", lang)}</span></div>
      {admin && (
        <div style={{ padding: "0 12px 6px" }}>
          <button onClick={() => setView("projects_overview")} style={{ ...S.navBtn, width: "100%", fontSize: 20, fontWeight: 800, padding: "16px 16px", ...(view === "projects_overview" ? { background: "rgba(0,201,167,.15)", color: "#00C9A7", borderLeftColor: "#00C9A7" } : {}) }}>🌐 All Projects Overview (Non-SI)</button>
          <button onClick={() => setView("all_si_projects")} style={{ ...S.navBtn, fontSize: 14, paddingTop: 9, paddingBottom: 9, ...(view === "all_si_projects" ? { background: "rgba(255,255,255,.1)", color: "#F1F5F9", borderLeftColor: "#00C9A7" } : {}) }}>🤝 All SI Projects</button>
        </div>
      )}
      {/* Project combobox — single control: type to filter, click row to select. */}
      <div style={{ padding: "0 18px 12px", position: "relative" }}>
        <label style={S.sideLabel}>{t("Project", lang)}</label>
        <input
          style={{ ...S.projSelect, padding: "8px 12px", fontSize: 13 }}
          placeholder={project ? "" : "Search projects…"}
          value={projOpen ? projSearch : (project?.name || "")}
          onChange={e => { setProjSearch(e.target.value); if (!projOpen) setProjOpen(true); }}
          onFocus={() => { setProjSearch(""); setProjOpen(true); }}
          onBlur={() => setTimeout(() => setProjOpen(false), 180)}
        />
        {projOpen && (
          <div style={{ position: "absolute", top: "100%", left: 18, right: 18, marginTop: 4, maxHeight: 280, overflowY: "auto", background: "#1E293B", border: "1px solid #334155", borderRadius: 6, zIndex: 100, boxShadow: "0 4px 12px rgba(0,0,0,.35)" }}>
            {filteredProjects.length === 0 ? (
              <div style={{ padding: "10px 12px", color: "#64748B", fontSize: 12, fontFamily: F, fontStyle: "italic" }}>No projects{projSearch ? " matching search" : ""}</div>
            ) : filteredProjects.slice(0, 50).map(p => (
              <button
                key={p.id}
                onMouseDown={() => pickProject(p)}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", background: project?.id === p.id ? "rgba(0,201,167,.18)" : "transparent", border: "none", color: "#F1F5F9", fontSize: 13, fontFamily: F, cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,.04)" }}
                onMouseOver={e => { if (project?.id !== p.id) e.currentTarget.style.background = "rgba(255,255,255,.06)"; }}
                onMouseOut={e => { if (project?.id !== p.id) e.currentTarget.style.background = "transparent"; }}
              >
                {p.name}{p.status === "deprecated" ? " (Past)" : p.status === "inactive" ? " (Inactive)" : ""}
              </button>
            ))}
            {filteredProjects.length > 50 && <div style={{ padding: "6px 12px", fontSize: 11, color: "#94A3B8", fontStyle: "italic" }}>{filteredProjects.length - 50} more — refine your search</div>}
          </div>
        )}
      </div>
      <nav style={S.navList}>
        {/* Overview — slightly bigger font */}
        <button onClick={() => setView("dashboard")} style={{ ...S.navBtn, fontSize: 17, fontWeight: 600, ...navActive("dashboard") }}>{"⊙ " + t("Overview", lang)}</button>
        <div style={S.divider} />
        {/* Project Details — with collapse/expand chevron */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <button onClick={() => setView("project_details")} style={{ ...S.navBtn, flex: 1, width: "auto", ...navActive("project_details") }}>📋 Project Details</button>
          {project && (
            <button onClick={() => setSubOpen(o => !o)} style={{ padding: "8px 10px", background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 14, lineHeight: 1, fontFamily: F }}>
              {subOpen ? "▾" : "▸"}
            </button>
          )}
        </div>
        {/* Sub-nav items. Instrumental sees all; external users see only the 3 open folders. */}
        {project && subOpen && (() => {
          const EXTERNAL_VISIBLE = new Set(["pd_specs", "pd_cad", "pd_deployment_requirements"]);
          const subCats = cats.filter(c => c.type !== "program");
          const items = (subCats.length > 0 ? subCats : APP_TABLE_TEMPLATES)
            .filter(c => admin || EXTERNAL_VISIBLE.has(c.id))
            .sort((a, b) => {
              const ai = TAB_ORDER.indexOf(a.id);
              const bi = TAB_ORDER.indexOf(b.id);
              if (ai === -1 && bi === -1) return 0;
              if (ai === -1) return 1;
              if (bi === -1) return -1;
              return ai - bi;
            });
          return items.map(cat => {
            const icon = cat.type === "table" ? "📊" : cat.type === "checklist" ? "📋" : "📁";
            const isActive = view === "project_details" && localStorage.getItem(`dp_proj_tab_${project.id}`) === cat.id;
            return (
              <button key={cat.id} onClick={() => setDetailTab(cat.id)} style={{
                ...S.navBtn, fontSize: 13, paddingTop: 9, paddingBottom: 9, paddingLeft: 32,
                ...(isActive ? { background: "rgba(255,255,255,.1)", color: "#F1F5F9", borderLeftColor: "#00C9A7" } : {}),
              }}>{icon} {cat.name}</button>
            );
          });
        })()}
        {/* Commercial — restricted indicator */}
        <button onClick={() => setView("commercial")} style={{ ...S.navBtn, ...navActive("commercial"), color: view === "commercial" ? "#F1F5F9" : hasCommercialAccess ? "#94A3B8" : "#64748B" }}>
          {hasCommercialAccess ? "📂" : "🔒"} Commercial
        </button>
        {/* Training */}
        <button onClick={() => setView("training")} style={{ ...S.navBtn, ...navActive("training") }}>🎓 Training</button>
        {/* AI Chat — available to all authenticated users */}
        <button onClick={() => setView("chat")} style={{ ...S.navBtn, ...navActive("chat") }}>💬 AI Chat</button>
        {/* Admin only */}
        {admin && (<>
          <div style={S.divider} />
          <button onClick={() => setView("admin")} style={{ ...S.navBtn, ...navActive("admin") }}>{"⊞ " + t("Admin Panel", lang)}</button>
          <button onClick={() => setView("manage")} style={{ ...S.navBtn, ...navActive("manage") }}>{"⊕ " + t("Manage Projects", lang)}</button>
        </>)}
      </nav>
      <div style={S.sideFoot}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          {user.photoURL ? <img src={user.photoURL} style={{ width: 34, height: 34, borderRadius: 10 }} alt="" referrerPolicy="no-referrer" /> : <div style={{ ...S.ava, background: "#00C9A7" }}>{(user.name||"?")[0]}</div>}
          <div><div style={{ fontSize: 14, fontWeight: 600, color: "#F1F5F9", fontFamily: F }}>{user.name}</div><div style={{ fontSize: 11, color: "#94A3B8" }}>{user.role}</div></div>
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={{ ...S.sideLabel, marginBottom: 4 }}>{t("Language", lang)}</label>
          <select style={{ ...S.projSelect, fontSize: 12 }} value={lang} onChange={e => { setLang(e.target.value); if (user?.id) dbWrite(`users/${user.id}/langPref`, e.target.value).catch(() => {}); }}>
            {LANGUAGES.map(l => <option key={l.id} value={l.id}>{l.flag} {l.label}</option>)}
          </select>
        </div>
        <button style={{ ...S.btnOut, marginTop: 10 }} onClick={onLogout}>{t("Sign Out", lang)}</button>
      </div>
    </aside>
  );
}

/* ═══ DASHBOARD — v3.2.0: simplified for externals, full for instrumental ═══ */
function DashboardView({ user, project, state, setState, lang = "en", setView }) {
  const admin = isInst(user);
  const [editStations, setEditStations] = useState(null);
  const [stationVal, setStationVal] = useState("");
  const [editStatus, setEditStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState(state?.statusMessage || "");

  if (!project) return <div style={S.page}><div style={S.empty}>{t("Select a project from the sidebar.", lang)}</div></div>;

  const progMilestones = (state.docData?.[project.id]?._programDetails?.tasks || []).filter(t => t.type === "milestone").sort((a, b) => new Date(a.date) - new Date(b.date));

  // External users — show stations, milestones, Project Overview (read-only), Hardware (read-only), and Gantt toggle
  if (isExternal(user)) {
    return (
      <div style={S.page}>
        <h2 style={S.h2}>{project.name}</h2>
        <p style={S.sub}>{t("Deployment overview", lang)}</p>
        <div style={{ ...S.card, borderTop: "3px solid #F59E0B" }}>
          <div style={{ fontSize: 14, color: "#64748B", fontFamily: F, marginBottom: 6 }}>{t("Stations", lang)}</div>
          <div style={{ fontSize: 42, fontWeight: 800, color: "#0F172A", fontFamily: F }}>{project.stations || 0}</div>
          <div style={{ fontSize: 13, color: "#94A3B8", fontFamily: F }}>{t("inspection stations for this project", lang)}</div>
        </div>
        {/* v4.1.0: external users now also see Project Overview + Hardware (read-only via canEdit gating) + Gantt */}
        <ProjectOverviewSection project={project} state={state} setState={setState} user={user} />
        <ProjectHardwareSection project={project} state={state} setState={setState} user={user} />
        <GanttChartToggle project={project} state={state} />
      </div>
    );
  }

  // Instrumental / admin dashboard — section summary cards
  const pdCats = getProjectDetails(state.docData, project.id);
  const pdItems = pdCats.reduce((a, c) => a + (c.items?.length || 0), 0);
  const allChecks = pdCats.filter(c => c.type === "checklist").flatMap(c => c.milestones || []).flatMap(ms => ms.checklist || []);
  const checkedCount = allChecks.filter(ck => ck.checked && !ck.na).length;
  const activeCount = allChecks.filter(ck => !ck.na).length;
  const msPct = activeCount > 0 ? Math.round((checkedCount / activeCount) * 100) : null;
  const trainingData = state.docData?.[project.id]?._training || {};
  const trainingEnabled = trainingData.enabled || false;

  return (
    <div style={S.page}>
      {/* Status banner editor */}
      {admin && (
        <div style={{ ...S.card, marginBottom: 20, borderLeft: "3px solid #00C9A7", padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#00C9A7", fontFamily: F }}>📢 Site Status Banner</span>
            <button style={S.btnEdit} onClick={() => setEditStatus(!editStatus)}>{editStatus ? "Cancel" : "✎ Edit"}</button>
          </div>
          {editStatus ? (
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input style={{ ...S.inp, flex: 1, padding: "8px 12px", fontSize: 14 }} value={statusDraft} onChange={e => setStatusDraft(e.target.value)} placeholder="e.g. Under construction — going live April 2026" />
              <button style={{ ...S.btnMain, width: "auto", padding: "8px 16px", fontSize: 13, marginTop: 0 }} onClick={() => { setState(prev => ({ ...prev, statusMessage: statusDraft })); setEditStatus(false); }}>Save</button>
              <button style={{ ...S.btnDel, padding: "8px 12px" }} onClick={() => { setState(prev => ({ ...prev, statusMessage: "" })); setStatusDraft(""); setEditStatus(false); }}>Clear</button>
            </div>
          ) : <p style={{ fontSize: 14, color: state?.statusMessage ? "#0F172A" : "#94A3B8", marginTop: 8, fontFamily: F, fontStyle: state?.statusMessage ? "normal" : "italic" }}>{state?.statusMessage || "No status message set."}</p>}
        </div>
      )}

      <h2 style={S.h2}>{project.name}<HubspotLinkIcon project={project} /></h2>
      <p style={S.sub}>Deployment overview</p>

      {/* Section summary cards */}
      <div style={S.gridRow}>
        <div onClick={() => setView("project_details")} style={{ ...S.card, flex: "1 1 240px", borderTop: "3px solid #00C9A7", cursor: "pointer", transition: "box-shadow .15s" }} onMouseEnter={e => e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,.10)"} onMouseLeave={e => e.currentTarget.style.boxShadow=""}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#00C9A7", fontFamily: F, marginBottom: 8 }}>📋 Project Details ↗</div>
          <div style={S.miniStat}><span>Folders</span><strong>{pdCats.length}</strong></div>
          <div style={S.miniStat}><span>Documents</span><strong>{pdItems || "—"}</strong></div>
          {activeCount > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#64748B", fontFamily: F, marginBottom: 4 }}>
                <span>Checklist Progress</span><strong style={{ color: "#00C9A7" }}>{msPct}%</strong>
              </div>
              <Bar value={msPct} color="#00C9A7" h={4} />
            </div>
          )}
        </div>
        <div onClick={() => setView("commercial")} style={{ ...S.card, flex: "1 1 200px", borderTop: "3px solid #F59E0B", cursor: "pointer", transition: "box-shadow .15s" }} onMouseEnter={e => e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,.10)"} onMouseLeave={e => e.currentTarget.style.boxShadow=""}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#F59E0B", fontFamily: F, marginBottom: 8 }}>🔒 Commercial ↗</div>
          <div style={{ fontSize: 13, color: "#94A3B8", fontFamily: F }}>Agreements, Pricing, Legal</div>
          <div style={{ fontSize: 12, color: "#CBD5E1", fontStyle: "italic", fontFamily: F, marginTop: 6 }}>Restricted — admin grant required</div>
        </div>
        <div onClick={() => setView("training")} style={{ ...S.card, flex: "1 1 200px", borderTop: "3px solid #3B82F6", cursor: "pointer", transition: "box-shadow .15s" }} onMouseEnter={e => e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,.10)"} onMouseLeave={e => e.currentTarget.style.boxShadow=""}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#3B82F6", fontFamily: F, marginBottom: 8 }}>🎓 Training ↗</div>
          <Chip small color={trainingEnabled ? "#ECFDF5" : "#F1F5F9"} fg={trainingEnabled ? "#059669" : "#94A3B8"}>{trainingEnabled ? "Enabled" : "Disabled"}</Chip>
        </div>
      </div>

      {/* Station count editor */}
      {admin && (
        <div style={{ ...S.card, marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F }}>Stations: {project.stations || 0}</span>
            {editStations === project.id ? (
              <div style={{ display: "flex", gap: 8 }}>
                <input type="number" style={{ ...S.inp, width: 100, padding: "6px 10px" }} value={stationVal} onChange={e => setStationVal(e.target.value)} placeholder="0" />
                <button style={{ ...S.btnMain, width: "auto", padding: "6px 14px", fontSize: 13, marginTop: 0 }} onClick={() => { setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id === project.id ? { ...p, stations: parseInt(stationVal)||0 } : p) })); setEditStations(null); }}>Save</button>
              </div>
            ) : <button style={S.btnEdit} onClick={() => { setEditStations(project.id); setStationVal(project.stations || ""); }}>✎ Edit</button>}
          </div>
        </div>
      )}

      {/* External view preview — stations + Project Overview dates */}
      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 12, paddingBottom: 8, borderBottom: "2px solid #F1F5F9" }}>External User View</div>
        <div style={{ ...S.card, borderTop: "3px solid #F59E0B" }}>
          <div style={{ fontSize: 14, color: "#64748B", fontFamily: F, marginBottom: 6 }}>Stations</div>
          <div style={{ fontSize: 42, fontWeight: 800, color: "#0F172A", fontFamily: F }}>{project.stations || 0}</div>
          <div style={{ fontSize: 13, color: "#94A3B8", fontFamily: F }}>inspection stations for this project</div>
        </div>
      </div>

      {/* Hardware — HubSpot-synced (read-only) + Custom manual entries */}
      {/* v4.1.0: Gantt is toggleable; disabled if < 3 dates */}
      <GanttChartToggle project={project} state={state} />

      {/* SI-specific details */}
      {project.isSI && (
        <div style={{ ...S.card, marginTop: 16, borderLeft: "3px solid #3B82F6" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#3B82F6", fontFamily: F, marginBottom: 8 }}>SI Deployment Details</div>
          <div style={S.miniStat}><span>SI Pipeline Stage</span><strong>{SI_PIPELINE_STAGES.find(s => s.id === normalizeSiStage(project.siStage))?.label || "SIRD"}</strong></div>
          <div style={S.miniStat}><span>Checklist Completion</span><strong>{(() => { const cats = getProjectDetails(state.docData, project.id); const all = cats.filter(c => c.type === "checklist").flatMap(c => (c.milestones||[]).flatMap(ms => ms.checklist||[])); const active = all.filter(ck => !ck.na); const done = active.filter(ck => ck.checked); return active.length > 0 ? `${Math.round(done.length / active.length * 100)}% (${done.length}/${active.length})` : "—"; })()}</strong></div>
          <div style={S.miniStat}><span>Stations</span><strong>{project.stations || 0}</strong></div>
        </div>
      )}

      <ProjectOverviewSection project={project} state={state} setState={setState} user={user} />
      <ProjectHardwareSection project={project} state={state} setState={setState} user={user} />
      {/* v4.1.0: HardwareTrackingSection removed — duplicates ProjectHardwareSection */}
    </div>
  );
}

/* ═══ PROJECT OVERVIEW SECTION — v4.1.0: writeback to HubSpot on date field save ═══ */
function ProjectOverviewSection({ project, state, setState, user }) {
  const canEdit = isInst(user);
  const pid = project?.id;
  const overview = state.projectOverview?.[pid] || {};
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(overview);
  const [botLoading, setBotLoading] = useState(false);
  // "idle" | "syncing" | "ok" | "error"
  const [writebackStatus, setWritebackStatus] = useState("idle");
  useEffect(() => { if (!editing) setDraft(overview); }, [editing, overview, pid]);

  const DATE_KEYS = ["cadCompleteDate", "cadActualFinishDate", "actualServiceStartDate", "targetBuildDate", "actualDeployDate"];

  const save = async () => {
    if (!canEdit || !pid) return;
    const next = { ...draft, updatedAt: new Date().toISOString(), updatedBy: user.name };
    setState(prev => ({ ...prev, projectOverview: { ...(prev.projectOverview||{}), [pid]: next } }));
    setEditing(false);

    // Writeback date fields to HubSpot if the project has a hubspotId
    const hubspotId = project?.hubspotId;
    if (!hubspotId) return;
    const changedFields = {};
    DATE_KEYS.forEach(k => {
      if (draft[k] !== overview[k]) changedFields[k] = draft[k] || null;
    });
    if (Object.keys(changedFields).length === 0) return;

    setWritebackStatus("syncing");
    try {
      const fn = httpsCallable(functions, "writeProjectDateToHubspot");
      await fn({ hubspotId, fields: changedFields });
      setWritebackStatus("ok");
      setTimeout(() => setWritebackStatus("idle"), 4000);
    } catch (e) {
      console.error("HubSpot writeback failed:", e);
      setWritebackStatus("error");
    }
  };

  // v4.0.0: AI-drafted project status. Calls existing askProjectBot CF with a tailored prompt.
  // Drops the answer into the draft.projectStatus textarea for the user to review before saving.
  const askBotForStatus = async () => {
    if (!canEdit || !pid) return;
    setBotLoading(true);
    try {
      const fn = httpsCallable(functions, "askProjectBot");
      const res = await fn({
        projectId: pid,
        question: "Draft a concise project status update (3-6 bullet points). Include: current phase/stage, what was done recently, what's next (with owner if known), and any blockers. Format as plain text, one bullet per line starting with '• '. Keep to ~120 words.",
      });
      const answer = res?.data?.answer;
      if (answer) setDraft(d => ({ ...d, projectStatus: answer }));
      if (!editing) setEditing(true);
    } catch (e) {
      alert("Bot error: " + (e.message || String(e)));
    }
    setBotLoading(false);
  };

  // HubSpot-synced fields (pull-only in v4.0.0, read from project)
  const csProgramId = project.csProgramId || "";
  const targetBuildAtDealClose = project.targetBuildDateAtDealClose || ""; // HubSpot property wiring pending — see REBUILD_4.0.0

  const WRITABLE = [
    { key: "cadCompleteDate", label: "CAD Complete Date", type: "date" },
    { key: "cadActualFinishDate", label: "CAD Actual Finish Date", type: "date" },
    { key: "actualServiceStartDate", label: "Actual Service Start Date", type: "date" },
    { key: "targetBuildDate", label: "Target Build Date", type: "date" },
    { key: "actualDeployDate", label: "Actual Deploy Date", type: "date" },
    { key: "webappProjectId", label: "Webapp Project ID", type: "text", instOnly: true },
  ];

  const Field = ({ label, value, placeholder, readOnly, badge }) => (
    <div style={{ padding: "10px 14px", background: readOnly ? "#FFF4F0" : "#F8FAFC", borderRadius: 8, border: `1px solid ${readOnly ? "#FED7AA" : "#F1F5F9"}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <div style={{ fontSize: 11, color: "#64748B", fontFamily: F, textTransform: "uppercase", letterSpacing: .5, fontWeight: 600 }}>{label}</div>
        {badge && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "#FFEDD5", color: "#C2410C", fontWeight: 600 }}>{badge}</span>}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: value ? "#0F172A" : "#CBD5E1", fontFamily: F, marginTop: 2 }}>{value || placeholder || "—"}</div>
    </div>
  );

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, paddingBottom: 8, borderBottom: "2px solid #F1F5F9" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F }}>Project Overview</div>
          {writebackStatus === "syncing" && <span style={{ fontSize: 11, color: "#3B82F6", fontFamily: F }}>↑ Syncing to HubSpot…</span>}
          {writebackStatus === "ok"      && <span style={{ fontSize: 11, color: "#059669", fontFamily: F }}>✓ HubSpot updated</span>}
          {writebackStatus === "error"   && <span style={{ fontSize: 11, color: "#DC2626", fontFamily: F }}>⚠ HubSpot writeback failed — saved locally</span>}
        </div>
        {canEdit && !editing && <button onClick={() => setEditing(true)} style={{ padding: "4px 12px", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", cursor: "pointer", fontFamily: F, color: "#3B82F6" }}>✎ Edit</button>}
        {canEdit && editing && (
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={save} style={{ padding: "4px 12px", fontSize: 12, border: "none", borderRadius: 6, background: "#00C9A7", color: "#FFF", cursor: "pointer", fontFamily: F, fontWeight: 600 }}>Save</button>
            <button onClick={() => { setDraft(overview); setEditing(false); }} style={{ padding: "4px 12px", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", cursor: "pointer", fontFamily: F }}>Cancel</button>
          </div>
        )}
      </div>
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "#94A3B8", fontFamily: F, marginBottom: 10 }}>Key project dates and status. {canEdit && project?.hubspotId ? "Date changes sync to HubSpot automatically on save." : canEdit ? "No HubSpot record linked — dates saved locally only." : ""}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
          {WRITABLE.filter(f => !f.instOnly || canEdit).map(f => editing ? (
            <div key={f.key} style={{ padding: "10px 14px", background: "#F8FAFC", borderRadius: 8, border: "1px solid #F1F5F9" }}>
              <div style={{ fontSize: 11, color: "#64748B", fontFamily: F, textTransform: "uppercase", letterSpacing: .5, fontWeight: 600, marginBottom: 4 }}>{f.label}</div>
              <input type={f.type} style={{ ...S.inp, padding: "4px 8px", fontSize: 13 }} value={draft[f.key] || ""} onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))} />
            </div>
          ) : <Field key={f.key} label={f.label} value={f.type === "date" ? (overview[f.key] ? fmtDay(overview[f.key]) : "") : (overview[f.key] || "")} />)}
          <Field label="Target Build Date at Deal Close" value={targetBuildAtDealClose ? fmtDay(targetBuildAtDealClose) : ""} readOnly badge="HubSpot" />
          <Field label="Associated CS Program ID" value={csProgramId} readOnly badge="HubSpot" />
        </div>

        {/* Custom Milestones — internal users only */}
        {canEdit && (
          <div style={{ marginTop: 16, padding: "12px 14px", background: "#F8FAFC", borderRadius: 8, border: "1px solid #F1F5F9" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "#64748B", fontFamily: F, textTransform: "uppercase", letterSpacing: .5, fontWeight: 600 }}>Custom Milestones</div>
              {editing && (
                <button onClick={() => setDraft(d => ({ ...d, customMilestones: [...(d.customMilestones || []), { id: genId(), label: "", date: "" }] }))}
                  style={{ ...S.btnAddItem, padding: "2px 8px", fontSize: 11 }}>+ Add Milestone</button>
              )}
            </div>
            {editing ? (
              (draft.customMilestones || []).length === 0 ? (
                <div style={{ fontSize: 13, color: "#CBD5E1", fontFamily: F, fontStyle: "italic" }}>No custom milestones. Click '+ Add Milestone' to add one.</div>
              ) : (
                (draft.customMilestones || []).map(m => (
                  <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <input type="text" value={m.label} onChange={e => setDraft(d => ({ ...d, customMilestones: d.customMilestones.map(x => x.id !== m.id ? x : { ...x, label: e.target.value }) }))}
                      placeholder="Milestone name" style={{ ...S.inp, flex: 1, padding: "4px 8px", fontSize: 13 }} />
                    <input type="date" value={m.date} onChange={e => setDraft(d => ({ ...d, customMilestones: d.customMilestones.map(x => x.id !== m.id ? x : { ...x, date: e.target.value }) }))}
                      style={{ ...S.inp, width: 140, padding: "4px 8px", fontSize: 13 }} />
                    <button onClick={() => setDraft(d => ({ ...d, customMilestones: d.customMilestones.filter(x => x.id !== m.id) }))}
                      style={{ ...S.btnDel, padding: "3px 8px", fontSize: 11 }}>✕</button>
                  </div>
                ))
              )
            ) : (
              (overview.customMilestones || []).filter(m => m.label).length === 0 ? (
                <div style={{ fontSize: 13, color: "#CBD5E1", fontFamily: F, fontStyle: "italic" }}>No custom milestones added.</div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                  {(overview.customMilestones || []).filter(m => m.label).map(m => (
                    <Field key={m.id} label={m.label} value={m.date ? fmtDay(m.date) : ""} />
                  ))}
                </div>
              )
            )}
          </div>
        )}

        {/* Project Status + Next Steps */}
        <div style={{ marginTop: 16, padding: "12px 14px", background: "#F8FAFC", borderRadius: 8, border: "1px solid #F1F5F9" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 11, color: "#64748B", fontFamily: F, textTransform: "uppercase", letterSpacing: .5, fontWeight: 600 }}>Project Status & Next Steps</div>
            {canEdit && (
              <button onClick={askBotForStatus} disabled={botLoading} style={{ padding: "3px 10px", fontSize: 11, border: "1px solid #A7F3D0", borderRadius: 6, background: botLoading ? "#F1F5F9" : "#ECFDF5", color: botLoading ? "#94A3B8" : "#059669", cursor: botLoading ? "wait" : "pointer", fontFamily: F, fontWeight: 600 }}>{botLoading ? "Bot drafting…" : "🤖 Ask Bot to draft"}</button>
            )}
          </div>
          {editing ? (
            <textarea rows={6} style={{ ...S.inp, fontSize: 13, fontFamily: F, width: "100%" }} value={draft.projectStatus || ""} onChange={e => setDraft(d => ({ ...d, projectStatus: e.target.value }))} placeholder="Overall status, next steps, owners…" />
          ) : (
            <div style={{ fontSize: 14, color: overview.projectStatus ? "#1E293B" : "#CBD5E1", fontFamily: F, whiteSpace: "pre-wrap" }}>{overview.projectStatus || "No status recorded. Click '🤖 Ask Bot to draft' to generate one from the project's checklists, program tasks, and HubSpot data."}</div>
          )}
        </div>

        {overview.updatedAt && (
          <div style={{ fontSize: 11, color: "#94A3B8", fontFamily: F, marginTop: 8, textAlign: "right" }}>
            Updated {fmtDate(overview.updatedAt)}{overview.updatedBy ? ` by ${overview.updatedBy}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══ PROJECT HARDWARE SECTION — v4.0.0: HubSpot suggestion + manual override ═══ */
/* Override model: docData/{pid}/_hardwareOverride[key] = { value, overriddenAt, overriddenBy } wins over HubSpot synced value. */
/* Stored in docData (not on project) so Instrumental users can write without needing appState/projects admin write. */
function ProjectHardwareSection({ project, state, setState, user }) {
  const canEdit = isInst(user);
  const customTypes = state.demandCustomTypes || {};
  const hw = project.hardware || {};
  const overrides = state.docData?.[project.id]?._hardwareOverride || {};
  const [editing, setEditing] = useState(null);
  const [draftVal, setDraftVal] = useState("");

  const hsRows = HUBSPOT_HW_FIELDS.map(f => {
    const suggestion = hw[f.key];
    const suggestedCount = parseHwCount(suggestion);
    const ov = overrides[f.key];
    const activeValue = ov && ov.value != null ? ov.value : suggestion;
    const activeCount = parseHwCount(activeValue);
    return { ...f, suggestion, suggestedCount, override: ov, activeValue, activeCount };
  }).filter(r => r.suggestedCount > 0 || r.suggestion || r.override);

  const saveOverride = (key, value) => {
    if (!canEdit) return;
    setState(prev => {
      const pid = project.id;
      const pdd = prev.docData?.[pid] || {};
      const ov = { ...(pdd._hardwareOverride || {}) };
      if (value === "" || value == null) { delete ov[key]; }
      else { ov[key] = { value: String(value), overriddenAt: new Date().toISOString(), overriddenBy: user.name }; }
      return { ...prev, docData: { ...prev.docData, [pid]: { ...pdd, _hardwareOverride: ov } } };
    });
    setEditing(null); setDraftVal("");
  };

  const updateCustomCount = (typeId, val) => {
    if (!canEdit) return;
    const n = parseInt(val) || 0;
    setState(prev => {
      const types = { ...(prev.demandCustomTypes || {}) };
      const t = { ...(types[typeId] || { label: "Custom", counts: {} }) };
      t.counts = { ...(t.counts || {}) };
      if (n > 0) t.counts[project.id] = n; else delete t.counts[project.id];
      types[typeId] = t;
      return { ...prev, demandCustomTypes: types };
    });
  };

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 12, paddingBottom: 8, borderBottom: "2px solid #F1F5F9" }}>Hardware</div>

      {/* HubSpot-synced with override support (v4.0.0) */}
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <Chip small color="#FFF4F0" fg="#FF7A59">HubSpot suggestion</Chip>
          <span style={{ fontSize: 12, color: "#94A3B8", fontFamily: F }}>{canEdit ? "Click ✎ to override. Overrides become the source of truth." : "HubSpot values can be overridden by Instrumental."}</span>
        </div>
        {hsRows.length === 0 ? (
          <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>No hardware synced from HubSpot for this project yet.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            {hsRows.map(r => {
              const isOverridden = !!r.override;
              const isEditing = editing === r.key;
              return (
                <div key={r.key} style={{ padding: "10px 14px", background: isOverridden ? "#EEF2FF" : "#F8FAFC", borderRadius: 8, border: `1px solid ${isOverridden ? "#C7D2FE" : "#F1F5F9"}` }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                    <div style={{ fontSize: 11, color: "#64748B", fontFamily: F, textTransform: "uppercase", letterSpacing: .5, fontWeight: 600 }}>{r.label}</div>
                    {canEdit && !isEditing && (
                      <button onClick={() => { setEditing(r.key); setDraftVal(r.activeValue != null ? String(r.activeValue) : ""); }} style={{ padding: "2px 6px", fontSize: 10, border: "1px solid #E2E8F0", borderRadius: 4, background: "#FFF", cursor: "pointer", fontFamily: F }} title="Override">✎</button>
                    )}
                  </div>
                  {isEditing ? (
                    <div style={{ marginTop: 4 }}>
                      <input autoFocus style={{ ...S.inp, padding: "4px 8px", fontSize: 14 }} value={draftVal} onChange={e => setDraftVal(e.target.value)} onKeyDown={e => { if (e.key === "Enter") saveOverride(r.key, draftVal); if (e.key === "Escape") { setEditing(null); setDraftVal(""); } }} />
                      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                        <button onClick={() => saveOverride(r.key, draftVal)} style={{ padding: "2px 8px", fontSize: 11, background: "#00C9A7", color: "#FFF", border: "none", borderRadius: 4, cursor: "pointer", fontFamily: F }}>Save</button>
                        {isOverridden && <button onClick={() => saveOverride(r.key, null)} style={{ padding: "2px 8px", fontSize: 11, background: "#FEE2E2", color: "#B91C1C", border: "none", borderRadius: 4, cursor: "pointer", fontFamily: F }}>Clear</button>}
                        <button onClick={() => { setEditing(null); setDraftVal(""); }} style={{ padding: "2px 8px", fontSize: 11, background: "#F1F5F9", color: "#64748B", border: "none", borderRadius: 4, cursor: "pointer", fontFamily: F }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 18, fontWeight: 700, color: "#0F172A", fontFamily: F, marginTop: 2 }}>{r.activeCount || "—"}</div>
                      {isOverridden && (
                        <div style={{ fontSize: 10, color: "#6366F1", fontFamily: F, marginTop: 2 }}>
                          Override · was {r.suggestedCount || "—"} from HubSpot
                        </div>
                      )}
                      {!isOverridden && typeof r.suggestion === "string" && r.suggestion !== String(r.suggestedCount) && (
                        <div style={{ fontSize: 11, color: "#94A3B8", fontFamily: F, marginTop: 2 }}>{r.suggestion}</div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Custom manual entries — editable by any Instrumental user */}
      <div style={S.card}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Chip small color="#EEF2FF" fg="#6366F1">Custom / Manual</Chip>
          <span style={{ fontSize: 12, color: "#94A3B8", fontFamily: F }}>
            {canEdit ? "Set per-project counts for custom hardware types. Add new types on Projects Overview → Demand Plan." : "Custom hardware types set by Instrumental."}
          </span>
        </div>
        {Object.keys(customTypes).length === 0 ? (
          <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>No custom hardware types defined. Instrumental users can add them on the Projects Overview → Demand Plan.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            {Object.entries(customTypes).map(([typeId, t]) => {
              const projectCount = t.counts?.[project.id] || 0;
              return (
                <div key={typeId} style={{ padding: "10px 14px", background: "#F8FAFC", borderRadius: 8, border: "1px solid #F1F5F9" }}>
                  <div style={{ fontSize: 11, color: "#64748B", fontFamily: F, textTransform: "uppercase", letterSpacing: .5, fontWeight: 600 }}>{t.label}</div>
                  {canEdit ? (
                    <input type="number" min="0" style={{ ...S.inp, marginTop: 4, padding: "6px 10px", fontSize: 16, fontWeight: 700 }} value={projectCount || ""} onChange={e => updateCustomCount(typeId, e.target.value)} placeholder="0" />
                  ) : (
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#0F172A", fontFamily: F, marginTop: 2 }}>{projectCount || "—"}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══ v4.1.0 PROJECT TABS HELPERS ═══ */
const tabIcon = (type) => {
  if (type === "checklist") return "📋";
  if (type === "table") return "📊";
  if (type === "program") return "📅";
  return "📁";
};

const tabBadge = (cat) => {
  if (cat.type === "checklist") {
    const all = (cat.milestones || []).flatMap(ms => ms.checklist || []);
    const active = all.filter(ck => !ck.na);
    if (active.length === 0) return null;
    const pct = Math.round(all.filter(ck => !ck.na && ck.checked).length / active.length * 100);
    return `${pct}%`;
  }
  if (cat.type === "table") { const n = (cat.rows || []).length; return n > 0 ? `${n}` : null; }
  if (cat.type === "program") return null;
  const n = (cat.items || []).filter(i => !i._userDeleted).length;
  return n > 0 ? `${n}` : null;
};

/* ═══ TABLE SECTION — inline-editable rows for type:"table" categories ═══ */
function TableSection({ cat, updateCats, canEdit, allCats = [] }) {
  const [editCell, setEditCell] = useState(null); // { rowId, key }
  const [editVal, setEditVal] = useState("");
  const [importStatus, setImportStatus] = useState(""); // brief feedback after import
  const fileInputRef = useRef(null);
  const rows = cat.rows || [];
  const cols = cat.columns || [];

  const updateRow = (rowId, key, value) =>
    updateCats(cur => cur.map(c => c.id !== cat.id ? c : {
      ...c, rows: (c.rows || []).map(r => r.id !== rowId ? r : { ...r, [key]: value })
    }));

  const addRow = () => {
    const newRow = { id: genId() };
    cols.forEach(col => { newRow[col.key] = col.type === "boolean" ? false : ""; });
    updateCats(cur => cur.map(c => c.id !== cat.id ? c : { ...c, rows: [...(c.rows || []), newRow] }));
  };

  const delRow = (rowId) =>
    updateCats(cur => cur.map(c => c.id !== cat.id ? c : { ...c, rows: (c.rows || []).filter(r => r.id !== rowId) }));

  const startEdit = (rowId, key, val) => { setEditCell({ rowId, key }); setEditVal(val || ""); };
  const commitEdit = () => {
    if (!editCell) return;
    updateRow(editCell.rowId, editCell.key, editVal);
    setEditCell(null); setEditVal("");
  };

  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const wb = XLSX.read(ev.target.result, { type: "array" });

        // Build lookup: norm(tabName) → cat object (all table-type cats)
        const tabLookup = {};
        (allCats || []).filter(c => c.type === "table").forEach(c => { tabLookup[norm(c.name)] = c; });

        // Pivot vertical/transposed sheets: attribute-per-row, station-per-column
        // (Excel layout used by StationKits, InFactoryInstall, CameraSettings, LED Settings)
        // Detected when first cell of row 0 normalizes to "station"
        const pivotVertical = (raw) => {
          const numStations = (raw[0] || []).length - 1;
          const pivoted = [];
          for (let si = 1; si <= numStations; si++) {
            const row = {};
            for (let ri = 0; ri < raw.length; ri++) {
              const attr = String(raw[ri]?.[0] || "").trim().replace(/:$/, "");
              if (!attr) continue;
              row[attr] = raw[ri][si] ?? "";
            }
            if (Object.values(row).some(v => v !== "" && v !== null && v !== undefined)) pivoted.push(row);
          }
          return pivoted;
        };

        // Scan all sheets in the file, match each to an app tab
        const imports = [];
        for (const sheetName of wb.SheetNames) {
          const matchedCat = tabLookup[norm(sheetName)];
          if (!matchedCat) continue;
          const ws = wb.Sheets[sheetName];
          const raw2d = XLSX.utils.sheet_to_json(ws, { header: 1 });
          const isVertical = norm(String(raw2d[0]?.[0] || "")) === "station" && raw2d[0]?.[1];
          const uploadedRows = isVertical
            ? pivotVertical(raw2d)
            : XLSX.utils.sheet_to_json(ws, { defval: "" });
          if (uploadedRows.length === 0) continue;

          const tCols = matchedCat.columns || [];
          const colMap = {};
          for (const h of Object.keys(uploadedRows[0])) {
            const nh = norm(h);
            const match = tCols.find(c => norm(c.label) === nh || norm(c.key) === nh);
            if (match) colMap[h] = { key: match.key, type: match.type };
          }
          if (Object.keys(colMap).length === 0) continue;

          const newRows = uploadedRows.map(r => {
            const row = { id: genId() };
            tCols.forEach(c => { row[c.key] = c.type === "boolean" ? false : ""; });
            for (const [h, { key, type }] of Object.entries(colMap)) {
              const v = r[h];
              row[key] = type === "boolean"
                ? (v === true || v === 1 || String(v).toLowerCase() === "true")
                : String(v ?? "");
            }
            return row;
          });
          imports.push({ catId: matchedCat.id, catName: matchedCat.name, newRows, existing: (matchedCat.rows || []).length });
        }

        if (imports.length === 0) {
          setImportStatus("No matching sheets found. Sheet names must match tab names (e.g. 'StationKits' → Station Kits).");
          setTimeout(() => setImportStatus(""), 7000); return;
        }

        const hasExisting = imports.some(im => im.existing > 0);
        if (hasExisting) {
          const names = imports.filter(im => im.existing > 0).map(im => im.catName).join(", ");
          if (!confirm(`This will append rows to tabs with existing data: ${names}. Proceed?`)) return;
        }

        updateCats(cur => {
          let next = cur;
          for (const { catId, newRows } of imports) {
            next = next.map(c => c.id !== catId ? c : { ...c, rows: [...(c.rows || []), ...newRows] });
          }
          return next;
        });

        const summary = imports.map(im => `${im.catName} (${im.newRows.length})`).join(", ");
        setImportStatus(`✓ Imported: ${summary}`);
        setTimeout(() => setImportStatus(""), 8000);
      } catch (err) {
        setImportStatus("Error reading file: " + err.message);
        setTimeout(() => setImportStatus(""), 6000);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  return (
    <div style={{ marginBottom: 8 }}>
      {canEdit && rows.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <button onClick={addRow} style={S.btnAddItem}>+ Add Row</button>
          <button onClick={() => fileInputRef.current?.click()} style={{ ...S.btnAddItem, background: "#F0FDF4", color: "#15803D", border: "1px solid #BBF7D0" }} title="Supports .xlsx, .xls, .csv — export from Google Sheets first">📥 Import from Spreadsheet</button>
        </div>
      )}
      <div style={{ overflowX: "auto", borderRadius: 8, border: "1px solid #E2E8F0" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 13, fontFamily: F, width: "max-content", minWidth: "100%" }}>
          <thead>
            <tr style={{ background: "#F8FAFC" }}>
              {cols.map(col => (
                <th key={col.key} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "#64748B", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap", borderBottom: "2px solid #E2E8F0", minWidth: col.width || 100 }}>
                  {col.label}
                </th>
              ))}
              {canEdit && <th style={{ padding: "8px 12px", borderBottom: "2px solid #E2E8F0", minWidth: 36 }} />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={cols.length + (canEdit ? 1 : 0)} style={{ padding: "18px 12px", color: "#CBD5E1", fontStyle: "italic", textAlign: "center", fontFamily: F }}>
                No rows yet.{canEdit ? " Click '+ Add Row' to begin." : ""}
              </td></tr>
            )}
            {rows.map((row, rowIdx) => (
              <tr key={row.id} style={{ borderBottom: "1px solid #F1F5F9", background: rowIdx % 2 === 0 ? "#FFF" : "#FAFAFA" }}>
                {cols.map(col => {
                  const isEditing = editCell?.rowId === row.id && editCell?.key === col.key;
                  const val = row[col.key];
                  if (col.type === "boolean") {
                    return (
                      <td key={col.key} style={{ padding: "6px 12px", textAlign: "center" }}>
                        <input type="checkbox" checked={!!val} disabled={!canEdit}
                          onChange={e => canEdit && updateRow(row.id, col.key, e.target.checked)}
                          style={{ width: 16, height: 16, cursor: canEdit ? "pointer" : "default" }} />
                      </td>
                    );
                  }
                  return (
                    <td key={col.key} style={{ padding: "4px 6px", minWidth: col.width || 100 }}
                        onClick={() => canEdit && !isEditing && startEdit(row.id, col.key, val)}>
                      {isEditing ? (
                        <input type={col.type === "date" ? "date" : "text"} autoFocus
                          value={editVal} onChange={e => setEditVal(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditCell(null); }}
                          style={{ width: "100%", padding: "4px 6px", fontSize: 13, border: "1px solid #3B82F6", borderRadius: 4, outline: "none", fontFamily: F }} />
                      ) : (
                        <div style={{ padding: "4px 6px", minHeight: 24, borderRadius: 4, color: val ? "#0F172A" : "#CBD5E1", cursor: canEdit ? "pointer" : "default", fontStyle: val ? "normal" : "italic", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {col.type === "date" && val ? fmtDay(val) : (val || (canEdit ? "click to edit" : "—"))}
                        </div>
                      )}
                    </td>
                  );
                })}
                {canEdit && <td style={{ padding: "4px 6px", textAlign: "center" }}>
                  <button onClick={() => delRow(row.id)} style={{ ...S.btnDel, padding: "2px 6px", fontSize: 11 }} title="Delete row">✕</button>
                </td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <button onClick={addRow} style={S.btnAddItem}>+ Add Row</button>
          <button onClick={() => fileInputRef.current?.click()} style={{ ...S.btnAddItem, background: "#F0FDF4", color: "#15803D", border: "1px solid #BBF7D0" }} title="Supports .xlsx, .xls, .csv — export from Google Sheets first">📥 Import from Spreadsheet</button>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={handleImport} />
          {importStatus && <span style={{ fontSize: 12, color: importStatus.startsWith("✓") ? "#15803D" : "#DC2626", fontFamily: F }}>{importStatus}</span>}
        </div>
      )}
      {rows.length > 0 && <div style={{ fontSize: 12, color: "#94A3B8", fontFamily: F, marginTop: 4 }}>{rows.length} row{rows.length !== 1 ? "s" : ""}</div>}
    </div>
  );
}

/* ═══ TRANSPOSED TABLE SECTION — attributes as rows, stations as columns (mirrors Excel format) ═══ */
/* Used for Station Kits, In-Factory Install, Camera Settings, LED Settings.                         */
/* Data model unchanged: cat.rows = one object per station. Rendering is transposed.                 */
function TransposedTableSection({ cat, updateCats, canEdit, allCats = [] }) {
  const [editCell, setEditCell] = useState(null); // { rowId, key }
  const [editVal, setEditVal] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const fileInputRef = useRef(null);
  const [editAttrs, setEditAttrs] = useState(false);
  const [editingAttrKey, setEditingAttrKey] = useState(null);
  const [editingAttrLabel, setEditingAttrLabel] = useState("");
  const [newAttrLabel, setNewAttrLabel] = useState("");
  const [newAttrType, setNewAttrType] = useState("text");
  const [newAttrSection, setNewAttrSection] = useState("");

  const stations = cat.rows || []; // each "row" in data = one station column in UI
  const cols = cat.columns || [];  // each "col" in template = one attribute row in UI

  const updateCell = (rowId, key, value) =>
    updateCats(cur => cur.map(c => c.id !== cat.id ? c : {
      ...c, rows: (c.rows || []).map(r => r.id !== rowId ? r : { ...r, [key]: value })
    }));

  const addStation = () => {
    const newRow = { id: genId() };
    cols.forEach(col => { newRow[col.key] = col.type === "boolean" ? false : ""; });
    updateCats(cur => cur.map(c => c.id !== cat.id ? c : { ...c, rows: [...(c.rows || []), newRow] }));
  };

  const delStation = (rowId) =>
    updateCats(cur => cur.map(c => c.id !== cat.id ? c : { ...c, rows: (c.rows || []).filter(r => r.id !== rowId) }));

  const startEdit = (rowId, key, val) => { setEditCell({ rowId, key }); setEditVal(val || ""); };
  const commitEdit = () => {
    if (!editCell) return;
    updateCell(editCell.rowId, editCell.key, editVal);
    setEditCell(null); setEditVal("");
  };

  const delCol = (key) =>
    updateCats(cur => cur.map(c => c.id !== cat.id ? c : {
      ...c,
      columns: (c.columns || []).filter(col => col.key !== key),
      deletedCols: [...(c.deletedCols || []), key],
    }));

  const renameCol = (key, newLabel) => {
    if (!newLabel.trim()) return;
    updateCats(cur => cur.map(c => c.id !== cat.id ? c : {
      ...c, columns: (c.columns || []).map(col => col.key === key ? { ...col, label: newLabel.trim() } : col),
    }));
  };

  const addCol = () => {
    const label = newAttrLabel.trim();
    if (!label) return;
    const key = "custom_" + label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") + "_" + Date.now().toString(36);
    const section = newAttrSection.trim() || "Custom";
    const colDef = { key, label, section, ...(newAttrType !== "text" ? { type: newAttrType } : {}) };
    updateCats(cur => cur.map(c => c.id !== cat.id ? c : { ...c, columns: [...(c.columns || []), colDef] }));
    setNewAttrLabel(""); setNewAttrSection("");
  };

  // Same multi-tab import logic as TableSection
  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const wb = XLSX.read(ev.target.result, { type: "array" });
        const tabLookup = {};
        (allCats || []).filter(c => c.type === "table").forEach(c => { tabLookup[norm(c.name)] = c; });
        const pivotVertical = (raw) => {
          const numStations = (raw[0] || []).length - 1;
          const pivoted = [];
          for (let si = 1; si <= numStations; si++) {
            const row = {};
            for (let ri = 0; ri < raw.length; ri++) {
              const attr = String(raw[ri]?.[0] || "").trim().replace(/:$/, "");
              if (!attr) continue;
              row[attr] = raw[ri][si] ?? "";
            }
            if (Object.values(row).some(v => v !== "" && v !== null && v !== undefined)) pivoted.push(row);
          }
          return pivoted;
        };
        const imports = [];
        for (const sheetName of wb.SheetNames) {
          const matchedCat = tabLookup[norm(sheetName)];
          if (!matchedCat) continue;
          const ws = wb.Sheets[sheetName];
          const raw2d = XLSX.utils.sheet_to_json(ws, { header: 1 });
          const isVertical = norm(String(raw2d[0]?.[0] || "")) === "station" && raw2d[0]?.[1];
          const uploadedRows = isVertical ? pivotVertical(raw2d) : XLSX.utils.sheet_to_json(ws, { defval: "" });
          if (uploadedRows.length === 0) continue;
          const tCols = matchedCat.columns || [];
          const colMap = {};
          for (const h of Object.keys(uploadedRows[0])) {
            const nh = norm(h);
            const match = tCols.find(c => norm(c.label) === nh || norm(c.key) === nh);
            if (match) colMap[h] = { key: match.key, type: match.type };
          }
          if (Object.keys(colMap).length === 0) continue;
          const newRows = uploadedRows.map(r => {
            const row = { id: genId() };
            tCols.forEach(c => { row[c.key] = c.type === "boolean" ? false : ""; });
            for (const [h, { key, type }] of Object.entries(colMap)) {
              const v = r[h];
              row[key] = type === "boolean" ? (v === true || v === 1 || String(v).toLowerCase() === "true") : String(v ?? "");
            }
            return row;
          });
          imports.push({ catId: matchedCat.id, catName: matchedCat.name, newRows, existing: (matchedCat.rows || []).length });
        }
        if (imports.length === 0) { setImportStatus("No matching sheets found."); setTimeout(() => setImportStatus(""), 6000); return; }
        const hasExisting = imports.some(im => im.existing > 0);
        if (hasExisting) {
          const names = imports.filter(im => im.existing > 0).map(im => im.catName).join(", ");
          if (!confirm(`Append rows to existing data in: ${names}. Proceed?`)) return;
        }
        updateCats(cur => {
          let next = cur;
          for (const { catId, newRows } of imports) {
            next = next.map(c => c.id !== catId ? c : { ...c, rows: [...(c.rows || []), ...newRows] });
          }
          return next;
        });
        setImportStatus(`✓ Imported: ${imports.map(im => `${im.catName} (${im.newRows.length})`).join(", ")}`);
        setTimeout(() => setImportStatus(""), 8000);
      } catch (err) {
        setImportStatus("Error reading file: " + err.message);
        setTimeout(() => setImportStatus(""), 6000);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // Build display rows: section headers interleaved with attribute rows
  const displayRows = [];
  let lastSection = null;
  for (const col of cols) {
    const sec = col.section || "";
    if (sec !== lastSection) {
      displayRows.push({ type: "header", label: sec });
      lastSection = sec;
    }
    displayRows.push({ type: "attr", col });
  }

  const stationLabel = (row, i) => String(row.station_num || row.station || `S${i + 1}`);

  const thBase = { padding: "8px 12px", fontWeight: 600, color: "#64748B", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap", borderBottom: "2px solid #E2E8F0", background: "#F8FAFC" };

  return (
    <div style={{ marginBottom: 8 }}>
      {canEdit && stations.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <button onClick={addStation} style={S.btnAddItem}>+ Add Station</button>
          <button onClick={() => fileInputRef.current?.click()} style={{ ...S.btnAddItem, background: "#F0FDF4", color: "#15803D", border: "1px solid #BBF7D0" }} title="Supports .xlsx, .xls, .csv — export from Google Sheets first">📥 Import from Spreadsheet</button>
        </div>
      )}
      <div style={{ overflowX: "auto", borderRadius: 8, border: "1px solid #E2E8F0" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 13, fontFamily: F, width: "max-content", minWidth: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...thBase, textAlign: "left", minWidth: editAttrs ? 260 : 200, position: "sticky", left: 0, zIndex: 1 }}>Attribute</th>
              {stations.map((row, i) => (
                <th key={row.id} style={{ ...thBase, textAlign: "center", minWidth: 130 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                    {stationLabel(row, i)}
                    {canEdit && <button onClick={() => delStation(row.id)} style={{ ...S.btnDel, padding: "1px 4px", fontSize: 9, lineHeight: 1 }} title="Remove station">✕</button>}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          {stations.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={2} style={{ padding: "20px 16px", color: "#CBD5E1", fontStyle: "italic", textAlign: "center", fontFamily: F }}>
                  No stations yet.{canEdit ? " Click '+ Add Station' to begin." : ""}
                </td>
              </tr>
            </tbody>
          ) : (
            <tbody>
              {displayRows.map((item, idx) => {
                if (item.type === "header") {
                  if (!item.label) return null;
                  return (
                    <tr key={`sec_${idx}`} style={{ background: "#F1F5F9" }}>
                      <td colSpan={stations.length + 1} style={{ padding: "5px 12px", fontWeight: 700, fontSize: 10, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: F }}>
                        {item.label}
                      </td>
                    </tr>
                  );
                }
                const col = item.col;
                return (
                  <tr key={col.key} style={{ borderBottom: "1px solid #F1F5F9" }}>
                    <td style={{ padding: editAttrs ? "4px 8px" : "6px 12px", color: "#1E293B", fontSize: 13, background: "#FAFAFA", fontWeight: 500, position: "sticky", left: 0, borderRight: "1px solid #E2E8F0", minWidth: editAttrs ? 260 : 200 }}>
                      {editAttrs ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {editingAttrKey === col.key ? (
                            <input value={editingAttrLabel} autoFocus
                              onChange={e => setEditingAttrLabel(e.target.value)}
                              onBlur={() => { renameCol(col.key, editingAttrLabel); setEditingAttrKey(null); }}
                              onKeyDown={e => { if (e.key === "Enter") { renameCol(col.key, editingAttrLabel); setEditingAttrKey(null); } if (e.key === "Escape") setEditingAttrKey(null); }}
                              style={{ flex: 1, padding: "3px 6px", fontSize: 12, border: "1px solid #3B82F6", borderRadius: 3, outline: "none", fontFamily: F }} />
                          ) : (
                            <span onClick={() => { setEditingAttrKey(col.key); setEditingAttrLabel(col.label); }}
                              title="Click to rename"
                              style={{ flex: 1, cursor: "text", padding: "3px 4px", borderRadius: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {col.label}
                            </span>
                          )}
                          <button onClick={() => { if (confirm(`Delete attribute "${col.label}"?`)) delCol(col.key); }}
                            style={{ flexShrink: 0, background: "none", border: "none", cursor: "pointer", color: "#EF4444", fontSize: 15, lineHeight: 1, padding: "2px 4px" }} title="Delete attribute">×</button>
                        </div>
                      ) : (
                        <span style={{ whiteSpace: "nowrap" }}>{col.label}</span>
                      )}
                    </td>
                    {stations.map(row => {
                      const val = row[col.key];
                      const isEditing = editCell?.rowId === row.id && editCell?.key === col.key;
                      if (col.type === "boolean") {
                        return (
                          <td key={row.id} style={{ padding: "6px 12px", textAlign: "center", verticalAlign: "middle" }}>
                            <input type="checkbox" checked={!!val} disabled={!canEdit}
                              onChange={e => canEdit && updateCell(row.id, col.key, e.target.checked)}
                              style={{ width: 16, height: 16, cursor: canEdit ? "pointer" : "default", accentColor: "#00C9A7" }} />
                          </td>
                        );
                      }
                      return (
                        <td key={row.id} style={{ padding: "4px 8px", minWidth: 130, verticalAlign: "middle" }}
                            onClick={() => canEdit && !isEditing && startEdit(row.id, col.key, val)}>
                          {isEditing ? (
                            <input type={col.type === "date" ? "date" : "text"} autoFocus
                              value={editVal} onChange={e => setEditVal(e.target.value)}
                              onBlur={commitEdit}
                              onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditCell(null); }}
                              style={{ width: "100%", padding: "4px 6px", fontSize: 13, border: "1px solid #3B82F6", borderRadius: 4, outline: "none", fontFamily: F }} />
                          ) : (
                            <div style={{ padding: "4px 6px", minHeight: 24, borderRadius: 4, color: val ? "#0F172A" : "#CBD5E1", cursor: canEdit ? "pointer" : "default", fontStyle: val ? "normal" : "italic", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {col.type === "date" && val ? fmtDay(val) : (val || (canEdit ? "click to edit" : "—"))}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>
      {canEdit && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button onClick={addStation} style={S.btnAddItem}>+ Add Station</button>
            <button onClick={() => fileInputRef.current?.click()} style={{ ...S.btnAddItem, background: "#F0FDF4", color: "#15803D", border: "1px solid #BBF7D0" }} title="Supports .xlsx, .xls, .csv — export from Google Sheets first">📥 Import from Spreadsheet</button>
            <button onClick={() => { setEditAttrs(ea => !ea); setEditingAttrKey(null); }}
              style={{ ...S.btnAddItem, ...(editAttrs ? { background: "#EFF6FF", color: "#1D4ED8", border: "1px solid #BFDBFE" } : {}) }}>
              {editAttrs ? "✓ Done Editing Attributes" : "✏️ Edit Attributes"}
            </button>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={handleImport} />
            {importStatus && <span style={{ fontSize: 12, color: importStatus.startsWith("✓") ? "#15803D" : "#DC2626", fontFamily: F }}>{importStatus}</span>}
          </div>
          {editAttrs && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "8px 10px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6 }}>
              <span style={{ fontSize: 11, color: "#64748B", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Add attribute:</span>
              <input placeholder="Label..." value={newAttrLabel} onChange={e => setNewAttrLabel(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addCol()}
                style={{ padding: "4px 8px", fontSize: 12, border: "1px solid #CBD5E1", borderRadius: 4, width: 180, fontFamily: F }} />
              <select value={newAttrType} onChange={e => setNewAttrType(e.target.value)}
                style={{ padding: "4px 6px", fontSize: 12, border: "1px solid #CBD5E1", borderRadius: 4, fontFamily: F }}>
                <option value="text">Text</option>
                <option value="boolean">Checkbox</option>
                <option value="date">Date</option>
              </select>
              <input placeholder="Section (optional)" value={newAttrSection} onChange={e => setNewAttrSection(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addCol()}
                style={{ padding: "4px 8px", fontSize: 12, border: "1px solid #CBD5E1", borderRadius: 4, width: 150, fontFamily: F }} />
              <button onClick={addCol} style={{ ...S.btnAddItem, padding: "4px 12px" }}>+ Add</button>
            </div>
          )}
        </div>
      )}
      {stations.length > 0 && <div style={{ fontSize: 12, color: "#94A3B8", fontFamily: F, marginTop: 4 }}>{stations.length} station{stations.length !== 1 ? "s" : ""}</div>}
    </div>
  );
}

/* ═══ FOLDER SECTION — renders a link/file folder category ═══ */
function FolderSection({ cat, updateCats, user, canEdit, pid }) {
  const [addingItem, setAddingItem] = useState(false);
  const [itemForm, setItemForm] = useState({ name: "", url: "", type: "link", lang: "en" });
  const items = (cat.items || []).filter(i => !i._userDeleted);

  // System docs are stored with storagePath (new) or ?alt=media URL (legacy).
  // getDownloadURL returns a token-bearing URL the browser can follow without auth headers.
  const openSystemDoc = async (item) => {
    try {
      let storagePath = item.storagePath;
      if (!storagePath && item.url) {
        const m = item.url.match(/\/o\/([^?]+)/);
        if (m) storagePath = decodeURIComponent(m[1]);
      }
      if (!storagePath) { window.open(item.url, "_blank", "noopener,noreferrer"); return; }
      const url = await getDownloadURL(sRef(storage, storagePath));
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      alert("Could not load document. Please try again.");
    }
  };

  const addItem = () => {
    if (!itemForm.name.trim()) return;
    const url = commitUrl(itemForm.url); if (url === null) return;
    const item = { id: genId(), name: itemForm.name.trim(), url, type: itemForm.type, lang: itemForm.lang, addedBy: user.name, addedAt: new Date().toISOString() };
    updateCats(cur => cur.map(c => c.id !== cat.id ? c : { ...c, items: [...(c.items || []), item] }));
    setItemForm({ name: "", url: "", type: "link", lang: "en" }); setAddingItem(false);
  };

  const delItem = (itemId, isSystem) => {
    if (isSystem) {
      updateCats(cur => cur.map(c => c.id !== cat.id ? c : { ...c, items: (c.items || []).map(i => i.id !== itemId ? i : { ...i, _userDeleted: true }) }));
    } else {
      updateCats(cur => cur.map(c => c.id !== cat.id ? c : { ...c, items: (c.items || []).filter(i => i.id !== itemId) }));
    }
  };

  return (
    <div>
      {items.map(item => (
        <div key={item.id} style={{ ...S.docItemRow, border: item.source === "system" ? "1px dashed #E2E8F0" : undefined, borderRadius: item.source === "system" ? 6 : undefined, padding: item.source === "system" ? "8px 10px" : undefined, marginBottom: 4 }}>
          <span style={{ fontSize: 14 }}>{item.type === "link" ? "🔗" : fileIcon(item.name)}</span>
          <div style={{ flex: 1 }}>
            {item.source === "system"
              ? <span onClick={() => openSystemDoc(item)} style={{ fontSize: 15, fontWeight: 500, color: "#0284C7", cursor: "pointer", textDecoration: "underline", fontFamily: F }}>{item.name}</span>
              : item.url
                ? <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 15, fontWeight: 500, color: "#0284C7", textDecoration: "none", fontFamily: F }}>{item.name}</a>
                : <span style={{ fontSize: 15, fontFamily: F }}>{item.name}</span>}
            <div style={{ fontSize: 12, color: "#94A3B8", fontFamily: F, display: "flex", gap: 6, alignItems: "center" }}>
              {item.source === "system" ? <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "#FFF4F0", color: "#C2410C", fontWeight: 600 }}>SYSTEM</span> : `${item.addedBy} · ${fmtDate(item.addedAt)}`}
            </div>
          </div>
          {canEdit && <button style={{ ...S.btnDel, padding: "3px 8px", fontSize: 11 }} onClick={() => delItem(item.id, item.source === "system")}>✕</button>}
        </div>
      ))}
      {items.length === 0 && <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>No documents yet.</div>}
      {canEdit && pid && (
        addingItem ? (
          <div style={{ marginTop: 12, padding: 14, background: "#F8FAFC", borderRadius: 10 }}>
            <label style={S.lbl}>Name</label>
            <input style={S.inp} value={itemForm.name} onChange={e => setItemForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Pin Inspection Spec v2.1" />
            <label style={S.lbl}>URL <span style={{ color: "#94A3B8", fontWeight: 400 }}>(or upload a file below)</span></label>
            <input style={S.inp} value={itemForm.url} onChange={e => setItemForm(f => ({ ...f, url: e.target.value, type: "link" }))} placeholder="https://..." />
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button style={{ ...S.btnMain, width: "auto", padding: "10px 18px", marginTop: 0 }} onClick={addItem}>Add</button>
              <PdfUploadButton projectId={pid} onUploaded={(url, fileName) => setItemForm(f => ({ ...f, url, type: "pdf", name: f.name?.trim() || fileName.replace(/\.[^.]+$/, "") }))} />
              <button style={{ ...S.btnFlat, width: "auto" }} onClick={() => { setAddingItem(false); setItemForm({ name: "", url: "", type: "link", lang: "en" }); }}>Cancel</button>
            </div>
            {itemForm.url && itemForm.type === "pdf" && <div style={{ fontSize: 12, color: "#059669", fontFamily: F, marginTop: 8 }}>✓ File uploaded — click Add to save.</div>}
          </div>
        ) : (
          <button style={{ ...S.btnAddItem, marginTop: 8 }} onClick={() => setAddingItem(true)}>+ Add Link or File</button>
        )
      )}
    </div>
  );
}

const TAB_ORDER = [
  "pd_team", "pd_deployment_requirements", "pd_cad",
  "inst_external_checklist", "inst_internal_checklist", "inst_mes_integration_checklist",
  "pd_specs", "pd_station_kits", "pd_in_factory_install", "pd_camera_settings",
  "pd_sop_plan", "pd_mes_station_plan", "pd_serialization", "pd_sku_configs",
  "pd_shipment_details", "pd_reference_info",
];

/* ═══ PROJECT TABS VIEW — tabbed nav for all project categories ═══ */
function ProjectTabsView({ cats, updateCats, user, canEdit, pid, project, state, setState, lang, onDelFolder, standardCatIds }) {
  // External users see only 3 specific folders; tables + checklists are Instrumental-only.
  const EXTERNAL_VISIBLE = new Set(["pd_specs", "pd_cad", "pd_deployment_requirements"]);
  const visibleCats = (() => {
    const filtered = cats
      .filter(c => c.type !== "program")
      .filter(c => isInst(user) || EXTERNAL_VISIBLE.has(c.id));
    if (!isInst(user)) return filtered;
    return [...filtered].sort((a, b) => {
      const ai = TAB_ORDER.indexOf(a.id);
      const bi = TAB_ORDER.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  })();

  const [activeTab, setActiveTab] = useState(() => {
    const saved = localStorage.getItem(`dp_proj_tab_${pid}`);
    return (saved && visibleCats.find(c => c.id === saved)) ? saved : (visibleCats[0]?.id || "");
  });
  useEffect(() => {
    const saved = localStorage.getItem(`dp_proj_tab_${pid}`);
    const valid = saved && visibleCats.find(c => c.id === saved);
    setActiveTab(valid ? saved : (visibleCats[0]?.id || ""));
  }, [pid, visibleCats.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTab = (id) => { setActiveTab(id); localStorage.setItem(`dp_proj_tab_${pid}`, id); };
  const activeCat = visibleCats.find(c => c.id === activeTab) || visibleCats[0];
  const isUserFolder = activeCat && !standardCatIds?.has(activeCat.id) && activeCat.type !== "checklist" && activeCat.type !== "program" && activeCat.type !== "table";

  const [globalImportStatus, setGlobalImportStatus] = useState("");
  const globalFileInputRef = useRef(null);

  const handleGlobalImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const wb = XLSX.read(ev.target.result, { type: "array" });
        const tableCats = cats.filter(c => c.type === "table");
        const tabLookup = {};
        tableCats.forEach(c => { tabLookup[norm(c.name)] = c; });
        // Fuzzy fallback: substring match when exact norm fails
        const findCat = (sheetName) => {
          const nsh = norm(sheetName);
          return tabLookup[nsh] || tableCats.find(c => { const nc = norm(c.name); return nsh.includes(nc) || nc.includes(nsh); });
        };
        const pivotVertical = (raw) => {
          const numStations = (raw[0] || []).length - 1;
          const pivoted = [];
          for (let si = 1; si <= numStations; si++) {
            const row = {};
            for (let ri = 0; ri < raw.length; ri++) {
              const attr = String(raw[ri]?.[0] || "").trim().replace(/:$/, "");
              if (!attr) continue;
              row[attr] = raw[ri][si] ?? "";
            }
            if (Object.values(row).some(v => v !== "" && v !== null && v !== undefined)) pivoted.push(row);
          }
          return pivoted;
        };
        const imports = [];
        for (const sheetName of wb.SheetNames) {
          const matchedCat = findCat(sheetName);
          if (!matchedCat) continue;
          const ws = wb.Sheets[sheetName];
          const raw2d = XLSX.utils.sheet_to_json(ws, { header: 1 });
          const isVertical = norm(String(raw2d[0]?.[0] || "")) === "station" && raw2d[0]?.[1];
          const uploadedRows = isVertical ? pivotVertical(raw2d) : XLSX.utils.sheet_to_json(ws, { defval: "" });
          if (uploadedRows.length === 0) continue;
          const tCols = matchedCat.columns || [];
          const colMap = {};
          for (const h of Object.keys(uploadedRows[0])) {
            const nh = norm(h);
            const match = tCols.find(c => norm(c.label) === nh || norm(c.key) === nh);
            if (match) colMap[h] = { key: match.key, type: match.type };
          }
          if (Object.keys(colMap).length === 0) continue;
          const newRows = uploadedRows.map(r => {
            const row = { id: genId() };
            tCols.forEach(c => { row[c.key] = c.type === "boolean" ? false : ""; });
            for (const [h, { key, type }] of Object.entries(colMap)) {
              const v = r[h];
              row[key] = type === "boolean" ? (v === true || v === 1 || String(v).toLowerCase() === "true") : String(v ?? "");
            }
            return row;
          });
          imports.push({ catId: matchedCat.id, catName: matchedCat.name, newRows, existing: (matchedCat.rows || []).length });
        }
        if (imports.length === 0) {
          setGlobalImportStatus("No matching sheets found. Sheet names must loosely match tab names (e.g. 'StationKits' → Station Kits).");
          setTimeout(() => setGlobalImportStatus(""), 8000); return;
        }
        const hasExisting = imports.some(im => im.existing > 0);
        if (hasExisting) {
          const names = imports.filter(im => im.existing > 0).map(im => im.catName).join(", ");
          if (!confirm(`This will append rows to tabs with existing data: ${names}. Proceed?`)) return;
        }
        updateCats(cur => {
          let next = cur;
          for (const { catId, newRows } of imports) {
            next = next.map(c => c.id !== catId ? c : { ...c, rows: [...(c.rows || []), ...newRows] });
          }
          return next;
        });
        const summary = imports.map(im => `${im.catName} (${im.newRows.length} rows)`).join(", ");
        setGlobalImportStatus(`✓ Imported: ${summary}`);
        setTimeout(() => setGlobalImportStatus(""), 12000);
      } catch (err) {
        setGlobalImportStatus("Error reading file: " + err.message);
        setTimeout(() => setGlobalImportStatus(""), 6000);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleGlobalExport = () => {
    const tableCats = cats.filter(c => c.type === "table");
    if (tableCats.length === 0) return;
    const wb = XLSX.utils.book_new();
    for (const cat of tableCats) {
      const cols = cat.columns || [];
      const rows = cat.rows || [];
      const isTransposed = TRANSPOSED_TABLE_IDS.has(cat.id);
      let ws;
      if (isTransposed) {
        // Vertical format: col attributes as rows, stations as columns
        const stationLabels = rows.map((r, i) => String(r.station_num || r.station || `S${i + 1}`));
        const aoa = [["Station", ...stationLabels]];
        for (const col of cols) {
          const rowData = [col.label, ...rows.map(r => {
            const v = r[col.key];
            return v === undefined || v === "" ? "" : v;
          })];
          aoa.push(rowData);
        }
        ws = XLSX.utils.aoa_to_sheet(aoa);
      } else {
        // Horizontal format: one row per data row
        const headers = cols.map(c => c.label);
        const jsonRows = rows.map(r => {
          const obj = {};
          cols.forEach(c => { obj[c.label] = r[c.key] ?? ""; });
          return obj;
        });
        ws = jsonRows.length > 0
          ? XLSX.utils.json_to_sheet(jsonRows, { header: headers })
          : XLSX.utils.aoa_to_sheet([headers]);
      }
      // Sheet name max 31 chars (Excel limit)
      XLSX.utils.book_append_sheet(wb, ws, cat.name.slice(0, 31));
    }
    const projectName = (project?.name || "project").replace(/[^a-z0-9]/gi, "_").slice(0, 30);
    const dateStr = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `${projectName}_${dateStr}.xlsx`);
  };

  return (
    <div>
      {/* Active tab header with optional delete (user-created folders only) */}
      {activeCat && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{activeCat.name}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {canEdit && (
              <>
                <button onClick={() => globalFileInputRef.current?.click()}
                  style={{ ...S.btnAddItem, background: "#F0FDF4", color: "#15803D", border: "1px solid #BBF7D0", fontSize: 11 }}
                  title="Import all matching sheets from an .xlsx file into their respective tabs">
                  📥 Import from Spreadsheet
                </button>
                <input ref={globalFileInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={handleGlobalImport} />
              </>
            )}
            <button onClick={handleGlobalExport}
              style={{ ...S.btnAddItem, background: "#EFF6FF", color: "#1D4ED8", border: "1px solid #BFDBFE", fontSize: 11 }}
              title="Export all table tabs to a single .xlsx file">
              📤 Export to Spreadsheet
            </button>
            {canEdit && isUserFolder && onDelFolder && (
              <button style={{ ...S.btnDel, fontSize: 11, padding: "4px 10px" }} onClick={() => onDelFolder(activeCat.id)}>Delete Folder</button>
            )}
          </div>
        </div>
      )}
      {globalImportStatus && (
        <div style={{ fontSize: 12, color: globalImportStatus.startsWith("✓") ? "#15803D" : "#DC2626", fontFamily: F, marginBottom: 8, padding: "6px 10px", background: globalImportStatus.startsWith("✓") ? "#F0FDF4" : "#FEF2F2", borderRadius: 6, border: `1px solid ${globalImportStatus.startsWith("✓") ? "#BBF7D0" : "#FECACA"}` }}>
          {globalImportStatus}
        </div>
      )}
      {/* Active tab content */}
      {activeCat && (
        activeCat.type === "checklist"
          ? <ChecklistSection cat={activeCat} cats={cats} updateCats={updateCats} user={user} canEdit={canEdit} pid={pid} lang={lang} />
          : activeCat.type === "program"
            ? <ProgramDetailsSection cat={activeCat} pid={pid} state={state} setState={setState} user={user} canEdit={canEdit} lang={lang} />
            : activeCat.type === "table"
              ? TRANSPOSED_TABLE_IDS.has(activeCat.id)
                ? <TransposedTableSection cat={activeCat} updateCats={updateCats} canEdit={canEdit} allCats={cats} />
                : <TableSection cat={activeCat} updateCats={updateCats} canEdit={canEdit} allCats={cats} />
              : <FolderSection cat={activeCat} updateCats={updateCats} user={user} canEdit={canEdit} pid={pid} />
      )}
    </div>
  );
}

/* Standard category IDs — protect from accidental deletion */
const STANDARD_CAT_IDS = new Set([
  ...APP_TABLE_TEMPLATES.map(t => t.id),
  "pd_specs", "pd_program", "pd_cad", "pd_deployment_requirements", "pd_reference_info",
  "inst_internal_checklist", "inst_external_checklist", "inst_mes_integration_checklist", "inst_si_checklist",
]);

/* ═══ PROJECT DETAILS VIEW — v4.1.0: tabbed nav with lazy migration ═══ */
function ProjectDetailsView({ user, project, state, setState, lang = "en" }) {
  const canEdit = isInst(user);
  const pid = project?.id;
  const cats = getProjectDetails(state.docData, pid);
  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  // updateCats + useEffect must be before any early return (Rules of Hooks)
  const updateCats = (newCatsOrFn) => setState(prev => {
    const cur = getProjectDetails(prev.docData, pid); // use merged result so col edits see appended template cols
    const newCats = typeof newCatsOrFn === "function" ? newCatsOrFn(cur) : newCatsOrFn;
    return { ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), projectDetails: newCats } } };
  });

  if (!project) return <div style={S.page}><div style={S.empty}>Select a project from the sidebar.</div></div>;

  const addFolder = () => {
    if (!newFolderName.trim()) return;
    updateCats(cur => [...cur, { id: genId(), name: newFolderName.trim(), accessLevel: "open", items: [] }]);
    setNewFolderName(""); setAddingFolder(false);
  };
  const delFolder = (catId) => { if (!confirm("Delete this folder?")) return; updateCats(cats.filter(c => c.id !== catId)); };

  const activeTabId = localStorage.getItem(`dp_proj_tab_${pid}`);
  const showValidation = activeTabId === "pd_specs";

  return (
    <div style={S.page}>
      <h2 style={S.h2}>Project Details</h2>
      <p style={S.sub}>{project.name} — documents, specs, checklists, tables, and drawings.</p>

      <ProjectTabsView
        cats={cats} updateCats={updateCats} user={user} canEdit={canEdit} pid={pid}
        project={project} state={state} setState={setState} lang={lang}
        onDelFolder={delFolder} standardCatIds={STANDARD_CAT_IDS}
      />

      {showValidation && <ValidationSection project={project} state={state} setState={setState} user={user} canEdit={canEdit} />}

      {canEdit && !addingFolder && (
        <button style={{ ...S.btnAddItem, marginTop: 16 }} onClick={() => setAddingFolder(true)}>+ Add Folder</button>
      )}
      {canEdit && addingFolder && (
        <div style={{ ...S.card, marginTop: 16 }}>
          <label style={S.lbl}>Folder Name</label>
          <input style={S.inp} value={newFolderName} onChange={e => setNewFolderName(e.target.value)} placeholder="e.g. Site Photos" />
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button style={{ ...S.btnMain, width: "auto", padding: "10px 18px", marginTop: 0 }} onClick={addFolder}>Create</button>
            <button style={{ ...S.btnFlat, width: "auto" }} onClick={() => setAddingFolder(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* Checklist Section — renders milestone groups with the v3.2.0 item schema */
// v4.0.3 — ChecklistSection: clean checkbox + label rows. Instrumental users can add/delete tasks.
// All hooks declared at top level — no IIFE/conditional hooks (the v3.x bug that crashed Chrome).
function ChecklistSection({ cat, cats, updateCats, user, canEdit, pid, lang }) {
  const [expanded, setExpanded] = useState({});
  const [addingTo, setAddingTo] = useState(null); // milestone id currently showing the "Add task" input
  const [newTaskLabel, setNewTaskLabel] = useState("");
  const [editingTask, setEditingTask] = useState(null); // { msId, ckId }
  const [editLabel, setEditLabel] = useState("");
  const [editingNotes, setEditingNotes] = useState(null); // { msId, ckId }
  const [notesValue, setNotesValue] = useState("");
  const toggleExpand = (msId) => setExpanded(prev => ({ ...prev, [msId]: !prev[msId] }));

  const updateMilestone = (msId, updater) => {
    updateCats(cur => cur.map(c => c.id !== cat.id ? c : { ...c, milestones: (c.milestones||[]).map(ms => ms.id !== msId ? ms : updater(ms)) }));
  };
  const toggleCheck = (msId, ckId) => updateMilestone(msId, ms => ({
    ...ms,
    checklist: (ms.checklist || []).map(ck => {
      if (ck.id !== ckId) return ck;
      const nowChecked = !ck.checked;
      return { ...ck, checked: nowChecked, checkedAt: nowChecked ? new Date().toISOString() : null, checkedBy: nowChecked ? (user.name || user.email || "Unknown") : null };
    }),
  }));
  const startEdit = (msId, ckId, label) => { setEditingTask({ msId, ckId }); setEditLabel(label); };
  const commitEdit = () => {
    if (!editingTask) return;
    const trimmed = editLabel.trim();
    if (trimmed) updateMilestone(editingTask.msId, ms => ({ ...ms, checklist: (ms.checklist || []).map(ck => ck.id !== editingTask.ckId ? ck : { ...ck, label: trimmed }) }));
    setEditingTask(null); setEditLabel("");
  };
  const addTask = (msId, label) => {
    const trimmed = (label || "").trim();
    if (!trimmed) return;
    updateMilestone(msId, ms => ({
      ...ms,
      checklist: [...(ms.checklist || []), {
        id: genId(), label: trimmed, checked: false, na: false,
        ownership: "", startDate: null, projectedDate: null, actualDate: null, sopLink: null,
        addedBy: user.name, addedAt: new Date().toISOString(),
      }],
    }));
    setNewTaskLabel("");
    setAddingTo(null);
  };
  const deleteTask = (msId, ckId) => {
    if (!confirm("Delete this task?")) return;
    updateMilestone(msId, ms => ({ ...ms, checklist: (ms.checklist || []).filter(ck => ck.id !== ckId) }));
  };
  const startEditNotes = (msId, ckId, current) => { setEditingNotes({ msId, ckId }); setNotesValue(current || ""); };
  const saveNotes = () => {
    if (!editingNotes) return;
    updateMilestone(editingNotes.msId, ms => ({
      ...ms,
      checklist: (ms.checklist || []).map(ck => ck.id !== editingNotes.ckId ? ck : { ...ck, notes: notesValue.trim() || null }),
    }));
    setEditingNotes(null); setNotesValue("");
  };

  const canCheck = canEdit || isInst(user); // Instrumental users can tick + add/delete tasks

  return (
    <div style={{ ...S.card, marginBottom: 12, borderLeft: "3px solid #6366F1" }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 12 }}>{cat.name}</div>
      {cat.id === "inst_mes_integration_checklist" && (
        <div style={{ marginBottom: 14, padding: "10px 14px", background: cat.mesRequired ? "#F0FDF4" : "#F8FAFC", borderRadius: 8, border: `1px solid ${cat.mesRequired ? "#BBF7D0" : "#E2E8F0"}`, display: "flex", alignItems: "center", gap: 10 }}>
          <input type="checkbox" id="mes_required_toggle" checked={!!cat.mesRequired}
            onChange={() => canEdit && updateCats(cur => cur.map(c => c.id !== cat.id ? c : { ...c, mesRequired: !c.mesRequired }))}
            style={{ width: 16, height: 16, cursor: canEdit ? "pointer" : "default", accentColor: "#15803D" }}
            disabled={!canEdit}
          />
          <label htmlFor="mes_required_toggle" style={{ fontSize: 14, fontWeight: 600, color: cat.mesRequired ? "#15803D" : "#64748B", fontFamily: F, cursor: canEdit ? "pointer" : "default" }}>
            MES integration is required for this project
          </label>
        </div>
      )}
      {cat.id === "inst_mes_integration_checklist" && !cat.mesRequired && (
        <div style={{ padding: "24px 0", textAlign: "center", color: "#94A3B8", fontFamily: F, fontSize: 13, fontStyle: "italic" }}>
          {canEdit ? "Check the box above to enable MES integration tracking for this project." : "MES integration is not required for this project."}
        </div>
      )}
      {(cat.id !== "inst_mes_integration_checklist" || !!cat.mesRequired) && (cat.milestones || []).map(ms => {
        const items = ms.checklist || [];
        const activeChecks = items.filter(ck => !ck.na);
        const doneCount = activeChecks.filter(ck => ck.checked).length;
        const pct = activeChecks.length > 0 ? Math.round((doneCount / activeChecks.length) * 100) : 0;
        const isOpen = !!expanded[ms.id];

        return (
          <div key={ms.id} style={{ marginBottom: 10, background: "#F8FAFC", borderRadius: 12, border: "1px solid #F1F5F9", overflow: "hidden" }}>
            {/* Milestone header — click to expand/collapse */}
            <button
              type="button"
              onClick={() => toggleExpand(ms.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", cursor: "pointer", width: "100%", border: "none", background: "transparent", textAlign: "left", fontFamily: F }}
            >
              <div style={{ width: 8, height: 8, borderRadius: 4, background: ms.color || "#00C9A7", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#0F172A" }}>{ms.name}</div>
                {ms.description && <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>{ms.description}</div>}
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: pct === 100 ? "#059669" : "#64748B", flexShrink: 0 }}>
                {doneCount}/{activeChecks.length}{activeChecks.length > 0 ? ` (${pct}%)` : ""}
              </div>
              <span style={{ fontSize: 12, color: "#94A3B8", flexShrink: 0 }}>{isOpen ? "▼" : "▶"}</span>
            </button>

            {/* Tasks list — checkbox + label per row, with Add task + delete affordances for Instrumental */}
            {isOpen && (
              <div style={{ padding: "4px 16px 14px" }}>
                {items.length === 0 ? (
                  <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", padding: "6px 0" }}>No tasks in this section.</div>
                ) : (
                  items.map(ck => {
                    const disabled = ck.na || !canCheck;
                    const isEditing = editingTask?.msId === ms.id && editingTask?.ckId === ck.id;
                    return (
                      <div key={ck.id} style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #F1F5F9", gap: 6 }}>
                        {/* Checkbox — click to toggle */}
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!disabled) toggleCheck(ms.id, ck.id); }}
                          style={{ flexShrink: 0, padding: "8px 4px 8px 6px", background: "transparent", border: "none", cursor: disabled ? "default" : "pointer" }}
                        >
                          <div style={{
                            width: 18, height: 18,
                            borderRadius: 4,
                            border: `2px solid ${ck.checked ? "#00C9A7" : "#CBD5E1"}`,
                            background: ck.checked ? "#00C9A7" : "#FFF",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 11, color: "#FFF", fontWeight: 800,
                          }}>{ck.checked ? "✓" : ""}</div>
                        </button>
                        {/* Label — double-click to edit (Instrumental only) */}
                        {isEditing ? (
                          <input
                            autoFocus
                            type="text"
                            value={editLabel}
                            onChange={e => setEditLabel(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
                              if (e.key === "Escape") { setEditingTask(null); setEditLabel(""); }
                            }}
                            onBlur={commitEdit}
                            style={{ flex: 1, padding: "4px 8px", fontSize: 13, fontFamily: F, border: "1px solid #C7D2FE", borderRadius: 6, outline: "none" }}
                          />
                        ) : (
                          <div style={{ flex: 1 }}>
                            <span
                              style={{
                                fontSize: 13, fontFamily: F, padding: "8px 0", display: "block",
                                color: ck.na ? "#94A3B8" : "#1E293B",
                                textDecoration: ck.na ? "line-through" : "none",
                                cursor: canCheck ? "text" : "default",
                                userSelect: "none",
                              }}
                              onDoubleClick={() => { if (canCheck) startEdit(ms.id, ck.id, ck.label); }}
                              title={canCheck ? "Double-click to edit" : undefined}
                            >{ck.label}</span>
                            {ck.checked && ck.checkedBy && (
                              <div style={{ fontSize: 11, color: "#00C9A7", fontFamily: F, paddingBottom: 4 }}>✓ {ck.checkedBy} · {fmtDate(ck.checkedAt)}</div>
                            )}
                            {/* Notes */}
                            {editingNotes?.msId === ms.id && editingNotes?.ckId === ck.id ? (
                              <textarea
                                autoFocus rows={2}
                                value={notesValue}
                                onChange={e => setNotesValue(e.target.value)}
                                onBlur={saveNotes}
                                onKeyDown={e => { if (e.key === "Escape") { setEditingNotes(null); setNotesValue(""); } }}
                                placeholder="Add a note…"
                                style={{ width: "100%", marginTop: 4, marginBottom: 4, padding: "4px 6px", fontSize: 12, fontFamily: F, border: "1px solid #C7D2FE", borderRadius: 5, outline: "none", resize: "vertical", color: "#475569" }}
                              />
                            ) : (ck.notes || canCheck) ? (
                              <div
                                onClick={() => canCheck && startEditNotes(ms.id, ck.id, ck.notes || "")}
                                style={{ fontSize: 12, fontFamily: F, color: ck.notes ? "#475569" : "#CBD5E1", fontStyle: ck.notes ? "normal" : "italic", marginTop: 2, marginBottom: 4, cursor: canCheck ? "text" : "default", minHeight: 16, lineHeight: "1.4" }}
                              >{ck.notes || "Add note…"}</div>
                            ) : null}
                          </div>
                        )}
                        {ck.ownership && !isEditing && <span style={{ fontSize: 11, color: "#94A3B8", flexShrink: 0 }}>· {ck.ownership}</span>}
                        {canCheck && (
                          <button
                            type="button"
                            title="Delete task"
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteTask(ms.id, ck.id); }}
                            style={{ border: "none", background: "transparent", color: "#CBD5E1", padding: "4px 10px", cursor: "pointer", fontSize: 16, fontFamily: F, lineHeight: 1, flexShrink: 0 }}
                            onMouseOver={e => e.currentTarget.style.color = "#DC2626"}
                            onMouseOut={e => e.currentTarget.style.color = "#CBD5E1"}
                          >×</button>
                        )}
                      </div>
                    );
                  })
                )}

                {/* Add task UI — Instrumental users only */}
                {canCheck && (
                  addingTo === ms.id ? (
                    <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                      <input
                        autoFocus
                        type="text"
                        value={newTaskLabel}
                        onChange={e => setNewTaskLabel(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") { e.preventDefault(); addTask(ms.id, newTaskLabel); }
                          if (e.key === "Escape") { setAddingTo(null); setNewTaskLabel(""); }
                        }}
                        placeholder="Type a new task and press Enter"
                        style={{ flex: 1, padding: "6px 10px", fontSize: 13, fontFamily: F, border: "1px solid #C7D2FE", borderRadius: 6, outline: "none" }}
                      />
                      <button type="button" onClick={() => addTask(ms.id, newTaskLabel)} style={{ padding: "6px 14px", fontSize: 12, fontWeight: 600, border: "none", borderRadius: 6, background: "#00C9A7", color: "#FFF", cursor: "pointer", fontFamily: F }}>Add</button>
                      <button type="button" onClick={() => { setAddingTo(null); setNewTaskLabel(""); }} style={{ padding: "6px 12px", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#64748B", cursor: "pointer", fontFamily: F }}>Cancel</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setAddingTo(ms.id); setNewTaskLabel(""); }}
                      style={{ marginTop: 10, padding: "6px 12px", fontSize: 12, fontWeight: 600, border: "1px dashed #C7D2FE", borderRadius: 6, background: "transparent", color: "#4338CA", cursor: "pointer", fontFamily: F }}
                    >+ Add task</button>
                  )
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* Program Details Section — tasks + milestones timeline (unchanged logic, extracted) */
function ProgramDetailsSection({ cat, pid, state, setState, user, canEdit, lang }) {
  const progData = state.docData?.[pid]?._programDetails || { tasks: [] };
  const tasks = progData.tasks || [];
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", type: "task", date: "", endDate: "" });

  const updateProg = (newTasks) => setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), _programDetails: { ...progData, tasks: newTasks } } } }));
  const addTask = () => { if (!form.name.trim()) return; updateProg([...tasks, { id: genId(), ...form, addedAt: new Date().toISOString() }]); setForm({ name: "", type: "task", date: "", endDate: "" }); setShowForm(false); };
  const delTask = (id) => updateProg(tasks.filter(t => t.id !== id));

  return (
    <div style={{ ...S.card, marginBottom: 12, borderLeft: "3px solid #F59E0B" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{cat.name}</div>
        {canEdit && <button style={S.btnEdit} onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "+ Add Task / Milestone"}</button>}
      </div>
      {showForm && canEdit && (
        <div style={{ padding: 14, background: "#F8FAFC", borderRadius: 10, marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button onClick={() => setForm(f => ({ ...f, type: "task" }))} style={{ ...S.typeBtn, ...(form.type === "task" ? S.typeBtnActive : {}) }}>📋 Task</button>
            <button onClick={() => setForm(f => ({ ...f, type: "milestone" }))} style={{ ...S.typeBtn, ...(form.type === "milestone" ? S.typeBtnActive : {}) }}>🏁 Milestone</button>
          </div>
          <label style={S.lbl}>Name</label><input style={S.inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <label style={S.lbl}>{form.type === "milestone" ? "Date" : "Start Date"}</label><input type="date" style={S.inp} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
          {form.type === "task" && <><label style={S.lbl}>End Date</label><input type="date" style={S.inp} value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} /></>}
          <button style={{ ...S.btnMain, width: "auto", padding: "10px 18px", marginTop: 12 }} onClick={addTask}>Add</button>
        </div>
      )}
      {tasks.length === 0 ? <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>No tasks or milestones yet.</div> : (
        <table style={{ ...S.table, fontSize: 13 }}>
          <thead><tr><th style={S.th}>Name</th><th style={S.th}>Type</th><th style={S.th}>Date</th>{canEdit && <th style={S.th}></th>}</tr></thead>
          <tbody>
            {tasks.map(t => (
              <tr key={t.id}>
                <td style={S.td}>{t.type === "milestone" ? "🏁 " : "📋 "}{t.name}</td>
                <td style={S.td}><Chip small color={t.type === "milestone" ? "#FEF3C7" : "#F1F5F9"} fg={t.type === "milestone" ? "#D97706" : "#64748B"}>{t.type}</Chip></td>
                <td style={S.td}>{fmtDay(t.date)}{t.endDate ? ` — ${fmtDay(t.endDate)}` : ""}</td>
                {canEdit && <td style={S.td}><button style={{ ...S.btnDel, fontSize: 11, padding: "2px 8px" }} onClick={() => delTask(t.id)}>✕</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* Hardware Tracking subsection (moved from old SI-specific, now visible to all) */
function HardwareTrackingSection({ project, state, setState, user, canEdit }) {
  const pid = project?.id;
  const hwData = state.docData?.[pid]?._hardwareTracking || [];
  const [addForm, setAddForm] = useState(null); // null | { type, serial, model, assetTag }
  const updateHW = (newData) => setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), _hardwareTracking: newData } } }));
  const delHW = (id) => { if (confirm("Remove this item?")) updateHW(hwData.filter(h => h.id !== id)); };
  const submitAdd = () => {
    if (!addForm?.serial?.trim()) return;
    updateHW([...hwData, { id: genId(), type: addForm.type, serial: addForm.serial.trim(), model: addForm.model?.trim() || "", assetTag: addForm.assetTag?.trim() || "", source: "manual" }]);
    setAddForm(null);
  };

  const hsCount = hwData.filter(h => h.source === "hubspot").length;
  const manualCount = hwData.filter(h => h.source !== "hubspot").length;

  return (
    <div style={{ ...S.card, marginBottom: 12, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F }}>Hardware Tracking</div>
        <div style={{ display: "flex", gap: 6 }}>
          {hsCount > 0 && <span style={{ fontSize: 11, fontWeight: 600, background: "#EFF6FF", color: "#2563EB", borderRadius: 6, padding: "2px 8px", fontFamily: F }}>🔗 {hsCount} from HubSpot</span>}
          {manualCount > 0 && <span style={{ fontSize: 11, fontWeight: 600, background: "#F0FDF4", color: "#16A34A", borderRadius: 6, padding: "2px 8px", fontFamily: F }}>✎ {manualCount} manual</span>}
        </div>
      </div>

      {hwData.length === 0 ? (
        <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>No hardware tracked yet. Run a HubSpot sync to auto-populate from Station Kits.</div>
      ) : (
        <table style={{ ...S.table, fontSize: 13 }}>
          <thead><tr>
            <th style={S.th}>Source</th>
            <th style={S.th}>Type</th>
            <th style={S.th}>Serial / Asset SN</th>
            <th style={S.th}>Model</th>
            <th style={S.th}>Asset Tag</th>
            <th style={S.th}>Kit SN</th>
            {canEdit && <th style={S.th}></th>}
          </tr></thead>
          <tbody>{hwData.map(h => (
            <tr key={h.id}>
              <td style={S.td}>
                {h.source === "hubspot"
                  ? <span style={{ fontSize: 10, fontWeight: 700, background: "#EFF6FF", color: "#2563EB", borderRadius: 4, padding: "1px 5px", fontFamily: F }}>HubSpot</span>
                  : <span style={{ fontSize: 10, fontWeight: 700, background: "#F0FDF4", color: "#16A34A", borderRadius: 4, padding: "1px 5px", fontFamily: F }}>Manual</span>}
              </td>
              <td style={S.td}>{h.type || "—"}</td>
              <td style={{ ...S.td, fontWeight: 600 }}>{h.serial || "—"}</td>
              <td style={S.td}>{h.model || "—"}</td>
              <td style={S.td}>{h.assetTag || "—"}</td>
              <td style={{ ...S.td, fontSize: 11, color: "#94A3B8" }}>{h.kitSN || "—"}</td>
              {canEdit && <td style={S.td}><button style={{ ...S.btnDel, fontSize: 11, padding: "2px 8px" }} onClick={() => delHW(h.id)}>✕</button></td>}
            </tr>
          ))}</tbody>
        </table>
      )}

      {canEdit && (
        addForm ? (
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <select value={addForm.type} onChange={e => setAddForm(f => ({ ...f, type: e.target.value }))}
              style={{ ...S.inp, width: 150, padding: "6px 10px", fontSize: 12 }}>
              {HW_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input placeholder="Serial / Asset SN *" value={addForm.serial} onChange={e => setAddForm(f => ({ ...f, serial: e.target.value }))}
              style={{ ...S.inp, width: 160, padding: "6px 10px", fontSize: 12 }} />
            <input placeholder="Model #" value={addForm.model} onChange={e => setAddForm(f => ({ ...f, model: e.target.value }))}
              style={{ ...S.inp, width: 140, padding: "6px 10px", fontSize: 12 }} />
            <input placeholder="Asset Tag" value={addForm.assetTag} onChange={e => setAddForm(f => ({ ...f, assetTag: e.target.value }))}
              onKeyDown={e => { if (e.key === "Enter") submitAdd(); if (e.key === "Escape") setAddForm(null); }}
              style={{ ...S.inp, width: 130, padding: "6px 10px", fontSize: 12 }} />
            <button onClick={submitAdd} style={{ ...S.btnMain, padding: "6px 16px", fontSize: 12 }}>Add</button>
            <button onClick={() => setAddForm(null)} style={{ padding: "6px 12px", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#64748B", cursor: "pointer", fontFamily: F }}>Cancel</button>
          </div>
        ) : (
          <button onClick={() => setAddForm({ type: HW_TYPES[0], serial: "", model: "", assetTag: "" })}
            style={{ ...S.btnAddItem, marginTop: 10 }}>+ Add hardware manually</button>
        )
      )}
    </div>
  );
}

/* Validation subsection (moved from old SI-specific) */
function ValidationSection({ project, state, setState, user, canEdit }) {
  const pid = project?.id;
  const valData = state.docData?.[pid]?._validation || {};
  const updateVal = (data) => setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), _validation: data } } }));
  return (
    <div style={{ ...S.card, marginBottom: 12 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 10 }}>Validation</div>
      <div style={{ fontSize: 13, color: "#64748B", fontFamily: F }}>
        <div style={S.miniStat}><span>FAT Status</span><strong>{valData.fatStatus || "Not started"}</strong></div>
        <div style={S.miniStat}><span>SAT Status</span><strong>{valData.satStatus || "Not started"}</strong></div>
        {canEdit && (
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <select style={{ ...S.inp, width: "auto", padding: "6px 10px", fontSize: 12 }} value={valData.fatStatus || ""} onChange={e => updateVal({ ...valData, fatStatus: e.target.value })}>
                <option value="">FAT Status...</option><option value="Not started">Not started</option><option value="In progress">In progress</option><option value="Passed">Passed</option><option value="Failed">Failed</option><option value="Conditional">Conditional</option>
              </select>
              {valData.fatStatus && <button type="button" onClick={() => updateVal({ ...valData, fatStatus: "" })} style={{ background: "#EF4444", color: "#fff", border: "none", borderRadius: 4, padding: "4px 8px", fontSize: 12, cursor: "pointer" }}>×</button>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <select style={{ ...S.inp, width: "auto", padding: "6px 10px", fontSize: 12 }} value={valData.satStatus || ""} onChange={e => updateVal({ ...valData, satStatus: e.target.value })}>
                <option value="">SAT Status...</option><option value="Not started">Not started</option><option value="In progress">In progress</option><option value="Passed">Passed</option><option value="Failed">Failed</option><option value="Conditional">Conditional</option>
              </select>
              {valData.satStatus && <button type="button" onClick={() => updateVal({ ...valData, satStatus: "" })} style={{ background: "#EF4444", color: "#fff", border: "none", borderRadius: 4, padding: "4px 8px", fontSize: 12, cursor: "pointer" }}>×</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══ COMMERCIAL VIEW — restricted, admin-gated ═══ */
function CommercialView({ user, project, state, setState, lang = "en" }) {
  const canEdit = isInst(user);
  const pid = project?.id;
  const cats = getCommercial(state.docData, pid);
  const [addingItem, setAddingItem] = useState(null);
  const [itemForm, setItemForm] = useState({ name: "", url: "", type: "link" });

  if (!project) return <div style={S.page}><div style={S.empty}>Select a project from the sidebar.</div></div>;

  const updateCats = (newCats) => setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), commercial: newCats } } }));
  const addItem = (catId) => {
    if (!itemForm.name.trim()) return;
    const url = commitUrl(itemForm.url); if (url === null) return;
    const item = { id: genId(), name: itemForm.name.trim(), url, type: itemForm.type, addedBy: user.name, addedAt: new Date().toISOString() };
    updateCats(cats.map(c => c.id !== catId ? c : { ...c, items: [...(c.items||[]), item] }));
    setItemForm({ name: "", url: "", type: "link" }); setAddingItem(null);
  };
  const delItem = (catId, itemId) => updateCats(cats.map(c => c.id !== catId ? c : { ...c, items: (c.items||[]).filter(i => i.id !== itemId) }));

  return (
    <div style={S.page}>
      <h2 style={S.h2}>Commercial</h2>
      <p style={S.sub}>{project.name} — agreements, pricing, and legal documents. Access is restricted.</p>
      <Chip small color="#FEF3C7" fg="#D97706">Restricted — admin-granted access only</Chip>
      <div style={{ marginTop: 16 }}>
        {cats.map(cat => (
          <div key={cat.id} style={{ ...S.card, marginBottom: 12, borderLeft: "3px solid #F59E0B" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F }}>🔒 {cat.name}</div>
              <Chip small>{(cat.items||[]).length} items</Chip>
            </div>
            {(cat.items||[]).map(item => (
              <div key={item.id} style={S.docItemRow}>
                <span>🔗</span>
                <div style={{ flex: 1 }}>{item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 15, color: "#0284C7", textDecoration: "none", fontFamily: F }}>{item.name}</a> : <span style={{ fontSize: 15, fontFamily: F }}>{item.name}</span>}</div>
                {canEdit && <button style={{ ...S.btnDel, padding: "3px 8px", fontSize: 11 }} onClick={() => delItem(cat.id, item.id)}>✕</button>}
              </div>
            ))}
            {(cat.items||[]).length === 0 && <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>No documents yet.</div>}
            {canEdit && (addingItem === cat.id ? (
              <div style={{ marginTop: 12, padding: 14, background: "#F8FAFC", borderRadius: 10 }}>
                <label style={S.lbl}>Name</label><input style={S.inp} value={itemForm.name} onChange={e => setItemForm(f => ({ ...f, name: e.target.value }))} />
                <label style={S.lbl}>URL <span style={{ color: "#94A3B8", fontWeight: 400 }}>(or upload a file below)</span></label>
                <input style={S.inp} value={itemForm.url} onChange={e => setItemForm(f => ({ ...f, url: e.target.value, type: "link" }))} placeholder="https://..." />
                <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <button style={{ ...S.btnMain, width: "auto", padding: "10px 18px", marginTop: 0 }} onClick={() => addItem(cat.id)}>Add</button>
                  <PdfUploadButton projectId={pid} onUploaded={(url, fileName) => {
                    setItemForm(f => ({ ...f, url, type: "pdf", name: f.name?.trim() || fileName.replace(/\.pdf$/i, "") }));
                  }} />
                  <button style={{ ...S.btnFlat, width: "auto" }} onClick={() => setAddingItem(null)}>Cancel</button>
                </div>
                {itemForm.url && itemForm.type === "pdf" && <div style={{ fontSize: 12, color: "#059669", fontFamily: F, marginTop: 8 }}>✓ PDF uploaded — click Add to save.</div>}
              </div>
            ) : <button style={S.btnAddItem} onClick={() => setAddingItem(cat.id)}>+ Add Document</button>)}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══ TRAINING VIEW — v3.2.0: per-project toggle, belt assignment, materials ═══ */
function TrainingView({ user, project, state, setState, lang = "en" }) {
  const canEdit = isInst(user);
  const pid = project?.id;
  const trainingData = state.docData?.[pid]?._training || {};
  const enabled = trainingData.enabled || false;
  const materials = trainingData.materials || [];
  const assignments = trainingData.assignments || {}; // { userId: "white"|"blue"|"black" }
  const allUsers = state.users || [];
  const [addMat, setAddMat] = useState(false);
  const [matForm, setMatForm] = useState({ name: "", url: "", belt: "white" });

  if (!project) return <div style={S.page}><div style={S.empty}>Select a project from the sidebar.</div></div>;

  const updateTraining = (data) => setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), _training: data } } }));
  const toggleEnabled = () => updateTraining({ ...trainingData, enabled: !enabled });
  const addMaterial = () => { if (!matForm.name.trim()) return; const url = commitUrl(matForm.url); if (url === null) return; updateTraining({ ...trainingData, materials: [...materials, { id: genId(), ...matForm, url, addedBy: user.name, addedAt: new Date().toISOString() }] }); setMatForm({ name: "", url: "", belt: "white" }); setAddMat(false); };
  const delMaterial = (id) => updateTraining({ ...trainingData, materials: materials.filter(m => m.id !== id) });
  const assignBelt = (uid, belt) => updateTraining({ ...trainingData, assignments: { ...assignments, [uid]: belt } });
  const removeBelt = (uid) => { const next = { ...assignments }; delete next[uid]; updateTraining({ ...trainingData, assignments: next }); };

  // Users see only their assigned belt
  const myBelt = assignments[user.id];
  const myMaterials = myBelt ? materials.filter(m => m.belt === myBelt) : [];

  return (
    <div style={S.page}>
      <h2 style={S.h2}>Training</h2>
      <p style={S.sub}>{project.name}</p>

      {canEdit && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <span style={{ fontSize: 14, color: "#64748B", fontFamily: F }}>{enabled ? "Enabled" : "Disabled"}</span>
          <div onClick={toggleEnabled} style={{ width: 44, height: 24, borderRadius: 12, background: enabled ? "#00C9A7" : "#CBD5E1", cursor: "pointer", position: "relative", transition: "background .2s" }}>
            <div style={{ width: 18, height: 18, borderRadius: 9, background: "#FFF", position: "absolute", top: 3, left: enabled ? 23 : 3, transition: "left .2s" }} />
          </div>
        </div>
      )}

      {!enabled && <div style={S.empty}>Training is disabled for this project.{canEdit ? " Toggle above to enable." : ""}</div>}

      {enabled && (<>
        {/* Belt assignment — admin/instrumental can assign users */}
        {canEdit && (
          <div style={{ ...S.card, marginBottom: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 10 }}>Belt Assignments</div>
            <p style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginBottom: 10 }}>Assign users to a belt level. They will only see materials for their assigned belt.</p>
            {allUsers.map(u => {
              const belt = assignments[u.id];
              return (
                <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid #F8FAFC" }}>
                  <span style={{ fontSize: 13, fontFamily: F, flex: 1 }}>{u.name} <span style={{ color: "#94A3B8", fontSize: 11 }}>({u.email})</span></span>
                  <select style={{ ...S.inp, width: 130, padding: "3px 6px", fontSize: 11 }} value={belt || ""} onChange={e => e.target.value ? assignBelt(u.id, e.target.value) : removeBelt(u.id)}>
                    <option value="">Not assigned</option>
                    {Object.entries(BELT_LEVELS).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.name}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        )}

        {/* Materials — organized by belt */}
        {canEdit ? (
          // Instrumental sees all belts
          ["white", "blue", "black"].map(belt => {
            const bi = BELT_LEVELS[belt];
            const beltMats = materials.filter(m => m.belt === belt);
            return (
              <div key={belt} style={{ ...S.card, marginBottom: 12, borderLeft: `3px solid ${bi.color}` }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 8 }}>{bi.icon} {bi.name}</div>
                {beltMats.map(m => (
                  <div key={m.id} style={S.docItemRow}>
                    <span>🔗</span>
                    <div style={{ flex: 1 }}>{m.url ? <a href={m.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, color: "#0284C7", fontFamily: F, textDecoration: "none" }}>{m.name}</a> : <span style={{ fontSize: 14, fontFamily: F }}>{m.name}</span>}</div>
                    <button style={{ ...S.btnDel, padding: "2px 6px", fontSize: 10 }} onClick={() => delMaterial(m.id)}>✕</button>
                  </div>
                ))}
                {beltMats.length === 0 && <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>No materials yet.</div>}
              </div>
            );
          })
        ) : (
          // External users see only their assigned belt
          myBelt ? (
            <div style={{ ...S.card, borderLeft: `3px solid ${BELT_LEVELS[myBelt].color}` }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 8 }}>{BELT_LEVELS[myBelt].icon} {BELT_LEVELS[myBelt].name}</div>
              {myMaterials.length > 0 ? myMaterials.map(m => (
                <div key={m.id} style={S.docItemRow}>
                  <span>🔗</span>
                  <div style={{ flex: 1 }}>{m.url ? <a href={m.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, color: "#0284C7", fontFamily: F, textDecoration: "none" }}>{m.name}</a> : <span style={{ fontSize: 14, fontFamily: F }}>{m.name}</span>}</div>
                </div>
              )) : <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>No materials available for your belt level yet.</div>}
            </div>
          ) : <div style={S.empty}>You have not been assigned a training belt for this project yet. Contact your Instrumental team.</div>
        )}

        {/* Add material — instrumental */}
        {canEdit && !addMat && <button style={{ ...S.btnAddItem, marginTop: 12 }} onClick={() => setAddMat(true)}>+ Add Training Material</button>}
        {canEdit && addMat && (
          <div style={{ ...S.card, marginTop: 12, padding: 14 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              {["white","blue","black"].map(b => <button key={b} onClick={() => setMatForm(f => ({...f, belt: b}))} style={{ ...S.typeBtn, ...(matForm.belt === b ? S.typeBtnActive : {}) }}>{BELT_LEVELS[b].icon} {BELT_LEVELS[b].name}</button>)}
            </div>
            <label style={S.lbl}>Title</label><input style={S.inp} value={matForm.name} onChange={e => setMatForm(f => ({...f, name: e.target.value}))} />
            <label style={S.lbl}>URL <span style={{ color: "#94A3B8", fontWeight: 400 }}>(or upload a file below)</span></label>
            <input style={S.inp} value={matForm.url} onChange={e => setMatForm(f => ({...f, url: e.target.value}))} placeholder="https://..." />
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button style={{ ...S.btnMain, width: "auto", padding: "8px 16px", marginTop: 0 }} onClick={addMaterial}>Add</button>
              <PdfUploadButton projectId={pid} onUploaded={(url, fileName) => {
                setMatForm(f => ({ ...f, url, name: f.name?.trim() || fileName.replace(/\.pdf$/i, "") }));
              }} />
              <button style={{ ...S.btnFlat, width: "auto" }} onClick={() => setAddMat(false)}>Cancel</button>
            </div>
            {matForm.url && /firebasestorage/.test(matForm.url) && <div style={{ fontSize: 12, color: "#059669", fontFamily: F, marginTop: 8 }}>✓ PDF uploaded — click Add to save.</div>}
          </div>
        )}
      </>)}
    </div>
  );
}

/* ═══ AI BOT CHAT — v3.3.0: per-project Q&A for Instrumental users ═══ */
/* ═══ CHAT VIEW — v4.0.0: full-page conversational chatbot, available to all authed users ═══ */
function ChatView({ user }) {
  const [messages, setMessages] = useState([
    { role: "assistant", text: `Hi ${user.name.split(" ")[0]} — I'm the Deployment Portal AI assistant. Ask me anything about your projects: status, milestones, hardware, who owns what. I'll do my best to help.` },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const send = async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    const next = [...messages, { role: "user", text: q }];
    setMessages(next);
    setLoading(true);
    try {
      const fn = httpsCallable(functions, "chatBot");
      const res = await fn({ question: q, history: messages });
      setMessages(prev => [...prev, { role: "assistant", text: res.data?.answer || "No response." }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", text: "Sorry — I hit an error: " + (e.message || String(e)) }]);
    }
    setLoading(false);
  };

  const suggestions = isInst(user)
    ? ["Which projects are blocked?", "Summarize all active deployments", "What's our total camera demand?", "Which projects have CAD pending?"]
    : ["What's the status of my projects?", "What milestones are coming up?", "Who owns the next steps?", "When is my project's expected deploy date?"];

  return (
    <div style={{ ...S.page, maxWidth: 900 }}>
      <h2 style={S.h2}>💬 AI Chat</h2>
      <p style={S.sub}>Conversational assistant for your projects. Powered by Claude.</p>

      <div style={{ ...S.card, padding: 0, overflow: "hidden", display: "flex", flexDirection: "column", height: "calc(100vh - 240px)", minHeight: 460 }}>
        <div style={{ flex: 1, overflowY: "auto", padding: 20, background: "#FAFAFA" }}>
          {messages.map((m, i) => (
            <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 12 }}>
              <div style={{ maxWidth: "78%", padding: "10px 14px", borderRadius: 12, background: m.role === "user" ? "#00C9A7" : "#FFF", color: m.role === "user" ? "#FFF" : "#0F172A", fontSize: 14, fontFamily: F, whiteSpace: "pre-wrap", border: m.role === "assistant" ? "1px solid #E2E8F0" : "none", lineHeight: 1.55, boxShadow: m.role === "assistant" ? "0 1px 2px rgba(0,0,0,.04)" : "none" }}>
                {m.text}
              </div>
            </div>
          ))}
          {loading && (
            <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 12 }}>
              <div style={{ padding: "10px 14px", borderRadius: 12, background: "#FFF", color: "#94A3B8", fontSize: 13, fontFamily: F, border: "1px solid #E2E8F0", fontStyle: "italic" }}>thinking…</div>
            </div>
          )}
        </div>

        {messages.length <= 2 && !loading && (
          <div style={{ padding: "10px 16px", borderTop: "1px solid #E2E8F0", background: "#F8FAFC" }}>
            <div style={{ fontSize: 11, color: "#64748B", fontFamily: F, marginBottom: 6, textTransform: "uppercase", letterSpacing: .5, fontWeight: 600 }}>Suggested questions</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {suggestions.map(s => (
                <button key={s} onClick={() => setInput(s)} style={{ padding: "5px 10px", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 14, background: "#FFF", color: "#475569", cursor: "pointer", fontFamily: F }}>{s}</button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid #E2E8F0", background: "#FFF" }}>
          <input
            style={{ flex: 1, padding: "10px 14px", fontSize: 14, fontFamily: F, border: "1px solid #E2E8F0", borderRadius: 10, outline: "none" }}
            placeholder="Type a message…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            disabled={loading}
          />
          <button onClick={send} disabled={loading || !input.trim()} style={{ padding: "10px 18px", fontSize: 14, fontWeight: 600, border: "none", borderRadius: 10, background: loading || !input.trim() ? "#CBD5E1" : "#00C9A7", color: "#FFF", cursor: loading || !input.trim() ? "default" : "pointer", fontFamily: F }}>Send</button>
        </div>
      </div>
    </div>
  );
}

/* ═══ GLOBAL AI BAR — v4.0.0: cross-project chat search at top of every view (Instrumental only) ═══ */
function GlobalBotBar({ user }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  if (!isInst(user)) return null;

  const ask = async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    const next = [...messages, { role: "user", text: q }];
    setMessages(next);
    setLoading(true);
    setOpen(true);
    try {
      const fn = httpsCallable(functions, "askGlobalBot");
      const res = await fn({ question: q, history: messages });
      setMessages(prev => [...prev, { role: "assistant", text: res.data?.answer || "No response." }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", text: "Error: " + (e.message || String(e)) }]);
    }
    setLoading(false);
  };

  return (
    <div style={{ position: "sticky", top: 0, zIndex: 50, background: "rgba(248,250,252,0.95)", backdropFilter: "blur(6px)", padding: "10px 24px", borderBottom: "1px solid #E2E8F0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: 1100, margin: "0 auto" }}>
        <span style={{ fontSize: 16 }}>🤖</span>
        <input
          style={{ flex: 1, padding: "8px 14px", fontSize: 13, fontFamily: F, border: "1px solid #E2E8F0", borderRadius: 8, background: "#FFF", outline: "none" }}
          placeholder="Ask the AI anything across all projects — e.g. 'Which projects are blocked?' or 'Total camera demand this quarter'"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") ask(); }}
        />
        <button onClick={ask} disabled={loading || !input.trim()} style={{ padding: "8px 14px", fontSize: 13, fontWeight: 600, border: "none", borderRadius: 8, background: loading ? "#CBD5E1" : "#00C9A7", color: "#FFF", cursor: loading || !input.trim() ? "default" : "pointer", fontFamily: F }}>{loading ? "Thinking…" : "Ask"}</button>
        {messages.length > 0 && (
          <button onClick={() => setOpen(o => !o)} style={{ padding: "6px 10px", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#64748B", cursor: "pointer", fontFamily: F }}>{open ? "Hide" : `Show (${messages.length})`}</button>
        )}
        {messages.length > 0 && (
          <button onClick={() => { setMessages([]); setOpen(false); }} style={{ padding: "6px 10px", fontSize: 12, border: "1px solid #FECACA", borderRadius: 6, background: "#FFF", color: "#B91C1C", cursor: "pointer", fontFamily: F }}>Clear</button>
        )}
      </div>
      {open && messages.length > 0 && (
        <div style={{ maxWidth: 1100, margin: "10px auto 0", maxHeight: 380, overflowY: "auto", padding: "8px 4px" }}>
          {messages.map((m, i) => (
            <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 8 }}>
              <div style={{ maxWidth: "78%", padding: "8px 12px", borderRadius: 10, background: m.role === "user" ? "#00C9A7" : "#FFF", color: m.role === "user" ? "#FFF" : "#0F172A", fontSize: 13, fontFamily: F, whiteSpace: "pre-wrap", border: m.role === "assistant" ? "1px solid #E2E8F0" : "none", lineHeight: 1.5 }}>
                {m.text}
              </div>
            </div>
          ))}
          {loading && <div style={{ fontSize: 12, color: "#94A3B8", fontFamily: F, textAlign: "center", padding: 6 }}>AI is thinking…</div>}
        </div>
      )}
    </div>
  );
}

function ProjectBotChat({ project, user }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  if (!project || !isInst(user)) return null;

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const q = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", text: q }]);
    setLoading(true);
    try {
      const fn = httpsCallable(functions, "askProjectBot");
      const res = await fn({ projectId: project.id, question: q });
      setMessages(prev => [...prev, { role: "assistant", text: res.data?.answer || "No response." }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", text: "Error: " + (e.message || String(e)) }]);
    }
    setLoading(false);
  };

  const fillSection = async (sectionId) => {
    setMessages(prev => [...prev, { role: "user", text: `Fill section: ${sectionId}` }]);
    setLoading(true);
    try {
      const fn = httpsCallable(functions, "askProjectBot");
      const res = await fn({ projectId: project.id, action: "fill_section", sectionId });
      setMessages(prev => [...prev, { role: "assistant", text: res.data?.answer || "No suggestions." }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", text: "Error: " + (e.message || String(e)) }]);
    }
    setLoading(false);
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ position: "fixed", bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, background: "#00C9A7", color: "#FFF", border: "none", fontSize: 24, cursor: "pointer", boxShadow: "0 4px 20px rgba(0,201,167,.4)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F }}>
        AI
      </button>
    );
  }

  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, width: 400, maxHeight: "70vh", background: "#FFF", borderRadius: 16, border: "1px solid #E2E8F0", boxShadow: "0 8px 40px rgba(0,0,0,.15)", zIndex: 200, display: "flex", flexDirection: "column", fontFamily: F }}>
      {/* Header */}
      <div style={{ padding: "14px 18px", borderBottom: "1px solid #F1F5F9", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A" }}>AI Assistant</div>
          <div style={{ fontSize: 12, color: "#94A3B8" }}>{project.name}</div>
        </div>
        <button onClick={() => setOpen(false)} style={{ border: "none", background: "none", fontSize: 18, color: "#94A3B8", cursor: "pointer" }}>✕</button>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: 14, maxHeight: "50vh" }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 14, color: "#64748B", marginBottom: 12 }}>Ask me anything about this project. I can see checklists, milestones, hardware, and documents.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {["What's the checklist progress?", "What are the upcoming milestones?", "Summarize the project status"].map(q => (
                <button key={q} onClick={() => { setInput(q); }} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #E2E8F0", background: "#F8FAFC", color: "#475569", fontSize: 12, cursor: "pointer", textAlign: "left", fontFamily: F }}>{q}</button>
              ))}
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: "#94A3B8" }}>Or ask the AI to fill a section:</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, justifyContent: "center" }}>
              {["Hardware", "Program Details", "Deployment Planning"].map(s => (
                <button key={s} onClick={() => fillSection(s)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #00C9A7", background: "#ECFDF5", color: "#059669", fontSize: 11, cursor: "pointer", fontFamily: F }}>Fill: {s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 10, display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{ maxWidth: "85%", padding: "10px 14px", borderRadius: m.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px", background: m.role === "user" ? "#00C9A7" : "#F1F5F9", color: m.role === "user" ? "#FFF" : "#0F172A", fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
              {m.text}
            </div>
          </div>
        ))}
        {loading && <div style={{ fontSize: 13, color: "#94A3B8", fontStyle: "italic" }}>Thinking...</div>}
      </div>

      {/* Input */}
      <div style={{ padding: "10px 14px", borderTop: "1px solid #F1F5F9", display: "flex", gap: 8 }}>
        <input style={{ ...S.inp, flex: 1, padding: "10px 14px", fontSize: 13 }} value={input} onChange={e => setInput(e.target.value)} placeholder="Ask about this project..." onKeyDown={e => e.key === "Enter" && sendMessage()} />
        <button onClick={sendMessage} disabled={loading || !input.trim()} style={{ ...S.btnMain, width: "auto", padding: "10px 18px", marginTop: 0, opacity: loading || !input.trim() ? 0.5 : 1 }}>Send</button>
      </div>
    </div>
  );
}

/* ═══ SI KANBAN — v4.0.1: shows projects from the HubSpot "SI Partner Deployment" pipeline only ═══ */
/* Stage comes from HubSpot sync (project.siStage). Drag-and-drop is local-only until v4.1.0 writeback. */
function SIKanbanView({ projects, state, setState }) {
  // Filter: projects in the SI Partner Deployment pipeline. Exclude [SI]-tagged Hardware Deployment projects.
  const siProjects = (projects || []).filter(p =>
    p.status === "active" &&
    p.hubspotPipelineId === SI_PARTNER_PIPELINE_ID
  );
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverStage, setDragOverStage] = useState(null);

  if (siProjects.length === 0) return null;

  const getStage = (proj) => normalizeSiStage(proj.siStage);
  const setStage = (pid, stageId) => setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id !== pid ? p : { ...p, siStage: stageId, updatedAt: new Date().toISOString() }) }));

  const onDragStart = (e, projId) => { setDraggingId(projId); e.dataTransfer.effectAllowed = "move"; };
  const onDragEnd = () => { setDraggingId(null); setDragOverStage(null); };
  const onDragOver = (e, stageId) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverStage(stageId); };
  const onDragLeave = () => setDragOverStage(null);
  const onDrop = (e, stageId) => { e.preventDefault(); if (draggingId) setStage(draggingId, stageId); setDraggingId(null); setDragOverStage(null); };

  return (
    <div style={{
      marginTop: 24,
      marginBottom: 32,
      padding: "20px 22px",
      background: "linear-gradient(135deg, #EFF6FF 0%, #DBEAFE 100%)",
      border: "2px solid #3B82F6",
      borderRadius: 12,
      boxShadow: "0 4px 12px rgba(59, 130, 246, 0.12)",
      position: "relative",
    }}>
      {/* Distinct top label so this section is clearly NOT the Hardware Deployment data */}
      <div style={{ position: "absolute", top: -12, left: 16, padding: "2px 10px", background: "#3B82F6", color: "#FFF", fontSize: 11, fontWeight: 700, letterSpacing: 1, borderRadius: 4, fontFamily: F }}>
        SI PARTNER DEPLOYMENT PIPELINE
      </div>
      <h3 style={{ ...S.h3, marginTop: 4, marginBottom: 6, color: "#1E40AF" }}>🤝 SI Deployment Kanban</h3>
      <p style={{ fontSize: 13, color: "#1E40AF", fontFamily: F, marginBottom: 14 }}>
        <b>Separate from Hardware Deployment.</b> Only shows projects in HubSpot's "SI Partner Deployment" pipeline. Drag cards between stages to update locally.
        &nbsp;{siProjects.length} SI project{siProjects.length !== 1 ? "s" : ""} tracked.
      </p>

      {/* SI Process link */}
      <a href="https://script.google.com/a/macros/instrumental.com/s/AKfycbxOAtRNRm2_-XIPPK1fPKW-O55uVtMhMZSDcdZiR4xRqRBmtYgqURhAZ8MPg3RVsvNG/exec" target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, background: "#FFF", color: "#3B82F6", fontSize: 12, fontWeight: 600, textDecoration: "none", fontFamily: F, marginBottom: 14 }}>
        SI Process, RACI & Principles ↗
      </a>

      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8 }}>
        {SI_PIPELINE_STAGES.map(stage => {
          const stageProjects = siProjects.filter(p => getStage(p) === stage.id);
          const isOver = dragOverStage === stage.id;
          return (
            <div key={stage.id}
              onDragOver={e => onDragOver(e, stage.id)}
              onDragLeave={onDragLeave}
              onDrop={e => onDrop(e, stage.id)}
              style={{ minWidth: 190, maxWidth: 230, flex: "0 0 auto", background: isOver ? `${stage.color}10` : "#F8FAFC", borderRadius: 12, border: `2px solid ${isOver ? stage.color : "#F1F5F9"}`, padding: 12, transition: "all .15s" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: 4, background: stage.color }} />
                <div style={{ fontSize: 12, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{stage.label}</div>
                <Chip small color={`${stage.color}22`} fg={stage.color}>{stageProjects.length}</Chip>
              </div>
              {stageProjects.map(proj => (
                <div key={proj.id}
                  draggable
                  onDragStart={e => onDragStart(e, proj.id)}
                  onDragEnd={onDragEnd}
                  style={{ background: draggingId === proj.id ? "#ECFDF5" : "#FFF", borderRadius: 8, padding: "8px 10px", marginBottom: 6, border: `1px solid ${draggingId === proj.id ? "#00C9A7" : "#E2E8F0"}`, fontSize: 12, fontFamily: F, cursor: "grab", opacity: draggingId === proj.id ? 0.6 : 1, transition: "all .1s" }}>
                  <div style={{ fontWeight: 600, color: "#0F172A", marginBottom: 2 }}>{proj.customer || proj.name}</div>
                  <div style={{ color: "#94A3B8", fontSize: 11 }}>{proj.stations || 0} stn{proj.updatedAt ? ` · ${fmtDay(proj.updatedAt)}` : ""}</div>
                </div>
              ))}
              {stageProjects.length === 0 && <div style={{ fontSize: 11, color: "#CBD5E1", fontStyle: "italic", fontFamily: F, padding: "8px 0" }}>{isOver ? "Drop here" : "No projects"}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══ GANTT CHART — per-project milestone/activity timeline (inline SVG) ═══ */
function GanttChart({ project, state }) {
  const pdCats = getProjectDetails(state.docData, project?.id);
  const progData = state.docData?.[project?.id]?._programDetails || {};
  const tasks = progData.tasks || [];
  // v4.1.0: also include checklist startDate, and Project Overview dates (CAD, deploy, etc.)
  const checklistItems = pdCats.filter(c => c.type === "checklist").flatMap(c => (c.milestones||[]).flatMap(ms => (ms.checklist||[]).filter(ck => !ck.na && (ck.projectedDate || ck.actualDate || ck.startDate)).map(ck => ({ id: ck.id, name: ck.label.substring(0, 40), start: ck.startDate || ck.projectedDate || ck.actualDate, end: ck.actualDate || ck.projectedDate || ck.startDate, done: ck.checked, type: "checklist" }))));
  const programTasks = tasks.map(t => ({ id: t.id, name: t.name, start: t.date, end: t.endDate || t.date, done: false, type: t.type }));
  const overview = state.projectOverview?.[project?.id] || {};
  const overviewItems = [
    { key: "cadCompleteDate", label: "CAD Complete (Target)" },
    { key: "cadActualFinishDate", label: "CAD Actual Finish" },
    { key: "actualServiceStartDate", label: "Service Start" },
    { key: "targetBuildDate", label: "Target Build" },
    { key: "actualDeployDate", label: "Actual Deploy" },
  ].filter(o => overview[o.key]).map(o => ({ id: `ov_${o.key}`, name: o.label, start: overview[o.key], end: overview[o.key], done: !!overview[o.key], type: "overview" }));
  const customMilestoneItems = (overview.customMilestones || [])
    .filter(m => m.label && m.date)
    .map(m => ({ id: `cm_${m.id}`, name: m.label.substring(0, 40), start: m.date, end: m.date, done: false, type: "milestone" }));
  const allItems = [...overviewItems, ...programTasks, ...checklistItems, ...customMilestoneItems].filter(i => i.start).sort((a, b) => new Date(a.start) - new Date(b.start));

  if (allItems.length === 0) return null;

  const dates = allItems.flatMap(i => [new Date(i.start), new Date(i.end || i.start)]);
  const minDate = new Date(Math.min(...dates));
  const maxDate = new Date(Math.max(...dates));
  const range = Math.max(1, (maxDate - minDate) / (1000 * 60 * 60 * 24));
  const chartW = 600;
  const barH = 20;
  const rowH = 28;
  const labelW = 200;
  const totalH = allItems.length * rowH + 30;
  const toX = (d) => ((new Date(d) - minDate) / (1000 * 60 * 60 * 24) / range) * chartW;

  return (
    <div style={{ ...S.card, marginTop: 16, overflow: "auto" }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 12 }}>Gantt Chart — Key Activities & Milestones</div>
      <svg width={labelW + chartW + 20} height={totalH} style={{ fontFamily: F, fontSize: 11 }}>
        {/* Header dates */}
        <text x={labelW} y={12} fill="#94A3B8" fontSize={10}>{fmtDay(minDate.toISOString())}</text>
        <text x={labelW + chartW - 60} y={12} fill="#94A3B8" fontSize={10} textAnchor="end">{fmtDay(maxDate.toISOString())}</text>
        <line x1={labelW} y1={18} x2={labelW + chartW} y2={18} stroke="#E2E8F0" />
        {/* Today line */}
        {(() => { const todayX = toX(new Date().toISOString()); return todayX >= 0 && todayX <= chartW ? <line x1={labelW + todayX} y1={18} x2={labelW + todayX} y2={totalH} stroke="#DC2626" strokeWidth={1} strokeDasharray="4,4" /> : null; })()}
        {/* Rows */}
        {allItems.map((item, i) => {
          const y = 24 + i * rowH;
          const x1 = toX(item.start);
          const x2 = toX(item.end || item.start);
          const w = Math.max(4, x2 - x1);
          const color = item.done ? "#059669" : item.type === "milestone" ? "#F59E0B" : "#3B82F6";
          return (
            <g key={item.id}>
              <text x={labelW - 8} y={y + barH / 2 + 4} fill="#475569" fontSize={11} textAnchor="end">{item.name}</text>
              {item.type === "milestone" ? (
                <polygon points={`${labelW + x1},${y + 4} ${labelW + x1 + 8},${y + barH / 2} ${labelW + x1},${y + barH - 4} ${labelW + x1 - 8},${y + barH / 2}`} fill={color} />
              ) : (
                <rect x={labelW + x1} y={y + 4} width={w} height={barH - 8} rx={3} fill={color} opacity={item.done ? 1 : 0.7} />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* v4.1.0 — Gantt toggle wrapper. Hidden by default; click to expand.
   Disabled with tooltip if fewer than 3 dated items. Reuses GanttChart.
   Date count must match exactly what GanttChart renders (overview dates + program tasks + checklist start/projected/actual). */
function GanttChartToggle({ project, state }) {
  const [shown, setShown] = useState(false);
  const dateCount = useMemo(() => {
    const pdCats = getProjectDetails(state.docData, project?.id);
    const progTasks = (state.docData?.[project?.id]?._programDetails?.tasks || []).filter(t => t.date).length;
    const checks = pdCats
      .filter(c => c.type === "checklist")
      .flatMap(c => (c.milestones || []).flatMap(ms => (ms.checklist || []).filter(ck => !ck.na && (ck.projectedDate || ck.actualDate || ck.startDate))))
      .length;
    const overview = state.projectOverview?.[project?.id] || {};
    const overviewDates = ["cadCompleteDate", "cadActualFinishDate", "actualServiceStartDate", "targetBuildDate", "actualDeployDate"]
      .filter(k => overview[k]).length;
    const customMilestoneDates = (overview.customMilestones || []).filter(m => m.label && m.date).length;
    return progTasks + checks + overviewDates + customMilestoneDates;
  }, [state.docData, project?.id]);
  const ready = dateCount >= 3;
  return (
    <div style={{ marginTop: 16 }}>
      <button
        type="button"
        onClick={() => ready && setShown(s => !s)}
        disabled={!ready}
        title={ready ? (shown ? "Hide Gantt chart" : "Show Gantt chart") : "Need at least 3 dates/milestones to display Gantt chart"}
        style={{
          padding: "8px 14px", fontSize: 13, fontWeight: 600,
          border: "1px solid " + (ready ? "#C7D2FE" : "#E2E8F0"), borderRadius: 6,
          background: ready ? (shown ? "#EEF2FF" : "#F8FAFC") : "#F1F5F9",
          color: ready ? "#4338CA" : "#94A3B8",
          cursor: ready ? "pointer" : "not-allowed", fontFamily: F,
        }}
      >
        📊 {shown ? "Hide" : "Show"} Gantt Chart {!ready && `(${dateCount}/3 dates)`}
      </button>
      {shown && ready && <div style={{ marginTop: 12 }}><GanttChart project={project} state={state} /></div>}
    </div>
  );
}

/* ═══ PROJECTS OVERVIEW — summary of ALL projects across pipelines ═══ */
/* Note: distinct from per-project "Overview" dashboard. This aggregates every project. */
function ProjectsOverviewView({ state, setState, user, lang = "en" }) {
  const allProjects = useMemo(() => projectsToArray(state.projects), [state.projects]);
  const activeProjects = useMemo(() => allProjects.filter(p => p.status === "active"), [allProjects]);
  const [selPipeline, setSelPipeline] = useState(PIPELINE_LIST[0]?.id || "");
  const [pipelineViewMode, setPipelineViewMode] = useState("kanban");
  const [demandExpanded, setDemandExpanded] = useState(null); // which hw row is expanded to show per-project
  const canEditDemand = isInst(user); // Any Instrumental user can add custom demand types
  // v4.3.0 — Kanban drag-and-drop stage writeback
  const [dragging, setDragging] = useState(null); // { projId, fromStageId, hubspotId }
  const [stageWriting, setStageWriting] = useState({}); // { [projId]: true } while CF in-flight
  const [stageError, setStageError] = useState(null);

  // ─── Demand Plan: aggregate hardware across all ACTIVE projects ───
  const customTypes = state.demandCustomTypes || {}; // { typeId: { label, counts: { projectId: n } } }
  const hubspotTotals = useMemo(() => HUBSPOT_HW_FIELDS.map(f => ({
    label: f.label,
    source: "HubSpot",
    total: activeProjects.reduce((sum, p) => sum + getEffectiveHwCount(p, f.key, state.docData), 0),
    perProject: activeProjects.map(p => ({ id: p.id, name: p.customer || p.name, count: getEffectiveHwCount(p, f.key, state.docData) })).filter(x => x.count > 0),
  })), [activeProjects, state.docData]);
  const customTotals = useMemo(() => Object.entries(customTypes).map(([id, t]) => ({
    id,
    label: t.label,
    source: "Manual",
    total: Object.entries(t.counts || {}).reduce((sum, [pid, n]) => {
      return activeProjects.some(p => p.id === pid) ? sum + (parseInt(n) || 0) : sum;
    }, 0),
  })), [customTypes, activeProjects]);
  const [newTypeLabel, setNewTypeLabel] = useState("");
  const addCustomType = () => {
    if (!newTypeLabel.trim() || !canEditDemand) return;
    const id = genId();
    setState(prev => ({ ...prev, demandCustomTypes: { ...(prev.demandCustomTypes||{}), [id]: { label: newTypeLabel.trim(), counts: {} } } }));
    setNewTypeLabel("");
  };
  const removeCustomType = (id) => {
    if (!canEditDemand || !confirm("Remove this custom hardware type from the demand plan?")) return;
    setState(prev => { const next = { ...(prev.demandCustomTypes||{}) }; delete next[id]; return { ...prev, demandCustomTypes: next }; });
  };

  // ─── Per-pipeline bar chart: active project count per stage ───
  const pipelineCharts = useMemo(() => PIPELINE_LIST.map(pl => {
    const stagesForPipeline = Object.entries(STAGES)
      .filter(([, s]) => s.pipelineId === pl.id && !s.closed) // active stages only
      .sort((a, b) => a[1].order - b[1].order);
    const data = stagesForPipeline.map(([sid, s]) => ({
      stageId: sid,
      label: s.label,
      count: activeProjects.filter(p => p.hubspotPipelineId === pl.id && p.hubspotStageId === sid).length,
    }));
    const maxCount = Math.max(1, ...data.map(d => d.count));
    return { pipeline: pl, data, maxCount, total: data.reduce((s, d) => s + d.count, 0) };
  }), [activeProjects]);

  // ─── Stage breakdown for selected pipeline (existing feature, active-only) ───
  const pipelineStages = Object.entries(STAGES).filter(([, s]) => s.pipelineId === selPipeline).sort((a, b) => a[1].order - b[1].order);
  const pipelineProjects = activeProjects.filter(p => p.hubspotPipelineId === selPipeline);
  const byStage = {};
  pipelineProjects.forEach(p => { const sid = p.hubspotStageId || "__none__"; (byStage[sid] = byStage[sid] || []).push(p); });
  const activeStages = pipelineStages.filter(([, s]) => !s.closed);

  const renderProjectRow = (proj) => (
    <div key={proj.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid #F8FAFC" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A", fontFamily: F }}>{proj.customer || proj.name}<HubspotLinkIcon project={proj} /></div>
        <div style={{ fontSize: 12, color: "#94A3B8", fontFamily: F }}>{proj.name}{proj.updatedAt ? ` · Updated ${fmtDay(proj.updatedAt)}` : ""}</div>
      </div>
      {proj.isSI && <Chip small color="#EFF6FF" fg="#3B82F6">SI</Chip>}
      {proj.stations > 0 && <span style={{ fontSize: 12, color: "#94A3B8", fontFamily: F }}>{proj.stations} stn</span>}
    </div>
  );

  return (
    <div style={S.page}>
      <h2 style={S.h2}>All Projects Overview (Non-SI)</h2>
      <p style={S.sub}>Summary of all non-SI HubSpot projects. <b>This page shows ACTIVE projects only</b> — closed/cancelled projects are excluded throughout.</p>

      {stageError && (
        <div style={{ background: "#FEE2E2", border: "1px solid #FECACA", borderRadius: 8, padding: "10px 14px", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: F, fontSize: 13, color: "#B91C1C" }}>
          <span>{stageError}</span>
          <button onClick={() => setStageError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#B91C1C", fontWeight: 700, fontSize: 16, lineHeight: 1 }}>✕</button>
        </div>
      )}

      {/* External links — prominent at top */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <a href="https://script.google.com/a/macros/instrumental.com/s/AKfycbxVMKgsK6nacvY2zEl4bF9AsKEtN6BNKvd-EQ8LGtOyWw3w5sLfTMT-hXSz102PjbNaqQ/exec" target="_blank" rel="noopener noreferrer" style={{ ...S.card, flex: "1 1 280px", padding: "16px 20px", borderLeft: "4px solid #00C9A7", textDecoration: "none", cursor: "pointer", transition: "box-shadow .15s" }} onMouseEnter={e => e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,.10)"} onMouseLeave={e => e.currentTarget.style.boxShadow=""}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#00C9A7", fontFamily: F }}>Deployment Timeline</div>
          <div style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginTop: 4 }}>View the interactive deployment timeline for all projects</div>
        </a>
      </div>
      {/* ═══ STAGE BREAKDOWN — list or kanban view ═══ */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ ...S.h3, margin: 0 }}>Projects by Stage (Active Only)</h3>
        <div style={{ display: "flex", gap: 4 }}>
          {["list", "kanban"].map(mode => (
            <button key={mode} onClick={() => setPipelineViewMode(mode)} style={{ padding: "5px 14px", borderRadius: 8, border: `1.5px solid ${pipelineViewMode === mode ? "#00C9A7" : "#E2E8F0"}`, background: pipelineViewMode === mode ? "#ECFDF5" : "#FFF", color: pipelineViewMode === mode ? "#059669" : "#64748B", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: F }}>
              {mode === "list" ? "☰ List" : "⬛ Kanban"}
            </button>
          ))}
        </div>
      </div>
      <p style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginBottom: 14 }}>Active project count per pipeline stage. Select a pipeline to drill in.</p>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {PIPELINE_LIST.map(pl => {
            const ct = activeProjects.filter(p => p.hubspotPipelineId === pl.id).length;
            return (
              <button key={pl.id} onClick={() => setSelPipeline(pl.id)} style={{ padding: "8px 16px", borderRadius: 10, border: `2px solid ${selPipeline === pl.id ? "#00C9A7" : "#E2E8F0"}`, background: selPipeline === pl.id ? "#ECFDF5" : "#FFF", color: selPipeline === pl.id ? "#059669" : "#64748B", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: F }}>
                {pl.short}
                {ct > 0 && <span style={{ marginLeft: 6, background: "#00C9A7", color: "#FFF", borderRadius: 10, padding: "1px 6px", fontSize: 11 }}>{ct}</span>}
              </button>
            );
          })}
        </div>
      </div>
      {pipelineProjects.length === 0 ? (
        <div style={S.empty}>No active projects in this pipeline.</div>
      ) : pipelineViewMode === "kanban" ? (
        (() => {
          const KANBAN_COLORS = ["#00C9A7", "#3B82F6", "#8B5CF6", "#F59E0B", "#10B981", "#EC4899", "#F97316", "#64748B"];
          const instUser = isInst(user);
          return (
            <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 12 }}>
              {activeStages.map(([stageId, stage], idx) => {
                const projs = byStage[stageId] || [];
                const color = KANBAN_COLORS[idx % KANBAN_COLORS.length];
                const isDropTarget = instUser && dragging && dragging.fromStageId !== stageId;
                return (
                  <div
                    key={stageId}
                    onDragOver={instUser ? (e) => e.preventDefault() : undefined}
                    onDrop={instUser ? async (e) => {
                      e.preventDefault();
                      if (!dragging || dragging.fromStageId === stageId) { setDragging(null); return; }
                      const { projId, hubspotId, fromStageId } = dragging;
                      setDragging(null);
                      setState(prev => ({ ...prev, projects: { ...prev.projects, [projId]: { ...(prev.projects[projId] || {}), hubspotStageId: stageId } } }));
                      setStageWriting(w => ({ ...w, [projId]: true }));
                      setStageError(null);
                      try {
                        await httpsCallable(functions, "writeStageToHubspot")({ hubspotId, stageId });
                      } catch(err) {
                        setState(prev => ({ ...prev, projects: { ...prev.projects, [projId]: { ...(prev.projects[projId] || {}), hubspotStageId: fromStageId } } }));
                        setStageError(`Stage update failed: ${err.message}`);
                      }
                      setStageWriting(w => { const n = { ...w }; delete n[projId]; return n; });
                    } : undefined}
                    style={{ minWidth: 200, maxWidth: 240, flex: "0 0 auto", background: "#F8FAFC", borderRadius: 12, border: `2px solid ${isDropTarget ? "#00C9A7" : "#F1F5F9"}`, padding: 12, outline: isDropTarget ? "2px dashed #00C9A7" : "none", transition: "border-color .15s" }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#0F172A", fontFamily: F, lineHeight: 1.3 }}>{stage.label}</div>
                      <Chip small color={`${color}22`} fg={color}>{projs.length}</Chip>
                    </div>
                    {projs.map(proj => (
                      <div
                        key={proj.id}
                        draggable={instUser}
                        onDragStart={instUser ? () => setDragging({ projId: proj.id, fromStageId: stageId, hubspotId: proj.hubspotId }) : undefined}
                        onDragEnd={instUser ? () => setDragging(null) : undefined}
                        style={{ background: stageWriting[proj.id] ? "#F0FDF4" : "#FFF", borderRadius: 8, padding: "8px 10px", marginBottom: 6, border: "1px solid #E2E8F0", fontSize: 12, fontFamily: F, cursor: instUser ? "grab" : "default", opacity: stageWriting[proj.id] ? 0.7 : 1, transition: "opacity .15s" }}
                      >
                        <div style={{ fontWeight: 600, color: "#0F172A", marginBottom: 2 }}>{proj.customer || proj.name}<HubspotLinkIcon project={proj} /></div>
                        {proj.name !== proj.customer && <div style={{ color: "#94A3B8", fontSize: 11, marginBottom: 2 }}>{proj.name}</div>}
                        <div style={{ color: "#94A3B8", fontSize: 11 }}>{proj.stations || 0} stn</div>
                      </div>
                    ))}
                    {projs.length === 0 && <div style={{ fontSize: 11, color: "#CBD5E1", fontStyle: "italic", fontFamily: F, padding: "8px 0" }}>No projects</div>}
                  </div>
                );
              })}
            </div>
          );
        })()
      ) : (
        activeStages.map(([stageId, stage]) => {
          const projs = byStage[stageId] || [];
          return (
            <div key={stageId} style={{ ...S.card, marginBottom: 10, borderLeft: "3px solid #00C9A7" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: projs.length > 0 ? 10 : 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{stage.label}</div>
                <Chip small color="#ECFDF5" fg="#059669">{projs.length} project{projs.length !== 1 ? "s" : ""}</Chip>
              </div>
              {projs.map(renderProjectRow)}
              {projs.length === 0 && <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>No projects in this stage.</div>}
            </div>
          );
        })
      )}

      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999, background: "#ECFDF5", color: "#059669", fontSize: 12, fontWeight: 700, marginBottom: 24, fontFamily: F }}>
        ● ACTIVE PROJECTS ONLY · {activeProjects.length} total
      </div>

      {activeProjects.length === 0 && (
        <div style={S.empty}>No active projects. Sync from Admin Panel → HubSpot Sync, or create one in Manage Projects.</div>
      )}

      {activeProjects.length > 0 && (<>
        {/* ═══ DEMAND PLAN ═══ */}
        <h3 style={{ ...S.h3, marginTop: 8, marginBottom: 6 }}>Demand Plan & Forecast (Active Projects)</h3>
        <p style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginBottom: 14 }}>Aggregated hardware requirements across all {activeProjects.length} active projects. HubSpot values are read-only. Instrumental users can add custom types. Click any row to see the per-project breakdown.</p>
        <div style={{ ...S.card, marginBottom: 24, padding: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: F }}>
            <thead>
              <tr>
                <th style={{ ...S.th, width: "55%" }}>Hardware Type</th>
                <th style={{ ...S.th, textAlign: "center", width: "20%" }}>Source</th>
                <th style={{ ...S.th, textAlign: "right", width: "15%" }}>Total Needed</th>
                <th style={{ ...S.th, width: "10%" }}></th>
              </tr>
            </thead>
            <tbody>
              {hubspotTotals.map(row => (<>
                <tr key={row.label} onClick={() => setDemandExpanded(demandExpanded === row.label ? null : row.label)} style={{ cursor: "pointer" }}>
                  <td style={S.td}>{demandExpanded === row.label ? "▼" : "▶"} {row.label}</td>
                  <td style={{ ...S.td, textAlign: "center" }}><Chip small color="#FFF4F0" fg="#FF7A59">HubSpot</Chip></td>
                  <td style={{ ...S.td, textAlign: "right", fontWeight: 700, color: "#0F172A", fontSize: 16 }}>{row.total}</td>
                  <td style={S.td}></td>
                </tr>
                {demandExpanded === row.label && row.perProject.length > 0 && row.perProject.map(pp => (
                  <tr key={pp.id} style={{ background: "#F8FAFC" }}>
                    <td style={{ ...S.td, paddingLeft: 32, fontSize: 12, color: "#64748B" }}>{pp.name}</td>
                    <td style={{ ...S.td, textAlign: "center", fontSize: 12, color: "#94A3B8" }}>—</td>
                    <td style={{ ...S.td, textAlign: "right", fontSize: 13, fontWeight: 600, color: "#475569" }}>{pp.count}</td>
                    <td style={S.td}></td>
                  </tr>
                ))}
              </>))}
              {customTotals.map(row => (
                <tr key={row.id}>
                  <td style={S.td}>{row.label}</td>
                  <td style={{ ...S.td, textAlign: "center" }}><Chip small color="#EEF2FF" fg="#6366F1">Manual</Chip></td>
                  <td style={{ ...S.td, textAlign: "right", fontWeight: 700, color: "#0F172A", fontSize: 16 }}>{row.total}</td>
                  <td style={{ ...S.td, textAlign: "right" }}>
                    {canEditDemand && <button style={{ ...S.btnDel, padding: "3px 8px", fontSize: 11 }} onClick={() => removeCustomType(row.id)}>✕</button>}
                  </td>
                </tr>
              ))}
              {customTotals.length === 0 && hubspotTotals.every(r => r.total === 0) && (
                <tr><td colSpan={4} style={{ ...S.td, textAlign: "center", color: "#94A3B8", fontStyle: "italic" }}>No hardware data yet. Sync from HubSpot or add custom types below.</td></tr>
              )}
            </tbody>
          </table>
          {canEditDemand && (
            <div style={{ padding: 14, borderTop: "1px solid #F1F5F9", background: "#F8FAFC", display: "flex", gap: 8 }}>
              <input style={{ ...S.inp, flex: 1, marginTop: 0 }} value={newTypeLabel} onChange={e => setNewTypeLabel(e.target.value)} placeholder="Add custom hardware type (e.g. 'GPU Modules')" onKeyDown={e => e.key === "Enter" && addCustomType()} />
              <button style={{ ...S.btnMain, width: "auto", padding: "10px 18px", marginTop: 0 }} onClick={addCustomType} disabled={!newTypeLabel.trim()}>+ Add Type</button>
            </div>
          )}
        </div>

        {/* ═══ PIPELINE BAR CHARTS ═══ */}
        {/* Demand by stage — forecast view */}
        <div style={{ ...S.card, marginBottom: 24, marginTop: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 8 }}>Hardware Forecast by Pipeline Stage</div>
          <p style={{ fontSize: 12, color: "#64748B", fontFamily: F, marginBottom: 10 }}>Station demand breakdown by where projects are in the Hardware Deployment pipeline. Helps forecast upcoming hardware needs.</p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: F, fontSize: 12 }}>
            <thead><tr><th style={{ ...S.th, fontSize: 10 }}>Stage</th><th style={{ ...S.th, fontSize: 10, textAlign: "center" }}>Projects</th><th style={{ ...S.th, fontSize: 10, textAlign: "right" }}>Total Stations</th><th style={{ ...S.th, fontSize: 10, textAlign: "right" }}>Cameras</th><th style={{ ...S.th, fontSize: 10, textAlign: "right" }}>Computers</th></tr></thead>
            <tbody>
              {Object.entries(STAGES).filter(([, s]) => s.pipelineId === "680801112" && !s.closed).sort((a, b) => a[1].order - b[1].order).map(([sid, stage]) => {
                const stageProjs = activeProjects.filter(p => p.hubspotPipelineId === "680801112" && p.hubspotStageId === sid);
                const totalStations = stageProjs.reduce((s, p) => s + (p.stations || 0), 0);
                const totalCameras = stageProjs.reduce((s, p) => s + getEffectiveHwCount(p, "cameras", state.docData), 0);
                const totalComputers = stageProjs.reduce((s, p) => s + getEffectiveHwCount(p, "computers", state.docData), 0);
                if (stageProjs.length === 0) return null;
                return (
                  <tr key={sid}>
                    <td style={{ ...S.td, fontSize: 12 }}>{stage.label}</td>
                    <td style={{ ...S.td, textAlign: "center", fontWeight: 600 }}>{stageProjs.length}</td>
                    <td style={{ ...S.td, textAlign: "right", fontWeight: 600 }}>{totalStations}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>{totalCameras || "—"}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>{totalComputers || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <h3 style={{ ...S.h3, marginBottom: 6 }}>Pipeline Stage Distribution (Active Projects)</h3>
        <p style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginBottom: 14 }}>Active project count per stage, shown per pipeline. Closed/cancelled stages excluded.</p>
        <div style={{ marginBottom: 24 }}>
          {pipelineCharts.map(pc => (
            <div key={pc.pipeline.id} style={{ ...S.card, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: pc.total > 0 ? 14 : 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{pc.pipeline.label}</div>
                <Chip small color={pc.total > 0 ? "#ECFDF5" : "#F1F5F9"} fg={pc.total > 0 ? "#059669" : "#94A3B8"}>{pc.total} active</Chip>
              </div>
              {pc.total > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {pc.data.map(d => (
                    <div key={d.stageId} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 200, fontSize: 12, color: "#475569", fontFamily: F, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={d.label}>{d.label}</div>
                      <div style={{ flex: 1, height: 22, background: "#F1F5F9", borderRadius: 4, position: "relative" }}>
                        <div style={{ height: "100%", width: `${(d.count / pc.maxCount) * 100}%`, background: d.count > 0 ? "#00C9A7" : "transparent", borderRadius: 4, transition: "width .4s ease" }} />
                      </div>
                      <div style={{ width: 36, textAlign: "right", fontSize: 13, fontWeight: 700, color: d.count > 0 ? "#0F172A" : "#CBD5E1", fontFamily: F }}>{d.count}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

      </>)}
    </div>
  );
}

/* ═══ ADMIN VIEW — restricted access management, pending approvals for external users ═══ */
function AdminView({ state, setState, allProjects, pendingUsers, currentUser }) {
  const { users } = state;
  const [tab, setTab] = useState(pendingUsers?.length > 0 ? "pending" : "users");
  const [approveForm, setApproveForm] = useState({});

  // HubSpot sync state
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [syncPreview, setSyncPreview] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [applyLoading, setApplyLoading] = useState(false);
  const [syncLog, setSyncLog] = useState([]); // v4.0.1 — sync history
  // v4.0.2 — Backfill Checklists (decoupled from HubSpot sync)
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState("");
  // v4.1.0 — HubSpot property schema diagnostic
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaResult, setSchemaResult] = useState(null);
  // v4.2.4 — List all HubSpot object types
  const [allSchemasLoading, setAllSchemasLoading] = useState(false);
  const [allSchemasResult, setAllSchemasResult] = useState(null);
  // v4.1.0 — Maintenance tab
  const [maintRun, setMaintRun] = useState(null);
  const [maintAlerts, setMaintAlerts] = useState({});
  const [maintLoading, setMaintLoading] = useState(false);
  const [maintMsg, setMaintMsg] = useState("");

  useEffect(() => {
    const unsubStatus = onValue(ref(db, "hubspotSync/status"), s => setSyncStatus(s.val()), { onlyOnce: false });
    const unsubLog = onValue(ref(db, "hubspotSync/log"), s => {
      const v = s.val() || {};
      const arr = Object.values(v).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
      setSyncLog(arr);
    }, { onlyOnce: false });
    const unsubMaint = onValue(ref(db, "maintenance/lastRun"), s => setMaintRun(s.val()), { onlyOnce: false });
    const unsubAlerts = onValue(ref(db, "maintenance/alerts"), s => setMaintAlerts(s.val() || {}), { onlyOnce: false });
    return () => { unsubStatus(); unsubLog(); unsubMaint(); unsubAlerts(); };
  }, []);

  const runPreview = async () => {
    setSyncLoading(true); setSyncMsg(""); setSyncPreview(null);
    try {
      const fn = httpsCallable(functions, "manualHubspotSync", { timeout: 560000 });
      await fn({ commit: false });
      // Preview data written to hubspotPreview/ — read it once
      const snap = await new Promise(r => onValue(ref(db, "hubspotPreview"), r, { onlyOnce: true }));
      const data = snap.val() || {};
      const projects = Object.values(data.projects || {});
      setSyncPreview(projects);
      setSyncMsg(`Preview complete: ${projects.length} projects found.`);
    } catch(e) { setSyncMsg("Error: " + (e.message || String(e))); }
    setSyncLoading(false);
  };

  const runApply = async () => {
    if (!confirm(`Apply sync? This will update ${syncPreview?.length || 0} projects in the webapp.`)) return;
    setApplyLoading(true); setSyncMsg("");
    try {
      const fn = httpsCallable(functions, "manualHubspotSync", { timeout: 560000 });
      const res = await fn({ commit: true });
      setSyncMsg(`✓ Sync applied: ${res.data?.newCount || 0} new, ${res.data?.updatedCount || 0} updated.`);
      setSyncPreview(null);
    } catch(e) { setSyncMsg("Error: " + (e.message || String(e))); }
    setApplyLoading(false);
  };

  // v4.0.0: all admin ops go through Cloud Function callables (audited, server-validated).

  const approve = async (pu) => {
    const f = approveForm[pu.id] || {};
    const selProj = Object.entries(f.projects || {}).filter(([,v]) => v).map(([k]) => k);
    if (selProj.length === 0) return;
    try { await callAdminApprove(pu.id, selProj); }
    catch(e) { console.error(e); alert("Approve failed: " + (e.message || String(e))); }
  };
  const deny = async (pu) => {
    try { await callAdminDeny(pu.id); }
    catch(e) { console.error(e); alert("Deny failed: " + (e.message || String(e))); }
  };
  const removeUser = async (uid) => {
    try {
      await callAdminDelete(uid);
      setState(prev => ({ ...prev, users: (prev.users||[]).filter(u => u.id !== uid) }));
    } catch(e) { console.error(e); alert("Delete failed: " + (e.message || String(e))); }
  };
  const promoteAdmin = async (uid) => {
    if (!currentUser?.superAdmin) { alert("Only the super admin can promote users to admin."); return; }
    const target = (users||[]).find(u => u.id === uid);
    if (!target) return;
    if (!confirm(`Make ${target.name} an admin? They'll have full edit access.`)) return;
    try {
      await callAdminSetRole(uid, "admin");
      setState(prev => ({ ...prev, users: (prev.users||[]).map(u => u.id !== uid ? u : { ...u, role: "admin", partyId: "instrumental" }) }));
    } catch(e) { console.error(e); alert("Promote failed: " + (e.message || String(e))); }
  };
  const addProject = async (uid, pid) => {
    const u = (users||[]).find(u => u.id === uid); if (!u || (u.projects||[]).includes(pid)) return;
    const np = [...(u.projects||[]), pid];
    setState(prev => ({ ...prev, users: (prev.users||[]).map(usr => usr.id !== uid ? usr : { ...usr, projects: np }) }));
    try { await callAdminSetProjectAccess(uid, pid, true); }
    catch(e) { console.error(e); alert("Grant failed: " + (e.message || String(e))); }
  };
  const removeProject = async (uid, pid) => {
    const u = (users||[]).find(u => u.id === uid);
    const np = ((u?.projects)||[]).filter(p => p !== pid);
    setState(prev => ({ ...prev, users: (prev.users||[]).map(usr => usr.id !== uid ? usr : { ...usr, projects: np }) }));
    try { await callAdminSetProjectAccess(uid, pid, false); }
    catch(e) { console.error(e); alert("Revoke failed: " + (e.message || String(e))); }
  };

  // Restricted access management
  const [restrictTab, setRestrictTab] = useState(null);
  const getRestricted = (projId, catId) => state.docData?.[projId]?._restrictedAccess?.[catId] || [];
  const toggleRestricted = (projId, catId, userId) => {
    const current = getRestricted(projId, catId);
    const next = current.includes(userId) ? current.filter(u => u !== userId) : [...current, userId];
    setState(prev => ({ ...prev, docData: { ...prev.docData, [projId]: { ...(prev.docData?.[projId]||{}), _restrictedAccess: { ...(prev.docData?.[projId]?._restrictedAccess||{}), [catId]: next } } } }));
  };

  const pending = pendingUsers || [];
  const instUsers = (users||[]).filter(u => (u.email||"").endsWith("@instrumental.com") && u.role !== "admin");
  const externals = (users||[]).filter(u => !(u.email||"").endsWith("@instrumental.com") && u.role !== "admin");
  const admins = (users||[]).filter(u => u.role === "admin");

  return (
    <div style={S.page}>
      <h2 style={S.h2}>Admin Panel</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
        {[{ id: "pending", label: `Pending${pending.length > 0 ? ` (${pending.length})` : ""}` }, { id: "users", label: "User Access" }, { id: "commercial_access", label: "🔒 Commercial Access" }, { id: "hubspot", label: "🔄 HubSpot Sync" }, { id: "maintenance", label: "🔧 Maintenance" }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ ...S.tabBtn, ...(tab === t.id ? { background: "#00C9A7", color: "#FFF", borderColor: "#00C9A7" } : {}), ...(t.id === "pending" && pending.length > 0 ? { borderColor: "#F59E0B" } : {}) }}>{t.label}</button>
        ))}
      </div>

      {/* PENDING TAB */}
      {tab === "pending" && (
        pending.length === 0 ? <div style={S.empty}>No pending requests. Instrumental users are auto-approved.</div> :
        pending.map(pu => {
          const f = approveForm[pu.id] || {};
          return (
            <div key={pu.id} style={{ ...S.card, marginBottom: 12, borderLeft: "3px solid #F59E0B" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                {pu.photoURL ? <img src={pu.photoURL} style={{ width: 38, height: 38, borderRadius: 10 }} alt="" referrerPolicy="no-referrer" /> : <div style={{ ...S.ava, background: "#F59E0B" }}>{(pu.name||"?")[0]}</div>}
                <div><div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{pu.name}</div><div style={{ fontSize: 13, color: "#64748B" }}>{pu.email}</div></div>
              </div>
              <div style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginBottom: 8 }}>This user will be added as an <strong>external user</strong>. Select which projects they should have access to.</div>
              <label style={S.lbl}>Assign Projects (active only)</label>
              {allProjects.filter(p => p.status === "active").map(proj => {
                const ck = f.projects?.[proj.id] || false;
                return (
                  <div key={proj.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "4px 0" }} onClick={() => setApproveForm(prev => ({ ...prev, [pu.id]: { ...prev[pu.id], projects: { ...(prev[pu.id]?.projects||{}), [proj.id]: !ck } } }))}>
                    <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${ck ? "#00C9A7" : "#CBD5E1"}`, background: ck ? "#00C9A7" : "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#FFF", fontWeight: 800 }}>{ck ? "✓" : ""}</div>
                    <span style={{ fontSize: 14, fontFamily: F }}>{proj.name}</span>
                  </div>
                );
              })}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button style={{ ...S.btnMain, width: "auto", padding: "10px 20px", marginTop: 0, opacity: Object.values(f.projects||{}).some(v=>v) ? 1 : .4 }} onClick={() => approve(pu)} disabled={!Object.values(f.projects||{}).some(v=>v)}>✓ Approve</button>
                <button style={{ ...S.btnDel, padding: "10px 16px" }} onClick={() => deny(pu)}>Deny</button>
              </div>
            </div>
          );
        })
      )}

      {/* USER ACCESS TAB */}
      {tab === "users" && (
        <div>
          <h3 style={{ ...S.h3, marginBottom: 10 }}>Admins</h3>
          {admins.map(u => (
            <div key={u.id} style={{ ...S.card, display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              {u.photoURL ? <img src={u.photoURL} style={{ width: 32, height: 32, borderRadius: 8 }} alt="" referrerPolicy="no-referrer" /> : <div style={{ ...S.ava, background: "#00C9A7", width: 32, height: 32 }}>{(u.name||"?")[0]}</div>}
              <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A", fontFamily: F }}>{u.name}</div><div style={{ fontSize: 12, color: "#64748B" }}>{u.email}</div></div>
              <Chip color="#ECFDF5" fg="#059669" small>Admin</Chip>
            </div>
          ))}

          <h3 style={{ ...S.h3, marginTop: 24, marginBottom: 10 }}>Instrumental Users</h3>
          {instUsers.length === 0 ? <div style={{ ...S.empty, marginBottom: 16 }}>No non-admin Instrumental users yet.</div> : instUsers.map(u => (
            <div key={u.id} style={{ ...S.card, display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              {u.photoURL ? <img src={u.photoURL} style={{ width: 32, height: 32, borderRadius: 8 }} alt="" referrerPolicy="no-referrer" /> : <div style={{ ...S.ava, background: "#00C9A7", width: 32, height: 32 }}>{(u.name||"?")[0]}</div>}
              <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A", fontFamily: F }}>{u.name}</div><div style={{ fontSize: 12, color: "#64748B" }}>{u.email}</div></div>
              <Chip small color="#ECFDF5" fg="#059669">Instrumental</Chip>
              <button style={{ ...S.btnEdit, fontSize: 11 }} onClick={() => promoteAdmin(u.id)}>⬆ Admin</button>
              <button style={{ ...S.btnDel, fontSize: 11 }} onClick={() => removeUser(u.id)}>Remove</button>
            </div>
          ))}

          <h3 style={{ ...S.h3, marginTop: 24, marginBottom: 10 }}>External Users</h3>
          {externals.length === 0 ? <div style={S.empty}>No external users yet.</div> : externals.map(u => {
            return (
              <div key={u.id} style={{ ...S.card, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                  {u.photoURL ? <img src={u.photoURL} style={{ width: 32, height: 32, borderRadius: 8 }} alt="" referrerPolicy="no-referrer" /> : <div style={{ ...S.ava, background: "#94A3B8", width: 32, height: 32 }}>{(u.name||"?")[0]}</div>}
                  <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A", fontFamily: F }}>{u.name}</div><div style={{ fontSize: 12, color: "#64748B" }}>{u.email}</div></div>
                  <Chip small color="#F1F5F9" fg="#64748B">External</Chip>
                  <button style={{ ...S.btnDel, fontSize: 11 }} onClick={() => removeUser(u.id)}>Remove</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "#94A3B8", fontWeight: 700 }}>Projects:</span>
                  {(u.projects||[]).map(pid => { const proj = allProjects.find(p => p.id === pid); return proj ? <span key={pid} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 6, background: "#F1F5F9", fontSize: 12, fontFamily: F }}>{proj.name}<span style={{ cursor: "pointer", color: "#DC2626", fontWeight: 700 }} onClick={() => removeProject(u.id, pid)}>✕</span></span> : null; })}
                  <select style={{ ...S.inp, width: 140, padding: "3px 6px", fontSize: 11 }} value="" onChange={e => e.target.value && addProject(u.id, e.target.value)}>
                    <option value="">+ Add</option>
                    {allProjects.filter(p => p.status === "active" && !(u.projects||[]).includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* HUBSPOT SYNC TAB */}
      {tab === "hubspot" && (
        <div>
          <div style={{ ...S.card, marginBottom: 16, borderLeft: "3px solid #FF7A59" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 8 }}>HubSpot Sync</div>
            <p style={{ fontSize: 14, color: "#64748B", fontFamily: F, marginBottom: 12 }}>
              Syncs all projects from all 7 HubSpot pipelines (Hardware Deployment, Data Source, MES Integration, Station Return, Image Source, Data Analytics, SI Partner Deployment). Preview first, then confirm to apply changes to the webapp.
              Auto-sync runs every Tuesday and Friday at 9am PDT.
            </p>
            {syncStatus && (
              <div style={{ fontSize: 13, color: "#94A3B8", fontFamily: F, marginBottom: 12 }}>
                Last sync: {syncStatus.syncedAt ? new Date(syncStatus.syncedAt).toLocaleString() : "Never"} ·{" "}
                {syncStatus.total != null ? `${syncStatus.total} projects` : ""}{" "}
                {syncStatus.error ? <span style={{ color: "#DC2626" }}>Error: {syncStatus.error}</span> : ""}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button style={{ ...S.btnMain, width: "auto", padding: "10px 20px", marginTop: 0, opacity: syncLoading ? .5 : 1, background: "#FF7A59" }} onClick={runPreview} disabled={syncLoading}>
                {syncLoading ? "Running preview…" : "▶ Run Preview Sync"}
              </button>
              {syncPreview && (
                <button style={{ ...S.btnMain, width: "auto", padding: "10px 20px", marginTop: 0, opacity: applyLoading ? .5 : 1 }} onClick={runApply} disabled={applyLoading}>
                  {applyLoading ? "Applying…" : "✓ Confirm & Apply"}
                </button>
              )}
            </div>
            {syncMsg && <p style={{ fontSize: 14, color: syncMsg.startsWith("Error") ? "#DC2626" : "#059669", marginTop: 12, fontFamily: F }}>{syncMsg}</p>}
          </div>

          {/* v4.0.2 — Backfill Checklists — independent of HubSpot sync */}
          <div style={{ ...S.card, marginBottom: 16, borderLeft: "3px solid #00C9A7" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 8 }}>📋 Backfill Project Checklists</div>
            <p style={{ fontSize: 14, color: "#64748B", fontFamily: F, marginBottom: 12 }}>
              Apply Internal + External (or SI) checklist templates from <code>functions/checklists.js</code> to every project that's missing them.
              Preserves any folders or checklists already present. <b>No HubSpot involved</b> — uses each project's already-stored pipeline ID to pick the right template.
            </p>
            <button
              style={{ ...S.btnMain, width: "auto", padding: "10px 20px", marginTop: 0, opacity: backfillLoading ? .5 : 1, background: "#00C9A7" }}
              disabled={backfillLoading}
              onClick={async () => {
                if (!confirm("Apply checklist templates to all projects missing them? Existing folders/checklists will be preserved. May take a couple of minutes.")) return;
                setBackfillLoading(true); setBackfillMsg("Working… this can take 1–3 minutes for ~750 projects.");
                try {
                  // v4.0.2 — bump client timeout from default 60s to 9 minutes; backend cap is 5 min.
                  const fn = httpsCallable(functions, "backfillChecklists", { timeout: 540000 });
                  const res = await fn({});
                  const s = res.data || {};
                  setBackfillMsg(`✓ Backfill complete: ${s.builtFresh || 0} built fresh, ${s.appendedChecklist || 0} had checklists appended, ${s.alreadyComplete || 0} already complete, ${s.addedCommercial || 0} commercial folders added (${s.total || 0} total projects).`);
                } catch(e) { setBackfillMsg("Error: " + (e.message || String(e))); }
                setBackfillLoading(false);
              }}
            >
              {backfillLoading ? "Backfilling…" : "Backfill Checklists Now"}
            </button>
            {backfillMsg && <p style={{ fontSize: 13, color: backfillMsg.startsWith("Error") ? "#DC2626" : "#059669", marginTop: 12, fontFamily: F }}>{backfillMsg}</p>}
          </div>

          {/* v4.1.0 — HubSpot Property Schema Diagnostic */}
          <div style={{ ...S.card, marginBottom: 16, borderLeft: "3px solid #6366F1" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 6 }}>🔍 HubSpot Property Schema</div>
            <p style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginBottom: 12 }}>
              Fetches all property names and types for the custom Projects object. Use this to verify the internal names for date writeback (e.g. <code>cad_complete_date__c</code>).
            </p>
            <button
              style={{ ...S.btnMain, width: "auto", padding: "8px 16px", marginTop: 0, opacity: schemaLoading ? .5 : 1, background: "#6366F1", fontSize: 13 }}
              disabled={schemaLoading}
              onClick={async () => {
                setSchemaLoading(true); setSchemaResult(null);
                try {
                  const fn = httpsCallable(functions, "getHubspotCustomObjectSchema");
                  const res = await fn({});
                  setSchemaResult(res.data);
                } catch(e) { setSchemaResult({ error: e.message || String(e) }); }
                setSchemaLoading(false);
              }}
            >
              {schemaLoading ? "Fetching…" : "Fetch Schema"}
            </button>
            {schemaResult?.error && <p style={{ fontSize: 13, color: "#DC2626", marginTop: 10, fontFamily: F }}>Error: {schemaResult.error}</p>}
            {schemaResult?.properties && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: "#64748B", fontFamily: F, marginBottom: 6 }}>{schemaResult.totalProperties} properties total. Showing all:</div>
                <div style={{ maxHeight: 300, overflowY: "auto", fontSize: 12, fontFamily: "monospace", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: 10 }}>
                  {schemaResult.properties.map(p => (
                    <div key={p.name} style={{ display: "flex", gap: 12, padding: "2px 0", borderBottom: "1px solid #F1F5F9" }}>
                      <span style={{ color: "#6366F1", minWidth: 280 }}>{p.name}</span>
                      <span style={{ color: "#64748B" }}>{p.type}/{p.fieldType}</span>
                      <span style={{ color: "#94A3B8" }}>{p.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* v4.2.4 — List all HubSpot object types */}
          <div style={{ ...S.card, marginBottom: 16, borderLeft: "3px solid #0EA5E9" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 6 }}>🗂️ All HubSpot Object Types</div>
            <p style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginBottom: 12 }}>
              Lists every custom object schema in this portal — useful for discovering object type IDs and property names (e.g. Shipments, Inventory) before wiring up new sync features.
            </p>
            <button
              style={{ ...S.btnMain, width: "auto", padding: "8px 16px", marginTop: 0, opacity: allSchemasLoading ? .5 : 1, background: "#0EA5E9", fontSize: 13 }}
              disabled={allSchemasLoading}
              onClick={async () => {
                setAllSchemasLoading(true); setAllSchemasResult(null);
                try {
                  const fn = httpsCallable(functions, "listHubspotSchemas");
                  const res = await fn({});
                  setAllSchemasResult(res.data);
                } catch(e) { setAllSchemasResult({ error: e.message || String(e) }); }
                setAllSchemasLoading(false);
              }}
            >
              {allSchemasLoading ? "Fetching…" : "List All Object Types"}
            </button>
            {allSchemasResult?.error && <p style={{ fontSize: 13, color: "#DC2626", marginTop: 10, fontFamily: F }}>Error: {allSchemasResult.error}</p>}
            {Array.isArray(allSchemasResult) && (
              <div style={{ marginTop: 12, maxHeight: 400, overflowY: "auto", fontSize: 12, fontFamily: "monospace", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: 10 }}>
                {allSchemasResult.map(s => (
                  <div key={s.objectTypeId} style={{ marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #E2E8F0" }}>
                    <div style={{ fontWeight: 700, color: "#0F172A", marginBottom: 2 }}>
                      {s.label} <span style={{ color: "#0EA5E9" }}>({s.name})</span> — <span style={{ color: "#64748B" }}>type: {s.objectTypeId}</span>
                    </div>
                    <div style={{ color: "#475569", paddingLeft: 8 }}>
                      {s.properties.map(p => (
                        <div key={p.name} style={{ display: "flex", gap: 12, padding: "1px 0" }}>
                          <span style={{ color: "#6366F1", minWidth: 240 }}>{p.name}</span>
                          <span style={{ color: "#64748B", minWidth: 80 }}>{p.type}</span>
                          <span style={{ color: "#94A3B8" }}>{p.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {syncPreview && (
            <div style={S.card}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 12 }}>Preview — {syncPreview.length} projects</div>
              {syncPreview.slice(0, 50).map(p => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid #F1F5F9" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A", fontFamily: F }}>{p.customer || p.name}</div>
                    <div style={{ fontSize: 12, color: "#94A3B8", fontFamily: F }}>{p.name}</div>
                  </div>
                  <Chip small color={p.status === "inactive" ? "#FEF3C7" : "#ECFDF5"} fg={p.status === "inactive" ? "#D97706" : "#059669"}>{p.status}</Chip>
                  {p.isSI && <Chip small color="#EFF6FF" fg="#3B82F6">SI</Chip>}
                  <span style={{ fontSize: 12, color: "#94A3B8", fontFamily: F }}>{PIPELINES[p.hubspotPipelineId]?.short || p.hubspotPipelineId}</span>
                </div>
              ))}
              {syncPreview.length > 50 && <p style={{ fontSize: 13, color: "#94A3B8", marginTop: 8, fontFamily: F }}>…and {syncPreview.length - 50} more</p>}
            </div>
          )}

          {/* v4.0.1 — Sync History */}
          <div style={{ ...S.card, marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F }}>Sync History</div>
              <span style={{ fontSize: 12, color: "#94A3B8", fontFamily: F }}>{syncLog.length} entries</span>
            </div>
            <p style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginBottom: 12 }}>Every sync (manual or scheduled) logs an entry below. Newest first.</p>
            {syncLog.length === 0 ? (
              <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>No syncs recorded yet. Run a sync above to populate.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: F }}>
                <thead>
                  <tr>
                    <th style={{ ...S.th, fontSize: 11 }}>When</th>
                    <th style={{ ...S.th, fontSize: 11 }}>Type</th>
                    <th style={{ ...S.th, fontSize: 11 }}>Mode</th>
                    <th style={{ ...S.th, fontSize: 11 }}>Result</th>
                    <th style={{ ...S.th, fontSize: 11, textAlign: "right" }}>Total</th>
                    <th style={{ ...S.th, fontSize: 11, textAlign: "right" }}>New</th>
                    <th style={{ ...S.th, fontSize: 11, textAlign: "right" }}>Updated</th>
                    <th style={{ ...S.th, fontSize: 11, textAlign: "right" }}>Duration</th>
                    <th style={{ ...S.th, fontSize: 11 }}>Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {syncLog.slice(0, 50).map((e, i) => {
                    const stateColor = e.state === "success" ? { bg: "#ECFDF5", fg: "#059669" } : e.state === "error" ? { bg: "#FEE2E2", fg: "#B91C1C" } : { bg: "#FEF3C7", fg: "#D97706" };
                    const typeBadge = e.type === "manual" ? { bg: "#EFF6FF", fg: "#3B82F6", label: "Manual" } : { bg: "#F3E8FF", fg: "#9333EA", label: "Scheduled" };
                    return (
                      <tr key={i} style={{ borderBottom: "1px solid #F1F5F9" }}>
                        <td style={{ ...S.td, fontSize: 12 }}>{e.startedAt ? new Date(e.startedAt).toLocaleString() : "—"}</td>
                        <td style={S.td}><Chip small color={typeBadge.bg} fg={typeBadge.fg}>{typeBadge.label}</Chip></td>
                        <td style={{ ...S.td, fontSize: 12, color: "#64748B" }}>{e.mode || "—"}</td>
                        <td style={S.td}><Chip small color={stateColor.bg} fg={stateColor.fg}>{e.state}</Chip></td>
                        <td style={{ ...S.td, fontSize: 12, textAlign: "right" }}>{e.total ?? "—"}</td>
                        <td style={{ ...S.td, fontSize: 12, textAlign: "right", color: "#059669" }}>{e.newCount ?? "—"}</td>
                        <td style={{ ...S.td, fontSize: 12, textAlign: "right", color: "#3B82F6" }}>{e.updatedCount ?? "—"}</td>
                        <td style={{ ...S.td, fontSize: 12, textAlign: "right", color: "#94A3B8" }}>{e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                        <td style={{ ...S.td, fontSize: 12, color: "#64748B" }}>{e.actorEmail || e.actorUid || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {/* v4.0.2 — only show errors from the last 24 hours (stale errors disappear automatically). */}
            {(() => {
              const cutoff = Date.now() - 24 * 60 * 60 * 1000;
              const recent = syncLog.filter(e => e.error && new Date(e.startedAt).getTime() > cutoff).slice(0, 3);
              if (recent.length === 0) return null;
              return (
                <div style={{ marginTop: 10, padding: 10, background: "#FEF2F2", borderLeft: "3px solid #DC2626", borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: "#B91C1C", fontFamily: F, fontWeight: 600, marginBottom: 4 }}>Recent errors (last 24h)</div>
                  {recent.map((e, i) => (
                    <div key={i} style={{ fontSize: 12, color: "#7F1D1D", fontFamily: F, marginBottom: 4 }}>
                      {new Date(e.startedAt).toLocaleString()} — {e.error}
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* MAINTENANCE TAB */}
      {tab === "maintenance" && (
        <div>
          {/* Active alerts */}
          {Object.keys(maintAlerts).length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#DC2626", fontFamily: F, marginBottom: 8 }}>⚠ Active Alerts</div>
              {Object.entries(maintAlerts).map(([key, alert]) => (
                <div key={key} style={{ ...S.card, marginBottom: 8, borderLeft: `3px solid ${alert.severity === "critical" ? "#DC2626" : "#F59E0B"}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: alert.severity === "critical" ? "#DC2626" : "#D97706", fontFamily: F, textTransform: "uppercase" }}>{alert.severity}</span>
                    <span style={{ fontSize: 11, color: "#94A3B8", fontFamily: F }}>{alert.rule}</span>
                  </div>
                  <div style={{ fontSize: 14, color: "#0F172A", fontFamily: F }}>{alert.message}</div>
                  {alert.firedAt && <div style={{ fontSize: 11, color: "#94A3B8", fontFamily: F, marginTop: 4 }}>Fired {new Date(alert.firedAt).toLocaleString()}</div>}
                </div>
              ))}
            </div>
          )}
          {Object.keys(maintAlerts).length === 0 && maintRun && (
            <div style={{ ...S.card, marginBottom: 16, borderLeft: "3px solid #00C9A7" }}>
              <div style={{ fontSize: 14, color: "#059669", fontFamily: F }}>✓ No active alerts</div>
            </div>
          )}

          {/* Last run summary */}
          <div style={{ ...S.card, marginBottom: 16, borderLeft: "3px solid #6366F1" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 8 }}>Last Maintenance Run</div>
            {maintRun ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8, marginBottom: 12 }}>
                  {[
                    { label: "Ran at", value: new Date(maintRun.ranAt).toLocaleString() },
                    { label: "Duration", value: `${maintRun.durationMs}ms` },
                    { label: "Tasks completed", value: `${maintRun.tasksCompleted}/${maintRun.totalTasks}` },
                    { label: "Alerts fired", value: maintRun.alerts },
                  ].map(f => (
                    <div key={f.label} style={{ padding: "8px 10px", background: "#F8FAFC", borderRadius: 6 }}>
                      <div style={{ fontSize: 11, color: "#94A3B8", fontFamily: F, textTransform: "uppercase", letterSpacing: .4, marginBottom: 2 }}>{f.label}</div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A", fontFamily: F }}>{f.value}</div>
                    </div>
                  ))}
                </div>
                {maintRun.tasks && (
                  <div style={{ fontSize: 12, fontFamily: "monospace", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, padding: "8px 10px", maxHeight: 200, overflowY: "auto" }}>
                    {maintRun.tasks.map((t, i) => (
                      <div key={i} style={{ color: t.error ? "#DC2626" : "#059669", padding: "1px 0" }}>
                        {t.error ? "✗" : "✓"} {t.name}{t.deleted != null ? ` — ${t.deleted} deleted` : ""}{t.openBugs != null ? ` — ${t.openBugs} open bugs` : ""}{t.rate != null ? ` — ${t.rate}% error rate` : ""}{t.error ? `: ${t.error}` : ""}{t.skipped ? ` (${t.skipped})` : ""}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 14, color: "#94A3B8", fontFamily: F }}>No maintenance run recorded yet. Schedule: Tue & Fri 3 PM PT.</div>
            )}
          </div>

          {/* Manual trigger */}
          <div style={{ ...S.card, borderLeft: "3px solid #F59E0B" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 6 }}>Run Maintenance Now</div>
            <p style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginBottom: 12 }}>
              Manually triggers the same routine as the scheduled run: sweeps old logs, evaluates Rules 1–3, writes results to <code>maintenance/lastRun</code>.
            </p>
            <button
              style={{ ...S.btnMain, width: "auto", padding: "10px 20px", marginTop: 0, opacity: maintLoading ? .5 : 1, background: "#F59E0B" }}
              disabled={maintLoading}
              onClick={async () => {
                setMaintLoading(true); setMaintMsg("");
                try {
                  const fn = httpsCallable(functions, "runMaintenanceNow");
                  const res = await fn({});
                  const r = res.data || {};
                  setMaintMsg(`✓ Complete: ${r.tasksCompleted}/${r.totalTasks} tasks, ${r.alerts} alert(s), ${r.durationMs}ms`);
                } catch (e) { setMaintMsg("Error: " + (e.message || String(e))); }
                setMaintLoading(false);
              }}
            >
              {maintLoading ? "Running…" : "Run Maintenance Now"}
            </button>
            {maintMsg && <p style={{ fontSize: 13, color: maintMsg.startsWith("Error") ? "#DC2626" : "#059669", marginTop: 10, fontFamily: F }}>{maintMsg}</p>}
          </div>
        </div>
      )}

      {/* COMMERCIAL ACCESS TAB */}
      {tab === "commercial_access" && (
        <div>
          <p style={{ fontSize: 14, color: "#64748B", fontFamily: F, marginBottom: 16 }}>Grant users access to the <strong>Commercial</strong> tab (Agreements, Pricing, Legal) per project. Admins always have access. Both external users AND non-admin Instrumental users need explicit grants.</p>
          {allProjects.filter(p => p.status === "active").map(proj => {
            const eligibleUsers = [...instUsers, ...externals];
            const commAccess = state.commercialAccess?.[proj.id] || {};
            const toggleComm = async (uid) => {
              const has = !!commAccess[uid];
              // Optimistic UI
              if (has) {
                setState(prev => {
                  const next = { ...(prev.commercialAccess||{}) };
                  if (next[proj.id]) { const p = { ...next[proj.id] }; delete p[uid]; next[proj.id] = p; }
                  return { ...prev, commercialAccess: next };
                });
              } else {
                setState(prev => ({ ...prev, commercialAccess: { ...(prev.commercialAccess||{}), [proj.id]: { ...(prev.commercialAccess?.[proj.id]||{}), [uid]: true } } }));
              }
              try { await callAdminSetCommercialAccess(uid, proj.id, !has); }
              catch(e) { console.error(e); alert("Commercial access update failed: " + (e.message || String(e))); }
            };
            return (
              <div key={proj.id} style={{ ...S.card, marginBottom: 12 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 10 }}>{proj.name}<HubspotLinkIcon project={proj} /></div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {eligibleUsers.map(u => {
                    const has = commAccess[u.id];
                    return (
                      <button key={u.id} onClick={() => toggleComm(u.id)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${has ? "#00C9A7" : "#E2E8F0"}`, background: has ? "#ECFDF5" : "#FFF", color: has ? "#059669" : "#94A3B8", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: F }}>{u.name}{has ? " ✓" : ""}</button>
                    );
                  })}
                  {eligibleUsers.length === 0 && <span style={{ fontSize: 12, color: "#94A3B8", fontFamily: F }}>No users to grant access to.</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ═══ MANAGE PROJECTS — with station count input ═══ */
/* ═══ MANAGE PROJECTS — v3.3.0: active/inactive/past separation, SI toggle, last-updated ═══ */
function ManageProjects({ state, setState }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", customer: "", stations: "", isSI: false });
  const [editingId, setEditingId] = useState(null);
  const [mgTab, setMgTab] = useState("active");

  const addProj = () => {
    if (!form.name.trim() || !form.customer.trim()) return;
    const proj = { id: genId(), name: form.name.trim(), customer: form.customer.trim(), stations: parseInt(form.stations) || 0, isSI: form.isSI, status: "active", updatedAt: new Date().toISOString() };
    setState(prev => ({ ...prev, projects: [...(prev.projects||[]), proj] }));
    setForm({ name: "", customer: "", stations: "", isSI: false }); setShowForm(false);
  };
  const toggleStatus = (pid) => setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id !== pid ? p : { ...p, status: p.status === "deprecated" ? "active" : "deprecated", updatedAt: new Date().toISOString() }) }));
  const toggleSI = (pid) => setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id !== pid ? p : { ...p, isSI: !p.isSI, updatedAt: new Date().toISOString() }) }));
  const updateStations = (pid, val) => setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id !== pid ? p : { ...p, stations: parseInt(val)||0, updatedAt: new Date().toISOString() }) }));
  const updateDocLink = (pid, link) => setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id !== pid ? p : { ...p, docLink: link, updatedAt: new Date().toISOString() }) }));

  const allProjects = state.projects || [];
  const active = allProjects.filter(p => p.status === "active");
  const inactive = allProjects.filter(p => p.status === "inactive");
  const past = allProjects.filter(p => p.status === "deprecated");

  const renderCard = (proj) => {
    const ed = editingId === proj.id;
    const isPast = proj.status === "deprecated";
    const isInactive = proj.status === "inactive";
    return (
      <div key={proj.id} style={{ ...S.card, marginBottom: 10, opacity: isPast || isInactive ? .7 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: ed ? 14 : 0 }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 17, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{proj.customer || proj.name}</span>
              {proj.isSI && <Chip small color="#EFF6FF" fg="#3B82F6">SI</Chip>}
            </div>
            <div style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginTop: 2 }}>
              {proj.name} · {proj.stations || 0} stations
              {proj.updatedAt && <span> · Updated {fmtDay(proj.updatedAt)}</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <Chip color={isPast ? "#FEF3C7" : isInactive ? "#F1F5F9" : "#ECFDF5"} fg={isPast ? "#D97706" : isInactive ? "#94A3B8" : "#059669"}>{isPast ? "Past" : isInactive ? "Inactive" : "Active"}</Chip>
            {!isInactive && <button style={S.btnEdit} onClick={() => toggleStatus(proj.id)}>{isPast ? "↑ Reactivate" : "↓ Archive"}</button>}
            {!isPast && !isInactive && <button style={S.btnEdit} onClick={() => setEditingId(ed ? null : proj.id)}>{ed ? "✓ Done" : "✎ Edit"}</button>}
            {!isPast && !isInactive && (
              <button style={{ ...S.btnEdit, borderColor: proj.isSI ? "#3B82F6" : "#E2E8F0", color: proj.isSI ? "#3B82F6" : "#94A3B8" }} onClick={() => toggleSI(proj.id)}>
                {proj.isSI ? "✓ SI" : "☐ SI"}
              </button>
            )}
            {!isPast && !isInactive && <button style={{ ...S.btnEdit, borderColor: "#00C9A7", color: "#00C9A7" }} onClick={async () => {
              // v4.0.2 — use SI Partner pipeline membership (not loose isSI flag).
              // [SI]-tagged Hardware Deployment projects should get the regular Internal+External checklist.
              const useSiChecklist = proj.hubspotPipelineId === SI_PARTNER_PIPELINE_ID;
              if (!confirm(`Apply checklist template to "${proj.name}"?${useSiChecklist ? " (SI Deployment Checklist)" : " (Internal + External Checklist)"}`)) return;
              try {
                const fn = httpsCallable(functions, "applyChecklistTemplate");
                await fn({ projectId: proj.id, isSI: useSiChecklist });
                alert("Checklist template applied.");
              } catch(e) { alert("Error: " + (e.message || String(e))); }
            }}>☑ Apply Checklist</button>}
          </div>
        </div>
        {isPast && proj.docLink && <div style={{ marginTop: 6 }}><span style={{ fontSize: 12, color: "#64748B" }}>📁 </span><a href={proj.docLink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "#0284C7", fontFamily: F }}>{proj.docLink}</a></div>}
        {isPast && !proj.docLink && <button style={{ ...S.btnEdit, marginTop: 6, fontSize: 11 }} onClick={() => { const l = prompt("Doc link (https://...):", proj.docLink || ""); if (l === null) return; const clean = commitUrl(l); if (clean === null) return; updateDocLink(proj.id, clean); }}>+ Add doc link</button>}
        {ed && (
          <div style={{ padding: 14, background: "#F8FAFC", borderRadius: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div><label style={{ ...S.lbl, marginTop: 0 }}>Customer</label><input style={S.inp} value={proj.customer || ""} onChange={e => setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id !== proj.id ? p : { ...p, customer: e.target.value, updatedAt: new Date().toISOString() }) }))} /></div>
              <div><label style={{ ...S.lbl, marginTop: 0 }}>Station Count</label><input type="number" style={S.inp} value={proj.stations || ""} onChange={e => updateStations(proj.id, e.target.value)} placeholder="0" /></div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={S.page}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={S.h2}>Manage Projects</h2>
        <button style={{ ...S.btnMain, width: "auto", padding: "10px 20px", marginTop: 0 }} onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "+ New Project"}</button>
      </div>
      <p style={S.sub}>Create projects, manage station counts, toggle SI involvement. Showing {active.length} active, {inactive.length} inactive, {past.length} past.</p>

      {/* Tab selector */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[{ id: "active", label: `Active (${active.length})`, color: "#059669" }, { id: "inactive", label: `Inactive (${inactive.length})`, color: "#94A3B8" }, { id: "past", label: `Past (${past.length})`, color: "#D97706" }].map(t => (
          <button key={t.id} onClick={() => setMgTab(t.id)} style={{ ...S.tabBtn, ...(mgTab === t.id ? { background: t.color, color: "#FFF", borderColor: t.color } : {}) }}>{t.label}</button>
        ))}
      </div>

      {showForm && (
        <div style={{ ...S.card, marginBottom: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div><label style={S.lbl}>Project Name</label><input style={S.inp} value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} placeholder="e.g. NVIDIA HGX Inspection" /></div>
            <div><label style={S.lbl}>Customer</label><input style={S.inp} value={form.customer} onChange={e => setForm(f => ({...f, customer: e.target.value}))} placeholder="e.g. NVIDIA" /></div>
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 12, alignItems: "center" }}>
            <div><label style={S.lbl}>Stations</label><input type="number" style={{ ...S.inp, width: 120 }} value={form.stations} onChange={e => setForm(f => ({...f, stations: e.target.value}))} placeholder="0" /></div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 20, cursor: "pointer" }} onClick={() => setForm(f => ({ ...f, isSI: !f.isSI }))}>
              <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${form.isSI ? "#3B82F6" : "#CBD5E1"}`, background: form.isSI ? "#3B82F6" : "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#FFF", fontWeight: 800 }}>{form.isSI ? "✓" : ""}</div>
              <span style={{ fontSize: 14, fontFamily: F, color: "#475569" }}>SI Involved</span>
            </div>
          </div>
          <button style={{ ...S.btnMain, marginTop: 16, width: "auto", padding: "10px 24px" }} onClick={addProj}>Create Project</button>
        </div>
      )}

      {/* Tab content */}
      {mgTab === "active" && (
        active.length === 0 ? <div style={S.empty}>No active projects.</div> : active.map(renderCard)
      )}
      {mgTab === "inactive" && (
        inactive.length === 0 ? <div style={S.empty}>No inactive/closed projects from HubSpot.</div> : inactive.map(renderCard)
      )}
      {mgTab === "past" && (<>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
          <button style={{ ...S.btnEdit, fontSize: 12 }} onClick={() => {
            const csv = prompt("Paste past projects, one per line:\nFormat: Name, Customer, Doc Link");
            if (!csv) return;
            const newP = csv.split("\n").filter(l => l.trim()).map(l => { const p = l.split(",").map(s => s.trim()); return { id: genId(), name: p[0]||"Unnamed", customer: p[1]||"", docLink: p[2]||null, stations: 0, status: "deprecated", updatedAt: new Date().toISOString() }; });
            setState(prev => ({ ...prev, projects: [...(prev.projects||[]), ...newP] }));
          }}>📋 Bulk Import</button>
        </div>
        {past.length === 0 ? <div style={S.empty}>No past projects.</div> : past.map(renderCard)}
      </>)}
    </div>
  );
}

/* ═══ ALL SI PROJECTS VIEW — v4.1.0 ═══ */
/* All SI Projects — ported from the fixture_tracker app.
   Lists manually-created SI projects (separate from the HubSpot-synced
   projects in state.projects). Backed by RTDB at appState/siProjects.
   First-session scope: list + create + inline-edit basic fields + delete.
   Future sessions add: per-project drill-in (stations, documents),
   timeline Gantt, kanban view, dashboard widgets. */
const SI_STAGES = ["SIRD", "DFM", "Quote", "PO", "Build", "FAT", "In Transit", "SAT", "Live"];
// Context for the file preview modal. Set by AllSIProjectsView, consumed
// anywhere inside via useContext(SIPreviewCtx).openPreview({ filename, url|downloadUrl, mimeType? }).
const SIPreviewCtx = createContext({ openPreview: () => {} });
// Context for navigating between Manage pages from anywhere inside the
// SI view (e.g. "Manage in SIRD Generator" link inside a drill-in card).
const SINavCtx = createContext({ goToTab: () => {} });

// fixture_tracker (localhost:5000) uses a sans-serif system stack at
// 13px base. The rest of the deployment-portal app uses Times New Roman
// (F). Scoped here so the All SI Projects view matches fixture_tracker
// without disturbing the parent app.
const SI_F = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

// Theme-aware content styles. Clicking the toggle actually flips the
// whole page — cards/tables/empties switch palettes via T. Mirrors
// fixture_tracker's behavior where both top nav AND content flip.
function themedSI(T) {
  const isDark = T?.name === "dark";
  return {
    card:   { background: T.cardBg, border: `1px solid ${T.cardBorder}`, borderRadius: 8, padding: 14, color: T.text, fontFamily: SI_F, fontSize: 13 },
    empty:  { background: T.cardBg, border: `1px dashed ${T.cardBorder}`, borderRadius: 8, padding: 24, textAlign: "center", color: T.textMuted, fontSize: 13, fontFamily: SI_F },
    table:  { width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontFamily: SI_F, color: T.text },
    th:     { textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${T.cardBorder}`, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: T.textMuted, fontFamily: SI_F, background: T.cardSoft },
    td:     { padding: "8px 10px", borderBottom: `1px solid ${isDark ? T.cardBorder : "#F1F5F9"}`, verticalAlign: "middle", fontFamily: SI_F, color: T.text },
    h2:     { fontSize: 15, fontWeight: 700, color: T.text, margin: 0, fontFamily: SI_F },
    pageBg: isDark ? T.pageBg : "#F5F6F8",
    cardBg:   T.cardBg,
    cardSoft: T.cardSoft,
    cardBorder: T.cardBorder,
    text: T.text,
    textMuted: T.textMuted,
    inputBg: T.inputBg,
    inputBorder: T.inputBorder,
    link:   isDark ? "#60A5FA" : "#2563EB",
    isDark,
  };
}

const SIStyleCtx = createContext(null);
function useSIS() {
  const ctx = useContext(SIStyleCtx);
  // Fallback for components rendered outside a provider (shouldn't happen
  // but doesn't crash if it does).
  return ctx || themedSI(THEMES.light);
}

// Light + dark theme palettes for the All SI Projects view. Only the
// surfaces that read directly via inline styles need to be themed —
// the rest of the deployment-portal app stays on its existing light look.
const THEMES = {
  light: {
    name: "light",
    pageBg:     "#F8FAFC",
    headerBg:   "#FFFFFF",
    headerBorder: "#E2E8F0",
    cardBg:     "#FFFFFF",
    cardBorder: "#E2E8F0",
    cardSoft:   "#F1F5F9",
    text:       "#0F172A",
    textMuted:  "#64748B",
    textLow:    "#94A3B8",
    inputBg:    "#FFFFFF",
    inputBorder:"#CBD5E1",
    accent:     "#00C9A7",
    accentSoft: "#ECFDF5",
    overlay:    "rgba(15,23,42,0.4)",
  },
  // Dark palette mirrors fixture_tracker's tokens exactly so the two
  // apps read identically when both are in dark mode.
  dark: {
    name: "dark",
    pageBg:     "#0f172a",
    headerBg:   "#1e293b",
    headerBorder:"#334155",
    cardBg:     "#1e293b",
    cardBorder: "#334155",
    cardSoft:   "#273449",
    text:       "#e2e8f0",
    textMuted:  "#94a3b8",
    textLow:    "#64748b",
    inputBg:    "#273449",
    inputBorder:"#334155",
    accent:     "#1d4ed8",
    accentSoft: "rgba(29,78,216,0.12)",
    overlay:    "rgba(0,0,0,0.65)",
  },
};
const MANAGE_TAB_IDS = new Set(["si_fleet", "si_sird_gen", "si_testplan_gen", "misc_docs"]);
const MANAGE_TAB_LABEL = {
  si_fleet:        "SI Fleet",
  si_sird_gen:     "SIRD Generator",
  si_testplan_gen: "FAT/SAT Test Plan Generator",
  misc_docs:       "Misc Documents",
};
const SI_STAGE_COLORS = {
  SIRD: "#6366F1", DFM: "#A855F7", Quote: "#EC4899", PO: "#F59E0B",
  Build: "#3B82F6", FAT: "#22C55E", "In Transit": "#F97316",
  SAT: "#14B8A6", Live: "#16A34A",
};

function AllSIProjectsView({ user, state, setState, setView, setProject, setSiFullscreen }) {
  // AllSIProjectsView is the provider — it computes siS from T and pushes
  // into context. Don't read from context here; we'd hit a circular dep.
  const isSIAdminUser = user?.role === "si_admin" || user?.role === "admin" || user?.superAdmin;
  const siProjects = state.siProjects || {};
  const allProjects = Object.entries(siProjects)
    .map(([pid, p]) => ({ pid, ...(p || {}) }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const [tab, setTab]                 = useState("dashboard"); // dashboard | timeline | kanban | si_fleet | si_sird_gen | si_testplan_gen | misc_docs
  // Per-tab theme: each tab remembers its own preference. Timeline
  // defaults to light (Gantt reads better there); others default to dark.
  // Mirrors fixture_tracker's nav.js theme persistence.
  // Per-tab body theme defaults — match the look in the design screenshots:
  // tab-specific overrides win; anything not listed falls back to "dark".
  const DEFAULT_THEME_BY_TAB = {
    dashboard:       "light",
    si_sird_gen:     "light",
    si_testplan_gen: "light",
    misc_docs:       "light",
    timeline:        "dark",
    kanban:          "dark",
    si_fleet:        "dark",
  };
  const getThemeForTab = (t) => {
    try {
      const saved = localStorage.getItem(`dp_si_theme.${t}`);
      if (saved === "light" || saved === "dark") return saved;
    } catch (_) {}
    return DEFAULT_THEME_BY_TAB[t] || "light";
  };
  const [theme, setThemeState] = useState(() => getThemeForTab("dashboard"));
  // Re-derive whenever the active tab changes.
  useEffect(() => { setThemeState(getThemeForTab(tab)); }, [tab]);
  const setTheme = (t) => {
    setThemeState(t);
    try { localStorage.setItem(`dp_si_theme.${tab}`, t); } catch (_) {}
  };
  const [selectedPid, setSelectedPid] = useState(null);
  // The project drill-in is intentionally always light, regardless of the
  // tab the user clicked through from (Dashboard / Timeline / Kanban). The
  // tab's own theme resumes the moment they go back.
  const effectiveTheme = selectedPid ? "light" : theme;
  const T = THEMES[effectiveTheme] || THEMES.light;
  const [editing, setEditing]         = useState(null);
  const [showNew, setShowNew]         = useState(false);
  const [manageOpen, setManageOpen]   = useState(false);
  const [showImport, setShowImport]   = useState(false);
  const [showCsvImport, setShowCsvImport] = useState(false);
  // Dashboard-table filters — name search + SI dropdown + Stage dropdown.
  const [search, setSearch]           = useState("");
  const [filterSi, setFilterSi]       = useState("");
  const [filterStage, setFilterStage] = useState("");
  const [expandedRows, setExpandedRows] = useState({});
  // Global preview-modal state. Components below set this when the user
  // clicks a file or inspection image; rendered once at the bottom.
  const [previewFile, setPreviewFile] = useState(null);

  // Name search + SI + Stage filters. Has to come after the state hooks
  // so we don't hit a TDZ error.
  const q = search.trim().toLowerCase();
  const projectList = allProjects.filter(p => {
    if (q && !(p.name || "").toLowerCase().includes(q)) return false;
    if (filterSi && p.si_name !== filterSi) return false;
    if (filterStage && effectiveStage(p) !== filterStage) return false;
    return true;
  });
  const allSiNames = Array.from(new Set(allProjects.map(p => p.si_name).filter(Boolean))).sort();
  const hasActiveFilter = !!(q || filterSi || filterStage);
  const clearFilters = () => { setSearch(""); setFilterSi(""); setFilterStage(""); };

  useEffect(() => { setSiFullscreen?.(true); return () => setSiFullscreen?.(false); }, [setSiFullscreen]);

  // Auto-create siProject stubs for HubSpot SI Partner Deployment projects
  // that don't yet have a linked manual record. Uses a deterministic pid
  // (`hs_<hubspotId>`) so re-runs don't duplicate. Only fires once the
  // first siProjects + HubSpot snapshots have both loaded.
  useEffect(() => {
    if (!isSIAdminUser) return;
    if (!state.siProjectsLoaded) return;
    const hsProjects = state.projects || [];
    if (!hsProjects.length) return;
    const candidates = hsProjects.filter(p =>
      p.status === "active" && p.hubspotPipelineId === SI_PARTNER_PIPELINE_ID
    );
    if (!candidates.length) return;
    (async () => {
      for (const hp of candidates) {
        const linked = findLinkedSiProject(hp, allProjects);
        const hsStageDates = hp.hubspotStageDates || {};
        if (linked) {
          // Existing manual project — non-destructively merge any HubSpot
          // stage dates we have but the user hasn't filled in yet.
          const merged = buildStageDatesFromHubspot(hsStageDates, linked.stage_dates || {});
          const changed = JSON.stringify(merged) !== JSON.stringify(linked.stage_dates || {});
          if (changed) {
            await update(ref(db, `appState/siProjects/${linked.pid}`), { stage_dates: merged });
            logSIActivity(linked.pid, "hubspot_dates_merge", `Imported HubSpot stage dates`, actor);
          }
          continue;
        }
        const autoPid = `hs_${hp.hubspotId || hp.id}`;
        if (siProjects[autoPid]) continue;
        const hsStage = normalizeSiStage(hp.siStage);
        const stage = HUBSPOT_TO_SI_STAGE[hsStage] || "SIRD";
        const stageDates = buildStageDatesFromHubspot(hsStageDates);
        await set(ref(db, `appState/siProjects/${autoPid}`), {
          name: hp.name || "(unnamed)",
          si_name: extractSiName(hp.name) || "",
          customer: hp.customer || "",
          cm_site: "",
          factory_location: hp.deployLocation || "",
          current_stage: stage,
          stage_dates: stageDates,
          stations: {},
          hubspot_id: hp.hubspotId || null,
          hubspot_pipeline_id: hp.hubspotPipelineId || null,
          source: "hubspot_auto",
          created_at: Date.now(),
          created_by: actor,
        });
        logSIActivity(autoPid, "auto_create_from_hubspot", `Auto-created from HubSpot project "${hp.name}"`, actor);
      }
    })();
    // Only re-run when the set of HubSpot project ids changes, not on every render
  }, [state.projects?.length, state.siProjectsLoaded, isSIAdminUser]);  // eslint-disable-line

  // Generic patch-by-path helper used by the drill-in subviews + Gantt
  // inline edits. Optimistically updates local state so the UI is snappy.
  const writeAt = (path, value) => set(ref(db, path), value);
  const updateAt = (path, patch) => update(ref(db, path), patch);
  const removeAt = (path) => remove(ref(db, path));

  const actor = user?.email || user?.name || "unknown";
  const saveField = (pid, field, value) => {
    update(ref(db, `appState/siProjects/${pid}`), { [field]: value, updated_at: Date.now() });
    setState(prev => ({
      ...prev,
      siProjects: { ...(prev.siProjects || {}), [pid]: { ...(prev.siProjects?.[pid] || {}), [field]: value } },
    }));
    logSIActivity(pid, "edit", `${field}: ${value == null || value === "" ? "(cleared)" : String(value).slice(0, 80)}`, actor);
  };
  const deleteProject = (pid, name) => {
    if (!confirm(`Delete project "${name}"? This cannot be undone.`)) return;
    remove(ref(db, `appState/siProjects/${pid}`));
    logSIActivity(pid, "delete", `Deleted project "${name}"`, actor);
    if (selectedPid === pid) setSelectedPid(null);
  };

  const isEditing = (pid, field) => editing?.pid === pid && editing?.field === field;

  const previewCtx = useMemo(() => ({ openPreview: (f) => setPreviewFile(f) }), []);
  const siS = useMemo(() => themedSI(T), [T]);

  // Drill-in is rendered as a sub-view INSIDE the AllSIProjectsView's
  // shared top nav, so logo + tabs + theme toggle stay visible. The
  // body switches between dashboard content and the drill-in based on
  // selectedPid below.
  const drillProject = selectedPid ? siProjects[selectedPid] : null;
  if (selectedPid && !drillProject) {
    // Project disappeared — bounce back to list.
    setSelectedPid(null);
  }

  // When the drill-in's "Manage in <Generator>" link is clicked, we want the
  // destination tab's project picker to be pre-set to the project the user
  // was just looking at. `pendingPid` carries the pid across the tab switch;
  // the target view consumes it via its `initialPid` prop and then clears it.
  const [pendingPid, setPendingPid] = useState(null);
  const navCtx = useMemo(() => ({
    goToTab: (tabId, opts) => {
      const carry = (opts && opts.pid) || selectedPid || null;
      if (carry) setPendingPid(carry);
      setSelectedPid(null);
      setTab(tabId);
    },
  }), [selectedPid]);

  // Helper used by the regular return below to wrap the whole view in
  // the preview + style + nav contexts and render the modal once.
  const _wrap = (children) => (
    <SIStyleCtx.Provider value={siS}>
      <SIPreviewCtx.Provider value={previewCtx}>
        <SINavCtx.Provider value={navCtx}>
          {children}
          {previewFile && <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
        </SINavCtx.Provider>
      </SIPreviewCtx.Provider>
    </SIStyleCtx.Provider>
  );

  // Tab styles match fixture_tracker's .tab + .tab.active rules:
  // transparent unselected, slightly lighter selected. Colors flip with
  // the theme so the toggle visibly changes the nav too.
  const navTab = (id, label) => (
    <button onClick={() => { setSelectedPid(null); setTab(id); }}
      style={{
        padding: "6px 14px",
        border: `1px solid ${tab === id && !selectedPid ? NAV_BORDER : "transparent"}`,
        borderRadius: 6,
        background: tab === id && !selectedPid ? NAV_HOVER : "transparent",
        color: tab === id && !selectedPid ? NAV_TEXT : NAV_MUTED,
        fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer",
      }}>{label}</button>
  );

  // Top nav is always dark navy, matching fixture_tracker (localhost:5000).
  // The page body still follows the per-tab theme via siS.pageBg below.
  const isDark = theme === "dark";
  const NAV_BG     = "#0F172A";
  const NAV_BORDER = "#1E293B";
  const NAV_TEXT   = "#F8FAFC";
  const NAV_MUTED  = "#94A3B8";
  const NAV_HOVER  = "#1E293B";
  return _wrap(
    <div style={{ minHeight: "100vh", background: siS.pageBg, color: "#0F172A" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "0 20px", borderBottom: `1px solid ${NAV_BORDER}`, background: NAV_BG, position: "sticky", top: 0, zIndex: 10, height: 56 }}>
        {/* Subtle "back to parent app" arrow. Hidden under a tooltip so it
            doesn't compete with the logo. The full text would clutter the
            top bar — fixture_tracker's nav doesn't have anything similar. */}
        <button onClick={() => setView("projects_overview")} title="Back to Deployment Portal"
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 28, height: 28, border: 0, borderRadius: 6,
            background: "transparent", color: NAV_MUTED,
            fontFamily: SI_F, fontSize: 16, cursor: "pointer",
          }}>
          ←
        </button>
        <div style={{ fontSize: 15, margin: 0, color: NAV_TEXT, fontFamily: SI_F, fontWeight: 700, letterSpacing: 0.3 }}>
          🤝 SI Projects Tracker
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center", position: "relative" }}>
          {navTab("dashboard", "Dashboard")}
          {navTab("timeline",  "Timeline")}
          {navTab("kanban",    "Kanban")}
          <div style={{ position: "relative" }}>
            <button onClick={() => setManageOpen(o => !o)} onBlur={() => setTimeout(() => setManageOpen(false), 150)}
              style={{
                padding: "6px 14px",
                border: `1px solid ${(manageOpen || MANAGE_TAB_IDS.has(tab)) ? NAV_BORDER : "transparent"}`,
                borderRadius: 6,
                background: (manageOpen || MANAGE_TAB_IDS.has(tab)) ? NAV_HOVER : "transparent",
                color: (manageOpen || MANAGE_TAB_IDS.has(tab)) ? NAV_TEXT : NAV_MUTED,
                fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}>{MANAGE_TAB_IDS.has(tab) ? MANAGE_TAB_LABEL[tab] + " " : ""}Manage ▾</button>
            {manageOpen && (
              <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: NAV_BG, border: `1px solid ${NAV_BORDER}`, borderRadius: 8, minWidth: 240, zIndex: 50, boxShadow: isDark ? "0 4px 12px rgba(0,0,0,0.4)" : "0 4px 12px rgba(15,23,42,0.12)" }}>
                {[
                  { id: "si_fleet",        label: "SI Fleet" },
                  { id: "si_sird_gen",     label: "SIRD Generator" },
                  { id: "si_testplan_gen", label: "FAT/SAT Test Plan Generator" },
                  { id: "misc_docs",       label: "Misc Documents" },
                ].map(item => (
                  <button key={item.id} onMouseDown={e => { e.preventDefault(); setSelectedPid(null); setTab(item.id); setManageOpen(false); }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: 0, background: tab === item.id ? NAV_HOVER : "transparent", color: tab === item.id ? NAV_TEXT : NAV_MUTED, fontFamily: SI_F, fontSize: 13, fontWeight: tab === item.id ? 600 : 500, cursor: "pointer" }}>
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <a href="https://script.google.com/a/macros/instrumental.com/s/AKfycbxOAtRNRm2_-XIPPK1fPKW-O55uVtMhMZSDcdZiR4xRqRBmtYgqURhAZ8MPg3RVsvNG/exec" target="_blank" rel="noopener noreferrer"
            style={{ padding: "6px 14px", border: "1px solid transparent", borderRadius: 6, background: "transparent", color: NAV_MUTED, fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>
            SI Process, RACI & Principles ↗
          </a>
        </div>
        <div style={{ flex: 1 }} />
      </div>

      <div style={{ padding: drillProject ? "16px 24px 80px" : "24px 32px 80px" }}>
        {drillProject ? (
          <SIDrillBoundary onBack={() => setSelectedPid(null)}>
            <SIProjectDetail
              pid={selectedPid}
              project={drillProject}
              siProjects={siProjects}
              isSIAdminUser={isSIAdminUser}
              actor={actor}
              onBack={() => setSelectedPid(null)}
              onDelete={() => deleteProject(selectedPid, drillProject.name)}
              saveField={saveField}
              writeAt={writeAt}
              updateAt={updateAt}
              removeAt={removeAt}
            />
          </SIDrillBoundary>
        ) : <>
        {tab === "dashboard" && (
          // Layout mirrors fixture_tracker's Dashboard exactly:
          // 1) Pipeline counters → 2) Projects table → 3) 2x2 grid of
          // FAT / On hold / SAT / Recent Activity panels at the bottom.
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <SIPipelineCounters projectList={projectList} />
            {projectList.length === 0 ? (
              q ? (
                <div style={siS.empty}>
                  No projects match "{search}". <button onClick={() => setSearch("")} style={{ background: "none", border: 0, color: "#2563EB", cursor: "pointer", padding: 0, textDecoration: "underline", fontFamily: SI_F, fontSize: "inherit" }}>Clear search</button>
                </div>
              ) : !state.siProjectsLoaded ? (
                <div style={{ ...siS.empty, color: siS.textMuted }}>Loading projects…</div>
              ) : (
                <EmptyStateWithAutoImport isSIAdminUser={isSIAdminUser} actor={actor}
                  onOpenImport={() => setShowImport(true)}
                  onOpenNew={() => setShowNew(true)} />
              )
            ) : (
              <div style={siS.card}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  <h2 style={{ ...siS.h2, fontSize: 15 }}>Projects</h2>
                  <span style={{ fontFamily: SI_F, fontSize: 11, color: "#64748B" }}>
                    {projectList.length} of {allProjects.length}
                  </span>
                  <div style={{ flex: 1 }} />
                  <input type="search" value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Search project…"
                    style={{ fontFamily: SI_F, fontSize: 12, padding: "5px 8px", border: "1px solid #E2E8F0", borderRadius: 5, background: "#FFF", color: "#0F172A", minWidth: 180 }} />
                  <select value={filterSi} onChange={e => setFilterSi(e.target.value)}
                    style={{ fontFamily: SI_F, fontSize: 12, padding: "5px 8px", border: "1px solid #E2E8F0", borderRadius: 5, background: "#FFF", color: "#0F172A" }}>
                    <option value="">All SIs</option>
                    {allSiNames.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select value={filterStage} onChange={e => setFilterStage(e.target.value)}
                    style={{ fontFamily: SI_F, fontSize: 12, padding: "5px 8px", border: "1px solid #E2E8F0", borderRadius: 5, background: "#FFF", color: "#0F172A" }}>
                    <option value="">All stages</option>
                    {SI_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  {hasActiveFilter && (
                    <button onClick={clearFilters}
                      style={{ fontFamily: SI_F, fontSize: 11, padding: "5px 10px", background: "transparent", border: "1px solid #E2E8F0", borderRadius: 5, color: "#64748B", cursor: "pointer" }}>
                      Clear
                    </button>
                  )}
                </div>
                {projectList.length === 0 ? (
                  <div style={{ color: "#64748B", fontFamily: SI_F, fontSize: 12, padding: "14px 0" }}>
                    No projects match the filter.
                  </div>
                ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={siS.table}>
                    <thead>
                      <tr>
                        <th style={{ ...siS.th, width: 16 }}></th>
                        <th style={siS.th}>Project</th>
                        <th style={siS.th}>SI</th>
                        <th style={siS.th}>Stage</th>
                        <th style={siS.th}>What's next</th>
                      </tr>
                    </thead>
                    <tbody>
                      {projectList.map(p => {
                        const hasNoStageDates = !p.stage_dates || Object.keys(p.stage_dates).length === 0
                          || Object.values(p.stage_dates).every(sd => !sd || Object.values(sd).every(v => !v));
                        const isOpen = !!expandedRows[p.pid];
                        const toggleRow = (e) => { e.stopPropagation(); setExpandedRows(r => ({ ...r, [p.pid]: !r[p.pid] })); };
                        const stations = Object.entries(p.stations || {}).map(([sid, s]) => ({ sid, ...(s || {}) }))
                          .sort((a, b) => (a.station_number || 0) - (b.station_number || 0));
                        return (
                          <React.Fragment key={p.pid}>
                          <tr>
                            <td onClick={toggleRow} title={isOpen ? "Collapse stations" : "Expand stations"}
                              style={{ ...siS.td, color: "#94A3B8", fontWeight: 700, cursor: "pointer", userSelect: "none", textAlign: "center" }}>
                              {isOpen ? "▾" : "▸"}
                            </td>
                            <td style={siS.td}>
                              <button onClick={() => setSelectedPid(p.pid)}
                                style={{ background: "none", border: 0, padding: 0, color: siS.link, fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer", textAlign: "left", textDecoration: "underline" }}>
                                {p.name || "(unnamed)"}
                              </button>
                              {hasNoStageDates && (
                                <span style={{ marginLeft: 6, padding: "1px 7px", borderRadius: 999, background: "#16A34A", color: "#FFF", fontSize: 10, fontWeight: 700, letterSpacing: 0.5 }}
                                  title="No timeline set yet — fill in stage dates to clear">NEW</span>
                              )}
                            </td>
                            <td style={siS.td}>{p.si_name || <span style={{ color: "#94A3B8" }}>—</span>}</td>
                            <td style={siS.td}>
                              {p.is_blocked ? (
                                <span title={p.block_reason || "On hold"}
                                  style={{ background: "#DC2626", color: "#FFF", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700, letterSpacing: 0.4 }}>
                                  ON HOLD
                                </span>
                              ) : (() => { const es = effectiveStage(p); return (
                                <span title="Stage is derived from the Timeline actual dates"
                                  style={{ background: SI_STAGE_COLORS[es] || "#94A3B8", color: "#FFF", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                                  {es}
                                </span>
                              ); })()}
                            </td>
                            <td style={{ ...siS.td, color: "#64748B", fontSize: 12.5 }}>{whatsNext(p)}</td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={5} style={{ padding: 0, borderBottom: "1px solid #E2E8F0", background: siS.cardSoft }}>
                                <div style={{ padding: "8px 14px", fontFamily: SI_F, fontSize: 12 }}>
                                  {stations.length === 0 ? (
                                    <div style={{ color: "#64748B" }}>No stations yet — open the project to add one.</div>
                                  ) : (
                                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12, fontFamily: SI_F }}>
                                      <thead>
                                        <tr>
                                          <th style={{ ...siS.th, padding: "4px 6px" }}>#</th>
                                          <th style={{ ...siS.th, padding: "4px 6px" }}>Name</th>
                                          <th style={{ ...siS.th, padding: "4px 6px" }}>Deployment factory</th>
                                          <th style={{ ...siS.th, padding: "4px 6px" }}>Notes</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {stations.map(s => (
                                          <tr key={s.sid}>
                                            <td style={{ ...siS.td, padding: "4px 6px" }}>{s.station_number}</td>
                                            <td style={{ ...siS.td, padding: "4px 6px" }}>{s.name || "—"}</td>
                                            <td style={{ ...siS.td, padding: "4px 6px" }}>{s.deployment_factory || <span style={{ color: "#94A3B8" }}>—</span>}</td>
                                            <td style={{ ...siS.td, padding: "4px 6px" }}>{s.notes || <span style={{ color: "#94A3B8" }}>—</span>}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                  <div style={{ marginTop: 6, textAlign: "right" }}>
                                    <button onClick={() => setSelectedPid(p.pid)}
                                      style={{ background: "none", border: 0, color: siS.link, fontFamily: SI_F, fontSize: 11.5, fontWeight: 600, cursor: "pointer", padding: 0 }}>
                                      See more →
                                    </button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                )}
              </div>
            )}
            {/* Bottom 2x2: FAT panel | On hold | SAT panel | Recent Activity */}
            <SIDashboardBottomGrid projectList={projectList} onOpen={setSelectedPid} />
          </div>
        )}

        {tab === "timeline" && <SIGanttView projectList={projectList} onOpen={setSelectedPid} theme={theme} actor={actor} />}
        {tab === "kanban"   && <SIKanbanBoard hubspotProjects={state.projects || []} siProjects={siProjects} onOpenDrillIn={setSelectedPid} />}
        {tab === "si_fleet"        && <SIFleetScorecard projectList={projectList} />}
        {tab === "si_sird_gen"     && <SIRDGeneratorView    projectList={projectList} isSIAdminUser={isSIAdminUser} user={user}  initialPid={pendingPid} onConsumeInitialPid={() => setPendingPid(null)} />}
        {tab === "si_testplan_gen" && <TestPlanGeneratorView projectList={projectList} isSIAdminUser={isSIAdminUser} user={user}  initialPid={pendingPid} onConsumeInitialPid={() => setPendingPid(null)} />}
        {tab === "misc_docs"       && <MiscDocumentsView    projectList={projectList} isSIAdminUser={isSIAdminUser} actor={actor} initialPid={pendingPid} onConsumeInitialPid={() => setPendingPid(null)} />}
        </>}
      </div>

      {showNew && <NewSIProjectModal onClose={() => setShowNew(false)} existing={siProjects} />}
      {showImport && <ImportFromFixtureTrackerModal onClose={() => setShowImport(false)} existing={siProjects} />}
      {showCsvImport && <CsvImportModal onClose={() => setShowCsvImport(false)} existing={siProjects} actor={actor} />}
    </div>
  );
}

/* CSV bulk-import. Accepts any CSV with at minimum a "name" column;
   other columns map case-insensitively to: si_name, customer, cm_site,
   factory, current_stage, stage. Uses SheetJS to parse — same dep we
   already have. */
function CsvImportModal({ onClose, existing, actor }) {
  const siS = useSIS();
  const [rows, setRows] = useState([]);     // parsed CSV rows
  const [errors, setErrors] = useState([]);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const append = (line) => setLog(prev => [...prev, line]);

  const parseFile = async (file) => {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      // Normalize keys to lowercase + strip whitespace.
      const norm = raw.map(r => {
        const out = {};
        for (const [k, v] of Object.entries(r)) out[k.toString().trim().toLowerCase()] = (typeof v === "string" ? v.trim() : v);
        return out;
      });
      // Validation pass.
      const errs = [];
      norm.forEach((r, i) => {
        const name = r.name || r.project || r.project_name;
        const si = r.si_name || r.si || r["si partner"] || r.si_partner;
        if (!name) errs.push({ row: i + 2, field: "name", message: "missing name" });
        if (!si) errs.push({ row: i + 2, field: "si_name", message: "missing SI partner" });
      });
      setRows(norm);
      setErrors(errs);
    } catch (e) {
      setErrors([{ row: 0, message: e?.message || String(e) }]);
    }
  };

  const apply = async () => {
    if (errors.length > 0) {
      if (!confirm(`${errors.length} validation issue${errors.length === 1 ? "" : "s"} — rows with errors will be skipped. Continue?`)) return;
    }
    setBusy(true);
    let created = 0, skipped = 0;
    for (const r of rows) {
      const name = (r.name || r.project || r.project_name || "").toString().trim();
      const si = (r.si_name || r.si || r["si partner"] || r.si_partner || "").toString().trim();
      if (!name || !si) { skipped++; continue; }
      const stage = (r.current_stage || r.stage || "SIRD").toString().trim();
      const newRef = push(ref(db, "appState/siProjects"));
      await set(newRef, {
        name,
        si_name:       canonicalSi(si, existing),
        customer:      (r.customer || "").toString().trim() || null,
        cm_site:       (r.cm_site || r.factory || r["deployment factory"] || "").toString().trim() || null,
        current_stage: SI_STAGES.includes(stage) ? stage : "SIRD",
        station_count: Number(r.station_count || r.stations || 1) || 1,
        is_blocked:    false,
        created_at:    Date.now(),
        updated_at:    Date.now(),
      });
      logSIActivity(newRef.key, "create", `Created project "${name}" (CSV import)`, actor);
      created++;
      append(`✓ ${name}`);
    }
    append(`\nImported ${created} project${created === 1 ? "" : "s"}, skipped ${skipped}.`);
    setBusy(false);
  };

  return (
    <div onClick={busy ? undefined : onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#FFF", borderRadius: 12, padding: 22, width: "min(640px, 92vw)", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <h3 style={{ margin: "0 0 6px", fontFamily: SI_F, fontSize: 17, color: "#0F172A" }}>CSV bulk-import</h3>
        <p style={{ margin: "0 0 12px", fontFamily: SI_F, fontSize: 12, color: "#64748B", lineHeight: 1.5 }}>
          Columns recognised (case-insensitive): <code>name</code> (required), <code>si_name</code> (required),
          <code>customer</code>, <code>cm_site</code> or <code>factory</code>, <code>current_stage</code>, <code>station_count</code>.
          First row is the header. SI partner casing is canonicalized to existing projects.
        </p>
        <input type="file" accept=".csv,.xlsx,.xls" onChange={e => parseFile(e.target.files?.[0])}
          style={{ marginBottom: 12, fontFamily: SI_F, fontSize: 12 }} />
        {errors.length > 0 && (
          <div style={{ background: "#FEF3C7", color: "#92400E", padding: 10, borderRadius: 6, fontFamily: SI_F, fontSize: 12, marginBottom: 10 }}>
            <strong>{errors.length} issue{errors.length === 1 ? "" : "s"}:</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
              {errors.slice(0, 5).map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}
              {errors.length > 5 && <li>… and {errors.length - 5} more</li>}
            </ul>
          </div>
        )}
        {rows.length > 0 && (
          <div style={{ flex: 1, overflowY: "auto", border: "1px solid #E2E8F0", borderRadius: 6, marginBottom: 12 }}>
            <table style={{ ...siS.table, fontSize: 11.5 }}>
              <thead><tr><th style={siS.th}>Name</th><th style={siS.th}>SI</th><th style={siS.th}>Customer</th><th style={siS.th}>Factory</th><th style={siS.th}>Stage</th></tr></thead>
              <tbody>
                {rows.slice(0, 15).map((r, i) => (
                  <tr key={i}>
                    <td style={siS.td}>{r.name || r.project || r.project_name || <span style={{ color: "#DC2626" }}>—</span>}</td>
                    <td style={siS.td}>{r.si_name || r.si || r["si partner"] || r.si_partner || <span style={{ color: "#DC2626" }}>—</span>}</td>
                    <td style={siS.td}>{r.customer || ""}</td>
                    <td style={siS.td}>{r.cm_site || r.factory || r["deployment factory"] || ""}</td>
                    <td style={siS.td}>{r.current_stage || r.stage || "SIRD"}</td>
                  </tr>
                ))}
                {rows.length > 15 && <tr><td colSpan={5} style={{ ...siS.td, color: "#94A3B8", textAlign: "center" }}>… +{rows.length - 15} more rows</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {log.length > 0 && (
          <pre style={{ background: siS.cardSoft, border: "1px solid #E2E8F0", borderRadius: 6, padding: 10, margin: "0 0 12px", fontFamily: "ui-monospace, monospace", fontSize: 11, maxHeight: 140, overflowY: "auto", whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={busy}
            style={{ padding: "7px 14px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#0F172A", fontFamily: SI_F, fontSize: 13, cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1 }}>Close</button>
          {rows.length > 0 && (
            <button onClick={apply} disabled={busy}
              style={{ padding: "7px 14px", border: "1px solid #2563EB", borderRadius: 6, background: busy ? "#94D3C5" : "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: busy ? "wait" : "pointer" }}>
              {busy ? "Importing…" : `Import ${rows.length - errors.filter(e => e.row > 0).length} project${rows.length === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Drill-in view — mirrors fixture_tracker's per-project Dashboard
   layout exactly: header card, Stations, Documents (SIRD/FAT/SAT cards
   + DFM zones), Executed test plans, Misc Documents, Coverage Doc &
   BOM, Inspection items. Project metadata is inline in the header
   (no separate Overview card); Stage editing happens here on the FAT
   plan or the Timeline view, not via a dropdown. */
/* Error boundary for the drill-in so a crash shows a recoverable message
   instead of a blank/black page. */
class SIDrillBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("[SIDrillBoundary]", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ background: "#FFF", border: "1px solid #FCA5A5", borderRadius: 8, padding: 20, color: "#0F172A", fontFamily: SI_F }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <button onClick={this.props.onBack}
              style={{ padding: "6px 14px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#64748B", fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              ← Back to Dashboard
            </button>
            <h2 style={{ margin: 0, color: "#B91C1C", fontSize: 16 }}>The project drill-in hit an error</h2>
          </div>
          <pre style={{ margin: 0, padding: 12, background: "#FEF2F2", color: "#7F1D1D", borderRadius: 6, fontFamily: "ui-monospace, monospace", fontSize: 12, whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 320 }}>
            {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function SIProjectDetail({ pid, project, siProjects, isSIAdminUser, actor, onBack, onDelete, saveField, writeAt, updateAt, removeAt }) {
  const siS = useSIS();
  const stations = project.stations || {};
  const files = project.files || {};
  const stationsList = Object.entries(stations).map(([sid, s]) => ({ sid, ...(s || {}) }))
    .sort((a, b) => (a.station_number || 0) - (b.station_number || 0));
  const deployedFactories = new Set(stationsList.map(s => s.deployment_factory).filter(Boolean));
  const fatPlannedDate = project.stage_dates?.FAT?.planned_start || null;

  const addDriveLink = async () => {
    const url = prompt("Paste the Google Drive folder URL:");
    if (!url) return;
    await update(ref(db, `appState/siProjects/${pid}`), { drive_url: url.trim() });
    logSIActivity(pid, "drive_link", `Added Drive link`, actor);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* "Back to Dashboard" strip — sits inside the shared AllSIProjectsView
          nav, so the top bar (logo + tabs + theme toggle) stays visible. */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button onClick={onBack}
          style={{ padding: "6px 14px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#64748B", fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
          ← Back to Dashboard
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Header card: name + stage badge + metadata line + Add Drive link */}
        <div style={siS.card}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <h2 style={{ ...siS.h2, fontSize: 18 }}>{project.name || "(unnamed)"}</h2>
            {(() => { const es = effectiveStage(project); return (
              <span style={{ background: SI_STAGE_COLORS[es] || "#94A3B8", color: "#FFF", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 700, fontFamily: SI_F }}>
                {es}
              </span>
            ); })()}
            {project.is_blocked && (
              <span style={{ background: "#DC2626", color: "#FFF", padding: "2px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700, fontFamily: SI_F }}>
                ON HOLD
              </span>
            )}
          </div>
          <div style={{ fontFamily: SI_F, fontSize: 12, color: "#64748B", marginBottom: 8 }}>
            {[
              `SI: ${project.si_name || "—"}`,
              `Customer: ${project.customer || "—"}`,
              `CM Site: ${project.cm_site || "—"}`,
              `${stationsList.length} station${stationsList.length === 1 ? "" : "s"}`,
              project.station_type || null,
              fatPlannedDate ? `FAT planned: ${fatPlannedDate}` : "FAT planned: —",
            ].filter(Boolean).join("  ·  ")}
          </div>
          {project.drive_url ? (
            <a href={project.drive_url} target="_blank" rel="noopener"
              style={{ fontFamily: SI_F, fontSize: 12, color: siS.link, textDecoration: "none", padding: "5px 12px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", display: "inline-block" }}>
              📁 Open Drive folder
            </a>
          ) : isSIAdminUser ? (
            <button onClick={addDriveLink}
              style={{ padding: "5px 12px", border: 0, borderRadius: 6, background: "#0F172A", color: "#FFF", fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              + Add Drive link
            </button>
          ) : null}
        </div>

        {/* Stations — richer table (matches fixture_tracker columns) */}
        <SIStationsSection
          pid={pid} stations={stations} isSIAdminUser={isSIAdminUser} actor={actor}
          deployedFactories={deployedFactories.size}
          writeAt={writeAt} updateAt={updateAt} removeAt={removeAt} />

        {/* Documents — SIRD / FAT / SAT cards + DFM zones */}
        <SIDocumentsSection
          pid={pid} project={project} files={files} isSIAdminUser={isSIAdminUser} actor={actor}
          writeAt={writeAt} removeAt={removeAt} />

        {/* Executed test plans (FAT + SAT) */}
        <SIExecutedTestPlansCard pid={pid} project={project} isSIAdminUser={isSIAdminUser} actor={actor} />

        {/* Misc Documents */}
        <SIMiscDocsCard pid={pid} files={files} isSIAdminUser={isSIAdminUser} actor={actor} />

        {/* Coverage Doc & BOM */}
        <SICoverageBomCard pid={pid} files={files} isSIAdminUser={isSIAdminUser} actor={actor} />

        {/* What we're inspecting */}
        <SIInspectionSection
          pid={pid} inspection={project.inspection || {}} isSIAdminUser={isSIAdminUser} actor={actor}
          writeAt={writeAt} updateAt={updateAt} removeAt={removeAt} />
      </div>
    </div>
  );
}

/* ── Recent activity feed for the per-project drill-in. Self-fetches
   its own log via onValue (RTDB) on mount; cleans up on unmount. */
/* Executed FAT/SAT card — shows xlsx upload count, records count, and
   per-side upload buttons that go through TestPlanGenerator's parser. */
function SIExecutedTestPlansCard({ pid, project, isSIAdminUser, actor }) {
  const siS = useSIS();
  const fatPlan = project?.test_plans?.fat || {};
  const satPlan = project?.test_plans?.sat || {};
  const fatUploads = Object.values(fatPlan.executed_uploads || {});
  const satUploads = Object.values(satPlan.executed_uploads || {});
  const fatRecords = Object.values(fatPlan.test_records || {});
  const satRecords = Object.values(satPlan.test_records || {});
  return (
    <div style={siS.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h3 style={{ ...siS.h2, fontSize: 14 }}>Executed test plans</h3>
        <span style={{ fontFamily: SI_F, fontSize: 11, color: "#64748B" }}>Summary pulled from the vendor-returned xlsx</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
        <ExecutedSide pid={pid} kind="FAT" plan={fatPlan} uploads={fatUploads} records={fatRecords} isSIAdminUser={isSIAdminUser} actor={actor} />
        <ExecutedSide pid={pid} kind="SAT" plan={satPlan} uploads={satUploads} records={satRecords} isSIAdminUser={isSIAdminUser} actor={actor} />
      </div>
    </div>
  );
}
function ExecutedSide({ pid, kind, plan, uploads, records, isSIAdminUser, actor }) {
  const siS = useSIS();
  const xlsxRef = useRef(null);
  const recRef = useRef(null);
  const planType = kind.toLowerCase();
  const ensurePlanExists = async () => {
    if (plan && plan.rows) return;
    // Stub-create a plan so executed uploads have somewhere to go.
    await set(ref(db, `appState/siProjects/${pid}/test_plans/${planType}`), {
      created_at: Date.now(), status: "draft", rows: {},
    });
  };
  const onUploadXlsx = async (file) => {
    if (!file) return;
    await ensurePlanExists();
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
    const storagePath = `siProjectFiles/${pid}/executed_${planType}/${Date.now()}_${safe}`;
    const sr = sRef(storage, storagePath);
    await uploadBytes(sr, file);
    const url = await getDownloadURL(sr);
    const k = push(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/executed_uploads`)).key;
    await set(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/executed_uploads/${k}`), {
      filename: file.name, storagePath, downloadUrl: url, uploaded_at: Date.now(), uploaded_by: actor,
    });
    logSIActivity(pid, "executed_xlsx", `Executed ${kind} xlsx: ${file.name}`, actor);
  };
  const onUploadRecord = async (file) => {
    if (!file) return;
    await ensurePlanExists();
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
    const storagePath = `siProjectFiles/${pid}/test_records_${planType}/${Date.now()}_${safe}`;
    const sr = sRef(storage, storagePath);
    await uploadBytes(sr, file);
    const url = await getDownloadURL(sr);
    const k = push(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/test_records`)).key;
    await set(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/test_records/${k}`), {
      filename: file.name, storagePath, downloadUrl: url, uploaded_at: Date.now(), uploaded_by: actor,
    });
    logSIActivity(pid, "test_record", `Test record (${kind}): ${file.name}`, actor);
  };
  return (
    <div style={{ background: siS.cardSoft, border: "1px solid #E2E8F0", borderRadius: 6, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ fontFamily: SI_F, fontSize: 12.5, fontWeight: 600, color: "#0F172A" }}>Executed {kind}</div>
        <span style={{ fontFamily: SI_F, fontSize: 10.5, color: "#64748B" }}>
          {uploads.length} xlsx · {records.length} record{records.length === 1 ? "" : "s"}
        </span>
        <div style={{ flex: 1 }} />
        {isSIAdminUser && (
          <>
            <button onClick={() => xlsxRef.current?.click()}
              style={{ padding: "3px 10px", border: "1px solid #2563EB", borderRadius: 4, background: "#FFF", color: "#2563EB", fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>↑ Executed xlsx</button>
            <input ref={xlsxRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={e => { onUploadXlsx(e.target.files?.[0]); e.target.value = ""; }} />
            <button onClick={() => recRef.current?.click()}
              style={{ padding: "3px 10px", border: "1px solid #E2E8F0", borderRadius: 4, background: "#FFF", color: "#64748B", fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>↑ Test record</button>
            <input ref={recRef} type="file" style={{ display: "none" }} onChange={e => { onUploadRecord(e.target.files?.[0]); e.target.value = ""; }} />
          </>
        )}
      </div>
      <div style={{ fontFamily: SI_F, fontSize: 10.5, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Executed plans</div>
      {uploads.length === 0
        ? <div style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 11 }}>None yet.</div>
        : <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>{uploads.slice(0, 5).map((u, i) => (
            <li key={i} style={{ fontFamily: SI_F, fontSize: 11.5, padding: "3px 0", borderTop: i ? "1px dotted #E2E8F0" : 0 }}>
              📄 <a href={u.downloadUrl} target="_blank" rel="noopener" style={{ color: "#2563EB", textDecoration: "none" }}>{u.filename}</a>
            </li>
          ))}</ul>}
      <div style={{ fontFamily: SI_F, fontSize: 10.5, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.4, margin: "10px 0 4px" }}>Test records</div>
      {records.length === 0
        ? <div style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 11 }}>None yet — proof images, videos, logs land here.</div>
        : <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>{records.slice(0, 5).map((u, i) => (
            <li key={i} style={{ fontFamily: SI_F, fontSize: 11.5, padding: "3px 0", borderTop: i ? "1px dotted #E2E8F0" : 0 }}>
              📎 <a href={u.downloadUrl} target="_blank" rel="noopener" style={{ color: "#2563EB", textDecoration: "none" }}>{u.filename}</a>
            </li>
          ))}</ul>}
    </div>
  );
}

/* Misc Documents read-only card on the drill-in. Write happens on the
   Manage > Misc Documents page. */
function SIMiscDocsCard({ pid, files, isSIAdminUser, actor }) {
  const siS = useSIS();
  const { goToTab } = useContext(SINavCtx);
  const { openPreview } = useContext(SIPreviewCtx);
  const misc = Object.entries(files || {}).map(([fid, f]) => ({ fid, ...f })).filter(f => f.category === "misc");
  return (
    <div style={siS.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h3 style={{ ...siS.h2, fontSize: 14 }}>Misc Documents</h3>
        <span style={{ fontFamily: SI_F, fontSize: 11, color: "#64748B" }}>{misc.length} item{misc.length === 1 ? "" : "s"}</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => goToTab("misc_docs")}
          style={{ background: "none", border: 0, padding: 0, color: siS.link, fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer", textDecoration: "underline" }}>
          ↗ Manage in Misc Documents
        </button>
      </div>
      {misc.length === 0
        ? <div style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 12 }}>No misc documents yet.</div>
        : <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>{misc.map(f => {
            const isLink = f.kind === "link";
            const href   = f.url || f.downloadUrl;
            return (
              <li key={f.fid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: `1px dotted ${siS.cardBorder}`, fontFamily: SI_F, fontSize: 12 }}>
                <span style={{ flex: "0 0 auto" }}>{isLink ? "🔗" : "📄"}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: siS.text }}>{f.filename || href}</span>
                {!isLink && f.downloadUrl && (
                  <button onClick={() => openPreview({ filename: f.filename, downloadUrl: f.downloadUrl, mimeType: f.mimeType })}
                    style={{ padding: "3px 9px", border: `1px solid ${siS.cardBorder}`, borderRadius: 5, background: "transparent", color: siS.link, fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                    👁 Preview
                  </button>
                )}
                {!isLink && f.downloadUrl && (
                  <a href={f.downloadUrl} download={f.filename || ""} target="_blank" rel="noopener"
                    style={{ padding: "3px 9px", border: `1px solid ${siS.cardBorder}`, borderRadius: 5, background: "transparent", color: siS.link, fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer", textDecoration: "none" }}>
                    ⬇ Download
                  </a>
                )}
                {isLink && href && (
                  <a href={href} target="_blank" rel="noopener"
                    style={{ padding: "3px 9px", border: `1px solid ${siS.cardBorder}`, borderRadius: 5, background: "transparent", color: siS.link, fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer", textDecoration: "none" }}>
                    ↗ Open
                  </a>
                )}
              </li>
            );
          })}</ul>}
    </div>
  );
}

/* Coverage Doc & BOM section — two stacked zones using DocZone. */
function SICoverageBomCard({ pid, files, isSIAdminUser, actor }) {
  const siS = useSIS();
  const coverage = Object.entries(files || {}).map(([fid, f]) => ({ fid, ...f })).filter(f => f.category === "coverage");
  const bom      = Object.entries(files || {}).map(([fid, f]) => ({ fid, ...f })).filter(f => f.category === "bom");
  return (
    <div style={siS.card}>
      <h3 style={{ ...siS.h2, fontSize: 14, marginBottom: 10 }}>Coverage Doc & BOM</h3>
      <h4 style={{ margin: "0 0 6px", fontFamily: SI_F, fontSize: 12.5, color: "#0F172A", fontWeight: 700 }}>Coverage Doc</h4>
      <DocZone pid={pid} category="coverage" label="Coverage document" files={coverage}
        isSIAdminUser={isSIAdminUser} actor={actor}
        writeAt={(p, v) => set(ref(db, p), v)} removeAt={(p) => remove(ref(db, p))} />
      <h4 style={{ margin: "12px 0 6px", fontFamily: SI_F, fontSize: 12.5, color: "#0F172A", fontWeight: 700 }}>BOM</h4>
      <DocZone pid={pid} category="bom" label="Bill of materials" files={bom}
        isSIAdminUser={isSIAdminUser} actor={actor}
        writeAt={(p, v) => set(ref(db, p), v)} removeAt={(p) => remove(ref(db, p))} />
    </div>
  );
}

function SIActivityFeed({ pid }) {
  const siS = useSIS();
  const [entries, setEntries] = useState([]);
  useEffect(() => {
    const r = ref(db, `appState/siActivityLog/${pid}`);
    return onValue(r, s => {
      const val = s.val() || {};
      const list = Object.entries(val)
        .map(([k, v]) => ({ k, ...(v || {}) }))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      setEntries(list);
    });
  }, [pid]);
  return (
    <Section title={`Recent activity (${entries.length})`}>
      {entries.length === 0 ? (
        <div style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 13 }}>No activity yet — edits to this project will appear here.</div>
      ) : (
        <div style={{ maxHeight: 260, overflowY: "auto" }}>
          {entries.slice(0, 50).map(e => (
            <div key={e.k} style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: "1px dotted #E2E8F0", fontFamily: SI_F, fontSize: 12 }}>
              <div style={{ color: "#64748B", width: 150, flexShrink: 0 }}>
                {e.timestamp ? new Date(e.timestamp).toLocaleString() : "—"}
              </div>
              <div style={{ color: "#64748B", width: 160, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.actor || "unknown"}
              </div>
              <div style={{ color: "#0F172A" }}>{e.summary || e.type || ""}</div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/* ── Inspection items: structured table grouped by section_title ──
   Mirrors fixture_tracker's "What we're inspecting" layout. Section
   header rows span the data cells, data rows carry connectors covered
   + image type + reference image (uploaded to Firebase Storage). */
/* Shared FAT/SAT test plan template library. CRUD over reusable rows
   that seed new plans. Stored at appState/testPlanLibrary/ as a flat
   map keyed by push id. Apply-to-FAT / Apply-to-SAT checkboxes let a
   template show up in just one or both kinds of plans. */
// Canonical default library rows — match the fixture_tracker seed exactly.
// First load on an empty library auto-seeds these so the table is never blank.
const DEFAULT_LIBRARY_ROWS = [
  { test_id: "M-001", sird_ref: "5.1",  module: "Mech",   category: "Fixture",     description: "Verify fixture footprint matches drawing",       pass_criterion: "Within ±2 mm of drawing",         phase: "Setup",        applies_to_fat: true,  applies_to_sat: true  },
  { test_id: "M-002", sird_ref: "5.3",  module: "Mech",   category: "Fixture",     description: "Verify reject chute clears largest variant",     pass_criterion: "No interference at any orientation", phase: "Setup",     applies_to_fat: true,  applies_to_sat: true  },
  { test_id: "E-001", sird_ref: "7.1",  module: "Elec",   category: "Power",       description: "Mains voltage matches site (208/240/480V)",       pass_criterion: "Within ±5% on each leg",          phase: "Setup",        applies_to_fat: true,  applies_to_sat: true  },
  { test_id: "E-002", sird_ref: "7.3",  module: "Elec",   category: "Safety",      description: "E-stop halts all motion <500 ms",                 pass_criterion: "Stops in ≤500 ms; latched",       phase: "Functional",   applies_to_fat: true,  applies_to_sat: true  },
  { test_id: "O-001", sird_ref: "4.2",  module: "Optics", category: "Calibration", description: "Camera resolution matches spec",                  pass_criterion: "≥ spec'd MP per camera",          phase: "Functional",   applies_to_fat: true,  applies_to_sat: true  },
  { test_id: "O-002", sird_ref: "4.3",  module: "Optics", category: "Lighting",    description: "Lighting uniformity",                             pass_criterion: "≤10% variance across FOV",        phase: "Functional",   applies_to_fat: true,  applies_to_sat: true  },
  { test_id: "S-001", sird_ref: "8.1",  module: "SW",     category: "Boot",        description: "App boots cleanly from cold start",               pass_criterion: "Boots in ≤120 s with no errors",  phase: "Functional",   applies_to_fat: true,  applies_to_sat: true  },
  { test_id: "S-002", sird_ref: "8.2",  module: "SW",     category: "Barcode",     description: "Barcode scan triggers cycle",                     pass_criterion: "100% trigger rate over 50 scans", phase: "Functional",   applies_to_fat: true,  applies_to_sat: true  },
  { test_id: "P-001", sird_ref: "16.1", module: "Perf",   category: "Cycle",       description: "Cycle time at target throughput",                 pass_criterion: "≤ target sec/unit at UPH spec",   phase: "Performance",  applies_to_fat: true,  applies_to_sat: true  },
  { test_id: "P-002", sird_ref: "16.2", module: "Perf",   category: "Detection",   description: "Defect detection on 100 known-bad units",         pass_criterion: "≥95% capture, ≤2% false-call",    phase: "Performance",  applies_to_fat: true,  applies_to_sat: true  },
  { test_id: "D-001", sird_ref: "13.1", module: "Deploy", category: "MES",         description: "MES handshake live on factory line",              pass_criterion: "Verified IO trace with line PLC", phase: "Acceptance",   applies_to_fat: false, applies_to_sat: true  },
  { test_id: "D-002", sird_ref: "13.2", module: "Deploy", category: "Operator",    description: "Operator can run a full shift with no escalations", pass_criterion: "8 h continuous operation, log clean", phase: "Acceptance", applies_to_fat: false, applies_to_sat: true },
];

function TestPlanLibraryView({ isSIAdminUser, actor }) {
  const siS = useSIS();
  const [templates, setTemplates] = useState(null);
  const [editingTid, setEditingTid] = useState(null);
  useEffect(() => {
    return onValue(ref(db, "appState/testPlanLibrary"), s => setTemplates(s.val() || {}));
  }, []);
  // Auto-seed defaults the first time the library is opened empty (admins only).
  useEffect(() => {
    if (!isSIAdminUser) return;
    if (templates === null) return; // still loading
    if (Object.keys(templates).length > 0) return; // already populated
    (async () => {
      const updates = {};
      DEFAULT_LIBRARY_ROWS.forEach((row, i) => {
        const k = push(ref(db, "appState/testPlanLibrary")).key;
        updates[k] = { ...row, is_active: true, sort_order: i + 1, created_at: Date.now(), created_by: actor };
      });
      await update(ref(db, "appState/testPlanLibrary"), updates);
    })();
  }, [templates, isSIAdminUser, actor]);

  const list = Object.entries(templates || {})
    .map(([tid, t]) => ({ tid, ...(t || {}) }))
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const addRow = () => {
    const nextOrder = list.length ? Math.max(...list.map(t => t.sort_order || 0)) + 1 : 1;
    const k = push(ref(db, "appState/testPlanLibrary")).key;
    set(ref(db, `appState/testPlanLibrary/${k}`), {
      test_id: `TPL-${String(nextOrder).padStart(3, "0")}`,
      sird_ref: "", module: "", category: "",
      description: "", pass_criterion: "", phase: "",
      applies_to_fat: true, applies_to_sat: true,
      is_active: true, sort_order: nextOrder,
      created_at: Date.now(), created_by: actor,
    });
    setEditingTid(k);
  };
  const updateField = (tid, field, value) => update(ref(db, `appState/testPlanLibrary/${tid}`), { [field]: value });
  const deleteRow = (tid) => { if (confirm("Delete this row?")) remove(ref(db, `appState/testPlanLibrary/${tid}`)); };
  const editingRow = editingTid ? list.find(r => r.tid === editingTid) : null;

  const check = "✓";
  return (
    <div style={siS.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <h3 style={{ ...siS.h2, fontSize: 14, margin: 0 }}>Test Plan Library</h3>
        <span style={{ fontFamily: SI_F, fontSize: 12, color: siS.textMuted }}>Library rows seed every new FAT/SAT plan.</span>
        <div style={{ flex: 1 }} />
        {isSIAdminUser && (
          <button onClick={addRow}
            style={{ padding: "6px 14px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
            + New row
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <div style={{ color: siS.textMuted, fontFamily: SI_F, fontSize: 13 }}>Library is loading…</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={siS.table}>
            <thead>
              <tr>
                <th style={siS.th}>Test ID</th>
                <th style={siS.th}>SIRD ref</th>
                <th style={siS.th}>Module</th>
                <th style={siS.th}>Category</th>
                <th style={siS.th}>Description</th>
                <th style={siS.th}>Pass criterion</th>
                <th style={siS.th}>Phase</th>
                <th style={{ ...siS.th, textAlign: "center", width: 50 }}>FAT</th>
                <th style={{ ...siS.th, textAlign: "center", width: 50 }}>SAT</th>
                {isSIAdminUser && <th style={{ ...siS.th, width: 110 }}></th>}
              </tr>
            </thead>
            <tbody>
              {list.map(t => (
                <tr key={t.tid}>
                  <td style={{ ...siS.td, color: "#DC2626", fontWeight: 600 }}>{t.test_id}</td>
                  <td style={siS.td}>{t.sird_ref || <span style={{ color: siS.textMuted }}>—</span>}</td>
                  <td style={siS.td}>{t.module || <span style={{ color: siS.textMuted }}>—</span>}</td>
                  <td style={siS.td}>{t.category || <span style={{ color: siS.textMuted }}>—</span>}</td>
                  <td style={siS.td}>{t.description}</td>
                  <td style={siS.td}>{t.pass_criterion}</td>
                  <td style={siS.td}>{t.phase || <span style={{ color: siS.textMuted }}>—</span>}</td>
                  <td style={{ ...siS.td, textAlign: "center", color: t.applies_to_fat !== false ? siS.text : "transparent" }}>{check}</td>
                  <td style={{ ...siS.td, textAlign: "center", color: t.applies_to_sat !== false ? siS.text : "transparent" }}>{check}</td>
                  {isSIAdminUser && (
                    <td style={siS.td}>
                      <button onClick={() => setEditingTid(t.tid)}
                        style={{ padding: "3px 10px", border: `1px solid ${siS.cardBorder}`, borderRadius: 5, background: siS.cardSoft, color: siS.text, fontFamily: SI_F, fontSize: 11.5, fontWeight: 600, cursor: "pointer", marginRight: 4 }}>
                        Edit
                      </button>
                      <button onClick={() => deleteRow(t.tid)}
                        style={{ padding: "3px 10px", border: "1px solid #DC2626", borderRadius: 5, background: "transparent", color: "#DC2626", fontFamily: SI_F, fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>
                        Del
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingRow && (
        <TestPlanLibraryEditModal row={editingRow} onSave={updateField} onClose={() => setEditingTid(null)} />
      )}
    </div>
  );
}

/* Modal for editing a single library row. */
function TestPlanLibraryEditModal({ row, onSave, onClose }) {
  const [form, setForm] = useState({
    test_id: row.test_id || "", sird_ref: row.sird_ref || "",
    module: row.module || "", category: row.category || "",
    description: row.description || "", pass_criterion: row.pass_criterion || "",
    phase: row.phase || "",
    applies_to_fat: row.applies_to_fat !== false,
    applies_to_sat: row.applies_to_sat !== false,
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const saveAll = async () => {
    for (const k of Object.keys(form)) await onSave(row.tid, k, form[k]);
    onClose();
  };
  const inputStyle = { width: "100%", padding: "8px 10px", border: "1px solid #CBD5E1", borderRadius: 6, background: "#1F2937", color: "#F8FAFC", fontFamily: SI_F, fontSize: 13, boxSizing: "border-box" };
  const lbl = { display: "block", fontFamily: SI_F, fontSize: 11, color: "#475569", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 };
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#FFF", borderRadius: 10, padding: 22, width: "min(620px, 94vw)", boxShadow: "0 24px 60px rgba(0,0,0,0.4)" }}>
        <h3 style={{ margin: "0 0 14px", fontFamily: SI_F, fontSize: 16, color: "#0F172A", fontWeight: 700 }}>Edit library row</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div><label style={lbl}>Test ID</label><input value={form.test_id} onChange={e => set("test_id", e.target.value)} style={inputStyle} /></div>
          <div><label style={lbl}>SIRD ref</label><input value={form.sird_ref} onChange={e => set("sird_ref", e.target.value)} style={inputStyle} /></div>
          <div><label style={lbl}>Module</label><input value={form.module} onChange={e => set("module", e.target.value)} style={inputStyle} /></div>
          <div><label style={lbl}>Category</label><input value={form.category} onChange={e => set("category", e.target.value)} style={inputStyle} /></div>
          <div style={{ gridColumn: "1 / -1" }}><label style={lbl}>Description</label><input value={form.description} onChange={e => set("description", e.target.value)} style={inputStyle} /></div>
          <div style={{ gridColumn: "1 / -1" }}><label style={lbl}>Pass criterion</label><input value={form.pass_criterion} onChange={e => set("pass_criterion", e.target.value)} style={inputStyle} /></div>
          <div><label style={lbl}>Phase</label><input value={form.phase} onChange={e => set("phase", e.target.value)} style={inputStyle} /></div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, alignSelf: "end", paddingBottom: 8 }}>
            <label style={{ fontFamily: SI_F, fontSize: 13, color: "#0F172A", display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={form.applies_to_fat} onChange={e => set("applies_to_fat", e.target.checked)} /> FAT
            </label>
            <label style={{ fontFamily: SI_F, fontSize: 13, color: "#0F172A", display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={form.applies_to_sat} onChange={e => set("applies_to_sat", e.target.checked)} /> SAT
            </label>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button onClick={onClose}
            style={{ padding: "8px 16px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#0F172A", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={saveAll}
            style={{ padding: "8px 16px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function SIInspectionSection({ pid, inspection, isSIAdminUser, actor, writeAt, updateAt, removeAt }) {
  const siS = useSIS();
  // Group items by section_title; preserve insertion order via sort_order.
  const items = Object.entries(inspection).map(([iid, it]) => ({ iid, ...(it || {}) }))
    .sort((a, b) => (a.section_title || "").localeCompare(b.section_title || "") || (a.sort_order || 0) - (b.sort_order || 0));
  const sections = [];
  const seen = new Map();
  for (const it of items) {
    const key = it.section_title || "";
    if (!seen.has(key)) { seen.set(key, { title: key, rows: [] }); sections.push(seen.get(key)); }
    seen.get(key).rows.push(it);
  }
  if (sections.length === 0) sections.push({ title: "", rows: [] });

  const addRow = (sectionTitle) => {
    const k = push(ref(db, `appState/siProjects/${pid}/inspection`)).key;
    set(ref(db, `appState/siProjects/${pid}/inspection/${k}`), {
      section_title: sectionTitle || null,
      connectors_covered: "", name: "New row",
      sort_order: items.length + 1, created_at: Date.now(),
    });
  };
  const addSection = () => {
    const title = prompt("Section title (e.g. Midplane (Front / Bayside) Inspection Images):");
    if (title === null) return;
    addRow(title.trim() || null);
  };
  const updateField = (iid, field, value) => updateAt(`appState/siProjects/${pid}/inspection/${iid}`, { [field]: value || null });
  const renameSection = (oldTitle, newTitle) => {
    const updates = {};
    for (const it of items) {
      if ((it.section_title || "") === oldTitle) updates[it.iid] = newTitle || null;
    }
    Object.entries(updates).forEach(([iid, t]) => updateAt(`appState/siProjects/${pid}/inspection/${iid}`, { section_title: t }));
  };
  const onUploadImage = async (iid, file) => {
    if (!file) return;
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
    const storagePath = `siProjectInspection/${pid}/${Date.now()}_${safeName}`;
    const sr = sRef(storage, storagePath);
    await uploadBytes(sr, file, { contentType: file.type || undefined });
    const url = await getDownloadURL(sr);
    updateAt(`appState/siProjects/${pid}/inspection/${iid}`, {
      image_storage_path: storagePath, image_url: url, image_filename: file.name,
    });
  };
  const deleteRow = async (it) => {
    if (!confirm("Delete this row?")) return;
    if (it.image_storage_path) {
      try { await deleteObject(sRef(storage, it.image_storage_path)); } catch (_) { /* */ }
    }
    removeAt(`appState/siProjects/${pid}/inspection/${it.iid}`);
  };

  return (
    <Section title="What we're inspecting" headerExtra={isSIAdminUser && (
      <button onClick={addSection}
        style={{ padding: "5px 12px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#475569", fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ New section</button>
    )}>
      <table style={{ ...siS.table, tableLayout: "fixed" }}>
        <thead>
          <tr>
            <th style={{ ...siS.th, background: "#0F172A", color: "#FFF", width: "25%", borderBottom: "1px solid #0F172A" }}>Connectors Covered</th>
            <th style={{ ...siS.th, background: "#0F172A", color: "#FFF", borderBottom: "1px solid #0F172A" }}>IMAGETYPE (for filename)</th>
            <th style={{ ...siS.th, background: "#0F172A", color: "#FFF", width: 220, textAlign: "center", borderBottom: "1px solid #0F172A" }}>Reference Image</th>
          </tr>
        </thead>
        {sections.map((sec, idx) => (
          <tbody key={idx}>
            <tr>
              <td colSpan={3} style={{ padding: 0, background: "#F1F5F9" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}>
                  <input defaultValue={sec.title} disabled={!isSIAdminUser}
                    placeholder="(Untitled section — click to rename)"
                    onBlur={e => { const v = e.target.value.trim(); if (v !== sec.title) renameSection(sec.title, v); }}
                    style={{ flex: 1, fontFamily: SI_F, fontWeight: 700, color: "#0F172A", fontSize: 13, border: 0, background: "transparent", outline: "none" }} />
                  {isSIAdminUser && (
                    <button onClick={() => addRow(sec.title)}
                      style={{ padding: "3px 8px", border: "1px solid #CBD5E1", borderRadius: 4, background: "transparent", color: "#475569", fontFamily: SI_F, fontSize: 11, cursor: "pointer" }}>+ Add row</button>
                  )}
                </div>
              </td>
            </tr>
            {sec.rows.length === 0 ? (
              <tr><td colSpan={3} style={{ ...siS.td, color: "#94A3B8", textAlign: "center", fontSize: 12 }}>No rows yet.</td></tr>
            ) : sec.rows.map(it => (
              <InspectionRow key={it.iid} it={it} isSIAdminUser={isSIAdminUser}
                onUpdate={(field, value) => updateField(it.iid, field, value)}
                onUploadImage={(file) => onUploadImage(it.iid, file)}
                onDelete={() => deleteRow(it)} />
            ))}
          </tbody>
        ))}
      </table>
    </Section>
  );
}
function InspectionRow({ it, isSIAdminUser, onUpdate, onUploadImage, onDelete }) {
  const siS = useSIS();
  const fileInputRef = useRef(null);
  const { openPreview } = useContext(SIPreviewCtx);
  return (
    <tr>
      <td style={{ ...siS.td, verticalAlign: "middle" }}>
        <input defaultValue={it.connectors_covered || ""} disabled={!isSIAdminUser}
          onBlur={e => onUpdate("connectors_covered", e.target.value.trim())}
          style={{ width: "100%", padding: "5px 8px", border: "1px solid transparent", borderRadius: 4, fontFamily: SI_F, fontSize: 13, fontWeight: 600, color: "#0F172A", background: "transparent" }} />
      </td>
      <td style={{ ...siS.td, verticalAlign: "middle" }}>
        <input defaultValue={it.name || ""} disabled={!isSIAdminUser}
          onBlur={e => onUpdate("name", e.target.value.trim() || "Untitled")}
          style={{ width: "100%", padding: "5px 8px", border: "1px solid transparent", borderRadius: 4, fontFamily: SI_F, fontSize: 13, color: "#0F172A", background: "transparent" }} />
      </td>
      <td style={{ ...siS.td, textAlign: "center", verticalAlign: "middle", position: "relative" }}>
        {it.image_url ? (
          <img src={it.image_url} alt={it.image_filename || it.name}
            onClick={() => openPreview({ filename: it.image_filename || it.name || "image", downloadUrl: it.image_url, mimeType: "image/" })}
            style={{ maxWidth: 200, maxHeight: 120, border: "1px solid #E2E8F0", borderRadius: 4, cursor: "zoom-in" }}
            title="Click to preview full size" />
        ) : isSIAdminUser ? (
          <button onClick={() => fileInputRef.current?.click()}
            style={{ background: "#F1F5F9", border: "1px dashed #CBD5E1", color: "#64748B", padding: "18px 22px", borderRadius: 6, cursor: "pointer", fontFamily: SI_F, fontSize: 12 }}>+ Add image</button>
        ) : (
          <span style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 12 }}>—</span>
        )}
        {isSIAdminUser && (
          <div style={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 4 }}>
            {it.image_url && (
              <button onClick={() => fileInputRef.current?.click()} title="Replace image"
                style={{ background: "#FFF", border: "1px solid #CBD5E1", color: "#475569", width: 22, height: 22, borderRadius: 4, cursor: "pointer", fontSize: 11, lineHeight: 1 }}>↻</button>
            )}
            <button onClick={onDelete} title="Delete row"
              style={{ background: "#FFF", border: "1px solid #FECACA", color: "#DC2626", width: 22, height: 22, borderRadius: 4, cursor: "pointer", fontSize: 13, lineHeight: 1 }}>×</button>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }}
          onChange={e => { onUploadImage(e.target.files?.[0]); e.target.value = ""; }} />
      </td>
    </tr>
  );
}

/* ── Section wrapper ─────────────────────────────────────────────── */
function Section({ title, children, headerExtra }) {
  const siS = useSIS();
  return (
    <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontFamily: SI_F, fontSize: 15, color: "#0F172A" }}>{title}</h3>
        <div style={{ flex: 1 }} />
        {headerExtra}
      </div>
      {children}
    </div>
  );
}

function Field({ label, value, onSave, editing, onStart, onCancel, editable }) {
  const siS = useSIS();
  return (
    <div>
      <div style={{ fontFamily: SI_F, fontSize: 11, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      {editing && editable ? (
        <input autoFocus defaultValue={value || ""}
          onBlur={e => onSave(e.target.value.trim())}
          onKeyDown={e => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") { e.target.value = value || ""; onCancel(); e.target.blur(); } }}
          style={{ fontFamily: SI_F, fontSize: 14, padding: "5px 8px", border: "1px solid #CBD5E1", borderRadius: 6, width: "100%", boxSizing: "border-box", color: "#0F172A" }} />
      ) : (
        <span onClick={editable ? onStart : undefined}
          style={{ cursor: editable ? "text" : "default", fontFamily: SI_F, fontSize: 14, color: value ? "#0F172A" : "#94A3B8" }}>
          {value || (editable ? "Click to add" : "—")}
        </span>
      )}
    </div>
  );
}
function FieldSelect({ label, value, options, onSave, editable }) {
  const siS = useSIS();
  return (
    <div>
      <div style={{ fontFamily: SI_F, fontSize: 11, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      {editable ? (
        <select value={value} onChange={e => onSave(e.target.value)}
          style={{ fontFamily: SI_F, fontSize: 14, padding: "5px 8px", border: "1px solid #CBD5E1", borderRadius: 6, background: "#FFF", color: "#0F172A" }}>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <span style={{ fontFamily: SI_F, fontSize: 14, color: "#0F172A" }}>{value}</span>
      )}
    </div>
  );
}
function FieldBool({ label, value, onSave, editable }) {
  const siS = useSIS();
  return (
    <div>
      <div style={{ fontFamily: SI_F, fontSize: 11, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      {editable ? (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: SI_F, fontSize: 14, color: "#0F172A", cursor: "pointer" }}>
          <input type="checkbox" checked={!!value} onChange={e => onSave(e.target.checked)} />
          {value ? "Yes" : "No"}
        </label>
      ) : (
        <span style={{ fontFamily: SI_F, fontSize: 14, color: "#0F172A" }}>{value ? "Yes" : "No"}</span>
      )}
    </div>
  );
}

/* ── Stations section ────────────────────────────────────────────── */
function SIStationsSection({ pid, stations, isSIAdminUser, actor, deployedFactories, writeAt, updateAt, removeAt }) {
  const siS = useSIS();
  const list = Object.entries(stations).map(([sid, s]) => ({ sid, ...(s || {}) }))
    .sort((a, b) => (a.station_number || 0) - (b.station_number || 0));
  const totalCount = list.reduce((sum, s) => sum + (Number(s.count) || 1), 0);
  const factoryCount = deployedFactories ?? new Set(list.map(s => s.deployment_factory).filter(Boolean)).size;
  const addStation = () => {
    const nextNum = list.length ? Math.max(...list.map(s => s.station_number || 0)) + 1 : 1;
    const newRef = push(ref(db, `appState/siProjects/${pid}/stations`));
    set(newRef, {
      station_number: nextNum,
      name: `Station ${nextNum}`,
      count: 1,
      customer: null,
      deployment_factory: null,
      notes: null,
      fat_result: "pending",
      sat_result: "pending",
      created_at: Date.now(),
    });
    logSIActivity(pid, "station_add", `Added Station ${nextNum}`, actor);
  };
  const resultPill = (r) => {
    const v = (r || "pending").toLowerCase();
    const bg = v === "pass" ? "#DCFCE7" : v === "fail" ? "#FEE2E2" : v === "ncr" ? "#FEF3C7" : "#F1F5F9";
    const fg = v === "pass" ? "#15803D" : v === "fail" ? "#991B1B" : v === "ncr" ? "#92400E" : "#64748B";
    return <span style={{ background: bg, color: fg, padding: "1px 8px", borderRadius: 999, fontSize: 10.5, fontWeight: 700, fontFamily: SI_F, textTransform: "capitalize" }}>{v}</span>;
  };
  return (
    <div style={siS.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h3 style={{ ...siS.h2, fontSize: 14 }}>
          {list.length} station{list.length === 1 ? "" : "s"}
          {factoryCount > 0 && <span style={{ fontWeight: 400, color: "#64748B" }}> · {totalCount} deployed at {factoryCount} factor{factoryCount === 1 ? "y" : "ies"}</span>}
        </h3>
        <div style={{ flex: 1 }} />
        {isSIAdminUser && (
          <button onClick={addStation}
            style={{ padding: "5px 12px", border: "1px solid #2563EB", borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ Add Station</button>
        )}
      </div>
      {list.length === 0 ? (
        <div style={{ color: "#94A3B8", fontSize: 13, fontFamily: SI_F }}>No stations yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={siS.table}>
            <thead>
              <tr>
                <th style={siS.th}>#</th>
                <th style={siS.th}>Name</th>
                <th style={siS.th}>Count</th>
                <th style={siS.th}>Customer</th>
                <th style={siS.th}>Deployment Factory</th>
                <th style={siS.th}>Notes</th>
                <th style={siS.th}>FAT</th>
                <th style={siS.th}>SAT</th>
                {isSIAdminUser && <th style={siS.th}></th>}
              </tr>
            </thead>
            <tbody>
              {list.map(s => (
                <tr key={s.sid}>
                  <td style={{ ...siS.td, color: "#DC2626", fontWeight: 600 }}>{s.station_number}</td>
                  <td style={siS.td}><StationCell value={s.name} editable={isSIAdminUser} onSave={v => { updateAt(`appState/siProjects/${pid}/stations/${s.sid}`, { name: v }); logSIActivity(pid, "station_edit", `Station ${s.station_number} name: ${v}`, actor); }} /></td>
                  <td style={siS.td}><StationCell value={s.count} editable={isSIAdminUser} onSave={v => updateAt(`appState/siProjects/${pid}/stations/${s.sid}`, { count: Number(v) || 1 })} /></td>
                  <td style={siS.td}><StationCell value={s.customer} editable={isSIAdminUser} onSave={v => updateAt(`appState/siProjects/${pid}/stations/${s.sid}`, { customer: v || null })} /></td>
                  <td style={siS.td}><StationCell value={s.deployment_factory} editable={isSIAdminUser} onSave={v => { updateAt(`appState/siProjects/${pid}/stations/${s.sid}`, { deployment_factory: v || null }); logSIActivity(pid, "station_edit", `Station ${s.station_number} factory: ${v || "(cleared)"}`, actor); }} /></td>
                  <td style={siS.td}><StationCell value={s.notes} editable={isSIAdminUser} onSave={v => updateAt(`appState/siProjects/${pid}/stations/${s.sid}`, { notes: v || null })} /></td>
                  <td style={siS.td}>{resultPill(s.fat_result)}</td>
                  <td style={siS.td}>{resultPill(s.sat_result)}</td>
                  {isSIAdminUser && (
                    <td style={siS.td}>
                      <button onClick={() => { if (confirm(`Delete Station ${s.station_number}?`)) { removeAt(`appState/siProjects/${pid}/stations/${s.sid}`); logSIActivity(pid, "station_delete", `Deleted Station ${s.station_number}`, actor); } }}
                        style={{ background: "#FFF", border: "1px solid #FECACA", color: "#DC2626", padding: "1px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: SI_F }}>Del</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
function StationCell({ value, onSave, editable }) {
  const siS = useSIS();
  const [editing, setEditing] = useState(false);
  if (editing && editable) {
    return (
      <input autoFocus defaultValue={value || ""}
        onBlur={e => { onSave(e.target.value.trim()); setEditing(false); }}
        onKeyDown={e => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") { e.target.value = value || ""; setEditing(false); e.target.blur(); } }}
        style={{ fontFamily: SI_F, fontSize: 13, padding: "3px 6px", border: "1px solid #CBD5E1", borderRadius: 5, width: "100%", boxSizing: "border-box", color: "#0F172A" }} />
    );
  }
  return (
    <span onClick={editable ? () => setEditing(true) : undefined}
      style={{ cursor: editable ? "text" : "default", fontFamily: SI_F, fontSize: 13, color: value ? "#0F172A" : "#94A3B8" }}>
      {value || (editable ? "Click to add" : "—")}
    </span>
  );
}

/* ── Stage Timeline section: per-stage planned + actual dates ─────── */
function SIStageDatesSection({ pid, stageDates, isSIAdminUser, actor, updateAt }) {
  const siS = useSIS();
  const onChange = (stage, key, value) => {
    updateAt(`appState/siProjects/${pid}/stage_dates/${stage}`, { [key]: value || null });
    logSIActivity(pid, "stage_date_edit", `${stage} ${key}: ${value || "(cleared)"}`, actor);
  };
  return (
    <Section title="Stage Timeline" headerExtra={isSIAdminUser && (
      <AITimelineImportButton pid={pid} stageDates={stageDates} actor={actor} updateAt={updateAt} />
    )}>
      <div style={{ overflowX: "auto" }}>
        <table style={siS.table}>
          <thead>
            <tr>
              <th style={siS.th}>Stage</th>
              <th style={siS.th}>Planned start</th>
              <th style={siS.th}>Planned end</th>
              <th style={siS.th}>Actual start</th>
              <th style={siS.th}>Actual end</th>
            </tr>
          </thead>
          <tbody>
            {SI_STAGES.map(stage => {
              const d = stageDates[stage] || {};
              const inp = (k) => (
                <input type="date" value={d[k] || ""} disabled={!isSIAdminUser}
                  onChange={e => onChange(stage, k, e.target.value)}
                  style={{ fontFamily: SI_F, fontSize: 13, padding: "3px 6px", border: "1px solid #CBD5E1", borderRadius: 5, color: "#0F172A", background: isSIAdminUser ? "#FFF" : "#F8FAFC" }} />
              );
              return (
                <tr key={stage}>
                  <td style={siS.td}><span style={{ background: SI_STAGE_COLORS[stage], color: "#FFF", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700 }}>{stage}</span></td>
                  <td style={siS.td}>{inp("planned_start")}</td>
                  <td style={siS.td}>{inp("planned_end")}</td>
                  <td style={siS.td}>{inp("actual_start")}</td>
                  <td style={siS.td}>{inp("actual_end")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* ── Documents section: Firebase Storage uploads + Drive links ───── */
const DOC_CATEGORIES = ["sird", "fat", "sat", "coverage", "bom", "misc"];
const DOC_LABELS = { sird: "SIRD", fat: "FAT", sat: "SAT", coverage: "Coverage Doc", bom: "BOM", misc: "Misc" };
function SIDocumentsSection({ pid, project, files, isSIAdminUser, actor, writeAt, removeAt }) {
  const siS = useSIS();
  const byCat = {};
  for (const cat of DOC_CATEGORIES) byCat[cat] = [];
  for (const [fid, f] of Object.entries(files || {})) {
    if (f && DOC_CATEGORIES.includes(f.category)) byCat[f.category].push({ fid, ...f });
  }
  const sirdLatest = Object.values(project?.sird_versions || {}).sort((a, b) => (b.version || 0) - (a.version || 0))[0] || null;
  const fatPlan = project?.test_plans?.fat || null;
  const satPlan = project?.test_plans?.sat || null;

  return (
    <div style={siS.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h3 style={{ ...siS.h2, fontSize: 14 }}>Documents</h3>
        <span style={{ fontFamily: SI_F, fontSize: 11, color: "#64748B" }}>Generate / edit from the Manage menu</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <DocSummaryCard title="SIRD" plan={sirdLatest} kind="sird" pid={pid} project={project} />
        <DocSummaryCard title="FAT"  plan={fatPlan}    kind="fat"  pid={pid} project={project} />
        <DocSummaryCard title="SAT"  plan={satPlan}    kind="sat"  pid={pid} project={project} />
      </div>
      <h4 style={{ margin: "14px 0 8px", fontFamily: SI_F, fontSize: 13, color: "#0F172A", fontWeight: 700 }}>DFM files</h4>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
        <DocZone pid={pid} category="dfm_vendor"   label="From vendor"      files={byCat.dfm_vendor   || []} isSIAdminUser={isSIAdminUser} actor={actor} writeAt={writeAt} removeAt={removeAt} />
        <DocZone pid={pid} category="dfm_feedback" label="Feedback we sent" files={byCat.dfm_feedback || []} isSIAdminUser={isSIAdminUser} actor={actor} writeAt={writeAt} removeAt={removeAt} />
      </div>
    </div>
  );
}

/* SIRD / FAT / SAT summary card with Preview / Download / Manage buttons
   (matches fixture_tracker's docSummaryCard layout). */
function DocSummaryCard({ title, plan, kind, pid, project }) {
  const siS = useSIS();
  const { openPreview } = useContext(SIPreviewCtx);
  const { goToTab } = useContext(SINavCtx);
  const exists = plan && (kind === "sird" ? plan.version : plan.rows);
  const status = kind === "sird"
    ? (plan?.sent_to_vendor_at ? "SENT" : "DRAFT")
    : (plan?.signed_off_at ? "SIGNED" : (plan?.status || "DRAFT")).toUpperCase();
  const statusBg = status === "SENT" || status === "SIGNED" ? "#DCFCE7" : "#FEF3C7";
  const statusFg = status === "SENT" || status === "SIGNED" ? "#15803D" : "#92400E";
  const managerTab = kind === "sird" ? "si_sird_gen" : "si_testplan_gen";
  const managerLabel = kind === "sird" ? "Manage in SIRD Generator" : "Manage in Test Plan Generator";

  // Build a printable HTML preview blob (no Storage round-trip; renders
  // straight from the in-memory snapshot).
  const onPreview = () => {
    if (!exists) return;
    if (kind === "sird") {
      const responses = plan.responses || {};
      const html = `<!doctype html><meta charset="utf-8"><title>${project?.name || "SIRD"} — v${plan.version}</title>
      <style>body{font-family:-apple-system,system-ui,sans-serif;background:#F8FAFC;color:#0F172A;margin:0;padding:32px;}
        .card{background:#FFF;border:1px solid #E2E8F0;border-radius:10px;padding:20px;max-width:760px;margin:0 auto 14px;}
        h1{margin:0 0 8px;font-size:22px;} .meta{color:#64748B;font-size:13px;margin-bottom:14px;}
        h2{margin:18px 0 8px;font-size:16px;color:#0F172A;} .q{font-weight:700;font-size:13px;color:#475569;margin-bottom:2px;}
        .a{font-size:14px;white-space:pre-wrap;margin-bottom:12px;color:#0F172A;} .a.blank{color:#94A3B8;}</style>
      <div class="card"><h1>${(project?.name || "SIRD").replace(/</g,"&lt;")}</h1>
      <div class="meta">SI partner: ${(project?.si_name || "—").replace(/</g,"&lt;")} · Version v${plan.version} · Published ${plan.published_at ? new Date(plan.published_at).toLocaleString() : "—"}</div>
      ${SIRD_SECTIONS.map(sec => `<div class="card"><h2>${sec.title}</h2>${sec.fields.map(f => {
        const v = responses[f.id]; const blank = !v || !String(v).trim();
        return `<div class="q">${f.label}</div><div class="a${blank?" blank":""}">${blank?"(blank)":String(v).replace(/</g,"&lt;")}</div>`;
      }).join("")}</div>`).join("")}`;
      const blob = new Blob([html], { type: "text/html" });
      openPreview({ filename: `${project?.name || "SIRD"} — v${plan.version}.html`, downloadUrl: URL.createObjectURL(blob), mimeType: "text/html" });
    } else {
      // FAT/SAT preview — render the rows as a printable HTML table.
      const rows = Object.values(plan.rows || {}).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      const html = `<!doctype html><meta charset="utf-8"><title>${(project?.name || title)} — ${title}</title>
      <style>body{font-family:-apple-system,system-ui,sans-serif;background:#F8FAFC;color:#0F172A;margin:0;padding:32px;}
        .card{background:#FFF;border:1px solid #E2E8F0;border-radius:10px;padding:20px;max-width:1100px;margin:0 auto;}
        h1{margin:0 0 8px;font-size:22px;} .meta{color:#64748B;font-size:13px;margin-bottom:14px;}
        table{width:100%;border-collapse:collapse;font-size:13px;} th{background:#F9FAFB;text-align:left;padding:8px;border-bottom:1px solid #E2E8F0;color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:.4px;}
        td{padding:8px;border-bottom:1px solid #F1F5F9;vertical-align:top;}
        .pill{padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;text-transform:capitalize;}
        .pass{background:#DCFCE7;color:#15803D;} .fail{background:#FEE2E2;color:#991B1B;} .ncr{background:#FEF3C7;color:#92400E;} .pending{background:#F1F5F9;color:#64748B;}</style>
      <div class="card"><h1>${(project?.name || "").replace(/</g,"&lt;")} — ${title} v${plan.version || 1}</h1>
      <div class="meta">Status: ${(plan.status || "draft")}${plan.signed_off_at ? ` · Signed off ${new Date(plan.signed_off_at).toLocaleDateString()}` : ""}</div>
      <table><thead><tr><th>Test ID</th><th>Description</th><th>Pass criterion</th><th>Result</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${(r.test_id || "").replace(/</g,"&lt;")}</td><td>${(r.description || "").replace(/</g,"&lt;")}</td><td>${(r.pass_criterion || "").replace(/</g,"&lt;")}</td><td><span class="pill ${r.result || "pending"}">${r.result || "pending"}</span></td></tr>`).join("")}
      </tbody></table></div>`;
      const blob = new Blob([html], { type: "text/html" });
      openPreview({ filename: `${project?.name || ""} — ${title} v${plan.version || 1}.html`, downloadUrl: URL.createObjectURL(blob), mimeType: "text/html" });
    }
  };

  // Download — same docx export as the SIRD generator, or xlsx for plans.
  const onDownload = async () => {
    if (!exists) return;
    if (kind === "sird") {
      // Reuse the docx generation code by building a Doc inline.
      const responsesSnapshot = plan.responses || {};
      const sections = SIRD_SECTIONS.map(sec => {
        const blocks = [new DocxParagraph({ text: sec.title, heading: DocxHeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } })];
        for (const f of sec.fields) {
          blocks.push(new DocxParagraph({ children: [new DocxTextRun({ text: f.label, bold: true })] }));
          const answer = responsesSnapshot[f.id];
          blocks.push(new DocxParagraph({ children: [new DocxTextRun({ text: answer && String(answer).trim() ? String(answer) : "(blank)" })], spacing: { after: 120 } }));
        }
        return blocks;
      }).flat();
      const doc = new DocxDocument({ sections: [{ properties: {}, children: [
        new DocxParagraph({ text: project?.name || "SIRD", heading: DocxHeadingLevel.TITLE }),
        new DocxParagraph({ children: [new DocxTextRun({ text: `SI partner: ${project?.si_name || "—"}  ·  Version ${plan.version}  ·  Published ${plan.published_at ? new Date(plan.published_at).toLocaleString() : "—"}`, italics: true, color: "64748B" })], spacing: { after: 240 } }),
        ...sections,
      ]}]});
      const blob = await DocxPacker.toBlob(doc);
      _triggerDownload(blob, `${(project?.name || "SIRD").replace(/[^A-Za-z0-9._-]/g, "_")}_SIRD_v${plan.version}.docx`);
    } else {
      const rows = Object.values(plan.rows || {}).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      const ws = XLSX.utils.json_to_sheet(rows.map(r => ({
        "Test ID": r.test_id || "",
        Description: r.description || "",
        "Pass criterion": r.pass_criterion || "",
        Result: r.result || "pending",
      })));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, title);
      const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      _triggerDownload(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        `${(project?.name || title).replace(/[^A-Za-z0-9._-]/g, "_")}_${title}_v${plan.version || 1}.xlsx`);
    }
  };

  const btn = (label, onClick, style) => (
    <button onClick={onClick}
      style={{ padding: "3px 10px", border: "1px solid #2563EB", borderRadius: 4, background: "#FFF", color: "#2563EB", fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer", ...style }}>
      {label}
    </button>
  );

  return (
    <div style={{ background: siS.cardSoft, border: "1px solid #E2E8F0", borderRadius: 6, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontFamily: SI_F, fontSize: 13, fontWeight: 600, color: "#0F172A" }}>
          {kind === "sird" && plan ? `Last sent ${title} — v${plan.version}` : exists ? `${title} — v${plan.version || 1}` : title}
        </div>
        {exists && <span style={{ background: statusBg, color: statusFg, padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700, fontFamily: SI_F }}>{status}</span>}
      </div>
      {!exists ? (
        <>
          <div style={{ color: "#94A3B8", fontSize: 12, fontFamily: SI_F, marginBottom: 8 }}>No {title} yet</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={() => goToTab(managerTab)}
              style={{ background: "none", border: 0, padding: 0, color: siS.link, fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer", textDecoration: "underline" }}>
              ↗ {managerLabel}
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 11, color: "#64748B", fontFamily: SI_F, marginBottom: 6 }}>
            {kind === "sird"
              ? <>Published {plan.published_at ? new Date(plan.published_at).toLocaleString() : "—"}</>
              : <>{Object.values(plan.rows || {}).filter(r => (r.result || "").toLowerCase() === "pass").length} pass · {" "}
                 {Object.values(plan.rows || {}).filter(r => (r.result || "").toLowerCase() === "fail").length} fail · {" "}
                 {Object.values(plan.rows || {}).filter(r => !["pass", "fail"].includes((r.result || "").toLowerCase())).length} pending</>}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {btn("👁 Preview", onPreview)}
            <button onClick={onDownload}
              style={{ background: "none", border: 0, padding: 0, color: "#2563EB", fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer", textDecoration: "underline" }}>
              ↓ Download{kind === "sird" ? "" : " xlsx"}
            </button>
            <button onClick={() => goToTab(managerTab)}
              style={{ background: "none", border: 0, padding: 0, color: siS.link, fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer", textDecoration: "underline" }}>
              ↗ {managerLabel}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Trigger a browser download from a Blob.
function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function DocZone({ pid, category, label, files, isSIAdminUser, actor, writeAt, removeAt }) {
  const siS = useSIS();
  const fileInputRef = useRef(null);
  const { openPreview } = useContext(SIPreviewCtx);
  const onUpload = async (file) => {
    if (!file) return;
    try {
      const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
      const ts = Date.now();
      const storagePath = `siProjectFiles/${pid}/${category}/${ts}_${safeName}`;
      const sr = sRef(storage, storagePath);
      await uploadBytes(sr, file);
      const url = await getDownloadURL(sr);
      const newRef = push(ref(db, `appState/siProjects/${pid}/files`));
      await set(newRef, {
        category, kind: "file", filename: file.name,
        storagePath, downloadUrl: url, size: file.size,
        uploaded_at: ts,
      });
      logSIActivity(pid, "file_upload", `Uploaded ${file.name} to ${category.toUpperCase()}`, actor);
    } catch (e) {
      alert("Upload failed: " + (e?.message || e));
    }
  };
  const onAddLink = async () => {
    const url = prompt("Paste the Google Drive (or other) URL:");
    if (!url) return;
    const name = prompt("Display name (optional):", "") || url;
    const newRef = push(ref(db, `appState/siProjects/${pid}/files`));
    await set(newRef, {
      category, kind: "link", filename: name.trim(), url: url.trim(),
      uploaded_at: Date.now(),
    });
    logSIActivity(pid, "file_link", `Added link "${name.trim()}" to ${category.toUpperCase()}`, actor);
  };
  const onDelete = async (f) => {
    if (!confirm(`Delete "${f.filename}"?`)) return;
    if (f.storagePath) {
      try { await deleteObject(sRef(storage, f.storagePath)); } catch (_) { /* may already be gone */ }
    }
    removeAt(`appState/siProjects/${pid}/files/${f.fid}`);
    logSIActivity(pid, "file_delete", `Removed ${f.filename} from ${category.toUpperCase()}`, actor);
  };
  return (
    <div style={{ background: siS.cardSoft, border: `1px solid ${siS.cardBorder}`, borderRadius: 8, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ fontFamily: SI_F, fontSize: 13, fontWeight: 700, color: siS.text }}>{label}</div>
        <span style={{ fontFamily: SI_F, fontSize: 11, color: siS.textMuted }}>{files.length} item{files.length === 1 ? "" : "s"}</span>
        <div style={{ flex: 1 }} />
        {isSIAdminUser && (
          <>
            <button onClick={() => fileInputRef.current?.click()}
              style={{ padding: "3px 10px", border: `1px solid ${siS.link}`, borderRadius: 4, background: "transparent", color: siS.link, fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>↑ Upload</button>
            <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={e => { onUpload(e.target.files?.[0]); e.target.value = ""; }} />
            <button onClick={onAddLink}
              style={{ padding: "3px 10px", border: `1px solid ${siS.cardBorder}`, borderRadius: 4, background: "transparent", color: siS.text, fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>🔗 Add link</button>
          </>
        )}
      </div>
      {files.length === 0 ? (
        <div style={{ color: siS.textMuted, fontFamily: SI_F, fontSize: 12 }}>No items yet.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {files.map(f => (
            <li key={f.fid} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", fontFamily: SI_F, fontSize: 12, borderTop: `1px dotted ${siS.cardBorder}`, color: siS.text }}>
              <span>{f.kind === "link" ? "🔗" : "📄"}</span>
              {f.kind === "link" ? (
                <a href={f.url} target="_blank" rel="noopener"
                   style={{ color: siS.link, textDecoration: "none", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                   title={f.url}>{f.filename}</a>
              ) : (
                <button onClick={() => openPreview({ filename: f.filename, downloadUrl: f.downloadUrl, mimeType: f.mimeType })}
                  style={{ background: "transparent", border: 0, padding: 0, color: siS.link, textDecoration: "none", cursor: "pointer", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left", fontFamily: SI_F, fontSize: 12 }}
                  title={`Preview ${f.filename}`}>{f.filename}</button>
              )}
              {isSIAdminUser && (
                <button onClick={() => onDelete(f)}
                  style={{ background: "transparent", border: 0, color: "#DC2626", fontSize: 14, cursor: "pointer", lineHeight: 1 }}>×</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Pipeline summary — 9-column grid of stage tiles (matches
   fixture_tracker's renderDashboard exactly). */
function SIPipelineCounters({ projectList }) {
  const siS = useSIS();
  const counts = {};
  for (const s of SI_STAGES) counts[s] = 0;
  for (const p of projectList) { const es = effectiveStage(p); counts[es] = (counts[es] || 0) + 1; }
  return (
    <div style={siS.card}>
      <h2 style={{ ...siS.h2, fontSize: 15, marginBottom: 10 }}>Pipeline</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(9, 1fr)", gap: 8 }}>
        {SI_STAGES.map(s => (
          <div key={s} style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 8, padding: 8, textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#0F172A", fontFamily: SI_F }}>{counts[s]}</div>
            <div style={{ fontSize: 11, color: "#64748B", marginTop: 2, fontFamily: SI_F }}>{s}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* Derive a project's effective current_stage from stage_dates.
   Mirrors fixture_tracker's services/stage_derivation.derive_current_stage,
   with one extension: when every stage has actual_end, advance to "Live"
   (fixture_tracker would just leave current_stage alone). */
function deriveCurrentStage(stageDates, fallback = "SIRD") {
  const sd = stageDates || {};
  const today = new Date(); today.setHours(0,0,0,0);
  // A stage is "completed" only when actual_end is set AND already in the past.
  // A future actual_end means "scheduled to end on" — the stage is still in progress.
  const isCompleted = (d) => {
    if (!d?.actual_end) return false;
    const ae = new Date(d.actual_end); ae.setHours(0,0,0,0);
    return !isNaN(ae) && ae <= today;
  };
  let inProgress = null;
  for (const s of SI_STAGES) {
    const d = sd[s] || {};
    if (d.actual_start && !isCompleted(d)) inProgress = s;
  }
  if (inProgress) return inProgress;
  for (const s of SI_STAGES) {
    const d = sd[s] || {};
    if (!isCompleted(d)) return s;
  }
  return "Live";
}

/* Effective stage for a project — derives from stage_dates if any stage has
   actual data, otherwise falls back to the stored current_stage field. */
function effectiveStage(p) {
  const sd = p?.stage_dates || {};
  const hasAnyActual = SI_STAGES.some(s => (sd[s] || {}).actual_start || (sd[s] || {}).actual_end);
  return hasAnyActual ? deriveCurrentStage(sd, p?.current_stage) : (p?.current_stage || "SIRD");
}

/* Deterministic "what's next" hint based on current_stage + blocked.
   Mirrors fixture_tracker's _whats_next() logic. */
function whatsNext(p) {
  if (p.is_blocked) return `Unblock: ${p.block_reason || "reason missing"}`;
  const s = effectiveStage(p);
  if (s === "SIRD")       return "Publish + send SIRD";
  if (s === "DFM")        return "Receive DFM feedback from SI";
  if (s === "Quote")      return "Approve quote";
  if (s === "PO")         return "Issue PO";
  if (s === "Build") {
    const fat = p.stage_dates?.FAT?.planned_start;
    if (fat) return `Prep FAT (${fat})`;
    return "Monitor build progress";
  }
  if (s === "FAT")        return "Run FAT + sign-off";
  if (s === "In Transit") {
    const sat = p.stage_dates?.SAT?.planned_start;
    return sat ? `Track shipment (SAT ${sat})` : "Track shipment";
  }
  if (s === "SAT")        return "Run SAT at customer site";
  if (s === "Live")       return "Post-launch hand-off";
  return "—";
}

/* ── Dashboard bottom 2x2 — mirrors fixture_tracker's layout exactly:
   FAT panel | On hold | SAT panel | Recent Activity (project-wide).
   The first three are derived locally; Recent Activity reads from RTDB
   at appState/siActivityLog/. */
function SIDashboardBottomGrid({ projectList, onOpen }) {
  const siS = useSIS();
  const today = new Date(); today.setHours(0,0,0,0);
  const in28 = new Date(today); in28.setDate(today.getDate() + 28);
  const parseISO = (s) => { if (!s) return null; const d = new Date(s); d.setHours(0,0,0,0); return isNaN(d) ? null : d; };
  const past28 = new Date(today); past28.setDate(today.getDate() - 28);
  // Completed = actual_end set AND already in the past (≤ today).
  // A future actual_end means "scheduled to end on", not "ended" — still ongoing.
  const bucket = (sd) => {
    if (!sd) return null;
    const ps = parseISO(sd.planned_start), pe = parseISO(sd.planned_end);
    const as = parseISO(sd.actual_start),  ae = parseISO(sd.actual_end);
    if (ae && ae <= today) return null;            // truly completed
    if (as) return "ongoing";                      // started, not yet finished
    if (ae && ae > today) return "ongoing";        // expected to finish in the future
    if (ps && pe && ps <= today && today <= pe) return "ongoing";
    if (ps && today <= ps && ps <= in28) return "upcoming";
    return null;
  };
  // Show actual range when present, otherwise planned dates.
  const displayDateFor = (sd) => {
    if (!sd) return "—";
    const s = sd.actual_start || sd.planned_start || "";
    const e = sd.actual_end   || sd.planned_end   || "";
    if (s && e) return `${s} → ${e}`;
    return s || e || "—";
  };
  // Recently completed — actual_end within the last 28 days AND in the past.
  const completedWithin = (sd) => {
    if (!sd) return null;
    const ae = parseISO(sd.actual_end);
    if (!ae) return null;
    if (ae > today) return null;          // not actually completed yet
    if (ae < past28) return null;         // older than 28 days
    return sd.actual_end;
  };
  const fatRows = [], satRows = [], heldRows = [], completedRows = [];
  for (const p of projectList) {
    if (p.is_blocked) { heldRows.push(p); continue; }
    const fb = bucket(p.stage_dates?.FAT); if (fb) fatRows.push({ ...p, _status: fb, _date: displayDateFor(p.stage_dates?.FAT) });
    const sb = bucket(p.stage_dates?.SAT); if (sb) satRows.push({ ...p, _status: sb, _date: displayDateFor(p.stage_dates?.SAT) });
    const fc = completedWithin(p.stage_dates?.FAT); if (fc) completedRows.push({ ...p, _stage: "FAT", _date: fc });
    const sc = completedWithin(p.stage_dates?.SAT); if (sc) completedRows.push({ ...p, _stage: "SAT", _date: sc });
  }
  const sortByBucket = (a, b) => (a._status === "ongoing" ? 0 : 1) - (b._status === "ongoing" ? 0 : 1) || (a._date || "").localeCompare(b._date || "");
  fatRows.sort(sortByBucket); satRows.sort(sortByBucket);
  // Newest completion first.
  completedRows.sort((a, b) => (b._date || "").localeCompare(a._date || ""));
  const statusPill = (s) => s === "ongoing"
    ? <span style={{ marginLeft: 6, background: "#DCFCE7", color: "#15803D", padding: "1px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 700 }}>ONGOING</span>
    : <span style={{ marginLeft: 6, background: "#DBEAFE", color: "#1D4ED8", padding: "1px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 700 }}>UPCOMING</span>;
  const panel = (title, list, render, empty = "None.") => (
    <div style={siS.card}>
      <h2 style={{ ...siS.h2, fontSize: 15, marginBottom: 10 }}>{title}</h2>
      {list.length === 0
        ? <div style={{ color: "#64748B", fontFamily: SI_F, fontSize: 12 }}>{empty}</div>
        : <ul style={{ margin: 0, paddingLeft: 18 }}>{list.map(render)}</ul>}
    </div>
  );
  const completedPill = <span style={{ marginLeft: 6, background: "#D1FAE5", color: "#047857", padding: "1px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 700 }}>COMPLETED</span>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
      {panel("FAT — ongoing & upcoming (28d)", fatRows, p => (
        <li key={p.pid} style={{ fontFamily: SI_F, fontSize: 12.5, marginBottom: 3 }}>
          <button onClick={() => onOpen(p.pid)} style={{ background: "none", border: 0, padding: 0, color: "#2563EB", textDecoration: "underline", cursor: "pointer", fontFamily: SI_F, fontSize: 12.5 }}>{p.name}</button>
          {" — " + (p._date || "—")}
          {statusPill(p._status)}
        </li>
      ))}
      {panel("On hold", heldRows, p => (
        <li key={p.pid} style={{ fontFamily: SI_F, fontSize: 12.5, marginBottom: 4 }}>
          <button onClick={() => onOpen(p.pid)} style={{ background: "none", border: 0, padding: 0, color: "#2563EB", textDecoration: "underline", cursor: "pointer", fontFamily: SI_F, fontSize: 12.5 }}>{p.name}</button>
          {" — " + (p.block_reason || "no reason")}
        </li>
      ))}
      {panel("SAT — ongoing & upcoming (28d)", satRows, p => (
        <li key={p.pid} style={{ fontFamily: SI_F, fontSize: 12.5, marginBottom: 3 }}>
          <button onClick={() => onOpen(p.pid)} style={{ background: "none", border: 0, padding: 0, color: "#2563EB", textDecoration: "underline", cursor: "pointer", fontFamily: SI_F, fontSize: 12.5 }}>{p.name}</button>
          {" — " + (p._date || "—")}
          {statusPill(p._status)}
        </li>
      ))}
      {panel("Recently completed (28d)", completedRows, r => (
        <li key={`${r.pid}-${r._stage}`} style={{ fontFamily: SI_F, fontSize: 12.5, marginBottom: 3 }}>
          <button onClick={() => onOpen(r.pid)} style={{ background: "none", border: 0, padding: 0, color: "#2563EB", textDecoration: "underline", cursor: "pointer", fontFamily: SI_F, fontSize: 12.5 }}>{r.name}</button>
          {" — " + r._stage + " · " + (r._date || "—")}
          {completedPill}
        </li>
      ))}
      <div style={{ gridColumn: "1 / -1" }}>
        <SIRecentActivityGlobal projectList={projectList} />
      </div>
    </div>
  );
}

function SIRecentActivityGlobal({ projectList }) {
  const siS = useSIS();
  const [entries, setEntries] = useState([]);
  useEffect(() => {
    const r = ref(db, "appState/siActivityLog");
    return onValue(r, s => {
      const val = s.val() || {};
      const list = [];
      for (const [pid, perProj] of Object.entries(val)) {
        for (const [k, e] of Object.entries(perProj || {})) {
          list.push({ k, pid, ...(e || {}) });
        }
      }
      list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      setEntries(list.slice(0, 10));
    });
  }, []);
  const nameOf = (pid) => projectList.find(p => p.pid === pid)?.name || "—";
  return (
    <div style={siS.card}>
      <h2 style={{ ...siS.h2, fontSize: 15, marginBottom: 10 }}>Recent Activity</h2>
      {entries.length === 0
        ? <div style={{ color: "#64748B", fontFamily: SI_F, fontSize: 12 }}>No recent activity.</div>
        : entries.map(e => (
            <div key={e.k} style={{ display: "flex", gap: 8, padding: "6px 0", borderBottom: "1px dotted #E2E8F0", fontFamily: SI_F, fontSize: 12 }}>
              <div style={{ color: "#64748B", width: 130, flex: "0 0 130px" }}>{e.timestamp ? new Date(e.timestamp).toLocaleString() : "—"}</div>
              <div style={{ color: "#64748B", width: 110, flex: "0 0 110px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nameOf(e.pid)}</div>
              <div>{e.summary || e.type || ""}</div>
            </div>
          ))}
    </div>
  );
}

/* ── Dashboard widgets (legacy, no longer used by dashboard tab; kept
   in case other code references it) ──────────────────────────────── */
function SIDashboardWidgets({ projectList, onOpen }) {
  const siS = useSIS();
  const today = new Date(); today.setHours(0,0,0,0);
  const in28 = new Date(today); in28.setDate(today.getDate() + 28);
  const parseISO = (s) => { if (!s) return null; const d = new Date(s); d.setHours(0,0,0,0); return isNaN(d) ? null : d; };
  const bucket = (sd) => {
    if (!sd) return null;
    const ps = parseISO(sd.planned_start), pe = parseISO(sd.planned_end);
    const as = parseISO(sd.actual_start),  ae = parseISO(sd.actual_end);
    // Stage is completed once actual_end is set — drop from ongoing/upcoming.
    if (ae) return null;
    if (as) return "ongoing";
    if (ps && pe && ps <= today && today <= pe) return "ongoing";
    if (ps && today <= ps && ps <= in28) return "upcoming";
    return null;
  };
  const fatRows = [], satRows = [], heldRows = [];
  for (const p of projectList) {
    if (p.is_blocked) { heldRows.push(p); continue; }
    const fatBucket = bucket(p.stage_dates?.FAT);
    if (fatBucket) fatRows.push({ ...p, _status: fatBucket, _date: p.stage_dates?.FAT?.planned_start });
    const satBucket = bucket(p.stage_dates?.SAT);
    if (satBucket) satRows.push({ ...p, _status: satBucket, _date: p.stage_dates?.SAT?.planned_start });
  }
  const sortByBucket = (a, b) => (a._status === "ongoing" ? 0 : 1) - (b._status === "ongoing" ? 0 : 1) || (a._date || "").localeCompare(b._date || "");
  fatRows.sort(sortByBucket); satRows.sort(sortByBucket);
  const pill = (s) => s === "ongoing"
    ? <span style={{ background: "#DCFCE7", color: "#15803D", padding: "1px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 700 }}>ONGOING</span>
    : <span style={{ background: "#DBEAFE", color: "#1D4ED8", padding: "1px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 700 }}>UPCOMING</span>;
  const widget = (title, rows, dateLabel) => (
    <div style={siS.card}>
      <h3 style={{ margin: "0 0 10px", fontFamily: SI_F, fontSize: 14, color: "#0F172A" }}>{title}</h3>
      {rows.length === 0
        ? <div style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 13 }}>None.</div>
        : <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {rows.map(r => (
              <li key={r.pid} style={{ padding: "5px 0", borderTop: "1px dotted #E2E8F0", display: "flex", alignItems: "center", gap: 8, fontFamily: SI_F, fontSize: 13 }}>
                <button onClick={() => onOpen(r.pid)} style={{ background: "none", border: 0, padding: 0, color: "#2563EB", cursor: "pointer", fontFamily: SI_F, fontSize: 13, fontWeight: 600, flex: 1, textAlign: "left" }}>{r.name}</button>
                <span style={{ color: "#64748B" }}>{r._date || (dateLabel === "fat" ? r.fat_date : r.sat_date) || ""}</span>
                {r._status && pill(r._status)}
              </li>
            ))}
          </ul>}
    </div>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
      {widget("FAT — ongoing & upcoming (28d)", fatRows, "fat")}
      {widget("SAT — ongoing & upcoming (28d)", satRows, "sat")}
      <div style={siS.card}>
        <h3 style={{ margin: "0 0 10px", fontFamily: SI_F, fontSize: 14, color: "#0F172A" }}>On hold</h3>
        {heldRows.length === 0
          ? <div style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 13 }}>None.</div>
          : <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {heldRows.map(r => (
                <li key={r.pid} style={{ padding: "5px 0", borderTop: "1px dotted #E2E8F0", fontFamily: SI_F, fontSize: 13 }}>
                  <button onClick={() => onOpen(r.pid)} style={{ background: "none", border: 0, padding: 0, color: "#2563EB", cursor: "pointer", fontFamily: SI_F, fontSize: 13, fontWeight: 600 }}>{r.name}</button>
                </li>
              ))}
            </ul>}
      </div>
    </div>
  );
}

/* ── Timeline Gantt (top-level) ───────────────────────────────────── */
function SIGanttView({ projectList, onOpen, theme, actor }) {
  const siS = useSIS();
  // Default 12-month window centered on today.
  const todayYM = useMemo(() => { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() }; }, []);
  const ymToStr = ({ y, m }) => `${y}-${String(m + 1).padStart(2, "0")}`;
  const strToYM = (s) => { const [y, m] = s.split("-").map(Number); return { y, m: m - 1 }; };
  const shifted = (ym, n) => { const d = new Date(ym.y, ym.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; };
  const [fromYM, setFromYM] = useState(() => ymToStr(shifted(todayYM, -1)));
  const [toYM,   setToYM]   = useState(() => ymToStr(shifted(todayYM, 4)));
  const [groupBy, setGroupBy] = useState("si_name");
  const [showPlanned, setShowPlanned] = useState(false);
  const [showActual,  setShowActual]  = useState(true);
  const [vendorUploadOpen, setVendorUploadOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  // Inverted from "collapsed" so the default (empty set) means everything is
  // collapsed — only pids the user has explicitly opened render their 9 stage
  // sub-rows.
  const [expandedProjects, setExpandedProjects] = useState({}); // pid → expanded
  const [editPopover, setEditPopover] = useState(null);
  const [slideOutPid, setSlideOutPid] = useState(null);

  // Timeline follows the user's chosen theme (dark or light). Dark by
  // default matches fixture_tracker, but the top-bar toggle flips it.
  const T = THEMES[theme] || THEMES.dark;
  const TL_BG     = T.cardBg;     // panel bg
  const TL_PAGE   = T.pageBg;     // outer page
  const TL_BORDER = T.cardBorder;
  const TL_TEXT   = T.text;
  const TL_MUTED  = T.textMuted;
  const TL_HOVER  = T.cardSoft;

  const months = useMemo(() => {
    const a = strToYM(fromYM), b = strToYM(toYM);
    const arr = []; let cur = { ...a };
    while (cur.y < b.y || (cur.y === b.y && cur.m <= b.m)) { arr.push({ ...cur }); cur = shifted(cur, 1); }
    return arr;
  }, [fromYM, toYM]);
  if (months.length === 0) {
    return <div style={{ ...siS.card, color: TL_MUTED }}>Date range is empty. Adjust From/To.</div>;
  }
  const start = new Date(months[0].y, months[0].m, 1);
  const end   = new Date(months[months.length-1].y, months[months.length-1].m+1, 0);
  const totalDays = Math.round((end - start) / 86400000) + 1;
  const pct = (iso) => {
    if (!iso) return null;
    const d = new Date(iso); if (isNaN(d)) return null;
    const days = (d - start) / 86400000;
    if (days < 0 || days > totalDays) return null;
    return (days / totalDays) * 100;
  };
  const monthLabel = ({ y, m }) => new Date(y, m, 1).toLocaleString(undefined, { month: "short", year: "2-digit" }).toUpperCase();
  const todayPct = (() => { const t = new Date(); t.setHours(0,0,0,0); return pct(t.toISOString().slice(0,10)); })();

  // Group projects.
  const groups = useMemo(() => {
    if (groupBy === "none") return [{ key: "All", projects: projectList }];
    const keyOf = (p) => (groupBy === "si_name" ? p.si_name : groupBy === "customer" ? p.customer : p.cm_site) || "Unassigned";
    const map = new Map();
    for (const p of projectList) {
      const k = keyOf(p);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([key, projects]) => ({ key, projects }));
  }, [projectList, groupBy]);

  const renderStageBar = (stage, p, d, withinSubRow, opts = {}) => {
    const lp = pct(d?.planned_start), rp = pct(d?.planned_end);
    const la = pct(d?.actual_start),  ra = pct(d?.actual_end || d?.actual_start);
    const openEdit = (e) => {
      e.stopPropagation();
      setEditPopover({ pid: p.pid, stage, project: p, anchor: e.currentTarget.getBoundingClientRect() });
    };
    const showP = showPlanned && lp != null && rp != null && rp > lp;
    const showA = showActual  && la != null && ra != null && ra >= la;
    const containsAnyDate = showP || showA;
    // Compact mode — used inside the collapsed project row.
    // Mirrors fixture_tracker: two stacked lanes, height 15, planned at top 4, actual at top 19.
    if (opts.compact) {
      if (!containsAnyDate) return null;
      return (
        <React.Fragment key={stage}>
          {showP && (
            <div title={`${stage} planned: ${d.planned_start} → ${d.planned_end}`}
              style={{ position: "absolute", left: `${lp}%`, width: `${rp - lp}%`, top: 4, height: 15, background: SI_STAGE_COLORS[stage], opacity: 0.45, borderRadius: 3, pointerEvents: "none" }} />
          )}
          {showA && (
            <div title={`${stage} actual: ${d.actual_start}${d.actual_end ? ` → ${d.actual_end}` : ""}`}
              style={{ position: "absolute", left: `${la}%`, width: `${Math.max(1, ra - la)}%`, top: 19, height: 15, background: SI_STAGE_COLORS[stage], borderRadius: 3, pointerEvents: "none", display: "flex", alignItems: "center", padding: "0 4px", color: "#FFF", fontFamily: SI_F, fontSize: 10, fontWeight: 700 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stage}</span>
            </div>
          )}
        </React.Fragment>
      );
    }
    if (withinSubRow && !containsAnyDate) {
      // "+ Add" empty-stage button for sub-rows
      return (
        <button key={stage} onClick={() => setEditPopover({ pid: p.pid, stage, project: p, anchor: { left: 8, bottom: 0, right: 0, top: 0 } })}
          style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", padding: "1px 10px", border: `1px dashed ${TL_MUTED}`, borderRadius: 999, background: "transparent", color: TL_MUTED, fontFamily: SI_F, fontSize: 10.5, fontWeight: 600, cursor: "pointer" }}>
          + Add
        </button>
      );
    }
    // Sub-row bars — fixture_tracker uses a single 14px-tall band centered in the 28px sub-row;
    // planned and actual overlap at the same position with planned fainter (opacity 0.45).
    return (
      <React.Fragment key={stage}>
        {showP && (
          <div onClick={openEdit} title={`${stage} planned: ${d.planned_start} → ${d.planned_end}`}
            style={{ position: "absolute", left: `${lp}%`, width: `${rp - lp}%`, top: 7, height: 14, background: SI_STAGE_COLORS[stage], opacity: 0.45, borderRadius: 3, cursor: "pointer" }}>
          </div>
        )}
        {showA && (
          <div onClick={openEdit} title={`${stage} actual: ${d.actual_start}${d.actual_end ? ` → ${d.actual_end}` : ""}`}
            style={{ position: "absolute", left: `${la}%`, width: `${Math.max(1, ra - la)}%`, top: 7, height: 14, background: SI_STAGE_COLORS[stage], borderRadius: 3, cursor: "pointer", display: "flex", alignItems: "center", padding: "0 5px", color: "#FFF", fontFamily: SI_F, fontSize: 10, fontWeight: 700 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stage}</span>
          </div>
        )}
      </React.Fragment>
    );
  };

  // Toggle button (used by Planned/Actual + Group by)
  const toggleBtn = (active, label, onClick) => (
    <button onClick={onClick}
      style={{
        padding: "5px 12px", borderRadius: 6,
        border: `1px solid ${active ? "#1d4ed8" : TL_BORDER}`,
        background: active ? "#1e3a8a" : "transparent",
        color: active ? "#bfdbfe" : TL_MUTED,
        fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer",
      }}>{label}</button>
  );
  const groupBtn = (id, label) => (
    <button onClick={() => setGroupBy(id)}
      style={{
        padding: "5px 12px", borderRadius: 6,
        border: `1px solid ${groupBy === id ? "#1d4ed8" : TL_BORDER}`,
        background: groupBy === id ? "#1e3a8a" : "transparent",
        color: groupBy === id ? "#bfdbfe" : TL_MUTED,
        fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer",
      }}>{label}</button>
  );

  const LABEL_W = 200;

  return (
    <div style={{ background: TL_PAGE, color: TL_TEXT, margin: "-24px -32px -80px", padding: "16px 24px 80px", minHeight: "calc(100vh - 56px)" }}>
      {/* Controls bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", flexWrap: "wrap", marginBottom: 14 }}>
        <span style={{ fontFamily: SI_F, fontSize: 10.5, color: TL_MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ display: "inline-block", width: 14, height: 6, background: "#3B82F6", opacity: 0.5, borderRadius: 2 }}></span>PLANNED
        </span>
        <span style={{ fontFamily: SI_F, fontSize: 10.5, color: TL_MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ display: "inline-block", width: 14, height: 6, background: "#3B82F6", borderRadius: 2 }}></span>ACTUAL
        </span>
        {toggleBtn(showPlanned, "Planned", () => setShowPlanned(v => !v))}
        {toggleBtn(showActual,  "Actual",  () => setShowActual(v => !v))}
        <span style={{ marginLeft: 12, fontFamily: SI_F, fontSize: 10.5, color: TL_MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>GROUP BY</span>
        {groupBtn("si_name",  "SI")}
        {groupBtn("customer", "Customer")}
        {groupBtn("cm_site",  "Factory")}
        <button onClick={() => setVendorUploadOpen(true)}
          style={{ padding: "5px 12px", border: "1px solid #2563EB", borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
          📥 Upload vendor file
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: SI_F, fontSize: 11, color: TL_MUTED }}>FROM</span>
        <input type="month" value={fromYM} onChange={e => setFromYM(e.target.value)}
          style={{ padding: "4px 8px", border: `1px solid ${TL_BORDER}`, borderRadius: 6, fontFamily: SI_F, fontSize: 12, background: TL_HOVER, color: TL_TEXT }} />
        <span style={{ fontFamily: SI_F, fontSize: 11, color: TL_MUTED }}>TO</span>
        <input type="month" value={toYM} onChange={e => setToYM(e.target.value)}
          style={{ padding: "4px 8px", border: `1px solid ${TL_BORDER}`, borderRadius: 6, fontFamily: SI_F, fontSize: 12, background: TL_HOVER, color: TL_TEXT }} />
      </div>

      {projectList.length === 0 ? (
        <div style={{ color: TL_MUTED, fontFamily: SI_F, fontSize: 13, padding: 40, textAlign: "center" }}>No projects yet.</div>
      ) : (
        <>
          {/* Month header */}
          <div style={{ display: "flex", position: "sticky", top: 0, background: TL_PAGE, zIndex: 2, paddingBottom: 4, borderBottom: `1px solid ${TL_BORDER}` }}>
            <div style={{ width: LABEL_W, flexShrink: 0 }} />
            <div style={{ flex: 1, position: "relative", height: 22 }}>
              {months.map((m, i) => (
                <div key={i} style={{ position: "absolute", left: `${(i / months.length) * 100}%`, width: `${100 / months.length}%`, fontFamily: SI_F, fontSize: 11, color: TL_MUTED, textAlign: "center", borderLeft: i === 0 ? 0 : `1px dotted ${TL_BORDER}`, fontWeight: 700 }}>
                  {monthLabel(m)}
                </div>
              ))}
              {todayPct != null && (
                <div title="Today" style={{ position: "absolute", top: -8, left: `${todayPct}%`, transform: "translateX(-50%)", padding: "1px 7px", borderRadius: 4, background: "#EF4444", color: "#FFF", fontFamily: SI_F, fontSize: 9.5, fontWeight: 700, zIndex: 3 }}>Today</div>
              )}
            </div>
          </div>

          {/* Group + project + stage rows */}
          {groups.map(g => (
            <div key={g.key}>
              {groupBy !== "none" && (
                <div onClick={() => setCollapsedGroups(c => ({ ...c, [g.key]: !c[g.key] }))}
                  style={{ display: "flex", alignItems: "center", height: 32, cursor: "pointer", borderBottom: `1px solid ${TL_BORDER}` }}>
                  <div style={{ width: LABEL_W, flexShrink: 0, fontFamily: SI_F, fontSize: 12, fontWeight: 700, color: TL_TEXT, display: "flex", alignItems: "center", gap: 4, paddingLeft: 4 }}>
                    <span style={{ color: TL_MUTED, width: 12, fontSize: 10 }}>{collapsedGroups[g.key] ? "▸" : "▾"}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: 0.3 }}>{g.key}</span>
                    <span style={{ background: TL_HOVER, color: TL_MUTED, padding: "1px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 700 }}>{g.projects.length}</span>
                  </div>
                  <div style={{ flex: 1, position: "relative", height: "100%" }}>
                    {todayPct != null && <div style={{ position: "absolute", top: 0, bottom: 0, left: `${todayPct}%`, width: 1, background: "#EF4444", pointerEvents: "none" }} />}
                  </div>
                </div>
              )}
              {!collapsedGroups[g.key] && g.projects.map(p => {
                const projCollapsed = !expandedProjects[p.pid];
                return (
                <React.Fragment key={p.pid}>
                  {/* Project name row — 38px, clickable chevron toggles per-project collapse */}
                  <div style={{ display: "flex", alignItems: "center", height: 38, borderBottom: `1px solid ${TL_BORDER}` }}>
                    <div style={{ width: LABEL_W, flexShrink: 0, fontFamily: SI_F, fontSize: 12.5, color: TL_TEXT, display: "flex", alignItems: "center", gap: 6, paddingLeft: groupBy === "none" ? 4 : 22 }}>
                      <span onClick={() => setExpandedProjects(c => ({ ...c, [p.pid]: !c[p.pid] }))}
                        style={{ color: TL_MUTED, width: 14, fontSize: 11, cursor: "pointer", userSelect: "none", textAlign: "center" }}
                        title={projCollapsed ? "Expand stages" : "Collapse stages"}>
                        {projCollapsed ? "▸" : "▾"}
                      </span>
                      <div style={{ flex: 1, overflow: "hidden", cursor: "pointer" }}
                        onClick={() => setExpandedProjects(c => ({ ...c, [p.pid]: !c[p.pid] }))}>
                        <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                        {p.is_blocked && <div style={{ fontSize: 10, color: "#EF4444", fontWeight: 700, lineHeight: 1, marginTop: 2 }}>on hold</div>}
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); setSlideOutPid(p.pid); }} title="Open detail"
                        style={{ background: "transparent", border: `1px solid ${TL_BORDER}`, borderRadius: 4, color: TL_MUTED, fontFamily: SI_F, fontSize: 11, width: 22, height: 20, cursor: "pointer", lineHeight: 1, marginRight: 4 }}>↗</button>
                    </div>
                    <div style={{ flex: 1, position: "relative", height: "100%" }}>
                      {todayPct != null && <div style={{ position: "absolute", top: 0, bottom: 0, left: `${todayPct}%`, width: 1, background: "#EF4444", pointerEvents: "none", zIndex: 1 }} />}
                      {/* When collapsed, render a compact summary bar spanning earliest→latest stage on this row */}
                      {projCollapsed && SI_STAGES.map(stage => {
                        const d = p.stage_dates?.[stage] || null;
                        return <React.Fragment key={stage}>{renderStageBar(stage, p, d || {}, true, { compact: true })}</React.Fragment>;
                      })}
                    </div>
                  </div>
                  {/* Stage sub-rows — only when expanded */}
                  {!projCollapsed && SI_STAGES.map(stage => {
                    const d = p.stage_dates?.[stage] || null;
                    return (
                      <div key={stage} style={{ display: "flex", alignItems: "center", height: 28, borderBottom: `1px solid ${TL_BORDER}` }}>
                        <div style={{ width: LABEL_W, flexShrink: 0, fontFamily: SI_F, fontSize: 11.5, color: TL_MUTED, paddingLeft: (groupBy === "none" ? 24 : 42), display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: SI_STAGE_COLORS[stage], flexShrink: 0 }}></span>
                          {stage}
                        </div>
                        <div style={{ flex: 1, position: "relative", height: "100%" }}>
                          {todayPct != null && <div style={{ position: "absolute", top: 0, bottom: 0, left: `${todayPct}%`, width: 1, background: "#EF4444", pointerEvents: "none", zIndex: 1 }} />}
                          {renderStageBar(stage, p, d || {}, true)}
                        </div>
                      </div>
                    );
                  })}
                </React.Fragment>
                );
              })}
            </div>
          ))}
        </>
      )}

      {editPopover && (
        <SIStageBarEditor info={editPopover} onClose={() => setEditPopover(null)} actor={actor} />
      )}
      {slideOutPid && (
        <SIProjectSlideOut pid={slideOutPid}
          project={projectList.find(p => p.pid === slideOutPid)}
          theme={theme}
          actor={actor}
          onClose={() => setSlideOutPid(null)} />
      )}
      {vendorUploadOpen && (
        <VendorFileUploadModal projectList={projectList} actor={actor} onClose={() => setVendorUploadOpen(false)} />
      )}
    </div>
  );
}

/* Vendor schedule upload — pick a project, upload pdf/csv/txt, Claude
   proposes stage_date changes, user reviews + applies. Mirrors the
   per-project AITimelineImportButton but scoped to the Timeline view. */
function VendorFileUploadModal({ projectList, actor, onClose }) {
  const [pid, setPid] = useState(projectList[0]?.pid || "");
  const [mode, setMode] = useState("idle"); // idle | running | review | error
  const [error, setError] = useState("");
  const [changes, setChanges] = useState([]);
  const [checked, setChecked] = useState({});
  const fileInput = useRef(null);
  const project = projectList.find(p => p.pid === pid);

  const onFile = async (file) => {
    if (!file) return;
    if (!pid) { setError("Pick a project first."); setMode("error"); return; }
    setMode("running"); setError("");
    try {
      const buf = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const fileBase64 = btoa(binary);
      const call = httpsCallable(functions, "aiSIParseTimelineImport");
      const res = await call({
        fileBase64,
        mimeType: file.type || "application/octet-stream",
        fileName: file.name,
        currentStageDates: project?.stage_dates || {},
        stages: SI_STAGES,
      });
      const ch = res?.data?.changes || [];
      setChanges(ch);
      const init = {}; ch.forEach((_, i) => { init[i] = true; });
      setChecked(init);
      setMode("review");
    } catch (e) {
      setError(e?.message || String(e));
      setMode("error");
    }
  };

  const apply = async () => {
    setMode("running");
    for (let i = 0; i < changes.length; i++) {
      if (!checked[i]) continue;
      const c = changes[i];
      if (!c.stage || !c.field || !c.new_value) continue;
      await update(ref(db, `appState/siProjects/${pid}/stage_dates/${c.stage}`), { [c.field]: c.new_value });
      logSIActivity(pid, "ai_timeline_import", `AI: ${c.stage} ${c.field} → ${c.new_value} (${(c.evidence || "").slice(0, 40)})`, actor);
    }
    try {
      const snap = await get(ref(db, `appState/siProjects/${pid}`));
      const live = snap.val() || {};
      const newStage = deriveCurrentStage(live.stage_dates || {}, live.current_stage);
      const prev = live.current_stage || "SIRD";
      await update(ref(db, `appState/siProjects/${pid}`), { current_stage: newStage });
      if (newStage !== prev) logSIActivity(pid, "stage_advance", `Stage: ${prev} → ${newStage}`, actor);
    } catch (_) {}
    onClose();
  };

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 10, padding: 20, width: "min(720px, 94vw)", maxHeight: "85vh", display: "flex", flexDirection: "column", color: "#F8FAFC" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <h3 style={{ margin: 0, flex: 1, fontFamily: SI_F, fontSize: 16, fontWeight: 700 }}>📥 Upload vendor schedule</h3>
          <button onClick={onClose} style={{ background: "transparent", border: 0, color: "#94A3B8", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        {mode === "idle" && (
          <>
            <label style={{ display: "block", fontFamily: SI_F, fontSize: 11, color: "#F59E0B", textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700, marginBottom: 6 }}>Project</label>
            <select value={pid} onChange={e => setPid(e.target.value)}
              style={{ width: "100%", padding: "8px 10px", border: "1px solid #334155", borderRadius: 6, background: "#0F172A", color: "#F8FAFC", fontFamily: SI_F, fontSize: 13, marginBottom: 16 }}>
              {projectList.map(p => <option key={p.pid} value={p.pid}>{p.name}</option>)}
            </select>
            <p style={{ margin: "0 0 14px", fontFamily: SI_F, fontSize: 12.5, color: "#CBD5E1" }}>
              Upload a vendor schedule (PDF, CSV, or text). Claude parses it and proposes stage-date updates for the selected project. You review and pick which to apply.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onClose}
                style={{ padding: "8px 16px", border: "1px solid #334155", borderRadius: 6, background: "#0F172A", color: "#F8FAFC", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={() => fileInput.current?.click()}
                style={{ padding: "8px 16px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Choose file…
              </button>
              <input ref={fileInput} type="file" accept=".pdf,.txt,.csv" style={{ display: "none" }}
                onChange={e => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
          </>
        )}

        {mode === "running" && (
          <div style={{ padding: "20px 0", textAlign: "center", fontFamily: SI_F, fontSize: 13.5, color: "#CBD5E1" }}>
            Calling Claude… this can take 10–30 seconds.
          </div>
        )}

        {mode === "error" && (
          <>
            <pre style={{ margin: 0, padding: 12, background: "#7F1D1D", color: "#FEE2E2", borderRadius: 6, fontFamily: "ui-monospace, monospace", fontSize: 11.5, whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto" }}>{error}</pre>
            <p style={{ fontFamily: SI_F, fontSize: 12, color: "#94A3B8", margin: "10px 0 14px" }}>
              If the error mentions <code style={{ background: "#0F172A", padding: "1px 5px", borderRadius: 3 }}>ANTHROPIC_API_KEY</code> or the function is not deployed, the Cloud Function needs to be configured. See <code style={{ background: "#0F172A", padding: "1px 5px", borderRadius: 3 }}>/functions/index.js</code>.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setMode("idle")}
                style={{ padding: "8px 16px", border: "1px solid #334155", borderRadius: 6, background: "#0F172A", color: "#F8FAFC", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                Try again
              </button>
              <button onClick={onClose}
                style={{ padding: "8px 16px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Close
              </button>
            </div>
          </>
        )}

        {mode === "review" && (
          <>
            <div style={{ fontFamily: SI_F, fontSize: 12.5, color: "#CBD5E1", marginBottom: 10 }}>
              {changes.length === 0
                ? "Claude didn't propose any changes from this file."
                : `${changes.length} proposed change${changes.length === 1 ? "" : "s"} for ${project?.name || "this project"}. Uncheck any you don't want to apply.`}
            </div>
            {changes.length > 0 && (
              <div style={{ overflowY: "auto", flex: 1, border: "1px solid #334155", borderRadius: 6, marginBottom: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: SI_F, fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "#0F172A" }}>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "#94A3B8", textTransform: "uppercase", fontSize: 10.5, fontWeight: 700 }}>Apply</th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "#94A3B8", textTransform: "uppercase", fontSize: 10.5, fontWeight: 700 }}>Stage</th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "#94A3B8", textTransform: "uppercase", fontSize: 10.5, fontWeight: 700 }}>Field</th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "#94A3B8", textTransform: "uppercase", fontSize: 10.5, fontWeight: 700 }}>New value</th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "#94A3B8", textTransform: "uppercase", fontSize: 10.5, fontWeight: 700 }}>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changes.map((c, i) => (
                      <tr key={i} style={{ borderTop: "1px solid #334155" }}>
                        <td style={{ padding: "6px 8px" }}><input type="checkbox" checked={!!checked[i]} onChange={e => setChecked({ ...checked, [i]: e.target.checked })} /></td>
                        <td style={{ padding: "6px 8px" }}>
                          <span style={{ background: SI_STAGE_COLORS[c.stage] || "#94A3B8", color: "#FFF", padding: "1px 7px", borderRadius: 999, fontSize: 10.5, fontWeight: 700 }}>{c.stage}</span>
                        </td>
                        <td style={{ padding: "6px 8px" }}>{c.field}</td>
                        <td style={{ padding: "6px 8px", fontWeight: 600 }}>{c.new_value}</td>
                        <td style={{ padding: "6px 8px", color: "#94A3B8", fontSize: 11, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.evidence || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onClose}
                style={{ padding: "8px 16px", border: "1px solid #334155", borderRadius: 6, background: "#0F172A", color: "#F8FAFC", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                Cancel
              </button>
              {changes.length > 0 && (
                <button onClick={apply}
                  style={{ padding: "8px 16px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                  Apply selected
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* Floating per-stage date editor anchored at the clicked bar. Updates
   write live to RTDB; closes on outside click. */
function SIStageBarEditor({ info, onClose, actor }) {
  const { pid, stage, project, anchor } = info;
  const sd = (project.stage_dates && project.stage_dates[stage]) || {};
  const ref0 = useRef(null);
  const [form, setForm] = useState({
    planned_start: sd.planned_start || "",
    planned_end:   sd.planned_end   || "",
    actual_start:  sd.actual_start  || "",
    actual_end:    sd.actual_end    || "",
  });
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const onSave = async () => {
    const plannedChanged = (form.planned_start !== (sd.planned_start || "")) ||
                           (form.planned_end   !== (sd.planned_end   || ""));
    if (plannedChanged) {
      const ok = window.confirm(
        `⚠  You're changing PLANNED dates for ${stage}.\n\n` +
        `Planned dates are set at project kickoff and used as the baseline for slippage / scorecard metrics. ` +
        `Changing them after kickoff invalidates that history.\n\n` +
        `If the dates have genuinely shifted, prefer updating ACTUAL dates instead.\n\nContinue?`
      );
      if (!ok) return;
    }
    await update(ref(db, `appState/siProjects/${pid}/stage_dates/${stage}`), {
      planned_start: form.planned_start || null,
      planned_end:   form.planned_end   || null,
      actual_start:  form.actual_start  || null,
      actual_end:    form.actual_end    || null,
    });
    // Activity log — one entry per changed key.
    const LABEL = { planned_start: "Planned start", planned_end: "Planned end", actual_start: "Actual start", actual_end: "Actual end" };
    for (const k of ["planned_start", "planned_end", "actual_start", "actual_end"]) {
      const before = sd[k] || "";
      const after  = form[k] || "";
      if (before !== after) {
        const arrow = before ? `${before} → ${after || "—"}` : `→ ${after || "—"}`;
        logSIActivity(pid, "stage_dates", `${stage} ${LABEL[k]}: ${arrow}`, actor);
      }
    }
    // Auto-advance current_stage. Read the LIVE stage_dates back from RTDB so
    // we use canonical data — not the editor's possibly-stale closure copy.
    try {
      const snap = await get(ref(db, `appState/siProjects/${pid}`));
      const live = snap.val() || {};
      const newStage = deriveCurrentStage(live.stage_dates || {}, live.current_stage);
      const prevStage = live.current_stage || project.current_stage || "SIRD";
      await update(ref(db, `appState/siProjects/${pid}`), { current_stage: newStage });
      if (newStage !== prevStage) {
        logSIActivity(pid, "stage_advance", `Stage: ${prevStage} → ${newStage}`, actor);
      }
    } catch (e) { /* tolerate */ }
    onClose();
  };
  // Center the modal horizontally on the viewport; place near the click vertically.
  const CARD_W = 460;
  const top  = Math.max(80, (anchor.top || 0) + window.scrollY - 10);
  const left = Math.max(16, (window.innerWidth - CARD_W) / 2 + window.scrollX);
  const labelStyle = (highlight) => ({
    display: "block", fontFamily: SI_F, fontSize: 10.5,
    color: highlight ? "#F59E0B" : "#94A3B8",
    textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700, marginBottom: 5,
  });
  const inputStyle = {
    display: "block", width: "100%", padding: "8px 10px",
    border: "1px solid #334155", borderRadius: 6, background: "#0F172A",
    color: "#F8FAFC", fontFamily: SI_F, fontSize: 13,
    colorScheme: "dark",
  };
  return (
    <>
      {/* Backdrop — click closes */}
      <div onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.55)", zIndex: 90 }} />
      <div ref={ref0}
        style={{
          position: "absolute", top, left, width: CARD_W,
          background: "#1E293B", border: "1px solid #334155", borderRadius: 10,
          boxShadow: "0 24px 60px rgba(0,0,0,0.55)", padding: "16px 18px", zIndex: 100,
        }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <h3 style={{ margin: 0, flex: 1, fontFamily: SI_F, fontSize: 15, color: "#F8FAFC", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {project.name}
          </h3>
          <span style={{ background: SI_STAGE_COLORS[stage], color: "#FFF", padding: "2px 10px", borderRadius: 999, fontFamily: SI_F, fontSize: 11, fontWeight: 700 }}>{stage}</span>
          <button onClick={onClose}
            style={{ background: "transparent", border: 0, color: "#94A3B8", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 2 }}>×</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 16px" }}>
          <div>
            <label style={labelStyle(true)}>Planned Start <span style={{ marginLeft: 2 }}>🔒</span></label>
            <input type="date" value={form.planned_start} onChange={e => set("planned_start", e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle(true)}>Planned End <span style={{ marginLeft: 2 }}>🔒</span></label>
            <input type="date" value={form.planned_end} onChange={e => set("planned_end", e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle(false)}>Actual Start</label>
            <input type="date" value={form.actual_start} onChange={e => set("actual_start", e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle(false)}>Actual End</label>
            <input type="date" value={form.actual_end} onChange={e => set("actual_end", e.target.value)} style={inputStyle} />
          </div>
        </div>
        <p style={{ margin: "14px 0 12px", fontFamily: SI_F, fontSize: 11.5, color: "#94A3B8", fontStyle: "italic" }}>
          🔒 Planned dates are the kickoff baseline. Prefer updating Actual dates as the project progresses.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-start", gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: "7px 14px", border: "1px solid #334155", borderRadius: 6, background: "#0F172A", color: "#F8FAFC", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={onSave}
            style={{ padding: "7px 16px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            Save
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Kanban: read-only board grouped by current_stage ────────────── */
/* ── Slide-out drill panel used by the Timeline's "↗ Open detail" button.
   Four tabs: Overview / Stage Dates / Sub-stages / Activity. Backed by
   the same RTDB paths the main drill-in uses. */
function SIProjectSlideOut({ pid, project, onClose, theme, actor }) {
  const [tab, setTab] = useState("overview");
  const T = THEMES[theme] || THEMES.dark;
  if (!project) return null;
  const isBlocked = !!project.is_blocked;
  const toggleHold = async () => {
    const reason = isBlocked ? null : (prompt("On-hold reason (shown in tooltips):", "") || "Hold");
    await update(ref(db, `appState/siProjects/${pid}`), {
      is_blocked: !isBlocked, block_reason: isBlocked ? null : reason,
    });
  };
  const tabBtn = (id, label) => (
    <button onClick={() => setTab(id)}
      style={{
        padding: "6px 4px", border: 0, background: "transparent",
        borderBottom: `2px solid ${tab === id ? "#2563EB" : "transparent"}`,
        color: tab === id ? T.text : T.textMuted,
        fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer",
      }}>{label}</button>
  );
  return (
    <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(620px, 90vw)", background: T.cardBg, borderLeft: `1px solid ${T.cardBorder}`, color: T.text, zIndex: 100, overflowY: "auto", boxShadow: "-16px 0 40px rgba(0,0,0,0.45)" }}>
      <div style={{ position: "sticky", top: 0, background: T.cardBg, borderBottom: `1px solid ${T.cardBorder}`, padding: "14px 18px 0", zIndex: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontFamily: SI_F, fontSize: 16, color: T.text, fontWeight: 700, flex: 1 }}>{project.name}</h2>
          <button onClick={toggleHold}
            style={{ padding: "5px 12px", border: `1px solid #EF4444`, borderRadius: 6, background: "transparent", color: "#EF4444", fontFamily: SI_F, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
            {isBlocked ? "▶ Resume" : "❚❚ Mark on hold"}
          </button>
          <button onClick={onClose}
            style={{ background: "transparent", border: 0, color: T.textMuted, fontSize: 20, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          {tabBtn("overview", "Overview")}
          {tabBtn("dates",    "Stage Dates")}
          {tabBtn("sub",      "Sub-stages")}
          {tabBtn("activity", "Activity")}
        </div>
      </div>
      <div style={{ padding: "16px 18px" }}>
        {tab === "overview" && <SlideOverview pid={pid} project={project} T={T} />}
        {tab === "dates"    && <SlideStageDates pid={pid} project={project} T={T} actor={actor} />}
        {tab === "sub"      && <SlideSubStages pid={pid} project={project} T={T} />}
        {tab === "activity" && <SlideActivity pid={pid} T={T} />}
      </div>
    </div>
  );
}

function _slideInput(T) {
  return { padding: "8px 10px", border: `1px solid ${T.cardBorder}`, borderRadius: 6, background: T.cardSoft, color: T.text, fontFamily: SI_F, fontSize: 13, width: "100%", boxSizing: "border-box" };
}
function _slideLabel(T) {
  return { display: "block", fontFamily: SI_F, fontSize: 10.5, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, marginBottom: 4 };
}
function SlideField({ label, T, children }) {
  return <div style={{ marginBottom: 12 }}><label style={_slideLabel(T)}>{label}</label>{children}</div>;
}

function SlideOverview({ pid, project, T }) {
  const [form, setForm] = useState({
    name: project.name || "",
    si_name: project.si_name || "",
    customer: project.customer || "",
    cm_site: project.cm_site || "",
    factory_location: project.factory_location || "",
    current_stage: project.current_stage || "SIRD",
    station_type: project.station_type || "",
    si_pm: project.si_pm || "",
    si_ae: project.si_ae || "",
    fat_date: project.fat_date || "",
    sat_date: project.sat_date || "",
    sat_location: project.sat_location || "",
    ship_date: project.ship_date || "",
    notes: project.notes || "",
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const save = async () => {
    const patch = { ...form };
    // Normalise empty strings to null so RTDB doesn't store blanks.
    Object.keys(patch).forEach(k => { if (patch[k] === "") patch[k] = null; });
    await update(ref(db, `appState/siProjects/${pid}`), { ...patch, updated_at: Date.now() });
  };
  const del = async () => {
    if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
    await remove(ref(db, `appState/siProjects/${pid}`));
  };
  return (
    <>
      <SlideField label="Name *" T={T}><input style={_slideInput(T)} value={form.name} onChange={e => set("name", e.target.value)} /></SlideField>
      <SlideField label="SI *"   T={T}><input style={_slideInput(T)} value={form.si_name} onChange={e => set("si_name", e.target.value)} /></SlideField>
      <SlideField label="Customer" T={T}><input style={_slideInput(T)} value={form.customer} onChange={e => set("customer", e.target.value)} /></SlideField>
      <SlideField label="CM Site"  T={T}><input style={_slideInput(T)} value={form.cm_site} onChange={e => set("cm_site", e.target.value)} /></SlideField>
      <SlideField label="Factory Location" T={T}><input style={_slideInput(T)} value={form.factory_location} onChange={e => set("factory_location", e.target.value)} /></SlideField>
      <SlideField label="Current Stage"    T={T}>
        <select style={_slideInput(T)} value={form.current_stage} onChange={e => set("current_stage", e.target.value)}>
          {SI_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </SlideField>
      <SlideField label="Station Type" T={T}><input style={_slideInput(T)} value={form.station_type} onChange={e => set("station_type", e.target.value)} placeholder="e.g. Semi-Automated Inspection Fixture" /></SlideField>
      <details style={{ marginBottom: 12 }} open>
        <summary style={{ fontFamily: SI_F, fontSize: 13, fontWeight: 700, color: T.text, cursor: "pointer", marginBottom: 8 }}>Contacts</summary>
        <SlideField label="SI PM" T={T}><input style={_slideInput(T)} value={form.si_pm} onChange={e => set("si_pm", e.target.value)} /></SlideField>
        <SlideField label="SI AE" T={T}><input style={_slideInput(T)} value={form.si_ae} onChange={e => set("si_ae", e.target.value)} /></SlideField>
      </details>
      <details style={{ marginBottom: 12 }} open>
        <summary style={{ fontFamily: SI_F, fontSize: 13, fontWeight: 700, color: T.text, cursor: "pointer", marginBottom: 8 }}>Key dates</summary>
        <SlideField label="FAT Date" T={T}><input type="date" style={_slideInput(T)} value={form.fat_date} onChange={e => set("fat_date", e.target.value)} /></SlideField>
        <SlideField label="SAT Date" T={T}><input type="date" style={_slideInput(T)} value={form.sat_date} onChange={e => set("sat_date", e.target.value)} /></SlideField>
        <SlideField label="SAT Location" T={T}><input style={_slideInput(T)} value={form.sat_location} onChange={e => set("sat_location", e.target.value)} /></SlideField>
        <SlideField label="Ship Date" T={T}><input type="date" style={_slideInput(T)} value={form.ship_date} onChange={e => set("ship_date", e.target.value)} /></SlideField>
        <div style={{ fontFamily: SI_F, fontSize: 10.5, color: T.textMuted }}>Writing here also updates the matching stage_dates planned-start cell.</div>
      </details>
      <SlideField label="Notes" T={T}><textarea style={{ ..._slideInput(T), minHeight: 70, resize: "vertical" }} value={form.notes} onChange={e => set("notes", e.target.value)} /></SlideField>
      <button onClick={save} style={{ padding: "7px 16px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Save</button>
      <div style={{ marginTop: 24, padding: 12, border: `1px solid #EF4444`, borderRadius: 6 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: SI_F, fontSize: 11, color: "#EF4444", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>Danger Zone</span>
          <button onClick={del}
            style={{ padding: "6px 14px", border: 0, borderRadius: 6, background: "#EF4444", color: "#FFF", fontFamily: SI_F, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>🗑 Delete project</button>
        </div>
      </div>
    </>
  );
}

function SlideStageDates({ pid, project, T, actor }) {
  const sd = project.stage_dates || {};
  const onChange = async (stage, key, value) => {
    const before = (project.stage_dates?.[stage] || {})[key] || "";
    const after  = value || "";
    await update(ref(db, `appState/siProjects/${pid}/stage_dates/${stage}`), { [key]: value || null });
    if (before !== after) {
      const LABEL = { planned_start: "Planned start", planned_end: "Planned end", actual_start: "Actual start", actual_end: "Actual end" };
      const arrow = before ? `${before} → ${after || "—"}` : `→ ${after || "—"}`;
      logSIActivity(pid, "stage_dates", `${stage} ${LABEL[key] || key}: ${arrow}`, actor);
    }
    try {
      const snap = await get(ref(db, `appState/siProjects/${pid}`));
      const live = snap.val() || {};
      const newStage = deriveCurrentStage(live.stage_dates || {}, live.current_stage);
      const prevStage = live.current_stage || project.current_stage || "SIRD";
      await update(ref(db, `appState/siProjects/${pid}`), { current_stage: newStage });
      if (newStage !== prevStage) {
        logSIActivity(pid, "stage_advance", `Stage: ${prevStage} → ${newStage}`, actor);
      }
    } catch (e) { /* tolerate */ }
  };
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: SI_F, fontSize: 12.5, tableLayout: "auto" }}>
      <thead><tr>
        {["Stage", "Planned Start", "Planned End", "Actual Start", "Actual End"].map(h => (
          <th key={h} style={{ fontFamily: SI_F, fontSize: 10.5, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, textAlign: "left", padding: "0 6px 8px", whiteSpace: "nowrap" }}>{h}</th>
        ))}
      </tr></thead>
      <tbody>
        {SI_STAGES.map(stage => {
          const d = sd[stage] || {};
          const inp = (k) => <input type="date" defaultValue={d[k] || ""} onChange={e => onChange(stage, k, e.target.value)}
            style={{ padding: "4px 6px", border: `1px solid ${T.cardBorder}`, borderRadius: 4, background: T.cardSoft, color: T.text, fontFamily: SI_F, fontSize: 11.5, width: 130 }} />;
          return (
            <tr key={stage}>
              <td style={{ padding: "4px 6px" }}>
                <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 999, background: SI_STAGE_COLORS[stage], color: "#FFF", fontFamily: SI_F, fontSize: 10.5, fontWeight: 700 }}>{stage}</span>
              </td>
              <td style={{ padding: "4px 6px" }}>{inp("planned_start")}</td>
              <td style={{ padding: "4px 6px" }}>{inp("planned_end")}</td>
              <td style={{ padding: "4px 6px" }}>{inp("actual_start")}</td>
              <td style={{ padding: "4px 6px" }}>{inp("actual_end")}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SlideSubStages({ pid, project, T }) {
  const subStages = Object.entries(project.sub_stages || {}).map(([id, s]) => ({ id, ...(s || {}) }));
  const add = () => {
    const name = prompt("Sub-stage name (e.g. Custom milestone):");
    if (!name) return;
    const parent = prompt("Parent stage (SIRD/DFM/Quote/PO/Build/FAT/In Transit/SAT/Live):", "Build") || "Build";
    const k = push(ref(db, `appState/siProjects/${pid}/sub_stages`)).key;
    set(ref(db, `appState/siProjects/${pid}/sub_stages/${k}`), {
      name: name.trim(), parent_stage: parent,
      planned_start: null, planned_end: null, actual_start: null, actual_end: null,
      created_at: Date.now(),
    });
  };
  return (
    <>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: SI_F, fontSize: 12.5, marginBottom: 12, tableLayout: "auto" }}>
        <thead><tr>
          {["Name", "Parent", "Planned Start", "Planned End", "Actual Start", "Actual End"].map(h => (
            <th key={h} style={{ fontFamily: SI_F, fontSize: 10.5, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, textAlign: "left", padding: "0 6px 8px", whiteSpace: "nowrap" }}>{h}</th>
          ))}
        </tr></thead>
        <tbody>
          {subStages.length === 0 ? (
            <tr><td colSpan={6} style={{ color: T.textMuted, padding: "10px 6px" }}>No sub-stages yet.</td></tr>
          ) : subStages.map(s => {
            const change = (k, v) => update(ref(db, `appState/siProjects/${pid}/sub_stages/${s.id}`), { [k]: v || null });
            return (
              <tr key={s.id}>
                <td style={{ padding: "4px 6px" }}>{s.name}</td>
                <td style={{ padding: "4px 6px" }}>{s.parent_stage}</td>
                <td style={{ padding: "4px 6px" }}><input type="date" defaultValue={s.planned_start || ""} onChange={e => change("planned_start", e.target.value)} style={{ padding: "3px 5px", border: `1px solid ${T.cardBorder}`, borderRadius: 4, background: T.cardSoft, color: T.text, fontSize: 11 }} /></td>
                <td style={{ padding: "4px 6px" }}><input type="date" defaultValue={s.planned_end   || ""} onChange={e => change("planned_end",   e.target.value)} style={{ padding: "3px 5px", border: `1px solid ${T.cardBorder}`, borderRadius: 4, background: T.cardSoft, color: T.text, fontSize: 11 }} /></td>
                <td style={{ padding: "4px 6px" }}><input type="date" defaultValue={s.actual_start  || ""} onChange={e => change("actual_start",  e.target.value)} style={{ padding: "3px 5px", border: `1px solid ${T.cardBorder}`, borderRadius: 4, background: T.cardSoft, color: T.text, fontSize: 11 }} /></td>
                <td style={{ padding: "4px 6px" }}><input type="date" defaultValue={s.actual_end    || ""} onChange={e => change("actual_end",    e.target.value)} style={{ padding: "3px 5px", border: `1px solid ${T.cardBorder}`, borderRadius: 4, background: T.cardSoft, color: T.text, fontSize: 11 }} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button onClick={add}
        style={{ padding: "6px 14px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>+ Add sub-stage</button>
    </>
  );
}

function SlideActivity({ pid, T }) {
  const [entries, setEntries] = useState([]);
  const [newName, setNewName] = useState(""); const [newKind, setNewKind] = useState("note"); const [newText, setNewText] = useState("");
  useEffect(() => {
    const r = ref(db, `appState/siActivityLog/${pid}`);
    return onValue(r, s => {
      const v = s.val() || {};
      const list = Object.entries(v).map(([k, e]) => ({ k, ...e })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      setEntries(list);
    });
  }, [pid]);
  const post = async () => {
    if (!newText.trim()) return;
    const k = push(ref(db, `appState/siActivityLog/${pid}`)).key;
    await set(ref(db, `appState/siActivityLog/${pid}/${k}`), {
      timestamp: Date.now(), type: newKind, summary: newText.trim(), actor: newName.trim() || "you",
    });
    setNewText("");
  };
  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input placeholder="Your name" value={newName} onChange={e => setNewName(e.target.value)}
          style={{ ..._slideInput(T), flex: 1 }} />
        <select value={newKind} onChange={e => setNewKind(e.target.value)} style={{ ..._slideInput(T), width: 110 }}>
          <option value="note">note</option><option value="blocker">blocker</option><option value="update">update</option>
        </select>
      </div>
      <textarea placeholder="Markdown allowed — **bold**, *italic*, `code`, [link](https://…)" value={newText} onChange={e => setNewText(e.target.value)}
        style={{ ..._slideInput(T), minHeight: 70, resize: "vertical", marginBottom: 8 }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <span style={{ fontFamily: SI_F, fontSize: 12, color: T.textMuted }}>📎 Attach</span>
        <button onClick={post}
          style={{ padding: "6px 14px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Post</button>
      </div>
      {entries.length === 0 ? (
        <div style={{ color: T.textMuted, fontFamily: SI_F, fontSize: 12.5 }}>No activity yet.</div>
      ) : entries.slice(0, 50).map(e => (
        <div key={e.k} style={{ padding: "10px 0", borderTop: `1px solid ${T.cardBorder}` }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
            <span style={{ fontFamily: SI_F, fontSize: 12.5, fontWeight: 700, color: T.text }}>{e.actor || "unknown"}</span>
            <span style={{ background: T.cardSoft, color: T.textMuted, padding: "1px 6px", borderRadius: 4, fontFamily: SI_F, fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }}>{e.type || "note"}</span>
            <span style={{ marginLeft: "auto", fontFamily: SI_F, fontSize: 10.5, color: T.textMuted }}>{e.timestamp ? new Date(e.timestamp).toLocaleString() : "—"}</span>
          </div>
          <div style={{ fontFamily: SI_F, fontSize: 12.5, color: T.text }}>{e.summary || ""}</div>
        </div>
      ))}
    </>
  );
}

// Kanban is the source-of-truth view for HubSpot pipeline state. It reads
// directly from the HubSpot-synced `projects` collection (filtered to the
// SI Partner Deployment pipeline) and is read-only — stage changes happen
// in HubSpot. Other SI tabs (Dashboard, Timeline, drill-in) keep using the
// manually-maintained `siProjects` RTDB collection.
// Pull the SI partner name out of a HubSpot project name. Naming
// convention is "[SI] [<Partner>] <rest>" — return "<Partner>" (e.g.
// "Anda", "NewPower"). Returns null if no second bracketed token found.
function extractSiName(rawName) {
  if (!rawName) return null;
  const m = String(rawName).match(/^\s*\[SI\]\s*\[([^\]]+)\]/i);
  return m ? m[1].trim() : null;
}

// Turn HubSpot's per-stage entered/exited dates into our timeline schema.
// HubSpot's "date entered <stage>" and "date exited <stage>" are populated
// when the project moves through the SI Partner Deployment pipeline; we
// treat that progression as the PLANNED timeline (the baseline schedule)
// so the user can layer actual deltas on top.
//
// If `existing` is provided, we merge non-destructively — only fill keys
// that are currently empty, so manual edits are preserved.
function buildStageDatesFromHubspot(hubspotStageDates, existing = {}) {
  const out = { ...(existing || {}) };
  if (!hubspotStageDates || typeof hubspotStageDates !== "object") return out;
  for (const [stage, dates] of Object.entries(hubspotStageDates)) {
    const cur = out[stage] || {};
    const next = { ...cur };
    if (!cur.planned_start && dates?.entered) next.planned_start = dates.entered;
    if (!cur.planned_end   && dates?.exited)  next.planned_end   = dates.exited;
    if (next.planned_start || next.planned_end || cur.actual_start || cur.actual_end) {
      out[stage] = next;
    }
  }
  return out;
}

// Correlate a HubSpot project name to a manually-maintained siProject.
// Rules (in order):
//   1. P-number prefix (P1, P2, P3, …) in either name matches by integer
//   2. "fundip" / "z-height" → siProject whose name contains either token
//   3. "newpower" / "new power" → siProject whose name OR si_name matches
// Returns the matching siProject record (with .pid) or null.
function findLinkedSiProject(hubspotProject, siProjectsArr) {
  if (!hubspotProject || !Array.isArray(siProjectsArr)) return null;
  const name = (hubspotProject.name || "").toLowerCase();
  if (!name) return null;
  const pMatch = name.match(/\bp(\d+)\b/);
  if (pMatch) {
    const pNum = parseInt(pMatch[1], 10);
    const hit = siProjectsArr.find(p => {
      const pn = (p.name || "").toLowerCase().match(/\bp(\d+)\b/);
      return pn && parseInt(pn[1], 10) === pNum;
    });
    if (hit) return hit;
  }
  if (/fundip|z-?height/i.test(name)) {
    const hit = siProjectsArr.find(p => /fundip|z-?height/i.test(p.name || ""));
    if (hit) return hit;
  }
  if (/new\s*power/i.test(name)) {
    const hit = siProjectsArr.find(p => /new\s*power/i.test(p.name || "") || /new\s*power/i.test(p.si_name || ""));
    if (hit) return hit;
  }
  return null;
}

const HUBSPOT_TO_SI_STAGE = {
  sird: "SIRD", dfm: "DFM", quote: "Quote", po: "PO",
  build: "Build", fat: "FAT", sat: "SAT", live: "Live",
};
const NEW_PROJECT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;  // 14 days

function SIKanbanBoard({ hubspotProjects, siProjects, onOpenDrillIn }) {
  const siS = useSIS();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const refreshFromHubspot = async () => {
    setSyncing(true); setSyncMsg("");
    try {
      const fn = httpsCallable(functions, "manualHubspotSync");
      // commit:true — without this flag the Cloud Function only previews
      // changes and never writes them back to RTDB.
      const res = await fn({ commit: true });
      const n = res?.data?.synced ?? res?.data?.count ?? res?.data?.totalProjects ?? null;
      setSyncMsg(n != null ? `Synced ${n} project${n === 1 ? "" : "s"} from HubSpot` : "Sync complete");
      setTimeout(() => setSyncMsg(""), 6000);
    } catch (e) {
      setSyncMsg(`Sync failed: ${e?.message || e}`);
      setTimeout(() => setSyncMsg(""), 8000);
    } finally {
      setSyncing(false);
    }
  };
  // Materialize the manual siProjects collection as an array so we can
  // correlate each HubSpot card to a manually-maintained project.
  const siProjectsArr = useMemo(() => Object.entries(siProjects || {})
    .map(([pid, p]) => ({ pid, ...(p || {}) })), [siProjects]);
  // Filter to the SI Partner Deployment pipeline, active only.
  const list = (hubspotProjects || []).filter(p =>
    p.status === "active" && p.hubspotPipelineId === SI_PARTNER_PIPELINE_ID
  );
  const now = Date.now();
  const isNew = (p) => {
    const raw = p.createdAt || p.created_at || p.createDate || p.updatedAt;
    if (!raw) return false;
    const t = typeof raw === "number" ? raw : Date.parse(raw);
    return Number.isFinite(t) && (now - t) <= NEW_PROJECT_WINDOW_MS;
  };
  const byStage = {};
  for (const s of SI_STAGES) byStage[s] = [];
  for (const p of list) {
    const hsStage = normalizeSiStage(p.siStage);                  // lowercase id
    const stage = HUBSPOT_TO_SI_STAGE[hsStage] || "SIRD";          // canonical
    if (byStage[stage]) byStage[stage].push(p);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ ...siS.card, padding: "10px 14px", fontFamily: SI_F, fontSize: 12, color: siS.textMuted, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#6366F1", flexShrink: 0 }} />
        <span style={{ flex: 1 }}>
          <strong style={{ color: siS.text }}>Read-only</strong> — pulled from HubSpot. {list.length} project{list.length === 1 ? "" : "s"} in the SI Partner Deployment pipeline.
          {syncMsg && <span style={{ marginLeft: 8, color: syncMsg.startsWith("Sync failed") ? "#DC2626" : "#16A34A" }}>· {syncMsg}</span>}
        </span>
        <button onClick={refreshFromHubspot} disabled={syncing}
          style={{ padding: "5px 12px", border: `1px solid ${siS.cardBorder}`, borderRadius: 6, background: siS.cardSoft, color: siS.text, fontFamily: SI_F, fontSize: 11.5, fontWeight: 600, cursor: syncing ? "wait" : "pointer" }}>
          {syncing ? "Syncing…" : "↻ Refresh from HubSpot"}
        </button>
      </div>
      {list.length === 0 ? (
        <div style={{ ...siS.empty, color: siS.textMuted }}>
          No active projects in the SI Partner Deployment pipeline yet. They'll appear here as soon as HubSpot syncs them in.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${SI_STAGES.length}, minmax(0, 1fr))`, gap: 8, paddingBottom: 8 }}>
          {SI_STAGES.map(stage => (
            <div key={stage}
              style={{ minWidth: 0, background: siS.cardBg, border: `1px solid ${siS.cardBorder}`, borderRadius: 8, display: "flex", flexDirection: "column", maxHeight: "75vh" }}>
              <div style={{ padding: "10px 12px", borderBottom: `1px solid ${siS.cardBorder}`, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: SI_STAGE_COLORS[stage], flexShrink: 0 }}></span>
                <span style={{ fontFamily: SI_F, fontSize: 12, fontWeight: 700, color: siS.text, textTransform: "uppercase", letterSpacing: 0.5, flex: 1 }}>{stage}</span>
                <span style={{ background: siS.cardSoft, color: siS.textMuted, padding: "1px 7px", borderRadius: 999, fontFamily: SI_F, fontSize: 11, fontWeight: 700 }}>{byStage[stage].length}</span>
              </div>
              <div style={{ padding: 8, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                {byStage[stage].map(p => {
                  const url = hubspotProjectUrl(p);
                  const fresh = isNew(p);
                  const linked = findLinkedSiProject(p, siProjectsArr);
                  const openDrill = () => { if (linked && onOpenDrillIn) onOpenDrillIn(linked.pid); };
                  return (
                    <div key={p.id}
                      style={{ background: siS.cardSoft, border: `1px solid ${siS.cardBorder}`, borderRadius: 6, padding: "8px 10px", fontFamily: SI_F, display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: siS.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                        {fresh && (
                          <span style={{ background: "#16A34A", color: "#FFF", padding: "1px 6px", borderRadius: 999, fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, flexShrink: 0 }}>NEW</span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: siS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.customer || "—"}{p.stations ? ` · ${p.stations} stn` : ""}
                      </div>
                      <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                        {linked ? (
                          <button onClick={openDrill}
                            title={`Open drill-in for ${linked.name}`}
                            style={{ flex: 1, padding: "3px 6px", border: `1px solid ${siS.link}`, borderRadius: 4, background: "transparent", color: siS.link, fontFamily: SI_F, fontSize: 10.5, fontWeight: 600, cursor: "pointer" }}>
                            → Open detail
                          </button>
                        ) : (
                          <span title="No linked project in this app yet — it'll be created on the next sync"
                            style={{ flex: 1, padding: "3px 6px", border: `1px dashed ${siS.cardBorder}`, borderRadius: 4, color: siS.textMuted, fontFamily: SI_F, fontSize: 10.5, fontWeight: 600, textAlign: "center" }}>
                            Not linked
                          </span>
                        )}
                        {url && (
                          <a href={url} target="_blank" rel="noopener" title="Open in HubSpot"
                            style={{ padding: "3px 8px", border: `1px solid ${siS.cardBorder}`, borderRadius: 4, color: siS.textMuted, fontFamily: SI_F, fontSize: 10.5, fontWeight: 600, textDecoration: "none" }}>
                            ↗ HubSpot
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════
   MANAGE PAGES — Misc Documents · SI Fleet · SIRD Generator · Test Plan
   All four follow the same shape: project picker (skipped for SI Fleet)
   + per-project editor. Backed by RTDB under appState/siProjects/{pid}.
   ═════════════════════════════════════════════════════════════════════ */

/* Manage > Misc Documents — project picker + misc-only upload zone.
   This is the project Dashboard's Misc section, exposed standalone so
   the user can manage misc docs without opening each project. */
function MiscDocumentsView({ projectList, isSIAdminUser, actor, initialPid, onConsumeInitialPid }) {
  const siS = useSIS();
  const [pid, setPid] = useState(initialPid || "");
  useEffect(() => {
    if (initialPid) { setPid(initialPid); onConsumeInitialPid && onConsumeInitialPid(); }
  }, [initialPid]);
  const project = pid ? projectList.find(p => p.pid === pid) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <ProjectPickerBar projectList={projectList} value={pid} onChange={setPid}
        title="Misc Documents"
        subtitle="Pick a project to attach miscellaneous documents (files or external links)." />
      {project && (
        <div style={siS.card}>
          <h3 style={{ ...siS.h2, fontSize: 14, marginBottom: 10 }}>Misc documents</h3>
          <DocZone pid={pid} category="misc" label="Files & links"
            files={Object.entries(project.files || {}).map(([fid, f]) => ({ fid, ...f })).filter(f => f.category === "misc")}
            isSIAdminUser={isSIAdminUser} actor={actor}
            writeAt={(p, v) => set(ref(db, p), v)}
            removeAt={(p) => remove(ref(db, p))} />
        </div>
      )}
    </div>
  );
}

function ProjectPickerBar({ projectList, value, onChange, title, subtitle, extraHeader }) {
  const siS = useSIS();
  return (
    <div style={siS.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {title && <h2 style={{ ...siS.h2, fontSize: 16, margin: 0 }}>{title}</h2>}
        {subtitle && <span style={{ fontFamily: SI_F, fontSize: 12, color: siS.textMuted }}>{subtitle}</span>}
        <div style={{ flex: 1 }} />
        {extraHeader}
        <label style={{ fontFamily: SI_F, fontSize: 12, color: siS.textMuted }}>Project:</label>
        <select value={value} onChange={e => onChange(e.target.value)}
          style={{ fontFamily: SI_F, fontSize: 13, padding: "6px 10px", border: `1px solid ${siS.inputBorder}`, borderRadius: 6, background: siS.inputBg, color: siS.text, minWidth: 280 }}>
          <option value="">— select a project —</option>
          {projectList.map(p => <option key={p.pid} value={p.pid}>{p.name}{p.si_name ? `  ·  ${p.si_name}` : ""}</option>)}
        </select>
      </div>
    </div>
  );
}

/* ── SI Fleet (Scorecard with notes) ──────────────────────────────────
   Computed live from projectList. For each unique si_name, aggregate
   project count, on-hold count, on-time/slipped stage counts. Score is
   a rough proxy: weighted blend of (1 - on-hold rate) and on-time rate.
   Notes per SI persist at appState/siScorecardNotes/{si_name_lc}. */
function SIFleetScorecard({ projectList }) {
  const siS = useSIS();
  // RTDB subscription for per-SI notes.
  const [notes, setNotes] = useState({});
  useEffect(() => {
    const r = ref(db, "appState/siScorecardNotes");
    return onValue(r, s => setNotes(s.val() || {}));
  }, []);
  const [openSi, setOpenSi] = useState(null);
  const [chartPid, setChartPid] = useState(null);  // null = all projects under this SI
  const [refreshKey, setRefreshKey] = useState(0);
  // Reset chart-scope whenever the opened SI changes.
  useEffect(() => { setChartPid(null); }, [openSi]);

  // ── Top-level KPIs ────────────────────────────────────────────────
  const kpis = useMemo(() => {
    let totalFixtures = 0, deployed = 0, inBuild = 0;
    const factories = new Set();
    for (const p of projectList) {
      const stations = Object.values(p.stations || {});
      totalFixtures += stations.length;
      for (const s of stations) {
        if (s?.deployment_factory) factories.add(s.deployment_factory);
        if (s?.deployed_at || s?.is_deployed) deployed += 1;
      }
      const es = effectiveStage(p);
      if (es === "Build" || es === "FAT" || es === "In Transit") inBuild += 1;
    }
    return { totalFixtures, deployed, inBuild, factories: factories.size };
  }, [projectList, refreshKey]);

  // ── Per-SI scorecard rows ─────────────────────────────────────────
  const rows = useMemo(() => {
    const bySi = new Map();
    for (const p of projectList) {
      const key = (p.si_name || "Unassigned").trim();
      if (!bySi.has(key)) bySi.set(key, []);
      bySi.get(key).push(p);
    }
    const out = [];
    for (const [si, items] of bySi.entries()) {
      let total = items.length;
      let blocked = 0, liveCount = 0;
      let onTime = 0, slipped = 0;
      let fatFirstPass = { pass: 0, total: 0 }, satFirstPass = { pass: 0, total: 0 };
      const slippageDays = [];
      for (const p of items) {
        if (p.is_blocked) blocked += 1;
        if (effectiveStage(p) === "Live") liveCount += 1;
        for (const sd of Object.values(p.stage_dates || {})) {
          if (!sd) continue;
          const pe = sd.planned_end ? new Date(sd.planned_end) : null;
          const ae = sd.actual_end  ? new Date(sd.actual_end)  : null;
          if (pe && ae) {
            const diff = Math.round((ae - pe) / 86400000);
            slippageDays.push(diff);
            if (diff <= 0) onTime += 1; else slipped += 1;
          }
        }
        // FAT/SAT 1st-pass: an executed upload exists and result === "pass"
        for (const kind of ["fat", "sat"]) {
          const plan = p?.test_plans?.[kind];
          if (!plan) continue;
          const ups = Object.values(plan.executed_uploads || {}).sort((a, b) => (a.uploaded_at || 0) - (b.uploaded_at || 0));
          if (ups.length === 0) continue;
          const first = ups[0];
          const target = kind === "fat" ? fatFirstPass : satFirstPass;
          target.total += 1;
          if ((first?.result || first?.outcome || "").toLowerCase() === "pass") target.pass += 1;
        }
      }
      const completed = onTime + slipped;
      const onTimePct = completed ? (onTime / completed) * 100 : null;
      const avgSlip = slippageDays.length ? slippageDays.reduce((a, b) => a + b, 0) / slippageDays.length : null;
      const blockedPct = total ? (blocked / total) * 100 : 0;
      const fatPct = fatFirstPass.total ? (fatFirstPass.pass / fatFirstPass.total) * 100 : null;
      const satPct = satFirstPass.total ? (satFirstPass.pass / satFirstPass.total) * 100 : null;
      const scoreParts = [[0.5, onTimePct ?? 100], [0.5, 100 - blockedPct]];
      const wsum = scoreParts.reduce((a, [w]) => a + w, 0);
      const score = scoreParts.reduce((a, [w, v]) => a + (w / wsum) * v, 0);
      out.push({
        si_name: si, items,
        total, active: total - liveCount, live: liveCount,
        blocked, on_time_pct: onTimePct, avg_slip: avgSlip,
        fat_first_pass: fatPct, sat_first_pass: satPct,
        blocked_pct: blockedPct, score: Math.round(score),
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }, [projectList, refreshKey]);

  const saveNote = (siKey, text) => set(ref(db, `appState/siScorecardNotes/${siKey}`), { notes: text, updated_at: Date.now() });
  const fmtPct  = (v) => v == null ? "—" : `${Math.round(v)}%`;
  const fmtDays = (v) => v == null ? "—" : `${Math.abs(v) < 0.05 ? "0d" : `${v > 0 ? "+" : ""}${(Math.round(v * 10) / 10).toFixed(1)}d`}`;

  // KPI tile component.
  const Kpi = ({ label, value, color }) => (
    <div style={{ ...siS.card, padding: "14px 18px" }}>
      <div style={{ fontFamily: SI_F, fontSize: 10.5, color: siS.textMuted, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: SI_F, fontSize: 30, fontWeight: 800, color: color || siS.text, lineHeight: 1 }}>{value}</div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header strip */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ ...siS.h2, fontSize: 18 }}>SI Fleet</h2>
        <div style={{ flex: 1 }} />
        <button onClick={() => setRefreshKey(k => k + 1)}
          style={{ padding: "6px 14px", border: `1px solid ${siS.cardBorder}`, borderRadius: 6, background: siS.cardSoft, color: siS.text, fontFamily: SI_F, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
          ↻ Refresh
        </button>
      </div>

      {/* KPI tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
        <Kpi label="Total fixtures"      value={kpis.totalFixtures} />
        <Kpi label="Currently deployed"  value={kpis.deployed}   color="#10B981" />
        <Kpi label="In build"            value={kpis.inBuild}    color="#F59E0B" />
        <Kpi label="Across factories"    value={kpis.factories} />
      </div>

      {/* Scorecard */}
      <div style={siS.card}>
        <div style={{ fontFamily: SI_F, fontSize: 11, color: siS.textMuted, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700, marginBottom: 10 }}>Scorecard</div>
        {rows.length === 0 ? (
          <div style={{ color: siS.textMuted, fontFamily: SI_F, fontSize: 13 }}>No SI projects yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={siS.table}>
              <thead>
                <tr>
                  <th style={siS.th}>SI</th>
                  <th style={siS.th}>Active</th>
                  <th style={siS.th}>Live</th>
                  <th style={siS.th}>On-Time %</th>
                  <th style={siS.th}>Avg Slip</th>
                  <th style={siS.th}>FAT 1st-Pass %</th>
                  <th style={siS.th}>SAT 1st-Pass %</th>
                  <th style={siS.th}>Blocked %</th>
                  <th style={siS.th}>Score</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.si_name} onClick={() => setOpenSi(openSi === r.si_name ? null : r.si_name)}
                      style={{ cursor: "pointer", background: openSi === r.si_name ? siS.cardSoft : "transparent" }}>
                    <td style={siS.td}>{r.si_name}</td>
                    <td style={siS.td}>{r.active}</td>
                    <td style={siS.td}>{r.live}</td>
                    <td style={siS.td}>{fmtPct(r.on_time_pct)}</td>
                    <td style={siS.td}>{fmtDays(r.avg_slip)}</td>
                    <td style={siS.td}>{fmtPct(r.fat_first_pass)}</td>
                    <td style={siS.td}>{fmtPct(r.sat_first_pass)}</td>
                    <td style={siS.td}>{fmtPct(r.blocked_pct)}</td>
                    <td style={{ ...siS.td, fontWeight: 700, color: siS.link }}>{r.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Drill-down for the selected SI */}
      {openSi && (() => {
        const r = rows.find(x => x.si_name === openSi);
        if (!r) return null;
        const siKey = openSi.toLowerCase().replace(/[^a-z0-9]+/g, "_");
        const note = notes[siKey] || {};
        // Chart scope: a single project if chartPid is set, otherwise all
        // projects under this SI.
        const scopedItems = chartPid ? r.items.filter(p => p.pid === chartPid) : r.items;
        const scopedProject = chartPid ? r.items.find(p => p.pid === chartPid) : null;
        // Per-stage average slippage over scopedItems
        const stages = ["SIRD", "DFM", "Quote", "PO", "Build", "FAT", "In Transit", "SAT"];
        const slipByStage = stages.map(s => {
          const diffs = [];
          for (const p of scopedItems) {
            const sd = p.stage_dates?.[s];
            if (!sd?.planned_end || !sd?.actual_end) continue;
            const pe = new Date(sd.planned_end), ae = new Date(sd.actual_end);
            if (isNaN(pe) || isNaN(ae)) continue;
            diffs.push((ae - pe) / 86400000);
          }
          const avg = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;
          return { stage: s, days: avg, samples: diffs.length };
        });
        const maxAbs = Math.max(2, ...slipByStage.map(x => Math.abs(x.days)));
        const yMax = Math.ceil(maxAbs);
        const chartH = 220, chartW = 540, padL = 36, padB = 30, padT = 10, padR = 10;
        const innerH = chartH - padT - padB, innerW = chartW - padL - padR;
        const barW = innerW / stages.length * 0.6;
        const slot = innerW / stages.length;
        const zeroY = padT + innerH / 2;
        const scaleY = (innerH / 2) / yMax;
        const ticks = [yMax, yMax/2, 0, -yMax/2, -yMax].map(v => Math.round(v));
        return (
          <div style={siS.card}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontFamily: SI_F, fontSize: 15, fontWeight: 700, color: siS.text }}>{openSi} — drill-down</h3>
              <div style={{ flex: 1 }} />
              <span style={{ fontFamily: SI_F, fontSize: 12, color: siS.textMuted }}>
                SCORE <strong style={{ color: siS.link }}>{r.score}</strong> · {r.active} ACTIVE · {r.live} LIVE · {r.total} TOTAL
              </span>
              <button onClick={() => setOpenSi(null)} style={{ background: "transparent", border: 0, color: siS.textMuted, fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 2 }}>×</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 18 }}>
              {/* Chart */}
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{ fontFamily: SI_F, fontSize: 10.5, color: siS.textMuted, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700 }}>
                    Average slippage per stage (days)
                  </div>
                  <span style={{ fontFamily: SI_F, fontSize: 11, color: siS.textMuted }}>
                    · {scopedProject ? scopedProject.name : `${r.items.length} project${r.items.length === 1 ? "" : "s"}`}
                  </span>
                  <div style={{ flex: 1 }} />
                  {chartPid && (
                    <button onClick={() => setChartPid(null)}
                      style={{ padding: "3px 10px", border: `1px solid ${siS.cardBorder}`, borderRadius: 999, background: "transparent", color: siS.link, fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                      Show all projects
                    </button>
                  )}
                </div>
                <svg viewBox={`0 0 ${chartW} ${chartH}`} style={{ width: "100%", height: chartH, maxWidth: chartW }}>
                  {/* y-axis ticks + gridlines */}
                  {ticks.map((t, i) => {
                    const y = zeroY - t * scaleY;
                    return (
                      <g key={i}>
                        <line x1={padL} x2={chartW - padR} y1={y} y2={y} stroke={siS.cardBorder} strokeWidth={t === 0 ? 1 : 0.5} />
                        <text x={padL - 6} y={y + 3} textAnchor="end" fontFamily={SI_F} fontSize="9.5" fill={siS.textMuted}>{t}</text>
                      </g>
                    );
                  })}
                  {/* Bars */}
                  {slipByStage.map((d, i) => {
                    const cx = padL + slot * i + slot / 2;
                    const h = Math.abs(d.days * scaleY);
                    const y = d.days >= 0 ? zeroY - h : zeroY;
                    const fill = d.samples === 0 ? siS.cardBorder : (d.days > 0 ? "#DC2626" : "#10B981");
                    return (
                      <g key={d.stage}>
                        <rect x={cx - barW / 2} y={y} width={barW} height={Math.max(0.5, h)} fill={fill} opacity={d.samples === 0 ? 0.25 : 0.85} />
                        <text x={cx} y={chartH - padB + 14} textAnchor="middle" fontFamily={SI_F} fontSize="10" fill={siS.text}>{d.stage}</text>
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Project list — click a row to scope the chart to it */}
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <div style={{ fontFamily: SI_F, fontSize: 10.5, color: siS.textMuted, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700 }}>Projects</div>
                  <span style={{ fontFamily: SI_F, fontSize: 10.5, color: siS.textMuted, fontStyle: "italic" }}>click to filter chart</span>
                </div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  {r.items.map(p => {
                    const es = effectiveStage(p);
                    const fatStatus = p?.test_plans?.fat?.signed_off_at ? "SIGNED" : p?.test_plans?.fat?.status?.toUpperCase() || "PENDING";
                    const satStatus = p?.test_plans?.sat?.signed_off_at ? "SIGNED" : p?.test_plans?.sat?.status?.toUpperCase() || "PENDING";
                    const isSelected = chartPid === p.pid;
                    const pill = (text, bg, fg) => (
                      <span style={{ background: bg, color: fg, padding: "1px 7px", borderRadius: 999, fontFamily: SI_F, fontSize: 10, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase" }}>{text}</span>
                    );
                    return (
                      <li key={p.pid}
                        onClick={() => setChartPid(isSelected ? null : p.pid)}
                        title={isSelected ? "Click to show all projects" : "Click to filter chart to this project"}
                        style={{
                          display: "flex", alignItems: "center", gap: 6, fontFamily: SI_F, fontSize: 12,
                          padding: "5px 8px", borderRadius: 6, cursor: "pointer",
                          background: isSelected ? siS.cardSoft : "transparent",
                          border: `1px solid ${isSelected ? siS.link : "transparent"}`,
                        }}>
                        <span style={{ color: siS.link, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 }}>{p.name}</span>
                        {pill(es, SI_STAGE_COLORS[es] || "#94A3B8", "#FFF")}
                        {p.is_blocked && pill("BLOCKED", "#FECACA", "#991B1B")}
                        {pill(`FAT: ${fatStatus}`, siS.cardSoft, siS.textMuted)}
                        {pill(`SAT: ${satStatus}`, siS.cardSoft, siS.textMuted)}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>

            {/* Notes */}
            <div style={{ marginTop: 18 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                <div style={{ fontFamily: SI_F, fontSize: 13, fontWeight: 700, color: siS.text }}>Notes</div>
                {note.updated_at && (
                  <span style={{ fontFamily: SI_F, fontSize: 10.5, color: siS.textMuted, textTransform: "uppercase", letterSpacing: 0.6 }}>
                    Last edited {new Date(note.updated_at).toLocaleString()}
                  </span>
                )}
              </div>
              <textarea key={openSi} defaultValue={note.notes || ""}
                onBlur={e => saveNote(siKey, e.target.value)}
                placeholder="Add context the numbers can't capture (e.g. delay on our side, vendor swap mid-project, scope change...). Saves on blur."
                style={{ width: "100%", minHeight: 110, padding: 10, border: `1px solid ${siS.cardBorder}`, borderRadius: 6, background: siS.inputBg, fontFamily: SI_F, fontSize: 13, lineHeight: 1.45, color: siS.text, boxSizing: "border-box", resize: "vertical" }} />
            </div>
          </div>
        );
      })()}

      {/* Bottom sections — empty placeholders for now */}
      <div>
        <div style={{ fontFamily: SI_F, fontSize: 11, color: siS.textMuted, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700, marginBottom: 6 }}>By SI</div>
        <div style={{ color: siS.textMuted, fontFamily: SI_F, fontSize: 13 }}>No fixtures yet.</div>
      </div>
      <div>
        <div style={{ fontFamily: SI_F, fontSize: 11, color: siS.textMuted, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700, marginBottom: 6 }}>Factory rollup</div>
        <div style={{ color: siS.textMuted, fontFamily: SI_F, fontSize: 13 }}>No deployments yet.</div>
      </div>
    </div>
  );
}

/* ── SIRD Generator (questionnaire only — docx generation skipped) ──── */
// Canonical 17-section SIRD questionnaire — mirrors fixture_tracker's
// services/si_questionnaire.SECTIONS exactly so the schemas stay aligned.
// Each field carries a role tag (TPM / SA / HDE / FDE / CSE / PM) for the
// pill rendered next to its label.
const SIRD_SECTIONS = [
  { id: "project_overview", title: "1. Project Overview", fields: [
    { id: "overview.customer_goal",   role: "TPM", label: "What is the customer's primary inspection goal?", type: "textarea" },
    { id: "overview.product_name",    role: "TPM", label: "Product or assembly under inspection",            type: "text" },
    { id: "overview.station_count",   role: "TPM", label: "Number of stations",                              type: "text" },
    { id: "overview.station_type",    role: "SA",  label: "Station type",                                    type: "select", options: ["Manual Inspection Fixture", "Semi-Automated Inspection Fixture", "Automated Inspection Cell"] },
    { id: "overview.target_factory",  role: "TPM", label: "Target factory / deployed location",              type: "text" },
  ]},
  { id: "product", title: "2. Product Under Test", fields: [
    { id: "product.dimensions",  role: "HDE", label: "Product dimensions (L × W × H mm)", type: "text" },
    { id: "product.weight",      role: "HDE", label: "Product weight (g)",                type: "text" },
    { id: "product.material",    role: "HDE", label: "Primary material(s)",               type: "text" },
    { id: "product.variants",    role: "TPM", label: "Variants / SKUs to support",        type: "textarea" },
  ]},
  { id: "defects", title: "3. Defect Coverage", fields: [
    { id: "defects.list",                role: "CSE", label: "Defects to detect (one per line)", type: "textarea" },
    { id: "defects.escapes_acceptable",  role: "CSE", label: "Acceptable escape rate (%)",       type: "text" },
    { id: "defects.false_call_target",   role: "CSE", label: "Target false-call rate (%)",       type: "text" },
  ]},
  { id: "optics", title: "4. Optics & Imaging", fields: [
    { id: "optics.camera_count",    role: "FDE", label: "Number of cameras / sensors",  type: "text" },
    { id: "optics.resolution",      role: "FDE", label: "Resolution per camera (MP)",   type: "text" },
    { id: "optics.lighting",        role: "FDE", label: "Lighting plan",                type: "textarea" },
    { id: "optics.exposure_range",  role: "FDE", label: "Expected exposure / gain range", type: "text" },
  ]},
  { id: "mechanical", title: "5. Mechanical & Fixturing", fields: [
    { id: "mech.fixture_concept",  role: "HDE", label: "Fixture concept (nest, vacuum, magnet, etc.)", type: "textarea" },
    { id: "mech.load_method",      role: "HDE", label: "Loading method (manual / pick & place / conveyor)", type: "text" },
    { id: "mech.eject_method",     role: "HDE", label: "Reject / unloading method",      type: "text" },
    { id: "mech.frame_footprint",  role: "HDE", label: "Frame footprint envelope (mm)",  type: "text" },
  ]},
  { id: "automation", title: "6. Automation & Motion", fields: [
    { id: "auto.cycle_time",   role: "SA",  label: "Target cycle time per unit (sec)", type: "text" },
    { id: "auto.throughput",   role: "SA",  label: "Throughput requirement (UPH)",     type: "text" },
    { id: "auto.motion_axes",  role: "HDE", label: "Motion axes required",             type: "text" },
  ]},
  { id: "electrical", title: "7. Electrical & Controls", fields: [
    { id: "elec.power",     role: "HDE", label: "Mains power (V / Hz / phase)", type: "text" },
    { id: "elec.io_count",  role: "HDE", label: "Digital I/O count",            type: "text" },
    { id: "elec.estop",     role: "HDE", label: "Safety / E-stop strategy",     type: "textarea" },
  ]},
  { id: "software", title: "8. Software & Integration", fields: [
    { id: "sw.mes_integration",  role: "FDE", label: "MES / SCADA / line-control integration", type: "textarea" },
    { id: "sw.barcode",          role: "FDE", label: "Barcode / traceability requirements",     type: "textarea" },
    { id: "sw.data_retention",   role: "FDE", label: "Image / data retention policy",           type: "text" },
  ]},
  { id: "network", title: "9. Network & Connectivity", fields: [
    { id: "net.factory_network",  role: "FDE", label: "Factory network type / VLAN access", type: "text" },
    { id: "net.outbound",         role: "FDE", label: "Outbound internet allowed?",          type: "select", options: ["Yes", "No", "Restricted"] },
  ]},
  { id: "environment", title: "10. Environment", fields: [
    { id: "env.temperature",  role: "HDE", label: "Ambient temperature range (°C)",       type: "text" },
    { id: "env.humidity",     role: "HDE", label: "Humidity range",                       type: "text" },
    { id: "env.vibration",    role: "HDE", label: "Vibration / nearby equipment concerns", type: "textarea" },
  ]},
  { id: "safety", title: "11. Safety & Compliance", fields: [
    { id: "safety.certifications",  role: "SA",  label: "Required certifications (CE, UL, etc.)", type: "text" },
    { id: "safety.guarding",        role: "HDE", label: "Guarding / light curtain requirements",  type: "textarea" },
  ]},
  { id: "operators", title: "12. Operators & Training", fields: [
    { id: "ops.skill_level",  role: "CSE", label: "Operator skill level",  type: "select", options: ["Entry", "Trained", "Expert"] },
    { id: "ops.languages",    role: "CSE", label: "Required UI language(s)", type: "text" },
  ]},
  { id: "logistics", title: "13. Logistics & Shipping", fields: [
    { id: "log.cm_site",             role: "PM", label: "CM site",                              type: "text" },
    { id: "log.ship_method",         role: "PM", label: "Shipping method (air / sea / domestic)", type: "text" },
    { id: "log.import_constraints",  role: "PM", label: "Import / customs constraints",         type: "textarea" },
  ]},
  { id: "schedule", title: "14. Schedule & Milestones", fields: [
    { id: "sched.fat_target",  role: "TPM", label: "FAT target date",            type: "date" },
    { id: "sched.sat_target",  role: "TPM", label: "SAT target date",            type: "date" },
    { id: "sched.go_live",     role: "TPM", label: "Production go-live target",  type: "date" },
  ]},
  { id: "service", title: "15. Service & Support", fields: [
    { id: "svc.spares",    role: "SA", label: "Spares strategy", type: "textarea" },
    { id: "svc.warranty",  role: "SA", label: "Warranty term",   type: "text" },
  ]},
  { id: "acceptance", title: "16. Acceptance Criteria", fields: [
    { id: "accept.fat_criteria",  role: "CSE", label: "FAT acceptance criteria", type: "textarea" },
    { id: "accept.sat_criteria",  role: "CSE", label: "SAT acceptance criteria", type: "textarea" },
  ]},
  { id: "risks", title: "17. Risks & Open Issues", fields: [
    { id: "risk.top_risks",        role: "TPM", label: "Top 3 risks",                       type: "textarea" },
    { id: "risk.open_questions",   role: "TPM", label: "Open questions for the customer",   type: "textarea" },
  ]},
];

// Role pill colors (subtle, monochromatic — match fixture_tracker's tags).
const SIRD_ROLE_COLORS = {
  TPM: { bg: "#E0E7FF", fg: "#3730A3" },
  SA:  { bg: "#D1FAE5", fg: "#065F46" },
  HDE: { bg: "#FEF3C7", fg: "#92400E" },
  FDE: { bg: "#FCE7F3", fg: "#9D174D" },
  CSE: { bg: "#DBEAFE", fg: "#1E40AF" },
  PM:  { bg: "#F3E8FF", fg: "#6B21A8" },
};

/* Write a vendor-facing snapshot of a SIRD to appState/publicSird/{token}.
   Open read, so the /share/sird/{token} viewer works without auth.
   If `version` is null, snapshot uses the project's current sird_responses
   (i.e. an in-progress draft). Otherwise it captures the version's frozen
   responses. */
async function publishPublicSirdSnapshot(token, project, version) {
  if (!token) return;
  const responses = version?.responses || project?.sird_responses || {};
  await set(ref(db, `appState/publicSird/${token}`), {
    project_name:      project?.name || null,
    si_name:           project?.si_name || null,
    version:           version?.version || null,
    published_at:      version?.published_at || null,
    sent_to_vendor_at: version?.sent_to_vendor_at || null,
    responses,
    snapshot_at:       Date.now(),
  });
}

/* Generic preview modal. Renders images inline, PDFs via iframe,
   everything else falls back to a download link. `file` shape:
   { filename, downloadUrl, mimeType?, url? (for external links) } */
function FilePreviewModal({ file, onClose }) {
  const siS = useSIS();
  if (!file) return null;
  const url = file.url || file.downloadUrl;
  const name = file.filename || "file";
  const mime = (file.mimeType || "").toLowerCase();
  const lower = (name || "").toLowerCase();
  const isImage = mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(lower);
  const isPdf   = mime === "application/pdf" || /\.pdf$/i.test(lower);
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#FFF", borderRadius: 10, width: "min(960px, 96vw)", maxHeight: "92vh", display: "flex", flexDirection: "column" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid #E2E8F0" }}>
          <span style={{ fontFamily: SI_F, fontSize: 14, fontWeight: 700, color: "#0F172A", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
          {url && (
            <a href={url} target="_blank" rel="noopener"
              style={{ padding: "5px 12px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#475569", fontFamily: SI_F, fontSize: 12.5, fontWeight: 600, textDecoration: "none" }}>
              ↗ Open in new tab
            </a>
          )}
          <button onClick={onClose}
            style={{ background: "transparent", border: 0, color: "#64748B", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
        </header>
        <div style={{ flex: 1, overflow: "auto", background: isImage ? "#0F172A" : "#F8FAFC", display: "flex", alignItems: "center", justifyContent: "center", padding: isImage ? 0 : 16 }}>
          {!url ? (
            <div style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 13 }}>No preview available.</div>
          ) : isImage ? (
            <img src={url} alt={name} style={{ maxWidth: "100%", maxHeight: "85vh" }} />
          ) : isPdf ? (
            <iframe src={url} title={name} style={{ width: "100%", height: "85vh", border: 0, background: "#FFF" }} />
          ) : (
            <div style={{ textAlign: "center", padding: 30, fontFamily: SI_F }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>📄</div>
              <div style={{ fontSize: 13, color: "#0F172A", marginBottom: 4 }}>{name}</div>
              <div style={{ fontSize: 12, color: "#64748B", marginBottom: 14 }}>Inline preview isn't supported for this file type.</div>
              <a href={url} target="_blank" rel="noopener"
                style={{ padding: "7px 14px", border: "1px solid #2563EB", borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
                ↓ Download
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* Public read-only SIRD viewer. Path: /share/sird/{token}. Fetches
   the snapshot from appState/publicSird/{token} (open-read, no auth)
   and renders the questionnaire in the same layout the editor uses,
   minus all the edit affordances. */
function PublicSIRDViewer({ token }) {
  const siS = useSIS();
  const [snapshot, setSnapshot] = useState(undefined);   // undefined = loading
  useEffect(() => {
    const r = ref(db, `appState/publicSird/${token}`);
    return onValue(r, s => setSnapshot(s.val() || null), () => setSnapshot(null));
  }, [token]);
  if (snapshot === undefined) {
    return <div style={{ padding: 40, textAlign: "center", fontFamily: SI_F, color: "#64748B" }}>Loading SIRD…</div>;
  }
  if (snapshot === null) {
    return (
      <div style={{ minHeight: "100vh", background: siS.cardSoft, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: SI_F }}>
        <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 10, padding: 40, maxWidth: 480, textAlign: "center" }}>
          <h2 style={{ margin: "0 0 8px", fontSize: 20, color: "#0F172A" }}>SIRD not found</h2>
          <p style={{ margin: 0, color: "#64748B", fontSize: 14 }}>This share link is invalid or has been revoked. Contact your Instrumental project manager for a new one.</p>
        </div>
      </div>
    );
  }
  const responses = snapshot.responses || {};
  return (
    <div style={{ minHeight: "100vh", background: siS.cardSoft, padding: "32px 20px", fontFamily: SI_F }}>
      <div style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <header style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 10, padding: 20 }}>
          <h1 style={{ margin: "0 0 6px", fontSize: 24, color: "#0F172A" }}>{snapshot.project_name || "SIRD"}</h1>
          <div style={{ fontSize: 13, color: "#64748B" }}>
            SI partner: <strong>{snapshot.si_name || "—"}</strong>
            {snapshot.version != null && <> · Version <strong>v{snapshot.version}</strong></>}
            {snapshot.published_at && <> · Published {new Date(snapshot.published_at).toLocaleString()}</>}
          </div>
          {snapshot.sent_to_vendor_at && (
            <div style={{ marginTop: 8, display: "inline-block", background: "#DCFCE7", color: "#15803D", padding: "2px 10px", borderRadius: 999, fontSize: 11.5, fontWeight: 700 }}>
              SENT TO VENDOR · {new Date(snapshot.sent_to_vendor_at).toLocaleDateString()}
            </div>
          )}
        </header>
        {SIRD_SECTIONS.map(sec => (
          <section key={sec.id} style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 10, padding: 20 }}>
            <h2 style={{ margin: "0 0 14px", fontSize: 17, color: "#0F172A" }}>{sec.title}</h2>
            {sec.fields.map(f => {
              const v = responses[f.id];
              return (
                <div key={f.id} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, color: "#475569", fontWeight: 700, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 }}>{f.label}</div>
                  <div style={{ fontSize: 14, color: v ? "#0F172A" : "#94A3B8", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{v || "(blank)"}</div>
                </div>
              );
            })}
          </section>
        ))}
        <footer style={{ textAlign: "center", color: "#94A3B8", fontSize: 12, paddingTop: 8 }}>
          Read-only snapshot · {snapshot.snapshot_at ? `Generated ${new Date(snapshot.snapshot_at).toLocaleString()}` : ""}
        </footer>
      </div>
    </div>
  );
}

/* Vendor-file → Claude → review modal → apply chosen date changes. */
function AITimelineImportButton({ pid, stageDates, actor, updateAt }) {
  const siS = useSIS();
  const fileInput = useRef(null);
  const [state, setState] = useState({ mode: "idle" }); // idle | running | review | error
  const [error, setError] = useState("");
  const [changes, setChanges] = useState([]);
  const [checked, setChecked] = useState({});

  const onFile = async (file) => {
    if (!file) return;
    setState({ mode: "running" });
    setError("");
    try {
      const buf = await file.arrayBuffer();
      // Pure browser btoa needs a binary-safe encoding.
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const fileBase64 = btoa(binary);
      const call = httpsCallable(functions, "aiSIParseTimelineImport");
      const res = await call({
        fileBase64,
        mimeType: file.type || "application/octet-stream",
        fileName: file.name,
        currentStageDates: stageDates || {},
        stages: SI_STAGES,
      });
      const ch = res?.data?.changes || [];
      setChanges(ch);
      const initial = {}; ch.forEach((_, i) => { initial[i] = true; });
      setChecked(initial);
      setState({ mode: "review" });
    } catch (e) {
      setError(e?.message || String(e));
      setState({ mode: "error" });
    }
  };

  const apply = async () => {
    setState({ mode: "running" });
    for (let i = 0; i < changes.length; i++) {
      if (!checked[i]) continue;
      const c = changes[i];
      if (!c.stage || !c.field || !c.new_value) continue;
      await updateAt(`appState/siProjects/${pid}/stage_dates/${c.stage}`, { [c.field]: c.new_value });
      logSIActivity(pid, "ai_timeline_import", `AI: ${c.stage} ${c.field} → ${c.new_value} (${(c.evidence || "").slice(0, 40)})`, actor);
    }
    setState({ mode: "idle" });
    setChanges([]); setChecked({});
  };

  return (
    <>
      <button onClick={() => fileInput.current?.click()}
        title="Upload a vendor schedule file; Claude proposes date changes."
        style={{ padding: "5px 12px", border: "1px solid #2563EB", borderRadius: 6, background: "#FFF", color: "#2563EB", fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
        {state.mode === "running" ? "Calling Claude…" : "📥 AI vendor file import"}
      </button>
      <input ref={fileInput} type="file" accept=".pdf,.txt,.csv" style={{ display: "none" }}
        onChange={e => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
      {state.mode === "error" && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: "#FFF", borderRadius: 10, padding: 20, width: "min(520px, 92vw)" }}>
            <h3 style={{ margin: "0 0 8px", fontFamily: SI_F, fontSize: 16 }}>AI import failed</h3>
            <pre style={{ margin: 0, padding: 10, background: "#FEF2F2", color: "#991B1B", borderRadius: 6, fontFamily: "ui-monospace, monospace", fontSize: 11.5, whiteSpace: "pre-wrap" }}>{error}</pre>
            <p style={{ fontFamily: SI_F, fontSize: 12, color: "#64748B", margin: "10px 0 14px" }}>
              If the error mentions <code>ANTHROPIC_API_KEY</code>, the Cloud Functions haven't been configured yet. See the README in <code>/functions</code>.
            </p>
            <div style={{ textAlign: "right" }}>
              <button onClick={() => setState({ mode: "idle" })}
                style={{ padding: "6px 14px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#0F172A", fontFamily: SI_F, fontSize: 13, cursor: "pointer" }}>Close</button>
            </div>
          </div>
        </div>
      )}
      {state.mode === "review" && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: "#FFF", borderRadius: 10, padding: 20, width: "min(720px, 94vw)", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
            <h3 style={{ margin: "0 0 12px", fontFamily: SI_F, fontSize: 16 }}>Review proposed changes ({changes.length})</h3>
            {changes.length === 0 ? (
              <div style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 13 }}>Claude didn't propose any changes from this file.</div>
            ) : (
              <div style={{ overflowY: "auto", flex: 1 }}>
                <table style={siS.table}>
                  <thead><tr><th style={siS.th}>Apply</th><th style={siS.th}>Stage</th><th style={siS.th}>Field</th><th style={siS.th}>New value</th><th style={siS.th}>Evidence</th></tr></thead>
                  <tbody>
                    {changes.map((c, i) => (
                      <tr key={i}>
                        <td style={siS.td}><input type="checkbox" checked={!!checked[i]} onChange={e => setChecked({ ...checked, [i]: e.target.checked })} /></td>
                        <td style={siS.td}>{c.stage}</td>
                        <td style={siS.td}>{c.field}</td>
                        <td style={siS.td}><strong>{c.new_value}</strong></td>
                        <td style={siS.td}><span style={{ color: "#64748B", fontFamily: SI_F, fontSize: 12 }}>{c.evidence || ""}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button onClick={() => setState({ mode: "idle" })}
                style={{ padding: "6px 14px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#0F172A", fontFamily: SI_F, fontSize: 13, cursor: "pointer" }}>Cancel</button>
              {changes.length > 0 && (
                <button onClick={apply}
                  style={{ padding: "6px 14px", border: "1px solid #2563EB", borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  Apply selected
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* Coverage doc → Claude → suggestions modal → user accepts suggestions
   to pre-fill the SIRD questionnaire. Writes accepted answers into
   sird_responses, then closes. */
function AICoverageDocImportButton({ pid, sections, actor }) {
  const siS = useSIS();
  const fileInput = useRef(null);
  const [state, setState] = useState({ mode: "idle" });
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState({}); // { qid: {value, evidence} }
  const [checked, setChecked] = useState({});

  // Flatten the section/field list to {id, label} pairs for the call.
  const allQuestions = useMemo(
    () => sections.flatMap(sec => sec.fields.map(f => ({ id: f.id, label: f.label }))),
    [sections]
  );
  const byId = Object.fromEntries(allQuestions.map(q => [q.id, q.label]));

  const onFile = async (file) => {
    if (!file) return;
    setState({ mode: "running" });
    try {
      const buf = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const fileBase64 = btoa(binary);
      const call = httpsCallable(functions, "aiSIParseCoverageDoc");
      const res = await call({
        fileBase64,
        mimeType: file.type || "application/octet-stream",
        fileName: file.name,
        questionnaire: allQuestions,
      });
      const s = res?.data?.suggestions || {};
      setSuggestions(s);
      const initial = {}; Object.keys(s).forEach(k => { initial[k] = true; });
      setChecked(initial);
      setState({ mode: "review" });
    } catch (e) {
      setError(e?.message || String(e));
      setState({ mode: "error" });
    }
  };
  const apply = async () => {
    setState({ mode: "running" });
    let n = 0;
    for (const [qid, sug] of Object.entries(suggestions)) {
      if (!checked[qid] || !sug?.value) continue;
      await set(ref(db, `appState/siProjects/${pid}/sird_responses/${qid}`), String(sug.value));
      n++;
    }
    logSIActivity(pid, "ai_coverage_doc", `AI: pre-filled ${n} SIRD answer${n === 1 ? "" : "s"} from coverage doc`, actor);
    setState({ mode: "idle" });
    setSuggestions({}); setChecked({});
  };

  return (
    <>
      <button onClick={() => fileInput.current?.click()}
        title="Upload a coverage document; Claude suggests answers to pre-fill the SIRD."
        style={{ padding: "6px 14px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#64748B", fontFamily: SI_F, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
        {state.mode === "running" ? "Calling Claude…" : "🪄 AI pre-fill from doc"}
      </button>
      <input ref={fileInput} type="file" accept=".pdf,.txt,.csv" style={{ display: "none" }}
        onChange={e => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
      {state.mode === "error" && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: "#FFF", borderRadius: 10, padding: 20, width: "min(520px, 92vw)" }}>
            <h3 style={{ margin: "0 0 8px", fontFamily: SI_F, fontSize: 16 }}>AI pre-fill failed</h3>
            <pre style={{ margin: 0, padding: 10, background: "#FEF2F2", color: "#991B1B", borderRadius: 6, fontFamily: "ui-monospace, monospace", fontSize: 11.5, whiteSpace: "pre-wrap" }}>{error}</pre>
            <div style={{ textAlign: "right", marginTop: 12 }}>
              <button onClick={() => setState({ mode: "idle" })}
                style={{ padding: "6px 14px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#0F172A", fontFamily: SI_F, fontSize: 13, cursor: "pointer" }}>Close</button>
            </div>
          </div>
        </div>
      )}
      {state.mode === "review" && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: "#FFF", borderRadius: 10, padding: 20, width: "min(720px, 94vw)", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
            <h3 style={{ margin: "0 0 12px", fontFamily: SI_F, fontSize: 16 }}>Review suggested answers ({Object.keys(suggestions).length})</h3>
            {Object.keys(suggestions).length === 0 ? (
              <div style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 13 }}>Claude didn't return any suggestions.</div>
            ) : (
              <div style={{ overflowY: "auto", flex: 1 }}>
                <table style={siS.table}>
                  <thead><tr><th style={siS.th}>Apply</th><th style={siS.th}>Question</th><th style={siS.th}>Suggested answer</th><th style={siS.th}>Evidence</th></tr></thead>
                  <tbody>
                    {Object.entries(suggestions).map(([qid, s]) => (
                      <tr key={qid}>
                        <td style={siS.td}><input type="checkbox" checked={!!checked[qid]} onChange={e => setChecked({ ...checked, [qid]: e.target.checked })} /></td>
                        <td style={siS.td}><strong>{byId[qid] || qid}</strong></td>
                        <td style={{ ...siS.td, whiteSpace: "pre-wrap" }}>{s.value}</td>
                        <td style={siS.td}><span style={{ color: "#64748B", fontFamily: SI_F, fontSize: 12 }}>{s.evidence || ""}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button onClick={() => setState({ mode: "idle" })}
                style={{ padding: "6px 14px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#0F172A", fontFamily: SI_F, fontSize: 13, cursor: "pointer" }}>Cancel</button>
              {Object.keys(suggestions).length > 0 && (
                <button onClick={apply}
                  style={{ padding: "6px 14px", border: "1px solid #2563EB", borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  Apply selected
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* Empty-state component that pings localhost:5000 on mount and offers
   a one-click import if it's reachable. Falls back to the three-button
   menu (New / Import / Sample) when localhost:5000 isn't reachable. */
function EmptyStateWithAutoImport({ isSIAdminUser, actor, onOpenImport, onOpenNew }) {
  const siS = useSIS();
  // Only probe localhost:5000 when the user is actually running on localhost.
  // On the deployed origin the fetch always fails (CORS / no localhost) and
  // showing "checking… / not reachable" text just looks broken.
  const isLocalDev = typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const [probe, setProbe] = useState(isLocalDev ? { state: "checking" } : { state: "missing" });
  useEffect(() => {
    if (!isLocalDev) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("http://localhost:5000/api/si-projects", {
          method: "GET",
          signal: AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const count = Array.isArray(data) ? data.length : (data?.projects?.length || 0);
        if (!cancelled) setProbe({ state: "found", count });
      } catch (_) {
        if (!cancelled) setProbe({ state: "missing" });
      }
    })();
    return () => { cancelled = true; };
  }, [isLocalDev]);
  if (!isSIAdminUser) {
    return <div style={siS.empty}>No SI projects yet.</div>;
  }
  if (probe.state === "checking") {
    return <div style={{ ...siS.empty, color: "#64748B" }}>Checking for existing projects in localhost:5000…</div>;
  }
  if (probe.state === "found" && probe.count > 0) {
    return (
      <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, padding: 24, textAlign: "center" }}>
        <div style={{ fontFamily: SI_F, fontSize: 16, color: "#1E3A8A", fontWeight: 700, marginBottom: 4 }}>
          Found {probe.count} project{probe.count === 1 ? "" : "s"} in localhost:5000
        </div>
        <div style={{ fontFamily: SI_F, fontSize: 13, color: "#1E3A8A", marginBottom: 14 }}>
          Click below to copy them into this app (one-time, runs in your browser).
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          <button onClick={onOpenImport}
            style={{ padding: "9px 18px", border: "1px solid #2563EB", borderRadius: 8, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
            📥 Import {probe.count} project{probe.count === 1 ? "" : "s"}
          </button>
          <button onClick={onOpenNew}
            style={{ padding: "9px 18px", border: "1px solid #E2E8F0", borderRadius: 8, background: "#FFF", color: "#475569", fontFamily: SI_F, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
            + Start fresh
          </button>
        </div>
        <p style={{ marginTop: 14, fontSize: 11.5, color: "#64748B", fontFamily: SI_F }}>
          Why a button? Firebase writes need your browser auth token, which only exists when you're signed in here — not in any process I control. One click is the bridge.
        </p>
      </div>
    );
  }
  // No projects yet (or localhost source unreachable in dev) — show the
  // standard new/import/sample menu.
  return (
    <div style={{ ...siS.empty, padding: 30, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <div>No SI projects yet.</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
        <button onClick={onOpenNew}
          style={{ padding: "7px 14px", border: "1px solid #2563EB", borderRadius: 8, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          + New project
        </button>
        <button onClick={async () => { if (confirm("Seed 5 sample projects?")) await seedSampleProjects(actor); }}
          style={{ padding: "7px 14px", border: "1px solid #E2E8F0", borderRadius: 8, background: "#FFF", color: "#64748B", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          🎲 Try sample data
        </button>
      </div>
      {isLocalDev && (
        <div style={{ fontSize: 11.5, color: "#94A3B8" }}>
          If localhost:5000 (fixture_tracker) is running, start it then refresh this page to auto-detect.
        </div>
      )}
    </div>
  );
}

/* Five sample SI projects — created on click of "Try sample data" when
   no projects exist. Each project gets a few stations + plausible stage
   dates so the Gantt, Dashboard widgets, and Kanban all light up. */
const SAMPLE_PROJECTS = [
  {
    name: "P1 — TALUS — Connector AOI",
    si_name: "ANDA", customer: "NERDS", cm_site: "Foxconn SH-12",
    current_stage: "SAT",
    stage_dates: {
      SIRD:       { planned_start: "2026-02-01", planned_end: "2026-02-14", actual_start: "2026-02-01", actual_end: "2026-02-15" },
      DFM:        { planned_start: "2026-02-15", planned_end: "2026-02-28", actual_start: "2026-02-16", actual_end: "2026-03-02" },
      Quote:      { planned_start: "2026-03-01", planned_end: "2026-03-10", actual_start: "2026-03-02", actual_end: "2026-03-12" },
      PO:         { planned_start: "2026-03-11", planned_end: "2026-03-20", actual_start: "2026-03-12", actual_end: "2026-03-22" },
      Build:      { planned_start: "2026-03-23", planned_end: "2026-04-30", actual_start: "2026-03-25", actual_end: "2026-05-05" },
      FAT:        { planned_start: "2026-05-06", planned_end: "2026-05-15", actual_start: "2026-05-08", actual_end: "2026-05-18" },
      "In Transit": { planned_start: "2026-05-19", planned_end: "2026-05-26" },
      SAT:        { planned_start: "2026-05-27", planned_end: "2026-06-05", actual_start: "2026-05-27" },
    },
    stations: [
      { name: "Strata station",   deployment_factory: "Farglory" },
      { name: "Bay B station",    deployment_factory: "Farglory" },
      { name: "Bay C station",    deployment_factory: "Farglory" },
    ],
  },
  {
    name: "P2 — ORION — 3-in-1 Connector AOI",
    si_name: "ANDA", customer: "Sunnyhills", cm_site: "Foxconn SJ",
    current_stage: "DFM",
    is_blocked: true, block_reason: "Awaiting customer schematic revision",
    stage_dates: {
      SIRD: { planned_start: "2026-03-01", planned_end: "2026-03-15", actual_start: "2026-03-01", actual_end: "2026-03-18" },
      DFM:  { planned_start: "2026-03-16", planned_end: "2026-04-15", actual_start: "2026-03-18" },
    },
    stations: [{ name: "Inline AOI", deployment_factory: "San Jose" }],
  },
  {
    name: "P3 — NOVA — VR Midplane",
    si_name: "ANDA", customer: "Sunnyhills", cm_site: "Foxconn DG",
    current_stage: "FAT",
    stage_dates: {
      SIRD:       { planned_start: "2026-02-15", planned_end: "2026-02-28", actual_start: "2026-02-15", actual_end: "2026-03-01" },
      DFM:        { planned_start: "2026-03-01", planned_end: "2026-03-15", actual_start: "2026-03-02", actual_end: "2026-03-18" },
      Quote:      { planned_start: "2026-03-16", planned_end: "2026-03-25", actual_start: "2026-03-19", actual_end: "2026-03-26" },
      PO:         { planned_start: "2026-03-26", planned_end: "2026-04-05", actual_start: "2026-03-27", actual_end: "2026-04-08" },
      Build:      { planned_start: "2026-04-09", planned_end: "2026-06-01", actual_start: "2026-04-10" },
      FAT:        { planned_start: "2026-06-12", planned_end: "2026-06-25" },
    },
    stations: [
      { name: "Midplane Front", deployment_factory: "Dongguan" },
      { name: "Midplane Bayside", deployment_factory: "Dongguan" },
      { name: "Optical inspect", deployment_factory: "Dongguan" },
    ],
  },
  {
    name: "Nerds Farglory VR Fixture",
    si_name: "Wistron", customer: "NERDS", cm_site: "Farglory",
    current_stage: "Build",
    stage_dates: {
      SIRD:  { planned_start: "2026-01-15", planned_end: "2026-01-30", actual_start: "2026-01-15", actual_end: "2026-02-02" },
      DFM:   { planned_start: "2026-02-01", planned_end: "2026-02-15", actual_start: "2026-02-03", actual_end: "2026-02-17" },
      Quote: { planned_start: "2026-02-16", planned_end: "2026-02-28", actual_start: "2026-02-18", actual_end: "2026-03-01" },
      PO:    { planned_start: "2026-03-01", planned_end: "2026-03-10", actual_start: "2026-03-02", actual_end: "2026-03-12" },
      Build: { planned_start: "2026-03-13", planned_end: "2026-06-15", actual_start: "2026-03-15" },
      FAT:   { planned_start: "2026-06-20", planned_end: "2026-07-05" },
    },
    stations: [{ name: "Fixture A" }, { name: "Fixture B" }],
  },
  {
    name: "New Power VR Midplane (TPM)",
    si_name: "New Power", customer: "NERDS", cm_site: "Foxconn",
    current_stage: "SIRD",
    stage_dates: {
      SIRD: { planned_start: "2026-05-15", planned_end: "2026-06-05" },
    },
    stations: [{ name: "Station 1" }],
  },
];

async function seedSampleProjects(actor) {
  for (const sp of SAMPLE_PROJECTS) {
    const projRef = push(ref(db, "appState/siProjects"));
    const stationsMap = {};
    (sp.stations || []).forEach((s, i) => {
      const k = push(ref(db, `appState/siProjects/${projRef.key}/stations`)).key;
      stationsMap[k] = {
        station_number: i + 1,
        name: s.name || `Station ${i + 1}`,
        deployment_factory: s.deployment_factory || null,
        customer: null, notes: null,
        created_at: Date.now(),
      };
    });
    const record = {
      name:          sp.name,
      si_name:       sp.si_name,
      customer:      sp.customer || null,
      cm_site:       sp.cm_site || null,
      current_stage: sp.current_stage || "SIRD",
      is_blocked:    !!sp.is_blocked,
      block_reason:  sp.block_reason || null,
      station_count: (sp.stations || []).length || 1,
      stage_dates:   sp.stage_dates || {},
      stations:      stationsMap,
      created_at:    Date.now(),
      updated_at:    Date.now(),
      is_sample:     true,
    };
    await set(projRef, record);
    logSIActivity(projRef.key, "create", `Created sample project "${sp.name}"`, actor);
  }
}

/* Per-project subscribers: a list of emails who should be looped in
   when a new SIRD version is published. Also exposes a per-project
   share token (32-char base64-ish) so vendors can be sent a stable
   read-only URL — token persists on the project so it never changes
   under the vendor's feet. */
function SIRDSubscribersSection({ pid, project, isSIAdminUser, actor }) {
  const siS = useSIS();
  const subs = project.sird_subscribers ? Object.entries(project.sird_subscribers).map(([sid, s]) => ({ sid, ...(s || {}) })) : [];
  const shareToken = project.sird_share_token || null;
  const shareUrl = shareToken ? `${window.location.origin}/share/sird/${shareToken}` : null;

  const ensureShareToken = async () => {
    if (shareToken) return shareToken;
    // crypto.getRandomValues for a URL-safe token; avoids deps.
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await update(ref(db, `appState/siProjects/${pid}`), { sird_share_token: token });
    // Seed the public snapshot so the share URL works immediately.
    await publishPublicSirdSnapshot(token, project, null);
    logSIActivity(pid, "sird_share_token", "Generated SIRD share token", actor);
    return token;
  };
  const copyShareUrl = async () => {
    const token = await ensureShareToken();
    const url = `${window.location.origin}/share/sird/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      alert(`Share URL copied:\n\n${url}\n\n(Note: the /share/sird/* route isn't built yet — it will resolve once a public read-only viewer is added.)`);
    } catch (_) {
      prompt("Copy this share URL:", url);
    }
  };
  const revokeShareToken = async () => {
    if (!confirm("Revoke the current share URL? Anyone with the old link will lose access.")) return;
    await update(ref(db, `appState/siProjects/${pid}`), { sird_share_token: null });
    // Delete the public copy so the vendor URL stops resolving.
    if (shareToken) await remove(ref(db, `appState/publicSird/${shareToken}`));
    logSIActivity(pid, "sird_share_revoke", "Revoked SIRD share token", actor);
  };
  const addSubscriber = async () => {
    const email = prompt("Subscriber email:");
    if (!email) return;
    const name = prompt("Display name (optional):", "") || "";
    const role = prompt("Role (e.g. PM, SI lead) (optional):", "") || "";
    const newRef = push(ref(db, `appState/siProjects/${pid}/sird_subscribers`));
    await set(newRef, {
      email: email.trim().toLowerCase(),
      name: name.trim() || null,
      role: role.trim() || null,
      added_at: Date.now(),
      added_by: actor,
    });
    logSIActivity(pid, "sird_subscriber_add", `Added subscriber ${email.trim()}`, actor);
  };
  const removeSubscriber = (s) => {
    if (!confirm(`Remove subscriber ${s.email}?`)) return;
    remove(ref(db, `appState/siProjects/${pid}/sird_subscribers/${s.sid}`));
    logSIActivity(pid, "sird_subscriber_remove", `Removed subscriber ${s.email}`, actor);
  };

  return (
    <Section title={`Subscribers & share (${subs.length})`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontFamily: SI_F, fontSize: 12, color: "#475569", fontWeight: 600, marginBottom: 6 }}>Share URL (read-only for vendors)</div>
          {shareToken ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <code style={{ flex: 1, minWidth: 240, padding: "5px 8px", background: "#F1F5F9", borderRadius: 5, fontSize: 12, color: "#0F172A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shareUrl}</code>
              <button onClick={copyShareUrl}
                style={{ padding: "5px 12px", border: "1px solid #2563EB", borderRadius: 5, background: "#FFF", color: "#2563EB", fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>📋 Copy</button>
              {isSIAdminUser && (
                <button onClick={revokeShareToken}
                  style={{ padding: "5px 12px", border: "1px solid #FECACA", borderRadius: 5, background: "#FFF", color: "#DC2626", fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Revoke</button>
              )}
            </div>
          ) : (
            isSIAdminUser ? (
              <button onClick={copyShareUrl}
                style={{ padding: "6px 14px", border: "1px solid #2563EB", borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                Generate share URL
              </button>
            ) : <span style={{ fontFamily: SI_F, fontSize: 13, color: "#94A3B8" }}>Not generated yet.</span>
          )}
        </div>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div style={{ fontFamily: SI_F, fontSize: 12, color: "#475569", fontWeight: 600 }}>Subscribers</div>
            <div style={{ flex: 1 }} />
            {isSIAdminUser && (
              <button onClick={addSubscriber}
                style={{ padding: "3px 12px", border: "1px solid #2563EB", borderRadius: 5, background: "#FFF", color: "#2563EB", fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ Add subscriber</button>
            )}
          </div>
          {subs.length === 0 ? (
            <div style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 13 }}>No subscribers yet.</div>
          ) : (
            <table style={siS.table}>
              <thead>
                <tr>
                  <th style={siS.th}>Email</th>
                  <th style={siS.th}>Name</th>
                  <th style={siS.th}>Role</th>
                  <th style={siS.th}>Added</th>
                  {isSIAdminUser && <th style={siS.th}></th>}
                </tr>
              </thead>
              <tbody>
                {subs.map(s => (
                  <tr key={s.sid}>
                    <td style={siS.td}><a href={`mailto:${s.email}`} style={{ color: "#2563EB", textDecoration: "none" }}>{s.email}</a></td>
                    <td style={siS.td}>{s.name || <span style={{ color: "#94A3B8" }}>—</span>}</td>
                    <td style={siS.td}>{s.role || <span style={{ color: "#94A3B8" }}>—</span>}</td>
                    <td style={siS.td}><span style={{ color: "#64748B", fontSize: 11 }}>{s.added_at ? new Date(s.added_at).toLocaleDateString() : "—"}</span></td>
                    {isSIAdminUser && (
                      <td style={siS.td}>
                        <button onClick={() => removeSubscriber(s)}
                          style={{ background: "transparent", border: 0, color: "#DC2626", fontSize: 14, cursor: "pointer", lineHeight: 1 }}>×</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Section>
  );
}

function SIRDGeneratorView({ projectList, isSIAdminUser, user, initialPid, onConsumeInitialPid }) {
  const siS = useSIS();
  const [pid, setPid] = useState(initialPid || "");
  useEffect(() => {
    if (initialPid) { setPid(initialPid); onConsumeInitialPid && onConsumeInitialPid(); }
  }, [initialPid]);
  const project = pid ? projectList.find(p => p.pid === pid) : null;
  const responses = project?.sird_responses || {};
  const versions = Object.entries(project?.sird_versions || {})
    .map(([vid, v]) => ({ vid, ...(v || {}) }))
    .sort((a, b) => (b.version || 0) - (a.version || 0));
  const actor = user?.email || user?.name || "unknown";
  const save = (qid, value) => set(ref(db, `appState/siProjects/${pid}/sird_responses/${qid}`), value);
  const publishVersion = async () => {
    const nextVersion = versions.length ? Math.max(...versions.map(v => v.version || 0)) + 1 : 1;
    const summary = prompt("Brief change summary for this version (optional):", "") || "";
    const newRef = push(ref(db, `appState/siProjects/${pid}/sird_versions`));
    await set(newRef, {
      version: nextVersion,
      responses: responses,
      change_summary: summary.trim() || null,
      published_at: Date.now(),
      published_by: actor,
      sent_to_vendor_at: null,
      sent_to_vendor_by: null,
    });
    // Also bump SIRD version + mark project as having a published SIRD.
    update(ref(db, `appState/siProjects/${pid}`), {
      sird_version: nextVersion,
      sird_published_at: Date.now(),
    });
    // Refresh public snapshot if a share token already exists.
    if (project.sird_share_token) {
      await publishPublicSirdSnapshot(project.sird_share_token, project, {
        version: nextVersion, responses, published_at: Date.now(), published_by: actor, sent_to_vendor_at: null,
      });
    }
    logSIActivity(pid, "sird_publish", `Published SIRD v${nextVersion}${summary ? `: ${summary.trim()}` : ""}`, actor);
  };
  // Render a SIRD version's snapshot to a .docx and trigger a browser
  // download. Pure client-side via the `docx` npm package — no Function
  // needed, no server round-trip. Layout: project title, then one H2
  // per section + a question/answer paragraph pair per field.
  const downloadDocx = async (v) => {
    const responsesSnapshot = v.responses || {};
    const sections = SIRD_SECTIONS.map(sec => {
      const blocks = [
        new DocxParagraph({ text: sec.title, heading: DocxHeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } }),
      ];
      for (const f of sec.fields) {
        blocks.push(new DocxParagraph({
          children: [new DocxTextRun({ text: f.label, bold: true })],
        }));
        const answer = responsesSnapshot[f.id];
        blocks.push(new DocxParagraph({
          children: [new DocxTextRun({ text: answer && String(answer).trim() ? String(answer) : "(blank)" })],
          spacing: { after: 120 },
        }));
      }
      return blocks;
    }).flat();
    const doc = new DocxDocument({
      sections: [{
        properties: {},
        children: [
          new DocxParagraph({ text: project.name || "SIRD", heading: DocxHeadingLevel.TITLE }),
          new DocxParagraph({
            children: [new DocxTextRun({ text: `SI partner: ${project.si_name || "—"}    ·    Version ${v.version}    ·    Published ${v.published_at ? new Date(v.published_at).toLocaleString() : "—"}`, italics: true, color: "64748B" })],
            spacing: { after: 240 },
          }),
          ...sections,
        ],
      }],
    });
    const blob = await DocxPacker.toBlob(doc);
    const safeName = (project.name || "SIRD").replace(/[^A-Za-z0-9._-]/g, "_");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${safeName}_SIRD_v${v.version}.docx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const markSent = async (v) => {
    const now = Date.now();
    await update(ref(db, `appState/siProjects/${pid}/sird_versions/${v.vid}`), {
      sent_to_vendor_at: now,
      sent_to_vendor_by: actor,
    });
    if (project.sird_share_token) {
      await publishPublicSirdSnapshot(project.sird_share_token, project, { ...v, sent_to_vendor_at: now });
    }
    logSIActivity(pid, "sird_send", `SIRD v${v.version} sent to vendor`, actor);
  };
  // Save All — flushes the local in-memory form to RTDB in one batch.
  // Auto-save on blur already covers most cases, but the user expects an
  // explicit Save button as well to mirror fixture_tracker.
  const formRef = useRef({});
  const saveAll = async () => {
    const all = formRef.current;
    const updates = {};
    for (const [qid, val] of Object.entries(all)) updates[qid] = val || null;
    if (Object.keys(updates).length > 0) {
      await update(ref(db, `appState/siProjects/${pid}/sird_responses`), updates);
    }
  };

  // Compact role pill rendered next to a field label.
  const rolePill = (role) => {
    if (!role) return null;
    const c = SIRD_ROLE_COLORS[role] || { bg: "#E2E8F0", fg: "#475569" };
    return (
      <span style={{ marginLeft: 6, background: c.bg, color: c.fg, padding: "1px 6px", borderRadius: 4, fontFamily: SI_F, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>{role}</span>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <ProjectPickerBar projectList={projectList} value={pid} onChange={setPid}
        title="SIRD Generator"
        subtitle="Pick a project to draft, publish, and send its SIRD." />

      {project && isSIAdminUser && (
        <div style={{ display: "flex", gap: 8 }}>
          <AICoverageDocImportButton pid={pid} sections={SIRD_SECTIONS} actor={actor} />
          <button onClick={publishVersion}
            style={{ padding: "8px 16px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            Publish new version
          </button>
        </div>
      )}

      {project && versions.length > 0 && (
        <div style={siS.card}>
          <h3 style={{ ...siS.h2, fontSize: 14, marginBottom: 10 }}>Versions</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={siS.table}>
              <thead>
                <tr>
                  <th style={siS.th}>v</th>
                  <th style={siS.th}>Type</th>
                  <th style={siS.th}>Published</th>
                  <th style={siS.th}>Sent</th>
                  <th style={siS.th}>Summary</th>
                  {isSIAdminUser && <th style={siS.th}></th>}
                </tr>
              </thead>
              <tbody>
                {versions.map((v, idx) => (
                  <tr key={v.vid}>
                    <td style={siS.td}><strong>v{v.version}</strong>{idx === 0 ? " ★" : ""}</td>
                    <td style={siS.td}>{v.change_type || "minor"}</td>
                    <td style={siS.td}>
                      {v.published_at ? new Date(v.published_at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}
                      {v.published_by ? ` · ${v.published_by}` : ""}
                    </td>
                    <td style={siS.td}>
                      {v.sent_to_vendor_at ? new Date(v.sent_to_vendor_at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : <span style={{ color: siS.textMuted }}>—</span>}
                    </td>
                    <td style={siS.td}>{v.change_summary || ""}</td>
                    {isSIAdminUser && (
                      <td style={siS.td}>
                        <button onClick={() => downloadDocx(v)}
                          style={{ padding: "4px 12px", border: `1px solid ${siS.cardBorder}`, borderRadius: 5, background: siS.cardSoft, color: siS.text, fontFamily: SI_F, fontSize: 11.5, fontWeight: 600, cursor: "pointer", marginRight: 6 }}>
                          .docx
                        </button>
                        {!v.sent_to_vendor_at ? (
                          <button onClick={() => markSent(v)}
                            style={{ padding: "4px 12px", border: 0, borderRadius: 5, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                            Send to vendor
                          </button>
                        ) : null}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {project && (
        <UploadedSirdsCard pid={pid} project={project} isSIAdminUser={isSIAdminUser} actor={actor} />
      )}

      {project && (
        <div style={siS.card}>
          <h3 style={{ ...siS.h2, fontSize: 14, marginBottom: 14 }}>Questionnaire ({SIRD_SECTIONS.length} sections)</h3>
          {SIRD_SECTIONS.map(sec => (
            <div key={sec.id} style={{ marginBottom: 18 }}>
              <div style={{ fontFamily: SI_F, fontSize: 13, fontWeight: 700, color: siS.text, marginBottom: 8 }}>{sec.title}</div>
              {sec.fields.map(f => (
                <div key={f.id} style={{ background: siS.cardSoft, borderLeft: `3px solid #C7D2FE`, borderRadius: 4, padding: "8px 12px", marginBottom: 8 }}>
                  <label style={{ display: "block", fontFamily: SI_F, fontSize: 12.5, color: siS.text, fontWeight: 600, marginBottom: 6 }}>
                    {f.label}{rolePill(f.role)}
                  </label>
                  {f.type === "textarea" ? (
                    <textarea key={pid + f.id} defaultValue={responses[f.id] || ""} disabled={!isSIAdminUser}
                      onChange={e => { formRef.current[f.id] = e.target.value; }}
                      onBlur={e => save(f.id, e.target.value)}
                      style={{ width: "100%", minHeight: 56, padding: 8, border: `1px solid ${siS.inputBorder}`, borderRadius: 5, background: siS.isDark ? "#0F172A" : "#1F2937", fontFamily: SI_F, fontSize: 13, lineHeight: 1.45, color: "#F8FAFC", boxSizing: "border-box", resize: "vertical" }} />
                  ) : f.type === "select" ? (
                    <select key={pid + f.id} defaultValue={responses[f.id] || ""} disabled={!isSIAdminUser}
                      onChange={e => { formRef.current[f.id] = e.target.value; save(f.id, e.target.value); }}
                      style={{ width: "100%", padding: "8px 10px", border: `1px solid ${siS.inputBorder}`, borderRadius: 5, background: siS.isDark ? "#0F172A" : "#1F2937", fontFamily: SI_F, fontSize: 13, color: "#F8FAFC", boxSizing: "border-box" }}>
                      <option value=""></option>
                      {(f.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  ) : (
                    <input type={f.type === "date" ? "date" : "text"}
                      key={pid + f.id} defaultValue={responses[f.id] || ""} disabled={!isSIAdminUser}
                      onChange={e => { formRef.current[f.id] = e.target.value; }}
                      onBlur={e => save(f.id, e.target.value)}
                      style={{ width: "100%", padding: "8px 10px", border: `1px solid ${siS.inputBorder}`, borderRadius: 5, background: siS.isDark ? "#0F172A" : "#1F2937", fontFamily: SI_F, fontSize: 13, color: "#F8FAFC", boxSizing: "border-box" }} />
                  )}
                </div>
              ))}
            </div>
          ))}
          {isSIAdminUser && (
            <button onClick={saveAll}
              style={{ padding: "8px 16px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              Save all answers
            </button>
          )}
        </div>
      )}

      {project && (
        <SIRDSubscribersSection pid={pid} project={project} isSIAdminUser={isSIAdminUser} actor={actor} />
      )}
    </div>
  );
}

/* Uploaded SIRDs & links — files in project.files where category is
   "sird_upload" or kind is "link". Drop-in upload + "Add link" buttons. */
function UploadedSirdsCard({ pid, project, isSIAdminUser, actor }) {
  const siS = useSIS();
  const { openPreview } = useContext(SIPreviewCtx);
  const items = Object.entries(project?.files || {})
    .map(([fid, f]) => ({ fid, ...(f || {}) }))
    .filter(f => f.category === "sird_upload" || (f.kind === "link" && f.category === "sird"));
  const fileInput = useRef(null);
  const uploadFile = async (file) => {
    if (!file) return;
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
    const storagePath = `siProjectFiles/${pid}/sird_upload/${Date.now()}_${safeName}`;
    const { ref: sref, uploadBytes, getDownloadURL } = await import("firebase/storage");
    const { storage } = await import("./firebase");
    const r = sref(storage, storagePath);
    await uploadBytes(r, file);
    const downloadUrl = await getDownloadURL(r);
    const newKey = push(ref(db, `appState/siProjects/${pid}/files`)).key;
    await set(ref(db, `appState/siProjects/${pid}/files/${newKey}`), {
      category: "sird_upload", kind: "file",
      filename: file.name, storagePath, downloadUrl,
      mimeType: file.type || "", size: file.size || 0,
      uploaded_at: Date.now(), uploaded_by: actor,
    });
    logSIActivity(pid, "sird_upload", `Uploaded SIRD file: ${file.name}`, actor);
  };
  const addLink = async () => {
    const url = prompt("Paste a link URL:");
    if (!url) return;
    const u = sanitizeUrl(url);
    if (!u) { alert("That URL was rejected (must be https://)."); return; }
    const label = prompt("Link label:", u) || u;
    const newKey = push(ref(db, `appState/siProjects/${pid}/files`)).key;
    await set(ref(db, `appState/siProjects/${pid}/files/${newKey}`), {
      category: "sird", kind: "link",
      filename: label.trim(), url: u, uploaded_at: Date.now(), uploaded_by: actor,
    });
    logSIActivity(pid, "sird_link", `Added SIRD link: ${label.trim()}`, actor);
  };
  return (
    <div style={siS.card}>
      <h3 style={{ ...siS.h2, fontSize: 14, marginBottom: 10 }}>Uploaded SIRDs & links</h3>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ fontFamily: SI_F, fontSize: 12, fontWeight: 700, color: siS.text }}>Files & links</span>
        <span style={{ fontFamily: SI_F, fontSize: 11.5, color: siS.textMuted }}>{items.length} item{items.length === 1 ? "" : "s"}</span>
        <div style={{ flex: 1 }} />
        {isSIAdminUser && (
          <>
            <button onClick={() => fileInput.current?.click()}
              style={{ padding: "5px 14px", border: `1px solid ${siS.link}`, borderRadius: 6, background: "transparent", color: siS.link, fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              ↑ Upload
            </button>
            <input ref={fileInput} type="file" style={{ display: "none" }}
              onChange={e => { uploadFile(e.target.files?.[0]); e.target.value = ""; }} />
            <button onClick={addLink}
              style={{ padding: "5px 14px", border: `1px solid ${siS.cardBorder}`, borderRadius: 6, background: "transparent", color: siS.text, fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              🔗 Add link
            </button>
          </>
        )}
      </div>
      {items.length === 0
        ? <div style={{ color: siS.textMuted, fontFamily: SI_F, fontSize: 12 }}>No items yet.</div>
        : <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {items.map(f => (
              <li key={f.fid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: `1px dotted ${siS.cardBorder}`, fontFamily: SI_F, fontSize: 12 }}>
                <span>{f.kind === "link" ? "🔗" : "📄"}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: siS.text }}>{f.filename}</span>
                {f.kind !== "link" && f.downloadUrl && (
                  <button onClick={() => openPreview({ filename: f.filename, downloadUrl: f.downloadUrl, mimeType: f.mimeType })}
                    style={{ padding: "3px 9px", border: `1px solid ${siS.cardBorder}`, borderRadius: 5, background: "transparent", color: siS.link, fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                    👁 Preview
                  </button>
                )}
                <a href={f.url || f.downloadUrl} target="_blank" rel="noopener"
                  style={{ padding: "3px 9px", border: `1px solid ${siS.cardBorder}`, borderRadius: 5, background: "transparent", color: siS.link, fontFamily: SI_F, fontSize: 11, fontWeight: 600, cursor: "pointer", textDecoration: "none" }}>
                  {f.kind === "link" ? "↗ Open" : "⬇ Download"}
                </a>
              </li>
            ))}
          </ul>}
    </div>
  );
}

/* ── FAT/SAT Test Plan Generator (simplified) ─────────────────────────
   For each project: a FAT plan and a SAT plan, each with an editable
   list of test rows (description, criterion, result). Sign-off,
   deviations, and executed xlsx parsing are stubbed for a later session. */
const DEFAULT_PLAN_ROWS = {
  fat: [
    { test_id: "FAT-001", description: "Power on test",                 pass_criterion: "Boots cleanly within 60s" },
    { test_id: "FAT-002", description: "Camera image capture",          pass_criterion: "Image stream visible, no dropped frames in 5 min" },
    { test_id: "FAT-003", description: "Inspection algorithm runs",     pass_criterion: "Algorithm returns result on sample part" },
    { test_id: "FAT-004", description: "Reject mechanism actuates",     pass_criterion: "Reject solenoid fires on fail signal" },
    { test_id: "FAT-005", description: "Cycle time meets spec",         pass_criterion: "Throughput ≥ spec" },
  ],
  sat: [
    { test_id: "SAT-001", description: "Installation complete",         pass_criterion: "Station mounted, powered, networked" },
    { test_id: "SAT-002", description: "Calibration with customer parts", pass_criterion: "Algorithm accepts known-good, rejects known-bad" },
    { test_id: "SAT-003", description: "Production-line integration",   pass_criterion: "Triggers + handshakes work with MES" },
    { test_id: "SAT-004", description: "Run rate on line",              pass_criterion: "Throughput ≥ spec on customer parts" },
  ],
};

/* Summary row of FAT/SAT plans for the selected project. Click Edit to
   open the inline row editor below. */
function TestPlanSummaryTable({ project, onEdit, siS }) {
  const fat = project?.test_plans?.fat || null;
  const sat = project?.test_plans?.sat || null;
  const stationCount = Object.keys(project?.stations || {}).length;
  const planRow = (kind, p) => {
    if (!p) return null;
    const rows = Object.values(p.rows || {});
    const total = rows.length;
    const pass = rows.filter(r => r.result === "pass").length;
    const fail = rows.filter(r => r.result === "fail").length;
    const pending = total - pass - fail;
    const result = total === 0 ? "—" : (
      <span style={{ fontFamily: SI_F, fontSize: 11.5 }}>
        <strong style={{ color: "#16A34A" }}>{pass}P</strong> · <strong style={{ color: "#DC2626" }}>{fail}F</strong> · <strong style={{ color: "#F59E0B" }}>{pending}p</strong>
      </span>
    );
    const sent = p.sent_to_vendor_at ? new Date(p.sent_to_vendor_at).toLocaleDateString() : "—";
    const signedOff = p.signed_off_at ? new Date(p.signed_off_at).toLocaleDateString() : "—";
    return (
      <tr key={kind}>
        <td style={siS.td}>{kind.toUpperCase()}</td>
        <td style={siS.td}>v{p.version || 1}</td>
        <td style={siS.td}>{stationCount}</td>
        <td style={siS.td}>{p.status || "draft"}</td>
        <td style={siS.td}>{result}</td>
        <td style={siS.td}>{sent}</td>
        <td style={siS.td}>{signedOff}</td>
        <td style={siS.td}>
          <button onClick={() => onEdit(kind)}
            style={{ padding: "4px 14px", border: `1px solid ${siS.cardBorder}`, borderRadius: 5, background: siS.cardSoft, color: siS.text, fontFamily: SI_F, fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>
            Edit
          </button>
        </td>
      </tr>
    );
  };
  if (!fat && !sat) {
    return (
      <div style={siS.card}>
        <h3 style={{ ...siS.h2, fontSize: 14, marginBottom: 8 }}>FAT / SAT Plans</h3>
        <div style={{ color: siS.textMuted, fontFamily: SI_F, fontSize: 13 }}>No plans yet. Use the "+ New FAT plan" or "+ New SAT plan" button to create one.</div>
      </div>
    );
  }
  return (
    <div style={siS.card}>
      <h3 style={{ ...siS.h2, fontSize: 14, marginBottom: 10 }}>FAT / SAT Plans</h3>
      <table style={siS.table}>
        <thead>
          <tr>
            <th style={siS.th}>Type</th>
            <th style={siS.th}>v</th>
            <th style={siS.th}>Stations</th>
            <th style={siS.th}>Status</th>
            <th style={siS.th}>Result</th>
            <th style={siS.th}>Sent</th>
            <th style={siS.th}>Signed off</th>
            <th style={siS.th}></th>
          </tr>
        </thead>
        <tbody>
          {planRow("fat", fat)}
          {planRow("sat", sat)}
        </tbody>
      </table>
    </div>
  );
}

/* Uploaded test plans & links — two side-by-side zones for FAT and SAT. */
function TestPlanFilesCard({ pid, project, isSIAdminUser, actor }) {
  const siS = useSIS();
  const { openPreview } = useContext(SIPreviewCtx);
  const itemsFor = (kind) => Object.entries(project?.files || {})
    .map(([fid, f]) => ({ fid, ...(f || {}) }))
    .filter(f => f.category === `${kind}_upload` || (f.kind === "link" && f.category === kind));
  const uploadFile = async (file, kind) => {
    if (!file) return;
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
    const storagePath = `siProjectFiles/${pid}/${kind}_upload/${Date.now()}_${safeName}`;
    const { ref: sref, uploadBytes, getDownloadURL } = await import("firebase/storage");
    const { storage } = await import("./firebase");
    const r = sref(storage, storagePath);
    await uploadBytes(r, file);
    const downloadUrl = await getDownloadURL(r);
    const newKey = push(ref(db, `appState/siProjects/${pid}/files`)).key;
    await set(ref(db, `appState/siProjects/${pid}/files/${newKey}`), {
      category: `${kind}_upload`, kind: "file",
      filename: file.name, storagePath, downloadUrl,
      mimeType: file.type || "", size: file.size || 0,
      uploaded_at: Date.now(), uploaded_by: actor,
    });
    logSIActivity(pid, `${kind}_upload`, `Uploaded ${kind.toUpperCase()} file: ${file.name}`, actor);
  };
  const addLink = async (kind) => {
    const url = prompt("Paste a link URL:");
    if (!url) return;
    const u = sanitizeUrl(url);
    if (!u) { alert("URL must be https://"); return; }
    const label = prompt("Link label:", u) || u;
    const newKey = push(ref(db, `appState/siProjects/${pid}/files`)).key;
    await set(ref(db, `appState/siProjects/${pid}/files/${newKey}`), {
      category: kind, kind: "link",
      filename: label.trim(), url: u, uploaded_at: Date.now(), uploaded_by: actor,
    });
    logSIActivity(pid, `${kind}_link`, `Added ${kind.toUpperCase()} link: ${label.trim()}`, actor);
  };
  const Zone = ({ kind }) => {
    const items = itemsFor(kind);
    const fileInput = useRef(null);
    return (
      <div style={{ background: siS.cardSoft, border: `1px solid ${siS.cardBorder}`, borderRadius: 6, padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontFamily: SI_F, fontSize: 12, fontWeight: 700, color: siS.text }}>{kind.toUpperCase()} files & links</span>
          <span style={{ fontFamily: SI_F, fontSize: 11.5, color: siS.textMuted }}>{items.length} item{items.length === 1 ? "" : "s"}</span>
          <div style={{ flex: 1 }} />
          {isSIAdminUser && (
            <>
              <button onClick={() => fileInput.current?.click()}
                style={{ padding: "4px 12px", border: `1px solid ${siS.link}`, borderRadius: 5, background: "transparent", color: siS.link, fontFamily: SI_F, fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>↑ Upload</button>
              <input ref={fileInput} type="file" style={{ display: "none" }}
                onChange={e => { uploadFile(e.target.files?.[0], kind); e.target.value = ""; }} />
              <button onClick={() => addLink(kind)}
                style={{ padding: "4px 12px", border: `1px solid ${siS.cardBorder}`, borderRadius: 5, background: "transparent", color: siS.text, fontFamily: SI_F, fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>🔗 Add link</button>
            </>
          )}
        </div>
        {items.length === 0
          ? <div style={{ color: siS.textMuted, fontFamily: SI_F, fontSize: 11.5 }}>No items yet.</div>
          : <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>{items.map(f => (
              <li key={f.fid} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", borderTop: `1px dotted ${siS.cardBorder}`, fontFamily: SI_F, fontSize: 11.5 }}>
                <span>{f.kind === "link" ? "🔗" : "📄"}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: siS.text }}>{f.filename}</span>
                {f.kind !== "link" && f.downloadUrl && (
                  <button onClick={() => openPreview({ filename: f.filename, downloadUrl: f.downloadUrl, mimeType: f.mimeType })}
                    style={{ background: "transparent", border: 0, color: siS.link, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>👁</button>
                )}
                <a href={f.url || f.downloadUrl} target="_blank" rel="noopener"
                  style={{ color: siS.link, fontSize: 11, fontWeight: 600, textDecoration: "none" }}>{f.kind === "link" ? "↗" : "⬇"}</a>
              </li>
            ))}</ul>}
      </div>
    );
  };
  return (
    <div style={siS.card}>
      <h3 style={{ ...siS.h2, fontSize: 14, marginBottom: 10 }}>Uploaded test plans & links</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Zone kind="fat" />
        <Zone kind="sat" />
      </div>
    </div>
  );
}

/* Internal Prereqs — small editable table at appState/siProjects/{pid}/prereqs. */
function TestPlanPrereqs({ pid, project, isSIAdminUser, actor }) {
  const siS = useSIS();
  const list = Object.entries(project?.prereqs || {})
    .map(([prid, p]) => ({ prid, ...(p || {}) }))
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  const [desc, setDesc] = useState("");
  const [owner, setOwner] = useState("");
  const add = async () => {
    if (!desc.trim()) return;
    const k = push(ref(db, `appState/siProjects/${pid}/prereqs`)).key;
    await set(ref(db, `appState/siProjects/${pid}/prereqs/${k}`), {
      description: desc.trim(), owner: owner.trim() || null, status: "open", created_at: Date.now(),
    });
    setDesc(""); setOwner("");
    logSIActivity(pid, "prereq_add", `Prereq: ${desc.trim().slice(0, 80)}`, actor);
  };
  const setStatus = (prid, status) =>
    update(ref(db, `appState/siProjects/${pid}/prereqs/${prid}`), { status });
  const del = (prid) => { if (confirm("Delete this prereq?")) remove(ref(db, `appState/siProjects/${pid}/prereqs/${prid}`)); };
  const darkInput = {
    width: "100%", padding: "8px 10px", border: `1px solid ${siS.inputBorder}`, borderRadius: 5,
    background: siS.isDark ? "#0F172A" : "#1F2937", fontFamily: SI_F, fontSize: 13, color: "#F8FAFC", boxSizing: "border-box",
  };
  return (
    <div style={siS.card}>
      <h3 style={{ ...siS.h2, fontSize: 14, marginBottom: 10 }}>Internal Prereqs ({list.length})</h3>
      <table style={siS.table}>
        <thead>
          <tr>
            <th style={siS.th}>Description</th>
            <th style={{ ...siS.th, width: 180 }}>Owner</th>
            <th style={{ ...siS.th, width: 140 }}>Status</th>
            {isSIAdminUser && <th style={{ ...siS.th, width: 30 }}></th>}
          </tr>
        </thead>
        <tbody>
          {list.map(p => (
            <tr key={p.prid}>
              <td style={siS.td}>{p.description}</td>
              <td style={siS.td}>{p.owner || <span style={{ color: siS.textMuted }}>—</span>}</td>
              <td style={siS.td}>
                {isSIAdminUser ? (
                  <select value={p.status || "open"} onChange={e => setStatus(p.prid, e.target.value)}
                    style={{ fontFamily: SI_F, fontSize: 12, padding: "3px 6px", border: `1px solid ${siS.inputBorder}`, borderRadius: 5, background: siS.inputBg, color: siS.text }}>
                    <option value="open">open</option>
                    <option value="in_progress">in progress</option>
                    <option value="done">done</option>
                    <option value="blocked">blocked</option>
                  </select>
                ) : (p.status || "open")}
              </td>
              {isSIAdminUser && (
                <td style={siS.td}><button onClick={() => del(p.prid)} style={{ background: "transparent", border: 0, color: "#DC2626", fontSize: 14, cursor: "pointer" }}>×</button></td>
              )}
            </tr>
          ))}
          {isSIAdminUser && (
            <tr>
              <td style={siS.td}><input value={desc} onChange={e => setDesc(e.target.value)} placeholder="description" style={darkInput} /></td>
              <td style={siS.td}><input value={owner} onChange={e => setOwner(e.target.value)} placeholder="owner" style={darkInput} /></td>
              <td style={siS.td}>
                <button onClick={add}
                  style={{ padding: "7px 16px", border: 0, borderRadius: 5, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  Add
                </button>
              </td>
              <td style={siS.td}></td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* "New FAT plan" / "New SAT plan" modal — asks for station count, then
   seeds rows from the library (or DEFAULT_PLAN_ROWS) and creates the plan. */
function NewTestPlanModal({ kind, pid, actor, onClose, onCreated }) {
  const [stationCount, setStationCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    try {
      // Seed from library (rows tagged for this kind), fallback to defaults.
      let seed = [];
      try {
        const libSnap = await new Promise(res => onValue(ref(db, "appState/testPlanLibrary"), s => res(s.val() || {}), { onlyOnce: true }));
        seed = Object.values(libSnap)
          .filter(t => t && t.is_active !== false && (kind === "fat" ? t.applies_to_fat !== false : t.applies_to_sat !== false))
          .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
          .map(t => ({
            test_id: t.test_id || "",
            description: t.description || "",
            pass_criterion: t.pass_criterion || "",
            module: t.module || null,
            phase: t.phase || null,
          }));
      } catch (_) {}
      if (seed.length === 0) seed = DEFAULT_PLAN_ROWS[kind];
      const rowsMap = {};
      seed.forEach((r, i) => {
        const k = push(ref(db, `appState/siProjects/${pid}/test_plans/${kind}/rows`)).key;
        rowsMap[k] = { ...r, sort_order: i + 1, result: "pending", created_at: Date.now() };
      });
      await set(ref(db, `appState/siProjects/${pid}/test_plans/${kind}`), {
        created_at: Date.now(), status: "draft", version: 1,
        station_count: stationCount, rows: rowsMap,
      });
      logSIActivity(pid, "testplan_create", `Generated ${kind.toUpperCase()} plan (${seed.length} rows, ${stationCount} station${stationCount === 1 ? "" : "s"})`, actor);
      onCreated(kind);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#FFFFFF", borderRadius: 10, padding: 22, width: "min(440px, 92vw)", boxShadow: "0 24px 60px rgba(0,0,0,0.4)" }}>
        <h3 style={{ margin: "0 0 6px", fontFamily: SI_F, fontSize: 16, color: "#0F172A", fontWeight: 700 }}>New {kind.toUpperCase()} plan</h3>
        <p style={{ margin: "0 0 14px", fontFamily: SI_F, fontSize: 12.5, color: "#64748B" }}>
          Library rows tagged for this plan type will be copied in. Edit per-row afterwards.
        </p>
        <label style={{ display: "block", fontFamily: SI_F, fontSize: 12, color: "#475569", fontWeight: 600, marginBottom: 4 }}>Station count</label>
        <input type="number" min={1} value={stationCount}
          onChange={e => setStationCount(Math.max(1, parseInt(e.target.value || "1", 10)))}
          style={{ width: "100%", padding: "8px 10px", border: "1px solid #CBD5E1", borderRadius: 6, background: "#1F2937", color: "#F8FAFC", fontFamily: SI_F, fontSize: 13, marginBottom: 16, boxSizing: "border-box" }} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={busy}
            style={{ padding: "8px 16px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#0F172A", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={generate} disabled={busy}
            style={{ padding: "8px 16px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: busy ? "wait" : "pointer" }}>
            {busy ? "Generating…" : "Generate"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TestPlanGeneratorView({ projectList, isSIAdminUser, user, initialPid, onConsumeInitialPid }) {
  const siS = useSIS();
  const [mode, setMode] = useState("generate"); // generate | library
  const actor = user?.email || user?.name || "unknown";
  const subBtn = (id, label) => (
    <button onClick={() => setMode(id)}
      style={{
        padding: "6px 14px",
        border: `1px solid ${mode === id ? "#2563EB" : "#E2E8F0"}`,
        borderRadius: 8,
        background: mode === id ? "#EFF6FF" : "#FFF",
        color: mode === id ? "#2563EB" : "#64748B",
        fontFamily: SI_F, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
      }}>{label}</button>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={siS.card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <h2 style={{ ...siS.h2, fontSize: 16, margin: 0 }}>FAT/SAT Test Plan Generator</h2>
          <span style={{ fontFamily: SI_F, fontSize: 12, color: siS.textMuted }}>
            Generate a per-project plan, or edit the shared library that seeds new plans.
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {subBtn("generate", "Generate plan")}
          {subBtn("library",  "Library")}
        </div>
      </div>
      {mode === "library"
        ? <TestPlanLibraryView isSIAdminUser={isSIAdminUser} actor={actor} />
        : <TestPlanGeneratePane projectList={projectList} isSIAdminUser={isSIAdminUser} user={user} initialPid={initialPid} onConsumeInitialPid={onConsumeInitialPid} />}
    </div>
  );
}

function TestPlanGeneratePane({ projectList, isSIAdminUser, user, initialPid, onConsumeInitialPid }) {
  const siS = useSIS();
  const [pid, setPid] = useState(initialPid || "");
  useEffect(() => {
    if (initialPid) { setPid(initialPid); onConsumeInitialPid && onConsumeInitialPid(); }
  }, [initialPid]);
  const [planType, setPlanType] = useState("fat");
  const [editingPlan, setEditingPlan] = useState(null);  // "fat" | "sat" | null
  const [newPlanModal, setNewPlanModal] = useState(null); // "fat" | "sat" | null
  const project = pid ? projectList.find(p => p.pid === pid) : null;
  const plan = project?.test_plans?.[planType] || null;
  const rows = plan?.rows ? Object.entries(plan.rows).map(([rid, r]) => ({ rid, ...r })).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)) : [];
  const deviations = plan?.deviations ? Object.entries(plan.deviations).map(([did, d]) => ({ did, ...d })).sort((a, b) => (a.sequence || 0) - (b.sequence || 0)) : [];
  const actor = user?.email || user?.name || "unknown";
  const signedOff = !!plan?.signed_off_at;

  const ensurePlan = async () => {
    if (plan) return plan;
    // Prefer the user-curated library if it has templates that apply
    // to this plan type; fall back to DEFAULT_PLAN_ROWS otherwise.
    let seed = [];
    try {
      const libSnap = await new Promise(res => onValue(ref(db, "appState/testPlanLibrary"), s => res(s.val() || {}), { onlyOnce: true }));
      seed = Object.values(libSnap)
        .filter(t => t && t.is_active !== false && (planType === "fat" ? t.applies_to_fat !== false : t.applies_to_sat !== false))
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
        .map(t => ({
          test_id:        t.test_id || "",
          description:    t.description || "",
          pass_criterion: t.pass_criterion || "",
          module:         t.module || null,
          phase:          t.phase || null,
        }));
    } catch (_) { /* fall through to defaults */ }
    if (seed.length === 0) seed = DEFAULT_PLAN_ROWS[planType];

    const rowsMap = {};
    seed.forEach((r, i) => {
      const k = push(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/rows`)).key;
      rowsMap[k] = { ...r, sort_order: i + 1, result: "pending", created_at: Date.now() };
    });
    await set(ref(db, `appState/siProjects/${pid}/test_plans/${planType}`), {
      created_at: Date.now(), status: "draft", rows: rowsMap,
    });
    logSIActivity(pid, "testplan_create", `Generated ${planType.toUpperCase()} plan (${seed.length} rows)`, actor);
  };

  const updateRow = (rid, patch) => update(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/rows/${rid}`), patch);
  const addRow = () => {
    const nextOrder = rows.length ? Math.max(...rows.map(r => r.sort_order || 0)) + 1 : 1;
    const k = push(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/rows`)).key;
    set(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/rows/${k}`), {
      test_id: `${planType.toUpperCase()}-${String(nextOrder).padStart(3, "0")}`,
      description: "", pass_criterion: "", result: "pending", sort_order: nextOrder, created_at: Date.now(),
    });
  };
  const deleteRow = (rid) => { if (confirm("Delete this test row?")) remove(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/rows/${rid}`)); };

  // Parse a vendor-returned executed xlsx and bulk-apply the results.
  // Heuristic column matching so vendors don't need to use exact headers:
  // any of {Test ID, test_id, TestID, ID, Test #} for the key column,
  // {Result, Status} for the result. Result values normalize across
  // (p / pass), (f / fail), (n / ncr / NCR), else "pending".
  const onUploadExecutedXlsx = async (file) => {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const xlsxRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const idKeys = ["Test ID", "test_id", "TestID", "Test#", "Test #", "ID", "Id", "id"];
      const resKeys = ["Result", "result", "RESULT", "Status", "status"];
      const pickKey = (row, candidates) => candidates.find(k => k in row);
      let matched = 0, unmatched = 0, updates = [];
      for (const xr of xlsxRows) {
        const idKey = pickKey(xr, idKeys);
        const resKey = pickKey(xr, resKeys);
        if (!idKey) continue;
        const testId = String(xr[idKey] || "").trim();
        const rawResult = String(xr[resKey] || "").toLowerCase().trim();
        if (!testId) continue;
        const planRow = rows.find(pr => (pr.test_id || "").toLowerCase() === testId.toLowerCase());
        if (planRow) {
          const norm = rawResult === "p" || rawResult === "pass" ? "pass"
                     : rawResult === "f" || rawResult === "fail" ? "fail"
                     : rawResult === "n" || rawResult === "ncr"  ? "ncr"
                     : ["pending", ""].includes(rawResult) ? "pending"
                     : rawResult;
          updates.push({ rid: planRow.rid, result: norm });
          matched++;
        } else {
          unmatched++;
        }
      }
      await Promise.all(updates.map(u =>
        update(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/rows/${u.rid}`), { result: u.result })
      ));
      // Also store the upload itself for audit + history.
      const upRef = push(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/executed_uploads`));
      await set(upRef, {
        filename: file.name,
        uploaded_at: Date.now(),
        uploaded_by: actor,
        rows_in_xlsx: xlsxRows.length,
        matched, unmatched,
      });
      logSIActivity(pid, "testplan_executed_upload",
        `Executed ${planType.toUpperCase()} xlsx "${file.name}": ${matched} updated, ${unmatched} unmatched (of ${xlsxRows.length})`,
        actor);
      alert(`Done.\n• ${matched} row${matched === 1 ? "" : "s"} updated\n• ${unmatched} unmatched\n• ${xlsxRows.length} xlsx rows total`);
    } catch (err) {
      alert("Parse failed: " + (err?.message || err));
    }
  };

  const signOff = () => {
    if (!confirm(`Sign off ${planType.toUpperCase()} plan? Test rows will be locked from edits.`)) return;
    update(ref(db, `appState/siProjects/${pid}/test_plans/${planType}`), {
      signed_off_at: Date.now(),
      signed_off_by: actor,
      status: "signed_off",
    });
    logSIActivity(pid, "testplan_signoff", `Signed off ${planType.toUpperCase()} plan`, actor);
  };
  const unsignOff = () => {
    if (!confirm("Re-open this plan for editing?")) return;
    update(ref(db, `appState/siProjects/${pid}/test_plans/${planType}`), {
      signed_off_at: null, signed_off_by: null, status: "draft",
    });
    logSIActivity(pid, "testplan_reopen", `Re-opened ${planType.toUpperCase()} plan`, actor);
  };
  const addDeviation = () => {
    const description = prompt("Deviation description (what didn't go as planned):");
    if (!description) return;
    const justification = prompt("Justification (why this was acceptable):", "") || "";
    const nextSeq = deviations.length ? Math.max(...deviations.map(d => d.sequence || 0)) + 1 : 1;
    const k = push(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/deviations`)).key;
    set(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/deviations/${k}`), {
      sequence: nextSeq,
      description: description.trim(),
      justification: justification.trim() || null,
      created_at: Date.now(),
      created_by: actor,
      approved_at: null, approved_by: null,
    });
    logSIActivity(pid, "deviation_add", `${planType.toUpperCase()} deviation: ${description.trim().slice(0, 80)}`, actor);
  };
  const approveDeviation = (did) => {
    update(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/deviations/${did}`), {
      approved_at: Date.now(),
      approved_by: actor,
    });
    logSIActivity(pid, "deviation_approve", `Approved ${planType.toUpperCase()} deviation`, actor);
  };
  const deleteDeviation = (did) => {
    if (!confirm("Delete this deviation?")) return;
    remove(ref(db, `appState/siProjects/${pid}/test_plans/${planType}/deviations/${did}`));
  };

  const counts = rows.reduce((acc, r) => { acc[r.result || "pending"] = (acc[r.result || "pending"] || 0) + 1; return acc; }, {});

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <ProjectPickerBar projectList={projectList} value={pid} onChange={setPid}
        subtitle="Pick a project to generate / edit / sign-off its FAT or SAT plan." />

      {project && isSIAdminUser && (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setNewPlanModal("fat")}
            style={{ padding: "8px 16px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            + New FAT plan
          </button>
          <button onClick={() => setNewPlanModal("sat")}
            style={{ padding: "8px 16px", border: 0, borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            + New SAT plan
          </button>
        </div>
      )}

      {project && (
        <TestPlanSummaryTable project={project} onEdit={(kind) => { setPlanType(kind); setEditingPlan(kind); }} siS={siS} />
      )}

      {project && (
        <TestPlanFilesCard pid={pid} project={project} isSIAdminUser={isSIAdminUser} actor={actor} />
      )}

      {project && (
        <TestPlanPrereqs pid={pid} project={project} isSIAdminUser={isSIAdminUser} actor={actor} />
      )}

      {newPlanModal && (
        <NewTestPlanModal kind={newPlanModal} pid={pid} actor={actor}
          onClose={() => setNewPlanModal(null)}
          onCreated={(kind) => { setPlanType(kind); setEditingPlan(kind); setNewPlanModal(null); }} />
      )}

      {project && editingPlan && (
        <Section title={`${editingPlan.toUpperCase()} plan editor`}
          headerExtra={(
            <div style={{ display: "flex", gap: 6 }}>
              {["fat", "sat"].map(t => (
                <button key={t} onClick={() => setPlanType(t)}
                  style={{ padding: "5px 14px", border: `1px solid ${planType === t ? "#2563EB" : siS.cardBorder}`, borderRadius: 6, background: planType === t ? "#EFF6FF" : siS.cardSoft, color: planType === t ? "#2563EB" : siS.textMuted, fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                  {t.toUpperCase()}
                </button>
              ))}
              <button onClick={() => setEditingPlan(null)}
                style={{ padding: "5px 12px", border: `1px solid ${siS.cardBorder}`, borderRadius: 6, background: siS.cardSoft, color: siS.textMuted, fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                Close editor
              </button>
            </div>
          )}>
          {!plan ? (
            <div>
              <div style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 13, marginBottom: 10 }}>No {planType.toUpperCase()} plan yet for this project.</div>
              {isSIAdminUser && (
                <button onClick={ensurePlan}
                  style={{ padding: "6px 14px", border: "1px solid #2563EB", borderRadius: 6, background: "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  Generate {planType.toUpperCase()} plan from template
                </button>
              )}
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 12, marginBottom: 10, fontFamily: SI_F, fontSize: 12, color: "#475569" }}>
                <span><strong style={{ color: "#16A34A" }}>{counts.pass || 0}</strong> pass</span>
                <span><strong style={{ color: "#DC2626" }}>{counts.fail || 0}</strong> fail</span>
                <span><strong style={{ color: "#F59E0B" }}>{counts.pending || 0}</strong> pending</span>
                <span>· {rows.length} total</span>
                <div style={{ flex: 1 }} />
                {isSIAdminUser && !signedOff && (
                  <>
                    <label style={{ padding: "4px 12px", border: "1px solid #2563EB", borderRadius: 6, background: "#FFF", color: "#2563EB", fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
                      title="Upload a vendor-returned xlsx; results bulk-apply by Test ID">
                      ↑ Upload executed xlsx
                      <input type="file" accept=".xlsx,.xls" style={{ display: "none" }}
                        onChange={e => { onUploadExecutedXlsx(e.target.files?.[0]); e.target.value = ""; }} />
                    </label>
                    <button onClick={addRow}
                      style={{ padding: "4px 12px", border: "1px solid #2563EB", borderRadius: 6, background: "#FFF", color: "#2563EB", fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                      + Add row
                    </button>
                  </>
                )}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={siS.table}>
                  <thead>
                    <tr>
                      <th style={siS.th}>Test ID</th>
                      <th style={siS.th}>Description</th>
                      <th style={siS.th}>Pass criterion</th>
                      <th style={siS.th}>Result</th>
                      {isSIAdminUser && <th style={siS.th}></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.rid}>
                        <td style={siS.td}>
                          <input defaultValue={r.test_id} disabled={!isSIAdminUser || signedOff}
                            onBlur={e => updateRow(r.rid, { test_id: e.target.value.trim() })}
                            style={{ width: 90, padding: "3px 6px", border: "1px solid transparent", borderRadius: 4, fontFamily: SI_F, fontSize: 12.5, color: "#0F172A", background: "transparent" }} />
                        </td>
                        <td style={siS.td}>
                          <input defaultValue={r.description} disabled={!isSIAdminUser || signedOff}
                            onBlur={e => updateRow(r.rid, { description: e.target.value })}
                            style={{ width: "100%", padding: "3px 6px", border: "1px solid transparent", borderRadius: 4, fontFamily: SI_F, fontSize: 12.5, color: "#0F172A", background: "transparent" }} />
                        </td>
                        <td style={siS.td}>
                          <input defaultValue={r.pass_criterion} disabled={!isSIAdminUser || signedOff}
                            onBlur={e => updateRow(r.rid, { pass_criterion: e.target.value })}
                            style={{ width: "100%", padding: "3px 6px", border: "1px solid transparent", borderRadius: 4, fontFamily: SI_F, fontSize: 12.5, color: "#0F172A", background: "transparent" }} />
                        </td>
                        <td style={siS.td}>
                          <select value={r.result || "pending"} disabled={!isSIAdminUser || signedOff}
                            onChange={e => updateRow(r.rid, { result: e.target.value })}
                            style={{ fontFamily: SI_F, fontSize: 12.5, padding: "3px 6px", border: "1px solid #CBD5E1", borderRadius: 5, background: "#FFF", color: "#0F172A" }}>
                            <option value="pending">pending</option>
                            <option value="pass">pass</option>
                            <option value="fail">fail</option>
                            <option value="ncr">ncr</option>
                          </select>
                        </td>
                        {isSIAdminUser && (
                          <td style={siS.td}>
                            {!signedOff && (
                              <button onClick={() => deleteRow(r.rid)}
                                style={{ background: "transparent", border: 0, color: "#DC2626", fontSize: 14, cursor: "pointer", lineHeight: 1 }}>×</button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                {isSIAdminUser && (
                  signedOff ? (
                    <button onClick={unsignOff}
                      style={{ padding: "6px 14px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#64748B", fontFamily: SI_F, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                      Re-open plan
                    </button>
                  ) : (
                    <button onClick={signOff}
                      style={{ padding: "6px 14px", border: "1px solid #16A34A", borderRadius: 6, background: "#16A34A", color: "#FFF", fontFamily: SI_F, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                      Sign off plan
                    </button>
                  )
                )}
              </div>
              {signedOff && (
                <div style={{ marginTop: 10, padding: 10, background: "#DCFCE7", color: "#15803D", borderRadius: 6, fontFamily: SI_F, fontSize: 12.5 }}>
                  ✓ Signed off {new Date(plan.signed_off_at).toLocaleString()} by {plan.signed_off_by || "unknown"}.
                </div>
              )}
              {plan.executed_uploads && Object.keys(plan.executed_uploads).length > 0 && (
                <div style={{ marginTop: 12, fontFamily: SI_F, fontSize: 11, color: "#64748B" }}>
                  Executed xlsx uploads:
                  <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
                    {Object.entries(plan.executed_uploads).sort((a, b) => (b[1]?.uploaded_at || 0) - (a[1]?.uploaded_at || 0)).slice(0, 5).map(([uid, u]) => (
                      <li key={uid}>
                        {u.filename} — {new Date(u.uploaded_at).toLocaleString()} by {u.uploaded_by} ({u.matched}/{u.rows_in_xlsx} matched)
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </Section>
      )}
      {project && plan && (
        <Section title={`Deviations (${deviations.length})`} headerExtra={isSIAdminUser && (
          <button onClick={addDeviation}
            style={{ padding: "5px 12px", border: "1px solid #F59E0B", borderRadius: 6, background: "#FFF", color: "#F59E0B", fontFamily: SI_F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ Add deviation</button>
        )}>
          {deviations.length === 0 ? (
            <div style={{ color: "#94A3B8", fontFamily: SI_F, fontSize: 13 }}>No deviations logged.</div>
          ) : (
            <table style={siS.table}>
              <thead>
                <tr>
                  <th style={siS.th}>#</th>
                  <th style={siS.th}>Description</th>
                  <th style={siS.th}>Justification</th>
                  <th style={siS.th}>Status</th>
                  {isSIAdminUser && <th style={siS.th}></th>}
                </tr>
              </thead>
              <tbody>
                {deviations.map(d => (
                  <tr key={d.did}>
                    <td style={siS.td}>D-{d.sequence}</td>
                    <td style={siS.td}>{d.description}</td>
                    <td style={siS.td}>{d.justification || <span style={{ color: "#94A3B8" }}>—</span>}</td>
                    <td style={siS.td}>{d.approved_at
                      ? <span style={{ background: "#DCFCE7", color: "#15803D", padding: "1px 7px", borderRadius: 999, fontSize: 11, fontWeight: 700 }}>APPROVED</span>
                      : <span style={{ background: "#FEF3C7", color: "#92400E", padding: "1px 7px", borderRadius: 999, fontSize: 11, fontWeight: 700 }}>PENDING</span>}</td>
                    {isSIAdminUser && (
                      <td style={siS.td}>
                        {!d.approved_at && (
                          <button onClick={() => approveDeviation(d.did)}
                            style={{ padding: "3px 10px", border: "1px solid #16A34A", borderRadius: 5, background: "#FFF", color: "#16A34A", fontFamily: SI_F, fontSize: 11.5, fontWeight: 600, cursor: "pointer", marginRight: 6 }}>
                            Approve
                          </button>
                        )}
                        <button onClick={() => deleteDeviation(d.did)}
                          style={{ background: "transparent", border: 0, color: "#DC2626", fontSize: 14, cursor: "pointer", lineHeight: 1 }}>×</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}
    </div>
  );
}

// Reuse the existing project's casing for an SI name (Anda / ANDA / anda
// all collapse to whatever is already on record). Mirrors the
// _canonical_si_name helper from fixture_tracker's Flask backend.
function canonicalSi(input, siProjects) {
  const s = (input || "").trim();
  if (!s) return s;
  for (const p of Object.values(siProjects || {})) {
    if ((p?.si_name || "").toLowerCase() === s.toLowerCase()) return p.si_name;
  }
  return s;
}

function InlineEditCell({ value, editing, onStart, onSave, onCancel, editable, bold }) {
  const siS = useSIS();
  if (editing && editable) {
    return (
      <input autoFocus defaultValue={value || ""}
        onBlur={e => onSave(e.target.value.trim())}
        onKeyDown={e => {
          if (e.key === "Enter") e.target.blur();
          if (e.key === "Escape") { e.target.value = value || ""; onCancel(); e.target.blur(); }
        }}
        style={{ fontFamily: SI_F, fontSize: 14, border: "1px solid #CBD5E1", borderRadius: 6, padding: "3px 7px", width: "100%", boxSizing: "border-box", color: "#0F172A" }} />
    );
  }
  return (
    <span onClick={editable ? onStart : undefined}
      style={{
        cursor: editable ? "text" : "default",
        color: value ? "#0F172A" : "#94A3B8",
        fontFamily: SI_F, fontSize: 14, fontWeight: bold ? 600 : 400,
      }}>
      {value || (editable ? "Click to add" : "—")}
    </span>
  );
}

/* One-shot importer: pulls projects + stations + stage_dates + files
   from the local fixture_tracker Flask app (http://localhost:5000) and
   writes them to RTDB at appState/siProjects/, plus uploads physical
   files to Firebase Storage. Skips a project if a record with the same
   `legacy_id` already exists, so the user can re-run safely. */
function ImportFromFixtureTrackerModal({ onClose, existing }) {
  const siS = useSIS();
  const API = "http://localhost:5000";
  const [status, setStatus] = useState("idle"); // idle | running | done | error
  const [log, setLog] = useState([]);
  const [counts, setCounts] = useState({ projects: 0, total: 0, stations: 0, files: 0, errors: 0 });
  const append = (line) => setLog(prev => [...prev, line]);

  // Detect already-imported projects via their legacy_id so re-runs no-op.
  const alreadyImported = useMemo(() => {
    const set = new Set();
    for (const p of Object.values(existing || {})) if (p?.legacy_id != null) set.add(String(p.legacy_id));
    return set;
  }, [existing]);

  const run = async () => {
    setStatus("running");
    setLog([]);
    let nProj = 0, nStations = 0, nFiles = 0, nErrors = 0;
    try {
      append(`Fetching projects from ${API}/api/si-projects …`);
      const projectsRes = await fetch(`${API}/api/si-projects`);
      if (!projectsRes.ok) throw new Error(`GET /api/si-projects → ${projectsRes.status}`);
      const projects = await projectsRes.json();
      setCounts(c => ({ ...c, total: projects.length }));
      append(`Found ${projects.length} project${projects.length === 1 ? "" : "s"}.`);

      for (const src of projects) {
        const legacyId = String(src.id);
        if (alreadyImported.has(legacyId)) {
          append(`↷ Skipping "${src.name}" (legacy_id ${legacyId}, already imported).`);
          nProj += 1;
          setCounts(c => ({ ...c, projects: nProj }));
          continue;
        }
        append(`→ "${src.name}"…`);

        // Stations
        let stations = [];
        try {
          const r = await fetch(`${API}/api/si-projects/${src.id}/stations`);
          if (r.ok) stations = (await r.json()).stations || [];
        } catch (_) { /* tolerate */ }

        // Files (metadata; we'll upload bytes next)
        let files = [];
        try {
          const r = await fetch(`${API}/api/si-projects/${src.id}/files`);
          if (r.ok) files = (await r.json()).files || [];
        } catch (_) { /* tolerate */ }

        // Build the new RTDB record. Stations + stage_dates + files all
        // nest under the project for a single subscription read.
        const newProjectRef = push(ref(db, "appState/siProjects"));
        const newPid = newProjectRef.key;

        const stationMap = {};
        for (const s of stations) {
          const sRefDb = push(ref(db, `appState/siProjects/${newPid}/stations`));
          stationMap[sRefDb.key] = {
            legacy_id: s.id,
            station_number: s.station_number || null,
            name: s.name || null,
            deployment_factory: s.deployment_factory || null,
            customer: s.customer || null,
            notes: s.notes || null,
            created_at: s.created_at ? new Date(s.created_at).getTime() : Date.now(),
          };
        }
        nStations += Object.keys(stationMap).length;

        // Migrate physical files: download bytes from localhost:5000 →
        // upload to Firebase Storage → store the new metadata. External
        // links (kind="link") just keep their url and skip the upload.
        const fileMap = {};
        for (const f of files) {
          const newFileRef = push(ref(db, `appState/siProjects/${newPid}/files`));
          const isLink = f.kind === "link" || !!f.url;
          if (isLink) {
            fileMap[newFileRef.key] = {
              legacy_id: f.id,
              category: f.category, kind: "link",
              filename: f.filename, url: f.url || null,
              uploaded_at: f.uploaded_at ? new Date(f.uploaded_at).getTime() : Date.now(),
            };
            nFiles += 1;
            continue;
          }
          try {
            const dl = await fetch(`${API}${f.download_url}`);
            if (!dl.ok) throw new Error(`download ${dl.status}`);
            const blob = await dl.blob();
            const safeName = (f.filename || "file").replace(/[^A-Za-z0-9._-]/g, "_");
            const storagePath = `siProjectFiles/${newPid}/${f.category || "misc"}/${Date.now()}_${safeName}`;
            const sr = sRef(storage, storagePath);
            await uploadBytes(sr, blob, { contentType: blob.type || undefined });
            const url = await getDownloadURL(sr);
            fileMap[newFileRef.key] = {
              legacy_id: f.id,
              category: f.category || "misc", kind: "file",
              filename: f.filename, storagePath, downloadUrl: url,
              size: blob.size,
              uploaded_at: f.uploaded_at ? new Date(f.uploaded_at).getTime() : Date.now(),
            };
            nFiles += 1;
          } catch (e) {
            append(`  ⚠ file ${f.filename || f.id}: ${e?.message || e}`);
            nErrors += 1;
          }
        }

        // Stage dates: prefer fixture_tracker's stage_dates JSON (legacy)
        // since that's what's populated on existing projects. Normalize
        // empty strings to null.
        const stageDates = {};
        for (const [stage, sd] of Object.entries(src.stage_dates || {})) {
          if (!sd) continue;
          stageDates[stage] = {
            planned_start: sd.planned_start || null,
            planned_end:   sd.planned_end   || null,
            actual_start:  sd.actual_start  || null,
            actual_end:    sd.actual_end    || null,
          };
        }

        const record = {
          legacy_id:      src.id,
          name:           src.name || null,
          si_name:        canonicalSi(src.si_name || "", existing),
          customer:       src.customer || null,
          cm_site:        src.cm_site  || null,
          current_stage:  src.current_stage || "SIRD",
          is_blocked:     !!src.is_blocked,
          block_reason:   src.block_reason || null,
          station_count:  src.station_count || stations.length || 1,
          notes:          src.notes || null,
          created_at:     src.created_at ? new Date(src.created_at).getTime() : Date.now(),
          updated_at:     Date.now(),
        };
        if (Object.keys(stationMap).length) record.stations = stationMap;
        if (Object.keys(fileMap).length)    record.files    = fileMap;
        if (Object.keys(stageDates).length) record.stage_dates = stageDates;

        await set(newProjectRef, record);
        nProj += 1;
        append(`  ✓ imported (${Object.keys(stationMap).length} stations, ${Object.keys(fileMap).length} files)`);
        setCounts({ projects: nProj, total: projects.length, stations: nStations, files: nFiles, errors: nErrors });
      }

      setStatus("done");
      append(`\nDone — ${nProj}/${projects.length} projects, ${nStations} stations, ${nFiles} files, ${nErrors} error${nErrors === 1 ? "" : "s"}.`);
    } catch (e) {
      append(`\n✗ ${e?.message || e}`);
      setStatus("error");
    }
  };

  return (
    <div onClick={status === "running" ? undefined : onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#FFF", borderRadius: 12, padding: 24, width: "min(640px, 92vw)", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(15,23,42,0.25)" }}>
        <h3 style={{ margin: "0 0 8px", fontFamily: SI_F, fontSize: 18, color: "#0F172A" }}>Import from fixture_tracker (localhost:5000)</h3>
        <p style={{ margin: "0 0 12px", fontFamily: SI_F, fontSize: 13, color: "#64748B", lineHeight: 1.5 }}>
          Pulls all SI projects + stations + stage dates + files from the local fixture_tracker Flask app and copies them into Firebase (RTDB + Storage).
          Safe to run more than once — projects already imported (matched by <code>legacy_id</code>) are skipped.
          Requires fixture_tracker running at <strong>http://localhost:5000</strong>.
        </p>
        {status === "running" && (
          <div style={{ background: "#F1F5F9", borderRadius: 6, padding: 10, marginBottom: 10, fontFamily: SI_F, fontSize: 12, color: "#475569" }}>
            Progress: {counts.projects}/{counts.total} projects · {counts.stations} stations · {counts.files} files{counts.errors ? ` · ${counts.errors} errors` : ""}
          </div>
        )}
        {log.length > 0 && (
          <pre style={{ flex: 1, overflowY: "auto", background: siS.cardSoft, border: "1px solid #E2E8F0", borderRadius: 6, padding: 10, fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11.5, color: "#0F172A", lineHeight: 1.5, margin: 0, whiteSpace: "pre-wrap" }}>
            {log.join("\n")}
          </pre>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button onClick={onClose} disabled={status === "running"}
            style={{ padding: "7px 14px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#0F172A", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: status === "running" ? "not-allowed" : "pointer", opacity: status === "running" ? 0.5 : 1 }}>
            {status === "done" ? "Close" : "Cancel"}
          </button>
          {status !== "done" && (
            <button onClick={run} disabled={status === "running"}
              style={{ padding: "7px 14px", border: "1px solid #2563EB", borderRadius: 6, background: status === "running" ? "#94D3C5" : "#2563EB", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: status === "running" ? "wait" : "pointer" }}>
              {status === "running" ? "Importing…" : status === "error" ? "Retry" : "Start import"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function NewSIProjectModal({ onClose, existing }) {
  const siS = useSIS();
  const [form, setForm] = useState({ name: "", si_name: "", customer: "", cm_site: "", current_stage: "SIRD" });
  const [busy, setBusy] = useState(false);
  const canSave = form.name.trim() && form.si_name.trim();
  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    try {
      const newRef = push(ref(db, "appState/siProjects"));
      const newPid = newRef.key;
      await set(newRef, {
        name:          form.name.trim(),
        si_name:       canonicalSi(form.si_name, existing),
        customer:      form.customer.trim() || null,
        cm_site:       form.cm_site.trim() || null,
        current_stage: form.current_stage,
        station_count: 1,
        is_blocked:    false,
        created_at:    Date.now(),
        updated_at:    Date.now(),
      });
      // The modal doesn't have direct access to the user; fall back to
      // localStorage email if signed in, else "unknown".
      let actor = "unknown";
      try {
        const email = JSON.parse(localStorage.getItem("dp_user") || "{}")?.email;
        if (email) actor = email;
      } catch (_) {}
      logSIActivity(newPid, "create", `Created project "${form.name.trim()}"`, actor);
      onClose();
    } catch (e) {
      alert("Failed to create project: " + (e?.message || e));
      setBusy(false);
    }
  };
  const field = (label, key, opts = {}) => (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 4 }}>{label}{opts.required && " *"}</label>
      {opts.options ? (
        <select value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })}
          style={{ fontFamily: SI_F, fontSize: 14, padding: "7px 9px", border: "1px solid #CBD5E1", borderRadius: 6, width: "100%", boxSizing: "border-box", background: "#FFF", color: "#0F172A" }}>
          {opts.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input type="text" value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} placeholder={opts.placeholder}
          style={{ fontFamily: SI_F, fontSize: 14, padding: "7px 9px", border: "1px solid #CBD5E1", borderRadius: 6, width: "100%", boxSizing: "border-box", color: "#0F172A" }} />
      )}
    </div>
  );
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#FFF", borderRadius: 12, padding: 24, width: "min(480px, 92vw)", boxShadow: "0 20px 60px rgba(15,23,42,0.25)" }}>
        <h3 style={{ margin: "0 0 16px", fontFamily: SI_F, fontSize: 18, color: "#0F172A" }}>New SI project</h3>
        {field("Project name",        "name",          { required: true, placeholder: "e.g. Nerds — Farglory / VR Fixture" })}
        {field("SI partner",          "si_name",       { required: true, placeholder: "e.g. ANDA" })}
        {field("Customer",            "customer",      { placeholder: "e.g. Fundip" })}
        {field("Deployment factory",  "cm_site",       { placeholder: "e.g. Foxconn" })}
        {field("Stage",               "current_stage", { options: SI_STAGES })}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: "7px 14px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", color: "#0F172A", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={save} disabled={!canSave || busy} style={{ padding: "7px 14px", border: "1px solid #2563EB", borderRadius: 6, background: canSave && !busy ? "#2563EB" : "#94D3C5", color: "#FFF", fontFamily: SI_F, fontSize: 13, fontWeight: 600, cursor: canSave && !busy ? "pointer" : "not-allowed" }}>{busy ? "Saving…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

function SIProjectRow({ proj, tracker, isSIAdminUser, editing, setEditing, saveTracker, riskBadge, setProject, setView }) {
  const t = tracker[proj.id] || {};
  const [notesExpanded, setNotesExpanded] = useState(false);
  const notesFull = t.notes || "";
  const isEditingField = (field) => editing?.pid === proj.id && editing?.field === field;

  return (
    <tr>
      {/* Project name — clickable */}
      <td style={S.td}>
        <button
          onClick={() => { setProject(proj); setView("project_details"); }}
          style={{ background: "none", border: "none", color: "#00C9A7", cursor: "pointer", fontFamily: F, fontSize: 14, fontWeight: 600, padding: 0, textAlign: "left" }}
        >
          {proj.name}
        </button>
      </td>
      {/* HubSpot Stage — pulled from siStage via SI_PIPELINE_STAGES lookup */}
      <td style={S.td}>{SI_PIPELINE_STAGES.find(s => s.id === normalizeSiStage(proj.siStage))?.label || "—"}</td>
      {/* SI Partner — editable text */}
      <td style={S.td}>
        {isSIAdminUser ? (
          isEditingField("siPartnerName") ? (
            <input
              autoFocus
              defaultValue={t.siPartnerName || ""}
              style={{ fontFamily: F, fontSize: 14, border: "1px solid #CBD5E1", borderRadius: 6, padding: "3px 7px", width: 130 }}
              onBlur={e => { saveTracker(proj.id, "siPartnerName", e.target.value); setEditing(null); }}
            />
          ) : (
            <span
              onClick={() => setEditing({ pid: proj.id, field: "siPartnerName" })}
              style={{ cursor: "text", color: t.siPartnerName ? "#1E293B" : "#94A3B8", fontFamily: F, fontSize: 14 }}
            >
              {t.siPartnerName || "Click to add"}
            </span>
          )
        ) : (
          <span style={{ fontFamily: F, fontSize: 14 }}>{t.siPartnerName || "—"}</span>
        )}
      </td>
      {/* Risk — dropdown or badge */}
      <td style={S.td}>
        {isSIAdminUser ? (
          <select
            value={t.risk || ""}
            onChange={e => saveTracker(proj.id, "risk", e.target.value)}
            style={{ fontFamily: F, fontSize: 14, border: "1px solid #CBD5E1", borderRadius: 6, padding: "3px 7px" }}
          >
            <option value="">—</option>
            <option value="healthy">🟢 Healthy</option>
            <option value="watch">🟡 Watch</option>
            <option value="at_risk">🔴 At-risk</option>
          </select>
        ) : (
          <span style={{ fontFamily: F, fontSize: 14 }}>{riskBadge(t.risk)}</span>
        )}
      </td>
      {/* Last Contact — date input or text */}
      <td style={S.td}>
        {isSIAdminUser ? (
          <input
            type="date"
            value={t.lastContactDate || ""}
            onChange={e => saveTracker(proj.id, "lastContactDate", e.target.value)}
            style={{ fontFamily: F, fontSize: 14, border: "1px solid #CBD5E1", borderRadius: 6, padding: "3px 7px" }}
          />
        ) : (
          <span style={{ fontFamily: F, fontSize: 14 }}>{t.lastContactDate || "—"}</span>
        )}
      </td>
      {/* Next Milestone — editable text */}
      <td style={S.td}>
        {isSIAdminUser ? (
          isEditingField("nextMilestone") ? (
            <input
              autoFocus
              defaultValue={t.nextMilestone || ""}
              style={{ fontFamily: F, fontSize: 14, border: "1px solid #CBD5E1", borderRadius: 6, padding: "3px 7px", width: 160 }}
              onBlur={e => { saveTracker(proj.id, "nextMilestone", e.target.value); setEditing(null); }}
            />
          ) : (
            <span
              onClick={() => setEditing({ pid: proj.id, field: "nextMilestone" })}
              style={{ cursor: "text", color: t.nextMilestone ? "#1E293B" : "#94A3B8", fontFamily: F, fontSize: 14 }}
            >
              {t.nextMilestone || "Click to add"}
            </span>
          )
        ) : (
          <span style={{ fontFamily: F, fontSize: 14 }}>{t.nextMilestone || "—"}</span>
        )}
      </td>
      {/* Notes — expandable */}
      <td style={S.td}>
        {isSIAdminUser ? (
          isEditingField("notes") ? (
            <textarea
              autoFocus
              defaultValue={notesFull}
              rows={3}
              style={{ fontFamily: F, fontSize: 13, border: "1px solid #CBD5E1", borderRadius: 6, padding: "4px 8px", width: 200, resize: "vertical" }}
              onBlur={e => { saveTracker(proj.id, "notes", e.target.value); setEditing(null); setNotesExpanded(false); }}
            />
          ) : (
            <span
              onClick={() => setEditing({ pid: proj.id, field: "notes" })}
              style={{ cursor: "text", color: notesFull ? "#1E293B" : "#94A3B8", fontFamily: F, fontSize: 13 }}
            >
              {notesFull ? (notesFull.length > 40 ? notesFull.slice(0, 40) + "..." : notesFull) : "Click to add"}
            </span>
          )
        ) : (
          notesExpanded ? (
            <span style={{ fontFamily: F, fontSize: 13, cursor: "pointer" }} onClick={() => setNotesExpanded(false)}>{notesFull || "—"}</span>
          ) : (
            <span
              style={{ cursor: notesFull.length > 40 ? "pointer" : "default", fontFamily: F, fontSize: 13 }}
              onClick={() => notesFull.length > 40 && setNotesExpanded(true)}
            >
              {notesFull ? (notesFull.length > 40 ? notesFull.slice(0, 40) + "..." : notesFull) : "—"}
            </span>
          )
        )}
      </td>
    </tr>
  );
}

/* ═══ SI Timeline (Gantt) — Fixture Tracker spec §3.2 ═══ */
function SITimelineView({ projects, tracker, setState, isSIAdminUser, fullscreen }) {
  const today = new Date();
  const ymStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const baseFrom = new Date(today.getFullYear(), today.getMonth() - 3, 1);
  const baseTo   = new Date(today.getFullYear(), today.getMonth() + 9, 1);

  const [fromYM, setFromYM] = useState(ymStr(baseFrom));
  const [toYM, setToYM]     = useState(ymStr(baseTo));
  const [showPlanned, setShowPlanned] = useState(true);
  const [showActual,  setShowActual]  = useState(true);
  const [expandedSIs, setExpandedSIs] = useState(() => new Set());
  const [expandedProjects, setExpandedProjects] = useState(() => new Set());
  const [tooltip, setTooltip] = useState(null);
  const [editingPid, setEditingPid] = useState(null);

  const chartRef = useRef(null);
  const [chartWidth, setChartWidth] = useState(900);

  useEffect(() => {
    if (!chartRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setChartWidth(entry.contentRect.width);
    });
    ro.observe(chartRef.current);
    return () => ro.disconnect();
  }, []);

  const months = useMemo(() => {
    const [fy, fm] = fromYM.split("-").map(Number);
    const [ty, tm] = toYM.split("-").map(Number);
    const out = [];
    let y = fy, m = fm;
    if (!fy || !fm || !ty || !tm) return out;
    while (y < ty || (y === ty && m <= tm)) {
      out.push({ y, m });
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return out;
  }, [fromYM, toYM]);

  const colWidth = months.length > 0 ? chartWidth / months.length : 0;

  const dateToX = useCallback((dateStr) => {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    const [fy, fm] = fromYM.split("-").map(Number);
    const monthDiff = (d.getFullYear() - fy) * 12 + (d.getMonth() + 1 - fm);
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const dayFraction = (d.getDate() - 1) / daysInMonth;
    return (monthDiff + dayFraction) * colWidth;
  }, [fromYM, colWidth]);

  const todayX = (() => {
    const t = new Date();
    const [fy, fm] = fromYM.split("-").map(Number);
    if (!fy || !fm) return -1;
    const monthDiff = (t.getFullYear() - fy) * 12 + (t.getMonth() + 1 - fm);
    const daysInMonth = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    const dayFraction = (t.getDate() - 1) / daysInMonth;
    return (monthDiff + dayFraction) * colWidth;
  })();

  const groups = useMemo(() => {
    const g = {};
    for (const p of projects) {
      const si = tracker[p.id]?.siPartnerName || "Unassigned";
      if (!g[si]) g[si] = [];
      g[si].push(p);
    }
    return Object.keys(g).sort().map(name => ({ name, projects: g[name] }));
  }, [projects, tracker]);

  const saveStageDates = (pid, stageDates) => {
    dbWrite(`appState/siTracker/${pid}/stageDates`, stageDates);
    setState(prev => ({
      ...prev,
      siTracker: {
        ...(prev.siTracker || {}),
        [pid]: { ...(prev.siTracker?.[pid] || {}), stageDates },
      },
    }));
  };

  const toggleSI = (name) => setExpandedSIs(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  const toggleProject = (pid) => setExpandedProjects(prev => { const n = new Set(prev); n.has(pid) ? n.delete(pid) : n.add(pid); return n; });

  const ROW_H = 44;
  const LABEL_W = 240;
  const todayInRange = todayX >= 0 && todayX <= chartWidth;

  // Dark palette scoped to this card (per design reference)
  const D = {
    bg: "#0F1117", panel: "#171A23", panelAlt: "#1C202C", border: "#2A2E3D",
    text: "#E2E8F0", muted: "#94A3B8", mutedLow: "#64748B", accent: "#A78BFA", red: "#EF4444",
  };

  const tipText = (proj, stage, sd) => (
    <span>
      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: stage.color, marginRight: 6 }} />
      <strong>{proj.name} — {stage.label}</strong><br/>
      Planned: {sd.plannedStart || "—"} → {sd.plannedEnd || "—"}<br/>
      Actual: {sd.actualStart || "—"} → {sd.actualEnd || "—"}
    </span>
  );

  const renderBars = (proj, stage, sd) => {
    const out = [];
    const barH = 16;
    const planTop = (ROW_H - barH * 2 - 2) / 2;
    const actTop  = planTop + barH + 2;
    const onMove = (e) => setTooltip({ x: e.clientX, y: e.clientY, content: tipText(proj, stage, sd) });
    const onLeave = () => setTooltip(null);
    const labelStyle = { display: "flex", alignItems: "center", padding: "0 6px", fontFamily: F, fontSize: 10, fontWeight: 700, color: "#FFF", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "clip", letterSpacing: 0.3 };

    if (showPlanned && sd.plannedStart && sd.plannedEnd) {
      const x1 = dateToX(sd.plannedStart), x2 = dateToX(sd.plannedEnd);
      if (x1 != null && x2 != null && x2 > x1) {
        out.push(
          <div key={stage.id + "-p"} onMouseEnter={onMove} onMouseMove={onMove} onMouseLeave={onLeave}
            style={{ position: "absolute", left: x1, top: planTop, width: x2 - x1, height: barH, background: stage.color, opacity: 0.45, borderRadius: 3, ...labelStyle }}>
            {stage.label}
          </div>
        );
      }
    }
    if (showActual && sd.actualStart && sd.actualEnd) {
      const x1 = dateToX(sd.actualStart), x2 = dateToX(sd.actualEnd);
      if (x1 != null && x2 != null && x2 > x1) {
        out.push(
          <div key={stage.id + "-a"} onMouseEnter={onMove} onMouseMove={onMove} onMouseLeave={onLeave}
            style={{ position: "absolute", left: x1, top: actTop, width: x2 - x1, height: barH, background: stage.color, opacity: 1, borderRadius: 3, ...labelStyle }}>
            {stage.label}
          </div>
        );
      }
    }
    return out;
  };

  const inputDark  = { fontFamily: F, fontSize: 13, padding: "6px 10px", border: `1px solid ${D.border}`, borderRadius: 6, background: D.panelAlt, color: D.text, outline: "none" };
  const pillBtn = (active) => ({ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", border: `1px solid ${active ? D.accent : D.border}`, borderRadius: 999, background: active ? "rgba(167,139,250,.12)" : D.panelAlt, color: active ? D.text : D.muted, fontFamily: F, fontSize: 12, fontWeight: 600, cursor: "pointer" });
  const sampleBar = (opacity) => ({ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 70, height: 14, borderRadius: 3, background: D.accent, opacity, color: "#FFF", fontFamily: F, fontSize: 10, fontWeight: 700 });

  return (
    <div style={{ background: D.bg, color: D.text, borderRadius: fullscreen ? 0 : 14, padding: 0, border: fullscreen ? "none" : `1px solid ${D.border}`, overflow: "hidden", minHeight: fullscreen ? "calc(100vh - 60px)" : undefined }}>
      {/* Legend */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 18px", borderBottom: `1px solid ${D.border}`, fontFamily: F, fontSize: 12 }}>
        <span style={{ fontWeight: 700, color: D.text }}>Legend:</span>
        <span style={sampleBar(0.45)}>Planned</span>
        <span style={{ color: D.muted }}>Planned</span>
        <span style={sampleBar(1)}>Actual</span>
        <span style={{ color: D.muted }}>Actual</span>
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 18px", borderBottom: `1px solid ${D.border}`, flexWrap: "wrap" }}>
        <span style={{ fontFamily: F, fontSize: 12, color: D.muted, flex: 1 }}>Click [+] to expand a SI group.</span>
        <button onClick={() => setShowPlanned(v => !v)} style={pillBtn(showPlanned)}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: showPlanned ? D.accent : D.mutedLow }} /> Planned
        </button>
        <button onClick={() => setShowActual(v => !v)} style={pillBtn(showActual)}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: showActual ? D.accent : D.mutedLow }} /> Actual
        </button>
        <span style={{ fontFamily: F, fontSize: 12, color: D.muted, marginLeft: 8 }}>From:</span>
        <input type="month" value={fromYM} onChange={e => setFromYM(e.target.value)} style={inputDark} />
        <span style={{ fontFamily: F, fontSize: 12, color: D.muted }}>To:</span>
        <input type="month" value={toYM} onChange={e => setToYM(e.target.value)} style={inputDark} />
      </div>

      {projects.length === 0 ? (
        <div style={{ padding: 36, textAlign: "center", color: D.muted, fontSize: 14, fontFamily: F }}>No SI projects to display.</div>
      ) : (
        <div>
          {/* Month header */}
          <div style={{ display: "flex", borderBottom: `1px solid ${D.border}`, background: D.panel }}>
            <div style={{ width: LABEL_W, flexShrink: 0, padding: "10px 16px", fontFamily: F, fontSize: 11, fontWeight: 700, color: D.muted, textTransform: "uppercase", letterSpacing: 1 }}>Fixture / SI</div>
            <div ref={chartRef} style={{ flex: 1, position: "relative", height: 36 }}>
              {months.map((m, i) => (
                <div key={i} style={{ position: "absolute", left: i * colWidth, top: 0, width: colWidth, textAlign: "center", borderLeft: i > 0 ? `1px solid ${D.border}` : "none", fontFamily: F, fontSize: 11, color: D.muted, padding: "10px 0", fontWeight: 600 }}>
                  {new Date(m.y, m.m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                </div>
              ))}
            </div>
          </div>

          {/* Body */}
          <div style={{ position: "relative", background: D.bg }}>
            {groups.map(group => {
              const isExp = expandedSIs.has(group.name);
              return (
                <div key={group.name}>
                  <div style={{ display: "flex", background: D.panel, borderBottom: `1px solid ${D.border}`, height: ROW_H, cursor: "pointer" }} onClick={() => toggleSI(group.name)}>
                    <div style={{ width: LABEL_W, flexShrink: 0, padding: "10px 16px", fontFamily: F, fontSize: 13, fontWeight: 700, color: D.text, display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 16, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", border: `1px solid ${D.border}`, borderRadius: 3, fontSize: 11, color: D.muted, lineHeight: 1 }}>{isExp ? "−" : "+"}</span>
                      {group.name} <span style={{ color: D.muted, fontWeight: 400 }}>({group.projects.length})</span>
                    </div>
                    <div style={{ flex: 1, position: "relative" }}>
                      {todayInRange && <div style={{ position: "absolute", left: todayX, top: 0, bottom: 0, width: 2, background: D.red }} />}
                    </div>
                  </div>

                  {isExp && group.projects.map(proj => {
                    const stageDates = tracker[proj.id]?.stageDates || {};
                    const projExp = expandedProjects.has(proj.id);
                    return (
                      <div key={proj.id}>
                        <div style={{ display: "flex", borderBottom: `1px solid ${D.border}`, height: ROW_H, background: D.bg }}>
                          <div style={{ width: LABEL_W, flexShrink: 0, padding: "10px 16px 10px 32px", fontFamily: F, fontSize: 13, color: D.text, display: "flex", alignItems: "center", gap: 8 }}>
                            <span onClick={() => toggleProject(proj.id)} style={{ width: 14, height: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", border: `1px solid ${D.border}`, borderRadius: 3, fontSize: 10, color: D.muted, cursor: "pointer", lineHeight: 1 }}>{projExp ? "−" : "+"}</span>
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: D.accent, flexShrink: 0 }} />
                            <span onClick={() => toggleProject(proj.id)} style={{ cursor: "pointer", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: D.text }}>{proj.name}</span>
                            {isSIAdminUser && (
                              <button onClick={() => setEditingPid(proj.id)}
                                style={{ padding: "3px 9px", fontSize: 11, fontFamily: F, fontWeight: 600, border: `1px solid ${D.border}`, borderRadius: 6, background: D.panelAlt, color: D.muted, cursor: "pointer" }}>
                                Detailed View
                              </button>
                            )}
                          </div>
                          <div style={{ flex: 1, position: "relative" }}>
                            {todayInRange && <div style={{ position: "absolute", left: todayX, top: 0, bottom: 0, width: 2, background: D.red, zIndex: 2 }} />}
                            {SI_TIMELINE_STAGES.map(stage => renderBars(proj, stage, stageDates[stage.id] || {}))}
                          </div>
                        </div>

                        {projExp && SI_TIMELINE_STAGES.map(stage => {
                          const sd = stageDates[stage.id] || {};
                          return (
                            <div key={stage.id} style={{ display: "flex", borderBottom: `1px solid ${D.border}`, height: ROW_H, background: D.bg }}>
                              <div style={{ width: LABEL_W, flexShrink: 0, padding: "10px 16px 10px 56px", fontFamily: F, fontSize: 12, color: D.muted, display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ width: 8, height: 8, background: stage.color, borderRadius: 2 }} />
                                {stage.label}
                              </div>
                              <div style={{ flex: 1, position: "relative" }}>
                                {todayInRange && <div style={{ position: "absolute", left: todayX, top: 0, bottom: 0, width: 2, background: D.red, zIndex: 2 }} />}
                                {renderBars(proj, stage, sd)}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {todayInRange && (
              <div style={{ position: "absolute", left: LABEL_W + todayX + 4, top: -16, fontFamily: F, fontSize: 10, color: D.red, fontWeight: 700, pointerEvents: "none", background: D.panel, padding: "1px 5px", borderRadius: 3 }}>Today</div>
            )}
          </div>
        </div>
      )}

      {tooltip && (
        <div style={{ position: "fixed", left: tooltip.x + 12, top: tooltip.y + 12, background: "#0F172A", color: "#F1F5F9", padding: "8px 12px", borderRadius: 8, fontFamily: F, fontSize: 12, pointerEvents: "none", zIndex: 1000, boxShadow: "0 4px 12px rgba(0,0,0,.2)", lineHeight: 1.5 }}>
          {tooltip.content}
        </div>
      )}

      {editingPid && (
        <SIStageDatesModal
          project={projects.find(p => p.id === editingPid)}
          stageDates={tracker[editingPid]?.stageDates || {}}
          onSave={(sd) => { saveStageDates(editingPid, sd); setEditingPid(null); }}
          onClose={() => setEditingPid(null)}
        />
      )}
    </div>
  );
}

function SIStageDatesModal({ project, stageDates, onSave, onClose }) {
  const [draft, setDraft] = useState(() => ({ ...stageDates }));
  const update = (stageId, field, value) => setDraft(prev => ({ ...prev, [stageId]: { ...(prev[stageId] || {}), [field]: value } }));
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFF", borderRadius: 16, padding: 28, maxWidth: 760, width: "100%", maxHeight: "90vh", overflow: "auto" }}>
        <h3 style={{ ...S.h3, marginBottom: 4 }}>Edit Stage Dates</h3>
        <p style={{ ...S.sub, margin: "0 0 20px" }}>{project?.name}</p>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Stage</th>
              <th style={S.th}>Planned Start</th>
              <th style={S.th}>Planned End</th>
              <th style={S.th}>Actual Start</th>
              <th style={S.th}>Actual End</th>
            </tr>
          </thead>
          <tbody>
            {SI_TIMELINE_STAGES.map(stage => {
              const sd = draft[stage.id] || {};
              return (
                <tr key={stage.id}>
                  <td style={S.td}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 10, height: 10, background: stage.color, borderRadius: 2 }} />
                      {stage.label}
                    </span>
                  </td>
                  {["plannedStart", "plannedEnd", "actualStart", "actualEnd"].map(field => (
                    <td key={field} style={S.td}>
                      <input type="date" value={sd[field] || ""} onChange={(e) => update(stage.id, field, e.target.value)}
                        style={{ fontFamily: F, fontSize: 13, padding: "4px 7px", border: "1px solid #CBD5E1", borderRadius: 6 }} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
          <button onClick={onClose} style={S.btnEdit}>Cancel</button>
          <button onClick={() => onSave(draft)} style={{ ...S.btnEdit, background: "#00C9A7", color: "#FFF", borderColor: "#00C9A7" }}>Save</button>
        </div>
      </div>
    </div>
  );
}

/* ═══ APP — Auth, DB, routing ═══ */
export default function App() {
  // Public share viewer routing — bypasses auth + the full app shell.
  // Path: /share/sird/{token}. The token resolves to appState/publicSird/{token},
  // which is open-read; vendors don't need an account.
  const shareMatch = window.location.pathname.match(/^\/share\/sird\/([A-Za-z0-9_-]+)\/?$/);
  if (shareMatch) {
    return <PublicSIRDViewer token={shareMatch[1]} />;
  }

  const [authChecked, setAuthChecked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState(getDefault());
  const [authUser, setAuthUser] = useState(null);
  const [user, setUser] = useState(null);
  const VALID_VIEWS = new Set(["dashboard", "project_details", "commercial", "training", "chat", "projects_overview", "all_si_projects", "admin", "manage"]);
  const [view, setView] = useState(() => {
    const saved = localStorage.getItem("dp_last_view");
    return (saved && VALID_VIEWS.has(saved)) ? saved : "project_details";
  });
  const [project, setProject] = useState(null);
  const [loginErr, setLoginErr] = useState("");
  const [pendingApproval, setPendingApproval] = useState(false);
  const [pendingUsers, setPendingUsers] = useState([]);
  const [lang, setLang] = useState("en");
  const [detailTabKey, setDetailTabKey] = useState(0);
  const [siFullscreen, setSiFullscreen] = useState(false);

  // 1. Auth state + session timeout
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (fu) => {
      if (fu) {
        const rem = localStorage.getItem("dp_remember");
        const last = fu.metadata?.lastSignInTime;
        if (rem === "72" && last && (Date.now() - new Date(last).getTime()) > 72*60*60*1000) { signOut(auth); return; }
        if (rem !== "72") { const sa = sessionStorage.getItem("dp_session_active"); if (!sa && last && (Date.now() - new Date(last).getTime()) > 5*60*1000) { signOut(auth); return; } sessionStorage.setItem("dp_session_active", "1"); }
        setAuthUser(fu);
      } else { setAuthUser(null); setUser(null); setPendingApproval(false); setLoaded(false); }
      setAuthChecked(true);
    });
    return () => unsub();
  }, []);

  // 2. User init — v4.0.0: all provisioning goes through provisionUser Cloud Function.
  // No client-side bootstrap. First admin must be manually seeded in Firebase console (see PRE_DEPLOY_RUNBOOK_4.0.0.md).
  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    const init = async () => {
      try {
        const dbUser = await dbRead(`users/${authUser.uid}`);
        if (cancelled) return;
        if (dbUser) { setUser(dbUser); if (dbUser.langPref) setLang(dbUser.langPref); setPendingApproval(false); return; }

        // No user record → call Cloud Function to provision.
        const res = await callProvisionUser();
        if (cancelled) return;
        const status = res?.data?.status;
        if (status === "provisioned_instrumental" || status === "exists") {
          setUser(res.data.user);
          setPendingApproval(false);
        } else if (status === "pending") {
          setPendingApproval(true);
        } else {
          setLoginErr("Provisioning failed. Please contact an admin.");
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) setLoginErr("Sign-in error: " + (e.message || "please refresh."));
      }
    };
    init();
    return () => { cancelled = true; };
  }, [authUser]);

  // 3. DB listeners — access scoped by role. Admin/Instrumental listen on parent; externals listen per-project.
  useEffect(() => {
    if (!user) return;
    const unsubs = [];
    const isAdminOrInst = user.role === "admin" || user.partyId === "instrumental";

    if (isAdminOrInst) {
      // Full reads — rules permit Admin/Instrumental to read parent paths
      unsubs.push(onValue(ref(db, "appState/projects"), (s) => { const v = s.val(); setState(prev => ({ ...prev, projects: projectsToArray(v) })); }, (e) => console.error(e)));
      unsubs.push(onValue(ref(db, "appState/docData"), (s) => { setState(prev => ({ ...prev, docData: s.val() || {} })); }, (e) => console.error(e)));
      unsubs.push(onValue(ref(db, "appState/siTracker"), (s) => {
        setState(prev => ({ ...prev, siTracker: s.val() || {} }));
      }));
      // SI Projects (manually-created via the All SI Projects page; not
      // synced from HubSpot). Stored as a map of {pid: projectRecord}.
      unsubs.push(onValue(ref(db, "appState/siProjects"), (s) => {
        setState(prev => ({ ...prev, siProjects: s.val() || {}, siProjectsLoaded: true }));
      }));
    } else {
      // External users — listen only to assigned projects/docData. Parent reads are blocked by rules.
      const assignedIds = user.projects || [];
      if (assignedIds.length === 0) {
        setState(prev => ({ ...prev, projects: [], docData: {} }));
      }
      assignedIds.forEach(pid => {
        unsubs.push(onValue(ref(db, `appState/projects/${pid}`), (s) => {
          const v = s.val();
          setState(prev => {
            const current = projectsToArray(prev.projects).filter(p => p.id !== pid);
            return { ...prev, projects: v ? [...current, v] : current };
          });
        }, (e) => console.error(e)));
        unsubs.push(onValue(ref(db, `appState/docData/${pid}`), (s) => {
          const v = s.val() || {};
          setState(prev => ({ ...prev, docData: { ...(prev.docData||{}), [pid]: v } }));
        }, (e) => console.error(e)));
      });
    }

    if (user.role === "admin") {
      unsubs.push(onValue(ref(db, "appState/progress"), (s) => { setState(prev => ({ ...prev, progress: s.val() || {} })); }, (e) => console.error(e)));
    } else {
      unsubs.push(onValue(ref(db, `appState/progress/${user.id}`), (s) => { setState(prev => ({ ...prev, progress: { ...(prev.progress||{}), [user.id]: s.val() || {} } })); }, (e) => console.error(e)));
    }
    unsubs.push(onValue(ref(db, "appState/statusMessage"), (s) => { setState(prev => ({ ...prev, statusMessage: s.val() || "" })); }, (e) => console.error(e)));
    if (isAdminOrInst) {
      unsubs.push(onValue(ref(db, "appState/demandCustomTypes"), (s) => { setState(prev => ({ ...prev, demandCustomTypes: s.val() || {} })); }, (e) => console.error(e)));
      unsubs.push(onValue(ref(db, "appState/projectOverview"), (s) => { setState(prev => ({ ...prev, projectOverview: s.val() || {} })); }, (e) => console.error(e)));
    } else {
      // Non-admin external: per-project overview subscription
      (user.projects || []).forEach(pid => {
        unsubs.push(onValue(ref(db, `appState/projectOverview/${pid}`), (s) => {
          setState(prev => ({ ...prev, projectOverview: { ...(prev.projectOverview||{}), [pid]: s.val() || {} } }));
        }, (e) => console.error(e)));
      });
    }
    // v4.0.0: scope reads by role. Admin sees everything. Non-admin sees only own records + per-project entries for projects they have access to.
    if (user.role === "admin") {
      unsubs.push(onValue(ref(db, "commercialAccess"), (s) => { setState(prev => ({ ...prev, commercialAccess: s.val() || {} })); }, (e) => console.error(e)));
      unsubs.push(onValue(ref(db, "users"), (s) => { const v = s.val(); if (v) setState(prev => ({ ...prev, users: Object.values(v) })); }, (e) => console.error(e)));
      unsubs.push(onValue(ref(db, "pendingUsers"), (s) => { const v = s.val(); setPendingUsers(v ? Object.values(v) : []); }, (e) => console.error(e)));
    } else {
      // Non-admin: only own user record + own commercialAccess entries per project they can see.
      unsubs.push(onValue(ref(db, `users/${user.id}`), (s) => { const v = s.val(); if (v) setState(prev => ({ ...prev, users: [v] })); }, (e) => console.error(e)));
      (user.projects || []).forEach(pid => {
        unsubs.push(onValue(ref(db, `commercialAccess/${pid}/${user.id}`), (s) => {
          const v = s.val();
          setState(prev => {
            const next = { ...(prev.commercialAccess || {}) };
            if (v) next[pid] = { ...(next[pid] || {}), [user.id]: true };
            else if (next[pid]) { const p = { ...next[pid] }; delete p[user.id]; next[pid] = p; }
            return { ...prev, commercialAccess: next };
          });
        }, (e) => console.error(e)));
      });
    }
    setLoaded(true);
    return () => unsubs.forEach(u => { try { u(); } catch(e) {} });
  }, [user]);

  // 3a. v3.1.0 one-time migration — runs on admin login. Converts projects array→object, populates access/ map.
  useEffect(() => {
    if (!user || user.role !== "admin") return;
    let cancelled = false;
    (async () => {
      try {
        const schemaVer = await dbRead("_schemaVersion");
        if (schemaVer === "v3.2.0" || schemaVer === "v3.1.0" || cancelled) return;
        const raw = await dbRead("appState/projects");
        const isArrayLike = Array.isArray(raw) || (raw && typeof raw === "object" && Object.keys(raw).every(k => /^\d+$/.test(k)));
        if (isArrayLike && raw) {
          const arr = projectsToArray(raw);
          const obj = {};
          arr.forEach(p => { if (p && p.id) obj[p.id] = p; });
          // Back up before rewriting — gives a rollback path
          await dbWrite("_backup/pre_v3_1_0_projects", { projects: raw, backedUpAt: new Date().toISOString() });
          await dbWrite("appState/projects", obj);
          console.log("[migration] projects array → object, count:", Object.keys(obj).length);
        }
        // Populate access/ map from existing user.projects lists (external users only)
        const usersMap = await dbRead("users") || {};
        const accessMap = {};
        Object.values(usersMap).forEach(u => {
          if (!u?.id) return;
          if (u.role === "admin" || u.partyId === "instrumental") return; // implicit access via rules
          (u.projects || []).forEach(pid => {
            if (!pid) return;
            if (!accessMap[pid]) accessMap[pid] = {};
            accessMap[pid][u.id] = true;
          });
        });
        if (Object.keys(accessMap).length > 0) {
          await dbWrite("access", accessMap);
          console.log("[migration] access/ map populated for", Object.keys(accessMap).length, "projects");
        }
        await dbWrite("_schemaVersion", "v3.1.0");
        console.log("[migration] v3.1.0 complete");
      } catch (e) {
        console.error("[migration] failed:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  // Save — projects are stored in DB as object keyed by ID (enables per-project rules). In-memory stays as array.
  const save = useCallback((updater) => {
    setState(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next.projects !== prev.projects) {
        const arr = projectsToArray(next.projects);
        const obj = {};
        arr.forEach(p => { if (p && p.id) obj[p.id] = p; });
        dbWrite("appState/projects", obj).catch(console.error);
      }
      if (next.docData !== prev.docData) {
        const prevDoc = prev.docData || {};
        Object.keys(next.docData).forEach(pid => {
          if (next.docData[pid] !== prevDoc[pid]) {
            dbWrite(`appState/docData/${pid}`, next.docData[pid]).catch(console.error);
          }
        });
      }
      // v4.0.0: per-user progress write (rules require $uid === auth.uid on progress/$uid).
      if (next.progress !== prev.progress && user?.id && next.progress?.[user.id] !== prev.progress?.[user.id]) {
        dbWrite(`appState/progress/${user.id}`, next.progress[user.id] || null).catch(console.error);
      }
      if (next.statusMessage !== prev.statusMessage) dbWrite("appState/statusMessage", next.statusMessage).catch(console.error);
      if (next.demandCustomTypes !== prev.demandCustomTypes) dbWrite("appState/demandCustomTypes", next.demandCustomTypes || null).catch(console.error);
      // v4.0.0 projectOverview — per-project writes
      if (next.projectOverview !== prev.projectOverview) {
        const po = next.projectOverview || {};
        const poPrev = prev.projectOverview || {};
        Object.keys(po).forEach(pid => { if (po[pid] !== poPrev[pid]) dbWrite(`appState/projectOverview/${pid}`, po[pid] || null).catch(console.error); });
      }
      // v4.0.0: commercialAccess and users/* writes go through admin callables — no direct writes from save().
      return next;
    });
  }, [user]);

  const onLogout = async () => { await signOut(auth); setUser(null); setAuthUser(null); setProject(null); setView("dashboard"); setLoaded(false); };

  // Persist current project/view so hard refresh restores where the user was
  useEffect(() => { if (project?.id) localStorage.setItem("dp_last_project", project.id); }, [project]);
  useEffect(() => { if (view) localStorage.setItem("dp_last_view", view); }, [view]);

  // Auto-select project — restores last-viewed project if still accessible.
  // Guard: skip if state.projects is still the seed placeholder (Firebase hasn't loaded yet).
  useEffect(() => {
    if (user && state.projects && state.projects !== SEED_PROJECTS) {
      const up = (Array.isArray(state.projects) ? state.projects : []).filter(p => user.role === "admin" || (user.projects||[]).includes(p.id));
      if (up.length > 0 && !project) {
        const lastId = localStorage.getItem("dp_last_project");
        setProject((lastId && up.find(p => p.id === lastId)) || up[0]);
      }
    }
  }, [user, state.projects]);

  // Server-side template migration — runs once per project change. Moved here from ProjectDetailsView
  // so it doesn't re-fire on every tab click (which remounts ProjectDetailsView via key={detailTabKey}).
  useEffect(() => {
    if (!user || !isInst(user) || !project?.id) return;
    httpsCallable(functions, "ensureProjectTemplate")({ projectId: project.id })
      .catch(e => console.warn("ensureProjectTemplate:", e.message));
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Render gates
  if (!authChecked) return <div style={S.loginWrap}><p style={{ color: "#94A3B8", fontFamily: F }}>Loading…</p></div>;
  if (!authUser) return <Login err={loginErr} />;
  if (pendingApproval) return <PendingApproval authUser={authUser} onLogout={onLogout} />;
  if (!user || !loaded) return <div style={S.loginWrap}><div><p style={{ color: "#94A3B8", fontFamily: F }}>Loading your data…</p><p style={{ color: "#94A3B8", fontSize: 13, marginTop: 8 }}>Signed in as {authUser.email}</p></div></div>;

  const projectsArr = Array.isArray(state.projects) ? state.projects : (state.projects ? Object.values(state.projects) : []);
  const userProjects = projectsArr.filter(p => user.role === "admin" || (user.projects||[]).includes(p.id));
  const admin = isInst(user);
  const projectCats = project ? getProjectDetails(state.docData, project.id) : [];
  const hasProjectAccess = !project || user.role === "admin" || admin || (user.projects||[]).includes(project.id);
  // Commercial access: admin always has it; others need explicit grant in commercialAccess/{pid}/{uid}
  const hasCommAccess = user.role === "admin" || (project && state.commercialAccess?.[project.id]?.[user.id]);

  const renderMain = () => {
    if (view === "chat") return <ChatView user={user} />;
    if (view === "projects_overview" && admin) return <ProjectsOverviewView state={state} setState={save} user={user} lang={lang} />;
    if (view === "all_si_projects" && admin) return <AllSIProjectsView user={user} state={state} setState={save} setView={setView} setProject={setProject} setSiFullscreen={setSiFullscreen} />;
    if (!hasProjectAccess && view !== "projects_overview" && view !== "admin" && view !== "manage" && view !== "chat" && view !== "all_si_projects") {
      return <div style={S.page}><div style={S.empty}>Access denied — you are not assigned to this project.</div></div>;
    }
    if (view === "project_details") {
      return <ProjectDetailsView key={detailTabKey} user={user} project={project} state={state} setState={save} lang={lang} />;
    }
    if (view === "commercial") {
      if (!hasCommAccess) return <div style={S.page}><div style={S.empty}>🔒 Access restricted. Contact your admin for access to Commercial documents.</div></div>;
      return <CommercialView user={user} project={project} state={state} setState={save} lang={lang} />;
    }
    if (view === "training") {
      return <TrainingView user={user} project={project} state={state} setState={save} lang={lang} />;
    }
    if (view.startsWith("docs_")) {
      // Legacy route compat — redirect to project_details
      return <ProjectDetailsView user={user} project={project} state={state} setState={save} lang={lang} />;
    }
    if (view === "admin" && admin) return <AdminView state={state} setState={save} allProjects={projectsArr} pendingUsers={pendingUsers} currentUser={user} />;
    if (view === "manage" && admin) return <ManageProjects state={state} setState={save} />;
    return <DashboardView user={user} project={project} state={state} setState={save} lang={lang} setView={setView} />;
  };

  const statusMsg = state.statusMessage || "";

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {statusMsg && <div style={S.statusBar}>{statusMsg}</div>}
      <div style={S.appWrap}>
        <style>{`
          * { box-sizing: border-box; margin: 0; }
          body { background: #F8FAFC; font-family: 'Times New Roman', Georgia, serif; }
          ::-webkit-scrollbar { width: 6px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 3px; }
          ::selection { background: #00C9A733; }
        `}</style>
        {!siFullscreen && (
          <Sidebar view={view} setView={setView} user={user} project={project} projects={userProjects} setProject={setProject} onLogout={onLogout} lang={lang} setLang={setLang} hasCommercialAccess={hasCommAccess} cats={projectCats} setDetailTab={(tabId) => { if (project?.id) localStorage.setItem(`dp_proj_tab_${project.id}`, tabId); setDetailTabKey(k => k + 1); setView("project_details"); }} />
        )}
        <main style={{ ...S.main, padding: 0 }}>
          {!siFullscreen && <GlobalBotBar user={user} />}
          <div style={{ padding: siFullscreen ? 0 : "32px 40px" }}>{renderMain()}</div>
        </main>
        {!siFullscreen && <ProjectBotChat project={project} user={user} />}
      </div>
    </div>
  );
}

/* ═══ STYLES ═══ */
const S = {
  appWrap: { display: "flex", minHeight: "100vh", background: "#F8FAFC", fontFamily: F, color: "#1E293B" },
  main: { flex: 1, overflowY: "auto", minHeight: "100vh" },
  page: { maxWidth: 1000, margin: "0 auto", padding: "36px 40px 80px" },
  side: { width: 300, background: "#0F172A", display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh", overflow: "auto" },
  sideHead: { display: "flex", alignItems: "center", gap: 12, padding: "24px 22px 16px" },
  sideTitle: { fontSize: 20, fontWeight: 800, color: "#F1F5F9", fontFamily: F },
  sideLabel: { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color: "#64748B", marginBottom: 6, display: "block", fontFamily: F },
  projSelect: { width: "100%", padding: "11px 14px", background: "#1E293B", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, color: "#E2E8F0", fontSize: 14, fontFamily: F, outline: "none", cursor: "pointer" },
  navList: { flex: 1, padding: "10px 12px", overflowY: "auto" },
  navBtn: { display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "13px 16px", border: "none", borderLeft: "3px solid transparent", borderRadius: "0 12px 12px 0", background: "none", color: "#94A3B8", fontSize: 15, fontWeight: 500, cursor: "pointer", textAlign: "left", fontFamily: F, transition: "all .15s" },
  navActive: { background: "rgba(255,255,255,.1)", color: "#F1F5F9" },
  divider: { height: 1, background: "rgba(255,255,255,.06)", margin: "10px 16px" },
  sideFoot: { padding: 18, borderTop: "1px solid rgba(255,255,255,.06)" },
  ava: { width: 34, height: 34, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, color: "#FFF", fontFamily: F },
  btnOut: { width: "100%", padding: "9px 0", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, background: "none", color: "#94A3B8", fontSize: 13, fontFamily: F, cursor: "pointer" },
  loginWrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F8FAFC", fontFamily: F },
  loginCard: { width: 420, background: "#FFF", borderRadius: 24, padding: 44, border: "1px solid #E2E8F0", boxShadow: "0 20px 60px rgba(0,0,0,.08)" },
  lbl: { display: "block", fontSize: 13, fontWeight: 700, color: "#64748B", marginBottom: 6, marginTop: 16, textTransform: "uppercase", letterSpacing: .8, fontFamily: F },
  inp: { width: "100%", padding: "13px 16px", borderRadius: 12, border: "1px solid #E2E8F0", background: "#F8FAFC", color: "#1E293B", fontSize: 16, fontFamily: F, outline: "none" },
  btnMain: { width: "100%", padding: "15px 0", borderRadius: 12, border: "none", background: "#00C9A7", color: "#FFF", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: F, marginTop: 20, transition: "all .2s" },
  btnFlat: { width: "100%", padding: "12px 0", border: "none", background: "none", color: "#64748B", fontSize: 15, cursor: "pointer", fontFamily: F, marginTop: 4 },
  card: { background: "#FFF", borderRadius: 16, padding: 24, border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,.04)", marginBottom: 0 },
  gridRow: { display: "flex", gap: 16, flexWrap: "wrap" },
  h2: { fontSize: 30, fontWeight: 800, color: "#0F172A", margin: 0, fontFamily: F },
  h3: { fontSize: 20, fontWeight: 700, color: "#1E293B", margin: 0, fontFamily: F },
  sub: { fontSize: 16, color: "#64748B", margin: "6px 0 24px", fontFamily: F },
  miniStat: { display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid #F1F5F9", fontSize: 15, color: "#64748B", fontFamily: F },
  empty: { padding: 36, textAlign: "center", color: "#94A3B8", fontSize: 16, background: "#FFF", borderRadius: 16, border: "1px dashed #E2E8F0", fontFamily: F },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 15, fontFamily: F },
  th: { textAlign: "left", padding: "12px 16px", borderBottom: "2px solid #E2E8F0", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: "#94A3B8", fontFamily: F },
  td: { padding: "14px 16px", borderBottom: "1px solid #F1F5F9", verticalAlign: "middle" },
  tabBtn: { padding: "10px 18px", border: "1px solid #E2E8F0", borderRadius: 10, background: "none", color: "#64748B", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: F, transition: "all .15s" },
  docItemRow: { display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, background: "#F8FAFC", border: "1px solid #F1F5F9", marginBottom: 6 },
  btnAddItem: { padding: "10px 18px", border: "1px dashed #CBD5E1", borderRadius: 10, background: "none", color: "#00C9A7", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: F },
  btnDel: { padding: "5px 10px", border: "none", borderRadius: 8, background: "#FEF2F2", color: "#DC2626", fontSize: 13, cursor: "pointer", fontFamily: F },
  btnEdit: { padding: "6px 14px", border: "1px solid #E2E8F0", borderRadius: 8, background: "none", color: "#64748B", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: F },
  typeBtn: { padding: "8px 14px", border: "1px solid #E2E8F0", borderRadius: 10, background: "none", color: "#64748B", fontSize: 14, cursor: "pointer", fontFamily: F },
  typeBtnActive: { background: "#ECFDF5", borderColor: "#00C9A7", color: "#00C9A7" },
  statusBar: { padding: "16px 28px", background: "#00C9A7", color: "#FFF", fontSize: 17, fontWeight: 700, textAlign: "center", fontFamily: F, position: "sticky", top: 0, zIndex: 100, boxShadow: "0 2px 12px rgba(0,201,167,.3)" },
};
