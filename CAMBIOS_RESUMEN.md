# Cambios Realizados - Monitoreo.js y Monitoreo.html

## 1. Números de tarjetas KPI (Arial)
**Archivo**: monitoreo.html
**Línea original**: 146
**Cambio**:
```css
/* Antes */
.mon-kpi-value { font-family: var(--font-d, "Cormorant Garamond", Georgia, serif); }

/* Después */
.mon-kpi-value { font-family: Arial, sans-serif; font-weight: 700; font-size: 1.9rem; }
```

## 2. Tipo de proceso dinámico
**Archivo**: monitoreo.js
**Ubicación**: Donde se genera mensaje de minutas (línea ~1354)
**Cambio**: El mensaje ahora lee `proceso.tipoProceso` en lugar de hardcodear "Arrendamiento"
```javascript
/* Antes */
"para procesos de tipo Arrendamiento"

/* Después */
`para procesos de tipo ${proceso.tipoProceso || 'desconocido'}`
```

## 3. Barras de búsqueda en paneles
**Archivo**: monitoreo.html
**Cambio**: Se agregó CSS para `.panel-search-wrap` y `.panel-search`
```html
<div class="panel-search-wrap">
  <span class="panel-search-icon">🔍</span>
  <input type="search" class="panel-search" placeholder="Buscar por radicado o alias…" />
</div>
```

## 4. match_confianza en consultarRJ()
**Archivo**: monitoreo.js
**Cambios principales**:

### 4.1 Función consultarRJ() modificada (líneas ~983-1052)
- Ahora devuelve `{ proceso, actuaciones, matchConfianza }`
- Si d.procesos.length > 1: filtra con `despachoCoincide()`
- Valores de matchConfianza:
  - `'alta'`: si solo hay un proceso O coincide por despacho
  - `'baja'`: si múltiples procesos y ninguno coincide claramente

### 4.2 onAgregarRadicado() (línea ~891)
```javascript
const resultado = await consultarRJ(raw);
// Incluir en insert:
match_confianza: resultado.matchConfianza || 'media'
```

### 4.3 actualizarUno() (línea ~1450)
```javascript
const resultado = await consultarRamaJudicialPorId(s);
// En updatePayload:
match_confianza: resultado?.matchConfianza || s.match_confianza || 'media'
```

### 4.4 renderTarjeta() (línea ~457)
```javascript
// Agregar badge si match_confianza es 'baja'
${s.match_confianza === 'baja' ? `
  <span class="mon-badge-review" title="Revisar manualmente — puede no ser el proceso correcto">
    ${IC.alertCircle} Revisar manualmente
  </span>
` : ""}
```

## 5. Migración SQL
**Archivo**: MIGRACIÓN_SUPABASE.sql
```sql
ALTER TABLE seguimientos
ADD COLUMN match_confianza text DEFAULT 'media';
```

## Resumen de archivos modificados:
- ✅ **monitoreo.js**: Lógica de match_confianza, tipo de proceso dinámico
- ✅ **monitoreo.html**: CSS para KPI Arial, barras de búsqueda, badge review
- ✅ **MIGRACIÓN_SUPABASE.sql**: Nueva columna en BD

## Próximos pasos en el frontend (fuera de este scope):
1. Implementar lógica de filtrado en inputs `.panel-search` (IA y Minutas)
2. Conectar búsqueda a los elementos correspondientes de cada panel
3. Ejecutar la migración SQL en Supabase antes de hacer deploy