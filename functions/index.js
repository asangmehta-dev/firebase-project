const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const { buildProjectDetails, buildCommercialFolders, TABLE_TEMPLATES, DEPLOYMENT_REQUIREMENTS_FOLDER } = require("./checklists");

const FETCH_TIMEOUT_MS = 15000;
async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

admin.initializeApp();
const db = admin.database();

/* ═══ CONFIG ═══ */
const OBJECT_TYPE = "2-39524389";
const SHIPMENT_OBJECT_TYPE = "2-39524475"; // Shipments custom object; primaryDisplayProperty = shipment_tracking_number (INxxx)
const STATION_KIT_TYPE_ID = "2-39260531";  // Station Kits custom object — used to traverse Kit→Shipment associations
// v4.5.0: Fleet Asset object type + association labels (Kit↔FleetAsset).
// Each fleet asset is linked to a kit with TWO associations: a labeled one (e.g. "Camera 1" / typeId 240)
// AND a generic unlabeled one (typeId 35). Writeback must handle both.
const FLEET_ASSET_TYPE_ID = "2-39261140";
const FLEET_ASSET_UNLABELED_TYPE_ID = 35;
// Map HubSpot association labels → typeId. Discovered via
// GET /crm/v4/associations/{STATION_KIT_TYPE_ID}/{FLEET_ASSET_TYPE_ID}/labels.
// Note: HubSpot's label casing is inconsistent ("camera 2" vs "Camera 1"); we preserve the exact strings
// HubSpot returns so the round trip stays accurate.
const FLEET_ASSET_LABEL_TO_TYPE_ID = {
  "Camera 1":             240,
  "camera 2":             236,
  "camera 3":             346,
  "camera 4":             348,
  "Camera 5":             402,
  "Lens 1":               238,
  "Lens 2":               226,
  "Lens 3":               350,
  "Lens 4":               352,
  "Lens 5":               404,
  "Computer":             234,
  "LED Light Controller": 228,
  "Monitor":              232,
  "Frame":                242,
  "Barcode Scanner":      230,
  "Sensor":               406,
  "Motorised Stage":      408,
  "Ram Upgrade 1":        332,
  "RAM Upgrade 2":        244,
};
// v4.5.5: CAD release docs synced from HubSpot Project properties → pd_cad folder.
// HDEs use a HubSpot workflow that writes URLs to 4 project properties + emails them.
// We read the properties on every sync and surface them inside Project Details → CAD & Drawings.
// Hidden _hubspotSource key on each item is the match key for re-runs (so we update
// the existing item's URL instead of duplicating).
const CAD_DOC_DEFS = [
  { key: "cad_folder",          label: "CAD Folder",          type: "link" },
  { key: "station_overview",    label: "Station Overview",    type: "link" },
  { key: "station_bom_details", label: "Station BOM Details", type: "link" },
  { key: "machining_notes",     label: "Machining Notes",     type: "link" },
];
// Per-SI-stage entered/exited date properties — populated by HubSpot
// automatically as projects move through the SI Partner Deployment pipeline.
// We request these so the timeline can pull actual stage dates without
// requiring the user to type them in.
const SI_STAGE_DATE_PROPS = [
  // entered
  "hs_v2_date_entered_3539976891", "hs_v2_date_entered_3539976892",
  "hs_v2_date_entered_3545524981", "hs_v2_date_entered_3545524982",
  "hs_v2_date_entered_3545524983", "hs_v2_date_entered_3545524984",
  "hs_v2_date_entered_3545524985", "hs_v2_date_entered_3545525946",
  // exited
  "hs_v2_date_exited_3539976891", "hs_v2_date_exited_3539976892",
  "hs_v2_date_exited_3545524981", "hs_v2_date_exited_3545524982",
  "hs_v2_date_exited_3545524983", "hs_v2_date_exited_3545524984",
  "hs_v2_date_exited_3545524985", "hs_v2_date_exited_3545525946",
];
const PROPERTIES = [
  "project_name", "hs_object_id", "app_project_id__c", "number_of_stations__c",
  "company_codename", "hs_pipeline", "hs_pipeline_stage",
  "associated_cs_program_id_last", "deploy_location_from_opportunity__c",
  "deploy_region__c", "deployzen_datazen_tpm",
  // v4.5.3: 4 DRI Owner IDs for pd_team sync
  "hde__hardware_design_engineer_", "sie__software_integration_engineer_",
  "sa_solutions_architect", "cs_customer_success",
  "standard_cameras", "number_of_cameras__c", "regular_lenses", "tc_lense",
  "type_of_lenses", "led_light_controllers", "standard_station_frames",
  "large_station_frames", "computers", "monitor_screens", "barcode_scanners",
  "station_bom_details_hde",
  // v4.5.5: CAD release URLs populated by the HubSpot CAD Release workflow.
  // Synced into the pd_cad folder so HDE releases appear under "CAD & Drawings" in the app.
  "cad_folder", "station_overview_hde", "machining_notes_hde",
  "hs_createdate", "hs_lastmodifieddate",
  "actual_start_date", "actual_finish_date",
  ...SI_STAGE_DATE_PROPS,
].join(",");

const PIPELINES = {
  "680801112": { label: "Hardware Deployment Pipeline", order: 0 },
  "680446891": { label: "Data Source Deployment Pipeline", order: 1 },
  "679446421": { label: "MES Integration Pipeline", order: 2 },
  "682405760": { label: "Station Return", order: 3 },
  "684527408": { label: "Image Source Deployment Pipeline", order: 4 },
  "1919898345": { label: "Data Analytics", order: 5 },
  // v4.0.1 — SI Partner Deployment pipeline.
  "2206979797": { label: "SI Partner Deployment", order: 6 },
};

// v4.1.0 — si_admin role helper: si_admin, admin, and superAdmin all have SI-admin capabilities.
const isSIAdmin = (caller) => caller?.role === "si_admin" || caller?.role === "admin" || caller?.superAdmin;

// v4.0.1 — SI Partner Deployment pipeline ID + stage mapping.
const SI_PARTNER_PIPELINE_ID = "2206979797";
// Map: HubSpot stage ID → SI Kanban stage key (sird|dfm|quote|po|build|fat|sat|live)
const SI_PARTNER_STAGE_MAP = {
  "3539976891": "sird",
  "3539976892": "dfm",
  "3545524981": "quote",
  "3545524982": "po",
  "3545524983": "build",
  "3545524984": "fat",
  "3545524985": "sat",
  "3545525946": "live",
};

const STAGES = {
  "1053337914": { label: "Deal SG6/7 Pipeline", closed: false, order: 0 },
  "997715736":  { label: "Kickoff", closed: false, order: 1 },
  "999736172":  { label: "Scope Verify w/Customer", closed: false, order: 2 },
  "1067748453": { label: "Design Queue", closed: false, order: 3 },
  "997715738":  { label: "InProgress Station/Nest Design", closed: false, order: 4 },
  "997715739":  { label: "Awaiting Nest Approval", closed: false, order: 5 },
  "997715740":  { label: "Station Configuration", closed: false, order: 6 },
  "997715741":  { label: "Shipment & Logistics", closed: false, order: 7 },
  "997715742":  { label: "Setup & Verification", closed: false, order: 8 },
  "997715743":  { label: "First Image in App", closed: false, order: 9 },
  "997715737":  { label: "Complete-Project/Deployment", closed: true, order: 10 },
  "1053255817": { label: "Cancel-Project/Deployment", closed: true, order: 11 },
  "3118657221": { label: "Pre-Deal Lost", closed: true, order: 12 },
  "997709588": { label: "Scope Reviewed w/Customer", closed: false, order: 0 },
  "997549163": { label: "Scope Validated", closed: false, order: 1 },
  "997549164": { label: "S3 Bucket & Test PRJ Creation", closed: false, order: 2 },
  "997549165": { label: "Sample Data Received", closed: false, order: 3 },
  "997549166": { label: "Test Data Uploaded", closed: false, order: 4 },
  "997549167": { label: "Test Data Verified", closed: false, order: 5 },
  "997549168": { label: "Data Upload to Final Project", closed: false, order: 6 },
  "997549169": { label: "Data Upload Automated", closed: false, order: 7 },
  "997709589": { label: "Project Complete", closed: true, order: 8 },
  "997780264": { label: "MES Questionnaire Share w/CM", closed: false, order: 0 },
  "997677454": { label: "CM MES Spec Received", closed: false, order: 1 },
  "997677455": { label: "CM MES API Validated", closed: false, order: 2 },
  "997677456": { label: "MES Implementation", closed: false, order: 3 },
  "997677457": { label: "MES Test", closed: false, order: 4 },
  "997677458": { label: "MES Routing Enforcement", closed: false, order: 5 },
  "997780265": { label: "Project Complete", closed: true, order: 6 },
  "999818661": { label: "Send Shipment & Packaging Info to CM", closed: false, order: 0 },
  "999761080": { label: "Station Shipped to Inst", closed: false, order: 1 },
  "999761081": { label: "Station Components Verified", closed: false, order: 2 },
  "999761152": { label: "Station Kits Returned", closed: false, order: 3 },
  "999818662": { label: "Project Complete", closed: true, order: 4 },
  "1002465694": { label: "Scope Reviewed w/Customer", closed: false, order: 0 },
  "1002419978": { label: "Scope Validated", closed: false, order: 1 },
  "1002419979": { label: "S3 Bucket & Test PRJ Creation", closed: false, order: 2 },
  "1002419980": { label: "Sample Data Received", closed: false, order: 3 },
  "1002419981": { label: "Test Data Uploaded", closed: false, order: 4 },
  "1002419982": { label: "Test Data Verified", closed: false, order: 5 },
  "1002419983": { label: "Data Upload to Final Project", closed: false, order: 6 },
  "1002419984": { label: "Data Upload Automated", closed: false, order: 7 },
  "1002465695": { label: "Project Complete", closed: true, order: 8 },
  "3040887544": { label: "Ideation", closed: false, order: 0 },
  "3039176431": { label: "Kick-off", closed: false, order: 1 },
  "3039176432": { label: "In Progress", closed: false, order: 2 },
  "3040887545": { label: "Completed", closed: true, order: 3 },
  // v4.0.1 — SI Partner Deployment pipeline stages
  "3539976891": { label: "SIRD",  closed: false, order: 0 },
  "3539976892": { label: "DFM",   closed: false, order: 1 },
  "3545524981": { label: "Quote", closed: false, order: 2 },
  "3545524982": { label: "PO",    closed: false, order: 3 },
  "3545524983": { label: "Build", closed: false, order: 4 },
  "3545524984": { label: "FAT",   closed: false, order: 5 },
  "3545524985": { label: "SAT",   closed: false, order: 6 },
  "3545525946": { label: "Live",  closed: false, order: 7 },
};

const CODENAME_MAP = {
  "allsorts": "Aescape", "altoids": "Alta Motors", "toffee/rolo parent": "Amazon",
  "abba-zaba": "Anduril Industries", "atomic fireball": "Apple", "almond joy": "Arista",
  "andes": "August, Inc.", "aero": "Axon", "bonbon": "Backbone", "baby ruth": "Bang & Olufsen",
  "starburst": "Block, Inc.", "butterfingers": "Bose", "coffee crisp": "Carbon Revolution",
  "cachou": "Cerebras Systems", "crunch bar": "ChargePoint", "mamba": "Meraki / CISCO",
  "cherry pie": "Cora (Wisk Aero)", "cotton candy": "Cruise Automation", "donut": "DJI",
  "eclipse": "Eargo", "eclair": "Ecobee", "toffee": "Eero", "espresso": "Empatica",
  "xigua": "Exponent", "fanta": "F5", "fortune cookie": "Fitbit", "flan": "FLIR Systems",
  "flanby": "Flock Safety", "fruit stripe": "Fossil", "gummybear": "Glowforge",
  "gobstoppers": "Google", "gumdrop": "GoPro", "gelato": "Gridware", "haribo": "Henkel",
  "hbo": "Honeywell", "hot tamale": "Humane", "icee": "Intuitive Surgical",
  "jelly belly": "Jabil", "juicy fruit": "Juul Labs", "keebler": "Keysight Technologies",
  "key lime pie": "Kitty Hawk", "knish": "KNS", "lot 100": "L3Harris Technologies",
  "airheads": "Lab 126 (Amazon)", "life savers": "Lenovo", "licorice": "Light",
  "lemondrop": "Logitech", "laffy taffy": "Lutron Electronics", "m&m's": "Mabe",
  "milkyway": "Meraki (POC)", "fundip": "Meta", "mars": "Microsoft", "mike n ike": "Microtek",
  "mentos": "Motorola Mobility", "mint": "Motorola Solutions", "nilla": "Nest",
  "necco": "Netgear", "forrest gump": "Nike", "nougat": "Nokia / Withings",
  "nerds": "NVIDIA Data Centers", "oreo": "Oculus", "otter pops": "Opal Camera",
  "opera": "OURA", "orbit": "Owletcare", "pez": "P2i", "kitkat": "Pearl Auto",
  "peeps": "Peloton", "pop rocks": "Poly", "pop tarts": "Puffco",
  "quality street": "QSC Audio Products", "reese's": "Razer", "rolo": "Ring",
  "razzle": "Rocket EMS", "smarties": "Seacomp", "skor": "Sesame AI", "snickers": "Snap",
  "sweetarts": "Softmatter", "sour patch kids": "SolarEdge",
  "spearmint": "Spellman High Voltage", "spree": "Spire", "sunnyhills": "Supermicro",
  "toblerone": "Tesla", "twizzlers": "Toast", "tribala": "Tractian",
  "violet crumble": "Valve", "vanilla": "Velodyne", "viennetta": "View",
  "warheads": "Whirlpool", "whoppers": "Whoop", "skittles": "Xylem (Sensus)",
  "zingers": "Zebra Technologies", "zero": "ZT Systems", "zots": "Zwift",
};

/* ═══ HELPERS ═══ */
function decodeCodename(codename) {
  if (!codename) return null;
  return CODENAME_MAP[codename.trim().toLowerCase()] || codename;
}

function extractStationsFromName(name) {
  if (!name) return null;
  const patterns = [/(\d+)\s*station\s*kit/i, /(\d+)\s*stations?/i, /(\d+)st\b/i, /\bx(\d+)\b/i];
  for (const p of patterns) {
    const m = name.match(p);
    if (m) return parseInt(m[1]);
  }
  return null;
}

