# @deep-tui/plugin-mode-plan

Adds a session-only `/plan` mode. `/plan` or `/plan on` enters it, `/plan off`
returns to normal operation, and `/plan status` explains the active policy.

While active, the plugin:

- adds a planning-only section to the assembled system prompt;
- keeps workspace reads and searches available;
- denies write, execute, and network permission classes;
- overrides auto approval without changing the user's auto-mode setting;
- displays `PLAN` in the TUI footer and temporarily hides the `AUTO` badge.

The mode starts off and does not persist between Deep TUI processes. Configure
`enabled`, `blockedRisks`, or `prompt` to build a different planning policy.
Because prompt, permission, status, and command behavior are ordinary Cordis
contributions, another plugin can replace any part of this mode.
