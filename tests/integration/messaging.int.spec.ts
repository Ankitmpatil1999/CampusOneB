/**
 * Direct messages on a real MySQL (Phase 8.3; SRS 23.9–23.11; COM-016…021; FR-COM-05; BR-71;
 * RNG-COM-088…128; OI-COM-24…33):
 * - contacts follow the role matrix; parents and class teachers reach each other only, and chat is
 *   not for students at all (client 2026-10-23);
 * - one conversation per pair; delivery in the app, logged without the body; opening marks read;
 * - archive for oneself only, undone by sending; another member's conversation answers 404;
 * - at most 30 messages a minute per member, also under concurrent sends; the matrix is a setting.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminUrl } from './db';
import { mobile, schoolFixture, type Auth, type Payer } from './school';
import { binToUuid } from '../../utils/idGenerator';

describe.skipIf(!adminUrl)('direct messages on real MySQL', () => {
  let f: Awaited<ReturnType<typeof schoolFixture>>;
  let con: Record<string, string>;
  let ravi: Payer;
  let meena: Payer;
  let kavya: Payer;
  let asha: Payer;
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
    kavya = await f.payer('Kavya', 0);
    asha = await f.student('Asha');
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

  it('lists contacts by the role matrix; students have no chat (client 2026-10-23)', async () => {
    const ravis = await get('/me/contacts', ravi.auth);
    expect(ravis.status, JSON.stringify(ravis.body)).toBe(200);
    expect(ravis.body).toMatchObject({ role: 'TEACHER', perMinute: 30, maxChars: 4000 });
    expect(ravis.body.notAllowed).toContain('STUDENT');
    const groups = ravis.body.groups as { group: string; items: { name: string }[] }[];
    expect(groups.map((g) => g.group)).not.toContain('STUDENT');
    expect(
      groups
        .find((g) => g.group === 'TEACHER')!
        .items.map((x) => x.name)
        .sort(),
    ).toEqual(['Kavya', 'Meena']);
    // A student neither lists contacts nor is one.
    const ashas = await get('/me/contacts', asha.auth);
    expect(ashas.status).toBe(403);
    expect(ashas.body.code).toBe('COM.DM_STUDENTS');
    const toAsha = await post('/me/conversations', ravi.auth, {
      recipientProfileId: asha.id,
      text: 'Hello',
    });
    expect(toAsha.status).toBe(403);
    expect(toAsha.body.code).toBe('COM.DM_STUDENTS');
    const fromAsha = await post('/me/conversations', asha.auth, {
      recipientProfileId: ravi.id,
      text: 'Hello sir',
    });
    expect(fromAsha.body.code).toBe('COM.DM_STUDENTS');
    expect((await get('/me/conversations', asha.auth)).body.code).toBe('COM.DM_STUDENTS');
  });

  it('starts one conversation per pair, delivers in the app and logs without the body', async () => {
    expect(
      (await post('/me/conversations', meena.auth, { recipientProfileId: meena.id, text: 'Hi' }))
        .body.code,
    ).toBe('COM.DM_SELF');
    expect(
      (await post('/me/conversations', ravi.auth, { recipientProfileId: meena.id, text: '   ' }))
        .body,
    ).toMatchObject({
      code: 'COM.DM_BODY',
      params: { max: 4000 },
    });
    const first = await post('/me/conversations', ravi.auth, {
      recipientProfileId: meena.id,
      text: 'Please bring the project files tomorrow.',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.message).toMatchObject({ mine: true, status: 'DELIVERED', readAt: null });
    conversationId = first.body.conversationId;
    const reply = await post('/me/conversations', meena.auth, {
      recipientProfileId: ravi.id,
      text: 'Yes, I will.',
    });
    expect(reply.body.conversationId).toBe(conversationId);
    expect(JSON.stringify((await get('/me/notifications', meena.auth)).body)).toContain(
      'Message from Ravi',
    );
    const logged = await f.t.db
      .selectFrom('comm_log')
      .selectAll()
      .where('ref_id', '=', conversationId)
      .execute();
    expect(logged).toHaveLength(2);
    expect(logged.every((r) => r.kind === 'DIRECT_MESSAGE' && r.outcome === 'SUCCESS')).toBe(true);
    expect(JSON.stringify(logged)).not.toContain('project files');
  });

  it('marks the other side read on opening; archive is per member; strangers get 404', async () => {
    const list = await get('/me/conversations', meena.auth);
    expect(list.body.counts).toEqual({ active: 1, archived: 0, unreadConversations: 1 });
    expect(list.body.items[0]).toMatchObject({
      conversationId,
      with: { name: 'Ravi', group: 'TEACHER' },
      lastMessage: { text: 'Yes, I will.', mine: true },
      unread: 1,
      canSend: true,
    });
    const thread = await get(`/me/conversations/${conversationId}/messages`, meena.auth);
    expect(thread.body.conversation).toMatchObject({
      with: { name: 'Ravi' },
      archived: false,
      canSend: true,
    });
    expect(thread.body.items.map((m: { text: string; mine: boolean }) => [m.text, m.mine])).toEqual(
      [
        ['Please bring the project files tomorrow.', false],
        ['Yes, I will.', true],
      ],
    );
    const ravisView = await get(`/me/conversations/${conversationId}/messages`, ravi.auth);
    expect(ravisView.body.conversation.with).toMatchObject({ name: 'Meena' });
    expect(ravisView.body.items[0]).toMatchObject({
      mine: true,
      status: 'READ',
      readAt: expect.any(String),
    });
    expect((await get('/me/conversations', meena.auth)).body.counts.unreadConversations).toBe(0);

    const arch = await post(`/me/conversations/${conversationId}/archive`, ravi.auth, {
      archived: true,
    });
    expect(arch.status, JSON.stringify(arch.body)).toBe(204);
    expect((await get('/me/conversations', ravi.auth)).body.counts).toMatchObject({
      active: 0,
      archived: 1,
    });
    expect((await get('/me/conversations?archived=true', ravi.auth)).body.items).toHaveLength(1);
    expect((await get('/me/conversations', meena.auth)).body.counts.active).toBe(1);
    const again = await post(`/me/conversations/${conversationId}/messages`, ravi.auth, {
      text: 'Also the colour pencils.',
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await get('/me/conversations', ravi.auth)).body.counts.active).toBe(1);

    const stranger = await get(`/me/conversations/${conversationId}/messages`, kavya.auth);
    expect(stranger.status).toBe(404);
    expect(stranger.body.code).toBe('COM.CONVERSATION_NOT_FOUND');
    expect(
      (await post(`/me/conversations/${conversationId}/messages`, kavya.auth, { text: 'Hi' }))
        .status,
    ).toBe(404);
  });

  it('allows 30 messages a minute per member, also when sent at once', async () => {
    const sends = await Promise.all(
      Array.from({ length: 34 }, (_, i) =>
        post('/me/conversations', kavya.auth, {
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
    // Chat is not for students (client 2026-10-23): no student is listed to write to.
    const students = await get('/me/contacts?group=STUDENT', ravi.auth);
    expect(students.status, JSON.stringify(students.body)).toBe(200);
    expect(students.body.groups).toEqual([]);
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
    // Teachers no longer with teachers (31 less TEACHER's 4).
    await setting('com.dm.allow.teacher', 27);
    const list = await get('/me/conversations', meena.auth);
    expect(list.body.items[0].canSend).toBe(false);
    const refused = await post(`/me/conversations/${conversationId}/messages`, meena.auth, {
      text: 'Can I bring them on Monday?',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('COM.DM_NOT_PERMITTED');
    await setting('com.dm.allow.teacher', 31);
  });

  it('keeps parents to their child’s class teacher, both ways (client 2026-10-23)', async () => {
    // A parent who signs in, with a child in Grade 6 A, whose class teacher is Ravi.
    const mob = mobile();
    const tokens = await f.signUp(mob, 'Gita');
    const child = await f.profileRow(await f.ward('Kiran', mob));
    const parentRow = String(
      (
        await f.t.db
          .selectFrom('guardianships')
          .select('guardian_profile_id')
          .where('ward_profile_id', '=', String(child.id))
          .executeTakeFirstOrThrow()
      ).guardian_profile_id,
    );
    const parentId = binToUuid(
      (
        await f.t.db
          .selectFrom('member_profiles')
          .select('public_id')
          .where('id', '=', parentRow)
          .executeTakeFirstOrThrow()
      ).public_id,
    );
    const parent = await f.onProfile(tokens, parentId);
    type Group = { group: string; items: { profileId: string; relation: string[] }[] };

    // The parent's contacts: teachers only, and of them the class teacher only.
    const mine = await get('/me/contacts', parent);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.allowed).toEqual(['TEACHER']);
    const teachers = (mine.body.groups as Group[]).find((g) => g.group === 'TEACHER')!;
    expect(teachers.items.map((x) => x.profileId)).toEqual([ravi.id]);
    expect(teachers.items[0]!.relation).toEqual(['Class teacher']);
    // Another teacher: refused; the class teacher: a conversation.
    const toMeena = await post('/me/conversations', parent, {
      recipientProfileId: meena.id,
      text: 'Hello',
    });
    expect(toMeena.status).toBe(403);
    expect(toMeena.body.code).toBe('COM.DM_PARENT_CLASS_TEACHER');
    const toRavi = await post('/me/conversations', parent, {
      recipientProfileId: ravi.id,
      text: 'Kiran will be late tomorrow.',
    });
    expect(toRavi.status, JSON.stringify(toRavi.body)).toBe(201);

    // The class teacher has the parent among contacts; another teacher neither has nor reaches them.
    const parentsOf = async (auth: Auth) =>
      ((await get('/me/contacts', auth)).body.groups as Group[])
        .find((g) => g.group === 'PARENT')
        ?.items.map((x) => x.profileId) ?? [];
    expect(await parentsOf(ravi.auth)).toContain(parentId);
    expect(await parentsOf(meena.auth)).not.toContain(parentId);
    const fromMeena = await post('/me/conversations', meena.auth, {
      recipientProfileId: parentId,
      text: 'Hello',
    });
    expect(fromMeena.body.code).toBe('COM.DM_PARENT_CLASS_TEACHER');

    // No longer the class teacher: the conversation stays, but nobody writes in it any more.
    await f.t.db
      .updateTable('teacher_assignments')
      .set({ ended_at: new Date() })
      .where('teacher_profile_id', '=', ravi.rowId)
      .where('kind', '=', 'CLASS_TEACHER')
      .execute();
    const list = await get('/me/conversations', parent);
    const conv = (list.body.items as { conversationId: string; canSend: boolean }[]).find(
      (x) => x.conversationId === toRavi.body.conversationId,
    )!;
    expect(conv.canSend).toBe(false);
    const reply = await post(`/me/conversations/${toRavi.body.conversationId}/messages`, parent, {
      text: 'Thank you',
    });
    expect(reply.body.code).toBe('COM.DM_PARENT_CLASS_TEACHER');
    await f.t.db
      .updateTable('teacher_assignments')
      .set({ ended_at: null })
      .where('teacher_profile_id', '=', ravi.rowId)
      .where('kind', '=', 'CLASS_TEACHER')
      .execute();
  });
});