function mapHubspotToProject(obj) {
  const p = obj.properties || {};
  const stageId = p.hs_pipeline_stage;
  const pipelineId = p.hs_pipeline;
  const stage = STAGES[stageId] || {};
  const pipeline = PIPELINES[pipelineId] || {};
  const name = p.project_name || `HubSpot Project ${obj.id}`;
  const codename = p.company_codename || null;
  const customer = decodeCodename(codename) || "";
  const stationsFromField = p.number_of_stations__c ? parseInt(p.number_of_stations__c) : null;
  const stationsFromName = extractStationsFromName(name);
  const stations = stationsFromField || stationsFromName || 0;
  // v4.0.2 — isSI is STRICTLY pipeline-based: only projects in SI Partner Deployment are SI.
  // Hardware Deployment projects with "[SI]" in the name are regular Hardware — the tag is just a label.
  const isFromSiPartner = pipelineId === SI_PARTNER_PIPELINE_ID;
  const isSI = isFromSiPartner;
  // siStage is set ONLY for projects in SI Partner Deployment pipeline (drives the Kanban).
  // Falls back to "sird" if a stage ID isn't in the map yet.
  const siStage = isFromSiPartner ? (SI_PARTNER_STAGE_MAP[stageId] || "sird") : null;
  const isClosed = stage.closed === true;

  // Per-stage entered/exited timestamps from HubSpot, keyed by the
  // canonical SI stage label used in our timeline ("SIRD", "DFM", …).
  // ISO-8601 date strings; null when the stage hasn't been entered/exited.
  const SI_STAGE_KEY_TO_CANONICAL = {
    sird: "SIRD", dfm: "DFM", quote: "Quote", po: "PO",
    build: "Build", fat: "FAT", sat: "SAT", live: "Live",
  };
  const toISODate = (raw) => {
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  const hubspotStageDates = {};
  if (isFromSiPartner) {
    for (const [hsStageId, key] of Object.entries(SI_PARTNER_STAGE_MAP)) {
      const canonical = SI_STAGE_KEY_TO_CANONICAL[key];
      if (!canonical) continue;
      const entered = toISODate(p[`hs_v2_date_entered_${hsStageId}`]);
      const exited  = toISODate(p[`hs_v2_date_exited_${hsStageId}`]);
      if (entered || exited) hubspotStageDates[canonical] = { entered, exited };
    }
  }

  return {
    id: `hs_${obj.id}`,
    hubspotId: obj.id,
    name,
    customer,
    codename,
    actualStartDate: toISODate(p.actual_start_date),
    actualFinishDate: toISODate(p.actual_finish_date),
    hubspotStageDates,
    appProjectId: p.app_project_id__c || null,
    stations,
    isSI,
    siStage,
    hubspotPipelineId: pipelineId || null,
    hubspotPipelineLabel: pipeline.label || null,
    hubspotStageId: stageId || null,
    hubspotStageLabel: stage.label || null,
    hubspotStageClosed: isClosed,
    hubspotStageOrder: stage.order ?? 99,
    csProgramId: p.associated_cs_program_id_last || null,
    deployLocation: p.deploy_location_from_opportunity__c || null,
    deployRegion: p.deploy_region__c || null,
    tpm: p.deployzen_datazen_tpm || null,
    hde: p.hde__hardware_design_engineer_ || null,
    // v4.5.3: all 4 DRI Owner IDs (numeric strings) for pd_team sync. Resolution to person details happens in runSync.
    dri: {
      hde: p.hde__hardware_design_engineer_     || null,
      sie: p.sie__software_integration_engineer_|| null,
      sa:  p.sa_solutions_architect             || null,
      cs:  p.cs_customer_success                || null,
    },
    hardware: {
      cameras: p.standard_cameras || p.number_of_cameras__c || null,
      lenses: p.regular_lenses || null,
      tcLense: p.tc_lense || null,
      lensType: p.type_of_lenses || null,
      ledControllers: p.led_light_controllers || null,
      standardFrames: p.standard_station_frames || null,
      largeFrames: p.large_station_frames || null,
      computers: p.computers || null,
      monitors: p.monitor_screens || null,
      barcodeScanner: p.barcode_scanners || null,
      bomDetails: p.station_bom_details_hde || null,
    },
    // v4.5.5: CAD release URLs (consumed by the pd_cad folder sync block in runSync).
    // Each value is either a URL string or null; sync skips projects where all 4 are null.
    cadDocs: {
      cad_folder:          p.cad_folder              || null,
      station_overview:    p.station_overview_hde    || null,
      station_bom_details: p.station_bom_details_hde || null,
      machining_notes:     p.machining_notes_hde     || null,
    },
    status: isClosed ? "inactive" : "active",
    si: isSI ? "" : "N/A",
    cm: "",
    partyNames: {
      instrumental: "Instrumental",
      si: isSI ? "" : "N/A",
      customer: customer || "",
      cm: "",
    },
    hubspotCreatedAt: p.hs_createdate || null,
    hubspotUpdatedAt: p.hs_lastmodifieddate || null,
    syncedAt: new Date().toISOString(),
    source: "hubspot",
  };
}

async function fetchAllHubspotObjects(token) {
  const all = [];
  let after = null;
  do {
    const url = `https://api.hubapi.com/crm/v3/objects/${OBJECT_TYPE}?limit=100&properties=${PROPERTIES}${after ? `&after=${after}` : ""}`;
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HubSpot API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    all.push(...(data.results || []));
    after = data.paging?.next?.after || null;
  } while (after);
  return all;
}

/* ═══ STATION KITS SYNC ═══ */
// Normalize HubSpot category labels to webapp hardware types
function normalizeCategory(cat) {
  if (!cat) return "Other";
  const c = cat.toLowerCase();
  if (c.includes("camera")) return "Camera";
  if (c.includes("lens")) return "Lens";
  if (c.includes("computer")) return "Station Computer";
  if (c.includes("frame")) return "Frame";
  if (c.includes("monitor") || c.includes("screen")) return "Monitor";
  if (c.includes("led") || c.includes("light controller")) return "LED Controller";
  if (c.includes("barcode") || c.includes("scanner")) return "Barcode Scanner";
  return cat; // pass through unknown categories as-is
}

// Discover Station Kit + Station Component object type IDs from HubSpot schema.
// Returns null if not found — callers handle gracefully.
async function discoverStationObjectTypes(token) {
  try {
    const res = await fetchWithTimeout("https://api.hubapi.com/crm/v3/schemas", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    let kitTypeId = null, componentTypeId = null;
    const allLabels = [];
    for (const schema of (data.results || [])) {
      const singular = (schema.labels?.singular || schema.name || "").toLowerCase();
      const plural   = (schema.labels?.plural   || "").toLowerCase();
      const name     = (schema.name || "").toLowerCase();
      const typeId   = schema.objectTypeId || schema.id;
      allLabels.push(`${singular}/${plural}(${typeId})`);
      if (singular.includes("station kit") || plural.includes("station kit")) kitTypeId = typeId;
      // v4.5.2 fix: explicitly match "fleet asset" — there's no "station component" object in HubSpot.
      // Previously this fell through to "first non-kit non-project association" which depended on
      // schema association order; a recent reorder put cs_programs_to_station_kits first, so the
      // discovery picked the CS Programs type as components, producing empty fleet-asset data.
      if (singular.includes("fleet asset") || plural.includes("fleet asset") || name === "fleet_assets") componentTypeId = typeId;
      if (singular.includes("station component") || plural.includes("station component")) componentTypeId = typeId;
    }
    console.log("[stationKits] schema:", allLabels.join(", "));

    // Always fetch the kit schema to discover actual associated component types
    if (kitTypeId) {
      try {
        const schemaRes = await fetchWithTimeout(`https://api.hubapi.com/crm/v3/schemas/${kitTypeId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (schemaRes.ok) {
          const kitSchema = await schemaRes.json();
          const assocs = kitSchema.associations || [];
          console.log("[stationKits] kit schema assocs:", JSON.stringify(assocs.map(a => ({ to: a.toObjectTypeId, name: a.name, label: a.label }))));
          // If componentTypeId not yet found from labels, look for the fleet asset association by typeId match.
          // Prefer FLEET_ASSET_TYPE_ID const (known stable) over arbitrary first-non-kit assoc.
          if (!componentTypeId) {
            if (assocs.some(a => a.toObjectTypeId === FLEET_ASSET_TYPE_ID)) {
              componentTypeId = FLEET_ASSET_TYPE_ID;
              console.log("[stationKits] componentTypeId set from FLEET_ASSET_TYPE_ID const:", componentTypeId);
            } else {
              // Last-resort: first non-kit, non-project assoc (legacy behavior, fragile)
              for (const a of assocs) {
                if (a.toObjectTypeId && a.toObjectTypeId !== kitTypeId && a.toObjectTypeId !== OBJECT_TYPE) {
                  componentTypeId = a.toObjectTypeId;
                  console.warn("[stationKits] fallback inferred componentTypeId from kit schema (fragile):", componentTypeId);
                  break;
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn("[stationKits] kit schema lookup failed:", e.message);
      }
    }

    console.log("[stationKits] discovered →", { kitTypeId, componentTypeId });
    return kitTypeId ? { kitTypeId, componentTypeId } : null;
  } catch (e) {
    console.warn("[stationKits] schema discovery failed:", e.message);
    return null;
  }
}

// Batch-read project → station kit associations via v4 API, then batch-read kit properties.
// Returns { byProject: { projectHsId: [kitId, ...] }, kitProps: { kitId: properties } }.
// Avoids v3 inline association key ambiguity (custom-to-custom objects).
async function fetchKitsForProjects(token, projectHsIds, kitTypeId) {
  if (!projectHsIds.length) return { byProject: {}, kitProps: {} };
  const BATCH = 100;
  const byProject = {};

  const projBatches = [];
  for (let i = 0; i < projectHsIds.length; i += BATCH) projBatches.push(projectHsIds.slice(i, i + BATCH));
  await Promise.all(projBatches.map(async (batch) => {
    try {
      const res = await fetchWithTimeout(
        `https://api.hubapi.com/crm/v4/associations/${OBJECT_TYPE}/${kitTypeId}/batch/read`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ inputs: batch.map(id => ({ id: String(id) })) }),
        }
      );
      if (!res.ok) { console.warn("[stationKits] project→kit assoc batch error:", res.status); return; }
      const data = await res.json();
      for (const result of (data.results || [])) {
        byProject[String(result.from.id)] = (result.to || []).map(t => String(t.toObjectId));
      }
    } catch (e) {
      console.warn("[stationKits] project→kit assoc batch failed:", e.message);
    }
  }));

  const allKitIds = [...new Set(Object.values(byProject).flat())];
  const kitProps = {};
  const kitBatches = [];
  for (let i = 0; i < allKitIds.length; i += BATCH) kitBatches.push(allKitIds.slice(i, i + BATCH));
  await Promise.all(kitBatches.map(async (batch) => {
    try {
      const res = await fetchWithTimeout(`https://api.hubapi.com/crm/v3/objects/${kitTypeId}/batch/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: batch.map(id => ({ id })),
          properties: ["station_kit_sn", "name", "computer_sn", "status", "station_type"],
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      for (const obj of (data.results || [])) kitProps[obj.id] = obj.properties || {};
    } catch (e) {
      console.warn("[stationKits] kit props batch failed:", e.message);
    }
  }));

  return { byProject, kitProps };
}

// Batch-fetch Station Components (Fleet Assets) for a list of kit IDs.
// v4.5.0: now also captures the per-association label (e.g. "Camera 1", "Lens 3") + the fleet asset's HubSpot ID
// so the UI can render slot-aware rows and writeback knows which association typeId to re-point.
// Returns map: kitId → [{ id, fleetAssetHsId, serial, category, model, associationLabel }]
async function fetchComponentsForKits(token, kitTypeId, componentTypeId, kitIds) {
  if (!kitIds.length || !componentTypeId) return {};
  // kitId → [{ assetId, label }] — preserves the labeled association (the unlabeled typeId 35 is ignored here)
  const assocsByKit = {};
  const BATCH = 100;

  // Step 1: batch-read kit→component associations (parallel). Each result entry carries the asset id plus
  // associationTypes — an array of typeId+label pairs. We pick the labeled one (skip typeId 35 / null label).
  const assocBatches = [];
  for (let i = 0; i < kitIds.length; i += BATCH) assocBatches.push(kitIds.slice(i, i + BATCH));
  let firstBatchLogged = false;
  await Promise.all(assocBatches.map(async (batch) => {
    try {
      const res = await fetchWithTimeout(`https://api.hubapi.com/crm/v4/associations/${kitTypeId}/${componentTypeId}/batch/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: batch.map(id => ({ id })) }),
      });
      const rawText = await res.text();
      if (!firstBatchLogged) {
        firstBatchLogged = true;
        console.log(`[stationKits] assoc batch status=${res.status}, sample response:`, rawText.slice(0, 400));
      }
      if (!res.ok) return;
      const data = JSON.parse(rawText);
      for (const result of (data.results || [])) {
        const kitId = String(result.from.id);
        const list = [];
        for (const t of (result.to || [])) {
          // Find the labeled association (HubSpot can include the unlabeled default typeId 35 alongside).
          const labeled = (t.associationTypes || []).find(at => at && at.label);
          list.push({
            assetId: String(t.toObjectId),
            label: labeled ? labeled.label : null,
          });
        }
        if (list.length) assocsByKit[kitId] = list;
      }
    } catch (e) {
      console.warn("[stationKits] assoc batch failed:", e.message);
    }
  }));

  // Step 2: batch-read component properties (parallel)
  const allCompIds = [...new Set(Object.values(assocsByKit).flatMap(arr => arr.map(a => a.assetId)))];
  const compProps = {};
  const compBatches = [];
  for (let i = 0; i < allCompIds.length; i += BATCH) compBatches.push(allCompIds.slice(i, i + BATCH));
  await Promise.all(compBatches.map(async (batch) => {
    try {
      const res = await fetchWithTimeout(`https://api.hubapi.com/crm/v3/objects/${componentTypeId}/batch/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: batch.map(id => ({ id })), properties: ["asset_sn", "name", "category_master", "category", "model_number", "model", "product_sn_service_tag", "mac_address__c"] }),
      });
      if (!res.ok) return;
      const data = await res.json();
      for (const obj of (data.results || [])) compProps[obj.id] = obj.properties || {};
    } catch (e) {
      console.warn("[stationKits] component batch read failed:", e.message);
    }
  }));

  // Step 3: build final map kitId → components array
  const result = {};
  for (const [kitId, assocs] of Object.entries(assocsByKit)) {
    result[kitId] = assocs.map(({ assetId, label }) => {
      const p = compProps[assetId] || {};
      return {
        id: `hs_comp_${assetId}`,
        fleetAssetHsId: assetId,
        associationLabel: label, // exact HubSpot label string, e.g. "Camera 1" — null if unlabeled
        serial: p.asset_sn || p.name || assetId,
        category: p.category_master || p.category || "",
        model: p.model_number || p.model || "",
        // v4.5.2: extra computer-specific props used by pd_station_kits row builder
        productServiceTag: p.product_sn_service_tag || "",
        macAddress: p.mac_address__c || "",
      };
    }).filter(c => c.serial);
  }
  return result;
}

// Build _hardwareTracking array for a project from its Station Kits.
// Preserves existing manually-added items (source !== "hubspot").
// v4.5.0: now carries kit HsId, fleet asset HsId, association label, and full kit-level fields per row
// so the UI can render slot-aware labels and writeback CFs have the IDs they need.
function buildHardwareFromKits(projectKitIds, kitProps, componentsByKit, existingHW) {
  const manualItems = (existingHW || []).filter(h => h.source !== "hubspot");
  const hsItems = [];
  for (const kitId of (projectKitIds || [])) {
    const props = kitProps[kitId] || {};
    const kitSN = props.station_kit_sn || props.name || kitId;
    const components = componentsByKit[kitId] || [];
    for (const comp of components) {
      hsItems.push({
        id: comp.id,
        type: normalizeCategory(comp.category),
        serial: comp.serial,
        model: comp.model || "",
        kitSN,
        source: "hubspot",
        // v4.5.0 writeback enablers
        _kitHubspotId: String(kitId),
        _fleetAssetHubspotId: comp.fleetAssetHsId || null,
        _associationLabel: comp.associationLabel || null, // e.g. "Camera 1", "Lens 2"
        // Kit-level fields (duplicated across rows of the same kit so each row carries enough to writeback)
        kitName: props.name || "",
        computerSN: props.computer_sn || "",
        kitStatus: props.status || "",
        stationType: props.station_type || "",
      });
    }
  }
  return [...hsItems, ...manualItems];
}

// v4.5.2: Build pd_station_kits rows (row-per-kit) from HubSpot kit + fleet asset data.
// Returns { kitHubspotId: rowFields } so the merge in runSync can match by _kitHubspotId
// and preserve user-typed manual fields on existing rows. Only writes the HubSpot-derived
// keys — the merge step in runSync is what guarantees other fields stay intact.
function buildStationKitsRowsFromKits(projectKitIds, kitProps, componentsByKit) {
  const rows = {};
  for (const kitId of projectKitIds || []) {
    const props = kitProps[kitId] || {};
    const components = componentsByKit[kitId] || [];
    const byLabel = {};
    for (const c of components) {
      if (c.associationLabel) byLabel[c.associationLabel] = c;
    }
    const cameraLabels = ["Camera 1", "camera 2", "camera 3", "camera 4", "Camera 5"];
    const lensLabels   = ["Lens 1", "Lens 2", "Lens 3", "Lens 4", "Lens 5"];
    const cameraCount = cameraLabels.filter(l => byLabel[l]).length;
    rows[String(kitId)] = {
      _kitHubspotId:        String(kitId),
      fixture_name:         props.station_kit_sn || "",
      station_name:         props.name           || "",
      computer_sn:          byLabel["Computer"]?.serial            || "",
      computer_service_tag: byLabel["Computer"]?.productServiceTag || "",
      mac_address:          byLabel["Computer"]?.macAddress        || "",
      camera_1_sn:          byLabel["Camera 1"]?.serial            || "",
      lens_1_sn:            byLabel["Lens 1"]?.serial              || "",
      barcode_scanner_sn:   byLabel["Barcode Scanner"]?.serial     || "",
      monitor_sn:           byLabel["Monitor"]?.serial             || "",
      led_controller_sn:    byLabel["LED Light Controller"]?.serial|| "",
      cameras_present:      cameraCount > 0,
      no_cameras:           cameraCount || "",
      lenses_present:       lensLabels.some(l => byLabel[l]),
      barcode_scanner:      !!byLabel["Barcode Scanner"],
      monitor:              !!byLabel["Monitor"],
      leds:                 !!byLabel["LED Light Controller"],
    };
  }
  return rows;
}

// v4.5.3: Fetch ALL HubSpot Owners once per sync (paginated, ~100/page). Owners are users in HubSpot —
// returned as { id → { name, email } }. Used to resolve DRI Owner IDs on each Project record to person
// details for pd_team rows. Limit 50 pages safety; orgs typically have <5000 owners.
async function fetchAllOwners(token) {
  const owners = {};
  let after = null;
  for (let i = 0; i < 50; i++) {
    const url = `https://api.hubapi.com/crm/v3/owners?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    try {
      const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { console.warn("[owners] fetch page failed:", res.status); break; }
      const data = await res.json();
      for (const o of (data.results || [])) {
        const fn = o.firstName || "";
        const ln = o.lastName  || "";
        const full = `${fn} ${ln}`.trim();
        owners[String(o.id)] = {
          name:  full || o.email || String(o.id),
          email: o.email || "",
        };
      }
      after = data.paging?.next?.after;
      if (!after) break;
    } catch (e) {
      console.warn("[owners] fetch failed:", e.message);
      break;
    }
  }
  console.log(`[owners] fetched ${Object.keys(owners).length} HubSpot Owners`);
  return owners;
}

// v4.5.3: Build the 4 DRI rows for pd_team from a project's DRI Owner IDs + the global owners map.
// Always emits exactly 4 rows in fixed order. Empty role rows still appear with name/email blank
// so users see "HDE: <empty>" when a DRI isn't assigned in HubSpot.
const DRI_ROLES = [
  { key: "hde", role: "HDE (Hardware Design Engineer)" },
  { key: "sie", role: "SIE (Software Integration Engineer)" },
  { key: "sa",  role: "SA (Solutions Architect)" },
  { key: "cs",  role: "CS (Customer Success)" },
];
function buildTeamRowsFromDRIs(dri, ownersById) {
  return DRI_ROLES.map(({ key, role }) => {
    const ownerId = dri?.[key] ? String(dri[key]) : null;
    const owner   = ownerId ? ownersById[ownerId] : null;
    return {
      _driRole: key,            // hidden match key
      role,                     // visible: "HDE (Hardware Design Engineer)"
      name:  owner?.name  || "",
      email: owner?.email || "",
    };
  });
}

// v4.5.7: Fetch HubSpot Notes (engagement type 0-46) associated to projects.
// Returns { projectHsId: [{ _hubspotNoteId, body, timestamp, author, authorEmail, attachments, source, _userDeleted }, ...] }.
// Notes are timeline-style (newest first). hs_note_body is rich HTML — we strip to plain text per the
// v4.5.7 decision (clickable URLs detected client-side, images rendered via attachment chips).
async function fetchNotesForProjects(token, projectHsIds, ownersById) {
  if (!projectHsIds.length) return {};
  const BATCH = 100;
  // Step 1: Project → Note associations
  const noteIdsByProject = {}; // projectHsId → [noteId, ...]
  const assocBatches = [];
  for (let i = 0; i < projectHsIds.length; i += BATCH) assocBatches.push(projectHsIds.slice(i, i + BATCH));
  await Promise.all(assocBatches.map(async (batch) => {
    try {
      const res = await fetchWithTimeout(
        `https://api.hubapi.com/crm/v4/associations/${OBJECT_TYPE}/notes/batch/read`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ inputs: batch.map(id => ({ id: String(id) })) }),
        }
      );
      if (!res.ok) { console.warn("[notes] assoc batch error:", res.status); return; }
      const data = await res.json();
      for (const r of (data.results || [])) {
        const ids = (r.to || []).map(t => String(t.toObjectId));
        if (ids.length) noteIdsByProject[String(r.from.id)] = ids;
      }
      // numErrors expected when a project has no notes — non-fatal
    } catch (e) {
      console.warn("[notes] assoc batch failed:", e.name === "AbortError" ? "timeout (15s)" : e.message);
    }
  }));

  const allNoteIds = [...new Set(Object.values(noteIdsByProject).flat())];
  if (!allNoteIds.length) return {};
  console.log(`[notes] found ${allNoteIds.length} unique note(s) across ${Object.keys(noteIdsByProject).length} project(s)`);

  // Step 2: Batch-read note properties
  const noteProps = {}; // noteId → { hs_note_body, hs_timestamp, hubspot_owner_id, hs_attachment_ids }
  const propBatches = [];
  for (let i = 0; i < allNoteIds.length; i += BATCH) propBatches.push(allNoteIds.slice(i, i + BATCH));
  await Promise.all(propBatches.map(async (batch) => {
    try {
      const res = await fetchWithTimeout(`https://api.hubapi.com/crm/v3/objects/notes/batch/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: batch.map(id => ({ id })),
          properties: ["hs_note_body", "hs_timestamp", "hubspot_owner_id", "hs_attachment_ids", "hs_createdate"],
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      for (const obj of (data.results || [])) noteProps[obj.id] = obj.properties || {};
    } catch (e) {
      console.warn("[notes] props batch failed:", e.message);
    }
  }));

  // Step 3: Collect unique attachment IDs across all notes; batch-fetch file metadata.
  const allAttIds = [...new Set(Object.values(noteProps).flatMap(p => {
    const raw = p.hs_attachment_ids || "";
    return raw.split(",").map(s => s.trim()).filter(Boolean);
  }))];
  const attMeta = {}; // attId → { name, url, mimeType, hubspotFileId }
  if (allAttIds.length) {
    await Promise.all(allAttIds.map(async (attId) => {
      try {
        const res = await fetchWithTimeout(`https://api.hubapi.com/files/v3/files/${attId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const f = await res.json();
        attMeta[attId] = {
          hubspotFileId: String(f.id),
          name: f.name || `attachment-${attId}`,
          url: f.url || null,
          mimeType: f.type || (f.extension ? `application/${f.extension}` : "application/octet-stream"),
        };
      } catch (_) { /* skip on error */ }
    }));
  }

  // Strip HTML to plain text. Keeps line breaks from <br> and </p>; removes everything else.
  const stripHtml = (html) => {
    if (!html) return "";
    return String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };

  // Step 4: Build per-project note items, newest first
  const byProject = {};
  for (const [projectHsId, ids] of Object.entries(noteIdsByProject)) {
    const items = [];
    for (const noteId of ids) {
      const p = noteProps[noteId];
      if (!p) continue;
      const ownerId = p.hubspot_owner_id ? String(p.hubspot_owner_id) : null;
      const owner = ownerId ? ownersById[ownerId] : null;
      const attIds = (p.hs_attachment_ids || "").split(",").map(s => s.trim()).filter(Boolean);
      const attachments = attIds.map(id => attMeta[id]).filter(Boolean);
      items.push({
        _hubspotNoteId: String(noteId),
        body: stripHtml(p.hs_note_body || ""),
        timestamp: p.hs_timestamp || p.hs_createdate || null,
        author: owner?.name || "HubSpot user",
        authorEmail: owner?.email || "",
        attachments,
        source: "hubspot",
      });
    }
    // Sort newest first by timestamp
    items.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
    if (items.length) byProject[projectHsId] = items;
  }
  return byProject;
}

