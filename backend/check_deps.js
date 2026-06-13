require('dotenv').config();
const mongoose = require('mongoose');
const DepositRequest = require('./src/models/DepositRequest');

async function test() {
  await mongoose.connect(process.env.MONGODB_URI);
  const deps = await DepositRequest.find({ status: 'rejected' }).lean();
  console.log(JSON.stringify(deps, null, 2));
  process.exit(0);
}
test().catch(console.error);
