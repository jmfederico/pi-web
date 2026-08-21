# skills

Distributable agent skills developed alongside pi-web.

## relay

Execute a long or complex plan as a chain of independent sessions, each running
one well-sized leg and handing off to the next via `spawn_session`.

```bash
npx skills add jmfederico/pi-web --skill relay -a pi -g
```

The `relays` Pi package ships the same skill to PI WEB sessions:
`pi-packages/relays/skills/relay/SKILL.md` is a symlink to the canonical file
here, which the plugin build (`npm run build:plugins`, or the dev watch) materializes
into a real packaged file. Edit the copy in this directory, not the plugin link.