// Traverse Kit→Shipment associations to find INxxx numbers per project.
// HubSpot has no direct Project→Shipment association; shipments are linked to Station Kits.
// kitsByProject: { projectHsId: [kitId, ...] } — from fetchKitsForProjects, already available.
// Returns { projectHsId: [{ id: "<hubspotShipmentObjectId>", num: "INxxx" }, ...] } for projects that have shipments.
// v4.4.0: now returns id+num pairs (was: just nums) so writeback can patch by ID without re-searching.
// All fetch calls use a 15s AbortController timeout to prevent silent hangs from blocking the sync.
async function fetchShipmentsViaKits(token, kitsByProject) {
  const allKitIds = [...new Set(Object.values(kitsByProject).flat())];
  if (!allKitIds.length) return {};
  const BATCH = 100;

  // Step 1: Kit → Shipment associations (parallel)
  const kitToShipmentIds = {}; // kitId → [shipmentObjectId, ...]
  const kitShipBatches = [];
  for (let i = 0; i < allKitIds.length; i += BATCH) kitShipBatches.push(allKitIds.slice(i, i + BATCH));
  await Promise.all(kitShipBatches.map(async (batch) => {
    try {
      const res = await fetchWithTimeout(
        `https://api.hubapi.com/crm/v4/associations/${STATION_KIT_TYPE_ID}/${SHIPMENT_OBJECT_TYPE}/batch/read`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ inputs: batch.map(id => ({ id: String(id) })) }),
        }
      );
      if (!res.ok) { console.warn("[shipments] kit→shipment assoc batch error:", res.status); return; }
      const data = await res.json();
      for (const result of (data.results || [])) {
        const ids = (result.to || []).map(t => String(t.toObjectId));
        if (ids.length) kitToShipmentIds[String(result.from.id)] = ids;
      }
    } catch (e) {
      console.warn("[shipments] kit→shipment assoc batch failed:", e.name === "AbortError" ? "timeout (15s)" : e.message);
    }
  }));

  const allShipmentIds = [...new Set(Object.values(kitToShipmentIds).flat())];
  if (!allShipmentIds.length) return {};
  console.log(`[shipments] found ${allShipmentIds.length} unique shipment IDs across all kits`);

  // Step 2: Fetch shipment_tracking_number (INxxx) for each shipment (parallel)
  const shipmentNums = {}; // shipmentObjectId → "INxxx"
  const shipPropBatches = [];
  for (let i = 0; i < allShipmentIds.length; i += BATCH) shipPropBatches.push(allShipmentIds.slice(i, i + BATCH));
  await Promise.all(shipPropBatches.map(async (batch) => {
    try {
      const res = await fetchWithTimeout(`https://api.hubapi.com/crm/v3/objects/${SHIPMENT_OBJECT_TYPE}/batch/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: batch.map(id => ({ id })), properties: ["shipment_tracking_number"] }),
      });
      if (!res.ok) return;
      const data = await res.json();
      for (const obj of (data.results || [])) {
        const num = obj.properties?.shipment_tracking_number;
        if (num) shipmentNums[obj.id] = num;
      }
    } catch (e) {
      console.warn("[shipments] shipment props batch failed:", e.name === "AbortError" ? "timeout (15s)" : e.message);
    }
  }));

  // Step 3: Map project → unique { id, num } pairs via kit intermediaries
  // (v4.4.0: keep both the HubSpot object ID and the INxxx — needed for writeback patches by ID)
  const byProject = {};
  for (const [projectHsId, kitIds] of Object.entries(kitsByProject)) {
    const seen = new Set();
    const pairs = [];
    for (const kid of kitIds) {
      for (const sid of (kitToShipmentIds[kid] || [])) {
        const num = shipmentNums[sid];
        if (!num || seen.has(num)) continue;
        seen.add(num);
        pairs.push({ id: String(sid), num });
      }
    }
    if (pairs.length) byProject[projectHsId] = pairs;
  }
  return byProject;
}

// v4.4.1: some shipments are associated directly to a Project (typeId 129), not via a Station Kit.
// Mirrors fetchShipmentsViaKits's return shape so the sync can union both paths.
async function fetchShipmentsDirect(token, projectHsIds) {
  if (!projectHsIds.length) return {};
  const BATCH = 100;

  const projectToShipmentIds = {};
  const assocBatches = [];
  for (let i = 0; i < projectHsIds.length; i += BATCH) assocBatches.push(projectHsIds.slice(i, i + BATCH));
  await Promise.all(assocBatches.map(async (batch) => {
    try {
      const res = await fetchWithTimeout(
        `https://api.hubapi.com/crm/v4/associations/${OBJECT_TYPE}/${SHIPMENT_OBJECT_TYPE}/batch/read`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ inputs: batch.map(id => ({ id: String(id) })) }),
        }
      );
      if (!res.ok) { console.warn("[shipments-direct] assoc batch error:", res.status); return; }
      const data = await res.json();
      for (const result of (data.results || [])) {
        const ids = (result.to || []).map(t => String(t.toObjectId));
        if (ids.length) projectToShipmentIds[String(result.from.id)] = ids;
      }
    } catch (e) {
      console.warn("[shipments-direct] assoc batch failed:", e.name === "AbortError" ? "timeout (15s)" : e.message);
    }
  }));

  const allShipmentIds = [...new Set(Object.values(projectToShipmentIds).flat())];
  if (!allShipmentIds.length) return {};
  console.log(`[shipments-direct] found ${allShipmentIds.length} directly-associated shipment(s) across ${Object.keys(projectToShipmentIds).length} project(s)`);

  const shipmentNums = {};
  const propBatches = [];
  for (let i = 0; i < allShipmentIds.length; i += BATCH) propBatches.push(allShipmentIds.slice(i, i + BATCH));
  await Promise.all(propBatches.map(async (batch) => {
    try {
      const res = await fetchWithTimeout(`https://api.hubapi.com/crm/v3/objects/${SHIPMENT_OBJECT_TYPE}/batch/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: batch.map(id => ({ id })), properties: ["shipment_tracking_number"] }),
      });
      if (!res.ok) return;
      const data = await res.json();
      for (const obj of (data.results || [])) {
        const num = obj.properties?.shipment_tracking_number;
        if (num) shipmentNums[obj.id] = num;
      }
    } catch (e) {
      console.warn("[shipments-direct] props batch failed:", e.name === "AbortError" ? "timeout (15s)" : e.message);
    }
  }));

  const byProject = {};
  for (const [projectHsId, shipmentIds] of Object.entries(projectToShipmentIds)) {
    const pairs = [];
    for (const sid of shipmentIds) {
      const num = shipmentNums[sid];
      if (!num) continue;
      pairs.push({ id: String(sid), num });
    }
    if (pairs.length) byProject[projectHsId] = pairs;
  }
  return byProject;
}

/* v4.0.3: Firebase Realtime DB rejects `undefined` in .set() values — recursively swap to null. */
function sanitizeForFirebase(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeForFirebase);
  const out = {};
  for (const k of Object.keys(value)) out[k] = sanitizeForFirebase(value[k]);
  return out;
}

/* ═══ SYNC LOG — v4.0.1: append-only history of all syncs ═══ */
/* Use push() — Firebase auto-IDs are path-safe and sortable; ISO timestamps contain "." which is forbidden in DB paths. */
async function writeSyncLogEntry(entry) {
  await db.ref("hubspotSync/log").push(entry);
}

/* ═══ CORE SYNC LOGIC ═══ */
// syncCtx: { type: "manual" | "scheduled", actorUid?: string, actorEmail?: string }
async function runSync(token, commit, syncCtx) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const ctx = syncCtx || { type: "scheduled" };
  await db.ref("hubspotSync/status").set({ state: "running", startedAt, type: ctx.type });

  try {
    const objects = await fetchAllHubspotObjects(token);
    const incoming = objects.map(mapHubspotToProject);

    // Load existing projects to detect new vs updated. DB may have legacy array shape or v3.1.0 object shape.
    const snap = await db.ref("appState/projects").once("value");
    const existing = snap.val() || {};
    const existingArr = Array.isArray(existing) ? existing : Object.values(existing);
    const existingByHsId = {};
    existingArr.forEach(p => { if (p && p.hubspotId) existingByHsId[p.hubspotId] = p; });

    const newProjects = incoming.filter(p => !existingByHsId[p.hubspotId]);
    const updatedProjects = incoming.filter(p => !!existingByHsId[p.hubspotId]);

    const summary = {
      total: incoming.length,
      newCount: newProjects.length,
      updatedCount: updatedProjects.length,
      syncedAt: startedAt,
    };

    if (!commit) {
      // Preview mode — write to hubspotPreview only
      const previewMap = {};
      incoming.forEach(p => { previewMap[p.hubspotId] = p; });
      await db.ref("hubspotPreview").set({ projects: previewMap, summary });
      await db.ref("hubspotSync/status").set({ state: "preview_ready", ...summary });
      await writeSyncLogEntry({
        startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs,
        type: ctx.type, mode: "preview",
        actorUid: ctx.actorUid || "system", actorEmail: ctx.actorEmail || null,
        state: "preview_ready", total: incoming.length, newCount: newProjects.length, updatedCount: updatedProjects.length, error: null,
      });
      return { success: true, preview: true, ...summary };
    }

    // Apply mode — merge into appState/projects and create checklist templates
    const merged = [...existingArr];

    // Update existing
    for (const incoming_p of updatedProjects) {
      const idx = merged.findIndex(p => p.hubspotId === incoming_p.hubspotId);
      if (idx >= 0) {
        // Preserve manually-set fields, overwrite HubSpot fields
        merged[idx] = {
          ...merged[idx],
          name: incoming_p.name,
          customer: incoming_p.customer,
          codename: incoming_p.codename,
          appProjectId: incoming_p.appProjectId,
          stations: incoming_p.stations || merged[idx].stations,
          isSI: incoming_p.isSI,
          // v4.0.1: only overwrite siStage when the incoming project is from the SI Partner pipeline.
          // Hardware Deployment [SI] projects shouldn't have their siStage clobbered to null.
          // v4.0.3: coerce undefined → null. Firebase Realtime DB rejects undefined values in .set() calls.
          siStage: incoming_p.siStage != null ? incoming_p.siStage : (merged[idx].siStage ?? null),
          hubspotPipelineId: incoming_p.hubspotPipelineId,
          hubspotPipelineLabel: incoming_p.hubspotPipelineLabel,
          hubspotStageId: incoming_p.hubspotStageId,
          hubspotStageLabel: incoming_p.hubspotStageLabel,
          hubspotStageClosed: incoming_p.hubspotStageClosed,
          hubspotStageOrder: incoming_p.hubspotStageOrder,
          status: incoming_p.status,
          hardware: incoming_p.hardware,
          syncedAt: incoming_p.syncedAt,
        };
      }
    }

    // Add new projects
    for (const np of newProjects) {
      merged.push(np);
    }

    // Write as object keyed by project ID (v3.1.0 schema — enables per-project DB rules)
    const mergedObj = {};
    merged.forEach(p => { if (p && p.id) mergedObj[p.id] = p; });
    await db.ref("appState/projects").set(sanitizeForFirebase(mergedObj));
    // Ensure schema version is set so the app-side migration can skip
    await db.ref("_schemaVersion").set("v3.2.0");

    // Template injection for new projects is handled client-side by getProjectDetails() in App.jsx
    // and server-side by the backfillChecklists CF. Doing it here required reading/writing the full
    // 20MB appState/docData on every sync run, which consistently caused 540s timeouts.

    let kitsByProject = {}; // projectHsId → [kitId, ...]; populated by station kits, consumed by shipments

    // Station Kits sync — batch-read project→kit associations via v4 API, populate _hardwareTracking.
    // Wrapped in try/catch: station kit failures must not abort the main project sync.
    // v4.6.0: closed projects are excluded from station kit re-sync — their hardware data freezes at the last sync before closure
    // (saves HubSpot API quota + RTDB writes; pd_station_kits rows for closed projects remain readable, just not re-synced).
    try {
      const stationTypes = await discoverStationObjectTypes(token);
      if (stationTypes) {
        const { kitTypeId, componentTypeId } = stationTypes;
        const activeIncoming = incoming.filter(p => p.status === "active");
        const projectHsIds = activeIncoming.map(p => p.hubspotId).filter(Boolean);
        console.log(`[stationKits] filtering to active projects: ${activeIncoming.length} of ${incoming.length} (skipping ${incoming.length - activeIncoming.length} closed)`);
        const { byProject, kitProps } = await fetchKitsForProjects(token, projectHsIds, kitTypeId);
        kitsByProject = byProject; // save for shipments traversal
        const allKitIds = [...new Set(Object.values(byProject).flat())];
        console.log(`[stationKits] projects with kits: ${Object.keys(byProject).length}, total unique kit IDs: ${allKitIds.length}`);
        const componentsByKit = await fetchComponentsForKits(token, kitTypeId, componentTypeId, allKitIds);
        const totalComponents = Object.values(componentsByKit).reduce((s, a) => s + a.length, 0);
        console.log(`[stationKits] total components found: ${totalComponents}`, totalComponents > 0 ? "sample:" : "(none)", totalComponents > 0 ? JSON.stringify(Object.values(componentsByKit)[0]?.[0]) : "");

        // Read only _hardwareTracking for projects that have kits (parallel targeted reads)
        const existingHWByPid = {};
        await Promise.all(Object.keys(byProject).map(async (projectHsId) => {
          const pid = `hs_${projectHsId}`;
          const snap = await db.ref(`appState/docData/${pid}/_hardwareTracking`).once("value");
          existingHWByPid[pid] = snap.val() || null;
        }));
        const hwUpdates = {};
        for (const [projectHsId, kitIds] of Object.entries(byProject)) {
          const pid = `hs_${projectHsId}`;
          const hwArray = buildHardwareFromKits(kitIds, kitProps, componentsByKit, existingHWByPid[pid]);
          hwUpdates[`appState/docData/${pid}/_hardwareTracking`] = sanitizeForFirebase(hwArray);
        }
        if (Object.keys(hwUpdates).length > 0) {
          await db.ref().update(hwUpdates);
          console.log(`[stationKits] synced hardware for ${Object.keys(hwUpdates).length} projects`);
        }

        // v4.5.2: also populate pd_station_kits rows inside projectDetails for each project with kits.
        // Match rows by _kitHubspotId; merge only HubSpot-derived columns; preserve all manual fields.
        // Inbound-only — writeback from pd_station_kits cells is deferred (HardwareTrackingSection handles writeback).
        const HUBSPOT_DRIVEN_SK_KEYS = [
          "fixture_name", "station_name", "computer_sn", "computer_service_tag", "mac_address",
          "camera_1_sn", "lens_1_sn", "barcode_scanner_sn", "monitor_sn", "led_controller_sn",
          "cameras_present", "no_cameras", "lenses_present", "barcode_scanner", "monitor", "leds",
        ];
        const newRowId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const stationKitsUpdates = {};
        for (const [projectHsId, kitIds] of Object.entries(byProject)) {
          const pid = `hs_${projectHsId}`;
          const newRowsByKitId = buildStationKitsRowsFromKits(kitIds, kitProps, componentsByKit);
          if (Object.keys(newRowsByKitId).length === 0) continue;

          const pdSnap = await db.ref(`appState/docData/${pid}/projectDetails`).once("value");
          const pdRaw = pdSnap.val();
          const pdArr = Array.isArray(pdRaw) ? pdRaw : (pdRaw && typeof pdRaw === "object" ? Object.values(pdRaw) : []);
          const skCatIdx = pdArr.findIndex(c => c?.id === "pd_station_kits");
          if (skCatIdx === -1) continue; // skip projects whose schema doesn't have the table yet

          const skCat = pdArr[skCatIdx];
          const existingRows = Array.isArray(skCat.rows) ? skCat.rows : [];
          const matchedKitIds = new Set();
          const updatedRows = existingRows.map(r => {
            if (!r?._kitHubspotId) return r;
            const nr = newRowsByKitId[r._kitHubspotId];
            if (!nr) return r;
            matchedKitIds.add(r._kitHubspotId);
            const merged = { ...r };
            for (const k of HUBSPOT_DRIVEN_SK_KEYS) merged[k] = nr[k];
            return merged;
          });
          // Append rows for kits that don't have a corresponding row yet
          let added = 0;
          for (const [kitHsId, nr] of Object.entries(newRowsByKitId)) {
            if (matchedKitIds.has(kitHsId)) continue;
            updatedRows.push({ id: newRowId(), ...nr });
            added++;
          }
          if (added > 0 || matchedKitIds.size > 0) {
            const newPd = pdArr.map((c, i) => i === skCatIdx ? { ...c, rows: updatedRows } : c);
            stationKitsUpdates[`appState/docData/${pid}/projectDetails`] = sanitizeForFirebase(newPd);
            console.log(`[stationKits] ${pid}: pd_station_kits — updated ${matchedKitIds.size} existing row(s), added ${added} new`);
          }
        }
        if (Object.keys(stationKitsUpdates).length > 0) {
          await db.ref().update(stationKitsUpdates);
          console.log(`[stationKits] synced pd_station_kits for ${Object.keys(stationKitsUpdates).length} projects`);
        }
      } else {
        console.log("[stationKits] object types not found in schema — skipping hardware sync");
      }
    } catch (stErr) {
      console.warn("[stationKits] station kit sync failed (non-fatal):", stErr.message);
    }

    // v4.5.3: DRI sync — populate the 4 fixed pd_team rows (HDE, SIE, SA, CS) from HubSpot Owners.
    // Each DRI Owner ID on a Project record resolves to a HubSpot Owner (firstName, lastName, email).
    // Match existing rows by hidden _driRole; preserve manual rows (no _driRole) untouched.
    try {
      const dris = incoming
        .filter(p => p.hubspotId && p.dri && (p.dri.hde || p.dri.sie || p.dri.sa || p.dri.cs))
        .map(p => ({ projectHsId: p.hubspotId, dri: p.dri }));
      if (dris.length > 0) {
        const ownersById = await fetchAllOwners(token);
        const HUBSPOT_DRIVEN_TEAM_KEYS = ["role", "name", "email"];
        const teamUpdates = {};
        for (const { projectHsId, dri } of dris) {
          const pid = `hs_${projectHsId}`;
          const newDriRows = buildTeamRowsFromDRIs(dri, ownersById);

          const pdSnap = await db.ref(`appState/docData/${pid}/projectDetails`).once("value");
          const pdRaw = pdSnap.val();
          const pdArr = Array.isArray(pdRaw) ? pdRaw : (pdRaw && typeof pdRaw === "object" ? Object.values(pdRaw) : []);
          const teamCatIdx = pdArr.findIndex(c => c?.id === "pd_team");
          if (teamCatIdx === -1) continue;

          const teamCat = pdArr[teamCatIdx];
          const existingRows = Array.isArray(teamCat.rows) ? teamCat.rows : [];
          const matchedRoles = new Set();
          const updatedRows = existingRows.map(r => {
            if (!r?._driRole) return r; // preserve manual rows
            const nr = newDriRows.find(x => x._driRole === r._driRole);
            if (!nr) return r;
            matchedRoles.add(r._driRole);
            const merged = { ...r };
            for (const k of HUBSPOT_DRIVEN_TEAM_KEYS) merged[k] = nr[k];
            return merged;
          });
          // Append any DRI rows that don't exist yet
          const newRowId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          let added = 0;
          for (const nr of newDriRows) {
            if (matchedRoles.has(nr._driRole)) continue;
            updatedRows.push({ id: newRowId(), ...nr });
            added++;
          }
          if (added > 0 || matchedRoles.size > 0) {
            const newPd = pdArr.map((c, i) => i === teamCatIdx ? { ...c, rows: updatedRows } : c);
            teamUpdates[`appState/docData/${pid}/projectDetails`] = sanitizeForFirebase(newPd);
            console.log(`[dri] ${pid}: pd_team — updated ${matchedRoles.size} DRI row(s), added ${added} new`);
          }
        }
        if (Object.keys(teamUpdates).length > 0) {
          await db.ref().update(teamUpdates);
          console.log(`[dri] synced pd_team rows for ${Object.keys(teamUpdates).length} projects`);
        }
      } else {
        console.log("[dri] no projects have DRI fields set — skipping pd_team sync");
      }
    } catch (driErr) {
      console.warn("[dri] DRI sync failed (non-fatal):", driErr.message);
    }

    // v4.5.5: CAD release docs sync — populate the pd_cad folder ("CAD & Drawings") from HubSpot Project properties.
    // HDEs use a HubSpot workflow that writes URLs to 4 properties (cad_folder, station_overview_hde,
    // station_bom_details_hde, machining_notes_hde) + emails them. We mirror those URLs into the pd_cad folder
    // so the team can find them under Project Details → CAD & Drawings without context-switching to email.
    // Allow-list merge: match by hidden _hubspotSource key; preserve user-added items + soft-deletes.
    try {
      const projectsWithCadDocs = incoming.filter(p =>
        p.hubspotId && p.cadDocs && Object.values(p.cadDocs).some(Boolean));
      if (projectsWithCadDocs.length > 0) {
        const newRowId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const cadUpdates = {};
        for (const p of projectsWithCadDocs) {
          const pid = `hs_${p.hubspotId}`;
          const pdSnap = await db.ref(`appState/docData/${pid}/projectDetails`).once("value");
          const pdRaw = pdSnap.val();
          const pdArr = Array.isArray(pdRaw) ? pdRaw : (pdRaw && typeof pdRaw === "object" ? Object.values(pdRaw) : []);
          // v4.5.5: auto-create pd_cad if the project's projectDetails predates the standard template.
          // Legacy projects (e.g. created before pd_cad was added) skip this category — we now create it
          // on-demand the first time a CAD URL is synced, so HDE releases are never silently dropped.
          let cadCatIdx = pdArr.findIndex(c => c?.id === "pd_cad");
          if (cadCatIdx === -1) {
            pdArr.push({ id: "pd_cad", name: "CAD & Drawings", accessLevel: "open", items: [] });
            cadCatIdx = pdArr.length - 1;
            console.log(`[cadDocs] ${pid}: auto-created missing pd_cad folder`);
          }

          const cadCat = pdArr[cadCatIdx];
          const existingItems = Array.isArray(cadCat.items) ? cadCat.items : [];

          let mutated = false;
          const matchedKeys = new Set();
          const updatedItems = existingItems.map(it => {
            if (!it?._hubspotSource) return it; // preserve user-added + system items
            const def = CAD_DOC_DEFS.find(d => d.key === it._hubspotSource);
            if (!def) return it; // unknown source key — leave alone
            matchedKeys.add(def.key);
            if (it._userDeleted) return it; // respect user soft-delete (won't resurrect on sync)
            const newUrl = p.cadDocs[def.key];
            if (!newUrl || newUrl === it.url) return it; // no change
            mutated = true;
            return { ...it, url: newUrl, name: def.label, updatedAt: new Date().toISOString() };
          });

          // Append new HubSpot-sourced items for keys not yet present in the folder
          let added = 0;
          for (const def of CAD_DOC_DEFS) {
            if (matchedKeys.has(def.key)) continue;
            const url = p.cadDocs[def.key];
            if (!url) continue;
            updatedItems.push({
              id: newRowId(),
              name: def.label,
              url,
              type: def.type,
              lang: "en",
              source: "hubspot",
              _hubspotSource: def.key,
              addedBy: "HubSpot CAD Release sync",
              addedAt: new Date().toISOString(),
            });
            added++;
            mutated = true;
          }

          if (mutated) {
            const newPd = pdArr.map((c, i) => i === cadCatIdx ? { ...c, items: updatedItems } : c);
            cadUpdates[`appState/docData/${pid}/projectDetails`] = sanitizeForFirebase(newPd);
            console.log(`[cadDocs] ${pid}: pd_cad — updated ${matchedKeys.size} existing item(s), added ${added} new`);
          }
        }
        if (Object.keys(cadUpdates).length > 0) {
          await db.ref().update(cadUpdates);
          console.log(`[cadDocs] synced pd_cad for ${Object.keys(cadUpdates).length} projects`);
        }
      } else {
        console.log("[cadDocs] no projects have CAD URLs set — skipping");
      }
    } catch (cadErr) {
      console.warn("[cadDocs] CAD sync failed (non-fatal):", cadErr.message);
    }

    // v4.5.7: Meeting Notes sync — pull HubSpot Notes (engagement type 0-46) associated to each project
    // and merge into pd_meeting_notes folder. Allow-list pattern: match by hidden _hubspotNoteId; preserve
    // manual notes (no _hubspotNoteId); respect user soft-delete; auto-create pd_meeting_notes if missing.
    try {
      const projectHsIdsForNotes = incoming.map(p => p.hubspotId).filter(Boolean);
      if (projectHsIdsForNotes.length > 0) {
        // Fetch owners again (DRI block fetches its own copy in a different scope; cheap enough to repeat)
        const notesOwnersById = await fetchAllOwners(token);
        const notesByProject = await fetchNotesForProjects(token, projectHsIdsForNotes, notesOwnersById);
        const HUBSPOT_DRIVEN_NOTE_KEYS = ["body", "timestamp", "author", "authorEmail", "attachments"];
        const newRowId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const notesUpdates = {};

        for (const [projectHsId, newNotes] of Object.entries(notesByProject)) {
          if (!newNotes.length) continue;
          const pid = `hs_${projectHsId}`;
          const pdSnap = await db.ref(`appState/docData/${pid}/projectDetails`).once("value");
          const pdRaw = pdSnap.val();
          const pdArr = Array.isArray(pdRaw) ? pdRaw : (pdRaw && typeof pdRaw === "object" ? Object.values(pdRaw) : []);

          // Auto-create pd_meeting_notes if missing (legacy projects)
          let mnIdx = pdArr.findIndex(c => c?.id === "pd_meeting_notes");
          if (mnIdx === -1) {
            pdArr.push({ id: "pd_meeting_notes", name: "Meeting Notes", type: "notes", accessLevel: "open", items: [] });
            mnIdx = pdArr.length - 1;
            console.log(`[notes] ${pid}: auto-created missing pd_meeting_notes folder`);
          }

          const mnCat = pdArr[mnIdx];
          const existingItems = Array.isArray(mnCat.items) ? mnCat.items : [];

          let mutated = false;
          const matchedIds = new Set();
          const updatedItems = existingItems.map(it => {
            if (!it?._hubspotNoteId) return it; // preserve manual + non-hubspot items
            matchedIds.add(it._hubspotNoteId);
            if (it._userDeleted) return it; // respect soft-delete
            const nn = newNotes.find(n => n._hubspotNoteId === it._hubspotNoteId);
            if (!nn) return it; // note no longer in HubSpot — preserve last-known
            const merged = { ...it };
            for (const k of HUBSPOT_DRIVEN_NOTE_KEYS) merged[k] = nn[k];
            // Only mark mutated if a key actually changed
            if (HUBSPOT_DRIVEN_NOTE_KEYS.some(k => JSON.stringify(it[k]) !== JSON.stringify(nn[k]))) mutated = true;
            return merged;
          });

          let added = 0;
          for (const nn of newNotes) {
            if (matchedIds.has(nn._hubspotNoteId)) continue;
            updatedItems.push({ id: newRowId(), ...nn });
            added++;
            mutated = true;
          }

          if (mutated) {
            // Re-sort newest-first by timestamp
            updatedItems.sort((a, b) => String(b?.timestamp || "").localeCompare(String(a?.timestamp || "")));
            const newPd = pdArr.map((c, i) => i === mnIdx ? { ...c, items: updatedItems } : c);
            notesUpdates[`appState/docData/${pid}/projectDetails`] = sanitizeForFirebase(newPd);
            console.log(`[notes] ${pid}: pd_meeting_notes — matched ${matchedIds.size} existing, added ${added} new`);
          }
        }
        if (Object.keys(notesUpdates).length > 0) {
          await db.ref().update(notesUpdates);
          console.log(`[notes] synced pd_meeting_notes for ${Object.keys(notesUpdates).length} projects`);
        }
      } else {
        console.log("[notes] no projects to scan — skipping");
      }
    } catch (notesErr) {
      console.warn("[notes] Notes sync failed (non-fatal):", notesErr.message);
    }

    // Shipment Details sync — traverse Kit→Shipment associations (the actual HubSpot link) to find INxxx numbers.
    // Shipments are linked to Station Kits, not directly to Projects — so we reuse kitsByProject from above.
    // Only adds item_num; never overwrites existing rows; leaves all other columns blank for manual fill-in.
    try {
      // v4.4.1: shipments live on two association paths — via Station Kit, AND directly on the Project.
      // We traverse both in parallel and union per project (dedup by INxxx).
      const projectHsIdsForShipments = incoming.map(p => p.hubspotId).filter(Boolean);
      const [viaKits, direct] = await Promise.all([
        fetchShipmentsViaKits(token, kitsByProject),
        fetchShipmentsDirect(token, projectHsIdsForShipments),
      ]);
      const shipmentsByProject = {};
      for (const pid of new Set([...Object.keys(viaKits), ...Object.keys(direct)])) {
        const seen = new Set();
        const merged = [];
        for (const pair of [...(viaKits[pid] || []), ...(direct[pid] || [])]) {
          if (seen.has(pair.num)) continue;
          seen.add(pair.num);
          merged.push(pair);
        }
        shipmentsByProject[pid] = merged;
      }
      const projectsWithShipments = Object.keys(shipmentsByProject);
      console.log(`[shipments] projects with shipments: ${projectsWithShipments.length}`);

      if (projectsWithShipments.length > 0) {
        // Read only projectDetails for projects with shipments (parallel targeted reads)
        const pdByPid = {};
        await Promise.all(projectsWithShipments.map(async (projectHsId) => {
          const pid = `hs_${projectHsId}`;
          const snap = await db.ref(`appState/docData/${pid}/projectDetails`).once("value");
          pdByPid[projectHsId] = snap.val() || [];
        }));
        const shipmentUpdates = {};

        for (const projectHsId of projectsWithShipments) {
          const pid = `hs_${projectHsId}`;
          const incomingPairs = shipmentsByProject[projectHsId]; // [{ id, num }, ...]
          const idByNum = new Map(incomingPairs.map(p => [p.num, p.id])); // INxxx → hubspotShipmentId
          const existingPD = pdByPid[projectHsId] || [];
          const existingArr = Array.isArray(existingPD) ? existingPD : Object.values(existingPD);
          const shipmentCat = existingArr.find(c => c && c.id === "pd_shipment_details");
          const existingRows = shipmentCat?.rows || [];
          const existingNums = new Set(existingRows.map(r => r.item_num).filter(Boolean));

          // v4.4.0: backfill hubspotShipmentId on EXISTING rows that don't have one yet (match by INxxx)
          let backfillCount = 0;
          const backfilledRows = existingRows.map(r => {
            if (r && r.item_num && !r.hubspotShipmentId && idByNum.has(r.item_num)) {
              backfillCount++;
              return { ...r, hubspotShipmentId: idByNum.get(r.item_num) };
            }
            return r;
          });

          // Brand-new rows for incoming INxxx that don't exist locally yet — include hubspotShipmentId from the start
          const newRows = incomingPairs
            .filter(p => !existingNums.has(p.num))
            .map(p => ({ item_num: p.num, hubspotShipmentId: p.id }));

          if (newRows.length > 0 || backfillCount > 0) {
            const mergedRows = [...backfilledRows, ...newRows];
            if (shipmentCat) {
              // pd_shipment_details cat exists — update its rows
              const updatedPD = existingArr.map(c => c.id === "pd_shipment_details" ? { ...c, rows: mergedRows } : c);
              shipmentUpdates[`appState/docData/${pid}/projectDetails`] = sanitizeForFirebase(updatedPD);
            } else {
              // No pd_shipment_details yet — append it with just the new rows
              const updatedPD = [...existingArr, { id: "pd_shipment_details", name: "Shipment Details", type: "table", accessLevel: "open", columns: [], rows: mergedRows }];
              shipmentUpdates[`appState/docData/${pid}/projectDetails`] = sanitizeForFirebase(updatedPD);
            }
            const msgParts = [];
            if (newRows.length) msgParts.push(`added ${newRows.length} new shipment row(s): ${newRows.map(r => r.item_num).join(", ")}`);
            if (backfillCount) msgParts.push(`backfilled hubspotShipmentId on ${backfillCount} existing row(s)`);
            console.log(`[shipments] ${pid}: ${msgParts.join(" + ")}`);
          }
        }

        if (Object.keys(shipmentUpdates).length > 0) {
          await db.ref().update(shipmentUpdates);
          console.log(`[shipments] synced shipment details for ${Object.keys(shipmentUpdates).length} project(s)`);
        }
      }
    } catch (shipErr) {
      console.warn("[shipments] shipment sync failed (non-fatal):", shipErr.message);
    }

    // Secondary ops — each wrapped so a log/status failure never masks a successful sync
    try { await db.ref("hubspotPreview").set(null); } catch (e) { console.warn("preview clear:", e.message); }
    try {
      await db.ref("hubspotSync/status").set({ state: "success", ...summary });
    } catch (e) { console.warn("status write:", e.message); }
    try {
      await writeSyncLogEntry({
        startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs,
        type: ctx.type, mode: "apply",
        actorUid: ctx.actorUid || "system", actorEmail: ctx.actorEmail || null,
        state: "success", total: incoming.length, newCount: newProjects.length, updatedCount: updatedProjects.length, error: null,
      });
    } catch (e) { console.warn("log write:", e.message); }

    return { success: true, preview: false, ...summary };
  } catch (err) {
    console.error("HubSpot sync error:", err);
    try { await db.ref("hubspotSync/status").set({ state: "error", error: err.message, startedAt }); } catch (e) { console.warn("error status write:", e.message); }
    try {
      await writeSyncLogEntry({
        startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs,
        type: (syncCtx || {}).type || "scheduled", mode: commit ? "apply" : "preview",
        actorUid: (syncCtx || {}).actorUid || "system", actorEmail: (syncCtx || {}).actorEmail || null,
        state: "error", total: 0, newCount: 0, updatedCount: 0, error: String(err.message || err).slice(0, 500),
      });
    } catch (e) { console.warn("error log write:", e.message); }
    throw err;
  }
}

/* ═══ BACKFILL CHECKLISTS — v4.0.2: standalone, no HubSpot involved ═══ */
/* Iterates all projects in the DB and applies checklist templates from functions/checklists.js */
/* (which mirror the Internal + External + SI Excel files). Preserves existing folders. */
/* Uses SI Partner pipeline membership to choose SI vs Internal+External checklist. */
exports.backfillChecklists = functions
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    const userSnap = await db.ref(`users/${context.auth.uid}`).once("value");
    const user = userSnap.val();
    if (user?.role !== "admin") throw new functions.https.HttpsError("permission-denied", "Admins only.");

    const [projSnap, docSnap] = await Promise.all([
      db.ref("appState/projects").once("value"),
      db.ref("appState/docData").once("value"),
    ]);
    const projects = projSnap.val() || {};
    const docData = docSnap.val() || {};

    const stats = { total: 0, builtFresh: 0, appendedChecklist: 0, alreadyComplete: 0, addedCommercial: 0, skipped: 0 };
    const updates = {}; // multi-path update — only touches specific paths, won't clobber other docData fields

    for (const pid of Object.keys(projects)) {
      const p = projects[pid];
      if (!p || !p.id) { stats.skipped++; continue; }
      stats.total++;

      const useSiChecklist = p.hubspotPipelineId === SI_PARTNER_PIPELINE_ID;

      const existingPd = docData[pid]?.projectDetails;
      const existingArr = Array.isArray(existingPd) ? existingPd : (existingPd && typeof existingPd === "object" ? Object.values(existingPd) : []);
      const hasChecklist = existingArr.some(c => c && c.type === "checklist");

      if (!existingPd || existingArr.length === 0) {
        updates[`appState/docData/${pid}/projectDetails`] = sanitizeForFirebase(buildProjectDetails(useSiChecklist));
        stats.builtFresh++;
      } else if (!hasChecklist) {
        const newCats = buildProjectDetails(useSiChecklist);
        const checklistCats = newCats.filter(c => c.type === "checklist");
        updates[`appState/docData/${pid}/projectDetails`] = sanitizeForFirebase([...existingArr, ...checklistCats]);
        stats.appendedChecklist++;
      } else {
        stats.alreadyComplete++;
      }

      if (!docData[pid]?.commercial) {
        updates[`appState/docData/${pid}/commercial`] = sanitizeForFirebase(buildCommercialFolders());
        stats.addedCommercial++;
      }
    }

    // v4.0.2 — batch writes in chunks to avoid huge single payload + slow client timeout.
    const allPaths = Object.keys(updates);
    const CHUNK = 100;
    for (let i = 0; i < allPaths.length; i += CHUNK) {
      const slice = allPaths.slice(i, i + CHUNK);
      const batch = {};
      for (const p of slice) batch[p] = updates[p];
      await db.ref().update(batch);
    }

    await writeAuditEntry(context.auth.uid, "backfill_checklists", null, stats);
    return stats;
  });

/* ═══ APPLY CHECKLIST TEMPLATE to existing project (v3.2.0 unified structure) ═══ */
async function applyChecklistToProject(projectId, isSI) {
  const snap = await db.ref(`appState/docData/${projectId}/projectDetails`).once("value");
  const existing = snap.val() || [];
  const existingArr = Array.isArray(existing) ? existing : Object.values(existing);

  const hasChecklist = existingArr.some(c => c.type === "checklist");
  if (hasChecklist) return { skipped: true, reason: "Checklist already exists" };

  const newCats = buildProjectDetails(isSI);
  // Preserve existing non-checklist categories, add checklists
  const checklistCats = newCats.filter(c => c.type === "checklist");
  const merged = [...existingArr, ...checklistCats];
  await db.ref(`appState/docData/${projectId}/projectDetails`).set(merged);

  // Also ensure commercial folders exist
  const commSnap = await db.ref(`appState/docData/${projectId}/commercial`).once("value");
  if (!commSnap.val()) {
    await db.ref(`appState/docData/${projectId}/commercial`).set(buildCommercialFolders());
  }
  return { success: true };
}

/* ═══ SCHEDULED SYNC — Tue & Fri 9am PT ═══ */
exports.scheduledHubspotSync = functions.runWith({ memory: "8GB", timeoutSeconds: 540 }).pubsub
  .schedule("0 9 * * 2,5")
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) { console.error("HubSpot token not configured"); return; }
    await runSync(token, true, { type: "scheduled", actorUid: "system", actorEmail: null });
  });

/* ═══ MANUAL SYNC — callable from Admin Panel ═══ */
exports.manualHubspotSync = functions.runWith({ memory: "8GB", timeoutSeconds: 540 }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");

  const userSnap = await db.ref(`users/${context.auth.uid}`).once("value");
  const user = userSnap.val();
  if (user?.role !== "admin" && !user?.superAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admins only.");
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new functions.https.HttpsError("internal", "HubSpot token not configured.");

  const commit = data?.commit === true;
  try {
    return await runSync(token, commit, {
      type: "manual",
      actorUid: context.auth.uid,
      actorEmail: (context.auth.token?.email || user?.email || null),
    });
  } catch (e) {
    if (e instanceof functions.https.HttpsError) throw e;
    throw new functions.https.HttpsError("internal", e.message || "Sync failed");
  }
});

/* ═══ APPLY CHECKLIST — callable from Admin Panel ═══ */
exports.applyChecklistTemplate = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");

  const userSnap = await db.ref(`users/${context.auth.uid}`).once("value");
  const user = userSnap.val();
  if (user?.role !== "admin" && !user?.superAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admins only.");
  }

  const { projectId, isSI } = data || {};
  if (!projectId) throw new functions.https.HttpsError("invalid-argument", "projectId required.");

  return await applyChecklistToProject(projectId, !!isSI);
});

/* ═══ AI PROJECT BOT — v3.3.0: Claude-powered Q&A per project ═══ */
exports.askProjectBot = functions.runWith({ memory: "512MB" }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");

  // Only Instrumental users can use the bot
  const userSnap = await db.ref(`users/${context.auth.uid}`).once("value");
  const user = userSnap.val();
  const email = context.auth.token?.email || "";
  if (user?.role !== "admin" && !email.endsWith("@instrumental.com")) {
    throw new functions.https.HttpsError("permission-denied", "Instrumental users only.");
  }

  const { projectId, question, action, sectionId } = data || {};
  if (!projectId) throw new functions.https.HttpsError("invalid-argument", "projectId required.");
  if (!question && !action) throw new functions.https.HttpsError("invalid-argument", "question or action required.");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new functions.https.HttpsError("internal", "Anthropic API key not configured. Add ANTHROPIC_API_KEY to functions/.env");

  // Build project context from DB
  const [projSnap, docSnap] = await Promise.all([
    db.ref(`appState/projects/${projectId}`).once("value"),
    db.ref(`appState/docData/${projectId}`).once("value"),
  ]);
  const project = projSnap.val() || {};
  const docData = docSnap.val() || {};

  // Flatten project context into a readable summary for the AI
  const contextParts = [];
  contextParts.push(`Project: ${project.name || projectId}`);
  contextParts.push(`Customer: ${project.customer || "Unknown"}`);
  contextParts.push(`Status: ${project.status || "unknown"}, Stations: ${project.stations || 0}, SI Involved: ${project.isSI ? "Yes" : "No"}`);
  if (project.hubspotPipelineLabel) contextParts.push(`Pipeline: ${project.hubspotPipelineLabel}, Stage: ${project.hubspotStageLabel || "Unknown"}`);
  if (project.hardware) contextParts.push(`Hardware: ${JSON.stringify(project.hardware)}`);

  // Include checklist data
  const pdCats = docData.projectDetails || docData.instrumental || [];
  const pdArr = Array.isArray(pdCats) ? pdCats : Object.values(pdCats);
  pdArr.forEach(cat => {
    if (cat.type === "checklist" && cat.milestones) {
      contextParts.push(`\nChecklist: ${cat.name}`);
      cat.milestones.forEach(ms => {
        const activeItems = (ms.checklist || []).filter(ck => !ck.na);
        const doneCount = activeItems.filter(ck => ck.checked).length;
        contextParts.push(`  ${ms.name}: ${doneCount}/${activeItems.length} complete`);
        activeItems.forEach(ck => {
          contextParts.push(`    ${ck.checked ? "[x]" : "[ ]"} ${ck.label}${ck.ownership ? " (Owner: " + ck.ownership + ")" : ""}${ck.projectedDate ? " Due: " + ck.projectedDate : ""}${ck.actualDate ? " Done: " + ck.actualDate : ""}`);
        });
      });
    }
    if (cat.items && cat.items.length > 0) {
      contextParts.push(`\nFolder: ${cat.name} (${cat.items.length} documents)`);
      cat.items.forEach(item => contextParts.push(`  - ${item.name}${item.url ? " [" + item.url + "]" : ""}`));
    }
  });

  // Include program details
  const progData = docData._programDetails || {};
  if (progData.tasks && progData.tasks.length > 0) {
    contextParts.push(`\nProgram Tasks & Milestones:`);
    progData.tasks.forEach(t => contextParts.push(`  ${t.type === "milestone" ? "🏁" : "📋"} ${t.name} — ${t.date || "No date"}${t.endDate ? " to " + t.endDate : ""}`));
  }

  const projectContext = contextParts.join("\n");

  // Build the prompt
  let systemPrompt = `You are an AI assistant for Instrumental's Deployment Portal. You help the Customer Experience team manage deployment projects. You have access to the following project data:\n\n${projectContext}\n\nAnswer questions accurately based on this data. If information is not available in the data, say so clearly. Be concise and actionable.`;

  let userMessage = question || "";

  // Section-filling action
  if (action === "fill_section" && sectionId) {
    systemPrompt += `\n\nThe user wants you to suggest content for a section of the project. Analyze the project data and any uploaded documents to generate appropriate entries.`;
    userMessage = `Based on the project data, suggest what should be filled in for the "${sectionId}" section. Provide specific, actionable items.`;
  }

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const answer = response.content?.[0]?.text || "No response generated.";
    return { answer, projectName: project.name };
  } catch (err) {
    console.error("AI Bot error:", err);
    throw new functions.https.HttpsError("internal", "AI service error: " + (err.message || String(err)));
  }
});

/* ═══ v4.0.0 SECURITY ═══ */

// Audit log writer — server-only. Rules block client writes (auditLog/.write: false).
// Shape: auditLog/{firebasePushId}: { ts, actor, action, target, meta }
// Use push() — Firebase auto-IDs are path-safe and chronologically sortable.
async function writeAuditEntry(actor, action, target, meta) {
  const ts = new Date().toISOString();
  await db.ref("auditLog").push({ ts, actor, action, target: target || null, meta: meta || null });
}

// URL validator — reject empty, non-https, javascript:, data: URIs.
function validateUrl(u) {
  if (u == null || u === "") return "";
  if (typeof u !== "string") throw new functions.https.HttpsError("invalid-argument", "URL must be a string.");
  const t = u.trim();
  if (!/^https:\/\//i.test(t)) throw new functions.https.HttpsError("invalid-argument", "URL must start with https://.");
  if (/^javascript:|^data:|^vbscript:|^file:/i.test(t)) throw new functions.https.HttpsError("invalid-argument", "Disallowed URL scheme.");
  if (t.length > 2048) throw new functions.https.HttpsError("invalid-argument", "URL too long.");
  return t;
}

async function requireAdmin(context) {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const snap = await db.ref(`users/${context.auth.uid}`).once("value");
  const u = snap.val();
  if (u?.role !== "admin") throw new functions.https.HttpsError("permission-denied", "Admins only.");
  return u;
}

/* ── provisionUser: first-time sign-in. Replaces client-side bootstrap + auto-approve. ── */
exports.provisionUser = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const uid = context.auth.uid;
  const email = (context.auth.token?.email || "").toLowerCase();
  const name = context.auth.token?.name || email;
  const photoURL = context.auth.token?.picture || null;

  // Idempotent — if user already exists, return it.
  const existing = (await db.ref(`users/${uid}`).once("value")).val();
  if (existing) return { status: "exists", user: existing };

  const isInstDomain = /@instrumental\.com$/i.test(email);
  if (isInstDomain) {
    // Auto-approve as Instrumental user (role=user, partyId=instrumental).
    // Admins must be promoted explicitly via adminSetRole by an existing admin.
    const allProj = (await db.ref("appState/projects").once("value")).val() || {};
    const projIds = Object.keys(allProj);
    const nu = {
      id: uid,
      name,
      email,
      photoURL,
      role: "user",
      partyId: "instrumental",
      projects: projIds,
      createdAt: new Date().toISOString(),
    };
    await db.ref(`users/${uid}`).set(nu);
    await writeAuditEntry(uid, "provision_instrumental", uid, { email });
    return { status: "provisioned_instrumental", user: nu };
  }

  // External user → pendingUsers for admin approval.
  const pending = { id: uid, name, email, photoURL, requestedAt: new Date().toISOString() };
  await db.ref(`pendingUsers/${uid}`).set(pending);
  await writeAuditEntry(uid, "request_access", uid, { email });
  return { status: "pending", pending };
});

/* ── Admin callables with audit logging ── */

exports.adminApproveUser = functions.https.onCall(async (data, context) => {
  const caller = await requireAdmin(context);
  const { pendingId, projectIds } = data || {};
  if (!pendingId) throw new functions.https.HttpsError("invalid-argument", "pendingId required.");
  const pu = (await db.ref(`pendingUsers/${pendingId}`).once("value")).val();
  if (!pu) throw new functions.https.HttpsError("not-found", "Pending user not found.");

  const selProjIds = Array.isArray(projectIds) ? projectIds : [];
  const nu = {
    id: pu.id,
    name: pu.name,
    email: pu.email,
    photoURL: pu.photoURL || null,
    role: "user",
    partyId: "external",
    projects: selProjIds,
    createdAt: new Date().toISOString(),
  };
  await db.ref(`users/${pu.id}`).set(nu);
  const updates = {};
  selProjIds.forEach(pid => { updates[`access/${pid}/${pu.id}`] = true; });
  if (Object.keys(updates).length > 0) await db.ref().update(updates);
  await db.ref(`pendingUsers/${pendingId}`).set(null);
  await writeAuditEntry(caller.id, "approve_user", pu.id, { email: pu.email, projectIds: selProjIds });
  return { ok: true };
});

exports.adminDenyUser = functions.https.onCall(async (data, context) => {
  const caller = await requireAdmin(context);
  const { pendingId } = data || {};
  if (!pendingId) throw new functions.https.HttpsError("invalid-argument", "pendingId required.");
  const pu = (await db.ref(`pendingUsers/${pendingId}`).once("value")).val();
  await db.ref(`pendingUsers/${pendingId}`).set(null);
  await writeAuditEntry(caller.id, "deny_user", pendingId, { email: pu?.email || null });
  return { ok: true };
});

exports.adminDeleteUser = functions.https.onCall(async (data, context) => {
  const caller = await requireAdmin(context);
  const { uid } = data || {};
  if (!uid) throw new functions.https.HttpsError("invalid-argument", "uid required.");
  if (uid === caller.id) throw new functions.https.HttpsError("failed-precondition", "Cannot delete self.");
  const target = (await db.ref(`users/${uid}`).once("value")).val();
  if (!target) throw new functions.https.HttpsError("not-found", "User not found.");

  // Sweep access maps across all projects
  const allAccess = (await db.ref("access").once("value")).val() || {};
  const accessUpdates = {};
  Object.keys(allAccess).forEach(pid => { if (allAccess[pid] && allAccess[pid][uid]) accessUpdates[`access/${pid}/${uid}`] = null; });
  const allCommercial = (await db.ref("commercialAccess").once("value")).val() || {};
  const commUpdates = {};
  Object.keys(allCommercial).forEach(pid => { if (allCommercial[pid] && allCommercial[pid][uid]) commUpdates[`commercialAccess/${pid}/${uid}`] = null; });

  const updates = { ...accessUpdates, ...commUpdates, [`users/${uid}`]: null };
  await db.ref().update(updates);

  // v4.5.4 security fix: also delete the Firebase Auth user so they can't re-sign-in and
  // get re-provisioned. Wrapped in try/catch — Auth user may not exist for legacy
  // RTDB-only records, and we still want the RTDB cleanup + audit entry to land.
  let authDeleted = false;
  let authError = null;
  try {
    await admin.auth().deleteUser(uid);
    authDeleted = true;
  } catch (e) {
    authError = e.code === "auth/user-not-found" ? "auth_user_not_found" : (e.message || String(e));
    console.warn(`adminDeleteUser: Firebase Auth delete failed for ${uid}:`, authError);
  }

  await writeAuditEntry(caller.id, "delete_user", uid, {
    email: target.email, role: target.role,
    authDeleted, ...(authError ? { authError } : {}),
  });
  return { ok: true, authDeleted, authError };
});

exports.adminSetRole = functions.https.onCall(async (data, context) => {
  const caller = await requireAdmin(context);
  const { uid, role } = data || {};
  if (!uid || !role) throw new functions.https.HttpsError("invalid-argument", "uid and role required.");
  if (role !== "user" && role !== "si_admin" && role !== "admin") throw new functions.https.HttpsError("invalid-argument", "role must be 'user', 'si_admin', or 'admin'.");
  const target = (await db.ref(`users/${uid}`).once("value")).val();
  if (!target) throw new functions.https.HttpsError("not-found", "User not found.");
  if (role === "admin" && !/@instrumental\.com$/i.test((target.email || "").toLowerCase())) {
    throw new functions.https.HttpsError("failed-precondition", "Only @instrumental.com users can be admins.");
  }
  const updates = { [`users/${uid}/role`]: role };
  if (role === "admin") updates[`users/${uid}/partyId`] = "instrumental";
  await db.ref().update(updates);
  await writeAuditEntry(caller.id, "set_role", uid, { oldRole: target.role, newRole: role, email: target.email });
  return { ok: true };
});

exports.adminSetProjectAccess = functions.https.onCall(async (data, context) => {
  const caller = await requireAdmin(context);
  const { uid, projectId, grant } = data || {};
  if (!uid || !projectId) throw new functions.https.HttpsError("invalid-argument", "uid and projectId required.");
  const target = (await db.ref(`users/${uid}`).once("value")).val();
  if (!target) throw new functions.https.HttpsError("not-found", "User not found.");

  const nextProjects = new Set(target.projects || []);
  if (grant) nextProjects.add(projectId); else nextProjects.delete(projectId);
  const needsAccessMap = target.role !== "admin" && !/@instrumental\.com$/i.test((target.email || "").toLowerCase());

  const updates = { [`users/${uid}/projects`]: Array.from(nextProjects) };
  if (needsAccessMap) updates[`access/${projectId}/${uid}`] = grant ? true : null;
  await db.ref().update(updates);
  await writeAuditEntry(caller.id, grant ? "grant_project" : "revoke_project", uid, { projectId, email: target.email });
  return { ok: true };
});

exports.adminSetCommercialAccess = functions.https.onCall(async (data, context) => {
  const caller = await requireAdmin(context);
  const { uid, projectId, grant } = data || {};
  if (!uid || !projectId) throw new functions.https.HttpsError("invalid-argument", "uid and projectId required.");
  await db.ref(`commercialAccess/${projectId}/${uid}`).set(grant ? true : null);
  await writeAuditEntry(caller.id, grant ? "grant_commercial" : "revoke_commercial", uid, { projectId });
  return { ok: true };
});

/* ═══ HUBSPOT WRITEBACK — v4.1.0: write date fields back to HubSpot custom object ═══ */

// Date property internal names in HubSpot. Run getHubspotCustomObjectSchema (admin panel) to verify.
// HubSpot stores dates as milliseconds-since-epoch (integer), not ISO strings.
const HUBSPOT_DATE_PROPS = {
  cadCompleteDate:        "cad_complete_date",
  cadActualFinishDate:    "actual_finish_date",
  actualServiceStartDate: "actual_service_start_date__c",
  targetBuildDate:        "actual_target_build_date__c",
  actualDeployDate:       "actual_deploy_date_production_ready__c",
};

// Diagnostic: returns all property names + labels for the custom object type (admin-only).
// v4.3.1: accepts objectTypeId param (defaults to OBJECT_TYPE for back-compat).
exports.getHubspotCustomObjectSchema = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const objectTypeId = (data && data.objectTypeId) || OBJECT_TYPE;
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new functions.https.HttpsError("internal", "HUBSPOT_TOKEN not configured.");
  const res = await fetch(
    `https://api.hubapi.com/crm/v3/schemas/${objectTypeId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new functions.https.HttpsError("internal", `HubSpot schema error: ${res.status} ${await res.text()}`);
  const schema = await res.json();
  const props = (schema.properties || []).map(p => ({
    name: p.name,
    label: p.label,
    type: p.type,
    fieldType: p.fieldType,
  }));
  return { objectType: objectTypeId, totalProperties: props.length, properties: props };
});

// Diagnostic: lists all custom object schemas in the HubSpot portal (admin-only).
// Use to discover object type IDs and property names for objects not yet integrated.
exports.listHubspotSchemas = functions.https.onCall(async (_data, context) => {
  await requireAdmin(context);
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new functions.https.HttpsError("internal", "HUBSPOT_TOKEN not configured.");
  const res = await fetch(
    "https://api.hubapi.com/crm/v3/schemas",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new functions.https.HttpsError("internal", `HubSpot schemas error: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return (body.results || []).map(s => ({
    name: s.name,
    label: s.labels?.singular || s.name,
    objectTypeId: s.objectTypeId,
    properties: (s.properties || []).map(p => ({ name: p.name, label: p.label, type: p.type })),
  }));
});

