# Contributing to Shotly

Contributions are welcome — bug reports, fixes, and features alike. Before
you open a pull request, three things are worth knowing.

## The licence

Shotly is published under the
[Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md)
(`FSL-1.1-ALv2`). In short: you may read, build, modify, and use Shotly for
any purpose except offering it, or something substantially like it, as a
competing commercial product. Two years after each version is released, that
version becomes available under the Apache License 2.0.

Shotly is also sold as a signed, notarized, auto-updating build under separate
commercial terms. The source is the same; only the licence on the binary
differs. This is why the next section exists.

## The contributor licence agreement

Every contributor must sign the [Contributor License Agreement](CLA.md) once.
It is short. You keep the copyright to everything you write; you grant the
owner of Shotly a licence broad enough to keep distributing the project under
both the FSL and commercial terms without having to ask every contributor each
time.

Signing is automated. When you open your first pull request a bot will ask
you to comment:

> I have read the CLA Document and I hereby sign the CLA

That comment is the signature. It is recorded in
[`.github/cla/signatures.json`](.github/cla/signatures.json) and you will not
be asked again.

Pull requests cannot be merged until the CLA check passes.

## Trademarks

"Shotly", the Shotly icon, and the name of this project are reserved. The
licence does not grant permission to use them; a fork must be called something
else.

## Working on the code

[docs/DEVELOPING.md](docs/DEVELOPING.md) covers running Shotly locally,
signing, the architecture, and the mistakes worth not repeating. A few
conventions that are easy to trip over:

- **Do not run `cargo fmt`.** The Rust source is formatted by hand and a
  formatter pass rewrites most of it. Match the style of the file you are in.
- **Comments explain why, not what.** Read a few files before writing any;
  the voice is consistent and worth keeping.
- **Keep pull requests to one change.** A fix and a refactor are two pull
  requests.
- **Build with `npm run bundle` and test the installed app**, not `tauri dev`
  — several capture paths behave differently under the harness, and macOS
  permission grants are tied to the signed bundle.

## Reporting bugs

Open an issue with the Shotly version (About Shotly shows it), your macOS
version, and what you expected to happen. A screen recording of the problem
is worth a great deal; Shotly can make one.
