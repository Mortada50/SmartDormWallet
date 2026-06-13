const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://admin:admin1234@cluster0.zox41.mongodb.net/smart-dorm-wallet').then(async () => {
  const db = mongoose.connection.db;
  const docs = await db.collection('depositrequests').find({}).toArray();
  console.log(JSON.stringify(docs, null, 2));
  process.exit(0);
});
