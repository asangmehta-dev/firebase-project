/* ═══ HUBSPOT CONFIG — pipelines, stages, codename map ═══ */

export const HUBSPOT_OBJECT_TYPE = "2-39524389";

export const PIPELINES = {
  "680801112": { label: "Hardware Deployment Pipeline", short: "Deploy", order: 0 },
  "680446891": { label: "Data Source Deployment Pipeline", short: "Data Source", order: 1 },
  "679446421": { label: "MES Integration Pipeline", short: "MES", order: 2 },
  "682405760": { label: "Station Return", short: "Return", order: 3 },
  "684527408": { label: "Image Source Deployment Pipeline", short: "Image Source", order: 4 },
  "1919898345": { label: "Data Analytics", short: "Analytics", order: 5 },
};

export const PIPELINE_LIST = Object.entries(PIPELINES)
  .sort((a, b) => a[1].order - b[1].order)
  .map(([id, p]) => ({ id, ...p }));

export const STAGES = {
  // Hardware Deployment Pipeline
  "1053337914": { label: "Deal SG6/7 Pipeline", closed: false, order: 0, pipelineId: "680801112" },
  "997715736":  { label: "Kickoff", closed: false, order: 1, pipelineId: "680801112" },
  "999736172":  { label: "Scope Verify w/Customer", closed: false, order: 2, pipelineId: "680801112" },
  "1067748453": { label: "Design Queue", closed: false, order: 3, pipelineId: "680801112" },
  "997715738":  { label: "InProgress Station/Nest Design", closed: false, order: 4, pipelineId: "680801112" },
  "997715739":  { label: "Awaiting Nest Approval", closed: false, order: 5, pipelineId: "680801112" },
  "997715740":  { label: "Station Configuration", closed: false, order: 6, pipelineId: "680801112" },
  "997715741":  { label: "Shipment & Logistics", closed: false, order: 7, pipelineId: "680801112" },
  "997715742":  { label: "Setup & Verification", closed: false, order: 8, pipelineId: "680801112" },
  "997715743":  { label: "First Image in App", closed: false, order: 9, pipelineId: "680801112" },
  "997715737":  { label: "Complete-Project/Deployment", closed: true, order: 10, pipelineId: "680801112" },
  "1053255817": { label: "Cancel-Project/Deployment", closed: true, order: 11, pipelineId: "680801112" },
  "3118657221": { label: "Pre-Deal Lost", closed: true, order: 12, pipelineId: "680801112" },
  // Data Source Deployment Pipeline
  "997709588": { label: "Scope Reviewed w/Customer", closed: false, order: 0, pipelineId: "680446891" },
  "997549163": { label: "Scope Validated", closed: false, order: 1, pipelineId: "680446891" },
  "997549164": { label: "S3 Bucket & Test PRJ Creation", closed: false, order: 2, pipelineId: "680446891" },
  "997549165": { label: "Sample Data Received", closed: false, order: 3, pipelineId: "680446891" },
  "997549166": { label: "Test Data Uploaded", closed: false, order: 4, pipelineId: "680446891" },
  "997549167": { label: "Test Data Verified", closed: false, order: 5, pipelineId: "680446891" },
  "997549168": { label: "Data Upload to Final Project", closed: false, order: 6, pipelineId: "680446891" },
  "997549169": { label: "Data Upload Automated", closed: false, order: 7, pipelineId: "680446891" },
  "997709589": { label: "Project Complete", closed: true, order: 8, pipelineId: "680446891" },
  // MES Integration Pipeline
  "997780264": { label: "MES Questionnaire Share w/CM", closed: false, order: 0, pipelineId: "679446421" },
  "997677454": { label: "CM MES Spec Received", closed: false, order: 1, pipelineId: "679446421" },
  "997677455": { label: "CM MES API Validated", closed: false, order: 2, pipelineId: "679446421" },
  "997677456": { label: "MES Implementation", closed: false, order: 3, pipelineId: "679446421" },
  "997677457": { label: "MES Test", closed: false, order: 4, pipelineId: "679446421" },
  "997677458": { label: "MES Routing Enforcement", closed: false, order: 5, pipelineId: "679446421" },
  "997780265": { label: "Project Complete", closed: true, order: 6, pipelineId: "679446421" },
  // Station Return
  "999818661": { label: "Send Shipment & Packaging Info to CM", closed: false, order: 0, pipelineId: "682405760" },
  "999761080": { label: "Station Shipped to Inst", closed: false, order: 1, pipelineId: "682405760" },
  "999761081": { label: "Station Components Verified", closed: false, order: 2, pipelineId: "682405760" },
  "999761152": { label: "Station Kits Returned", closed: false, order: 3, pipelineId: "682405760" },
  "999818662": { label: "Project Complete", closed: true, order: 4, pipelineId: "682405760" },
  // Image Source Deployment Pipeline
  "1002465694": { label: "Scope Reviewed w/Customer", closed: false, order: 0, pipelineId: "684527408" },
  "1002419978": { label: "Scope Validated", closed: false, order: 1, pipelineId: "684527408" },
  "1002419979": { label: "S3 Bucket & Test PRJ Creation", closed: false, order: 2, pipelineId: "684527408" },
  "1002419980": { label: "Sample Data Received", closed: false, order: 3, pipelineId: "684527408" },
  "1002419981": { label: "Test Data Uploaded", closed: false, order: 4, pipelineId: "684527408" },
  "1002419982": { label: "Test Data Verified", closed: false, order: 5, pipelineId: "684527408" },
  "1002419983": { label: "Data Upload to Final Project", closed: false, order: 6, pipelineId: "684527408" },
  "1002419984": { label: "Data Upload Automated", closed: false, order: 7, pipelineId: "684527408" },
  "1002465695": { label: "Project Complete", closed: true, order: 8, pipelineId: "684527408" },
  // Data Analytics
  "3040887544": { label: "Ideation", closed: false, order: 0, pipelineId: "1919898345" },
  "3039176431": { label: "Kick-off", closed: false, order: 1, pipelineId: "1919898345" },
  "3039176432": { label: "In Progress", closed: false, order: 2, pipelineId: "1919898345" },
  "3040887545": { label: "Completed", closed: true, order: 3, pipelineId: "1919898345" },
};

