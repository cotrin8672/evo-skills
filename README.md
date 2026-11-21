# Pi Skill Evolution

A standalone Pi extension. It asks a separately selected model to propose a small, evidence-based improvement to one skill. It never edits the original skill or sends completion messages to the current chat.

```sh
pi install git:github.com/cotrin8672/pi-skill-evolution
```

Then use the following commands in Pi or pig:

| Command | Action |
| --- | --- |
| `/skill-evolution model` | Choose the improvement model |
| `/skill-evolution model <provider/model-id>` | Set it directly without changing the chat model |
| `/skill-evolution run <path to SKILL.md>` | Supply an observation and start a background proposal |
| `/skill-evolution status` | Show the current or latest job in this session |

Proposals contain `before.md` and `after.md` under the Pi agent directory's `skill-evolution/proposals/` folder. Review them with `git diff --no-index before.md after.md` from that proposal directory. The original frontmatter is preserved. There is no automatic application, history collection, persistent queue, or automatic adoption in this version.

The improvement session gets no tools, extensions, MCP servers, or chat history. The selected skill and your observation are sent to the selected model provider; don't include secrets. The model picker uses standard Pi `auth.json`, `models.json`, and environment-based configuration, not providers or accounts registered only by pig or another extension. The job stops on session shutdown and has a two-minute time limit.

## Development

Requires Pi's `@earendil-works/pi-coding-agent` 1.5.2 (the tested SDK version).

```sh
mise install
pnpm install --frozen-lockfile
pnpm check
```
