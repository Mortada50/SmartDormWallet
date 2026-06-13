const mongoose = require('mongoose');
require('dotenv').config({ path: './.env' });
const notificationRepository = require('./src/repositories/notificationRepository');
const User = require('./src/models/User');
const { NOTIFICATION_TYPES } = require('./src/models/Notification');

async function test() {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const user = await User.findOne({ publicId: 'b37b5f6c-5a81-4e93-8f35-99e88a482a99' }).lean();
    const result = await notificationRepository.createOne({
      userId: user._id,
      userPublicId: user.publicId,
      type: NOTIFICATION_TYPES.DEPOSIT_REJECTED,
      message: 'Test notification',
      metadata: { depositRequestPublicId: '123' }
    });
    console.log("Success:", result);
  } catch (err) {
    console.log(JSON.stringify(err.errInfo?.details, null, 2));
  }
  process.exit();
}
test();
