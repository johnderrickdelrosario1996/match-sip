import React, { useState, useEffect, useMemo } from 'react';
import { Calendar as CalendarIcon, Check, Lock, RotateCcw, Sparkles } from 'lucide-react';
import { generateSlotsForCourt } from '../data/mockData';
import { TimeSlot, SelectedSlot, ConfirmedBooking } from '../types';
import { CalendarPopup } from './CalendarPopup';
import { getTodayDateString, formatDateToDDMMYYYY } from '../utils/dateUtils';


interface BookingMatrixProps {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  selectedSlots: SelectedSlot[];
  persistedBookings: ConfirmedBooking[];
  isLoadingBookings: boolean;
  onToggleSlot: (slot: TimeSlot, dateStr: string) => void;
  onClearSlots: () => void;
  onProceedToCheckout: () => void;
  onOpenReservationsModal?: () => void;
}

export const BookingMatrix: React.FC<BookingMatrixProps> = ({
  selectedDate,
  onSelectDate,
  selectedSlots,
  persistedBookings,
  isLoadingBookings,
  onToggleSlot,
  onClearSlots,
  onProceedToCheckout,
  onOpenReservationsModal,
}) => {
  // Real-time current date state (synchronizes every 10 seconds to update on midnight/date change)
  const [currentTodayStr, setCurrentTodayStr] = useState<string>(() => getTodayDateString());
  const [isCalendarOpen, setIsCalendarOpen] = useState<boolean>(false);

  useEffect(() => {
    const checkMidnight = () => {
      const liveToday = getTodayDateString();
      if (liveToday !== currentTodayStr) {
        setCurrentTodayStr(liveToday);
      }
    };
    const interval = setInterval(checkMidnight, 10000);
    return () => clearInterval(interval);
  }, [currentTodayStr]);

  // Format date for display: "20/09/2026"
  const formattedDisplayDate = useMemo(() => {
    return formatDateToDDMMYYYY(selectedDate);
  }, [selectedDate]);

  // Extract all booked slot IDs for the current selected date from Cloud Firestore
  const bookedSlotsMap = useMemo(() => {
    const map = new Map<string, { bookingRef: string; customerName: string; status: string }>();
    persistedBookings.forEach((b) => {
      if (b.selectedDate === selectedDate) {
        b.slots.forEach((s) => {
          map.set(s.slotId, {
            bookingRef: b.bookingReference,
            customerName: b.customer?.fullName || 'Reserved',
            status: b.status || 'VERIFIED',
          });
        });
      }
    });
    return map;
  }, [persistedBookings, selectedDate]);

  // Generate base slots and overlay Firestore persistence
  const court1Base = useMemo(() => generateSlotsForCourt('court-1', selectedDate), [selectedDate]);
  const court2Base = useMemo(() => generateSlotsForCourt('court-2', selectedDate), [selectedDate]);

  const court1Slots = useMemo(() => {
    return court1Base.map((s) => {
      if (bookedSlotsMap.has(s.id)) {
        return { ...s, status: 'BOOKED' as const };
      }
      return s;
    });
  }, [court1Base, bookedSlotsMap]);

  const court2Slots = useMemo(() => {
    return court2Base.map((s) => {
      if (bookedSlotsMap.has(s.id)) {
        return { ...s, status: 'BOOKED' as const };
      }
      return s;
    });
  }, [court2Base, bookedSlotsMap]);

  const allSlots = useMemo(() => [...court1Slots, ...court2Slots], [court1Slots, court2Slots]);
  const totalOpenSlots = useMemo(() => allSlots.filter((s) => s.status === 'OPEN').length, [allSlots]);
  const totalSlotsCount = allSlots.length; // 32

  const court1OpenCount = useMemo(() => court1Slots.filter((s) => s.status === 'OPEN').length, [court1Slots]);
  const court2OpenCount = useMemo(() => court2Slots.filter((s) => s.status === 'OPEN').length, [court2Slots]);

  const totalPrice = useMemo(() => {
    return selectedSlots.reduce((sum, item) => sum + item.price, 0);
  }, [selectedSlots]);

  const isSlotSelected = (slotId: string) => {
    return selectedSlots.some((s) => s.slotId === slotId && s.date === selectedDate);
  };

  const renderSlotButton = (slot: TimeSlot) => {
    const selected = isSlotSelected(slot.id);
    const isBooked = slot.status === 'BOOKED';
    const dbInfo = bookedSlotsMap.get(slot.id);

    if (isBooked) {
      return (
        <div
          key={slot.id}
          title={dbInfo ? `Reserved by ${dbInfo.customerName} (#${dbInfo.bookingRef})` : 'Slot Booked'}
          className="flex flex-col items-center justify-center rounded-xl bg-[#5E2CB2] p-2 text-[#FFFFFF] select-none cursor-not-allowed min-h-[58px] transition-all relative group"
        >
          <span className="text-xs sm:text-sm font-bold opacity-90">{slot.startTime}</span>
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#B3A2DB] flex items-center gap-0.5 mt-0.5">
            <Lock className="h-2.5 w-2.5" /> BOOKED
          </span>
          {dbInfo && (
            <span className="absolute -top-1 -right-1 flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00C6FF] opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00C6FF]" />
            </span>
          )}
        </div>
      );
    }

    return (
      <button
        key={slot.id}
        type="button"
        id={`slot-${slot.id}`}
        onClick={() => onToggleSlot(slot, selectedDate)}
        className={`flex flex-col items-center justify-center rounded-xl transition-all duration-150 cursor-pointer min-h-[58px] p-2 ${
          selected
            ? 'bg-[#00C6FF] border-2 border-[#00C6FF] text-black font-black shadow-md shadow-[#00C6FF]/35 scale-[1.03]'
            : 'bg-[#FFFFFF] border-2 border-[#B3A2DB]/60 text-[#5E2CB2] hover:bg-[#00C6FF]/10 hover:border-[#00C6FF] font-bold'
        }`}
      >
        <span className="text-xs sm:text-sm font-bold">{slot.startTime}</span>
        {selected ? (
          <span className="text-[10px] font-black uppercase text-black flex items-center gap-0.5">
            <Check className="h-2.5 w-2.5 stroke-[3]" /> PICKED
          </span>
        ) : (
          <span className="text-[10px] text-[#5E2CB2]/70 font-semibold">
            ₱{slot.price}
          </span>
        )}
      </button>
    );
  };

  return (
    <section
      id="court-matrix-section"
      className="w-full bg-[#FFFFFF] text-[#5E2CB2] py-12 sm:py-16 lg:py-20"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Top Header Row */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-8">
          {/* Left Title */}
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm font-black tracking-widest uppercase text-[#5E2CB2] mb-2">
              <span className="h-2 w-2 rounded-full bg-[#00C6FF]" />
              <span>LIVE COURT MATRIX</span>
            </div>

            <h2 className="font-heading text-4xl sm:text-5xl lg:text-6xl font-black uppercase tracking-tight text-[#5E2CB2] leading-[0.95]">
              PICK YOUR<br />
              TIME &amp; SPACE
            </h2>
          </div>

          {/* Right Stats */}
          <div className="flex flex-col items-start md:items-end text-left md:text-right">
            <span className="text-xs font-bold uppercase tracking-widest text-[#5E2CB2]/80">
              AVAILABLE SLOTS TODAY
            </span>
            <div className="font-heading text-4xl sm:text-5xl font-black text-[#00C6FF] leading-none my-1">
              {totalOpenSlots}/{totalSlotsCount}
            </div>
            <span className="text-xs font-semibold text-[#B3A2DB]">
              08:00-23:00 • ₱150-200/HR • 4 PLAYERS MAX
            </span>
          </div>
        </div>

        {/* Action Controls Row: DATE Selector */}
        <div className="flex items-center justify-end gap-4 mb-6">
          {/* Right Date Selector Button */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-black uppercase tracking-widest text-[#5E2CB2]">
              DATE
            </span>
            <button
              type="button"
              id="open-calendar-popover-btn"
              onClick={() => setIsCalendarOpen(true)}
              className="group relative flex items-center gap-2.5 rounded-xl border-2 border-[#B3A2DB] bg-[#FFFFFF] px-3.5 py-2 text-xs sm:text-sm font-black text-[#5E2CB2] shadow-sm hover:border-[#5E2CB2] hover:bg-[#FAF8FF] hover:shadow-md transition-all active:scale-95 cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#00C6FF]"
              aria-label={`Selected date: ${formattedDisplayDate}. Click to open pop-up calendar`}
              aria-haspopup="dialog"
              aria-expanded={isCalendarOpen}
            >
              {selectedDate === currentTodayStr && (
                <span className="inline-flex items-center gap-1 rounded-md bg-[#00C6FF]/20 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#0088B0]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#00C6FF] animate-pulse" />
                  TODAY
                </span>
              )}
              <span>{formattedDisplayDate}</span>
              <CalendarIcon className="h-4 w-4 text-[#5E2CB2] group-hover:text-[#00C6FF] transition-colors" />
            </button>
          </div>
        </div>

        {/* Courts Grid Container */}
        <div className="space-y-6">
          {/* Court 01 Card */}
          <div className="rounded-2xl sm:rounded-3xl border-2 border-[#B3A2DB]/40 bg-[#FFFFFF] p-5 sm:p-7 shadow-sm">
            {/* Card Header */}
            <div className="flex items-center justify-between pb-5 border-b border-[#B3A2DB]/20">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-black uppercase tracking-wider text-[#5E2CB2]">
                  COURT
                </span>
                <span className="font-heading text-3xl sm:text-4xl font-black text-[#5E2CB2]">
                  01
                </span>
              </div>
              <span className="rounded-full bg-[#B3A2DB]/25 px-3 py-1 text-xs font-black uppercase tracking-wider text-[#5E2CB2]">
                {court1OpenCount} OPEN
              </span>
            </div>

            {/* Time Slot Grid (8 cols x 2 rows) */}
            <div className="mt-5 grid grid-cols-4 sm:grid-cols-8 gap-2.5">
              {court1Slots.map(renderSlotButton)}
            </div>
          </div>

          {/* Court 02 Card */}
          <div className="rounded-2xl sm:rounded-3xl border-2 border-[#B3A2DB]/40 bg-[#FFFFFF] p-5 sm:p-7 shadow-sm">
            {/* Card Header */}
            <div className="flex items-center justify-between pb-5 border-b border-[#B3A2DB]/20">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-black uppercase tracking-wider text-[#5E2CB2]">
                  COURT
                </span>
                <span className="font-heading text-3xl sm:text-4xl font-black text-[#5E2CB2]">
                  02
                </span>
              </div>
              <span className="rounded-full bg-[#B3A2DB]/25 px-3 py-1 text-xs font-black uppercase tracking-wider text-[#5E2CB2]">
                {court2OpenCount} OPEN
              </span>
            </div>

            {/* Time Slot Grid (8 cols x 2 rows) */}
            <div className="mt-5 grid grid-cols-4 sm:grid-cols-8 gap-2.5">
              {court2Slots.map(renderSlotButton)}
            </div>
          </div>

          {/* Your Selection Summary Card */}
          <div className="rounded-2xl sm:rounded-3xl border-2 border-[#B3A2DB]/40 bg-[#FFFFFF] p-5 sm:p-7 shadow-sm">
            <div className="flex items-center justify-between pb-3">
              <span className="text-sm sm:text-base font-black uppercase tracking-wider text-[#5E2CB2]">
                YOUR SELECTION ({selectedSlots.length})
              </span>
              <span className="font-heading text-2xl sm:text-3xl font-black text-[#5E2CB2]">
                ₱{totalPrice}
              </span>
            </div>

            {/* Slot details or empty state message */}
            <div className="py-2 text-xs sm:text-sm text-[#5E2CB2]/80">
              {selectedSlots.length === 0 ? (
                <span>No slots selected yet. Tap open slots above to add them to your reservation.</span>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {selectedSlots.map((s) => (
                    <span
                      key={`${s.courtId}-${s.slotId}-${s.date}`}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#B3A2DB]/25 border border-[#B3A2DB]/50 px-2.5 py-1 text-xs font-bold text-[#5E2CB2]"
                    >
                      {s.courtName} ({s.timeLabel}) • ₱{s.price}
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={onClearSlots}
                    className="ml-auto flex items-center gap-1 text-xs font-bold text-red-500 hover:text-red-700 cursor-pointer"
                  >
                    <RotateCcw className="h-3 w-3" /> Clear All
                  </button>
                </div>
              )}
            </div>

            {/* Continue to Checkout Button */}
            <div className="mt-4 pt-3 border-t border-[#B3A2DB]/20">
              <button
                type="button"
                id="continue-to-checkout-btn"
                onClick={onProceedToCheckout}
                disabled={selectedSlots.length === 0}
                className={`w-full rounded-xl py-3.5 px-6 text-center text-xs sm:text-sm font-black uppercase tracking-wider transition-all ${
                  selectedSlots.length > 0
                    ? 'bg-[#00C6FF] text-black shadow-lg shadow-[#00C6FF]/25 hover:bg-[#00C6FF]/90 hover:scale-[1.01] cursor-pointer'
                    : 'bg-[#B3A2DB]/25 text-[#5E2CB2]/40 cursor-not-allowed'
                }`}
              >
                CONTINUE TO CHECKOUT
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Pop-up Calendar */}
      <CalendarPopup
        isOpen={isCalendarOpen}
        onClose={() => setIsCalendarOpen(false)}
        selectedDate={selectedDate}
        onSelectDate={(newDate) => {
          onSelectDate(newDate);
          setIsCalendarOpen(false);
        }}
        currentTodayStr={currentTodayStr}
      />
    </section>
  );
};
