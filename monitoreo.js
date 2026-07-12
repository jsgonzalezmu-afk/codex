/* ═══════════════════════════════════════════════════════════════
   MONITOREO JURÍDICO — Dashboard de procesos Rama Judicial
   Versión: 2025-07-12-v5  ← ACTUALIZADA CON match_confianza
   ───────────────────────────────────────────────────────────────
   Requiere: supabaseClient, currentUser, toast() — de app.js
   Llama directamente a la API pública de Rama Judicial (CORS: *)
   v5 — Integra match_confianza para validación de procesos
═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  console.log("%c[Minutas Legales] monitoreo.js v5 (2025-07-12) cargado ✓", "color:#22c55e;font-weight:bold");

  /* ── Constantes ──────────────────────────────────────────────*/
  const POLL_INTERVAL_MS  = 6 * 60 * 60 * 1000;
  const REFRESH_DB_MS     = 10 * 60 * 1000;
  const PAGE_SIZE         = 10;
  const INACTIVO_DIAS     = 90;
  const RJ_API    = "https://consultaprocesos.ramajudicial.gov.co:448/api/v2";
  const RJ_PORTAL = "https://consultaprocesos.ramajudicial.gov.co/Procesos/NumeroRadicacion";
  const PP_PORTAL = "https://publicacionesprocesales.ramajudicial.gov.co/web/publicaciones-procesales";

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
  let actuacionesCache  = {};
  let publicacionesCache = {};
  const _PUBS_KEY = "monitoreo_pubs_abiertos";
  let pubsAbiertos = new Set(
    (() => { try { return JSON.parse(sessionStorage.getItem(_PUBS_KEY) || "[]"); } catch { return []; } })()
  );
  function _syncPubsStorage() {
    try { sessionStorage.setItem(_PUBS_KEY, JSON.stringify([...pubsAbiertos])); } catch {}
  }
  let actsPagina        = {};
  let pubsPagina        = {};
  const PAGE_ITEMS      = 10;
  let _ppBuscando = new Set();

  let consultaLogs    = [];
  let consultaLogsPag = 1;
  const LOGS_PER_PAG  = 10;

  function getUser()       { try { return typeof currentUser         !== "undefined" ? currentUser         : null; } catch (_) { return null; } }
  function getClient()     { try { return typeof supabaseClient      !== "undefined" ? supabaseClient      : null; } catch (_) { return null; } }
  function getSuscripcion(){ try { return typeof suscripcionMonitoreo !== "undefined" ? suscripcionMonitoreo : null; } catch (_) { return null; } }
  function showToast(msg, type) { try { if (typeof toast === "function") toast(msg, type); } catch (_) {} }

  const LIMITE_BASICO = 20;

  function clasificar(s) {
    if (s.tiene_cambios) return "novedad";
    if (!s.ultima_actuacion) return "inactivo";
    const dias = (Date.now() - new Date(s.ultima_actuacion)) / 86400000;
    return dias <= INACTIVO_DIAS ? "activo" : "inactivo";
  }

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

  function renderNoAuth() {
    const c = document.getElementById("monitoreo-content");
    if (!c) return;
    monitoreoActivo = false;
    c.innerHTML = `
      <div class="mon-empty">
        <div class="mon-empty-icon">⚖️</div>
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
      .mon-card-foot-loading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .mon-card-radicado { font-family:var(--font-d,"Cormorant Garamond",Georgia,serif); font-size:1.05rem; }
      .mon-card-details .mon-detail { font-size:.72rem; }
      .mon-metric-label { text-transform:uppercase; letter-spacing:.06em; font-size:.6rem; }
      .mon-kpi-value { font-family:Arial, sans-serif; font-weight:700; color:var(--blue,#1a3a5c); }
      .mon-kpi.kpi-accent .mon-kpi-value { color:var(--gold-dk,#a8893a); }
      .mon-kpi.kpi-pub .mon-kpi-value { color:var(--amber,#d97706); }
      .mon-kpi.kpi-warn .mon-kpi-value { color:var(--green,#16a34a); }
      .mon-badge-review { display:inline-flex; align-items:center; gap:4px; padding:2px 9px; border-radius:99px; font-size:.61rem; font-weight:700; background:#fef2f2; color:#dc2626; border:1px solid #fca5a5; }
    `;
    document.head.appendChild(st);
  }

  function renderShell() {
    _inyectarEstilosSkeletonCard();
    const c = document.getElementById("monitoreo-content");
    if (!c) return;
    c.innerHTML = `
      <div class="mon-dashboard">
        <div class="mon-kpi-row" id="mon-kpi-row"></div>
        <div class="mon-panel">
          <aside class="mon-sidebar">
            <nav class="mon-nav" id="mon-nav">
              <button class="mon-nav-item active" data-filter="todos"><span class="mon-nav-count" id="nav-count-todos">—</span> Todos</button>
              <button class="mon-nav-item" data-filter="novedad"><span class="mon-nav-count" id="nav-count-novedad">—</span> Con novedades</button>
              <button class="mon-nav-item" data-filter="activo"><span class="mon-nav-count" id="nav-count-activo">—</span> Activos</button>
              <button class="mon-nav-item" data-filter="inactivo"><span class="mon-nav-count" id="nav-count-inactivo">—</span> Sin actividad</button>
            </nav>
            <div class="mon-sidebar-divider"></div>
            <button class="mon-sidebar-logout" id="mon-btn-logout">Cerrar sesión</button>
          </aside>
          <div class="mon-main">
            <div class="mon-toolbar">
              <div class="mon-search-wrap">
                <input type="search" id="mon-search" class="mon-search" placeholder="Buscar por radicado o alias…" autocomplete="off" />
              </div>
              <button class="mon-btn-refresh-all" id="btn-refresh-all">Actualizar todos</button>
            </div>
            <div id="mon-list"></div>
            <div class="mon-pagination" id="mon-pagination"></div>
          </div>
        </div>
      </div>`;
    bindShellEvents();
  }

  function bindShellEvents() {
    document.getElementById("btn-refresh-all")?.addEventListener("click", () => actualizarTodos(true));
    document.getElementById("mon-btn-logout")?.addEventListener("click", async () => {
      const client = getClient();
      if (client) await client.auth.signOut();
      window.location.reload();
    });
    const searchEl = document.getElementById("mon-search");
    if (searchEl) {
      let searchTimer;
      searchEl.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          busqueda = searchEl.value.trim().toLowerCase();
          paginaActual = 1;
          renderLista();
        }, 250);
      });
    }
    document.getElementById("mon-nav")?.addEventListener("click", e => {
      const item = e.target.closest(".mon-nav-item");
      if (!item) return;
      filtroActivo = item.dataset.filter;
      paginaActual = 1;
      document.querySelectorAll(".mon-nav-item").forEach(el => el.classList.toggle("active", el === item));
      renderLista();
    });
  }

  async function cargarTodos() {
    const client = getClient();
    const user   = getUser();
    if (!client || !user) return;

    const SEL_BASE = "id, radicado, alias, despacho, sujetos, id_proceso, ultima_actuacion, tiene_cambios, ultimo_chequeo, created_at, tiene_publicacion_nueva, pub_count, match_confianza";
    let rq = await client
      .from("seguimientos")
      .select(SEL_BASE + ", ultima_publicacion")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

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

  function renderKPIs() {
    const total      = todosLosSeguimientos.length;
    const novedad    = todosLosSeguimientos.filter(s => s.tiene_cambios).length;
    const activos    = todosLosSeguimientos.filter(s => clasificar(s) === "activo").length;
    const inactivos  = todosLosSeguimientos.filter(s => clasificar(s) === "inactivo").length;

    const el = document.getElementById("mon-kpi-row");
    if (!el) return;
    el.innerHTML = `
      <div class="mon-kpi"><div class="mon-kpi-value">${total}</div><div class="mon-kpi-label">Total</div></div>
      <div class="mon-kpi"><div class="mon-kpi-value">${novedad}</div><div class="mon-kpi-label">Con novedades</div></div>
      <div class="mon-kpi"><div class="mon-kpi-value">${activos}</div><div class="mon-kpi-label">Activos</div></div>
      <div class="mon-kpi"><div class="mon-kpi-value">${inactivos}</div><div class="mon-kpi-label">Sin actividad</div></div>`;
  }

  function renderNavCounts() {
    const counts = { todos: 0, novedad: 0, activo: 0, inactivo: 0 };
    todosLosSeguimientos.forEach(s => {
      counts.todos++;
      counts[clasificar(s)]++;
    });
    Object.keys(counts).forEach(k => {
      const el = document.getElementById(`nav-count-${k}`);
      if (el) el.textContent = counts[k];
    });
  }

  function datosFiltrados() {
    return todosLosSeguimientos.filter(s => {
      if (filtroActivo !== "todos" && clasificar(s) !== filtroActivo) return false;
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

    const filtrados = datosFiltrados();
    const totalPags = Math.max(1, Math.ceil(filtrados.length / PAGE_SIZE));
    if (paginaActual > totalPags) paginaActual = totalPags;
    const desde = (paginaActual - 1) * PAGE_SIZE;
    const pagina = filtrados.slice(desde, desde + PAGE_SIZE);

    if (filtrados.length === 0) {
      el.innerHTML = `<div class="mon-empty mon-empty-inline">
        ${todosLosSeguimientos.length === 0
          ? `<p>Aún no tienes procesos. Agrega uno para comenzar.</p>`
          : `<p>Ningún proceso coincide con tu búsqueda.</p>`}
      </div>`;
      return;
    }

    el.innerHTML = pagina.map(s => renderTarjeta(s)).join("");
    renderPaginacion(filtrados.length, totalPags);
  }

  function renderTarjeta(s) {
    const clase = clasificar(s);
    const estadoLabel = { novedad: "Con novedad", activo: "Activo", inactivo: "Sin actividad" }[clase];

    return `
    <div class="mon-card mon-card-${clase}" id="moncard-${s.id}">
      <div class="mon-card-body">
        <div class="mon-card-left">
          <div class="mon-card-top-row">
            <span class="mon-estado">${estadoLabel}</span>
            ${s.tiene_cambios ? `<span class="mon-badge-new">Nueva actuación</span>` : ""}
            ${s.match_confianza === 'baja' ? `<span class="mon-badge-review">⚠️ Revisar manualmente</span>` : ""}
          </div>
          <div class="mon-card-radicado">${s.radicado}</div>
          ${s.alias ? `<div class="mon-card-alias">${s.alias}</div>` : ""}
          ${s.despacho ? `<div class="mon-card-details">${s.despacho}</div>` : ""}
        </div>
      </div>
      <div class="mon-card-foot">
        <span class="mon-foot-meta">Última consulta: ${s.ultimo_chequeo ? new Date(s.ultimo_chequeo).toLocaleDateString() : "Nunca"}</span>
        <div class="mon-foot-toggles">
          <button class="mon-toggle-acts" id="btn-ver-${s.id}" data-id="${s.id}">Ver actuaciones</button>
          <button class="mon-action-btn" id="btn-refresh-${s.id}">Actualizar</button>
          <button class="mon-action-btn mon-action-danger" id="btn-delete-${s.id}">Eliminar</button>
        </div>
      </div>
      <div class="mon-actuaciones" id="actuaciones-${s.id}" style="display:none"></div>
    </div>`;
  }

  function renderPaginacion(total, totalPags) {
    const el = document.getElementById("mon-pagination");
    if (!el) return;
    if (totalPags <= 1) { el.innerHTML = ""; return; }

    let pagBtns = "";
    for (let i = 1; i <= totalPags; i++) {
      pagBtns += `<button class="mon-pag-btn ${i === paginaActual ? "active" : ""}" data-pag="${i}">${i}</button>`;
    }

    el.innerHTML = `<div class="mon-pag-controls">${pagBtns}</div>`;
    el.querySelectorAll(".mon-pag-btn").forEach(btn =>
      btn.addEventListener("click", () => { paginaActual = +btn.dataset.pag; renderLista(); }));
  }

  function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // ════════════════════════════════════════════
  // CONSULTAR RAMA JUDICIAL CON match_confianza
  // ════════════════════════════════════════════

  function extraerNumeroJuzgadoDeRadicado(radicado) {
    const r = (radicado || "").replace(/\D/g, "");
    if (r.length !== 23) return null;
    return parseInt(r.substring(10, 12), 10);
  }

  function extraerNumeroJuzgado(texto) {
    const m = (texto || "").match(/\b0*(\d+)\b/);
    return m ? parseInt(m[1], 10) : null;
  }

  function ordenarActuacionesRecientePrimero(actuaciones) {
    if (!Array.isArray(actuaciones) || actuaciones.length < 2) return actuaciones || [];
    return [...actuaciones].sort((a, b) => {
      const ta = a?.fechaActuacion ? new Date(a.fechaActuacion).getTime() : -Infinity;
      const tb = b?.fechaActuacion ? new Date(b.fechaActuacion).getTime() : -Infinity;
      return tb - ta;
    });
  }

  function despachoCoincide(despachoGuardado, despachoAPI, numJuzgadoEsperado) {
    if (!despachoAPI) return false;
    const norm = str => (str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
    const a = norm(despachoAPI);
    const g = norm(despachoGuardado || "");
    
    const numA = extraerNumeroJuzgado(a);
    const numG = extraerNumeroJuzgado(g);
    
    if (numJuzgadoEsperado !== null && numJuzgadoEsperado !== undefined) {
      return numA !== null && numA === numJuzgadoEsperado;
    }
    return numA !== null && numG !== null && numA === numG;
  }

  async function consultarRJ(radicado, despachoGuardado, sujetosGuardados) {
    try {
      const r = await fetch(
        `${RJ_API}/Procesos/Consulta/NumeroRadicacion?numero=${radicado}&SoloActivos=false&pagina=1`,
        { headers: RJ_HEADERS }
      );
      if (!r.ok) { showToast("Error consultando la Rama Judicial.", "error"); return null; }
      const d = await r.json();
      if (!d.procesos?.length) { showToast("No se encontró ningún proceso con ese radicado.", "error"); return null; }

      const numJuzgadoRad = extraerNumeroJuzgadoDeRadicado(radicado);
      let procesoCandidato = null;

      if (numJuzgadoRad !== null) {
        procesoCandidato = d.procesos.find(proc => {
          const numDespacho = extraerNumeroJuzgado(proc.despacho || "");
          return numDespacho === numJuzgadoRad;
        }) || null;
      }

      if (!procesoCandidato) procesoCandidato = d.procesos[0];

      let proceso = procesoCandidato;
      let actuaciones = [];
      let matchConfianza = "media";

      // Obtener actuaciones
      const rActPrincipal = await fetch(
        `${RJ_API}/Proceso/Actuaciones/${procesoCandidato.idProceso}?pagina=1`,
        { headers: RJ_HEADERS }
      );
      const dActPrincipal = rActPrincipal.ok ? await rActPrincipal.json() : {};
      actuaciones = Array.isArray(dActPrincipal.actuaciones) ? dActPrincipal.actuaciones
                 : Array.isArray(dActPrincipal) ? dActPrincipal : [];

      // ← NUEVO: Lógica de match_confianza
      if (d.procesos.length > 1 && despachoGuardado) {
        const conActuaciones = [];
        for (const proc of d.procesos) {
          const rA = await fetch(`${RJ_API}/Proceso/Actuaciones/${proc.idProceso}?pagina=1`, { headers: RJ_HEADERS });
          const dA = rA.ok ? await rA.json() : {};
          const acts = Array.isArray(dA.actuaciones) ? dA.actuaciones : Array.isArray(dA) ? dA : [];
          if (acts.length > 0) conActuaciones.push({ proc, acts });
        }

        if (conActuaciones.length > 1) {
          const coincide = conActuaciones.find(c =>
            despachoCoincide(despachoGuardado, c.proc.despacho || "", numJuzgadoRad)
          );
          if (coincide) {
            proceso = coincide.proc;
            actuaciones = coincide.acts;
            matchConfianza = "alta";
          } else {
            proceso = conActuaciones[0].proc;
            actuaciones = conActuaciones[0].acts;
            matchConfianza = "baja";
          }
        } else if (conActuaciones.length === 1) {
          proceso = conActuaciones[0].proc;
          actuaciones = conActuaciones[0].acts;
          matchConfianza = "alta";
        }
      } else if (d.procesos.length === 1) {
        matchConfianza = "alta";
      }

      return { proceso, actuaciones: ordenarActuacionesRecientePrimero(actuaciones), matchConfianza };
    } catch (err) {
      console.error(err);
      showToast("No se pudo conectar con la Rama Judicial.", "error");
      return null;
    }
  }

  async function onAgregarRadicado(e) {
    if (e) e.preventDefault();
    const raw = "23001400300520260071900"; // Para prueba rápida
    
    try {
      const resultado = await consultarRJ(raw, null, null);
      if (!resultado) return;

      const { proceso, actuaciones, matchConfianza } = resultado;
      const client = getClient();
      const user   = getUser();

      const { data, error } = await client
        .from("seguimientos")
        .insert({
          user_id:         user.id,
          radicado:        raw,
          alias:           null,
          nombre_proceso:  proceso.tipoProceso || null,
          despacho:        proceso.despacho || null,
          sujetos:         proceso.sujetosProcesales || null,
          id_proceso:      String(proceso.idProceso),
          actuaciones,
          ultima_actuacion: actuaciones[0]?.fechaActuacion || null,
          tiene_cambios:   false,
          ultimo_chequeo:  new Date().toISOString(),
          match_confianza: matchConfianza || "media",  // ← NUEVO
        })
        .select("*")
        .single();

      if (error) throw error;

      todosLosSeguimientos.unshift(data);
      renderLista();
      showToast("Proceso agregado.", "ok");
    } catch (err) {
      console.error(err);
      showToast("Error al agregar.", "error");
    }
  }

  async function actualizarTodos(manual = false) {
    if (!todosLosSeguimientos.length) {
      if (manual) showToast("No tienes procesos en seguimiento.", "");
      return;
    }
    showToast("Actualizando...", "");
  }

  async function eliminar(id) {
    if (!confirm("¿Eliminar este proceso?")) return;
    const client = getClient();
    await client.from("seguimientos").delete().eq("id", id);
    todosLosSeguimientos = todosLosSeguimientos.filter(s => s.id !== id);
    renderLista();
    showToast("Proceso eliminado.", "");
  }

  function iniciarPolling() {
    // Placeholder
  }

  async function cargarLogs() {
    // Placeholder
  }

  function actualizarContadorLogs() {
    // Placeholder
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
    iniciarMonitoreo();
  };
})();
