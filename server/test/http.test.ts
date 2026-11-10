import jwt from 'jsonwebtoken';
import request from 'supertest';
import { Shift, User } from '../src/models';
import * as swaps from '../src/swaps';
import { app, hour, PASSWORD, person, shift, signedIn, useDatabase } from './helpers';

useDatabase();

// These go through the real clock, so the shifts have to be in the future.
beforeAll(() => {
  expect(hour(0).getTime()).toBeGreaterThan(Date.now());
});

describe('signing in', () => {
  it('sets a cookie scripts cannot read and other sites cannot send', async () => {
    const a = await person();
    const res = await request(app())
      .post('/api/auth/login')
      .send({ email: a.email, password: PASSWORD })
      .expect(204);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('answers a wrong password and an unknown email the same way', async () => {
    const a = await person();
    const wrong = await request(app()).post('/api/auth/login').send({ email: a.email, password: 'nope' });
    const unknown = await request(app())
      .post('/api/auth/login')
      .send({ email: 'x@example.com', password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('rejects a query operator where a string belongs', async () => {
    await request(app())
      .post('/api/auth/login')
      .send({ email: { $gt: '' }, password: { $gt: '' } })
      .expect(400);
  });

  it('stops after too many attempts', async () => {
    const server = app();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await request(server)
        .post('/api/auth/login')
        .send({ email: 'x@example.com', password: 'nope' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual(Array(5).fill(401));
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('does not store the password', async () => {
    const a = await person();
    const row = await User.findById(a.id).lean();
    expect(row!.passwordHash).not.toContain(PASSWORD);
  });
});

describe('sessions', () => {
  it('needs a session', async () => {
    await request(app()).get('/api/me').expect(401);
  });

  it('rejects a token signed with another key', async () => {
    const a = await person();
    const forged = jwt.sign({}, 'other-key', { subject: String(a.id) });
    await request(app()).get('/api/me').set('Cookie', `session=${forged}`).expect(401);
  });

  it('rejects an unsigned token', async () => {
    const a = await person();
    const none = jwt.sign({}, '', { subject: String(a.id), algorithm: 'none' });
    await request(app()).get('/api/me').set('Cookie', `session=${none}`).expect(401);
  });

  it('a manager demoted mid-session loses the power at once', async () => {
    const [m, a, b] = [await person('manager'), await person(), await person()];
    const s = await shift(a, 9, 17);
    const swap = await swaps.offer(String(s._id), a);
    await swaps.accept(String(swap._id), null, b);
    const agent = await signedIn(m);
    await User.updateOne({ _id: m.id }, { role: 'staff' });
    const res = await agent.post(`/api/swaps/${String(swap._id)}/approve`);
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('managers_only');
  });

  it('logging out ends the session in the browser', async () => {
    const agent = await signedIn(await person());
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/me').expect(401);
  });
});

describe('the API', () => {
  it('runs a whole swap over HTTP', async () => {
    const [m, a, b] = [await person('manager'), await person(), await person()];
    const s = await shift(a, 9, 17);
    const [am, ag, bg] = [await signedIn(m), await signedIn(a), await signedIn(b)];

    const offered = await ag
      .post('/api/swaps')
      .send({ shiftId: String(s._id) })
      .expect(201);
    const id = (offered.body as { id: string }).id;
    await bg.post(`/api/swaps/${id}/accept`).send({}).expect(200);
    const done = await am.post(`/api/swaps/${id}/approve`).expect(200);

    expect(done.body).toMatchObject({ status: 'approved', taker: { id: String(b.id) } });
    expect((await Shift.findById(s._id).lean())!.owner.equals(b.id)).toBe(true);
  });

  it('returns the reason as a code the interface can act on', async () => {
    const [a, b] = [await person(), await person()];
    const s = await shift(a, 9, 17);
    await shift(b, 12, 20);
    const swap = await swaps.offer(String(s._id), a);
    const res = await (await signedIn(b)).post(`/api/swaps/${String(swap._id)}/accept`).send({});
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('would_double_book');
  });

  it('rejects a malformed id, and a filter it does not know', async () => {
    const agent = await signedIn(await person());
    await agent
      .post('/api/swaps')
      .send({ shiftId: { $ne: null } })
      .expect(400);
    await agent.get('/api/swaps?filter=everything').expect(400);
    await agent.get('/api/swaps?cursor=abc').expect(400);
  });

  it('does not read brackets in a query string as an operator', async () => {
    const agent = await signedIn(await person());
    const res = await agent.get('/api/swaps?cursor[$gt]=000000000000000000000000').expect(200);
    expect(res.body).toEqual({ items: [], next: null });
  });

  it('answers broken JSON with 400, not 500', async () => {
    await request(app())
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400);
  });

  it('only lists a person’s own shifts', async () => {
    const [a, b] = [await person(), await person()];
    const mine = await shift(a, 9, 17);
    await shift(b, 40, 48);
    const res = await (await signedIn(a)).get('/api/shifts/mine').expect(200);
    expect((res.body as { id: string }[]).map((r) => r.id)).toEqual([String(mine._id)]);
  });

  it('never sends a password hash', async () => {
    const [a, b] = [await person(), await person()];
    const s = await shift(a, 9, 17);
    const swap = await swaps.offer(String(s._id), a);
    await swaps.accept(String(swap._id), null, b);
    const res = await (await signedIn(a)).get('/api/swaps').expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|email/);
  });
});
