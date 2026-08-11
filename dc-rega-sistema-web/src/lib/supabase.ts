import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * Supabase é opcional: o painel funciona mesmo sem credenciais configuradas.
 * Quando VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY não existem, o cliente
 * fica desativado (isSupabaseEnabled = false) e as funções de registo de
 * eventos degradam de forma silenciosa em vez de rebentar a aplicação com
 * "supabaseUrl is required".
 */
export const isSupabaseEnabled = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase: SupabaseClient | null = isSupabaseEnabled
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : null;

export type EventType =
  | 'zone_toggle'
  | 'pump_toggle'
  | 'system_start'
  | 'system_stop'
  | 'system_reset'
  | 'mode_change'
  | 'zone_add'
  | 'zone_remove'
  | 'emergency_stop'
  | 'test_cycle'
  | 'zone_rename'
  | 'zone_drag'
  | 'zone_add_map'
  | 'zone_duplicate'
  | 'zone_clear_all';

export type EventSeverity = 'info' | 'warning' | 'critical';

export type EventLogEntry = {
  id: string;
  event_type: EventType;
  source: string;
  message: string;
  severity: EventSeverity;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

/**
 * Registo local (fallback) usado quando o Supabase não está configurado.
 * Mantém os eventos em memória para que o Histórico continue a funcionar
 * durante a sessão, sem depender de qualquer serviço externo.
 */
const localEventLog: EventLogEntry[] = [];
let localSeq = 0;

export async function logEvent(
  eventType: EventType,
  source: string,
  message: string,
  severity: EventSeverity = 'info',
  metadata: Record<string, unknown> | null = null,
): Promise<void> {
  // fallback local — sempre alimentado, também serve de cache quando há Supabase
  localEventLog.unshift({
    id: `local-${Date.now()}-${localSeq++}`,
    event_type: eventType,
    source,
    message,
    severity,
    metadata,
    created_at: new Date().toISOString(),
  });
  if (localEventLog.length > 200) localEventLog.length = 200;

  if (!supabase) return;
  try {
    await supabase.from('event_log').insert({
      event_type: eventType,
      source,
      message,
      severity,
      metadata,
    });
  } catch {
    // silently fail — logging is best-effort
  }
}

export async function fetchEvents(limit = 50): Promise<EventLogEntry[]> {
  if (!supabase) {
    return localEventLog.slice(0, limit);
  }
  try {
    const { data, error } = await supabase
      .from('event_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) return localEventLog.slice(0, limit);
    return data as EventLogEntry[];
  } catch {
    return localEventLog.slice(0, limit);
  }
}
