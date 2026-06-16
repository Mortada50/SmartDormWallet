'use strict';

const router = require('express').Router();
const { authenticate, requireAnyRole } = require('../middleware/authMiddleware');
const { lookup, generateAccountNumber, createTransfer } = require('../controllers/transferController');

// Lookup recipient by account number
router.get('/lookup', authenticate, requireAnyRole, lookup);

// Generate account number for current user (one-time)
router.post('/generate-account-number', authenticate, requireAnyRole, generateAccountNumber);

// Execute a transfer
router.post('/', authenticate, requireAnyRole, createTransfer);

module.exports = router;
