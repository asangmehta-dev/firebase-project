import { useState, useEffect, useCallback } from "react";
import { auth, db, functions, googleProvider } from "./firebase";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { ref, onValue, set } from "firebase/database";
import { httpsCallable } from "firebase/functions";
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
const HW_TYPES = ["Camera", "Lens", "Station Computer"];
const SI_PIPELINE_STAGES = [
  { id: "sird_drafting", label: "SIRD Drafting", color: "#00C9A7" },
  { id: "sird_approved", label: "SIRD Approved", color: "#3B82F6" },
  { id: "dfm_si", label: "DFM (SI)", color: "#F59E0B" },
  { id: "dfm_approved", label: "DFM Approved", color: "#A855F7" },
  { id: "quote_received", label: "Quote Received", color: "#0284C7" },
  { id: "quote_approved", label: "Quote Approved", color: "#DC2626" },
  { id: "po_issued", label: "PO Issued", color: "#64748B" },
  { id: "build", label: "Build", color: "#059669" },
  { id: "fat", label: "FAT", color: "#F59E0B" },
  { id: "shipped", label: "Shipped", color: "#3B82F6" },
  { id: "sat", label: "SAT", color: "#A855F7" },
  { id: "warranty", label: "Warranty / Legal", color: "#DC2626" },
  { id: "complete", label: "Deployment Complete", color: "#059669" },
];
const SEED_PROJECTS = [
  { id: "proj_nvidia_1", name: "NVIDIA — HGX B200 Inspection", customer: "NVIDIA", status: "active", stations: 0, isSI: true },
  { id: "proj_aws_1", name: "AWS — Trainium Board QC", customer: "AWS", status: "active", stations: 0, isSI: false },
];
/* v3.2.0: Default project-details folders (applied to new projects). Checklist templates come from Cloud Functions. */
const DEFAULT_PROJECT_DETAILS = [
  { id: "pd_hw", name: "Hardware & MES Deployments", accessLevel: "open", items: [] },
  { id: "pd_specs", name: "Design Specifications & Integration Docs", accessLevel: "open", items: [] },
  { id: "pd_program", name: "Program Details & Timelines", accessLevel: "open", items: [], type: "program" },
  { id: "pd_cad", name: "CAD & Drawings", accessLevel: "open", items: [] },
];
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
const getProjectDetails = (dd, pid) => dd?.[pid]?.projectDetails || DEFAULT_PROJECT_DETAILS;
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
function Sidebar({ view, setView, user, project, projects, setProject, onLogout, lang, setLang, hasCommercialAccess }) {
  const admin = isInst(user);
  const dropdownProjects = admin ? projects.filter(p => p.status !== "inactive") : projects.filter(p => p.status === "active");
  const [projSearch, setProjSearch] = useState("");
  const filteredProjects = projSearch.trim() ? dropdownProjects.filter(p => p.name.toLowerCase().includes(projSearch.trim().toLowerCase())) : dropdownProjects;
  const navActive = (v) => view === v ? { background: "rgba(255,255,255,.1)", color: "#F1F5F9", borderLeftColor: "#00C9A7" } : {};
  return (
    <aside style={S.side}>
      <div style={S.sideHead}><span style={{ fontSize: 24, color: "#00C9A7" }}>◎</span><span style={S.sideTitle}>{t("Deployment Portal", lang)}</span></div>
      {/* All Projects Overview — large font, admin/instrumental only */}
      {admin && (
        <div style={{ padding: "0 12px 6px" }}>
          <button onClick={() => setView("projects_overview")} style={{ ...S.navBtn, fontSize: 20, fontWeight: 800, padding: "16px 16px", ...(view === "projects_overview" ? { background: "rgba(0,201,167,.15)", color: "#00C9A7", borderLeftColor: "#00C9A7" } : {}) }}>🌐 All Projects Overview</button>
        </div>
      )}
      {/* Project dropdown with search */}
      <div style={{ padding: "0 18px 12px" }}>
        <label style={S.sideLabel}>{t("Project", lang)}</label>
        <input style={{ ...S.projSelect, marginBottom: 6, padding: "8px 12px", fontSize: 12 }} placeholder="Search projects..." value={projSearch} onChange={e => setProjSearch(e.target.value)} />
        <select style={S.projSelect} value={project?.id || ""} onChange={e => { setProject(filteredProjects.find(p => p.id === e.target.value) || dropdownProjects.find(p => p.id === e.target.value)); setProjSearch(""); }}>
          {filteredProjects.length === 0 && <option value="">No projects{projSearch ? " matching search" : ""}</option>}
          {filteredProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.status === "deprecated" ? " (Past)" : ""}</option>)}
        </select>
      </div>
      <nav style={S.navList}>
        {/* Overview — slightly bigger font */}
        <button onClick={() => setView("dashboard")} style={{ ...S.navBtn, fontSize: 17, fontWeight: 600, ...navActive("dashboard") }}>{"⊙ " + t("Overview", lang)}</button>
        <div style={S.divider} />
        {/* Project Details */}
        <button onClick={() => setView("project_details")} style={{ ...S.navBtn, ...navActive("project_details") }}>📋 Project Details</button>
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

  // External users — simplified dashboard (station count + milestones)
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
        {progMilestones.length > 0 && (
          <div style={{ ...S.card, marginTop: 12, borderTop: "3px solid #F59E0B" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 10 }}>{t("Key Milestones", lang)}</div>
            {progMilestones.map(m => (
              <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F1F5F9" }}>
                <span style={{ fontSize: 14, fontFamily: F, color: "#1E293B" }}>🏁 {m.name}</span>
                <span style={{ fontSize: 13, color: "#64748B", fontFamily: F }}>{fmtDay(m.date)}</span>
              </div>
            ))}
          </div>
        )}
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

      <h2 style={S.h2}>{project.name}</h2>
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

      {/* External view preview — station count + milestones */}
      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 12, paddingBottom: 8, borderBottom: "2px solid #F1F5F9" }}>External User View</div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ ...S.card, flex: "1 1 160px", borderTop: "3px solid #F59E0B" }}>
            <div style={{ fontSize: 14, color: "#64748B", fontFamily: F, marginBottom: 6 }}>Stations</div>
            <div style={{ fontSize: 42, fontWeight: 800, color: "#0F172A", fontFamily: F }}>{project.stations || 0}</div>
            <div style={{ fontSize: 13, color: "#94A3B8", fontFamily: F }}>inspection stations for this project</div>
          </div>
          <div style={{ ...S.card, flex: "1 1 300px", borderTop: "3px solid #F59E0B" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 10 }}>Key Milestones</div>
            {progMilestones.length > 0
              ? progMilestones.map(m => (
                <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F1F5F9" }}>
                  <span style={{ fontSize: 14, fontFamily: F, color: "#1E293B" }}>🏁 {m.name}</span>
                  <span style={{ fontSize: 13, color: "#64748B", fontFamily: F }}>{fmtDay(m.date)}</span>
                </div>
              ))
              : <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>Add milestones in Program Details to display here</div>}
          </div>
        </div>
      </div>

      {/* Hardware — HubSpot-synced (read-only) + Custom manual entries */}
      {/* Gantt chart — visible for all projects with dates */}
      <GanttChart project={project} state={state} />

      {/* SI-specific details */}
      {project.isSI && (
        <div style={{ ...S.card, marginTop: 16, borderLeft: "3px solid #3B82F6" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#3B82F6", fontFamily: F, marginBottom: 8 }}>SI Deployment Details</div>
          <div style={S.miniStat}><span>SI Pipeline Stage</span><strong>{SI_PIPELINE_STAGES.find(s => s.id === (project.siStage || "sird_drafting"))?.label || "SIRD Drafting"}</strong></div>
          <div style={S.miniStat}><span>Checklist Completion</span><strong>{(() => { const cats = getProjectDetails(state.docData, project.id); const all = cats.filter(c => c.type === "checklist").flatMap(c => (c.milestones||[]).flatMap(ms => ms.checklist||[])); const active = all.filter(ck => !ck.na); const done = active.filter(ck => ck.checked); return active.length > 0 ? `${Math.round(done.length / active.length * 100)}% (${done.length}/${active.length})` : "—"; })()}</strong></div>
          <div style={S.miniStat}><span>Stations</span><strong>{project.stations || 0}</strong></div>
        </div>
      )}

      <ProjectOverviewSection project={project} state={state} setState={setState} user={user} />
      <ProjectHardwareSection project={project} state={state} setState={setState} user={user} />
    </div>
  );
}

