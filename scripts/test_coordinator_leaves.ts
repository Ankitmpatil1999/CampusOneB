async function testCoordinator() {
  console.log('=== TESTING COORDINATOR LEAVE QUEUE ===');
  
  // 1. Sign in as Academic Coordinator
  const signinRes = await fetch('http://localhost:3000/api/v1/auth/console/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'coordinator@pbcoe.edu.in', password: 'Hello@123' })
  });
  console.log('Coordinator Signin HTTP status:', signinRes.status);
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
  console.log('Coordinator Verify HTTP status:', verifyRes.status);
  
  const rawCookies = verifyRes.headers.getSetCookie();
  const atCookie = rawCookies.find(c => c.includes('rp_console_at='));
  const jwtToken = atCookie ? atCookie.split('rp_console_at=')[1].split(';')[0] : '';
  const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');

  const authHeaders: any = {
    'Content-Type': 'application/json',
    'Cookie': cookieHeader,
    'Authorization': `Bearer ${jwtToken}`
  };

  const coordRes = await fetch('http://localhost:3000/api/v1/console/teacher-leaves?status=PENDING', {
    headers: authHeaders
  });
  console.log('Coordinator Leaves HTTP status:', coordRes.status);
  const coordData: any = await coordRes.json();
  console.log('Pending with Coordinator:', coordData.counts?.pending);
  console.log('With Principal:', coordData.counts?.withPrincipal);
  console.table(coordData.items?.map((item: any) => ({
    reference: item.reference,
    teacher: item.staff?.name,
    type: item.type,
    from: item.from,
    to: item.to,
    days: item.days,
    reason: item.reason.slice(0, 45) + '...',
    state: item.state
  })));
}

testCoordinator().catch(console.error);
