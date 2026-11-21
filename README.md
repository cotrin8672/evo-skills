# Pi Skill Evolution

A standalone Pi extension for opt-in skill improvement. It observes use of tracked skills, queues an independent agent to propose improvements, and publishes only revisions that pass a fixed comparison. It does not change the original skill or insert completion messages into the chat.

```sh
pi install git:github.com/cotrin8672/pi-skill-evolution
```

## Set up one skill

1. Run `/skill-evolution model` and select an improvement model. To set a thinking level, use `model <provider/model-id> <level>`. This never switches the chat model.
2. If Pi already discovers the original, exclude that file in the applicable Pi `settings.json` before tracking it. Add `"-<absolute-path-to-SKILL.md>"` to `skills` in the same scope, preserving other entries, and reload. The command refuses a visible duplicate. Keep the source file for existing sessions.
3. Run `/skill-evolution track <path to SKILL.md>`. It copies the skill directory; new sessions use the managed copy and keep the selected revision for their lifetime. Use `/skill:your-skill` or let the agent read its `SKILL.md` in a new session.
4. Run `/skill-evolution checks <skill> <fixtures.json>` to enable automatic adoption. The evaluation model defaults to the model and thinking level of the originating task. Use `target <skill> <provider/model-id> [thinking]` to pin a different evaluator or `target <skill> origin` to clear it.

```json
[
  { "kind": "regression", "task": "A representative task that already works", "includes": ["expected result"] },
  { "kind": "repair", "task": "Reproduce a specific past failure", "includes": ["corrected result"], "excludes": ["known bad result"] },
  { "kind": "non_applicable", "task": "An unrelated task that should not use the skill", "includes": ["expected answer"] }
]
```

The old and new revisions run twice under the same conditions with fresh working directories. Both revised runs must satisfy every case; regression and non-applicable cases must also pass on the baseline, and at least one repair case must consistently fail on the baseline. This checks applicability and text outputs, not scripts or integration behavior. If those checks cannot establish an improvement, the revision stays a candidate for review.

## Commands

All commands below are arguments to `/skill-evolution`.

| Command | Purpose |
| --- | --- |
| `status` | Show selected model, queue, usage and both active and session-pinned revisions |
| `model [provider/model-id] [thinking]` | Set the model used only for generating proposals |
| `track <path>` | Register one user-owned skill |
| `checks <skill> <fixtures.json>` | Set the comparison fixtures for future jobs |
| `target <skill> <provider/model-id\|origin> [thinking]` | Set or reset the evaluation profile |
| `run <skill>` | Enqueue a manual observation without the normal cooldown |
| `pause` / `resume` | Disable or resume starting queued jobs |
| `budget <setting> <integer>` | Set `jobsPerDay`, `callsPerJob`, `outputTokens`, `timeoutMs`, `idleMs` or `cooldownMs` |
| `diff <job>` | Review the rationale, referenced observations, evaluation and diff |
| `reevaluate <job>` | Compare a held candidate with the current fixtures |
| `apply <job>` | Adopt a structurally valid held candidate after manual review |
| `rollback <skill> <revision>` | Change the active revision for future sessions |

## Behavior and limits

- Nothing is collected until a skill is explicitly registered. Settled turns are associated with a skill through confirmed `/skill:` expansion or the final built-in `read` result. A read is recorded as an observation, not proof of usefulness. Subsequent observations are associated with the branch that used the skill.
- Evidence excerpts and skill content are sent to the configured improvement model. Standard secret patterns and raw `read` output are omitted, but the filter is not a guarantee against sensitive data. Track only skills and conversations you may share with that provider.
- The optimizer has only `read_evidence`, `read_skill_file` and `submit_proposal`. It cannot use shell, arbitrary filesystem tools, MCP, or other extensions. Comparison sessions have no tools. Neither worker can enqueue observations or change the evaluation conditions.
- The extension uses Pi's standard credential/model configuration (`auth.json`, `models.json`, and the environment). Providers or profiles configured only in pig or registered by other extensions are not automatically available.
- State is stored locally in SQLite under the Pi agent directory's `skill-evolution/`, with immutable revision directories alongside it. Do not locate that store on a network share or sync it between running hosts. The worker pauses new model calls while a tracked host has foreground work. Interruption leaves the job recoverable; nothing runs after the host exits.
- Reloaded and resumed sessions keep their recorded pins; forks inherit a known parent pin. Manually editing stored revisions bypasses those guarantees.

## Development

The tests use Pi SDK 1.5.2 and a fake provider (no network calls for model execution).

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise run check
```
