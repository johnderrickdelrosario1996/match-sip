import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { storage } from '../lib/firebase';

export interface UploadProgressCallback {
  (progressPercent: number): void;
}

export interface UploadResult {
  downloadUrl: string;
  storagePath: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
}

/**
 * Resolves the MIME content type from the file object or its extension.
 */
function resolveContentType(file: File): string {
  if (file.type && file.type.startsWith('image/')) {
    return file.type;
  }
  const ext = file.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'image/jpeg';
  }
}

/**
 * Converts a file into a base64 Data URL for local preview and seamless fallback.
 */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

/**
 * Compresses an image File into an optimized Base64 string using an HTML canvas.
 * Scales down dimensions to fit within maxWidth/maxHeight while preserving aspect ratio
 * and encodes as JPEG with controlled quality, producing a lightweight (< 200KB) payload
 * perfectly suited for direct attachment to Firestore documents.
 */
export function compressImageToBase64(
  file: File,
  maxWidth = 1000,
  maxHeight = 1000,
  quality = 0.72
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = (err) => reject(err);
    reader.onload = (event) => {
      const rawDataUrl = event.target?.result as string;
      const img = new Image();
      img.onerror = () => {
        // If image loading fails, return raw data url as fallback
        resolve(rawDataUrl);
      };
      img.onload = () => {
        try {
          let width = img.width;
          let height = img.height;

          if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(rawDataUrl);
            return;
          }

          // Fill white background in case of transparent PNG/WEBP
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, width, height);

          ctx.drawImage(img, 0, 0, width, height);
          const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
          resolve(compressedDataUrl);
        } catch (canvasErr) {
          console.warn('Canvas compression error, falling back to raw data URL:', canvasErr);
          resolve(rawDataUrl);
        }
      };
      img.src = rawDataUrl;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Uploads a payment receipt photo to Firebase Storage using uploadBytesResumable.
 * Includes explicit try/catch, detailed console error logging, MIME type validation,
 * and a CORS/network stall guard that prevents the upload from hanging at 0%.
 *
 * @param file The image File object from the user input
 * @param bookingReference Optional booking reference (e.g. MS-123456) for organizing receipts
 * @param onProgress Optional callback for tracking percentage (0-100)
 * @returns Promise resolving to the UploadResult containing the Firebase Storage download URL
 */
export async function uploadReceiptToFirebaseStorage(
  file: File,
  bookingReference?: string,
  onProgress?: UploadProgressCallback
): Promise<UploadResult> {
  if (!file) {
    throw new Error('No file provided for upload.');
  }

  // Verify Firebase Storage bucket initialization
  const bucketName = storage.app.options.storageBucket;
  if (!bucketName) {
    const configError = new Error(
      'Firebase Storage is not properly configured: storageBucket is missing from Firebase app options.'
    );
    console.error('Firebase Storage Configuration Error:', {
      error: configError.message,
      appOptions: storage.app.options,
    });
    throw configError;
  }

  // Sanitize file name and build structured storage path: receipts/YYYY-MM/{timestamp}_{safeName}
  const dateFolder = new Date().toISOString().slice(0, 7); // e.g. 2026-09
  const timestamp = Date.now();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const refPrefix = bookingReference ? `${bookingReference}_` : '';
  const storagePath = `receipts/${dateFolder}/${refPrefix}${timestamp}_${safeName}`;

  const storageRef = ref(storage, storagePath);
  const contentType = resolveContentType(file);

  // Normalize File into a clean Blob with explicit content type
  const fileBlob = new Blob([file], { type: contentType });

  const metadata = {
    contentType,
    customMetadata: {
      originalName: file.name,
      bookingReference: bookingReference || 'pending',
      uploadedAt: new Date().toISOString(),
    },
  };

  return new Promise<UploadResult>((resolve, reject) => {
    let isSettled = false;
    let bytesTransferredSoFar = 0;

    // CORS & Stall Guard:
    // If the upload task fails to transfer any bytes within 6 seconds, abort
    // and notify the caller so the UI automatically triggers the compressed Base64 fallback.
    const STALL_TIMEOUT_MS = 6000;
    let uploadTask: ReturnType<typeof uploadBytesResumable>;

    try {
      uploadTask = uploadBytesResumable(storageRef, fileBlob, metadata);
    } catch (initErr: any) {
      console.error('Failed to initialize uploadBytesResumable task:', {
        code: initErr?.code,
        message: initErr?.message,
        storageBucket: bucketName,
        storagePath,
      });
      reject(initErr);
      return;
    }

    const stallTimer = setTimeout(() => {
      if (!isSettled && bytesTransferredSoFar === 0) {
        isSettled = true;
        try {
          uploadTask.cancel();
        } catch {
          // Ignore cancel error if already aborted
        }

        const stallError = new Error(
          'Upload stalled at 0%. This typically occurs when Firebase Storage CORS is not configured for web origins or unauthenticated write permissions are restricted in Storage Security Rules.'
        );
        (stallError as any).code = 'storage/stalled-or-cors';

        console.error('Firebase Storage upload stalled at 0%:', {
          code: 'storage/stalled-or-cors',
          message: stallError.message,
          storageBucket: bucketName,
          storagePath,
          fileName: file.name,
        });

        reject(stallError);
      }
    }, STALL_TIMEOUT_MS);

    uploadTask.on(
      'state_changed',
      (snapshot) => {
        bytesTransferredSoFar = snapshot.bytesTransferred;
        if (snapshot.totalBytes > 0) {
          const progress = Math.round(
            (snapshot.bytesTransferred / snapshot.totalBytes) * 100
          );
          if (onProgress) {
            onProgress(progress);
          }
        }
      },
      (error: any) => {
        clearTimeout(stallTimer);
        if (isSettled) return;
        isSettled = true;

        const errorCode = error?.code || 'storage/unknown';
        const serverResponse = error?.serverResponse || null;

        console.error('Firebase Storage uploadBytesResumable error:', {
          code: errorCode,
          message: error.message,
          name: error.name,
          serverResponse,
          storageBucket: bucketName,
          storagePath,
          fileName: file.name,
        });

        // Formulate informative, user-facing error message
        let friendlyMessage = error.message;
        if (errorCode === 'storage/unauthorized') {
          friendlyMessage =
            'Permission denied (storage/unauthorized). Please verify Firebase Storage rules allow image write permissions.';
        } else if (errorCode === 'storage/canceled') {
          friendlyMessage =
            'Upload was cancelled or timed out due to CORS / network restriction.';
        } else if (errorCode === 'storage/retry-limit-exceeded') {
          friendlyMessage =
            'Upload failed: Retry limit exceeded. Network or CORS preflight blocked connection to Firebase Storage.';
        } else if (errorCode === 'storage/unknown') {
          friendlyMessage = `Upload failed: Network or CORS issue connecting to Firebase Storage bucket ${bucketName}.`;
        }

        const enhancedError = new Error(friendlyMessage);
        (enhancedError as any).code = errorCode;
        (enhancedError as any).serverResponse = serverResponse;
        (enhancedError as any).originalError = error;

        reject(enhancedError);
      },
      async () => {
        clearTimeout(stallTimer);
        if (isSettled) return;
        isSettled = true;

        try {
          const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
          resolve({
            downloadUrl,
            storagePath,
            fileName: file.name,
            sizeBytes: file.size,
            contentType,
          });
        } catch (downloadErr: any) {
          console.error('Failed to retrieve Firebase Storage download URL:', {
            code: downloadErr?.code,
            message: downloadErr?.message,
            storagePath,
          });
          reject(downloadErr);
        }
      }
    );
  });
}

