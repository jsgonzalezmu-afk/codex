
/* ═══════════════════════════════════════════════════════
   CONFIGURACIÓN SUPABASE
═══════════════════════════════════════════════════════ */
const SUPABASE_URL     = "https://fcvtjzkhwjqkygghttmg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Bzez62wgnyfb_HuFfln1Gw_BZBAPq1a";

const ADMIN_EMAIL = "jsgonzalezmu@gmail.com";

/* Groq — gratuito, rápido, compatible con formato OpenAI */
const OPENAI_MODEL   = "llama-3.1-8b-instant";
const OPENAI_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const isConfigured = SUPABASE_URL !== "TU_URL";
if (!isConfigured) document.getElementById("config-banner").style.display = "block";

const { createClient } = supabase;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ── ESTADO GLOBAL ── */
let currentUser      = null;   // session.user object from Supabase
let isAdmin          = false;
let minutasData      = [];
let minutasFiltradas = [];
let categoriasData   = [];
let currentMinuta    = null;
let currentStep      = 1;
let camposLlenados   = {};   // campos normales
let camposIALlenados = {};   // textos crudos del usuario para IA
let camposIAMejorados = {};  // textos ya mejorados por IA
let docxBlob         = null;
let pagoExitoso      = false;
let wompiConfig      = {};
let geminiConfig     = {};   // { apiKey: "..." }
let modoPrueba       = false; // Modo prueba: omite pago real
let currentWompiTransactionId = null;
let suscripcionMonitoreo = null; // null | { plan: "basico"|"premium", created_at }
let monitoreoConfig      = {};   // { precio_basico, precio_premium }
let googleConfig         = {};   // { gaMeasurementId, recaptchaSiteKey }

/* Indica si la minuta actual tiene campos de IA */
let minutaTieneIA = false;
/* Nombres de placeholders de IA detectados en el Word */
let placeholdersIA = [];
/* Indica si la IA ya procesó los campos en la sesión actual */
let iaYaProcesada = false;

/* Minuta pendiente: se guarda cuando el usuario es redirigido al login */
let pendingMinutaId       = null;
let pendingCamposSnapshot = null;
let pendingResumeState    = null;

/* ── LÍMITE DE USO DE IA ── */
const IA_MAX_USOS   = 3;
const IA_BLOQUEO_MS = 60 * 60 * 1000; // 1 hora

/* ─────────────────────────────────────────────────────
   LÍMITES DE IA Y PREVISUALIZACIONES — Supabase
   Tabla: app_limites  (user_id, clave, usos, bloqueado_hasta)
───────────────────────────────────────────────────── */
function _limClient() { return window.supabaseClient || null; }

async function _limUser() {
  const c = _limClient();
  if (!c) return null;
  const { data } = await c.auth.getUser();
  return data?.user || null;
}

async function _limLeer(clave) {
  try {
    const c = _limClient(); if (!c) return null;
    const u = await _limUser(); if (!u) return null;
    const { data } = await c
      .from("app_limites")
      .select("usos, bloqueado_hasta")
      .eq("user_id", u.id).eq("clave", clave)
      .maybeSingle();
    return data || null;
  } catch(_) { return null; }
}

async function _limEscribir(clave, usos, bloqueadoHasta) {
  try {
    const c = _limClient(); if (!c) return;
    const u = await _limUser(); if (!u) return;
    await c.from("app_limites").upsert(
      { user_id: u.id, clave, usos, bloqueado_hasta: bloqueadoHasta || null,
        updated_at: new Date().toISOString() },
      { onConflict: "user_id,clave" }
    );
  } catch(_) {}
}

/* ── Límite de IA ─────────────────────────────────── */
function _iaLimClave() {
  const mid = currentMinuta ? (currentMinuta.id || currentMinuta.nombre || "none") : "none";
  return `ia_${mid}`;
}

async function iaLimitCheck() {
  const data = await _limLeer(_iaLimClave());
  if (!data) return { bloqueado: false, usos: 0, msRestantes: 0 };
  const now = Date.now();
  const bh  = data.bloqueado_hasta ? new Date(data.bloqueado_hasta).getTime() : 0;
  if (bh > now)  return { bloqueado: true, usos: data.usos, bloqueadoHasta: bh, msRestantes: bh - now };
  if (bh && bh <= now) {
    await _limEscribir(_iaLimClave(), 0, null);  /* reset automático */
    return { bloqueado: false, usos: 0, msRestantes: 0 };
  }
  return { bloqueado: false, usos: data.usos, msRestantes: 0 };
}

async function iaLimitIncrement() {
  const data = await _limLeer(_iaLimClave());
  const usos = ((data?.usos) || 0) + 1;
  const bh   = usos >= IA_MAX_USOS ? new Date(Date.now() + IA_BLOQUEO_MS).toISOString() : null;
  await _limEscribir(_iaLimClave(), usos, bh);
  return usos >= IA_MAX_USOS;
}

function iaLimitMensaje(msRestantes) {
  const totalMin = Math.ceil(msRestantes / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const tiempo = h > 0 ? `${h}h ${m}m` : `${m} minutos`;
  return `Has alcanzado el límite de ${IA_MAX_USOS} usos de IA para este contrato. Podrás volver a usarla en ${tiempo}.`;
}

/* ── PAGINADO ── */
const MINUTAS_PER_PAGE    = 10;
let minutasCurrentPage    = 1;
const CAMPOS_PER_PAGE     = 5;
let camposCurrentPage     = 1;
let camposTotalPages      = 1;
const ADMIN_ITEMS_PER_PAGE = 10;
let adminMinutasPage      = 1;
let adminMinutasAll       = [];
let adminVentasPage       = 1;
let adminVentasAll        = [];
const HISTORIAL_PER_PAGE  = 10;
let historialPage         = 1;
let historialAll          = [];

/* ── VARIABLES ADMIN para campos IA del Word subido ── */
let adminDocxBuffer    = null;
let adminPlaceholdersIA = [];

/* ── VARIABLES CLAUSULAS OPCIONALES (ELECCION USUARIO) ── */
let adminClausulasEleccion = [];
let minutaClausulas        = [];
let eleccionesClausulas    = {};
let camposClausulas        = {};

/* ─────────────────────────────────────────────────────
   NAVEGACIÓN Y AUTH
───────────────────────────────────────────────────── */
function showSection(id) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-link").forEach(b => b.classList.remove("active"));
  const s = document.getElementById(id);
  if (s) s.classList.add("active");
  document.body.classList.remove("on-inicio","on-minutas","on-usuarios","on-asesoria","on-admin","on-monitoreo");
  document.body.classList.add("on-" + id);
  window.scrollTo({ top: 0, behavior: "smooth" });
  ga4_page_view(id);
  if (id === "minutas" && !minutasData.length) loadMinutas();
  if (id === "usuarios") {
    if (currentUser) {
      document.getElementById("view-auth").style.display = "none";
      document.getElementById("view-perfil").style.display = "block";
      document.getElementById("perfil-email-texto").textContent = currentUser.email;
      cargarHistorialUsuario();
      cargarSuscripcionPerfil();
    } else {
      document.getElementById("view-auth").style.display = "block";
      document.getElementById("view-perfil").style.display = "none";
    }
  }
  if (id === "admin" && isAdmin) {
    renderAdminData();
    loadAdminCategorias();
    cargarWompiConfigAdmin();
    cargarGeminiConfigAdmin();
    cargarPlanesMonitoreoAdmin();
    cargarGoogleConfigAdmin();
    actualizarEstadoModoPrueba();
    registrarAccesoAdmin(); /* ② Log de acceso admin */
  }
  if (id === "monitoreo") {
    iniciarMonitoreoSection();
  }
  actualizarNavActivo(id);
}

function actualizarNavActivo(id) {
  document.querySelectorAll("nav .nav-link, .mobile-menu-panel .nav-link").forEach(b => b.classList.remove("active"));
  const mapa = {
    inicio:   ["nav-inicio",   "nav-inicio-mobile"],
    minutas:  ["nav-minutas",  "nav-minutas-mobile"],
    usuarios: ["nav-usuarios", "nav-usuarios-mobile"],
    asesoria: ["nav-asesoria", "nav-asesoria-mobile"],
    admin:    ["nav-admin",    "nav-admin-mobile"],
    monitoreo: ["nav-monitoreo", "nav-monitoreo-mobile"]
  };
  if (mapa[id]) {
    mapa[id].forEach(elId => {
      const el = document.getElementById(elId);
      if (el) el.classList.add("active");
    });
  }
}

/* ── AUTH STATE ── */
supabaseClient.auth.onAuthStateChange((event, session) => {
  currentUser = session ? session.user : null;
  isAdmin = currentUser && currentUser.email === ADMIN_EMAIL;
  if (currentUser) {
    document.getElementById("auth-logged-out").style.display = "none";
    document.getElementById("auth-logged-in").style.display = "flex";
    document.getElementById("user-email").textContent = currentUser.email;
    document.getElementById("nav-admin").style.display = isAdmin ? "inline-flex" : "none";
    const navAdminMobile = document.getElementById("nav-admin-mobile");
    if (navAdminMobile) navAdminMobile.style.display = isAdmin ? "flex" : "none";
    const navUsu = document.getElementById("nav-usuarios");
    if (navUsu) navUsu.textContent = "Mi perfil";
    const navUsuMobile = document.getElementById("nav-usuarios-mobile");
    if (navUsuMobile) navUsuMobile.textContent = "Mi perfil";
    const mobileOut = document.getElementById("mobile-auth-logged-out");
    const mobileIn  = document.getElementById("mobile-auth-logged-in");
    const mobileEmail = document.getElementById("mobile-user-email-text");
    if (mobileOut) mobileOut.style.display = "none";
    if (mobileIn)  mobileIn.style.display  = "block";
    if (mobileEmail) mobileEmail.textContent = currentUser.email;
  } else {
    document.getElementById("auth-logged-out").style.display = "flex";
    document.getElementById("auth-logged-in").style.display = "none";
    document.getElementById("nav-admin").style.display = "none";
    const navAdminMobile = document.getElementById("nav-admin-mobile");
    if (navAdminMobile) navAdminMobile.style.display = "none";
    const navUsu = document.getElementById("nav-usuarios");
    if (navUsu) navUsu.textContent = "Usuarios";
    const navUsuMobile = document.getElementById("nav-usuarios-mobile");
    if (navUsuMobile) navUsuMobile.textContent = "Usuarios";
    const mobileOut = document.getElementById("mobile-auth-logged-out");
    const mobileIn  = document.getElementById("mobile-auth-logged-in");
    if (mobileOut) mobileOut.style.display = "block";
    if (mobileIn)  mobileIn.style.display  = "none";
  }
});

function authError(code) {
  const m = {
    "auth/wrong-password":        "Contraseña incorrecta.",
    "auth/user-not-found":        "No existe una cuenta con ese correo.",
    "email already in use":       "Ya existe una cuenta con ese correo.",
    "Password should be":         "La contraseña debe tener al menos 6 caracteres.",
    "Invalid login credentials":  "Correo o contraseña incorrectos.",
    "auth/invalid-email":         "El correo no es válido.",
    "auth/too-many-requests":     "Demasiados intentos. Espera un momento.",
    "auth/requires-recent-login": "Por seguridad, vuelve a iniciar sesión para hacer este cambio."
  };
  if (!code) return "Error de autenticación.";
  for (const [k, v] of Object.entries(m)) {
    if (code.includes(k)) return v;
  }
  return code || "Error de autenticación.";
}

function toast(msg, type) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (type === "error" ? " error" : type === "ok" ? " ok" : "");
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3800);
}

/* ── LOGIN ── */
document.getElementById("form-login").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = document.getElementById("btn-login");
  btn.disabled = true; btn.textContent = "Iniciando sesión...";
  try {
    await obtenerTokenRecaptcha("login"); /* reCAPTCHA v3 */
    const { error } = await supabaseClient.auth.signInWithPassword({
      email:    document.getElementById("login-email").value.trim(),
      password: document.getElementById("login-password").value
    });
    if (error) throw error;
    gtag_evento("login", { method: "email" }); /* GA4 */
    if (pendingMinutaId) {
      const savedId = pendingMinutaId;
      const state   = pendingResumeState;
      pendingMinutaId = null; pendingCamposSnapshot = null; pendingResumeState = null;
      toast("¡Bienvenido! Continúa donde lo dejaste.", "ok");
      await abrirMinuta(savedId);
      restaurarEstadoModal(state);
    } else {
      toast("¡Bienvenido!", "ok");
      showSection("inicio");
    }
  } catch(err) { toast(authError(err.message || err.code), "error"); }
  finally { btn.disabled = false; btn.textContent = "Iniciar Sesión"; }
});

/* ── REGISTRO ── */
document.getElementById("form-register").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = document.getElementById("btn-register");
  btn.disabled = true; btn.textContent = "Creando cuenta...";
  try {
    await obtenerTokenRecaptcha("register"); /* reCAPTCHA v3 */
    const { error } = await supabaseClient.auth.signUp({
      email:    document.getElementById("reg-email").value.trim(),
      password: document.getElementById("reg-password").value
    });
    if (error) throw error;
    gtag_evento("register", { method: "email" }); /* GA4 */
    if (pendingMinutaId) {
      const savedId = pendingMinutaId;
      const state   = pendingResumeState;
      pendingMinutaId = null; pendingCamposSnapshot = null; pendingResumeState = null;
      toast("¡Cuenta creada! Continúa donde lo dejaste.", "ok");
      await abrirMinuta(savedId);
      restaurarEstadoModal(state);
    } else {
      toast("¡Cuenta creada correctamente!", "ok");
      showSection("inicio");
    }
  } catch(err) { toast(authError(err.message || err.code), "error"); }
  finally { btn.disabled = false; btn.textContent = "Crear Cuenta"; }
});

/* ── LOGOUT ── */
document.getElementById("btn-logout").addEventListener("click", async () => {
  gtag_evento("logout", {}); /* GA4 */
  await supabaseClient.auth.signOut();
  toast("Sesión cerrada.");
  showSection("inicio");
});

const btnLogoutMobile = document.getElementById("btn-logout-mobile");
if (btnLogoutMobile) {
  btnLogoutMobile.addEventListener("click", async () => {
    cerrarMenuMovil();
    gtag_evento("logout", {}); /* GA4 */
    await supabaseClient.auth.signOut();
    toast("Sesión cerrada.");
    showSection("inicio");
  });
}

/* ── MENÚ HAMBURGUESA MÓVIL ── */
function toggleMenuMovil() {
  const menu = document.getElementById("mobile-menu");
  const btn  = document.getElementById("hamburger-btn");
  const open = menu.classList.contains("open");
  if (open) {
    menu.classList.remove("open");
    btn.classList.remove("open");
    document.body.style.overflow = "";
  } else {
    menu.classList.add("open");
    btn.classList.add("open");
    document.body.style.overflow = "hidden";
  }
}

function cerrarMenuMovil() {
  const menu = document.getElementById("mobile-menu");
  const btn  = document.getElementById("hamburger-btn");
  menu.classList.remove("open");
  btn.classList.remove("open");
  document.body.style.overflow = "";
}

function cerrarMenuMovilFondo(e) {
  if (e.target === document.getElementById("mobile-menu")) cerrarMenuMovil();
}

/* ── CAMBIAR EMAIL ── */
document.getElementById("form-cambiar-email").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = document.getElementById("btn-cambiar-email");
  btn.disabled = true; btn.textContent = "Actualizando...";
  try {
    const nuevoEmail = document.getElementById("nuevo-email").value.trim();
    const { error } = await supabaseClient.auth.updateUser({ email: nuevoEmail });
    if (error) throw error;
    toast("Se envió un enlace de confirmación a tu nuevo correo.", "ok");
    document.getElementById("form-cambiar-email").reset();
  } catch(err) { toast(authError(err.message), "error"); }
  finally { btn.disabled = false; btn.textContent = "Actualizar correo"; }
});

/* ── CAMBIAR CONTRASEÑA ── */
document.getElementById("form-cambiar-pass").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = document.getElementById("btn-cambiar-pass");
  btn.disabled = true; btn.textContent = "Actualizando...";
  const passNueva  = document.getElementById("pass-nueva").value;
  const passConf   = document.getElementById("pass-confirmar").value;
  if (passNueva !== passConf) {
    toast("Las contraseñas no coinciden.", "error");
    btn.disabled = false; btn.textContent = "Actualizar contraseña";
    return;
  }
  try {
    // Verifica que la sesión siga activa antes de intentar el cambio
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
      toast("Tu sesión expiró. Por favor inicia sesión de nuevo.", "error");
      btn.disabled = false; btn.textContent = "Actualizar contraseña";
      setTimeout(() => { supabaseClient.auth.signOut(); showSection("usuarios"); }, 1500);
      return;
    }
    const { error } = await supabaseClient.auth.updateUser({ password: passNueva });
    if (error) throw error;
    toast("Contraseña actualizada correctamente.", "ok");
    document.getElementById("form-cambiar-pass").reset();
  } catch(err) { toast(authError(err.message), "error"); }
  finally { btn.disabled = false; btn.textContent = "Actualizar contraseña"; }
});

/* ── HISTORIAL ── */
async function cargarHistorialUsuario() {
  const cont   = document.getElementById("perfil-historial");
  const pagCont = document.getElementById("perfil-historial-pagination");
  cont.innerHTML = "<p class='text-muted'>Cargando...</p>";
  pagCont.innerHTML = "";
  if (!currentUser) { cont.innerHTML = "<p class='text-muted'>No disponible.</p>"; return; }
  try {
    const { data, error } = await supabaseClient
      .from("ventas")
      .select("*")
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    historialAll = data || [];
    historialPage = 1;
    renderHistorial();
  } catch(err) { cont.innerHTML = `<p class='text-muted'>Error: ${err.message}</p>`; }
}

