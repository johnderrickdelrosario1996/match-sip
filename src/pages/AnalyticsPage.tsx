import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ShieldCheck,
  ShieldAlert,
  Lock,
  Unlock,
  RefreshCw,
  Search,
  Filter,
  Download,
  ArrowLeft,
  Clock,
  Globe,
  Smartphone,
  Laptop,
  CheckCircle2,
  Calendar,
  Activity,
  AlertTriangle,
  Copy,
  Check,
  Trash2,
} from 'lucide-react';
import {
  fetchAnalyticsLogs,
  deleteAnalyticsLog,
  clearAllAnalytics,
  AnalyticsLog,
  AnalyticsMetrics,
} from '../services/analyticsService';
import { useDebounce } from '../utils/useDebounce';
import { PinCodeInput } from '../components/PinCodeInput';

const ADMIN_PASSWORD = '0912';
const AUTH_STORAGE_KEY = 'matchsip_admin_auth';

export const AnalyticsPage: React.FC = () => {
  const navigate = useNavigate();

  // Authentication State with sessionStorage persistence (shared with /bookings)
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
  const pinInputRef = useRef<HTMLInputElement>(null);

  // Analytics data state
  const [logs, setLogs] = useState<AnalyticsLog[]>([]);
  const [metrics, setMetrics] = useState<AnalyticsMetrics>({
    totalEvents: 0,
    uniqueIps: 0,
    bookingActions: 0,
    slotInteractions: 0,
    topActions: [],
    topIps: [],
  });
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedIp, setCopiedIp] = useState<string | null>(null);
  const [toastNotification, setToastNotification] = useState<string | null>(null);

  // Filters & Search
  const [searchTerm, setSearchTerm] = useState('');
  const debouncedSearchTerm = useDebounce(searchTerm, 250);
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'bookings' | 'slots' | 'pages' | 'admin'>('all');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 50;

  const showNotification = (msg: string) => {
    setToastNotification(msg);
    setTimeout(() => {
      setToastNotification((prev) => (prev === msg ? null : prev));
    }, 3200);
  };

  // ---------------------------------------------------------
  // PASSWORD GATE LOGIC (Matches /bookings)
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
      showNotification('Access granted to Security & Analytics.');
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
  // DATA FETCHING
  // ---------------------------------------------------------
  const loadData = async (silent = false) => {
    if (!isAuthenticated) return;
    if (!silent) setIsLoading(true);
    setErrorMsg(null);

    try {
      const data = await fetchAnalyticsLogs(ADMIN_PASSWORD, 500);
      setLogs(data.logs);
      setMetrics(data.metrics);
    } catch (err: any) {
      console.error('Failed to load analytics:', err);
      setErrorMsg(err.message || 'Failed to retrieve analytics records.');
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      loadData();
    }
  }, [isAuthenticated]);

  // Auto-refresh interval (every 12 seconds)
  useEffect(() => {
    if (!isAuthenticated || !autoRefresh) return;
    const interval = setInterval(() => {
      loadData(true);
    }, 12000);
    return () => clearInterval(interval);
  }, [isAuthenticated, autoRefresh]);

  // Copy IP helper
  const handleCopyIp = (ip: string) => {
    navigator.clipboard.writeText(ip);
    setCopiedIp(ip);
    setTimeout(() => {
      setCopiedIp((prev) => (prev === ip ? null : prev));
    }, 2000);
    showNotification(`Copied IP: ${ip}`);
  };

  // CSV Export
  const exportLogsToCsv = () => {
    if (logs.length === 0) {
      showNotification('No logs available to export.');
      return;
    }

    const headers = ['ID', 'Timestamp (UTC)', 'IP Address', 'Action Taken', 'User Agent'];
    const rows = logs.map((l) => [
      l.id,
      `"${l.timestamp}"`,
      `"${l.ipAddress}"`,
      `"${(l.action || '').replace(/"/g, '""')}"`,
      `"${(l.userAgent || '').replace(/"/g, '""')}"`,
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `MATCH_SIP_ANALYTICS_48H_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showNotification('Exported 48-Hour Security Logs to CSV.');
  };

  // State for delete actions
  const [isDeletingAll, setIsDeletingAll] = useState(false);
  const [showClearConfirmModal, setShowClearConfirmModal] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Single record deletion handler
  const handleDeleteSingleLog = async (id: number) => {
    try {
      setDeletingId(id);
      await deleteAnalyticsLog(ADMIN_PASSWORD, id);
      setLogs((prev) => prev.filter((log) => log.id !== id));
      showNotification(`Deleted log #${id}. Present actions refreshed.`);
      // Refresh summary metrics asynchronously
      loadData(true);
    } catch (err: any) {
      console.error('Failed to delete log entry:', err);
      showNotification(err.message || 'Failed to delete record.');
    } finally {
      setDeletingId(null);
    }
  };

  // Clear all present logs handler
  const handleClearAllLogs = async () => {
    try {
      setIsDeletingAll(true);
      const res = await clearAllAnalytics(ADMIN_PASSWORD);
      setShowClearConfirmModal(false);
      setLogs([]);
      setMetrics({
        totalEvents: 0,
        uniqueIps: 0,
        bookingActions: 0,
        slotInteractions: 0,
        topActions: [],
        topIps: [],
      });
      showNotification(`Successfully purged ${res.count} records. Tracking feed reset.`);
    } catch (err: any) {
      console.error('Failed to clear analytics:', err);
      showNotification(err.message || 'Failed to clear analytics logs.');
    } finally {
      setIsDeletingAll(false);
    }
  };

  // Format timestamp
  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return ts;
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
    } catch {
      return ts;
    }
  };

  // Relative time helper
  const getRelativeTime = (ts: string) => {
    try {
      const diffSec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
      if (diffSec < 60) return `${Math.max(1, diffSec)}s ago`;
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHrs = Math.floor(diffMin / 60);
      if (diffHrs < 24) return `${diffHrs}h ago`;
      const diffDays = Math.floor(diffHrs / 24);
      return `${diffDays}d ago`;
    } catch {
      return '';
    }
  };

  // Parse User Agent to readable badge
  const parseDeviceType = (ua: string) => {
    const lower = (ua || '').toLowerCase();
    if (lower.includes('iphone') || lower.includes('ipad') || lower.includes('ios')) {
      return { label: 'Apple iOS', icon: <Smartphone className="h-3.5 w-3.5 text-slate-300" /> };
    }
    if (lower.includes('android')) {
      return { label: 'Android Mobile', icon: <Smartphone className="h-3.5 w-3.5 text-emerald-400" /> };
    }
    if (lower.includes('macintosh') || lower.includes('mac os')) {
      return { label: 'macOS Desktop', icon: <Laptop className="h-3.5 w-3.5 text-sky-300" /> };
    }
    if (lower.includes('windows')) {
      return { label: 'Windows PC', icon: <Laptop className="h-3.5 w-3.5 text-blue-400" /> };
    }
    if (lower.includes('linux')) {
      return { label: 'Linux Device', icon: <Laptop className="h-3.5 w-3.5 text-amber-400" /> };
    }
    return { label: 'Web Browser', icon: <Globe className="h-3.5 w-3.5 text-gray-400" /> };
  };

  // Filtered logs
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      // Category filter
      if (selectedCategory === 'bookings') {
        const lower = log.action.toLowerCase();
        if (!lower.includes('booking') && !lower.includes('checkout')) return false;
      } else if (selectedCategory === 'slots') {
        const lower = log.action.toLowerCase();
        if (!lower.includes('slot')) return false;
      } else if (selectedCategory === 'pages') {
        const lower = log.action.toLowerCase();
        if (!lower.includes('page view') && !lower.includes('view:')) return false;
      } else if (selectedCategory === 'admin') {
        const lower = log.action.toLowerCase();
        if (!lower.includes('admin')) return false;
      }

      // Search term filter
      if (debouncedSearchTerm) {
        const term = debouncedSearchTerm.toLowerCase();
        const matchesIp = log.ipAddress.toLowerCase().includes(term);
        const matchesAction = log.action.toLowerCase().includes(term);
        const matchesUa = (log.userAgent || '').toLowerCase().includes(term);
        if (!matchesIp && !matchesAction && !matchesUa) return false;
      }

      return true;
    });
  }, [logs, selectedCategory, debouncedSearchTerm]);

  // Paginated logs
  const paginatedLogs = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredLogs.slice(start, start + pageSize);
  }, [filteredLogs, currentPage, pageSize]);

  const totalPages = Math.ceil(filteredLogs.length / pageSize) || 1;

  // ---------------------------------------------------------
  // RENDER: PASSWORD GATE (IF NOT AUTHENTICATED)
  // ---------------------------------------------------------
  if (!isAuthenticated) {
    return (
      <div className="flex min-h-[85vh] flex-col items-center justify-center p-4">
        <div
          className={`w-full max-w-sm rounded-3xl border-2 border-[#B3A2DB]/40 bg-[#FFFFFF] p-6 sm:p-8 text-[#5E2CB2] shadow-2xl transition-all ${
            isShaking ? 'animate-shake' : ''
          }`}
        >
          <div className="flex flex-col items-center text-center">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#5E2CB2] text-[#00C6FF] shadow-lg shadow-[#5E2CB2]/30">
              <ShieldCheck className="h-7 w-7" />
            </div>

            <span className="text-[10px] font-black uppercase tracking-widest text-[#00C6FF]">
              RESTRICTED AUDIT AREA
            </span>
            <h2 className="font-heading text-2xl font-black uppercase tracking-tight text-[#5E2CB2]">
              SECURITY &amp; ANALYTICS
            </h2>
            <p className="mt-1.5 text-xs text-[#5E2CB2]/70 leading-relaxed">
              Enter the 4-digit administrator passcode to review the rolling 48-hour visitor and security logs.
            </p>
          </div>

          <form onSubmit={handleUnlockSubmit} className="mt-6 flex flex-col items-center">
            <div className="mb-4 w-full">
              <PinCodeInput
                pin={pin}
                onChange={(newPin) => {
                  setPin(newPin);
                  setAuthError(null);
                }}
                onSubmit={(pinToVerify) => verifyPin(pinToVerify)}
                inputRef={pinInputRef}
                isShaking={isShaking}
                autoFocus={true}
                id="analytics-pin-input"
                className="bg-[#5E2CB2]"
              />
            </div>

            {authError && (
              <div className="mb-3 flex items-center gap-1.5 text-xs font-bold text-red-600 animate-in fade-in">
                <AlertTriangle className="h-4 w-4" />
                <span>{authError}</span>
              </div>
            )}

            {/* Quick numeric buttons keypad for thumbs */}
            <div className="grid w-full grid-cols-3 gap-2 mb-4">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'].map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    if (key === 'C') {
                      setPin('');
                      setAuthError(null);
                    } else if (key === 'OK') {
                      verifyPin(pin);
                    } else {
                      if (pin.length < 4) {
                        const newPin = pin + key;
                        setPin(newPin);
                        if (newPin.length === 4) {
                          verifyPin(newPin);
                        }
                      }
                    }
                  }}
                  className={`h-12 rounded-xl text-base font-black transition-all active:scale-95 cursor-pointer ${
                    key === 'OK'
                      ? 'bg-[#00C6FF] text-black shadow-md'
                      : key === 'C'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-[#5E2CB2]/10 text-[#5E2CB2] hover:bg-[#5E2CB2]/20'
                  }`}
                >
                  {key}
                </button>
              ))}
            </div>

            <div className="flex w-full items-center justify-between pt-2">
              <Link
                to="/"
                className="flex items-center gap-1 text-xs font-bold text-[#5E2CB2]/70 hover:text-[#5E2CB2] transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Return Home
              </Link>
              <Link
                to="/bookings"
                className="text-xs font-bold text-[#0088B0] hover:underline"
              >
                Bookings Admin →
              </Link>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------
  // RENDER: AUTHENTICATED ANALYTICS DASHBOARD
  // ---------------------------------------------------------
  return (
    <div className="min-h-screen bg-[#5E2CB2] text-[#FFFFFF] py-6 sm:py-10 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        
        {/* Top Header Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-[#B3A2DB]/30">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#00C6FF] animate-pulse" />
              <span className="text-xs font-black uppercase tracking-widest text-[#00C6FF]">
                SECURITY AUDIT &amp; FRAUD PREVENTION
              </span>
            </div>
            <h1 className="font-heading text-3xl sm:text-4xl md:text-5xl font-black uppercase tracking-tight text-[#FFFFFF]">
              VISITOR ANALYTICS
            </h1>
            <p className="mt-1 text-xs sm:text-sm text-[#B3A2DB] max-w-2xl">
              Real-time audit log of client IP addresses, device user agents, slot clicks, and reservation submissions.
            </p>
          </div>

          {/* Action Bar */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Link
              to="/bookings"
              className="rounded-xl border border-[#B3A2DB]/50 bg-white/10 px-3.5 py-2 text-xs font-bold text-white hover:bg-white/20 transition-all flex items-center gap-1.5 min-h-[40px]"
            >
              <Calendar className="h-4 w-4 text-[#00C6FF]" />
              <span>Bookings Admin</span>
            </Link>

            <button
              type="button"
              onClick={exportLogsToCsv}
              className="rounded-xl border border-[#00C6FF]/50 bg-[#00C6FF]/15 px-3.5 py-2 text-xs font-black text-[#00C6FF] hover:bg-[#00C6FF]/25 transition-all flex items-center gap-1.5 min-h-[40px] cursor-pointer"
            >
              <Download className="h-4 w-4" />
              <span>Export CSV</span>
            </button>

            <button
              type="button"
              onClick={() => loadData()}
              disabled={isLoading}
              className="rounded-xl bg-[#00C6FF] px-4 py-2 text-xs font-black uppercase text-black hover:bg-[#00C6FF]/90 transition-all shadow-md active:scale-95 flex items-center gap-1.5 min-h-[40px] cursor-pointer"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>

            {/* Clear / Delete All Logs Button */}
            <button
              type="button"
              onClick={() => setShowClearConfirmModal(true)}
              disabled={isLoading || logs.length === 0}
              className="rounded-xl border border-red-500/60 bg-red-500/15 px-3.5 py-2 text-xs font-black uppercase text-red-300 hover:bg-red-500/25 hover:text-red-200 transition-all flex items-center gap-1.5 min-h-[40px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              title="Delete all present actions and IP logs"
            >
              <Trash2 className="h-4 w-4 text-red-400" />
              <span>Delete All</span>
            </button>

            <button
              type="button"
              onClick={handleLogout}
              className="rounded-xl border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 hover:bg-red-500/20 transition-all flex items-center gap-1.5 min-h-[40px] cursor-pointer"
              title="Lock Admin Session"
            >
              <Lock className="h-4 w-4" />
              <span className="hidden sm:inline">Lock</span>
            </button>
          </div>
        </div>

        {/* 48-Hour Retention Banner */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-2xl border border-[#00C6FF]/40 bg-[#1A0B2E]/60 p-4 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#00C6FF]/20 text-[#00C6FF]">
              <Clock className="h-5 w-5" />
            </div>
            <div>
              <span className="text-xs sm:text-sm font-black uppercase tracking-wider text-[#FFFFFF] flex items-center gap-2">
                <span>Active 48-Hour Security Window</span>
                <span className="rounded-md bg-[#00C6FF]/20 px-2 py-0.5 text-[10px] font-bold text-[#00C6FF]">
                  Rolling Retention
                </span>
              </span>
              <p className="text-xs text-[#B3A2DB] leading-snug">
                Records are automatically purged after 48 hours to preserve database storage and enforce strict user privacy.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-center">
            <label className="flex items-center gap-2 text-xs font-bold text-[#B3A2DB] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded border-white/20 bg-white/10 text-[#00C6FF] focus:ring-[#00C6FF] h-4 w-4"
              />
              <span>Live Auto-Refresh (12s)</span>
            </label>
          </div>
        </div>

        {/* Summary Metric Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div className="rounded-2xl border border-[#B3A2DB]/30 bg-[#1A0B2E]/50 p-4 sm:p-5 backdrop-blur-md">
            <span className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-[#B3A2DB] block">
              Total Logged Events (48h)
            </span>
            <div className="font-heading text-2xl sm:text-4xl font-black text-[#00C6FF] my-1">
              {metrics.totalEvents}
            </div>
            <span className="text-[11px] text-[#B3A2DB]/70 flex items-center gap-1">
              <Activity className="h-3 w-3" /> All tracked requests
            </span>
          </div>

          <div className="rounded-2xl border border-[#B3A2DB]/30 bg-[#1A0B2E]/50 p-4 sm:p-5 backdrop-blur-md">
            <span className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-[#B3A2DB] block">
              Unique Visitors (IPs)
            </span>
            <div className="font-heading text-2xl sm:text-4xl font-black text-[#FFFFFF] my-1">
              {metrics.uniqueIps}
            </div>
            <span className="text-[11px] text-[#B3A2DB]/70 flex items-center gap-1">
              <Globe className="h-3 w-3" /> Distinct client addresses
            </span>
          </div>

          <div className="rounded-2xl border border-[#B3A2DB]/30 bg-[#1A0B2E]/50 p-4 sm:p-5 backdrop-blur-md">
            <span className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-[#B3A2DB] block">
              Booking Submissions
            </span>
            <div className="font-heading text-2xl sm:text-4xl font-black text-emerald-400 my-1">
              {metrics.bookingActions}
            </div>
            <span className="text-[11px] text-[#B3A2DB]/70 flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-emerald-400" /> Confirmed / Checkout
            </span>
          </div>

          <div className="rounded-2xl border border-[#B3A2DB]/30 bg-[#1A0B2E]/50 p-4 sm:p-5 backdrop-blur-md">
            <span className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-[#B3A2DB] block">
              Court Slot Clicks
            </span>
            <div className="font-heading text-2xl sm:text-4xl font-black text-amber-300 my-1">
              {metrics.slotInteractions}
            </div>
            <span className="text-[11px] text-[#B3A2DB]/70 flex items-center gap-1">
              <Calendar className="h-3 w-3 text-amber-300" /> Interactive slot selections
            </span>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 rounded-2xl border border-[#B3A2DB]/30 bg-[#1A0B2E]/40 p-3 sm:p-4 backdrop-blur-md">
          {/* Category Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
            {[
              { id: 'all', label: 'All Records' },
              { id: 'bookings', label: 'Bookings' },
              { id: 'slots', label: 'Slot Clicks' },
              { id: 'pages', label: 'Page Views' },
              { id: 'admin', label: 'Admin Actions' },
            ].map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => {
                  setSelectedCategory(cat.id as any);
                  setCurrentPage(1);
                }}
                className={`rounded-xl px-3 py-1.5 text-xs font-black uppercase tracking-wider transition-all whitespace-nowrap cursor-pointer ${
                  selectedCategory === cat.id
                    ? 'bg-[#00C6FF] text-black shadow-sm'
                    : 'bg-white/5 text-white/80 hover:bg-white/10'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div className="relative min-w-[240px]">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              placeholder="Search IP, action, or browser..."
              className="w-full rounded-xl border border-[#B3A2DB]/40 bg-[#5E2CB2]/60 px-3.5 py-2 pl-9 text-xs font-medium text-white placeholder-[#B3A2DB]/60 focus:outline-none focus:ring-1 focus:ring-[#00C6FF]"
            />
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-[#B3A2DB]" />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                className="absolute right-2.5 top-2 text-xs text-[#B3A2DB] hover:text-white"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Data Table */}
        <div className="overflow-hidden rounded-3xl border border-[#B3A2DB]/30 bg-[#FFFFFF] text-black shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#B3A2DB]/20 bg-[#FAF8FF] text-[11px] font-black uppercase tracking-wider text-[#5E2CB2]">
                  <th className="py-3.5 px-4 sm:px-6">Timestamp (48h)</th>
                  <th className="py-3.5 px-4 sm:px-6">IP Address</th>
                  <th className="py-3.5 px-4 sm:px-6">Action Taken</th>
                  <th className="py-3.5 px-4 sm:px-6">User Agent / Client</th>
                  <th className="py-3.5 px-4 sm:px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-xs font-medium">
                {isLoading && logs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-gray-400">
                      <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-[#00C6FF]" />
                      <span>Loading visitor security logs from Cloud SQL...</span>
                    </td>
                  </tr>
                ) : paginatedLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-gray-500">
                      <ShieldAlert className="h-8 w-8 mx-auto mb-2 text-amber-500" />
                      <span className="font-bold">No records found matching your filters.</span>
                      <p className="text-xs text-gray-400 mt-1">
                        Try clearing search terms or interacting with the court matrix to generate fresh logs.
                      </p>
                    </td>
                  </tr>
                ) : (
                  paginatedLogs.map((log) => {
                    const dev = parseDeviceType(log.userAgent);
                    const isBooking = log.action.toLowerCase().includes('booking') || log.action.toLowerCase().includes('checkout');
                    const isSlot = log.action.toLowerCase().includes('slot');
                    const isAdmin = log.action.toLowerCase().includes('admin');
                    const isDeletingThis = deletingId === log.id;

                    return (
                      <tr key={log.id} className="hover:bg-purple-50/60 transition-colors">
                        {/* Timestamp */}
                        <td className="py-3.5 px-4 sm:px-6 whitespace-nowrap">
                          <div className="flex flex-col">
                            <span className="font-mono text-xs font-bold text-gray-900">
                              {formatTime(log.timestamp)}
                            </span>
                            <span className="text-[10px] text-gray-400">
                              {getRelativeTime(log.timestamp)}
                            </span>
                          </div>
                        </td>

                        {/* IP Address */}
                        <td className="py-3.5 px-4 sm:px-6 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono font-bold text-xs bg-gray-100 text-[#5E2CB2] px-2 py-1 rounded-md border border-gray-200">
                              {log.ipAddress}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleCopyIp(log.ipAddress)}
                              className="p-1 text-gray-400 hover:text-[#5E2CB2] transition-colors rounded hover:bg-gray-100 cursor-pointer"
                              title="Copy IP"
                            >
                              {copiedIp === log.ipAddress ? (
                                <Check className="h-3 w-3 text-emerald-600" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </td>

                        {/* Action Taken */}
                        <td className="py-3.5 px-4 sm:px-6">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold ${
                              isBooking
                                ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                                : isSlot
                                ? 'bg-cyan-100 text-cyan-900 border border-cyan-200'
                                : isAdmin
                                ? 'bg-purple-100 text-purple-900 border border-purple-200'
                                : 'bg-gray-100 text-gray-800'
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                isBooking ? 'bg-emerald-600' : isSlot ? 'bg-cyan-600' : isAdmin ? 'bg-purple-600' : 'bg-gray-500'
                              }`}
                            />
                            <span>{log.action}</span>
                          </span>
                        </td>

                        {/* User Agent */}
                        <td className="py-3.5 px-4 sm:px-6 max-w-xs sm:max-w-md">
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-700 shrink-0">
                              {dev.icon}
                              <span>{dev.label}</span>
                            </span>
                            <span
                              className="truncate text-[11px] font-mono text-gray-500"
                              title={log.userAgent}
                            >
                              {log.userAgent || 'Unknown User Agent'}
                            </span>
                          </div>
                        </td>

                        {/* Row-Level Delete Action Button */}
                        <td className="py-3.5 px-4 sm:px-6 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => handleDeleteSingleLog(log.id)}
                            disabled={isDeletingThis}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-bold text-red-600 hover:bg-red-100 hover:border-red-300 transition-all cursor-pointer disabled:opacity-50"
                            title={`Delete record #${log.id}`}
                          >
                            <Trash2 className={`h-3.5 w-3.5 ${isDeletingThis ? 'animate-spin' : ''}`} />
                            <span className="hidden sm:inline">Delete</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Table Footer with Pagination */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-gray-200 bg-[#FAF8FF] px-4 sm:px-6 py-3.5 text-xs text-gray-600">
            <div>
              Showing{' '}
              <span className="font-bold text-gray-900">
                {filteredLogs.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}
              </span>{' '}
              to{' '}
              <span className="font-bold text-gray-900">
                {Math.min(currentPage * pageSize, filteredLogs.length)}
              </span>{' '}
              of <span className="font-bold text-gray-900">{filteredLogs.length}</span> records
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1 font-bold text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 cursor-pointer"
              >
                Previous
              </button>
              <span className="font-bold text-[#5E2CB2]">
                Page {currentPage} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1 font-bold text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>
        </div>

      </div>

      {/* Confirmation Modal for Clearing All Present Logs */}
      {showClearConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-3xl border border-red-500/40 bg-[#FFFFFF] p-6 text-black shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center gap-3 text-red-600 mb-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-100">
                <Trash2 className="h-6 w-6 text-red-600" />
              </div>
              <div>
                <h3 className="font-heading text-lg font-black uppercase tracking-tight text-gray-900">
                  Delete All Analytics Logs?
                </h3>
                <span className="text-xs text-gray-500">
                  Reset present IP addresses and user actions
                </span>
              </div>
            </div>

            <p className="text-xs text-gray-600 leading-relaxed mb-6">
              This action will permanently delete all <strong className="text-gray-900 font-bold">{logs.length} logged visitor events</strong> stored in Cloud SQL. The feed and metrics will be reset to fresh state immediately.
            </p>

            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowClearConfirmModal(false)}
                disabled={isDeletingAll}
                className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-xs font-bold text-gray-700 hover:bg-gray-100 transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleClearAllLogs}
                disabled={isDeletingAll}
                className="rounded-xl bg-red-600 px-4 py-2 text-xs font-black uppercase text-white hover:bg-red-700 transition-all shadow-md cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
              >
                {isDeletingAll ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Purging...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Confirm Delete All</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastNotification && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl border border-[#00C6FF]/60 bg-[#5E2CB2] px-4 py-3 text-xs font-semibold text-[#FFFFFF] shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-3 duration-200">
          <span className="h-2 w-2 rounded-full bg-[#00C6FF] animate-ping" />
          <span>{toastNotification}</span>
        </div>
      )}
    </div>
  );
};
