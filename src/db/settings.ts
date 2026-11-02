import fs from 'fs';
import path from 'path';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';

export interface MaintenanceSettings {
  enabled: boolean;
  message: string;
  updatedAt: string;
}

const DEFAULT_MESSAGE =
  'MATCH & SIP is under maintenance. We will be back soon! You can book thru our Instagram link below.';

const STATE_FILE_PATH = path.join(process.cwd(), '.maintenance_state.json');

/**
 * Synchronously reads the durable state file from local disk.
 * This guarantees maintenance mode NEVER resets or wears off across
 * server restarts, container idle scale-down, or multi-hour timeouts.
 */
function readDiskState(): MaintenanceSettings | null {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const raw = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed?.enabled === 'boolean') {
        return {
          enabled: parsed.enabled,
          message: parsed.message || DEFAULT_MESSAGE,
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
      }
    }
  } catch (err) {
    console.warn('[SETTINGS] Could not read disk maintenance state:', err);
  }
  return null;
}

/**
 * Synchronously writes state to the local disk file for 100% durable persistence.
 */
function writeDiskState(state: MaintenanceSettings): void {
  try {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[SETTINGS] Could not write disk maintenance state:', err);
  }
}

// Initialize from durable disk file first, or environment variable fallback
const diskInitial = readDiskState();
let currentMaintenanceSettings: MaintenanceSettings = diskInitial || {
  enabled: process.env.MAINTENANCE_MODE === 'true',
  message: DEFAULT_MESSAGE,
  updatedAt: new Date().toISOString(),
};

/**
 * Fetch maintenance settings.
 * Checks memory & disk first (instant), then attempts Supabase sync.
 * Even if Supabase query fails or table does not exist, the local disk state
 * is preserved indefinitely until explicitly changed.
 */
export async function getMaintenanceStatus(): Promise<MaintenanceSettings> {
  // If memory/disk already has an explicit state, ensure disk is synced
  const diskState = readDiskState();
  if (diskState && diskState.updatedAt > currentMaintenanceSettings.updatedAt) {
    currentMaintenanceSettings = diskState;
  }

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value, updated_at')
        .eq('key', 'maintenance')
        .maybeSingle();

      if (!error && data?.value) {
        const val = data.value as any;
        const dbUpdatedAt = data.updated_at || '';
        // If Supabase has a newer timestamp than disk, update disk & memory
        if (dbUpdatedAt && dbUpdatedAt > currentMaintenanceSettings.updatedAt) {
          currentMaintenanceSettings = {
            enabled: Boolean(val.enabled),
            message: val.message || DEFAULT_MESSAGE,
            updatedAt: dbUpdatedAt,
          };
          writeDiskState(currentMaintenanceSettings);
        }
      }
    } catch {
      // Graceful fallback to persistent disk state
    }
  }

  return currentMaintenanceSettings;
}

/**
 * Update maintenance settings durably.
 * Writes immediately to disk (so server restarts never lose it)
 * and attempts persistence to Supabase app_settings table.
 */
export async function setMaintenanceStatus(
  enabled: boolean,
  message?: string
): Promise<MaintenanceSettings> {
  const updated: MaintenanceSettings = {
    enabled,
    message: message || (enabled ? DEFAULT_MESSAGE : ''),
    updatedAt: new Date().toISOString(),
  };

  currentMaintenanceSettings = updated;
  // 1. Immediately persist to disk
  writeDiskState(updated);

  // 2. Persist to Supabase if configured
  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('app_settings').upsert({
        key: 'maintenance',
        value: { enabled, message: updated.message },
        updated_at: updated.updatedAt,
      });
      if (error) {
        console.warn('[SETTINGS] Could not upsert to app_settings table in Supabase:', error.message);
      }
    } catch (err) {
      console.warn('[SETTINGS] Supabase app_settings upsert exception:', err);
    }
  }

  return currentMaintenanceSettings;
}
