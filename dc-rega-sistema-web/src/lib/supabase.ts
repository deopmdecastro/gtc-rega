import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

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
  | 'zone_add_map';

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

export async function logEvent(
  eventType: EventType,
  source: string,
  message: string,
  severity: EventSeverity = 'info',
  metadata: Record<string, unknown> | null = null,
): Promise<void> {
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
  const { data, error } = await supabase
    .from('event_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data as EventLogEntry[]) ?? [];
}
