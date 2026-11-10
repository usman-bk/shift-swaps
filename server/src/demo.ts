// `npm run demo`: a real single-node replica set, a small team and the built
// web app on one port. Nothing here is used in production.
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createApp } from './app';
import { hashPassword } from './auth';
import { ensureIndexes, Shift, User } from './models';

const PASSWORD = 'demo-password';
const DAY = 86_400_000;

async function seed(): Promise<void> {
  const passwordHash = await hashPassword(PASSWORD);
  const [mina, jonas, priya, tom] = await User.create([
    { email: 'mina@example.com', name: 'Mina Vogel', role: 'manager', passwordHash },
    { email: 'jonas@example.com', name: 'Jonas Weber', role: 'staff', passwordHash },
    { email: 'priya@example.com', name: 'Priya Nair', role: 'staff', passwordHash },
    { email: 'tom@example.com', name: 'Tom Becker', role: 'staff', passwordHash },
  ]);
  void mina;
  const monday = new Date();
  monday.setUTCHours(0, 0, 0, 0);
  monday.setTime(monday.getTime() + ((8 - monday.getUTCDay()) % 7 || 7) * DAY);

  const at = (day: number, hour: number) => new Date(monday.getTime() + day * DAY + hour * 3_600_000);
  const rows = [jonas, priya, tom].flatMap((user, i) =>
    [0, 1, 3, 4].map((day) => ({
      title: ['Front desk', 'Kitchen', 'Delivery'][i]!,
      start: at(day + i, 7 + i * 2),
      end: at(day + i, 15 + i * 2),
      owner: user!._id,
    })),
  );
  await Shift.create(rows);
}

async function main(): Promise<void> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri('shift_swaps_demo'));
  await ensureIndexes();
  await seed();
  const port = Number(process.env.PORT ?? 3000);
  const app = createApp({
    jwtSecret: 'demo-only',
    timeZone: 'Europe/Berlin',
    secureCookies: false,
    webRoot: path.join(__dirname, '../../web/dist'),
    loginLimit: 1000,
  });
  const server = app.listen(port, () => {
    console.log(
      `http://localhost:${port}  mina@ (manager), jonas@, priya@, tom@example.com  password: ${PASSWORD}`,
    );
  });
  const stop = () => {
    server.close(
      () =>
        void mongoose
          .disconnect()
          .then(() => replSet.stop())
          .then(() => process.exit(0)),
    );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