// Writeback: patches one or more date fields on the HubSpot custom object record.
// data: { hubspotId: string, fields: { [appKey]: "YYYY-MM-DD" | null } }
// Gate: Instrumental users only (admin or si_admin or partyId === "instrumental")
exports.writeProjectDateToHubspot = functions.runWith({ memory: "256MB" }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const uid = context.auth.uid;
  const userSnap = await db.ref(`users/${uid}`).once("value");
  const user = userSnap.val();
  if (!user) throw new functions.https.HttpsError("permission-denied", "User not found.");
  const isInst = user.role === "admin" || user.role === "si_admin" || user.partyId === "instrumental";
  if (!isInst) throw new functions.https.HttpsError("permission-denied", "Instrumental users only.");

  const { hubspotId, fields } = data || {};
  if (!hubspotId || !fields || typeof fields !== "object")
    throw new functions.https.HttpsError("invalid-argument", "hubspotId and fields required.");

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new functions.https.HttpsError("internal", "HUBSPOT_TOKEN not configured.");

  // Build HubSpot properties object — convert "YYYY-MM-DD" → ms since epoch (MIDNIGHT UTC, strictly).
  // HubSpot rejects datepicker values that aren't exactly midnight UTC with error:
  //   "X ms is at HH:MM:SS.0 UTC, not midnight!" (INVALID_DATE).
  // The v4.1.0 code used noon UTC "to avoid TZ shifts" but that was wrong — HubSpot enforces midnight.
  const properties = {};
  for (const [appKey, val] of Object.entries(fields)) {
    const propName = HUBSPOT_DATE_PROPS[appKey];
    if (!propName) continue;
    if (val) {
      const ms = new Date(val + "T00:00:00Z").getTime();
      properties[propName] = ms;
    } else {
      properties[propName] = "";  // clear the field
    }
  }
  if (Object.keys(properties).length === 0) return { ok: true, skipped: true };

  const url = `https://api.hubapi.com/crm/v3/objects/${OBJECT_TYPE}/${hubspotId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties }),
  });

  const logEntry = {
    ts: new Date().toISOString(), uid, hubspotId, fields,
    status: res.ok ? "ok" : "error",
    httpStatus: res.status,
  };
  if (!res.ok) {
    logEntry.body = await res.text();
    await db.ref("hubspotWriteback/log").push(logEntry);
    throw new functions.https.HttpsError("internal", `HubSpot PATCH failed: ${res.status} ${logEntry.body}`);
  }
  await db.ref("hubspotWriteback/log").push(logEntry);
  return { ok: true, properties };
});

/* ═══ HUBSPOT WRITEBACK — v4.3.0: write stage changes back to HubSpot ═══ */
exports.writeStageToHubspot = functions.runWith({ memory: "256MB" }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const uid = context.auth.uid;
  const userSnap = await db.ref(`users/${uid}`).once("value");
  const user = userSnap.val();
  if (!user) throw new functions.https.HttpsError("permission-denied", "User not found.");
  const isInst = user.role === "admin" || user.role === "si_admin" || user.partyId === "instrumental";
  if (!isInst) throw new functions.https.HttpsError("permission-denied", "Instrumental users only.");

  const { hubspotId, stageId } = data || {};
  if (!hubspotId || !stageId)
    throw new functions.https.HttpsError("invalid-argument", "hubspotId and stageId required.");

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new functions.https.HttpsError("internal", "HUBSPOT_TOKEN not configured.");

  const url = `https://api.hubapi.com/crm/v3/objects/${OBJECT_TYPE}/${hubspotId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { hs_pipeline_stage: stageId } }),
  });

  const logEntry = { ts: new Date().toISOString(), uid, hubspotId, stageId, status: res.ok ? "ok" : "error", httpStatus: res.status };
  if (!res.ok) {
    logEntry.body = await res.text();
    await db.ref("hubspotWriteback/log").push(logEntry);
    throw new functions.https.HttpsError("internal", `HubSpot stage PATCH failed: ${res.status} ${logEntry.body}`);
  }
  const pid = `hs_${hubspotId}`;
  await db.ref(`appState/projects/${pid}/hubspotStageId`).set(stageId);
  await db.ref("hubspotWriteback/log").push(logEntry);
  return { ok: true };
});

