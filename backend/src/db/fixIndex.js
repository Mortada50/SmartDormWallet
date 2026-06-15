/**
 * @file fixIndex.js
 * @description Drops the faulty merchant transactions index and recreates it.
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const env = require('../config/env');

async function fixIndex() {
  try {
    await mongoose.connect(env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection('merchanttransactions');

    try {
      await collection.dropIndex('idx_merchantId_invoiceRef_unique');
      console.log('✅ Dropped old index idx_merchantId_invoiceRef_unique');
    } catch (err) {
      console.log('⚠️ Old index not found or already dropped:', err.message);
    }

    await collection.createIndex(
      { merchantId: 1, invoiceReference: 1 },
      {
        unique: true,
        partialFilterExpression: { invoiceReference: { $type: 'string' } },
        name: 'idx_merchantId_invoiceRef_unique',
      }
    );
    console.log('✅ Created new index idx_merchantId_invoiceRef_unique with $type: string');

  } catch (err) {
    console.error('❌ Error fixing index:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

fixIndex();
