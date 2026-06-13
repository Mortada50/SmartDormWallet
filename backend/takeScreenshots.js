const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const OUT_DIR = 'C:/Users/DELL/.gemini/antigravity/brain/6f43f2f6-5e88-47b7-9c49-134a2ccf989d/scratch/';

async function delay(time) {
  return new Promise(function(resolve) { 
      setTimeout(resolve, time)
  });
}

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox']
  });
  const page = await browser.newPage();
  
  // Set viewport to desktop size
  await page.setViewport({ width: 1280, height: 800 });

  try {
    console.log('Navigating to login page...');
    await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle2' });
    await delay(2000);
    
    // Screenshot login page
    const loginImgPath = path.join(OUT_DIR, 'login_page.png');
    await page.screenshot({ path: loginImgPath });
    console.log(`Saved screenshot: ${loginImgPath}`);

    // Type credentials
    console.log('Typing credentials...');
    await page.type('input[name="phone"]', '000000000', { delay: 50 });
    await page.type('input[name="pin"]', 'adminPassword123!', { delay: 50 });
    
    // Click login
    console.log('Clicking login...');
    await page.click('button[type="submit"]');

    // Wait for navigation or network idle
    console.log('Waiting for dashboard to load...');
    await delay(3000);
    
    // Check if we reached admin dashboard
    const currentUrl = page.url();
    console.log('Current URL after login:', currentUrl);
    
    // Screenshot dashboard
    const dashImgPath = path.join(OUT_DIR, 'dashboard_page.png');
    await page.screenshot({ path: dashImgPath });
    console.log(`Saved screenshot: ${dashImgPath}`);
    
  } catch (error) {
    console.error('Simulation failed:', error);
  }
  // Intentionally leaving the browser open for the user to see!
})();