/* ═══ HUBSPOT SHIPMENT WRITEBACK — v4.4.0: create-or-update Shipments custom object ═══ */
// App's pd_shipment_details row → HubSpot Shipments custom object (2-39524475).
// Properties confirmed via schema diagnostic on 2026-06-09.
// Note: label and name are swapped on two fields in HubSpot's schema (confusing but verified via real data):
//   - shipment_tracking_number = the INxxx (despite its label saying "Internal Shipment ID")
//   - internal_shipment_id     = the carrier's tracking number (despite its label saying "Shipment Tracking Number")
const HUBSPOT_SHIPMENT_PROPS = {
  contents:     "shipment_contents__c",   // app textarea → HubSpot textarea
  carrier:      "logistics_company__c",   // app text → HubSpot text (e.g., "Fedex", "SF Express")
  tracking_num: "internal_shipment_id",   // app text → HubSpot text (carrier's tracking #)
  ship_date:    "date_shipped__c",        // app date (YYYY-MM-DD) → HubSpot datepicker (midnight UTC ms)
  notes:        "notes",                  // app textarea → HubSpot textarea
};
// App columns with no HubSpot equivalent — saved locally only, never written back:
//   box_size_in, box_size_mm, weight_lbs, weight_kg

// Writeback: PATCH existing Shipment if hubspotShipmentId is known or INxxx matches a HubSpot record;
//            otherwise CREATE a new Shipment with the given INxxx + properties.
// data: { hubspotShipmentId?, item_num (INxxx), fields: { contents?, carrier?, tracking_num?, ship_date?, notes? } }
// Gate: Instrumental users only.
exports.writeShipmentToHubspot = functions.runWith({ memory: "256MB" }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const uid = context.auth.uid;
  const userSnap = await db.ref(`users/${uid}`).once("value");
  const user = userSnap.val();
  if (!user) throw new functions.https.HttpsError("permission-denied", "User not found.");
  const isInst = user.role === "admin" || user.role === "si_admin" || user.partyId === "instrumental";
  if (!isInst) throw new functions.https.HttpsError("permission-denied", "Instrumental users only.");

  const { hubspotShipmentId, item_num, fields } = data || {};
  if (!item_num || typeof item_num !== "string" || !item_num.trim())
    throw new functions.https.HttpsError("invalid-argument", "item_num (INxxx) required.");
  if (!fields || typeof fields !== "object")
    throw new functions.https.HttpsError("invalid-argument", "fields required.");

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new functions.https.HttpsError("internal", "HUBSPOT_TOKEN not configured.");

  // Build HubSpot properties object from the app-key → HubSpot-prop map.
  const properties = {};
  for (const [appKey, val] of Object.entries(fields)) {
    const propName = HUBSPOT_SHIPMENT_PROPS[appKey];
    if (!propName) continue; // ignore local-only fields (box_size, weight, etc.)
    if (val === null || val === undefined || val === "") {
      properties[propName] = ""; // clear the field
    } else if (appKey === "ship_date") {
      // Date format: HubSpot datepickers require midnight UTC ms (same fix as writeProjectDateToHubspot).
      properties[propName] = new Date(String(val) + "T00:00:00Z").getTime();
    } else {
      properties[propName] = String(val);
    }
  }
  // v4.4.1: always include shipment_tracking_number in the PATCH body so item_num renames propagate.
  // Idempotent: if the value matches, HubSpot no-ops; if it changed, the INxxx updates on HubSpot.
  // (Pre-v4.4.1 the PATCH body only carried mapped fields, so item_num-only edits were silently dropped.)
  properties["shipment_tracking_number"] = item_num.trim();

  // Step 1: resolve target HubSpot record — by ID if known, else search by INxxx, else create.
  let targetId = hubspotShipmentId || null;

  if (!targetId) {
    // Search for an existing Shipment with this INxxx (shipment_tracking_number).
    // v4.5.4: do NOT silently fall through to CREATE on search failure — HubSpot
    // doesn't enforce uniqueness on shipment_tracking_number, so a flaky search
    // (5xx, timeout, malformed JSON) would silently create a duplicate Shipment
    // record. Instead: log to hubspotWriteback/log and propagate the error to
    // the client so the user can retry.
    try {
      const searchRes = await fetch(`https://api.hubapi.com/crm/v3/objects/${SHIPMENT_OBJECT_TYPE}/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "shipment_tracking_number", operator: "EQ", value: item_num.trim() }] }],
          properties: ["shipment_tracking_number"],
          limit: 1,
        }),
      });
      if (!searchRes.ok) {
        const body = await searchRes.text();
        await db.ref("hubspotWriteback/log").push({
          ts: new Date().toISOString(), uid, item_num: item_num.trim(),
          action: "search_shipment_failed", status: "error",
          httpStatus: searchRes.status, body: body.slice(0, 500),
        });
        throw new functions.https.HttpsError("unavailable",
          `HubSpot search failed (${searchRes.status}). To avoid creating a duplicate, the request was aborted. Try again in a moment.`);
      }
      const body = await searchRes.json();
      const hit = (body.results || [])[0];
      if (hit && hit.id) targetId = String(hit.id);
    } catch (e) {
      // Re-throw HttpsErrors as-is; wrap other errors (network / JSON parse) so
      // they don't silently fall through to CREATE.
      if (e instanceof functions.https.HttpsError) throw e;
      await db.ref("hubspotWriteback/log").push({
        ts: new Date().toISOString(), uid, item_num: item_num.trim(),
        action: "search_shipment_failed", status: "error",
        error: e.message || String(e),
      });
      throw new functions.https.HttpsError("unavailable",
        `HubSpot search request failed. To avoid creating a duplicate, the request was aborted. Try again. (${e.message || e})`);
    }
  }

  // Step 2: PATCH (existing) or POST (new)
  const isCreate = !targetId;
  const url = isCreate
    ? `https://api.hubapi.com/crm/v3/objects/${SHIPMENT_OBJECT_TYPE}`
    : `https://api.hubapi.com/crm/v3/objects/${SHIPMENT_OBJECT_TYPE}/${targetId}`;
  const method = isCreate ? "POST" : "PATCH";
  // properties already carries shipment_tracking_number (set above) so both paths use the same body shape.
  const reqBody = { properties };

  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });

  const logEntry = {
    ts: new Date().toISOString(), uid, item_num: item_num.trim(),
    hubspotId: targetId || null,
    action: isCreate ? "create_shipment" : "patch_shipment",
    fields: Object.keys(properties),
    status: res.ok ? "ok" : "error",
    httpStatus: res.status,
  };

  if (!res.ok) {
    logEntry.body = await res.text();
    await db.ref("hubspotWriteback/log").push(logEntry);
    throw new functions.https.HttpsError("internal", `HubSpot ${method} failed: ${res.status} ${logEntry.body}`);
  }

  const responseBody = await res.json();
  if (isCreate && responseBody.id) {
    targetId = String(responseBody.id);
    logEntry.hubspotId = targetId;
  }
  await db.ref("hubspotWriteback/log").push(logEntry);
  return { ok: true, hubspotShipmentId: targetId, created: isCreate };
});

