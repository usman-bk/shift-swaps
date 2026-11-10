import mongoose from 'mongoose';
import { createApp } from './app';
import { ensureIndexes } from './models';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  // A standalone mongod refuses transactions, so this has to be a replica set.
  await mongoose.connect(required('MONGO_URL'));
  await ensureIndexes();
  const app = createApp({
    jwtSecret: required('JWT_SECRET'),
    timeZone: process.env.TEAM_TIME_ZONE ?? 'Europe/Berlin',
    secureCookies: process.env.INSECURE_COOKIES !== '1',
    webRoot: process.env.WEB_ROOT,
  });
  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => console.log(`listening on ${port}`));

  const stop = () => {
    server.close(() => void mongoose.disconnect().then(() => process.exit(0)));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
