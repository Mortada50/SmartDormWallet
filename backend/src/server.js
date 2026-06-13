/**
 * @file server.js
 * @description Application entry point. Bootstraps DB, Redis, and HTTP server.
 *
 * STARTUP SEQUENCE:
 *   1. Connect to MongoDB Atlas (config/db.js)
 *   2. Preload system settings into Redis cache (settingService.preloadSettings)
 *   3. Register OS signal handlers for graceful shutdown
 *   4. Start HTTP server on PORT (default: 5000)
 *
 * GRACEFUL SHUTDOWN:
 *   On SIGINT / SIGTERM:
 *     - Stop accepting new connections (server.close)
 *     - Wait for in-flight requests to complete (max 10s)
 *     - Disconnect MongoDB
 *     - Disconnect Redis
 *     - Exit process
 *
 * @module server
 */

'use strict';

require('dotenv').config();

const { connect, disconnect, registerShutdownHooks } = require('./config/db');
const { disconnectRedis } = require('./config/redis');
const settingService = require('./services/settingService');
const { startScheduler }  = require('./jobs/cronScheduler');
const { startCleanupJob } = require('./jobs/cleanupJob');
const createApp = require('./app');
const logger = require('./config/logger');
const env = require('./config/env');

const PORT = parseInt(env.PORT || '5000', 10);

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
  try {
    logger.info('[server] 🚀 بدء تشغيل Smart Dorm Wallet API...');

    // 1. Connect to MongoDB
    await connect();

    // 2. Preload settings into Redis cache
    await settingService.preloadSettings();

    // 3. Start background jobs (after DB is ready)
    const scheduler  = startScheduler();
    const cleanup    = startCleanupJob();

    // 4. Create Express app
    const app = createApp();

    // 5. Start HTTP server
    const server = app.listen(PORT, () => {
      logger.info(`[server] ✅ الخادم يعمل على المنفذ ${PORT}`, {
        environment: env.NODE_ENV,
        port: PORT,
      });
    });

    // 6. Graceful shutdown
    registerShutdownHooks();

    const gracefulShutdown = async (signal) => {
      logger.info(`[server] ⚠️  إشارة إيقاف: ${signal}`);

      // Stop accepting new connections
      server.close(async () => {
        logger.info('[server] تم إيقاف استقبال الطلبات الجديدة');

        try {
          // Stop cron jobs gracefully before DB disconnect
          scheduler.stop();
          cleanup.stop();

          await disconnect(signal);
          await disconnectRedis();
          logger.info('[server] 🛑 تم إيقاف الخادم بنجاح');
          process.exit(0);
        } catch (err) {
          logger.error('[server] خطأ أثناء الإيقاف', { error: err.message });
          process.exit(1);
        }
      });

      // Force exit after 10s if requests don't finish
      setTimeout(() => {
        logger.error('[server] انتهت مهلة الإيقاف الآمن — إيقاف قسري');
        process.exit(1);
      }, 10_000).unref();
    };

    process.once('SIGINT',  () => gracefulShutdown('SIGINT'));
    process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

    return server;
  } catch (err) {
    logger.error('[server] ❌ فشل بدء التشغيل', {
      message: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
}

bootstrap();