/* ═══ v4.5.0 STAGE 6B — STATION KIT + FLEET ASSET WRITEBACK ═══ */

// App→HubSpot kit-level field PATCH. Mirrors writeProjectDateToHubspot.
// Only the 5 fields below are writable — everything else local-only.
const HUBSPOT_KIT_PROPS = {
  kitName:     "name",
  kitSN:       "station_kit_sn",
  computerSN:  "computer_sn",
  kitStatus:   "status",
  stationType: "station_type",
};

exports.writeStationKitToHubspot = functions.runWith({ memory: "256MB" }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const uid = context.auth.uid;
  const userSnap = await db.ref(`users/${uid}`).once("value");
  const user = userSnap.val();
  if (!user) throw new functions.https.HttpsError("permission-denied", "User not found.");
  const isInst = user.role === "admin" || user.role === "si_admin" || user.partyId === "instrumental";
  if (!isInst) throw new functions.https.HttpsError("permission-denied", "Instrumental users only.");

  const { kitHubspotId, fields } = data || {};
  if (!kitHubspotId || typeof kitHubspotId !== "string")
    throw new functions.https.HttpsError("invalid-argument", "kitHubspotId required.");
  if (!fields || typeof fields !== "object")
    throw new functions.https.HttpsError("invalid-argument", "fields required.");

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new functions.https.HttpsError("internal", "HUBSPOT_TOKEN not configured.");

  const properties = {};
  for (const [appKey, val] of Object.entries(fields)) {
    const propName = HUBSPOT_KIT_PROPS[appKey];
    if (!propName) continue;
    properties[propName] = (val === null || val === undefined) ? "" : String(val);
  }
  if (Object.keys(properties).length === 0) {
    return { ok: true, skipped: true, reason: "no mapped fields" };
  }

  const res = await fetch(`https://api.hubapi.com/crm/v3/objects/${STATION_KIT_TYPE_ID}/${kitHubspotId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties }),
  });

  const logEntry = {
    ts: new Date().toISOString(), uid, kitHubspotId,
    action: "patch_station_kit",
    fields: Object.keys(properties),
    status: res.ok ? "ok" : "error",
    httpStatus: res.status,
  };
  if (!res.ok) {
    logEntry.body = await res.text();
    await db.ref("hubspotWriteback/log").push(logEntry);
    throw new functions.https.HttpsError("internal", `HubSpot PATCH failed: ${res.status} ${logEntry.body}`);
  }
  await db.ref("hubspotWriteback/log").push(logEntry);
  return { ok: true };
});

// App→HubSpot fleet asset SN edit. Treated as a "swap" — find a Fleet Asset by the new SN, then
// re-point the Kit↔FleetAsset associations (both labeled and the typeId 35 default) to it.
// PUT-then-DELETE order: only remove the old association after the new one is in place, so a partial
// failure never leaves a kit with no association under that label.
exports.writeFleetAssetAssociation = functions.runWith({ memory: "256MB" }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const uid = context.auth.uid;
  const userSnap = await db.ref(`users/${uid}`).once("value");
  const user = userSnap.val();
  if (!user) throw new functions.https.HttpsError("permission-denied", "User not found.");
  const isInst = user.role === "admin" || user.role === "si_admin" || user.partyId === "instrumental";
  if (!isInst) throw new functions.https.HttpsError("permission-denied", "Instrumental users only.");

  const { kitHubspotId, currentFleetAssetHubspotId, label, newSerial } = data || {};
  if (!kitHubspotId || !label || !newSerial)
    throw new functions.https.HttpsError("invalid-argument", "kitHubspotId, label, and newSerial required.");

  const labelTypeId = FLEET_ASSET_LABEL_TO_TYPE_ID[label];
  if (!labelTypeId)
    throw new functions.https.HttpsError("invalid-argument", `Unknown association label "${label}". Expected one of: ${Object.keys(FLEET_ASSET_LABEL_TO_TYPE_ID).join(", ")}.`);

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new functions.https.HttpsError("internal", "HUBSPOT_TOKEN not configured.");

  const baseLog = { ts: new Date().toISOString(), uid, kitHubspotId, label, newSerial: String(newSerial).trim(), action: "writeFleetAssetAssociation" };

  // Step 1: search HubSpot for a Fleet Asset with asset_sn === newSerial
  const searchRes = await fetch(`https://api.hubapi.com/crm/v3/objects/${FLEET_ASSET_TYPE_ID}/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "asset_sn", operator: "EQ", value: String(newSerial).trim() }] }],
      properties: ["asset_sn"],
      limit: 2,
    }),
  });
  if (!searchRes.ok) {
    const body = await searchRes.text();
    await db.ref("hubspotWriteback/log").push({ ...baseLog, status: "error", httpStatus: searchRes.status, step: "search", body });
    throw new functions.https.HttpsError("internal", `Fleet Asset search failed: ${searchRes.status} ${body}`);
  }
  const searchBody = await searchRes.json();
  const hits = searchBody.results || [];
  if (hits.length === 0) {
    await db.ref("hubspotWriteback/log").push({ ...baseLog, status: "error", step: "search", reason: "not_found" });
    throw new functions.https.HttpsError("not-found", `No Fleet Asset with SN "${String(newSerial).trim()}" exists in HubSpot. Create it first, then sync this project.`);
  }
  const newFleetAssetId = String(hits[0].id);

  // Step 2: idempotent no-op when the target asset is already the one linked
  if (currentFleetAssetHubspotId && newFleetAssetId === String(currentFleetAssetHubspotId)) {
    await db.ref("hubspotWriteback/log").push({ ...baseLog, status: "ok", noop: true, newFleetAssetHubspotId: newFleetAssetId });
    return { ok: true, noop: true, newFleetAssetHubspotId: newFleetAssetId };
  }

  // Step 3: PUT new Kit↔NewFleetAsset associations (labeled + unlabeled default). Batch create both at once.
  const createUrl = `https://api.hubapi.com/crm/v4/associations/${STATION_KIT_TYPE_ID}/${FLEET_ASSET_TYPE_ID}/batch/create`;
  const createBody = {
    inputs: [{
      from: { id: String(kitHubspotId) },
      to:   { id: newFleetAssetId },
      types: [
        { associationCategory: "USER_DEFINED", associationTypeId: labelTypeId },
        { associationCategory: "USER_DEFINED", associationTypeId: FLEET_ASSET_UNLABELED_TYPE_ID },
      ],
    }],
  };
  const createRes = await fetch(createUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(createBody),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    await db.ref("hubspotWriteback/log").push({ ...baseLog, status: "error", httpStatus: createRes.status, step: "create_assoc", body, newFleetAssetHubspotId: newFleetAssetId });
    throw new functions.https.HttpsError("internal", `Create association failed: ${createRes.status} ${body}`);
  }

  // Step 4: DELETE all old Kit↔OldFleetAsset associations (best-effort).
  // Use the single-object DELETE endpoint (verified HTTP 204) — it removes ALL labels/typeIds
  // between the two objects in one call. batch/archive's body shape rejected our minimal inputs.
  let deleteWarning = null;
  if (currentFleetAssetHubspotId) {
    const deleteUrl = `https://api.hubapi.com/crm/v4/objects/${STATION_KIT_TYPE_ID}/${kitHubspotId}/associations/${FLEET_ASSET_TYPE_ID}/${currentFleetAssetHubspotId}`;
    const deleteRes = await fetch(deleteUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!deleteRes.ok) {
      deleteWarning = `Old association DELETE returned ${deleteRes.status}: ${(await deleteRes.text()).slice(0, 200)}`;
      console.warn("[writeFleetAssetAssociation]", deleteWarning);
    }
  }

  await db.ref("hubspotWriteback/log").push({
    ...baseLog,
    status: "ok",
    httpStatus: createRes.status,
    newFleetAssetHubspotId: newFleetAssetId,
    oldFleetAssetHubspotId: currentFleetAssetHubspotId || null,
    ...(deleteWarning ? { deleteWarning } : {}),
  });
  return { ok: true, newFleetAssetHubspotId: newFleetAssetId, deleteWarning };
});

