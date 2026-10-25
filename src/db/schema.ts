import { pgTable, serial, text, varchar, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';

// Users table (linked to Firebase Auth UID)
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// Court Reservations / Bookings Table
export const bookings = pgTable('bookings', {
  id: serial('id').primaryKey(),
  bookingReference: text('booking_reference').notNull().unique(),
  selectedDate: text('selected_date').notNull(),
  paymentMethod: text('payment_method').notNull().default('GCash (PayMongo)'),
  customerName: text('customer_name').notNull(),
  customerPhone: text('customer_phone').notNull(),
  customerEmail: text('customer_email').default(''),
  customerNotes: text('customer_notes').default(''),
  slots: jsonb('slots').notNull().$type<any[]>(),
  totalAmount: integer('total_amount').notNull().default(0),
  paymentProofUrl: text('payment_proof_url').default(''),
  status: text('status').notNull().default('BOOKED'),
  confirmedAt: text('confirmed_at').default(''),
  bookedAt: text('booked_at').default(''),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Atomic Court Slot Locks Table (prevents double bookings)
export const courtSlotLocks = pgTable('court_slot_locks', {
  id: serial('id').primaryKey(),
  lockId: text('lock_id').notNull().unique(),
  bookingReference: text('booking_reference').notNull(),
  customerName: text('customer_name').default(''),
  date: text('date').notNull(),
  courtId: text('court_id').notNull(),
  courtName: text('court_name').default(''),
  timeLabel: text('time_label').default(''),
  status: text('status').notNull().default('BOOKED'),
  lockedAt: text('locked_at').default(''),
  createdAt: timestamp('created_at').defaultNow(),
});

// Visitor Analytics & Security Audit Logs Table (48-hour rolling window)
export const visitorAnalytics = pgTable('visitor_analytics', {
  id: serial('id').primaryKey(),
  ipAddress: varchar('ip_address', { length: 255 }).notNull(),
  action: text('action').notNull(),
  userAgent: text('user_agent').default(''),
  timestamp: timestamp('timestamp').defaultNow(),
});

