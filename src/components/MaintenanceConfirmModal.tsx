import React, { useState, useEffect, useRef } from 'react';
import { X, Lock } from 'lucide-react';
import { PinCodeInput } from './PinCodeInput';

interface MaintenanceConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  isCurrentlyActive: boolean;
  onConfirm: (pin: string, confirmation: string) => Promise<boolean>;
}

export const MaintenanceConfirmModal: React.FC<MaintenanceConfirmModalProps> = ({
  isOpen,
  onClose,
  isCurrentlyActive,
  onConfirm,
}) => {
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isShaking, setIsShaking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const pinInputRef = useRef<HTMLInputElement>(null);
  const confirmInputRef = useRef<HTMLInputElement>(null);

  // Target state: if currently active, target is OFF (restore). If currently inactive, target is ON (activate).
  const targetStateActive = !isCurrentlyActive;

  // Reset state whenever modal opens or closes
  useEffect(() => {
    if (isOpen) {
      setPin('');
      setConfirmation('');
      setErrorMessage(null);
      setIsExecuting(false);
      setIsShaking(false);
      setTimeout(() => {
        pinInputRef.current?.focus();
      }, 150);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isPinComplete = pin.length === 4;
  const isConfirmationMatched = confirmation.trim().toUpperCase() === 'CONFIRM';
  const canSubmit = isPinComplete && isConfirmationMatched && !isExecuting;

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setErrorMessage(null);

    // Validate PIN
    if (pin.trim() !== '0912') {
      setIsShaking(true);
      setErrorMessage('Incorrect Admin PIN. Please enter the 4-digit code.');
      setTimeout(() => setIsShaking(false), 600);
      return;
    }

    // Validate confirmation phrase
    if (!isConfirmationMatched) {
      setErrorMessage('Please type CONFIRM in the verification box to proceed.');
      confirmInputRef.current?.focus();
      return;
    }

    try {
      setIsExecuting(true);
      const success = await onConfirm(pin.trim(), confirmation.trim().toUpperCase());
      if (success) {
        onClose();
      } else {
        setErrorMessage('Failed to update maintenance status. Please check connection.');
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to update maintenance status.');
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby="maintenance-modal-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[440px] rounded-3xl border border-white/15 bg-[#431E82] p-7 sm:p-8 shadow-2xl relative text-white"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          disabled={isExecuting}
          className="absolute top-5 right-5 h-8 w-8 rounded-full border border-white/15 bg-white/5 flex items-center justify-center text-white/60 hover:text-white hover:bg-white/15 transition-colors cursor-pointer"
          aria-label="Close modal"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Brand Header */}
        <div className="flex items-center justify-between pb-5 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full bg-[#00C6FF] shadow-sm shadow-[#00C6FF]/60" />
            <span className="font-heading text-lg font-black uppercase tracking-tight text-white">
              MATCH<span className="text-[#00C6FF]">&amp;</span>SIP
            </span>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-black uppercase tracking-wider border ${
              targetStateActive
                ? 'bg-amber-400/10 border-amber-400/30 text-amber-300'
                : 'bg-emerald-400/10 border-emerald-400/30 text-emerald-300'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                targetStateActive ? 'bg-amber-400' : 'bg-emerald-400'
              }`}
            />
            {targetStateActive ? 'MAINTENANCE' : 'NORMAL'}
          </span>
        </div>

        {/* Title & Concise Description */}
        <div className="mt-6 mb-6">
          <div className="text-[11px] font-black uppercase tracking-[0.2em] text-[#00C6FF] mb-1">
            SYSTEM ACCESS
          </div>
          <h2
            id="maintenance-modal-title"
            className="font-heading text-2xl font-black uppercase tracking-tight text-white leading-tight"
          >
            {targetStateActive ? 'ACTIVATE MAINTENANCE' : 'RESTORE NORMAL SITE'}
          </h2>
          <p className="mt-2 text-xs text-[#B3A2DB] leading-relaxed font-normal">
            {targetStateActive
              ? 'Locks out active customer booking sessions across all devices in real time until toggled off.'
              : 'Re-enables live court booking matrix and instant checkout across all connected devices.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Gate 1: PIN Input */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor="maintenance-pin-input"
                className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-white"
              >
                <Lock className="h-3.5 w-3.5 text-[#00C6FF]" />
                <span>1. ADMIN PIN</span>
              </label>
              <span className="text-[10px] font-mono font-bold text-[#00C6FF]">REQUIRED</span>
            </div>

            <PinCodeInput
              pin={pin}
              onChange={(newPin) => {
                setPin(newPin);
                setErrorMessage(null);
                if (newPin.length === 4) {
                  confirmInputRef.current?.focus();
                }
              }}
              onSubmit={() => {
                if (isConfirmationMatched) {
                  handleSubmit();
                } else {
                  confirmInputRef.current?.focus();
                }
              }}
              inputRef={pinInputRef}
              isShaking={isShaking}
              autoFocus={true}
              id="maintenance-pin-input"
            />
          </div>

          {/* Gate 2: Confirmation Input */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor="confirmation-input"
                className="text-xs font-black uppercase tracking-wider text-white"
              >
                2. TYPE <span className="text-[#00C6FF]">"CONFIRM"</span>
              </label>
              <span className="text-[10px] text-white/50">VERIFICATION</span>
            </div>

            <input
              ref={confirmInputRef}
              id="confirmation-input"
              type="text"
              value={confirmation}
              onChange={(e) => {
                setConfirmation(e.target.value.toUpperCase());
                setErrorMessage(null);
              }}
              placeholder="CONFIRM"
              autoComplete="off"
              className={`w-full rounded-2xl border px-4 py-3.5 text-center text-sm font-mono font-black tracking-[0.25em] text-white placeholder:text-white/25 uppercase transition-all focus:outline-none ${
                isConfirmationMatched
                  ? 'border-emerald-400 bg-emerald-500/10 shadow-[0_0_15px_rgba(52,211,153,0.15)] ring-1 ring-emerald-400'
                  : 'border-white/15 bg-black/25 focus:border-[#00C6FF] focus:ring-1 focus:ring-[#00C6FF]'
              }`}
            />
          </div>

          {/* Error Message */}
          {errorMessage && (
            <div
              role="alert"
              className="rounded-xl bg-red-500/15 border border-red-400/30 px-3.5 py-2.5 text-xs font-bold text-red-200 text-center animate-in fade-in"
            >
              {errorMessage}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isExecuting}
              className="flex-1 cursor-pointer rounded-xl border border-white/20 bg-white/5 py-3.5 text-center text-xs font-black uppercase tracking-wider text-[#B3A2DB] hover:text-white hover:bg-white/10 transition-all disabled:opacity-50"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={!canSubmit}
              className={`flex-1 cursor-pointer rounded-xl py-3.5 px-4 text-center text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-lg ${
                !canSubmit
                  ? 'bg-white/10 text-white/30 border border-white/10 cursor-not-allowed'
                  : targetStateActive
                  ? 'bg-[#00C6FF] text-black hover:bg-[#00C6FF]/90 shadow-[#00C6FF]/25 active:scale-[0.99]'
                  : 'bg-emerald-400 text-black hover:bg-emerald-300 shadow-emerald-400/25 active:scale-[0.99]'
              }`}
            >
              {isExecuting ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-3.5 w-3.5 border-2 border-black border-t-transparent rounded-full animate-spin" />
                  Updating...
                </span>
              ) : (
                <span>{targetStateActive ? 'Lock Site Now' : 'Restore Site Now'}</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
