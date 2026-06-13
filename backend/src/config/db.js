/**
 * @file db.js
 * @description MongoDB Atlas connection manager via Mongoose.
 *
 * Design decisions:
 *  - Uses a module-level singleton pattern; calling connect() multiple times
 *    is safe — Mongoose maintains the connection pool internally.
 *  - Enables mongoose.set('autoCreate', false) to prevent accidental collection
 *    creation outside of explicit migration/seed scripts.
 *  - Enables mongoose.set('autoIndex', false) in production; indexes are
 *    created via the dedicated createIndexes.js migration script.
 *  - Gracefully shuts down the connection on SIGINT / SIGTERM.
 *  - Emits structured Winston log events for every connection state change.
 *
 * MongoDB Atlas requirements (spec §13):
 *  - M2 minimum tier — required for multi-document session transactions.
 *  - Read concern 'snapshot' + write concern 'majority' on all financial ops.
 *  - The connection string must point to a replica set (Atlas always provides
 *    one, even on M2).
 *
 * @module config/db
 */

'use strict';

const mongoose = require('mongoose');
const env = require('./env');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Mongoose global settings
// ---------------------------------------------------------------------------

/**
 * Disable automatic index creation in production.
 * Indexes are created via the `npm run db:migrate` script to ensure explicit
 * control and prevent blocking operations on live collections.
 */
mongoose.set('autoIndex', env.NODE_ENV !== 'production');

/**
 * Disable auto-creation of collections.
 * All collections are created explicitly in db/createCollections.js with
 * JSON Schema validators (spec §13).
 */
mongoose.set('autoCreate', false);

/**
 * Use Node.js built-in crypto for UUID v4 generation when mongoose needs it.
 * We manage publicId ourselves via crypto.randomUUID() in models.
 */
mongoose.set('id', false); // We manage publicId separately

/**
 * Suppress Mongoose's default casting of queries — explicit validation preferred.
 */
mongoose.set('strict', true);
mongoose.set('strictQuery', true);

// ---------------------------------------------------------------------------
// Connection options
// ---------------------------------------------------------------------------

/**
 * Mongoose / MongoDB Node.js driver connection options.
 *
 * Key choices:
 *  - `serverSelectionTimeoutMS`: fail fast during startup if Atlas is
 *    unreachable rather than hanging indefinitely.
 *  - `socketTimeoutMS`: prevent zombie connections on heavily loaded nodes.
 *  - `maxPoolSize`: 10 is appropriate for a single-instance API server;
 *    scale up when running multiple dynos / containers.
 *  - `readPreference`: 'primaryPreferred' for financial reads to guarantee
 *    strong consistency; override to 'secondaryPreferred' only for reporting
 *    endpoints.
 *  - `retryWrites`: required for atomic transactions on Atlas.
 *  - `w: 'majority'` + `journal: true`: durability guarantee on all writes
 *    (spec §5 — race condition prevention).
 */
const CONNECTION_OPTIONS = {
  // Pool
  maxPoolSize: 10,
  minPoolSize: 2,

  // Timeouts
  serverSelectionTimeoutMS: 10_000,  // 10 s — fail fast on startup
  socketTimeoutMS: 45_000,           // 45 s — drop idle sockets
  connectTimeoutMS: 10_000,          // 10 s — initial TCP handshake
  heartbeatFrequencyMS: 10_000,      // 10 s — replica set monitoring

  // Durability (spec §5 — all financial writes)
  w: 'majority',
  journal: true,

  // Atlas requires retryWrites for transactions
  retryWrites: true,

  // Read preference — override per-query for reporting
  readPreference: 'primaryPreferred',

  // App name visible in Atlas Performance Advisor
  appName: 'SmartDormWallet',
};

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

let _isConnected = false;

/**
 * Establishes a Mongoose connection to MongoDB Atlas.
 * Safe to call multiple times — subsequent calls are no-ops if already connected.
 *
 * @returns {Promise<mongoose.Connection>} The active Mongoose connection.
 * @throws Will log and re-throw any connection error so the process can crash
 *         loudly during startup (fail-fast behaviour).
 */
