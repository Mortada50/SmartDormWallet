const mongoose = require('mongoose');
require('dotenv').config({ path: './.env' });
const { Notification } = require('./src/models');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  try {
    const notifs = await Notification.find({ type: { $in: ['TRANSFER_IN', 'TRANSFER_OUT'] } }).lean();
    console.log('Found:', notifs.length);
    console.log(notifs);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    mongoose.disconnect();
  }
});
