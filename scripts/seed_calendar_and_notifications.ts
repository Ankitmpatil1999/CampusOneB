import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';

function uuidToBin(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  console.log('Connected to MySQL database.');

  const instId = 6;
  const yearId = 6;

  // =========================================================================
  // 1. Seed Calendar Entries (Holidays, Exams, Sports Day, Events, Meetings)
  // =========================================================================
  console.log('\n--- 1. Seeding Academic Calendar Entries ---');

  const calendarEvents = [
    // --- Holidays ---
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Independence Day',
      description: 'National Holiday on account of 80th Independence Day of India.',
      all_day: 1,
      start_date: '2026-08-15',
      end_date: '2026-08-15',
      location: 'Campus Flag Ground',
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Raksha Bandhan',
      description: 'Festival Holiday for Raksha Bandhan celebration.',
      all_day: 1,
      start_date: '2026-08-28',
      end_date: '2026-08-28',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Janmashtami',
      description: 'Public holiday commemorating Shri Krishna Janmashtami.',
      all_day: 1,
      start_date: '2026-09-04',
      end_date: '2026-09-04',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Ganesh Chaturthi',
      description: 'Lord Ganesha Sthapana & festival holiday across Maharashtra.',
      all_day: 1,
      start_date: '2026-09-14',
      end_date: '2026-09-14',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Mahatma Gandhi Jayanti',
      description: 'National holiday honoring the birth anniversary of Mahatma Gandhi.',
      all_day: 1,
      start_date: '2026-10-02',
      end_date: '2026-10-02',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Dussehra / Vijayadashami',
      description: 'Dussehra festival celebration holiday.',
      all_day: 1,
      start_date: '2026-10-20',
      end_date: '2026-10-20',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Vacation',
      title: 'Diwali & Laxmi Pujan Vacation',
      description: 'Diwali festival vacation for all students, faculty and staff members.',
      all_day: 1,
      start_date: '2026-11-08',
      end_date: '2026-11-12',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Guru Nanak Jayanti',
      description: 'Prakash Utsav of Guru Nanak Dev Ji.',
      all_day: 1,
      start_date: '2026-11-24',
      end_date: '2026-11-24',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Christmas Day',
      description: 'Christmas celebration holiday.',
      all_day: 1,
      start_date: '2026-12-25',
      end_date: '2026-12-25',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Vacation',
      title: 'Winter Vacation 2026-27',
      description: 'Semester break & winter vacation for students and academic staff.',
      all_day: 1,
      start_date: '2026-12-28',
      end_date: '2027-01-02',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Makar Sankranti',
      description: 'Harvest festival holiday of Makar Sankranti & Pongal.',
      all_day: 1,
      start_date: '2027-01-14',
      end_date: '2027-01-14',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Republic Day Celebration',
      description: '78th Republic Day Parade and flag hoisting ceremony at PBCOE.',
      all_day: 1,
      start_date: '2027-01-26',
      end_date: '2027-01-26',
      location: 'PBCOE Main Parade Ground',
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Institution holiday',
      title: 'Chhatrapati Shivaji Maharaj Jayanti',
      description: 'Birth anniversary celebration of Chhatrapati Shivaji Maharaj.',
      all_day: 1,
      start_date: '2027-02-19',
      end_date: '2027-02-19',
      location: 'Campus Auditorium',
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Mahashivratri',
      description: 'Festival holiday of Mahashivratri.',
      all_day: 1,
      start_date: '2027-03-06',
      end_date: '2027-03-06',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Holi (Dhulivandan)',
      description: 'Festival of Colours celebration holiday.',
      all_day: 1,
      start_date: '2027-03-22',
      end_date: '2027-03-22',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Dr. Babasaheb Ambedkar Jayanti',
      description: 'Birth anniversary of Bharat Ratna Dr. B. R. Ambedkar.',
      all_day: 1,
      start_date: '2027-04-14',
      end_date: '2027-04-14',
      location: null,
      colour: '#ef4444'
    },
    {
      type: 'Holiday',
      holiday_type: 'Public holiday',
      title: 'Maharashtra Day & Labour Day',
      description: 'Foundation day of Maharashtra State.',
      all_day: 1,
      start_date: '2027-05-01',
      end_date: '2027-05-01',
      location: null,
      colour: '#ef4444'
    },

    // --- Exams ---
    {
      type: 'Exam',
      holiday_type: null,
      title: 'Mid-Semester Theory Examination 2026',
      description: 'Odd-Semester internal theory examination for 1st, 2nd, 3rd and 4th year B.Tech and MCA.',
      all_day: 0,
      start_date: '2026-10-06',
      end_date: '2026-10-17',
      location: 'Respective Department Exam Halls',
      colour: '#f59e0b'
    },
    {
      type: 'Exam',
      holiday_type: null,
      title: 'Departmental Lab Practical & Viva Exams',
      description: 'Winter 2026 practical examinations and external lab viva evaluation.',
      all_day: 0,
      start_date: '2026-11-10',
      end_date: '2026-11-16',
      location: 'Engineering Department Laboratories',
      colour: '#f59e0b'
    },
    {
      type: 'Exam',
      holiday_type: null,
      title: 'End-Semester University Theory Examination 2026',
      description: 'Rashtrasant Tukadoji Maharaj Nagpur University (RTMNU) Winter 2026 Final Theory Exams.',
      all_day: 0,
      start_date: '2026-11-23',
      end_date: '2026-12-08',
      location: 'PBCOE University Examination Center',
      colour: '#f59e0b'
    },
    {
      type: 'Exam',
      holiday_type: null,
      title: 'Even-Semester Mid-Term Assessment 2027',
      description: 'Internal assessment examination for Spring 2027 session across all branches.',
      all_day: 0,
      start_date: '2027-03-15',
      end_date: '2027-03-24',
      location: 'Classrooms & Seminar Halls',
      colour: '#f59e0b'
    },
    {
      type: 'Exam',
      holiday_type: null,
      title: 'Final Degree Examinations & Major Project Defense',
      description: 'Final year major project presentation, viva-voce and summer degree examinations.',
      all_day: 0,
      start_date: '2027-05-05',
      end_date: '2027-05-20',
      location: 'Auditorium & Conference Rooms',
      colour: '#f59e0b'
    },

    // --- Sports Day & Athletics ---
    {
      type: 'Sports',
      holiday_type: null,
      title: 'Annual Sports Meet - PBCOE Khel Mahotsav 2026',
      description: 'Annual Inter-Departmental Sports Tournaments: Cricket, Football, Volleyball, Basketball, Badminton, Chess & Table Tennis.',
      all_day: 1,
      start_date: '2026-12-18',
      end_date: '2026-12-20',
      location: 'PBCOE Main Sports Complex & Indoor Stadium',
      colour: '#10b981'
    },
    {
      type: 'Sports',
      holiday_type: null,
      title: 'Annual Athletic Championship & Track Events',
      description: 'Track and field events: 100m, 200m, 400m, 4x100m Relay, Shot Put, Long Jump, Javelin and Tug-of-War Finals.',
      all_day: 1,
      start_date: '2026-12-22',
      end_date: '2026-12-22',
      location: 'College Athletic Stadium Track',
      colour: '#10b981'
    },
    {
      type: 'Sports',
      holiday_type: null,
      title: 'Inter-College University Sports Trials',
      description: 'RTMNU University selection trials for College Cricket & Badminton Teams.',
      all_day: 0,
      start_date: '2027-01-20',
      end_date: '2027-01-20',
      location: 'College Sports Pavilion',
      colour: '#10b981'
    },

    // --- College Events & Fests ---
    {
      type: 'Event',
      holiday_type: null,
      title: "Engineers' Day Celebration & Innovation Expo",
      description: 'Commemoration of Bharat Ratna Sir M. Visvesvaraya. Student prototype and hardware innovation display.',
      all_day: 1,
      start_date: '2026-09-15',
      end_date: '2026-09-15',
      location: 'PBCOE Central Auditorium',
      colour: '#3b82f6'
    },
    {
      type: 'Event',
      holiday_type: null,
      title: 'Technova 2026: National Technical Symposium',
      description: 'Annual national tech fest featuring National Coding Hackathon, Robotics Arena, Paper Presentation & Webathon.',
      all_day: 1,
      start_date: '2026-10-27',
      end_date: '2026-10-28',
      location: 'PBCOE Campus & Computer Center',
      colour: '#3b82f6'
    },
    {
      type: 'Event',
      holiday_type: null,
      title: 'Tarunya 2027: Annual Cultural Gathering',
      description: '3-Day Mega Cultural Fest with Music, Dance, Fashion Show, Drama, Art Showcase and Celebrity Musical Night.',
      all_day: 1,
      start_date: '2027-02-12',
      end_date: '2027-02-14',
      location: 'PBCOE Open Air Amphitheatre',
      colour: '#8b5cf6'
    },
    {
      type: 'Event',
      holiday_type: null,
      title: "International Women's Day & Technologist Forum",
      description: 'Celebrating women in engineering and technology with keynote speeches, workshops and awards.',
      all_day: 1,
      start_date: '2027-03-08',
      end_date: '2027-03-08',
      location: 'Auditorium',
      colour: '#ec4899'
    },

    // --- Meetings & PTM ---
    {
      type: 'PTM',
      holiday_type: null,
      title: 'Odd-Semester Parent-Teacher Meeting (PTM)',
      description: 'Parent-Teacher conference to discuss Mid-Term academic performance, student attendance and project progress.',
      all_day: 0,
      start_date: '2026-10-24',
      end_date: '2026-10-24',
      location: 'Respective Department Seminar Halls',
      colour: '#6366f1'
    },
    {
      type: 'Meeting',
      holiday_type: null,
      title: 'Academic Council & HOD Examination Review',
      description: 'Review of syllabus coverage, university examination preparedness, lab assessments and teacher leave schedules.',
      all_day: 0,
      start_date: '2026-11-20',
      end_date: '2026-11-20',
      location: 'Board Room / Conference Hall',
      colour: '#64748b'
    },
    {
      type: 'PTM',
      holiday_type: null,
      title: 'Even-Semester Parent-Teacher Meeting (PTM)',
      description: 'Discussion on student placement preparation, university form submissions and summer internship planning.',
      all_day: 0,
      start_date: '2027-03-27',
      end_date: '2027-03-27',
      location: 'Department Classrooms',
      colour: '#6366f1'
    }
  ];

  let calInserted = 0;
  for (const e of calendarEvents) {
    const pubId = uuidToBin(uuidv4());

    await conn.query(`
      INSERT INTO campusone_cug.calendar_entries
        (public_id, institution_id, year_id, type, holiday_type, title, description,
         all_day, start_date, end_date, start_time, end_time, location, audience, recurrence,
         colour, reminders, source, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ALL', 'NONE', ?, '[]', 'CONSOLE', NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        description = VALUES(description),
        end_date = VALUES(end_date),
        location = VALUES(location),
        colour = VALUES(colour),
        updated_at = NOW()
    `, [
      pubId, instId, yearId, e.type, e.holiday_type, e.title, e.description,
      e.all_day, e.start_date, e.end_date,
      e.all_day ? null : '10:00:00',
      e.all_day ? null : '16:00:00',
      e.location, e.colour
    ]);
    calInserted++;
  }
  console.log(`✅ Seeded ${calInserted} rich calendar entries (Holidays, Exams, Sports Day, Fests, PTM)!`);


  // =========================================================================
  // 2. Seed Announcement Categories & Announcements
  // =========================================================================
  console.log('\n--- 2. Seeding Announcements & Categories ---');

  const categories = [
    { code: 'GEN', label: 'General Notice', colour: '#3b82f6', sort_order: 1 },
    { code: 'ACAD', label: 'Academic Notice', colour: '#10b981', sort_order: 2 },
    { code: 'EXAM', label: 'Exam Circular', colour: '#f59e0b', sort_order: 3 },
    { code: 'SPORT', label: 'Sports & Games', colour: '#06b6d4', sort_order: 4 },
    { code: 'EVENT', label: 'College Fests', colour: '#8b5cf6', sort_order: 5 },
    { code: 'HOLI', label: 'Holiday Circular', colour: '#ef4444', sort_order: 6 },
    { code: 'ADMIN', label: 'Admin & Finance', colour: '#64748b', sort_order: 7 },
  ];

  for (const cat of categories) {
    await conn.query(`
      INSERT INTO campusone_cug.announcement_categories (code, label, colour, sort_order)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE label = VALUES(label), colour = VALUES(colour), sort_order = VALUES(sort_order)
    `, [cat.code, cat.label, cat.colour, cat.sort_order]);
  }
  console.log(`✅ Configured ${categories.length} announcement categories.`);

  // Announcements to insert
  const notices = [
    {
      seq: 1,
      category_code: 'SPORT',
      title: 'Annual Sports Meet 2026: Team Registration Open',
      body: 'All students and faculty members are invited to register for the upcoming PBCOE Annual Sports Meet 2026 (Khel Mahotsav). Events include Cricket, Football, Volleyball, Badminton, Table Tennis and Athletics. Submit your departmental team entries to your respective sports coordinator by 5th December 2026.',
      important: 1,
      ack_required: 0
    },
    {
      seq: 2,
      category_code: 'EXAM',
      title: 'End-Semester University Examination: Hall Tickets & Time Table',
      body: 'The RTM Nagpur University Winter 2026 Examination schedule has been released. Theory examinations commence from 23rd November 2026. All students can download their examination admit cards / hall tickets from the student portal. Carrying your college identity card and physical hall ticket is mandatory in the examination hall.',
      important: 1,
      ack_required: 1
    },
    {
      seq: 3,
      category_code: 'HOLI',
      title: 'Holiday Circular: Guru Nanak Jayanti & Winter Schedule',
      body: 'The college will remain closed on Tuesday, 24th November 2026 on account of Guru Nanak Jayanti. Normal academic lectures and laboratory practicals will resume on Wednesday, 25th November 2026 as per the regular timetable.',
      important: 0,
      ack_required: 0
    },
    {
      seq: 4,
      category_code: 'EVENT',
      title: 'Technova 2026: National Technical Symposium Highlights & Winners',
      body: 'Congratulations to all winning student teams at Technova 2026! Over 1,200 participants from 45 engineering colleges participated in the 24-hour National Hackathon and Robotics Challenge. PBCOE CSE and AI-DS teams bagged the 1st prize in the Open Innovation Track.',
      important: 0,
      ack_required: 0
    },
    {
      seq: 5,
      category_code: 'ACAD',
      title: 'Mid-Semester Examination Results Published in Student Portal',
      body: 'Results for the Mid-Semester Winter Examinations 2026 have been published across all B.Tech and MCA sections. Students can view their subject-wise marks and grade distributions under the Academics > Results section. For any re-evaluation inquiries, contact your class teacher before 25th November 2026.',
      important: 1,
      ack_required: 0
    },
    {
      seq: 6,
      category_code: 'ADMIN',
      title: 'Library Extended Hours & University Exam Book Bank Facility',
      body: 'In view of the upcoming university examinations, the PBCOE Central Library will remain open from 08:00 AM to 08:00 PM on all working days including Saturdays. The Book Bank facility is open for all students to borrow reference textbooks.',
      important: 0,
      ack_required: 0
    }
  ];

  // Fetch all PBCOE member profiles for recipient mapping
  const [profiles]: any = await conn.query(`
    SELECT id FROM campusone_cug.member_profiles WHERE institution_id = ? AND status != 'INACTIVE'
  `, [instId]);
  console.log(`Targeting announcements to ${profiles.length} PBCOE members.`);

  for (const n of notices) {
    const pubId = uuidToBin(uuidv4());
    await conn.query(`
      INSERT INTO campusone_cug.announcements
        (public_id, institution_id, year_id, seq, source, section_id, title, body, category_code,
         important, ack_required, channels, targets, send_at, status, recipients, sent_success,
         dispatched_at, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, 'PRINCIPAL', NULL, ?, ?, ?, ?, ?, 'IN_APP,EMAIL', '{"groups":["STUDENTS","TEACHERS","STAFF"]}',
         NOW(), 'COMPLETED', ?, ?, NOW(), NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        body = VALUES(body),
        important = VALUES(important),
        updated_at = NOW()
    `, [pubId, instId, yearId, n.seq, n.title, n.body, n.category_code, n.important, n.ack_required, profiles.length, profiles.length]);

    const [annRow]: any = await conn.query('SELECT id FROM campusone_cug.announcements WHERE institution_id = ? AND seq = ?', [instId, n.seq]);
    const annId = annRow[0]?.id;

    // Seed sample recipients so `mine` API displays them
    if (annId) {
      const recipientChunks = profiles.slice(0, 100); // map top 100 profiles (including faculty & sample students)
      for (const p of recipientChunks) {
        await conn.query(`
          INSERT IGNORE INTO campusone_cug.announcement_recipients
            (announcement_id, profile_id, institution_id, delivered_at, acknowledged_at, ack_channel)
          VALUES
            (?, ?, ?, NOW(), ${n.ack_required ? 'NOW()' : 'NULL'}, 'IN-APP')
        `, [annId, p.id, instId]);
      }
    }
  }
  console.log(`✅ Seeded ${notices.length} official college announcements and mapped recipient deliveries.`);


  // =========================================================================
  // 3. Seed In-App Notifications for ALL Roles (The Bell Icon)
  // =========================================================================
  console.log('\n--- 3. Seeding Role-Specific In-App Notifications (Notification Bell) ---');

  // Fetch accounts by role
  const [keyAccounts]: any = await conn.query(`
    SELECT mp.id as profile_id, mp.first_name, mp.last_name, mp.account_id, ut.category, pa.email
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    JOIN campusone.platform_accounts pa ON pa.id = mp.account_id
    WHERE mp.institution_id = ? AND mp.status != 'INACTIVE'
  `, [instId]);

  console.log(`Found ${keyAccounts.length} members with platform accounts in PBCOE.`);

  const dean = keyAccounts.find((a: any) => a.category === 'DEAN');
  const principal = keyAccounts.find((a: any) => a.category === 'PRINCIPAL');
  const coordinator = keyAccounts.find((a: any) => a.category === 'COORDINATOR');
  const teachers = keyAccounts.filter((a: any) => a.category === 'TEACHER');
  const staff = keyAccounts.filter((a: any) => a.category === 'STAFF');
  const students = keyAccounts.filter((a: any) => a.category === 'STUDENT');
  const parents = keyAccounts.filter((a: any) => a.category === 'PARENT');

  const notificationsToInsert: any[] = [];
  const todayStr = '2026-11-19';

  function addNotif(accId: number, surface: 'CONSOLE' | 'MEMBER', category: string, titleKey: string, body: string, link: string) {
    notificationsToInsert.push([
      todayStr,
      uuidToBin(uuidv4()),
      instId,
      accId,
      surface,
      category,
      titleKey,
      JSON.stringify({}),
      body,
      link,
      null, // read_at is null so unread badge shows!
      new Date()
    ]);
  }

  // --- 1. Notifications for Dean (Pravin Patil) ---
  if (dean) {
    addNotif(dean.account_id, 'CONSOLE', 'APPROVAL', 'Teacher Leave Requests Awaiting Your Decision', '4 teacher leave applications have been recommended by Academic Coordinator and await your final approval.', '/console/principal-leave');
    addNotif(dean.account_id, 'CONSOLE', 'ACADEMICS', 'Winter 2026 End-Semester Exam Schedule Ready', 'University theory examination time table and seating allocation for 17 sections has been finalized.', '/console/principal');
    addNotif(dean.account_id, 'CONSOLE', 'ATTENDANCE', 'Daily PBCOE Attendance Report (19-Nov-2026)', 'Overall student attendance today is 94.7% (701/740) and faculty attendance is 94.7% (18/19).', '/console/principal-attendance');
    addNotif(dean.account_id, 'CONSOLE', 'EVENT', 'Annual Sports Meet 2026 Ground Preparation', 'Sports committee submitted the ground and equipment preparation proposal for approval.', '/console/principal');
  }

  // --- 2. Notifications for Principal (Narendra Choudhari) ---
  if (principal) {
    addNotif(principal.account_id, 'CONSOLE', 'ACADEMICS', 'RTM Nagpur University Inspection Circular', 'University academic inspection visit is scheduled for the upcoming accreditation cycle.', '/console/principal');
    addNotif(principal.account_id, 'CONSOLE', 'ATTENDANCE', 'PBCOE Institutional Attendance Overview', 'Student attendance today stands at 94.7%. 1 faculty member is on approved casual leave today.', '/console/principal-attendance');
    addNotif(principal.account_id, 'CONSOLE', 'APPROVAL', 'Staff Leave Decision Log', 'Dean Dr. Pravin Patil is reviewing pending faculty leave requests.', '/console/principal-leave');
  }

  // --- 3. Notifications for Coordinator (Manish Choudhari) ---
  if (coordinator) {
    addNotif(coordinator.account_id, 'CONSOLE', 'LEAVE', '3 Teacher Leave Applications Awaiting Review', 'Leave applications from Prof. Kalpana Bawankar, Prof. Priya Agrawal and Prof. Tanmay Deokar need your recommendation.', '/console/principal-leave');
    addNotif(coordinator.account_id, 'CONSOLE', 'TIMETABLE', 'Winter 2026 Timetable Activated', 'All 33 class sections now have 671 clash-free lessons scheduled across Monday to Saturday.', '/console/teaching');
  }

  // --- 4. Notifications for Faculty / Teachers ---
  for (const t of teachers) {
    addNotif(t.account_id, 'CONSOLE', 'ACADEMICS', 'Mid-Semester Marks Successfully Validated', 'Internal examination marks for your assigned subjects have been verified and published to students.', '/console/teaching');
    addNotif(t.account_id, 'CONSOLE', 'SPORT', 'Annual Sports Meet 2026: Faculty Duty Assignment', 'Faculty committee duties for Khel Mahotsav 2026 tournaments have been uploaded.', '/console/announcements');
    addNotif(t.account_id, 'CONSOLE', 'HOLIDAY', 'Holiday Circular: Guru Nanak Jayanti (24-Nov)', 'The institution will remain closed on 24th November 2026 on account of Guru Nanak Jayanti.', '/console/announcements');
  }

  // --- 5. Notifications for Students ---
  for (const s of students) {
    addNotif(s.account_id, 'MEMBER', 'EXAM', 'End-Sem University Exam Hall Ticket Available', 'Your official university examination hall ticket is now available for download. Please print and verify your exam roll number.', '/announcements');
    addNotif(s.account_id, 'MEMBER', 'SPORT', 'Khel Mahotsav 2026: Team Registration Open', 'Register your departmental team for Cricket, Football, Badminton and Athletics events before 5th December.', '/announcements');
    addNotif(s.account_id, 'MEMBER', 'ACADEMICS', 'Mid-Semester Exam Marks Published', 'Your subject-wise internal assessment marks and grades are now live on your student dashboard.', '/me/academics');
  }

  // --- 6. Notifications for Staff ---
  for (const st of staff) {
    addNotif(st.account_id, 'CONSOLE', 'ADMIN', 'Biometric & NFC Attendance Sync Scheduled', 'Monthly firmware check and NFC tap terminal verification is scheduled for Saturday 5:00 PM.', '/console/attendance');
    addNotif(st.account_id, 'CONSOLE', 'HOLIDAY', 'Holiday Notice: Guru Nanak Jayanti (24-Nov)', 'Non-teaching and lab staff holiday notice on account of Guru Nanak Jayanti.', '/console/announcements');
  }

  // --- 7. Notifications for Parents ---
  for (const pr of parents) {
    addNotif(pr.account_id, 'MEMBER', 'ACADEMICS', 'Odd-Semester Parent-Teacher Meeting (PTM)', 'You are cordially invited to attend the Parent-Teacher Meeting on Saturday 24th October at 10:00 AM.', '/announcements');
    addNotif(pr.account_id, 'MEMBER', 'ATTENDANCE', 'Monthly Attendance & Academic Report', 'Your ward has maintained above 90% attendance this semester. View the detailed attendance log.', '/me/attendance');
  }

  console.log(`Prepared ${notificationsToInsert.length} in-app notification records.`);

  // Batch insert in chunks of 500
  for (let i = 0; i < notificationsToInsert.length; i += 500) {
    const chunk = notificationsToInsert.slice(i, i + 500);
    await conn.query(`
      INSERT INTO campusone.notifications
        (created_on, public_id, institution_id, account_id, surface, category, title_key, params, body, link, read_at, created_at)
      VALUES ?
    `, [chunk]);
  }
  console.log(`✅ Successfully seeded ${notificationsToInsert.length} in-app notifications for all roles!`);

  // =========================================================================
  // 4. Verification
  // =========================================================================
  const [calStats]: any = await conn.query(`
    SELECT type, COUNT(*) as count FROM campusone_cug.calendar_entries WHERE institution_id = ? GROUP BY type
  `, [instId]);
  console.log('\n=================== CALENDAR ENTRIES BY TYPE ===================');
  console.table(calStats);

  const [annStats]: any = await conn.query(`
    SELECT COUNT(*) as announcements, SUM(recipients) as total_recipients FROM campusone_cug.announcements WHERE institution_id = ?
  `, [instId]);
  console.log('Announcements summary:', annStats[0]);

  const [notifStats]: any = await conn.query(`
    SELECT surface, category, COUNT(*) as count FROM campusone.notifications WHERE institution_id = ? GROUP BY surface, category
  `, [instId]);
  console.log('\n=================== IN-APP NOTIFICATIONS SUMMARY ===================');
  console.table(notifStats);

  await conn.end();
}

main().catch(console.error);
