import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const apiBase = import.meta.env.VITE_API_URL || '';

/** Supabase é opcional: usamos o backend Docker como fallback primário */
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
  | 'zone_clear_all'
  | 'layout_save'
  | 'state_sync';

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

const localEventLog: EventLogEntry[] = [];
let localSeq = 0;

/** Save event via backend API (Docker) when Supabase isn't configured */
async function postToBackend(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fetch from backend API */
async function getFromBackend(path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${apiBase}${path}`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function logEvent(
  eventType: EventType,
  source: string,
  message: string,
  severity: EventSeverity = 'info',
  metadata: Record<string, unknown> | null = null,
): Promise<void> {
  const entry: EventLogEntry = {
    id: `local-${Date.now()}-${localSeq++}`,
    event_type: eventType,
    source,
    message,
    severity,
    metadata,
    created_at: new Date().toISOString(),
  };

  // Always keep local cache
  localEventLog.unshift(entry);
  if (localEventLog.length > 200) localEventLog.length = 200;

  // Try Supabase first
  if (supabase) {
    try {
      await supabase.from('event_log').insert({
        event_type: eventType,
        source,
        message,
        severity,
        metadata,
      });
      return;
    } catch { /* fall through */ }
  }

  // Fallback: backend Docker API
  await postToBackend('/api/events', entry);
}

export async function fetchEvents(limit = 50): Promise<EventLogEntry[]> {
  // Try Supabase first
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('event_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (!error && data) return data as EventLogEntry[];
    } catch { /* fall through */ }
  }

  // Try backend API
  const backendEvents = await getFromBackend(`/api/events?limit=${limit}`);
  if (backendEvents && Array.isArray(backendEvents)) {
    return backendEvents as EventLogEntry[];
  }

  // Finally: local cache
  return localEventLog.slice(0, limit);
}

/** Save full app state to backend */
export async function saveState(state: unknown): Promise<boolean> {
  return postToBackend('/api/state', state);
}

/** Load full app state from backend */
export async function loadState(): Promise<unknown | null> {
  return getFromBackend('/api/state');
}

/** Save map layout to backend */
export async function saveLayout(layout: unknown): Promise<boolean> {
  // Also save to localStorage as immediate cache
  try {
    localStorage.setItem('gtc-rega-map-layout', JSON.stringify(layout));
  } catch { /* ignore */ }
  return postToBackend('/api/layout', layout);
}

/** Load map layout from backend, fallback to localStorage */
export async function loadLayout(): Promise<unknown | null> {
  const backend = await getFromBackend('/api/layout');
  if (backend && Object.keys(backend as object).length > 0) {
    // Also sync localStorage
    try {
      localStorage.setItem('gtc-rega-map-layout', JSON.stringify(backend));
    } catch { /* ignore */ }
    return backend;
  }
  // Fallback: localStorage
  try {
    const local = localStorage.getItem('gtc-rega-map-layout');
    if (local) return JSON.parse(local);
  } catch { /* ignore */ }
  return null;
}
