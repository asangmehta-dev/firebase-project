import { useState, useEffect, useCallback } from "react";
import { auth, db, googleProvider } from "./firebase";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { ref, onValue, set } from "firebase/database";

/* ═══ DB HELPERS ═══ */
const dbRead = (p) => new Promise((r) => { onValue(ref(db, p), (s) => r(s.val()), { onlyOnce: true }); });
const dbWrite = (p, d) => set(ref(db, p), d);

/* ═══ CONSTANTS ═══ */
const PARTY_DEFS = {
  instrumental: { id: "instrumental", icon: "◉", accent: "#00C9A7", defaultName: "Instrumental" },
  si: { id: "si", icon: "◈", accent: "#3B82F6", defaultName: "Systems Integrator" },
  customer: { id: "customer", icon: "◆", accent: "#F59E0B", defaultName: "Customer" },
  cm: { id: "cm", icon: "◇", accent: "#A855F7", defaultName: "Contract Manufacturer" },
};
const BELT_LEVELS = { white: { name: "White Belt", color: "#64748B", icon: "○" }, blue: { name: "Blue Belt", color: "#3B82F6", icon: "◐" }, black: { name: "Black Belt", color: "#1E293B", icon: "●" } };
const LANGUAGES = [
  { id: "en", label: "English (US)", flag: "🇺🇸", short: "EN" },
  { id: "es", label: "Español", flag: "🇪🇸", short: "ES" },
  { id: "vi", label: "Tiếng Việt", flag: "🇻🇳", short: "VI" },
  { id: "zh-tw", label: "繁體中文", flag: "🇹🇼", short: "繁" },
  { id: "zh-cn", label: "简体中文", flag: "🇨🇳", short: "简" },
];
const HW_TYPES = ["Camera", "Lens", "Station Computer"];
const SEED_PROJECTS = [
  { id: "proj_nvidia_1", name: "NVIDIA — HGX B200 Inspection", customer: "NVIDIA", si: "Anda Technologies", cm: "Foxconn", status: "active", stations: 0, partyNames: { instrumental: "Instrumental", si: "Anda Technologies", customer: "NVIDIA", cm: "Foxconn" } },
  { id: "proj_aws_1", name: "AWS — Trainium Board QC", customer: "AWS", si: "New Power", cm: "Quanta", status: "active", stations: 0, partyNames: { instrumental: "Instrumental", si: "New Power", customer: "AWS", cm: "Quanta" } },
];
const SEED_DOC_CATEGORIES = {
  instrumental: [
    { id: "inst_hw", name: "Hardware & MES Deployments", accessLevel: "open", items: [] },
    { id: "inst_specs", name: "Specifications & Integration Docs", accessLevel: "open", items: [] },
    { id: "inst_program", name: "Program Details & Timelines", accessLevel: "open", items: [], type: "program" },
    { id: "inst_training_docs", name: "Training Documentation", accessLevel: "open", items: [] },
    { id: "inst_milestones", name: "Checklist Milestones", accessLevel: "open", type: "checklist",
      milestones: [
        { id: "ms_ok2contract", name: "OK2Contract", description: "Specs, CAD, and business deal locked.", color: "#00C9A7",
          checklist: [ { id: "ck_c1", label: "Specifications finalized and signed off", checked: false }, { id: "ck_c2", label: "CAD files reviewed and approved", checked: false }, { id: "ck_c3", label: "Business deal / contract locked", checked: false }, { id: "ck_c4", label: "NDA and IP agreements executed", checked: false }, { id: "ck_c5", label: "Pricing and payment terms agreed", checked: false }, { id: "ck_c6", label: "Stakeholder sign-off obtained", checked: false } ],
          links: [], signatures: [ { id: "sig_c1", role: "Program Manager", name: "", email: "", signed: false, signedAt: null }, { id: "sig_c2", role: "Customer Engineering Lead", name: "", email: "", signed: false, signedAt: null }, { id: "sig_c3", role: "SI Project Manager", name: "", email: "", signed: false, signedAt: null } ] },
        { id: "ms_ok2ship", name: "OK2Ship", description: "Ship hardware + software/ML. Includes FAT criteria.", color: "#3B82F6",
          checklist: [ { id: "ck_s1", label: "All hardware sourced and assembled", checked: false }, { id: "ck_s2", label: "Software / ML packaged and validated", checked: false }, { id: "ck_s3", label: "FAT criteria defined", checked: false }, { id: "ck_s4", label: "FAT executed and passed", checked: false }, { id: "ck_s5", label: "FAT report documented and signed", checked: false }, { id: "ck_s6", label: "Shipping logistics confirmed", checked: false } ],
          links: [], signatures: [ { id: "sig_s1", role: "Hardware Lead", name: "", email: "", signed: false, signedAt: null }, { id: "sig_s2", role: "SI Engineering Lead", name: "", email: "", signed: false, signedAt: null }, { id: "sig_s3", role: "QA / FAT Lead", name: "", email: "", signed: false, signedAt: null } ] },
        { id: "ms_ok2build", name: "OK2Build", description: "OK to build at CM. SAT criteria.", color: "#F59E0B",
          checklist: [ { id: "ck_b1", label: "SAT criteria defined", checked: false }, { id: "ck_b2", label: "SAT executed and passed", checked: false }, { id: "ck_b3", label: "SAT report documented and signed", checked: false }, { id: "ck_b4", label: "CM line readiness confirmed", checked: false }, { id: "ck_b5", label: "Hardware installed and calibrated", checked: false }, { id: "ck_b6", label: "Operator training completed", checked: false } ],
          links: [], signatures: [ { id: "sig_b1", role: "Deployment Lead", name: "", email: "", signed: false, signedAt: null }, { id: "sig_b2", role: "CM Site Manager", name: "", email: "", signed: false, signedAt: null }, { id: "sig_b3", role: "QA / SAT Lead", name: "", email: "", signed: false, signedAt: null } ] },
      ], items: [] },
  ],
  si: [
    { id: "si_specs", name: "Specifications & Integration Docs", accessLevel: "open", items: [] },
    { id: "si_cad", name: "CAD & Drawings", accessLevel: "open", items: [] },
    { id: "si_agreement", name: "Agreements", accessLevel: "restricted", items: [] },
    { id: "si_pricing", name: "Pricing", accessLevel: "restricted", items: [] },
  ],
  customer: [
    { id: "cust_agreements", name: "Agreements", accessLevel: "open", items: [] },
    { id: "cust_specs", name: "Specifications & Integration Docs", accessLevel: "open", items: [] },
    { id: "cust_legal", name: "Legal Documents", accessLevel: "restricted", items: [] },
    { id: "cust_program", name: "Program Details", accessLevel: "open", items: [], type: "program" },
  ],
  cm: [
    { id: "cm_cad", name: "CAD & Specifications", accessLevel: "open", items: [] },
    { id: "cm_specs", name: "Process Specifications", accessLevel: "open", items: [] },
  ],
};
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
const getDocCats = (dd, pid, party) => dd?.[pid]?.[party] || SEED_DOC_CATEGORIES[party] || [];
const getPN = (proj, pid) => proj?.partyNames?.[pid] || PARTY_DEFS[pid]?.defaultName || pid;
const isInst = (u) => u?.partyId === "instrumental" || u?.role === "admin";
const isVisible = (proj, pid) => { const n = (proj?.partyNames?.[pid] || "").trim().toLowerCase(); return n && n !== "n/a" && n !== "na" && n !== "-" && n !== "none"; };

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

