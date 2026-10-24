/**
 * E-mail (client 2026-10-16): the SMTP sender in the RingPe layout, its subjects, its configuration,
 * and the notification events every in-app notice belongs to.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config';
import { COMM_EVENTS, allMessages, commEventOf } from '../config/registers';
import { createEmailSender, smtpSender } from '../integrations/email.provider';
import { emailHtml, subjectFor } from '../utils/email-layout';
import { BASE_ENV, capturingLoggers } from './helpers';

const smtp = {
  host: 'mail.example.in',
  port: 587,
  secure: false,
  user: 'noreply@school.example.in',
  pass: 'secret-pass',
  from: 'noreply@school.example.in',
  fromName: 'RingPe',
  tlsVerify: true,
};

describe('SMTP sender', () => {
  it('sends HTML in the RingPe layout with the text beside it, from the school, and logs no content', async () => {
    const sent: Record<string, unknown>[] = [];
    const { loggers, lines } = capturingLoggers();
    const sender = smtpSender(smtp, loggers, {
      sendMail: async (o: Record<string, unknown>) => {
        sent.push(o);
        return { messageId: '<m1@example>' };
      },
    } as never);
    await sender.send({
      to: 'parent@example.in',
      purpose: 'fee.payLink',
      subject: 'Term 1 fee for Aarav',
      text: 'Pay here: https://ringpe.example.in/fees/pay/x <b>bold</b>',
      fromName: 'Tunga "Valley" Public School',
      replyTo: 'office@tvps.example.in',
    });
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m['from']).toEqual({ name: 'Tunga Valley Public School', address: smtp.from });
    expect(m['to']).toBe('parent@example.in');
    expect(m['replyTo']).toBe('office@tvps.example.in');
    expect(m['subject']).toBe('Term 1 fee for Aarav');
    expect(m['text']).toContain('<b>bold</b>');
    const html = String(m['html']);
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('<a href="https://ringpe.example.in/fees/pay/x"');
    expect(html).toContain('Tunga Valley Public School');
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.stringify(lines)).not.toContain('parent@example.in');
    expect(JSON.stringify(lines)).not.toContain('Aarav');
  });

  it('sends attachments by their names and types (client 2026-10-23: the application form)', async () => {
    const sent: Record<string, unknown>[] = [];
    const sender = smtpSender(smtp, capturingLoggers().loggers, {
      sendMail: async (o: Record<string, unknown>) => {
        sent.push(o);
        return {};
      },
    } as never);
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    await sender.send({
      to: 'parent@example.in',
      purpose: 'admission.submitted',
      text: 'x',
      attachments: [
        { fileName: 'Application-A-1.pdf', content: pdf, contentType: 'application/pdf' },
      ],
    });
    await sender.send({ to: 'parent@example.in', purpose: 'admission.approved', text: 'x' });
    expect(sent[0]!['attachments']).toEqual([
      { filename: 'Application-A-1.pdf', content: pdf, contentType: 'application/pdf' },
    ]);
    expect(sent[1]).not.toHaveProperty('attachments');
  });

  it("takes the subject from the communication log's, else from the purpose", async () => {
    const sent: Record<string, unknown>[] = [];
    const sender = smtpSender(smtp, capturingLoggers().loggers, {
      sendMail: async (o: Record<string, unknown>) => {
        sent.push(o);
        return {};
      },
    } as never);
    await sender.send({
      to: 'a@example.in',
      purpose: 'announcement',
      text: 'x',
      log: { subject: 'Sports day on Friday' },
    });
    await sender.send({ to: 'a@example.in', purpose: 'admission.submitted', text: 'x' });
    expect(sent.map((m) => m['subject'])).toEqual([
      'Sports day on Friday',
      'We have received your admission application',
    ]);
    expect(sent[1]!['from']).toEqual({ name: 'RingPe', address: smtp.from });
  });

  it('gives a subject by purpose when none is given', () => {
    expect(subjectFor('otp.signup')).toBe('Your RingPe one-time code');
    expect(subjectFor('password_reset.console')).toBe('Reset your RingPe password');
    expect(subjectFor('staff.onboarded')).toBe('Welcome to RingPe');
    expect(subjectFor('fee.payLink')).toBe('Your school fee payment link');
    expect(subjectFor('something.new')).toBe('A message from RingPe');
    expect(subjectFor('x', '  Given  ')).toBe('Given');
    expect(emailHtml({ subject: '<s>', text: 'a', sender: 'S' })).toContain('&lt;s&gt;');
  });

  it('needs the account and a sender address, and checks the certificate in production', () => {
    expect(() => loadConfig({ ...BASE_ENV, EMAIL_PROVIDER: 'smtp' })).toThrow(
      /EMAIL_USER: and EMAIL_PASS are required/,
    );
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        EMAIL_PROVIDER: 'smtp',
        EMAIL_USER: 'not-an-address',
        EMAIL_PASS: 'x',
      }),
    ).toThrow(/EMAIL_FROM: must be an e-mail address/);
    const ok = loadConfig({
      ...BASE_ENV,
      EMAIL_PROVIDER: 'smtp',
      EMAIL_USER: 'noreply@school.example.in',
      EMAIL_PASS: 'x',
    });
    expect(ok.notify.smtp).toMatchObject({
      host: 'mail.sabadotechnologies.com',
      port: 587,
      secure: false,
      from: 'noreply@school.example.in',
      fromName: 'RingPe',
      tlsVerify: true,
    });
    // The sender is made without connecting (nodemailer connects on the first message).
    expect(
      createEmailSender('smtp', capturingLoggers().loggers, { echo: false, smtp: ok.notify.smtp })
        .channel,
    ).toBe('email');
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'smtp',
        EMAIL_USER: 'noreply@school.example.in',
        EMAIL_PASS: 'x',
        EMAIL_TLS_VERIFY: 'false',
      }),
    ).toThrow(/EMAIL_TLS_VERIFY: must be true in production/);
  });
});

describe('notification events', () => {
  it('every in-app notice belongs to one event, and every event is on by default (the bus-near e-mail off)', () => {
    const notices = allMessages()
      .map((m) => m.key)
      .filter((k) => k.startsWith('NTF.'));
    expect(notices.length).toBeGreaterThan(30);
    expect(notices.filter((k) => !commEventOf(k))).toEqual([]);
    const titles = COMM_EVENTS.flatMap((e) => e.titles);
    expect(new Set(titles).size).toBe(titles.length);
    expect(COMM_EVENTS.every((e) => e.alertByDefault)).toBe(true);
    // Client 2026-10-21/22: "the bus is near your stop" by e-mail would arrive after the bus has
    // gone; today's bus and each check-in or check-out are daily.
    expect(COMM_EVENTS.filter((e) => !e.emailByDefault).map((e) => e.key)).toEqual([
      'CHECK_IN_OUT',
      'BUS_NEAR',
      'BUS_TODAY',
    ]);
  });
});
