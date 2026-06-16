const mongoose = require('mongoose');
require('dotenv').config({ path: './.env' });
const { AuditLog } = require('./src/models');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  try {
    const logs = await AuditLog.find({ action: 'TRANSFER_CREATED' }).lean();
    console.log('Found:', logs.length);
    console.log(logs);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    mongoose.disconnect();
  }
});