/* ═══ v4.5.7 — WRITE NOTE TO HUBSPOT ═══ */
// Creates a Note (engagement object 0-46) in HubSpot, uploads any attachments to HubSpot Files,
// and associates the note to the given Project. Mirrors the writeShipmentToHubspot auth pattern.
// data = { projectHubspotId, body, attachments?: [{ name, base64, mimeType }] }
exports.writeNoteToHubspot = functions.runWith({ memory: "512MB", timeoutSeconds: 60 }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const uid = context.auth.uid;
  const userSnap = await db.ref(`users/${uid}`).once("value");
  const user = userSnap.val();
  if (!user) throw new functions.https.HttpsError("permission-denied", "User not found.");
  const isInst = user.role === "admin" || user.role === "si_admin" || user.partyId === "instrumental";
  if (!isInst) throw new functions.https.HttpsError("permission-denied", "Instrumental users only.");

  const { projectHubspotId, body, attachments } = data || {};
  if (!projectHubspotId || typeof projectHubspotId !== "string")
    throw new functions.https.HttpsError("invalid-argument", "projectHubspotId required.");
  const trimmedBody = String(body || "").trim();
  if (!trimmedBody && !(Array.isArray(attachments) && attachments.length))
    throw new functions.https.HttpsError("invalid-argument", "Either body text or at least one attachment is required.");

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new functions.https.HttpsError("internal", "HUBSPOT_TOKEN not configured.");

  // Step 1: upload attachments to HubSpot Files (in parallel). Each item: { name, base64, mimeType }.
  const attList = Array.isArray(attachments) ? attachments : [];
  const fileIds = [];
  const uploadErrors = [];
  if (attList.length) {
    const folder = `/deployment-portal-notes/${projectHubspotId}/${Date.now()}`;
    await Promise.all(attList.map(async (att, idx) => {
      try {
        if (!att?.base64 || !att?.name) {
          uploadErrors.push(`attachment[${idx}] missing name or base64`);
          return;
        }
        const buf = Buffer.from(att.base64, "base64");
        // v4.5.7 hotfix: build multipart body manually as Buffer. Node 20 native FormData + fetch
        // in the Cloud Functions runtime doesn't reliably set Content-Type with boundary, causing
        // HubSpot Files API to reject with HTTP 415. Manual construction is deterministic.
        const boundary = `----dpFormBoundary${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        const CRLF = "\r\n";
        const optionsJson = JSON.stringify({ access: "PRIVATE", overwrite: false });
        const parts = [
          Buffer.from(
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="file"; filename="${att.name.replace(/"/g, '\\"')}"${CRLF}` +
            `Content-Type: ${att.mimeType || "application/octet-stream"}${CRLF}${CRLF}`,
            "utf8"
          ),
          buf,
          Buffer.from(
            `${CRLF}--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="folderPath"${CRLF}${CRLF}` +
            `${folder}${CRLF}` +
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="options"${CRLF}${CRLF}` +
            `${optionsJson}${CRLF}` +
            `--${boundary}--${CRLF}`,
            "utf8"
          ),
        ];
        const body = Buffer.concat(parts);
        const res = await fetch("https://api.hubapi.com/files/v3/files", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": String(body.length),
          },
          body,
        });
        if (!res.ok) {
          const errText = await res.text();
          uploadErrors.push(`${att.name}: HTTP ${res.status} ${errText.slice(0, 150)}`);
          return;
        }
        const f = await res.json();
        if (f.id) fileIds.push(String(f.id));
      } catch (e) {
        uploadErrors.push(`${att?.name || `attachment[${idx}]`}: ${e.message || e}`);
      }
    }));
    if (uploadErrors.length && !fileIds.length) {
      // ALL uploads failed — abort before creating the note
      await db.ref("hubspotWriteback/log").push({
        ts: new Date().toISOString(), uid, projectHubspotId,
        action: "write_note_upload_failed", status: "error",
        uploadErrors,
      });
      throw new functions.https.HttpsError("internal", `All attachment uploads failed: ${uploadErrors.join("; ")}`);
    }
  }

  // Step 2: try to resolve the caller to a HubSpot Owner by email (best-effort)
  let ownerIdForNote = null;
  if (user.email) {
    try {
      const ownersRes = await fetch(`https://api.hubapi.com/crm/v3/owners?email=${encodeURIComponent(user.email)}&limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (ownersRes.ok) {
        const od = await ownersRes.json();
        const o = (od.results || [])[0];
        if (o?.id) ownerIdForNote = String(o.id);
      }
    } catch (_) { /* non-fatal */ }
  }

  // Step 3: create the Note object
  // hs_note_body must be HTML — wrap plain text body in <p>. Escape HTML-special chars in user input.
  const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const htmlBody = trimmedBody ? `<p>${escapeHtml(trimmedBody).replace(/\n/g, "<br>")}</p>` : "";
  const noteProps = {
    hs_timestamp: Date.now(),
    hs_note_body: htmlBody,
  };
  if (fileIds.length) noteProps.hs_attachment_ids = fileIds.join(";");
  if (ownerIdForNote) noteProps.hubspot_owner_id = ownerIdForNote;

  const createNoteRes = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: noteProps }),
  });
  if (!createNoteRes.ok) {
    const errText = await createNoteRes.text();
    await db.ref("hubspotWriteback/log").push({
      ts: new Date().toISOString(), uid, projectHubspotId,
      action: "write_note_create_failed", status: "error",
      httpStatus: createNoteRes.status, body: errText.slice(0, 500),
      uploadedFileIds: fileIds,
    });
    throw new functions.https.HttpsError("internal", `Create note failed: ${createNoteRes.status} ${errText.slice(0, 200)}`);
  }
  const noteData = await createNoteRes.json();
  const noteId = String(noteData.id);

  // Step 4: associate note → project (default HubSpot-defined association)
  let assocWarning = null;
  try {
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/notes/${noteId}/associations/default/${OBJECT_TYPE}/${projectHubspotId}`,
      { method: "PUT", headers: { Authorization: `Bearer ${token}` } }
    );
    if (!assocRes.ok) {
      assocWarning = `Association PUT returned ${assocRes.status}: ${(await assocRes.text()).slice(0, 150)}`;
      console.warn("[writeNoteToHubspot]", assocWarning);
    }
  } catch (e) {
    assocWarning = `Association PUT threw: ${e.message || e}`;
    console.warn("[writeNoteToHubspot]", assocWarning);
  }

  await db.ref("hubspotWriteback/log").push({
    ts: new Date().toISOString(), uid, projectHubspotId,
    action: "write_note", status: "ok",
    hubspotNoteId: noteId,
    fileIds, uploadErrors: uploadErrors.length ? uploadErrors : null,
    ...(assocWarning ? { assocWarning } : {}),
  });
  return {
    ok: true,
    hubspotNoteId: noteId,
    fileIds,
    uploadErrors: uploadErrors.length ? uploadErrors : null,
    assocWarning,
  };
});

/* ═══ SLACK FEEDBACK — v4.3.1: in-app feedback button posts to Slack ═══ */
// Routes by category: si → Sneha; everything else → Asang. Webhooks live in env vars.
exports.sendSlackFeedback = functions.runWith({ memory: "256MB" }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const { message, category, projectName } = data || {};
  if (!message || typeof message !== "string" || !message.trim())
    throw new functions.https.HttpsError("invalid-argument", "Message required.");
  const trimmed = message.trim().slice(0, 2000);

  const uid = context.auth.uid;
  const userSnap = await db.ref(`users/${uid}`).once("value");
  const sender = userSnap.val();
  const senderLabel = sender ? `${sender.name || "Unknown"} <${sender.email || uid}>` : uid;

  const isSI = category === "si";
  const webhook = isSI ? process.env.SLACK_WEBHOOK_SNEHA : process.env.SLACK_WEBHOOK_ASANG;
  if (!webhook) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      `Slack webhook for ${isSI ? "SI" : "general"} feedback is not configured yet.`
    );
  }

  const text = [
    `*New Deployment Portal Feedback* ${isSI ? "🤝 SI-related" : "📋 General"}`,
    `*From:* ${senderLabel}`,
    projectName ? `*Project:* ${projectName}` : null,
    `*Message:*\n${trimmed}`,
  ].filter(Boolean).join("\n");

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new functions.https.HttpsError("internal", `Slack webhook failed: ${res.status} ${body}`);
  }
  return { ok: true };
});

/* ═══ CHAT BOT — v4.0.0: conversational chat for all authed users, scoped to accessible projects ═══ */
exports.chatBot = functions.runWith({ memory: "512MB" }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const uid = context.auth.uid;
  const userSnap = await db.ref(`users/${uid}`).once("value");
  const user = userSnap.val();
  if (!user) throw new functions.https.HttpsError("permission-denied", "User record not found.");

  const { question, history } = data || {};
  if (!question || typeof question !== "string") throw new functions.https.HttpsError("invalid-argument", "question required.");
  if (question.length > 4000) throw new functions.https.HttpsError("invalid-argument", "question too long.");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new functions.https.HttpsError("internal", "Anthropic API key not configured.");

  // Determine which projects this user can see.
  const isInstrumental = user.role === "admin" || user.partyId === "instrumental";
  const allProjects = (await db.ref("appState/projects").once("value")).val() || {};
  let accessibleProjects;
  if (isInstrumental) {
    accessibleProjects = Object.values(allProjects).filter(p => p);
  } else {
    const allowedIds = new Set(user.projects || []);
    accessibleProjects = Object.values(allProjects).filter(p => p && allowedIds.has(p.id));
  }

  // Build context — keep small for external users (only their projects), larger for Instrumental.
  const cap = isInstrumental ? 60 : 30;
  const lines = [];
  lines.push(`User: ${user.name} (${user.role}, ${user.partyId}). They have access to ${accessibleProjects.length} project(s).`);
  accessibleProjects.slice(0, cap).forEach(p => {
    lines.push(`• ${p.name} (${p.customer || "?"}) — pipeline: ${p.hubspotPipelineLabel || "?"}, stage: ${p.hubspotStageLabel || "?"}, status: ${p.status || "?"}, stations: ${p.stations || 0}${p.isSI ? ", SI" : ""}`);
  });

  const systemPrompt = `You are a friendly AI assistant for Instrumental's Deployment Portal. You help ${isInstrumental ? "the Customer Experience team" : "external partners (customers, SI, CM)"} with questions about their hardware deployment projects. Use the data below. If the user asks about something outside their accessible projects or beyond the data, say so politely.

ACCESSIBLE PROJECTS:
${lines.join("\n")}

Be conversational, concise, and helpful. Use the user's name (${user.name.split(" ")[0]}) occasionally. Format lists with bullets when listing multiple things.`;

  const trimmedHistory = Array.isArray(history) ? history.slice(-12).filter(m => m && m.role && m.text) : [];
  const messages = [
    ...trimmedHistory.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.text).slice(0, 4000) })),
    { role: "user", content: question.trim() },
  ];

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });
    const answer = response.content?.[0]?.text || "No response generated.";
    return { answer };
  } catch (err) {
    console.error("chatBot error:", err);
    throw new functions.https.HttpsError("internal", "AI service error: " + (err.message || String(err)));
  }
});

/* ═══ GLOBAL AI SEARCH/CHAT — v4.0.0: cross-project Q&A for Instrumental users ═══ */
/* Differs from askProjectBot: no projectId required; aggregates all active projects + their key data. */
exports.askGlobalBot = functions.runWith({ memory: "512MB" }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");

  const userSnap = await db.ref(`users/${context.auth.uid}`).once("value");
  const user = userSnap.val();
  const email = (context.auth.token?.email || "").toLowerCase();
  if (user?.role !== "admin" && !email.endsWith("@instrumental.com")) {
    throw new functions.https.HttpsError("permission-denied", "Instrumental users only.");
  }

  const { question, history } = data || {};
  if (!question || typeof question !== "string") throw new functions.https.HttpsError("invalid-argument", "question required.");
  if (question.length > 4000) throw new functions.https.HttpsError("invalid-argument", "question too long.");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new functions.https.HttpsError("internal", "Anthropic API key not configured. Add ANTHROPIC_API_KEY to functions/.env");

  // Pull cross-project context. Cap to avoid huge prompts.
  const [projSnap, docSnap, overviewSnap] = await Promise.all([
    db.ref("appState/projects").once("value"),
    db.ref("appState/docData").once("value"),
    db.ref("appState/projectOverview").once("value"),
  ]);
  const projects = projSnap.val() || {};
  const docData = docSnap.val() || {};
  const overviews = overviewSnap.val() || {};

  const projArr = Object.values(projects).filter(p => p && p.status === "active").slice(0, 80);
  const lines = [];
  lines.push(`There are ${Object.keys(projects).length} total projects. ${projArr.length} active projects summarized below.`);
  projArr.forEach(p => {
    const ov = overviews[p.id] || {};
    const pdd = docData[p.id] || {};
    const pdCats = pdd.projectDetails || [];
    const pdArr = Array.isArray(pdCats) ? pdCats : Object.values(pdCats);
    let totalItems = 0, doneItems = 0;
    pdArr.forEach(c => {
      if (c?.type === "checklist" && c.milestones) {
        c.milestones.forEach(ms => (ms.checklist || []).forEach(ck => { if (!ck.na) { totalItems++; if (ck.checked) doneItems++; } }));
      }
    });
    const hwOv = pdd._hardwareOverride || {};
    const cameras = parseInt((hwOv.cameras?.value ?? p.hardware?.cameras ?? "").toString().match(/\d+/)?.[0] || "0");
    const computers = parseInt((hwOv.computers?.value ?? p.hardware?.computers ?? "").toString().match(/\d+/)?.[0] || "0");
    lines.push(`• ${p.name} (${p.customer || "?"}) — ${p.hubspotPipelineLabel || "?"} → ${p.hubspotStageLabel || "?"}; ${p.isSI ? "SI; " : ""}stations:${p.stations || 0}; cameras:${cameras}; computers:${computers}; checklist:${doneItems}/${totalItems}; CSProgID:${p.csProgramId || "—"}; status:"${(ov.projectStatus || "").substring(0, 120)}"`);
  });

  const systemPrompt = `You are an AI assistant for Instrumental's Deployment Portal, helping the Customer Experience team manage hardware deployment projects across all customers. You can answer questions that span multiple projects — e.g. "which projects are blocked", "what's our total camera demand", "list projects in CAD review". Use only the data below. If a question can't be answered from this data, say so plainly.

PROJECT DATA:
${lines.join("\n")}

Keep answers concise and actionable. Use bullet points or short tables when listing multiple projects. Reference projects by name, not ID.`;

  // Build messages array including conversation history (capped).
  const trimmedHistory = Array.isArray(history) ? history.slice(-10).filter(m => m && m.role && m.text) : [];
  const messages = [
    ...trimmedHistory.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.text).slice(0, 4000) })),
    { role: "user", content: question.trim() },
  ];

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });
    const answer = response.content?.[0]?.text || "No response generated.";
    await writeAuditEntry(context.auth.uid, "global_bot_query", null, { qLen: question.length });
    return { answer };
  } catch (err) {
    console.error("Global Bot error:", err);
    throw new functions.https.HttpsError("internal", "AI service error: " + (err.message || String(err)));
  }
});

