const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: './.env' });
const axios = require('axios');

async function test() {
  const token = jwt.sign(
    { sub: 'b37b5f6c-5a81-4e93-8f35-99e88a482a99', role: 'resident', type: 'access' },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '1h' }
  );

  try {
    const res = await axios.get('http://localhost:5000/api/v1/expenses/my', {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(JSON.stringify(res.data.data.expenses[0], null, 2));
  } catch (err) {
    console.error(err.response?.data || err.message);
  }
}
test();
