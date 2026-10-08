/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { HomePage } from './pages/HomePage';
import { TimeSlot, SelectedSlot, ConfirmedBooking } from './types';
import { 
  subscribeToBookings, 
  saveBookingToFirestore, 
  getInitialCachedBookings 
} from './services/bookingService';
import { getTodayDateString } from './utils/dateUtils';

// Lazy-loaded routes & modals for bundle code-splitting and faster initial page load
const BookingsPage = lazy(() => import('./pages/BookingsPage').then((m) => ({ default: m.BookingsPage })));
const BookingSuccessModal = lazy(() => import('./components/BookingSuccessModal').then((m) => ({ default: m.BookingSuccessModal })));
const ReservationsModal = lazy(() => import('./components/ReservationsModal').then((m) => ({ default: m.ReservationsModal })));

// Lightweight Route Loading Spinner
const RouteLoadingFallback = () => (
  <div className="flex-1 flex flex-col items-center justify-center min-h-[50vh] p-8 text-center text-[#B3A2DB]">
    <div className="h-10 w-10 border-3 border-[#00C6FF] border-t-transparent rounded-full animate-spin mb-3" />
    <span className="text-xs font-bold uppercase tracking-widest text-[#00C6FF]">Loading Match &amp; Sip...</span>
  </div>
);

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const isBookingsPage = location.pathname === '/bookings';
  const [selectedDate, setSelectedDate] = useState<string>(() => getTodayDateString());
  const [selectedSlots, setSelectedSlots] = useState<SelectedSlot[]>([]);
  const [confirmedBooking, setConfirmedBooking] = useState<ConfirmedBooking | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Firestore Real-time Persistence State (instant cache initialization eliminates loading flash)
  const [persistedBookings, setPersistedBookings] = useState<ConfirmedBooking[]>(() => {
    return getInitialCachedBookings();
  });
  const [isLoadingBookings, setIsLoadingBookings] = useState<boolean>(() => {
    return getInitialCachedBookings().length === 0;
  });
  const [isReservationsModalOpen, setIsReservationsModalOpen] = useState<boolean>(false);

  // Everyday real-time sync: when midnight hits, dynamically advance current day in real time
  useEffect(() => {
    let lastKnownToday = getTodayDateString();
    const interval = setInterval(() => {
      const nowToday = getTodayDateString();
      if (nowToday !== lastKnownToday) {
        setSelectedDate((prev) => (prev === lastKnownToday ? nowToday : prev));
        lastKnownToday = nowToday;
      }
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((curr) => (curr === msg ? null : curr));
    }, 3200);
  };

  // Real-time synchronization with Cloud Firestore
  useEffect(() => {
    const unsubscribe = subscribeToBookings(
      (bookings) => {
        setPersistedBookings(bookings);
        setIsLoadingBookings(false);
      },
      (error) => {
        console.warn('Real-time database sync notice:', error);
        setIsLoadingBookings(false);
      }
    );

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

  // Concurrency guard: if someone else books a slot that is currently picked by this user, automatically release it
  useEffect(() => {
    if (selectedSlots.length === 0 || persistedBookings.length === 0) return;

    const bookedIdsOnSelectedDate = new Set(
      persistedBookings
        .filter((b) => b.selectedDate === selectedDate)
        .flatMap((b) =>
          (b.slots || []).flatMap((s) => {
            const match = (s.timeLabel || '').match(/(\d{1,2}):(\d{2})/);
            const timeKey = match ? `${match[1].padStart(2, '0')}${match[2]}` : '';
            return [s.slotId, `${s.courtId}-${timeKey}`].filter(Boolean);
          })
        )
    );

    const conflicted = selectedSlots.filter((s) => {
      if (s.date !== selectedDate) return false;
      const match = (s.timeLabel || '').match(/(\d{1,2}):(\d{2})/);
      const timeKey = match ? `${match[1].padStart(2, '0')}${match[2]}` : '';
      return (
        bookedIdsOnSelectedDate.has(s.slotId) ||
        (timeKey ? bookedIdsOnSelectedDate.has(`${s.courtId}-${timeKey}`) : false)
      );
    });

    if (conflicted.length > 0) {
      setSelectedSlots((prev) =>
        prev.filter((s) => !(s.date === selectedDate && bookedIdsOnSelectedDate.has(s.slotId)))
      );
      showToast(`${conflicted.length} slot(s) were just reserved by another player.`);
    }
  }, [persistedBookings, selectedDate, selectedSlots]);

  const handleToggleSlot = useCallback((slot: TimeSlot, dateStr: string) => {
    const formattedRange = `${slot.startTime}-${slot.endTime}`;
    setSelectedSlots((prev) => {
      const exists = prev.some((s) => s.slotId === slot.id && s.date === dateStr);
      if (exists) {
        showToast(`Removed ${slot.courtName} (${formattedRange})`);
        return prev.filter((s) => !(s.slotId === slot.id && s.date === dateStr));
      } else {
        showToast(`Added ${slot.courtName} (${formattedRange}) to reservation`);
        return [
          ...prev,
          {
            slotId: slot.id,
            courtId: slot.courtId,
            courtName: slot.courtName,
            timeLabel: formattedRange,
            date: dateStr,
            price: slot.price,
          },
        ];
      }
    });
  }, []);

  const handleClearSlots = useCallback(() => {
    setSelectedSlots([]);
    showToast('Cleared all selected court slots');
  }, []);

  const handlePlayTodayClick = useCallback(() => {
    navigate('/');
    setTimeout(() => {
      const el = document.getElementById('court-matrix-section');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
      }
    }, 100);
  }, [navigate]);

  const handleBookingComplete = useCallback(async (booking: ConfirmedBooking) => {
    try {
      // 1. Atomic Firestore transaction: verifies no slots are taken and commits
      await saveBookingToFirestore(booking);

      // 2. On atomic commit success: update state and show success
      setPersistedBookings((prev) => [booking, ...prev.filter((b) => b.bookingReference !== booking.bookingReference)]);
      setConfirmedBooking(booking);
      setSelectedSlots([]);
      showToast(`Reservation #${booking.bookingReference} confirmed & saved!`);
    } catch (error: any) {
      console.error('Error saving to Cloud Firestore:', error);
      if (error?.message && error.message.includes('DOUBLE_BOOKING_PREVENTED')) {
        showToast('⚠️ Slot conflict: This court hour was just booked by another player.');
        throw error;
      }
      // Transient offline fallback only for non-conflict network errors
      setPersistedBookings((prev) => [booking, ...prev.filter((b) => b.bookingReference !== booking.bookingReference)]);
      setConfirmedBooking(booking);
      setSelectedSlots([]);
      showToast(`Reservation #${booking.bookingReference} saved locally!`);
    }
  }, []);

  return (
    <div className="min-h-screen bg-[#5E2CB2] text-[#FFFFFF] flex flex-col selection:bg-[#00C6FF] selection:text-black">
      {/* Top Header */}
      {!isBookingsPage && location.pathname !== '/checkout/gcash-pay' && (
        <Header
          onPlayTodayClick={handlePlayTodayClick}
          selectedSlotsCount={selectedSlots.length}
          onOpenReservationsClick={() => navigate('/bookings')}
          savedBookingsCount={persistedBookings.length}
        />
      )}

      {/* Main Routed Content with Code-Splitting Suspense */}
      <main className="flex-1 flex flex-col">
        <Suspense fallback={<RouteLoadingFallback />}>
          <Routes>
            <Route
              path="/"
              element={
                <HomePage
                  selectedDate={selectedDate}
                  onSelectDate={(newDate) => {
                    setSelectedDate(newDate);
                    setSelectedSlots([]);
                  }}
                  selectedSlots={selectedSlots}
                  persistedBookings={persistedBookings}
                  isLoadingBookings={isLoadingBookings}
                  onToggleSlot={handleToggleSlot}
                  onClearSlots={handleClearSlots}
                  onBookingComplete={handleBookingComplete}
                />
              }
            />
            <Route
              path="/bookings"
              element={
                <BookingsPage
                  persistedBookings={persistedBookings}
                  isLoadingBookings={isLoadingBookings}
                />
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>

      {/* Persistent Footer */}
      {!isBookingsPage && <Footer />}

      {/* Booking Confirmation Success Modal */}
      <Suspense fallback={null}>
        <BookingSuccessModal
          booking={confirmedBooking}
          onClose={() => setConfirmedBooking(null)}
        />
      </Suspense>

      {/* Persistent Cloud Reservations Modal */}
      <Suspense fallback={null}>
        <ReservationsModal
          isOpen={isReservationsModalOpen}
          onClose={() => setIsReservationsModalOpen(false)}
          bookings={persistedBookings}
          isLoading={isLoadingBookings}
        />
      </Suspense>

      {/* Floating Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl border border-[#00C6FF]/60 bg-[#5E2CB2] px-4 py-3 text-xs font-semibold text-[#FFFFFF] shadow-2xl shadow-[#00C6FF]/30 backdrop-blur-md animate-in fade-in slide-in-from-bottom-3 duration-200">
          <span className="h-2 w-2 rounded-full bg-[#00C6FF] animate-ping" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
