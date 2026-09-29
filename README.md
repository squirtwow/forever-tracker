# Forever tracker

Tells a staff Discord channel when **World of Warcraft: Forever** changes, so
addon authors can fix their addons quickly. It posts three things, and nothing
else:

- **New Forever builds** from Blizzard's public patch server (product
  `wow_classic_beta`), with the regions that have the build and any still behind
- **The Blizzard UI source for each build**, from the public
  [Gethe/wow-ui-source](https://github.com/Gethe/wow-ui-source) mirror (`forever`
  branch): files and lines changed, API functions and events added or removed,
  Blizzard addons touched, and a link to the full comparison
- **Forever patch notes and hotfixes** posted by Blizzard staff on the US WoW
  forums, read from the public Blue Tracker feed. Only Forever notes count: a
  staff notes topic in a Forever forum (or with Forever in its title), or a
  standalone staff update inside one. Retail news, realm notices and chat
  replies are left out.

It only reads from Blizzard and GitHub. The one thing it sends is the Discord
message. Nobody is pinged unless you set up a role (see Options).

## How it runs

A GitHub Actions workflow (`.github/workflows/tracker.yml`) runs every 15
minutes. What it has already seen is kept in a small state file in the Actions
cache, so nothing is committed. The first run only records where everything is
and posts one "Forever tracker is live" message; after that, only new things are
posted. A source that is down is simply checked again next run, without losing
its place or posting twice.

## Setup

1. Create a **public** repository and push this code to it (public repositories
   get free Actions minutes).
2. In the repository: **Settings > Secrets and variables > Actions > New
   repository secret**. Name: `FOREVER_TRACKER_WEBHOOK`. Value: the Discord
   webhook URL of the staff channel.
3. **Actions** tab: enable workflows if GitHub asks.
4. **Actions > Forever tracker > Run workflow** with **Dry run** ticked. The log
   shows the message it would post, and proves every source can be reached from
   GitHub.
5. Run it again without Dry run. The channel gets the "live" message, and the
   schedule takes over from there.

## Options

Optional repository variables (**Settings > Secrets and variables > Actions >
Variables**):

| Variable | What it does |
|---|---|
| `INCLUDE_KNOWN_ISSUES` | `true` also posts staff Known Issues topics and their updates. Off by default. |
| `PING_ROLE_ID` | A Discord role ID to ping on new builds. Off by default. |
| `WATCH_ADDONS` | Blizzard addons to list first, in bold, such as `CooldownViewer,TrainerUI`. |
| `FOREVER_PRODUCTS` | Patch server products to watch. Default `wow_classic_beta`. |

## Running it by hand

Needs Node.js 20 or newer. There are no packages to install.

```sh
node src/tracker.mjs --dry-run    # check everything and print the messages; nothing is sent or saved
node src/tracker.mjs --seed-old   # dry run from one build back, to preview real build, UI and notes messages
npm test                          # the tests (node --test)
```

A real run needs `FOREVER_TRACKER_WEBHOOK` set, and saves its state to
`.state/state.json` (or `STATE_FILE`).

## Good to know

- If a source fails 8 runs in a row (about two hours), that run is marked
  failed once, so GitHub emails you. Nothing is posted to Discord about it.
- A message Discord doesn't accept is kept and tried again next run, up to 5
  times.
- More than 5 new notes posts at once are posted as the newest 3 plus one
  message listing the rest.
- The saved state lasts as long as the workflow keeps running. If nothing runs
  for 7 days it is lost, and the next run posts a new "live" message saying so.
- GitHub turns off scheduled workflows in public repositories after 60 days
  without any repository activity, and emails a warning first. Turn it back on
  from the Actions tab, or push any change.

## License

Copyright (c) 2026 Squirt. All rights reserved. See [LICENSE.txt](LICENSE.txt).
