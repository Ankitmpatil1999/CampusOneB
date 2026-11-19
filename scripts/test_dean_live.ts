async function test() {
  const signinRes = await fetch('http://localhost:3000/api/v1/auth/console/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dean@pbcoe.edu.in', password: 'Hello@123' })
  });
  const signinData: any = await signinRes.json();
  let challengeId = signinData.challengeId;
  let otp = signinData.testCode;

  if (!otp && signinData.alreadySent) {
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
  
  const rawCookies = verifyRes.headers.getSetCookie();
  const atCookie = rawCookies.find(c => c.includes('rp_console_at='));
  const jwtToken = atCookie ? atCookie.split('rp_console_at=')[1].split(';')[0] : '';
  const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');

  const authHeaders: any = {
    'Content-Type': 'application/json',
    'Cookie': cookieHeader,
    'Authorization': `Bearer ${jwtToken}`
  };

  const studentsRes = await fetch('http://localhost:3000/api/v1/principal/student-overview', {
    headers: authHeaders
  });
  const studentsData: any = await studentsRes.json();
  console.log('Student Overview Keys:', Object.keys(studentsData));
  if (Array.isArray(studentsData.classes)) {
    console.log('Classes count:', studentsData.classes.length);
  }
  if (Array.isArray(studentsData.students)) {
    console.log('Students count:', studentsData.students.length);
  } else if (Array.isArray(studentsData.items)) {
    console.log('Items count:', studentsData.items.length);
  }
}

test().catch(console.error);
