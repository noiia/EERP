# graphify
- **graphify** (`.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Keep Graphify `PreToolUse` hooks out of the shared `.claude/settings.json`.
Copilot also loads that file, and a failing hook can block its tools, including Git.
Invoke `/graphify` explicitly when needed.
