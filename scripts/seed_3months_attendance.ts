import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  console.log('Connected to MySQL database.');

  // 1. Ensure the 5 students without enrolments get enrolled in year_id = 6 with their section
  const missingEnrolments = [
    { profile_id: 1124, section_id: 138 }, // Neha Deshmukh (AI-DS) -> 138
    { profile_id: 1125, section_id: 150 }, // Rohan Kulkarni (ECE) -> 150
    { profile_id: 1126, section_id: 132 }, // Pratiksha Patil (MCA) -> 132
    { profile_id: 1208, section_id: 125 }, // Poonam Deokar (CSE) -> 125
    { profile_id: 1878, section_id: 142 }, // Rohit Sharma (MECH) -> 142
  ];

  for (const m of missingEnrolments) {
    await conn.query(`
      INSERT INTO campusone_cug.enrolments 
        (institution_id, student_profile_id, year_id, section_id, enrolled_on)
      VALUES 
        (6, ?, 6, ?, '2026-06-15')
      ON DUPLICATE KEY UPDATE section_id = VALUES(section_id)
    `, [m.profile_id, m.section_id]);
  }
  console.log('Verified & enrolled 5 missing students into year 6 sections.');

  // 2. Fetch all students with their section_id
  const [students]: any = await conn.query(`
    SELECT mp.id as profile_id, en.section_id
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    JOIN campusone_cug.enrolments en ON en.student_profile_id = mp.id AND en.year_id = 6
    WHERE mp.institution_id = 6 AND mp.status != 'INACTIVE' AND ut.category = 'STUDENT'
  `);
  console.log(`Fetched ${students.length} active enrolled students.`);

  // 3. Fetch all faculty and staff
  const [staff]: any = await conn.query(`
    SELECT mp.id as profile_id, ut.category, mp.first_name, mp.last_name
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE mp.institution_id = 6 AND mp.status != 'INACTIVE' 
      AND ut.category IN ('TEACHER', 'PRINCIPAL', 'DEAN', 'COORDINATOR', 'STAFF')
  `);
  console.log(`Fetched ${staff.length} faculty and staff members.`);

  // 4. Generate working dates from 2026-09-01 to 2026-11-19 (excluding Sundays)
  const workingDates: string[] = [];
  const cur = new Date('2026-09-01T00:00:00Z');
  const endDate = new Date('2026-11-19T00:00:00Z');

  while (cur <= endDate) {
    const dayOfWeek = cur.getUTCDay(); // 0 is Sunday
    if (dayOfWeek !== 0) {
      const yyyy = cur.getUTCFullYear();
      const mm = String(cur.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(cur.getUTCDate()).padStart(2, '0');
      workingDates.push(`${yyyy}-${mm}-${dd}`);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  console.log(`Generated ${workingDates.length} working dates between 2026-09-01 and 2026-11-19.`);

  // Fetch approved leaves so we respect them in attendance
  const [approvedLeaves]: any = await conn.query(`
    SELECT profile_id, DATE_FORMAT(from_date, '%Y-%m-%d') as from_date, DATE_FORMAT(to_date, '%Y-%m-%d') as to_date, leave_type
    FROM campusone_cug.staff_leaves
    WHERE institution_id = 6 AND final_status = 'APPROVED'
  `);
  console.log(`Found ${approvedLeaves.length} approved staff leaves:`, approvedLeaves);

  function isStaffOnApprovedLeave(profileId: number, dateStr: string): boolean {
    return approvedLeaves.some((l: any) => l.profile_id === profileId && dateStr >= l.from_date && dateStr <= l.to_date);
  }

  // Pseudo-random deterministic generator based on profileId and date so attendance looks consistent
  function pseudoRandom(seed: number) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  // Build rows for insertion
  const allRows: any[] = [];

  for (let dIdx = 0; dIdx < workingDates.length; dIdx++) {
    const dateStr = workingDates[dIdx];
    const isToday = (dateStr === '2026-11-19');

    // --- Students ---
    for (const st of students) {
      const seed = st.profile_id * 1000 + dIdx * 7;
      const rnd = pseudoRandom(seed);

      let status: 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT' = 'PRESENT';
      let checkin_status: 'PRESENT' | 'LATE' | 'ABSENT' = 'PRESENT';
      let check_in_at: string | null = null;
      let check_out_at: string | null = null;
      let method: 'NFC' | 'MANUAL' = (rnd < 0.85) ? 'NFC' : 'MANUAL';
      let remark: string | null = null;

      if (rnd < 0.88) {
        // 88% Present on time
        status = 'PRESENT';
        checkin_status = 'PRESENT';
        const inMin = Math.floor(pseudoRandom(seed + 1) * 20); // 08:35 to 08:55
        const outMin = Math.floor(pseudoRandom(seed + 2) * 35); // 16:30 to 17:05
        check_in_at = `${dateStr} 08:${String(35 + inMin).padStart(2, '0')}:00`;
        check_out_at = `${dateStr} 16:${String(30 + (outMin % 30)).padStart(2, '0')}:00`;
      } else if (rnd < 0.93) {
        // 5% Late
        status = 'LATE';
        checkin_status = 'LATE';
        const inMin = Math.floor(pseudoRandom(seed + 1) * 25); // 09:10 to 09:35
        check_in_at = `${dateStr} 09:${String(10 + inMin).padStart(2, '0')}:00`;
        check_out_at = `${dateStr} 16:45:00`;
        remark = 'Arrived late after gate closed';
      } else if (rnd < 0.95) {
        // 2% Half Day
        status = 'HALF_DAY';
        checkin_status = 'PRESENT';
        check_in_at = `${dateStr} 08:50:00`;
        check_out_at = `${dateStr} 12:45:00`;
        remark = 'Permitted early departure';
      } else {
        // 5% Absent
        status = 'ABSENT';
        checkin_status = 'ABSENT';
        check_in_at = null;
        check_out_at = null;
        method = 'MANUAL';
        remark = 'Unexcused absence';
      }

      allRows.push([
        6, // institution_id
        6, // year_id
        st.profile_id,
        st.section_id,
        dateStr,
        checkin_status,
        status,
        method,
        check_in_at,
        check_out_at,
        remark,
        `${dateStr} 08:30:00`,
        `${dateStr} 17:00:00`
      ]);
    }

    // --- Faculty & Staff ---
    for (const mem of staff) {
      const onLeave = isStaffOnApprovedLeave(mem.profile_id, dateStr);
      const seed = mem.profile_id * 500 + dIdx * 11;
      const rnd = pseudoRandom(seed);

      let status: 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT' = 'PRESENT';
      let checkin_status: 'PRESENT' | 'LATE' | 'ABSENT' = 'PRESENT';
      let check_in_at: string | null = null;
      let check_out_at: string | null = null;
      let method: 'NFC' | 'MANUAL' = 'NFC';
      let remark: string | null = null;

      if (onLeave) {
        status = 'ABSENT';
        checkin_status = 'ABSENT';
        check_in_at = null;
        check_out_at = null;
        method = 'MANUAL';
        remark = 'On Approved Leave';
      } else if (isToday) {
        // Today: Keep faculty/staff attendance high (~96% present)
        if (rnd < 0.92) {
          status = 'PRESENT';
          checkin_status = 'PRESENT';
          check_in_at = `${dateStr} 08:45:00`;
          check_out_at = `${dateStr} 17:00:00`;
        } else if (rnd < 0.96) {
          status = 'LATE';
          checkin_status = 'LATE';
          check_in_at = `${dateStr} 09:15:00`;
          check_out_at = `${dateStr} 17:00:00`;
          remark = 'Late arrival';
        } else {
          status = 'ABSENT';
          checkin_status = 'ABSENT';
          method = 'MANUAL';
          remark = 'Casual Leave applied';
        }
      } else {
        // Historical days
        if (rnd < 0.90) {
          status = 'PRESENT';
          checkin_status = 'PRESENT';
          check_in_at = `${dateStr} 08:45:00`;
          check_out_at = `${dateStr} 17:00:00`;
        } else if (rnd < 0.94) {
          status = 'LATE';
          checkin_status = 'LATE';
          check_in_at = `${dateStr} 09:15:00`;
          check_out_at = `${dateStr} 17:00:00`;
        } else if (rnd < 0.96) {
          status = 'HALF_DAY';
          checkin_status = 'PRESENT';
          check_in_at = `${dateStr} 08:45:00`;
          check_out_at = `${dateStr} 13:00:00`;
        } else {
          status = 'ABSENT';
          checkin_status = 'ABSENT';
          method = 'MANUAL';
          remark = 'Duty leave / Casual leave';
        }
      }

      allRows.push([
        6, // institution_id
        6, // year_id
        mem.profile_id,
        null, // staff doesn't have section_id
        dateStr,
        checkin_status,
        status,
        method,
        check_in_at,
        check_out_at,
        remark,
        `${dateStr} 08:30:00`,
        `${dateStr} 17:00:00`
      ]);
    }
  }

  console.log(`Total attendance records generated: ${allRows.length}`);

  // 5. Batch insert into attendance_days in chunks of 2,000
  const CHUNK_SIZE = 2000;
  let inserted = 0;

  for (let i = 0; i < allRows.length; i += CHUNK_SIZE) {
    const chunk = allRows.slice(i, i + CHUNK_SIZE);
    await conn.query(`
      INSERT INTO campusone_cug.attendance_days 
        (institution_id, year_id, profile_id, section_id, att_date, checkin_status, status, method, check_in_at, check_out_at, remark, created_at, updated_at)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        section_id = VALUES(section_id),
        checkin_status = VALUES(checkin_status),
        status = VALUES(status),
        method = VALUES(method),
        check_in_at = VALUES(check_in_at),
        check_out_at = VALUES(check_out_at),
        remark = VALUES(remark),
        updated_at = VALUES(updated_at)
    `, [chunk]);

    inserted += chunk.length;
    process.stdout.write(`Inserted ${inserted} / ${allRows.length} rows...\r`);
  }

  console.log(`\nSuccessfully inserted/updated ${inserted} attendance records.`);

  // 6. Verify summary of attendance
  const [stats]: any = await conn.query(`
    SELECT 
      MIN(att_date) as start_date,
      MAX(att_date) as end_date,
      COUNT(*) as total_days_records,
      COUNT(DISTINCT att_date) as total_working_days,
      COUNT(DISTINCT profile_id) as total_profiles,
      SUM(status = 'PRESENT') as present_count,
      SUM(status = 'LATE') as late_count,
      SUM(status = 'HALF_DAY') as half_day_count,
      SUM(status = 'ABSENT') as absent_count
    FROM campusone_cug.attendance_days
    WHERE institution_id = 6 AND att_date >= '2026-09-01'
  `);
  console.log('Attendance 3-Month Summary:');
  console.table(stats);

  // Check today's specific stats
  const [todayStats]: any = await conn.query(`
    SELECT 
      ut.category,
      COUNT(*) as total,
      SUM(ad.status IN ('PRESENT', 'LATE', 'HALF_DAY')) as attended,
      SUM(ad.status = 'PRESENT') as present,
      SUM(ad.status = 'LATE') as late,
      SUM(ad.status = 'HALF_DAY') as half_day,
      SUM(ad.status = 'ABSENT') as absent
    FROM campusone_cug.attendance_days ad
    JOIN campusone_cug.member_profiles mp ON mp.id = ad.profile_id
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE ad.institution_id = 6 AND ad.att_date = '2026-11-19'
    GROUP BY ut.category
  `);
  console.log("Today's (2026-11-19) Attendance Summary:");
  console.table(todayStats);

  await conn.end();
}

main().catch(console.error);
