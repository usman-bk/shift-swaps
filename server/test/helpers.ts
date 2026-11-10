import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth';
import { ensureIndexes, Shift, Swap, User } from '../src/models';
import * as swaps from '../src/swaps';

export const HOUR = 3_600_000;
export const T0 = new Date('2030-03-04T00:00:00Z').getTime();
export const hour = (h: number) => new Date(T0 + h * HOUR);
/** The clock most tests use: an hour before the first shift. */
export const hooks = { now: () => hour(-1) };

let replSet: MongoMemoryReplSet;

export function useDatabase(): void {
  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri('shift_swaps_test'));
    await ensureIndexes();
  }, 120_000);
  afterEach(async () => {
    await Promise.all([User.deleteMany({}), Shift.deleteMany({}), Swap.deleteMany({})]);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });
}

let n = 0;
let password: string | undefined;
export const PASSWORD = 'correct horse';

export async function person(role: 'staff' | 'manager' = 'staff', name?: string) {
  password ??= await hashPassword(PASSWORD);
  n += 1;
  const user = await User.create({
    email: `p${n}@example.com`,
    name: name ?? `Person ${n}`,
    role,
    passwordHash: password,
  });
  return { id: user._id, role, email: user.email };
}

type Who = { id: Types.ObjectId };
type Person = Awaited<ReturnType<typeof person>>;

export function shift(owner: Who, from: number, to: number) {
  return Shift.create({ title: 'Desk', start: hour(from), end: hour(to), owner: owner.id });
}

export const ownerOf = async (s: { _id: Types.ObjectId }) => (await Shift.findById(s._id).lean())!.owner;
export const shiftsOf = (who: Who) => Shift.countDocuments({ owner: who.id });
export const app = () =>
  createApp({ jwtSecret: 'test-secret', timeZone: 'Europe/Berlin', secureCookies: false, loginLimit: 5 });

/** A swap that has reached the manager: offered by `from`, accepted by `to`. */
export async function acceptedSwap(from: Person, s: { _id: Types.ObjectId }, to: Person) {
  const swap = await swaps.offer(String(s._id), from, hooks);
  await swaps.accept(String(swap._id), null, to, hooks);
  return String(swap._id);
}

export async function signedIn(user: { email: string }) {
  const agent = request.agent(app());
  await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(204);
  return agent;
}

/** Holds whoever arrives first until the second arrives, or until `ms` passes. */
export function barrier(ms: number): () => Promise<void> {
  let release: () => void = () => undefined;
  let waiting = false;
  return async () => {
    if (waiting) {
      release();
      return;
    }
    waiting = true;
    await new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, ms);
    });
  };
}
