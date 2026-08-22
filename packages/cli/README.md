# @deep-tui/cli

The Deep TUI command-line host and `deep-tui` executable. Deep TUI is a plugin-first
coding-agent harness built on Cordis.

Install it with npm; pnpm and a repository checkout are not required:

```sh
npm install --global @deep-tui/cli
```

Then initialize a project composition and start the default UI:

```sh
deep-tui init
export DEEPSEEK_API_KEY=your-key
deep-tui
```

Use `deep-tui config init --scope user` instead if you want the default
composition to apply in projects that do not have their own configuration.

Plugins may be installed from npm, loaded from local files, or declared as a
GitHub repository URL. See the repository README for configuration, security,
and plugin-authoring details.
