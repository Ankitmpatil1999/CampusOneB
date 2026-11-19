async function testTeacher() {
  const baseURL = 'http://127.0.0.1:3000';
  console.log('Signing in as Prof. Kalpana Bawankar (hod.cse@pbcoe.edu.in)...');
  const teacherSigninRes = await fetch(`${baseURL}/api/v1/auth/console/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hod.cse@pbcoe.edu.in', password: 'Hello@123' })
  });
  const tSignData: any = await teacherSigninRes.json();
  let challengeId = tSignData.challengeId;
  let otp = tSignData.testCode;

  if (!otp && tSignData.alreadySent) {
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
  const tRawCookies = tVerifyRes.headers.getSetCookie();
  const tToken = tRawCookies.find(c => c.includes('rp_console_at='))?.split('rp_console_at=')[1].split(';')[0];
  const tCookie = tRawCookies.map(c => c.split(';')[0]).join('; ');
  const teacherHeaders = {
    'Content-Type': 'application/json',
    'Cookie': tCookie,
    'Authorization': `Bearer ${tToken}`
  };

  console.log('Teacher successfully signed in! Auth session active.');

  // 1. Test /api/v1/teacher/today
  console.log('\n--- 1. Testing GET /api/v1/teacher/today ---');
  const todayRes = await fetch(`${baseURL}/api/v1/teacher/today`, { headers: teacherHeaders });
  const todayJson: any = await todayRes.json();
  console.log('Teacher Today Status:', todayRes.status);
  console.log('Class Teacher of:', todayJson?.classTeacherOf);
  console.log('Periods scheduled for today:', todayJson?.periods?.length || 0);
  if (todayJson?.periods?.length) {
    console.table(todayJson.periods.map((p: any) => ({
      period: p.period.name,
      time: `${p.period.startsAt} - ${p.period.endsAt}`,
      section: p.section.label,
      subject: p.subject.name
    })));
  }

  // 2. Test /api/v1/teacher/classes
  console.log('\n--- 2. Testing GET /api/v1/teacher/classes ---');
  const classesRes = await fetch(`${baseURL}/api/v1/teacher/classes`, { headers: teacherHeaders });
  const classesJson: any = await classesRes.json();
  console.log('Classes Status:', classesRes.status);
  console.log('Total sections taught:', classesJson?.items?.length || 0);
  if (classesJson?.items?.length) {
    console.table(classesJson.items.map((s: any) => ({
      section: s.label,
      classTeacher: s.classTeacher,
      students: s.students,
      subjects: s.subjects?.map((sub: any) => sub.name).join(', ')
    })));
  }

  // 3. Test /api/v1/teacher/timetable
  console.log('\n--- 3. Testing GET /api/v1/teacher/timetable ---');
  const ttRes = await fetch(`${baseURL}/api/v1/teacher/timetable`, { headers: teacherHeaders });
  const ttJson: any = await ttRes.json();
  console.log('Timetable Status:', ttRes.status);
  console.log('Weekly teaching periods scheduled for Prof. Kalpana:', ttJson?.mine?.length || 0);
  if (ttJson?.mine?.length) {
    console.table(ttJson.mine.slice(0, 10).map((s: any) => ({
      day: s.day,
      period: s.period.name,
      section: s.section.label,
      subject: s.subject.name
    })));
  }
}

testTeacher().catch(console.error);
