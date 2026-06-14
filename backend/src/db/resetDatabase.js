/**
 * @file resetDatabase.js
 * @description A utility script to wipe all test/production data while preserving Admin accounts and System Settings.
 *
 * CAUTION: THIS IS A DESTRUCTIVE OPERATION.
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');

const {
  User,
  Transaction,
  DepositRequest,
  WithdrawalRequest,
  Expense,
  Merchant,
  MerchantTransaction,
  AuditLog,
  Notification,
  TokenBlacklist,
  DeputyAssignment,
  BalanceSnapshot,
} = require('../models');

const env = require('../config/env');

async function resetDatabase() {
  console.log('\n⚠️  تحذير: سيتم حذف جميع بيانات النظام باستثناء حسابات المشرفين (Admin) والإعدادات (Settings).');
  console.log(`جارٍ الاتصال بقاعدة البيانات...`);

  try {
    await mongoose.connect(env.MONGODB_URI);
    console.log('✅ تم الاتصال بنجاح بـ MongoDB.');

    // Delete everything EXCEPT admins from User
    const userDeleteResult = await User.deleteMany({ role: { $ne: 'admin' } });
    console.log(`🗑️ تم حذف ${userDeleteResult.deletedCount} من الطلاب (Users).`);

    // Delete all from other collections
    const collectionsToClear = [
      { model: Transaction, name: 'سجلات المحفظة (Transactions)' },
      { model: DepositRequest, name: 'طلبات الإيداع (DepositRequests)' },
      { model: WithdrawalRequest, name: 'طلبات السحب (WithdrawalRequests)' },
      { model: Expense, name: 'المصروفات (Expenses)' },
      { model: Merchant, name: 'التجار (Merchants)' },
      { model: MerchantTransaction, name: 'عمليات التجار (MerchantTransactions)' },
      { model: AuditLog, name: 'سجل المراجعة (AuditLogs)' },
      { model: Notification, name: 'الإشعارات (Notifications)' },
      { model: TokenBlacklist, name: 'الجلسات المنتهية (TokenBlacklists)' },
      { model: DeputyAssignment, name: 'تعيينات النواب (DeputyAssignments)' },
      { model: BalanceSnapshot, name: 'اللقطات المالية (BalanceSnapshots)' },
    ];

    for (const { model, name } of collectionsToClear) {
      const result = await model.deleteMany({});
      console.log(`🗑️ تم حذف ${result.deletedCount} من ${name}.`);
    }

    console.log('\n✅ تم الاحتفاظ بإعدادات النظام وحسابات المشرفين.');
    console.log('🎉 عملية تصفير البيانات تمت بنجاح!');
    
  } catch (err) {
    console.error('❌ حدث خطأ أثناء تصفير قاعدة البيانات:', err);
  } finally {
    await mongoose.disconnect();
    console.log('تم فصل الاتصال بقاعدة البيانات.');
    process.exit(0);
  }
}

resetDatabase();
