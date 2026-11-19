async function verifyLive() {
  const baseURL = 'http://127.0.0.1:3000';

  // 1. Sign in as Dean (dean@pbcoe.edu.in)
  console.log('Signing in as Dean (dean@pbcoe.edu.in)...');
  const dSign = await fetch(`${baseURL}/api/v1/auth/console/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dean@pbcoe.edu.in', password: 'Hello@123' })
  });
  const dSignData: any = await dSign.json();
  const dVerify = await fetch(`${baseURL}/api/v1/auth/console/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: dSignData.challengeId, otp: dSignData.testCode })
  });
  const dCookies = dVerify.headers.getSetCookie();
  const dToken = dCookies.find(c => c.includes('rp_console_at='))?.split('rp_console_at=')[1].split(';')[0];
  const dCookie = dCookies.map(c => c.split(';')[0]).join('; ');
  const deanHeaders = {
    'Content-Type': 'application/json',
    'Cookie': dCookie,
    'Authorization': `Bearer ${dToken}`
  };

  // Test Calendar
  console.log('\n--- 1. Testing GET /api/v1/console/calendar-events ---');
  const calRes = await fetch(`${baseURL}/api/v1/console/calendar-events`, { headers: deanHeaders });
  const calJson: any = await calRes.json();
  console.log('Calendar Response Status:', calRes.status);
  console.log('Counts:', calJson?.counts);
  if (calJson?.items?.length) {
    console.table(calJson.items.slice(0, 10).map((e: any) => ({
      type: e.type,
      title: e.title,
      start: e.occurrences?.[0]?.start || e.start_date,
      end: e.occurrences?.[0]?.end || e.end_date,
      location: e.location || '-'
    })));
  }

  // Test Notifications for Dean
  console.log('\n--- 2. Testing GET /api/v1/notifications for Dean ---');
  const notifRes = await fetch(`${baseURL}/api/v1/notifications`, { headers: deanHeaders });
  const notifJson: any = await notifRes.json();
  console.log('Dean Notifications Status:', notifRes.status);
  console.log(`Unread count: ${notifJson?.unread}`);
  if (notifJson?.items?.length) {
    console.table(notifJson.items.map((n: any) => ({
      category: n.category,
      title: n.title,
      body: n.body.substring(0, 50) + '...',
      link: n.link
    })));
  }

  // 2. Sign in as Teacher (hod.cse@pbcoe.edu.in)
  console.log('\n--- 3. Testing Notifications for Teacher (hod.cse@pbcoe.edu.in) ---');
  const tSign = await fetch(`${baseURL}/api/v1/auth/console/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hod.cse@pbcoe.edu.in', password: 'Hello@123' })
  });
  const tSignData: any = await tSign.json();
  const tVerify = await fetch(`${baseURL}/api/v1/auth/console/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: tSignData.challengeId, otp: tSignData.testCode })
  });
  const tCookies = tVerify.headers.getSetCookie();
  const tToken = tCookies.find(c => c.includes('rp_console_at='))?.split('rp_console_at=')[1].split(';')[0];
  const tCookie = tCookies.map(c => c.split(';')[0]).join('; ');
  const teacherHeaders = {
    'Content-Type': 'application/json',
    'Cookie': tCookie,
    'Authorization': `Bearer ${tToken}`
  };

  const tNotifRes = await fetch(`${baseURL}/api/v1/notifications`, { headers: teacherHeaders });
  const tNotifJson: any = await tNotifRes.json();
  console.log('Teacher Notifications Status:', tNotifRes.status);
  console.log(`Teacher Unread count: ${tNotifJson?.unread}`);
  if (tNotifJson?.items?.length) {
    console.table(tNotifJson.items.map((n: any) => ({
      category: n.category,
      title: n.title,
      body: n.body.substring(0, 50) + '...',
      link: n.link
    })));
  }
}

verifyLive().catch(console.error);