export const CODENAME_MAP = {
  "allsorts": "Aescape",
  "altoids": "Alta Motors",
  "toffee/rolo parent": "Amazon",
  "abba-zaba": "Anduril Industries",
  "atomic fireball": "Apple",
  "almond joy": "Arista",
  "andes": "August, Inc.",
  "aero": "Axon",
  "bonbon": "Backbone",
  "baby ruth": "Bang & Olufsen",
  "starburst": "Block, Inc.",
  "butterfingers": "Bose",
  "coffee crisp": "Carbon Revolution",
  "cachou": "Cerebras Systems",
  "crunch bar": "ChargePoint",
  "mamba": "Meraki / CISCO",
  "cherry pie": "Cora (Wisk Aero)",
  "cotton candy": "Cruise Automation",
  "donut": "DJI",
  "eclipse": "Eargo",
  "eclair": "Ecobee",
  "toffee": "Eero",
  "espresso": "Empatica",
  "xigua": "Exponent",
  "fanta": "F5",
  "fortune cookie": "Fitbit",
  "flan": "FLIR Systems",
  "flanby": "Flock Safety",
  "fruit stripe": "Fossil",
  "gummybear": "Glowforge",
  "gobstoppers": "Google",
  "gumdrop": "GoPro",
  "gelato": "Gridware",
  "haribo": "Henkel",
  "hbo": "Honeywell",
  "hot tamale": "Humane",
  "icee": "Intuitive Surgical",
  "jelly belly": "Jabil",
  "juicy fruit": "Juul Labs",
  "keebler": "Keysight Technologies",
  "key lime pie": "Kitty Hawk",
  "knish": "KNS",
  "lot 100": "L3Harris Technologies",
  "airheads": "Lab 126 (Amazon)",
  "life savers": "Lenovo",
  "licorice": "Light",
  "lemondrop": "Logitech",
  "laffy taffy": "Lutron Electronics",
  "m&m's": "Mabe",
  "milkyway": "Meraki (POC)",
  "fundip": "Meta",
  "mars": "Microsoft",
  "mike n ike": "Microtek",
  "mentos": "Motorola Mobility",
  "mint": "Motorola Solutions",
  "nilla": "Nest",
  "necco": "Netgear",
  "forrest gump": "Nike",
  "nougat": "Nokia / Withings",
  "nerds": "NVIDIA Data Centers",
  "oreo": "Oculus",
  "otter pops": "Opal Camera",
  "opera": "OURA",
  "orbit": "Owletcare",
  "pez": "P2i",
  "kitkat": "Pearl Auto",
  "peeps": "Peloton",
  "pop rocks": "Poly",
  "pop tarts": "Puffco",
  "quality street": "QSC Audio Products",
  "reese's": "Razer",
  "rolo": "Ring",
  "razzle": "Rocket EMS",
  "smarties": "Seacomp",
  "skor": "Sesame AI",
  "snickers": "Snap",
  "sweetarts": "Softmatter",
  "sour patch kids": "SolarEdge",
  "spearmint": "Spellman High Voltage",
  "spree": "Spire",
  "sunnyhills": "Supermicro",
  "toblerone": "Tesla",
  "twizzlers": "Toast",
  "tribala": "Tractian",
  "violet crumble": "Valve",
  "vanilla": "Velodyne",
  "viennetta": "View",
  "warheads": "Whirlpool",
  "whoppers": "Whoop",
  "skittles": "Xylem (Sensus)",
  "zingers": "Zebra Technologies",
  "zero": "ZT Systems",
  "zots": "Zwift",
};

export function decodeCodename(codename) {
  if (!codename) return null;
  return CODENAME_MAP[codename.trim().toLowerCase()] || null;
}

export function extractStationsFromName(name) {
  if (!name) return null;
  const patterns = [
    /(\d+)\s*station\s*kit/i,
    /(\d+)\s*stations?/i,
    /(\d+)st\b/i,
    /\bx(\d+)\b/i,
  ];
  for (const p of patterns) {
    const m = name.match(p);
    if (m) return parseInt(m[1]);
  }
  return null;
}
