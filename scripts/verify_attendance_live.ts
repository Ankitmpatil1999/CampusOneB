async function testAttendanceLive() {
  const baseURL = 'http://127.0.0.1:3000';
  
  // 1. Sign in as Dean
  console.log('Signing in as Dean (dean@pbcoe.edu.in)...');
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

  const headers: any = {
    'Content-Type': 'application/json',
    'Cookie': cookieHeader,
    'Authorization': `Bearer ${jwtToken}`
  };
  console.log('Dean signed in successfully. Auth session active.');

  // 2. Fetch Overview
  console.log('\n======================================================');
  console.log('--- 1. Testing GET /api/v1/principal/overview ---');
  console.log('======================================================');
  const overviewRes = await fetch(`${baseURL}/api/v1/principal/overview`, { headers });
  const ov: any = await overviewRes.json();
  console.log('Overview Role:', ov.role);
  console.log('People counts:', ov.people);
  console.log('Attendance Today Summary:');
  console.log(JSON.stringify(ov.attendanceToday, null, 2));
  console.log('Staff On Leave Today:', ov.staffOnLeaveToday);
  console.log('Approvals Summary:', ov.approvals);

  // 3. Fetch Students Attendance for Today
  console.log('\n======================================================');
  console.log('--- 2. Testing GET /api/v1/principal/attendance (type=STUDENTS) ---');
  console.log('======================================================');
  const studentAttRes = await fetch(`${baseURL}/api/v1/principal/attendance?date=2026-11-19&type=STUDENTS`, { headers });
  const studentData: any = await studentAttRes.json();
  console.log(`Date: ${studentData.date}, Total sections with attendance: ${studentData.items.length}`);
  console.table(studentData.items.map((s: any) => ({
    section: s.section.label,
    students: s.students,
    attended: s.attended,
    present: s.present,
    late: s.late,
    absent: s.absent,
    percentage: `${s.percentage}%`
  })));

  // 4. Fetch Teachers Attendance for Today
  console.log('\n======================================================');
  console.log('--- 3. Testing GET /api/v1/principal/attendance (type=TEACHERS) ---');
  console.log('======================================================');
  const teacherAttRes = await fetch(`${baseURL}/api/v1/principal/attendance?date=2026-11-19&type=TEACHERS`, { headers });
  const teacherData: any = await teacherAttRes.json();
  console.log(`Date: ${teacherData.date}, Total faculty: ${teacherData.items.length}`);
  console.table(teacherData.items.map((t: any) => ({
    name: t.member.name,
    role: t.member.type,
    status: t.status,
    checkIn: t.checkInAt ? t.checkInAt.substring(11, 16) : '-',
    checkOut: t.checkOutAt ? t.checkOutAt.substring(11, 16) : '-',
    onApprovedLeave: t.onApprovedLeave
  })));

  // 5. Fetch Staff Attendance for Today
  console.log('\n======================================================');
  console.log('--- 4. Testing GET /api/v1/principal/attendance (type=STAFF) ---');
  console.log('======================================================');
  const staffAttRes = await fetch(`${baseURL}/api/v1/principal/attendance?date=2026-11-19&type=STAFF`, { headers });
  const staffData: any = await staffAttRes.json();
  console.log(`Date: ${staffData.date}, Total staff: ${staffData.items.length}`);
  console.table(staffData.items.map((s: any) => ({
    name: s.member.name,
    role: s.member.type,
    status: s.status,
    checkIn: tCheck(s.checkInAt),
    checkOut: tCheck(s.checkOutAt),
    onApprovedLeave: s.onApprovedLeave
  })));

  // 6. Test historical date (2026-10-15)
  console.log('\n======================================================');
  console.log('--- 5. Testing Historical Date (2026-10-15) ---');
  console.log('======================================================');
  const histRes = await fetch(`${baseURL}/api/v1/principal/attendance?date=2026-10-15&type=STUDENTS`, { headers });
  const histData: any = await histRes.json();
  console.log(`Date: ${histData.date}, Total sections: ${histData.items.length}`);
  const totalAttended = histData.items.reduce((acc: number, s: any) => acc + s.attended, 0);
  const totalStudents = histData.items.reduce((acc: number, s: any) => acc + s.students, 0);
  console.log(`Total Students across sections: ${totalStudents}, Total Attended: ${totalAttended} (${(totalAttended * 100 / totalStudents).toFixed(1)}%)`);

  function tCheck(t: string | null) {
    return t ? t.substring(11, 16) : '-';
  }
}

testAttendanceLive().catch((err) => {
  console.error('Error running test:', err);
});
