# pi-goal

Give Pi a goal and let it work until the goal is done. Pi keeps taking turns on its own, asks
you when it needs a decision, and stops only when it has checked that the goal is met.

## Install

```bash
pi install git:github.com/kacperkwapisz/pi-goal
```

Requires Pi 1.x.

## Use

```
/goal Make the test suite pass on Node 22 and 24
```

A line above the editor shows the goal and whether Pi is working on it, waiting for you or
paused. Pi can also suggest a goal itself when one would help; it asks you first.

| Command | |
|---|---|
| `/goal <goal>` | Set or replace the goal |
| `/goal` | Show the current goal |
| `/goal pause` | Stop working on it automatically |
| `/goal resume` | Continue (also skips a wait) |
| `/goal clear` | Remove the goal |

While a goal is set, the model gets a few tools:

- `goal_complete` ends the goal once the work is done and checked.
- `goal_ask` asks you something (a decision, missing information, or before anything
  destructive). Pi stops and waits; your next message is the answer, and then it carries on.
- `goal_pause` pauses the goal when it needs you to do something outside Pi, such as signing in
  or granting access.
- `goal_wait` waits for background work instead of idling or polling: agents from
  [pi-subagents](https://github.com/kacperkwapisz/pi-subagents) started in the background, or
  jobs from a background jobs extension that speaks the same protocol (see below).
  Pi continues when one of them finishes, when you send a message, or after a timeout
  (30 minutes by default).

### When Pi stops on its own

- **Esc** holds the goal until you send a message or run `/goal resume`.
- **`/compact`** pauses the turn; the goal continues once compaction is done. If automatic
  compaction fails or is cancelled, the goal pauses, so a full context can't turn into a loop.
- **Sign-in, billing or access errors** from the provider (HTTP 401, 402, 403, 407) pause the
  goal until you fix them and run `/goal resume`.

The goal is saved in the session, so it is still there after `/resume` or `/tree`.

## Background work

`goal_wait` talks to other extensions over Pi's `pi.events`, so any extension can take part.
It asks `<name>:query` with `{ reply(names) }` for what is running and listens to
`<name>:finished` for `{ name, triggersTurn }`, where `<name>` is `bg-jobs` or `pi-subagents`.
`triggersTurn: false` means the user stopped it, so the goal loop continues by itself.

## Development

```bash
npm install
npm run check
npm test
```

The tests run the goal loop in a real Pi session with a scripted model.
