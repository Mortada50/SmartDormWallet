/**
 * @file logger.js
 * @description Structured Winston logger with Morgan HTTP request logging.
 *
 * Outputs:
 *  - Development: coloured, human-readable console output.
 *  - Production: JSON structured logs (compatible with Render log drain,
 *    Datadog, Logtail, etc.).
 *
 * Log levels (Winston standard):
 *  error > warn > info > http > debug
 *
 * @module config/logger
 */

'use strict';

const { createLogger, format, transports } = require('winston');
const morgan = require('morgan');

// Defer env import to avoid circular dependency during startup validation
const getEnv = () => {
  try {
    return require('./env');
  } catch {
    return { NODE_ENV: process.env.NODE_ENV || 'development', LOG_LEVEL: 'info' };
  }
};

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

const developmentFormat = format.combine(
  format.colorize({ all: true }),
  format.timestamp({ format: 'HH:mm:ss' }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? '\n' + JSON.stringify(meta, null, 2)
      : '';
    return `${timestamp} ${level}: ${message}${metaStr}`;
  })
);

const productionFormat = format.combine(
  format.timestamp(),
  format.errors({ stack: true }),
  format.json()
);

// ---------------------------------------------------------------------------
// Logger instance
// ---------------------------------------------------------------------------

const env = getEnv();

const logger = createLogger({
  level: env.LOG_LEVEL || 'info',
  format: env.NODE_ENV === 'production' ? productionFormat : developmentFormat,
  defaultMeta: { service: 'smart-dorm-wallet' },
  transports: [new transports.Console()],
  exitOnError: false,
});

// ---------------------------------------------------------------------------
// Morgan HTTP middleware (integrates with Winston)
// ---------------------------------------------------------------------------

/**
 * Morgan middleware that pipes HTTP request logs into Winston at 'http' level.
 * Use this in app.js: app.use(httpLogger)
 */
const httpLogger = morgan(
  env.NODE_ENV === 'production' ? 'combined' : 'dev',
  {
    stream: {
      write: (message) => logger.http(message.trim()),
    },
    // Skip health check noise in production
    skip: (req) =>
      env.NODE_ENV === 'production' && req.url === '/api/v1/health',
  }
);

module.exports = logger;
module.exports.httpLogger = httpLogger;
