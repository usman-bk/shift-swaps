import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { User } from './models';
import { Problem } from './problem';
import type { Actor } from './swaps';

const derive = promisify(scrypt) as (p: string, s: Buffer, l: number) => Promise<Buffer>;
const KEY_LENGTH = 32;
export const COOKIE = 'session';
export const SESSION_HOURS = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(':');
  const actual = await derive(password, Buffer.from(salt!, 'hex'), KEY_LENGTH);
  return timingSafeEqual(actual, Buffer.from(key!, 'hex'));
}

// An unknown email still costs one scrypt, so the response time does not say
// which addresses have accounts.
const nobody = hashPassword(randomBytes(16).toString('hex'));

export async function login(email: string, password: string, secret: string): Promise<string> {
  const user = await User.findOne({ email }).lean();
  const ok = await checkPassword(password, user?.passwordHash ?? (await nobody));
  if (!user || !ok) throw new Problem(401, 'bad_login', 'Wrong email or password.');
  return jwt.sign({}, secret, {
    subject: String(user._id),
    algorithm: 'HS256',
    expiresIn: `${SESSION_HOURS}h`,
  });
}

export type Authed = { actor: Actor; name: string };

/** The token says who you are. What you may do is read fresh on each request. */
export function requireUser(secret: string): RequestHandler {
  return async (req, res, next) => {
    let sub: string | undefined;
    try {
      const token = (req.cookies as Record<string, string | undefined>)[COOKIE] ?? '';
      sub = jwt.verify(token, secret, { algorithms: ['HS256'] }).sub as string | undefined;
    } catch {
      throw new Problem(401, 'not_signed_in', 'Please sign in.');
    }
    const user = await User.findById(sub).select('name role').lean();
    if (!user) throw new Problem(401, 'not_signed_in', 'Please sign in.');
    res.locals.user = { actor: { id: user._id, role: user.role }, name: user.name } satisfies Authed;
    next();
  };
}
