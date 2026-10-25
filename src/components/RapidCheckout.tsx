import React, { useState, useEffect, useRef } from 'react';
import { 
  Upload, 
  CheckCircle2, 
  AlertCircle, 
  ShieldCheck, 
  Trash2, 
  X, 
  Maximize2, 
  Download,
  Cloud,
  Loader2,
  RefreshCw
} from 'lucide-react';
import { SelectedSlot, ConfirmedBooking } from '../types';
import qrCodeImg from '../assets/images/INSTAPAY QR CODE.jpg';
import paddleUpImg from '../assets/images/Paddleup.jpg';
import { uploadReceiptToFirebaseStorage, compressImageToBase64, validateReceiptFile } from '../services/storageService';
import { validateSlotsLiveAvailability } from '../services/bookingService';
import { getTodayDateString } from '../utils/dateUtils';

interface RapidCheckoutProps {
  selectedDate: string;
  selectedSlots: SelectedSlot[];
  onBookingComplete: (booking: ConfirmedBooking) => Promise<void> | void;
  onNavigateToMatrix: () => void;
}

const COURT_SAFETY_RULES = [
  { num: '01', text: 'Warm up and stretch before playing.' },
  { num: '02', text: 'Wear appropriate sports attire and non-marking court shoes.' },
  { num: '03', text: 'Inspect the playing area before starting; report wet surfaces, loose nets, or hazards immediately.' },
  { num: '04', text: 'Stay aware of your surroundings (partner, opponents, equipment, court boundaries).' },
  { num: '05', text: 'Avoid reckless play; do not intentionally hit the ball toward another person at close range.' },
  { num: '06', text: 'Do not enter another court while a rally is in progress.' },
  { num: '07', text: 'Retrieve loose balls carefully and signal before entering another court.' },
  { num: '08', text: 'Use equipment properly (no swinging paddles dangerously, throwing equipment, or climbing on nets).' },
  { num: '09', text: 'Stop playing immediately if you feel unwell, dizzy, experience chest pain, or have trouble breathing.' },
  { num: '10', text: 'Know your physical limits and assess your condition safely.' },
  { num: '11', text: 'Keep personal items (bags, bottles, paddles) in designated areas outside the court boundaries.' },
  { num: '12', text: 'Report all accidents and hazards immediately to court staff.' },
  { num: '13', text: 'No smoking / vaping: Smoking, vaping, or using e-cigarettes is strictly prohibited anywhere within the court premises.' },
  { num: '14', text: 'No food and drinks shall be allowed inside the court area.' },
  { num: '15', text: 'Kindly park at the designated parking area at the back of the court, it is discouraged to park in front of the shop' },
  { num: '16', text: 'Use the side entrance to enter Match & Sip.'},
];

