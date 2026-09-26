import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Search,
  Calendar,
  Clock,
  CheckCircle2,
  Phone,
  User,
  Database,
  ExternalLink,
  X,
  PlusCircle,
  RefreshCw,
  Trash2,
  Pencil,
  Check,
  Lock,
  Mail,
  ArrowUpDown,
} from 'lucide-react';
import { ConfirmedBooking } from '../types';
import { 
  deleteBookingFromFirestore, 
  updateBookingInFirestore,
  sendAdminBookingNotification,
} from '../services/bookingService';
import { EditBookingModal } from '../components/EditBookingModal';
import { CalendarPopup } from '../components/CalendarPopup';
import { getTodayDateString, formatDateToDDMMYYYY, formatDateToFullReadable } from '../utils/dateUtils';

interface BookingsPageProps {
  persistedBookings: ConfirmedBooking[];
  isLoadingBookings: boolean;
}

const ADMIN_PASSWORD = '0912';
const AUTH_STORAGE_KEY = 'matchsip_admin_auth';

export const BookingsPage: React.FC<BookingsPageProps> = ({
  persistedBookings,
  isLoadingBookings,
}) => {
  const navigate = useNavigate();

  // Authentication State with sessionStorage persistence
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(AUTH_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [pin, setPin] = useState('');
  const [isShaking, setIsShaking] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const pinInputRef = React.useRef<HTMLInputElement>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProof, setSelectedProof] = useState<string | null>(null);
  const [filterDate, setFilterDate] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<'all' | 'today' | 'upcoming' | 'past'>('all');
  const [sortOrder, setSortOrder] = useState<'present-first' | 'newest-first' | 'oldest-first'>('present-first');
  const [isCalendarOpen, setIsCalendarOpen] = useState<boolean>(false);
  const [deletingBookingId, setDeletingBookingId] = useState<string | null>(null);
  const [editingBooking, setEditingBooking] = useState<ConfirmedBooking | null>(null);
  const [toastNotification, setToastNotification] = useState<string | null>(null);
  const [sendingEmailBookingId, setSendingEmailBookingId] = useState<string | null>(null);
  const [isSendingTestEmail, setIsSendingTestEmail] = useState<boolean>(false);

  const showNotification = (msg: string) => {
    setToastNotification(msg);
    setTimeout(() => {
      setToastNotification((prev) => (prev === msg ? null : prev));
    }, 3500);
  };

  const handleSendNotificationEmail = async (booking: ConfirmedBooking) => {
    const ref = booking.bookingReference;
    setSendingEmailBookingId(ref);
    try {
      const res = await sendAdminBookingNotification(booking);
      if (res.success) {
        showNotification(`Notification email sent to admin for #${ref}! Check your inbox or Spam.`);
      } else {
        showNotification(res.message || 'Failed to dispatch email.');
      }
    } catch (err: any) {
      showNotification('Error sending email: ' + (err.message || 'Unknown'));
    } finally {
      setSendingEmailBookingId(null);
    }
  };

  const handleSendTestEmail = async () => {
    setIsSendingTestEmail(true);
    try {
      const res = await fetch('/api/test-email', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showNotification(`Live test email sent to ${data.recipient || 'danamieratan@gmail.com'}! (Check Spam/Promotions folder if not in Inbox)`);
      } else {
        showNotification(data.error || 'Failed to send test email.');
      }
    } catch (err: any) {
      showNotification('Test request failed: ' + (err.message || 'Unknown'));
    } finally {
      setIsSendingTestEmail(false);
    }
  };

  // ---------------------------------------------------------
  // FORMAL PIN AUTHENTICATION HANDLERS
  // ---------------------------------------------------------
  const verifyPin = (candidatePin: string) => {
    if (candidatePin.trim() === ADMIN_PASSWORD) {
      try {
        sessionStorage.setItem(AUTH_STORAGE_KEY, 'true');
      } catch (err) {
        console.error('Failed to write to sessionStorage:', err);
      }
      setIsAuthenticated(true);
      setPin('');
      setAuthError(null);
      showNotification('Access granted to booking management.');
    } else {
      setIsShaking(true);
      setAuthError('Incorrect PIN. Please try again.');
      setTimeout(() => {
        setPin('');
        setIsShaking(false);
        pinInputRef.current?.focus();
      }, 550);
    }
  };

  const handlePinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const numeric = e.target.value.replace(/\D/g, '').slice(0, 4);
    setPin(numeric);
    setAuthError(null);
    if (numeric.length === 4) {
      verifyPin(numeric);
    }
  };

  const handleUnlockSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    verifyPin(pin);
  };

  const handleLogout = () => {
    try {
      sessionStorage.removeItem(AUTH_STORAGE_KEY);
    } catch (err) {
      console.error('Failed to clear sessionStorage:', err);
    }
    setIsAuthenticated(false);
    setPin('');
    setAuthError(null);
    showNotification('Session locked. Admin PIN required.');
  };

  useEffect(() => {
    if (!isAuthenticated) {
      pinInputRef.current?.focus();
    }
  }, [isAuthenticated]);

  // ---------------------------------------------------------
  // TODAY'S DATE REFERENCE
  // ---------------------------------------------------------
  const todayStr = getTodayDateString();

  // ---------------------------------------------------------
  // CATEGORY METRIC COUNTS
  // ---------------------------------------------------------
  const todayBookingsCount = useMemo(() => {
    return persistedBookings.filter((b) => b.selectedDate === todayStr).length;
  }, [persistedBookings, todayStr]);

  const upcomingBookingsCount = useMemo(() => {
    return persistedBookings.filter((b) => (b.selectedDate || '') > todayStr).length;
  }, [persistedBookings, todayStr]);

  const pastBookingsCount = useMemo(() => {
    return persistedBookings.filter((b) => (b.selectedDate || '') < todayStr).length;
  }, [persistedBookings, todayStr]);

  // ---------------------------------------------------------
  // FILTER AND CHRONOLOGICALLY SORT BOOKINGS
  // Places the most present schedule of booking at the top,
  // followed by upcoming, and past booking schedules at the bottom.
  // ---------------------------------------------------------
  const filteredBookings = useMemo(() => {
    // 1. Filter
    const filtered = persistedBookings.filter((booking) => {
      // Category filter
      if (filterCategory === 'today' && booking.selectedDate !== todayStr) {
        return false;
      }
      if (filterCategory === 'upcoming' && (booking.selectedDate || '') <= todayStr) {
        return false;
      }
      if (filterCategory === 'past' && (booking.selectedDate || '') >= todayStr) {
        return false;
      }

      // Specific Date filter
      const matchesDate =
        filterDate === 'all' || booking.selectedDate === filterDate;
      if (!matchesDate) {
        return false;
      }

      // Search query filter
      const query = searchTerm.toLowerCase().trim();
      if (!query) {
        return true;
      }

      return (
        (booking.bookingReference || '').toLowerCase().includes(query) ||
        (booking.customer?.fullName || '').toLowerCase().includes(query) ||
        (booking.customer?.phoneNumber || '').toLowerCase().includes(query) ||
        (booking.selectedDate || '').toLowerCase().includes(query)
      );
    });

    // Helper: extract earliest start time from reserved slots
    const getStartTime = (b: ConfirmedBooking): string => {
      if (!b.slots || b.slots.length === 0) return '00:00';
      const times: string[] = [];
      for (const s of b.slots) {
        if (s.timeLabel) {
          const match = s.timeLabel.match(/^(\d{1,2}:\d{2})/);
          if (match) {
            const [h, m] = match[1].split(':');
            times.push(`${h.padStart(2, '0')}:${m}`);
          }
        }
      }
      if (times.length === 0) return '00:00';
      times.sort();
      return times[0];
    };

    // 2. Sort chronologically
    return [...filtered].sort((a, b) => {
      const dateA = a.selectedDate || '';
      const dateB = b.selectedDate || '';
      const timeA = getStartTime(a);
      const timeB = getStartTime(b);

      if (sortOrder === 'present-first') {
        // Primary: Most present schedule of booking is placed at the top,
        // and the past booking schedules at the bottom.
        // Rank 0: Today (the most present schedule)
        // Rank 1: Upcoming (future schedules in chronological order)
        // Rank 2: Past (past schedules in reverse chronological order)
        const getRank = (d: string) => {
          if (d === todayStr) return 0;
          if (d > todayStr) return 1;
          return 2;
        };

        const rankA = getRank(dateA);
        const rankB = getRank(dateB);

        if (rankA !== rankB) {
          return rankA - rankB;
        }

        // Within Today (rank 0): chronological by slot time (08:00 -> 24:00)
        if (rankA === 0) {
          if (timeA !== timeB) return timeA.localeCompare(timeB);
          return (b.createdAt || b.bookingReference).localeCompare(a.createdAt || a.bookingReference);
        }

        // Within Upcoming (rank 1): chronological by date ascending, then slot time
        if (rankA === 1) {
          if (dateA !== dateB) return dateA.localeCompare(dateB);
          if (timeA !== timeB) return timeA.localeCompare(timeB);
          return (b.createdAt || b.bookingReference).localeCompare(a.createdAt || a.bookingReference);
        }

        // Within Past (rank 2): most recent past day first down to older past dates
        if (dateA !== dateB) return dateB.localeCompare(dateA);
        if (timeA !== timeB) return timeA.localeCompare(timeB);
        return (b.createdAt || b.bookingReference).localeCompare(a.createdAt || a.bookingReference);
      }

      if (sortOrder === 'newest-first') {
        // Date descending, then time
        if (dateA !== dateB) return dateB.localeCompare(dateA);
        if (timeA !== timeB) return timeB.localeCompare(timeA);
        return (b.createdAt || b.bookingReference).localeCompare(a.createdAt || a.bookingReference);
      }

      // 'oldest-first'
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      if (timeA !== timeB) return timeA.localeCompare(timeB);
      return (a.createdAt || a.bookingReference).localeCompare(b.createdAt || b.bookingReference);
    });
  }, [persistedBookings, filterCategory, filterDate, searchTerm, sortOrder, todayStr]);

  // ---------------------------------------------------------
  // CALCULATE METRICS
  // ---------------------------------------------------------
  const totalRevenue = persistedBookings.reduce(
    (sum, booking) => sum + (Number(booking.totalAmount) || 0),
    0
  );

  const totalSlotsCount = persistedBookings.reduce(
    (sum, booking) => sum + (booking.slots?.length || 0),
    0
  );

  // ---------------------------------------------------------
  // DISTINCT DATES (Sorted descending: most present date first)
  // ---------------------------------------------------------
  const uniqueDates = Array.from(
    new Set(
      persistedBookings
        .map((booking) => booking.selectedDate)
        .filter(Boolean)
    )
  ).sort((a, b) => b.localeCompare(a));

  // ---------------------------------------------------------
  // DELETE BOOKING
  // ---------------------------------------------------------
  const handleDeleteBooking = async (booking: ConfirmedBooking) => {
    const bookingId = booking.id || booking.bookingReference;
    if (!bookingId) {
      alert('Unable to delete this booking because the booking ID is missing.');
      return;
    }

    const confirmed = window.confirm(
      `Are you sure you want to delete reservation #${booking.bookingReference} for ${booking.customer?.fullName || 'this player'} permanently?\n\nThis will release the reserved court slots.`
    );
    if (!confirmed) return;

    try {
      setDeletingBookingId(bookingId);
      await deleteBookingFromFirestore(bookingId);
      showNotification(`Reservation #${booking.bookingReference} was deleted successfully.`);
    } catch (error) {
      console.error('Error deleting booking:', error);
      alert('Failed to delete booking. Please check your network and try again.');
    } finally {
      setDeletingBookingId(null);
    }
  };

  // ---------------------------------------------------------
  // UPDATE / EDIT BOOKING
  // ---------------------------------------------------------
  const handleSaveEdit = async (
    bookingId: string,
    updates: {
      fullName: string;
      phoneNumber: string;
      selectedDate: string;
      status: string;
      totalAmount: number;
      notes?: string;
      slots?: ConfirmedBooking['slots'];
    }
  ) => {
    await updateBookingInFirestore(bookingId, updates);
    showNotification(`Reservation #${editingBooking?.bookingReference || bookingId} updated successfully.`);
  };

  // ---------------------------------------------------------
  // FORMAT CURRENCY
  // ---------------------------------------------------------
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-PH', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  // =========================================================
  // FORMAL ADMIN PIN SCREEN (When not authenticated)
  // =========================================================
  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#5E2CB2] px-4 py-8 relative selection:bg-transparent">
        {/* Centered Formal PIN Card */}
        <div className="w-full max-w-[420px] rounded-[2.5rem] border border-white/15 bg-white/5 p-8 sm:p-10 shadow-2xl backdrop-blur-md transition-all">
          {/* Brand Logo Header: Cyan dot + MATCH&SIP */}
          <div className="flex items-center gap-3">
            <span className="h-4 w-4 rounded-full bg-[#00C6FF] shadow-sm shadow-[#00C6FF]/60" />
            <span className="font-heading text-xl sm:text-2xl font-black uppercase tracking-tight text-white">
              MATCH<span className="text-[#00C6FF]">&amp;</span>SIP
            </span>
          </div>

          {/* Eyebrow Label */}
          <div className="mt-8 mb-3 flex items-center gap-2 text-xs font-black uppercase tracking-[0.25em] text-[#00C6FF]">
            <span>RESTRICTED</span>
            <span className="text-white/40">·</span>
            <span>ADMIN</span>
          </div>

          {/* Heading */}
          <h1 className="font-heading text-2xl sm:text-3xl font-black uppercase tracking-tight text-white leading-[1.15] mb-8">
            ENTER PIN TO VIEW<br />BOOKINGS
          </h1>

          {/* Form */}
          <form onSubmit={handleUnlockSubmit} className="space-y-6">
            {/* Rectangular PIN Display Box with Cyan Border & Working Text Cursor */}
            <div
              onClick={() => pinInputRef.current?.focus()}
              className={`relative flex h-16 sm:h-18 w-full cursor-text items-center justify-center rounded-xl border transition-all ${
                isShaking
                  ? 'border-red-400 bg-red-500/10 animate-shake'
                  : 'border-[#00C6FF] bg-black/20 focus-within:ring-2 focus-within:ring-[#00C6FF]/50'
              }`}
            >
              <input
                ref={pinInputRef}
                id="admin-pin-input"
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                autoFocus
                value={pin}
                onChange={handlePinChange}
                placeholder="• • • •"
                className="w-full h-full bg-transparent text-center text-white text-3xl sm:text-4xl font-black tracking-[0.6em] focus:outline-none caret-[#00C6FF] placeholder:text-white/25 placeholder:font-black placeholder:tracking-[0.6em] cursor-text selection:bg-[#00C6FF] selection:text-black px-4"
                aria-label="Admin PIN"
              />
            </div>

            {/* Error Feedback */}
            {authError && (
              <div
                role="alert"
                className="text-center text-xs font-bold text-red-300 animate-in fade-in -mt-2"
              >
                {authError}
              </div>
            )}

            {/* Solid Electric Cyan UNLOCK Button */}
            <button
              type="submit"
              id="admin-pin-unlock-btn"
              className="w-full rounded-xl bg-[#00C6FF] py-4 text-center font-heading text-base sm:text-lg font-black uppercase tracking-wider text-black shadow-lg shadow-[#00C6FF]/20 transition-all hover:bg-[#00C6FF]/90 active:scale-[0.99] cursor-pointer"
            >
              UNLOCK
            </button>
          </form>
        </div>

        {/* Floating Toast Notification */}
        {toastNotification && (
          <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl border border-[#00C6FF]/60 bg-[#4A1E94] px-4 py-3 text-xs font-bold text-white shadow-2xl shadow-[#00C6FF]/30 backdrop-blur-md animate-in fade-in slide-in-from-bottom-3">
            <span className="h-2 w-2 rounded-full bg-[#00C6FF] animate-ping" />
            <span>{toastNotification}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col flex-1 bg-[#5E2CB2] text-[#FFFFFF]">

      {/* =====================================================
          TOP HEADER & NAVIGATION
      ====================================================== */}
      <div className="w-full border-b border-[#B3A2DB]/30 bg-[#5E2CB2] py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">

          <div className="flex items-center gap-3 ml-auto justify-end">

            {/* LOCK / LOGOUT BUTTON */}
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-red-400/40 bg-red-500/15 px-3.5 py-1.5 text-xs font-bold text-red-200 transition-all hover:bg-red-500/25 hover:border-red-400/60"
              title="Lock and logout of booking management"
            >
              <Lock className="h-4 w-4" />
              <span>Logout</span>
            </button>

            <button
              type="button"
              onClick={() => navigate('/')}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#00C6FF] px-4 py-1.5 text-xs font-black uppercase tracking-wider text-black shadow-md transition-all hover:bg-[#00C6FF]/90"
            >
              <PlusCircle className="h-4 w-4" />
              <span>Book A Court</span>
            </button>
          </div>
        </div>
      </div>

      {/* =====================================================
          MAIN PAGE HEADER
      ====================================================== */}
      <div className="w-full border-b border-[#B3A2DB]/20 bg-[#5E2CB2] px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
        <div className="mx-auto max-w-7xl">

          <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">

            <div>
              <h1 className="font-heading text-3xl font-black uppercase tracking-tight text-white sm:text-4xl lg:text-5xl">
                SAVED BOOKINGS
              </h1>

              <p className="mt-2 max-w-2xl text-xs text-[#B3A2DB] sm:text-sm">
                Confirmed court reservations stored securely in Cloud
                Firestore. Filter by player, date, or booking reference code,
                and view InstaPay payment receipts.
              </p>

            </div>

            {/* QUICK METRICS */}
            <div className="grid grid-cols-3 gap-3 self-start md:self-auto">

              <div className="min-w-[90px] rounded-2xl border border-[#B3A2DB]/30 bg-white/5 p-3 text-center sm:p-4">
                <span className="block text-[10px] font-bold uppercase tracking-wider text-[#B3A2DB]">
                  Bookings
                </span>

                <span className="font-heading text-xl font-black text-[#00C6FF] sm:text-2xl">
                  {persistedBookings.length}
                </span>
              </div>

              <div className="min-w-[90px] rounded-2xl border border-[#B3A2DB]/30 bg-white/5 p-3 text-center sm:p-4">
                <span className="block text-[10px] font-bold uppercase tracking-wider text-[#B3A2DB]">
                  Slots
                </span>

                <span className="font-heading text-xl font-black text-white sm:text-2xl">
                  {totalSlotsCount}
                </span>
              </div>

              <div className="min-w-[90px] rounded-2xl border border-[#B3A2DB]/30 bg-white/5 p-3 text-center sm:p-4">
                <span className="block text-[10px] font-bold uppercase tracking-wider text-[#B3A2DB]">
                  Total
                </span>

                <span className="font-heading text-xl font-black text-emerald-400 sm:text-2xl">
                  ₱{formatCurrency(totalRevenue)}
                </span>
              </div>

            </div>
          </div>
        </div>
      </div>

      {/* =====================================================
          CONTENT AREA
      ====================================================== */}
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-8 sm:px-6 lg:px-8">

        {/* ===================================================
            SEARCH & FILTER BAR
        ==================================================== */}
        <div className="mb-8 space-y-4">
          <div className="flex flex-col items-stretch justify-between gap-4 lg:flex-row lg:items-center">

            {/* SEARCH */}
            <div className="relative max-w-md flex-1">
              <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#B3A2DB]" />
              <input
                type="text"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search reference #, player name, phone..."
                className="w-full rounded-full border border-[#B3A2DB]/40 bg-white/10 py-2.5 pl-10 pr-10 text-xs font-medium text-white shadow-inner transition-all placeholder:text-[#B3A2DB]/60 focus:border-[#00C6FF] focus:bg-white/15 focus:outline-none sm:text-sm"
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-white/50 transition-colors hover:text-white"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* SORT SELECTOR */}
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[#B3A2DB] shrink-0">
                <ArrowUpDown className="h-3.5 w-3.5 text-[#00C6FF]" />
                Sort:
              </span>
              <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as any)}
                className="rounded-full border border-[#B3A2DB]/40 bg-[#1A0B2E]/80 px-3.5 py-1.5 text-xs font-bold text-white shadow-sm transition-all focus:border-[#00C6FF] focus:outline-none cursor-pointer"
              >
                <option value="present-first" className="bg-[#1A0B2E] text-white">
                  Present Schedule First (Today → Upcoming → Past)
                </option>
                <option value="newest-first" className="bg-[#1A0B2E] text-white">
                  Newest Date First (Descending)
                </option>
                <option value="oldest-first" className="bg-[#1A0B2E] text-white">
                  Oldest Date First (Ascending)
                </option>
              </select>
            </div>

          </div>

          {/* SCHEDULE CATEGORY TABS & CALENDAR BUTTON */}
          <div className="flex flex-col gap-2.5 pt-1 border-t border-white/10">
            {/* Category Tabs and Calendar Button */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1 flex-wrap sm:flex-nowrap">
              <button
                type="button"
                onClick={() => {
                  setFilterCategory('all');
                  setFilterDate('all');
                }}
                className={`cursor-pointer whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-black uppercase tracking-wider transition-colors ${
                  filterCategory === 'all' && filterDate === 'all'
                    ? 'bg-[#00C6FF] text-black shadow-md shadow-[#00C6FF]/30'
                    : 'bg-white/10 text-white hover:bg-white/20'
                }`}
              >
                All Bookings ({persistedBookings.length})
              </button>

              <button
                type="button"
                onClick={() => {
                  setFilterCategory('today');
                  setFilterDate('all');
                }}
                className={`cursor-pointer whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-black uppercase tracking-wider transition-colors flex items-center gap-1.5 ${
                  filterCategory === 'today'
                    ? 'bg-[#00C6FF] text-black shadow-md shadow-[#00C6FF]/30'
                    : 'bg-white/10 text-white hover:bg-white/20'
                }`}
              >
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>Today's Schedule ({todayBookingsCount})</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setFilterCategory('upcoming');
                  setFilterDate('all');
                }}
                className={`cursor-pointer whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-black uppercase tracking-wider transition-colors ${
                  filterCategory === 'upcoming'
                    ? 'bg-[#00C6FF] text-black shadow-md shadow-[#00C6FF]/30'
                    : 'bg-white/10 text-white hover:bg-white/20'
                }`}
              >
                Upcoming ({upcomingBookingsCount})
              </button>

              {/* CALENDAR BUTTON TO VIEW CALENDAR & NAVIGATE PAST BOOKINGS */}
              <button
                type="button"
                onClick={() => setIsCalendarOpen(true)}
                className={`cursor-pointer whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 border shadow-sm ${
                  filterDate !== 'all'
                    ? 'bg-[#00C6FF] text-black border-[#00C6FF] shadow-md shadow-[#00C6FF]/30 scale-[1.02]'
                    : 'bg-white/10 text-white border-white/20 hover:bg-white/20 hover:border-[#00C6FF]/60'
                }`}
                title="Open calendar to view and navigate past bookings by date"
                aria-label="Open Calendar"
              >
                <Calendar className={`h-3.5 w-3.5 ${filterDate !== 'all' ? 'text-black' : 'text-[#00C6FF]'}`} />
                <span>
                  {filterDate !== 'all' ? `Date: ${formatDateToDDMMYYYY(filterDate)}` : 'Calendar & Past Dates'}
                </span>
                {filterDate !== 'all' && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      setFilterDate('all');
                    }}
                    className="ml-0.5 rounded-full bg-black/20 hover:bg-black/30 p-0.5 text-black cursor-pointer"
                    title="Clear date filter"
                  >
                    <X className="h-3 w-3" />
                  </span>
                )}
              </button>
            </div>

            {/* Active Date Filter Banner */}
            {filterDate !== 'all' && (
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-[#00C6FF]/40 bg-[#00C6FF]/10 px-4 py-2 text-xs text-white">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-[#00C6FF] animate-pulse" />
                  <span className="text-[#B3A2DB]">Viewing Bookings for:</span>
                  <strong className="text-white font-black">{formatDateToFullReadable(filterDate)}</strong>
                  <span className="text-[#00C6FF] font-semibold">
                    ({filteredBookings.length} {filteredBookings.length === 1 ? 'booking' : 'bookings'} found)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setFilterDate('all')}
                  className="inline-flex items-center gap-1 font-bold text-xs text-[#00C6FF] hover:underline cursor-pointer"
                >
                  <X className="h-3 w-3" />
                  <span>Show All</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ===================================================
            LOADING STATE
        ==================================================== */}
        {isLoadingBookings ? (

          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">

            <RefreshCw className="h-8 w-8 animate-spin text-[#00C6FF]" />

            <span className="text-sm font-bold text-[#B3A2DB]">
              Loading confirmed reservations from Cloud Firestore...
            </span>

          </div>

        ) : filteredBookings.length === 0 ? (

          /* =================================================
             EMPTY STATE
          ================================================== */
          <div className="mx-auto my-8 max-w-xl rounded-3xl border-2 border-dashed border-[#B3A2DB]/40 bg-white/5 p-12 text-center sm:p-16">

            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 text-[#00C6FF]">
              <Database className="h-8 w-8" />
            </div>

            <h2 className="font-heading text-xl font-black uppercase text-white sm:text-2xl">
              {searchTerm || filterDate !== 'all'
                ? 'No Matching Bookings'
                : 'No Saved Bookings Yet'}
            </h2>

            <p className="mx-auto mt-2 max-w-md text-xs text-[#B3A2DB] sm:text-sm">
              {searchTerm || filterDate !== 'all'
                ? 'Try adjusting your search criteria or resetting date filters.'
                : 'When players select court slots and confirm their reservations via InstaPay, they will appear here in real-time.'}
            </p>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">

              {(searchTerm || filterDate !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchTerm('');
                    setFilterDate('all');
                  }}
                  className="cursor-pointer rounded-full bg-white/15 px-5 py-2 text-xs font-bold text-white transition-colors hover:bg-white/25"
                >
                  Clear Filters
                </button>
              )}

              <button
                type="button"
                onClick={() => navigate('/')}
                className="cursor-pointer rounded-full bg-[#00C6FF] px-6 py-2.5 text-xs font-black uppercase tracking-wider text-black transition-all hover:bg-[#00C6FF]/90"
              >
                Go to Court Booking Matrix
              </button>

            </div>

          </div>

        ) : (

          /* =================================================
             BOOKINGS GRID
          ================================================== */
          <div className="grid grid-cols-1 gap-6 pb-12 md:grid-cols-2 lg:grid-cols-3">

            {filteredBookings.map((booking) => {

              const bookingId = booking.id || '';
              const isDeleting = deletingBookingId === bookingId;

              return (
                <div
                  key={booking.id || booking.bookingReference}
                  className="flex flex-col justify-between rounded-3xl border border-[#B3A2DB]/40 bg-white p-6 text-[#5E2CB2] shadow-xl transition-all hover:shadow-2xl"
                >

                  {/* =========================================
                      BOOKING INFORMATION
                  ========================================== */}
                  <div>

                    {/* TOP BAR */}
                    <div className="flex items-center justify-between gap-2 border-b-2 border-[#B3A2DB]/20 pb-3">

                      <span className="min-w-0 flex-1 truncate font-mono text-xs font-black tracking-wider text-[#5E2CB2]">
                        #{booking.bookingReference}
                      </span>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase ${
                          booking.status === 'BOOKED' || booking.status === 'CONFIRMED' || booking.status === 'VERIFIED'
                            ? 'border-emerald-300 bg-emerald-100 text-emerald-800'
                            : 'border-amber-300 bg-amber-100 text-amber-800'
                        }`}>
                          <CheckCircle2 className="h-3 w-3" />
                          <span>{booking.status || 'BOOKED'}</span>
                        </span>

                        {/* RESEND EMAIL NOTIFICATION BUTTON */}
                        <button
                          type="button"
                          disabled={sendingEmailBookingId === booking.bookingReference}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSendNotificationEmail(booking);
                          }}
                          className="p-1.5 rounded-lg text-[#5E2CB2] hover:bg-[#5E2CB2]/10 transition-colors cursor-pointer disabled:opacity-40"
                          title="Send Email Notification to Admin"
                          aria-label="Send Email Notification"
                        >
                          {sendingEmailBookingId === booking.bookingReference ? (
                            <RefreshCw className="w-4 h-4 animate-spin text-[#00C6FF]" />
                          ) : (
                            <Mail className="w-4 h-4" />
                          )}
                        </button>

                        {/* EDIT BUTTON */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingBooking(booking);
                          }}
                          className="p-1.5 rounded-lg text-[#5E2CB2] hover:bg-[#5E2CB2]/10 transition-colors cursor-pointer"
                          title="Edit Booking"
                          aria-label="Edit Booking"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>

                        {/* DELETE BUTTON */}
                        <button
                          type="button"
                          disabled={isDeleting}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteBooking(booking);
                          }}
                          className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 hover:text-red-700 transition-colors cursor-pointer disabled:opacity-40"
                          title="Delete Booking"
                          aria-label="Delete Booking"
                        >
                          {isDeleting ? (
                            <RefreshCw className="w-4 h-4 animate-spin text-red-500" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      </div>

                    </div>

                    {/* PLAYER & CONTACT */}
                    <div className="space-y-1.5 pb-3 pt-4">

                      <div className="flex items-center gap-2">

                        <User className="h-4 w-4 shrink-0 text-[#5E2CB2]" />

                        <span className="truncate font-heading text-base font-black text-[#5E2CB2]">
                          {booking.customer?.fullName || 'Unknown Player'}
                        </span>

                      </div>

                      <div className="flex items-center gap-2 text-xs font-medium text-[#5E2CB2]/80">

                        <Phone className="h-3.5 w-3.5 shrink-0 text-[#5E2CB2]/70" />

                        <span>
                          {booking.customer?.phoneNumber || 'No phone number'}
                        </span>

                      </div>

                    </div>

                    {/* DATE & RESERVED SLOTS */}
                    <div className="mt-2 border-t border-[#B3A2DB]/20 pt-3">

                      <div className="mb-2 flex items-center justify-between text-xs font-bold text-[#5E2CB2]/80 gap-2 flex-wrap">

                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="flex items-center gap-1.5 font-bold text-[#5E2CB2]">
                            <Calendar className="h-3.5 w-3.5 text-[#5E2CB2]" />
                            <span>
                              {booking.selectedDate || 'No date'}
                            </span>
                          </span>

                          {/* Present / Upcoming / Past Schedule Badge */}
                          {booking.selectedDate === todayStr ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#00C6FF]/15 border border-[#00C6FF]/40 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#007da6]">
                              <span className="h-1.5 w-1.5 rounded-full bg-[#00C6FF] animate-pulse" />
                              Today's Schedule
                            </span>
                          ) : (booking.selectedDate || '') > todayStr ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#5E2CB2]/10 border border-[#5E2CB2]/25 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#5E2CB2]">
                              Upcoming
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                              Past Schedule
                            </span>
                          )}
                        </div>

                        <span className="rounded-full bg-[#5E2CB2]/10 px-2 py-0.5 text-[10px] font-black">
                          {booking.slots?.length || 0}{' '}
                          {(booking.slots?.length || 0) === 1
                            ? 'Slot'
                            : 'Slots'}
                        </span>

                      </div>

                      <div className="flex flex-wrap gap-1.5">

                        {booking.slots?.length ? (
                          booking.slots.map((slot, index) => (
                            <div
                              key={`${slot.slotId}-${index}`}
                              className="inline-flex items-center gap-1 rounded-lg bg-[#5E2CB2]/10 px-2.5 py-1 text-[11px] font-bold text-[#5E2CB2]"
                            >
                              <Clock className="h-3 w-3 text-[#5E2CB2]/70" />

                              <span>
                                {slot.courtName}: {slot.timeLabel}
                              </span>
                            </div>
                          ))
                        ) : (
                          <span className="text-xs italic text-[#5E2CB2]/60">
                            No reserved slots
                          </span>
                        )}

                      </div>

                    </div>

                  </div>

                  {/* =========================================
                      BOTTOM BAR
                  ========================================== */}
                  <div className="mt-5 flex items-center justify-between border-t-2 border-[#B3A2DB]/20 pt-3">

                    <div>

                      <span className="block text-[10px] font-black uppercase tracking-wider text-[#5E2CB2]/60">
                        Total Paid
                      </span>

                      <span className="font-heading text-xl font-black text-[#5E2CB2]">
                        ₱{formatCurrency(Number(booking.totalAmount) || 0)}
                      </span>

                    </div>

                    {booking.paymentProofUrl ? (

                      <button
                        type="button"
                        onClick={() =>
                          setSelectedProof(booking.paymentProofUrl || null)
                        }
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#5E2CB2] px-3.5 py-1.5 text-xs font-bold text-white transition-all hover:bg-[#5E2CB2]/90"
                      >
                        <ExternalLink className="h-3 w-3" />
                        <span>Receipt</span>
                      </button>

                    ) : (

                      <span className="inline-flex items-center gap-1 rounded-full bg-[#007DFE]/15 text-[#007DFE] px-2.5 py-1 text-[10px] font-black uppercase">
                        {booking.paymentMethod || 'GCash (PayMongo)'}
                      </span>

                    )}

                  </div>

                </div>
              );
            })}

          </div>
        )}

      </div>

      {/* =====================================================
          PAYMENT RECEIPT MODAL
      ====================================================== */}
      {selectedProof && (

        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md"
          role="dialog"
          aria-modal="true"
          aria-label="InstaPay Payment Proof"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedProof(null);
            }
          }}
        >

          <div className="relative w-full max-w-lg rounded-3xl border-2 border-white/20 bg-[#5E2CB2] p-5 text-white shadow-2xl">

            {/* MODAL HEADER */}
            <div className="mb-3 flex items-center justify-between border-b border-white/20 pb-3">

              <div className="flex items-center gap-2">

                <CheckCircle2 className="h-4 w-4 text-[#00C6FF]" />

                <span className="text-xs font-black uppercase text-[#00C6FF]">
                  InstaPay Payment Proof
                </span>

              </div>

              <button
                type="button"
                onClick={() => setSelectedProof(null)}
                className="rounded-full p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Close receipt"
              >
                <X className="h-5 w-5" />
              </button>

            </div>

            {/* RECEIPT IMAGE */}
            <div className="flex max-h-[70vh] items-center justify-center overflow-hidden rounded-2xl bg-black/40 p-2">

              <img
                src={selectedProof}
                alt="InstaPay Payment Screenshot"
                className="max-h-[65vh] w-auto rounded-xl object-contain"
                referrerPolicy="no-referrer"
              />

            </div>

            {/* CLOSE BUTTON */}
            <div className="mt-3 text-center">

              <button
                type="button"
                onClick={() => setSelectedProof(null)}
                className="cursor-pointer rounded-full bg-white/20 px-5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-white/30"
              >
                Close Receipt
              </button>

            </div>

          </div>

        </div>

      )}

      {/* =====================================================
          EDIT BOOKING MODAL
      ====================================================== */}
      <EditBookingModal
        isOpen={!!editingBooking}
        booking={editingBooking}
        onClose={() => setEditingBooking(null)}
        onSave={handleSaveEdit}
      />

      {/* =====================================================
          CALENDAR POPUP (NAVIGATE PAST BOOKINGS BY DATE)
      ====================================================== */}
      <CalendarPopup
        isOpen={isCalendarOpen}
        onClose={() => setIsCalendarOpen(false)}
        selectedDate={filterDate !== 'all' ? filterDate : todayStr}
        onSelectDate={(dateStr) => {
          setFilterDate(dateStr);
          setFilterCategory('all');
          setIsCalendarOpen(false);
        }}
        currentTodayStr={todayStr}
        allowPastDates={true}
        bookingDates={uniqueDates}
        title="CALENDAR & PAST BOOKINGS"
        subtitle="Select any past or present date to navigate and view its court bookings"
      />

      {/* =====================================================
          TOAST FEEDBACK
      ====================================================== */}
      {toastNotification && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl border border-[#00C6FF]/60 bg-[#4A1E94] px-4 py-3 text-xs font-bold text-white shadow-2xl shadow-[#00C6FF]/30 backdrop-blur-md animate-in fade-in slide-in-from-bottom-3">
          <span className="h-2 w-2 rounded-full bg-[#00C6FF] animate-ping" />
          <span>{toastNotification}</span>
        </div>
      )}

    </div>
  );
};