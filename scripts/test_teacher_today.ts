import mysql from 'mysql2/promise';

async function testTeacher() {
  const baseURL = 'http://127.0.0.1:3000';
  const teacherSigninRes = await fetch(`${baseURL}/api/v1/auth/console/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'kalpana.bawankar@pbcoe.edu.in', password: 'Hello@123' })
  });
  const tSignData: any = await teacherSigninRes.json();
  console.log('Teacher signin response:', tSignData);

  let challengeId = tSignData.challengeId;
  let otp = tSignData.testCode;

  if (!otp && tSignData.alreadySent) {
    console.log(`Waiting ${tSignData.resendAfterSeconds + 1}s to resend OTP...`);
    await new Promise(r => setTimeout(r, (tSignData.resendAfterSeconds + 1) * 1000));
    const resendRes = await fetch(`${baseURL}/api/v1/auth/console/otp/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId })
    });
    const resendData: any = await resendRes.json();
    otp = resendData.testCode;
    challengeId = resendData.challengeId || challengeId;
  }

  const tVerifyRes = await fetch(`${baseURL}/api/v1/auth/console/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, otp })
  });
  const tVerifyData: any = await tVerifyRes.json();
  console.log('Teacher verify status:', tVerifyRes.status, tVerifyData);

  const tRawCookies = tVerifyRes.headers.getSetCookie();
  const tToken = tRawCookies.find(c => c.includes('rp_console_at='))?.split('rp_console_at=')[1].split(';')[0];
  const tCookie = tRawCookies.map(c => c.split(';')[0]).join('; ');
  const teacherHeaders = {
    'Content-Type': 'application/json',
    'Cookie': tCookie,
    'Authorization': `Bearer ${tToken}`
  };

  const teachingTodayRes = await fetch(`${baseURL}/api/v1/teaching/today`, { headers: teacherHeaders });
  const teachingToday: any = await teachingTodayRes.json();
  console.log('Teacher Today Status:', teachingTodayRes.status);
  console.log(`Teaching Today Response:`, JSON.stringify(teachingToday, null, 2));
}

testTeacher().catch(console.error);