function renderHistorial() {
  const cont   = document.getElementById("perfil-historial");
  const pagCont = document.getElementById("perfil-historial-pagination");
  if (!historialAll.length) { cont.innerHTML = "<p class='text-muted'>Aún no has realizado compras.</p>"; pagCont.innerHTML = ""; return; }
  const totalPages = Math.ceil(historialAll.length / HISTORIAL_PER_PAGE);
  const start = (historialPage - 1) * HISTORIAL_PER_PAGE;
  const slice = historialAll.slice(start, start + HISTORIAL_PER_PAGE);
  cont.innerHTML = slice.map(v => {
    const fecha = v.created_at
      ? new Date(v.created_at).toLocaleString("es-CO", { year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit" })
      : "—";
    return `<div class="historial-item">
      <div class="historial-item-nombre">${esc(v.minuta_nombre||"Minuta")}</div>
      <div class="historial-item-meta">${fecha} · ${esc(v.metodo_pago||"—")}</div>
      <div class="historial-item-precio">$${Number(v.precio||0).toLocaleString("es-CO")} COP <span class="estado-pagado" style="margin-left:8px;">Pagado</span></div>
    </div>`;
  }).join("");
  renderPagination(pagCont, historialPage, totalPages, p => { historialPage = p; renderHistorial(); });
}

/* ─────────────────────────────────────────────────────
   CATEGORÍAS
───────────────────────────────────────────────────── */
const CATS_DEFAULT = ["Arrendamiento","Compraventa","Laboral","Sociedad","Otro"];

async function loadCategorias() {
  try {
    const { data, error } = await supabaseClient
      .from("categorias")
      .select("nombre")
      .order("nombre", { ascending: true });
    if (error) throw error;
    if (!data || !data.length) {
      for (const nombre of CATS_DEFAULT) {
        await supabaseClient.from("categorias").insert({ nombre });
      }
      categoriasData = [...CATS_DEFAULT];
    } else {
      categoriasData = data.map(d => d.nombre);
    }
  } catch(e) { categoriasData = [...CATS_DEFAULT]; }
  renderFiltros();
}

function renderFiltros() {
  const container = document.getElementById("filtros-container");
  container.innerHTML = `<button class="filtro-btn active" data-cat="todos">Todas</button>`;
  categoriasData.forEach(cat => {
    const btn = document.createElement("button");
    btn.className = "filtro-btn";
    btn.dataset.cat = cat;
    btn.textContent = cat;
    btn.onclick = () => {
      document.querySelectorAll(".filtro-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      minutasFiltradas = cat === "todos" ? minutasData : minutasData.filter(m => m.categoria === cat);
      minutasCurrentPage = 1;
      renderMinutas(minutasFiltradas);
    };
    container.appendChild(btn);
  });
  container.querySelector("[data-cat='todos']").onclick = () => {
    document.querySelectorAll(".filtro-btn").forEach(b => b.classList.remove("active"));
    container.querySelector("[data-cat='todos']").classList.add("active");
    minutasFiltradas = minutasData;
    minutasCurrentPage = 1;
    renderMinutas(minutasData);
  };
}

async function loadAdminCategorias() {
  const list   = document.getElementById("cat-tag-list");
  const select = document.getElementById("adm-categoria");
  try {
    const { data, error } = await supabaseClient
      .from("categorias")
      .select("id, nombre")
      .order("nombre", { ascending: true });
    if (error) throw error;
    categoriasData = data || [];
  } catch(e) { categoriasData = CATS_DEFAULT.map(n => ({ nombre: n })); }
  if (!categoriasData.length) { list.innerHTML = "<span class='text-muted'>No hay categorías aún.</span>"; } else {
    list.innerHTML = categoriasData.map(c => `<span class="cat-tag">${esc(c.nombre || c)}<button onclick="eliminarCategoria('${c.id||""}')" title="Eliminar">✕</button></span>`).join("");
  }
  const nombres = categoriasData.map(c => c.nombre || c);
  select.innerHTML = nombres.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
}

async function agregarCategoria() {
  const input = document.getElementById("nueva-cat-input");
  const nombre = input.value.trim();
  if (!nombre) { toast("Escribe el nombre de la categoría.", "error"); return; }
  try {
    const { error } = await supabaseClient.from("categorias").insert({ nombre });
    if (error) throw error;
    toast("Categoría agregada.", "ok");
    input.value = "";
    await loadAdminCategorias();
    await loadCategorias();
  } catch(e) { toast("Error al agregar: " + e.message, "error"); }
}

async function eliminarCategoria(id) {
  if (!id) { toast("No se puede eliminar (sin ID).", "error"); return; }
  if (!confirm("¿Eliminar esta categoría?")) return;
  try {
    const { error } = await supabaseClient.from("categorias").delete().eq("id", id);
    if (error) throw error;
    toast("Categoría eliminada.");
    await loadAdminCategorias();
    await loadCategorias();
  } catch(e) { toast("Error: " + e.message, "error"); }
}

/* ─────────────────────────────────────────────────────
   MINUTAS — CATÁLOGO
───────────────────────────────────────────────────── */
async function loadMinutas() {
  document.getElementById("minutas-grid").innerHTML = '<div class="loading-spinner"></div>';
  document.getElementById("minutas-empty").style.display = "none";
  document.getElementById("minutas-pagination").innerHTML = "";
  try {
    const { data, error } = await supabaseClient
      .from("minutas")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    minutasData = (data || []).map(row => _mapMinuta(row));
    minutasFiltradas = minutasData;
    if (!categoriasData.length) await loadCategorias();
    minutasCurrentPage = 1;
    renderMinutas(minutasData);
    actualizarHeroStatusPill();
  } catch(err) {
    document.getElementById("minutas-grid").innerHTML = "";
    document.getElementById("minutas-empty").style.display = "block";
    document.getElementById("minutas-empty").textContent = "Error: " + err.message;
    actualizarHeroStatusPill();
  }
}

/* Normaliza una fila de Supabase al shape que espera el resto del código
   (camelCase ↔ snake_case) */
function _mapMinuta(row) {
  if (!row) return row;
  return {
    id:                row.id,
    nombre:            row.nombre,
    descripcion:       row.descripcion,
    categoria:         row.categoria,
    tipoDocumento:     row.tipo_documento,
    contextoIA:        row.contexto_ia,
    precio:            row.precio,
    campos:            row.campos            || [],
    camposLargo:       row.campos_largo      || [],
    tieneIA:           row.tiene_ia,
    placeholdersIA:    row.placeholders_ia   || [],
    tieneClausulas:    row.tiene_clausulas,
    clausulasEleccion: row.clausulas_eleccion|| [],
    archivoURL:        row.archivo_url,
    archivoNombre:     row.archivo_nombre,
    docxBase64:        row.docx_base64,
    docxPreviewURL:    row.docx_preview_url,
    soloStorage:       row.solo_storage,
    createdAt:         row.created_at
  };
}

/* ─── Pill de estado en el hero ─── */
async function precargarHeroStatusPill() {
  try {
    if (!minutasData.length) {
      const { count } = await supabaseClient
        .from("minutas")
        .select("id", { count: "exact", head: true });
      window.__heroMinutasCount = count || 0;
    }
    if (!categoriasData.length) {
      try { await loadCategorias(); } catch(_) {}
    }
  } catch(_) {}
  actualizarHeroStatusPill();
}

function actualizarHeroStatusPill() {
  const el = document.getElementById("hero-status-pill-text");
  if (!el) return;
  const totalMin = (minutasData && minutasData.length) || window.__heroMinutasCount || 0;
  const totalCat = (categoriasData && categoriasData.length) || 0;
  if (!totalMin && !totalCat) {
    el.innerHTML = "Catálogo en línea · listo para usar";
    return;
  }
  if (!totalCat) {
    el.innerHTML = "<strong>" + totalMin + "</strong> minuta" + (totalMin === 1 ? "" : "s") + " activa" + (totalMin === 1 ? "" : "s");
    return;
  }
  el.innerHTML =
    "<strong>" + totalMin + "</strong> minuta" + (totalMin === 1 ? "" : "s") + " activa" + (totalMin === 1 ? "" : "s") +
    " en <strong>" + totalCat + "</strong> categoría" + (totalCat === 1 ? "" : "s");
}

function renderMinutas(list) {
  const grid    = document.getElementById("minutas-grid");
  const empty   = document.getElementById("minutas-empty");
  const pagCont = document.getElementById("minutas-pagination");
  grid.innerHTML = ""; pagCont.innerHTML = "";
  if (!list.length) { empty.style.display = "block"; return; }
  empty.style.display = "none";
  const totalPages = Math.ceil(list.length / MINUTAS_PER_PAGE);
  if (minutasCurrentPage > totalPages) minutasCurrentPage = 1;
  const start = (minutasCurrentPage - 1) * MINUTAS_PER_PAGE;
  const slice = list.slice(start, start + MINUTAS_PER_PAGE);
  slice.forEach(m => {
    const card = document.createElement("div");
    card.className = "minuta-card";
    const aiTag = (m.tieneIA && (m.placeholdersIA || []).length)
      ? `<span class="minuta-ai-badge">Redacción IA</span>` : "";
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <div class="minuta-badge">${esc(m.categoria||"Legal")}${aiTag}</div>
        <button class="btn-eye" onclick="previsualizarMinuta('${m.id}',event)">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" xmlns="http://www.w3.org/2000/svg"><path d="M1 10s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7z"/><circle cx="10" cy="10" r="3"/></svg>
          Vista previa
        </button>
      </div>
      <h3>${esc(m.nombre)}</h3>
      <p>${esc(m.descripcion||"")}</p>
      <div class="minuta-campos">
        <strong>Campos personalizables:</strong>
        <span>${(m.campos||[]).length ? (m.campos.length + " campo" + (m.campos.length !== 1 ? "s" : "")) : "Ninguno"}</span>
      </div>
      <div class="minuta-footer">
        ${Number(m.precio||0) === 0
          ? `<span class="precio-gratis">Gratis</span>`
          : `<span class="precio">$${Number(m.precio||0).toLocaleString("es-CO")} COP</span>`
        }
        <button class="btn btn-primary btn-sm" onclick="abrirMinuta('${m.id}')">Adquirir</button>
      </div>`;
    grid.appendChild(card);
  });
  renderPagination(pagCont, minutasCurrentPage, totalPages, p => {
    minutasCurrentPage = p;
    renderMinutas(list);
    document.getElementById("minutas").scrollIntoView({ behavior:"smooth", block:"start" });
  });
}

document.getElementById("buscador").addEventListener("input", e => {
  const t = e.target.value.toLowerCase();
  minutasFiltradas = minutasData.filter(m =>
    m.nombre.toLowerCase().includes(t) ||
    (m.descripcion||"").toLowerCase().includes(t) ||
    (m.categoria||"").toLowerCase().includes(t)
  );
  minutasCurrentPage = 1;
  renderMinutas(minutasFiltradas);
});

/* ─────────────────────────────────────────────────────
   PAGINADO GENÉRICO
───────────────────────────────────────────────────── */
function renderPagination(container, currentPage, totalPages, onPageChange) {
  container.innerHTML = "";
  if (totalPages <= 1) return;
  const prevBtn = document.createElement("button");
  prevBtn.className = "page-btn"; prevBtn.textContent = "‹"; prevBtn.disabled = currentPage === 1;
  prevBtn.onclick = () => onPageChange(currentPage - 1);
  container.appendChild(prevBtn);
  const pages = getPaginationRange(currentPage, totalPages);
  pages.forEach(p => {
    if (p === "...") {
      const dots = document.createElement("span");
      dots.textContent = "…"; dots.style.cssText = "padding:0 6px;color:var(--text-muted);display:inline-flex;align-items:center;";
      container.appendChild(dots);
    } else {
      const btn = document.createElement("button");
      btn.className = "page-btn" + (p === currentPage ? " active" : ""); btn.textContent = p;
      btn.onclick = () => onPageChange(p);
      container.appendChild(btn);
    }
  });
  const nextBtn = document.createElement("button");
  nextBtn.className = "page-btn"; nextBtn.textContent = "›"; nextBtn.disabled = currentPage === totalPages;
  nextBtn.onclick = () => onPageChange(currentPage + 1);
  container.appendChild(nextBtn);
}

function getPaginationRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const range = [];
  if (current <= 4) {
    for (let i = 1; i <= 5; i++) range.push(i); range.push("..."); range.push(total);
  } else if (current >= total - 3) {
    range.push(1); range.push("..."); for (let i = total - 4; i <= total; i++) range.push(i);
  } else {
    range.push(1); range.push("..."); range.push(current - 1); range.push(current); range.push(current + 1); range.push("..."); range.push(total);
  }
  return range;
}

/* ─────────────────────────────────────────────────────
   MODAL — FLUJO DE COMPRA
───────────────────────────────────────────────────── */
async function abrirMinuta(id) {
  currentMinuta    = minutasData.find(m => m.id === id);
  if (!currentMinuta) return;
  gtag_evento("view_minuta", { minuta_id: id, minuta_nombre: currentMinuta.nombre || "", minuta_categoria: currentMinuta.categoria || "" }); /* GA4 */
  currentStep      = 1;
  camposLlenados   = {};
  camposIALlenados = {};
  camposIAMejorados = {};
  camposCurrentPage = 1;
  docxBlob         = null;
  currentWompiTransactionId = null;
  iaYaProcesada    = false;
  pagoExitoso      = false;
  livePreviewReady = false;
  const _lpCont = document.getElementById("live-preview-content");
  if (_lpCont) _lpCont.innerHTML = `<div class="live-preview-empty"><div class="loading-spinner" style="margin:0 auto 12px;"></div>Cargando previsualización…</div>`;
  const _lpBody = document.getElementById("modal-body");
  if (_lpBody) _lpBody.classList.remove("with-live-preview", "lp-mobile-open");
  const _lpModal = document.getElementById("modal-compra");
  if (_lpModal) _lpModal.classList.remove("modal--with-preview");

  minutaTieneIA    = !!(currentMinuta.tieneIA && (currentMinuta.placeholdersIA||[]).length);
  placeholdersIA   = currentMinuta.placeholdersIA || [];
  minutaClausulas   = currentMinuta.clausulasEleccion || [];
  eleccionesClausulas = {};
  camposClausulas   = {};

  document.getElementById("modal-nombre-titulo").textContent = currentMinuta.nombre;
  const precioDisplay = Number(currentMinuta.precio||0) === 0 ? "Gratis" : `$${Number(currentMinuta.precio||0).toLocaleString("es-CO")} COP`;
  document.getElementById("modal-precio-header").textContent = precioDisplay;
  document.getElementById("pay-total-monto").textContent     = precioDisplay;

  buildStepsBar();
  renderStep(1);
  document.getElementById("modal-overlay").classList.add("open");
  document.body.style.overflow = "hidden";

  (async () => {
    const b64 = currentMinuta.docxBase64;
    if (b64) {
      try {
        const binary = atob(b64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        docxBlob = new Blob([bytes.buffer], { type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        try { await inicializarLivePreview(); } catch(_) {}
        return;
      } catch(e) { console.warn("[abrirMinuta] Error decodificando docxBase64:", e); }
    }
    if (currentMinuta.archivoURL) {
      try {
        const resp = await fetch(currentMinuta.archivoURL, { mode: "cors" });
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          docxBlob = new Blob([buf], { type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        } else {
          console.warn("[abrirMinuta] fetch archivoURL respondió con estado:", resp.status);
        }
      } catch(fetchErr) {
        console.warn("[abrirMinuta] Error cargando archivoURL:", fetchErr);
      }
    }
    if (!docxBlob) {
      const cont = document.getElementById("live-preview-content");
      if (cont) cont.innerHTML = `<div class="live-preview-empty">No fue posible cargar la previsualización del documento.</div>`;
    } else {
      try { await inicializarLivePreview(); } catch(_) {}
    }
  })();
}

function tieneClausulasOpcionales() {
  return minutaClausulas && minutaClausulas.length > 0;
}

function buildStepsBar() {
  const bar = document.getElementById("steps-bar-container");
  const campos = currentMinuta.campos || [];
  const tieneIA = minutaTieneIA;
  const steps = [];
  if (campos.length) steps.push({ label: "Mis datos" });
  if (tieneClausulasOpcionales()) steps.push({ label: "Cláusulas" });
  if (tieneIA) steps.push({ label: "Hechos y pretensiones" });
  steps.push({ label: "Pago" });
  steps.push({ label: "Descargar" });
  bar.innerHTML = steps.map((s, i) => `
    <div class="step-item${i === 0 ? ' active' : ''}" id="step-ind-${i+1}">
      <span class="step-num">${i+1}</span>${s.label}
    </div>`).join("");
}

function tieneCamposMinuta() {
  if (!currentMinuta) return false;
  const c  = (currentMinuta.campos      || []).length;
  const cl = (currentMinuta.camposLargo || []).length;
  return (c + cl) > 0;
}

function getFlowPanels() {
  const panels = [];
  if (tieneCamposMinuta())       panels.push("2");
  if (tieneClausulasOpcionales()) panels.push("clausulas");
  if (minutaTieneIA)              panels.push("3");
  panels.push("4");
  panels.push("5");
  return panels;
}

function getStepPanelId(step) {
  const panels = getFlowPanels();
  const panel = panels[step - 1];
  if (!panel) return 5;
  return panel === "clausulas" ? "clausulas" : Number(panel);
}

function getTotalSteps() {
  return getFlowPanels().length;
}

function renderStep(step) {
  currentStep = step;
  const totalSteps = getTotalSteps();
  const panelId = getStepPanelId(step);

  if (pagoExitoso && panelId === 4) {
    renderStep(step + 1);
    return;
  }

  [1, 2, 3, 4, 5].forEach(i => {
    const panel = document.getElementById("step-" + i);
    if (panel) panel.classList.remove("active");
  });
  const panelClausulas = document.getElementById("step-clausulas");
  if (panelClausulas) panelClausulas.classList.remove("active");

  if (panelId === "clausulas") {
    if (panelClausulas) panelClausulas.classList.add("active");
  } else {
    const panel = document.getElementById("step-" + panelId);
    if (panel) panel.classList.add("active");
    const p1 = document.getElementById("step-1");
    if (p1) p1.classList.remove("active");
  }

  const bars = document.querySelectorAll("#steps-bar-container .step-item");
  bars.forEach((el, idx) => {
    el.classList.remove("active","done");
    if (idx + 1 === step) el.classList.add("active");
    else if (idx + 1 < step) el.classList.add("done");
  });

  const back = document.getElementById("btn-step-back");
  const next = document.getElementById("btn-step-next");
  back.style.display = step > 1 && step < totalSteps ? "inline-flex" : "none";

  if (panelId === 2) {
    buildCamposForm();
    updateStep2FooterBtn();
  } else if (panelId === "clausulas") {
    buildClausulasForm();
    next.style.display = "inline-flex";
    next.textContent = "Confirmar selección →";
    next.style.background = "";
    next.disabled = false;
  } else if (panelId === 3) {
    buildCamposIAForm();
    next.style.display = "inline-flex";
    next.textContent = "Continuar al pago →";
    next.style.background = "";
  } else if (panelId === 4) {
    next.style.display = "none";
    renderPagoStep();
  } else if (panelId === 5) {
    next.style.display = "none";
    back.style.display = "none";
    setupDescarga();
  }

  aplicarClaseLivePreviewSegunPaso();
  actualizarLivePreview();
}

/* ── CAMPOS (NORMALES + LARGOS) CON PAGINADO ── */
function buildAllCamposList() {
  const normales = (currentMinuta.campos      || []).map(n => ({ nombre: n, tipo: "normal" }));
  const largos   = (currentMinuta.camposLargo || []).map(n => ({ nombre: n, tipo: "largo"  }));
  return [...normales, ...largos];
}

function buildCamposForm() {
  const lista = buildAllCamposList();
  camposTotalPages = lista.length ? Math.ceil(lista.length / CAMPOS_PER_PAGE) : 1;
  renderCamposPage();
}

function renderCamposPage() {
  const cont    = document.getElementById("campos-dinamicos");
  const infoEl  = document.getElementById("campos-pag-info");
  const navEl   = document.getElementById("campos-nav");
  const navInfo = document.getElementById("campos-nav-info");
  const btnPrev = document.getElementById("btn-campos-prev");
  const btnNext = document.getElementById("btn-campos-next");
  cont.innerHTML = "";
  const lista = buildAllCamposList();
  if (!lista.length) {
    cont.innerHTML = "<p class='text-muted'>Esta minuta no tiene campos personalizables. Puedes continuar al pago.</p>";
    infoEl.textContent = ""; navEl.style.display = "none"; updateStep2FooterBtn(); return;
  }
  const start = (camposCurrentPage - 1) * CAMPOS_PER_PAGE;
  const slice = lista.slice(start, start + CAMPOS_PER_PAGE);
  infoEl.textContent = `Campos ${start+1}–${Math.min(start+CAMPOS_PER_PAGE, lista.length)} de ${lista.length}`;
  slice.forEach(({ nombre: campo, tipo }) => {
    const div    = document.createElement("div");
    div.className = "form-group";
    if (tipo === "largo") {
      div.innerHTML = `
        <label style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;">${esc(campo)}
          <span style="background:rgba(26,58,92,0.09);color:var(--primary);font-size:0.72rem;font-weight:700;padding:2px 8px;border-radius:10px;">Texto libre</span>
        </label>
        <textarea class="form-control campo-input" data-campo="${esc(campo)}"
          rows="8" style="min-height:160px;resize:vertical;font-size:0.92rem;line-height:1.7;"
          placeholder="Escribe aquí ${esc(campo)}. Puedes usar Enter para separar párrafos o enumeraciones (PRIMERO., SEGUNDO., etc.).">${esc(camposLlenados[campo]||"")}</textarea>
        <p class="form-hint">Puedes presionar Enter para hacer saltos de línea. El texto se insertará tal cual en el documento Word.</p>`;
    } else {
      div.innerHTML = `
        <label>${esc(campo)}</label>
        <input type="text" class="form-control campo-input" data-campo="${esc(campo)}"
          placeholder="Escribe: ${esc(campo)}" value="${esc(camposLlenados[campo]||"")}" />`;
    }
    cont.appendChild(div);
  });
  if (camposTotalPages > 1) {
    navEl.style.display = "flex"; navInfo.textContent = `Página ${camposCurrentPage} de ${camposTotalPages}`;
    btnPrev.disabled = camposCurrentPage === 1;
    btnNext.style.display = camposCurrentPage < camposTotalPages ? "inline-flex" : "none";
  } else { navEl.style.display = "none"; }
  updateStep2FooterBtn();
}

function saveCamposActuales() {
  document.querySelectorAll(".campo-input").forEach(inp => {
    if (inp.value.trim()) camposLlenados[inp.dataset.campo] = inp.value.trim();
  });
}

function validateCamposActuales() {
  let valid = true;
  document.querySelectorAll(".campo-input").forEach(inp => {
    if (!inp.value.trim()) { inp.style.borderColor = "var(--danger)"; valid = false; }
    else inp.style.borderColor = "";
  });
  return valid;
}

function camposPrevPage() {
  saveCamposActuales();
  if (camposCurrentPage > 1) { camposCurrentPage--; renderCamposPage(); }
}

function camposNextPage() {
  if (!validateCamposActuales()) { toast("Completa todos los campos antes de continuar.", "error"); return; }
  saveCamposActuales();
  if (camposCurrentPage < camposTotalPages) { camposCurrentPage++; renderCamposPage(); }
}

function updateStep2FooterBtn() {
  const next = document.getElementById("btn-step-next");
  if (camposTotalPages > 1 && camposCurrentPage < camposTotalPages) {
    next.style.display = "none";
  } else {
    next.style.display = "inline-flex";
    next.textContent = "Continuar →";
  }
}

/* ── CAMPOS DE IA ── */
async function buildCamposIAForm() {
  const cont = document.getElementById("campos-ia-dinamicos");
  cont.innerHTML = "";
  if (!placeholdersIA.length) {
    cont.innerHTML = "<p class='text-muted'>No se detectaron espacios de IA en este documento.</p>"; return;
  }

  const limite = await iaLimitCheck();
  if (limite.bloqueado) {
    const msg = iaLimitMensaje(limite.msRestantes);
    cont.innerHTML = `
      <div style="background:var(--danger-bg,#fff0f0);border:1.5px solid var(--danger,#dc2626);border-radius:10px;padding:20px 22px;text-align:center;">
        <div style="font-size:2rem;margin-bottom:8px;">🚫</div>
        <p style="font-weight:700;color:var(--danger,#dc2626);margin:0 0 6px;">Límite de IA alcanzado</p>
        <p style="color:#555;margin:0;font-size:0.93rem;" id="ia-limite-countdown">${esc(msg)}</p>
      </div>`;
    const next = document.getElementById("btn-step-next");
    if (next) { next.disabled = true; next.style.opacity = "0.5"; }
    clearInterval(window._iaCountdownInterval);
    window._iaCountdownInterval = setInterval(async () => {
      const l2 = await iaLimitCheck();
      const el = document.getElementById("ia-limite-countdown");
      if (!el) { clearInterval(window._iaCountdownInterval); return; }
      if (!l2.bloqueado) {
        clearInterval(window._iaCountdownInterval);
        buildCamposIAForm();
        if (next) { next.disabled = false; next.style.opacity = ""; }
      } else {
        el.textContent = iaLimitMensaje(l2.msRestantes);
      }
    }, 60000);
    return;
  }

  const next = document.getElementById("btn-step-next");
  if (next) { next.disabled = false; next.style.opacity = ""; }

  const intro = cont.previousElementSibling;
  if (intro && intro.tagName !== "P") intro.style.display = "none";

  cont.innerHTML = `
    <div class="ia-chat" id="ia-chat">
      <div class="ia-chat-header">
        <div class="ia-chat-avatar">⚖️</div>
        <div class="ia-chat-meta">
          <div class="ia-chat-title">Asistente legal</div>
          <div class="ia-chat-status"><span class="ia-chat-status-dot"></span>Te ayudo a redactar tu documento</div>
        </div>
      </div>
      <div class="ia-chat-messages" id="ia-chat-messages" aria-live="polite"></div>
      <div class="ia-chat-composer">
        <textarea class="ia-chat-input" id="ia-chat-input" rows="1"
          placeholder="Escribe tu respuesta… (Shift+Enter para una nueva línea)"></textarea>
        <button type="button" class="ia-chat-send" id="ia-chat-send"
          onclick="enviarMensajeChatIA()" title="Enviar (Enter)" aria-label="Enviar">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d="M2.4 20.6 22 12 2.4 3.4l.01 6.69L17 12 2.41 13.91z"/>
          </svg>
        </button>
      </div>
      <div class="ia-chat-hint">
        <kbd>Enter</kbd> envía
        <span class="ia-chat-hint-sep">•</span>
        <kbd>Shift</kbd>+<kbd>Enter</kbd> nueva línea
        <span class="ia-chat-hint-sep">•</span>
        <span class="ia-chat-hint-edit">Pulsa <span class="ia-chat-hint-pencil">✎</span> en una respuesta para editarla</span>
      </div>
    </div>
  `;

  renderChatIA();

  const inp = document.getElementById("ia-chat-input");
  if (inp) {
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        enviarMensajeChatIA();
      }
    });
    inp.addEventListener("input", () => {
      inp.style.height = "auto";
      inp.style.height = Math.min(inp.scrollHeight, 140) + "px";
    });
  }

  actualizarBotonChatIA();
  if (typeof actualizarLivePreview === "function") {
    try { actualizarLivePreview(); } catch(_) {}
  }
}

/* ── CHAT IA: helpers ── */
function _chatPreguntaIA(placeholder) {
  const label = humanizarPlaceholderIA(placeholder);
  const lo    = label.toLowerCase();
  const tipo  = detectarTipoDocumento(currentMinuta);

  if (lo.includes("hecho")) {
    if (tipo.tipo === "contrato") {
      return "Cuéntame los antecedentes o el contexto del contrato: ¿cómo llegaron las partes a este acuerdo? Descríbelo con tus propias palabras.";
    }
    return "Cuéntame los hechos: ¿qué fue lo que pasó? Descríbelo con tus propias palabras, como si me lo estuvieras contando. Si son varios hechos, los puedes separar (Primero..., Segundo..., etc.).";
  }

  if (lo.includes("pretensi") || lo.includes("petici") || lo.includes("solicit")) {
    switch (tipo.tipo) {
      case "peticion":
        return "Ahora cuéntame: ¿qué le quieres pedir o solicitar formalmente a la entidad? Lista cada solicitud que tengas (1, 2, 3...). Recuerda que la entidad debe responderte en máximo 15 días hábiles.";
      case "tutela":
        return "Ahora cuéntame: ¿qué le pides al juez constitucional? ¿Qué derecho fundamental quieres que se proteja y de qué manera (que ordene tal cosa, que se restablezca tal otra...)? Lista cada pretensión.";
      case "demanda":
        return "Ahora cuéntame: ¿qué le pides al juez? Lista cada pretensión que quieras incluir (declaraciones, condenas, indemnizaciones, etc.).";
      case "queja":
        return "Cuéntame qué le pides a la entidad u organismo: ¿qué quieres que investiguen, sancionen o corrijan? Lista cada solicitud.";
      case "denuncia":
        return "Cuéntame qué le pides a la autoridad: ¿que investiguen los hechos, que se inicie un proceso penal, que se tomen medidas de protección? Lista cada solicitud.";
      case "recurso":
        return "Cuéntame qué le pides a la autoridad que resolverá el recurso: ¿que revoque, modifique o confirme la decisión? Sé específico con lo que pides.";
      case "poder":
        return "Cuéntame qué facultades quieres otorgarle a tu apoderado: ¿qué actos puede hacer en tu nombre? Lista cada facultad.";
      case "desistimiento":
        return "Cuéntame qué quieres desistir o renunciar exactamente y, si quieres, los motivos generales (sin entrar en detalles confidenciales).";
      default:
        return "Cuéntame qué quieres pedir o lograr con este documento. Lista cada solicitud que tengas, separada con números o saltos de línea.";
    }
  }

  if (lo.includes("fundamento") || lo.includes("derecho") || lo.includes("razon")) {
    if (tipo.tipo === "tutela") {
      return "Cuéntame los fundamentos: ¿qué derechos fundamentales consideras que te están vulnerando y por qué? (No necesitas citar artículos exactos — yo te ayudo con la forma.)";
    }
    if (tipo.tipo === "peticion") {
      return "Cuéntame los fundamentos: ¿en qué te basas para hacer esta petición? Si conoces normas (leyes, decretos), menciónalas; si no, describe en tus palabras por qué consideras que es procedente.";
    }
    return "Cuéntame los fundamentos: ¿en qué te basas para hacer esta solicitud? ¿Cuáles son los motivos de fondo? (Yo me encargo de citar las normas correctamente).";
  }

  if (lo.includes("descrip") || lo.includes("objeto")) {
    return "Describe con tus palabras lo que necesites incluir en esta sección.";
  }

  return `Cuéntame sobre "${label}". Escribe con tus propias palabras lo que quieras incluir en esta sección — yo me encargo de mejorar la redacción y el lenguaje jurídico.`;
}

function _appendChatMsgIA(role, text) {
  const msgs = document.getElementById("ia-chat-messages");
  if (!msgs) return;
  const wrap = document.createElement("div");
  wrap.className = "ia-chat-msg ia-chat-msg--" + role;
  const bubble = document.createElement("div");
  bubble.className = "ia-chat-bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  msgs.appendChild(wrap);
}

function _appendChatMsgUserIA(text, placeholder) {
  const msgs = document.getElementById("ia-chat-messages");
  if (!msgs) return;
  const wrap = document.createElement("div");
  wrap.className = "ia-chat-msg ia-chat-msg--user";
  const phEsc = String(placeholder || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  wrap.innerHTML = `
    <div class="ia-chat-bubble-wrap">
      <button type="button" class="ia-chat-edit-btn"
        onclick="editarRespuestaChatIA('${phEsc}')"
        title="Editar esta respuesta" aria-label="Editar respuesta">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
        </svg>
        <span>Editar</span>
      </button>
      <div class="ia-chat-bubble"></div>
    </div>
  `;
  wrap.querySelector(".ia-chat-bubble").textContent = text;
  msgs.appendChild(wrap);
}

function renderChatIA() {
  const msgs = document.getElementById("ia-chat-messages");
  const inp  = document.getElementById("ia-chat-input");
  const send = document.getElementById("ia-chat-send");
  if (!msgs) return;
  msgs.innerHTML = "";

  _appendChatMsgIA("ai",
    "¡Hola! 👋 Soy tu asistente para redactar este documento. Te voy a hacer unas preguntas y, con tus respuestas, armaré el texto formal con lenguaje jurídico colombiano.\n\nPuedes editar cualquier respuesta más adelante con el botón ✎.");

  let activaEncontrada = false;

  for (let i = 0; i < placeholdersIA.length; i++) {
    const ph  = placeholdersIA[i];
    const ans = (camposIALlenados[ph] || "").trim();
    _appendChatMsgIA("ai", _chatPreguntaIA(ph));
    if (ans) {
      _appendChatMsgUserIA(ans, ph);
    } else {
      activaEncontrada = true;
      if (inp) {
        inp.dataset.placeholder = ph;
        inp.disabled = false;
        inp.value = "";
        inp.style.height = "auto";
        inp.placeholder = "Escribe tu respuesta… (Shift+Enter para nueva línea)";
        setTimeout(() => { try { inp.focus(); } catch(_) {} }, 60);
      }
      if (send) send.disabled = false;
      break;
    }
  }

  if (!activaEncontrada) {
    _appendChatMsgIA("ai",
      "¡Listo! 🎉 Tengo todo lo que necesito. Haz clic en \"Continuar al pago\" para que mejore tu redacción con lenguaje jurídico formal.\n\nSi quieres cambiar alguna respuesta, pulsa ✎ junto a ella.");
    if (inp) {
      delete inp.dataset.placeholder;
      inp.disabled = true;
      inp.value = "";
      inp.placeholder = "Conversación completada — usa ✎ para editar una respuesta";
    }
    if (send) send.disabled = true;
  }

  setTimeout(() => { msgs.scrollTop = msgs.scrollHeight; }, 30);
}

function enviarMensajeChatIA() {
  const inp = document.getElementById("ia-chat-input");
  if (!inp || inp.disabled) return;
  const txt = (inp.value || "").trim();
  if (!txt) { toast("Escribe una respuesta antes de enviarla.", "error"); return; }
  const ph = inp.dataset.placeholder;
  if (!ph) return;
  camposIALlenados[ph] = txt;
  if (camposIAMejorados[ph]) delete camposIAMejorados[ph];
  inp.value = "";
  inp.style.height = "auto";
  renderChatIA();
  if (typeof actualizarLivePreview === "function") {
    try { actualizarLivePreview(); } catch(_) {}
  }
  actualizarBotonChatIA();
}

function editarRespuestaChatIA(ph) {
  if (!ph || !placeholdersIA.includes(ph)) return;
  const valorPrevio = camposIALlenados[ph] || "";
  delete camposIALlenados[ph];
  if (camposIAMejorados && camposIAMejorados[ph]) delete camposIAMejorados[ph];
  iaYaProcesada = false;
  const cont = document.getElementById("campos-ia-dinamicos");
  if (cont) {
    const prev = cont.querySelector(".ia-preview-resultado");
    if (prev) prev.remove();
  }
  const btnNext = document.getElementById("btn-step-next");
  if (btnNext) {
    btnNext.textContent = "Continuar al pago →";
    btnNext.style.background = "";
  }
  renderChatIA();
  const inp = document.getElementById("ia-chat-input");
  if (inp) {
    inp.value = valorPrevio;
    inp.dataset.placeholder = ph;
    inp.disabled = false;
    inp.style.height = "auto";
    inp.style.height = Math.min(inp.scrollHeight + 2, 180) + "px";
    setTimeout(() => {
      try {
        inp.focus();
        inp.setSelectionRange(valorPrevio.length, valorPrevio.length);
      } catch(_) {}
    }, 80);
  }
  const send = document.getElementById("ia-chat-send");
  if (send) send.disabled = false;
  actualizarBotonChatIA();
  if (typeof actualizarLivePreview === "function") {
    try { actualizarLivePreview(); } catch(_) {}
  }
  toast("Edita tu respuesta y vuelve a enviarla.", "");
}

function actualizarBotonChatIA() {
  const next = document.getElementById("btn-step-next");
  if (!next) return;
  if (iaYaProcesada) { next.disabled = false; next.style.opacity = ""; return; }
  const todos = placeholdersIA.length > 0 &&
                placeholdersIA.every(p => (camposIALlenados[p] || "").trim());
  next.disabled = !todos;
  next.style.opacity = todos ? "" : "0.5";
}

function humanizarPlaceholderIA(placeholder) {
  const m = placeholder.match(/\(([^)]+)\)/);
  if (m) {
    const raw = m[1].trim();
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  }
  let label = placeholder
    .replace(/^ESPACIO PARA EL TEXTO DE LA IA\d*\s*/i, "")
    .trim();
  if (!label) return "Texto (IA)";
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}

function saveCamposIAActuales() {
  const chatInp = document.getElementById("ia-chat-input");
  if (chatInp && chatInp.dataset.placeholder && (chatInp.value || "").trim()) {
    camposIALlenados[chatInp.dataset.placeholder] = chatInp.value.trim();
  }
  document.querySelectorAll(".campo-ia-input").forEach(inp => {
    camposIALlenados[inp.dataset.placeholder] = inp.value.trim();
  });
}

function validateCamposIA() {
  if (document.getElementById("ia-chat")) {
    return placeholdersIA.length > 0 &&
           placeholdersIA.every(p => (camposIALlenados[p] || "").trim());
  }
  let valid = true;
  document.querySelectorAll(".campo-ia-input").forEach(inp => {
    if (!inp.value.trim()) { inp.style.borderColor = "var(--danger)"; valid = false; }
    else inp.style.borderColor = "";
  });
  return valid;
}

/* ── DETECCIÓN DE TIPO DE DOCUMENTO ── */
const TIPOS_DOC = {
  demanda: {
    nombre: "demanda judicial",
    rolUsuario: "demandante",
    rolContraparte: "demandado/a",
    destinatario: "el juez competente",
    instruccionAI:
      "Es una DEMANDA JUDICIAL. Refiérete al usuario como \"el/la demandante\" o \"el/la suscrito/a demandante\". " +
      "A la otra parte como \"el/la demandado/a\". Las pretensiones se dirigen al juez competente. " +
      "PROHIBIDO usar \"peticionario\" o \"accionante\" en este contexto."
  },
  peticion: {
    nombre: "derecho de petición",
    rolUsuario: "peticionario",
    rolContraparte: "la entidad destinataria",
    destinatario: "la entidad pública o privada destinataria",
    instruccionAI:
      "Es un DERECHO DE PETICIÓN (artículo 23 de la Constitución Política y Ley 1755 de 2015). " +
      "Refiérete al usuario como \"el/la peticionario/a\" o \"el/la suscrito/a peticionario/a\". " +
      "PROHIBIDO usar \"demandante\" o \"accionante\". " +
      "Las solicitudes se dirigen formalmente a la entidad destinataria, no a un juez. " +
      "Usa fórmulas como \"De manera respetuosa, solicito...\", \"Conforme al artículo 23 de la C.P.\" o \"Atentamente solicito...\"."
  },
  tutela: {
    nombre: "acción de tutela",
    rolUsuario: "accionante",
    rolContraparte: "la entidad accionada",
    destinatario: "el juez constitucional",
    instruccionAI:
      "Es una ACCIÓN DE TUTELA (artículo 86 de la Constitución Política y Decreto 2591 de 1991). " +
      "Refiérete al usuario como \"el/la accionante\" o \"el/la suscrito/a accionante\". " +
      "A la contraparte como \"la entidad accionada\" o \"el/la accionado/a\". " +
      "PROHIBIDO usar \"demandante\" o \"peticionario\". " +
      "Las pretensiones son de protección constitucional (\"se proteja el derecho fundamental a...\")."
  },
  queja: {
    nombre: "queja o reclamación",
    rolUsuario: "quejoso",
    rolContraparte: "la entidad o persona contra la que se interpone la queja",
    destinatario: "la entidad u organismo competente",
    instruccionAI:
      "Es una QUEJA o RECLAMACIÓN. Refiérete al usuario como \"el/la quejoso/a\" o \"el/la reclamante\". " +
      "PROHIBIDO usar \"demandante\". Usa lenguaje administrativo formal."
  },
  denuncia: {
    nombre: "denuncia",
    rolUsuario: "denunciante",
    rolContraparte: "el denunciado",
    destinatario: "la autoridad competente (Fiscalía, Policía, etc.)",
    instruccionAI:
      "Es una DENUNCIA. Refiérete al usuario como \"el/la denunciante\". " +
      "A la persona o entidad denunciada como \"el/la denunciado/a\". " +
      "PROHIBIDO usar \"demandante\"."
  },
  recurso: {
    nombre: "recurso administrativo o procesal",
    rolUsuario: "recurrente",
    rolContraparte: "la autoridad o parte contraria",
    destinatario: "la autoridad que conoce el recurso",
    instruccionAI:
      "Es un RECURSO (apelación, reposición, súplica, queja, etc.). " +
      "Refiérete al usuario como \"el/la recurrente\" o \"el/la suscrito/a recurrente\". " +
      "Las pretensiones son las propias del recurso (revocar, modificar, confirmar, etc.)."
  },
  contrato: {
    nombre: "contrato",
    rolUsuario: "una de las partes contratantes",
    rolContraparte: "la otra parte contratante",
    destinatario: "(no aplica — es un acuerdo entre partes)",
    instruccionAI:
      "Es un CONTRATO entre partes privadas. " +
      "PROHIBIDO usar lenguaje de demanda (no hay \"demandante\", \"juez\" ni \"pretensiones\"). " +
      "Usa lenguaje contractual: \"las partes acuerdan\", \"se obliga a\", \"declara y garantiza\", \"en virtud del presente contrato\", etc."
  },
  poder: {
    nombre: "poder o mandato",
    rolUsuario: "poderdante",
    rolContraparte: "el apoderado o mandatario",
    destinatario: "(no aplica)",
    instruccionAI:
      "Es un PODER o MANDATO. Refiérete al usuario como \"el/la poderdante\" y a quien recibe el poder como \"el/la apoderado/a\" o \"mandatario/a\". " +
      "Usa lenguaje formal de otorgamiento (\"confiero\", \"otorgo\", \"faculto\")."
  },
  desistimiento: {
    nombre: "desistimiento o renuncia",
    rolUsuario: "el suscrito",
    rolContraparte: "(no aplica)",
    destinatario: "el juez o autoridad que conoce el proceso",
    instruccionAI:
      "Es un DESISTIMIENTO o RENUNCIA. Refiérete al usuario como \"el/la suscrito/a\" (o por el rol que tenga en el proceso original: demandante, accionante, etc., si se infiere del contexto). " +
      "Usa fórmulas como \"manifiesto mi voluntad de desistir\", \"renuncio formalmente a...\"."
  },
  generico: {
    nombre: "documento legal",
    rolUsuario: "el suscrito",
    rolContraparte: "la contraparte",
    destinatario: "el destinatario",
    instruccionAI:
      "Documento legal de tipo genérico. Usa lenguaje jurídico formal y NEUTRAL. " +
      "Refiérete al usuario como \"el/la suscrito/a\" o \"el/la solicitante\". " +
      "PROHIBIDO asumir que es una demanda — no uses \"demandante\" salvo que el texto del usuario lo diga explícitamente."
  }
};

function detectarTipoDocumento(minuta) {
  const fallback = { tipo: "generico", ...TIPOS_DOC.generico };
  if (!minuta) return fallback;
  const manual = (minuta.tipoDocumento || "").trim().toLowerCase();
  if (manual && TIPOS_DOC[manual]) return { tipo: manual, ...TIPOS_DOC[manual] };
  const txt = `${minuta.nombre || ""} ${minuta.categoria || ""} ${minuta.descripcion || ""}`.toLowerCase();
  if (/\btutela\b|acci[oó]n de tutela/.test(txt))                                    return { tipo: "tutela",        ...TIPOS_DOC.tutela };
  if (/derecho de petici[oó]n|\bpetici[oó]n\b/.test(txt))                            return { tipo: "peticion",      ...TIPOS_DOC.peticion };
  if (/\bdenuncia\b/.test(txt))                                                      return { tipo: "denuncia",      ...TIPOS_DOC.denuncia };
  if (/\bqueja\b|reclamaci[oó]n|\breclamo\b/.test(txt))                              return { tipo: "queja",         ...TIPOS_DOC.queja };
  if (/recurso de (apelaci[oó]n|reposici[oó]n|s[uú]plica|queja|alzada)|\brecurso\b/.test(txt))
                                                                                      return { tipo: "recurso",       ...TIPOS_DOC.recurso };
  if (/desistimiento|renuncia/.test(txt))                                            return { tipo: "desistimiento", ...TIPOS_DOC.desistimiento };
  if (/\bpoder\b|mandato/.test(txt))                                                 return { tipo: "poder",         ...TIPOS_DOC.poder };
  if (/\bdemanda\b/.test(txt))                                                       return { tipo: "demanda",       ...TIPOS_DOC.demanda };
  if (/\bcontrato\b|arrendamiento|compraventa|prestaci[oó]n de servicios|\blaboral\b|sociedad|cesi[oó]n/.test(txt))
                                                                                      return { tipo: "contrato",      ...TIPOS_DOC.contrato };
  return fallback;
}

async function mejorarTextosConIA() {
  const textos = Object.entries(camposIALlenados)
    .filter(([,v]) => v.trim())
    .map(([clave, texto]) => ({ clave, texto }));
  if (!textos.length) return;
  if (!geminiConfig.apiKey) {
    textos.forEach(t => { camposIAMejorados[t.clave] = t.texto; });
    toast("IA no configurada. Se usará el texto original tal como lo escribiste.", "");
    return;
  }
  const limiteIA = await iaLimitCheck();
  if (limiteIA.bloqueado) {
    toast(iaLimitMensaje(limiteIA.msRestantes), "error");
    textos.forEach(t => { camposIAMejorados[t.clave] = t.texto; });
    return;
  }
  /* ③ Límite diario global de IA por usuario */
  await obtenerTokenRecaptcha("use_ai"); /* reCAPTCHA v3 */
  const limiteGlobal = await iaGlobalLimitCheck();
  if (limiteGlobal.bloqueado) {
    toast(`Alcanzaste el límite de ${IA_GLOBAL_MAX_DIA} usos de IA por día. Vuelve mañana.`, "error");
    textos.forEach(t => { camposIAMejorados[t.clave] = t.texto; });
    return;
  }
  const overlay = document.getElementById("processing-overlay");
  const msg     = document.getElementById("processing-msg");
  overlay.classList.add("open");
  msg.textContent = "La IA está mejorando la redacción... esto puede tomar unos segundos.";

  const bloques = textos.map((t, i) => {
    const label = humanizarPlaceholderIA(t.clave);
    return `[CAMPO_${i+1}] — ${label.toUpperCase()}\n${t.texto}`;
  }).join("\n\n");

  const tipoInfo = detectarTipoDocumento(currentMinuta);
  const nombreDoc = (currentMinuta && currentMinuta.nombre) ? currentMinuta.nombre : "documento legal";
  const catDoc    = (currentMinuta && currentMinuta.categoria) ? currentMinuta.categoria : "no especificada";
  const ctxExtra  = (currentMinuta && currentMinuta.contextoIA) ? String(currentMinuta.contextoIA).trim() : "";

  const systemPrompt =
    `Eres un abogado colombiano experto en redacción jurídica (demandas, derechos de petición, tutelas, contratos, recursos y demás documentos legales). ` +
    `Recibirás uno o más textos de distintas secciones de un documento legal, identificados con [CAMPO_N] y el nombre de la sección. ` +
    `\n\n=== CONTEXTO DEL DOCUMENTO ===\n` +
    `Documento que se está redactando: "${nombreDoc}" (categoría: ${catDoc}). ` +
    `Tipo identificado: ${tipoInfo.nombre.toUpperCase()}. ` +
    `${tipoInfo.instruccionAI} ` +
    `Cuando necesites referirte al usuario, usa SIEMPRE: "${tipoInfo.rolUsuario}". ` +
    `Cuando necesites referirte a la otra parte, usa: "${tipoInfo.rolContraparte}". ` +
    `Las solicitudes/pretensiones se dirigen a: ${tipoInfo.destinatario}. ` +
    `Si el usuario en su texto crudo usa una palabra incorrecta para su rol, CORRÍGELO al rol que corresponda según el tipo de documento. ` +
    (ctxExtra
      ? `\n\n=== CONTEXTO ADICIONAL ESPECÍFICO DE ESTA MINUTA ===\n${ctxExtra}\nIntegra estas indicaciones en tu redacción siempre que no contradigan las reglas anteriores ni te obliguen a inventar datos no proporcionados por el usuario. `
      : ``) +
    `\n\n=== REGLAS GENERALES OBLIGATORIAS ===\n` +
    `1) DEBES reescribir el texto con lenguaje jurídico formal colombiano. Corrige ortografía, tildes, puntuación y gramática. ` +
    `2) FORMATO DE NUMERACIÓN OBLIGATORIO: Cuando uses PRIMERO., SEGUNDO., TERCERO., etc., el número y su contenido van SIEMPRE en la misma línea, juntos. ` +
    `3) Cada hecho o pretensión numerada va en su propia línea (separada con \\n), pero el número y el texto van JUNTOS en esa misma línea. ` +
    `4) PROHIBICIÓN ABSOLUTA DE INVENTAR: No agregues ningún dato, fecha, nombre, dirección, ciudad, número o detalle que NO esté en el texto original del usuario. ` +
    `\n\n=== INSTRUCCIONES POR SECCIÓN ===\n` +
    `Para HECHOS: redacta cada hecho de forma narrativa, cronológica y formal. CADA hecho DEBE ser un párrafo completo y sustancial de al menos 3 oraciones. ` +
    `Formato: "PRIMERO. [párrafo extenso del hecho]\\nSEGUNDO. [párrafo extenso del hecho]\\n..." ` +
    `Para PRETENSIONES / SOLICITUDES / PETICIONES: redacta como puntos numerados formales dirigidos a ${tipoInfo.destinatario}. ` +
    `Formato: "PRIMERO. [pretensión / solicitud]\\nSEGUNDO. [pretensión / solicitud]\\n..." ` +
    `Para FUNDAMENTOS DE DERECHO: cita normativa colombiana relevante al tipo de documento sin inventar artículos específicos que no aparezcan en el texto original. ` +
    `Para cualquier otra sección: mejora ortografía, puntuación y redacción formal sin agregar ni quitar información. ` +
    `\n\n=== FORMATO DE RESPUESTA ===\n` +
    `Responde ÚNICAMENTE con JSON puro: {"CAMPO_1":"texto mejorado con \\n para saltos de línea","CAMPO_2":"texto mejorado",...}. ` +
    `Sin explicaciones, sin markdown, sin bloques de código.`;

  try {
    const resp = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${geminiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: bloques }
        ],
        temperature: 0.2,
        max_tokens: 4096,
        response_format: { type: "json_object" }
      })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const errMsg = err?.error?.message || resp.statusText || "Error desconocido";
      throw new Error(errMsg);
    }
    const data = await resp.json();
    const raw  = data?.choices?.[0]?.message?.content?.trim() || "";
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch(_) {
      const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      try { parsed = JSON.parse(clean); } catch(__) {}
    }
    camposIAMejorados = {};
    textos.forEach((t, i) => {
      const key = `CAMPO_${i+1}`;
      camposIAMejorados[t.clave] = (parsed && parsed[key]) ? String(parsed[key]).trim() : t.texto;
    });
    mostrarPreviewIA();
    gtag_evento("use_ai", { minuta_id: currentMinuta ? currentMinuta.id : "", minuta_nombre: currentMinuta ? currentMinuta.nombre : "", campos_count: textos.length }); /* GA4 */
    await iaLimitIncrement();
    await iaGlobalLimitIncrement(); /* ③ incrementa contador diario global */
  } catch(e) {
    const detalle = e instanceof Error ? e.message : String(e);
    let msgError = "La IA no pudo procesar el texto. Se usará el texto original.";
    if (detalle.includes("invalid_api_key") || detalle.includes("401") || detalle.includes("Authentication")) {
      msgError = "La clave de Groq no es válida. Verifica la clave en Admin → Configurar IA.";
    } else if (detalle.includes("429") || detalle.includes("rate_limit") || detalle.includes("quota")) {
      msgError = "Se alcanzó el límite gratuito de Groq. Espera un momento e intenta de nuevo.";
    } else if (detalle.includes("Failed to fetch") || detalle.includes("NetworkError")) {
      msgError = "Error de red al conectar con Groq. Verifica tu conexión.";
    } else if (detalle) {
      msgError = `Error de IA: ${detalle.substring(0, 120)}. Se usará el texto original.`;
    }
    toast(msgError, "error");
    textos.forEach(t => { camposIAMejorados[t.clave] = t.texto; });
  } finally {
    overlay.classList.remove("open");
  }
}

/* ── PREVIEW DE TEXTOS MEJORADOS POR IA ── */
function mostrarPreviewIA() {
  const cont = document.getElementById("campos-ia-dinamicos");
  if (!cont) return;
  const entradas = Object.entries(camposIAMejorados);
  if (!entradas.length) return;
  iaYaProcesada = true;
  const btnNext = document.getElementById("btn-step-next");
  if (btnNext) {
    btnNext.textContent = "He revisado — Continuar al pago →";
    btnNext.style.background = "var(--success)";
  }
  let existente = cont.querySelector(".ia-preview-resultado");
  if (existente) existente.remove();
  const preview = document.createElement("div");
  preview.className = "ia-preview-resultado";
  preview.style.cssText = "margin-top:20px;border-top:2px solid rgba(37,99,168,0.2);padding-top:16px;";
  const camposHtml = entradas.map(([clave, textoMejorado]) => {
    const label = humanizarPlaceholderIA(clave);
    const claveEsc = esc(clave).replace(/'/g, "\\'");
    return `<div class="ia-campo-resultado" data-clave="${esc(clave)}" style="margin-bottom:16px;border:1px solid var(--border);border-radius:10px;overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;background:rgba(26,58,92,0.04);border-bottom:1px solid var(--border);">
        <span style="font-size:0.82rem;font-weight:700;color:var(--primary);">${esc(label)}</span>
        <button onclick="regenerarCampoIA('${claveEsc}')" data-regen="${esc(clave)}" style="display:inline-flex;align-items:center;gap:5px;padding:5px 12px;background:#fff;border:1.5px solid rgba(37,99,168,0.3);border-radius:7px;color:var(--primary-light);font-size:0.78rem;font-weight:700;cursor:pointer;white-space:nowrap;">
          ↻ Regenerar este campo
        </button>
      </div>
      <div class="ia-campo-texto" style="padding:12px 14px;font-size:0.87rem;color:var(--text);line-height:1.65;white-space:pre-wrap;background:rgba(30,126,52,0.03);">${esc(textoMejorado)}</div>
    </div>`;
  }).join("");
  preview.innerHTML = `
    <p style="font-size:0.88rem;font-weight:700;color:var(--success);margin-bottom:14px;">
      ✅ La IA mejoró tu redacción. Así quedará en el documento:
    </p>
    ${camposHtml}
    <p style="font-size:0.78rem;color:var(--text-muted);margin-top:8px;font-style:italic;">
      Cada campo tiene su propio botón para regenerar solo ese texto con una redacción diferente.
    </p>
  `;
  cont.appendChild(preview);
  preview.scrollIntoView({ behavior: "smooth", block: "nearest" });
  actualizarLivePreview();
}

/* ── REGENERAR UN CAMPO INDIVIDUAL CON IA ── */
async function regenerarCampoIA(clave) {
  const limiteRegen = await iaLimitCheck();
  if (limiteRegen.bloqueado) {
    toast(iaLimitMensaje(limiteRegen.msRestantes), "error"); return;
  }
  if (!geminiConfig.apiKey) {
    toast("IA no configurada. Configura tu clave de Groq en Admin → Configuración IA.", "error"); return;
  }
  saveCamposIAActuales();
  const textoOriginal = camposIALlenados[clave];
  if (!textoOriginal || !textoOriginal.trim()) {
    toast("El campo está vacío. Escribe algo primero.", "error"); return;
  }
  const label = humanizarPlaceholderIA(clave);
  const btnRegen = document.querySelector(`[data-regen="${CSS.escape(clave)}"]`);
  if (btnRegen) { btnRegen.disabled = true; btnRegen.textContent = "Redactando…"; }
  const variacion = Math.floor(Math.random() * 9000) + 1000;
  const tipoInfoR = detectarTipoDocumento(currentMinuta);
  const ctxExtraR = (currentMinuta && currentMinuta.contextoIA) ? String(currentMinuta.contextoIA).trim() : "";
  const systemPrompt =
    `Eres un abogado colombiano experto en redacción jurídica. ` +
    `Estás regenerando un campo de un documento del tipo: ${tipoInfoR.nombre.toUpperCase()}. ` +
    `${tipoInfoR.instruccionAI} Refiérete al usuario como "${tipoInfoR.rolUsuario}" y a la otra parte como "${tipoInfoR.rolContraparte}". Las solicitudes se dirigen a ${tipoInfoR.destinatario}. ` +
    (ctxExtraR ? `\nCONTEXTO ADICIONAL ESPECÍFICO: ${ctxExtraR}\n` : ``) +
    `VARIACIÓN #${variacion}: Debes producir una redacción diferente variando ÚNICAMENTE el vocabulario jurídico, la estructura gramatical y el estilo formal — NUNCA agregando información nueva. ` +
    `REGLA ABSOLUTA: PROHIBIDO agregar cualquier dato, hecho, fecha, nombre, dirección, ciudad, número o detalle que NO esté explícitamente en el texto original del usuario. ` +
    `REGLAS DE FORMATO: 1) Reescribe con lenguaje jurídico formal colombiano. 2) FORMATO DE NUMERACIÓN: "PRIMERO. [texto]\\nSEGUNDO. [texto]" — NUNCA pongas el número solo en una línea. ` +
    `Responde ÚNICAMENTE con JSON puro: {"resultado":"texto mejorado con \\n para saltos de línea"}. Sin markdown.`;
  try {
    const resp = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${geminiConfig.apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: `[${label.toUpperCase()}]\n${textoOriginal}` }
        ],
        temperature: 0.85,
        max_tokens: 2048,
        response_format: { type: "json_object" }
      })
    });
    if (!resp.ok) throw new Error((await resp.json().catch(()=>({}))).error?.message || resp.statusText);
    const data = await resp.json();
    const raw  = data?.choices?.[0]?.message?.content?.trim() || "";
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch(_) {
      const clean = raw.replace(/^```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
      try { parsed = JSON.parse(clean); } catch(__) {}
    }
    const nuevoTexto = parsed?.resultado ? String(parsed.resultado).trim() : textoOriginal;
    camposIAMejorados[clave] = nuevoTexto;
    actualizarLivePreview();
    const card = document.querySelector(`.ia-campo-resultado[data-clave="${CSS.escape(clave)}"]`);
    if (card) {
      card.querySelector(".ia-campo-texto").textContent = nuevoTexto;
      card.style.borderColor = "rgba(37,99,168,0.4)";
      setTimeout(() => { card.style.borderColor = "var(--border)"; }, 1200);
    }
    const bloqueadoAhora = await iaLimitIncrement();
    const msgExito = bloqueadoAhora
      ? `${label} regenerado. ⚠️ Límite de ${IA_MAX_USOS} usos alcanzado — IA bloqueada por 1 hora.`
      : `${label} regenerado con éxito.`;
    toast(msgExito, bloqueadoAhora ? "error" : "ok");
  } catch(e) {
    toast("Error al regenerar: " + (e.message||String(e)).substring(0,80), "error");
  } finally {
    if (btnRegen) { btnRegen.disabled = false; btnRegen.textContent = "↻ Regenerar este campo"; }
  }
}

async function regenerarConIA() {
  iaYaProcesada = false;
  camposIAMejorados = {};
  const btnNext = document.getElementById("btn-step-next");
  if (btnNext) {
    btnNext.textContent = "Continuar al pago →";
    btnNext.style.background = "";
    btnNext.disabled = true;
  }
  const cont = document.getElementById("campos-ia-dinamicos");
  const prevExistente = cont ? cont.querySelector(".ia-preview-resultado") : null;
  if (prevExistente) prevExistente.remove();
  toast("Pidiendo a la IA que redacte de nuevo…", "");
  saveCamposIAActuales();
  await mejorarTextosConIA();
  if (btnNext) btnNext.disabled = false;
}

/* ── NAVEGACIÓN DE PASOS ── */
async function stepNext() {
  const totalSteps = getTotalSteps();
  const panelId    = getStepPanelId(currentStep);
  if (panelId === 2) {
    if (!validateCamposActuales()) { toast("Completa todos los campos.", "error"); return; }
    saveCamposActuales();
    renderStep(currentStep + 1);
  } else if (panelId === "clausulas") {
    saveClausulasActuales();
    const resClausulas = validateClausulas();
    if (!resClausulas.ok) {
      marcarCamposExtraFaltantes();
      toast(resClausulas.razon, "error");
      return;
    }
    renderStep(currentStep + 1);
  } else if (panelId === 3) {
    if (!iaYaProcesada) {
      if (!validateCamposIA()) { toast("Completa todos los campos de IA.", "error"); return; }
      saveCamposIAActuales();
      await mejorarTextosConIA();
      if (iaYaProcesada) return;
      renderStep(currentStep + 1);
      return;
    }
    iaYaProcesada = false;
    renderStep(currentStep + 1);
  } else if (panelId === 4) {
    const precio = Number(currentMinuta ? currentMinuta.precio || 0 : 0);
    if (precio === 0) { obtenerGratis(); } else { iniciarPagoWompi(); }
  }
}

function stepBack() {
  const panelId = getStepPanelId(currentStep);
  if (panelId === 2) { saveCamposActuales(); camposCurrentPage = 1; }
  if (panelId === "clausulas") { saveClausulasActuales(); }
  if (panelId === 3) { saveCamposIAActuales(); iaYaProcesada = false; }
  if (currentStep > 1) renderStep(currentStep - 1);
}

/* ── PAGO CON WOMPI ── */
async function cargarWompiConfig() {
  try {
    const { data, error } = await supabaseClient
      .from("config")
      .select("*")
      .eq("id", "wompi")
      .single();
    if (!error && data) wompiConfig = {
      publicKey: data.public_key,
      mode:      data.mode
      /* ④ integrity_secret NO se carga al navegador — solo la usa la Edge Function */
    };
  } catch(_) {}
}

function renderPagoStep() {
  const checkoutSection    = document.getElementById("wompi-checkout-section");
  const notConfigured      = document.getElementById("wompi-not-configured");
  const pendingSection     = document.getElementById("wompi-pending-section");
  const modoPruebaSection  = document.getElementById("modo-prueba-section");
  const gratisSection      = document.getElementById("gratis-section");
  const loginRequired      = document.getElementById("pago-login-required");
  const payTotal           = document.getElementById("pay-total-monto");
  pendingSection.style.display = "none";
  const precio = Number(currentMinuta ? currentMinuta.precio || 0 : 0);
  if (payTotal) payTotal.textContent = precio === 0 ? "Gratis" : `$${precio.toLocaleString("es-CO")} COP`;
  if (!currentUser) {
    if (loginRequired)     loginRequired.style.display     = "block";
    if (checkoutSection)   checkoutSection.style.display   = "none";
    if (notConfigured)     notConfigured.style.display     = "none";
    if (modoPruebaSection) modoPruebaSection.style.display = "none";
    if (gratisSection)     gratisSection.style.display     = "none";
    return;
  }
  if (loginRequired) loginRequired.style.display = "none";
  if (precio === 0) {
    checkoutSection.style.display  = "none";
    notConfigured.style.display    = "none";
    modoPruebaSection.style.display = "none";
    gratisSection.style.display    = "block";
    return;
  }
  gratisSection.style.display = "none";
  if (modoPrueba) {
    checkoutSection.style.display   = "none";
    notConfigured.style.display     = "none";
    modoPruebaSection.style.display = "block";
  } else {
    modoPruebaSection.style.display = "none";
    if (wompiConfig.publicKey) {
      checkoutSection.style.display = "block"; notConfigured.style.display = "none";
    } else {
      checkoutSection.style.display = "none"; notConfigured.style.display = "block";
    }
  }
}

async function obtenerGratis() {
  if (!currentUser) { pedirInicioSesion(); return; }
  const btn = document.querySelector("#gratis-section .btn");
  if (btn) { btn.disabled = true; btn.textContent = "Procesando..."; }
  try {
    const ref = generarReferenciaUnica();
    await registrarVenta(ref, "gratis", "gratis");
    pagoExitoso = true;
    renderStep(getTotalSteps());
  } catch(err) {
    toast("Error al obtener el documento: " + (err.message || err), "error");
    if (btn) { btn.disabled = false; btn.textContent = "Obtener documento gratis"; }
  }
}

/* ── MODO PRUEBA ── */
function actualizarEstadoModoPrueba() {
  const el = document.getElementById("modo-prueba-estado");
  if (!el) return;
  if (modoPrueba) {
    el.textContent = "✅ Activado";
    el.style.color = "var(--success)";
    el.style.fontWeight = "700";
  } else {
    el.textContent = "Desactivado";
    el.style.color = "var(--text-muted)";
    el.style.fontWeight = "";
  }
}

function activarModoPrueba() {
  modoPrueba = true;
  localStorage.setItem("modoPrueba", "1");
  actualizarEstadoModoPrueba();
  toast("Modo prueba activado. Los pagos serán simulados.", "ok");
}

function desactivarModoPrueba() {
  modoPrueba = false;
  localStorage.removeItem("modoPrueba");
  actualizarEstadoModoPrueba();
  toast("Modo prueba desactivado. Los pagos son reales.");
}

/* ═══════════════════════════════════════════════════════
   ① GOOGLE ANALYTICS 4 Y reCAPTCHA v3
   Config en Supabase (tabla config, id="google").
   El navegador solo recibe ga_measurement_id y recaptcha_site_key.
   La recaptcha_secret_key queda en Supabase para la Edge Function.
   ═══════════════════════════════════════════════════════ */

async function cargarGoogleConfig() {
  try {
    const { data, error } = await supabaseClient
      .from("config").select("ga_measurement_id, recaptcha_site_key")
      .eq("id", "google").maybeSingle();
    if (error || !data) return;
    googleConfig = {
      gaMeasurementId:  data.ga_measurement_id  || "",
      recaptchaSiteKey: data.recaptcha_site_key  || ""
    };
    if (googleConfig.gaMeasurementId)  inicializarGA4(googleConfig.gaMeasurementId);
    if (googleConfig.recaptchaSiteKey) inicializarRecaptcha(googleConfig.recaptchaSiteKey);
  } catch (_) {}
}

function inicializarGA4(measurementId) {
  if (!measurementId || document.getElementById("ga4-script")) return;
  const s = document.createElement("script");
  s.id = "ga4-script"; s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function() { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("config", measurementId, { send_page_view: true });
}

function gtag_evento(nombre, params) {
  try { if (typeof window.gtag === "function") window.gtag("event", nombre, params || {}); } catch (_) {}
}

function ga4_page_view(seccion) {
  try {
    if (typeof window.gtag !== "function") return;
    window.gtag("event", "page_view", {
      page_title:    document.title + " — " + seccion,
      page_location: window.location.href.split("#")[0] + "#" + seccion
    });
  } catch (_) {}
}

function inicializarRecaptcha(siteKey) {
  if (!siteKey || document.getElementById("recaptcha-script")) return;
  const s = document.createElement("script");
  s.id = "recaptcha-script"; s.async = true; s.defer = true;
  s.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
  document.head.appendChild(s);
}

async function obtenerTokenRecaptcha(accion) {
  try {
    if (typeof window.grecaptcha === "undefined" || !googleConfig.recaptchaSiteKey) return null;
    await new Promise(resolve => window.grecaptcha.ready(resolve));
    return await window.grecaptcha.execute(googleConfig.recaptchaSiteKey, { action: accion });
  } catch (_) { return null; }
}

async function cargarGoogleConfigAdmin() {
  try {
    const { data, error } = await supabaseClient
      .from("config").select("ga_measurement_id, recaptcha_site_key, recaptcha_secret_key")
      .eq("id", "google").maybeSingle();
    if (error || !data) return;
    const gaInput  = document.getElementById("google-ga-id");
    const skInput  = document.getElementById("google-recaptcha-site-key");
    const secInput = document.getElementById("google-recaptcha-secret-key");
    if (gaInput  && data.ga_measurement_id)    gaInput.value  = data.ga_measurement_id;
    if (skInput  && data.recaptcha_site_key)   skInput.value  = data.recaptcha_site_key;
    if (secInput && data.recaptcha_secret_key) secInput.value = data.recaptcha_secret_key;
    const gaStatus = document.getElementById("google-ga-status");
    if (gaStatus && data.ga_measurement_id)
      gaStatus.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">✅ Google Analytics configurado (${esc(data.ga_measurement_id)}).</p>`;
    const rcStatus = document.getElementById("google-recaptcha-status");
    if (rcStatus && data.recaptcha_site_key)
      rcStatus.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">✅ reCAPTCHA v3 configurado.</p>`;
  } catch (_) {}
}

