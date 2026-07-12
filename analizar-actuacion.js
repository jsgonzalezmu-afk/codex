/* ══════════════════════════════════════════════════════════════════
   COPILOTO PROCESAL IA — v3
   ──────────────────────────────────────────────────────────────────
   Módulo independiente. Solo agrega este archivo al HTML:
     <script src="analizar-actuacion.js"></script>

   Requiere en window:
     • geminiConfig.apiKey   → API key de Groq (del panel Admin)
     • minutasData           → catálogo (opcional, para sugerir minutas)
══════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  console.log("[CopilotoIA] Script cargado ✓");

  const GROQ_URL              = "https://api.groq.com/openai/v1/chat/completions";
  const GROQ_MODEL            = "llama-3.3-70b-versatile";
  const GROQ_MODEL_RAZONADOR  = "deepseek-r1-distill-llama-70b"; /* razona antes de responder */

  /* ── Prompt ─────────────────────────────────────────────────── */
  const SYSTEM_PROMPT = `Eres un asistente procesal experto en derecho colombiano. Tu función es analizar actuaciones judiciales y darle al abogado orientación CONCRETA, NORMATIVA y VERIFICABLE sobre qué debe hacer.

═══════════════════════════════════════════════════
REGLA 0 — LEE EL TÍTULO DEL AUTO ANTES DE TODO
═══════════════════════════════════════════════════
El TÍTULO del auto determina lo que ya ocurrió y lo que no.

"CONCEDE RECURSO DE APELACIÓN" → el abogado YA interpuso el recurso. El juzgado lo admitió.
  NUNCA digas "interponga el recurso" ni "sustente el recurso" — ya fue interpuesto.
  Lo que sigue depende de si el expediente está en tránsito o ya fue repartido (ver sección APELACIÓN CONCEDIDA).

"NIEGA RECURSO DE APELACIÓN" → el juzgado rechazó el recurso. Evalúa recurso de queja.
"ADMITE DEMANDA" → la demanda ya fue presentada y admitida.
"NOTIFICA" → una providencia previa está siendo notificada. Identifica cuál y qué recurso procede.

═══════════════════════════════════════════════════
REGLA CRÍTICA — QUIÉN ACTUÓ Y QUIÉN ES DESTINO
═══════════════════════════════════════════════════
El actor es el despacho ORIGEN. El destino aún no ha actuado.

"AUTO CONCEDE APELACIÓN … Despacho origen: JUZGADO 06 … Destino: TRIBUNAL / Oficina de apoyo"
  → Actuó: EL JUZGADO 06 (concedió). El Tribunal o la Oficina de apoyo son destino — no han actuado.
  → "Oficina de apoyo / Repartidor" es una oficina intermedia de tránsito hacia el reparto en el Tribunal.
     El expediente aún NO ha sido repartido al Tribunal. No corre ningún término todavía.

═══════════════════════════════════════════════════
APELACIÓN CONCEDIDA — PROTOCOLO OBLIGATORIO
═══════════════════════════════════════════════════
Cuando el auto dice "CONCEDE RECURSO DE APELACIÓN" o "CONCEDE APELACIÓN":

PASO 1 — Identifica el destino:

  CASO A · Destino = "Oficina de apoyo" / "Repartidor" / "Oficina de distribución" / código de reparto
    → El expediente está EN TRÁNSITO. NO ha sido repartido al Tribunal todavía.
    → NO corre ningún término de sustentación.
    → Acción AHORA: Monitorear el sistema de consulta del Tribunal (SAMAI o Consulta Nacional Unificada)
      hasta que aparezca el reparto y el nuevo radicado en el Tribunal.
    → Acción DESPUÉS DEL REPARTO: Presentar memorial de sustentación dentro del término legal
      (CPACA apelación sentencia: 10 días hábiles Art. 247 / CPACA apelación auto: 5 días Art. 245 /
       CGP: 3 días Art. 327).
    → alertaNivel: "media" (hay que estar pendiente, pero el término no corre aún).

  CASO B · Destino = directamente el Tribunal (ya repartido, hay nuevo radicado de segunda instancia)
    → El término de sustentación YA corre desde el reparto.
    → Acción INMEDIATA: Presentar memorial de sustentación ante el Tribunal dentro del término.
    → alertaNivel: "alta".

PASO 2 — Identifica el efecto del recurso:
  Efecto SUSPENSIVO: la sentencia o auto queda suspendido mientras el Tribunal decide.
  Efecto DEVOLUTIVO: el proceso sigue ejecutándose provisionalmente en primera instancia.

═══════════════════════════════════════════════════
SISTEMAS DE CONSULTA POR ESPECIALIDAD — OBLIGATORIO
═══════════════════════════════════════════════════
Para el campo "dondeVerificar", usa ÚNICAMENTE los sistemas correspondientes a la especialidad.
NUNCA recomiendes ir a "secretaría del despacho" para despachos ADMINISTRATIVOS — la gestión es digital.

ADMINISTRATIVO (Tribunales Administrativos / Consejo de Estado):
  • SAMAI — sistema principal de los despachos administrativos
  • Consulta Nacional Unificada → consultaunificada.ramajudicial.gov.co
  • TYBA → tyba.com.co (expedientes digitales administrativos)
  • SIUGJ — Sistema de Información Unificado de la Gestión Judicial
  • Rama Judicial → consultaprocesos.ramajudicial.gov.co (búsqueda por radicado)
  Ejemplos de uso: "SAMAI o Consulta Nacional Unificada → verificar reparto en el Tribunal Administrativo"

CIVIL / FAMILIA / LABORAL:
  • Rama Judicial → consultaprocesos.ramajudicial.gov.co
  • App móvil "Rama Judicial" → consulta de procesos por radicado
  • Justicia XXI (sistema interno de gestión del despacho)
  • Secretaría del juzgado (para procesos en papel o cuando el sistema no esté actualizado)

PENAL:
  • SPOA (Sistema Penal Oral Acusatorio)
  • Rama Judicial → consultaprocesos.ramajudicial.gov.co
  • Fiscalía General (para actuaciones con código F)

═══════════════════════════════════════════════════
NORMATIVA POR ESPECIALIDAD
═══════════════════════════════════════════════════
ADMINISTRATIVO (CPACA — Ley 1437/2011):
  Audiencia inicial → Art. 180 | Audiencia de pruebas → Art. 181
  Alegatos → Art. 182 | Audiencia de juzgamiento → Art. 183
  Apelación sentencia → Art. 247 (sustentación: 10 días hábiles desde reparto en el Tribunal)
  Apelación auto → Art. 245 (sustentación: 5 días hábiles desde reparto)
  Recurso de queja → Art. 246 | Casación → Art. 256 CE
  Notificación personal → Art. 197 | Por aviso → Art. 199
  Demanda → Art. 162–166 | Inadmisión → Art. 170 (subsanar: 10 días hábiles)
  Medidas cautelares → Art. 229–241 | Caducidad → Art. 164

CIVIL/FAMILIA (CGP — Ley 1564/2012):
  Audiencia inicial → Art. 372 | Audiencia de instrucción → Art. 373
  Apelación sentencia → Art. 327 (sustentación: 3 días en audiencia o por escrito)
  Apelación auto → Art. 322 | Recurso de reposición → Art. 318 (3 días)
  Notificación → Art. 290–303 | Traslado demanda → Art. 91 (20 días hábiles)
  Excepciones previas → Art. 100 (10 días) | Nulidades → Art. 132

LABORAL (CPT y PSSS — Decreto 2158/1948 mod. Ley 712/2001):
  Audiencia de trámite → Art. 77 CPT | Apelación → Art. 65–66 CPT
  Notificación → Art. 41 CPT | Interrogatorio → Art. 54 CPT

PENAL (CPP — Ley 906/2004):
  Audiencia preliminar → Art. 154 | Formulación cargos → Art. 286
  Preclusión → Art. 331 | Acusación → Art. 336
  Juicio oral → Art. 366 | Apelación → Art. 176–179

═══════════════════════════════════════════════════
PLAYBOOK POR TIPO DE ACTUACIÓN
═══════════════════════════════════════════════════

CONSTANCIA SECRETARIAL / ACTUACIÓN DE SECRETARÍA:
  - Si dice "pendiente fijar fecha audiencia" o similar: NO hay término corriendo.
    Acción: Hacer seguimiento periódico (cada 5–10 días hábiles) en el sistema de consulta correspondiente.
    fuentesLegales: norma que regula la audiencia pendiente.

ENVÍO A OTROS DESPACHOS — SIN RECURSO (REPARTO ORDINARIO):
  - Acción: Consultar el nuevo radicado y despacho asignado. Actualizar datos del proceso.
  - Verificar: Portal Rama Judicial o SAMAI (según especialidad) con el radicado original.

AUTO ADMITE DEMANDA:
  - Acción: Verificar notificación al demandado. Estar atento al término de traslado.
  - ADMINISTRATIVO: Verificar en SAMAI o Consulta Nacional Unificada.
  - CIVIL: Verificar en consultaprocesos.ramajudicial.gov.co.

AUTO INADMITE / RECHAZA DEMANDA:
  - Acción: Subsanar los defectos señalados dentro del término (CPACA Art. 170: 10 días hábiles).
  - Escrito: "Escrito de subsanación de demanda".

NOTIFICACIÓN (de auto o providencia):
  - Si te notifican a ti: verificar qué recurso procede y en qué término.
  - Si notifican al demandado: confirmar notificación; revisar si corre traslado.

TRASLADO DE ESCRITO / AUTO CORRE TRASLADO:
  - Acción: Presentar escrito de respuesta dentro del término del traslado indicado en el auto.

AUDIENCIA INICIAL (CPACA Art. 180):
  - Acción: Preparar alegatos de apertura, lista de pruebas, excepciones pendientes.
  - ADMINISTRATIVO: Verificar fecha en SAMAI. NO mencionar secretaría física.
  - Escrito sugerido: "Memorial de preparación de audiencia inicial" o "Solicitud de pruebas".

AUDIENCIA DE PRUEBAS (CPACA Art. 181 / CGP Art. 373):
  - Acción: Confirmar lista de testigos y peritos citados. Preparar interrogatorios.

SENTENCIA / FALLO:
  - Si favorable: solicitar ejecutoria. Evaluar medidas de ejecución si hay condena.
  - Si desfavorable: evaluar recurso de apelación.
    ADMINISTRATIVO: término 10 días hábiles desde notificación (CPACA Art. 247).
    CIVIL: 3 días desde notificación en audiencia (CGP Art. 327).

RECURSO DE QUEJA (el a-quo NIEGA la apelación):
  - Art. 246 CPACA | Art. 353 CGP.
  - Acción: Interponer queja ante el superior dentro de los 5 días hábiles siguientes a la notificación.

═══════════════════════════════════════════════════
REGLAS ANTI-ERROR — LECTURA DE ACTUACIONES
═══════════════════════════════════════════════════
1. "CONCEDE RECURSO" = el abogado ya lo interpuso. PROHIBIDO decir "interponga" o "sustente ahora".
2. "NIEGA RECURSO" = evalúa recurso de queja. No confundas con "concede".
3. Destino "Oficina de apoyo" / "Repartidor" = tránsito. El término NO ha empezado.
4. El término de sustentación empieza desde el REPARTO en el ad-quem, no desde el auto que concede.
5. Para ADMINISTRATIVO: usa SAMAI / TYBA / Consulta Nacional Unificada. NUNCA "secretaría del despacho".
6. NUNCA inventes artículos. Si no tienes certeza, escribe "verificar en [Ley/Código]".
7. Si hay término corriendo, alertaNivel DEBE ser "alta". No uses "media" para términos urgentes.
8. pasoASeguir: mínimo 4 oraciones. Verbo imperativo. Qué hacer, ante quién, cuándo, con qué escrito.

═══════════════════════════════════════════════════
CAMPOS DE RESPUESTA
═══════════════════════════════════════════════════
pasoASeguir: OBLIGATORIO. Mínimo 4 oraciones. Qué hacer, ante quién, en qué término, con qué escrito.
fuentesLegales: 2 a 5 strings. Formato: "Art. X LEY — descripción de para qué sirve".
dondeVerificar: 1 o 2 fuentes del sistema correcto según especialidad (ver sección SISTEMAS DE CONSULTA).
termino: plazo exacto con norma. Ej: "10 días hábiles desde reparto (Art. 247 CPACA)". Si no hay: "Sin término inmediato — monitorear reparto".
alertaNivel: "alta" = término corriendo / acción que no puede esperar. "media" = actuar pronto, sin urgencia inmediata. "baja" = solo conocimiento.
tipoJuzgado: Civil | Laboral | Administrativo | Familia | Penal | Otro
etapaProcesal: nombre corto y preciso.
documentoSugerido: nombre exacto del escrito, o null.

Responde SOLO con JSON válido, sin texto antes ni después:
{
  "tipoJuzgado": "...",
  "etapaProcesal": "...",
  "pasoASeguir": "...",
  "fuentesLegales": ["Art. X LEY — descripción", "Art. Y LEY — descripción"],
  "dondeVerificar": "...",
  "termino": "...",
  "alertaNivel": "alta | media | baja",
  "documentoSugerido": "... | null"
}`;

  /* ── Prompt de razonamiento (Fase 1) ───────────────────────── */
  const REASONING_PROMPT = `Eres un abogado procesalista colombiano con 25 años de experiencia en jurisdicción administrativa, civil y laboral. Se te presenta una actuación judicial. PRIMERO infórmate bien leyendo cada dato disponible; SOLO ENTONCES da tu análisis.

PROTOCOLO DE ANÁLISIS OBLIGATORIO — responde CADA punto antes de concluir:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PASO 0 · LEE EL TÍTULO Y LOS METADATOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ¿Qué dice EXACTAMENTE el título del auto? (CONCEDE, NIEGA, ADMITE, NOTIFICA, FIJA FECHA, etc.)
- ¿Cuál es el Despacho ORIGEN? ¿Cuál es el DESTINO?
  → El ORIGEN actuó. El DESTINO aún no ha actuado.
  → Si el DESTINO es "Oficina de apoyo", "Repartidor" o "Oficina de distribución":
    el expediente está en TRÁNSITO. No ha llegado al tribunal todavía. NO corre ningún término.
- ¿Cuál es el Motivo del reparto? (Apelación sentencia, apelación auto, reparto ordinario, etc.)
- ¿Cuál es el EFECTO si aplica? (Suspensivo = sentencia suspendida / Devolutivo = ejecuta provisionalmente)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PASO 1 · ¿QUÉ YA HIZO EL ABOGADO?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Deduce de la actuación qué acciones YA tomó el abogado antes de este momento:
- "CONCEDE RECURSO DE APELACIÓN" → el abogado YA interpuso la apelación. No decirle que la interponga ni que la sustente antes de tiempo.
- "ADMITE DEMANDA" → la demanda ya fue radicada. No decirle que la presente.
- "NOTIFICA AUTO" → una providencia anterior ya se expidió. El abogado debe actuar sobre esa providencia.
Establece claramente: "El abogado YA realizó X. Lo pendiente es Y."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PASO 2 · ESPECIALIDAD Y CÓDIGO PROCESAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ¿El despacho es Administrativo, Civil, Laboral, Familia o Penal?
- ¿Qué código procesal aplica? (CPACA, CGP, CPT, CPP)
- Para ADMINISTRATIVO: los sistemas de consulta son SAMAI, TYBA, Consulta Nacional Unificada, SIUGJ.
  NUNCA recomendar ir a "secretaría del juzgado" — la gestión administrativa es digital.
- Para CIVIL/LABORAL: consultaprocesos.ramajudicial.gov.co, app Rama Judicial, Justicia XXI.
- Para PENAL: SIICCA, Portal Rama Judicial.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PASO 3 · TÉRMINOS Y PLAZOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ¿Hay algún término corriendo AHORA MISMO desde esta actuación?
  → Si el destino es "Oficina de apoyo" / tránsito: NO corre ningún término todavía.
  → El término de sustentación de apelación corre desde el REPARTO en el ad-quem, NO desde el auto que concede.
- ¿Desde qué momento exacto empieza el término? ¿Días hábiles o calendario?
- Artículo EXACTO con número y ley. Si no tienes certeza, escribe: "verificar en [código]".
  Referencias clave:
  · CPACA Art. 247 → sustentación apelación SENTENCIA: 10 días hábiles desde reparto en Tribunal.
  · CPACA Art. 245 → sustentación apelación AUTO: 5 días hábiles desde reparto.
  · CGP Art. 327 → sustentación apelación sentencia: 3 días.
  · CPACA Art. 246 → recurso de queja: 5 días hábiles.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PASO 4 · ETAPA PROCESAL Y CONTEXTO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ¿En qué etapa está el proceso? (Primera instancia, segunda instancia, ejecución, etc.)
- ¿Qué viene inmediatamente después de este acto?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PASO 5 · RIESGOS SI NO SE ACTÚA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ¿Qué consecuencia jurídica tiene no actuar en término? (preclusión, inadmisión, ejecutoria, deserción)
- ¿La urgencia es inmediata (término corriendo) o futura (hay que monitorear)?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PASO 6 · ACCIÓN CONCRETA Y SISTEMA DE VERIFICACIÓN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ¿Qué debe hacer el abogado AHORA? ¿Qué escrito exacto? ¿Ante quién? ¿En qué plazo?
- Si no hay acción inmediata: ¿en qué sistema debe monitorear y con qué frecuencia?
- Para ADMINISTRATIVO: SAMAI o Consulta Nacional Unificada. NUNCA "secretaría física".
- Si no aplica acción inmediata: sé específico sobre CUÁNDO se activará el término y cómo saberlo.

REGLA FINAL: La precisión vale más que la exhaustividad. Si tienes duda sobre un artículo, dilo. Un artículo incorrecto puede perjudicar al cliente. Responde en español técnico-jurídico.`;

  /* ── API key — busca en geminiConfig (index.html) o en Supabase (monitoreo.html) */
  let _apiKeyCache = null;

  async function getApiKey() {
    /* 1. Ya cargada en caché */
    if (_apiKeyCache) return _apiKeyCache;

    /* 2. Disponible desde app.js (cuando se usa en index.html) */
    try {
      const k = window.geminiConfig && window.geminiConfig.apiKey;
      if (k) { _apiKeyCache = k; return k; }
    } catch (_) {}

    /* 3. Cargar desde Supabase (cuando se usa en monitoreo.html) */
    try {
      const client = window.supabaseClient ||
        (window.supabase && window.supabase.createClient &&
          window.supabase.createClient(
            document.querySelector("script[data-sb-url]")?.dataset.sbUrl || "",
            document.querySelector("script[data-sb-key]")?.dataset.sbKey || ""
          ));
      if (!client) return null;
      const { data, error } = await client
        .from("config")
        .select("api_key")
        .eq("id", "openai")
        .single();
      if (!error && data?.api_key) {
        _apiKeyCache = data.api_key;
        return _apiKeyCache;
      }
    } catch (_) {}

    return null;
  }

  function esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function encontrarMinuta(doc) {
    if (!doc) return null;
    const minutas = Array.isArray(window.minutasData) ? window.minutasData : [];
    if (!minutas.length) return null;
    const palabras = doc.toLowerCase().split(/\s+/).filter(p => p.length > 3);
    let mejor = null, top = 0;
    for (const m of minutas) {
      const txt = [m.nombre, m.descripcion, m.categoria].filter(Boolean).join(" ").toLowerCase();
      let pts = 0; palabras.forEach(p => { if (txt.includes(p)) pts++; });
      if (pts > top) { top = pts; mejor = m; }
    }
    return top >= 1 ? mejor : null;
  }

  /* ── SVG del botón Copiloto ─────────────────────────────────── */
  const SVG_COPILOTO = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
    stroke-linejoin="round" style="flex-shrink:0;vertical-align:middle">
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1
      0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1
      .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1
      0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0
      1-.963 0z"/>
    <path d="M20 3v4M22 5h-4M4 17v2M5 18H3"/>
  </svg>`;

  /* Lee despacho y radicado — acepta el card directamente o un hijo */
  function leerContexto(el) {
    const card = el.classList?.contains("mon-card") ? el : el.closest(".mon-card");
    if (!card) return { despacho: "", radicado: "" };
    const details = card.querySelectorAll(".mon-card-details .mon-detail");
    let despacho = "";
    details.forEach(el => {
      const t = el.textContent.trim();
      // El despacho es el primer detail — strip cualquier ícono/símbolo del inicio
      if (!despacho && t.length > 3) {
        const m = t.match(/[A-ZÁÉÍÓÚÜÑA-Z0-9].*/i);
        despacho = m ? m[0].trim() : t.trim();
      }
    });
    const radicado = (card.querySelector(".mon-card-radicado")?.textContent || "").trim();
    return { despacho, radicado };
  }

  /* ── Llamada a Groq — helper ───────────────────────────────── */
  async function _llamarGroq(apiKey, modelo, messages, extra = {}) {
    let res;
    try {
      res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: modelo, messages, ...extra }),
      });
    } catch (_) {
      throw new Error("Sin conexión con el servicio de IA. Verifica tu red.");
    }
    if (!res.ok) {
      if (res.status === 401) throw new Error("API key de Groq inválida o expirada.");
      if (res.status === 429) throw new Error("Límite de consultas alcanzado. Espera un momento.");
      throw new Error(`Error de IA (${res.status}). Intenta de nuevo.`);
    }
    const json = await res.json();
    return json?.choices?.[0]?.message?.content ?? "";
  }

  /* ── Análisis en dos fases ──────────────────────────────────── */
  /*   onProgreso(fase): "investigando" | "redactando"            */
  async function analizarTexto({ textoActuacion, tipoDespacho, radicado }, onProgreso = null) {
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error(
      "API key de Groq no configurada. Ve al panel Admin → Configuración IA."
    );

    const ctx = [
      tipoDespacho ? `Despacho: ${tipoDespacho}` : null,
      radicado     ? `Radicado: ${radicado}`      : null,
    ].filter(Boolean).join(" | ");

    const inputUsuario = ctx
      ? `${ctx}\n\nActuación:\n${textoActuacion.trim()}`
      : `Actuación:\n${textoActuacion.trim()}`;

    /* ── FASE 1: Razonamiento profundo (modelo de razonamiento) ── */
    if (onProgreso) onProgreso("investigando");
    let analisisPrevio = "";
    try {
      analisisPrevio = await _llamarGroq(
        apiKey,
        GROQ_MODEL_RAZONADOR,
        [
          { role: "system", content: REASONING_PROMPT },
          { role: "user",   content: inputUsuario },
        ],
        { temperature: 0.4, max_tokens: 2048 }
      );
      /* Quitar bloques <think>…</think> del modelo DeepSeek — son internos */
      analisisPrevio = analisisPrevio.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    } catch (err) {
      /* Si falla la fase de razonamiento, continuar sin ella */
      console.warn("[CopilotoIA] Fase 1 (razonamiento) falló:", err.message);
    }

    /* ── FASE 2: Respuesta estructurada (modelo versátil) ────── */
    if (onProgreso) onProgreso("redactando");
    const msgUsuarioFinal = analisisPrevio
      ? `${inputUsuario}\n\n---ANÁLISIS_JURÍDICO (razonamiento previo de apoyo)---\n${analisisPrevio}`
      : inputUsuario;

    const contenido = await _llamarGroq(
      apiKey,
      GROQ_MODEL,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: msgUsuarioFinal },
      ],
      { temperature: 0.1, max_tokens: 1024, response_format: { type: "json_object" } }
    );

    let a;
    try { a = JSON.parse(contenido); }
    catch (_) { throw new Error("Respuesta inesperada de la IA. Intenta de nuevo."); }

    return {
      tipoJuzgado:       a.tipoJuzgado                         || "No identificado",
      etapaProcesal:     a.etapaProcesal                       || "No identificada",
      pasoASeguir:       a.pasoASeguir                         || "",
      fuentesLegales:    Array.isArray(a.fuentesLegales) ? a.fuentesLegales : [],
      dondeVerificar:    a.dondeVerificar                      || "",
      termino:           a.termino                             || "",
      alertaNivel:       a.alertaNivel                         || "media",
      minutaRelacionada: encontrarMinuta(a.documentoSugerido   || null),
    };
  }

  /* ── Render de la tarjeta resultado ────────────────────────── */
  function renderResultado(res, div) {
    const minHTML = res.minutaRelacionada
      ? `<div class="aa-minuta">
           <span class="aa-minuta-label">Escrito a preparar</span>
           <button class="btn btn-accent btn-sm"
             onclick="abrirMinuta('${esc(res.minutaRelacionada.id)}')">
             ${SVG_DOC} ${esc(res.minutaRelacionada.nombre)}
           </button>
         </div>` : "";

    const hayTermino = res.termino &&
      !res.termino.toLowerCase().includes("sin término");
    const terminoHTML = hayTermino
      ? `<div class="aa-termino-box">
           <span class="aa-termino-icon">${SVG_RELOJ}</span>
           <div>
             <span class="aa-label">Término</span>
             <p class="aa-termino-texto">${esc(res.termino)}</p>
           </div>
         </div>` : "";

    const fuentesHTML = res.fuentesLegales.length
      ? `<div class="aa-fuentes">
           <span class="aa-label">Fundamento legal</span>
           <ul class="aa-fuentes-list">
             ${res.fuentesLegales.map(f => `<li>${SVG_LISTA} ${esc(f)}</li>`).join("")}
           </ul>
         </div>` : "";

    const verificarHTML = res.dondeVerificar
      ? `<div class="aa-verificar-box">
           <span class="aa-verificar-icon">${SVG_LUPA}</span>
           <div>
             <span class="aa-label">Dónde verificar</span>
             <p class="aa-verificar-texto">${esc(res.dondeVerificar)}</p>
           </div>
         </div>` : "";

    const alertaColor = { alta: "#b03a2e", media: "#a8893a", baja: "#2e7d32" };
    const alertaSVG   = { alta: SVG_ALERTA, media: SVG_DOT_MEDIA, baja: SVG_DOT_BAJA };
    const alertaTxt   = { alta: "Urgente", media: "Acción requerida", baja: "Conocimiento" };
    const nivel = res.alertaNivel || "media";

    div.innerHTML = `
      <div class="aa-card">
        <div class="aa-meta">
          <span class="aa-badge aa-badge-juzgado">${esc(res.tipoJuzgado)}</span>
          <span class="aa-badge aa-badge-etapa">${esc(res.etapaProcesal)}</span>
          <span class="aa-badge aa-badge-alerta" style="background:${alertaColor[nivel]}18;color:${alertaColor[nivel]};border:1px solid ${alertaColor[nivel]}44">
            ${alertaSVG[nivel]} ${alertaTxt[nivel]}
          </span>
        </div>

        <div class="aa-paso-label">Paso a seguir</div>
        <div class="aa-consejo-box">
          <span class="aa-consejo-icon">${SVG_BALANZA}</span>
          <span class="aa-consejo-texto">${esc(res.pasoASeguir)}</span>
        </div>

        ${terminoHTML}
        ${fuentesHTML}
        ${verificarHTML}
        ${minHTML}

        <p class="aa-disclaimer">
          ${SVG_ALERTA} Generado por IA. Verifica siempre los artículos citados con la norma vigente antes de actuar.
        </p>
      </div>`;
  }

  /* ── Obtener texto de la última actuación de un card ────────── */
  async function obtenerTextoActuacion(card) {
    const actuPanel = card.querySelector(".mon-actuaciones");

    const leerFila = () => {
      const row = actuPanel?.querySelector(".mon-act-row");
      if (!row) return null;
      const nombre = (row.querySelector(".mon-act-nombre")?.textContent || "").trim();
      const anot   = (row.querySelector(".mon-act-anot")?.textContent   || "").trim();
      return [nombre, anot].filter(Boolean).join("\n") || null;
    };

    /* Ya hay filas cargadas */
    const ya = leerFila();
    if (ya) return ya;

    /* Disparar "Ver actuaciones" y esperar hasta 6 s */
    const verBtn = card.querySelector(".mon-toggle-acts");
    if (verBtn) verBtn.click();
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 100));
      const t = leerFila();
      if (t) return t;
    }
    return null;
  }

  /* ── Almacén global de consejos ─────────────────────────────── */
  /* Estructura: { [radicado]: { radicado, despacho, consejos: [{ id, resultado, ts }] } } */
  window._copilotoConsejos = window._copilotoConsejos || {};

  /* ── Estado de navegación (carpetas / paginación) ───────────── */
  let _vistaRadicadoActual = null;  // null = lista carpetas | string = radicado abierto
  let _paginaConsejo       = 0;     // índice base-0 dentro de la carpeta
  let _paginaCarpetas      = 0;     // página actual en la lista de carpetas
  const CARPETAS_POR_PAG   = 10;

  /* ── Ícono carpeta ──────────────────────────────────────────── */
  const SVG_CARPETA = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>`;

  /* ── SVGs de iconos para la tarjeta resultado ───────────────── */
  const _ico = (path, w = 15) =>
    `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round" style="flex-shrink:0;vertical-align:middle">${path}</svg>`;

  /* Balanza — paso a seguir */
  const SVG_BALANZA = _ico(
    `<path d="M12 3v18M5 6l7-3 7 3M5 6c0 3.3-1.3 6-3 7.5 1.7 1.5 3 4.2 3 7.5h14c0-3.3 1.3-6 3-7.5C20.3 12 19 9.3 19 6"/>`,
    16
  );

  /* Reloj — término */
  const SVG_RELOJ = _ico(
    `<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/>`,
    15
  );

  /* Lista/artículo — fuentes legales */
  const SVG_LISTA = _ico(
    `<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
     <rect x="9" y="3" width="6" height="4" rx="1"/>
     <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>`,
    15
  );

  /* Lupa — dónde verificar */
  const SVG_LUPA = _ico(
    `<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>`,
    15
  );

  /* Documento — escrito/minuta */
  const SVG_DOC = _ico(
    `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
     <polyline points="14 2 14 8 20 8"/>
     <line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/>`,
    15
  );

  /* Triángulo advertencia — disclaimer y alerta alta */
  const SVG_ALERTA = _ico(
    `<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
     <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
    14
  );

  /* Círculo sólido — alerta media */
  const SVG_DOT_MEDIA = _ico(
    `<circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/>`,
    10
  );

  /* Círculo vacío — alerta baja */
  const SVG_DOT_BAJA = _ico(
    `<circle cx="12" cy="12" r="7"/>`,
    10
  );

  /* Papelera — botón eliminar */
  const SVG_TRASH = _ico(
    `<polyline points="3 6 5 6 21 6"/>
     <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
     <path d="M10 11v6M14 11v6"/>
     <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>`,
    15
  );

  /* ══════════════════════════════════════════════════════════════
     PERSISTENCIA — Supabase
  ══════════════════════════════════════════════════════════════ */
  function _getClient() {
    return window.supabaseClient || null;
  }

  async function _getUser() {
    const client = _getClient();
    if (!client) return null;
    try {
      const { data } = await client.auth.getSession();
      return data?.session?.user || null;
    } catch (_) { return null; }
  }

  async function cargarConsejosSupabase() {
    try {
      const client = _getClient();
      if (!client) return;
      const user = await _getUser();
      if (!user) return;

      const { data, error } = await client
        .from("copiloto_consejos")
        .select("id, radicado, despacho, resultado, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });

      if (error) {
        console.warn("[CopilotoIA] Error cargando consejos:", error.message);
        return;
      }

      window._copilotoConsejos = {};
      (data || []).forEach(row => {
        const clave = row.radicado || row.id;
        if (!window._copilotoConsejos[clave]) {
          window._copilotoConsejos[clave] = {
            radicado: row.radicado,
            despacho: row.despacho,
            consejos: [],
          };
        }
        window._copilotoConsejos[clave].consejos.push({
          id:        row.id,
          resultado: row.resultado,
          ts: new Date(row.created_at).toLocaleString("es-CO", {
            dateStyle: "short", timeStyle: "short",
          }),
        });
      });
      actualizarContadorNav();
    } catch (err) {
      console.warn("[CopilotoIA] cargarConsejosSupabase:", err);
    }
  }

  async function guardarConsejoSupabase(radicado, despacho, resultado) {
    try {
      const client = _getClient();
      if (!client) return null;
      const user = await _getUser();
      if (!user) return null;

      const { data, error } = await client
        .from("copiloto_consejos")
        .insert({ user_id: user.id, radicado, despacho, resultado })
        .select("id, created_at")
        .single();

      if (error) { console.warn("[CopilotoIA] Error guardando consejo:", error.message); return null; }
      return data;
    } catch (err) {
      console.warn("[CopilotoIA] guardarConsejoSupabase:", err);
      return null;
    }
  }

  /* Elimina una lista de IDs en UNA sola consulta (.in) */
  async function _eliminarConsejosDB(ids) {
    const limpios = (ids || []).filter(Boolean);
    if (!limpios.length) return true;
    try {
      const client = _getClient();
      if (!client) return false;
      const { error } = await client
        .from("copiloto_consejos")
        .delete()
        .in("id", limpios);
      if (error) { console.warn("[CopilotoIA] Error al eliminar consejos:", error.message); return false; }
      return true;
    } catch (err) {
      console.warn("[CopilotoIA] _eliminarConsejosDB:", err);
      return false;
    }
  }

  /* Elimina TODOS los consejos del usuario en una sola consulta */
  async function _eliminarTodosDB() {
    try {
      const client = _getClient();
      if (!client) return false;
      const user = await _getUser();
      if (!user) return false;
      const { error } = await client
        .from("copiloto_consejos")
        .delete()
        .eq("user_id", user.id);
      if (error) { console.warn("[CopilotoIA] Error al eliminar todos:", error.message); return false; }
      return true;
    } catch (err) {
      console.warn("[CopilotoIA] _eliminarTodosDB:", err);
      return false;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     VISTA — contenedor
  ══════════════════════════════════════════════════════════════ */
  function obtenerOCrearVista() {
    let vista = document.getElementById("aa-vista-consejos");
    if (vista) return vista;
    vista = document.createElement("div");
    vista.id = "aa-vista-consejos";
    vista.style.display = "none";
    const contenedor = document.querySelector(".mon-main")
      || document.getElementById("monitoreo-content")
      || document.body;
    contenedor.appendChild(vista);
    return vista;
  }

  /* ══════════════════════════════════════════════════════════════
     NIVEL 1 — Lista de carpetas (un radicado = una carpeta)
  ══════════════════════════════════════════════════════════════ */
  function renderCarpetas(vista) {
    const mapa     = window._copilotoConsejos;
    const entradas = Object.entries(mapa);   // [ [clave, entrada], … ]

    if (!entradas.length) {
      vista.innerHTML = `
        <div class="aa-vista-empty">
          ${SVG_COPILOTO}
          <p>Aún no hay consejos generados.</p>
          <p class="aa-vista-empty-hint">Haz clic en <strong>Ayúdate con nuestro Copiloto IA</strong>
          en cualquier proceso para generar el primer análisis.</p>
        </div>`;
      return;
    }

    const totalConsejos  = entradas.reduce((s, [, e]) => s + e.consejos.length, 0);
    const totalPags      = Math.ceil(entradas.length / CARPETAS_POR_PAG);
    const pagActual      = Math.max(0, Math.min(_paginaCarpetas, totalPags - 1));
    const inicio         = pagActual * CARPETAS_POR_PAG;
    const pagina         = entradas.slice(inicio, inicio + CARPETAS_POR_PAG);

    vista.innerHTML = `
      <div class="aa-vista-header">
        <div class="aa-vista-header-left">
          ${SVG_COPILOTO}
          <div>
            <h2 class="aa-vista-titulo">Consejos IA Copilot</h2>
            <p class="aa-vista-sub">${entradas.length} proceso${entradas.length !== 1 ? "s" : ""}
              · ${totalConsejos} consejo${totalConsejos !== 1 ? "s" : ""} guardado${totalConsejos !== 1 ? "s" : ""}</p>
          </div>
        </div>
        <button class="aa-vista-limpiar" id="aa-btn-limpiar">✕ Limpiar todo</button>
      </div>
      <div class="aa-carpetas-grid" id="aa-carpetas-grid"></div>
      ${totalPags > 1 ? `
      <div class="aa-paginador-carpetas">
        <button class="aa-pag-btn" id="aa-carp-ant" ${pagActual <= 0 ? "disabled" : ""}>‹ Anterior</button>
        <span class="aa-pag-info">Página ${pagActual + 1} de ${totalPags}</span>
        <button class="aa-pag-btn" id="aa-carp-sig" ${pagActual >= totalPags - 1 ? "disabled" : ""}>Siguiente ›</button>
      </div>` : ""}`;

    document.getElementById("aa-btn-limpiar")?.addEventListener("click", async () => {
      if (!confirm("¿Eliminar TODOS los consejos guardados? Esta acción no se puede deshacer.")) return;
      await _eliminarTodosDB();          /* una sola consulta DELETE por user_id */
      window._copilotoConsejos = {};
      _paginaCarpetas = 0;
      actualizarContadorNav();
      renderCarpetas(vista);
    });

    document.getElementById("aa-carp-ant")?.addEventListener("click", () => {
      _paginaCarpetas = pagActual - 1;
      renderCarpetas(vista);
    });
    document.getElementById("aa-carp-sig")?.addEventListener("click", () => {
      _paginaCarpetas = pagActual + 1;
      renderCarpetas(vista);
    });

    const grid = document.getElementById("aa-carpetas-grid");
    pagina.forEach(([clave, entrada]) => {
      const ult   = entrada.consejos[entrada.consejos.length - 1];
      const card  = document.createElement("button");
      card.className = "aa-carpeta-card";
      card.innerHTML = `
        <div class="aa-carpeta-icon">${SVG_CARPETA}</div>
        <div class="aa-carpeta-body">
          <div class="aa-carpeta-rad">${esc(entrada.radicado || clave)}</div>
          ${entrada.despacho ? `<div class="aa-carpeta-desp">${esc(entrada.despacho)}</div>` : ""}
          <div class="aa-carpeta-meta">
            <span class="aa-carpeta-count">${entrada.consejos.length} consejo${entrada.consejos.length !== 1 ? "s" : ""}</span>
            ${ult ? `<span class="aa-carpeta-ts">${ult.ts}</span>` : ""}
          </div>
        </div>
        <span class="aa-carpeta-arrow">›</span>`;
      card.addEventListener("click", () => irACarpeta(clave));
      grid.appendChild(card);
    });
  }

  /* ══════════════════════════════════════════════════════════════
     NIVEL 2 — Consejos de un radicado, paginados (1 por página)
  ══════════════════════════════════════════════════════════════ */
  function irACarpeta(clave) {
    _vistaRadicadoActual = clave;
    _paginaConsejo       = (window._copilotoConsejos[clave]?.consejos.length || 1) - 1; // último = más reciente
    const vista = obtenerOCrearVista();
    renderPaginaConsejo(vista);
  }

  function volverACarpetas() {
    _vistaRadicadoActual = null;
    _paginaConsejo       = 0;
    const vista = obtenerOCrearVista();
    renderCarpetas(vista);
  }

  function renderPaginaConsejo(vista) {
    const clave   = _vistaRadicadoActual;
    const entrada = window._copilotoConsejos[clave];
    if (!entrada) { volverACarpetas(); return; }

    const consejos = entrada.consejos;
    const total    = consejos.length;
    const idx      = Math.max(0, Math.min(_paginaConsejo, total - 1));
    const consejo  = consejos[idx];

    vista.innerHTML = `
      <div class="aa-vista-header">
        <div class="aa-vista-header-left">
          <button class="aa-btn-volver" id="aa-btn-volver">← Volver</button>
          <div>
            <h2 class="aa-vista-titulo">${esc(entrada.radicado || clave)}</h2>
            ${entrada.despacho ? `<p class="aa-vista-sub">${esc(entrada.despacho)}</p>` : ""}
          </div>
        </div>
        <button class="aa-vista-limpiar" id="aa-btn-limpiar-carpeta">✕ Limpiar proceso</button>
      </div>

      <div class="aa-paginador-consejo">
        <button class="aa-pag-btn" id="aa-pag-ant" ${idx <= 0 ? "disabled" : ""}>‹ Anterior</button>
        <span class="aa-pag-info">Consejo ${idx + 1} de ${total}</span>
        <button class="aa-pag-btn" id="aa-pag-sig" ${idx >= total - 1 ? "disabled" : ""}>Siguiente ›</button>
        <button class="aa-btn-del-consejo-ind" id="aa-btn-del-consejo" title="Eliminar este consejo">${SVG_TRASH}</button>
      </div>

      <div class="aa-consejo-pagina">
        <div class="aa-vista-item-meta">
          <span class="aa-vista-item-rad">${esc(entrada.radicado || clave)}</span>
          ${entrada.despacho ? `<span class="aa-vista-item-desp">${esc(entrada.despacho)}</span>` : ""}
          <span class="aa-vista-item-ts">${consejo.ts || ""}</span>
        </div>
        <div class="aa-vista-item-body" id="aa-consejo-body"></div>
      </div>`;

    renderResultado(consejo.resultado, document.getElementById("aa-consejo-body"));

    document.getElementById("aa-btn-volver")?.addEventListener("click", volverACarpetas);
    document.getElementById("aa-pag-ant")?.addEventListener("click", () => {
      _paginaConsejo = idx - 1;
      renderPaginaConsejo(vista);
    });
    document.getElementById("aa-pag-sig")?.addEventListener("click", () => {
      _paginaConsejo = idx + 1;
      renderPaginaConsejo(vista);
    });
    document.getElementById("aa-btn-limpiar-carpeta")?.addEventListener("click", async () => {
      if (!confirm(`¿Eliminar todos los consejos de ${entrada.radicado || clave}?\nEsta acción no se puede deshacer.`)) return;
      const ids = entrada.consejos.map(c => c.id);
      await _eliminarConsejosDB(ids);   /* una sola consulta .in("id", ids) */
      delete window._copilotoConsejos[clave];
      actualizarContadorNav();
      volverACarpetas();
    });

    /* ── Botón eliminar consejo individual ── */
    document.getElementById("aa-btn-del-consejo")?.addEventListener("click", async () => {
      if (!confirm(`¿Eliminar este consejo (${idx + 1} de ${total})?`)) return;
      await _eliminarConsejosDB([consejo.id]);
      entrada.consejos.splice(idx, 1);
      actualizarContadorNav();
      if (!entrada.consejos.length) {
        delete window._copilotoConsejos[clave];
        volverACarpetas();
      } else {
        _paginaConsejo = Math.min(idx, entrada.consejos.length - 1);
        renderPaginaConsejo(vista);
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════
     RENDER PRINCIPAL (despacha al nivel correcto)
  ══════════════════════════════════════════════════════════════ */
  function renderVistaConsejos() {
    const vista = obtenerOCrearVista();
    if (_vistaRadicadoActual) {
      renderPaginaConsejo(vista);
    } else {
      renderCarpetas(vista);
    }
  }

  /* Selectores que podemos ocultar/restaurar sin interferir con el dashboard.
     #mon-form-wrap se excluye: su visibilidad la controla el dashboard. */
  const AA_OCULTAR = ".mon-kpi-row, .mon-eyebrow, .mon-toolbar, #mon-list, #mon-pagination";

  function mostrarVistaConsejos() {
    const vista = obtenerOCrearVista();
    /* Cerrar el formulario si está abierto, sin guardarlo para restaurar */
    const formWrap = document.getElementById("mon-form-wrap");
    if (formWrap && formWrap.style.display !== "none") {
      formWrap.style.display = "none";
      formWrap.dataset.aaFormCerrado = "1";
    }
    document.querySelectorAll(AA_OCULTAR).forEach(el => {
      el.dataset.aaOcultoDisplay = el.style.display;
      el.style.display = "none";
    });
    renderVistaConsejos();
    vista.style.display = "block";
  }

  function ocultarVistaConsejos() {
    const vista = document.getElementById("aa-vista-consejos");
    if (vista) vista.style.display = "none";
    _vistaRadicadoActual = null;
    document.querySelectorAll(AA_OCULTAR).forEach(el => {
      el.style.display = el.dataset.aaOcultoDisplay ?? "";
      delete el.dataset.aaOcultoDisplay;
    });
    /* El formulario permanece cerrado — el dashboard lo abre cuando corresponde */
  }

  /* ══════════════════════════════════════════════════════════════
     EXPORTAR EN EXCEL
  ══════════════════════════════════════════════════════════════ */

  /* SVGs para el panel de exportación */
  const SVG_EXCEL_LG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h2"/><path d="M8 17h2"/><path d="M12 13h4"/><path d="M12 17h4"/></svg>`;
  const SVG_EXCEL_SM = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h2"/><path d="M8 17h2"/><path d="M12 13h4"/><path d="M12 17h4"/></svg>`;

  function obtenerOCrearVistaExportar() {
    let v = document.getElementById("aa-vista-exportar");
    if (!v) {
      v = document.createElement("div");
      v.id = "aa-vista-exportar";
      v.style.display = "none";
      const contenedor = document.querySelector(".mon-main")
        || document.getElementById("monitoreo-content")
        || document.body;
      contenedor.appendChild(v);
    }
    return v;
  }

  function renderVistaExportar(vista) {
    vista.innerHTML = `
      <div class="aa-vista-header">
        <div class="aa-vista-header-left">
          ${SVG_EXCEL_LG}
          <div>
            <h2 class="aa-vista-titulo">Exportar en Excel</h2>
            <p class="aa-vista-sub">Descarga todos tus procesos en seguimiento en formato .xlsx</p>
          </div>
        </div>
      </div>
      <div class="aa-export-panel">
        <div class="aa-export-info">
          <p class="aa-export-desc">El archivo Excel incluirá, por cada proceso en seguimiento:</p>
          <ul class="aa-export-cols">
            <li>Número de radicado</li>
            <li>Alias del proceso</li>
            <li>Demandante / Accionante</li>
            <li>Demandado / Accionado</li>
            <li>Despacho judicial</li>
            <li>Última actuación (nombre + descripción completa)</li>
            <li>Última publicación procesal</li>
            <li>Fecha del último movimiento</li>
            <li>Fecha última consulta</li>
            <li>Estado (Con novedad / Activo / Sin actividad)</li>
          </ul>
        </div>
        <button class="aa-export-btn" id="aa-export-btn">
          ${SVG_EXCEL_SM} Descargar Excel
        </button>
      </div>`;
    document.getElementById("aa-export-btn")?.addEventListener("click", exportarExcel);
  }

  function mostrarVistaExportar() {
    const vista = obtenerOCrearVistaExportar();
    const formWrap = document.getElementById("mon-form-wrap");
    if (formWrap && formWrap.style.display !== "none") {
      formWrap.style.display = "none";
    }
    document.querySelectorAll(AA_OCULTAR).forEach(el => {
      el.dataset.aaExportOculto = el.style.display;
      el.style.display = "none";
    });
    renderVistaExportar(vista);
    vista.style.display = "block";
  }

  function ocultarVistaExportar() {
    const vista = document.getElementById("aa-vista-exportar");
    if (!vista || vista.style.display === "none") return;
    vista.style.display = "none";
    document.querySelectorAll(AA_OCULTAR).forEach(el => {
      if (el.dataset.aaExportOculto !== undefined) {
        el.style.display = el.dataset.aaExportOculto;
        delete el.dataset.aaExportOculto;
      }
    });
  }

  /* ── Parsear sujetos procesales para extraer demandante / demandado ── */
  function parsearSujetos(sujetos) {
    if (!sujetos) return { demandante: "", demandado: "" };

    /* Separar por saltos de línea Y por " | " (ambos formatos usa la Rama Judicial) */
    const segmentos = sujetos
      .split(/\r?\n|\s*\|\s*/)
      .map(seg => seg.replace(/\t+/g, " ").trim())
      .filter(Boolean);

    const demandantes = [];
    const demandados  = [];

    segmentos.forEach(seg => {
      const up = seg.toUpperCase();
      /* Extrae el nombre después del primer ":" (maneja "TIPO /: NOMBRE" y "TIPO: NOMBRE") */
      const nombre = seg.replace(/^[^:]+:\s*/, "").trim();
      if (!nombre) return;

      if (/DEMANDANTE|ACCIONANTE|\bACTOR\b|QUERELLANTE|DENUNCIANTE/.test(up)) {
        demandantes.push(nombre);
      } else if (/DEMANDADO|ACCIONADO|\bIMPUTADO\b|\bINDICIADO\b|\bACUSADO\b|\bPROCESADO\b/.test(up)) {
        demandados.push(nombre);
      }
    });

    return {
      demandante: demandantes.join("; "),
      demandado:  demandados.join("; "),
    };
  }

  /* ── Carga ExcelJS dinámicamente (una sola vez) ──────────────── */
  function cargarExcelJS() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
      s.onload  = () => window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error("ExcelJS no disponible"));
      s.onerror = () => reject(new Error("No se pudo cargar la librería de Excel. Verifica tu conexión."));
      document.head.appendChild(s);
    });
  }

  /* ── Función principal de exportación ───────────────────────── */
  async function exportarExcel() {
    const btn = document.getElementById("aa-export-btn");
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="aa-spinner"></span> Preparando datos…`; }

    try {
      const ExcelJS = await cargarExcelJS();
      const client  = _getClient();
      const user    = await _getUser();

      if (!client || !user) {
        alert("Debes iniciar sesión para exportar.");
        return;
      }

      if (btn) btn.innerHTML = `<span class="aa-spinner"></span> Cargando procesos…`;

      const { data, error } = await client
        .from("seguimientos")
        .select("radicado, alias, despacho, sujetos, ultima_actuacion, ultimo_chequeo, tiene_cambios, actuaciones, publicaciones_procesales")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      if (!data?.length) {
        alert("No tienes procesos en seguimiento registrados.");
        return;
      }

      const fmtFecha = iso => {
        if (!iso) return "";
        try { return new Date(iso).toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" }); }
        catch (_) { return iso; }
      };

      const filas = data.map(s => {
        const { demandante, demandado } = parsearSujetos(s.sujetos);
        const acts = Array.isArray(s.actuaciones)              ? s.actuaciones              : [];
        const pubs = Array.isArray(s.publicaciones_procesales) ? s.publicaciones_procesales : [];
        const ultimaAct = acts[0];
        const ultimaPub = pubs[0];

        /* Última actuación: nombre + descripción en una sola celda */
        const ultimaActTexto = [ultimaAct?.actuacion, ultimaAct?.anotacion]
          .filter(Boolean).join("\n");

        return [
          s.radicado  || "",
          s.alias     || "",
          demandante,
          demandado,
          s.despacho  || "",
          ultimaActTexto,
          ultimaPub?.title || "",
          fmtFecha(s.ultima_actuacion),
          fmtFecha(s.ultimo_chequeo),
          s.tiene_cambios ? "Con novedad" : (s.ultima_actuacion ? "Activo" : "Sin actividad"),
        ];
      });

      /* ── Construir workbook con ExcelJS ── */
      const wb = new ExcelJS.Workbook();
      wb.creator = "Minutas Legales Colombia";
      wb.created = new Date();
      const ws = wb.addWorksheet("Procesos", { views: [{ state: "frozen", ySplit: 3 }] });

      const COLS = 10;
      const lastCol = "J";

      /* Fila 1 — título de marca */
      ws.mergeCells(`A1:${lastCol}1`);
      const celdaTitulo = ws.getCell("A1");
      celdaTitulo.value = "Minutas Legales Colombia — Monitoreo Jurídico";
      celdaTitulo.font      = { name: "Calibri", size: 14, bold: true, color: { argb: "FFFFFFFF" } };
      celdaTitulo.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A3A5C" } };
      celdaTitulo.alignment = { horizontal: "center", vertical: "middle" };
      ws.getRow(1).height   = 32;

      /* Fila 2 — fecha de generación */
      ws.mergeCells(`A2:${lastCol}2`);
      const celdaFecha = ws.getCell("A2");
      celdaFecha.value = `Generado: ${new Date().toLocaleString("es-CO", { dateStyle: "long", timeStyle: "short" })}`;
      celdaFecha.font      = { name: "Calibri", size: 9, italic: true, color: { argb: "FFA8893A" } };
      celdaFecha.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAF8F3" } };
      celdaFecha.alignment = { horizontal: "right", vertical: "middle" };
      ws.getRow(2).height  = 16;

      /* Fila 3 — encabezados */
      const HEADERS = [
        "Radicado", "Alias", "Demandante / Accionante", "Demandado / Accionado",
        "Despacho", "Última actuación", "Última publicación procesal",
        "Fecha último movimiento", "Fecha última consulta", "Estado",
      ];
      const filaHeader = ws.addRow(HEADERS);
      filaHeader.eachCell(cell => {
        cell.font      = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A3A5C" } };
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        cell.border    = { bottom: { style: "medium", color: { argb: "FFC9A84C" } } };
      });
      filaHeader.height = 26;

      /* Autofiltro en cabecera */
      ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: COLS } };

      /* Filas de datos */
      const estadoColores = {
        "Con novedad":   { bg: "FFD1FAE5", txt: "FF065F46", bold: true  },
        "Sin actividad": { bg: "FFFEF9C3", txt: "FF78350F", bold: false },
        "Activo":        { bg: "FFEFF6FF", txt: "FF1E40AF", bold: false },
      };

      filas.forEach((valores, i) => {
        const fila = ws.addRow(valores);
        const esAlternada = i % 2 !== 0;
        const estadoVal = String(valores[COLS - 1] || "");
        const estadoClr = estadoColores[estadoVal] || null;

        fila.eachCell({ includeEmpty: true }, (cell, colNum) => {
          cell.font      = { name: "Calibri", size: 9 };
          cell.fill      = {
            type: "pattern", pattern: "solid",
            fgColor: { argb: colNum === COLS && estadoClr ? estadoClr.bg : esAlternada ? "FFF5F2EC" : "FFFFFFFF" },
          };
          cell.alignment = { vertical: "top", wrapText: true };
          cell.border    = {
            bottom: { style: "thin", color: { argb: "FFE8E2D3" } },
            right:  { style: "hair", color: { argb: "FFE8E2D3" } },
          };
          if (colNum === 1) cell.font = { ...cell.font, bold: true, color: { argb: "FF1A3A5C" } };
          if (colNum === COLS && estadoClr) {
            cell.font = { ...cell.font, color: { argb: estadoClr.txt }, bold: estadoClr.bold };
            cell.alignment = { ...cell.alignment, horizontal: "center" };
          }
        });
        fila.height = 45;
      });

      /* Anchos de columna */
      const anchos = [28, 20, 36, 36, 44, 58, 55, 18, 18, 14];
      anchos.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

      /* ── Hoja de resumen KPI ── */
      const ws2 = wb.addWorksheet("Resumen");
      ws2.getColumn(1).width = 38; ws2.getColumn(2).width = 22;

      ws2.mergeCells("A1:B1");
      const kpTit = ws2.getCell("A1");
      kpTit.value = "📊 Resumen Estadístico — Monitoreo Jurídico";
      kpTit.font  = { name: "Calibri", bold: true, size: 13, color: { argb: "FFFFFFFF" } };
      kpTit.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A3A5C" } };
      kpTit.alignment = { horizontal: "center", vertical: "middle" };
      ws2.getRow(1).height = 28;
      ws2.addRow([]);

      const addKpi = (label, val, boldVal) => {
        const r = ws2.addRow([label, val]);
        r.getCell(1).font = { name: "Calibri", size: 9, color: { argb: "FF374151" } };
        r.getCell(2).font = { name: "Calibri", size: 10, bold: !!boldVal, color: { argb: "FF1A3A5C" } };
        r.getCell(2).alignment = { horizontal: "right" };
        r.getCell(1).fill = r.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ws2.rowCount % 2 === 0 ? "FFF5F2EC" : "FFFFFFFF" } };
        r.getCell(1).border = r.getCell(2).border = { bottom: { style: "hair", color: { argb: "FFE8E2D3" } } };
        r.height = 18;
      };

      const conNovedad  = data.filter(s => s.tiene_cambios).length;
      const sinActividad = data.filter(s => !s.ultima_actuacion).length;
      addKpi("Total de procesos en seguimiento", data.length, true);
      addKpi("Procesos con novedad reciente", conNovedad, conNovedad > 0);
      addKpi("Procesos sin actividad registrada", sinActividad);
      addKpi("Procesos activos con actuación", data.length - sinActividad);
      ws2.addRow([]);
      addKpi("Fecha de exportación", new Date().toLocaleString("es-CO", { dateStyle: "long", timeStyle: "short" }));

      /* Descargar */
      if (btn) btn.innerHTML = `<span class="aa-spinner"></span> Generando archivo…`;
      const buffer = await wb.xlsx.writeBuffer();
      const blob   = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url    = URL.createObjectURL(blob);
      const a      = document.createElement("a");
      const hoy    = new Date().toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, "-");
      a.href       = url;
      a.download   = `Monitoreo_Juridico_${hoy}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (btn) btn.innerHTML = `${SVG_EXCEL_SM} Descargado ✓`;
      setTimeout(() => {
        if (btn) { btn.disabled = false; btn.innerHTML = `${SVG_EXCEL_SM} Descargar Excel`; }
      }, 3500);

    } catch (err) {
      console.error("[ExportarExcel]", err);
      alert("Error al exportar: " + (err.message || String(err)));
      if (btn) { btn.disabled = false; btn.innerHTML = `${SVG_EXCEL_SM} Descargar Excel`; }
    }
  }

  /* Actualiza el contador del nav item (total de consejos, no de radicados) */
  function actualizarContadorNav() {
    const total = Object.values(window._copilotoConsejos)
      .reduce((s, e) => s + (Array.isArray(e.consejos) ? e.consejos.length : 0), 0);
    const el = document.getElementById("aa-nav-count");
    if (el) el.textContent = String(total);
    const navItem = document.getElementById("aa-nav-consejos");
    if (navItem) navItem.classList.toggle("aa-nav-has-count", total > 0);
  }

  /* ── Inyectar ítem "Consejos IA Copilot" en el sidebar ─────── */
  function inyectarNavConsejos() {
    if (document.getElementById("aa-nav-consejos")) return;
    const nav = document.querySelector(".mon-nav");
    if (!nav) return;

    const item = document.createElement("button");
    item.className = "mon-nav-item";
    item.id = "aa-nav-consejos";
    item.innerHTML = `
      <span class="mon-nav-icon aa-nav-icon-copiloto">${SVG_COPILOTO}</span>
      <span class="mon-nav-label">Consejos IA Copilot</span>
      <span class="mon-nav-count" id="aa-nav-count">0</span>`;
    nav.appendChild(item);

    item.addEventListener("click", () => {
      document.querySelectorAll(".mon-nav-item").forEach(el => el.classList.remove("active"));
      item.classList.add("active");
      ocultarVistaExportar();
      mostrarVistaConsejos();
    });

    /* Cuando el usuario hace clic en cualquier otro nav-item → restaurar */
    nav.addEventListener("click", e => {
      const clicked = e.target.closest(".mon-nav-item");
      if (clicked && clicked.id !== "aa-nav-consejos") {
        ocultarVistaConsejos();
      }
    });
  }

  /* ── Inyectar ítem "Exportar en Excel" en el sidebar ─────────── */
  function inyectarNavExportar() {
    if (document.getElementById("aa-nav-exportar")) return;
    const nav = document.querySelector(".mon-nav");
    if (!nav) return;

    const item = document.createElement("button");
    item.className = "mon-nav-item";
    item.id = "aa-nav-exportar";
    item.innerHTML = `
      <span class="mon-nav-icon aa-nav-icon-excel">${SVG_EXCEL_SM}</span>
      <span class="mon-nav-label">Exportar en Excel</span>`;
    nav.appendChild(item);

    item.addEventListener("click", e => {
      e.stopPropagation();
      document.querySelectorAll(".mon-nav-item").forEach(el => el.classList.remove("active"));
      item.classList.add("active");
      ocultarVistaConsejos();
      mostrarVistaExportar();
    });

    nav.addEventListener("click", e => {
      const clicked = e.target.closest(".mon-nav-item");
      if (clicked && clicked.id !== "aa-nav-exportar") {
        ocultarVistaExportar();
      }
    });
  }

  /* ── Inyectar botón en la tarjeta ───────────────────────────── */
  function inyectarEnTarjeta(card) {
    if (card.querySelector(".aa-copiloto-btn")) return;

    const ctx    = leerContexto(card);
    const LIMITE = 3;
    let usos     = 0;

    /* Botón — va debajo de mon-card-actions, en mon-card-right */
    const btn = document.createElement("button");
    btn.className = "aa-copiloto-btn";
    btn.innerHTML = `${SVG_COPILOTO}<span>Ayúdate con nuestro Copiloto IA</span>`;

    const actions = card.querySelector(".mon-card-actions");
    if (actions) {
      const fila = document.createElement("div");
      fila.className = "aa-copiloto-row";
      fila.appendChild(btn);
      actions.after(fila);
    } else {
      (card.querySelector(".mon-card-right") || card).appendChild(btn);
    }

    /* ── Función de análisis ── */
    async function ejecutarAnalisis() {
      btn.dataset.cargando = "1";
      btn.disabled = true;
      btn.innerHTML = `<span class="aa-spinner"></span><span>Preparando análisis…</span>`;

      try {
        const texto = await obtenerTextoActuacion(card);
        if (!texto) throw new Error(
          "No hay actuaciones para este proceso. " +
          "Verifica que esté registrado en la Rama Judicial."
        );
        const res = await analizarTexto(
          { textoActuacion: texto, tipoDespacho: ctx.despacho, radicado: ctx.radicado },
          (fase) => {
            if (fase === "investigando") {
              btn.innerHTML = `<span class="aa-spinner"></span><span>Investigando caso…</span>`;
            } else if (fase === "redactando") {
              btn.innerHTML = `<span class="aa-spinner"></span><span>Redactando consejo…</span>`;
            }
          }
        );

        /* Guardar en el almacén y en Supabase */
        const clave = ctx.radicado || `proceso_${Date.now()}`;
        if (!window._copilotoConsejos[clave]) {
          window._copilotoConsejos[clave] = {
            radicado: ctx.radicado,
            despacho: ctx.despacho,
            consejos: [],
          };
        }
        const saved = await guardarConsejoSupabase(ctx.radicado, ctx.despacho, res);
        const ahora = saved
          ? new Date(saved.created_at).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })
          : new Date().toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });
        window._copilotoConsejos[clave].consejos.push({
          id:        saved?.id || null,
          resultado: res,
          ts:        ahora,
        });
        /* Apuntar la navegación al consejo recién creado */
        _vistaRadicadoActual = clave;
        _paginaConsejo = window._copilotoConsejos[clave].consejos.length - 1;
        actualizarContadorNav();

        usos++;
        if (usos >= LIMITE) {
          btn.classList.add("aa-copiloto-btn--agotado");
          btn.title = "Límite de 3 análisis alcanzado";
          btn.innerHTML = `${SVG_COPILOTO}<span>Consejo guardado ✓</span>`;
        } else {
          btn.innerHTML = `${SVG_COPILOTO}<span>Consejo guardado ✓  (${usos}/${LIMITE})</span>`;
        }
        btn.classList.add("aa-copiloto-btn--done");

        /* Navegar automáticamente a la vista Consejos (nivel 2: consejo recién creado) */
        const navItem = document.getElementById("aa-nav-consejos");
        if (navItem) navItem.click();

      } catch (err) {
        btn.innerHTML = `${SVG_COPILOTO}<span>Ayúdate con nuestro Copiloto IA</span>`;
        /* Mostrar error en la vista */
        const vista = obtenerOCrearVista();
        vista.style.display = "block";
        vista.innerHTML = `<div class="aa-error" style="margin:24px">${esc(err.message)}</div>`;
      } finally {
        btn.dataset.cargando = "0";
        if (usos < LIMITE) btn.disabled = false;
      }
    }

    btn.addEventListener("click", async () => {
      if (btn.dataset.cargando === "1") return;
      if (usos >= LIMITE) {
        /* Ya agotado — solo ir a la vista */
        const navItem = document.getElementById("aa-nav-consejos");
        if (navItem) navItem.click();
        return;
      }
      await ejecutarAnalisis();
    });
  }

  /* ── ESCÁNER PRINCIPAL ──────────────────────────────────────── */
  function escanear() {
    /* Inyectar en tarjetas nuevas */
    document.querySelectorAll(".mon-card").forEach(card => {
      if (!card.querySelector(".mon-card-actions")) return;
      if (card.querySelector(".aa-copiloto-btn")) return;
      inyectarEnTarjeta(card);
    });
    /* Inyectar nav Consejos si aún no existe */
    inyectarNavConsejos();
    /* Inyectar nav Exportar si aún no existe */
    inyectarNavExportar();
  }

  /* Inicia el escáner cuando el DOM está listo */
  async function iniciar() {
    escanear();

    /* MutationObserver: inyecta el botón en cuanto el DOM crea nuevas tarjetas,
       sin esperar el intervalo. Evita el parpadeo al navegar entre vistas. */
    const _observerTarget =
      document.querySelector(".mon-main") ||
      document.getElementById("monitoreo-content") ||
      document.body;

    let _scanPending = false;
    const _observer = new MutationObserver(() => {
      if (_scanPending) return;
      _scanPending = true;
      setTimeout(() => { _scanPending = false; escanear(); }, 60);
    });
    _observer.observe(_observerTarget, { childList: true, subtree: true });

    /* Intervalo lento solo para mantener los nav-items (no recorre tarjetas) */
    setInterval(() => {
      inyectarNavConsejos();
      inyectarNavExportar();
    }, 3000);

    await cargarConsejosSupabase();
    console.log("[CopilotoIA] Escáner activo ✓");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }

  /* ── Estilos ─────────────────────────────────────────────────── */
  (function inyectarEstilos() {
    if (document.getElementById("aa-styles")) return;
    const s = document.createElement("style");
    s.id = "aa-styles";
    s.textContent = `
      /* ── Fila del botón en mon-card-right ───────────────────── */
      .aa-copiloto-row {
        margin-top: 8px;
        display: flex; justify-content: flex-end;
      }

      /* ── Botón principal "Ayúdate con nuestro Copiloto IA" ─── */
      .aa-copiloto-btn {
        display: inline-flex; align-items: center; gap: 6px;
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.72rem; font-weight: 700;
        letter-spacing: 0.03em;
        padding: 6px 14px; border-radius: 5px;
        border: 1.5px solid var(--accent, #c9a84c);
        background: rgba(201,168,76,0.08);
        color: var(--accent-dark, #a8893a);
        cursor: pointer;
        transition: background 0.18s, color 0.18s, border-color 0.18s;
        white-space: nowrap;
      }
      .aa-copiloto-btn:hover:not(:disabled) {
        background: var(--accent, #c9a84c);
        color: var(--primary, #1a3a5c);
      }
      .aa-copiloto-btn--done {
        border-color: rgba(30,126,52,0.5);
        background: rgba(30,126,52,0.06);
        color: #1a5c2a;
      }
      .aa-copiloto-btn--agotado { opacity: 0.5; cursor: default; }
      .aa-copiloto-btn:disabled { opacity: 0.55; cursor: wait; }

      /* ── Ícono SVG copiloto en nav sidebar ──────────────────── */
      .aa-nav-icon-copiloto svg { width: 14px; height: 14px; }

      /* ── Vista "Consejos IA Copilot" ────────────────────────── */
      @keyframes aaFadeUp {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      #aa-vista-consejos {
        padding: 24px 0 60px;
        animation: aaFadeUp 0.28s ease;
      }
      .aa-vista-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 0 4px 20px;
        border-bottom: 1px solid var(--border, #e8e2d3);
        margin-bottom: 24px;
        gap: 12px;
      }
      .aa-vista-header-left {
        display: flex; align-items: center; gap: 12px;
      }
      .aa-vista-header-left svg { width: 22px; height: 22px; flex-shrink: 0; }
      .aa-vista-titulo {
        font-family: var(--font-display, "Cormorant Garamond", serif);
        font-size: 1.35rem; font-weight: 600; color: var(--primary, #1a3a5c);
        line-height: 1.1; margin: 0;
      }
      .aa-vista-sub {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.72rem; color: var(--text-soft, #8a8a93);
        margin: 3px 0 0; letter-spacing: 0.03em;
      }
      .aa-vista-limpiar {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.7rem; font-weight: 600;
        padding: 5px 12px; border-radius: 4px;
        border: 1px solid var(--border-strong, #d4cab0);
        background: transparent; color: var(--text-soft, #8a8a93);
        cursor: pointer; white-space: nowrap;
        transition: background 0.15s, color 0.15s;
      }
      .aa-vista-limpiar:hover { background: var(--bg-soft, #f3efe5); color: var(--danger, #b03a2e); border-color: var(--danger, #b03a2e); }

      /* Estado vacío */
      .aa-vista-empty {
        display: flex; flex-direction: column; align-items: center;
        gap: 12px; padding: 60px 24px; text-align: center;
        color: var(--text-muted, #6b6b75);
      }
      .aa-vista-empty svg { width: 32px; height: 32px; opacity: 0.35; }
      .aa-vista-empty p {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.9rem; margin: 0;
      }
      .aa-vista-empty-hint {
        font-size: 0.8rem !important; color: var(--text-soft, #8a8a93);
        max-width: 380px;
      }

      /* Lista de consejos */
      .aa-vista-lista { display: flex; flex-direction: column; gap: 28px; }
      .aa-vista-item {
        border: 1px solid var(--border, #e8e2d3);
        border-radius: 10px; overflow: hidden;
        box-shadow: var(--shadow-sm, 0 2px 8px rgba(26,58,92,0.06));
        background: var(--bg-card, #fff);
      }
      .aa-vista-item-meta {
        display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
        padding: 12px 18px;
        background: linear-gradient(90deg, rgba(201,168,76,0.07) 0%, transparent 100%);
        border-bottom: 1px solid var(--border, #e8e2d3);
      }
      .aa-vista-item-rad {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.78rem; font-weight: 700; color: var(--primary, #1a3a5c);
      }
      .aa-vista-item-desp {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.72rem; color: var(--text-muted, #6b6b75);
        padding-left: 8px; border-left: 1px solid var(--border, #e8e2d3);
      }
      .aa-vista-item-ts {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.68rem; color: var(--text-soft, #8a8a93);
        margin-left: auto;
      }
      .aa-vista-item-body { padding: 16px 18px 20px; }

      @keyframes aaSpin { to { transform: rotate(360deg); } }
      .aa-spinner {
        display: inline-block; width: 12px; height: 12px;
        border: 2px solid rgba(201,168,76,0.3);
        border-top-color: var(--accent, #c9a84c);
        border-radius: 50%;
        animation: aaSpin 0.75s linear infinite; flex-shrink: 0;
      }

      @keyframes aaFadeIn {
        from { opacity: 0; transform: translateY(5px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .aa-card {
        margin: 6px 0 12px;
        background: var(--bg, #faf8f3);
        border: 1px solid var(--border, #e8e2d3);
        border-left: 3px solid var(--accent, #c9a84c);
        border-radius: 7px; padding: 16px 18px;
        display: flex; flex-direction: column; gap: 12px;
        animation: aaFadeIn 0.3s ease;
      }
      .aa-meta { display: flex; flex-wrap: wrap; gap: 5px; }
      .aa-badge {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.62rem; font-weight: 700;
        letter-spacing: 0.1em; text-transform: uppercase;
        padding: 2px 8px; border-radius: 99px;
      }
      .aa-badge-juzgado { background: rgba(26,58,92,0.08); color: var(--primary, #1a3a5c); }
      .aa-badge-etapa   { background: rgba(201,168,76,0.12); color: var(--accent-dark, #a8893a); border: 1px solid rgba(201,168,76,0.28); }
      .aa-badge-alerta  { display: inline-flex; align-items: center; gap: 4px; }
      .aa-label {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.65rem; font-weight: 700;
        letter-spacing: 0.12em; text-transform: uppercase;
        color: var(--text-soft, #8a8a93);
      }
      .aa-paso-label {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.63rem; font-weight: 800;
        letter-spacing: 0.14em; text-transform: uppercase;
        color: var(--accent-dark, #a8893a);
        margin-bottom: -4px;
      }
      .aa-termino-box {
        display: flex; gap: 10px; align-items: flex-start;
        background: rgba(30,126,52,0.05);
        border: 1px solid rgba(30,126,52,0.18);
        border-radius: 6px; padding: 10px 14px;
      }
      /* Icono en caja de término — ahora SVG, no emoji */
      .aa-termino-icon {
        flex-shrink: 0; display: flex; align-items: center;
        color: #1a5c2a; margin-top: 1px;
      }
      .aa-termino-texto {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.84rem; font-weight: 600;
        color: #1a5c2a; margin: 2px 0 0;
      }
      .aa-consejo-box {
        display: flex; gap: 10px; align-items: flex-start;
        background: rgba(201,168,76,0.05);
        border-radius: 6px; padding: 13px 15px;
      }
      /* Icono balanza — SVG */
      .aa-consejo-icon {
        flex-shrink: 0; display: flex; align-items: center;
        color: var(--accent-dark, #a8893a); margin-top: 2px;
      }
      .aa-consejo-texto {
        font-family: var(--font-body, "Lora", serif);
        font-size: 0.88rem; line-height: 1.65; color: var(--text, #1c1c1e);
      }
      .aa-fuentes {
        display: flex; flex-direction: column; gap: 5px;
        background: rgba(26,58,92,0.03);
        border: 1px solid rgba(26,58,92,0.1);
        border-radius: 6px; padding: 11px 14px;
      }
      .aa-fuentes-list {
        margin: 4px 0 0; padding: 0;
        list-style: none; display: flex; flex-direction: column; gap: 5px;
      }
      /* Ítem de fuente legal — SVG alineado con texto */
      .aa-fuentes-list li {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.8rem; color: var(--primary, #1a3a5c);
        line-height: 1.5; display: flex; align-items: flex-start; gap: 6px;
      }
      .aa-fuentes-list li svg { margin-top: 1px; flex-shrink: 0; }
      .aa-verificar-box {
        display: flex; gap: 10px; align-items: flex-start;
        background: rgba(74,107,152,0.05);
        border: 1px solid rgba(74,107,152,0.15);
        border-radius: 6px; padding: 10px 14px;
      }
      /* Icono lupa — SVG */
      .aa-verificar-icon {
        flex-shrink: 0; display: flex; align-items: center;
        color: #2c4a7c; margin-top: 1px;
      }
      .aa-verificar-texto {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.81rem; color: #2c4a7c; margin: 2px 0 0; line-height: 1.55;
      }
      .aa-minuta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .aa-minuta-label {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.68rem; font-weight: 600;
        letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--text-soft, #8a8a93);
      }
      .aa-disclaimer {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.7rem; color: var(--text-soft, #8a8a93);
        border-top: 1px solid var(--border, #e8e2d3);
        padding-top: 9px; margin: 0; line-height: 1.55;
        display: flex; align-items: flex-start; gap: 6px;
      }
      .aa-disclaimer svg { flex-shrink: 0; margin-top: 1px; }
      /* Botón de minuta — SVG alineado */
      .aa-minuta .btn { display: inline-flex; align-items: center; gap: 5px; }
      /* ── Carpetas (nivel 1) ─────────────────────────────────── */
      .aa-carpetas-grid {
        display: flex; flex-direction: column; gap: 10px;
        padding: 0 4px;
      }
      .aa-carpeta-card {
        display: flex; align-items: center; gap: 14px;
        background: var(--bg-card, #fff);
        border: 1px solid var(--border, #e8e2d3);
        border-radius: 10px; padding: 16px 18px;
        box-shadow: 0 1px 4px rgba(26,58,92,0.05);
        cursor: pointer; text-align: left; width: 100%;
        transition: box-shadow 0.15s, border-color 0.15s, transform 0.12s;
      }
      .aa-carpeta-card:hover {
        box-shadow: 0 4px 14px rgba(26,58,92,0.1);
        border-color: var(--accent, #c9a84c);
        transform: translateY(-1px);
      }
      .aa-carpeta-icon { color: var(--accent-dark, #a8893a); flex-shrink: 0; opacity: 0.8; }
      .aa-carpeta-body { flex: 1; min-width: 0; }
      .aa-carpeta-rad {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.84rem; font-weight: 700; color: var(--primary, #1a3a5c);
        word-break: break-all;
      }
      .aa-carpeta-desp {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.74rem; color: var(--text-muted, #6b6b75);
        margin-top: 2px;
        line-height: 1.4;
      }
      .aa-carpeta-meta {
        display: flex; align-items: center; gap: 10px; margin-top: 6px;
      }
      .aa-carpeta-count {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.68rem; font-weight: 700;
        background: rgba(201,168,76,0.14); color: var(--accent-dark, #a8893a);
        padding: 1px 8px; border-radius: 99px;
      }
      .aa-carpeta-ts {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.67rem; color: var(--text-soft, #8a8a93);
      }
      .aa-carpeta-arrow {
        font-size: 1.4rem; color: var(--text-soft, #8a8a93); flex-shrink: 0; line-height: 1;
      }

      /* ── Paginador de carpetas (nivel 1) ───────────────────── */
      .aa-paginador-carpetas {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 18px 4px 4px;
        margin-top: 4px;
      }

      /* ── Paginador de consejo (nivel 2) ─────────────────────── */
      .aa-paginador-consejo {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 10px 4px 18px;
        border-bottom: 1px solid var(--border, #e8e2d3);
        margin-bottom: 20px;
      }
      .aa-pag-btn {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.8rem; font-weight: 600;
        padding: 6px 16px; border-radius: 5px;
        border: 1px solid var(--border, #e8e2d3);
        background: var(--bg-card, #fff); color: var(--primary, #1a3a5c);
        cursor: pointer; transition: all 0.15s; white-space: nowrap;
      }
      .aa-pag-btn:hover:not(:disabled) {
        border-color: var(--primary, #1a3a5c);
        background: var(--bg-soft, #f3efe5);
      }
      .aa-pag-btn:disabled { opacity: 0.35; cursor: default; }
      .aa-pag-info {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.78rem; font-weight: 600; color: var(--text-soft, #8a8a93);
      }
      .aa-consejo-pagina {
        border: 1px solid var(--border, #e8e2d3);
        border-radius: 10px; overflow: hidden;
        background: var(--bg-card, #fff);
        box-shadow: 0 1px 4px rgba(26,58,92,0.05);
      }

      /* ── Botón eliminar consejo individual (en paginador) ──── */
      .aa-btn-del-consejo-ind {
        font-size: 0.9rem; line-height: 1;
        padding: 5px 9px; border-radius: 5px;
        border: 1px solid rgba(176,58,46,0.25);
        background: rgba(176,58,46,0.05); color: #b03a2e;
        cursor: pointer; transition: all 0.15s; flex-shrink: 0;
        margin-left: 4px;
      }
      .aa-btn-del-consejo-ind:hover {
        background: rgba(176,58,46,0.12);
        border-color: rgba(176,58,46,0.5);
      }

      /* ── Botón volver ───────────────────────────────────────── */
      .aa-btn-volver {
        display: inline-flex; align-items: center; gap: 5px;
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.8rem; font-weight: 600;
        color: var(--primary, #1a3a5c);
        background: none; border: 1px solid var(--border, #e8e2d3);
        border-radius: 5px; padding: 5px 12px; cursor: pointer;
        transition: all 0.15s; white-space: nowrap;
      }
      .aa-btn-volver:hover {
        border-color: var(--primary, #1a3a5c);
        background: var(--bg-soft, #f3efe5);
      }

      .aa-error {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.82rem; color: var(--danger, #b03a2e);
        margin: 6px 0; line-height: 1.5;
      }

      /* ── Ícono Excel en nav sidebar ──────────────────────────── */
      .aa-nav-icon-excel svg { width: 14px; height: 14px; }

      /* ── Vista "Exportar en Excel" ───────────────────────────── */
      #aa-vista-exportar {
        padding: 24px 0 60px;
        animation: aaFadeUp 0.28s ease;
      }

      /* ── Panel de exportación ────────────────────────────────── */
      .aa-export-panel {
        display: flex;
        flex-direction: column;
        gap: 28px;
        padding: 0 4px;
      }
      .aa-export-info {
        background: var(--bg-card, #fff);
        border: 1px solid var(--border, #e8e2d3);
        border-radius: 10px;
        padding: 22px 26px 20px;
        box-shadow: 0 1px 4px rgba(26,58,92,0.05);
      }
      .aa-export-desc {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--primary, #1a3a5c);
        margin: 0 0 12px;
      }
      .aa-export-cols {
        margin: 0;
        padding: 0 0 0 18px;
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .aa-export-cols li {
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.8rem;
        color: var(--text-muted, #6b6b75);
        line-height: 1.5;
      }
      .aa-export-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        align-self: flex-start;
        font-family: var(--font-ui, "Inter", sans-serif);
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.03em;
        padding: 10px 22px;
        border-radius: 6px;
        border: 1.5px solid #1e7e34;
        background: rgba(30,126,52,0.07);
        color: #1a5c2a;
        cursor: pointer;
        transition: background 0.18s, color 0.18s, border-color 0.18s;
        white-space: nowrap;
      }
      .aa-export-btn:hover:not(:disabled) {
        background: #1e7e34;
        color: #fff;
        border-color: #1e7e34;
      }
      .aa-export-btn:disabled {
        opacity: 0.55;
        cursor: wait;
      }
    `;
    document.head.appendChild(s);
  })();

  /* ── API pública ─────────────────────────────────────────────── */
  window.copilotoIA = {
    analizar:      analizarTexto,
    renderConsejo: renderResultado,
    escanear:      escanear,   /* llámalo manualmente si necesitas: copilotoIA.escanear() */
  };

})();