/* ═══ SIDEBAR — non-instrumental only sees their party + project + language ═══ */
function Sidebar({ view, setView, user, project, projects, setProject, onLogout, lang, setLang }) {
  const admin = isInst(user);
  return (
    <aside style={S.side}>
      <div style={S.sideHead}><span style={{ fontSize: 24, color: "#00C9A7" }}>◎</span><span style={S.sideTitle}>{t("Deployment Portal", lang)}</span></div>
      <div style={{ padding: "0 18px 12px" }}>
        <label style={S.sideLabel}>{t("Project", lang)}</label>
        <select style={S.projSelect} value={project?.id || ""} onChange={e => setProject(projects.find(p => p.id === e.target.value))}>
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.status === "deprecated" ? " (Past)" : ""}</option>)}
        </select>
      </div>
      <nav style={S.navList}>
        {(user.partyId === "instrumental" || user.partyId === "customer" || user.role === "admin") && (<>
          <button onClick={() => setView("dashboard")} style={{ ...S.navBtn, ...(view === "dashboard" ? { background: "rgba(255,255,255,.1)", color: "#F1F5F9", borderLeftColor: "#00C9A7" } : {}) }}>{"⊙ " + t("Overview", lang)}</button>
          <div style={S.divider} />
        </>)}
        {/* Party sections */}
        {Object.values(PARTY_DEFS).filter(pd => {
          if (!admin && pd.id !== user.partyId) return false;
          return project ? isVisible(project, pd.id) : true;
        }).map(pd => (
          <button key={pd.id} onClick={() => setView(`docs_${pd.id}`)} style={{ ...S.navBtn, ...(view === `docs_${pd.id}` ? { background: "rgba(255,255,255,.1)", color: "#F1F5F9", borderLeftColor: pd.accent } : {}) }}>
            <span>{pd.icon}</span> <span>{getPN(project, pd.id)}</span>
          </button>
        ))}
        {/* Admin only */}
        {admin && (<>
          <div style={S.divider} />
          <button onClick={() => setView("admin")} style={{ ...S.navBtn, ...(view === "admin" ? { background: "rgba(255,255,255,.1)", color: "#F1F5F9" } : {}) }}>{"⊞ " + t("Admin Panel", lang)}</button>
          <button onClick={() => setView("manage")} style={{ ...S.navBtn, ...(view === "manage" ? { background: "rgba(255,255,255,.1)", color: "#F1F5F9" } : {}) }}>{"⊕ " + t("Manage Projects", lang)}</button>
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

/* ═══ DASHBOARD — party specific ═══ */
function DashboardView({ user, project, state, setState, lang = "en", setView }) {
  const admin = isInst(user);
  // Prompt for missing station count on existing projects
  const [editStations, setEditStations] = useState(null);
  const [stationVal, setStationVal] = useState("");

  // Status banner editor (admin)
  const [editStatus, setEditStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState(state?.statusMessage || "");

  if (!project) return <div style={S.page}><div style={S.empty}>{t("Select a project from the sidebar.", lang)}</div></div>;

  // Customer dashboard — station count + key milestones
  if (user.partyId === "customer" && !admin) {
    const progMilestones = (state.docData?.[project.id]?._programDetails?.tasks || []).filter(t => t.type === "milestone").sort((a, b) => new Date(a.date) - new Date(b.date));
    return (
      <div style={S.page}>
        <h2 style={S.h2}>{getPN(project, "customer")} {t("Dashboard", lang)}</h2>
        <p style={S.sub}>{project.name}</p>
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

  // Instrumental / admin dashboard — sees all parties
  return (
    <div style={S.page}>
      {/* Status banner editor */}
      {admin && (
        <div style={{ ...S.card, marginBottom: 20, borderLeft: "3px solid #00C9A7", padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#00C9A7", fontFamily: F }}>{t("📢 Site Status Banner", lang)}</span>
            <button style={S.btnEdit} onClick={() => setEditStatus(!editStatus)}>{editStatus ? t("Cancel", lang) : t("✎ Edit", lang)}</button>
          </div>
          {editStatus ? (
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input style={{ ...S.inp, flex: 1, padding: "8px 12px", fontSize: 14 }} value={statusDraft} onChange={e => setStatusDraft(e.target.value)} placeholder="e.g. Under construction — going live April 2026" />
              <button style={{ ...S.btnMain, width: "auto", padding: "8px 16px", fontSize: 13, marginTop: 0 }} onClick={() => { setState(prev => ({ ...prev, statusMessage: statusDraft })); setEditStatus(false); }}>{t("Save", lang)}</button>
              <button style={{ ...S.btnDel, padding: "8px 12px" }} onClick={() => { setState(prev => ({ ...prev, statusMessage: "" })); setStatusDraft(""); setEditStatus(false); }}>{t("Clear", lang)}</button>
            </div>
          ) : <p style={{ fontSize: 14, color: state?.statusMessage ? "#0F172A" : "#94A3B8", marginTop: 8, fontFamily: F, fontStyle: state?.statusMessage ? "normal" : "italic" }}>{state?.statusMessage || t("No status message set.", lang)}</p>}
        </div>
      )}

      <h2 style={S.h2}>{project.name}</h2>
      <p style={S.sub}>{t("Deployment overview", lang)}</p>

      {/* Station count per project (admin can edit) */}
      <div style={S.gridRow}>
        {Object.values(PARTY_DEFS).filter(pd => isVisible(project, pd.id)).map(pd => {
          const cats = getDocCats(state.docData, project.id, pd.id);
          const totalItems = cats.reduce((a, c) => a + (c.items?.length || 0), 0);
          const milestoneCat = cats.find(c => c.type === "checklist");
          const allChecks = milestoneCat?.milestones?.flatMap(ms => ms.checklist) || [];
          const checkedCount = allChecks.filter(ck => ck.checked).length;
          const totalCount = allChecks.length;
          const msPct = totalCount > 0 ? Math.round((checkedCount / totalCount) * 100) : null;
          const canNav = admin || user.partyId === pd.id;
          return (
            <div key={pd.id} onClick={() => canNav && setView && setView(`docs_${pd.id}`)} style={{ ...S.card, flex: "1 1 200px", borderTop: `3px solid ${pd.accent}`, cursor: canNav ? "pointer" : "default", transition: "box-shadow .15s" }} onMouseEnter={e => { if (canNav) e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,.10)"; }} onMouseLeave={e => e.currentTarget.style.boxShadow=""}>
              <div style={{ fontSize: 16, fontWeight: 700, color: pd.accent, fontFamily: F, marginBottom: 8 }}>{getPN(project, pd.id)}{canNav ? " ↗" : ""}</div>
              <div style={S.miniStat}><span>{t("Folders", lang)}</span><strong>{cats.length}</strong></div>
              <div style={S.miniStat}><span>{t("Documents", lang)}</span><strong>{totalItems || "—"}</strong></div>
              {pd.id === "instrumental" && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#64748B", fontFamily: F, marginBottom: 4 }}>
                    <span>{t("Milestone Progress", lang)}</span>
                    {totalCount > 0 ? <strong style={{ color: pd.accent }}>{msPct}%</strong> : <span style={{ color: "#CBD5E1" }}>—</span>}
                  </div>
                  {totalCount > 0
                    ? <Bar value={msPct} color={pd.accent} h={4} />
                    : <div style={{ fontSize: 11, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>{t("Add checklist items to track progress", lang)}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Station count editor */}
      {admin && (
        <div style={{ ...S.card, marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F }}>Stations: {project.stations || 0}</span>
            {editStations === project.id ? (
              <div style={{ display: "flex", gap: 8 }}>
                <input type="number" style={{ ...S.inp, width: 100, padding: "6px 10px" }} value={stationVal} onChange={e => setStationVal(e.target.value)} placeholder="0" />
                <button style={{ ...S.btnMain, width: "auto", padding: "6px 14px", fontSize: 13, marginTop: 0 }} onClick={() => { setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id === project.id ? { ...p, stations: parseInt(stationVal)||0 } : p) })); setEditStations(null); }}>{t("Save", lang)}</button>
              </div>
            ) : <button style={S.btnEdit} onClick={() => { setEditStations(project.id); setStationVal(project.stations || ""); }}>{t("✎ Edit", lang)}</button>}
          </div>
        </div>
      )}

      {/* Customer View — always visible to instrumental/admin */}
      {(() => {
        const progMilestones = (state.docData?.[project.id]?._programDetails?.tasks || []).filter(t => t.type === "milestone").sort((a, b) => new Date(a.date) - new Date(b.date));
        return (
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 12, paddingBottom: 8, borderBottom: "2px solid #F1F5F9" }}>{t("Customer View", lang)}</div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div style={{ ...S.card, flex: "1 1 160px", borderTop: "3px solid #F59E0B" }}>
                <div style={{ fontSize: 14, color: "#64748B", fontFamily: F, marginBottom: 6 }}>{t("Stations", lang)}</div>
                <div style={{ fontSize: 42, fontWeight: 800, color: "#0F172A", fontFamily: F }}>{project.stations || 0}</div>
                <div style={{ fontSize: 13, color: "#94A3B8", fontFamily: F }}>{t("inspection stations for this project", lang)}</div>
              </div>
              <div style={{ ...S.card, flex: "1 1 300px", borderTop: "3px solid #F59E0B" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 10 }}>{t("Key Milestones", lang)}</div>
                {progMilestones.length > 0
                  ? progMilestones.map(m => (
                    <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #F1F5F9" }}>
                      <span style={{ fontSize: 14, fontFamily: F, color: "#1E293B" }}>🏁 {m.name}</span>
                      <span style={{ fontSize: 13, color: "#64748B", fontFamily: F }}>{fmtDay(m.date)}</span>
                    </div>
                  ))
                  : <div style={{ fontSize: 13, color: "#CBD5E1", fontStyle: "italic", fontFamily: F }}>{t("Add milestones in Program Details to display here", lang)}</div>}
              </div>
            </div>
          </div>
        );
      })()}
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
          const url = prompt("PDF URL:"); 
          update({ ...val, [key]: { ...sec, docs: [...(sec.docs||[]), { id: genId(), name, url: url || "", type: "pdf" }] } });
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
          const url = prompt("URL or PDF link:");
          updateProg({ ...prog, docs: [...(prog.docs||[]), { id: genId(), name, url: url || "" }] });
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
  const canEdit = user.role === "admin"; // only explicit admins can edit

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
    const c = ensureCats();
    updateCats(c.map(cat => cat.id !== catId ? cat : { ...cat, items: [...(cat.items||[]), { id: genId(), name: itemForm.name.trim(), url: itemForm.url.trim() || null, type: itemForm.type, lang: itemForm.lang, addedAt: new Date().toISOString(), addedBy: user.name }] }));
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
        const addTLink = () => { if (!tlForm.name.trim()) return; const nl = { id: genId(), ...tlForm, addedAt: new Date().toISOString(), addedBy: user.name }; setState(prev => ({ ...prev, docData: { ...prev.docData, [pid]: { ...(prev.docData?.[pid]||{}), _training: { ...(prev.docData?.[pid]?._training||{}), [partyId]: { ...td, links: [...links, nl] } } } } })); setTlForm({ name: "", url: "", belt: "white" }); setAddTL(false); };
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

  const approve = async (pu) => {
    const f = approveForm[pu.id] || {};
    if (!f.partyId) return;
    const selProj = Object.entries(f.projects || {}).filter(([,v]) => v).map(([k]) => k);
    if (selProj.length === 0) return;
    const nu = { id: pu.id, name: pu.name, email: pu.email, photoURL: pu.photoURL || null, role: "user", partyId: f.partyId, projects: selProj, createdAt: pu.requestedAt, approvedAt: new Date().toISOString() };
    try { await dbWrite(`users/${pu.id}`, nu); await dbWrite(`pendingUsers/${pu.id}`, null); } catch(e) { console.error(e); }
  };
  const deny = async (pu) => { try { await dbWrite(`pendingUsers/${pu.id}`, null); } catch(e) { console.error(e); } };
  const removeUser = async (uid) => { try { await dbWrite(`users/${uid}`, null); setState(prev => ({ ...prev, users: (prev.users||[]).filter(u => u.id !== uid) })); } catch(e) { console.error(e); } };
  const promoteAdmin = async (uid) => {
    if (!currentUser?.superAdmin) { alert("Only the super admin can promote users to admin."); return; }
    const target = (users||[]).find(u => u.id === uid);
    if (!target?.email?.endsWith("@instrumental.com")) { alert("Only @instrumental.com users can be promoted to admin."); return; }
    if (!confirm(`Make ${target.name} an admin? They'll have full edit access.`)) return;
    try { await dbWrite(`users/${uid}/role`, "admin"); await dbWrite(`users/${uid}/partyId`, "instrumental"); setState(prev => ({ ...prev, users: (prev.users||[]).map(u => u.id !== uid ? u : { ...u, role: "admin", partyId: "instrumental" }) })); } catch(e) { console.error(e); }
  };
  const addProject = (uid, pid) => {
    const u = (users||[]).find(u => u.id === uid); if (!u || (u.projects||[]).includes(pid)) return;
    const np = [...(u.projects||[]), pid];
    setState(prev => ({ ...prev, users: (prev.users||[]).map(usr => usr.id !== uid ? usr : { ...usr, projects: np }) }));
    dbWrite(`users/${uid}/projects`, np).catch(console.error);
  };
  const removeProject = (uid, pid) => {
    const np = ((users||[]).find(u => u.id === uid)?.projects||[]).filter(p => p !== pid);
    setState(prev => ({ ...prev, users: (prev.users||[]).map(u => u.id !== uid ? u : { ...u, projects: np }) }));
    dbWrite(`users/${uid}/projects`, np).catch(console.error);
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
  const admins = (users||[]).filter(u => u.role === "admin");
  const externals = (users||[]).filter(u => u.role !== "admin");

  return (
    <div style={S.page}>
      <h2 style={S.h2}>Admin Panel</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
        {[{ id: "pending", label: `Pending${pending.length > 0 ? ` (${pending.length})` : ""}` }, { id: "users", label: "User Access" }, { id: "restricted", label: "Restricted Folders" }].map(t => (
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
              <label style={S.lbl}>Assign Party</label>
              <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                {Object.values(PARTY_DEFS).filter(p => p.id !== "instrumental").map(p => (
                  <button key={p.id} onClick={() => setApproveForm(prev => ({ ...prev, [pu.id]: { ...prev[pu.id], partyId: p.id } }))} style={{ padding: "6px 14px", borderRadius: 8, border: `2px solid ${f.partyId === p.id ? p.accent : "#E2E8F0"}`, background: f.partyId === p.id ? `${p.accent}15` : "#FFF", color: f.partyId === p.id ? p.accent : "#94A3B8", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: F }}>{p.defaultName}</button>
                ))}
              </div>
              <label style={S.lbl}>Assign Projects</label>
              {allProjects.filter(p => p.status !== "deprecated").map(proj => {
                const ck = f.projects?.[proj.id] || false;
                return (
                  <div key={proj.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "4px 0" }} onClick={() => setApproveForm(prev => ({ ...prev, [pu.id]: { ...prev[pu.id], projects: { ...(prev[pu.id]?.projects||{}), [proj.id]: !ck } } }))}>
                    <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${ck ? "#00C9A7" : "#CBD5E1"}`, background: ck ? "#00C9A7" : "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#FFF", fontWeight: 800 }}>{ck ? "✓" : ""}</div>
                    <span style={{ fontSize: 14, fontFamily: F }}>{proj.name}</span>
                  </div>
                );
              })}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button style={{ ...S.btnMain, width: "auto", padding: "10px 20px", marginTop: 0, opacity: (f.partyId && Object.values(f.projects||{}).some(v=>v)) ? 1 : .4 }} onClick={() => approve(pu)} disabled={!f.partyId || !Object.values(f.projects||{}).some(v=>v)}>✓ Approve</button>
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
          <h3 style={{ ...S.h3, marginTop: 20, marginBottom: 10 }}>External Users</h3>
          {externals.length === 0 ? <div style={S.empty}>No external users yet.</div> : externals.map(u => {
            const p = PARTY_DEFS[u.partyId];
            return (
              <div key={u.id} style={{ ...S.card, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                  {u.photoURL ? <img src={u.photoURL} style={{ width: 32, height: 32, borderRadius: 8 }} alt="" referrerPolicy="no-referrer" /> : <div style={{ ...S.ava, background: p?.accent||"#94A3B8", width: 32, height: 32 }}>{(u.name||"?")[0]}</div>}
                  <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A", fontFamily: F }}>{u.name}</div><div style={{ fontSize: 12, color: "#64748B" }}>{u.email}</div></div>
                  <Chip small color={`${p?.accent}22`} fg={p?.accent}>{p?.defaultName}</Chip>
                  <button style={{ ...S.btnEdit, fontSize: 11 }} onClick={() => promoteAdmin(u.id)}>⬆ Admin</button>
                  <button style={{ ...S.btnDel, fontSize: 11 }} onClick={() => removeUser(u.id)}>Remove</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "#94A3B8", fontWeight: 700 }}>Projects:</span>
                  {(u.projects||[]).map(pid => { const proj = allProjects.find(p => p.id === pid); return proj ? <span key={pid} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 6, background: "#F1F5F9", fontSize: 12, fontFamily: F }}>{proj.name}<span style={{ cursor: "pointer", color: "#DC2626", fontWeight: 700 }} onClick={() => removeProject(u.id, pid)}>✕</span></span> : null; })}
                  <select style={{ ...S.inp, width: 140, padding: "3px 6px", fontSize: 11 }} value="" onChange={e => e.target.value && addProject(u.id, e.target.value)}>
                    <option value="">+ Add</option>
                    {allProjects.filter(p => !(u.projects||[]).includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* RESTRICTED FOLDERS TAB */}
      {tab === "restricted" && (
        <div>
          <p style={{ fontSize: 14, color: "#64748B", fontFamily: F, marginBottom: 16 }}>Grant users access to restricted folders per project. Currently you and other admins always have access.</p>
          {allProjects.filter(p => p.status !== "deprecated").map(proj => {
            const allCats = Object.entries(SEED_DOC_CATEGORIES).flatMap(([party, cats]) => cats.filter(c => c.accessLevel === "restricted").map(c => ({ ...c, party })));
            const projCats = Object.entries(state.docData?.[proj.id] || {}).flatMap(([party, cats]) => Array.isArray(cats) ? cats.filter(c => c.accessLevel === "restricted").map(c => ({ ...c, party })) : []);
            const restricted = [...allCats, ...projCats].filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i);
            if (restricted.length === 0) return null;
            return (
              <div key={proj.id} style={{ ...S.card, marginBottom: 12 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", fontFamily: F, marginBottom: 10 }}>{proj.name}</div>
                {restricted.map(cat => (
                  <div key={cat.id} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#64748B", fontFamily: F, marginBottom: 4 }}>🔒 {cat.name} ({getPN(proj, cat.party)})</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {(externals).map(u => {
                        const has = getRestricted(proj.id, cat.id).includes(u.id);
                        return (
                          <button key={u.id} onClick={() => toggleRestricted(proj.id, cat.id, u.id)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${has ? "#00C9A7" : "#E2E8F0"}`, background: has ? "#ECFDF5" : "#FFF", color: has ? "#059669" : "#94A3B8", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: F }}>{u.name}{has ? " ✓" : ""}</button>
                        );
                      })}
                      {externals.length === 0 && <span style={{ fontSize: 12, color: "#94A3B8", fontFamily: F }}>No external users to grant access to.</span>}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ═══ MANAGE PROJECTS — with station count input ═══ */
function ManageProjects({ state, setState }) {
  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState("active");
  const [form, setForm] = useState({ name: "", customer: "", si: "", cm: "", stations: "", docLink: "" });
  const [editingNames, setEditingNames] = useState(null);

  const addProj = () => {
    if (!form.name.trim() || !form.customer.trim()) return;
    const proj = { id: genId(), name: form.name.trim(), customer: form.customer.trim(), si: form.si.trim(), cm: form.cm.trim(), stations: parseInt(form.stations) || 0, status: formType === "deprecated" ? "deprecated" : "active", docLink: form.docLink.trim() || null,
      partyNames: { instrumental: "Instrumental", si: form.si.trim() || "Systems Integrator", customer: form.customer.trim(), cm: form.cm.trim() || "Contract Manufacturer" } };
    setState(prev => ({ ...prev, projects: [...(prev.projects||[]), proj] }));
    setForm({ name: "", customer: "", si: "", cm: "", stations: "", docLink: "" }); setShowForm(false);
  };
  const toggleStatus = (pid) => setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id !== pid ? p : { ...p, status: p.status === "deprecated" ? "active" : "deprecated" }) }));
  const updatePN = (pid, key, val) => setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id !== pid ? p : { ...p, partyNames: { ...(p.partyNames||{}), [key]: val } }) }));
  const updateDocLink = (pid, link) => setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id !== pid ? p : { ...p, docLink: link }) }));
  const updateStations = (pid, val) => setState(prev => ({ ...prev, projects: (prev.projects||[]).map(p => p.id !== pid ? p : { ...p, stations: parseInt(val)||0 }) }));

  const active = (state.projects||[]).filter(p => p.status !== "deprecated");
  const past = (state.projects||[]).filter(p => p.status === "deprecated");

  const renderCard = (proj) => {
    const ed = editingNames === proj.id;
    const names = proj.partyNames || {};
    const isPast = proj.status === "deprecated";
    return (
      <div key={proj.id} style={{ ...S.card, marginBottom: 10, opacity: isPast ? .75 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: ed ? 14 : 0 }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#0F172A", fontFamily: F }}>{proj.name}</div>
            {!ed && <div style={{ fontSize: 13, color: "#64748B", fontFamily: F, marginTop: 2 }}>{getPN(proj, "customer")} · SI: {getPN(proj, "si")} · CM: {getPN(proj, "cm")} · Stations: {proj.stations || 0}</div>}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <Chip color={isPast ? "#FEF3C7" : "#ECFDF5"} fg={isPast ? "#D97706" : "#059669"}>{isPast ? "Past" : "Active"}</Chip>
            <button style={S.btnEdit} onClick={() => toggleStatus(proj.id)}>{isPast ? "↑ Reactivate" : "↓ Archive"}</button>
            {!isPast && <button style={S.btnEdit} onClick={() => setEditingNames(ed ? null : proj.id)}>{ed ? "✓ Done" : "✎ Edit"}</button>}
          </div>
        </div>
        {isPast && proj.docLink && <div style={{ marginTop: 6 }}><span style={{ fontSize: 12, color: "#64748B" }}>📁 </span><a href={proj.docLink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "#0284C7", fontFamily: F }}>{proj.docLink}</a></div>}
        {isPast && !proj.docLink && <button style={{ ...S.btnEdit, marginTop: 6, fontSize: 11 }} onClick={() => { const l = prompt("Doc link:", proj.docLink || ""); if (l !== null) updateDocLink(proj.id, l); }}>+ Add doc link</button>}
        {ed && (
          <div style={{ padding: 14, background: "#F8FAFC", borderRadius: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {Object.entries(PARTY_DEFS).map(([k, p]) => <div key={k}><label style={{ ...S.lbl, marginTop: 0 }}>{p.icon} {p.defaultName}</label><input style={S.inp} value={names[k] || p.defaultName} onChange={e => updatePN(proj.id, k, e.target.value)} /></div>)}
            </div>
            <div style={{ marginTop: 10 }}>
              <label style={S.lbl}>Station Count</label>
              <input type="number" style={{ ...S.inp, width: 140 }} value={proj.stations || ""} onChange={e => updateStations(proj.id, e.target.value)} placeholder="0" />
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
      <p style={S.sub}>Create projects, edit party names, manage station counts.</p>
      {showForm && (
        <div style={{ ...S.card, marginBottom: 20 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <button onClick={() => setFormType("active")} style={{ ...S.typeBtn, ...(formType === "active" ? S.typeBtnActive : {}) }}>Active</button>
            <button onClick={() => setFormType("deprecated")} style={{ ...S.typeBtn, ...(formType === "deprecated" ? { background: "#FEF3C7", borderColor: "#D97706", color: "#D97706" } : {}) }}>Past / Deprecated</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div><label style={S.lbl}>Project Name</label><input style={S.inp} value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} placeholder="e.g. NVIDIA HGX Inspection" /></div>
            <div><label style={S.lbl}>Customer</label><input style={S.inp} value={form.customer} onChange={e => setForm(f => ({...f, customer: e.target.value}))} placeholder="e.g. NVIDIA" /></div>
            <div><label style={S.lbl}>Systems Integrator</label><input style={S.inp} value={form.si} onChange={e => setForm(f => ({...f, si: e.target.value}))} placeholder="e.g. Anda Technologies (or N/A)" /></div>
            <div><label style={S.lbl}>Contract Manufacturer</label><input style={S.inp} value={form.cm} onChange={e => setForm(f => ({...f, cm: e.target.value}))} placeholder="e.g. Foxconn (or N/A)" /></div>
          </div>
          {formType === "active" && <div><label style={S.lbl}>Number of Stations</label><input type="number" style={{ ...S.inp, width: 160 }} value={form.stations} onChange={e => setForm(f => ({...f, stations: e.target.value}))} placeholder="0" /></div>}
          {formType === "deprecated" && <div><label style={S.lbl}>Documentation Link</label><input style={S.inp} value={form.docLink} onChange={e => setForm(f => ({...f, docLink: e.target.value}))} placeholder="https://drive.google.com/..." /></div>}
          <button style={{ ...S.btnMain, marginTop: 16, width: "auto", padding: "10px 24px" }} onClick={addProj}>Create {formType === "deprecated" ? "Past" : "Active"} Project</button>
        </div>
      )}

      <h3 style={{ ...S.h3, marginBottom: 10 }}>Active ({active.length})</h3>
      {active.length === 0 ? <div style={{ ...S.empty, marginBottom: 20 }}>No active projects.</div> : active.map(renderCard)}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24, marginBottom: 10 }}>
        <h3 style={{ ...S.h3, color: "#94A3B8" }}>Past ({past.length})</h3>
        <button style={{ ...S.btnEdit, fontSize: 12 }} onClick={() => {
          const csv = prompt("Paste past projects, one per line:\nFormat: Name, Customer, SI, CM, Doc Link");
          if (!csv) return;
          const newP = csv.split("\n").filter(l => l.trim()).map(l => { const p = l.split(",").map(s => s.trim()); return { id: genId(), name: p[0]||"Unnamed", customer: p[1]||"", si: p[2]||"", cm: p[3]||"", docLink: p[4]||null, stations: 0, status: "deprecated", partyNames: { instrumental: "Instrumental", si: p[2]||"SI", customer: p[1]||"Customer", cm: p[3]||"CM" } }; });
          setState(prev => ({ ...prev, projects: [...(prev.projects||[]), ...newP] }));
        }}>📋 Bulk Import</button>
      </div>
      {past.length === 0 ? <div style={S.empty}>No past projects.</div> : past.map(renderCard)}
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

  // 2. User init — AUTO-APPROVE @instrumental.com
  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    const init = async () => {
      try {
        const dbUser = await dbRead(`users/${authUser.uid}`);
        if (cancelled) return;
        if (dbUser) { setUser(dbUser); if (dbUser.langPref) setLang(dbUser.langPref); setPendingApproval(false); return; }

        const allUsers = await dbRead("users");
        if (cancelled) return;
        const isFirst = !allUsers || Object.keys(allUsers).length === 0;
        const email = authUser.email || "";
        const isInstDomain = email.endsWith("@instrumental.com");

        if (isFirst) {
          const { projects, progress, docData } = getDefault();
          const nu = { id: authUser.uid, name: authUser.displayName || email, email, photoURL: authUser.photoURL || null, role: "admin", partyId: "instrumental", projects: projects.map(p => p.id), createdAt: new Date().toISOString() };
          await dbWrite("appState/projects", projects);
          await dbWrite("appState/progress", progress);
          await dbWrite("appState/docData", docData);
          await dbWrite("appState/statusMessage", "");
          await dbWrite(`users/${authUser.uid}`, nu);
          if (!cancelled) { setUser(nu); setPendingApproval(false); }
        } else if (isInstDomain) {
          // Auto-approve @instrumental.com users as instrumental party — admin must be explicitly granted
          const allProj = await dbRead("appState/projects") || [];
          const projIds = (Array.isArray(allProj) ? allProj : Object.values(allProj)).map(p => p.id);
          const nu = { id: authUser.uid, name: authUser.displayName || email, email, photoURL: authUser.photoURL || null, role: "user", partyId: "instrumental", projects: projIds, createdAt: new Date().toISOString() };
          await dbWrite(`users/${authUser.uid}`, nu);
          if (!cancelled) { setUser(nu); setPendingApproval(false); }
        } else {
          // External user — needs approval
          await dbWrite(`pendingUsers/${authUser.uid}`, { id: authUser.uid, name: authUser.displayName || email, email, photoURL: authUser.photoURL || null, requestedAt: new Date().toISOString() });
          if (!cancelled) setPendingApproval(true);
        }
      } catch (e) { console.error(e); if (!cancelled) setLoginErr("Database error. Please refresh."); }
    };
    init();
    return () => { cancelled = true; };
  }, [authUser]);

  // 3. DB listeners
  useEffect(() => {
    if (!user) return;
    const unsubs = [];
    unsubs.push(onValue(ref(db, "appState/projects"), (s) => { const v = s.val(); if (v) setState(prev => ({ ...prev, projects: Array.isArray(v) ? v : Object.values(v) })); }, (e) => console.error(e)));
    unsubs.push(onValue(ref(db, "appState/docData"), (s) => { setState(prev => ({ ...prev, docData: s.val() || {} })); }, (e) => console.error(e)));
    if (user.role === "admin") {
      unsubs.push(onValue(ref(db, "appState/progress"), (s) => { setState(prev => ({ ...prev, progress: s.val() || {} })); }, (e) => console.error(e)));
    } else {
      unsubs.push(onValue(ref(db, `appState/progress/${user.id}`), (s) => { setState(prev => ({ ...prev, progress: { ...(prev.progress||{}), [user.id]: s.val() || {} } })); }, (e) => console.error(e)));
    }
    unsubs.push(onValue(ref(db, "appState/statusMessage"), (s) => { setState(prev => ({ ...prev, statusMessage: s.val() || "" })); }, (e) => console.error(e)));
    unsubs.push(onValue(ref(db, "users"), (s) => { const v = s.val(); if (v) setState(prev => ({ ...prev, users: Object.values(v) })); }));
    if (user.role === "admin") { unsubs.push(onValue(ref(db, "pendingUsers"), (s) => { const v = s.val(); setPendingUsers(v ? Object.values(v) : []); })); }
    setLoaded(true);
    return () => unsubs.forEach(u => { try { u(); } catch(e) {} });
  }, [user]);

  // Save
  const save = useCallback((updater) => {
    setState(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next.projects !== prev.projects) dbWrite("appState/projects", next.projects).catch(console.error);
      if (next.docData !== prev.docData) dbWrite("appState/docData", next.docData).catch(console.error);
      if (next.progress !== prev.progress) dbWrite("appState/progress", next.progress).catch(console.error);
      if (next.statusMessage !== prev.statusMessage) dbWrite("appState/statusMessage", next.statusMessage).catch(console.error);
      if (next.users !== prev.users && Array.isArray(next.users)) next.users.forEach(u => { if (u.id) dbWrite(`users/${u.id}`, u).catch(console.error); });
      return next;
    });
  }, []);

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

  const userProjects = (Array.isArray(state.projects) ? state.projects : []).filter(p => user.role === "admin" || (user.projects||[]).includes(p.id));
  const admin = isInst(user);

  const renderMain = () => {
    if (view === "dashboard" || (!view.startsWith("docs_") && view !== "admin" && view !== "manage")) {
      if (user.partyId !== "instrumental" && user.partyId !== "customer" && user.role !== "admin") return <div style={S.page}><div style={S.empty}>Access denied.</div></div>;
      return <DashboardView user={user} project={project} state={state} setState={save} lang={lang} setView={setView} />;
    }
    if (view.startsWith("docs_")) {
      const pid = view.replace("docs_", "");
      if (!admin && pid !== user.partyId) return <div style={S.page}><div style={S.empty}>Access denied.</div></div>;
      return <DocsView partyId={pid} user={user} project={project} state={state} setState={save} lang={lang} />;
    }
    if (view === "admin" && admin) return <AdminView state={state} setState={save} allProjects={Array.isArray(state.projects) ? state.projects : []} pendingUsers={pendingUsers} currentUser={user} />;
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
        <Sidebar view={view} setView={setView} user={user} project={project} projects={userProjects} setProject={setProject} onLogout={onLogout} lang={lang} setLang={setLang} />
        <main style={S.main}>{renderMain()}</main>
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
