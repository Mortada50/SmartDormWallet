/**
 * @file index.js
 * @description Central config barrel file.
 *              Import from '@/config' instead of individual config files.
 *
 * @example
 *   const { env, db, redis } = require('../config');
 *
 * @module config
 */

'use strict';

module.exports = {
  env: require('./env'),
  db: require('./db'),
  logger: require('./logger'),
  cloudinary: require('./cloudinary'),
  redis: require('./redis'),
};
