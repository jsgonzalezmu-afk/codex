/* ═══════════════════════════════════════════════════════════════
   MONITOREO JURÍDICO — Dashboard de procesos Rama Judicial
   Versión: 2025-07-05-v4  ← verifica este valor en la consola
   ───────────────────────────────────────────────────────────────
   Requiere: supabaseClient, currentUser, toast() — de app.js
   Llama directamente a la API pública de Rama Judicial (CORS: *)
   v2 — integra Publicaciones Procesales (Rama Judicial)
═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // Marcador de versión — abre la consola del navegador (F12) y busca esta línea
  // para confirmar que estás ejecutando el archivo actualizado.
  console.log("%c[Minutas Legales] monitoreo.js v4 (2025-07-05) cargado ✓", "color:#22c55e;font-weight:bold");

  /* ── Constantes ──────────────────────────────────────────────*/
  const POLL_INTERVAL_MS  = 6 * 60 * 60 * 1000;  // polling pesado (consulta RJ) cada 6h
  const REFRESH_DB_MS     = 10 * 60 * 1000;       // polling ligero (sólo Supabase) cada 10 min
  const PAGE_SIZE         = 10;
  const INACTIVO_DIAS     = 90;
  const RJ_API    = "https://consultaprocesos.ramajudicial.gov.co:448/api/v2";
  const RJ_PORTAL = "https://consultaprocesos.ramajudicial.gov.co/Procesos/NumeroRadicacion";
  const PP_PORTAL = "https://publicacionesprocesales.ramajudicial.gov.co/web/publicaciones-procesales";
  /**
   * Resuelve la URL del Edge Function en tiempo de llamada (lazy).
   * Orden: PP_PROXY_URL → SUPABASE_URL + ruta estándar → "".
   * Derivar de SUPABASE_URL garantiza que funciona sin ninguna config extra.
   */
  function getPpApiUrl() {
    try { if (typeof PP_PROXY_URL !== "undefined" && PP_PROXY_URL) return PP_PROXY_URL; } catch (_) {}
    try {
      if (typeof SUPABASE_URL !== "undefined" && SUPABASE_URL)
        return `${SUPABASE_URL}/functions/v1/pp-buscar`;
    } catch (_) {}
    return "";
  }
  const RJ_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "es-CO,es;q=0.9",
    "Origin": "https://consultaprocesos.ramajudicial.gov.co",
    "Referer": "https://consultaprocesos.ramajudicial.gov.co/",
  };

  /* ── Estado ──────────────────────────────────────────────────*/
  let todosLosSeguimientos = [];
  let filtroActivo  = "todos";
  let busqueda      = "";
  let paginaActual  = 1;
  let pollingTimer  = null;
  let monitoreoActivo = false;
  let actuacionesCache  = {};   // id → actuaciones[]
  let publicacionesCache = {};  // id → publicaciones[]
    // Persistir estado abierto/cerrado de paneles de publicaciones entre navegaciones
    const _PUBS_KEY = "monitoreo_pubs_abiertos";
    let pubsAbiertos = new Set(
      (() => { try { return JSON.parse(sessionStorage.getItem(_PUBS_KEY) || "[]"); } catch { return []; } })()
    );
    function _syncPubsStorage() {
      try { sessionStorage.setItem(_PUBS_KEY, JSON.stringify([...pubsAbiertos])); } catch {}
    }
  let actsPagina        = {};   // id → página actual (1-indexed)
  let pubsPagina        = {};   // id → página actual (1-indexed)
  const PAGE_ITEMS      = 10;
  /** IDs de procesos cuya búsqueda PP está en curso → muestra skeleton en la tarjeta */
  let _ppBuscando = new Set();

  /* ── Notificaciones de consulta ──────────────────────────────*/
  let consultaLogs    = [];   // { ts, total, fallos, error }
  let consultaLogsPag = 1;
  const LOGS_PER_PAG  = 10;

  /* ── Accesores seguros a globales de app.js ─────────────────*/
  function getUser()       { try { return typeof currentUser         !== "undefined" ? currentUser         : null; } catch (_) { return null; } }
  function getClient()     { try { return typeof supabaseClient      !== "undefined" ? supabaseClient      : null; } catch (_) { return null; } }
  function getSuscripcion(){ try { return typeof suscripcionMonitoreo !== "undefined" ? suscripcionMonitoreo : null; } catch (_) { return null; } }
  function showToast(msg, type) { try { if (typeof toast === "function") toast(msg, type); } catch (_) {} }

  const LIMITE_BASICO = 20;

  /* ── Clasificación ───────────────────────────────────────────*/
  function clasificar(s) {
    if (s.tiene_cambios) return "novedad";
    if (!s.ultima_actuacion) return "inactivo";
    const dias = (Date.now() - new Date(s.ultima_actuacion)) / 86400000;
    return dias <= INACTIVO_DIAS ? "activo" : "inactivo";
  }

  /* ══════════════════════════════════════════════════════════════
     INICIALIZACIÓN
  ══════════════════════════════════════════════════════════════ */
  async function iniciarMonitoreo() {
    let user = getUser();
    if (!user) {
      const client = getClient();
      if (client) {
        try { const { data } = await client.auth.getSession(); user = data?.session?.user || null; } catch (_) {}
      }
    }
    if (!user) { renderNoAuth(); return; }

    if (!monitoreoActivo) {
      monitoreoActivo = true;
      renderShell();
      await cargarLogs();
      actualizarContadorLogs();
      await cargarTodos();
      iniciarPolling();
    }
  }

  /* ══════════════════════════════════════════════════════════════
     SHELL
  ══════════════════════════════════════════════════════════════ */
  function renderNoAuth() {
    const c = document.getElementById("monitoreo-content");
    if (!c) return;
    monitoreoActivo = false;
    c.innerHTML = `
      <div class="mon-empty">
        <div class="mon-empty-icon">${IC.scales}</div>
        <h3>Accede para usar el Monitoreo Jurídico</h3>
        <p>Necesitas una cuenta para guardar y monitorear tus procesos ante la Rama Judicial de Colombia.</p>
        <div class="mon-empty-actions">
          <button class="btn btn-accent" onclick="showSection('usuarios')">Iniciar sesión</button>
          <button class="btn btn-outline" onclick="iniciarMonitoreo()">Reintentar</button>
        </div>
      </div>`;
  }

  function _inyectarEstilosSkeletonCard() {
    if (document.getElementById("mon-skel-card-styles")) return;
    const st = document.createElement("style");
    st.id = "mon-skel-card-styles";
    st.textContent = `
      .mon-card-loading { pointer-events:none; }
      .mon-card-foot-loading {
        display:flex; align-items:center; justify-content:space-between;
        gap:12px;
      }
      .mon-card-radicado { font-family:var(--font-d,"Cormorant Garamond",Georgia,serif); font-size:1.05rem; }
      .mon-card-details .mon-detail { font-size:.72rem; }
      .mon-metric-label { text-transform:uppercase; letter-spacing:.06em; font-size:.6rem; }
      /* Tarjetas KPI (Total procesos, Novedades RJ, Publicaciones PP, Sin actividad):
         el número debe usar la misma tipografía serif que el radicado, con un color
         distinto por tarjeta para diferenciarlas de un vistazo. */
      .mon-kpi-value { font-family:var(--font-d,"Cormorant Garamond",Georgia,serif); font-weight:700; color:var(--blue,#1a3a5c); }
      .mon-kpi.kpi-accent .mon-kpi-value { color:var(--gold-dk,#a8893a); }
      .mon-kpi.kpi-pub    .mon-kpi-value { color:var(--amber,#d97706); }
      .mon-kpi.kpi-warn   .mon-kpi-value { color:var(--green,#16a34a); }
    `;
    document.head.appendChild(st);
  }

  function renderShell() {
    _inyectarEstilosSkeletonCard();
    const c = document.getElementById("monitoreo-content");
    if (!c) return;
    c.innerHTML = `
      <div class="mon-dashboard">
        <div class="mon-kpi-row" id="mon-kpi-row">${kpiSkeleton()}</div>
        <div class="mon-panel">
          <aside class="mon-sidebar">
            <nav class="mon-nav" id="mon-nav">
              ${navItem("todos",          IC.list,         "Todos")}
              ${navItem("novedad",        IC.bell,         "Con novedades RJ")}
              ${navItem("novedad_pp",     IC.newspaper,    "Con novedades PP")}
              ${navItem("activo",         IC.check,        "Activos")}
              ${navItem("inactivo",       IC.clock,        "Sin actividad")}
              ${navItem("notif_consulta", IC.alertCircle,  "Notificaciones de consulta")}
            </nav>
            <div class="mon-sidebar-divider"></div>
            <button class="mon-sidebar-add" id="btn-toggle-form">
              ${IC.plus} Agregar proceso
            </button>
            <button class="mon-sidebar-logout" id="mon-btn-logout">
              ${IC.logOut} Cerrar sesión
            </button>
          </aside>
          <div class="mon-main">
            <div class="mon-form-collapse" id="mon-form-wrap" style="display:none">
              <form id="form-add-radicado" class="mon-form-inner">
                <div class="mon-form-fields">
                  <div class="mon-add-field">
                    <label for="input-radicado">Número de radicado <span class="mon-req">*</span></label>
                    <input type="text" id="input-radicado"
                      placeholder="23 dígitos, sin espacios"
                      maxlength="27" autocomplete="off" inputmode="numeric" />
                  </div>
                  <div class="mon-add-field">
                    <label for="input-alias">Alias <span class="mon-opt">(opcional)</span></label>
                    <input type="text" id="input-alias"
                      placeholder="Ej: Demanda arrendamiento" maxlength="80" />
                  </div>
                </div>
                <div class="mon-form-actions">
                  <button type="submit" class="btn btn-accent" id="btn-add-radicado">${IC.plus} Agregar</button>
                  <button type="button" class="btn btn-outline" id="btn-cancel-form">Cancelar</button>
                </div>
              </form>
            </div>
            <div class="mon-toolbar">
              <div class="mon-search-wrap">
                ${IC.search}
                <input type="search" id="mon-search" class="mon-search"
                  placeholder="Buscar por radicado o alias…" autocomplete="off" />
              </div>
              <button class="mon-btn-refresh-all" id="btn-refresh-all">
                ${IC.refresh} Actualizar todos
              </button>
            </div>
            <div id="mon-list"><div class="mon-skeleton-list">${skeletonCards(3)}</div></div>
            <div class="mon-pagination" id="mon-pagination"></div>
          </div>
        </div>
      </div>`;
    bindShellEvents();
  }

  function bindShellEvents() {
    document.getElementById("btn-toggle-form").addEventListener("click", toggleForm);
    document.getElementById("btn-cancel-form").addEventListener("click", toggleForm);
    document.getElementById("form-add-radicado").addEventListener("submit", onAgregarRadicado);
    document.getElementById("btn-refresh-all").addEventListener("click", () => actualizarTodos(true));
    document.getElementById("mon-btn-logout")?.addEventListener("click", async () => {
      const client = getClient();
      if (client) await client.auth.signOut();
      window.location.reload();
    });
    const searchEl = document.getElementById("mon-search");
    let searchTimer;
    searchEl.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        busqueda = searchEl.value.trim().toLowerCase();
        paginaActual = 1;
        renderLista();
      }, 250);
    });
    document.getElementById("mon-nav").addEventListener("click", e => {
      const item = e.target.closest(".mon-nav-item");
      if (!item) return;
      filtroActivo = item.dataset.filter;
      paginaActual = 1;
      document.querySelectorAll(".mon-nav-item").forEach(el => el.classList.toggle("active", el === item));
      renderLista();
    });
  }

  function navItem(filter, icon, label) {
    return `<button class="mon-nav-item${filter === "todos" ? " active" : ""}" data-filter="${filter}">
      <span class="mon-nav-icon">${icon}</span>
      <span class="mon-nav-label">${label}</span>
      <span class="mon-nav-count" id="nav-count-${filter}">—</span>
    </button>`;
  }

  function toggleForm() {
    const wrap = document.getElementById("mon-form-wrap");
    const open = wrap.style.display !== "none";
    wrap.style.display = open ? "none" : "block";
    document.getElementById("btn-toggle-form").classList.toggle("active", !open);
    if (!open) document.getElementById("input-radicado")?.focus();
  }

  /* ══════════════════════════════════════════════════════════════
     CARGA DE DATOS — sin actuaciones ni publicaciones (performance)
  ══════════════════════════════════════════════════════════════ */
  async function cargarTodos() {
    const client = getClient();
    const user   = getUser();
    if (!client || !user) return;

    const SEL_BASE = "id, radicado, alias, despacho, sujetos, id_proceso, ultima_actuacion, tiene_cambios, ultimo_chequeo, created_at, tiene_publicacion_nueva, pub_count";
    let rq = await client
      .from("seguimientos")
      .select(SEL_BASE + ", ultima_publicacion")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    // Si la columna ultima_publicacion aún no existe en la BD, reintentamos sin ella
    if (rq.error && (rq.error.code === "42703" || (rq.error.message || "").includes("ultima_publicacion"))) {
      rq = await client
        .from("seguimientos")
        .select(SEL_BASE)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
    }

    const { data, error } = rq;
    if (error) { console.error(error); return; }

    todosLosSeguimientos = data || [];
    actuacionesCache  = {};
    publicacionesCache = {};
    renderKPIs();
    renderNavCounts();
    renderLista();
  }

  /* ══════════════════════════════════════════════════════════════
     KPI CARDS
  ══════════════════════════════════════════════════════════════ */
  function renderKPIs() {
    const total      = todosLosSeguimientos.length;
    const novedad    = todosLosSeguimientos.filter(s => s.tiene_cambios).length;
    const conPub     = todosLosSeguimientos.filter(s => s.tiene_publicacion_nueva).length;
    const activos    = todosLosSeguimientos.filter(s => clasificar(s) === "activo").length;
    const inactivos  = todosLosSeguimientos.filter(s => clasificar(s) === "inactivo").length;

    const el = document.getElementById("mon-kpi-row");
    if (!el) return;
    el.innerHTML = `
      ${kpiCard("Total procesos",           total,    IC.folder,    "",          () => setFiltro("todos"))}
      ${kpiCard("Con novedades (RJ)",        novedad,  IC.bell,      "kpi-accent",() => setFiltro("novedad"))}
      ${kpiCard("Publicaciones nuevas",      conPub,   IC.newspaper, "kpi-pub",  () => {})}
      ${kpiCard("Sin actividad +90 días",    inactivos,IC.clockOff,  "kpi-warn", () => setFiltro("inactivo"))}`;

    el.querySelectorAll(".mon-kpi").forEach((card, i) => {
      card.addEventListener("click", [
        () => setFiltro("todos"),
        () => setFiltro("novedad"),
        () => {},
        () => setFiltro("inactivo"),
      ][i]);
    });
  }

  function kpiCard(label, value, icon, cls, _onClick) {
    return `<div class="mon-kpi ${cls}" role="button" tabindex="0">
      <div class="mon-kpi-icon">${icon}</div>
      <div class="mon-kpi-body">
        <div class="mon-kpi-value">${value}</div>
        <div class="mon-kpi-label">${label}</div>
      </div>
    </div>`;
  }

  function kpiSkeleton() {
    return `<div class="mon-kpi mon-skel"></div>`.repeat(4);
  }

  function setFiltro(f) {
    filtroActivo = f;
    paginaActual = 1;
    document.querySelectorAll(".mon-nav-item").forEach(el =>
      el.classList.toggle("active", el.dataset.filter === f));
    renderLista();
  }

  /* ══════════════════════════════════════════════════════════════
     CONTADORES SIDEBAR
  ══════════════════════════════════════════════════════════════ */
  function renderNavCounts() {
    const counts = { todos: 0, novedad: 0, novedad_pp: 0, activo: 0, inactivo: 0 };
    todosLosSeguimientos.forEach(s => {
      counts.todos++;
      counts[clasificar(s)]++;
      if (s.tiene_publicacion_nueva) counts.novedad_pp++;
    });
    Object.keys(counts).forEach(k => {
      const el = document.getElementById(`nav-count-${k}`);
      if (el) el.textContent = counts[k];
    });
    actualizarContadorLogs();
  }

  /* ══════════════════════════════════════════════════════════════
     FILTRAR + PAGINAR + RENDERIZAR LISTA
  ══════════════════════════════════════════════════════════════ */
  function datosFiltrados() {
    return todosLosSeguimientos.filter(s => {
      if (filtroActivo === "novedad_pp") {
        if (!s.tiene_publicacion_nueva) return false;
      } else if (filtroActivo !== "todos" && clasificar(s) !== filtroActivo) return false;
      if (busqueda) {
        const hay = (s.radicado + (s.alias || "") + (s.despacho || "")).toLowerCase();
        if (!hay.includes(busqueda)) return false;
      }
      return true;
    });
  }

  function renderLista() {
    const el = document.getElementById("mon-list");
    if (!el) return;

    if (filtroActivo === "notif_consulta") {
      renderLogs();
      return;
    }

    const filtrados = datosFiltrados();
    const totalPags = Math.max(1, Math.ceil(filtrados.length / PAGE_SIZE));
    if (paginaActual > totalPags) paginaActual = totalPags;
    const desde = (paginaActual - 1) * PAGE_SIZE;
    const pagina = filtrados.slice(desde, desde + PAGE_SIZE);

    if (filtrados.length === 0) {
      el.innerHTML = `<div class="mon-empty mon-empty-inline">
        ${todosLosSeguimientos.length === 0
          ? `${IC.scales}<p>Aún no tienes procesos. Usa <strong>Agregar proceso</strong> para comenzar.</p>`
          : `${IC.search}<p>Ningún proceso coincide con tu búsqueda o filtro.</p>`}
      </div>`;
      renderPaginacion(0, 0);
      return;
    }

    el.innerHTML = pagina.map(s => renderTarjeta(s)).join("");
    bindTarjetaEvents(pagina);
    renderPaginacion(filtrados.length, totalPags);
    renderNavCounts();
  }

  /* ══════════════════════════════════════════════════════════════
     TARJETA
  ══════════════════════════════════════════════════════════════ */
  function renderTarjetaSkeleton(id) {
    return `<div class="mon-card mon-card-activo mon-card-loading" id="moncard-${id}">
      <div class="mon-card-body">
        <div class="mon-card-left">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <div class="mon-skel" style="height:14px;width:54%;border-radius:4px"></div>
            <div class="mon-skel" style="height:20px;width:58px;border-radius:99px"></div>
          </div>
          <div class="mon-skel mon-skel-line" style="width:80%;margin-bottom:6px"></div>
          <div class="mon-skel mon-skel-line" style="width:64%;margin-bottom:6px"></div>
          <div class="mon-skel mon-skel-line" style="width:72%"></div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <div class="mon-skel" style="height:30px;width:70px;border-radius:6px"></div>
            <div class="mon-skel" style="height:30px;width:70px;border-radius:6px"></div>
            <div class="mon-skel" style="height:30px;width:70px;border-radius:6px"></div>
          </div>
        </div>
        <div class="mon-card-right">
          <div class="mon-card-metrics">
            <div class="mon-metric">
              <div class="mon-skel" style="height:16px;width:60px;margin-bottom:4px;border-radius:3px"></div>
              <div class="mon-skel" style="height:10px;width:80px;border-radius:3px"></div>
            </div>
            <div class="mon-metric">
              <div class="mon-skel" style="height:16px;width:32px;margin-bottom:4px;border-radius:3px"></div>
              <div class="mon-skel" style="height:10px;width:80px;border-radius:3px"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="mon-card-foot mon-card-foot-loading">
        <div class="mon-skel" style="height:11px;width:45%;border-radius:3px"></div>
        <div style="display:flex;align-items:center;gap:6px;font-size:.72rem;color:var(--amber,#d97706);font-weight:500">
          <div class="spinner" style="width:12px;height:12px;border-width:1.5px;border-color:#d97706;border-top-color:transparent;flex-shrink:0"></div>
          Buscando publicaciones procesales…
        </div>
      </div>
    </div>`;
  }

  function renderTarjeta(s) {
    if (_ppBuscando.has(s.id)) return renderTarjetaSkeleton(s.id);
    const clase = clasificar(s);
    const fecha = s.ultimo_chequeo
      ? new Date(s.ultimo_chequeo).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })
      : "Nunca";
    const ultimaAct = s.ultima_actuacion
      ? new Date(s.ultima_actuacion).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" })
      : null;
    const diasDesde = s.ultima_actuacion
      ? Math.max(0, Math.floor((Date.now() - new Date(s.ultima_actuacion)) / 86400000))
      : null;

    const diasDesdePP = s.ultima_publicacion
      ? Math.max(0, Math.floor((Date.now() - new Date(s.ultima_publicacion)) / 86400000))
      : null;

    const estadoLabel = { novedad: "Con novedad", activo: "Activo", inactivo: "Sin actividad" }[clase];
    const estadoCls   = { novedad: "mon-estado-novedad", activo: "mon-estado-activo", inactivo: "mon-estado-inactivo" }[clase];
    const pubCount    = s.pub_count || 0;

    return `
    <div class="mon-card mon-card-${clase}" id="moncard-${s.id}">
      <div class="mon-card-body">
        <div class="mon-card-left">
          <div class="mon-card-top-row">
            <span class="mon-estado ${estadoCls}">${estadoLabel}</span>
            ${s.tiene_cambios         ? `<span class="mon-badge-new">Nueva actuación</span>` : ""}
            ${s.tiene_publicacion_nueva ? `<span class="mon-badge-pub">${IC.newspaper} Publicación nueva</span>` : ""}
          </div>
          <div class="mon-card-radicado">${escHtml(s.radicado)}</div>
          ${s.alias ? `<div class="mon-card-alias">${escHtml(s.alias)}</div>` : ""}
          <div class="mon-card-details">
            ${s.despacho ? `<span class="mon-detail">${IC.building} ${escHtml(s.despacho.trim())}</span>` : ""}
            ${s.sujetos  ? `<span class="mon-detail">${IC.users} ${escHtml(s.sujetos.replace(/\r?\n\t+/g, " · ").trim())}</span>` : ""}
          </div>
        </div>

        <div class="mon-card-right">
          <div class="mon-card-metrics">
            <div class="mon-metric">
              <span class="mon-metric-value${!ultimaAct ? " mon-metric-empty" : ""}">${ultimaAct || "—"}</span>
              <span class="mon-metric-label">Último movimiento</span>
            </div>
            <div class="mon-metric">
              <span class="mon-metric-value${diasDesde === null ? " mon-metric-empty" : (diasDesde > INACTIVO_DIAS ? " mon-metric-warn" : "")}">${diasDesde !== null ? diasDesde : "—"}</span>
              <span class="mon-metric-label">días sin act. RJ <i class="mon-info-icon" data-tip="Días transcurridos desde la última actuación registrada en el portal Consulta Procesos de la Rama Judicial.">i</i></span>
            </div>
            ${diasDesdePP !== null ? `
            <div class="mon-metric">
              <span class="mon-metric-value ${diasDesdePP > INACTIVO_DIAS ? "mon-metric-warn" : ""}">${diasDesdePP}</span>
              <span class="mon-metric-label">días sin pub. PP</span>
            </div>` : ""}
          </div>
          <div class="mon-card-actions">
            <a class="mon-action-btn" href="${RJ_PORTAL}" target="_blank" rel="noopener" title="Ver en Rama Judicial">
              ${IC.link}<span>Rama Judicial</span>
            </a>
            <button class="mon-action-btn" id="btn-refresh-${s.id}" title="Actualizar proceso">
              ${IC.refresh}
            </button>
            <button class="mon-action-btn mon-action-danger" id="btn-delete-${s.id}" title="Eliminar">
              ${IC.trash}
            </button>
          </div>
        </div>
      </div>

      <div class="mon-card-foot">
        <span class="mon-foot-meta">${IC.clockSm} Última consulta: ${fecha}</span>
        <div class="mon-foot-toggles">
          <button class="mon-toggle-acts" id="btn-ver-${s.id}" data-id="${s.id}">
            Ver actuaciones ${IC.chevron}
          </button>
          ${pubCount > 0 ? `
          <button class="mon-toggle-acts" id="btn-pubs-${s.id}" data-id="${s.id}" style="color:var(--amber,#d97706)">
            ${IC.newspaper} Ver publicaciones (${pubCount})
          </button>` : ""}
        </div>
      </div>

      <div class="mon-actuaciones" id="actuaciones-${s.id}" style="display:none">
        <div class="mon-acts-loading" id="acts-loading-${s.id}">
          <div class="loading-spinner" style="width:24px;height:24px;margin:20px auto;display:block;"></div>
        </div>
      </div>

    </div>`;
  }

  function bindTarjetaEvents(pagina) {
    pagina.forEach(s => {
      document.getElementById(`btn-refresh-${s.id}`)?.addEventListener("click", () => actualizarUno(s, true));
      document.getElementById(`btn-delete-${s.id}`)?.addEventListener("click",  () => eliminar(s.id));
      document.getElementById(`btn-ver-${s.id}`)?.addEventListener("click",     () => toggleActuaciones(s));
      document.getElementById(`btn-pubs-${s.id}`)?.addEventListener("click",    () => togglePublicaciones(s));
    });
  }

  /* ══════════════════════════════════════════════════════════════
     ACTUACIONES — carga bajo demanda
  ══════════════════════════════════════════════════════════════ */
  async function toggleActuaciones(s) {
    const panel = document.getElementById(`actuaciones-${s.id}`);
    const btn   = document.getElementById(`btn-ver-${s.id}`);
    if (!panel) return;

    const abierto = panel.style.display !== "none";
    panel.style.display = abierto ? "none" : "block";
    btn?.classList.toggle("mon-toggle-open", !abierto);

    if (!abierto) {
      if (!actuacionesCache[s.id] || actuacionesCache[s.id].length === 0) {
        await cargarActuacionesDemanda(s);
      } else {
        renderActuaciones(s.id, actuacionesCache[s.id]);
      }
    }
  }

  async function cargarActuacionesDemanda(s) {
    const client = getClient();
    if (!client) return;
    const { data } = await client
      .from("seguimientos")
      .select("actuaciones, id_proceso")
      .eq("id", s.id)
      .single();

    let acts = Array.isArray(data?.actuaciones) ? data.actuaciones : [];

    // Si la DB tiene la lista vacía pero el proceso existe en RJ, ir a buscarlo
    if (acts.length === 0 && (data?.id_proceso || s.id_proceso)) {
      const panel = document.getElementById(`actuaciones-${s.id}`);
      if (panel) panel.innerHTML = `<p class="mon-acts-empty" style="color:var(--text-muted)">Obteniendo actuaciones desde Rama Judicial…</p>`;
      try {
        const idProceso = data?.id_proceso || s.id_proceso;
        const rAct = await fetch(`${RJ_API}/Proceso/Actuaciones/${idProceso}?pagina=1`, { headers: RJ_HEADERS });
        if (rAct.ok) {
          const dAct = await rAct.json();
          const fetched = Array.isArray(dAct.actuaciones) ? dAct.actuaciones
                        : Array.isArray(dAct) ? dAct : [];
          if (fetched.length > 0) {
            acts = fetched;
            const ultimaAct = fetched[0]?.fechaActuacion || null;
            await client.from("seguimientos").update({
              actuaciones:      acts,
              ultima_actuacion: ultimaAct,
              ultimo_chequeo:   new Date().toISOString(),
            }).eq("id", s.id);
            // Actualizar estado local
            const idx = todosLosSeguimientos.findIndex(x => x.id === s.id);
            if (idx !== -1) {
              todosLosSeguimientos[idx].ultima_actuacion = ultimaAct;
              todosLosSeguimientos[idx].ultimo_chequeo   = new Date().toISOString();
            }
            renderKPIs();
            renderNavCounts();
            renderLista();
          }
        }
      } catch (_) { /* si falla la consulta a RJ, muestra vacío */ }
    }

    actuacionesCache[s.id] = acts;
    renderActuaciones(s.id, acts);
  }

  function renderActuaciones(id, acts) {
    const loading = document.getElementById(`acts-loading-${id}`);
    if (loading) loading.remove();

    const panel = document.getElementById(`actuaciones-${id}`);
    if (!panel) return;

    if (acts.length === 0) {
      panel.innerHTML = `<p class="mon-acts-empty">Sin actuaciones registradas para este proceso.</p>`;
      return;
    }

    const pag       = actsPagina[id] || 1;
    const totalPags = Math.ceil(acts.length / PAGE_ITEMS);
    const slice     = acts.slice((pag - 1) * PAGE_ITEMS, pag * PAGE_ITEMS);

    panel.innerHTML = `
      <div class="mon-acts-header">
        <span>${IC.fileText} ${acts.length} actuación${acts.length !== 1 ? "es" : ""}</span>
      </div>
      <div class="mon-acts-list">
        ${slice.map((a, i) => `
          <div class="mon-act-row ${a.esNueva ? "mon-act-new" : ""}">
            <div class="mon-act-timeline">
              <div class="mon-act-dot ${a.esNueva ? "mon-act-dot-new" : ""}"></div>
              ${i < slice.length - 1 ? '<div class="mon-act-line"></div>' : ""}
            </div>
            <div class="mon-act-body">
              <div class="mon-act-fecha">${a.fechaActuacion ? new Date(a.fechaActuacion).toLocaleDateString("es-CO", { day:"2-digit", month:"short", year:"numeric" }) : ""}</div>
              <div class="mon-act-nombre">${escHtml(a.actuacion || "")}</div>
              ${a.anotacion ? `<div class="mon-act-anot">${escHtml(a.anotacion)}</div>` : ""}
            </div>
          </div>`).join("")}
      </div>
      ${totalPags > 1 ? `<div class="mon-item-pager">
        <button class="mon-pager-btn" ${pag <= 1 ? "disabled" : `onclick="window._cambiarPaginaItem('acts','${id}',${pag - 1})"`}>‹ Ant.</button>
        <span class="mon-pager-info">${pag} / ${totalPags}</span>
        <button class="mon-pager-btn" ${pag >= totalPags ? "disabled" : `onclick="window._cambiarPaginaItem('acts','${id}',${pag + 1})"`}>Sig. ›</button>
      </div>` : ""}`;
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLICACIONES PROCESALES — modal bajo demanda
  ══════════════════════════════════════════════════════════════ */
  async function togglePublicaciones(s) {
    _abrirPubsModal(s);
    if (!publicacionesCache[s.id]) {
      await cargarPublicacionesDemanda(s);
    } else {
      renderPublicaciones(s.id, publicacionesCache[s.id]);
      if (s.tiene_publicacion_nueva) await marcarPPVista(s.id);
    }
  }

  function _abrirPubsModal(s) {
    document.getElementById("mon-pubs-modal")?.remove();
    const mo = document.createElement("div");
    mo.id = "mon-pubs-modal";
    mo.className = "acts-modal";
    const titulo = escHtml(s.alias || s.radicado || "");
    mo.innerHTML = `<div class="acts-modal-box">
      <div class="acts-modal-hdr">
        ${IC.newspaper}
        <span class="acts-modal-title">${titulo} — Publicaciones procesales</span>
        <button class="acts-modal-close" id="pm-close" title="Cerrar">✕</button>
      </div>
      <div class="acts-modal-body" id="pubs-modal-body">
        <p class="mon-acts-empty" style="padding:20px">Cargando…</p>
      </div>
    </div>`;
    document.body.appendChild(mo);
    mo.addEventListener("click", e => { if (e.target === mo) _cerrarPubsModal(); });
    document.getElementById("pm-close")?.addEventListener("click", _cerrarPubsModal);
  }

  function _cerrarPubsModal() { document.getElementById("mon-pubs-modal")?.remove(); }

  async function cargarPublicacionesDemanda(s) {
    const client = getClient();
    if (!client) return;
    const { data } = await client
      .from("seguimientos")
      .select("publicaciones_procesales, tiene_publicacion_nueva")
      .eq("id", s.id)
      .single();

    const pubs = Array.isArray(data?.publicaciones_procesales) ? data.publicaciones_procesales : [];
    publicacionesCache[s.id] = pubs;
    renderPublicaciones(s.id, pubs);
    if (data?.tiene_publicacion_nueva) await marcarPPVista(s.id);
  }

  async function marcarPPVista(segId) {
    const client = getClient();
    if (!client) return;
    await client
      .from("seguimientos")
      .update({ tiene_publicacion_nueva: false })
      .eq("id", segId);
    const idx = todosLosSeguimientos.findIndex(x => x.id === segId);
    if (idx !== -1) todosLosSeguimientos[idx].tiene_publicacion_nueva = false;
    const badge = document.querySelector(`#moncard-${segId} .mon-badge-pub`);
    if (badge) badge.remove();
    const btn = document.getElementById(`btn-pubs-${segId}`);
    if (btn) {
      btn.classList.remove("mon-toggle-pubs-new");
      const cntBadge = btn.querySelector(".mon-pub-count");
      if (cntBadge) cntBadge.remove();
    }
    renderKPIs();
    renderNavCounts();
  }
  window._marcarPPVista = marcarPPVista;

  function renderPublicaciones(id, pubs) {
    const panel = document.getElementById("pubs-modal-body");
    if (!panel) return;

    if (!pubs.length) {
      panel.innerHTML = `<p class="mon-acts-empty">No se han detectado publicaciones procesales para este proceso.</p>`;
      return;
    }

    const ppBase = "https://publicacionesprocesales.ramajudicial.gov.co";

    /* Ordenar por fecha descendente (más reciente primero) */
    const pubsOrdenadas = [...pubs].sort((a, b) => {
      const ta = a.fecha ? new Date(a.fecha).getTime() : 0;
      const tb = b.fecha ? new Date(b.fecha).getTime() : 0;
      return tb - ta;
    });

    const pagPub       = pubsPagina[id] || 1;
    const totalPagsPub = Math.ceil(pubsOrdenadas.length / PAGE_ITEMS);
    const slicePub     = pubsOrdenadas.slice((pagPub - 1) * PAGE_ITEMS, pagPub * PAGE_ITEMS);

    panel.innerHTML = `
      <div class="mon-pub-header">
        ${IC.newspaper}
        <span>${pubs.length} publicación${pubs.length !== 1 ? "es" : ""} detectada${pubs.length !== 1 ? "s" : ""} en tu juzgado</span>
        <span class="mon-pub-header-hint">Las marcadas con ${IC.checkCircle} contienen tu radicado</span>
      </div>
      <div class="mon-pub-list">
        ${slicePub.map(p => {
          /* Preferencia de URL para el PDF:
             1. get_file?uuid= → URL pública directa (obtenida por el Edge Function)
             2. Proxy vía Edge Function con fileEntryId → resuelve el redirect con sesión Liferay
             3. Cualquier otra URL http almacenada
             4. Portal PP genérico */
          /* pdfUrl viene resuelto por el Edge Function:
             - get_file?uuid=… → URL directa pública de Liferay (sin auth)
             - …supabase.co/functions/v1/pp-buscar?pdf=… → proxy (requiere apikey como query param)
             Fallback: reparar entradas antiguas (find_file_entry) con proxy. */
          const _ppApi = getPpApiUrl();
          const _anonK = (()=>{ try{ return typeof SUPABASE_ANON_KEY!=="undefined"?SUPABASE_ANON_KEY:""; }catch{ return ""; }})();
          const pdfHref = (() => {
            const u = p.pdfUrl || "";
            /* URL directa de Liferay → no necesita auth */
            if (u.includes("get_file?uuid=")) return u;
            /* URL proxy del Edge Function → añadir apikey como query param */
            if (u.includes("?pdf=")) return _anonK ? `${u}&apikey=${_anonK}` : u;
            /* URL antigua (find_file_entry) → redirigir al proxy */
            if (_ppApi && p.fileEntryId)
              return `${_ppApi}?pdf=${p.fileEntryId}${_anonK ? "&apikey="+_anonK : ""}`;
            if (u.startsWith("http")) return u;
            return null;
          })();
          const portalHref = pdfHref || PP_PORTAL;
          const fecha = p.fecha || p.fechaRadicado || "";
          const fechaStr = fecha
            ? new Date(fecha).toLocaleDateString("es-CO", { day:"2-digit", month:"short", year:"numeric" })
            : "";
          return `
          <div class="mon-pub-item ${p.radicadoEncontrado ? "mon-pub-item-match" : ""}">
            <div class="mon-pub-item-top">
              ${p.radicadoEncontrado
                ? `<span class="mon-pub-found">${IC.checkCircle} Radicado encontrado</span>`
                : `<span class="mon-pub-court">${IC.building2} En tu juzgado</span>`}
              ${fechaStr ? `<span class="mon-pub-date">${fechaStr}</span>` : ""}
            </div>
            <div class="mon-pub-title">${escHtml(p.title || "Sin título")}</div>
            ${p.nomDespacho ? `<div class="mon-pub-despacho">${escHtml(p.nomDespacho)}</div>` : ""}
            <div class="mon-pub-item-actions">
              <button class="mon-action-btn mon-action-pp"
                onclick="window._abrirPdfPP('${escHtml(p.fileEntryId||'')}','${escHtml(pdfHref||'')}',this)"
                title="${pdfHref ? 'Abrir PDF de la publicación' : 'Ir al portal de Publicaciones Procesales'}">
                ${pdfHref ? IC.filePdf : IC.link}<span>${pdfHref ? 'Ver publicación (PDF)' : 'Ir al portal'}</span>
              </button>
            </div>
          </div>`;
        }).join("")}
      </div>
      ${totalPagsPub > 1 ? `<div class="mon-item-pager">
        <button class="mon-pager-btn" ${pagPub <= 1 ? "disabled" : `onclick="window._cambiarPaginaItem('pubs','${id}',${pagPub - 1})"`}>‹ Ant.</button>
        <span class="mon-pager-info">${pagPub} / ${totalPagsPub}</span>
        <button class="mon-pager-btn" ${pagPub >= totalPagsPub ? "disabled" : `onclick="window._cambiarPaginaItem('pubs','${id}',${pagPub + 1})"`}>Sig. ›</button>
      </div>` : ""}`;
  }

  /* ══════════════════════════════════════════════════════════════
     PAGINACIÓN
  ══════════════════════════════════════════════════════════════ */
  function renderPaginacion(total, totalPags) {
    const el = document.getElementById("mon-pagination");
    if (!el) return;

    if (totalPags <= 1) { el.innerHTML = ""; return; }

    const desde = (paginaActual - 1) * PAGE_SIZE + 1;
    const hasta = Math.min(paginaActual * PAGE_SIZE, total);

    let pagBtns = "";
    paginasVisibles(paginaActual, totalPags).forEach(p => {
      if (p === "…") pagBtns += `<span class="mon-pag-ellipsis">…</span>`;
      else pagBtns += `<button class="mon-pag-btn ${p === paginaActual ? "active" : ""}" data-pag="${p}">${p}</button>`;
    });

    el.innerHTML = `
      <div class="mon-pag-info">${desde}–${hasta} de ${total}</div>
      <div class="mon-pag-controls">
        <button class="mon-pag-btn mon-pag-nav" id="pag-prev" ${paginaActual === 1 ? "disabled" : ""}>${IC.chevLeft}</button>
        ${pagBtns}
        <button class="mon-pag-btn mon-pag-nav" id="pag-next" ${paginaActual === totalPags ? "disabled" : ""}>${IC.chevRight}</button>
      </div>`;

    el.querySelectorAll(".mon-pag-btn[data-pag]").forEach(btn =>
      btn.addEventListener("click", () => { paginaActual = +btn.dataset.pag; renderLista(); scroll2List(); }));
    el.querySelector("#pag-prev")?.addEventListener("click", () => { paginaActual--; renderLista(); scroll2List(); });
    el.querySelector("#pag-next")?.addEventListener("click", () => { paginaActual++; renderLista(); scroll2List(); });
  }

  function paginasVisibles(actual, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [1];
    if (actual > 3) pages.push("…");
    for (let p = Math.max(2, actual - 1); p <= Math.min(total - 1, actual + 1); p++) pages.push(p);
    if (actual < total - 2) pages.push("…");
    pages.push(total);
    return pages;
  }

  function scroll2List() {
    document.getElementById("mon-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ══════════════════════════════════════════════════════════════
     AGREGAR
  ══════════════════════════════════════════════════════════════ */
  async function onAgregarRadicado(e) {
    e.preventDefault();
    const raw   = (document.getElementById("input-radicado")?.value || "").replace(/\s/g, "");
    const alias = (document.getElementById("input-alias")?.value || "").trim();

    if (!/^\d{23}$/.test(raw)) { showToast("El radicado debe tener exactamente 23 dígitos.", "error"); return; }
    if (todosLosSeguimientos.some(s => s.radicado === raw)) { showToast("Ya tienes ese radicado en seguimiento.", "error"); return; }

    const suscripcion = getSuscripcion();
    if (suscripcion?.plan === "basico" && todosLosSeguimientos.length >= LIMITE_BASICO) {
      showToast(`El Plan Básico permite hasta ${LIMITE_BASICO} procesos. Actualiza a Premium para agregar más.`, "error");
      return;
    }

    const btn = document.getElementById("btn-add-radicado");
    btn.disabled = true; btn.innerHTML = `${IC.spinner} Consultando…`;

    try {
      const resultado = await consultarRamaJudicial(raw);
      if (!resultado) return;

      const { proceso, actuaciones } = resultado;
      const client = getClient();
      const user   = getUser();

      const { data, error } = await client
        .from("seguimientos")
        .insert({
          user_id:         user.id,
          radicado:        raw,
          alias:           alias || null,
          nombre_proceso:  proceso.tipoProceso   || null,
          despacho:        proceso.despacho      || null,
          sujetos:         proceso.sujetosProcesales || null,
          id_proceso:      String(proceso.idProceso),
          actuaciones,
          ultima_actuacion: actuaciones[0]?.fechaActuacion || null,
          tiene_cambios:   false,
          ultimo_chequeo:  new Date().toISOString(),
        })
        .select("id, radicado, alias, despacho, sujetos, id_proceso, ultima_actuacion, tiene_cambios, ultimo_chequeo, created_at, tiene_publicacion_nueva, pub_count")
        .single();

      if (error) throw error;

      actuacionesCache[data.id]   = actuaciones;
      publicacionesCache[data.id] = [];
      todosLosSeguimientos.unshift(data);
      document.getElementById("input-radicado").value = "";
      document.getElementById("input-alias").value    = "";
      toggleForm();
      /* Mostrar tarjeta en estado skeleton mientras se buscan publicaciones procesales */
      _ppBuscando.add(data.id);
      renderKPIs();
      renderNavCounts();
      renderLista();
      showToast("Proceso agregado. Buscando publicaciones procesales…", "ok");
      /* Buscar PP en segundo plano */
      _consultarPPYAgregarSkeleton(data);
    } catch (err) {
      console.error(err);
      showToast("Error al agregar el proceso. Intenta de nuevo.", "error");
    } finally {
      btn.disabled = false; btn.innerHTML = `${IC.plus} Agregar`;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     CONSULTAR Rama Judicial — búsqueda inicial por número de radicado
     Usado al agregar un proceso nuevo (sin id_proceso conocido).
  ══════════════════════════════════════════════════════════════ */

  /**
   * Extrae el número de juzgado codificado dentro del propio radicado colombiano (23 dígitos).
   *
   * Formato estándar: CCCCC EEEEE JJ AAAA SSSSS EE  (sin espacios, 23 dígitos en total)
   *   CCCCC = código ciudad   (pos  0- 4, 5 dígitos)
   *   EEEEE = especialidad    (pos  5- 9, 5 dígitos)
   *   JJ    = número juzgado  (pos 10-11, 2 dígitos)  ← aquí está la clave
   *   AAAA  = año             (pos 12-15, 4 dígitos)
   *   SSSSS = secuencial      (pos 16-20, 5 dígitos)
   *   EE    = extensión       (pos 21-22, 2 dígitos)
   *
   * Ejemplo: "76001400300520260071900" → pos 10-11 = "05" → juzgado 5
   *          "76001400303220260071900" → pos 10-11 = "32" → juzgado 32
   */
  function extraerNumeroJuzgadoDeRadicado(radicado) {
    const r = (radicado || "").replace(/\D/g, ""); // solo dígitos
    if (r.length !== 23) return null;
    return parseInt(r.substring(10, 12), 10);
  }

  /**
   * La API de la Rama Judicial no garantiza que "actuaciones[0]" sea siempre
   * la actuación más reciente (a veces llegan en orden de registro, no de
   * fecha). Como "días sin actuación" y "última actuación" se calculan a
   * partir de la posición [0], un orden incorrecto producía fechas
   * incoherentes (por ejemplo, una fecha futura o un conteo de días en 0
   * cuando en realidad ya habían pasado varios días). Ordenamos siempre por
   * fecha descendente antes de usar la actuación más reciente.
   */
  function ordenarActuacionesRecientePrimero(actuaciones) {
    if (!Array.isArray(actuaciones) || actuaciones.length < 2) return actuaciones || [];
    return [...actuaciones].sort((a, b) => {
      const ta = a?.fechaActuacion ? new Date(a.fechaActuacion).getTime() : -Infinity;
      const tb = b?.fechaActuacion ? new Date(b.fechaActuacion).getTime() : -Infinity;
      return tb - ta;
    });
  }

  async function consultarRamaJudicial(radicado) {
    try {
      const r = await fetch(
        `${RJ_API}/Procesos/Consulta/NumeroRadicacion?numero=${radicado}&SoloActivos=false&pagina=1`,
        { headers: RJ_HEADERS }
      );
      if (!r.ok) { showToast("Error consultando la Rama Judicial.", "error"); return null; }
      const d = await r.json();
      if (!d.procesos?.length) { showToast("No se encontró ningún proceso con ese radicado.", "error"); return null; }

      // ── Paso 1: identificar el proceso correcto por el número de juzgado ──────
      // El radicado colombiano de 23 dígitos codifica el número del juzgado en las
      // posiciones 10-11. Esto es determinista y no depende de actuaciones ni texto.
      // Ej: "...0005..." → juzgado 05  /  "...0032..." → juzgado 32
      const numJuzgadoRad = extraerNumeroJuzgadoDeRadicado(radicado);

      let procesoCandidato = null;

      if (numJuzgadoRad !== null) {
        // Buscar el proceso cuyo despacho contiene el mismo número de juzgado.
        // Aplica siempre, sin importar cuántos procesos devuelva la API.
        procesoCandidato = d.procesos.find(proc => {
          const numDespacho = extraerNumeroJuzgado(proc.despacho || "");
          return numDespacho === numJuzgadoRad;
        }) || null;
      }

      // Si no encontramos por número de juzgado (ej: despacho en texto "QUINTO"),
      // usamos el primer proceso como fallback.
      if (!procesoCandidato) procesoCandidato = d.procesos[0];

      // ── Paso 2: obtener actuaciones del proceso identificado ─────────────────
      // Intentamos primero con el proceso que coincide con el juzgado del radicado.
      // Si no tiene actuaciones, buscamos en los demás como fallback.
      let proceso    = procesoCandidato;
      let actuaciones = [];

      const rActPrincipal = await fetch(
        `${RJ_API}/Proceso/Actuaciones/${procesoCandidato.idProceso}?pagina=1`,
        { headers: RJ_HEADERS }
      );
      const dActPrincipal = rActPrincipal.ok ? await rActPrincipal.json() : {};
      actuaciones = Array.isArray(dActPrincipal.actuaciones) ? dActPrincipal.actuaciones
                 : Array.isArray(dActPrincipal) ? dActPrincipal : [];

      // Fallback: si el proceso correcto no tiene actuaciones, buscar en los otros
      // pero SIN cambiar el proceso seleccionado (para no guardar el id_proceso incorrecto)
      if (actuaciones.length === 0) {
        for (const proc of d.procesos) {
          if (proc.idProceso === procesoCandidato.idProceso) continue;
          const rAct = await fetch(`${RJ_API}/Proceso/Actuaciones/${proc.idProceso}?pagina=1`, { headers: RJ_HEADERS });
          const dAct = rAct.ok ? await rAct.json() : {};
          const acts = Array.isArray(dAct.actuaciones) ? dAct.actuaciones
                     : Array.isArray(dAct) ? dAct : [];
          if (acts.length > 0) {
            // Tomamos las actuaciones del otro proceso como referencia inicial,
            // pero mantenemos el proceso (despacho, sujetos) del juzgado correcto.
            actuaciones = acts;
            break;
          }
        }
      }

      return { proceso, actuaciones: ordenarActuacionesRecientePrimero(actuaciones) };
    } catch (err) {
      console.error(err);
      showToast("No se pudo conectar con la Rama Judicial.", "error");
      return null;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     ENCONTRAR MEJOR COINCIDENCIA — cotejar proceso contra datos guardados
     Compara número de juzgado, despacho completo y sujetos (partes) para
     identificar cuál de los múltiples procesos devueltos por la API
     corresponde realmente al proceso del usuario.
  ══════════════════════════════════════════════════════════════ */

  /**
   * Extrae el número entero del juzgado de una cadena de despacho.
   * Ej: "JUZGADO 005 CIVIL MUNICIPAL DE CALI"  → 5
   *     "JUZGADO TREINTA Y DOS CIVIL DE CALI"  → null (sin dígito directo)
   *     "JUZGADO 032 CIVIL MUNICIPAL DE CALI"  → 32
   * Solo extrae el primer número que aparezca en el texto.
   */
  function extraerNumeroJuzgado(texto) {
    const m = (texto || "").match(/\b0*(\d+)\b/);
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * Palabras que pueden aparecer al final de un nombre de despacho sin ser una
   * ciudad (tipo de trámite, especialidad, etc.) — ej. "JUZGADO SEGUNDO CIVIL
   * DEL CIRCUITO DE ORALIDAD": lo que sigue al último " de " es "oralidad",
   * que es el tipo de trámite, no el municipio. Si el candidato cae en esta
   * lista se sigue buscando hacia atrás un " de <algo>" anterior que sí sea
   * una ciudad, en vez de rechazar por error una publicación legítima.
   */
  const NO_CIUDAD = new Set([
    "oralidad", "descongestion", "garantias", "conocimiento", "ejecucion",
    "liquidacion", "familia", "unico", "unica", "adjunto", "circuito",
    "municipal", "promiscuo", "civil", "penal", "laboral", "administrativo",
    "agrario", "restitucion", "restitucion de tierras", "tierras",
    "transicion", "paz", "ordinario", "verbal", "sumario", "ejecutivo",
    "mixta", "mixto", "especializado", "itinerante", "reparto", "turno",
    "pequenas causas", "pequeñas causas", "menores", "infancia", "adolescencia",
  ]);

  /**
   * Extrae el nombre de la ciudad/municipio de un texto de despacho.
   * Convención colombiana: el despacho suele terminar en "... DE <CIUDAD>"
   * (ej: "JUZGADO 001 CIVIL MUNICIPAL DE PASTO"). Recorre las ocurrencias de
   * " de " desde el final hacia el inicio y devuelve la primera que NO sea
   * una palabra de trámite/especialidad (ver NO_CIUDAD) en vez de asumir
   * ciegamente la última. Si ninguna sirve, devuelve "" — nunca se inventa
   * una ciudad. `texto` debe venir ya normalizado (minúsculas, sin tildes).
   */
  function extraerCiudadDespacho(texto) {
    const t = texto || "";
    if (!t) return "";
    const idxs = [];
    let i = -1;
    while ((i = t.indexOf(" de ", i + 1)) !== -1) idxs.push(i);
    for (let k = idxs.length - 1; k >= 0; k--) {
      const cand = t.substring(idxs[k] + 4).trim();
      if (!cand || NO_CIUDAD.has(cand)) continue;
      return cand;
    }
    return "";
  }

  /**
   * Extrae nombres/apellidos (palabras > 3 letras) de la cadena de sujetos
   * procesales (demandante/demandado) guardada con el proceso, para usarlos
   * como criterio de coincidencia contra el título de una publicación.
   */
  function extraerPartesProceso(sujetosStr) {
    const norm = str => (str || "").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return norm(sujetosStr || "").split(/[\s·,.\-/]+/).filter(w => w.length > 3);
  }

  /**
   * Compara si una cadena de despacho (la que devuelve el portal PP) pertenece
   * al mismo proceso guardado, y si no, si el título de la publicación
   * menciona a alguna de las partes guardadas.
   *
   * Orden de criterios EN CASCADA, de más a menos confiable (el radicado ya
   * está garantizado antes de llegar aquí, porque la búsqueda en el portal PP
   * se hace con el radicado completo):
   *   1) CIUDAD — si se identifica en ambos lados y no coincide, se rechaza de
   *      inmediato: distintos municipios pueden compartir el mismo número de
   *      juzgado, pero no el mismo nombre de ciudad.
   *   2) PARTES (demandante/demandado) — si la ciudad no pudo verificarse en
   *      alguno de los dos lados, se acepta cuando el título de la
   *      publicación menciona a alguna de las partes guardadas.
   *   3) JUZGADO (número) — último recurso, el más débil: los despachos a
   *      veces cambian de nombre o numeración, así que solo se usa si ninguna
   *      otra señal fue posible.
   * Si ninguna señal permite confirmar, se RECHAZA (fail-closed) — así se
   * evita mezclar publicaciones de otro juzgado o ciudad que comparten el
   * mismo año-secuencial del radicado.
   *
   * @param despachoGuardado texto del despacho guardado por el usuario (puede faltar)
   * @param despachoAPI      texto "nomDespacho" que devuelve el portal PP
   * @param numJuzgadoEsperado número de juzgado extraído del radicado completo guardado
   * @param sujetosGuardados  texto de sujetos procesales (demandante/demandado) guardado
   * @param tituloPublicacion texto "title" de la publicación (para el criterio de partes)
   */
  function despachoCoincide(despachoGuardado, despachoAPI, numJuzgadoEsperado, sujetosGuardados, tituloPublicacion) {
    if (!despachoAPI) return false; // sin despacho de la API no hay nada que verificar
    const norm = str => (str || "").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ").trim();
    const a = norm(despachoAPI);
    const g = norm(despachoGuardado || "");

    // ── 1) Ciudad ──
    const ciudadA = extraerCiudadDespacho(a);
    const ciudadG = extraerCiudadDespacho(g);
    if (ciudadG && ciudadA) return ciudadG === ciudadA;

    // ── 2) Partes (demandante/demandado) ──
    const partes = extraerPartesProceso(sujetosGuardados);
    if (partes.length && tituloPublicacion) {
      const titulo = norm(tituloPublicacion);
      if (partes.some(p => titulo.includes(p))) return true;
    }

    // ── 3) Juzgado (número) — respaldo más débil ──
    const numA = extraerNumeroJuzgado(a);
    if (numJuzgadoEsperado !== null && numJuzgadoEsperado !== undefined) {
      return numA !== null && numA === numJuzgadoEsperado;
    }
    const numG = extraerNumeroJuzgado(g);
    if (numG !== null) return numA !== null && numA === numG;

    return false; // sin ninguna referencia confiable → rechazar
  }

  function encontrarMejorCoincidencia(procesos, s) {
    if (!procesos?.length) return null;
    if (procesos.length === 1) return procesos[0];

    // Normalizar texto: minúsculas, sin tildes, sin espacios dobles
    const norm = str => (str || "")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ").trim();

    const despachoBase = norm(s.despacho || "");
    const sujetosBase  = norm(s.sujetos  || "");

    // Si tenemos id_proceso guardado, es la coincidencia perfecta
    if (s.id_proceso) {
      const porId = procesos.find(p => String(p.idProceso) === String(s.id_proceso));
      if (porId) return porId;
    }

    // Sin datos de referencia, devolver el primero
    if (!despachoBase && !sujetosBase) return procesos[0];

    // Número de juzgado del despacho guardado — criterio principal
    const numJuzgadoBase = extraerNumeroJuzgado(despachoBase);

    let mejorPuntaje = -Infinity;
    let mejorProceso = procesos[0];

    for (const proc of procesos) {
      let puntaje = 0;
      const despachoProc = norm(proc.despacho || "");
      const sujetosProc  = norm(proc.sujetosProcesales || "");

      // ── Número de juzgado — PESO MÁXIMO (70 pts / −100 penalización) ──
      // "JUZGADO 005" vs "JUZGADO 032": el número distingue unívocamente el despacho.
      // La versión anterior filtraba palabras con >3 letras, dejando "005" fuera → BUG.
      if (numJuzgadoBase !== null) {
        const numJuzgadoProc = extraerNumeroJuzgado(despachoProc);
        if (numJuzgadoProc !== null) {
          if (numJuzgadoProc === numJuzgadoBase) {
            puntaje += 70;   // coincidencia exacta → muy probable que sea el mismo
          } else {
            puntaje -= 100;  // número diferente → penalizar fuertemente
          }
        }
      }

      // ── Palabras del despacho (ciudad, tipo de juzgado) — 20 pts ──
      // Solo palabras > 3 letras para ignorar artículos ("de", "y", "el")
      if (despachoBase && despachoProc) {
        const palabrasBase = despachoBase.split(" ").filter(w => w.length > 3);
        if (palabrasBase.length > 0) {
          const coinciden = palabrasBase.filter(w => despachoProc.includes(w));
          puntaje += (coinciden.length / palabrasBase.length) * 20;
        }
      }

      // ── Sujetos procesales (nombres de las partes) — 30 pts ──
      // Apellidos y nombres suelen tener > 3 letras, así que el filtro aplica bien.
      if (sujetosBase && sujetosProc) {
        const palabrasBase = sujetosBase.split(/[\s·,.\-/]+/).filter(w => w.length > 3);
        if (palabrasBase.length > 0) {
          const coinciden = palabrasBase.filter(w => sujetosProc.includes(w));
          puntaje += (coinciden.length / palabrasBase.length) * 30;
        }
      }

      if (puntaje > mejorPuntaje) {
        mejorPuntaje = puntaje;
        mejorProceso = proc;
      }
    }

    return mejorProceso;
  }

  /* ══════════════════════════════════════════════════════════════
     CONSULTAR Rama Judicial POR ID DE PROCESO — para actualizaciones
     Usado al refrescar un proceso ya guardado (tiene id_proceso).
     Obtiene las actuaciones directamente con el idProceso guardado
     y coteja el proceso correcto contra despacho + sujetos guardados,
     evitando mezclar datos de otros juzgados o ciudades.
  ══════════════════════════════════════════════════════════════ */
  async function consultarRamaJudicialPorId(s) {
    // Si por alguna razón no tenemos id_proceso, caemos al flujo normal
    if (!s.id_proceso) return consultarRamaJudicial(s.radicado);

    try {
      // 1. Buscar la lista de procesos para el radicado (para obtener datos actualizados
      //    del despacho, sujetos, tipoProceso, etc.)
      const r = await fetch(
        `${RJ_API}/Procesos/Consulta/NumeroRadicacion?numero=${s.radicado}&SoloActivos=false&pagina=1`,
        { headers: RJ_HEADERS }
      );
      if (!r.ok) {
        showToast("Error consultando la Rama Judicial.", "error");
        return null;
      }
      const d = await r.json();

      let proceso = null;

      if (d.procesos?.length) {
        // Número de juzgado codificado en el propio radicado (posiciones 10-11).
        // Es la fuente más confiable para verificar si un proceso es el correcto.
        const numJuzgadoRad = extraerNumeroJuzgadoDeRadicado(s.radicado);

        // Intento 1: coincidencia exacta por idProceso guardado
        const porId = d.procesos.find(p => String(p.idProceso) === String(s.id_proceso));

        if (porId) {
          // Verificar que el proceso encontrado por ID pertenece al mismo juzgado
          // que indica el radicado (posiciones 10-11). Solo descartamos el ID guardado
          // si AMBOS números están disponibles Y son claramente distintos.
          // En caso de duda siempre confiamos en el ID guardado.
          const numJuzgadoEncontrado = extraerNumeroJuzgado(porId.despacho || "");
          const hayConflictoClaro = numJuzgadoRad !== null
                                 && numJuzgadoEncontrado !== null
                                 && numJuzgadoEncontrado !== numJuzgadoRad;
          if (!hayConflictoClaro) {
            proceso = porId;  // confiar en el ID guardado
          }
          // Solo si hay conflicto claro (ej: radicado dice juzgado 05, ID apunta a juzgado 32)
          // dejamos proceso = null para buscar por otra vía.
        }

        // Intento 2: si el id_proceso es incorrecto o no se encontró, buscar por
        // número de juzgado del radicado (método más confiable)
        if (!proceso && numJuzgadoRad !== null) {
          proceso = d.procesos.find(p => extraerNumeroJuzgado(p.despacho || "") === numJuzgadoRad) || null;
        }

        // Intento 3: cotejo por despacho + sujetos guardados
        if (!proceso) {
          proceso = encontrarMejorCoincidencia(d.procesos, s);
        }
      }

      // Fallback si la API no devuelve ningún proceso con ese radicado
      if (!proceso) {
        showToast("No se encontró el proceso en la Rama Judicial.", "error");
        return null;
      }

      // 2. Determinar el idProceso real a usar para buscar actuaciones.
      //    Si encontramos el proceso por coincidencia (no por ID exacto),
      //    usamos su idProceso real, no el antiguo s.id_proceso.
      //    Esto evita recibir actuaciones de un proceso diferente.
      const idProcesoReal = String(proceso.idProceso);

      // 3. Obtener actuaciones con el idProceso correcto
      const rAct = await fetch(
        `${RJ_API}/Proceso/Actuaciones/${idProcesoReal}?pagina=1`,
        { headers: RJ_HEADERS }
      );
      const dAct = rAct.ok ? await rAct.json() : {};
      const actuaciones = Array.isArray(dAct.actuaciones) ? dAct.actuaciones
                        : Array.isArray(dAct) ? dAct : [];

      // Incluir idProcesoReal para que actualizarUno pueda persistirlo si cambió
      return { proceso, actuaciones: ordenarActuacionesRecientePrimero(actuaciones), idProcesoReal };
    } catch (err) {
      console.error(err);
      showToast("No se pudo conectar con la Rama Judicial.", "error");
      return null;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     CONSULTAR PUBLICACIONES PROCESALES (vía API de Rama Judicial)
  ══════════════════════════════════════════════════════════════ */
  async function consultarPublicacionesProcesales(s) {
    /* Las fuentes se mantienen separadas para aplicar distintos niveles de confianza:
       · pubsRJ  (fuente 1): vinculadas al id_proceso exacto → CONFIABLES, se conservan todas.
       · pubsPP  (fuente 2): buscadas por radicado en el portal PP → DESCONFIABLES porque
         el portal hace coincidencia parcial ("00719") y devuelve publicaciones de otros
         juzgados que comparten el número secuencial. Solo se conservan las que tienen
         nomDespacho explícito Y coincide con el juzgado del proceso guardado.
    */
    let pubsRJ = [];
    let pubsPP = [];

    /* 1. RJ API — fuente confiable (ligada a id_proceso)
          Trae varias páginas para capturar publicaciones recientes. */
    if (s.id_proceso) {
      try {
        let allRaw = [], paginaRJ = 1, totalPags = 1;
        do {
          const r = await fetch(`${RJ_API}/Proceso/Publicaciones/${s.id_proceso}?pagina=${paginaRJ}`, { headers: RJ_HEADERS });
          if (!r.ok) break;
          let d; try { d = await r.json(); } catch { d = null; }
          const raw = Array.isArray(d?.publicaciones) ? d.publicaciones : Array.isArray(d) ? d : [];
          if (!raw.length) break;
          for (const item of raw) {
            if (!allRaw.some(x =>
              (x.uuid && x.uuid === item.uuid) ||
              (x.fileEntryId && x.fileEntryId === item.fileEntryId) ||
              (x.title && x.title === item.title)
            )) allRaw.push(item);
          }
          if (paginaRJ === 1) {
            totalPags = d?.totalPaginas || d?.paginas || 1;
            if (totalPags < 2 && d?.totalRegistros > raw.length) totalPags = 2;
          }
          paginaRJ++;
        } while (paginaRJ <= Math.min(totalPags, 5));
        pubsRJ = allRaw;
      } catch (_) {}
    }

    /* 2. Edge Function PP — fuente desconfiable (búsqueda por radicado parcial)
          El portal PP coincide por "00719" y devuelve publicaciones de TODOS los
          juzgados que compartan ese número secuencial (ej: juzgado 05 y 32).
          REGLA: solo se acepta una publicación de esta fuente si tiene nomDespacho
          explícito Y ese despacho corresponde al juzgado del proceso guardado.
          Sin nomDespacho → se descarta (no se puede verificar a qué juzgado pertenece). */
    const _ppApiUrl = getPpApiUrl();
    if (_ppApiUrl) {
      try {
        const anonKey = (()=>{ try{ return typeof SUPABASE_ANON_KEY!=="undefined"?SUPABASE_ANON_KEY:""; }catch{ return ""; }})();
        const params  = new URLSearchParams({ radicado: s.radicado||"", idProceso: s.id_proceso||"" });
        const headers = anonKey ? { "apikey": anonKey, "Authorization": `Bearer ${anonKey}` } : {};
        const r = await fetch(`${_ppApiUrl}?${params}`, { headers });
        if (r.ok) {
          const d = await r.json();
          let proxyPubs = Array.isArray(d.publicaciones) ? d.publicaciones : [];

          // Filtro estricto: nomDespacho debe existir y coincidir con el proceso
          // guardado. El criterio se aplica en cascada dentro de despachoCoincide:
          // ciudad → partes (demandante/demandado) → número de juzgado (el número
          // codificado en el propio radicado de 23 dígitos es el más confiable de
          // los tres para el criterio de juzgado, porque no depende de que el
          // usuario haya guardado el texto del despacho).
          // El proxy pp-buscar (Edge Function) ya verifica server-side que el
          // radicado completo de 23 dígitos aparece textualmente en el título
          // o el contenido del documento (ver snippetContieneRadicado en
          // pp-buscar.ts) — señal más fuerte que comparar texto de despacho,
          // así que si ya viene confirmada (radicadoEncontrado) se acepta de
          // inmediato. Esta fuente NO trae "nomDespacho" (el buscador del
          // portal no expone esa información), así que exigirlo aquí como
          // antes rechazaba el 100% de sus resultados.
          const numJuzgadoRad = extraerNumeroJuzgadoDeRadicado(s.radicado);
          proxyPubs = proxyPubs.filter(p =>
            p.radicadoEncontrado === true ||
            (p.nomDespacho && despachoCoincide(s.despacho, p.nomDespacho, numJuzgadoRad, s.sujetos, p.title))
          );

          pubsPP = proxyPubs;
        }
      } catch (_) {}
    }

    /* 3. Combinar: fuente RJ primero (confiable), luego PP sin duplicados */
    const pubs = [...pubsRJ];
    for (const p of pubsPP) {
      if (!pubs.some(x =>
        (x.uuid  && x.uuid  === p.uuid)  ||
        (x.title && x.title === p.title)
      )) pubs.push(p);
    }

    return { pubs, error: null };
  }

  /* ══════════════════════════════════════════════════════════════
     ACTUALIZAR UNO — consulta RJ + Publicaciones Procesales
  ══════════════════════════════════════════════════════════════ */
  async function actualizarUno(s, manual = false) {
    const btnR = document.getElementById(`btn-refresh-${s.id}`);
    const orig = btnR?.innerHTML;
    if (btnR) { btnR.disabled = true; btnR.innerHTML = IC.spinner; }

    let ppError = null;

    try {
      let prevActs = actuacionesCache[s.id];
      if (!prevActs) {
        const { data } = await getClient().from("seguimientos").select("actuaciones").eq("id", s.id).single();
        prevActs = ordenarActuacionesRecientePrimero(data?.actuaciones || []);
        actuacionesCache[s.id] = prevActs;
      }

      // ── Consultar Rama Judicial ──
      // Usamos consultarRamaJudicialPorId para obtener actuaciones directamente
      // con el id_proceso guardado y cotejar el proceso correcto por despacho
      // y sujetos, evitando recibir datos de otro juzgado o ciudad.
      const resultado = await consultarRamaJudicialPorId(s);
      if (!resultado) return { ok: false, error: "No se obtuvo respuesta de la Rama Judicial" };

      const { proceso, actuaciones, idProcesoReal: _idReal } = resultado;
      // Si la búsqueda fue por fallback (sin id_proceso previo), derivar el ID del proceso encontrado
      const idProcesoReal = _idReal || (proceso?.idProceso ? String(proceso.idProceso) : null);
      const cambio = actuaciones[0]?.fechaActuacion !== prevActs[0]?.fechaActuacion;
      // Si la API devuelve vacío pero teníamos datos, conservar los previos (evita borrado por fallo de red)
      const actsBase = actuaciones.length > 0 ? actuaciones : prevActs;
      const acts     = actsBase.map((a, i) => ({ ...a, esNueva: i === 0 && cambio && actuaciones.length > 0 }));
      const ahora  = new Date().toISOString();

      // Detectar si el id_proceso cambió (re-indexación en RJ) o estaba vacío
      const idProcesoCambio = idProcesoReal && String(idProcesoReal) !== String(s.id_proceso || "");

      // ── Consultar Publicaciones Procesales ──
      // Si el id_proceso cambió, actualizar s para que la consulta PP use el correcto
      const sParaPP = idProcesoCambio ? { ...s, id_proceso: idProcesoReal } : s;
      const { pubs, error: errPP } = await consultarPublicacionesProcesales(sParaPP);
      ppError = errPP;

      // Detectar publicación nueva comparando cantidad con lo que había
      let prevPubs = publicacionesCache[s.id];
      if (!prevPubs) {
        const { data: dpub } = await getClient()
          .from("seguimientos")
          .select("publicaciones_procesales")
          .eq("id", s.id)
          .single();
        prevPubs = Array.isArray(dpub?.publicaciones_procesales) ? dpub.publicaciones_procesales : [];
        publicacionesCache[s.id] = prevPubs;
      }
      const pubNueva   = pubs.length > (prevPubs?.length || 0);
      const ultimaPub  = pubs[0]?.fecha || pubs[0]?.fechaRadicado || null;

      // ── Actualizar Supabase con RJ + PP ──
      // Solo sobreescribir actuaciones si la API devolvió datos; si devuelve vacío, conservar las previas
      const actsParaGuardar = actuaciones.length > 0 ? acts : prevActs;
      const updatePayload = {
        despacho:                 proceso.despacho            || s.despacho,
        sujetos:                  proceso.sujetosProcesales   || s.sujetos,
        actuaciones:              actsParaGuardar,
        ultima_actuacion:         actuaciones[0]?.fechaActuacion || (prevActs[0]?.fechaActuacion || null),
        tiene_cambios:            cambio,
        ultimo_chequeo:           ahora,
        /* Si la búsqueda PP no devolvió resultados conservar los datos anteriores */
        publicaciones_procesales: pubs.length > 0 ? pubs : prevPubs,
        pub_count:                pubs.length > 0 ? pubs.length : prevPubs.length,
        tiene_publicacion_nueva:  pubNueva || (s.tiene_publicacion_nueva && !pubNueva ? s.tiene_publicacion_nueva : pubNueva),
      };
      if (ultimaPub) updatePayload.ultima_publicacion = ultimaPub;
      // Persistir id_proceso si estaba vacío o cambió (re-indexación en RJ)
      if (idProcesoCambio || (!s.id_proceso && idProcesoReal)) {
        updatePayload.id_proceso = idProcesoReal;
      }

      await getClient().from("seguimientos").update(updatePayload).eq("id", s.id);

      const pubsToStore = pubs.length > 0 ? pubs : prevPubs;
      actuacionesCache[s.id]   = acts;
      publicacionesCache[s.id] = pubsToStore;

      const idx = todosLosSeguimientos.findIndex(x => x.id === s.id);
      if (idx !== -1) Object.assign(todosLosSeguimientos[idx], {
        despacho:                proceso.despacho          || s.despacho,
        sujetos:                 proceso.sujetosProcesales || s.sujetos,
        id_proceso:              idProcesoReal             || s.id_proceso,
        ultima_actuacion:        actuaciones[0]?.fechaActuacion || null,
        tiene_cambios:           cambio,
        ultimo_chequeo:          ahora,
        pub_count:               pubsToStore.length,
        tiene_publicacion_nueva: pubNueva,
        ultima_publicacion:      ultimaPub || todosLosSeguimientos[idx].ultima_publicacion,
      });

      renderKPIs();
      renderNavCounts();
      renderLista();

      // ── Guardar log en actualización individual manual ──
      if (manual) {
        const fallos = errPP ? 1 : 0;
        await guardarLog({
          ts:     ahora,
          total:  1,
          fallos,
          error:  errPP
            ? `PP: ${errPP}`
            : null,
        });
        const msgs = [];
        if (cambio)   msgs.push(`Nueva actuación en ${s.alias || s.radicado.slice(-6)}`);
        if (pubNueva) msgs.push("Nueva publicación procesal detectada");
        if (errPP)    msgs.push(`Error PP: ${errPP}`);
        if (!msgs.length) msgs.push("Sin cambios en RJ ni en Publicaciones Procesales.");
        showToast(msgs.join(" · "), errPP ? "error" : (cambio || pubNueva) ? "ok" : "");
      } else {
        if (cambio)   showToast(`Nuevo movimiento: ${s.alias || s.radicado.slice(-6)}`, "ok");
        else if (pubNueva) showToast(`Nueva publicación PP: ${s.alias || s.radicado.slice(-6)}`, "ok");
      }
      return { ok: true, ppError };
    } catch (err) {
      console.error(err);
      if (manual) showToast("Error al actualizar.", "error");
      return { ok: false, error: err?.message || "Error de conexión" };
    } finally {
      if (btnR) { btnR.disabled = false; btnR.innerHTML = orig || IC.refresh; }
    }
  }

  /* ══════════════════════════════════════════════════════════════
     ACTUALIZAR TODOS — consulta RJ + PP para cada proceso
  ══════════════════════════════════════════════════════════════ */
  async function actualizarTodos(manual = false) {
    if (!todosLosSeguimientos.length) {
      if (manual) showToast("No tienes procesos en seguimiento.", "");
      return;
    }
    const btn = document.getElementById("btn-refresh-all");
    if (btn) { btn.disabled = true; btn.innerHTML = `${IC.spinner} Consultando…`; }

    const lista = [...todosLosSeguimientos];
    let rjErrCount  = 0;
    let ppErrCount  = 0;
    let lastRjErr   = null;
    let lastPpErr   = null;

    for (let i = 0; i < lista.length; i += 5) {
      const resultados = await Promise.allSettled(lista.slice(i, i + 5).map(s => actualizarUno(s, false)));
      resultados.forEach(r => {
        const val = r.status === "fulfilled" ? r.value : { ok: false, error: r.reason?.message };
        if (!val?.ok)     { rjErrCount++; if (val?.error)   lastRjErr = val.error; }
        if (val?.ppError) { ppErrCount++; lastPpErr = val.ppError; }
      });
    }

    const totalFallos = rjErrCount + ppErrCount;
    const ahora = new Date().toISOString();

    // Construir mensaje de error descriptivo para el log
    let errorMsg = null;
    if (rjErrCount > 0 && ppErrCount > 0) {
      errorMsg = `RJ: ${rjErrCount} error(es) (${lastRjErr}). PP: ${ppErrCount} error(es) (${lastPpErr}).`;
    } else if (rjErrCount > 0) {
      errorMsg = `Consulta RJ: ${lastRjErr}`;
    } else if (ppErrCount > 0) {
      errorMsg = `Publicaciones PP: ${lastPpErr}`;
    }

    // Guardar log con resultados de RJ y PP
    await guardarLog({ ts: ahora, total: lista.length, fallos: totalFallos, error: errorMsg });

    // Refrescar desde Supabase
    try { await cargarTodos(); } catch(_) {}

    if (btn) { btn.disabled = false; btn.innerHTML = `${IC.refresh} Actualizar todos`; }
    if (manual) showToast(
      totalFallos > 0
        ? `${totalFallos} consulta(s) fallida(s). Revisa las Notificaciones de consulta.`
        : "Rama Judicial y Publicaciones Procesales actualizados.",
      totalFallos > 0 ? "error" : "ok"
    );
  }

  /* ══════════════════════════════════════════════════════════════
     ELIMINAR
  ══════════════════════════════════════════════════════════════ */
  async function eliminar(id) {
    if (!confirm("¿Eliminar este proceso del monitoreo?")) return;
    const client = getClient();
    const user = getUser();
    const s = todosLosSeguimientos.find(x => x.id === id);
    // Borrar primero los datos relacionados en otras secciones (Copiloto IA, etc.)
    // que se guardan aparte por radicado, para no dejar registros huérfanos.
    if (s?.radicado && user?.id) {
      try {
        await client.from("copiloto_consejos").delete().eq("user_id", user.id).eq("radicado", s.radicado);
      } catch (err) {
        console.error("[eliminar] No se pudieron borrar los consejos del Copiloto IA:", err);
      }
    }
    const { error } = await client.from("seguimientos").delete().eq("id", id);
    if (error) { showToast("Error al eliminar.", "error"); return; }
    todosLosSeguimientos = todosLosSeguimientos.filter(s => s.id !== id);
    delete actuacionesCache[id];
    delete publicacionesCache[id];
    delete actsPagina[id];
    delete pubsPagina[id];
    _ppBuscando.delete(id);
    pubsAbiertos.delete(id); _syncPubsStorage();
    renderKPIs();
    renderNavCounts();
    renderLista();
    showToast("Proceso eliminado.", "");
  }

  /* ══════════════════════════════════════════════════════════════
     POLLING
  ══════════════════════════════════════════════════════════════ */
  let refreshDbTimer = null;

  function iniciarPolling() {
    if (pollingTimer)   clearInterval(pollingTimer);
    if (refreshDbTimer) clearInterval(refreshDbTimer);

    // Polling pesado: consulta la Rama Judicial cada 6 horas
    pollingTimer = setInterval(() => {
      if (getUser() && todosLosSeguimientos.length) actualizarTodos(false);
    }, POLL_INTERVAL_MS);

    // Polling ligero: refresca sólo desde Supabase cada 10 minutos
    // (recoge cambios del cron automático sin llamar a la API de la RJ)
    refreshDbTimer = setInterval(async () => {
      if (getUser() && monitoreoActivo) {
        await cargarTodos();
        await cargarLogs();
        actualizarContadorLogs();
        if (filtroActivo === "notif_consulta") renderLogs();
      }
    }, REFRESH_DB_MS);

    // Refrescar también cuando el usuario vuelve a la pestaña
    document.addEventListener("visibilitychange", _onVisibilityChange);
  }

  async function _onVisibilityChange() {
    if (!document.hidden && getUser() && monitoreoActivo) {
      await cargarTodos();
      await cargarLogs();
      actualizarContadorLogs();
      if (filtroActivo === "notif_consulta") renderLogs();
    }
  }

  /* ══════════════════════════════════════════════════════════════
     SKELETONS
  ══════════════════════════════════════════════════════════════ */
  function skeletonCards(n) {
    return `<div class="mon-skeletons">${`<div class="mon-skel-card"><div class="mon-skel mon-skel-line w60"></div><div class="mon-skel mon-skel-line w40"></div><div class="mon-skel mon-skel-line w80"></div></div>`.repeat(n)}</div>`;
  }

  /* ══════════════════════════════════════════════════════════════
     UTILIDADES
  ══════════════════════════════════════════════════════════════ */
  function escHtml(s) {
    return String(s || "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  /* ══════════════════════════════════════════════════════════════
     ICON SET — SVG Lucide inline
  ══════════════════════════════════════════════════════════════ */
  const IC = {
    list:        `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
    bell:        `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
    check:       `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    clock:       `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    clockOff:    `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/><line x1="2" y1="2" x2="22" y2="22" stroke-width="1.5"/></svg>`,
    clockSm:     `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    folder:      `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
    search:      `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    refresh:     `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
    trash:       `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`,
    link:        `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
    plus:        `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    chevron:     `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
    chevLeft:    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
    chevRight:   `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
    building:    `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M3 9h6"/><path d="M3 15h6"/><path d="M15 9h3"/><path d="M15 15h3"/></svg>`,
    building2:   `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M3 9h6"/><path d="M3 15h6"/><path d="M15 9h3"/><path d="M15 15h3"/></svg>`,
    users:       `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    fileText:    `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    filePdf:     `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
    newspaper:   `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/></svg>`,
    checkCircle: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    scales:      `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><path d="M3 9h18"/><path d="M3 9l4.5 9S3 18 3 9z"/><path d="M21 9l-4.5 9S21 18 21 9z"/><path d="M9 21h6"/></svg>`,
    spinner:     `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:mon-spin 0.8s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
    logOut:      `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
    alertCircle: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };

  /* ══════════════════════════════════════════════════════════════
     NOTIFICACIONES DE CONSULTA — Supabase
  ══════════════════════════════════════════════════════════════ */
  async function cargarLogs() {
    const user = getUser();
    if (!user) return;
    try {
      const { data, error } = await getClient()
        .from("consulta_logs")
        .select("id, ts, total, fallos, error_msg")
        .eq("user_id", user.id)
        .order("ts", { ascending: false })
        .limit(200);
      if (!error) consultaLogs = (data || []).map(r => ({
        id: r.id, ts: r.ts, total: r.total, fallos: r.fallos, error: r.error_msg
      }));
    } catch(_) {}
  }

  async function guardarLog(entry) {
    const user = getUser();
    if (!user) return;
    // Actualización optimista: muestra en UI inmediatamente, sin esperar a Supabase
    const localEntry = { id: null, ts: entry.ts, total: entry.total, fallos: entry.fallos, error: entry.error || null };
    consultaLogs.unshift(localEntry);
    if (consultaLogs.length > 200) consultaLogs = consultaLogs.slice(0, 200);
    actualizarContadorLogs();
    if (filtroActivo === "notif_consulta") renderLogs();
    // Persistir en Supabase (en segundo plano — requiere que exista la tabla consulta_logs)
    try {
      const { data, error } = await getClient()
        .from("consulta_logs")
        .insert({
          user_id:   user.id,
          ts:        entry.ts,
          total:     entry.total,
          fallos:    entry.fallos,
          error_msg: entry.error || null,
        })
        .select("id, ts, total, fallos, error_msg")
        .single();
      if (!error && data) {
        localEntry.id = data.id;
        localEntry.ts = data.ts;
      }
    } catch(_) {}
  }

  function actualizarContadorLogs() {
    const el = document.getElementById("nav-count-notif_consulta");
    if (!el) return;
    // No mostrar números — solo mostrar "—" siempre (el historial sigue visible al entrar)
    el.textContent = "—";
    el.classList.remove("mon-nav-count-error");
  }

  function renderLogs() {
    const listEl  = document.getElementById("mon-list");
    const pagEl   = document.getElementById("mon-pagination");
    if (!listEl) return;

    if (consultaLogs.length === 0) {
      listEl.innerHTML = `
        <div class="mon-empty mon-empty-inline">
          ${IC.alertCircle}
          <p>No hay notificaciones de consulta registradas aún.<br>
          <small>El historial se guarda cada vez que se ejecuta una verificación de procesos.</small></p>
        </div>`;
      if (pagEl) pagEl.innerHTML = "";
      return;
    }

    const totalPags = Math.max(1, Math.ceil(consultaLogs.length / LOGS_PER_PAG));
    if (consultaLogsPag > totalPags) consultaLogsPag = totalPags;
    const desde = (consultaLogsPag - 1) * LOGS_PER_PAG;
    const pagina = consultaLogs.slice(desde, desde + LOGS_PER_PAG);

    listEl.innerHTML = `
      <div class="mon-logs-header">
        ${IC.alertCircle}
        <span>Historial de verificaciones — ${consultaLogs.length} registros</span>
        <button class="mon-logs-clear" id="btn-logs-clear" title="Limpiar historial">Limpiar todo</button>
      </div>
      <div class="mon-logs-list">
        ${pagina.map(log => {
          const fecha = new Date(log.ts).toLocaleString("es-CO", {
            dateStyle: "medium", timeStyle: "short"
          });
          const hayError = log.fallos > 0 || log.error;
          const clsFila  = hayError ? "mon-log-row mon-log-row-error" : "mon-log-row mon-log-row-ok";
          const dotCls   = hayError ? "mon-log-dot mon-log-dot-error" : "mon-log-dot mon-log-dot-ok";
          const titulo   = hayError
            ? `${log.fallos} de ${log.total} proceso(s) no pudieron verificarse`
            : `${log.total} proceso(s) verificados correctamente`;
          const detalle  = log.error
            ? `${log.error}`
            : (hayError ? "Uno o más procesos no se pudieron verificar (RJ o Publicaciones Procesales)." : "");
          return `
            <div class="${clsFila}">
              <div class="${dotCls}"></div>
              <div class="mon-log-body">
                <div class="mon-log-fecha">${fecha}</div>
                <div class="mon-log-titulo">${escHtml(titulo)}</div>
                ${detalle ? `<div class="mon-log-detalle">${escHtml(detalle)}</div>` : ""}
              </div>
              <div class="mon-log-badge ${hayError ? "mon-log-badge-error" : "mon-log-badge-ok"}">
                ${hayError ? "Error" : "OK"}
              </div>
            </div>`;
        }).join("")}
      </div>`;

    document.getElementById("btn-logs-clear")?.addEventListener("click", async () => {
      if (!confirm("¿Limpiar todo el historial de notificaciones de consulta?")) return;
      const user = getUser();
      if (user) {
        try { await getClient().from("consulta_logs").delete().eq("user_id", user.id); } catch(_) {}
      }
      consultaLogs = [];
      consultaLogsPag = 1;
      actualizarContadorLogs();
      renderLogs();
    });

    if (!pagEl) return;
    if (totalPags <= 1) { pagEl.innerHTML = ""; return; }

    const desde2 = desde + 1;
    const hasta  = Math.min(consultaLogsPag * LOGS_PER_PAG, consultaLogs.length);
    let pagBtns  = "";
    paginasVisibles(consultaLogsPag, totalPags).forEach(p => {
      if (p === "…") pagBtns += `<span class="mon-pag-ellipsis">…</span>`;
      else pagBtns += `<button class="mon-pag-btn ${p === consultaLogsPag ? "active" : ""}" data-logpag="${p}">${p}</button>`;
    });
    pagEl.innerHTML = `
      <div class="mon-pag-info">${desde2}–${hasta} de ${consultaLogs.length}</div>
      <div class="mon-pag-controls">
        <button class="mon-pag-btn mon-pag-nav" id="logpag-prev" ${consultaLogsPag === 1 ? "disabled" : ""}>${IC.chevLeft}</button>
        ${pagBtns}
        <button class="mon-pag-btn mon-pag-nav" id="logpag-next" ${consultaLogsPag === totalPags ? "disabled" : ""}>${IC.chevRight}</button>
      </div>`;
    pagEl.querySelectorAll(".mon-pag-btn[data-logpag]").forEach(btn =>
      btn.addEventListener("click", () => { consultaLogsPag = +btn.dataset.logpag; renderLogs(); scroll2List(); }));
    pagEl.querySelector("#logpag-prev")?.addEventListener("click", () => { consultaLogsPag--; renderLogs(); scroll2List(); });
    pagEl.querySelector("#logpag-next")?.addEventListener("click", () => { consultaLogsPag++; renderLogs(); scroll2List(); });
  }

  /* ── Portal de Publicaciones Procesales con aviso de posible caída ─*/
  window._cambiarPaginaItem = function(type, id, page) {
    if (type === "acts") {
      actsPagina[id] = page;
      renderActuaciones(id, actuacionesCache[id] || []);
    } else {
      pubsPagina[id] = page;
      renderPublicaciones(id, publicacionesCache[id] || []);
    }
  };

  /* ── Tooltip flotante global (evita clipping por overflow:hidden del card) ── */
  (function() {
    let tip;
    function getTip() {
      if (!tip) {
        tip = document.createElement("div");
        tip.id = "mon-tooltip-global";
        tip.style.cssText = "position:fixed;z-index:9999;background:#1e293b;color:#fff;font-size:0.72rem;line-height:1.45;font-weight:400;font-style:normal;padding:8px 11px;border-radius:7px;max-width:250px;pointer-events:none;opacity:0;transition:opacity 0.15s;text-transform:none;letter-spacing:0";
        document.body.appendChild(tip);
      }
      return tip;
    }
    document.addEventListener("mouseover", e => {
      const el = e.target.closest("[data-tip]");
      if (!el) return;
      const t = getTip();
      t.textContent = el.dataset.tip;
      t.style.opacity = "1";
    });
    document.addEventListener("mousemove", e => {
      const el = e.target.closest("[data-tip]");
      if (!el) { if (tip) tip.style.opacity = "0"; return; }
      const t = getTip();
      t.style.left = Math.max(8, Math.min(e.clientX - 125, window.innerWidth - 260)) + "px";
      t.style.top  = Math.max(8, e.clientY - t.offsetHeight - 12) + "px";
    });
    document.addEventListener("mouseout", e => { if (tip && !e.relatedTarget?.closest("[data-tip]")) tip.style.opacity = "0"; });
  })();

  window._abrirPortalPP = function (url, segId) {
    showToast(
      "Abriendo portal externo de Publicaciones Procesales. Si la página no carga, es un problema temporal del servidor de la Rama Judicial, no de nuestra plataforma.",
      ""
    );
    setTimeout(() => window.open(url || PP_PORTAL, "_blank", "noopener"), 800);
    if (segId && typeof window._marcarPPVista === "function") window._marcarPPVista(segId);
  };

  /**
   * Abre el PDF de una publicación procesal usando el Edge Function como proxy.
   * Usa getClient().functions.invoke() para que los headers de auth se añadan
   * automáticamente — sin depender de variables globales accesibles o --no-verify-jwt.
   */
  window._abrirPdfPP = async function (fileEntryId, fallbackUrl, btnEl) {
    const origHtml = btnEl ? btnEl.innerHTML : "";
    if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = `<span style="opacity:.7">Cargando…</span>`; }

    const restore = () => { if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = origHtml; } };

    /* Caso 1: URL directa de Liferay (get_file?uuid=) — no necesita auth */
    if (fallbackUrl && fallbackUrl.includes("get_file?uuid=")) {
      window.open(fallbackUrl, "_blank", "noopener");
      restore();
      return;
    }

    /* Caso 2: Proxy vía Edge Function con invoke() — auth automático */
    if (fileEntryId) {
      try {
        const client = getClient();
        /* Supabase JS v2 acepta query params incluidos en el nombre de la función */
        const { data, error } = await client.functions.invoke(
          `pp-buscar?pdf=${encodeURIComponent(fileEntryId)}`,
          { headers: { Accept: "application/pdf, application/json, */*" } }
        );

        if (error) throw new Error(error.message || "Error en el Edge Function");

        /* data es Blob (pdf) o JSON parseado */
        if (data instanceof Blob) {
          const ct = data.type || "";
          if (ct.includes("json") || ct.includes("text")) {
            /* JSON envuelto en Blob (Supabase lo hace a veces) */
            try {
              const json = JSON.parse(await data.text());
              if (json.url) { window.open(json.url, "_blank", "noopener"); restore(); return; }
              if (json.error) throw new Error(json.error);
            } catch (parseErr) { throw parseErr instanceof Error ? parseErr : new Error("Respuesta inesperada"); }
          }
          /* PDF como Blob */
          const blobUrl = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
          const a = document.createElement("a");
          a.href = blobUrl; a.target = "_blank"; a.rel = "noopener";
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
          restore(); return;
        }

        /* JSON directo */
        if (data && typeof data === "object") {
          if (data.url) { window.open(data.url, "_blank", "noopener"); restore(); return; }
          if (data.error) throw new Error(data.error);
        }
      } catch (e) {
        /* El Edge Function no pudo devolver el PDF.
           ── Estrategia de fallback en cascada ──
           1. fallbackUrl directa (si es URL de Liferay, no proxy Supabase)
           2. get_file?fileEntryId= — portal PP es público, mismo patrón que get_file?uuid=
           3. JSON-WS para resolver UUID (puede fallar por CORS)
           4. Portal PP general */
        const liferayBase = "https://publicacionesprocesales.ramajudicial.gov.co";

        /* Paso 1: fallbackUrl si es URL directa */
        const esDireccion = fallbackUrl &&
          fallbackUrl.startsWith("http") &&
          !fallbackUrl.includes("supabase.co/functions") &&
          !fallbackUrl.includes("?pdf=") &&
          !fallbackUrl.includes("?fileEntryId=");
        if (esDireccion) {
          window.open(fallbackUrl, "_blank", "noopener");
          restore(); return;
        }

        if (fileEntryId) {
          /* Paso 2: URL directa con fileEntryId — abrimos sin probe (CORS no aplica a window.open) */
          const byIdUrl = `${liferayBase}/c/document_library/get_file?groupId=6098902&fileEntryId=${encodeURIComponent(fileEntryId)}`;
          window.open(byIdUrl, "_blank", "noopener");
          restore(); return;

          /* Paso 3: JSON-WS para obtener UUID (puede fallar por CORS) */
          try {
            const jwsUrl = `${liferayBase}/api/jsonws/dlapp/get-file-entry/file-entry-id/${encodeURIComponent(fileEntryId)}`;
            const rJws = await fetch(jwsUrl, { headers: { Accept: "application/json" }, credentials: "omit" });
            if (rJws.ok) {
              const fe = await rJws.json();
              if (fe?.uuid) {
                const directUrl = `${liferayBase}/c/document_library/get_file?uuid=${encodeURIComponent(fe.uuid)}&groupId=${fe.groupId || 6098902}`;
                window.open(directUrl, "_blank", "noopener");
                restore(); return;
              }
            }
          } catch (_) {}
        }

        /* Paso 4: Portal PP general */
        showToast("No se pudo obtener el PDF. Abriendo el portal de Publicaciones Procesales.", "");
        setTimeout(() => window.open(PP_PORTAL, "_blank", "noopener"), 800);
        restore(); return;
      }
    }

    /* Caso 3: Fallback — solo abrir si es URL directa, nunca el proxy de Supabase */
    const esDireccionFinal = fallbackUrl &&
      fallbackUrl.startsWith("http") &&
      !fallbackUrl.includes("supabase.co/functions") &&
      !fallbackUrl.includes("?pdf=");
    if (esDireccionFinal) {
      window.open(fallbackUrl, "_blank", "noopener");
    } else {
      window.open(PP_PORTAL, "_blank", "noopener");
    }
    restore();
  };

  /* ══════════════════════════════════════════════════════════════
     CONSULTAR PP TRAS AGREGAR — gestiona skeleton de tarjeta nueva
  ══════════════════════════════════════════════════════════════ */
  async function _consultarPPYAgregarSkeleton(s) {
    if (!s?.id || !s?.id_proceso) return;
    try {
      let { pubs } = await consultarPublicacionesProcesales(s);
      /* Reintento con pausa, igual que en la versión del HTML inline */
      if (!pubs.length) {
        await new Promise(r => setTimeout(r, 3000));
        ({ pubs } = await consultarPublicacionesProcesales(s));
      }
      if (!pubs.length) {
        /* Sin publicaciones: quitar skeleton y mostrar tarjeta real */
        _ppBuscando.delete(s.id);
        renderLista();
        return;
      }
      publicacionesCache[s.id] = pubs;
      const cl = getClient(); if (!cl) { _ppBuscando.delete(s.id); renderLista(); return; }
      await cl.from("seguimientos").update({
        publicaciones_procesales: pubs,
        pub_count: pubs.length,
        tiene_publicacion_nueva: pubs.length > 0,
      }).eq("id", s.id);
      const idx = todosLosSeguimientos.findIndex(x => x.id === s.id);
      if (idx !== -1) Object.assign(todosLosSeguimientos[idx], { pub_count: pubs.length, tiene_publicacion_nueva: pubs.length > 0 });
      /* Quitar skeleton y re-renderizar con datos reales */
      _ppBuscando.delete(s.id);
      renderKPIs(); renderNavCounts(); renderLista();
      showToast(`${pubs.length} publicación${pubs.length !== 1 ? "es" : ""} procesal${pubs.length !== 1 ? "es" : ""} encontrada${pubs.length !== 1 ? "s" : ""}. ✓`, "ok");
    } catch (e) {
      /* En caso de error, quitar skeleton para no bloquear la UI */
      _ppBuscando.delete(s.id);
      renderLista();
      console.warn("[PP] Error buscando publicaciones al agregar:", e);
    }
  }

  /* ── Exposición global ──────────────────────────────────────*/
  window.iniciarMonitoreo   = iniciarMonitoreo;
  window.reiniciarMonitoreo = function () {
    monitoreoActivo       = false;
    todosLosSeguimientos  = [];
    actuacionesCache      = {};
    publicacionesCache    = {};
    filtroActivo          = "todos";
    busqueda              = "";
    paginaActual          = 1;
    consultaLogsPag       = 1;
    iniciarMonitoreo();
  };
})();
