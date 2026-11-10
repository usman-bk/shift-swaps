# shift-swaps

_Built with AI assistance._

A team rota where two people can swap shifts and a manager signs it off, without
the swap ever leaving someone on two shifts at once or short of their rest.

React 19, Redux Toolkit Query, TypeScript, Node, Express 5, MongoDB through
Mongoose. The server tests run against a real `mongod` replica set, because the
interesting failures only exist inside real transactions.

```
server/src/swaps.ts    every rule about who may swap what, and the transaction
server/src/models.ts   the collections and the two indexes that matter
server/src/auth.ts     scrypt, the session cookie, per-request permissions
server/src/app.ts      routes and validation, no rules
web/src/api.ts         the API, including the optimistic accept
web/src/App.tsx        the screens
```

## A swap goes through three people

Someone offers a shift. A colleague accepts it, optionally giving one of their
own in return. A manager approves it, and only then do the shifts change hands.
Time passes between those steps, so the rota is checked at accept to refuse
early and checked again at approve, because the first answer can have gone stale.

## Why a transaction was not enough

Take one person, Cara, and two approved swaps that each hand her a Monday shift.
The shifts overlap. Two managers approve at the same moment.

Each transaction reads Cara's rota, sees no clash, and writes a different shift
document. MongoDB transactions are snapshot isolated, and they only conflict when
they write the same document. These two do not, so both commit and Cara is double
booked. It is the write skew anomaly, and no amount of re-reading inside the
transaction fixes it, because each one is reading a correct snapshot.

There is no exclusion constraint to reach for, so the fix is to make the writes
collide on purpose. Every approval increments a `rotaVersion` counter on both
people first. Nothing ever reads that number. Writing it means the second
transaction hits a write conflict, is aborted, retries through `withTransaction`,
and on the retry sees the first swap and refuses.

`two approvals racing` holds both transactions after their checks so they really
do overlap. CI removes the counter on every push and fails if that test still
passes.

Two things follow from how MongoDB handles the conflict. It aborts instead of
making the second transaction wait, so the callback runs more than once and must
not keep state between runs. And the counter is written before the checks, so
the loser is stopped before it does any work.

## One shift, one live swap

A shift can be on either side of a swap, as the one offered or the one given
back. Both go in a `locks` array, under a unique index restricted to live swaps:

```js
swapSchema.index({ locks: 1 }, { unique: true, partialFilterExpression: { live: true } });
```

A unique index on an array is unique across documents, so that one line covers
both sides and every interleaving. Closing a swap empties the array and the shift
is free again. Offering is safe to retry for the same reason: the duplicate key
error leads back to the swap that already exists.

## Eleven hours, in real hours

The minimum rest defaults to eleven hours, the daily rest in Article 3 of the EU
Working Time Directive (2003/88/EC), and `MIN_REST_HOURS` changes it. It is a
scheduling check, not legal advice, and the directive has exceptions this does
not model.

Everything is stored and compared as instants. On the night the clocks go back
in Berlin, 22:00 to 08:00 reads as ten hours and is eleven, and there is a test
for it. The browser shows the team's clock rather than its own, so a manager
travelling does not see the rota move.

## The interface tells the truth late, then corrects it

Accepting shows at once. If the server says someone got there first, the row goes
back and the server's reason appears. Either way the list is refetched. Buttons
keep their size in every state, and the space for a message is reserved, so a
refusal does not push the list down under the pointer.

Permissions are read from the database on every request. The token only says who
you are, so a manager who is demoted loses approval on their next click rather
than when the token expires.

## Where it stops

- One team per deployment. There is no tenant boundary.
- Shifts are created by the seed script. In real use they would come from the
  scheduling system.
- No notifications. People find out by opening the board.
- The login rate limit is in memory, so it is per process.
- CSRF protection is the `SameSite=Strict` session cookie, with no token as well.
- A session cannot be ended from the server before its ten hours are up, except
  by deleting the user.

## Running it

Needs Node 24. The demo downloads a `mongod` binary the first time and needs no
other setup:

    npm ci
    npm run demo

Open http://localhost:3000 and sign in as `mina@example.com` (manager), or
`jonas@`, `priya@` or `tom@example.com`, with the password `demo-password`.

    npm test            # server against a real replica set, then the web app
    npm run lint
    npm run typecheck

Production needs `MONGO_URL` pointing at a replica set, since a standalone
`mongod` refuses transactions, and `JWT_SECRET`.
