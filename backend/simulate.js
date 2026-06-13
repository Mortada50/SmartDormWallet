const axios = require('axios');

const API_URL = 'http://localhost:5000/api/v1';

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runSimulation() {
  try {
    console.log('--- بدء محاكاة النظام ---');
    
    // 1. Admin Login
    console.log('\n[1] تسجيل دخول المسؤول (Admin)...');
    const adminRes = await axios.post(`${API_URL}/auth/login`, {
      phone: '000000000',
      password: 'adminPassword123!'
    });
    const adminToken = adminRes.data.data.accessToken;
    const adminHeader = { headers: { Authorization: `Bearer ${adminToken}` } };
    console.log('✅ نجاح الدخول. اسم المسؤول:', adminRes.data.data.user.fullName);

    // 2. Register Student
    const phone = '770' + Math.floor(100000 + Math.random() * 900000);
    console.log(`\n[2] إنشاء حساب طالب جديد برقم ${phone}...`);
    const registerRes = await axios.post(`${API_URL}/auth/register`, {
      fullName: 'طالب تجريبي',
      phone: phone,
      password: 'studentPassword123!',
      nationalId: '10020030040',
      roomNumber: '101'
    });
    console.log('✅ تم إنشاء حساب الطالب بنجاح');

    // 3. Student Login
    console.log('\n[3] تسجيل دخول الطالب...');
    const studentRes = await axios.post(`${API_URL}/auth/login`, {
      phone: phone,
      password: 'studentPassword123!'
    });
    const studentToken = studentRes.data.data.accessToken;
    const studentHeader = { headers: { Authorization: `Bearer ${studentToken}` } };
    console.log('✅ نجاح دخول الطالب.');

    // 4. Submit Deposit Request
    console.log('\n[4] الطالب يرفع طلب إيداع بمبلغ 50000 ريال...');
    // We mock file upload by skipping Cloudinary or faking it if not strictly required
    // Wait, the deposit route requires a file upload. We will use a FormData with a dummy buffer
    const FormData = require('form-data');
    const form = new FormData();
    form.append('amount', 50000);
    form.append('referenceNumber', 'REF' + Date.now());
    form.append('receipt', Buffer.from('dummy image content'), 'receipt.jpg');

    const depositRes = await axios.post(`${API_URL}/deposits`, form, {
      headers: {
        ...studentHeader.headers,
        ...form.getHeaders()
      }
    });
    const depositPublicId = depositRes.data.data.depositRequest.publicId;
    console.log('✅ تم رفع طلب الإيداع. المعرف:', depositPublicId);

    // 5. Admin Approves Deposit
    console.log('\n[5] المسؤول يوافق على طلب الإيداع...');
    await axios.post(`${API_URL}/admin/deposits/${depositPublicId}/approve`, {
      adminNote: 'تم التحقق من الحوالة، رصيد معتمد.'
    }, adminHeader);
    console.log('✅ تمت الموافقة بنجاح.');

    // 6. Check Student Balance
    console.log('\n[6] جلب رصيد الطالب المحدث...');
    const balanceRes = await axios.get(`${API_URL}/auth/me`, studentHeader);
    console.log('✅ الرصيد الحالي للطالب:', balanceRes.data.data.balances.currentBaseBalance, 'ريال يمني');

    console.log('\n--- تمت المحاكاة بنجاح 🚀 ---');
  } catch (error) {
    console.error('❌ خطأ أثناء المحاكاة:', error.response ? error.response.data : error.message);
  }
}

runSimulation();
