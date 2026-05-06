import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { auth, db, functions, storage, googleProvider } from "./firebase";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { ref, onValue, set } from "firebase/database";
import { httpsCallable } from "firebase/functions";
import { ref as sRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { PIPELINES, STAGES, PIPELINE_LIST } from "./hubspotConfig";

/* ═══ DB HELPERS ═══ */
const dbRead = (p) => new Promise((resolve, reject) => { onValue(ref(db, p), (s) => resolve(s.val()), (e) => reject(e), { onlyOnce: true }); });
const dbWrite = (p, d) => set(ref(db, p), d);

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

const getDefault = () => ({ projects: SEED_PROJECTS, progress: {}, docData: {}, statusMessage: "" });

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
  // Also inject any template table cats missing from Firebase entirely (e.g. added after ensureProjectTemplate last ran)
  const existingIds = new Set(merged.map(c => c.id));
  const missingTmplCats = APP_TABLE_TEMPLATES.filter(t => !existingIds.has(t.id));
  return [...merged, ...missingTmplCats];
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
  const [overviewOpen, setOverviewOpen] = useState(true);
  const dropdownProjects = admin ? projects.filter(p => p.status !== "inactive") : projects.filter(p => p.status === "active");
  // v4.0.2 — single-control combobox replaces the old <input>+<select> pair (which was glitchy on macOS browsers).
  const [projSearch, setProjSearch] = useState("");
  const [projOpen, setProjOpen] = useState(false);
  const filteredProjects = projSearch.trim() ? dropdownProjects.filter(p => p.name.toLowerCase().includes(projSearch.trim().toLowerCase())) : dropdownProjects;
  const pickProject = (p) => { setProject(p); setProjSearch(""); setProjOpen(false); };
  const navActive = (v) => view === v ? { background: "rgba(255,255,255,.1)", color: "#F1F5F9", borderLeftColor: "#00C9A7" } : {};
  return (
    <aside style={S.side}>
      <div style={S.sideHead}><span style={{ fontSize: 24, color: "#00C9A7" }}>◎</span><span style={S.sideTitle}>{t("Deployment Portal", lang)}</span></div>
      {/* All Projects Overview — large font, admin/instrumental only, with All SI Projects sub-item */}
      {admin && (
        <div style={{ padding: "0 12px 6px" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <button onClick={() => setView("projects_overview")} style={{ ...S.navBtn, flex: 1, width: "auto", fontSize: 20, fontWeight: 800, padding: "16px 16px", ...(view === "projects_overview" ? { background: "rgba(0,201,167,.15)", color: "#00C9A7", borderLeftColor: "#00C9A7" } : {}) }}>🌐 All Projects Overview</button>
            <button onClick={() => setOverviewOpen(o => !o)} style={{ padding: "8px 10px", background: "none", border: "none", color: "#64748B", cursor: "pointer", fontSize: 14, lineHeight: 1, fontFamily: F }}>{overviewOpen ? "▾" : "▸"}</button>
          </div>
          {overviewOpen && (
            <button onClick={() => setView("all_si_projects")} style={{ ...S.navBtn, fontSize: 14, paddingTop: 9, paddingBottom: 9, paddingLeft: 32, ...(view === "all_si_projects" ? { background: "rgba(255,255,255,.1)", color: "#F1F5F9", borderLeftColor: "#00C9A7" } : {}) }}>🤝 All SI Projects</button>
          )}
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
            .filter(c => admin || EXTERNAL_VISIBLE.has(c.id));
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
  useEffect(() => { setDraft(overview); }, [overview, pid]);

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
          {WRITABLE.map(f => editing ? (
            <div key={f.key} style={{ padding: "10px 14px", background: "#F8FAFC", borderRadius: 8, border: "1px solid #F1F5F9" }}>
              <div style={{ fontSize: 11, color: "#64748B", fontFamily: F, textTransform: "uppercase", letterSpacing: .5, fontWeight: 600, marginBottom: 4 }}>{f.label}</div>
              <input type={f.type} style={{ ...S.inp, padding: "4px 8px", fontSize: 13 }} value={draft[f.key] || ""} onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))} />
            </div>
          ) : <Field key={f.key} label={f.label} value={overview[f.key] ? fmtDay(overview[f.key]) : ""} />)}
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

/* ═══ PROJECT TABS VIEW — tabbed nav for all project categories ═══ */
function ProjectTabsView({ cats, updateCats, user, canEdit, pid, project, state, setState, lang, onDelFolder, standardCatIds }) {
  // External users see only 3 specific folders; tables + checklists are Instrumental-only.
  const EXTERNAL_VISIBLE = new Set(["pd_specs", "pd_cad", "pd_deployment_requirements"]);
  const visibleCats = (() => {
    const filtered = cats
      .filter(c => c.type !== "program")
      .filter(c => isInst(user) || EXTERNAL_VISIBLE.has(c.id));
    if (!isInst(user)) return filtered;
    // Instrumental: tables leftmost, then folders, then checklists
    return [
      ...filtered.filter(c => c.type === "table"),
      ...filtered.filter(c => c.type !== "table" && c.type !== "checklist"),
      ...filtered.filter(c => c.type === "checklist"),
    ];
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
  "inst_internal_checklist", "inst_external_checklist", "inst_si_checklist",
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

  const canCheck = canEdit || isInst(user); // Instrumental users can tick + add/delete tasks

  return (
    <div style={{ ...S.card, marginBottom: 12, borderLeft: "3px solid #6366F1" }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 12 }}>{cat.name}</div>
      {(cat.milestones || []).map(ms => {
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
  const [pipelineViewMode, setPipelineViewMode] = useState("list");
  const [demandExpanded, setDemandExpanded] = useState(null); // which hw row is expanded to show per-project
  const canEditDemand = isInst(user); // Any Instrumental user can add custom demand types

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
      <h2 style={S.h2}>All Projects Overview</h2>
      <p style={S.sub}>Summary of all HubSpot projects. <b>This page shows ACTIVE projects only</b> — closed/cancelled projects are excluded throughout.</p>

      {/* External links — prominent at top */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <a href="https://script.google.com/a/macros/instrumental.com/s/AKfycbxVMKgsK6nacvY2zEl4bF9AsKEtN6BNKvd-EQ8LGtOyWw3w5sLfTMT-hXSz102PjbNaqQ/exec" target="_blank" rel="noopener noreferrer" style={{ ...S.card, flex: "1 1 280px", padding: "16px 20px", borderLeft: "4px solid #00C9A7", textDecoration: "none", cursor: "pointer", transition: "box-shadow .15s" }} onMouseEnter={e => e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,.10)"} onMouseLeave={e => e.currentTarget.style.boxShadow=""}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#00C9A7", fontFamily: F }}>Deployment Timeline</div>
          <div style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginTop: 4 }}>View the interactive deployment timeline for all projects</div>
        </a>
        <a href="https://script.google.com/a/macros/instrumental.com/s/AKfycbxOAtRNRm2_-XIPPK1fPKW-O55uVtMhMZSDcdZiR4xRqRBmtYgqURhAZ8MPg3RVsvNG/exec" target="_blank" rel="noopener noreferrer" style={{ ...S.card, flex: "1 1 280px", padding: "16px 20px", borderLeft: "4px solid #3B82F6", textDecoration: "none", cursor: "pointer", transition: "box-shadow .15s" }} onMouseEnter={e => e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,.10)"} onMouseLeave={e => e.currentTarget.style.boxShadow=""}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#3B82F6", fontFamily: F }}>SI Process, RACI & Principles</div>
          <div style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginTop: 4 }}>Deployment process flowchart, RACI matrix, and SI working principles</div>
        </a>
      </div>
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
            return (
              <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 12 }}>
                {activeStages.map(([stageId, stage], idx) => {
                  const projs = byStage[stageId] || [];
                  const color = KANBAN_COLORS[idx % KANBAN_COLORS.length];
                  return (
                    <div key={stageId} style={{ minWidth: 200, maxWidth: 240, flex: "0 0 auto", background: "#F8FAFC", borderRadius: 12, border: "2px solid #F1F5F9", padding: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                        <div style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#0F172A", fontFamily: F, lineHeight: 1.3 }}>{stage.label}</div>
                        <Chip small color={`${color}22`} fg={color}>{projs.length}</Chip>
                      </div>
                      {projs.map(proj => (
                        <div key={proj.id} style={{ background: "#FFF", borderRadius: 8, padding: "8px 10px", marginBottom: 6, border: "1px solid #E2E8F0", fontSize: 12, fontFamily: F }}>
                          <div style={{ fontWeight: 600, color: "#0F172A", marginBottom: 2 }}>{proj.customer || proj.name}<HubspotLinkIcon project={proj} /></div>
                          {proj.name !== proj.customer && <div style={{ color: "#94A3B8", fontSize: 11, marginBottom: 2 }}>{proj.name}</div>}
                          <div style={{ color: "#94A3B8", fontSize: 11 }}>{proj.stations || 0} stn{proj.isSI ? " · SI" : ""}</div>
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
function AllSIProjectsView({ user, state, setState, setView, setProject, setSiFullscreen }) {
  const isSIAdminUser = user?.role === "si_admin" || user?.role === "admin" || user?.superAdmin;
  const SI_PIPELINE = "2206979797";
  const siProjects = (Array.isArray(state.projects) ? state.projects : []).filter(p => p.hubspotPipelineId === SI_PIPELINE);
  const tracker = state.siTracker || {};
  const [editing, setEditing] = useState(null); // { pid, field }
  const [tab, setTab] = useState("tracker"); // "tracker" | "timeline"
  const fullscreen = true;

  useEffect(() => { setSiFullscreen?.(true); return () => setSiFullscreen?.(false); }, [setSiFullscreen]);

  const saveTracker = (pid, field, value) => {
    dbWrite(`appState/siTracker/${pid}/${field}`, value);
    setState(prev => ({
      ...prev,
      siTracker: {
        ...(prev.siTracker || {}),
        [pid]: { ...(prev.siTracker?.[pid] || {}), [field]: value },
      },
    }));
  };

  const riskBadge = (val) => {
    if (val === "at_risk") return "🔴 At-risk";
    if (val === "watch")   return "🟡 Watch";
    if (val === "healthy") return "🟢 Healthy";
    return "—";
  };

  const atRisk  = siProjects.filter(p => tracker[p.id]?.risk === "at_risk").length;
  const watch   = siProjects.filter(p => tracker[p.id]?.risk === "watch").length;
  const healthy = siProjects.filter(p => tracker[p.id]?.risk === "healthy").length;

  const allActiveProjects = (Array.isArray(state.projects) ? state.projects : []).filter(p => p.status !== "inactive");

  const tabBtn = (id, label) => (
    <button onClick={() => setTab(id)}
      style={{
        padding: "7px 16px",
        border: `1px solid ${tab === id ? "#00C9A7" : "#E2E8F0"}`,
        borderRadius: 8,
        background: tab === id ? "#ECFDF5" : "#FFF",
        color: tab === id ? "#00C9A7" : "#64748B",
        fontFamily: F, fontSize: 13, fontWeight: 600, cursor: "pointer",
      }}>
      {label}
    </button>
  );

  return (
    <div style={{ minHeight: "100vh", background: tab === "timeline" ? "#0F1117" : "#F8FAFC" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 24px", borderBottom: `1px solid ${tab === "timeline" ? "#2A2E3D" : "#E2E8F0"}`, background: tab === "timeline" ? "#0F1117" : "#FFF", position: "sticky", top: 0, zIndex: 10, flexWrap: "wrap" }}>
        <button onClick={() => setView("projects_overview")}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px",
            border: `1px solid ${tab === "timeline" ? "#2A2E3D" : "#E2E8F0"}`, borderRadius: 8,
            background: tab === "timeline" ? "#171A23" : "#FFF",
            color: tab === "timeline" ? "#E2E8F0" : "#64748B",
            fontFamily: F, fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>
          ← Back to Overview
        </button>
        <h2 style={{ ...S.h2, fontSize: 20, margin: 0, color: tab === "timeline" ? "#E2E8F0" : "#0F172A" }}>🤝 All SI Projects</h2>
        <div style={{ display: "flex", gap: 6 }}>
          {tabBtn("tracker", "Tracker")}
          {tabBtn("timeline", "Timeline")}
        </div>
        <span style={{ fontFamily: F, fontSize: 13, color: tab === "timeline" ? "#94A3B8" : "#64748B", marginLeft: "auto" }}>
          {siProjects.length} project{siProjects.length !== 1 ? "s" : ""} in SI Partner Deployment pipeline
        </span>
      </div>

      {tab === "tracker" ? (
        <div style={{ padding: "24px 32px 80px" }}>
          <SIKanbanView projects={allActiveProjects} state={state} setState={setState} />

          <div style={{ display: "flex", gap: 20, margin: "24px 0 16px", flexWrap: "wrap" }}>
            <span style={{ fontFamily: F, fontSize: 14, color: "#64748B" }}>🔴 At-risk: <strong>{atRisk}</strong></span>
            <span style={{ fontFamily: F, fontSize: 14, color: "#64748B" }}>🟡 Watch: <strong>{watch}</strong></span>
            <span style={{ fontFamily: F, fontSize: 14, color: "#64748B" }}>🟢 Healthy: <strong>{healthy}</strong></span>
          </div>
          {siProjects.length === 0 ? (
            <div style={S.empty}>No projects in SI Partner Deployment pipeline.</div>
          ) : (
            <div style={S.card}>
              <div style={{ overflowX: "auto" }}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.th}>Project</th>
                      <th style={S.th}>HubSpot Stage</th>
                      <th style={S.th}>SI Partner</th>
                      <th style={S.th}>Risk</th>
                      <th style={S.th}>Last Contact</th>
                      <th style={S.th}>Next Milestone</th>
                      <th style={S.th}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {siProjects.map(proj => <SIProjectRow key={proj.id} proj={proj} tracker={tracker} isSIAdminUser={isSIAdminUser} editing={editing} setEditing={setEditing} saveTracker={saveTracker} riskBadge={riskBadge} setProject={setProject} setView={setView} />)}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : (
        <SITimelineView projects={siProjects} tracker={tracker} setState={setState} isSIAdminUser={isSIAdminUser} fullscreen={fullscreen} />
      )}
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
  const projectCats = (project && state.docData?.[project.id]?.projectDetails) || [];
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
        <ProjectBotChat project={project} user={user} />
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
