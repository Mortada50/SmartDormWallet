const mongoose = require('mongoose');
require('dotenv').config({ path: './.env' });
const { User } = require('./src/models');
const ledgerService = require('./src/services/ledgerService');
const transferController = require('./src/controllers/transferController');
const { randomUUID } = require('crypto');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  try {
    const sender = await User.findOne({ status: 'active', accountNumber: { $ne: null } }).lean();
    const recipient = await User.findOne({ status: 'active', accountNumber: { $ne: null }, _id: { $ne: sender._id } }).lean();
    
    console.log('Sender:', sender.fullName);
    console.log('Recipient:', recipient.fullName);
    
    // Test the notification payload directly as it would be in the controller
    const notifRepository = require('./src/repositories/notificationRepository');
    
    const notif1 = await notifRepository.createOne({
      userId: recipient._id,
      userPublicId: recipient.publicId,
      type: 'TRANSFER_IN',
      message: `استلمت تحويلاً بمبلغ 100 ر.ي من ${sender.fullName}`,
      relatedEntityPublicId: randomUUID(),
    });
    console.log('Notif 1 created:', !!notif1);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    mongoose.disconnect();
  }
});
