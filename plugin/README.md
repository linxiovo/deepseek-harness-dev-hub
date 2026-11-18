# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the documents through [DOCS.md](DOCS.md), which routes this module's source and numbered-document leaves; each numbered document builds only on the ones before it.

## Development

From the repository root, use Node.js 22.19+ (22.x) or 24+, and pnpm 11.7.0. On Linux, run the same full check as [Plugin CI](../.github/workflows/plugin-ci.yml):

```sh
pnpm -C plugin install --frozen-lockfile
pnpm -C plugin check
```

`check` typechecks, runs the full tests and builds after the native Windows job succeeds; when Windows fails, `check` explicitly fails rather than being skipped. Windows CI typechecks, runs the handoff tests and builds; the other tests rely on POSIX utilities, so use Linux or WSL for the full suite. After the local hook installer is merged into `main`, opt in with `pnpm -C plugin run hooks:install`; the pre-commit hook is not a substitute for CI. See [deployment checks](docs/006-deployment.md#development-checks).

## License

[MIT](LICENSE)
