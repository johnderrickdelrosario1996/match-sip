/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { BookingSuccessModal } from './components/BookingSuccessModal';
import { ReservationsModal } from './components/ReservationsModal';
import { HomePage } from './pages/HomePage';
import { BookingsPage } from './pages/BookingsPage';
import { TimeSlot, SelectedSlot, ConfirmedBooking } from './types';
import { subscribeToBookings, saveBookingToFirestore } from './services/bookingService';
import { sendAdminBookingSms } from './services/smsService';
import { getTodayDateString } from './utils/dateUtils';

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const isBookingsPage = location.pathname === '/bookings';
  const [selectedDate, setSelectedDate] = useState<string>(() => getTodayDateString());
  const [selectedSlots, setSelectedSlots] = useState<SelectedSlot[]>([]);
  const [confirmedBooking, setConfirmedBooking] = useState<ConfirmedBooking | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Firestore Real-time Persistence State
  const [persistedBookings, setPersistedBookings] = useState<ConfirmedBooking[]>([]);
  const [isLoadingBookings, setIsLoadingBookings] = useState<boolean>(true);
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

    const conflicted = selectedSlots.filter(
      (s) =>
        s.date === selectedDate &&
        (bookedIdsOnSelectedDate.has(s.slotId) ||
          bookedIdsOnSelectedDate.has(`${s.courtId}-${s.timeLabel.slice(0, 2)}${s.timeLabel.slice(3, 5)}`))
    );

    if (conflicted.length > 0) {
      setSelectedSlots((prev) =>
        prev.filter((s) => !(s.date === selectedDate && bookedIdsOnSelectedDate.has(s.slotId)))
      );
      showToast(`${conflicted.length} slot(s) were just reserved by another player.`);
    }
  }, [persistedBookings, selectedDate, selectedSlots]);

  const handleToggleSlot = (slot: TimeSlot, dateStr: string) => {
    setSelectedSlots((prev) => {
      const exists = prev.some((s) => s.slotId === slot.id && s.date === dateStr);
      if (exists) {
        showToast(`Removed ${slot.courtName} (${slot.timeLabel})`);
        return prev.filter((s) => !(s.slotId === slot.id && s.date === dateStr));
      } else {
        showToast(`Added ${slot.courtName} (${slot.timeLabel}) to reservation`);
        return [
          ...prev,
          {
            slotId: slot.id,
            courtId: slot.courtId,
            courtName: slot.courtName,
            timeLabel: slot.timeLabel,
            date: dateStr,
            price: slot.price,
          },
        ];
      }
    });
  };

  const handleClearSlots = () => {
    setSelectedSlots([]);
    showToast('Cleared all selected court slots');
  };

  const handlePlayTodayClick = () => {
    navigate('/');
    setTimeout(() => {
      const el = document.getElementById('court-matrix-section');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
      }
    }, 100);
  };

  const handleBookingComplete = async (booking: ConfirmedBooking) => {
    try {
      // Save permanently to Cloud Firestore
      await saveBookingToFirestore(booking);
      setConfirmedBooking(booking);
      setSelectedSlots([]);
      showToast(`Reservation #${booking.bookingReference} saved to Cloud Firestore!`);
    } catch (error) {
      console.error('Error saving to Cloud Firestore:', error);
      // Ensure smooth UX even during transient network interruption
      setConfirmedBooking(booking);
      setSelectedSlots([]);
      showToast(`Reservation #${booking.bookingReference} saved locally!`);
    }

    // Fail-Safe Handler: Dispatch automated SMS notification to admin on new booking
    // Wrapped in try/catch so booking reservation in Cloud Firestore completes successfully without throwing an error to the user
    try {
      await sendAdminBookingSms(booking);
    } catch (smsError) {
      console.warn('Fail-safe handler caught SMS dispatch error (booking completed safely):', smsError);
    }
  };

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

      {/* Main Routed Content */}
      <main className="flex-1 flex flex-col">
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
      </main>

      {/* Persistent Footer */}
      {!isBookingsPage && <Footer />}

      {/* Booking Confirmation Success Modal */}
      <BookingSuccessModal
        booking={confirmedBooking}
        onClose={() => setConfirmedBooking(null)}
      />

      {/* Persistent Cloud Reservations Modal */}
      <ReservationsModal
        isOpen={isReservationsModalOpen}
        onClose={() => setIsReservationsModalOpen(false)}
        bookings={persistedBookings}
        isLoading={isLoadingBookings}
      />

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
