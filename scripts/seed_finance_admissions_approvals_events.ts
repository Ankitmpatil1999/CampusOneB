import mysql from 'mysql2/promise';
import crypto from 'crypto';

function uuidToBin(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function randomUuid(): string {
  return crypto.randomUUID();
}

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  console.log('--- STARTING COMPREHENSIVE SEEDING FOR PBCOE (INSTITUTION 6) ---');

  const instId = 6;
  const yearId = 6;
  const accountantProfileId = 1111; // Shailesh Wankhede

  // =========================================================================
  // 1. FEE RECORD HEADS & FEE COLLECTIONS (/console/feecollection)
  // =========================================================================
  console.log('\n--- 1. SEEDING FEE HEADS & COLLECTIONS ---');
  
  const [feeRecords]: any = await conn.query(`
    SELECT fr.id, fr.student_profile_id, fr.instalment_seq, fr.amount_paise, fr.status,
           mp.first_name, mp.last_name
    FROM campusone_cug.fee_records fr
    JOIN campusone_cug.member_profiles mp ON mp.id = fr.student_profile_id
    WHERE fr.institution_id = ? AND fr.year_id = ?
    ORDER BY fr.student_profile_id, fr.instalment_seq
  `, [instId, yearId]);

  console.log(`Found ${feeRecords.length} fee records across students.`);

  const recordIds = feeRecords.map((r: any) => r.id);
  if (recordIds.length > 0) {
    await conn.query(`DELETE FROM campusone_cug.fee_record_heads WHERE record_id IN (?)`, [recordIds]);
    await conn.query(`DELETE FROM campusone_cug.fee_collections WHERE record_id IN (?)`, [recordIds]);
  }

  const inst1Heads = [
    { headId: 8, name: 'Tuition Fee', amount: 3500000 },
    { headId: 9, name: 'Development Fee', amount: 1000000 },
    { headId: 10, name: 'University & Exam Fee', amount: 500000 },
    { headId: 12, name: 'Lab & Workshop Fee', amount: 500000 },
    { headId: 13, name: 'Library & Digital Fee', amount: 300000 },
    { headId: 14, name: 'Sports & Gymkhana Fee', amount: 200000 },
  ];

  const inst2Heads = [
    { headId: 8, name: 'Tuition Fee', amount: 2000000 },
    { headId: 9, name: 'Development Fee', amount: 500000 },
    { headId: 10, name: 'University & Exam Fee', amount: 300000 },
    { headId: 12, name: 'Lab & Workshop Fee', amount: 400000 },
    { headId: 13, name: 'Library & Digital Fee', amount: 200000 },
    { headId: 14, name: 'Sports & Gymkhana Fee', amount: 100000 },
  ];

  const inst3Heads = [
    { headId: 8, name: 'Tuition Fee', amount: 1000000 },
    { headId: 9, name: 'Development Fee', amount: 400000 },
    { headId: 10, name: 'University & Exam Fee', amount: 300000 },
    { headId: 12, name: 'Lab & Workshop Fee', amount: 200000 },
    { headId: 13, name: 'Library & Digital Fee', amount: 100000 },
  ];

  let recordHeadInserts: any[] = [];
  let collectionInserts: any[] = [];
  let receiptIndex = 1;

  for (const r of feeRecords) {
    let heads = inst1Heads;
    if (r.instalment_seq === 2) heads = inst2Heads;
    if (r.instalment_seq === 3) heads = inst3Heads;

    for (const h of heads) {
      recordHeadInserts.push([r.id, h.headId, h.name, h.amount]);
    }

    if (r.instalment_seq === 1) {
      const receiptNo = `REC-PBCOE-26-${String(receiptIndex++).padStart(4, '0')}`;
      const mode = (receiptIndex % 3 === 0) ? 'CASH' : (receiptIndex % 7 === 0 ? 'WALLET' : 'ONLINE');
      const paidDate = new Date(2026, 6, 10 + (receiptIndex % 20), 10, 30, 0); // July 2026
      
      collectionInserts.push([
        uuidToBin(randomUuid()),
        instId,
        r.id,
        r.amount_paise,
        0, // fine_paise
        'CONSOLE',
        mode,
        receiptNo,
        `${r.first_name} ${r.last_name}`,
        null, // collected_by
        'COLLECTED',
        paidDate
      ]);

      await conn.query(`
        UPDATE campusone_cug.fee_records
        SET status = 'PAID', paid_paise = amount_paise, paid_at = ?, paid_reference = ?
        WHERE id = ?
      `, [paidDate, receiptNo, r.id]);
    }
    else if (r.instalment_seq === 2 && receiptIndex <= 58) {
      const receiptNo = `REC-PBCOE-26-${String(receiptIndex++).padStart(4, '0')}`;
      const mode = (receiptIndex % 2 === 0) ? 'ONLINE' : 'CASH';
      const paidDate = new Date(2026, 9, 12 + (receiptIndex % 15), 11, 45, 0); // October 2026
      
      collectionInserts.push([
        uuidToBin(randomUuid()),
        instId,
        r.id,
        r.amount_paise,
        0,
        'CONSOLE',
        mode,
        receiptNo,
        `${r.first_name} ${r.last_name}`,
        null,
        'COLLECTED',
        paidDate
      ]);

      await conn.query(`
        UPDATE campusone_cug.fee_records
        SET status = 'PAID', paid_paise = amount_paise, paid_at = ?, paid_reference = ?
        WHERE id = ?
      `, [paidDate, receiptNo, r.id]);
    }
  }

  if (recordHeadInserts.length > 0) {
    const chunkSize = 200;
    for (let i = 0; i < recordHeadInserts.length; i += chunkSize) {
      const chunk = recordHeadInserts.slice(i, i + chunkSize);
      await conn.query(`
        INSERT INTO campusone_cug.fee_record_heads (record_id, head_id, name, amount_paise)
        VALUES ?
      `, [chunk]);
    }
    console.log(`Seeded ${recordHeadInserts.length} fee_record_heads.`);
  }

  if (collectionInserts.length > 0) {
    await conn.query(`
      INSERT INTO campusone_cug.fee_collections
        (public_id, institution_id, record_id, amount_paise, fine_paise, source, mode, receipt_no, paid_by, collected_by, status, collected_at)
      VALUES ?
    `, [collectionInserts]);
    console.log(`Seeded ${collectionInserts.length} fee_collections with total receipts: ${receiptIndex - 1}.`);
  }

  // =========================================================================
  // 2. ADMISSIONS: ENTRY FEES & APPLICATIONS (/console/applications & /console/admfees)
  // =========================================================================
  console.log('\n--- 2. SEEDING ADMISSION ENTRY FEES & APPLICATIONS ---');

  await conn.query(`
    INSERT INTO campusone_cug.entry_fees
      (institution_id, year_id, application_fee_paise, application_mandatory, admission_fee_paise, row_version, updated_by, created_at, updated_at)
    VALUES
      (?, ?, 100000, 1, 1500000, 1, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      application_fee_paise = 100000,
      application_mandatory = 1,
      admission_fee_paise = 1500000,
      updated_at = NOW()
  `, [instId, yearId, accountantProfileId]);
  console.log('Configured entry_fees: Application Fee = ₹1,000, Admission Fee = ₹15,000.');

  await conn.query(`DELETE FROM campusone_cug.admission_payments WHERE institution_id = ?`, [instId]);
  await conn.query(`DELETE FROM campusone_cug.admission_applications WHERE institution_id = ?`, [instId]);

  const appDataList = [
    // 5 SUBMITTED (Awaiting review, application fee paid)
    { first: 'Yash', last: 'Deshmukh', gender: 'MALE', classId: 63, status: 'SUBMITTED', mid: 0, appFee: 'PAID', admFee: 'PENDING' },
    { first: 'Pooja', last: 'Tiwari', gender: 'FEMALE', classId: 76, status: 'SUBMITTED', mid: 0, appFee: 'PAID', admFee: 'PENDING' },
    { first: 'Aniket', last: 'Sharma', gender: 'MALE', classId: 80, status: 'SUBMITTED', mid: 1, appFee: 'PAID', admFee: 'PENDING' },
    { first: 'Ritu', last: 'Verma', gender: 'FEMALE', classId: 72, status: 'SUBMITTED', mid: 0, appFee: 'PAID', admFee: 'PENDING' },
    { first: 'Swapnil', last: 'Patil', gender: 'MALE', classId: 63, status: 'SUBMITTED', mid: 1, appFee: 'PAID', admFee: 'PENDING' },
    
    // 8 APPROVED (Enrolled, both fees paid)
    { first: 'Tanmay', last: 'Joshi', gender: 'MALE', classId: 63, status: 'APPROVED', mid: 0, appFee: 'PAID', admFee: 'PAID' },
    { first: 'Sneha', last: 'Raut', gender: 'FEMALE', classId: 76, status: 'APPROVED', mid: 0, appFee: 'PAID', admFee: 'PAID' },
    { first: 'Kunal', last: 'Wagh', gender: 'MALE', classId: 63, status: 'APPROVED', mid: 0, appFee: 'PAID', admFee: 'PAID' },
    { first: 'Priya', last: 'Meshram', gender: 'FEMALE', classId: 72, status: 'APPROVED', mid: 0, appFee: 'PAID', admFee: 'PAID' },
    { first: 'Abhishek', last: 'Kale', gender: 'MALE', classId: 80, status: 'APPROVED', mid: 0, appFee: 'PAID', admFee: 'PAID' },
    { first: 'Shruti', last: 'Bawankar', gender: 'FEMALE', classId: 63, status: 'APPROVED', mid: 0, appFee: 'PAID', admFee: 'PAID' },
    { first: 'Mayur', last: 'Gawande', gender: 'MALE', classId: 84, status: 'APPROVED', mid: 0, appFee: 'PAID', admFee: 'PAID' },
    { first: 'Neha', last: 'Choudhary', gender: 'FEMALE', classId: 92, status: 'APPROVED', mid: 0, appFee: 'PAID', admFee: 'PAID' },

    // 2 DRAFT
    { first: 'Rahul', last: 'Jain', gender: 'MALE', classId: 63, status: 'DRAFT', mid: 0, appFee: 'PENDING', admFee: 'PENDING' },
    { first: 'Sakshi', last: 'Bhave', gender: 'FEMALE', classId: 76, status: 'DRAFT', mid: 0, appFee: 'PENDING', admFee: 'PENDING' },

    // 1 REJECTED
    { first: 'Omkar', last: 'Birajdar', gender: 'MALE', classId: 80, status: 'REJECTED', mid: 0, appFee: 'PAID', admFee: 'PENDING' },
  ];

  let appSeq = 1;
  let admReceiptSeq = 1;

  for (const item of appDataList) {
    const appNo = `APP-PBCOE-2026-${String(appSeq++).padStart(4, '0')}`;
    const dob = '2008-04-15';
    const primaryName = `Mr. Ramesh ${item.last}`;
    const primaryMobile = `98230${String(10000 + appSeq).slice(1)}`;
    const primaryEmail = `${item.first.toLowerCase()}.${item.last.toLowerCase()}@example.com`;
    const submittedAt = item.status !== 'DRAFT' ? '2026-06-25 10:00:00' : null;
    const decidedAt = (item.status === 'APPROVED' || item.status === 'REJECTED') ? '2026-07-02 14:30:00' : null;
    const decidedBy = decidedAt ? accountantProfileId : null;
    const rejectionReason = item.status === 'REJECTED' ? 'CRITERIA_NOT_MET' : null;
    const rejectionRemarks = item.status === 'REJECTED' ? 'Minimum aggregate score of 60% in PCM required' : null;
    const paymentStatus = item.status === 'APPROVED' ? 'CONFIRMED' : (item.appFee === 'PAID' ? 'PAID' : 'PENDING');

    const appData = JSON.stringify({
      address: 'Nagpur, Maharashtra',
      bloodGroup: 'B+',
      category: 'General',
      previousCollege: 'St. Paul Junior College, Nagpur',
      hscScore: '84.6%',
      cetPercentile: '91.45',
    });

    const [insertResult]: any = await conn.query(`
      INSERT INTO campusone_cug.admission_applications
        (public_id, institution_id, application_no, source, status, year_id, class_id, mid_term,
         first_name, last_name, gender, dob, primary_name, primary_relation, primary_mobile, primary_email,
         contact_verified_mobile, contact_verified_at, data, step, declared_at, declared_by,
         submitted_at, decided_at, decided_by, rejection_reason, rejection_remarks, payment_status, created_at, updated_at)
      VALUES
        (UUID_TO_BIN(UUID()), ?, ?, 'PUBLIC', ?, ?, ?, ?,
         ?, ?, ?, ?, ?, 'FATHER', ?, ?,
         1, NOW(), ?, 4, NOW(), ?,
         ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [
      instId, appNo, item.status, yearId, item.classId, item.mid,
      item.first, item.last, item.gender, dob, primaryName, primaryMobile, primaryEmail,
      appData, primaryName,
      submittedAt, decidedAt, decidedBy, rejectionReason, rejectionRemarks, paymentStatus
    ]);

    const applicationId = insertResult.insertId;

    if (item.appFee === 'PAID') {
      const mode = (appSeq % 2 === 0) ? 'ONLINE' : 'CASH';
      const receiptNo = `APP-PBCOE-REC-${String(appSeq).padStart(4, '0')}`;
      await conn.query(`
        INSERT INTO campusone_cug.admission_payments
          (public_id, institution_id, application_id, fee_type, amount_paise, status, mode, receipt_no, paid_by, collected_by, paid_at, confirmed_at, confirmed_by, created_at, updated_at)
        VALUES
          (UUID_TO_BIN(UUID()), ?, ?, 'APPLICATION', 100000, 'PAID', ?, ?, ?, ?, '2026-06-25 10:15:00', '2026-06-25 10:20:00', ?, NOW(), NOW())
      `, [instId, applicationId, mode, receiptNo, primaryName, accountantProfileId, accountantProfileId]);
    }

    if (item.admFee === 'PAID') {
      const mode = (admReceiptSeq % 2 === 0) ? 'ONLINE' : 'CASH';
      const receiptNo = `ADM-PBCOE-REC-${String(admReceiptSeq++).padStart(4, '0')}`;
      await conn.query(`
        INSERT INTO campusone_cug.admission_payments
          (public_id, institution_id, application_id, fee_type, amount_paise, status, mode, receipt_no, paid_by, collected_by, paid_at, confirmed_at, confirmed_by, created_at, updated_at)
        VALUES
          (UUID_TO_BIN(UUID()), ?, ?, 'ADMISSION', 1500000, 'PAID', ?, ?, ?, ?, '2026-07-03 11:30:00', '2026-07-03 11:35:00', ?, NOW(), NOW())
      `, [instId, applicationId, mode, receiptNo, primaryName, accountantProfileId, accountantProfileId]);
    }
  }

  console.log(`Seeded ${appDataList.length} admission applications and related payments.`);

  // =========================================================================
  // 3. APPROVALS MAKER-CHECKER QUEUE (/console/approvals)
  // =========================================================================
  console.log('\n--- 3. SEEDING APPROVAL REQUESTS ---');

  // Find max request_seq for inst 6
  const [maxSeqRes]: any = await conn.query(`SELECT COALESCE(MAX(request_seq), 0) as max_seq FROM campusone.approval_requests WHERE institution_id = ?`, [instId]);
  let currentSeq = maxSeqRes[0].max_seq;

  // Check if we already have approval requests for institution 6
  const [existingApprovals]: any = await conn.query(`SELECT COUNT(*) as count FROM campusone.approval_requests WHERE institution_id = ?`, [instId]);
  
  if (existingApprovals[0].count === 0) {
    const approvalData = [
      {
        module: 'FEE_CONCESSION',
        action: 'UPDATE',
        summary: 'Fee concession request of 25% (₹28,750.00) for Pranav Gaikwad (Merit-cum-Means scholarship recommendation by HOD CSE)',
        subjectType: 'student',
        payload: JSON.stringify({ studentId: 1123, concessionPercent: 25, amountPaise: 2875000, reason: 'Merit-cum-Means Top 5% Rank' }),
        makerType: 'staff',
        status: 'PENDING',
        checkerRef: null,
        remarks: null,
        decidedAt: null
      },
      {
        module: 'FEE_REFUND',
        action: 'CREATE',
        summary: 'Caution money excess refund of ₹5,000.00 to Rohit Sharma (Branch change from Civil to Mechanical Engineering)',
        subjectType: 'fee_record',
        payload: JSON.stringify({ studentId: 1878, refundAmountPaise: 500000, reason: 'Branch change credit adjustment' }),
        makerType: 'staff',
        status: 'PENDING',
        checkerRef: null,
        remarks: null,
        decidedAt: null
      },
      {
        module: 'PII_CORRECTION',
        action: 'UPDATE',
        summary: "Correction of Mother's Name and Aadhaar registration for Sneha Kulkarni (B.Tech AI-DS 1st Year)",
        subjectType: 'student',
        payload: JSON.stringify({ field: 'MOTHER_NAME', old: 'Sunita', new: 'Sunita Devi Kulkarni' }),
        makerType: 'member',
        status: 'PENDING',
        checkerRef: null,
        remarks: null,
        decidedAt: null
      },
      {
        module: 'FEE_STRUCTURE',
        action: 'UPDATE',
        summary: 'Approval of fee structure version 1 for B.Tech Academic Fee 2026-27 (₹1,15,000.00 in 3 instalments)',
        subjectType: 'fee_structure',
        payload: JSON.stringify({ structureId: 5, version: 1, totalPaise: 11500000 }),
        makerType: 'staff',
        status: 'APPROVED',
        checkerRef: uuidToBin(randomUuid()),
        remarks: 'Approved after verification with Governing Body fee committee circular',
        decidedAt: '2026-11-01 10:00:00'
      },
      {
        module: 'FEE_CONCESSION',
        action: 'UPDATE',
        summary: 'Sports quota concession of ₹10,000.00 for Rahul Deshmukh (State level Athletics Gold Medalist)',
        subjectType: 'student',
        payload: JSON.stringify({ studentId: 1125, concessionAmountPaise: 1000000, reason: 'University Sports Representative' }),
        makerType: 'staff',
        status: 'APPROVED',
        checkerRef: uuidToBin(randomUuid()),
        remarks: 'Validated sports certificate verified with DTE Sports Board',
        decidedAt: '2026-11-05 14:20:00'
      },
      {
        module: 'FEE_EXTENSION',
        action: 'UPDATE',
        summary: 'Installment 2 payment deadline extension of 15 days granted for 8 students awaiting scholarship disbursement',
        subjectType: 'fee_record',
        payload: JSON.stringify({ extensionDays: 15, newDueDate: '2026-11-30' }),
        makerType: 'staff',
        status: 'APPROVED',
        checkerRef: uuidToBin(randomUuid()),
        remarks: 'Granted on recommendation of Dean and Social Welfare department receipt',
        decidedAt: '2026-11-10 16:45:00'
      },
      {
        module: 'FEE_WAIVER',
        action: 'UPDATE',
        summary: 'Late fee fine waiver request of ₹500.00 for Aditya Shinde (Incomplete supporting documentation)',
        subjectType: 'fee_record',
        payload: JSON.stringify({ fineAmountPaise: 50000, reason: 'Medical emergency claim' }),
        makerType: 'member',
        status: 'REJECTED',
        checkerRef: uuidToBin(randomUuid()),
        remarks: 'Medical certificate lacked registration number and civil surgeon stamp',
        decidedAt: '2026-11-12 11:15:00'
      }
    ];

    for (const item of approvalData) {
      currentSeq++;
      await conn.query(`
        INSERT INTO campusone.approval_requests
          (public_id, request_seq, institution_id, module, action, summary, subject_type, payload,
           maker_type, maker_ref, status, checker_ref, remarks, decided_at, applied_directly, row_version, created_at, updated_at)
        VALUES
          (UUID_TO_BIN(UUID()), ?, ?, ?, ?, ?, ?, ?,
           ?, UUID_TO_BIN(UUID()), ?, ?, ?, ?, 0, 1, NOW(), NOW())
      `, [
        currentSeq, instId, item.module, item.action, item.summary, item.subjectType, item.payload,
        item.makerType, item.status, item.checkerRef, item.remarks, item.decidedAt
      ]);
    }
    console.log(`Seeded ${approvalData.length} approval requests.`);
  } else {
    console.log(`Already found ${existingApprovals[0].count} approval requests for institution 6.`);
  }

  // =========================================================================
  // 4. EVENTS & PAYMENTS (/console/events & /console/payments)
  // =========================================================================
  console.log('\n--- 4. SEEDING PBCOE MERCHANT, EVENTS & PAYMENTS ---');

  const [existingMerchant]: any = await conn.query(`SELECT profile_id FROM campusone_cug.merchants WHERE institution_id = ?`, [instId]);
  let merchantProfileId: number;

  if (existingMerchant.length > 0) {
    merchantProfileId = existingMerchant[0].profile_id;
  } else {
    const [pRes]: any = await conn.query(`
      INSERT INTO campusone_cug.member_profiles
        (public_id, institution_id, user_type_id, first_name, last_name, status, created_at, updated_at)
      VALUES
        (UUID_TO_BIN(UUID()), ?, 15, 'PBCOE Event Desk', 'Account', 'ACTIVE', NOW(), NOW())
    `, [instId]);
    merchantProfileId = pRes.insertId;

    await conn.query(`
      INSERT INTO campusone_cug.merchants
        (profile_id, institution_id, unique_id, display_name, sub_type, holder_name, bank_name,
         acct_enc, acct_bidx, acct_last4, ifsc, is_fee_account, row_version, created_at, updated_at)
      VALUES
        (?, ?, 'MERPBCOE001', 'PBCOE College Fee & Event Desk', 'REGULAR',
         'PRIYADARSHINI BHAGWATI COLLEGE OF ENGINEERING', 'Axis Bank',
         NULL, NULL, NULL, NULL, 1, 1, NOW(), NOW())
    `, [merchantProfileId, instId]);
    console.log(`Created Merchant profile ${merchantProfileId} for PBCOE.`);
  }

  const [currEvents]: any = await conn.query(`SELECT id FROM campusone_cug.events WHERE institution_id = ?`, [instId]);
  if (currEvents.length > 0) {
    const eIds = currEvents.map((e: any) => e.id);
    await conn.query(`DELETE FROM campusone_cug.event_heads WHERE event_id IN (?)`, [eIds]);
    await conn.query(`DELETE FROM campusone_cug.events WHERE id IN (?)`, [eIds]);
  }
  await conn.query(`DELETE FROM campusone_cug.payment_attempts WHERE institution_id = ? AND channel = 'EVENT'`, [instId]);

  const [studentRows]: any = await conn.query(`
    SELECT DISTINCT fr.student_profile_id
    FROM campusone_cug.fee_records fr
    WHERE fr.institution_id = ?
  `, [instId]);
  const studentIds = studentRows.map((s: any) => s.student_profile_id);

  const eventsData = [
    {
      title: 'Technova 2026 - National Tech Symposium & Hackathon',
      desc: 'National Level Technical Symposium featuring 24-hr Hackathon, Paper Presentation, Robotics Challenge, and Coding Marathon.',
      start: '2026-10-15',
      end: '2026-10-17',
      totalPaise: 50000,
      heads: [
        { name: 'Hackathon Registration Pass', amount: 30000 },
        { name: 'Technical Paper Presentation & Delegate Kit', amount: 20000 }
      ],
      paidCount: 45
    },
    {
      title: 'Tarunya 2027 - Annual Cultural Fest & Celebrity Night',
      desc: 'PBCOE Grand Cultural Festival with Inter-College Music, Dance, Drama competitions, Art exhibitions, and Star Celebrity Musical Night.',
      start: '2027-02-18',
      end: '2027-02-20',
      totalPaise: 60000,
      heads: [
        { name: 'Pro-Night & Celebrity Pass', amount: 40000 },
        { name: 'Cultural Events Entry & Food Voucher', amount: 20000 }
      ],
      paidCount: 38
    },
    {
      title: 'Khel Mahotsav 2026 - Inter-Collegiate Sports Championship',
      desc: 'Annual Cricket, Football, Volleyball, Badminton, and Athletic Championship with trophies and university selection trials.',
      start: '2026-11-20',
      end: '2026-11-23',
      totalPaise: 35000,
      heads: [
        { name: 'Official PBCOE Sports Jersey & Kit', amount: 25000 },
        { name: 'Athletics & Court Events Registration', amount: 10000 }
      ],
      paidCount: 52
    }
  ];

  for (const ed of eventsData) {
    const evUuid = randomUuid();
    const [eRes]: any = await conn.query(`
      INSERT INTO campusone_cug.events
        (public_id, institution_id, title, description, start_date, end_date, total_paise,
         merchant_profile_id, status, row_version, created_at, updated_at)
      VALUES
        (UUID_TO_BIN(?), ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, NOW(), NOW())
    `, [evUuid, instId, ed.title, ed.desc, ed.start, ed.end, ed.totalPaise, merchantProfileId]);

    const eventId = eRes.insertId;

    let sOrder = 1;
    for (const h of ed.heads) {
      await conn.query(`
        INSERT INTO campusone_cug.event_heads
          (event_id, name, amount_paise, sort_order)
        VALUES (?, ?, ?, ?)
      `, [eventId, h.name, h.amount, sOrder++]);
    }

    for (let p = 0; p < ed.paidCount; p++) {
      const payerId = studentIds[p % studentIds.length];
      const ref = `PAY-EVT-${evUuid.slice(0, 8)}-${String(p + 1).padStart(3, '0')}`;
      await conn.query(`
        INSERT INTO campusone_cug.payment_attempts
          (public_id, institution_id, reference, channel, instrument, payer_profile_id, payee_profile_id, amount_paise, status, idempotency_key, attempted_at, event_ref)
        VALUES
          (UUID_TO_BIN(UUID()), ?, ?, 'EVENT', 'WALLET', ?, ?, ?, 'SUCCESS', UUID(), NOW(), ?)
      `, [instId, ref, payerId, merchantProfileId, ed.totalPaise, evUuid]);
    }
    console.log(`Seeded Event: ${ed.title} (Heads: ${ed.heads.length}, Paid Registrations: ${ed.paidCount})`);
  }

  console.log('\n--- ALL FINANCIAL, ADMISSION, APPROVAL & EVENT DATA SEEDED SUCCESSFULLY! ---');
  await conn.end();
}

main().catch(console.error);
