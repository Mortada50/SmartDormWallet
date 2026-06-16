const mongoose = require('mongoose');
require('dotenv').config({ path: './.env' });
const { Notification } = require('./src/models');
const notificationRepository = require('./src/repositories/notificationRepository');
const { randomUUID } = require('crypto');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  try {
    const doc = await notificationRepository.createOne({
      userId: new mongoose.Types.ObjectId(),
      userPublicId: randomUUID(),
      type: 'TRANSFER_IN',
      message: 'Test message',
      relatedEntityPublicId: randomUUID()
    });
    console.log('Success:', doc);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    mongoose.disconnect();
  }
});