async function _guardarGoogleConfigRow(campos) {
  const { data: ex } = await supabaseClient.from("config").select("id").eq("id", "google").maybeSingle();
  if (ex) {
    const { error } = await supabaseClient.from("config")
      .update({ ...campos, updated_at: new Date().toISOString() }).eq("id", "google");
    if (error) throw error;
  } else {
    const { error } = await supabaseClient.from("config")
      .insert({ id: "google", api_key: "", ...campos, updated_at: new Date().toISOString() });
    if (error) throw error;
  }
}

async function guardarGoogleConfigGA(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-guardar-google-ga");
  btn.disabled = true; btn.textContent = "Guardando...";
  const gaId = document.getElementById("google-ga-id").value.trim();
  if (!gaId) { toast("Escribe el Measurement ID de Google Analytics.", "error"); btn.disabled = false; btn.textContent = "Guardar"; return; }
  if (!/^G-[A-Z0-9]+$/i.test(gaId)) { toast("El Measurement ID debe tener el formato G-XXXXXXXXXX.", "error"); btn.disabled = false; btn.textContent = "Guardar"; return; }
  try {
    await _guardarGoogleConfigRow({ ga_measurement_id: gaId });
    googleConfig.gaMeasurementId = gaId; inicializarGA4(gaId);
    toast("Measurement ID guardado. Analytics activo.", "ok");
    const st = document.getElementById("google-ga-status");
    if (st) st.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">✅ Google Analytics configurado (${esc(gaId)}).</p>`;
  } catch (err) { toast("Error al guardar: " + err.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Guardar"; }
}

async function guardarGoogleConfigRecaptcha(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-guardar-google-recaptcha");
  btn.disabled = true; btn.textContent = "Guardando...";
  const siteKey   = document.getElementById("google-recaptcha-site-key").value.trim();
  const secretKey = document.getElementById("google-recaptcha-secret-key").value.trim();
  if (!siteKey) { toast("Escribe la Site Key de reCAPTCHA.", "error"); btn.disabled = false; btn.textContent = "Guardar"; return; }
  try {
    await _guardarGoogleConfigRow({ recaptcha_site_key: siteKey, recaptcha_secret_key: secretKey });
    googleConfig.recaptchaSiteKey = siteKey; inicializarRecaptcha(siteKey);
    toast("Configuración de reCAPTCHA guardada.", "ok");
    const st = document.getElementById("google-recaptcha-status");
    if (st) st.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">✅ reCAPTCHA v3 configurado.</p>`;
  } catch (err) { toast("Error al guardar: " + err.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Guardar"; }
}

/* ═══════════════════════════════════════════════════════
   ② SEGURIDAD: LOG DE ACCESOS ADMIN
   Tabla: admin_logs (ejecutar admin_logs.sql en Supabase)
   Los logs son visibles en Supabase → Table Editor → admin_logs
   ═══════════════════════════════════════════════════════ */

async function registrarAccesoAdmin() {
  if (!currentUser || !isAdmin) return;
  try {
    await supabaseClient.from("admin_logs").insert({
      user_id:    currentUser.id,
      user_email: currentUser.email,
      accion:     "acceso_panel_admin",
      created_at: new Date().toISOString()
    });
  } catch (_) {} /* silencioso — no interrumpe la navegación */
}

/* ═══════════════════════════════════════════════════════
   ③ SEGURIDAD: RATE LIMITING IA — LÍMITE DIARIO GLOBAL
   Agrega un tope de usos de IA POR DÍA por usuario
   (independiente del límite por minuta).
   Clave en app_limites: ia_global_USERID_YYYY-MM-DD
   ═══════════════════════════════════════════════════════ */

const IA_GLOBAL_MAX_DIA = 10; /* Máx. usos de IA por usuario por día */

function _iaGlobalClave() {
  if (!currentUser) return null;
  const hoy = new Date().toISOString().slice(0, 10);
  return `ia_global_${currentUser.id}_${hoy}`;
}

async function iaGlobalLimitCheck() {
  const clave = _iaGlobalClave();
  if (!clave) return { bloqueado: false, usos: 0 };
  const data = await _limLeer(clave);
  if (!data) return { bloqueado: false, usos: 0 };
  const bh = data.bloqueado_hasta ? new Date(data.bloqueado_hasta).getTime() : 0;
  if (bh > Date.now()) return { bloqueado: true, usos: data.usos || 0 };
  return { bloqueado: (data.usos || 0) >= IA_GLOBAL_MAX_DIA, usos: data.usos || 0 };
}

async function iaGlobalLimitIncrement() {
  const clave = _iaGlobalClave();
  if (!clave) return false;
  const data  = await _limLeer(clave);
  const usos  = ((data?.usos) || 0) + 1;
  const mañana = new Date(); mañana.setHours(24, 0, 0, 0);
  const bh = usos >= IA_GLOBAL_MAX_DIA ? mañana.toISOString() : null;
  await _limEscribir(clave, usos, bh);
  return usos >= IA_GLOBAL_MAX_DIA;
}

/* ═══════════════════════════════════════════════════════
   ④ SEGURIDAD: FIRMA WOMPI VÍA EDGE FUNCTION
   La integrity_secret NO llega al navegador.
   Se calcula en Supabase Edge Function "wompi-signature".
   Archivo: supabase/functions/wompi-signature/index.ts
   ═══════════════════════════════════════════════════════ */

async function obtenerFirmaWompi(reference, amountInCents, currency) {
  try {
    const { data, error } = await supabaseClient.functions.invoke("wompi-signature", {
      body: { reference, amountInCents, currency }
    });
    if (error) throw error;
    return data?.signature || null;
  } catch (_) {
    /* Edge Function no desplegada → continuar sin firma (Wompi lo permite) */
    return null;
  }
}

/* ─────────────────────────────────────────────────────
   ADMIN TABS
───────────────────────────────────────────────────── */
function cambiarTabAdmin(tabId, btn) {
  document.querySelectorAll(".admin-tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".admin-tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(tabId).classList.add("active");
  if (btn) btn.classList.add("active");
  if (tabId === "tab-categorias") {
    loadAdminCategorias();
    renderAdminData();
  }
  if (tabId === "tab-historial") renderAdminData();
  if (tabId === "tab-google") cargarGoogleConfigAdmin();
}

/* ─────────────────────────────────────────────────────
   PREVISUALIZACIÓN TEMPORAL (10 SEGUNDOS)
───────────────────────────────────────────────────── */
let _previewTimer = null;
let _previewMinutaId = null;
const PREVIEW_MAX_VISTAS = 4;
const PREVIEW_BLOQUEO_MS = 60 * 60 * 1000;

/* ── Límite de vistas previas (Supabase) ──────────── */
async function verificarLimiteVistas(id) {
  const data = await _limLeer(`preview_${id}`);
  if (!data) return { bloqueado: false };
  const now = Date.now();
  const bh  = data.bloqueado_hasta ? new Date(data.bloqueado_hasta).getTime() : 0;
  if (bh > now)  return { bloqueado: true, minutosRestantes: Math.ceil((bh - now) / 60000) };
  if (bh && bh <= now) {
    await _limEscribir(`preview_${id}`, 0, null);
    return { bloqueado: false };
  }
  return { bloqueado: false };
}

async function registrarVistaPreview(id) {
  const data = await _limLeer(`preview_${id}`);
  const nuevoCount = ((data?.usos) || 0) + 1;
  const bh = nuevoCount >= PREVIEW_MAX_VISTAS
    ? new Date(Date.now() + PREVIEW_BLOQUEO_MS).toISOString()
    : null;
  await _limEscribir(`preview_${id}`, nuevoCount, bh);
  return nuevoCount;
}

function mostrarModalBloqueado(nombreMinuta, minutosRestantes) {
  const overlay  = document.getElementById("preview-timed-overlay");
  const content  = document.getElementById("preview-timed-content");
  const titulo   = document.getElementById("preview-timed-titulo");
  const bar      = document.getElementById("countdown-bar");
  const timerTxt = document.getElementById("countdown-text");
  const btnAdq   = document.getElementById("preview-timed-adquirir");
  const footer   = overlay.querySelector(".preview-timed-footer");
  titulo.textContent = "Vista previa no disponible";
  bar.style.width = "0%";
  timerTxt.innerHTML = "";
  if (footer) footer.style.display = "none";
  content.innerHTML = `
    <div style="text-align:center;padding:30px 20px;">
      <div style="font-size:3rem;margin-bottom:16px;">🔒</div>
      <h4 style="font-size:1.1rem;color:var(--primary);margin-bottom:12px;">Has alcanzado el límite de vistas previas</h4>
      <p style="font-size:0.9rem;color:var(--text-muted);line-height:1.6;margin-bottom:20px;">
        Has visto esta minuta demasiadas veces. Podrás volver a previsualizar en aproximadamente
        <strong>${minutosRestantes} minuto${minutosRestantes !== 1 ? "s" : ""}</strong>.
      </p>
      <p style="font-size:0.9rem;color:var(--text);font-weight:600;margin-bottom:20px;">
        ¿Te interesa este documento? Adquiérela para acceder al documento completo y personalizado sin restricciones.
      </p>
      <button class="btn btn-primary" onclick="cerrarPreviewBloqueado('${_previewMinutaId}')">
        Adquirir minuta
      </button>
    </div>`;
  overlay.classList.add("open");
}

function cerrarPreviewBloqueado(id) {
  const overlay = document.getElementById("preview-timed-overlay");
  const footer  = overlay.querySelector(".preview-timed-footer");
  overlay.classList.remove("open");
  if (footer) footer.style.display = "";
  if (id) abrirMinuta(id);
}

async function previsualizarMinuta(id, evt) {
  if (evt) evt.stopPropagation();
  _previewMinutaId = id;
  const limiteCheck = await verificarLimiteVistas(id);
  if (limiteCheck.bloqueado) {
    const minuta = minutasData.find(m => m.id === id);
    mostrarModalBloqueado(minuta ? minuta.nombre : "", limiteCheck.minutosRestantes);
    return;
  }
  await registrarVistaPreview(id);
  const overlay  = document.getElementById("preview-timed-overlay");
  const content  = document.getElementById("preview-timed-content");
  const titulo   = document.getElementById("preview-timed-titulo");
  const bar      = document.getElementById("countdown-bar");
  const timerTxt = document.getElementById("countdown-text");
  const btnAdq   = document.getElementById("preview-timed-adquirir");
  const minuta = minutasData.find(m => m.id === id);
  if (!minuta) { toast("Minuta no encontrada.", "error"); return; }
  _previewMinutaId = id;
  titulo.textContent = minuta.nombre || "Vista previa";
  content.innerHTML = '<div class="loading-spinner"></div>';
  btnAdq.onclick = () => { cerrarPreviewTimed(); abrirMinuta(id); };
  overlay.classList.add("open");
  let html = "";
  if (!html && minuta.docxPreviewURL) {
    try {
      const resp = await fetch(minuta.docxPreviewURL);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        if (buf.byteLength > 0) {
          const result = await mammoth.convertToHtml({ arrayBuffer: buf });
          html = result.value || "";
        }
      }
    } catch(_) {}
  }
  if (!html && minuta.docxBase64) {
    try {
      const binary = atob(minuta.docxBase64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      if (bytes.length > 0) {
        const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
        html = result.value || "";
      }
    } catch(_) {}
  }
  if (!html && minuta.archivoURL) {
    try {
      const resp = await fetch(minuta.archivoURL);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        if (buf.byteLength > 0) {
          const result = await mammoth.convertToHtml({ arrayBuffer: buf });
          html = result.value || "";
        }
      }
    } catch(_) {}
  }
  if (!html) {
    html = `<p><strong>${esc(minuta.nombre)}</strong></p><p>${esc(minuta.descripcion||"")}</p><p style="color:var(--text-muted);font-size:0.83rem;margin-top:14px;padding:10px 14px;background:#f8f7f4;border-radius:8px;border:1px solid var(--border);">La previsualización del documento no está disponible. Para ver el documento completo, adquiere la minuta.</p>`;
  }
  content.innerHTML = `<div class="word-page">${html}</div>`;
  let seg = 10;
  bar.style.transition = "none";
  bar.style.width = "100%";
  timerTxt.innerHTML = `Vista por <strong>${seg}s</strong>`;
  if (_previewTimer) clearInterval(_previewTimer);
  void bar.offsetWidth;
  bar.style.transition = "width 1s linear";
  _previewTimer = setInterval(() => {
    seg--;
    const pct = (seg / 10) * 100;
    bar.style.width = pct + "%";
    timerTxt.innerHTML = `Vista por <strong>${seg}s</strong>`;
    if (seg <= 0) cerrarPreviewTimed();
  }, 1000);
}

function cerrarPreviewTimed() {
  if (_previewTimer) { clearInterval(_previewTimer); _previewTimer = null; }
  const overlay = document.getElementById("preview-timed-overlay");
  overlay.classList.remove("open");
  document.getElementById("preview-timed-content").innerHTML = '<div class="loading-spinner"></div>';
  const footer = overlay.querySelector(".preview-timed-footer");
  if (footer) footer.style.display = "";
}

async function simularPago() {
  if (!currentUser) { pedirInicioSesion(); return; }
  const ref = "TEST-" + Date.now();
  await registrarVenta(ref, "simulado", "prueba");
  pagoExitoso = true;
  renderStep(getTotalSteps());
  toast("Pago simulado. Descarga tu documento ahora.", "ok");
}

function generarReferenciaUnica() {
  const ts   = Date.now();
  const rand = Math.random().toString(36).substring(2,8).toUpperCase();
  return `ML-${ts}-${rand}`;
}

async function calcularIntegritySignature(reference, amountInCents, currency, secret) {
  const cadena     = `${reference}${amountInCents}${currency}${secret}`;
  const encoder    = new TextEncoder();
  const data       = encoder.encode(cadena);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray  = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2,"0")).join("");
}

async function iniciarPagoWompi() {
  if (!currentUser) { pedirInicioSesion(); return; }
  if (!wompiConfig.publicKey) { toast("La pasarela de pago no está configurada. Contacta al administrador.", "error"); return; }
  if (!currentMinuta) return;
  const btn = document.getElementById("btn-pagar-wompi");
  btn.disabled = true; btn.textContent = "Preparando pago...";
  try {
    const amountInCents = Math.round((currentMinuta.precio || 0) * 100);
    const reference = generarReferenciaUnica();
    const currency  = "COP";
    const checkoutConfig = {
      currency, amountInCents, reference,
      publicKey: wompiConfig.publicKey,
      customerData: { email: currentUser.email }
    };
    /* ④ Firma calculada en el servidor (Edge Function) — secret nunca en el browser */
    const firma = await obtenerFirmaWompi(reference, amountInCents, currency);
    if (firma) checkoutConfig.signature = { integrity: firma };
    const checkout = new WidgetCheckout(checkoutConfig);
    btn.disabled = false; btn.textContent = "Pagar ahora";
    checkout.open(async result => {
      const { transaction } = result;
      if (!transaction) return;
      currentWompiTransactionId = transaction.id;
      if (transaction.status === "APPROVED") {
        await registrarVenta(reference, transaction.id, "wompi");
        pagoExitoso = true;
        renderStep(getTotalSteps());
      } else if (["PENDING","IN_VALIDATION"].includes(transaction.status)) {
        document.getElementById("wompi-checkout-section").style.display = "none";
        document.getElementById("wompi-pending-section").style.display = "block";
      } else {
        toast("El pago fue rechazado o cancelado. Intenta de nuevo.", "error");
      }
    });
  } catch(err) {
    toast("Error al iniciar el pago: " + err.message, "error");
    btn.disabled = false; btn.textContent = "Pagar ahora";
  }
}

async function verificarEstadoPago() {
  if (!currentWompiTransactionId) return;
  try {
    const resp = await fetch(`https://sandbox.wompi.co/v1/transactions/${currentWompiTransactionId}`);
    const data = await resp.json();
    const tx   = data.data;
    if (tx && tx.status === "APPROVED") {
      await registrarVenta(tx.reference, tx.id, "wompi");
      pagoExitoso = true;
      renderStep(getTotalSteps());
    } else {
      toast("El pago aún no ha sido aprobado. Intenta en unos minutos.", "");
    }
  } catch(e) { toast("Error verificando el pago.", "error"); }
}

async function registrarVenta(reference, transactionId, metodoPago) {
  if (!currentUser || !currentMinuta) return;
  try {
    const { error } = await supabaseClient.from("ventas").insert({
      user_id:       currentUser.id,
      user_email:    currentUser.email,
      minuta_id:     currentMinuta.id,
      minuta_nombre: currentMinuta.nombre,
      precio:        currentMinuta.precio || 0,
      metodo_pago:   metodoPago,
      reference,
      transaction_id: transactionId,
      estado:        "pagado",
      created_at:    new Date().toISOString()
    });
    if (error) throw error;
    gtag_evento("purchase_minuta", { transaction_id: reference, minuta_id: currentMinuta.id, minuta_nombre: currentMinuta.nombre || "", value: currentMinuta.precio || 0, currency: "COP", payment_method: metodoPago }); /* GA4 */
  } catch(e) { console.warn("[registrarVenta]", e); }
}

/* ── CARGAR CONFIG OPENAI ── */
async function cargarGeminiConfig() {
  try {
    const { data, error } = await supabaseClient
      .from("config")
      .select("*")
      .eq("id", "openai")
      .single();
    if (!error && data) geminiConfig = { apiKey: data.api_key };
  } catch(_) {}
}

/* ── GUARDAR CONFIG OPENAI ── */
async function guardarOpenAIConfig(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-guardar-gemini");
  btn.disabled = true; btn.textContent = "Guardando...";
  const apiKey = document.getElementById("gemini-api-key").value.trim();
  if (!apiKey) {
    toast("Escribe la clave de API de Groq.", "error");
    btn.disabled = false; btn.textContent = "Guardar clave de Groq";
    return;
  }
  if (!apiKey.startsWith("gsk_")) {
    toast("La clave de Groq debe comenzar con 'gsk_'.", "error");
    btn.disabled = false; btn.textContent = "Guardar clave de Groq";
    return;
  }
  try {
    const { error } = await supabaseClient
      .from("config")
      .upsert({ id: "openai", api_key: apiKey, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) throw error;
    geminiConfig = { apiKey };
    toast("Clave de Groq guardada correctamente.", "ok");
    const statusEl = document.getElementById("gemini-config-status");
    statusEl.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">✅ Groq configurado. La IA está lista para usarse.</p>`;
  } catch(e) { toast("Error al guardar: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Guardar clave de Groq"; }
}

/* ── GUARDAR WOMPI CONFIG ── */
async function guardarWompiConfig(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-guardar-wompi");
  btn.disabled = true; btn.textContent = "Guardando...";
  const publicKey       = document.getElementById("wompi-public-key").value.trim();
  const integritySecret = document.getElementById("wompi-integrity-secret").value.trim();
  const mode            = document.getElementById("wompi-mode").value;
  try {
    const { error } = await supabaseClient
      .from("config")
      .upsert({
        id:               "wompi",
        public_key:       publicKey,
        integrity_secret: integritySecret,
        mode,
        updated_at:       new Date().toISOString()
      }, { onConflict: "id" });
    if (error) throw error;
    wompiConfig = { publicKey, integritySecret, mode };
    toast("Configuración Wompi guardada.", "ok");
    const statusEl = document.getElementById("wompi-config-status");
    if (publicKey) statusEl.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">Wompi configurado en modo ${mode === "prod" ? "Producción" : "Pruebas"}.</p>`;
  } catch(e) { toast("Error al guardar: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Guardar configuración Wompi"; }
}

/* ══════════════════════════════════════════════════════
   REEMPLAZAR CAMPOS EN DOCX
   ══════════════════════════════════════════════════════ */
function extraerTextoParagrafo(parrafoXml) {
  const matches = [...parrafoXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
  return matches.map(m => m[1]).join("");
}

function extraerRuns(pBody) {
  const runRegex = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
  const runs = [];
  let rm;
  while ((rm = runRegex.exec(pBody)) !== null) {
    const runXml = rm[0];
    const wts = [...runXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
    const text = wts.map(m => m[1]).join("");
    const rPrM = runXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
    runs.push({
      xml: runXml,
      text,
      rPr: rPrM ? rPrM[0] : "",
      pBodyStart: rm.index,
      pBodyEnd: rm.index + rm[0].length
    });
  }
  return runs;
}

function reemplazarCampoEnParrafo(pBody, campoUP, valorStr, tieneNewline) {
  const runs = extraerRuns(pBody);
  if (!runs.length) return null;
  const fullText = runs.map(r => r.text).join("");
  const fullTextUP = fullText.toUpperCase();
  const idx = fullTextUP.indexOf(campoUP);
  if (idx === -1) return null;
  const idxEnd = idx + campoUP.length;
  let charPos = 0;
  let firstRunIdx = -1, lastRunIdx = -1;
  for (let i = 0; i < runs.length; i++) {
    const runStart = charPos;
    const runEnd = charPos + runs[i].text.length;
    if (firstRunIdx === -1 && runEnd > idx) firstRunIdx = i;
    if (runStart < idxEnd) lastRunIdx = i;
    charPos = runEnd;
  }
  if (firstRunIdx === -1 || lastRunIdx === -1) return null;
  const rPr = runs[firstRunIdx].rPr;
  const pPrM = pBody.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  const pPr = pPrM ? pPrM[0] : "";
  let charBefore = 0;
  for (let i = 0; i < firstRunIdx; i++) charBefore += runs[i].text.length;
  const prefixText = fullText.substring(charBefore, idx);
  let charBeforeLast = 0;
  for (let i = 0; i < lastRunIdx; i++) charBeforeLast += runs[i].text.length;
  const suffixText = fullText.substring(idxEnd, charBeforeLast + runs[lastRunIdx].text.length);
  const buildRun = (rp, txt) =>
    `<w:r>${rp}<w:t xml:space="preserve">${xmlEsc(txt)}</w:t></w:r>`;
  if (!tieneNewline) {
    let replacement = "";
    if (prefixText) replacement += buildRun(rPr, prefixText);
    replacement += buildRun(rPr, valorStr);
    if (suffixText) replacement += buildRun(runs[lastRunIdx].rPr, suffixText);
    const newBody =
      pBody.substring(0, runs[firstRunIdx].pBodyStart) +
      replacement +
      pBody.substring(runs[lastRunIdx].pBodyEnd);
    return newBody;
  } else {
    const lineas = valorStr.split(/\r?\n/);
    const parrafos = lineas.map((linea, li) => {
      let content = pPr;
      if (li === 0 && prefixText) content += buildRun(rPr, prefixText);
      content += buildRun(rPr, linea);
      if (li === lineas.length - 1 && suffixText) content += buildRun(runs[lastRunIdx].rPr, suffixText);
      return `<w:p>${content}</w:p>`;
    }).join("");
    return parrafos;
  }
}

async function reemplazarEnDocx(blob, campos) {
  const buf = await blob.arrayBuffer();
  const zip  = new PizZip(buf);
  const archivos = [
    "word/document.xml",
    "word/header1.xml","word/header2.xml",
    "word/footer1.xml","word/footer2.xml"
  ];
  const entradas = Object.entries(campos)
    .flatMap(([c, v]) => {
      const norm = c.replace(/\s+/g, " ").trim();
      const up   = norm.toUpperCase();
      const base = { valorStr: String(v), tieneNewline: String(v).includes("\n") };
      return [
        { ...base, campoNorm: norm,          campoUP: up },
        { ...base, campoNorm: `{{${norm}}}`, campoUP: `{{${up}}}` },
        { ...base, campoNorm: `[${norm}]`,   campoUP: `[${up}]` },
      ];
    })
    .sort((a, b) => b.campoNorm.length - a.campoNorm.length);
  archivos.forEach(f => {
    if (!zip.files[f]) return;
    let xml = zip.files[f].asText();
    xml = xml
      .replace(/<w:proofErr[^>]*\/?>/g, "")
      .replace(/<\/w:proofErr>/g, "")
      .replace(/<w:rsid[A-Za-z]*="[^"]*"/g, "")
      .replace(/<w:bookmarkStart[^>]*\/?>/g, "")
      .replace(/<w:bookmarkEnd[^>]*\/?>/g, "")
      .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")
      .replace(/<w:ins\b[^>]*>/g, "")
      .replace(/<\/w:ins>/g, "")
      .replace(/<w:rPrChange\b[\s\S]*?<\/w:rPrChange>/g, "")
      .replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, "");
    for (const { campoNorm, campoUP, valorStr, tieneNewline } of entradas) {
      xml = xml.replace(/(<w:p\b[^>]*>)([\s\S]*?)(<\/w:p>)/g, (match, pOpen, pBody, pClose) => {
        const resultado = reemplazarCampoEnParrafo(pBody, campoUP, valorStr, tieneNewline);
        if (resultado === null) return match;
        if (tieneNewline) return resultado;
        return pOpen + resultado + pClose;
      });
    }
    zip.file(f, xml);
  });
  return zip.generate({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
}

/* ── DESCARGA ── */
function setupDescarga() {
  const nombreArchivo = (currentMinuta.nombre||"minuta").replace(/\s+/g,"_");
  const msgEl = document.getElementById("descarga-msg");
  if (msgEl) {
    const usaIA = minutaTieneIA && Object.keys(camposIAMejorados).length > 0;
    if (usaIA) {
      msgEl.textContent = "Tu minuta fue personalizada con los datos que ingresaste y la IA mejoró la redacción. Descárgala ahora.";
    } else {
      msgEl.textContent = "Tu minuta fue personalizada con los datos que ingresaste. Descárgala ahora.";
    }
  }
  document.getElementById("btn-download-word").onclick = async () => {
    if (minutaClausulas && minutaClausulas.length > 0) {
      saveClausulasActuales();
      const resClausulas = validateClausulas();
      if (!resClausulas.ok) {
        marcarCamposExtraFaltantes();
        toast(resClausulas.razon, "error");
        return;
      }
    }
    if (!docxBlob && currentMinuta.archivoURL) {
      toast("Obteniendo archivo de trabajo...", "");
      try {
        const resp = await fetch(currentMinuta.archivoURL, { mode: "cors" });
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          docxBlob = new Blob([buf], { type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        } else {
          toast("Error al obtener el archivo (" + resp.status + "). Verifica las reglas de acceso en Supabase Storage.", "error");
        }
      } catch(fetchErr) {
        toast("No se pudo descargar el archivo de plantilla. Verifica que el bucket de Supabase Storage sea público.", "error");
      }
    }
    if (docxBlob) {
      const camposDeClausulas = {};
      if (minutaClausulas && minutaClausulas.length > 0) {
        for (const cl of minutaClausulas) {
          if (eleccionesClausulas[cl.id] === true && cl.camposExtra && cl.camposExtra.length) {
            for (const campo of cl.camposExtra) {
              const valor = (camposClausulas[cl.id + "_" + campo] || "").trim();
              if (valor) camposDeClausulas[campo] = valor;
            }
          }
        }
      }
      const todosLosCampos = { ...camposLlenados, ...camposIAMejorados, ...camposDeClausulas };
      const nCampos = Object.keys(todosLosCampos).length;
      let blobFinal = docxBlob;
      if (minutaClausulas && minutaClausulas.length > 0) {
        try {
          toast("Aplicando selección de cláusulas…", "");
          const bufferConElecciones = await aplicarEleccionesEnDocx(await blobFinal.arrayBuffer());
          blobFinal = new Blob([bufferConElecciones], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        } catch(err) {
          toast("⚠️ Error procesando cláusulas opcionales: " + (err.message || err), "error");
        }
      }
      if (nCampos > 0) {
        toast(`Insertando ${nCampos} campo(s) en el documento…`, "");
        try {
          blobFinal = await reemplazarEnDocx(blobFinal, todosLosCampos);
          toast("✅ Datos insertados. Descargando…", "");
        } catch(err) {
          toast("⚠️ No se pudieron insertar los datos: " + (err.message || err), "error");
        }
      }
      const url = URL.createObjectURL(blobFinal);
      const a   = document.createElement("a");
      a.href = url; a.download = nombreArchivo + ".docx"; a.click();
      URL.revokeObjectURL(url);
      gtag_evento("download_docx", { minuta_id: currentMinuta ? currentMinuta.id : "", minuta_nombre: currentMinuta ? currentMinuta.nombre : "", file_format: "docx" }); /* GA4 */
      return;
    }
    if (currentMinuta.archivoURL) {
      toast("⚠️ No se pudo obtener el archivo para personalizarlo. Descargando el original.", "error");
      const a = document.createElement("a");
      a.href = currentMinuta.archivoURL; a.target = "_blank"; a.download = nombreArchivo + ".docx"; a.click();
      return;
    }
    toast("Archivo no disponible.", "error");
  };
}

/* ── VISTA PREVIA POST-PAGO ── */
async function generarBlobFinal() {
  let blobFinal = docxBlob;
  if (!blobFinal && currentMinuta.archivoURL) {
    try {
      const resp = await fetch(currentMinuta.archivoURL, { mode: "cors" });
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        blobFinal = new Blob([buf], { type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        docxBlob = blobFinal;
      }
    } catch(_) {}
  }
  if (!blobFinal) return null;
  if (minutaClausulas && minutaClausulas.length > 0) {
    try {
      const bufConElecciones = await aplicarEleccionesEnDocx(await blobFinal.arrayBuffer());
      blobFinal = new Blob([bufConElecciones], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    } catch(_) {}
  }
  const camposDeClausulas = {};
  if (minutaClausulas && minutaClausulas.length > 0) {
    for (const cl of minutaClausulas) {
      if (eleccionesClausulas[cl.id] === true && cl.camposExtra && cl.camposExtra.length) {
        for (const campo of cl.camposExtra) {
          const valor = (camposClausulas[cl.id + "_" + campo] || "").trim();
          if (valor) camposDeClausulas[campo] = valor;
        }
      }
    }
  }
  const todosLosCampos = { ...camposLlenados, ...camposIAMejorados, ...camposDeClausulas };
  if (Object.keys(todosLosCampos).length > 0) {
    try { blobFinal = await reemplazarEnDocx(blobFinal, todosLosCampos); } catch(_) {}
  }
  return blobFinal;
}

async function abrirPreviewPostpago() {
  const overlay = document.getElementById("preview-postpago-overlay");
  const content = document.getElementById("preview-postpago-content");
  if (!overlay || !content) return;
  content.innerHTML = '<div class="loading-spinner"></div>';
  overlay.classList.add("open");
  try {
    const blobFinal = await generarBlobFinal();
    if (!blobFinal) {
      content.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:30px;">No se pudo generar la vista previa del documento.</p>';
      return;
    }
    const buf = await blobFinal.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    const html = result.value || "<p>El documento no tiene contenido visible.</p>";
    content.innerHTML = `<div class="word-page">${html}</div>`;
  } catch(err) {
    content.innerHTML = '<p style="text-align:center;color:var(--danger);padding:30px;">Error al generar la vista previa: ' + esc(err.message || err) + '</p>';
  }
}

function cerrarPreviewPostpago() {
  const overlay = document.getElementById("preview-postpago-overlay");
  if (overlay) overlay.classList.remove("open");
}

function editarDatosPostpago() {
  cerrarPreviewPostpago();
  camposCurrentPage = 1;
  renderStep(1);
}

function descargarDesdePreview() {
  cerrarPreviewPostpago();
  document.getElementById("btn-download-word").click();
}

function switchAuthTab(tab) {
  const isLogin = tab === "login";
  document.getElementById("tab-login-btn").classList.toggle("active", isLogin);
  document.getElementById("tab-register-btn").classList.toggle("active", !isLogin);
  document.getElementById("auth-form-login").classList.toggle("active", isLogin);
  document.getElementById("auth-form-recuperar").classList.remove("active");
  document.getElementById("auth-form-register").classList.toggle("active", !isLogin);
  document.querySelectorAll(".auth-tab").forEach(t => t.style.display = "");
}

function mostrarRecuperacion() {
  document.getElementById("auth-form-login").classList.remove("active");
  document.getElementById("auth-form-register").classList.remove("active");
  document.getElementById("auth-form-recuperar").classList.add("active");
  document.getElementById("recuperar-idle").style.display = "";
  document.getElementById("recuperar-ok").style.display = "none";
  document.getElementById("recuperar-email").value = "";
  document.querySelectorAll(".auth-tab").forEach(t => t.style.display = "none");
}

function ocultarRecuperacion() {
  switchAuthTab("login");
}

function toggleAuthPassword(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  btn.classList.toggle("is-visible", !visible);
  btn.setAttribute("aria-label", visible ? "Mostrar contraseña" : "Ocultar contraseña");
}

document.getElementById("form-recuperar").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = document.getElementById("btn-recuperar");
  const email = document.getElementById("recuperar-email").value.trim();
  btn.disabled = true; btn.textContent = "Enviando...";
  try {
    await obtenerTokenRecaptcha("password_reset"); /* reCAPTCHA v3 */
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    if (error) throw error;
    document.getElementById("recuperar-idle").style.display = "none";
    document.getElementById("recuperar-ok").style.display = "";
  } catch(err) {
    const msg = err.message || "";
    const msgs = {
      "User not found": "No existe una cuenta con ese correo. Verifica que sea el correo con el que te registraste.",
      "Invalid email":  "El correo no tiene un formato válido.",
      "rate limit":     "Demasiados intentos. Espera unos minutos antes de intentar de nuevo.",
    };
    let toastMsg = "No se pudo enviar el correo. Intenta de nuevo.";
    for (const [k, v] of Object.entries(msgs)) {
      if (msg.toLowerCase().includes(k.toLowerCase())) { toastMsg = v; break; }
    }
    toast(toastMsg, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Enviar enlace";
  }
});

function cerrarModal() {
  document.getElementById("modal-overlay").classList.remove("open");
  document.body.style.overflow = "";
}

function pedirInicioSesion() {
  try { saveCamposActuales(); }    catch(_) {}
  try { saveCamposIAActuales(); }  catch(_) {}
  try { saveClausulasActuales(); } catch(_) {}
  pendingMinutaId = currentMinuta ? currentMinuta.id : null;
  if (pendingMinutaId) {
    pendingResumeState = {
      camposLlenados:      { ...camposLlenados },
      camposIALlenados:    { ...camposIALlenados },
      camposIAMejorados:   { ...camposIAMejorados },
      eleccionesClausulas: { ...eleccionesClausulas },
      camposClausulas:     { ...camposClausulas },
      currentStep:         currentStep,
      camposCurrentPage:   camposCurrentPage,
      iaYaProcesada:       iaYaProcesada
    };
  } else {
    pendingResumeState = null;
  }
  pendingCamposSnapshot = pendingResumeState ? { ...pendingResumeState.camposLlenados } : null;
  cerrarModal();
  showSection("usuarios");
  toast("Inicia sesión para continuar — tus datos se conservarán.", "");
}

function restaurarEstadoModal(state) {
  if (!state) return;
  camposLlenados      = { ...(state.camposLlenados      || {}) };
  camposIALlenados    = { ...(state.camposIALlenados    || {}) };
  camposIAMejorados   = { ...(state.camposIAMejorados   || {}) };
  eleccionesClausulas = { ...(state.eleccionesClausulas || {}) };
  camposClausulas     = { ...(state.camposClausulas     || {}) };
  iaYaProcesada       = !!state.iaYaProcesada;
  camposCurrentPage   = state.camposCurrentPage || 1;
  const totalSteps = getTotalSteps();
  let targetStep   = Math.min(Math.max(1, state.currentStep || 1), totalSteps);
  renderStep(targetStep);
  if (typeof actualizarLivePreview === "function") {
    try { actualizarLivePreview(); } catch(_) {}
  }
}

document.getElementById("modal-close").addEventListener("click", cerrarModal);
document.getElementById("modal-overlay").addEventListener("click", e => {
  if (e.target === document.getElementById("modal-overlay")) cerrarModal();
});

/* ═══════════════════════════════════════════════════════
   ADMIN — SUBIR MINUTA CON DETECCIÓN DE IA
═══════════════════════════════════════════════════════ */
const AI_PLACEHOLDER_REGEX = /ESPACIO PARA EL TEXTO DE LA IA\d+\s*\([^)]+\)/gi;

function extractTextFromDocxXml(xmlText) {
  const limpio = xmlText
    .replace(/<w:proofErr[^>]*\/>/g, "")
    .replace(/<w:bookmarkStart[^>]*\/>/g, "")
    .replace(/<w:bookmarkEnd[^>]*\/>/g, "")
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")
    .replace(/<w:rPrChange\b[\s\S]*?<\/w:rPrChange>/g, "")
    .replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, "");
  const matches = [...limpio.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
  return matches.map(m => m[1]).join("");
}

async function detectarClausulasEleccion(arrayBuffer) {
  const zip = new PizZip(arrayBuffer);
  if (!zip.files["word/document.xml"]) return [];
  const xmlText = zip.files["word/document.xml"].asText();
  const limpio = xmlText
    .replace(/<w:proofErr[^>]*\/>/g, "")
    .replace(/<w:bookmarkStart[^>]*\/>/g, "")
    .replace(/<w:bookmarkEnd[^>]*\/>/g, "")
    .replace(/<w:rPrChange[^>]*>[\s\S]*?<\/w:rPrChange>/g, "")
    .replace(/<w:pPrChange[^>]*>[\s\S]*?<\/w:pPrChange>/g, "");
  const parrafoRe = /<w:p[ >][\s\S]*?<\/w:p>/g;
  const parrafos = [];
  let m;
  while ((m = parrafoRe.exec(limpio)) !== null) {
    const textoParrafo = extractTextFromDocxXml(m[0]).trim();
    parrafos.push({ xml: m[0], texto: textoParrafo, idx: parrafos.length });
  }
  const MARCA = /ELECCION\s*USUARIO/i;
  const clausulas = [];
  let dentroBloque = false;
  let inicioIdx = -1;
  for (let i = 0; i < parrafos.length; i++) {
    const texto = parrafos[i].texto;
    if (MARCA.test(texto)) {
      if (!dentroBloque) {
        dentroBloque = true;
        inicioIdx = i;
      } else {
        dentroBloque = false;
        const bloqueParrafos = parrafos.slice(inicioIdx, i + 1);
        const contenido = bloqueParrafos
          .slice(1, -1)
          .map(p => p.texto)
          .filter(Boolean)
          .join("\n");
        const preview = contenido.substring(0, 300) + (contenido.length > 300 ? "..." : "");
        const ORDINAL_RE = /^(PRIMER[AO]|SEGUND[AO]|TERCER[AO]|CUART[AO]|QUINT[AO]|SEXT[AO]|S[EÉ]PTIM[AO]|OCTAV[AO]|NOVEN[AO]|D[EÉ]CIM[AO])[:\s\-\.]/i;
        let titulo = `Cláusula opcional ${clausulas.length + 1}`;
        for (const p of bloqueParrafos.slice(1, -1)) {
          if (p.texto && ORDINAL_RE.test(p.texto)) {
            titulo = p.texto.substring(0, 80).trim();
            break;
          } else if (p.texto && p.texto.length > 3) {
            titulo = p.texto.substring(0, 80).trim();
            break;
          }
        }
        clausulas.push({
          id: "clausula_" + clausulas.length,
          titulo, preview, contenido,
          inicioIdx, finIdx: i, camposExtra: []
        });
        inicioIdx = -1;
      }
    }
  }
  return clausulas;
}

async function confirmarEleccionUsuario(tiene) {
  const eleccionResult = document.getElementById("eleccion-detected-result");
  eleccionResult.style.display = "block";
  if (!tiene) {
    adminClausulasEleccion = [];
    eleccionResult.innerHTML = "<p style='color:var(--text-muted);font-size:0.87rem;'>Sin cláusulas opcionales. Los clientes no tendrán elección de cláusulas.</p>";
    return;
  }
  if (!adminDocxBuffer) {
    toast("Primero selecciona un archivo Word.", "error"); return;
  }
  eleccionResult.innerHTML = "<p style='color:var(--text-muted);font-size:0.87rem;'>Analizando cláusulas...</p>";
  try {
    const clausulas = await detectarClausulasEleccion(adminDocxBuffer);
    if (!clausulas.length) {
      adminClausulasEleccion = [];
      eleccionResult.innerHTML = `
        <div class="eleccion-detected-box" style="border-color:rgba(192,57,43,0.3);background:rgba(192,57,43,0.07);">
          <p style="color:var(--danger);">⚠ No se encontraron marcadores ELECCION USUARIO en el documento.</p>
          <p style="font-size:0.82rem;color:var(--text-muted);margin-top:6px;">
            Asegúrate de que el Word contenga exactamente el texto <strong>ELECCION USUARIO</strong>
            (en mayúsculas) al inicio y al final de cada cláusula opcional que deseas configurar.
          </p>
        </div>`;
      return;
    }
    adminClausulasEleccion = clausulas;
    renderAdminClausulasConfig();
  } catch(ex) {
    eleccionResult.innerHTML = `<p style='color:var(--danger);'>Error analizando el archivo: ${esc(ex.message)}</p>`;
  }
}

function renderAdminClausulasConfig() {
  const eleccionResult = document.getElementById("eleccion-detected-result");
  const clausulas = adminClausulasEleccion;
  const itemsHtml = clausulas.map((cl, idx) => `
    <div class="eleccion-item" id="admin-clausula-${idx}">
      <div class="eleccion-item-label">📌 Cláusula ${idx + 1}: ${esc(cl.titulo)}</div>
      <div class="clausula-opcion-preview" style="max-height:80px;">${esc(cl.preview)}</div>
      <div class="eleccion-campos-extra-input">
        <label>Campos adicionales si el cliente <strong>incluye</strong> esta cláusula (separados por coma):</label>
        <input type="text"
               class="form-input"
               placeholder="Ej: NOMBRE ARRENDATARIO, FECHA DE INICIO, VALOR MENSUAL"
               id="admin-clausula-campos-${idx}"
               value="${esc((cl.camposExtra||[]).join(", "))}"
               oninput="actualizarCamposExtraClausula(${idx})"
               style="margin-top:4px;" />
        <p style="font-size:0.78rem;color:var(--text-muted);margin-top:3px;">
          Estos campos serán pedidos al cliente si decide incluir esta cláusula.
          Usa los mismos nombres que en el Word (sin llaves). Deja vacío si no hay campos adicionales.
        </p>
      </div>
    </div>`).join("");
  eleccionResult.innerHTML = `
    <div class="eleccion-detected-box">
      <p>✅ Se detectaron ${clausulas.length} cláusula(s) opcional(es)</p>
      ${itemsHtml}
    </div>`;
}

function actualizarCamposExtraClausula(idx) {
  const input = document.getElementById("admin-clausula-campos-" + idx);
  if (!input) return;
  const campos = input.value.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (adminClausulasEleccion[idx]) {
    adminClausulasEleccion[idx].camposExtra = campos;
  }
}

function textoPlanoAHtml(texto) {
  if (!texto) return "";
  return texto
    .split(/\n\n+/)
    .map(parrafo => {
      const lineas = parrafo
        .split("\n")
        .map(l => esc(l.trim()))
        .filter(l => l.length > 0)
        .join("<br>");
      return lineas ? `<p>${lineas}</p>` : "";
    })
    .filter(p => p.length > 0)
    .join("");
}

/* ══════════════════════════════════════════════════════════
   CLÁUSULAS OPCIONALES — ELECCION USUARIO (flujo cliente)
══════════════════════════════════════════════════════════ */
function buildClausulasForm() {
  const container = document.getElementById("clausulas-dinamicas");
  if (!container) return;
  mostrarListaClausulas();
}

function mostrarListaClausulas() {
  const container = document.getElementById("clausulas-dinamicas");
  if (!container) return;
  const pendientes = minutaClausulas.filter(cl => eleccionesClausulas[cl.id] === undefined || eleccionesClausulas[cl.id] === null).length;
  container.innerHTML = `
    ${pendientes > 0 ? `<p class="clausulas-pendientes-aviso">⚠️ ${pendientes} cláusula${pendientes > 1 ? 's' : ''} sin decisión — haz clic en cada una para leerla y elegir.</p>` : ""}
    <div class="clausulas-lista">
      ${minutaClausulas.map((cl, idx) => {
        const incluida = eleccionesClausulas[cl.id] === true;
        const excluida = eleccionesClausulas[cl.id] === false;
        const estadoClass = incluida ? 'seleccionada' : excluida ? 'excluida' : '';
        const estadoIcon = incluida ? '✅' : excluida ? '✗' : '📌';
        const estadoTexto = incluida ? 'Incluida' : excluida ? 'Excluida' : 'Sin decidir';
        const estadoBadgeClass = incluida ? 'badge-ok' : excluida ? 'badge-no' : 'badge-pendiente';
        return `
          <button class="clausula-lista-item ${estadoClass}" onclick="mostrarDetalleClausula(${idx})">
            <span class="clausula-lista-icono">${estadoIcon}</span>
            <span class="clausula-lista-titulo">${esc(cl.titulo)}</span>
            <span class="clausula-lista-badge ${estadoBadgeClass}">${estadoTexto}</span>
            <svg class="clausula-lista-flecha" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/>
            </svg>
          </button>`;
      }).join("")}
    </div>`;
}

function mostrarDetalleClausula(idx) {
  const container = document.getElementById("clausulas-dinamicas");
  const cl = minutaClausulas[idx];
  if (!container || !cl) return;
  const incluida = eleccionesClausulas[cl.id] === true;
  const excluida = eleccionesClausulas[cl.id] === false;
  const total = minutaClausulas.length;
  const textoCompleto = cl.contenido || cl.preview || "";
  const camposExtraHtml = (cl.camposExtra && cl.camposExtra.length > 0)
    ? `<div class="clausula-campos-extra ${incluida ? 'visible' : ''}" id="clausula-extra-0" style="${incluida ? '' : 'display:none;'}">
        <p style="font-size:0.84rem;font-weight:600;color:var(--primary);margin-bottom:10px;">
          Completa los siguientes campos para esta cláusula:
        </p>
        ${cl.camposExtra.map(campo => `
          <div class="form-group" style="margin-bottom:12px;">
            <label class="form-label">${esc(campo)}</label>
            <input type="text"
                   class="form-input clausula-campo-input"
                   placeholder="${esc(campo)}"
                   data-clausula="${cl.id}"
                   data-campo="${esc(campo)}"
                   value="${esc(camposClausulas[cl.id + '_' + campo] || '')}"
                   oninput="guardarCampoClausulaExtra(this)" />
          </div>`).join("")}
      </div>`
    : "";
  const prevBtn = idx > 0
    ? `<button class="btn-clausula-nav" onclick="mostrarDetalleClausula(${idx - 1})">← Anterior</button>`
    : `<span></span>`;
  const nextBtn = idx < total - 1
    ? `<button class="btn-clausula-nav" onclick="mostrarDetalleClausula(${idx + 1})">Siguiente →</button>`
    : `<span></span>`;
  container.innerHTML = `
    <div class="clausula-detalle-wrap">
      <div class="clausula-detalle-header">
        <button class="clausula-volver-btn" onclick="mostrarListaClausulas()">
          <svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px;vertical-align:-2px;margin-right:5px;">
            <path fill-rule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clip-rule="evenodd"/>
          </svg>
          Ver todas las cláusulas
        </button>
        <span class="clausula-detalle-progreso">${idx + 1} / ${total}</span>
      </div>
      <div class="clausula-detalle-body">
        <h4 class="clausula-detalle-titulo">${esc(cl.titulo)}</h4>
        ${textoCompleto ? `<div class="clausula-word-viewer"><div class="word-page">${textoPlanoAHtml(textoCompleto)}</div></div>` : ""}
        <div class="clausula-opcion-btns" style="margin-top:18px;">
          <button class="btn-clausula-incluir ${incluida ? 'activo' : ''}" id="det-btn-incluir"
                  onclick="toggleClausulaDesdeDetalle(${idx}, true)">
            ✅ Incluir esta cláusula
          </button>
          <button class="btn-clausula-excluir ${excluida ? 'activo' : ''}" id="det-btn-excluir"
                  onclick="toggleClausulaDesdeDetalle(${idx}, false)">
            ✗ Excluir del contrato
          </button>
        </div>
        ${camposExtraHtml}
      </div>
      <div class="clausula-detalle-nav">
        ${prevBtn}
        ${nextBtn}
      </div>
    </div>`;
}

function toggleClausulaDesdeDetalle(idx, incluir) {
  const cl = minutaClausulas[idx];
  if (!cl) return;
  eleccionesClausulas[cl.id] = incluir;
  const btnInc = document.getElementById("det-btn-incluir");
  const btnExc = document.getElementById("det-btn-excluir");
  if (btnInc) btnInc.classList.toggle("activo", incluir);
  if (btnExc) btnExc.classList.toggle("activo", !incluir);
  const extraDiv = document.getElementById("clausula-extra-0");
  if (extraDiv) {
    extraDiv.style.display = incluir ? "block" : "none";
  }
  actualizarLivePreview();
}

function toggleClausula(idx, incluir) {
  const cl = minutaClausulas[idx];
  if (!cl) return;
  eleccionesClausulas[cl.id] = incluir;
  const card = document.getElementById("clausula-card-" + idx);
  if (card) {
    card.classList.toggle("seleccionada", incluir);
    card.classList.toggle("excluida", !incluir);
    const icono = document.getElementById("clausula-icono-" + idx);
    if (icono) icono.textContent = incluir ? "✅" : "✗";
    const btnInc = card.querySelector(".btn-clausula-incluir");
    const btnExc = card.querySelector(".btn-clausula-excluir");
    if (btnInc) btnInc.classList.toggle("activo", incluir);
    if (btnExc) btnExc.classList.toggle("activo", !incluir);
    const extraDiv = document.getElementById("clausula-extra-" + idx);
    if (extraDiv) extraDiv.classList.toggle("visible", incluir);
  }
  actualizarLivePreview();
}

function guardarCampoClausulaExtra(input) {
  const clausulaId = input.getAttribute("data-clausula");
  const campo = input.getAttribute("data-campo");
  camposClausulas[clausulaId + "_" + campo] = input.value;
  if (input.value.trim()) {
    input.style.borderColor = "";
    input.style.background = "";
  }
}

function validateClausulas() {
  for (const cl of minutaClausulas) {
    if (eleccionesClausulas[cl.id] === undefined || eleccionesClausulas[cl.id] === null) {
      return { ok: false, razon: `Por favor indica si deseas incluir o excluir la cláusula: "${cl.titulo}".` };
    }
    if (eleccionesClausulas[cl.id] === true && cl.camposExtra && cl.camposExtra.length) {
      for (const campo of cl.camposExtra) {
        const val = (camposClausulas[cl.id + "_" + campo] || "").trim();
        if (!val) return { ok: false, razon: `Completa el campo "${campo}" de la cláusula "${cl.titulo}".` };
      }
    }
  }
  return { ok: true };
}

function marcarCamposExtraFaltantes() {
  document.querySelectorAll(".clausula-campo-input").forEach(input => {
    const clausulaId = input.getAttribute("data-clausula");
    const campo = input.getAttribute("data-campo");
    const incluida = eleccionesClausulas[clausulaId] === true;
    const vacio = !(camposClausulas[clausulaId + "_" + campo] || "").trim();
    if (incluida && vacio) {
      input.style.borderColor = "var(--danger)";
      input.style.background = "rgba(192,57,43,0.04)";
    } else {
      input.style.borderColor = "";
      input.style.background = "";
    }
  });
}

function saveClausulasActuales() {
  const inputs = document.querySelectorAll(".clausula-campo-input");
  inputs.forEach(inp => {
    const clausulaId = inp.getAttribute("data-clausula");
    const campo = inp.getAttribute("data-campo");
    camposClausulas[clausulaId + "_" + campo] = inp.value;
  });
}

/* ══════════════════════════════════════════════════════════
   PROCESAMIENTO DOCX — eliminar cláusulas y renumerar
══════════════════════════════════════════════════════════ */
const ORDINALES_ES = [
  "PRIMERO","SEGUNDO","TERCERO","CUARTO","QUINTO",
  "SEXTO","SÉPTIMO","SÉPTIMO","OCTAVO","NOVENO",
  "DÉCIMO","DÉCIMO PRIMERO","DÉCIMO SEGUNDO","DÉCIMO TERCERO",
  "DÉCIMO CUARTO","DÉCIMO QUINTO","DÉCIMO SEXTO","DÉCIMO SÉPTIMO",
  "DÉCIMO OCTAVO","DÉCIMO NOVENO","VIGÉSIMO"
];

async function aplicarEleccionesEnDocx(arrayBuffer) {
  if (!minutaClausulas || minutaClausulas.length === 0) return arrayBuffer;
  const zip = new PizZip(arrayBuffer);
  if (!zip.files["word/document.xml"]) return arrayBuffer;
  let xmlText = zip.files["word/document.xml"].asText();
  const limpio = xmlText
    .replace(/<w:proofErr[^>]*\/>/g, "")
    .replace(/<w:bookmarkStart[^>]*\/>/g, "")
    .replace(/<w:bookmarkEnd[^>]*\/>/g, "")
    .replace(/<w:rPrChange[^>]*>[\s\S]*?<\/w:rPrChange>/g, "")
    .replace(/<w:pPrChange[^>]*>[\s\S]*?<\/w:pPrChange>/g, "");
  const parrafoRe = /(<w:p[ >][\s\S]*?<\/w:p>)/g;
  const partes = limpio.split(parrafoRe);
  const MARCA = /ELECCION\s*USUARIO/i;
  let parrafosInfo = [];
  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i];
    const esParrafo = /<w:p[ >]/.test(parte) && parte.endsWith("</w:p>");
    const texto = esParrafo ? extractTextFromDocxXml(parte).trim() : "";
    parrafosInfo.push({ contenido: parte, esParrafo, texto, esMarkup: esParrafo && MARCA.test(texto) });
  }
  const marcadores = [];
  for (let i = 0; i < parrafosInfo.length; i++) {
    if (parrafosInfo[i].esMarkup) marcadores.push(i);
  }
  const bloques = [];
  for (let i = 0; i < marcadores.length - 1; i += 2) {
    const clausulaIdx = Math.floor(i / 2);
    const cl = minutaClausulas[clausulaIdx];
    if (!cl) continue;
    bloques.push({
      clausulaId: cl.id,
      clausulaIdx,
      inicioIdx: marcadores[i],
      finIdx: marcadores[i + 1]
    });
  }
  const eliminar = new Set();
  for (const bloque of bloques) {
    const incluida = eleccionesClausulas[bloque.clausulaId] !== false;
    if (!incluida) {
      for (let j = bloque.inicioIdx; j <= bloque.finIdx; j++) {
        eliminar.add(j);
      }
    } else {
      eliminar.add(bloque.inicioIdx);
      eliminar.add(bloque.finIdx);
    }
  }
  let xmlFinal = parrafosInfo
    .filter((_, i) => !eliminar.has(i))
    .map(p => p.contenido)
    .join("");
  xmlFinal = renumerarOrdinalesDocx(xmlFinal);
  zip.file("word/document.xml", xmlFinal);
  return zip.generate({ type: "arraybuffer", compression: "DEFLATE" });
}

function renumerarOrdinalesDocx(xmlText) {
  const LISTA_MASC = [
    "PRIMERO","SEGUNDO","TERCERO","CUARTO","QUINTO",
    "SEXTO","SÉPTIMO","OCTAVO","NOVENO","DÉCIMO",
    "DÉCIMO PRIMERO","DÉCIMO SEGUNDO","DÉCIMO TERCERO",
    "DÉCIMO CUARTO","DÉCIMO QUINTO","DÉCIMO SEXTO",
    "DÉCIMO SÉPTIMO","DÉCIMO OCTAVO","DÉCIMO NOVENO","VIGÉSIMO"
  ];
  const LISTA_FEM = [
    "PRIMERA","SEGUNDA","TERCERA","CUARTA","QUINTA",
    "SEXTA","SÉPTIMA","OCTAVA","NOVENA","DÉCIMA",
    "DÉCIMA PRIMERA","DÉCIMA SEGUNDA","DÉCIMA TERCERA",
    "DÉCIMA CUARTA","DÉCIMA QUINTA","DÉCIMA SEXTA",
    "DÉCIMA SÉPTIMA","DÉCIMA OCTAVA","DÉCIMA NOVENA","VIGÉSIMA"
  ];
  const SIMPLES_MF = "PRIMER[AO]|SEGUND[AO]|TERCER[AO]|CUART[AO]|QUINT[AO]|SEXT[AO]|S[EÉ]PTIM[AO]|OCTAV[AO]|NOVEN[AO]";
  const ORDINAL_RE_STR = "(?:D[EÉ]CIM[AO]\\s+(?:" + SIMPLES_MF + ")|VIG[EÉ]SIM[AO]|D[EÉ]CIM[AO]|" + SIMPLES_MF + ")";
  const PATRON_TITULO_A = new RegExp("^(" + ORDINAL_RE_STR + ")\\b", "i");
  const PATRON_TITULO_B = new RegExp("^(P[AÁ]RRAFO|PARA[GG]RAFO|P[AÁ]RAGRAFO)\\s+(" + ORDINAL_RE_STR + ")\\b", "i");
  function esFemenino(str) { return /[aáAÁ]\s*$/.test(str.trim()); }
  function ordinalPorPosicion(idx, fem) {
    const lista = fem ? LISTA_FEM : LISTA_MASC;
    return idx < lista.length ? lista[idx] : null;
  }
  const parrafoRe = /(<w:p[ >][\s\S]*?<\/w:p>)/g;
  const partes = xmlText.split(parrafoRe);
  let contadorClausulas = 0;
  let contadorParafrafos = 0;
  const WP_START_RE = /<w:p[\s>]/;
  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i];
    if (!WP_START_RE.test(parte) || !parte.endsWith("</w:p>")) continue;
    const textoParrafo = extractTextFromDocxXml(parte).trim();
    const matchB = textoParrafo.match(PATRON_TITULO_B);
    if (matchB) {
      const ordinalTexto = matchB[2];
      const fem = esFemenino(ordinalTexto);
      const ordinalNuevo = ordinalPorPosicion(contadorParafrafos, fem);
      contadorParafrafos++;
      if (ordinalNuevo && ordinalTexto.trim().toUpperCase() !== ordinalNuevo) {
        partes[i] = reemplazarTextoEnParrafoXml(parte, ordinalTexto, ordinalNuevo);
      }
      continue;
    }
    const matchA = textoParrafo.match(PATRON_TITULO_A);
    if (matchA) {
      const ordinalTexto = matchA[1];
      const fem = esFemenino(ordinalTexto);
      const ordinalNuevo = ordinalPorPosicion(contadorClausulas, fem);
      contadorClausulas++;
      if (ordinalNuevo && ordinalTexto.trim().toUpperCase() !== ordinalNuevo) {
        partes[i] = reemplazarTextoEnParrafoXml(parte, ordinalTexto, ordinalNuevo);
      }
      continue;
    }
  }
  return partes.join("");
}

function reemplazarTextoEnParrafoXml(parrafoXml, textoViejo, textoNuevo) {
  const reEscaped = textoViejo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(reEscaped, 'gi');
  return parrafoXml.replace(/<w:t([^>]*)>([\s\S]*?)<\/w:t>/g, (match, attrs, content) => {
    const newContent = content.replace(re, xmlEsc(textoNuevo));
    return `<w:t${attrs}>${newContent}</w:t>`;
  });
}

async function detectarPlaceholdersIA(arrayBuffer) {
  const zip = new PizZip(arrayBuffer);
  const files = ["word/document.xml","word/header1.xml","word/header2.xml","word/footer1.xml","word/footer2.xml"];
  const encontrados = new Map();
  const reDetect = /ESPACIO\s+PARA\s+EL\s+TEXTO\s+DE\s+LA\s+IA\s*(\d+)\s*\(([^)]+)\)/gi;
  files.forEach(f => {
    if (!zip.files[f]) return;
    const xmlText = zip.files[f].asText();
    const limpio = xmlText
      .replace(/<w:proofErr[^>]*\/>/g, "")
      .replace(/<w:bookmarkStart[^>]*\/>/g, "")
      .replace(/<w:bookmarkEnd[^>]*\/>/g, "");
    let m;
    reDetect.lastIndex = 0;
    while ((m = reDetect.exec(limpio)) !== null) {
      const num   = m[1];
      const label = m[2].trim().toUpperCase();
      const clave = `ESPACIO PARA EL TEXTO DE LA IA${num} (${label})`;
      encontrados.set(clave, clave);
    }
    const textoPlano = extractTextFromDocxXml(limpio);
    reDetect.lastIndex = 0;
    while ((m = reDetect.exec(textoPlano)) !== null) {
      const num   = m[1];
      const label = m[2].trim().toUpperCase();
      const clave = `ESPACIO PARA EL TEXTO DE LA IA${num} (${label})`;
      encontrados.set(clave, clave);
    }
  });
  return [...encontrados.values()].sort((a, b) => {
    const na = parseInt(a.match(/IA(\d+)/)?.[1] || "0");
    const nb = parseInt(b.match(/IA(\d+)/)?.[1] || "0");
    return na - nb;
  });
}

/* Cuando el admin selecciona un archivo */
document.getElementById("adm-archivo").addEventListener("change", async e => {
  const file = e.target.files[0];
  const info = document.getElementById("file-info");
  const aiBox = document.getElementById("ai-question-box");
  const aiResult = document.getElementById("ai-placeholders-result");
  const eleccionBox = document.getElementById("eleccion-question-box");
  const eleccionResult = document.getElementById("eleccion-detected-result");
  adminDocxBuffer = null;
  adminPlaceholdersIA = [];
  adminClausulasEleccion = [];
  if (!file) {
    info.style.display = "none";
    aiBox.style.display = "none";
    eleccionBox.style.display = "none";
    return;
  }
  const kb    = (file.size / 1024).toFixed(1);
  const mb    = (file.size / 1024 / 1024).toFixed(2);
  const sizeStr = file.size > 1024*1024 ? mb + " MB" : kb + " KB";
  info.style.display = "block";
  info.textContent = "📄 " + file.name + "  —  " + sizeStr;
  try {
    adminDocxBuffer = await file.arrayBuffer();
  } catch(ex) {}
  eleccionResult.style.display = "none";
  eleccionResult.innerHTML = "";
  try {
    const clausulasDetectadas = await detectarClausulasEleccion(adminDocxBuffer);
    if (clausulasDetectadas.length > 0) {
      eleccionBox.style.display = "block";
      adminClausulasEleccion = clausulasDetectadas;
    } else {
      eleccionBox.style.display = "block";
      adminClausulasEleccion = [];
    }
  } catch(ex) {
    eleccionBox.style.display = "block";
  }
  aiBox.style.display = "block";
  aiResult.style.display = "none";
  aiResult.innerHTML = "";
  const btns = aiBox.querySelectorAll(".ai-question-btns .btn");
  btns.forEach(b => b.classList.remove("btn-success"));
});

async function confirmarCamposIA(tiene) {
  const aiBox    = document.getElementById("ai-question-box");
  const aiResult = document.getElementById("ai-placeholders-result");
  if (!tiene) {
    adminPlaceholdersIA = [];
    aiResult.style.display = "block";
    aiResult.innerHTML = "<p style='color:var(--text-muted);'>Sin campos de IA. La minuta usará solo los campos personalizables normales.</p>";
    return;
  }
  if (!adminDocxBuffer) {
    toast("Primero selecciona un archivo Word.", "error"); return;
  }
  aiResult.style.display = "block";
  aiResult.innerHTML = "<p style='color:var(--text-muted);'>Analizando el documento...</p>";
  try {
    const encontrados = await detectarPlaceholdersIA(adminDocxBuffer);
    adminPlaceholdersIA = encontrados;
    if (!encontrados.length) {
      aiResult.innerHTML = `<p style='color:var(--danger);font-weight:600;'>No se encontraron marcadores de IA en el documento.</p>
        <p style='font-size:0.82rem;color:var(--text-muted);margin-top:6px;'>
          El Word debe contener exactamente los textos:<br>
          <code>ESPACIO PARA EL TEXTO DE LA IA1 (HECHOS)</code><br>
          <code>ESPACIO PARA EL TEXTO DE LA IA2 (PRETENSIONES)</code><br>
          El número y la etiqueta entre paréntesis son obligatorios.
        </p>`;
    } else {
      aiResult.innerHTML = `<p style='color:var(--success);font-weight:600;'>✅ Se detectaron ${encontrados.length} marcador(es) de IA:</p>
        <ul>${encontrados.map(p => `<li><code>${esc(p)}</code> → campo "<strong>${esc(humanizarPlaceholderIA(p))}</strong>"</li>`).join("")}</ul>
        <p style='font-size:0.82rem;color:var(--text-muted);margin-top:8px;'>Estos marcadores serán reemplazados por el texto mejorado por IA al generar el documento.</p>`;
    }
  } catch(ex) {
    aiResult.innerHTML = `<p style='color:var(--danger);'>Error analizando el archivo: ${esc(ex.message)}</p>`;
  }
}

/* Límite en bytes para guardar el docx como Base64 en la BD */
const DOCX_BASE64_MAX_BYTES = 700 * 1024; // 700 KB

/* ── FORMULARIO NUEVA MINUTA ── */
document.getElementById("form-nueva-minuta").addEventListener("submit", async e => {
  e.preventDefault();
  if (!isAdmin) { toast("Sin permisos.", "error"); return; }
  const btn = document.getElementById("btn-guardar-minuta");
  btn.disabled = true; btn.textContent = "Guardando...";
  try {
    const nombre        = document.getElementById("adm-nombre").value.trim();
    const descripcion   = document.getElementById("adm-descripcion").value.trim();
    const categoria     = document.getElementById("adm-categoria").value;
    const tipoDocSel    = document.getElementById("adm-tipo-documento");
    const tipoDocumento = tipoDocSel ? tipoDocSel.value.trim() : "";
    const ctxIaEl       = document.getElementById("adm-contexto-ia");
    const contextoIA    = ctxIaEl ? ctxIaEl.value.trim() : "";
    const precio        = parseFloat(document.getElementById("adm-precio").value)||0;
    const campos      = document.getElementById("adm-campos").value.split(",").map(s=>s.trim()).filter(Boolean);
    const camposLargo = document.getElementById("adm-campos-largo-nombres").value.split(",").map(s=>s.trim()).filter(Boolean);
    const file        = document.getElementById("adm-archivo").files[0];
    const filePreview = document.getElementById("adm-archivo-preview").files[0];

    const tieneIA      = adminPlaceholdersIA.length > 0;
    const placeholdersIA = adminPlaceholdersIA;
    const tieneClausulas = adminClausulasEleccion.length > 0;
    const clausulasEleccion = adminClausulasEleccion;

    let archivoURL = "", archivoNombre = "", docxBase64 = "", docxPreviewURL = "";

    if (file) {
      archivoNombre = file.name;
      // 1. Subir a Supabase Storage
      try {
        btn.textContent = "Subiendo archivo de trabajo a Storage...";
        const filePath = `minutas/${Date.now()}_${file.name}`;
        const { data: storageData, error: storageError } = await supabaseClient.storage
          .from("minutas")
          .upload(filePath, file, { upsert: false });
        if (storageError) throw storageError;
        const { data: urlData } = supabaseClient.storage
          .from("minutas")
          .getPublicUrl(filePath);
        archivoURL = urlData.publicUrl;
      } catch(se) {
        console.warn("[Admin] Error subiendo a Storage:", se);
        toast("Advertencia: no se pudo subir a Storage. Verifica las reglas del bucket en Supabase.", "error");
      }
      // 2. Guardar Base64 si el archivo es suficientemente pequeño
      if (file.size <= DOCX_BASE64_MAX_BYTES) {
        try {
          btn.textContent = "Leyendo archivo de trabajo...";
          docxBase64 = await fileToBase64(file);
        } catch(be) {
          console.warn("[Admin] Error convirtiendo a Base64:", be);
          docxBase64 = "";
        }
      }
    }

    if (filePreview) {
      btn.textContent = "Subiendo archivo de previsualización...";
      try {
        const previewPath = `minutas/preview_${Date.now()}_${filePreview.name}`;
        const { error: prevError } = await supabaseClient.storage
          .from("minutas")
          .upload(previewPath, filePreview, { upsert: false });
        if (prevError) throw prevError;
        const { data: prevUrlData } = supabaseClient.storage
          .from("minutas")
          .getPublicUrl(previewPath);
        docxPreviewURL = prevUrlData.publicUrl;
      } catch(se) {
        console.warn("[Admin] Error subiendo preview a Storage:", se);
      }
    }

    if (!archivoURL && !docxBase64) {
      toast("Error: el archivo no se pudo guardar en Storage ni localmente. Verifica la configuración del bucket en Supabase.", "error");
      return;
    }

    btn.textContent = "Guardando en base de datos...";

    const datosMinuta = {
      nombre, descripcion, categoria,
      tipo_documento:     tipoDocumento,
      contexto_ia:        contextoIA,
      precio,
      campos,
      campos_largo:       camposLargo,
      tiene_ia:           tieneIA,
      placeholders_ia:    placeholdersIA,
      tiene_clausulas:    tieneClausulas,
      clausulas_eleccion: clausulasEleccion,
      archivo_url:        archivoURL,
      archivo_nombre:     archivoNombre,
      docx_base64:        docxBase64,
      docx_preview_url:   docxPreviewURL,
      solo_storage:       !docxBase64,
      created_at:         new Date().toISOString()
    };

    const { error: insertError } = await supabaseClient.from("minutas").insert(datosMinuta);
    if (insertError) throw insertError;

    toast("Minuta guardada correctamente.", "ok");
    document.getElementById("form-nueva-minuta").reset();
    document.getElementById("file-info").style.display = "none";
    document.getElementById("ai-question-box").style.display = "none";
    document.getElementById("eleccion-question-box").style.display = "none";
    adminDocxBuffer = null; adminPlaceholdersIA = []; adminClausulasEleccion = [];
    renderAdminData();
  } catch(err) {
    let msg = err.message || "Error desconocido";
    if (msg.includes("quota") || msg.includes("size") || msg.includes("limit") || msg.includes("longer") || msg.includes("bytes")) {
      msg = "El documento supera el límite permitido. Asegúrate de que Supabase Storage esté habilitado y el bucket sea público.";
    } else if (msg.includes("permission") || msg.includes("Permission") || msg.includes("policy")) {
      msg = "Sin permisos. Verifica las políticas RLS de Supabase.";
    } else if (msg.includes("network") || msg.includes("Network")) {
      msg = "Error de red. Verifica tu conexión a internet.";
    }
    toast("Error: " + msg, "error");
  } finally { btn.disabled = false; btn.textContent = "Guardar Minuta"; }
});

/* ── ADMIN DATA ── */
async function renderAdminData() {
  const minutasList = document.getElementById("admin-minutas-list");
  const ventasList  = document.getElementById("admin-ventas-list");
  minutasList.innerHTML = "<p class='text-muted'>Cargando...</p>";
  ventasList.innerHTML  = "<p class='text-muted'>Cargando...</p>";
  try {
    const { data: mData, error: mErr } = await supabaseClient
      .from("minutas")
      .select("*")
      .order("created_at", { ascending: false });
    if (mErr) throw mErr;
    adminMinutasAll = (mData || []).map(row => _mapMinuta(row));
    adminMinutasPage = 1; renderAdminMinutas();

    const { data: vData, error: vErr } = await supabaseClient
      .from("ventas")
      .select("*")
      .order("created_at", { ascending: false });
    if (vErr) throw vErr;
    adminVentasAll = vData || [];
    adminVentasPage = 1; renderAdminVentas();
  } catch(err) { minutasList.innerHTML = `<p class='text-muted'>Error: ${err.message}</p>`; }
}

function renderAdminMinutas() {
  const minutasList = document.getElementById("admin-minutas-list");
  const pagCont     = document.getElementById("admin-minutas-pagination");
  if (!adminMinutasAll.length) { minutasList.innerHTML = "<p class='text-muted'>No hay minutas.</p>"; pagCont.innerHTML = ""; return; }
  const totalPages = Math.ceil(adminMinutasAll.length / ADMIN_ITEMS_PER_PAGE);
  const start      = (adminMinutasPage - 1) * ADMIN_ITEMS_PER_PAGE;
  const slice      = adminMinutasAll.slice(start, start + ADMIN_ITEMS_PER_PAGE);
  minutasList.innerHTML = slice.map(m => {
    const iaBadge = m.tieneIA ? ` <span style="background:rgba(37,99,168,0.12);color:var(--primary-light);font-size:0.72rem;font-weight:700;padding:2px 7px;border-radius:10px;border:1px solid rgba(37,99,168,0.2);">Redacción IA · ${(m.placeholdersIA||[]).length} espacios</span>` : "";
    return `<div class="admin-item">
      <div>
        <strong>${esc(m.nombre)}</strong><span class="badge-cat">${esc(m.categoria||"")}</span>${iaBadge}
        <br><small>$${Number(m.precio||0).toLocaleString("es-CO")} COP · ${(m.campos||[]).length} campos · ${(m.docxBase64 || m.archivoURL) ? "✅ Plantilla lista" : "❌ Sin plantilla"} · ${(m.docxPreviewURL) ? "✅ Preview" : "⚠️ Sin preview (verán la plantilla)"}</small>
      </div>
      <div class="admin-item-actions">
        <button class="btn btn-sm btn-danger" onclick="eliminarMinuta('${m.id}')">Eliminar</button>
      </div>
    </div>`;
  }).join("");
  renderPagination(pagCont, adminMinutasPage, totalPages, p => { adminMinutasPage = p; renderAdminMinutas(); });
}

function renderAdminVentas() {
  const ventasList = document.getElementById("admin-ventas-list");
  const pagCont    = document.getElementById("admin-ventas-pagination");
  if (!adminVentasAll.length) { ventasList.innerHTML = "<p class='text-muted'>Aún no hay ventas.</p>"; pagCont.innerHTML = ""; return; }
  const totalPages = Math.ceil(adminVentasAll.length / ADMIN_ITEMS_PER_PAGE);
  const start      = (adminVentasPage - 1) * ADMIN_ITEMS_PER_PAGE;
  const slice      = adminVentasAll.slice(start, start + ADMIN_ITEMS_PER_PAGE);
  ventasList.innerHTML = slice.map(v => {
    const estadoClass = v.estado === "pagado" ? "estado-pagado" : "";
    const estadoStyle = v.estado !== "pagado" ? 'style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.78rem;font-weight:600;margin-left:6px;background:#fff3cd;color:#856404;"' : "";
    const estadoLabel = v.estado === "pagado" ? "Pagado" : v.estado === "pendiente" ? "Pendiente" : v.estado || "—";
    const txId = v.transaction_id ? ` · TX: ${v.transaction_id}` : "";
    const fecha = v.created_at
      ? new Date(v.created_at).toLocaleString("es-CO", { year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit" })
      : "—";
    return `<div class="admin-item">
      <div>
        <strong>${esc(v.minuta_nombre)}</strong>
        <span class="${estadoClass}" ${estadoStyle}>${estadoLabel}</span>
        <br><small>${esc(v.user_email)} · $${Number(v.precio||0).toLocaleString("es-CO")} COP · ${v.metodo_pago||"-"}${txId} · ${fecha}</small>
      </div>
    </div>`;
  }).join("");
  renderPagination(pagCont, adminVentasPage, totalPages, p => { adminVentasPage = p; renderAdminVentas(); });
}

async function eliminarMinuta(id) {
  if (!confirm("¿Eliminar esta minuta?")) return;
  try {
    const { error } = await supabaseClient.from("minutas").delete().eq("id", id);
    if (error) throw error;
    toast("Minuta eliminada.");
    renderAdminData();
  } catch(e) { toast("Error: " + e.message, "error"); }
}

async function reiniciarVentas() {
  if (!isAdmin) return;
  if (!confirm("¿Estás seguro de que deseas eliminar TODOS los registros de ventas?\n\nEsta acción es permanente e irreversible. Las minutas, categorías y configuración NO se borrarán.")) return;
  if (!confirm("Confirmación final: ¿eliminar todos los registros de compras-ventas?")) return;
  const btn = document.querySelector('[onclick="reiniciarVentas()"]');
  if (btn) { btn.disabled = true; btn.textContent = "Eliminando..."; }
  try {
    const { data: ventas, error: fetchErr } = await supabaseClient.from("ventas").select("id");
    if (fetchErr) throw fetchErr;
    if (!ventas || !ventas.length) { toast("No hay registros de ventas para eliminar.", ""); return; }
    const ids = ventas.map(v => v.id);
    const { error: delError } = await supabaseClient.from("ventas").delete().in("id", ids);
    if (delError) throw delError;
    adminVentasAll = [];
    adminVentasPage = 1;
    renderAdminVentas();
    toast(`Se eliminaron ${ids.length} registro(s) de ventas correctamente.`, "ok");
  } catch(e) {
    toast("Error al eliminar ventas: " + e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Reiniciar todo"; }
  }
}

/* ── CARGAR CONFIG WOMPI EN ADMIN ── */
async function cargarWompiConfigAdmin() {
  try {
    const { data, error } = await supabaseClient
      .from("config")
      .select("*")
      .eq("id", "wompi")
      .single();
    if (!error && data) {
      wompiConfig = {
        publicKey:       data.public_key,
        integritySecret: data.integrity_secret,
        mode:            data.mode
      };
      document.getElementById("wompi-public-key").value      = data.public_key || "";
      document.getElementById("wompi-integrity-secret").value = data.integrity_secret || "";
      document.getElementById("wompi-mode").value            = data.mode || "test";
      const statusEl = document.getElementById("wompi-config-status");
      if (data.public_key) statusEl.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">Wompi configurado en modo ${data.mode === "prod" ? "Producción" : "Pruebas"}.</p>`;
    }
  } catch(_) {}
}

/* ── CARGAR CONFIG OPENAI EN ADMIN ── */
async function cargarGeminiConfigAdmin() {
  try {
    const { data, error } = await supabaseClient
      .from("config")
      .select("*")
      .eq("id", "openai")
      .single();
    if (!error && data) {
      geminiConfig = { apiKey: data.api_key };
      const statusEl = document.getElementById("gemini-config-status");
      if (data.api_key) {
        const keyMasked = data.api_key.substring(0, 7) + "..." + data.api_key.slice(-4);
        statusEl.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">✅ Groq configurado. Clave: ${keyMasked}</p>`;
      }
    }
  } catch(_) {}
}

/* ═══════════════════════════════════════════════════════
   MONITOREO — SUSCRIPCIONES
═══════════════════════════════════════════════════════ */

/* Carga precios desde config (id = "monitoreo_planes") */
async function cargarMonitoreoConfig() {
  try {
    const { data } = await supabaseClient.from("config").select("api_key").eq("id", "monitoreo_planes").single();
    if (data?.api_key) {
      try { monitoreoConfig = JSON.parse(data.api_key); } catch(_) {}
    }
  } catch(_) {}
}

/* Verifica si el usuario ya tiene suscripción (consulta tabla suscripciones_monitoreo) */
const DIAS_SUSCRIPCION_MON = 30;

async function cargarSuscripcionMonitoreo() {
  if (!currentUser) { suscripcionMonitoreo = null; return; }
  try {
    const { data, error } = await supabaseClient
      .from("suscripciones_monitoreo")
      .select("id, plan, created_at, vence_at")
      .eq("user_id", currentUser.id)
      .order("vence_at", { ascending: false })
      .limit(10);
    console.log("[MON] cargarSuscripcion →", { data, error });
    if (error || !data || data.length === 0) { suscripcionMonitoreo = null; return; }
    const now = new Date();
    const vigentes = data.filter(s => new Date(s.vence_at) > now);
    if (vigentes.length === 0) { suscripcionMonitoreo = null; return; }
    const best = vigentes.find(s => s.plan === "premium") || vigentes[0];
    suscripcionMonitoreo = {
      id:         best.id,
      plan:       best.plan,
      created_at: best.created_at,
      vence_at:   best.vence_at
    };
  } catch(e) { console.error("[MON] cargarSuscripcion ERROR:", e); suscripcionMonitoreo = null; }
}

/* Activa el dashboard directamente (sin re-consultar Supabase) — úsalo tras un pago exitoso */
function activarDashboardMonitoreo() {
  window.location.href = "monitoreo.html";
}

/* Decide qué mostrar al entrar a Monitoreo */
async function iniciarMonitoreoSection() {
  const content  = document.getElementById("monitoreo-content");
  const headerEl = document.getElementById("mon-section-header");
  if (content) content.innerHTML = `<div class="mon-pay-loading"><div class="loading-spinner"></div></div>`;

  await Promise.all([cargarMonitoreoConfig(), cargarSuscripcionMonitoreo()]);

  if (suscripcionMonitoreo) {
    window.location.href = "monitoreo.html";
  } else {
    if (headerEl) headerEl.style.display = "block";
    renderMonitoreoPaywall();
  }
}

/* Renderiza la pantalla de planes */
function renderMonitoreoPaywall() {
  const c = document.getElementById("monitoreo-content");
  if (!c) return;
  const pb = monitoreoConfig.precio_basico;
  const pp = monitoreoConfig.precio_premium;
  const tieneP = p => p != null && p !== "";
  const fmt = p => !tieneP(p) ? "Próximamente" : Number(p) === 0 ? "GRATIS" : `$${Number(p).toLocaleString("es-CO")} COP`;
  const noLogin = !currentUser;
  const IC_CHECK = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

  c.innerHTML = `
    <div class="mon-paywall">
      ${noLogin ? `
        <div class="mon-pay-login-notice">
          <p>Para acceder al Monitoreo Jurídico debes iniciar sesión o crear una cuenta.</p>
          <button class="btn btn-accent" onclick="showSection('usuarios')">Iniciar sesión</button>
        </div>` : ""}
      <p class="mon-pay-subtitle">Elige el plan que mejor se adapte a tus necesidades</p>

      <div class="mon-pay-plans">

        <!-- Básico -->
        <div class="mon-pay-card">
          <div class="mon-pay-plan-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
          </div>
          <div class="mon-pay-plan-name">Básico</div>
          <div class="mon-pay-price">${fmt(pb)}</div>
          <div class="mon-pay-price-note">suscripción mensual · renueva cada 30 días</div>
          <ul class="mon-pay-features">
            <li>${IC_CHECK}Hasta 20 procesos en seguimiento</li>
            <li>${IC_CHECK}Actualización automática cada 6h</li>
            <li>${IC_CHECK}Alertas de nuevas actuaciones</li>
            <li>${IC_CHECK}Dashboard con estadísticas</li>
          </ul>
          <button class="btn mon-pay-btn${noLogin || !tieneP(pb) ? " mon-pay-btn-disabled" : ""}"
            ${noLogin ? `onclick="showSection('usuarios')"` : tieneP(pb) ? `onclick="iniciarPagoMonitoreo('basico')"` : ""}>
            ${noLogin ? "Inicia sesión primero" : tieneP(pb) ? (Number(pb) === 0 ? "Obtener gratis — Plan Básico" : "Suscribirse — Plan Básico") : "No disponible aún"}
          </button>
        </div>

        <!-- Premium -->
        <div class="mon-pay-card mon-pay-card-premium">
          <div class="mon-pay-badge">✦ Recomendado</div>
          <div class="mon-pay-plan-icon mon-pay-icon-premium">
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </div>
          <div class="mon-pay-plan-name">Premium</div>
          <div class="mon-pay-price">${fmt(pp)}</div>
          <div class="mon-pay-price-note">suscripción mensual · renueva cada 30 días</div>
          <ul class="mon-pay-features">
            <li>${IC_CHECK}Procesos ilimitados</li>
            <li>${IC_CHECK}Actualización automática cada 6h</li>
            <li>${IC_CHECK}Alertas de nuevas actuaciones</li>
            <li>${IC_CHECK}Dashboard con estadísticas</li>
            <li>${IC_CHECK}Acceso anticipado a nuevas funciones</li>
          </ul>
          <button class="btn mon-pay-btn mon-pay-btn-premium${noLogin || !tieneP(pp) ? " mon-pay-btn-disabled" : ""}"
            ${noLogin ? `onclick="showSection('usuarios')"` : tieneP(pp) ? `onclick="iniciarPagoMonitoreo('premium')"` : ""}>
            ${noLogin ? "Inicia sesión primero" : tieneP(pp) ? (Number(pp) === 0 ? "Obtener gratis — Plan Premium" : "Suscribirse — Plan Premium") : "No disponible aún"}
          </button>
        </div>

      </div>
      ${!tieneP(pb) || !tieneP(pp) ? `
      <button onclick="verificarPlanesMonitoreo()" style="background:none;border:none;color:var(--text-soft);font-family:var(--font-ui);font-size:0.78rem;cursor:pointer;text-decoration:underline;padding:0;">
        Verificar disponibilidad de planes
      </button>` : ""}
      <p class="mon-pay-footer">
        Pago único procesado por Wompi (Bancolombia). Tu información está protegida con encriptación SSL.
      </p>
    </div>`;
}

/* Refresca precios y re-renderiza el paywall (botón "Verificar disponibilidad") */
async function verificarPlanesMonitoreo() {
  const c = document.getElementById("monitoreo-content");
  if (c) c.innerHTML = `<div class="mon-pay-loading"><div class="loading-spinner"></div></div>`;
  await cargarMonitoreoConfig();
  renderMonitoreoPaywall();
}

/* Inicia pago Wompi para suscripción de monitoreo */
async function iniciarPagoMonitoreo(plan) {
  if (!currentUser) { showSection("usuarios"); return; }
  const precio = plan === "basico" ? monitoreoConfig.precio_basico : monitoreoConfig.precio_premium;
  if (precio == null || precio === "") { toast("El precio de este plan no está configurado aún.", "error"); return; }

  if (Number(precio) === 0) {
    const vence0 = new Date(Date.now() + DIAS_SUSCRIPCION_MON * 86400000);
    const regResult0 = await registrarSuscripcionMonitoreo(plan, "GRATIS-" + Date.now(), "gratis");
    if (regResult0 !== true) {
      toast("Error BD: " + String(regResult0), "error");
      return;
    }
    const ok0 = true;
    suscripcionMonitoreo = { plan, created_at: new Date().toISOString(), vence_at: vence0.toISOString() };
    toast(`¡Plan ${plan === "basico" ? "Básico" : "Premium"} activado gratuitamente! 🎉`, "ok");
    activarDashboardMonitoreo();
    return;
  }

  if (modoPrueba) {
    const venceP = new Date(Date.now() + DIAS_SUSCRIPCION_MON * 86400000);
    const regResultP = await registrarSuscripcionMonitoreo(plan, "PRUEBA-" + Date.now(), "prueba");
    if (regResultP !== true) {
      toast("Error BD: " + String(regResultP), "error");
      return;
    }
    suscripcionMonitoreo = { plan, created_at: new Date().toISOString(), vence_at: venceP.toISOString() };
    toast(`Plan ${plan === "basico" ? "Básico" : "Premium"} activado (modo prueba).`, "ok");
    activarDashboardMonitoreo();
    return;
  }

  if (!wompiConfig.publicKey) { toast("La pasarela de pago no está configurada. Contacta al administrador.", "error"); return; }

  const amountInCents = Math.round(Number(precio) * 100);
  const reference     = `MON-${plan.toUpperCase()}-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  const currency      = "COP";
  const checkoutConfig = {
    currency, amountInCents, reference,
    publicKey: wompiConfig.publicKey,
    customerData: { email: currentUser.email }
  };
  if (wompiConfig.integritySecret) {
    try {
      const sig = await calcularIntegritySignature(reference, amountInCents, currency, wompiConfig.integritySecret);
      checkoutConfig.signature = { integrity: sig };
    } catch(_) {}
  }
  const checkout = new WidgetCheckout(checkoutConfig);
  checkout.open(async result => {
    const { transaction } = result;
    if (!transaction) return;
    if (transaction.status === "APPROVED") {
      const venceW = new Date(Date.now() + DIAS_SUSCRIPCION_MON * 86400000);
      const okW = await registrarSuscripcionMonitoreo(plan, reference, transaction.id);
      if (!okW) {
        toast("Pago aprobado, pero hubo un error al guardar la suscripción. Contacta al administrador.", "error");
        return;
      }
      suscripcionMonitoreo = { plan, created_at: new Date().toISOString(), vence_at: venceW.toISOString() };
      toast(`¡Bienvenido al Plan ${plan === "basico" ? "Básico" : "Premium"}! 🎉`, "ok");
      activarDashboardMonitoreo();
    } else if (["PENDING","IN_VALIDATION"].includes(transaction.status)) {
      toast("Pago en proceso. Cuando sea aprobado, recarga la página.", "");
    } else {
      toast("El pago fue rechazado o cancelado. Intenta de nuevo.", "error");
    }
  });
}

/* Registra la suscripción en la tabla suscripciones_monitoreo.
   Devuelve true si se guardó, false si falló (el error queda en consola). */
async function registrarSuscripcionMonitoreo(plan, reference, transactionId) {
  if (!currentUser) { console.error("[MON] registrar: no hay currentUser"); return false; }
  const vence_at = new Date(Date.now() + DIAS_SUSCRIPCION_MON * 86400000).toISOString();
  console.log("[MON] registrar → INSERT", { plan, user_id: currentUser.id, vence_at });
  try {
    const { data, error } = await supabaseClient.from("suscripciones_monitoreo").insert({
      user_id:        currentUser.id,
      user_email:     currentUser.email,
      plan,
      vence_at,
      metodo_pago:    transactionId === "prueba" ? "prueba" : transactionId === "gratis" ? "gratis" : "wompi",
      reference,
      transaction_id: transactionId,
    }).select();
    if (error) throw error;
    console.log("[MON] registrar → OK, fila guardada:", data);
    return true;
  } catch(e) {
    console.error("[MON] registrar → ERROR:", e.message, e);
    return e.message || "error desconocido";
  }
}

/* Admin: carga precios actuales */
async function cargarPlanesMonitoreoAdmin() {
  try {
    const { data } = await supabaseClient.from("config").select("api_key").eq("id", "monitoreo_planes").single();
    if (data?.api_key) {
      try {
        const cfg = JSON.parse(data.api_key);
        const pb = document.getElementById("mon-precio-basico");
        const pp = document.getElementById("mon-precio-premium");
        if (pb && cfg.precio_basico) pb.value = cfg.precio_basico;
        if (pp && cfg.precio_premium) pp.value = cfg.precio_premium;
      } catch(_) {}
    }
  } catch(_) {}
  cargarSuscriptoresMonitoreoAdmin();
}

/* Admin: guarda precios */
async function guardarPlanesMonitoreo(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-guardar-mon-planes");
  btn.disabled = true; btn.textContent = "Guardando...";
  const pb = parseFloat(document.getElementById("mon-precio-basico").value) || 0;
  const pp = parseFloat(document.getElementById("mon-precio-premium").value) || 0;
  try {
    const { error } = await supabaseClient.from("config").upsert({
      id:         "monitoreo_planes",
      api_key:    JSON.stringify({ precio_basico: pb, precio_premium: pp }),
      updated_at: new Date().toISOString()
    }, { onConflict: "id" });
    if (error) throw error;
    monitoreoConfig = { precio_basico: pb, precio_premium: pp };
    const st = document.getElementById("mon-planes-status");
    if (st) st.innerHTML = `<p style="color:var(--success);font-size:0.85rem;font-weight:600;">✅ Precios guardados: Básico $${pb.toLocaleString("es-CO")} · Premium $${pp.toLocaleString("es-CO")}</p>`;
    toast("Precios de Monitoreo guardados.", "ok");
    if (!suscripcionMonitoreo && document.getElementById("monitoreo-content")) renderMonitoreoPaywall();
  } catch(e) { toast("Error al guardar: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Guardar precios"; }
}

/* Admin: renderiza el buscador de suscripciones por email */
function cargarSuscriptoresMonitoreoAdmin() {
  const el = document.getElementById("mon-suscriptores-lista");
  if (!el) return;
  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <input type="email" id="admin-susc-search-input" class="form-control"
        placeholder="Buscar por correo electrónico..."
        style="flex:1;"
        onkeydown="if(event.key==='Enter')buscarSuscripcionAdmin()" />
      <button class="btn btn-primary" onclick="buscarSuscripcionAdmin()">Buscar</button>
    </div>
    <div id="admin-susc-resultado">
      <p style="color:var(--text-muted);font-size:0.88rem;">Ingresa un correo y presiona Buscar.</p>
    </div>`;
}

/* Admin: busca las suscripciones del email ingresado */
async function buscarSuscripcionAdmin() {
  const input   = document.getElementById("admin-susc-search-input");
  const resultEl = document.getElementById("admin-susc-resultado");
  if (!input || !resultEl) return;
  const email = input.value.trim();
  if (!email) {
    resultEl.innerHTML = `<p style="color:var(--text-muted);font-size:0.88rem;">Ingresa un correo para buscar.</p>`;
    return;
  }
  resultEl.innerHTML = `<p style="color:var(--text-soft);font-size:0.88rem;">Buscando...</p>`;
  try {
    const { data, error } = await supabaseClient
      .from("suscripciones_monitoreo")
      .select("id, plan, created_at, vence_at")
      .ilike("user_email", email)
      .order("vence_at", { ascending: false });
    if (error) throw error;
    if (!data || data.length === 0) {
      resultEl.innerHTML = `<p style="color:var(--text-muted);font-size:0.88rem;">No se encontraron suscripciones para <strong>${esc(email)}</strong>.</p>`;
      return;
    }
    const now = new Date();
    resultEl.innerHTML = `
      <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:12px;">
        ${data.length} suscripción${data.length !== 1 ? "es" : ""} para <strong>${esc(email)}</strong>
      </p>
      ${data.map(s => {
        const vence = new Date(s.vence_at);
        const activo = vence > now;
        const diasRest = Math.ceil((vence - now) / 86400000);
        const venceFmt = vence.toLocaleDateString("es-CO", { day:"numeric", month:"long", year:"numeric" });
        const colorBg    = activo ? "rgba(30,126,52,0.06)"  : "rgba(176,58,46,0.05)";
        const colorBorde = activo ? "rgba(30,126,52,0.22)"  : "rgba(176,58,46,0.20)";
        const colorBadge = activo ? "var(--success)"         : "var(--danger)";
        return `
          <div style="background:${colorBg};border:1.5px solid ${colorBorde};border-radius:10px;padding:14px 16px;margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
              <strong style="font-size:0.9rem;">${s.plan === "premium" ? "Plan Premium" : "Plan Básico"}</strong>
              <span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:0.73rem;font-weight:700;background:${colorBadge};color:#fff;">
                ${activo ? `Activo · ${diasRest}d` : "Vencido"}
              </span>
            </div>
            <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:12px;">
              Vence: <strong>${venceFmt}</strong>
            </p>
            <div style="display:flex;gap:8px;">
              <button class="btn btn-primary btn-sm" onclick="ajustarDiasSuscripcionDialog('${s.id}','agregar')">Agregar días</button>
              <button class="btn btn-outline btn-sm" onclick="ajustarDiasSuscripcionDialog('${s.id}','eliminar')">Eliminar días</button>
            </div>
          </div>`;
      }).join("")}`;
  } catch(e) {
    resultEl.innerHTML = `<p style="color:var(--danger);font-size:0.85rem;">Error: ${esc(e.message)}</p>`;
  }
}

/* Admin: pide cantidad de días y llama a ajustar */
async function ajustarDiasSuscripcionDialog(suscripcionId, tipo) {
  const verbo = tipo === "agregar" ? "agregar" : "eliminar";
  const rawDias = window.prompt(`¿Cuántos días deseas ${verbo}?`, "30");
  if (rawDias === null) return;
  const dias = parseInt(rawDias, 10);
  if (isNaN(dias) || dias <= 0) { toast("Ingresa un número de días válido (mayor a 0).", "error"); return; }
  await ajustarDiasSuscripcion(suscripcionId, tipo === "agregar" ? dias : -dias);
  buscarSuscripcionAdmin();
}

/* Admin: ajusta días de vencimiento de una suscripción */
async function ajustarDiasSuscripcion(suscripcionId, dias) {
  if (!isAdmin) return;
  try {
    const { data, error } = await supabaseClient
      .from("suscripciones_monitoreo")
      .select("vence_at")
      .eq("id", suscripcionId)
      .single();
    if (error || !data) { toast("Suscripción no encontrada.", "error"); return; }
    const base  = new Date(data.vence_at);
    const nuevo = new Date(base.getTime() + dias * 86400000);
    const ahora = new Date();
    const final = nuevo < ahora ? ahora : nuevo;
    const { error: upErr } = await supabaseClient
      .from("suscripciones_monitoreo")
      .update({ vence_at: final.toISOString() })
      .eq("id", suscripcionId);
    if (upErr) throw upErr;
    const etiqueta = dias > 0 ? `+${dias} días` : `${dias} días`;
    toast(`Ajuste aplicado (${etiqueta}). Nuevo vencimiento: ${final.toLocaleDateString("es-CO")}.`, "ok");
  } catch(e) { toast("Error al ajustar días: " + e.message, "error"); }
}

/* Perfil: muestra suscripción de monitoreo activa */
async function cargarSuscripcionPerfil() {
  const el = document.getElementById("perfil-suscripcion-monitoreo");
  if (!el || !currentUser) return;
  try {
    const { data } = await supabaseClient
      .from("suscripciones_monitoreo")
      .select("plan, created_at, vence_at")
      .eq("user_id", currentUser.id)
      .order("vence_at", { ascending: false })
      .limit(10);
    const now = new Date();
    const vigentes = (data || []).filter(s => new Date(s.vence_at) > now);
    if (!vigentes.length) {
      el.innerHTML = `
        <hr class="divider" style="margin:18px 0;" />
        <h3 style="margin-bottom:10px;">Monitoreo Jurídico</h3>
        <p style="color:var(--text-muted);font-size:0.88rem;margin-bottom:10px;">No tienes una suscripción activa.</p>
        <button class="btn btn-primary btn-sm" onclick="showSection('monitoreo')">Ver planes</button>`;
      el.style.display = "block";
      return;
    }
    const best = vigentes.find(s => s.plan === "premium") || vigentes[0];
    const vence = new Date(best.vence_at);
    const diasRestantes = Math.ceil((vence - now) / 86400000);
    const venceFmt = vence.toLocaleDateString("es-CO", { day:"numeric", month:"long", year:"numeric" });
    const planLabel = best.plan === "premium" ? "Premium" : "Básico";
    const urgente = diasRestantes <= 5;
    const colorBg    = urgente ? "rgba(176,58,46,0.06)"  : "rgba(30,126,52,0.06)";
    const colorBorde = urgente ? "rgba(176,58,46,0.25)"  : "rgba(30,126,52,0.25)";
    const colorBadge = urgente ? "var(--danger)"          : "var(--success)";
    const colorDias  = urgente ? "var(--danger)"          : "var(--text-muted)";
    el.innerHTML = `
      <hr class="divider" style="margin:18px 0;" />
      <h3 style="margin-bottom:10px;">Monitoreo Jurídico</h3>
      <div style="background:${colorBg};border:1.5px solid ${colorBorde};border-radius:10px;padding:14px 16px;">
        <div style="margin-bottom:8px;">
          <span style="display:inline-block;background:${colorBadge};color:#fff;font-size:0.72rem;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:0.04em;">
            ACTIVO · Plan ${planLabel}
          </span>
        </div>
        <p style="font-size:0.9rem;color:var(--text);margin-bottom:4px;"><strong>Renueva el ${venceFmt}</strong></p>
        <p style="font-size:0.85rem;color:${colorDias};margin-bottom:12px;">
          ${urgente ? "⚠️ " : ""}${diasRestantes} día${diasRestantes !== 1 ? "s" : ""} restante${diasRestantes !== 1 ? "s" : ""}
        </p>
        <button class="btn btn-outline btn-sm" onclick="showSection('monitoreo')">Ir al Monitoreo</button>
      </div>`;
    el.style.display = "block";
  } catch(_) {}
}

/* ═══════════════════════════════════════════════════════
   UTILIDADES
═══════════════════════════════════════════════════════ */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function xmlEsc(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

function textoAWordXml(texto, pPr, rPr) {
  const lineas = String(texto).split(/\r?\n/);
  if (lineas.length <= 1) {
    return xmlEsc(texto);
  }
  return lineas.map(linea => {
    const textEsc = xmlEsc(linea);
    return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${textEsc}</w:t></w:r></w:p>`;
  }).join("");
}

/* ── INICIALIZAR ── */
if (localStorage.getItem("modoPrueba") === "1") { modoPrueba = true; }
loadCategorias();
cargarWompiConfig();
cargarGeminiConfig();
cargarMonitoreoConfig();
cargarGoogleConfig(); /* ① GA4 + reCAPTCHA — carga config de Supabase e inyecta scripts */
showSection("inicio");
precargarHeroStatusPill();

/* ══════════════════════════════════════════════════════════════════════
   VISTA PREVIA EN VIVO
══════════════════════════════════════════════════════════════════════ */
let livePreviewReady     = false;
let livePreviewWired     = false;
let _livePreviewInitId   = 0;

function getActualPanelId() {
  try { return getStepPanelId(currentStep); } catch(_) { return null; }
}

function panelUsaLivePreview(panelId) {
  return panelId === 2 || panelId === "clausulas" || panelId === 3;
}

function aplicarClaseLivePreviewSegunPaso() {
  const body  = document.getElementById("modal-body");
  const modal = document.getElementById("modal-compra");
  if (!body || !modal) return;
  const panelId = getActualPanelId();
  const debe = livePreviewReady && panelUsaLivePreview(panelId);
  body.classList.toggle("with-live-preview", debe);
  modal.classList.toggle("modal--with-preview", debe);
  if (!debe) body.classList.remove("lp-mobile-open");
}

function toggleLivePreviewMobile() {
  const body = document.getElementById("modal-body");
  const btn  = document.getElementById("live-preview-toggle-mobile");
  if (!body) return;
  const abierto = body.classList.toggle("lp-mobile-open");
  if (btn) {
    const txt = btn.querySelector(".lp-toggle-text");
    if (txt) txt.textContent = abierto ? "Ocultar vista previa" : "Ver vista previa";
  }
}

function _lpEscMultiline(str) {
  return esc(String(str || "")).replace(/\r?\n/g, "<br>");
}

function _lpRecolectarPlaceholders() {
  const set = new Set();
  if (currentMinuta) {
    (currentMinuta.campos || []).forEach(n => n && set.add(n));
    (currentMinuta.camposLargo || []).forEach(n => n && set.add(n));
  }
  (placeholdersIA || []).forEach(n => n && set.add(n));
  (minutaClausulas || []).forEach(cl => {
    (cl.camposExtra || []).forEach(n => n && set.add(n));
  });
  return Array.from(set).filter(s => String(s).trim().length > 0);
}

function _lpEnvolverPlaceholdersEnDom(root, nombres) {
  if (!nombres.length) return;
  const lista = nombres.slice().sort((a, b) => b.length - a.length);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (n.parentNode && n.parentNode.classList && n.parentNode.classList.contains("lp-ph")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);
  textNodes.forEach(node => {
    let txt = node.nodeValue;
    const upper = txt.toUpperCase();
    let alguno = false;
    for (const name of lista) {
      if (upper.indexOf(name.toUpperCase()) !== -1) { alguno = true; break; }
    }
    if (!alguno) return;
    const frag = document.createDocumentFragment();
    let remaining = txt;
    while (remaining.length) {
      const upRem = remaining.toUpperCase();
      let bestIdx = -1, bestName = null;
      for (const name of lista) {
        const idx = upRem.indexOf(name.toUpperCase());
        if (idx !== -1 && (bestIdx === -1 || idx < bestIdx || (idx === bestIdx && name.length > bestName.length))) {
          bestIdx = idx; bestName = name;
        }
      }
      if (bestIdx === -1) {
        frag.appendChild(document.createTextNode(remaining));
        break;
      }
      if (bestIdx > 0) frag.appendChild(document.createTextNode(remaining.slice(0, bestIdx)));
      const span = document.createElement("span");
      span.className = "lp-ph";
      span.dataset.ph = bestName;
      span.textContent = bestName;
      frag.appendChild(span);
      remaining = remaining.slice(bestIdx + bestName.length);
    }
    node.parentNode.replaceChild(frag, node);
  });
}

function _lpEnvolverClausulasEnDom(root) {
  if (!minutaClausulas || !minutaClausulas.length) return;
  const hijos = Array.from(root.children);
  const marcadores = hijos.filter(el => /ELECCION\s+USUARIO/i.test(el.textContent || ""));
  const pares = Math.floor(marcadores.length / 2);
  for (let i = 0; i < pares; i++) {
    const startEl = marcadores[i * 2];
    const endEl   = marcadores[i * 2 + 1];
    const cl = minutaClausulas[i];
    if (!cl) continue;
    const nodos = [];
    let cur = startEl;
    while (cur) {
      nodos.push(cur);
      if (cur === endEl) break;
      cur = cur.nextElementSibling;
    }
    if (!nodos.length || nodos[nodos.length - 1] !== endEl) continue;
    const wrap = document.createElement("div");
    wrap.className = "lp-clause";
    wrap.dataset.clIdx = String(i);
    wrap.dataset.clId  = cl.id;
    root.insertBefore(wrap, startEl);
    nodos.forEach(node => {
      if (node === startEl || node === endEl) {
        if (node.classList) node.classList.add("lp-clause-marker");
      }
      wrap.appendChild(node);
    });
  }
}

async function inicializarLivePreview() {
  const myId = ++_livePreviewInitId;
  livePreviewReady = false;
  const cont = document.getElementById("live-preview-content");
  if (!cont) return;
  if (!docxBlob) {
    cont.innerHTML = `<div class="live-preview-empty">No fue posible cargar la previsualización del documento.</div>`;
    aplicarClaseLivePreviewSegunPaso();
    return;
  }
  cont.innerHTML = `<div class="live-preview-empty"><div class="loading-spinner" style="margin:0 auto 12px;"></div>Generando previsualización…</div>`;
  let html = "";
  try {
    const buf = await docxBlob.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    html = result.value || "";
  } catch (e) {
    console.warn("[livePreview] Error convirtiendo docx:", e);
    cont.innerHTML = `<div class="live-preview-empty">No se pudo generar la previsualización en vivo.</div>`;
    aplicarClaseLivePreviewSegunPaso();
    return;
  }
  if (myId !== _livePreviewInitId) return;
  if (!html) {
    cont.innerHTML = `<div class="live-preview-empty">El documento no contiene contenido para mostrar.</div>`;
    aplicarClaseLivePreviewSegunPaso();
    return;
  }
  cont.innerHTML = `<div class="word-page" id="live-preview-doc">${html}</div>`;
  const doc = cont.querySelector("#live-preview-doc");
  if (!doc) return;
  _lpEnvolverClausulasEnDom(doc);
  _lpEnvolverPlaceholdersEnDom(doc, _lpRecolectarPlaceholders());
  livePreviewReady = true;
  wireLivePreviewInputs();
  protegerLivePreviewAntiCopia();
  aplicarClaseLivePreviewSegunPaso();
  actualizarLivePreview();
}

let _lpAntiCopyWired = false;
function protegerLivePreviewAntiCopia() {
  if (_lpAntiCopyWired) return;
  const cont = document.getElementById("live-preview-content");
  if (!cont) return;
  _lpAntiCopyWired = true;
  const stop = e => { e.preventDefault(); e.stopPropagation(); return false; };
  ["copy","cut","paste","contextmenu","selectstart","dragstart","drop"].forEach(ev => {
    cont.addEventListener(ev, stop);
  });
  cont.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && ["c","x","a","s","p","u"].includes((e.key||"").toLowerCase())) {
      stop(e);
    }
  });
  const BLACKOUT_MS = 5000;
  const blackoutOn = () => cont.classList.add("lp-blackout");
  const blackoutOff = () => cont.classList.remove("lp-blackout");
  const blackoutTemporal = (ms = BLACKOUT_MS) => {
    blackoutOn();
    clearTimeout(cont._lpBlackoutTimer);
    cont._lpBlackoutTimer = setTimeout(blackoutOff, ms);
  };
  const previewActivo = () => {
    const modal = document.getElementById("modal-overlay");
    return modal && modal.classList.contains("open");
  };
  document.addEventListener("visibilitychange", () => {
    if (!previewActivo()) return;
    if (document.hidden) blackoutOn();
    else blackoutTemporal(800);
  });
  window.addEventListener("blur", () => {
    if (previewActivo()) blackoutOn();
  });
  window.addEventListener("focus", () => {
    if (previewActivo()) blackoutTemporal(600);
  });
  const isCaptureCombo = e => {
    const k = (e.key || "").toLowerCase();
    const code = e.code || "";
    if (k === "printscreen" || code === "PrintScreen" || /print/i.test(code)) return true;
    if (k === "snapshot") return true;
    const winLikeKey =
      code === "MetaLeft" || code === "MetaRight" ||
      code === "OSLeft"   || code === "OSRight"   ||
      k === "meta" || k === "os";
    if (winLikeKey) return true;
    if ((e.metaKey || (e.getModifierState && e.getModifierState("OS"))) &&
        (e.shiftKey || ["g","s","r","3","4","5","6"].includes(k))) return true;
    return false;
  };
  const onAnyKey = e => {
    if (!previewActivo()) return;
    if (isCaptureCombo(e)) {
      blackoutTemporal(BLACKOUT_MS);
      try { navigator.clipboard && navigator.clipboard.writeText(""); } catch(_) {}
    }
  };
  document.addEventListener("keydown", onAnyKey, true);
  document.addEventListener("keyup", onAnyKey, true);
  document.addEventListener("mouseleave", e => {
    if (!previewActivo()) return;
    if (typeof e.clientY === "number" && e.clientY <= 0) blackoutOn();
  });
  document.addEventListener("mouseenter", () => {
    if (previewActivo()) blackoutTemporal(400);
  });
}

function actualizarLivePreview() {
  if (!livePreviewReady) return;
  const cont = document.getElementById("live-preview-content");
  if (!cont) return;
  const doc = cont.querySelector("#live-preview-doc");
  if (!doc) return;
  doc.querySelectorAll(".lp-clause").forEach(clEl => {
    const id = clEl.dataset.clId;
    const sel = eleccionesClausulas[id];
    clEl.classList.remove("included", "excluded");
    if (sel === false) clEl.classList.add("excluded");
    else if (sel === true) clEl.classList.add("included");
  });
  doc.querySelectorAll(".lp-ph").forEach(span => {
    const name = span.dataset.ph;
    let valor = "";
    if (camposLlenados[name] !== undefined && String(camposLlenados[name]).trim() !== "") {
      valor = camposLlenados[name];
    }
    else if (placeholdersIA && placeholdersIA.indexOf(name) !== -1) {
      if (camposIAMejorados[name] && String(camposIAMejorados[name]).trim() !== "") valor = camposIAMejorados[name];
      else if (camposIALlenados[name] && String(camposIALlenados[name]).trim() !== "") valor = camposIALlenados[name];
    }
    if (!valor) {
      const parentCl = span.closest(".lp-clause");
      if (parentCl) {
        const clId = parentCl.dataset.clId;
        const k = clId + "_" + name;
        if (camposClausulas[k] && String(camposClausulas[k]).trim() !== "") valor = camposClausulas[k];
      }
    }
    if (valor && String(valor).trim() !== "") {
      const nuevoHtml = _lpEscMultiline(valor);
      if (span.innerHTML !== nuevoHtml) {
        span.innerHTML = nuevoHtml;
      }
      if (!span.classList.contains("filled")) span.classList.add("filled");
    } else {
      if (span.textContent !== name) span.textContent = name;
      span.classList.remove("filled");
    }
  });
}

function wireLivePreviewInputs() {
  if (livePreviewWired) return;
  const body = document.getElementById("modal-body");
  if (!body) return;
  livePreviewWired = true;
  function placeholderForTarget(t) {
    if (!t || !t.classList) return null;
    if (t.classList.contains("campo-input"))         return t.dataset.campo || null;
    if (t.classList.contains("campo-ia-input"))      return t.dataset.placeholder || null;
    if (t.classList.contains("ia-chat-input"))       return t.dataset.placeholder || null;
    if (t.classList.contains("clausula-campo-input")) return t.dataset.campo || null;
    return null;
  }
  let _scrollDebounce = null;
  function scrollPreviewToPlaceholder(name) {
    if (!name) return;
    const cont = document.getElementById("live-preview-content");
    if (!cont) return;
    let span = null;
    try {
      span = cont.querySelector(`.lp-ph[data-ph="${CSS.escape(name)}"]`);
    } catch(_) {
      const all = cont.querySelectorAll(".lp-ph");
      for (const el of all) { if (el.dataset.ph === name) { span = el; break; } }
    }
    if (!span) return;
    const contRect = cont.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();
    const offset   = (spanRect.top - contRect.top) - (cont.clientHeight / 3);
    const target   = Math.max(0, cont.scrollTop + offset);
    cont.scrollTo({ top: target, behavior: "smooth" });
    cont.querySelectorAll(".lp-ph.lp-focus").forEach(s => {
      if (s !== span) s.classList.remove("lp-focus");
    });
    span.classList.add("lp-focus");
  }
  function scheduleScroll(name) {
    if (!name || !livePreviewReady) return;
    if (_scrollDebounce) clearTimeout(_scrollDebounce);
    _scrollDebounce = setTimeout(() => scrollPreviewToPlaceholder(name), 60);
  }
  body.addEventListener("input", e => {
    const t = e.target;
    if (!t || !t.classList) return;
    let cambio = false;
    if (t.classList.contains("campo-input")) {
      const k = t.dataset.campo;
      if (k) { camposLlenados[k] = t.value; cambio = true; }
    } else if (t.classList.contains("campo-ia-input")) {
      const k = t.dataset.placeholder;
      if (k) {
        camposIALlenados[k] = t.value;
        if (camposIAMejorados[k]) delete camposIAMejorados[k];
        cambio = true;
      }
    } else if (t.classList.contains("clausula-campo-input")) {
      cambio = true;
    }
    if (cambio) actualizarLivePreview();
    scheduleScroll(placeholderForTarget(t));
  });
  body.addEventListener("focusin", e => {
    scheduleScroll(placeholderForTarget(e.target));
  });
  body.addEventListener("click", e => {
    const t = e.target;
    if (!t || !t.closest) return;
    const navBtn = t.closest("#btn-campos-next, #btn-campos-prev");
    if (navBtn) {
      setTimeout(() => {
        const firstInp = document.querySelector("#campos-dinamicos .campo-input");
        if (firstInp) {
          try { firstInp.focus({ preventScroll: true }); } catch(_) { try { firstInp.focus(); } catch(__) {} }
          scheduleScroll(placeholderForTarget(firstInp));
        }
      }, 80);
    }
  });
}
