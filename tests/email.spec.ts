/**
 * E-mail (client 2026-10-16): the SMTP sender in the RingPe layout, its configuration, and the
 * notification events every in-app notice belongs to.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config';
import { COMM_EVENTS, allMessages, commEventOf } from '../config/registers';
import { smtpSender } from '../integrations/email.provider';
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
      purpose: 'notification.attendance',
      subject: 'Aarav was marked absent on 16 Oct 2026',
      text: 'Details: https://ringpe.example.in/x <b>bold</b>',
      fromName: 'Tunga "Valley" Public School',
      replyTo: 'office@tvps.example.in',
    });
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m['from']).toEqual({ name: 'Tunga Valley Public School', address: smtp.from });
    expect(m['replyTo']).toBe('office@tvps.example.in');
    expect(m['subject']).toBe('Aarav was marked absent on 16 Oct 2026');
    expect(m['text']).toContain('<b>bold</b>');
    const html = String(m['html']);
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('<a href="https://ringpe.example.in/x"');
    expect(html).toContain('Tunga Valley Public School');
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.stringify(lines)).not.toContain('parent@example.in');
    expect(JSON.stringify(lines)).not.toContain('absent');
  });

  it('gives a subject by purpose when none is given', () => {
    expect(subjectFor('otp.signup')).toBe('Your RingPe one-time code');
    expect(subjectFor('password_reset.console')).toBe('Reset your RingPe password');
    expect(subjectFor('staff.onboarded')).toBe('Welcome to RingPe');
    expect(subjectFor('something.new')).toBe('A message from RingPe');
    expect(subjectFor('x', '  Given  ')).toBe('Given');
    expect(emailHtml({ subject: '<s>', text: 'a', sender: 'S' })).toContain('&lt;s&gt;');
  });

  it('needs the account and a sender address, and checks the certificate in production', () => {
    expect(() => loadConfig({ ...BASE_ENV, EMAIL_PROVIDER: 'smtp' })).toThrow(
      /EMAIL_USER: and EMAIL_PASS are required/,
    );
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
      tlsVerify: true,
    });
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
    // Client 2026-10-21: "the bus is near your stop" by e-mail would arrive after the bus has gone.
    expect(COMM_EVENTS.filter((e) => !e.emailByDefault).map((e) => e.key)).toEqual(['BUS_NEAR']);
  });
});