/* ═══ PROJECT OVERVIEW SECTION — v4.0.0: 8 fields, pull-only from HubSpot, writeback in v4.1.0 ═══ */
function ProjectOverviewSection({ project, state, setState, user }) {
  const canEdit = isInst(user);
  const pid = project?.id;
  const overview = state.projectOverview?.[pid] || {};
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(overview);
  const [botLoading, setBotLoading] = useState(false);
  useEffect(() => { setDraft(overview); }, [overview, pid]);

  const save = () => {
    if (!canEdit || !pid) return;
    const next = { ...draft, updatedAt: new Date().toISOString(), updatedBy: user.name };
    setState(prev => ({ ...prev, projectOverview: { ...(prev.projectOverview||{}), [pid]: next } }));
    setEditing(false);
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
        <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F }}>Project Overview</div>
        {canEdit && !editing && <button onClick={() => setEditing(true)} style={{ padding: "4px 12px", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", cursor: "pointer", fontFamily: F, color: "#3B82F6" }}>✎ Edit</button>}
        {canEdit && editing && (
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={save} style={{ padding: "4px 12px", fontSize: 12, border: "none", borderRadius: 6, background: "#00C9A7", color: "#FFF", cursor: "pointer", fontFamily: F, fontWeight: 600 }}>Save</button>
            <button onClick={() => { setDraft(overview); setEditing(false); }} style={{ padding: "4px 12px", fontSize: 12, border: "1px solid #E2E8F0", borderRadius: 6, background: "#FFF", cursor: "pointer", fontFamily: F }}>Cancel</button>
          </div>
        )}
      </div>
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "#94A3B8", fontFamily: F, marginBottom: 10 }}>Key project dates and status. {canEdit ? "Editable fields are source-of-truth in the webapp; writeback to HubSpot arrives in v4.1.0." : ""}</div>
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

/* ═══ PROJECT DETAILS VIEW — v3.2.0 unified folders (replaces party-based DocsView) ═══ */
function ProjectDetailsView({ user, project, state, setState, lang = "en" }) {
  const canEdit = isInst(user);
  const pid = project?.id;
  const cats = getProjectDetails(state.docData, pid);
  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [addingItem, setAddingItem] = useState(null);
  const [itemForm, setItemForm] = useState({ name: "", url: "", type: "link", lang: "en" });

  if (!project) return <div style={S.page}><div style={S.empty}>Select a project from the sidebar.</div></div>;

  const updateCats = (newCats) => setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), projectDetails: newCats } } }));
  const addFolder = () => { if (!newFolderName.trim()) return; updateCats([...cats, { id: genId(), name: newFolderName.trim(), accessLevel: "open", items: [] }]); setNewFolderName(""); setAddingFolder(false); };
  const delFolder = (catId) => { if (!confirm("Delete this folder?")) return; updateCats(cats.filter(c => c.id !== catId)); };
  const addItem = (catId) => {
    if (!itemForm.name.trim()) return;
    const url = commitUrl(itemForm.url); if (url === null) return;
    const item = { id: genId(), name: itemForm.name.trim(), url, type: itemForm.type, lang: itemForm.lang, addedBy: user.name, addedAt: new Date().toISOString() };
    updateCats(cats.map(c => c.id !== catId ? c : { ...c, items: [...(c.items||[]), item] }));
    setItemForm({ name: "", url: "", type: "link", lang: "en" }); setAddingItem(null);
  };
  const delItem = (catId, itemId) => updateCats(cats.map(c => c.id !== catId ? c : { ...c, items: (c.items||[]).filter(i => i.id !== itemId) }));

  return (
    <div style={S.page}>
      <h2 style={S.h2}>Project Details</h2>
      <p style={S.sub}>{project.name} — documents, specs, checklists, and drawings.</p>

      {cats.map(cat => {
        if (cat.type === "checklist") return <ChecklistSection key={cat.id} cat={cat} cats={cats} updateCats={updateCats} user={user} canEdit={canEdit} pid={pid} lang={lang} />;
        if (cat.type === "program") return <ProgramDetailsSection key={cat.id} cat={cat} pid={pid} state={state} setState={setState} user={user} canEdit={canEdit} lang={lang} />;
        return (
          <div key={cat.id} style={{ ...S.card, marginBottom: 12, borderLeft: "3px solid #00C9A7" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{cat.name}</div>
              <Chip small color="#ECFDF5" fg="#059669">{(cat.items||[]).length} items</Chip>
            </div>
            {(cat.items||[]).map(item => (
              <div key={item.id} style={S.docItemRow}>
                <span style={{ fontSize: 14, color: item.type === "link" ? "#3B82F6" : "#A855F7" }}>{item.type === "link" ? "🔗" : "📄"}</span>
                <div style={{ flex: 1 }}>
                  {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 15, fontWeight: 500, color: "#0284C7", textDecoration: "none", fontFamily: F }}>{item.name}</a> : <span style={{ fontSize: 15, fontFamily: F }}>{item.name}</span>}
                  <div style={{ fontSize: 12, color: "#94A3B8", fontFamily: F }}>{item.addedBy} · {fmtDate(item.addedAt)}</div>
                </div>
                {canEdit && <button style={{ ...S.btnDel, padding: "3px 8px", fontSize: 11 }} onClick={() => delItem(cat.id, item.id)}>✕</button>}
              </div>
            ))}
            {(cat.items||[]).length === 0 && <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>No documents yet.</div>}
            {canEdit && pid && (
              addingItem === cat.id ? (
                <div style={{ marginTop: 12, padding: 14, background: "#F8FAFC", borderRadius: 10 }}>
                  <label style={S.lbl}>Name</label>
                  <input style={S.inp} value={itemForm.name} onChange={e => setItemForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Pin Inspection Spec v2.1" />
                  <label style={S.lbl}>URL</label>
                  <input style={S.inp} value={itemForm.url} onChange={e => setItemForm(f => ({ ...f, url: e.target.value }))} placeholder="https://..." />
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button style={{ ...S.btnMain, width: "auto", padding: "10px 18px", marginTop: 0 }} onClick={() => addItem(cat.id)}>Add</button>
                    <button style={{ ...S.btnFlat, width: "auto" }} onClick={() => { setAddingItem(null); setItemForm({ name: "", url: "", type: "link", lang: "en" }); }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button style={S.btnAddItem} onClick={() => setAddingItem(cat.id)}>+ Add Link or PDF</button>
                  <button style={{ ...S.btnDel, fontSize: 11, padding: "4px 10px" }} onClick={() => delFolder(cat.id)}>Delete Folder</button>
                </div>
              )
            )}
          </div>
        );
      })}

      {/* Hardware tracking + Validation subsections */}
      <HardwareTrackingSection project={project} state={state} setState={setState} user={user} canEdit={canEdit} />
      <ValidationSection project={project} state={state} setState={setState} user={user} canEdit={canEdit} />

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
function ChecklistSection({ cat, cats, updateCats, user, canEdit, pid, lang }) {
  const [expanded, setExpanded] = useState({});
  const toggleExpand = (msId) => setExpanded(prev => ({ ...prev, [msId]: !prev[msId] }));

  const updateMilestone = (msId, updater) => {
    updateCats(cats.map(c => c.id !== cat.id ? c : { ...c, milestones: (c.milestones||[]).map(ms => ms.id !== msId ? ms : updater(ms)) }));
  };
  const toggleCheck = (msId, ckId) => updateMilestone(msId, ms => ({ ...ms, checklist: ms.checklist.map(ck => ck.id !== ckId ? ck : { ...ck, checked: !ck.checked }) }));
  const toggleNA = (msId, ckId) => updateMilestone(msId, ms => ({ ...ms, checklist: ms.checklist.map(ck => ck.id !== ckId ? ck : { ...ck, na: !ck.na, checked: ck.na ? ck.checked : false }) }));
  const updateField = (msId, ckId, field, val) => updateMilestone(msId, ms => ({ ...ms, checklist: ms.checklist.map(ck => ck.id !== ckId ? ck : { ...ck, [field]: val }) }));
  const addItem = (msId, label) => updateMilestone(msId, ms => ({ ...ms, checklist: [...ms.checklist, { id: genId(), label, checked: false, na: false, ownership: "", startDate: null, projectedDate: null, actualDate: null, sopLink: null }] }));

  return (
    <div style={{ ...S.card, marginBottom: 12, borderLeft: "3px solid #6366F1" }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 12 }}>{cat.name}</div>
      {(cat.milestones||[]).map(ms => {
        const activeChecks = ms.checklist.filter(ck => !ck.na);
        const doneCount = activeChecks.filter(ck => ck.checked).length;
        const pct = activeChecks.length > 0 ? Math.round((doneCount / activeChecks.length) * 100) : 0;
        const isOpen = expanded[ms.id];
        return (
          <div key={ms.id} style={{ marginBottom: 10, background: "#F8FAFC", borderRadius: 12, border: "1px solid #F1F5F9", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", cursor: "pointer" }} onClick={() => toggleExpand(ms.id)}>
              <div style={{ width: 8, height: 8, borderRadius: 4, background: ms.color || "#00C9A7" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{ms.name}</div>
                {ms.description && <div style={{ fontSize: 12, color: "#64748B", fontFamily: F }}>{ms.description}</div>}
                {ms.gatedBy && <div style={{ fontSize: 11, color: "#94A3B8", fontFamily: F }}>Gated by: {ms.gatedBy}</div>}
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: pct === 100 ? "#059669" : "#64748B", fontFamily: F }}>{doneCount}/{activeChecks.length} ({pct}%)</div>
              <Bar value={pct} color={ms.color || "#00C9A7"} h={4} />
              <span style={{ fontSize: 12, color: "#94A3B8" }}>{isOpen ? "▼" : "▶"}</span>
            </div>
            {isOpen && (
              <div style={{ padding: "0 16px 12px" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, fontFamily: F }}>
                  <thead>
                    <tr>
                      <th style={{ ...S.th, fontSize: 10, padding: "6px 4px", width: 30 }}></th>
                      <th style={{ ...S.th, fontSize: 10, padding: "6px 4px" }}>Item</th>
                      <th style={{ ...S.th, fontSize: 10, padding: "6px 4px", width: 80 }}>Owner</th>
                      <th style={{ ...S.th, fontSize: 10, padding: "6px 4px", width: 90 }}>Proj. Date</th>
                      <th style={{ ...S.th, fontSize: 10, padding: "6px 4px", width: 90 }}>Actual</th>
                      <th style={{ ...S.th, fontSize: 10, padding: "6px 4px", width: 50 }}>SOP</th>
                      <th style={{ ...S.th, fontSize: 10, padding: "6px 4px", width: 40 }}>N/A</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ms.checklist.map(ck => (
                      <tr key={ck.id} style={{ opacity: ck.na ? 0.4 : 1, textDecoration: ck.na ? "line-through" : "none" }}>
                        <td style={{ ...S.td, padding: "6px 4px", textAlign: "center" }}>
                          <div onClick={() => !ck.na && (canEdit || isInst(user)) && toggleCheck(ms.id, ck.id)} style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${ck.checked ? "#00C9A7" : "#CBD5E1"}`, background: ck.checked ? "#00C9A7" : "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#FFF", fontWeight: 800, cursor: ck.na ? "default" : "pointer" }}>{ck.checked ? "✓" : ""}</div>
                        </td>
                        <td style={{ ...S.td, padding: "6px 4px", fontSize: 13 }}>{ck.label}</td>
                        <td style={{ ...S.td, padding: "6px 4px" }}>
                          {canEdit ? <input style={{ ...S.inp, padding: "2px 4px", fontSize: 11, width: "100%" }} value={ck.ownership || ""} onChange={e => updateField(ms.id, ck.id, "ownership", e.target.value)} /> : <span style={{ fontSize: 11 }}>{ck.ownership || "—"}</span>}
                        </td>
                        <td style={{ ...S.td, padding: "6px 4px" }}>
                          {canEdit ? <input type="date" style={{ ...S.inp, padding: "2px 4px", fontSize: 11, width: "100%" }} value={ck.projectedDate || ""} onChange={e => updateField(ms.id, ck.id, "projectedDate", e.target.value)} /> : <span style={{ fontSize: 11 }}>{ck.projectedDate || "—"}</span>}
                        </td>
                        <td style={{ ...S.td, padding: "6px 4px" }}>
                          {canEdit ? <input type="date" style={{ ...S.inp, padding: "2px 4px", fontSize: 11, width: "100%" }} value={ck.actualDate || ""} onChange={e => updateField(ms.id, ck.id, "actualDate", e.target.value)} /> : <span style={{ fontSize: 11 }}>{ck.actualDate || "—"}</span>}
                        </td>
                        <td style={{ ...S.td, padding: "6px 4px", textAlign: "center" }}>
                          {ck.sopLink ? <a href={ck.sopLink} target="_blank" rel="noopener noreferrer" style={{ color: "#0284C7", fontSize: 11 }}>Link</a> : (canEdit ? <input style={{ ...S.inp, padding: "2px 4px", fontSize: 11, width: "100%" }} defaultValue="" onBlur={e => { const v = e.target.value; if (!v) return; const clean = commitUrl(v); if (clean) updateField(ms.id, ck.id, "sopLink", clean); else e.target.value = ""; }} placeholder="https://..." /> : "—")}
                        </td>
                        <td style={{ ...S.td, padding: "6px 4px", textAlign: "center" }}>
                          {canEdit && <button style={{ border: "none", background: ck.na ? "#FEF3C7" : "#F1F5F9", color: ck.na ? "#D97706" : "#94A3B8", fontSize: 10, borderRadius: 4, padding: "2px 6px", cursor: "pointer", fontFamily: F }} onClick={() => toggleNA(ms.id, ck.id)}>{ck.na ? "N/A" : "—"}</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {canEdit && (() => {
                  const [newLabel, setNewLabel] = useState("");
                  return (
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <input style={{ ...S.inp, flex: 1, padding: "6px 10px", fontSize: 12 }} value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Add checklist item..." onKeyDown={e => { if (e.key === "Enter" && newLabel.trim()) { addItem(ms.id, newLabel.trim()); setNewLabel(""); } }} />
                      <button style={{ ...S.btnMain, width: "auto", padding: "6px 14px", fontSize: 12, marginTop: 0 }} onClick={() => { if (newLabel.trim()) { addItem(ms.id, newLabel.trim()); setNewLabel(""); } }}>+ Add</button>
                    </div>
                  );
                })()}
                {/* Signatures */}
                {(ms.signatures||[]).length > 0 && (
                  <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #F1F5F9" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#64748B", fontFamily: F, marginBottom: 6 }}>Signatures</div>
                    {ms.signatures.map(sig => (
                      <div key={sig.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 13, fontFamily: F }}>
                        <div onClick={() => canEdit && updateMilestone(ms.id, m => ({ ...m, signatures: m.signatures.map(s => s.id !== sig.id ? s : { ...s, signed: !s.signed, signedAt: s.signed ? null : new Date().toISOString(), name: s.signed ? "" : user.name, email: s.signed ? "" : user.email }) }))} style={{ width: 16, height: 16, borderRadius: 3, border: `2px solid ${sig.signed ? "#059669" : "#CBD5E1"}`, background: sig.signed ? "#059669" : "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#FFF", cursor: canEdit ? "pointer" : "default" }}>{sig.signed ? "✓" : ""}</div>
                        <span style={{ color: "#475569" }}>{sig.role}</span>
                        {sig.signed && <span style={{ color: "#059669", fontSize: 11 }}> — {sig.name} ({fmtDate(sig.signedAt)})</span>}
                      </div>
                    ))}
                  </div>
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
  const updateHW = (newData) => setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), _hardwareTracking: newData } } }));
  const addHW = (type) => { const serial = prompt("Serial number:"); const tag = prompt("Instrumental Asset Tag:"); if (serial) updateHW([...hwData, { id: genId(), type, serial, assetTag: tag || "" }]); };
  const delHW = (id) => updateHW(hwData.filter(h => h.id !== id));

  return (
    <div style={{ ...S.card, marginBottom: 12, marginTop: 16 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 10 }}>Hardware Tracking</div>
      {hwData.length === 0 ? <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>No hardware tracked yet.</div> : (
        <table style={{ ...S.table, fontSize: 13 }}><thead><tr><th style={S.th}>Type</th><th style={S.th}>Serial Number</th><th style={S.th}>Asset Tag</th>{canEdit && <th style={S.th}></th>}</tr></thead>
        <tbody>{hwData.map(h => (<tr key={h.id}><td style={S.td}>{h.type}</td><td style={S.td}>{h.serial}</td><td style={S.td}>{h.assetTag || "—"}</td>{canEdit && <td style={S.td}><button style={{ ...S.btnDel, fontSize: 11, padding: "2px 8px" }} onClick={() => delHW(h.id)}>✕</button></td>}</tr>))}</tbody></table>
      )}
      {canEdit && <div style={{ display: "flex", gap: 8, marginTop: 8 }}>{HW_TYPES.map(t => <button key={t} style={S.btnAddItem} onClick={() => addHW(t)}>+ {t}</button>)}</div>}
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
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <select style={{ ...S.inp, width: "auto", padding: "6px 10px", fontSize: 12 }} value={valData.fatStatus || ""} onChange={e => updateVal({ ...valData, fatStatus: e.target.value })}>
              <option value="">FAT Status...</option><option value="Not started">Not started</option><option value="In progress">In progress</option><option value="Passed">Passed</option><option value="Failed">Failed</option><option value="Conditional">Conditional</option>
            </select>
            <select style={{ ...S.inp, width: "auto", padding: "6px 10px", fontSize: 12 }} value={valData.satStatus || ""} onChange={e => updateVal({ ...valData, satStatus: e.target.value })}>
              <option value="">SAT Status...</option><option value="Not started">Not started</option><option value="In progress">In progress</option><option value="Passed">Passed</option><option value="Failed">Failed</option><option value="Conditional">Conditional</option>
            </select>
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
                <label style={S.lbl}>URL</label><input style={S.inp} value={itemForm.url} onChange={e => setItemForm(f => ({ ...f, url: e.target.value }))} placeholder="https://..." />
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button style={{ ...S.btnMain, width: "auto", padding: "10px 18px", marginTop: 0 }} onClick={() => addItem(cat.id)}>Add</button>
                  <button style={{ ...S.btnFlat, width: "auto" }} onClick={() => setAddingItem(null)}>Cancel</button>
                </div>
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
            <label style={S.lbl}>URL</label><input style={S.inp} value={matForm.url} onChange={e => setMatForm(f => ({...f, url: e.target.value}))} placeholder="https://..." />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button style={{ ...S.btnMain, width: "auto", padding: "8px 16px", marginTop: 0 }} onClick={addMaterial}>Add</button>
              <button style={{ ...S.btnFlat, width: "auto" }} onClick={() => setAddMat(false)}>Cancel</button>
            </div>
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

/* ═══ SI KANBAN — shows SI-flagged projects across SI pipeline stages ═══ */
function SIKanbanView({ projects, state, setState }) {
  const siProjects = projects.filter(p => p.isSI && p.status === "active");
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverStage, setDragOverStage] = useState(null);

  if (siProjects.length === 0) return null;

  const getStage = (proj) => proj.siStage || "sird_drafting";
  const setStage = (pid, stageId) => setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id !== pid ? p : { ...p, siStage: stageId, updatedAt: new Date().toISOString() }) }));

  const onDragStart = (e, projId) => { setDraggingId(projId); e.dataTransfer.effectAllowed = "move"; };
  const onDragEnd = () => { setDraggingId(null); setDragOverStage(null); };
  const onDragOver = (e, stageId) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverStage(stageId); };
  const onDragLeave = () => setDragOverStage(null);
  const onDrop = (e, stageId) => { e.preventDefault(); if (draggingId) setStage(draggingId, stageId); setDraggingId(null); setDragOverStage(null); };

  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ ...S.h3, marginBottom: 6 }}>SI Deployment Kanban (Active SI Projects)</h3>
      <p style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginBottom: 14 }}>Drag project cards between stages to update their position. {siProjects.length} SI project{siProjects.length !== 1 ? "s" : ""} tracked.</p>

      {/* SI Process link */}
      <a href="https://script.google.com/a/macros/instrumental.com/s/AKfycbxOAtRNRm2_-XIPPK1fPKW-O55uVtMhMZSDcdZiR4xRqRBmtYgqURhAZ8MPg3RVsvNG/exec" target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, background: "#EFF6FF", color: "#3B82F6", fontSize: 12, fontWeight: 600, textDecoration: "none", fontFamily: F, marginBottom: 14 }}>
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
  const checklistItems = pdCats.filter(c => c.type === "checklist").flatMap(c => (c.milestones||[]).flatMap(ms => ms.checklist.filter(ck => !ck.na && (ck.projectedDate || ck.actualDate)).map(ck => ({ id: ck.id, name: ck.label.substring(0, 40), start: ck.projectedDate || ck.actualDate, end: ck.actualDate || ck.projectedDate, done: ck.checked, type: "checklist" }))));
  const programTasks = tasks.map(t => ({ id: t.id, name: t.name, start: t.date, end: t.endDate || t.date, done: false, type: t.type }));
  const allItems = [...programTasks, ...checklistItems].filter(i => i.start).sort((a, b) => new Date(a.start) - new Date(b.start));

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

/* ═══ PROJECTS OVERVIEW — summary of ALL projects across pipelines ═══ */
/* Note: distinct from per-project "Overview" dashboard. This aggregates every project. */
function ProjectsOverviewView({ state, setState, user, lang = "en" }) {
  const allProjects = projectsToArray(state.projects);
  const activeProjects = allProjects.filter(p => p.status === "active");
  const [selPipeline, setSelPipeline] = useState(PIPELINE_LIST[0]?.id || "");
  const [demandExpanded, setDemandExpanded] = useState(null); // which hw row is expanded to show per-project
  const canEditDemand = isInst(user); // Any Instrumental user can add custom demand types

  // ─── Demand Plan: aggregate hardware across all ACTIVE projects ───
  const customTypes = state.demandCustomTypes || {}; // { typeId: { label, counts: { projectId: n } } }
  const hubspotTotals = HUBSPOT_HW_FIELDS.map(f => ({
    label: f.label,
    source: "HubSpot",
    total: activeProjects.reduce((sum, p) => sum + getEffectiveHwCount(p, f.key, state.docData), 0),
    perProject: activeProjects.map(p => ({ id: p.id, name: p.customer || p.name, count: getEffectiveHwCount(p, f.key, state.docData) })).filter(x => x.count > 0),
  }));
  const customTotals = Object.entries(customTypes).map(([id, t]) => ({
    id,
    label: t.label,
    source: "Manual",
    total: Object.entries(t.counts || {}).reduce((sum, [pid, n]) => {
      // only count if project is still active
      return activeProjects.some(p => p.id === pid) ? sum + (parseInt(n) || 0) : sum;
    }, 0),
  }));
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
  const pipelineCharts = PIPELINE_LIST.map(pl => {
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
  });

  // ─── Stage breakdown for selected pipeline (existing feature, active-only) ───
  const pipelineStages = Object.entries(STAGES).filter(([, s]) => s.pipelineId === selPipeline).sort((a, b) => a[1].order - b[1].order);
  const pipelineProjects = activeProjects.filter(p => p.hubspotPipelineId === selPipeline);
  const byStage = {};
  pipelineProjects.forEach(p => { const sid = p.hubspotStageId || "__none__"; (byStage[sid] = byStage[sid] || []).push(p); });
  const activeStages = pipelineStages.filter(([, s]) => !s.closed);

  const renderProjectRow = (proj) => (
    <div key={proj.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid #F8FAFC" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A", fontFamily: F }}>{proj.customer || proj.name}</div>
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

      {/* SI Kanban — only shown if there are SI projects */}
      <SIKanbanView projects={activeProjects} state={state} setState={setState} />

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

        {/* ═══ STAGE BREAKDOWN (existing, active-only) ═══ */}
        <h3 style={{ ...S.h3, marginBottom: 6 }}>Projects by Stage (Active Only)</h3>
        <p style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginBottom: 14 }}>Detailed project list per pipeline stage. Select a pipeline to drill in.</p>
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

/* ═══ MILESTONE CARD (reused from existing) ═══ */
function MilestoneCard({ milestone: ms, catId, isAdmin, projectId, onToggleCheck, onAddCheckItem, onDeleteCheckItem, onAddLink, onDeleteLink, onUpdateSignature, onToggleSignature, onAddSignature, onDeleteSignature, onUpdateDesc, onUpdateCheckLabel, lang = "en" }) {
  const [expanded, setExpanded] = useState(false);
  const [newCheck, setNewCheck] = useState("");
  const [newLinkName, setNewLinkName] = useState("");
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(ms.description || "");
  const [editingCk, setEditingCk] = useState(null);
  const [ckDraft, setCkDraft] = useState("");
  const doneCt = ms.checklist.filter(c => c.checked).length;
  const totalCt = ms.checklist.length;
  const pct = totalCt > 0 ? Math.round((doneCt / totalCt) * 100) : 0;

  return (
    <div style={{ ...S.card, marginBottom: 12, borderLeft: `3px solid ${ms.color}` }}>
      <button style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", border: "none", background: "none", cursor: "pointer", textAlign: "left", fontFamily: F, padding: 0 }} onClick={() => setExpanded(!expanded)}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{ms.name}</div>
        </div>
        <div style={{ textAlign: "right", minWidth: 60 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: ms.color }}>{pct}%</div>
          <div style={{ fontSize: 11, color: "#94A3B8" }}>{doneCt}/{totalCt}</div>
        </div>
        <span style={{ color: "#94A3B8" }}>{expanded ? "▾" : "▸"}</span>
      </button>
      {/* Description — editable by admins */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, marginBottom: 6 }}>
        {isAdmin && editingDesc ? (
          <input style={{ ...S.inp, flex: 1, fontSize: 13, padding: "4px 8px" }} value={descDraft} onChange={e => setDescDraft(e.target.value)} onBlur={() => { onUpdateDesc(catId, ms.id, descDraft); setEditingDesc(false); }} onKeyDown={e => { if (e.key === "Enter") { onUpdateDesc(catId, ms.id, descDraft); setEditingDesc(false); } if (e.key === "Escape") setEditingDesc(false); }} autoFocus />
        ) : (
          <>
            <span style={{ fontSize: 13, color: "#64748B", fontFamily: F }}>{t(ms.description, lang)}</span>
            {isAdmin && <button style={{ fontSize: 10, color: "#94A3B8", border: "none", background: "none", cursor: "pointer", padding: "0 2px", lineHeight: 1 }} onClick={() => { setDescDraft(ms.description || ""); setEditingDesc(true); }}>✎</button>}
          </>
        )}
      </div>
      <Bar value={pct} color={ms.color} h={4} />

      {expanded && (
        <div style={{ marginTop: 14 }}>
          {/* Checklist */}
          {ms.checklist.map(ck => (
            <div key={ck.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #F1F5F9" }}>
              <div onClick={() => isAdmin && onToggleCheck(catId, ms.id, ck.id)} style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${ck.checked ? ms.color : "#CBD5E1"}`, background: ck.checked ? ms.color : "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: "#FFF", cursor: isAdmin ? "pointer" : "default", flexShrink: 0 }}>{ck.checked ? "✓" : ""}</div>
              {isAdmin && editingCk === ck.id ? (
                <input style={{ ...S.inp, flex: 1, fontSize: 14, padding: "4px 8px" }} value={ckDraft} onChange={e => setCkDraft(e.target.value)} onBlur={() => { if (ckDraft.trim()) onUpdateCheckLabel(catId, ms.id, ck.id, ckDraft.trim()); setEditingCk(null); }} onKeyDown={e => { if (e.key === "Enter") { if (ckDraft.trim()) onUpdateCheckLabel(catId, ms.id, ck.id, ckDraft.trim()); setEditingCk(null); } if (e.key === "Escape") setEditingCk(null); }} autoFocus />
              ) : (
                <span style={{ flex: 1, fontSize: 14, color: "#1E293B", fontFamily: F, textDecoration: ck.checked ? "line-through" : "none", opacity: ck.checked ? .6 : 1 }}>{t(ck.label, lang)}</span>
              )}
              {isAdmin && editingCk !== ck.id && <button style={{ fontSize: 10, color: "#94A3B8", border: "none", background: "none", cursor: "pointer", padding: "0 2px", lineHeight: 1 }} onClick={() => { setCkDraft(ck.label); setEditingCk(ck.id); }}>✎</button>}
              {isAdmin && editingCk !== ck.id && <button style={{ ...S.btnDel, padding: "2px 6px", fontSize: 10 }} onClick={() => onDeleteCheckItem(catId, ms.id, ck.id)}>✕</button>}
            </div>
          ))}
          {isAdmin && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input style={{ ...S.inp, flex: 1, padding: "8px 10px", fontSize: 13 }} value={newCheck} onChange={e => setNewCheck(e.target.value)} placeholder={t("Add a checklist item...", lang)} onKeyDown={e => { if (e.key === "Enter" && newCheck.trim()) { onAddCheckItem(catId, ms.id, newCheck.trim()); setNewCheck(""); } }} />
              <button style={{ ...S.btnMain, width: "auto", padding: "8px 14px", fontSize: 12, marginTop: 0 }} onClick={() => { if (newCheck.trim()) { onAddCheckItem(catId, ms.id, newCheck.trim()); setNewCheck(""); } }}>+</button>
            </div>
          )}

          {/* Links */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#64748B", fontFamily: F, marginBottom: 6 }}>{t("Linked Resources", lang)}</div>
            {(ms.links || []).map(lk => (
              <div key={lk.id} style={S.docItemRow}>
                <span>🔗</span>
                <div style={{ flex: 1 }}>{lk.url ? <a href={lk.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, color: "#0284C7", textDecoration: "none", fontFamily: F }}>{lk.name}</a> : <span style={{ fontSize: 14, fontFamily: F }}>{lk.name}</span>}</div>
                {isAdmin && <button style={{ ...S.btnDel, padding: "2px 6px", fontSize: 10 }} onClick={() => onDeleteLink(catId, ms.id, lk.id)}>✕</button>}
              </div>
            ))}
            {isAdmin && (
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <input style={{ ...S.inp, flex: 1, padding: "6px 10px", fontSize: 12 }} value={newLinkName} onChange={e => setNewLinkName(e.target.value)} placeholder="Link name" />
                <input style={{ ...S.inp, flex: 1, padding: "6px 10px", fontSize: 12 }} value={newLinkUrl} onChange={e => setNewLinkUrl(e.target.value)} placeholder="URL" />
                <button style={{ ...S.btnMain, width: "auto", padding: "6px 12px", fontSize: 12, marginTop: 0 }} onClick={() => { if (newLinkName.trim()) { onAddLink(catId, ms.id, newLinkName.trim(), newLinkUrl.trim()); setNewLinkName(""); setNewLinkUrl(""); } }}>+</button>
              </div>
            )}
          </div>

          {/* Signatures */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#64748B", fontFamily: F, marginBottom: 6 }}>{t("Signatures", lang)}</div>
            {(ms.signatures || []).map(sig => (
              <div key={sig.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid #F8FAFC" }}>
                <span style={{ fontSize: 13, color: sig.signed ? "#16A34A" : "#CBD5E1" }}>{sig.signed ? "✓" : "○"}</span>
                <span style={{ flex: 1, fontSize: 13, fontFamily: F, color: "#1E293B" }}>{sig.role}{sig.name ? ` — ${sig.name}` : ""}</span>
                {sig.signed && <span style={{ fontSize: 11, color: "#94A3B8" }}>{fmtDate(sig.signedAt)}</span>}
                {isAdmin && !sig.signed && <button style={{ ...S.btnEdit, padding: "2px 8px", fontSize: 10 }} onClick={() => onToggleSignature(catId, ms.id, sig.id)}>Sign</button>}
                {isAdmin && sig.signed && <button style={{ ...S.btnEdit, padding: "2px 8px", fontSize: 10 }} onClick={() => onToggleSignature(catId, ms.id, sig.id)}>Unsign</button>}
              </div>
            ))}
            {isAdmin && (
              <button style={{ ...S.btnAddItem, marginTop: 6, fontSize: 12 }} onClick={() => onAddSignature(catId, ms.id)}>{t("+ Add Signature", lang)}</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══ SI VALIDATION SECTION (FAT/SAT) ═══ */
function SIValidation({ project, state, setState, isAdmin }) {
  const pid = project?.id;
  const val = state.docData?.[pid]?._siValidation || { fat: { criteria: "", signatures: [], docs: [] }, sat: { criteria: "", signatures: [], docs: [] } };

  const update = (newVal) => {
    if (!pid) return;
    setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid] || {}), _siValidation: newVal } } }));
  };

  const renderSection = (key, label) => {
    const sec = val[key] || { criteria: "", signatures: [], docs: [] };
    return (
      <div style={{ ...S.card, marginBottom: 12, borderLeft: `3px solid ${key === "fat" ? "#3B82F6" : "#F59E0B"}` }}>
        <h3 style={{ ...S.h3, fontSize: 17, marginBottom: 10 }}>{label}</h3>
        {/* Criteria */}
        <label style={S.lbl}>Criteria</label>
        {isAdmin ? (
          <textarea style={{ ...S.inp, minHeight: 60, resize: "vertical" }} value={sec.criteria} onChange={e => update({ ...val, [key]: { ...sec, criteria: e.target.value } })} placeholder={`Enter ${label} criteria...`} />
        ) : (
          <p style={{ fontSize: 14, color: "#1E293B", fontFamily: F, whiteSpace: "pre-wrap", padding: "10px 14px", background: "#F8FAFC", borderRadius: 10, border: "1px solid #E2E8F0" }}>{sec.criteria || "No criteria defined yet."}</p>
        )}
        {/* Signatures */}
        <label style={{ ...S.lbl, marginTop: 14 }}>Signatures (Instrumental & SI only)</label>
        {(sec.signatures || []).map((sig, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0" }}>
            <span style={{ color: sig.signed ? "#16A34A" : "#CBD5E1" }}>{sig.signed ? "✓" : "○"}</span>
            <span style={{ flex: 1, fontSize: 14, fontFamily: F }}>{sig.role}{sig.name ? ` — ${sig.name}` : ""}</span>
            {isAdmin && <button style={{ ...S.btnEdit, padding: "2px 8px", fontSize: 10 }} onClick={() => {
              const newSigs = [...sec.signatures]; newSigs[i] = { ...newSigs[i], signed: !newSigs[i].signed, signedAt: !newSigs[i].signed ? new Date().toISOString() : null };
              update({ ...val, [key]: { ...sec, signatures: newSigs } });
            }}>{sig.signed ? "Unsign" : "Sign"}</button>}
            {isAdmin && <button style={{ ...S.btnDel, padding: "2px 6px", fontSize: 10 }} onClick={() => {
              update({ ...val, [key]: { ...sec, signatures: sec.signatures.filter((_, j) => j !== i) } });
            }}>✕</button>}
          </div>
        ))}
        {isAdmin && <button style={{ ...S.btnAddItem, fontSize: 12, marginTop: 6 }} onClick={() => {
          const role = prompt("Signature role (e.g. 'SI Lead Engineer'):");
          if (!role) return;
          update({ ...val, [key]: { ...sec, signatures: [...(sec.signatures||[]), { role, name: "", signed: false, signedAt: null }] } });
        }}>+ Add Signature</button>}
        {/* Documents */}
        <label style={{ ...S.lbl, marginTop: 14 }}>Documents (PDF only)</label>
        {(sec.docs || []).map((doc, i) => (
          <div key={i} style={S.docItemRow}>
            <span>📄</span>
            <div style={{ flex: 1 }}>{doc.url ? <a href={doc.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, color: "#0284C7", fontFamily: F, textDecoration: "none" }}>{doc.name}</a> : <span style={{ fontSize: 14, fontFamily: F }}>{doc.name}</span>}</div>
            {isAdmin && <button style={{ ...S.btnDel, padding: "2px 6px", fontSize: 10 }} onClick={() => { update({ ...val, [key]: { ...sec, docs: sec.docs.filter((_, j) => j !== i) } }); }}>✕</button>}
          </div>
        ))}
        {isAdmin && <button style={{ ...S.btnAddItem, fontSize: 12, marginTop: 6 }} onClick={() => {
          const name = prompt("Document name:"); if (!name) return;
          const rawUrl = prompt("PDF URL (https://...):");
          const url = commitUrl(rawUrl || ""); if (url === null) return;
          update({ ...val, [key]: { ...sec, docs: [...(sec.docs||[]), { id: genId(), name, url, type: "pdf" }] } });
        }}>+ Add PDF Document</button>}
      </div>
    );
  };

  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ ...S.h3, marginBottom: 12 }}>Validation</h3>
      {renderSection("fat", "Factory Acceptance Test (FAT)")}
      {renderSection("sat", "Site Acceptance Test (SAT)")}
    </div>
  );
}

/* ═══ SI APPROVED HARDWARE ═══ */
function SIHardware({ project, state, setState, isAdmin }) {
  const pid = project?.id;
  const hw = state.docData?.[pid]?._siHardware || [];

  const updateHW = (newHw) => {
    if (!pid) return;
    setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid] || {}), _siHardware: newHw } } }));
  };

  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ ...S.h3, marginBottom: 12 }}>Approved Hardware</h3>
      <div style={S.card}>
        <table style={S.table}>
          <thead><tr><th style={S.th}>Type</th><th style={S.th}>Serial Number</th><th style={S.th}>Instrumental Asset Tag</th>{isAdmin && <th style={S.th}></th>}</tr></thead>
          <tbody>
            {hw.length === 0 && <tr><td colSpan={isAdmin ? 4 : 3} style={{ ...S.td, color: "#94A3B8", textAlign: "center", fontFamily: F }}>No hardware entries yet.</td></tr>}
            {hw.map((item, i) => (
              <tr key={i}>
                <td style={{ ...S.td, fontFamily: F }}>{item.type}</td>
                <td style={{ ...S.td, fontFamily: F }}>{item.serial || "—"}</td>
                <td style={{ ...S.td, fontFamily: F }}>{item.assetTag || "—"}</td>
                {isAdmin && <td style={S.td}><button style={{ ...S.btnDel, padding: "2px 8px", fontSize: 10 }} onClick={() => updateHW(hw.filter((_, j) => j !== i))}>✕</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
        {isAdmin && (
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {HW_TYPES.map(type => (
              <button key={type} style={S.btnAddItem} onClick={() => {
                const serial = prompt(`Serial Number for ${type}:`) || "";
                const tag = prompt(`Instrumental Asset Tag for ${type}:`) || "";
                updateHW([...hw, { id: genId(), type, serial, assetTag: tag }]);
              }}>+ {type}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══ PROGRAM DETAILS — tasks + milestones with dates ═══ */
function ProgramDetails({ project, state, setState, isAdmin }) {
  const pid = project?.id;
  const prog = state.docData?.[pid]?._programDetails || { tasks: [], docs: [] };
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", type: "task", startDate: "", endDate: "", date: "" });
  const [dragIdx, setDragIdx] = useState(null);

  const updateProg = (p) => { if (!pid) return; setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid] || {}), _programDetails: p } } })); };

  const addItem = () => {
    if (!form.name.trim()) return;
    const item = { id: genId(), name: form.name.trim(), type: form.type, startDate: form.type === "task" ? form.startDate : "", endDate: form.type === "task" ? form.endDate : "", date: form.type === "milestone" ? form.date : "", createdAt: new Date().toISOString() };
    updateProg({ ...prog, tasks: [...(prog.tasks || []), item] });
    setForm({ name: "", type: "task", startDate: "", endDate: "", date: "" }); setShowForm(false);
  };

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={S.h3}>Program Details</h3>
        {isAdmin && <button style={S.btnAddItem} onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "+ Add Task / Milestone"}</button>}
      </div>

      {showForm && isAdmin && (
        <div style={{ ...S.card, marginBottom: 12, background: "#F8FAFC" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button onClick={() => setForm(f => ({ ...f, type: "task" }))} style={{ ...S.typeBtn, ...(form.type === "task" ? S.typeBtnActive : {}) }}>📋 Task</button>
            <button onClick={() => setForm(f => ({ ...f, type: "milestone" }))} style={{ ...S.typeBtn, ...(form.type === "milestone" ? S.typeBtnActive : {}) }}>🏁 Milestone</button>
          </div>
          <label style={S.lbl}>Name</label>
          <input style={S.inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={form.type === "task" ? "e.g. Hardware integration" : "e.g. FAT Complete"} />
          {form.type === "task" ? (<>
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}><label style={S.lbl}>Start Date</label><input type="date" style={S.inp} value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} /></div>
              <div style={{ flex: 1 }}><label style={S.lbl}>End Date</label><input type="date" style={S.inp} value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} /></div>
            </div>
          </>) : (<>
            <label style={S.lbl}>Date</label><input type="date" style={S.inp} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
          </>)}
          <button style={{ ...S.btnMain, width: "auto", padding: "10px 20px", marginTop: 12 }} onClick={addItem}>Add {form.type === "task" ? "Task" : "Milestone"}</button>
        </div>
      )}

      <div style={S.card}>
        {(prog.tasks || []).length === 0 && <p style={{ fontSize: 14, color: "#94A3B8", fontFamily: F }}>No tasks or milestones yet.</p>}
        {(prog.tasks || []).map((item, i) => (
          <div key={item.id}
            draggable={isAdmin}
            onDragStart={() => setDragIdx(i)}
            onDragOver={e => e.preventDefault()}
            onDrop={() => { if (dragIdx === null || dragIdx === i) return; const r = [...prog.tasks]; const [m] = r.splice(dragIdx, 1); r.splice(i, 0, m); updateProg({ ...prog, tasks: r }); setDragIdx(null); }}
            onDragEnd={() => setDragIdx(null)}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #F1F5F9", opacity: dragIdx === i ? 0.4 : 1, cursor: isAdmin ? "grab" : "default" }}>
            {isAdmin && <span style={{ color: "#CBD5E1", fontSize: 14, cursor: "grab" }}>⠿</span>}
            <span style={{ fontSize: 14 }}>{item.type === "task" ? "📋" : "🏁"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#0F172A", fontFamily: F }}>{item.name}</div>
              <div style={{ fontSize: 12, color: "#64748B", fontFamily: F }}>
                {item.type === "task" ? `${fmtDay(item.startDate)} → ${fmtDay(item.endDate)}` : fmtDay(item.date)}
              </div>
            </div>
            <Chip small color={item.type === "task" ? "#EFF6FF" : "#FEF3C7"} fg={item.type === "task" ? "#3B82F6" : "#D97706"}>{item.type}</Chip>
            {isAdmin && <button style={{ ...S.btnDel, padding: "2px 8px", fontSize: 10 }} onClick={() => updateProg({ ...prog, tasks: prog.tasks.filter((_, j) => j !== i) })}>✕</button>}
          </div>
        ))}
      </div>

      {/* RACI / docs upload */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#64748B", fontFamily: F, marginBottom: 6 }}>RACI & Program Documents</div>
        {(prog.docs || []).map((doc, i) => (
          <div key={i} style={S.docItemRow}>
            <span>📄</span>
            <div style={{ flex: 1 }}>{doc.url ? <a href={doc.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, color: "#0284C7", fontFamily: F, textDecoration: "none" }}>{doc.name}</a> : <span style={{ fontSize: 14, fontFamily: F }}>{doc.name}</span>}</div>
            {isAdmin && <button style={{ ...S.btnDel, padding: "2px 6px", fontSize: 10 }} onClick={() => updateProg({ ...prog, docs: prog.docs.filter((_, j) => j !== i) })}>✕</button>}
          </div>
        ))}
        {isAdmin && <button style={{ ...S.btnAddItem, fontSize: 12, marginTop: 6 }} onClick={() => {
          const name = prompt("Document name (e.g. RACI Matrix):"); if (!name) return;
          const rawUrl = prompt("URL (https://...):");
          const url = commitUrl(rawUrl || ""); if (url === null) return;
          updateProg({ ...prog, docs: [...(prog.docs||[]), { id: genId(), name, url }] });
        }}>+ Add Document</button>}
      </div>
    </div>
  );
}

/* ═══ DOCS VIEW — read-only for non-instrumental, PDF-only uploads, training inside ═══ */
function DocsView({ partyId, user, project, state, setState, lang }) {
  const pd = PARTY_DEFS[partyId];
  const displayName = getPN(project, partyId);
  const pid = project?.id;
  const cats = pid ? getDocCats(state.docData, pid, partyId) : (SEED_DOC_CATEGORIES[partyId] || []);
  const [expanded, setExpanded] = useState(null);
  const [addingItem, setAddingItem] = useState(null);
  const [itemForm, setItemForm] = useState({ name: "", url: "", type: "link", lang: "en" });
  const [addingFolder, setAddingFolder] = useState(false);
  const [msDragIdx, setMsDragIdx] = useState(null);
  const [folderForm, setFolderForm] = useState({ name: "", accessLevel: "open" });
  const admin = isInst(user);
  const canEdit = isInst(user); // all Instrumental users (partyId: instrumental) + admins can edit

  const canAccess = (cat) => {
    if (cat.accessLevel !== "restricted") return true;
    if (admin) return true;
    // Check restricted access grants
    const grants = state.docData?.[pid]?._restrictedAccess || {};
    return grants[cat.id]?.includes(user.id);
  };

  const ensureCats = () => {
    if (!pid) return cats;
    if (state.docData?.[pid]?.[partyId]) return state.docData[pid][partyId];
    const seeded = JSON.parse(JSON.stringify(SEED_DOC_CATEGORIES[partyId] || []));
    setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid] || {}), [partyId]: seeded } } }));
    return seeded;
  };
  const updateCats = (nc) => { if (!pid) return; setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid] || {}), [partyId]: nc } } })); };

  const addItem = (catId) => {
    if (!itemForm.name.trim()) return;
    const url = commitUrl(itemForm.url); if (url === null) return;
    const c = ensureCats();
    updateCats(c.map(cat => cat.id !== catId ? cat : { ...cat, items: [...(cat.items||[]), { id: genId(), name: itemForm.name.trim(), url: url || null, type: itemForm.type, lang: itemForm.lang, addedAt: new Date().toISOString(), addedBy: user.name }] }));
    setItemForm({ name: "", url: "", type: "link", lang: "en" }); setAddingItem(null);
  };
  const delItem = (catId, itemId) => { const c = ensureCats(); updateCats(c.map(cat => cat.id !== catId ? cat : { ...cat, items: (cat.items||[]).filter(i => i.id !== itemId) })); };
  const addFolder = () => { if (!folderForm.name.trim()) return; const c = ensureCats(); updateCats([...c, { id: genId(), name: folderForm.name.trim(), accessLevel: folderForm.accessLevel, items: [] }]); setFolderForm({ name: "", accessLevel: "open" }); setAddingFolder(false); };
  const delFolder = (catId) => { const c = ensureCats(); updateCats(c.filter(cat => cat.id !== catId)); };

  // Milestone handlers
  const toggleCheck = (catId, msId, ckId) => { const c = ensureCats(); updateCats(c.map(cat => { if (cat.id !== catId || !cat.milestones) return cat; return { ...cat, milestones: cat.milestones.map(ms => ms.id !== msId ? ms : { ...ms, checklist: ms.checklist.map(ck => ck.id !== ckId ? ck : { ...ck, checked: !ck.checked }) }) }; })); };
  const addCheckItem = (catId, msId, label) => { const c = ensureCats(); updateCats(c.map(cat => { if (cat.id !== catId) return cat; return { ...cat, milestones: cat.milestones.map(ms => ms.id !== msId ? ms : { ...ms, checklist: [...ms.checklist, { id: genId(), label, checked: false }] }) }; })); };
  const delCheckItem = (catId, msId, ckId) => { const c = ensureCats(); updateCats(c.map(cat => { if (cat.id !== catId) return cat; return { ...cat, milestones: cat.milestones.map(ms => ms.id !== msId ? ms : { ...ms, checklist: ms.checklist.filter(ck => ck.id !== ckId) }) }; })); };
  const addMsLink = (catId, msId, name, url) => { const c = ensureCats(); updateCats(c.map(cat => { if (cat.id !== catId) return cat; return { ...cat, milestones: cat.milestones.map(ms => ms.id !== msId ? ms : { ...ms, links: [...(ms.links||[]), { id: genId(), name, url, type: "link", addedBy: user.name, addedAt: new Date().toISOString() }] }) }; })); };
  const delMsLink = (catId, msId, lkId) => { const c = ensureCats(); updateCats(c.map(cat => { if (cat.id !== catId) return cat; return { ...cat, milestones: cat.milestones.map(ms => ms.id !== msId ? ms : { ...ms, links: (ms.links||[]).filter(l => l.id !== lkId) }) }; })); };
  const toggleSig = (catId, msId, sigId) => { const c = ensureCats(); updateCats(c.map(cat => { if (cat.id !== catId) return cat; return { ...cat, milestones: cat.milestones.map(ms => ms.id !== msId ? ms : { ...ms, signatures: (ms.signatures||[]).map(s => s.id !== sigId ? s : { ...s, signed: !s.signed, name: !s.signed ? user.name : "", signedAt: !s.signed ? new Date().toISOString() : null }) }) }; })); };
  const addSig = (catId, msId) => { const role = prompt("Signature role:"); if (!role) return; const c = ensureCats(); updateCats(c.map(cat => { if (cat.id !== catId) return cat; return { ...cat, milestones: cat.milestones.map(ms => ms.id !== msId ? ms : { ...ms, signatures: [...(ms.signatures||[]), { id: genId(), role, name: "", email: "", signed: false, signedAt: null }] }) }; })); };
  const delSig = (catId, msId, sigId) => { const c = ensureCats(); updateCats(c.map(cat => { if (cat.id !== catId) return cat; return { ...cat, milestones: cat.milestones.map(ms => ms.id !== msId ? ms : { ...ms, signatures: (ms.signatures||[]).filter(s => s.id !== sigId) }) }; })); };
  const reorderMilestones = (catId, newMilestones) => { const c = ensureCats(); updateCats(c.map(cat => cat.id !== catId ? cat : { ...cat, milestones: newMilestones })); };
  const updateMsDesc = (catId, msId, desc) => { const c = ensureCats(); updateCats(c.map(cat => { if (cat.id !== catId || !cat.milestones) return cat; return { ...cat, milestones: cat.milestones.map(ms => ms.id !== msId ? ms : { ...ms, description: desc }) }; })); };
  const updateCheckLabel = (catId, msId, ckId, label) => { const c = ensureCats(); updateCats(c.map(cat => { if (cat.id !== catId) return cat; return { ...cat, milestones: cat.milestones.map(ms => ms.id !== msId ? ms : { ...ms, checklist: ms.checklist.map(ck => ck.id !== ckId ? ck : { ...ck, label }) }) }; })); };

  return (
    <div style={S.page}>
      <h2 style={S.h2}>{displayName}</h2>
      <p style={S.sub}>{project?.name || "Select a project"}</p>

      {/* Add folder (admin only) */}
      {canEdit && pid && !addingFolder && <button style={{ ...S.btnAddItem, marginBottom: 16 }} onClick={() => setAddingFolder(true)}>{t("+ Add Folder", lang)}</button>}
      {canEdit && addingFolder && (
        <div style={{ ...S.card, marginBottom: 16, background: "#F8FAFC" }}>
          <label style={S.lbl}>{t("Folder Name", lang)}</label>
          <input style={S.inp} value={folderForm.name} onChange={e => setFolderForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Specifications" />
          <label style={S.lbl}>{t("Access", lang)}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setFolderForm(f => ({ ...f, accessLevel: "open" }))} style={{ ...S.typeBtn, ...(folderForm.accessLevel === "open" ? S.typeBtnActive : {}) }}>{t("Open", lang)}</button>
            <button onClick={() => setFolderForm(f => ({ ...f, accessLevel: "restricted" }))} style={{ ...S.typeBtn, ...(folderForm.accessLevel === "restricted" ? { background: "#FEF2F2", borderColor: "#DC2626", color: "#DC2626" } : {}) }}>{t("Restricted", lang)}</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button style={{ ...S.btnMain, width: "auto", padding: "10px 20px", marginTop: 0 }} onClick={addFolder}>{t("Create", lang)}</button>
            <button style={S.btnFlat} onClick={() => setAddingFolder(false)}>{t("Cancel", lang)}</button>
          </div>
        </div>
      )}

      {/* Document folders */}
      {cats.map(cat => {
        const locked = !canAccess(cat);
        const isExp = expanded === cat.id;
        const isChecklist = cat.type === "checklist";
        const isProgram = cat.type === "program";
        const items = cat.items || [];
        const langItem = LANGUAGES.find(l => l.id === (cat.lang || "en"));

        return (
          <div key={cat.id} style={{ ...S.card, marginBottom: 10, opacity: locked ? .5 : 1 }}>
            <button onClick={() => !locked && setExpanded(isExp ? null : cat.id)} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", border: "none", background: "none", cursor: locked ? "not-allowed" : "pointer", textAlign: "left", padding: 0, fontFamily: F }}>
              <span style={{ fontSize: 15, color: pd.accent }}>{locked ? "🔒" : isChecklist ? "☑" : isProgram ? "📋" : "📁"}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{t(cat.name, lang)}</div>
                {locked && <div style={{ fontSize: 12, color: "#DC2626", fontFamily: F }}>{t("Restricted — contact admin for access", lang)}</div>}
              </div>
              {!locked && <span style={{ fontSize: 12, color: "#94A3B8" }}>{isChecklist ? (cat.milestones?.length || 0) : isProgram ? (state.docData?.[pid]?._programDetails?.tasks?.length || prog?.tasks?.length || 0) : items.length} {t("items", lang)}</span>}
              {!locked && <span style={{ color: "#94A3B8" }}>{isExp ? "▾" : "▸"}</span>}
            </button>

            {isExp && !locked && isChecklist && cat.milestones && (
              <div style={{ marginTop: 14 }}>
                {cat.milestones.map((ms, msI) => (
                  <div key={ms.id}
                    draggable={canEdit}
                    onDragStart={() => setMsDragIdx(msI)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => { if (msDragIdx === null || msDragIdx === msI) return; const r = [...cat.milestones]; const [m] = r.splice(msDragIdx, 1); r.splice(msI, 0, m); reorderMilestones(cat.id, r); setMsDragIdx(null); }}
                    onDragEnd={() => setMsDragIdx(null)}
                    style={{ opacity: msDragIdx === msI ? 0.4 : 1, cursor: canEdit ? "grab" : "default" }}>
                    <MilestoneCard milestone={ms} catId={cat.id} isAdmin={canEdit} projectId={pid} onToggleCheck={toggleCheck} onAddCheckItem={addCheckItem} onDeleteCheckItem={delCheckItem} onAddLink={addMsLink} onDeleteLink={delMsLink} onUpdateSignature={() => {}} onToggleSignature={toggleSig} onAddSignature={addSig} onDeleteSignature={delSig} onUpdateDesc={updateMsDesc} onUpdateCheckLabel={updateCheckLabel} lang={lang} />
                  </div>
                ))}
              </div>
            )}

            {isExp && !locked && isProgram && (
              <div style={{ marginTop: 14 }}>
                <ProgramDetails project={project} state={state} setState={setState} isAdmin={canEdit} />
              </div>
            )}

            {isExp && !locked && !isChecklist && !isProgram && (
              <div style={{ marginTop: 14 }}>
                {items.length === 0 && !canEdit && <p style={{ fontSize: 14, color: "#94A3B8", fontFamily: F }}>{t("No documents yet.", lang)}</p>}
                {items.map(item => {
                  const il = LANGUAGES.find(l => l.id === item.lang) || LANGUAGES[0];
                  return (
                    <div key={item.id} style={S.docItemRow}>
                      <span style={{ fontSize: 14, color: item.type === "link" ? "#3B82F6" : "#A855F7" }}>{item.type === "link" ? "🔗" : "📄"}</span>
                      <div style={{ flex: 1 }}>
                        {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 15, fontWeight: 500, color: "#0284C7", textDecoration: "none", fontFamily: F }}>{item.name}</a> : <span style={{ fontSize: 15, fontFamily: F, color: "#1E293B" }}>{item.name}</span>}
                        <div style={{ fontSize: 12, color: "#94A3B8", fontFamily: F }}>{item.type === "link" ? t("Link", lang) : "PDF"} · {item.addedBy} · {fmtDate(item.addedAt)}</div>
                      </div>
                      <span style={{ padding: "2px 8px", borderRadius: 6, background: "#F1F5F9", fontSize: 11, fontWeight: 700, color: "#64748B" }}>{il.flag} {il.short}</span>
                      {canEdit && <button style={{ ...S.btnDel, padding: "3px 8px", fontSize: 11 }} onClick={() => delItem(cat.id, item.id)}>✕</button>}
                    </div>
                  );
                })}
                {/* Add item form — admin only */}
                {canEdit && pid && (<>
                  {addingItem === cat.id ? (
                    <div style={{ marginTop: 12, padding: 14, background: "#F8FAFC", borderRadius: 10 }}>
                      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                        <button onClick={() => setItemForm(f => ({ ...f, type: "link" }))} style={{ ...S.typeBtn, ...(itemForm.type === "link" ? S.typeBtnActive : {}) }}>🔗 Link (any format)</button>
                        <button onClick={() => setItemForm(f => ({ ...f, type: "pdf" }))} style={{ ...S.typeBtn, ...(itemForm.type === "pdf" ? S.typeBtnActive : {}) }}>📄 PDF Document</button>
                      </div>
                      <label style={S.lbl}>{t("Name", lang)}</label>
                      <input style={S.inp} value={itemForm.name} onChange={e => setItemForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Pin Inspection Spec v2.1" />
                      <label style={S.lbl}>{itemForm.type === "link" ? t("URL (any format)", lang) : t("PDF URL (must be .pdf)", lang)}</label>
                      <input style={S.inp} value={itemForm.url} onChange={e => setItemForm(f => ({ ...f, url: e.target.value }))} placeholder={itemForm.type === "link" ? "https://docs.google.com/..." : "https://...file.pdf"} />
                      <label style={S.lbl}>{t("Document Language", lang)}</label>
                      <select style={S.inp} value={itemForm.lang} onChange={e => setItemForm(f => ({ ...f, lang: e.target.value }))}>
                        {LANGUAGES.map(l => <option key={l.id} value={l.id}>{l.flag} {l.label}</option>)}
                      </select>
                      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <button style={{ ...S.btnMain, width: "auto", padding: "10px 18px", marginTop: 0 }} onClick={() => addItem(cat.id)}>{t("Add", lang)}</button>
                        <button style={{ ...S.btnFlat, width: "auto" }} onClick={() => { setAddingItem(null); setItemForm({ name: "", url: "", type: "link", lang: "en" }); }}>{t("Cancel", lang)}</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button style={S.btnAddItem} onClick={() => setAddingItem(cat.id)}>{t("+ Add Link or PDF", lang)}</button>
                      <button style={{ ...S.btnDel, fontSize: 11, padding: "4px 10px" }} onClick={() => delFolder(cat.id)}>{t("Delete Folder", lang)}</button>
                    </div>
                  )}
                </>)}
              </div>
            )}
          </div>
        );
      })}

      {/* SI-specific: Validation + Hardware */}
      {partyId === "si" && (<>
        <SIValidation project={project} state={state} setState={setState} isAdmin={canEdit} />
        <SIHardware project={project} state={state} setState={setState} isAdmin={canEdit} />
      </>)}

      {/* Training section inside each party */}
      {(() => {
        const td = state.docData?.[pid]?._training?.[partyId] || {};
        const enabled = td.enabled || false;
        const links = td.links || [];
        const [addTL, setAddTL] = useState(false);
        const [tlForm, setTlForm] = useState({ name: "", url: "", belt: "white" });
        const toggleT = () => { if (!pid) return; setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), _training: { ...(prev.docData?.[pid]?._training||{}), [partyId]: { ...td, enabled: !enabled } } } } })); };
        const addTLink = () => { if (!tlForm.name.trim()) return; const url = commitUrl(tlForm.url); if (url === null) return; const nl = { id: genId(), ...tlForm, url, addedAt: new Date().toISOString(), addedBy: user.name }; setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), _training: { ...(prev.docData?.[pid]?._training||{}), [partyId]: { ...td, links: [...links, nl] } } } } })); setTlForm({ name: "", url: "", belt: "white" }); setAddTL(false); };
        const delTLink = (id) => { setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), _training: { ...(prev.docData?.[pid]?._training||{}), [partyId]: { ...td, links: links.filter(l => l.id !== id) } } } } })); };
        const toggleBeltNA = (belt) => { const k = `${belt}_disabled`; setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), _training: { ...(prev.docData?.[pid]?._training||{}), [partyId]: { ...td, [k]: !td[k] } } } } })); };

        return (
          <div style={{ marginTop: 28 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={S.h3}>{t("Training", lang)}</h3>
              {canEdit && pid && (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 13, color: "#64748B", fontFamily: F }}>{enabled ? t("Enabled", lang) : t("Disabled", lang)}</span>
                  <div onClick={toggleT} style={{ width: 44, height: 24, borderRadius: 12, background: enabled ? "#00C9A7" : "#CBD5E1", cursor: "pointer", position: "relative", transition: "background .2s" }}>
                    <div style={{ width: 18, height: 18, borderRadius: 9, background: "#FFF", position: "absolute", top: 3, left: enabled ? 23 : 3, transition: "left .2s" }} />
                  </div>
                </div>
              )}
            </div>
            {!enabled && <div style={S.empty}>{canEdit ? t("Training is disabled for this party. Toggle above to enable.", lang) : t("Training is not required.", lang)}</div>}
            {enabled && (
              <div style={{ ...S.card, borderLeft: `3px solid ${pd.accent}` }}>
                {["white", "blue", "black"].map(belt => {
                  const bl = links.filter(l => l.belt === belt);
                  const bi = BELT_LEVELS[belt];
                  const dis = td[`${belt}_disabled`];
                  return (
                    <div key={belt} style={{ marginBottom: 16, opacity: dis ? .4 : 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <span>{bi.icon}</span>
                        <span style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{bi.name}</span>
                        {dis && <Chip small color="#F1F5F9" fg="#94A3B8">{t("N/A", lang)}</Chip>}
                        {canEdit && <button style={{ ...S.btnEdit, padding: "2px 8px", fontSize: 10, marginLeft: "auto" }} onClick={() => toggleBeltNA(belt)}>{dis ? t("Enable", lang) : t("N/A", lang)}</button>}
                      </div>
                      {!dis && bl.map(lk => (
                        <div key={lk.id} style={{ ...S.docItemRow, marginLeft: 24 }}>
                          <span>🔗</span>
                          <div style={{ flex: 1 }}>{lk.url ? <a href={lk.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, color: "#0284C7", fontFamily: F, textDecoration: "none" }}>{lk.name}</a> : <span style={{ fontSize: 14, fontFamily: F }}>{lk.name}</span>}</div>
                          {canEdit && <button style={{ ...S.btnDel, padding: "2px 6px", fontSize: 10 }} onClick={() => delTLink(lk.id)}>✕</button>}
                        </div>
                      ))}
                      {!dis && bl.length === 0 && <p style={{ fontSize: 13, color: "#94A3B8", marginLeft: 24, fontFamily: F }}>{t("No materials yet.", lang)}</p>}
                    </div>
                  );
                })}
                {canEdit && pid && !addTL && <button style={S.btnAddItem} onClick={() => setAddTL(true)}>{t("+ Add Training Material", lang)}</button>}
                {canEdit && addTL && (
                  <div style={{ padding: 14, background: "#F8FAFC", borderRadius: 10, marginTop: 8 }}>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                      {["white","blue","black"].map(b => <button key={b} onClick={() => setTlForm(f => ({...f, belt: b}))} style={{ ...S.typeBtn, ...(tlForm.belt === b ? S.typeBtnActive : {}) }}>{BELT_LEVELS[b].icon} {BELT_LEVELS[b].name}</button>)}
                    </div>
                    <label style={S.lbl}>{t("Title", lang)}</label><input style={S.inp} value={tlForm.name} onChange={e => setTlForm(f => ({...f, name: e.target.value}))} placeholder="e.g. White Belt Module 1" />
                    <label style={S.lbl}>URL</label><input style={S.inp} value={tlForm.url} onChange={e => setTlForm(f => ({...f, url: e.target.value}))} placeholder="https://..." />
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                      <button style={{ ...S.btnMain, width: "auto", padding: "8px 16px", marginTop: 0 }} onClick={addTLink}>{t("Add", lang)}</button>
                      <button style={{ ...S.btnFlat, width: "auto" }} onClick={() => setAddTL(false)}>{t("Cancel", lang)}</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}
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

  useEffect(() => {
    const unsub = onValue(ref(db, "hubspotSync/status"), s => setSyncStatus(s.val()), { onlyOnce: false });
    return () => unsub();
  }, []);

  const runPreview = async () => {
    setSyncLoading(true); setSyncMsg(""); setSyncPreview(null);
    try {
      const fn = httpsCallable(functions, "manualHubspotSync");
      await fn({ commit: false });
      // Preview data written to hubspotPreview/ — read it once
      const snap = await new Promise(r => onValue(ref(db, "hubspotPreview"), r, { onlyOnce: true }));
      const data = snap.val() || {};
      const projects = Object.values(data);
      setSyncPreview(projects);
      setSyncMsg(`Preview complete: ${projects.length} projects found.`);
    } catch(e) { setSyncMsg("Error: " + (e.message || String(e))); }
    setSyncLoading(false);
  };

  const runApply = async () => {
    if (!confirm(`Apply sync? This will update ${syncPreview?.length || 0} projects in the webapp.`)) return;
    setApplyLoading(true); setSyncMsg("");
    try {
      const fn = httpsCallable(functions, "manualHubspotSync");
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
        {[{ id: "pending", label: `Pending${pending.length > 0 ? ` (${pending.length})` : ""}` }, { id: "users", label: "User Access" }, { id: "commercial_access", label: "🔒 Commercial Access" }, { id: "hubspot", label: "🔄 HubSpot Sync" }].map(t => (
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
              Syncs all projects from all 6 HubSpot pipelines. Preview first, then confirm to apply changes to the webapp.
              Auto-sync runs every Tuesday and Friday at 9am PDT.
            </p>
            {syncStatus && (
              <div style={{ fontSize: 13, color: "#94A3B8", fontFamily: F, marginBottom: 12 }}>
                Last sync: {syncStatus.lastSync ? new Date(syncStatus.lastSync).toLocaleString() : "Never"} ·{" "}
                {syncStatus.count != null ? `${syncStatus.count} projects` : ""}{" "}
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
                <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 10 }}>{proj.name}</div>
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
              if (!confirm(`Apply checklist template to "${proj.name}"?${proj.isSI ? " (SI Deployment Checklist)" : " (Internal + External Checklist)"}`)) return;
              try {
                const fn = httpsCallable(functions, "applyChecklistTemplate");
                await fn({ projectId: proj.id, isSI: proj.isSI });
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

/* ═══ APP — Auth, DB, routing ═══ */
export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState(getDefault());
  const [authUser, setAuthUser] = useState(null);
  const [user, setUser] = useState(null);
  const [view, setView] = useState("dashboard");
  const [project, setProject] = useState(null);
  const [loginErr, setLoginErr] = useState("");
  const [pendingApproval, setPendingApproval] = useState(false);
  const [pendingUsers, setPendingUsers] = useState([]);
  const [lang, setLang] = useState("en");

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
      if (next.docData !== prev.docData) dbWrite("appState/docData", next.docData).catch(console.error);
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

  // Auto-select project
  useEffect(() => {
    if (user && state.projects) {
      const up = (Array.isArray(state.projects) ? state.projects : []).filter(p => user.role === "admin" || (user.projects||[]).includes(p.id));
      if (up.length > 0 && !project) setProject(up[0]);
    }
  }, [user, state.projects]);

  // Render gates
  if (!authChecked) return <div style={S.loginWrap}><p style={{ color: "#94A3B8", fontFamily: F }}>Loading…</p></div>;
  if (!authUser) return <Login err={loginErr} />;
  if (pendingApproval) return <PendingApproval authUser={authUser} onLogout={onLogout} />;
  if (!user || !loaded) return <div style={S.loginWrap}><div><p style={{ color: "#94A3B8", fontFamily: F }}>Loading your data…</p><p style={{ color: "#94A3B8", fontSize: 13, marginTop: 8 }}>Signed in as {authUser.email}</p></div></div>;

  const projectsArr = Array.isArray(state.projects) ? state.projects : (state.projects ? Object.values(state.projects) : []);
  const userProjects = projectsArr.filter(p => user.role === "admin" || (user.projects||[]).includes(p.id));
  const admin = isInst(user);
  const hasProjectAccess = !project || user.role === "admin" || admin || (user.projects||[]).includes(project.id);
  // Commercial access: admin always has it; others need explicit grant in commercialAccess/{pid}/{uid}
  const hasCommAccess = user.role === "admin" || (project && state.commercialAccess?.[project.id]?.[user.id]);

  const renderMain = () => {
    if (view === "chat") return <ChatView user={user} />;
    if (view === "projects_overview" && admin) return <ProjectsOverviewView state={state} setState={save} user={user} lang={lang} />;
    if (!hasProjectAccess && view !== "projects_overview" && view !== "admin" && view !== "manage" && view !== "chat") {
      return <div style={S.page}><div style={S.empty}>Access denied — you are not assigned to this project.</div></div>;
    }
    if (view === "project_details") {
      return <ProjectDetailsView user={user} project={project} state={state} setState={save} lang={lang} />;
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
        <Sidebar view={view} setView={setView} user={user} project={project} projects={userProjects} setProject={setProject} onLogout={onLogout} lang={lang} setLang={setLang} hasCommercialAccess={hasCommAccess} />
        <main style={{ ...S.main, padding: 0 }}>
          <GlobalBotBar user={user} />
          <div style={{ padding: "32px 40px" }}>{renderMain()}</div>
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
