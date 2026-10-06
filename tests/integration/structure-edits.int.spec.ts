/**
 * Editing the academic structure on a real MySQL (Phase 9.1 coverage; SRS 20.2–20.4; ACA-004…014):
 * - a class is renamed, reordered and its sections kept, added or removed with If-Match; a name in use
 *   and a stale version are refused; a section with students can't be removed;
 * - a section is renamed with its capacity; a subject's name and colour change (its code doesn't);
 * - the class sheet is previewed row by row, then committed: new classes created, new sections added
 *   to an existing class, bad rows reported.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { schoolFixture } from './school';

describe.skipIf(!adminUrl)('editing the academic structure on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  const send = (method: 'post' | 'patch', path: string, body: object = {}, ver?: number) => {
    let r = request(f.app)
      [method](`/api/v1/console${path}`)
      .set(con)
      .set('Idempotency-Key', randomUUID());
    if (ver !== undefined) r = r.set('If-Match', `"v${ver}"`);
    return r.send(body);
  };
  const get = (path: string) => request(f.app).get(`/api/v1/console${path}`).set(con);
  type Klass = {
    id: string;
    name: string;
    version: number;
    sections: { id: string; name: string; capacity: number | null }[];
  };
  const classNamed = async (name: string) =>
    ((await get('/classes')).body.items as Klass[]).find((c) => c.name === name)!;

  beforeAll(async () => {
    f = await schoolFixture('Structure Edits School');
    con = f.school.con;
    await f.student('Asha'); // enrolled in Grade 6 A
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('edits a class and its sections with If-Match', async () => {
    const made = await send('post', '/classes', {
      name: 'Grade 8',
      sections: [{ name: 'A' }, { name: 'B' }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const g8 = made.body as Klass;
    const a = g8.sections.find((s) => s.name === 'A')!;
    const edited = await send(
      'patch',
      `/classes/${g8.id}`,
      {
        name: 'Grade 8 (new)',
        order: 8,
        sections: [
          { id: a.id, name: 'A' },
          { name: 'C', capacity: 40 },
        ],
      },
      g8.version,
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const after = await classNamed('Grade 8 (new)');
    expect(after.sections.map((s) => s.name).sort()).toEqual(['A', 'C']);
    // A stale version, a name in use and an unknown class are refused.
    expect(
      (
        await send(
          'patch',
          `/classes/${g8.id}`,
          { name: 'Grade 8', order: 8, sections: [] },
          g8.version,
        )
      ).status,
    ).toBe(412);
    expect(
      (
        await send(
          'patch',
          `/classes/${after.id}`,
          {
            name: 'Grade 6',
            order: 8,
            sections: after.sections.map((s) => ({ id: s.id, name: s.name })),
          },
          after.version,
        )
      ).body.code,
    ).toBe('ACA.CLASS_NAME_TAKEN');
    expect(
      (await send('patch', `/classes/${randomUUID()}`, { name: 'X1', order: 1, sections: [] }, 1))
        .status,
    ).toBe(404);
    // Grade 6 A has a student this year: it can't be dropped.
    const g6 = await classNamed('Grade 6');
    const drop = await send(
      'patch',
      `/classes/${g6.id}`,
      { name: 'Grade 6', order: 6, sections: [] },
      g6.version,
    );
    expect(drop.body.code, JSON.stringify(drop.body)).toBe('ACA.SECTION_IN_USE');
    // Sections can't share a name.
    expect(
      (
        await send(
          'patch',
          `/classes/${after.id}`,
          { name: 'Grade 8 (new)', order: 8, sections: [{ name: 'D' }, { name: 'd' }] },
          after.version,
        )
      ).body.errors[0].code,
    ).toBe('ACA.SECTION_NAMES');
  });

  it('renames a section with its capacity', async () => {
    const g8 = await classNamed('Grade 8 (new)');
    const c = g8.sections.find((s) => s.name === 'C')!;
    const r = await send('patch', `/sections/${c.id}`, { name: 'E', capacity: 35 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const again = await classNamed('Grade 8 (new)');
    expect(again.sections.find((s) => s.id === c.id)).toMatchObject({ name: 'E', capacity: 35 });
    expect((await send('patch', `/sections/${c.id}`, { name: 'A' })).body.errors[0].code).toBe(
      'ACA.SECTION_NAMES',
    );
    expect((await send('patch', `/sections/${randomUUID()}`, { name: 'Z' })).status).toBe(404);
  });

  it('edits a subject’s name and colour, never its code', async () => {
    const s = await send('post', '/subjects', {
      code: 'EVS',
      name: 'Environment',
      colour: '#2a9d8f',
    });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    await send('post', '/subjects', { code: 'KAN', name: 'Kannada' });
    const r = await send(
      'patch',
      `/subjects/${s.body.id}`,
      { name: 'Environmental studies', colour: '#264653' },
      s.body.version,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ code: 'EVS', name: 'Environmental studies', colour: '#264653' });
    expect(
      (await send('patch', `/subjects/${s.body.id}`, { name: 'Kannada' }, r.body.version)).body
        .code,
    ).toBe('ACA.SUBJECT_NAME_TAKEN');
    expect(
      (await send('patch', `/subjects/${s.body.id}`, { name: 'X' }, r.body.version)).body.errors[0]
        .code,
    ).toBe('ACA.SUBJECT_NAME');
    expect((await send('patch', `/subjects/${s.body.id}`, { name: 'Science' }, 1)).status).toBe(
      412,
    );
    expect((await send('patch', `/subjects/${randomUUID()}`, { name: 'Science' }, 1)).status).toBe(
      404,
    );
  });

  it('previews the class sheet row by row, then commits the good rows', async () => {
    const sheet = [
      'class_name,sections,order',
      'Grade 9,"A, B",9',
      'Grade 6,"A, F",',
      'Grade 10,"A, A",10',
      'Grade 9,C,9',
      'X,A,',
      'Grade 11,"A",120',
    ].join('\r\n');
    const upload = (commit: boolean) =>
      request(f.app)
        .post('/api/v1/console/classes/uploads')
        .set(con)
        .set('Idempotency-Key', randomUUID())
        .field('commit', String(commit))
        .attach('file', Buffer.from(sheet, 'utf8'), {
          filename: 'classes.csv',
          contentType: 'text/csv',
        });
    const preview = await upload(false);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const codes = (preview.body.rows as { row: number; code: string | null }[]).map((r) => [
      r.row,
      r.code,
    ]);
    expect(codes).toEqual([
      [1, null],
      [2, null],
      [3, 'ACA.SECTION_NAMES'],
      [4, 'ACA.ROW_REPEATED'],
      [5, 'VALIDATION.FORMAT'],
      [6, 'VALIDATION.FORMAT'],
    ]);
    expect(await classNamed('Grade 9')).toBeUndefined();
    const done = await upload(true);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await classNamed('Grade 9')).sections.map((s) => s.name).sort()).toEqual(['A', 'B']);
    expect((await classNamed('Grade 6')).sections.map((s) => s.name)).toContain('F');
    // The same sheet again: nothing new to add.
    const again = await upload(false);
    expect((again.body.rows as { code: string | null }[]).slice(0, 2).map((r) => r.code)).toEqual([
      'ACA.CLASS_NAME_TAKEN',
      'ACA.CLASS_NAME_TAKEN',
    ]);
    const bad = await request(f.app)
      .post('/api/v1/console/classes/uploads')
      .set(con)
      .set('Idempotency-Key', randomUUID())
      .attach('file', Buffer.from('name,sections\r\nGrade 12,A', 'utf8'), {
        filename: 'classes.csv',
        contentType: 'text/csv',
      });
    expect(bad.body.errors[0].code).toBe('UPL.HEADER_MISMATCH');
  });
});
