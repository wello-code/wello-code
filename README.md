# Wello Code

An open-source desktop coding agent: a calm, agent-first workbench for handing a task
to a model, watching every action it takes, and approving anything that touches your
machine.

Wello Code signs you in with your **Wello account** and runs against Wello's models, so
usage counts toward your subscription (with pay-as-you-go beyond it). The desktop app
talks to the Wello backend only over the public HTTPS API; no private Wello service code
lives in this repository.

> **Status:** first Windows release in preparation. Windows 10+ (64-bit) is the only
> build today. macOS is planned but not built yet.

## What it does

- **Works in tasks, not prompts.** Describe the job; the agent drafts a plan, walks
  through it, and hands the result back as a reviewable diff.
- **Terminal, preview and git in the window.** Run commands, start a dev server, open
  any site in the built-in browser (with phone and tablet modes), manage branches,
  commits, stashes and conflicts without a console.
- **Nothing without asking.** Every file write, command and network call goes through a
  permission broker and is recorded in an audit timeline. Trust a folder wholesale, or
  approve one action at a time.
- **Roll back.** Project state is captured before every turn, so you can return to any
  step and take both the files and the conversation with you.
- **GitHub without the CLI.** Publish a project and open a pull request from the UI.
- **Skills and MCP.** Bundled Agent Skills plus your own, and MCP connectors.

The interface is currently Russian only.

## Architecture

- **Electron + React + TypeScript (strict) + Vite**, pnpm workspace.
- Hardened renderer: `sandbox`, `contextIsolation`, no `nodeIntegration`, strict CSP. A
  small typed preload API is the only bridge.
- Privileged work (files, shell, git, agent) lives in the main process behind
  Zod-validated contracts.
- The agent engine sits behind a typed `AgentProvider`; a deterministic
  `MockAgentProvider` runs the whole UX in tests with no network and no key.

## Development

```bash
pnpm install
pnpm dev          # launch the desktop app
pnpm typecheck
pnpm lint
pnpm test
```

Requires Node >= 20 and pnpm 11.

To produce a portable Windows build:

```bash
pnpm --filter @wello-code/desktop build
node apps/desktop/scripts/package-win.mjs
```

## License

Apache License 2.0. See [LICENSE](LICENSE).

The agent engine, [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
is a **proprietary** dependency of Anthropic PBC and is not covered by this project's
license; it is installed from npm and its use is subject to
[Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance). Bundled
third-party Agent Skills keep their own licenses. See [NOTICE](NOTICE) for the full
attribution list.
