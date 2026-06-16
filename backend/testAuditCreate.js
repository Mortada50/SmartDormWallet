const mongoose = require('mongoose');
require('dotenv').config({ path: './.env' });
const auditLogRepository = require('./src/repositories/auditLogRepository');
const { randomUUID } = require('crypto');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  try {
    const log = await auditLogRepository.createLog({
      actorId: new mongoose.Types.ObjectId(),
      actorPublicId: randomUUID(),
      actorRole: 'admin',
      actorName: 'Test Admin',
      action: 'TRANSFER_CREATED',
      entityType: 'transfer',
      entityPublicId: randomUUID(),
      metadata: {
        amount: 100
      }
    });
    console.log('Log created:', !!log);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    mongoose.disconnect();
  }
});
