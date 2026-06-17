const mongoose = require('mongoose');
require('dotenv').config({ path: './.env' });
const userRepository = require('./src/repositories/userRepository');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  try {
    const user = await userRepository.findByAccountNumber('102345'); // Need to find a user that has beneficiaries
    const user2 = await userRepository.findByPublicId(user?.publicId || (await mongoose.connection.collection('users').findOne({})).publicId);
    console.log(JSON.stringify(user2.savedBeneficiaries, null, 2));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    mongoose.disconnect();
  }
});
