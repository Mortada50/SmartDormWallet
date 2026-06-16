'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const env = require('../config/env');

async function applyAccountNumberIndex() {
  try {
    await mongoose.connect(env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const users = mongoose.connection.db.collection('users');

    try {
      await users.createIndex(
        { accountNumber: 1 },
        {
          unique: true,
          partialFilterExpression: { accountNumber: { $type: 'string' } },
          name: 'idx_accountNumber_unique',
        }
      );
      console.log('✅ Created idx_accountNumber_unique on users');
    } catch (err) {
      console.log('⚠️ Index might already exist:', err.message);
    }

    console.log('🎉 Done!');
  } catch (err) {
    console.error('❌ Error:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

applyAccountNumberIndex();