async function connect() {
  if (_isConnected) {
    logger.debug('[db] إعادة استخدام اتصال MongoDB الحالي');
    return mongoose.connection;
  }

  logger.info('[db] جاري الاتصال بقاعدة البيانات MongoDB Atlas…');

  try {
    await mongoose.connect(env.MONGODB_URI, CONNECTION_OPTIONS);
    _isConnected = true;
    logger.info('[db] ✅ تم الاتصال بنجاح بـ MongoDB Atlas');
    return mongoose.connection;
  } catch (error) {
    logger.error('[db] ❌ فشل الاتصال بـ MongoDB Atlas', {
      message: error.message,
      code: error.code,
    });
    throw error;
  }
}

/**
 * Gracefully closes the Mongoose connection.
 * Called by the graceful-shutdown handler in server.js.
 *
 * @param {string} [reason='manual'] - Reason for closing, logged for observability.
 * @returns {Promise<void>}
 */
async function disconnect(reason = 'manual') {
  if (!_isConnected) return;

  logger.info(`[db] إغلاق اتصال MongoDB… (السبب: ${reason})`);

  await mongoose.connection.close();
  _isConnected = false;

  logger.info('[db] تم إغلاق اتصال MongoDB بنجاح');
}

/**
 * Creates a new Mongoose ClientSession for use in multi-document transactions.
 *
 * Usage:
 *   const session = await startSession();
 *   await session.withTransaction(async () => { ... });
 *   session.endSession();
 *
 * All financial write operations that span multiple documents MUST use this
 * helper to guarantee atomicity (spec §5, §6, §7, §8, §9, §10).
 *
 * Session options:
 *  - defaultTransactionOptions.readConcern.level = 'snapshot'  → prevents
 *    dirty reads between concurrent financial operations.
 *  - defaultTransactionOptions.writeConcern.w = 'majority'     → durability
 *    on all replica set members before acknowledging the commit.
 *
 * @returns {Promise<mongoose.mongo.ClientSession>}
 */
async function startSession() {
  if (!_isConnected) {
    throw new Error('[db] لا يمكن بدء جلسة: قاعدة البيانات غير متصلة');
  }

  return mongoose.connection.startSession({
    defaultTransactionOptions: {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority', j: true },
      readPreference: 'primary',
    },
  });
}

/**
 * Returns true when the Mongoose connection is in the CONNECTED state.
 * Used by the /health endpoint and the graceful-shutdown handler.
 *
 * @returns {boolean}
 */
function isConnected() {
  return _isConnected && mongoose.connection.readyState === 1;
}

// ---------------------------------------------------------------------------
// Mongoose connection event listeners
// ---------------------------------------------------------------------------

mongoose.connection.on('connected', () => {
  logger.info('[db] Mongoose: حالة الاتصال — متصل');
});

mongoose.connection.on('disconnected', () => {
  _isConnected = false;
  logger.warn('[db] Mongoose: حالة الاتصال — غير متصل');
});

mongoose.connection.on('reconnected', () => {
  _isConnected = true;
  logger.info('[db] Mongoose: حالة الاتصال — أعيد الاتصال');
});

mongoose.connection.on('error', (err) => {
  logger.error('[db] خطأ في اتصال Mongoose', {
    message: err.message,
    code: err.code,
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown hooks
// ---------------------------------------------------------------------------

/**
 * Registers OS signal handlers to gracefully close the DB connection
 * before the process exits. This prevents connection pool exhaustion on Atlas.
 *
 * Called once from server.js after the HTTP server is listening.
 */
function registerShutdownHooks() {
  const shutdown = async (signal) => {
    logger.info(`[db] استقبال إشارة ${signal} — جاري إيقاف التشغيل بأمان…`);
    await disconnect(signal);
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Unhandled promise rejections — log and exit so Docker / Render restarts cleanly
  process.on('unhandledRejection', (reason) => {
    logger.error('[process] رفض غير معالج (unhandledRejection)', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    // Give logger time to flush before exiting
    setTimeout(() => process.exit(1), 500);
  });

  process.on('uncaughtException', (error) => {
    logger.error('[process] استثناء غير محصور (uncaughtException)', {
      message: error.message,
      stack: error.stack,
    });
    setTimeout(() => process.exit(1), 500);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  connect,
  disconnect,
  startSession,
  isConnected,
  registerShutdownHooks,
};
