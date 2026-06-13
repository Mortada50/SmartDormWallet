/**
 * @file app.js
 * @description Express application factory.
 *
 * SECURITY LAYERS (applied in order):
 *   1. helmet          — security headers (CSP, HSTS, X-Frame-Options...)
 *   2. cors            — configurable CORS policy
 *   3. express.json()  — body parsing (10kb limit to prevent payload attacks)
 *   4. cookieParser    — for httpOnly refresh token cookie
 *   5. morgan          — HTTP access logging via Winston
 *   6. Routes          — all API routes under /api/v1
 *   7. 404 handler     — catch unmatched routes
 *   8. Global error handler — last middleware (4-argument)
 *
 * @module app
 */

'use strict';

const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const cookieParser = require('cookie-parser');
const morgan      = require('morgan');

const routes = require('./routes');
const { notFoundHandler, globalErrorHandler } = require('./middleware/errorMiddleware');
const logger = require('./config/logger');
const env    = require('./config/env');

// ---------------------------------------------------------------------------
// Application factory
// ---------------------------------------------------------------------------

function createApp() {
  const app = express();

  // ── Security headers ──────────────────────────────────────────────────────
  app.use(helmet({
    crossOriginEmbedderPolicy: false, // allow embedded images from Cloudinary
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  }));

  // ── CORS ─────────────────────────────────────────────────────────────────
  const allowedOrigins = (env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(o => o.trim());

  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (Postman, curl, mobile apps)
      if (!origin || allowedOrigins.includes(origin) || env.NODE_ENV === 'development') {
        callback(null, true);
      } else {
        callback(new Error(`CORS: الأصل غير مسموح به: ${origin}`));
      }
    },
    credentials: true, // Allow cookies (refresh token)
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  }));

  // ── Body parsing ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: '10kb' }));
  app.use(express.urlencoded({ extended: true, limit: '10kb' }));
  app.use(cookieParser());

  // ── HTTP access logging ───────────────────────────────────────────────────
  if (env.NODE_ENV !== 'test') {
    app.use(morgan('combined', {
      stream: { write: (message) => logger.http(message.trim()) },
      skip: (req) => req.url === '/health', // Don't log health checks
    }));
  }

  // ── Trust proxy (for correct req.ip behind reverse proxy / Render / Heroku)
  app.set('trust proxy', 1);

  // ── Health check (no auth, no rate limit) ────────────────────────────────
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
    });
  });

  // ── API routes ────────────────────────────────────────────────────────────
  app.use('/api/v1', routes);

  // ── 404 handler ───────────────────────────────────────────────────────────
  app.use(notFoundHandler);

  // ── Global error handler (must be last) ──────────────────────────────────
  app.use(globalErrorHandler);

  return app;
}

module.exports = createApp;
