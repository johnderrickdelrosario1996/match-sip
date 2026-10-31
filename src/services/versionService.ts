/**
 * Version Management & Automatic Force-Refresh Service
 * Ensures clients never run stale code after a new build or deployment.
 */

import { clearBookingsCache } from './bookingService.ts';

declare global {
  interface Window {
    __APP_BUILD_TIME__?: string | number;
    __APP_VERSION__?: string;
  }
}

// Fallback build identifier if not injected by Vite
const CLIENT_BOOT_TIME = typeof window !== 'undefined' && window.__APP_BUILD_TIME__
  ? Number(window.__APP_BUILD_TIME__)
  : Date.now();

let knownServerBuildTime: number = CLIENT_BOOT_TIME;
let isCheckingVersion = false;
let checkIntervalTimer: any = null;
let onVersionUpdateCallback: ((newVersionInfo: { buildTime: number; version?: string }) => void) | null = null;

export interface AppVersionInfo {
  version: string;
  buildTime: number;
  environment?: string;
  timestamp?: string;
}

/**
 * Checks the backend /api/version endpoint for a newer deployment.
 */
export async function checkForAppUpdates(): Promise<{ hasUpdate: boolean; versionInfo?: AppVersionInfo }> {
  if (isCheckingVersion) return { hasUpdate: false };
  isCheckingVersion = true;

  try {
    // Append cache-buster query parameter to bypass all intermediate browser / proxy caches
    const cacheBuster = Date.now();
    const res = await fetch(`/api/version?_t=${cacheBuster}`, {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      return { hasUpdate: false };
    }

    const data: AppVersionInfo = await res.json();
    const serverBuildTime = Number(data.buildTime || 0);

    // If server has a newer build timestamp than our boot time
    if (serverBuildTime > 0 && serverBuildTime > knownServerBuildTime) {
      console.log(`[VERSION] New deployment detected: Server (${serverBuildTime}) > Client (${knownServerBuildTime})`);
      knownServerBuildTime = serverBuildTime;

      if (onVersionUpdateCallback) {
        onVersionUpdateCallback({ buildTime: serverBuildTime, version: data.version });
      }

      return { hasUpdate: true, versionInfo: data };
    }

    return { hasUpdate: false, versionInfo: data };
  } catch (err) {
    // Silent network guard (e.g. temporary offline)
    return { hasUpdate: false };
  } finally {
    isCheckingVersion = false;
  }
}

/**
 * Perform an immediate, aggressive force reload to fetch latest JS/CSS bundles.
 */
export function forceAppRefresh(reason = 'New version deployed'): void {
  console.warn(`[VERSION] Force-refreshing application: ${reason}`);
  try {
    // Bust stale bookings localStorage caches
    clearBookingsCache();
    // Clear in-memory caches and session caches if present
    sessionStorage.removeItem('matchsip_chunk_reload_lock');
    // If Service Workers are registered, update or unregister them
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const registration of registrations) {
          registration.update().catch(() => {});
        }
      }).catch(() => {});
    }
  } catch {}

  // Force hard reload bypassing cache
  const cleanPath = window.location.pathname + window.location.search;
  const separator = cleanPath.includes('?') ? '&' : '?';
  const refreshUrl = `${cleanPath}${separator}v=${Date.now()}`;
  
  // Replace location to bust cache
  window.location.replace(refreshUrl);
}

/**
 * Initializes automatic version checking and dynamic chunk failure guards.
 */
export function initVersionChecker(onNewVersionFound?: (info: { buildTime: number; version?: string }) => void) {
  if (typeof window === 'undefined') return;

  if (onNewVersionFound) {
    onVersionUpdateCallback = onNewVersionFound;
  }

  // 1. Guard against Vite/Webpack "Failed to fetch dynamically imported module" errors.
  // This happens when a new build changes chunk hashes and an open tab tries to load an old chunk.
  window.addEventListener('error', (event) => {
    const errorMsg = event?.message || '';
    if (
      errorMsg.includes('Failed to fetch dynamically imported module') ||
      errorMsg.includes('Loading chunk') ||
      errorMsg.includes('Importing a module script failed')
    ) {
      const lastReload = Number(sessionStorage.getItem('matchsip_chunk_reload_lock') || 0);
      const now = Date.now();
      // Reload at most once every 10 seconds to avoid infinite reload loops
      if (now - lastReload > 10000) {
        sessionStorage.setItem('matchsip_chunk_reload_lock', String(now));
        console.warn('[VERSION] Dynamic import chunk mismatch detected. Auto-reloading latest bundle...');
        forceAppRefresh('Stale bundle chunk detected');
      }
    }
  });

  // 2. Initial check after 3 seconds of boot
  setTimeout(() => {
    checkForAppUpdates();
  }, 3000);

  // 3. Periodic check every 45 seconds
  if (checkIntervalTimer) {
    clearInterval(checkIntervalTimer);
  }
  checkIntervalTimer = setInterval(checkForAppUpdates, 45000);

  // 4. Check immediately whenever user returns to the tab
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      checkForAppUpdates();
    }
  };

  window.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleVisibilityChange);

  return () => {
    if (checkIntervalTimer) clearInterval(checkIntervalTimer);
    window.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('focus', handleVisibilityChange);
  };
}
