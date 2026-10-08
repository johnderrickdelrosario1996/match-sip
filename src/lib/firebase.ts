import { initializeApp, getApps, getApp } from 'firebase/app';
import { 
  initializeFirestore, 
  getFirestore,
  persistentLocalCache, 
  persistentMultipleTabManager,
  CACHE_SIZE_UNLIMITED,
  memoryLocalCache,
  doc,
  getDocFromServer
} from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { getStorage } from 'firebase/storage';
import firebaseConfig from '../../firebase-applet-config.json';

// Initialize Firebase App singleton
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

/**
 * Initialize Cloud Firestore with client-side offline persistence.
 * Enables IndexedDB persistent local cache with multi-tab coordination and unlimited cache size.
 * Automatically falls back to memory cache if persistent storage is unavailable in the environment.
 */
function createFirestoreInstance() {
  const databaseId = (firebaseConfig as any).firestoreDatabaseId || undefined;
  try {
    return initializeFirestore(
      app,
      {
        experimentalForceLongPolling: true,
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
          cacheSizeBytes: CACHE_SIZE_UNLIMITED,
        }),
      },
      databaseId
    );
  } catch (initErr: any) {
    console.warn('[MATCH&SIP] Primary persistent cache initialization notice:', initErr?.message || initErr);
    try {
      return getFirestore(app, databaseId);
    } catch (fallbackErr) {
      console.warn('[MATCH&SIP] Falling back to memory local cache:', fallbackErr);
      return initializeFirestore(
        app,
        {
          localCache: memoryLocalCache(),
        },
        databaseId
      );
    }
  }
}

export const db = createFirestoreInstance();
export const auth = getAuth(app);
export const storage = getStorage(app);

// Skill constraint: validate connection to Firestore on initialization
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('[MATCH&SIP] Client is offline. Offline persistence is active and serving cached data.');
    }
  }
}
testConnection();
