/**
 * Several corporate codes per school, mapped to classes (client 2026-10-13/14; INS-043…048, WAL-003,
 * BNK-002/003; migration 0073), on a real MySQL:
 * - the school's existing code (set by the bank arrangement) is its default; every wallet's VAN is
 *   the default code + the wallet number until its class is mapped;
 * - a code mapped to a class gives that class's students its code (bank name and IFSC shown); staff
 *   keep the default; a class moves when mapped to another code; a disabled code's class falls back;
 * - the bank is matched on the wallet number and accepts only the code the VAN uses now;
 * - rules: one default (can't be disabled), codes unique, up to 10 characters, classes of the school,
 *   If-Match; the back office manages any school's codes; the default follows into the institution.
 */
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture, type Auth, type Payer } from './school';

type Fixture = Awaited<ReturnType<typeof schoolFixture>>;
type CodeView = {
  id: string;
  corporateCode: string;
  bankName: string | null;
  ifsc: string | null;
  isDefault: boolean;
  status: string;
  classes: { id: string; name: string }[];
  version: number;
};

describe.skipIf(!adminUrl)('corporate codes mapped to classes on real MySQL', () => {
  let f: Fixture;
  let con: Auth;
  let student: Payer;
  let staff: Payer;
  let grade6 = '';
  let schoolId = '';
  let defaultCode = '';
  let bank: { clientId: string; secret: string };
  const tag = String(randomInt(100, 999));
  const AXIS = `AX${tag}`;
  const SBI = `SB${tag}`;

  const post = (path: string, auth: Auth, body: object) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const patch = (path: string, auth: Auth, version: number, body: object) =>
    request(f.app).patch(`/api/v1${path}`).set(auth).set('If-Match', `"v${version}"`).send(body);
  const get = (path: string, auth: Auth) => request(f.app).get(`/api/v1${path}`).set(auth);
  const codes = async () => (await get('/console/corporate-codes', con)).body;
  /** The member's campus wallet and its VAN details (WAL-003). */
  const vanOf = async (p: Payer) => {
    const list = await get('/me/wallets', p.auth);
    const w = list.body.wallets.find((x: { kind: string }) => x.kind === 'CAMPUS');
    const va = await get(`/me/wallets/${w.id}/virtual-account`, p.auth);
    return { walletNo: w.walletNo as string, listed: w.virtualAccount as string, ...va.body };
  };
  const bankToken = async () =>
    (
      await request(f.app).post('/api/v1/partners/axis/bank/token').send({
        grant_type: 'client_credentials',
        client_id: bank.clientId,
        client_secret: bank.secret,
        scope: 'transaction_validation transaction_notification_posting',
      })
    ).body.access_token as string;
  const validate = async (van: string) =>
    (
      await request(f.app)
        .post('/api/v1/partners/axis/bank/transaction/validate')
        .set('Authorization', `Bearer ${await bankToken()}`)
        .send({
          UTR: `UTR${randomInt(0, 1e9)}`,
          Bene_acc_no: van,
          Req_type: 'Validation',
          Req_date: '2026-10-14',
          Txn_amnt: '500.00',
          Tran_id: `T${randomInt(0, 1e9)}`,
        })
    ).body;

  beforeAll(async () => {
    f = await schoolFixture('Codes School');
    con = f.school.con;
    schoolId = f.school.id;
    staff = await f.payer('Ravi', 0);
    student = await f.student('Asha');
    const classes = (await get('/console/classes', con)).body.items as {
      id: string;
      name: string;
    }[];
    grade6 = classes.find((c) => c.name === 'Grade 6')!.id;
    const created = await post('/ops/api-clients', f.ops, {
      name: 'Axis Bank Power E-coll',
      partner: 'SPONSOR_BANK',
      scopes: ['va.validate', 'va.notify'],
      ipAllowlist: ['127.0.0.1', '::1'],
    });
    bank = created.body;
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('starts with the school’s existing code as its default, for every wallet', async () => {
    const list = await codes();
    expect(list.maxLength).toBe(10);
    expect(list.items).toHaveLength(1);
    const d = list.items[0] as CodeView;
    defaultCode = d.corporateCode;
    expect(d).toMatchObject({ isDefault: true, status: 'ACTIVE', bankName: null, classes: [] });
    expect(list.classes.find((c: { id: string }) => c.id === grade6).codeId).toBeNull();
    const s = await vanOf(student);
    expect(s.vaNumber).toBe(`${defaultCode}${s.walletNo}`);
    expect(s.listed).toBe(s.vaNumber);
    // Bank name and IFSC not filled in yet: the platform's values.
    expect(s.example).toBe(true);
  });

  it('gives a mapped class its code (bank and IFSC), keeps staff on the default', async () => {
    const added = await post('/console/corporate-codes', con, {
      bankName: 'Axis Bank',
      ifsc: 'utib0cch274',
      corporateCode: AXIS.toLowerCase(),
      poolAccountRef: 'AXISPOOL01',
      classIds: [grade6],
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({
      corporateCode: AXIS,
      ifsc: 'UTIB0CCH274',
      isDefault: false,
      classes: [{ id: grade6, name: 'Grade 6' }],
    });
    const s = await vanOf(student);
    expect(s).toMatchObject({
      vaNumber: `${AXIS}${s.walletNo}`,
      bankName: 'Axis Bank',
      ifsc: 'UTIB0CCH274',
      example: false,
    });
    const t = await vanOf(staff);
    expect(t.vaNumber).toBe(`${defaultCode}${t.walletNo}`);

    // The bank: the class's code is accepted; the default code (the student's earlier VAN) isn't.
    expect(await validate(`${AXIS}${s.walletNo}`)).toEqual({
      Stts_flg: 'S',
      Err_cd: '000',
      message: 'Success',
    });
    expect(await validate(`${defaultCode}${s.walletNo}`)).toMatchObject({
      Stts_flg: 'F',
      Err_cd: '002',
    });
    expect(await validate(`${defaultCode}${t.walletNo}`)).toMatchObject({ Stts_flg: 'S' });
  });

  it('refuses a class already on another code; it moves once taken off', async () => {
    // A class uses one code (client 2026-10-14): Grade 6 is on Axis.
    const taken = await post('/console/corporate-codes', con, {
      bankName: 'State Bank of India',
      ifsc: 'SBIN0001234',
      corporateCode: SBI,
      classIds: [grade6],
    });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'CC.CLASS_TAKEN' });
    expect(taken.body.detail).toBe(
      `Already on the corporate code ${AXIS}: Grade 6. Take them off that code first.`,
    );
    let list = await codes();
    expect(list.items.some((c: CodeView) => c.corporateCode === SBI)).toBe(false);
    // Taken off Axis, then given to SBI.
    let axis = list.items.find((c: CodeView) => c.corporateCode === AXIS) as CodeView;
    const off6 = await patch(`/console/corporate-codes/${axis.id}`, con, axis.version, {
      classIds: [],
    });
    expect(off6.status).toBe(200);
    const sbi = await post('/console/corporate-codes', con, {
      bankName: 'State Bank of India',
      ifsc: 'SBIN0001234',
      corporateCode: SBI,
      classIds: [grade6],
    });
    expect(sbi.status, JSON.stringify(sbi.body)).toBe(201);
    list = await codes();
    axis = list.items.find((c: CodeView) => c.corporateCode === AXIS) as CodeView;
    expect(axis.classes).toEqual([]);
    expect(list.classes.find((c: { id: string }) => c.id === grade6).codeId).toBe(sbi.body.id);
    let s = await vanOf(student);
    expect(s).toMatchObject({ vaNumber: `${SBI}${s.walletNo}`, bankName: 'State Bank of India' });
    expect(await validate(`${AXIS}${s.walletNo}`)).toMatchObject({ Stts_flg: 'F', Err_cd: '002' });

    // Disabled: the class uses the default until the code is enabled again.
    const off = await patch(`/console/corporate-codes/${sbi.body.id}`, con, sbi.body.version, {
      status: 'DISABLED',
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    s = await vanOf(student);
    expect(s.vaNumber).toBe(`${defaultCode}${s.walletNo}`);
    list = await codes();
    const back = list.items.find((c: CodeView) => c.corporateCode === SBI) as CodeView;
    expect(back.classes).toHaveLength(1);
    expect(
      (
        await patch(`/console/corporate-codes/${sbi.body.id}`, con, back.version, {
          status: 'ACTIVE',
        })
      ).status,
    ).toBe(200);
    expect((await vanOf(student)).vaNumber).toBe(`${SBI}${s.walletNo}`);
  });

  it('keeps one default, unique codes and its other rules', async () => {
    let list = await codes();
    const d = list.items.find((c: CodeView) => c.isDefault) as CodeView;
    const axis = list.items.find((c: CodeView) => c.corporateCode === AXIS) as CodeView;
    expect(
      (await patch(`/console/corporate-codes/${d.id}`, con, d.version, { status: 'DISABLED' })).body
        .code,
    ).toBe('CC.DEFAULT_DISABLED');
    expect(
      (
        await patch(`/console/corporate-codes/${axis.id}`, con, axis.version + 7, {
          bankName: 'Axis Bank Ltd',
        })
      ).status,
    ).toBe(412);
    expect(
      (
        await post('/console/corporate-codes', con, {
          bankName: 'Axis Bank',
          corporateCode: AXIS,
        })
      ).body.code,
    ).toBe('INS.CORPORATE_CODE_TAKEN');
    // More than 10 characters.
    const long = await post('/console/corporate-codes', con, {
      bankName: 'Axis Bank',
      corporateCode: 'TOOLONGCODE',
    });
    expect(long.status).toBe(422);
    expect(long.body.errors.map((e: { field: string }) => e.field)).toEqual(['corporateCode']);
    const bad = await post('/console/corporate-codes', con, {
      bankName: 'B',
      corporateCode: 'AB-1',
      ifsc: 'NOTANIFSC',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'bankName',
      'corporateCode',
      'ifsc',
    ]);
    // A class of another school (or none at all).
    expect(
      (
        await post('/console/corporate-codes', con, {
          bankName: 'Canara Bank',
          corporateCode: `CN${tag}`,
          classIds: [randomUUID()],
        })
      ).body.errors[0].code,
    ).toBe('CC.CLASS_UNKNOWN');

    // Axis becomes the default: the institution's own code follows; staff move to Axis.
    const made = await patch(`/console/corporate-codes/${axis.id}`, con, axis.version, {
      isDefault: true,
    });
    expect(made.body.isDefault).toBe(true);
    list = await codes();
    expect(list.items.filter((c: CodeView) => c.isDefault)).toHaveLength(1);
    const inst = await get(`/ops/institutions/${schoolId}`, f.ops);
    expect(inst.body.corporateCode).toBe(AXIS);
    const t = await vanOf(staff);
    expect(t.vaNumber).toBe(`${AXIS}${t.walletNo}`);
  });

  it('lets the back office manage a school’s codes; the console needs the task', async () => {
    const list = await get(`/ops/institutions/${schoolId}/corporate-codes`, f.ops);
    expect(list.status).toBe(200);
    expect(list.body.items.map((c: CodeView) => c.corporateCode)).toEqual(
      expect.arrayContaining([AXIS, SBI, defaultCode]),
    );
    const added = await post(`/ops/institutions/${schoolId}/corporate-codes`, f.ops, {
      bankName: 'HDFC Bank',
      corporateCode: `HD${tag}`,
    });
    expect(added.status).toBe(201);
    // A member's session can't reach the console's codes.
    expect((await get('/console/corporate-codes', student.auth)).status).toBeGreaterThanOrEqual(
      401,
    );
  });
});
