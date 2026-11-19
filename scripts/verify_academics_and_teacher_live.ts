async function verifyAcademicsLive() {
  const baseURL = 'http://127.0.0.1:3000';

  // 1. Sign in as Dean
  console.log('--- 1. Testing Dean Academic Overview ---');
  const signinRes = await fetch(`${baseURL}/api/v1/auth/console/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dean@pbcoe.edu.in', password: 'Hello@123' })
  });
  const signinData: any = await signinRes.json();
  let challengeId = signinData.challengeId;
  let otp = signinData.testCode;

  if (!otp && signinData.alreadySent) {
    await new Promise(r => setTimeout(r, (signinData.resendAfterSeconds + 1) * 1000));
    const resendRes = await fetch(`${baseURL}/api/v1/auth/console/otp/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId })
    });
    const resendData: any = await resendRes.json();
    otp = resendData.testCode;
    challengeId = resendData.challengeId || challengeId;
  }

  const verifyRes = await fetch(`${baseURL}/api/v1/auth/console/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, otp })
  });

  const rawCookies = verifyRes.headers.getSetCookie();
  const atCookie = rawCookies.find(c => c.includes('rp_console_at='));
  const jwtToken = atCookie ? atCookie.split('rp_console_at=')[1].split(';')[0] : '';
  const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');

  const deanHeaders = {
    'Content-Type': 'application/json',
    'Cookie': cookieHeader,
    'Authorization': `Bearer ${jwtToken}`
  };

  // Fetch /api/v1/principal/overview
  const ovRes = await fetch(`${baseURL}/api/v1/principal/overview`, { headers: deanHeaders });
  const ovJson: any = await ovRes.json();
  console.log('Dean Overview Academics Summary:');
  console.log(ovJson.academics);

  // Fetch /api/v1/principal/academics
  const acadRes = await fetch(`${baseURL}/api/v1/principal/academics`, { headers: deanHeaders });
  const acadJson: any = await acadRes.json();
  console.log(`\nPrincipal Academics: ${acadJson.sections.length} sections analysed`);
  console.table(acadJson.sections.slice(0, 8).map((s: any) => ({
    section: s.section.label,
    average: `${s.average}%`,
    passRate: `${s.passRate}%`,
    standing: s.standing
  })));

  console.log(`Upcoming Exams in next 14 days: ${acadJson.upcomingExams.length}`);
  console.table(acadJson.upcomingExams.slice(0, 5).map((e: any) => ({
    name: e.name.name,
    section: e.section.label,
    subject: e.subject.name,
    date: e.date,
    time: `${e.startTime} - ${e.endTime}`
  })));

  console.log(`Timetables coverage: ${acadJson.timetables.length} sections`);
  console.table(acadJson.timetables.filter((t: any) => t.lessonsAWeek > 0).slice(0, 6).map((t: any) => ({
    section: t.section.label,
    lessonsAWeek: t.lessonsAWeek
  })));

  // 2. Teacher view test
  console.log('\n--- 2. Testing Teacher Login & Timetable (kalpana.bawankar@pbcoe.edu.in) ---');
  const teacherSigninRes = await fetch(`${baseURL}/api/v1/auth/console/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'kalpana.bawankar@pbcoe.edu.in', password: 'Hello@123' })
  });
  const tSignData: any = await teacherSigninRes.json();
  const tVerifyRes = await fetch(`${baseURL}/api/v1/auth/console/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: tSignData.challengeId, otp: tSignData.testCode })
  });
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
  console.log(`Periods scheduled today for Prof. Kalpana:`, teachingToday?.periods?.length || 0);
  if (teachingToday?.periods?.length) {
    console.table(teachingToday.periods.map((p: any) => ({
      period: p.period.name,
      time: `${p.period.startsAt} - ${p.period.endsAt}`,
      section: p.section.label,
      subject: p.subject.name
    })));
  }
}

verifyAcademicsLive().catch(console.error);
