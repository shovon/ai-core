# Changesets

A changeset is a small file in this folder. It says which published packages a change affects, how big the change is for each, and what to tell the people who use them. [Changesets](https://changesets.dev) turns the files into version numbers and changelogs.

The published packages are `@ai-idioms/core` and `@ai-idioms/anthropic-provider`. A pull request that changes neither needs no changeset.

## Add one

At the repo's root, run this and commit the file it writes:

```sh
npx changeset
```

It asks which packages changed, how big each change is, and for a summary. The summary goes into the package's changelog as it is, so write it for someone who uses the package.

The same without the questions:

```sh
npx changeset add --patch @ai-idioms/core -m "Say what changed."
```

## How big

While the packages are below 1.0:

- A change that breaks code written against the package is a `minor`.
- Anything else is a `patch`.

A range like `^0.1.0` admits patch releases only. So a minor is the smallest release nobody gets without asking for it.

## What becomes of them

`npm run version-packages` uses up every changeset in this folder:

- It raises each package's version by the biggest change named for it.
- It writes the summaries into each package's `CHANGELOG.md`.
- When core moves out of the range the provider depends on, it rewrites that range and gives the provider a patch release.
- It brings `package-lock.json` up to date.

It fails if there are no changesets. Publishing what it versions is not set up yet: see [#17](https://github.com/shovon/ai-core/issues/17).