/* ═══ ENSURE PROJECT TEMPLATE — atomically adds ALL missing standard categories in one write ═══ */
/* Called by the client on every project open; idempotent (returns fast if nothing needed). */
exports.ensureProjectTemplate = functions.runWith({ memory: "512MB" }).https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required.");
  const email = (context.auth.token.email || "").toLowerCase();
  const callerSnap = await db.ref(`users/${context.auth.uid}`).once("value");
  const caller = callerSnap.val();
  const instUser = email.endsWith("@instrumental.com") || caller?.role === "admin" || caller?.superAdmin;
  if (!instUser) throw new functions.https.HttpsError("permission-denied", "Instrumental users only.");

  const { projectId } = data || {};
  if (!projectId) throw new functions.https.HttpsError("invalid-argument", "projectId required.");

  const [projectSnap, detailsSnap] = await Promise.all([
    db.ref(`appState/projects/${projectId}`).once("value"),
    db.ref(`appState/docData/${projectId}/projectDetails`).once("value"),
  ]);
  const project = projectSnap.val();
  if (!project) return { skipped: true, reason: "project_not_found" };

  const raw = detailsSnap.val();
  const existingArr = Array.isArray(raw) ? raw
    : (raw && typeof raw === "object" ? Object.values(raw) : []);
  let workingArr = existingArr.filter(Boolean);
  let needsWrite = false;

  // Remove legacy pd_hw folder
  if (workingArr.some(c => c.id === "pd_hw")) {
    workingArr = workingArr.filter(c => c.id !== "pd_hw");
    needsWrite = true;
  }

  // Add any missing standard categories
  const workingIds = new Set(workingArr.map(c => c.id));
  const toAdd = [];
  TABLE_TEMPLATES.forEach(t => { if (!workingIds.has(t.id)) toAdd.push(JSON.parse(JSON.stringify(t))); });
  if (!workingIds.has("pd_deployment_requirements"))
    toAdd.push(JSON.parse(JSON.stringify(DEPLOYMENT_REQUIREMENTS_FOLDER)));
  if (!workingIds.has("pd_reference_info"))
    toAdd.push({ id: "pd_reference_info", name: "Reference Info", type: "folder", accessLevel: "open", items: [] });
  // v4.5.8: ensure pd_cad + pd_meeting_notes appear on every project, even ones that pre-date them
  // or have no HubSpot data yet. Lets users author notes from the app on any project.
  if (!workingIds.has("pd_cad"))
    toAdd.push({ id: "pd_cad", name: "CAD & Drawings", accessLevel: "open", items: [] });
  if (!workingIds.has("pd_meeting_notes"))
    toAdd.push({ id: "pd_meeting_notes", name: "Meeting Notes", type: "notes", accessLevel: "open", items: [] });
  if (!workingArr.some(c => c?.type === "checklist")) {
    const useSI = project.hubspotPipelineId === SI_PARTNER_PIPELINE_ID;
    buildProjectDetails(useSI).filter(c => c.type === "checklist").forEach(c => toAdd.push(c));
  }

  if (toAdd.length === 0 && !needsWrite) return { added: false, reason: "already_complete" };

  const finalArr = [...workingArr, ...toAdd];
  await db.ref(`appState/docData/${projectId}/projectDetails`).set(sanitizeForFirebase(finalArr));
  console.log(`ensureProjectTemplate: updated ${projectId} — migrated:${needsWrite} added:${toAdd.map(t => t.id).join(",")}`);
  return { added: true, migrated: needsWrite, count: toAdd.length, ids: toAdd.map(t => t.id) };
});

/* ═══ BACKFILL DEPLOYMENT DOCS — adds missing standard categories to all existing projects ═══ */
exports.backfillDeploymentDocs = functions.runWith({ memory: "1GB", timeoutSeconds: 300 }).https.onCall(async (_data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required.");
  const callerSnap = await db.ref(`users/${context.auth.uid}`).once("value");
  const caller = callerSnap.val();
  if (caller?.role !== "admin" && !caller?.superAdmin) throw new functions.https.HttpsError("permission-denied", "Admin only.");

  const projectsSnap = await db.ref("appState/projects").once("value");
  const projects = projectsSnap.val() || {};
  const pids = Object.keys(projects);

  let updated = 0, skipped = 0, errors = 0;
  for (const pid of pids) {
    try {
      const detailsSnap = await db.ref(`appState/docData/${pid}/projectDetails`).once("value");
      const existing = detailsSnap.val();
      if (!Array.isArray(existing)) { skipped++; continue; }

      let workArr = existing.filter(Boolean);
      let changed = false;

      // Remove legacy pd_hw folder
      if (workArr.some(c => c.id === "pd_hw")) {
        workArr = workArr.filter(c => c.id !== "pd_hw");
        changed = true;
      }

      const workIds = new Set(workArr.map(c => c.id));
      const toAdd = [];
      TABLE_TEMPLATES.forEach(t => { if (!workIds.has(t.id)) toAdd.push(JSON.parse(JSON.stringify(t))); });
      if (!workIds.has("pd_deployment_requirements")) toAdd.push(JSON.parse(JSON.stringify(DEPLOYMENT_REQUIREMENTS_FOLDER)));
      if (!workIds.has("pd_reference_info")) toAdd.push({ id: "pd_reference_info", name: "Reference Info", type: "folder", accessLevel: "open", items: [] });
      // v4.5.8: ensure pd_cad + pd_meeting_notes on every project (admin-triggered backfill)
      if (!workIds.has("pd_cad")) toAdd.push({ id: "pd_cad", name: "CAD & Drawings", accessLevel: "open", items: [] });
      if (!workIds.has("pd_meeting_notes")) toAdd.push({ id: "pd_meeting_notes", name: "Meeting Notes", type: "notes", accessLevel: "open", items: [] });

      if (toAdd.length === 0 && !changed) { skipped++; continue; }
      await db.ref(`appState/docData/${pid}/projectDetails`).set([...workArr, ...toAdd]);
      updated++;
    } catch (e) {
      console.error(`backfillDeploymentDocs: error on ${pid}:`, e.message);
      errors++;
    }
  }

  const summary = { ranAt: new Date().toISOString(), total: pids.length, updated, skipped, errors };
  await db.ref("maintenance/lastBackfill").set(summary);
  console.log("backfillDeploymentDocs complete:", summary);
  return summary;
});

/* ═══ SCHEDULED MAINTENANCE — v4.1.0: Tue & Fri 3pm PT (1 hr before HubSpot sync) ═══ */

async function runMaintenance() {
  const startedAt = Date.now();
  const now = new Date();
  const tasks = [];
  const alerts = [];

  // 1 — Sweep hubspotSync/log: delete entries older than 30 days
  try {
    const cutoff30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const logSnap = await db.ref("hubspotSync/log").orderByChild("startedAt").endAt(cutoff30).once("value");
    const stale = logSnap.val() || {};
    const staleKeys = Object.keys(stale);
    await Promise.all(staleKeys.map(k => db.ref(`hubspotSync/log/${k}`).remove()));
    tasks.push({ name: "sweep_sync_log", deleted: staleKeys.length });
  } catch (e) { tasks.push({ name: "sweep_sync_log", error: e.message }); }

  // 2 — Sweep auditLog: delete entries older than 90 days
  try {
    const cutoff90 = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    const auditSnap = await db.ref("auditLog").orderByChild("ts").endAt(cutoff90).once("value");
    const stale = auditSnap.val() || {};
    const staleKeys = Object.keys(stale);
    await Promise.all(staleKeys.map(k => db.ref(`auditLog/${k}`).remove()));
    tasks.push({ name: "sweep_audit_log", deleted: staleKeys.length });
  } catch (e) { tasks.push({ name: "sweep_audit_log", error: e.message }); }

  // 3 — Sweep hubspotWriteback/log: delete entries older than 30 days
  try {
    const cutoff30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const wbSnap = await db.ref("hubspotWriteback/log").orderByChild("ts").endAt(cutoff30).once("value");
    const stale = wbSnap.val() || {};
    const staleKeys = Object.keys(stale);
    await Promise.all(staleKeys.map(k => db.ref(`hubspotWriteback/log/${k}`).remove()));
    tasks.push({ name: "sweep_writeback_log", deleted: staleKeys.length });
  } catch (e) { tasks.push({ name: "sweep_writeback_log", error: e.message }); }

  // 4 — Rule 1: bug count threshold (> 2 open bugs in current version → alert)
  try {
    const bugsSnap = await db.ref("bugs/log").orderByChild("status").equalTo("open").once("value");
    const bugs = Object.values(bugsSnap.val() || {});
    if (bugs.length > 2) {
      const alert = { rule: "bug_count_threshold", severity: "warn", message: `${bugs.length} open bugs logged — review and resolve.`, firedAt: now.toISOString() };
      alerts.push(alert);
      await db.ref("maintenance/alerts/bugCount").set(alert);
    } else {
      await db.ref("maintenance/alerts/bugCount").remove();
    }
    tasks.push({ name: "rule_bug_count", openBugs: bugs.length, alerted: bugs.length > 2 });
  } catch (e) { tasks.push({ name: "rule_bug_count", error: e.message }); }

  // 5 — Rule 2: sync error rate (> 10% of syncs in last 24 h have state="error")
  try {
    const cutoff24 = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const recentSnap = await db.ref("hubspotSync/log").orderByChild("startedAt").startAt(cutoff24).once("value");
    const recent = Object.values(recentSnap.val() || {});
    const errorCount = recent.filter(e => e.state === "error").length;
    const errorRate = recent.length > 0 ? errorCount / recent.length : 0;
    if (errorRate > 0.1) {
      const alert = { rule: "sync_error_rate", severity: "warn", message: `${Math.round(errorRate * 100)}% of syncs in last 24h errored (${errorCount}/${recent.length}). Consider pausing scheduled sync.`, firedAt: now.toISOString() };
      alerts.push(alert);
      await db.ref("maintenance/alerts/syncErrorRate").set(alert);
    } else {
      await db.ref("maintenance/alerts/syncErrorRate").remove();
    }
    tasks.push({ name: "rule_sync_error_rate", rate: Math.round(errorRate * 100), alerted: errorRate > 0.1 });
  } catch (e) { tasks.push({ name: "rule_sync_error_rate", error: e.message }); }

  // 6 — Rule 3: sync failure circuit breaker (3 consecutive scheduled syncs failed → pause)
  try {
    const pausedSnap = await db.ref("hubspotSync/paused").once("value");
    if (!pausedSnap.val()) {
      const recentSnap = await db.ref("hubspotSync/log")
        .orderByChild("type").equalTo("scheduled").limitToLast(3).once("value");
      const recent = Object.values(recentSnap.val() || {}).sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
      const allFailed = recent.length === 3 && recent.every(e => e.state === "error");
      if (allFailed) {
        await db.ref("hubspotSync/paused").set(true);
        const alert = { rule: "sync_circuit_breaker", severity: "critical", message: "3 consecutive scheduled syncs failed — auto-paused. Re-enable manually in Admin Panel → HubSpot Sync.", firedAt: now.toISOString() };
        alerts.push(alert);
        await db.ref("maintenance/alerts/circuitBreaker").set(alert);
      } else {
        await db.ref("maintenance/alerts/circuitBreaker").remove();
      }
      tasks.push({ name: "rule_circuit_breaker", consecutive: recent.length, tripped: allFailed });
    } else {
      tasks.push({ name: "rule_circuit_breaker", skipped: "already paused" });
    }
  } catch (e) { tasks.push({ name: "rule_circuit_breaker", error: e.message }); }

  const result = {
    ranAt: now.toISOString(),
    durationMs: Date.now() - startedAt,
    tasksCompleted: tasks.filter(t => !t.error).length,
    totalTasks: tasks.length,
    alerts: alerts.length,
    tasks,
    alertList: alerts,
  };
  await db.ref("maintenance/lastRun").set(result);
  console.log("scheduledMaintenance complete:", result);
  return result;
}

exports.scheduledMaintenance = functions.runWith({ memory: "256MB" }).pubsub
  .schedule("0 15 * * 2,5")
  .timeZone("America/Los_Angeles")
  .onRun(async () => { await runMaintenance(); });

// Manual trigger — admin only, callable from Admin Panel
exports.runMaintenanceNow = functions.runWith({ memory: "256MB" }).https.onCall(async (_data, context) => {
  await requireAdmin(context);
  return await runMaintenance();
});

/* ═══════════════════════════════════════════════════════════════════════
   SI Tracker — Anthropic-backed parsers
   ═══════════════════════════════════════════════════════════════════════

   Two callable Functions used by the All SI Projects view:

   • aiSIParseTimelineImport — takes a vendor file (PDF / text base64),
     calls Claude with the project's current stage dates as context, and
     returns proposed date changes ready for the user to approve.

   • aiSIParseCoverageDoc — takes a coverage doc (PDF / xlsx text export),
     calls Claude with the 7-section SIRD questionnaire, and returns
     suggested answers per question id.

   Configuration:
     firebase functions:config:set anthropic.key="sk-ant-..."
     firebase deploy --only functions

   Both endpoints require admin or instrumental-party auth. */

async function requireSIWrite(context) {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const snap = await db.ref(`users/${context.auth.uid}`).once("value");
  const u = snap.val() || {};
  if (u.role !== "admin" && u.role !== "si_admin" && u.partyId !== "instrumental") {
    throw new functions.https.HttpsError("permission-denied", "Admin / SI admin / Instrumental party only.");
  }
  return u;
}

function getAnthropicClient() {
  const cfg = (functions.config().anthropic || {});
  const key = cfg.key || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "ANTHROPIC_API_KEY not configured. Run: firebase functions:config:set anthropic.key=\"sk-ant-...\" then redeploy."
    );
  }
  // Lazy require so cold-start of unrelated functions stays fast.
  const Anthropic = require("@anthropic-ai/sdk");
  return new Anthropic({ apiKey: key });
}

// Helper: build the Claude content block for a document. PDF goes as a
// `document` content block; plain text goes as a text block.
function buildDocBlock({ fileBase64, mimeType, fileName }) {
  if (!fileBase64) throw new functions.https.HttpsError("invalid-argument", "fileBase64 is required.");
  if (mimeType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 }};
  }
  // For txt / csv / xlsx-text-export, decode base64 → utf-8 string and send as text.
  try {
    const text = Buffer.from(fileBase64, "base64").toString("utf-8");
    return { type: "text", text: `[File: ${fileName || "unknown"}]\n\n${text}` };
  } catch (e) {
    throw new functions.https.HttpsError("invalid-argument", `Could not decode file: ${e.message}`);
  }
}

exports.aiSIParseTimelineImport = functions.runWith({ memory: "512MB", timeoutSeconds: 60 })
  .https.onCall(async (data, context) => {
    await requireSIWrite(context);
    const { fileBase64, mimeType, fileName, currentStageDates, stages } = data || {};
    const client = getAnthropicClient();
    const stageList = (stages && stages.length) ? stages : ["SIRD","DFM","Quote","PO","Build","FAT","In Transit","SAT","Live"];
    const systemPrompt = (
      "You're a project-timeline parser. Given a vendor's schedule file, extract proposed start/end dates per stage. " +
      "Only emit a change if the file evidence clearly indicates a different date than what's currently stored. " +
      "Stages are: " + stageList.join(", ") + ". " +
      "Return STRICT JSON only — no commentary, no prose. Schema: " +
      "{ \"changes\": [ { \"stage\": <stage>, \"field\": \"planned_start\"|\"planned_end\"|\"actual_start\"|\"actual_end\", \"new_value\": \"YYYY-MM-DD\", \"evidence\": <short quote from the file> } ] }"
    );
    const userBlocks = [
      buildDocBlock({ fileBase64, mimeType, fileName }),
      { type: "text", text: "Current stage dates on record (JSON):\n" + JSON.stringify(currentStageDates || {}, null, 2) +
        "\n\nReturn proposed changes vs. what's on record. JSON only." },
    ];
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userBlocks }],
    });
    const raw = (resp.content || []).map(b => b.type === "text" ? b.text : "").join("\n").trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new functions.https.HttpsError("internal", "Claude returned non-JSON: " + raw.slice(0, 200));
      parsed = JSON.parse(m[0]);
    }
    return { changes: Array.isArray(parsed?.changes) ? parsed.changes : [] };
  });

exports.aiSIParseCoverageDoc = functions.runWith({ memory: "512MB", timeoutSeconds: 60 })
  .https.onCall(async (data, context) => {
    await requireSIWrite(context);
    const { fileBase64, mimeType, fileName, questionnaire } = data || {};
    const client = getAnthropicClient();
    if (!Array.isArray(questionnaire)) {
      throw new functions.https.HttpsError("invalid-argument", "questionnaire (array of {id,label}) is required.");
    }
    const systemPrompt = (
      "You're an inspection-project SIRD assistant. Given a coverage document, extract suggested answers " +
      "for the SIRD questionnaire fields. Only suggest answers where the document provides clear evidence. " +
      "Return STRICT JSON only — no commentary. Schema: " +
      "{ \"suggestions\": { <questionId>: { \"value\": <suggested answer string>, \"evidence\": <short quote> } } }"
    );
    const qList = questionnaire.map(q => `- ${q.id}: ${q.label}`).join("\n");
    const userBlocks = [
      buildDocBlock({ fileBase64, mimeType, fileName }),
      { type: "text", text: `SIRD questionnaire fields:\n${qList}\n\nReturn suggestions JSON only.` },
    ];
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: "user", content: userBlocks }],
    });
    const raw = (resp.content || []).map(b => b.type === "text" ? b.text : "").join("\n").trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new functions.https.HttpsError("internal", "Claude returned non-JSON: " + raw.slice(0, 200));
      parsed = JSON.parse(m[0]);
    }
    return { suggestions: parsed?.suggestions || {} };
  });

