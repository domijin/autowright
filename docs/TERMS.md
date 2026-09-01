# Terms of service

Autowright is free, open source software released under the MIT License (see
`LICENSE`). These terms explain what that means in practice when you install and
use the app, and they never narrow what the license grants you.

## No account, no service

There is no Autowright server, account, or subscription. The app, its background
service, and every automation run entirely on your own computer. Nothing is
operated for you, so there is nothing to sign up for and nothing that can be
suspended or shut off remotely.

## No warranty

Autowright is provided "as is", without warranty of any kind, express or
implied, including fitness for a particular purpose. It is an early release
under active development; features may change or break between versions.

## Your automations are your responsibility

- Automation scripts are written by the AI agent you connect and executed only
  after you review and approve them. Those scripts can do anything your user
  account can do on this computer: read and write files, reach the network, and
  run other programs. The engine is not a sandbox.
- Read every change before you accept and execute it. You are responsible for
  what your automations do, including what they send, delete, or purchase, and
  for making sure they comply with the law and with the terms of any website or
  service they access.
- Secret values are stored in the operating system's secret store and injected
  only at run time, but a script you approve can still transmit a value it is
  given. Grant secrets to an automation only after reading what it does with them.

## Third-party agents, models, and services

Claude Code, Gemini CLI, Codex, OpenCode, Ollama, and any model or service they
reach are provided by their respective vendors under their own terms and
privacy policies, using your own accounts. Any cost they charge is yours. The
same applies to any service an automation of yours talks to.

## Updates

Update checks and downloads come from GitHub, as described in `PRIVACY.md`. You
choose whether and when to install an update, and you can turn automatic checks
off in the app.

## Limitation of liability

To the fullest extent permitted by law, the author is not liable for any damage
or loss arising from the use of Autowright or from anything your automations do,
whether direct, indirect, incidental, or consequential.

## Changes

These terms live at the root of the repository; any change to them is visible
in the project's git history. Questions and reports go to
https://github.com/hansololz/autowright/issues.

_Last updated: 2026-08-28_
