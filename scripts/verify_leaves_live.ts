async function test() {
  console.log('=== TESTING DEAN OVERVIEW & TEACHER LEAVE FLOW ===');
  
  // 1. Sign in as Dean
  const signinRes = await fetch('http://localhost:3000/api/v1/auth/console/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dean@pbcoe.edu.in', password: 'Hello@123' })
  });
  console.log('Signin HTTP status:', signinRes.status);
  const signinData: any = await signinRes.json();
  let challengeId = signinData.challengeId;
  let otp = signinData.testCode;

  if (!otp && signinData.alreadySent) {
    console.log(`Waiting ${signinData.resendAfterSeconds + 1}s to resend...`);
    await new Promise(r => setTimeout(r, (signinData.resendAfterSeconds + 1) * 1000));
    const resendRes = await fetch('http://localhost:3000/api/v1/auth/console/otp/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId })
    });
    const resendData: any = await resendRes.json();
    otp = resendData.testCode;
    challengeId = resendData.challengeId || challengeId;
  }

  const verifyRes = await fetch('http://localhost:3000/api/v1/auth/console/otp/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, otp })
  });
  console.log('Verify HTTP status:', verifyRes.status);
  
  const rawCookies = verifyRes.headers.getSetCookie();
  const atCookie = rawCookies.find(c => c.includes('rp_console_at='));
  const jwtToken = atCookie ? atCookie.split('rp_console_at=')[1].split(';')[0] : '';
  const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');

  const authHeaders: any = {
    'Content-Type': 'application/json',
    'Cookie': cookieHeader,
    'Authorization': `Bearer ${jwtToken}`
  };

  const overviewRes = await fetch('http://localhost:3000/api/v1/principal/overview', {
    headers: authHeaders
  });
  console.log('Overview HTTP status:', overviewRes.status);
  const overviewData: any = await overviewRes.json();
  console.log('Overview Data:', JSON.stringify(overviewData, null, 2));

  const awaitingRes = await fetch('http://localhost:3000/api/v1/principal/teacher-leaves?status=AWAITING', {
    headers: authHeaders
  });
  console.log('Awaiting HTTP status:', awaitingRes.status);
  const awaitingData: any = await awaitingRes.json();
  console.log('Awaiting Data:', JSON.stringify(awaitingData, null, 2));
}

test().catch(console.error);