export const RapidCheckout: React.FC<RapidCheckoutProps> = ({
  selectedDate,
  selectedSlots,
  onBookingComplete,
  onNavigateToMatrix,
}) => {
  // Restore draft inputs from local storage so network flickers don't lose typed data
  const [fullName, setFullName] = useState<string>(() => {
    try {
      const draft = localStorage.getItem('matchsip_checkout_draft');
      if (draft) {
        const parsed = JSON.parse(draft);
        return parsed.fullName || '';
      }
    } catch {}
    return '';
  });

  const [phoneNumber, setPhoneNumber] = useState<string>(() => {
    try {
      const draft = localStorage.getItem('matchsip_checkout_draft');
      if (draft) {
        const parsed = JSON.parse(draft);
        return parsed.phoneNumber || '';
      }
    } catch {}
    return '';
  });

  const [safetyAgreed, setSafetyAgreed] = useState(false);
  const [showSafetyModal, setShowSafetyModal] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [showReceiptPreviewModal, setShowReceiptPreviewModal] = useState(false);

  // Sync draft to local storage so connection drops keep user input safe
  useEffect(() => {
    try {
      localStorage.setItem(
        'matchsip_checkout_draft',
        JSON.stringify({ fullName, phoneNumber })
      );
    } catch {}
  }, [fullName, phoneNumber]);

  // Payment receipt states
  const [proofImage, setProofImage] = useState<string | null>(null);
  const [proofFileName, setProofFileName] = useState<string | null>(null);
  const [storageDownloadUrl, setStorageDownloadUrl] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [isUploadingProof, setIsUploadingProof] = useState(false);
  const [isFallbackBase64, setIsFallbackBase64] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isNetworkFailure, setIsNetworkFailure] = useState(false);

  // Listen to network online recovery
  useEffect(() => {
    const handleOnline = () => {
      setIsNetworkFailure(false);
      if (errorMessage && errorMessage.includes('offline')) {
        setErrorMessage(null);
      }
    };
    const handleOffline = () => {
      setIsNetworkFailure(true);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [errorMessage]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalPrice = selectedSlots.reduce((acc, curr) => acc + curr.price, 0);
  const reservationDate = selectedSlots.length > 0 ? selectedSlots[0].date : selectedDate;

  // Validation flags for requiring fields before booking is clickable
  const isNameFilled = fullName.trim().length > 0;
  const isPhoneFilled = phoneNumber.trim().replace(/\D/g, '').length === 10;
  const isProofUploaded = Boolean((proofImage || storageDownloadUrl) && !isUploadingProof);
  const isFormValid = Boolean(
    selectedSlots.length > 0 &&
    isNameFilled &&
    isPhoneFilled &&
    isProofUploaded &&
    safetyAgreed &&
    !isSubmitting
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  /**
   * Upload the selected photo file directly to Firebase Storage and capture the download URL.
   * If Firebase Storage fails or stalls, automatically falls back to an optimized compressed
   * Base64 string and attaches it to the reservation state.
   */
  const uploadFileToStorage = async (file: File) => {
    setIsUploadingProof(true);
    setUploadProgress(0);
    setUploadError(null);
    setIsFallbackBase64(false);

    try {
      const tempRef = `MS-${Math.floor(100000 + Math.random() * 900000)}`;
      const result = await uploadReceiptToFirebaseStorage(file, tempRef, (percent) => {
        setUploadProgress(percent);
      });

      // Successfully retrieved Firebase Storage download URL
      setStorageDownloadUrl(result.downloadUrl);
      setProofImage(result.downloadUrl);
      setIsUploadingProof(false);
      setIsFallbackBase64(false);
      setUploadError(null);
      setErrorMessage(null);
    } catch (err: any) {
      console.warn('Firebase Storage upload failed or stalled. Automatically falling back to compressed Base64 proof:', {
        code: err?.code,
        message: err?.message,
        serverResponse: err?.serverResponse,
      });

      try {
        // Automatically compress image into optimized Base64 and attach to reservation state
        const compressedBase64 = await compressImageToBase64(file);
        setStorageDownloadUrl(compressedBase64);
        setProofImage(compressedBase64);
        setIsFallbackBase64(true);
        setIsUploadingProof(false);
        setUploadError(null);
        setErrorMessage(null);
      } catch (fallbackErr) {
        console.error('Compressed Base64 fallback error:', fallbackErr);
        setIsUploadingProof(false);
        const friendlyMessage =
          err?.message || 'Upload failed and compression fallback was unable to process the file.';
        setUploadError(friendlyMessage);
      }
    }
  };

  const processFile = (file: File) => {
    const validation = validateReceiptFile(file);
    if (!validation.isValid) {
      setErrorMessage(
        validation.error || 'Please upload a valid JPG, PNG, or WebP screenshot under 5MB.'
      );
      return;
    }

    setCurrentFile(file);
    setProofFileName(file.name);
    setErrorMessage(null);
    setUploadError(null);

    // Create instant local thumbnail for responsive UX while uploading
    const reader = new FileReader();
    reader.onload = (e) => {
      setProofImage(e.target?.result as string);
    };
    reader.readAsDataURL(file);

    // Upload file to Firebase Storage
    uploadFileToStorage(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const removeProof = () => {
    setProofImage(null);
    setProofFileName(null);
    setStorageDownloadUrl(null);
    setCurrentFile(null);
    setIsUploadingProof(false);
    setIsFallbackBase64(false);
    setUploadProgress(0);
    setUploadError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (selectedSlots.length === 0) {
      setErrorMessage('Please select at least one court slot in the matrix above.');
      onNavigateToMatrix();
      return;
    }

    if (!fullName.trim()) {
      setErrorMessage('Please enter your full name.');
      return;
    }

    if (!phoneNumber.trim() || phoneNumber.trim().replace(/\D/g, '').length !== 10) {
      setErrorMessage('Please enter a valid 10-digit mobile number (e.g. 9XX XXX XXXX).');
      return;
    }

    if (isUploadingProof) {
      setErrorMessage('Please wait a moment for your receipt to finish processing...');
      return;
    }

    if (!storageDownloadUrl && !proofImage) {
      setErrorMessage('Please upload your InstaPay payment screenshot proof.');
      return;
    }

    if (!safetyAgreed) {
      setErrorMessage('Please agree to the Pickleball Court Safety Reminders.');
      return;
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsNetworkFailure(true);
      setErrorMessage(
        'You appear to be offline. Your selected slots and form details are safely saved on this device. Tap "Retry Reservation" once your network reconnects.'
      );
      setIsSubmitting(false);
      return;
    }

    setIsSubmitting(true);

    try {
      // 0. Live concurrency guard: verify slots have not been claimed by another player while in checkout
      const availabilityCheck = await validateSlotsLiveAvailability(selectedSlots, reservationDate);
      if (!availabilityCheck.isAvailable) {
        setErrorMessage(
          availabilityCheck.conflictReason ||
          'One or more of your selected court slots was just reserved by another player. Please choose an open slot.'
        );
        setIsSubmitting(false);
        return;
      }

      // Ensure we have the payment proof URL (Storage download URL or verified compressed Base64)
      let finalProofUrl = storageDownloadUrl || proofImage;
      if (!finalProofUrl && currentFile) {
        try {
          const uploadResult = await uploadReceiptToFirebaseStorage(currentFile);
          finalProofUrl = uploadResult.downloadUrl;
          setStorageDownloadUrl(finalProofUrl);
        } catch (uploadErr) {
          console.warn('Firebase Storage upload failed on submit, converting to compressed Base64 fallback:', uploadErr);
          const compressed = await compressImageToBase64(currentFile);
          finalProofUrl = compressed;
          setProofImage(compressed);
          setStorageDownloadUrl(compressed);
          setIsFallbackBase64(true);
        }
      }

      if (!finalProofUrl) {
        throw new Error('Payment receipt screenshot proof is required.');
      }

      const bookingRef = `MS-${Math.floor(100000 + Math.random() * 900000)}`;
      const nowIso = new Date().toISOString();
      const newBooking: ConfirmedBooking = {
        bookingReference: bookingRef,
        selectedDate: reservationDate,
        paymentMethod: 'InstaPay QR',
        customer: {
          fullName: fullName.trim(),
          phoneNumber: `+63 ${phoneNumber.trim()}`,
          email: `${fullName.toLowerCase().replace(/\s+/g, '')}@example.com`,
        },
        slots: selectedSlots,
        totalAmount: totalPrice,
        paymentProofUrl: finalProofUrl,
        confirmedAt: nowIso,
        createdAt: nowIso,
        bookedAt: nowIso,
        paidAt: nowIso,
        status: 'VERIFIED',
      };

      await onBookingComplete(newBooking);

      // Reset form & cached draft on success
      setFullName('');
      setPhoneNumber('');
      setSafetyAgreed(false);
      removeProof();
      setIsNetworkFailure(false);
      try {
        localStorage.removeItem('matchsip_checkout_draft');
      } catch {}
    } catch (err: unknown) {
      console.error('Submission error:', err);
      const isNet =
        (typeof navigator !== 'undefined' && !navigator.onLine) ||
        (err instanceof Error &&
          (err.message.includes('fetch') ||
            err.message.includes('network') ||
            err.message.includes('Network') ||
            err.message.includes('Failed to fetch')));
      if (isNet) {
        setIsNetworkFailure(true);
        setErrorMessage(
          'Connection flickered during checkout. Don’t worry! Your slots and details are saved on your phone. Tap "Retry Reservation" to confirm.'
        );
      } else {
        setIsNetworkFailure(false);
        setErrorMessage(
          err instanceof Error 
            ? err.message 
            : 'Could not complete reservation. Please try again.'
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section id="rapid-checkout" className="w-full bg-[#5E2CB2] text-[#FFFFFF] py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-10 items-start">
          
          {/* Left Column: Reservation Summary */}
          <div className="flex flex-col gap-6">
            {/* Paddle Photo inside a rounded container (rounded-2xl) */}
            <div className="overflow-hidden rounded-2xl border border-[#B3A2DB]/40 bg-[#5E2CB2] shadow-xl">
              {/* Paddle Photo (Lazy Loaded) */}
              <img
                src={paddleUpImg}
                alt="Paddle Up"
                loading="lazy"
                decoding="async"
                width={640}
                height={360}
                className="w-full aspect-[16/9] object-cover"
                referrerPolicy="no-referrer"
              />
            </div>

            {/* YOUR RESERVATION summary card */}
            <div className="rounded-2xl border border-[#B3A2DB]/40 bg-[#5E2CB2] p-6 shadow-xl flex flex-col gap-4">
              <div className="flex items-center justify-between pb-3 border-b border-[#B3A2DB]/30">
                <span className="text-xs font-black uppercase tracking-widest text-[#00C6FF]">
                  YOUR RESERVATION
                </span>
                <div className="flex items-center gap-2">
                  {reservationDate === getTodayDateString() && (
                    <span className="inline-flex items-center gap-1 rounded bg-[#00C6FF]/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#00C6FF]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#00C6FF] animate-pulse" />
                      TODAY
                    </span>
                  )}
                  <span className="text-xs font-mono font-bold text-[#FFFFFF]">
                    {reservationDate}
                  </span>
                </div>
              </div>

              {/* Slot list or empty alert */}
              <div className="min-h-[70px] flex flex-col justify-center">
                {selectedSlots.length === 0 ? (
                  <p className="text-xs sm:text-sm text-[#B3A2DB] leading-relaxed">
                    No slots selected for <span className="font-semibold text-white">{reservationDate === getTodayDateString() ? `Today (${reservationDate})` : reservationDate}</span>. Head back to the matrix to pick your courts and times.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {selectedSlots.map((s, idx) => (
                      <div
                        key={`${s.slotId}-${idx}`}
                        className="flex items-center justify-between text-xs sm:text-sm py-1 border-b border-[#B3A2DB]/20 last:border-0"
                      >
                        <span className="font-bold text-[#FFFFFF]">
                          {s.courtName}: {s.timeLabel.replace(/\s*-\s*/, '-')}
                        </span>
                        <span className="font-mono text-[#00C6FF] font-bold">
                          ₱{s.price}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* TOTAL ROW */}
              <div className="pt-3 border-t border-[#B3A2DB]/30 flex items-center justify-between">
                <span className="text-sm font-black uppercase tracking-widest text-[#FFFFFF]">
                  TOTAL
                </span>
                <span className="font-heading text-3xl sm:text-4xl font-black text-[#00C6FF]">
                  ₱{totalPrice}
                </span>
              </div>
            </div>
          </div>

          {/* Right Column: Checkout Form */}
          <div className="flex flex-col gap-6">
            {/* Section Eyebrow & Headline */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-black uppercase tracking-widest text-[#00C6FF]">
                  RAPID CHECKOUT
                </span>
              </div>
              <h2 className="font-heading text-4xl sm:text-6xl font-black uppercase tracking-tight text-[#FFFFFF] leading-[0.95]">
                CONFIRM<br />
                YOUR SERVE
              </h2>
            </div>

            {/* Checkout Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Full Name input */}
              <div>
                <input
                  type="text"
                  id="checkout-name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Your name"
                  required
                  className={`w-full rounded-xl border px-4 py-3.5 sm:py-4 text-base sm:text-sm font-medium text-[#FFFFFF] placeholder-[#B3A2DB]/70 transition-all focus:outline-none focus:ring-1 focus:ring-[#00C6FF] min-h-[50px] ${
                    isNameFilled
                      ? 'border-[#00C6FF]/70 bg-[#5E2CB2]'
                      : 'border-[#B3A2DB]/50 bg-[#5E2CB2]'
                  }`}
                />
              </div>

              {/* Phone number input with +63 prefix */}
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="flex h-12.5 sm:h-13 items-center justify-center rounded-xl border border-[#B3A2DB]/50 bg-[#5E2CB2] px-4 text-base sm:text-sm font-bold text-[#FFFFFF] min-h-[50px]">
                    +63
                  </div>
                  <div className="relative flex-1">
                    <input
                      type="tel"
                      id="checkout-phone"
                      value={phoneNumber}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
                        setPhoneNumber(digits);
                      }}
                      maxLength={10}
                      inputMode="numeric"
                      pattern="[0-9]{10}"
                      placeholder="9XX XXX XXXX"
                      required
                      className={`w-full rounded-xl border px-4 py-3.5 sm:py-4 pr-14 text-base sm:text-sm font-mono font-medium tracking-wider text-[#FFFFFF] placeholder-[#B3A2DB]/70 transition-all focus:outline-none focus:ring-1 focus:ring-[#00C6FF] min-h-[50px] ${
                        isPhoneFilled
                          ? 'border-[#00C6FF]/80 bg-[#5E2CB2] shadow-[0_0_12px_rgba(0,198,255,0.15)]'
                          : 'border-[#B3A2DB]/50 bg-[#5E2CB2]'
                      }`}
                    />
                    <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                      <span className={`text-[11px] font-mono font-bold transition-colors ${
                        isPhoneFilled
                          ? 'text-[#00C6FF]'
                          : phoneNumber.length > 0
                          ? 'text-[#B3A2DB]'
                          : 'text-[#B3A2DB]/40'
                      }`}>
                        {phoneNumber.length}/10
                      </span>
                    </div>
                  </div>
                </div>
                {phoneNumber.length > 0 && phoneNumber.length < 10 && (
                  <p className="px-1 text-[11px] text-[#00C6FF]/90 font-medium">
                    Please enter {10 - phoneNumber.length} more digit{10 - phoneNumber.length > 1 ? 's' : ''} (10 digits total)
                  </p>
                )}
              </div>

              {/* InstaPay QR Box with User's Uploaded QR Code */}
              <div className="rounded-2xl border border-[#B3A2DB]/40 bg-[#5E2CB2] p-4 sm:p-5 flex flex-col sm:flex-row items-center gap-4 sm:gap-6 shadow-inner">
                {/* Official InstaPay QR Card */}
                <div className="group relative flex shrink-0 flex-col items-center justify-center rounded-2xl bg-[#FFFFFF] p-2.5 shadow-xl transition-all hover:shadow-2xl">
                  <div className="relative overflow-hidden rounded-xl bg-white p-1">
                    <img
                      src={qrCodeImg}
                      alt="InstaPay QR Code for DA*A MI**A T."
                      className="h-32 w-32 object-contain sm:h-36 sm:w-36"
                      referrerPolicy="no-referrer"
                    />
                    {/* Hover enlarge button */}
                    <button
                      type="button"
                      onClick={() => setShowQrModal(true)}
                      className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl cursor-pointer"
                      aria-label="Enlarge QR Code"
                    >
                      <span className="flex items-center gap-1 rounded-full bg-[#00C6FF] px-2.5 py-1 text-[10px] font-black uppercase text-black shadow-md">
                        <Maximize2 className="h-3 w-3" /> Zoom
                      </span>
                    </button>
                  </div>

                  {/* Merchant information below QR */}
                  <div className="mt-1.5 flex flex-col items-center text-center">
                    <span className="text-[10px] font-medium text-gray-500">
                      Transfer fees may apply.
                    </span>
                    <span className="text-xs font-black tracking-wider text-[#0B63CE] uppercase">
                      DA*A MI**A T.
                    </span>
                  </div>
                </div>

                {/* QR instructions & actions */}
                <div className="flex flex-col text-center sm:text-left flex-1">
                  <span className="text-xs sm:text-sm font-black uppercase tracking-wider text-[#00C6FF]">
                    SCAN TO PAY • ₱{totalPrice}
                  </span>
                  <p className="mt-1 text-xs text-[#B3A2DB] leading-relaxed">
                    Scan this InstaPay QR code using GCash, Maya, BDO, or any QR Ph banking app to transfer exactly ₱{totalPrice}.
                  </p>

                  <div className="mt-2.5 flex flex-col gap-0.5 text-xs">
                    <div className="flex items-center justify-center sm:justify-start gap-1.5">
                      <span className="text-[#B3A2DB]">Account:</span>
                      <span className="font-extrabold text-[#FFFFFF]">DA*A MI**A T.</span>
                    </div>
                    <div className="flex items-center justify-center sm:justify-start gap-1.5">
                      <span className="text-[#B3A2DB]">Network:</span>
                      <span className="font-semibold text-[#00C6FF]">InstaPay / QR Ph</span>
                    </div>
                  </div>

                  <div className="mt-3.5 flex flex-wrap items-center justify-center sm:justify-start gap-2">
                    <button
                      type="button"
                      onClick={() => setShowQrModal(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[#00C6FF]/50 bg-[#5E2CB2] px-3 py-1.5 text-xs font-bold text-[#00C6FF] hover:bg-[#00C6FF]/10 transition-colors cursor-pointer"
                    >
                      <Maximize2 className="h-3.5 w-3.5" /> Enlarge QR
                    </button>
                    <a
                      href={qrCodeImg}
                      download="MATCH_AND_SIP_QR.jpg"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[#B3A2DB]/40 bg-[#5E2CB2] px-3 py-1.5 text-xs font-bold text-[#FFFFFF] hover:text-[#00C6FF] hover:border-[#00C6FF] transition-colors"
                    >
                      <Download className="h-3.5 w-3.5" /> Save QR
                    </a>
                  </div>
                </div>
              </div>

              {/* Notice Box */}
              <div className="rounded-xl border border-[#00C6FF]/40 bg-[#5E2CB2] px-4 py-3.5 sm:px-5 sm:py-4 shadow-sm">
                <p className="text-xs sm:text-sm font-bold uppercase tracking-wide text-[#ffd200] leading-relaxed">
                  NOTE: NO PAYMENT REFUND ONCE RESERVED. ALL BOOKINGS ARE FINAL AND NON-REFUNDABLE.
                </p>
              </div>

              {/* Payment Proof Upload Area */}
              <div className="space-y-2">
                <label className="block text-[11px] sm:text-xs font-bold uppercase tracking-wider text-[#B3A2DB]">
                  PAYMENT PROOF (JPG, PNG, OR WEBP • MAX 5MB)
                </label>

                <input
                  type="file"
                  ref={fileInputRef}
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleFileChange}
                  className="hidden"
                />

                {!proofImage && !isUploadingProof ? (
                  /* Reverted upload card colors back to purple/cyan palette */
                  <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`flex items-center gap-3 w-full cursor-pointer rounded-xl border px-4 py-3.5 sm:px-5 sm:py-4 transition-all ${
                      isDragging
                        ? 'border-[#00C6FF] bg-[#00C6FF]/15 scale-[1.01]'
                        : 'border-[#B3A2DB]/40 bg-[#5E2CB2] hover:border-[#00C6FF] hover:bg-[#5E2CB2]/80'
                    }`}
                  >
                    <Upload className="h-5 w-5 text-[#00C6FF] shrink-0" />
                    <span className="text-xs sm:text-sm font-medium text-[#FFFFFF]">
                      Upload payment screenshot (JPG, PNG, or WebP &bull; Max 5MB)
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 rounded-xl border border-[#00C6FF]/50 bg-[#5E2CB2] p-3.5 sm:p-4 shadow-lg">
                    <div className="flex items-center justify-between gap-3">
                      {/* Image Thumbnail with zoom trigger */}
                      <div className="relative group shrink-0">
                        {proofImage ? (
                          <img
                            src={proofImage}
                            alt="Payment receipt proof preview"
                            className="h-12 w-12 rounded-lg object-cover border border-[#00C6FF]/50 shadow-sm"
                          />
                        ) : (
                          <div className="h-12 w-12 rounded-lg bg-white/10 flex items-center justify-center border border-[#B3A2DB]/40">
                            <Cloud className="h-5 w-5 text-[#B3A2DB]" />
                          </div>
                        )}
                        {proofImage && (
                          <button
                            type="button"
                            onClick={() => setShowReceiptPreviewModal(true)}
                            className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg cursor-pointer"
                            title="View enlarged receipt"
                          >
                            <Maximize2 className="h-3 w-3 text-white" />
                          </button>
                        )}
                      </div>

                      {/* File Info & Upload Status */}
                      <div className="flex flex-col flex-1 min-w-0">
                        <span className="text-xs font-bold text-[#FFFFFF] truncate">
                          {proofFileName || 'payment_receipt.jpg'}
                        </span>
                        
                        {isUploadingProof ? (
                          <div className="mt-1 flex flex-col gap-1">
                            <span className="text-[11px] font-bold text-[#00C6FF] flex items-center gap-1.5">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Uploading to Firebase Storage ({uploadProgress}%)...
                            </span>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/15">
                              <div
                                className="h-full bg-[#00C6FF] transition-all duration-200"
                                style={{ width: `${uploadProgress}%` }}
                              />
                            </div>
                          </div>
                        ) : uploadError ? (
                          <div className="mt-1 flex flex-col gap-1 text-[11px] font-medium text-red-300">
                            <div className="flex items-start gap-1.5">
                              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400 mt-0.5" />
                              <span className="leading-snug">{uploadError}</span>
                            </div>
                          </div>
                        ) : (
                          <span className="mt-1 text-[11px] font-bold text-[#00C6FF] flex items-center gap-1">
                            <CheckCircle2 className="h-3.5 w-3.5 text-[#00C6FF]" />
                            Payment proof attached • Ready
                          </span>
                        )}
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-1.5 shrink-0">
                        {uploadError && currentFile && (
                          <button
                            type="button"
                            onClick={() => uploadFileToStorage(currentFile)}
                            className="inline-flex items-center gap-1 rounded-lg bg-[#00C6FF] px-2 py-1 text-[11px] font-bold text-black hover:bg-[#00C6FF]/90 transition-colors cursor-pointer"
                            title="Retry upload"
                          >
                            <RefreshCw className="h-3 w-3" /> Retry
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="rounded-lg bg-white/10 hover:bg-white/20 px-2 py-1 text-[11px] font-medium text-white transition-colors cursor-pointer"
                          title="Choose a different screenshot"
                        >
                          Change
                        </button>
                        <button
                          type="button"
                          onClick={removeProof}
                          className="rounded-lg p-1.5 text-[#B3A2DB] hover:bg-red-500/20 hover:text-red-300 transition-colors cursor-pointer"
                          title="Remove screenshot"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Safety Reminders Button */}
              <div className="pt-1">
                <button
                  type="button"
                  id="safety-agreement-checkbox"
                  onClick={() => setShowSafetyModal(true)}
                  className={`w-full flex items-center justify-between gap-3 rounded-xl border px-4 py-3.5 sm:px-5 sm:py-4 transition-all text-left cursor-pointer ${
                    safetyAgreed
                      ? 'border-[#00C6FF] bg-[#00C6FF]/15 text-[#FFFFFF]'
                      : 'border-[#B3A2DB]/40 bg-[#5E2CB2] hover:border-[#00C6FF] hover:bg-[#5E2CB2]/80 text-[#FFFFFF]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {safetyAgreed ? (
                      <CheckCircle2 className="h-5 w-5 text-[#00C6FF] shrink-0" />
                    ) : (
                      <ShieldCheck className="h-5 w-5 text-[#00C6FF] shrink-0" />
                    )}
                    <span className="text-xs sm:text-sm font-medium leading-snug text-[#FFFFFF]">
                      {safetyAgreed ? (
                        <>
                          Agreed to <span className="text-[#00C6FF] font-bold">Pickleball Court Safety Reminders</span>
                        </>
                      ) : (
                        <>
                          I have read and agree to the <span className="font-semibold text-white">Pickleball Court Safety Reminders</span>.
                        </>
                      )}
                    </span>
                  </div>

                  <span className="rounded-lg bg-[#00C6FF] hover:bg-[#00C6FF]/90 px-3 py-1.5 text-xs font-bold text-black transition-colors shrink-0 whitespace-nowrap">
                    {safetyAgreed ? 'View Reminders' : 'View Reminders'}
                  </span>
                </button>
              </div>

              {/* Error notice & Offline Fallback Action */}
              {errorMessage && (
                <div className="flex flex-col gap-2.5 rounded-xl bg-red-950/80 border border-red-500/60 p-3.5 text-xs text-red-200">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                    <span className="leading-relaxed flex-1">{errorMessage}</span>
                  </div>
                  {isNetworkFailure && (
                    <button
                      type="button"
                      onClick={handleSubmit}
                      disabled={isSubmitting || !isFormValid}
                      className="mt-1 w-full rounded-xl bg-[#00C6FF] py-3 px-4 text-center text-xs font-black uppercase tracking-wider text-black shadow-md hover:bg-[#00C6FF]/90 active:scale-95 cursor-pointer flex items-center justify-center gap-2 min-h-[46px]"
                    >
                      <RefreshCw className={`h-4 w-4 ${isSubmitting ? 'animate-spin' : ''}`} />
                      <span>Retry Reservation Now</span>
                    </button>
                  )}
                </div>
              )}

              {/* Action Button: BOOK RESERVATION */}
              <div className="pt-2">
                <button
                  type="submit"
                  id="book-reservation-btn"
                  disabled={!isFormValid}
                  className={`w-full rounded-xl py-4 sm:py-4.5 text-center text-xs sm:text-sm font-black uppercase tracking-wider transition-all min-h-[52px] sm:min-h-[56px] flex items-center justify-center gap-2 ${
                    isFormValid
                      ? 'bg-[#00C6FF] text-black shadow-lg shadow-[#00C6FF]/30 hover:bg-[#00C6FF]/90 hover:scale-[1.01] active:scale-95 cursor-pointer'
                      : 'bg-[#B3A2DB]/20 text-[#FFFFFF]/40 cursor-not-allowed border border-[#B3A2DB]/20 shadow-none'
                  }`}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                      <span>CONFIRMING RESERVATION...</span>
                    </>
                  ) : (
                    <span>BOOK RESERVATION</span>
                  )}
                </button>

                <p className="mt-2 text-center text-[11px] text-[#B3A2DB]">
                  {selectedSlots.length === 0
                    ? '↑ Select a court & slots in the matrix above first'
                    : !isNameFilled
                    ? 'Required: Please enter your full name'
                    : !isPhoneFilled
                    ? 'Required: Please enter your phone number'
                    : !isProofUploaded
                    ? (isUploadingProof ? 'Uploading receipt to Firebase Storage...' : 'Required: Please upload your InstaPay payment screenshot')
                    : !safetyAgreed
                    ? 'Required: Please agree to the court safety reminders'
                    : 'All requirements satisfied. Click to book!'}
                </p>
              </div>
            </form>
          </div>

        </div>
      </div>

      {/* Enlarged InstaPay QR Modal */}
      {showQrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in">
          <div className="relative w-full max-w-sm rounded-3xl border border-[#00C6FF]/60 bg-[#FFFFFF] p-6 text-black shadow-2xl text-center">
            <button
              type="button"
              onClick={() => setShowQrModal(false)}
              className="absolute top-4 right-4 rounded-full p-2 text-gray-600 hover:text-black hover:bg-gray-100 transition-colors"
              aria-label="Close QR modal"
            >
              <X className="h-5 w-5" />
            </button>

            <span className="text-[11px] font-black tracking-widest text-[#5E2CB2] uppercase block mb-3">
              Official InstaPay QR
            </span>

            <div className="mx-auto w-64 h-64 overflow-hidden rounded-2xl bg-white p-2 border border-gray-200 shadow-inner flex items-center justify-center">
              <img
                src={qrCodeImg}
                alt="Enlarged InstaPay QR Code"
                className="w-full h-full object-contain"
                referrerPolicy="no-referrer"
              />
            </div>

            <div className="mt-3">
              <p className="text-xs text-gray-500 font-medium">Transfer fees may apply.</p>
              <p className="text-base font-black tracking-wider text-[#0B63CE] uppercase mt-0.5">
                DA*A MI**A T.
              </p>
            </div>

            <div className="mt-4 pt-3 border-t border-gray-200 flex items-center justify-between text-xs">
              <span className="font-bold text-gray-700">Amount Due:</span>
              <span className="font-mono font-black text-base text-[#5E2CB2]">₱{totalPrice}</span>
            </div>

            <div className="mt-5 flex gap-2">
              <a
                href={qrCodeImg}
                download="MATCH_AND_SIP_QR.jpg"
                className="flex-1 rounded-xl border-2 border-[#5E2CB2] bg-[#FFFFFF] py-2.5 text-xs font-black uppercase tracking-wider text-[#5E2CB2] hover:bg-[#5E2CB2]/5 transition-colors inline-flex items-center justify-center gap-1.5"
              >
                <Download className="h-4 w-4" /> Save Image
              </a>
              <button
                type="button"
                onClick={() => setShowQrModal(false)}
                className="flex-1 rounded-xl bg-[#00C6FF] py-2.5 text-xs font-black uppercase tracking-wider text-black hover:bg-[#00C6FF]/90 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt Proof Zoom Modal */}
      {showReceiptPreviewModal && proofImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-in fade-in">
          <div className="relative max-w-md w-full rounded-2xl border border-white/20 bg-[#5E2CB2] p-5 text-white shadow-2xl">
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/20">
              <div className="flex items-center gap-2">
                <Cloud className="h-4 w-4 text-[#00C6FF]" />
                <span className="text-xs font-black uppercase text-[#00C6FF]">
                  Uploaded Payment Receipt
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowReceiptPreviewModal(false)}
                className="rounded-full p-1 text-white/70 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="overflow-hidden rounded-xl bg-black/40 p-2 flex items-center justify-center max-h-[65vh]">
              <img
                src={proofImage}
                alt="Enlarged payment screenshot proof"
                className="max-h-[60vh] w-auto object-contain rounded-lg"
                referrerPolicy="no-referrer"
              />
            </div>

            <div className="mt-3 flex items-center justify-between gap-2 text-xs">
              <span className="text-white/70 truncate text-[11px]">
                {proofFileName || 'payment_receipt.jpg'}
              </span>
              <button
                type="button"
                onClick={() => setShowReceiptPreviewModal(false)}
                className="rounded-lg bg-[#00C6FF] px-4 py-1.5 text-xs font-black uppercase tracking-wider text-black hover:bg-[#00C6FF]/90 transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Court Safety Reminders Modal */}
      {showSafetyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="relative w-full max-w-xl max-h-[90vh] flex flex-col rounded-3xl border border-[#00C6FF]/40 bg-[#5E2CB2] p-5 sm:p-7 text-[#FFFFFF] shadow-2xl shadow-black/60">
            {/* Header */}
            <div className="flex items-center justify-between pb-4 border-b border-[#B3A2DB]/20 shrink-0">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-[#00C6FF]/15 border border-[#00C6FF]/30 flex items-center justify-center shrink-0">
                  <ShieldCheck className="h-5 w-5 text-[#00C6FF]" />
                </div>
                <div>
                  <h3 className="font-heading text-lg sm:text-xl font-black uppercase tracking-tight text-[#FFFFFF] leading-tight">
                    Pickleball Court Safety Reminders
                  </h3>
                  <span className="text-[11px] font-bold tracking-wider uppercase text-[#00C6FF]">
                    14 Mandatory Safety Guidelines
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowSafetyModal(false)}
                className="rounded-full p-2 text-[#B3A2DB] hover:text-[#FFFFFF] hover:bg-white/10 transition-colors cursor-pointer"
                aria-label="Close safety reminders modal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Scrollable Rules List */}
            <div className="overflow-y-auto max-h-[58vh] pr-1.5 sm:pr-2.5 my-4 space-y-2.5">
              {COURT_SAFETY_RULES.map((rule) => (
                <div
                  key={rule.num}
                  className="group flex items-start gap-3 rounded-xl border border-[#B3A2DB]/25 bg-white/[0.05] hover:border-[#00C6FF]/40 hover:bg-white/[0.08] p-3 sm:p-3.5 transition-all"
                >
                  <span className="font-mono text-xs font-black px-2 py-0.5 rounded-md shrink-0 flex items-center justify-center min-w-[34px] mt-0.5 text-[#00C6FF] bg-[#00C6FF]/15 border border-[#00C6FF]/30">
                    {rule.num}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs sm:text-sm text-[#FFFFFF]/95 leading-relaxed font-medium">
                      {rule.text}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Modal Footer */}
            <div className="pt-3 border-t border-[#B3A2DB]/20 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setSafetyAgreed(true);
                  setShowSafetyModal(false);
                }}
                className="w-full rounded-xl bg-[#00C6FF] py-3.5 text-center text-xs sm:text-sm font-black uppercase tracking-wider text-black hover:bg-[#00C6FF]/90 shadow-lg shadow-[#00C6FF]/25 hover:scale-[1.01] active:scale-98 transition-all cursor-pointer font-bold"
              >
                I UNDERSTAND &amp; AGREE TO ALL RULES
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
