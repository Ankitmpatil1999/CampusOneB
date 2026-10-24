/**
 * Direct messages on a real MySQL (Phase 8.3; SRS 23.9–23.11; COM-016…021; FR-COM-05; BR-71;
 * RNG-COM-088…128; OI-COM-24…33):
 * - contacts follow the role matrix: a teacher's own students, a student's own teachers;
 * - one conversation per pair; delivery in the app, logged without the body; opening marks read;
 * - archive for oneself only, undone by sending; another member's conversation answers 404;
 * - at most 30 messages a minute per member, also under concurrent sends; the matrix is a setting.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { mobile, schoolFixture, type Auth, type Payer } from './school';

describe.skipIf(!adminUrl)('direct messages on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let ravi: Payer;
  let meena: Payer;
  let asha: Payer;
  let bala: Payer;
  let conversationId: string;
  const post = (path: string, auth: Auth, body: object = {}) =>
    request(f.app).post(`/api/v1${path}`).set(auth).set('Idempotency-Key', randomUUID()).send(body);
  const get = (path: string, auth: Auth) => request(f.app).get(`/api/v1${path}`).set(auth);
  const setting = async (key: string, value: number) => {
    const s = (await request(f.app).get('/api/v1/ops/settings').set(f.ops)).body.items.find(
      (x: { key: string }) => x.key === key,
    );
    const r = await request(f.app)
      .put(`/api/v1/ops/settings/${key}`)
      .set(f.ops)
      .set('If-Match', `"v${s.version}"`)
      .send({ value, reason: 'Direct messages test' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };

  beforeAll(async () => {
    f = await schoolFixture('Messaging School');
    con = f.school.con;
    ravi = await f.payer('Ravi', 0);
    meena = await f.payer('Meena', 0);
    asha = await f.student('Asha');
    bala = await f.student('Bala');
    const classes = (await get('/console/classes', con)).body.items as {
      name: string;
      sections: { id: string }[];
    }[];
    const section6A = classes.find((c) => c.name === 'Grade 6')!.sections[0]!.id;
    const t = await post('/console/teacher-assignments', con, {
      kind: 'CLASS_TEACHER',
      teacherId: ravi.id,
      sectionIds: [section6A],
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
  }, 240_000);
  afterAll(async () => {
    await f?.t.drop();
  });

  it('lists contacts by the role matrix and the relationship', async () => {
    const ravis = await get('/me/contacts', ravi.auth);
    expect(ravis.status, JSON.stringify(ravis.body)).toBe(200);
    expect(ravis.body).toMatchObject({ role: 'TEACHER', perMinute: 30, maxChars: 4000 });
    const students = ravis.body.groups.find((g: { group: string }) => g.group === 'STUDENT');
    expect(students.items.map((x: { name: string }) => x.name).sort()).toEqual([
      'Asha Rao',
      'Bala Rao',
    ]);
    expect(students.items[0].sub).toMatch(/^Grade 6 A · ADM\//);
    // Meena teaches no class: no students to start with.
    const meenas = await get('/me/contacts?group=STUDENT', meena.auth);
    expect(meenas.body.groups).toEqual([expect.objectContaining({ group: 'STUDENT', total: 0 })]);
    const ashas = await get('/me/contacts', asha.auth);
    expect(ashas.body.role).toBe('STUDENT');
    expect(ashas.body.notAllowed).toEqual(['STUDENT', 'PARENT']);
    const teachers = ashas.body.groups.find((g: { group: string }) => g.group === 'TEACHER');
    expect(teachers.items).toEqual([
      expect.objectContaining({ name: 'Ravi', relation: ['Class teacher'] }),
    ]);
  });

  it('starts one conversation per pair, delivers in the app and logs without the body', async () => {
    expect(
      (await post('/me/conversations', meena.auth, { recipientProfileId: asha.id, text: 'Hello' }))
        .body.code,
    ).toBe('COM.DM_NOT_A_CONTACT');
    expect(
      (await post('/me/conversations', asha.auth, { recipientProfileId: asha.id, text: 'Hi' })).body
        .code,
    ).toBe('COM.DM_SELF');
    expect(
      (await post('/me/conversations', asha.auth, { recipientProfileId: bala.id, text: 'Hi' })).body
        .code,
    ).toBe('COM.DM_NOT_PERMITTED');
    expect(
      (await post('/me/conversations', ravi.auth, { recipientProfileId: asha.id, text: '   ' }))
        .body,
    ).toMatchObject({
      code: 'COM.DM_BODY',
      params: { max: 4000 },
    });
    const first = await post('/me/conversations', ravi.auth, {
      recipientProfileId: asha.id,
      text: 'Please bring your project file tomorrow.',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.message).toMatchObject({ mine: true, status: 'DELIVERED', readAt: null });
    conversationId = first.body.conversationId;
    const reply = await post('/me/conversations', asha.auth, {
      recipientProfileId: ravi.id,
      text: 'Yes sir, I will.',
    });
    expect(reply.body.conversationId).toBe(conversationId);
    expect(JSON.stringify((await get('/me/notifications', asha.auth)).body)).toContain(
      'Message from Ravi',
    );
    const logged = await f.t.db
      .selectFrom('comm_log')
      .selectAll()
      .where('ref_id', '=', conversationId)
      .execute();
    expect(logged).toHaveLength(2);
    expect(logged.every((r) => r.kind === 'DIRECT_MESSAGE' && r.outcome === 'SUCCESS')).toBe(true);
    expect(JSON.stringify(logged)).not.toContain('project file');
  });

  it('marks the other side read on opening; archive is per member; strangers get 404', async () => {
    const list = await get('/me/conversations', asha.auth);
    expect(list.body.counts).toEqual({ active: 1, archived: 0, unreadConversations: 1 });
    expect(list.body.items[0]).toMatchObject({
      conversationId,
      with: { name: 'Ravi', group: 'TEACHER' },
      lastMessage: { text: 'Yes sir, I will.', mine: true },
      unread: 1,
      canSend: true,
    });
    const thread = await get(`/me/conversations/${conversationId}/messages`, asha.auth);
    expect(thread.body.conversation).toMatchObject({
      with: { name: 'Ravi' },
      archived: false,
      canSend: true,
    });
    expect(thread.body.items.map((m: { text: string; mine: boolean }) => [m.text, m.mine])).toEqual(
      [
        ['Please bring your project file tomorrow.', false],
        ['Yes sir, I will.', true],
      ],
    );
    const ravisView = await get(`/me/conversations/${conversationId}/messages`, ravi.auth);
    expect(ravisView.body.conversation.with).toMatchObject({
      name: 'Asha Rao',
      classSection: 'Grade 6 A',
    });
    expect(ravisView.body.items[0]).toMatchObject({
      mine: true,
      status: 'READ',
      readAt: expect.any(String),
    });
    expect((await get('/me/conversations', asha.auth)).body.counts.unreadConversations).toBe(0);

    const arch = await post(`/me/conversations/${conversationId}/archive`, ravi.auth, {
      archived: true,
    });
    expect(arch.status, JSON.stringify(arch.body)).toBe(204);
    expect((await get('/me/conversations', ravi.auth)).body.counts).toMatchObject({
      active: 0,
      archived: 1,
    });
    expect((await get('/me/conversations?archived=true', ravi.auth)).body.items).toHaveLength(1);
    expect((await get('/me/conversations', asha.auth)).body.counts.active).toBe(1);
    const again = await post(`/me/conversations/${conversationId}/messages`, ravi.auth, {
      text: 'Also the colour pencils.',
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await get('/me/conversations', ravi.auth)).body.counts.active).toBe(1);

    const stranger = await get(`/me/conversations/${conversationId}/messages`, meena.auth);
    expect(stranger.status).toBe(404);
    expect(stranger.body.code).toBe('COM.CONVERSATION_NOT_FOUND');
    expect(
      (await post(`/me/conversations/${conversationId}/messages`, meena.auth, { text: 'Hi' }))
        .status,
    ).toBe(404);
  });

  it('allows 30 messages a minute per member, also when sent at once', async () => {
    const sends = await Promise.all(
      Array.from({ length: 34 }, (_, i) =>
        post('/me/conversations', bala.auth, {
          recipientProfileId: ravi.id,
          text: `Question ${i + 1}`,
        }),
      ),
    );
    const ok = sends.filter((r) => r.status === 201);
    const refused = sends.filter((r) => r.status === 429);
    expect(ok).toHaveLength(30);
    expect(refused).toHaveLength(4);
    expect(refused[0]!.body.code).toBe('COM.DM_RATE_LIMITED');
    expect(new Set(ok.map((r) => r.body.conversationId)).size).toBe(1);
  });

  it("shows the school's staff each parent's children, and finds a parent by a child's name (client 2026-10-23)", async () => {
    // Chitra, in Grade 6 A, onboarded with her father's mobile.
    await f.ward('Chitra', mobile());
    const parents = await get('/me/contacts?group=PARENT&q=Chitra', ravi.auth);
    expect(parents.status, JSON.stringify(parents.body)).toBe(200);
    const father = parents.body.groups[0].items as {
      profileId: string;
      name: string;
      children: object[];
    }[];
    expect(father).toEqual([
      expect.objectContaining({
        name: 'Guardian Rao',
        roleLabel: 'Parent',
        children: [{ name: 'Chitra Rao', classSection: 'Grade 6 A', relation: 'FATHER' }],
      }),
    ]);
    // Students have no children listed.
    const students = await get('/me/contacts?group=STUDENT', ravi.auth);
    expect(students.body.groups[0].items[0].children).toEqual([]);
    // The conversation with him names his child, in the list and when opened.
    const started = await post('/me/conversations', ravi.auth, {
      recipientProfileId: father[0]!.profileId,
      text: 'Chitra did very well in the quiz today.',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const child = { name: 'Chitra Rao', classSection: 'Grade 6 A', relation: 'FATHER' };
    const listed = (await get('/me/conversations', ravi.auth)).body.items.find(
      (c: { conversationId: string }) => c.conversationId === started.body.conversationId,
    );
    expect(listed.with).toMatchObject({ name: 'Guardian Rao', group: 'PARENT', children: [child] });
    const opened = await get(
      `/me/conversations/${started.body.conversationId}/messages`,
      ravi.auth,
    );
    expect(opened.body.conversation.with.children).toEqual([child]);
  });

  it('follows the matrix setting: a role switched off can no longer send', async () => {
    await setting('com.dm.allow.student', 0);
    const list = await get('/me/conversations', asha.auth);
    expect(list.body.items[0].canSend).toBe(false);
    const refused = await post(`/me/conversations/${conversationId}/messages`, asha.auth, {
      text: 'Can I submit it on Monday?',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('COM.DM_NOT_PERMITTED');
    await setting('com.dm.allow.student', 28);
  });
});
