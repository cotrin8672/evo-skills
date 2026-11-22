# Evo Skills

A standalone Pi extension for opt-in skill improvement. It observes use of personal and trusted project skills, queues an independent agent to propose improvements, and automatically applies only revisions that pass a fixed comparison.

```sh
pi install git:github.com/cotrin8672/evo-skills
```

If you installed the extension under the previous repository name, replace the old package source rather than loading both. The new installation keeps using the existing state directory without moving it.

## Enable automatic improvement

1. Run `/evo-skills model` and select an improvement model. To set a thinking level, use `model <provider/model-id> <level>`. This never switches the chat model.
2. Run `/evo-skills enable` once and confirm. Pi's auto-discovered personal and trusted project `SKILL.md` files become eligible without registering or excluding individual skills. Package, extension, and other non-auto-discovered skills are not eligible.
3. Use `/skill:your-skill` or let the agent read its `SKILL.md`. To allow automatic write-back for a skill, set up comparison cases with `/evo-skills checks <skill> <fixtures.json>`. Without those cases, improvements stay candidates for manual review.

Opt-in is shared across projects using the same Pi agent directory. Evo Skills only considers global skills and skills Pi loads for the current trusted project; it does not scan other projects. New projects are picked up when opened in Pi. Skills added while Pi is running are picked up automatically on an idle refresh, without running `/reload` or opting in again.

The evaluation model defaults to the model and thinking level of the originating task. Use `target <skill> <provider/model-id> [thinking]` to pin a different evaluator or `target <skill> origin` to clear it.

```json
[
  { "kind": "regression", "task": "A representative task that already works", "includes": ["expected result"] },
  { "kind": "repair", "task": "Reproduce a specific past failure", "includes": ["corrected result"], "excludes": ["known bad result"] },
  { "kind": "non_applicable", "task": "An unrelated task that should not use the skill", "includes": ["expected answer"] }
]
```

The old and new revisions run twice under the same conditions with fresh working directories. Both revised runs must satisfy every case; regression and non-applicable cases must also pass on the baseline, and at least one repair case must consistently fail on the baseline. This checks applicability and text outputs, not scripts or integration behavior. If those checks cannot establish an improvement, the revision stays a candidate for review.

## Commands

All commands below are arguments to `/evo-skills`.

| Command | Purpose |
| --- | --- |
| `status` | Show selected model, queue, usage and both active and session-pinned revisions |
| `model [provider/model-id] [thinking]` | Set the model used only for generating proposals |
| `enable` | Opt in once to automatic discovery and improvement |
| `checks <skill> <fixtures.json>` | Set the comparison fixtures for future jobs |
| `target <skill> <provider/model-id\|origin> [thinking]` | Set or reset the evaluation profile |
| `run <skill>` | Enqueue a manual observation without the normal cooldown |
| `pause` / `resume` | Suspend or resume observation and starting queued jobs |
| `budget <setting> <integer>` | Set `jobsPerDay`, `callsPerJob`, `outputTokens`, `timeoutMs`, `idleMs` or `cooldownMs` |
| `diff <job>` | Review the rationale, referenced observations, evaluation and diff |
| `reevaluate <job>` | Compare a held candidate with the current fixtures |
| `apply <job>` | Adopt a structurally valid held candidate after manual review |
| `rollback <skill> <revision>` | Change the active revision for future sessions |

## Behavior and limits

- For automatically discovered skills, only turns that expand `/skill:` or successfully read the eligible `SKILL.md` with the built-in `read` tool are observed. A read is not proof of usefulness. Pi's provenance determines eligibility: a third-party skill copied as ordinary files into a personal skill directory looks like a personal skill.
- Evidence excerpts and skill content are sent to the configured improvement model. Standard secret patterns and raw `read` output are omitted, but the filter is not a guarantee against sensitive data. Track only skills and conversations you may share with that provider.
- The optimizer has only `read_evidence`, `read_skill_file` and `submit_proposal`. It cannot use shell, arbitrary filesystem tools, MCP, or other extensions. Comparison sessions have no tools. Neither worker can enqueue observations or change the evaluation conditions.
- The extension uses Pi's standard credential/model configuration (`auth.json`, `models.json`, and the environment). Providers or profiles configured only in pig or registered by other extensions are not automatically available.
- New installations store state locally in SQLite under the Pi agent directory's `evo-skills/`, with immutable revision directories alongside it. Do not locate that store on a network share or sync it between running hosts. The worker pauses new model calls while a tracked host has foreground work. Interruption leaves the job recoverable; nothing runs after the host exits.
- Accepted revisions update the original `SKILL.md` in place and keep the previous version for rollback. If the original has changed since the proposal's base revision, the proposal is held instead of overwriting the edit. Updates show a Pi notification and the job is available in `status` and `diff`.
- Skills registered with older releases keep using their managed copies and session pins. The extension does not rewrite their original files or change their Pi discovery settings.

## Development

The tests use Pi SDK 1.5.2 and a fake provider (no network calls for model execution).

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise run check
```
