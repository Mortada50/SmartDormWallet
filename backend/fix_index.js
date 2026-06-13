const mongoose = require('mongoose');

async function fixIndex() {
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017/SmartDormWallet_DB');
    console.log('Connected to DB');
    const db = mongoose.connection.db;
    
    try {
      await db.collection('merchanttransactions').dropIndex('idx_merchantId_invoiceRef_unique');
      console.log('Dropped old index idx_merchantId_invoiceRef_unique');
    } catch (e) {
      console.log('Old index not found or already dropped');
    }
    
    await db.collection('merchanttransactions').createIndex(
      { merchantId: 1, invoiceReference: 1 },
      { 
        unique: true, 
        partialFilterExpression: { invoiceReference: { $type: 'string' } }, 
        name: 'idx_merchantId_invoiceRef_unique' 
      }
    );
    console.log('Created new index with partialFilterExpression');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

fixIndex();
