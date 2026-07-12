-- Migración: Agregar columna match_confianza a tabla seguimientos
-- Ejecutar en Supabase SQL Editor

ALTER TABLE seguimientos
ADD COLUMN match_confianza text DEFAULT 'media';

-- Valores esperados: 'alta', 'media', 'baja'
-- 'alta': proceso identificado con confianza (coincide despacho o solo hay uno)
-- 'media': identificación por defecto
-- 'baja': múltiples procesos sin coincidencia clara por despacho