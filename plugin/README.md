# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). One installation manages multiple GitHub projects, with one active at a time. It listens to GitHub and, optionally, Feishu for the active project. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and Git worktree, and answers in the original conversation. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the documents through [DOCS.md](DOCS.md), which routes this module's source and numbered-document leaves; each numbered document builds only on the ones before it.

## Development

From the repository root, use Node.js 22.19+ (22.x) or 24+, and pnpm 11.7.0. On native Windows or Linux, run:

```sh
pnpm -C plugin install --frozen-lockfile
pnpm -C plugin check
```

`check` typechecks, runs every test applicable to the platform, and builds. CI requires both the native Windows `windows` job and the Ubuntu `check` job. Ubuntu runs the full suite, including the POSIX-only service-script tests, only after Windows succeeds; if Windows does not succeed, the Ubuntu job fails explicitly instead of being skipped. On success Ubuntu uploads the build and exact-commit evidence. See [deployment checks](docs/006-deployment.md#development-checks) for evidence, required job settings, and optional local hooks.

## License

[MIT](LICENSE)
