# Workflow reference corpus

This directory separates durable corpus documentation from raw evidence that may contain
machine-specific paths, private prompts, provider transcripts, or credentials.

## Layout

```text
references/
├── README.md                              # This policy and corpus index; safe to commit.
├── claude-code-workflow-tool-context.md   # The Workflow tool contract as the model sees it in-context; safe to commit.
├── claude-harness-workflow-tool.md        # A SPEC/OBSERVED/INFERENCE cross-check of the same live contract.
└── raw/                                   # Exact source evidence; deliberately gitignored.
```

The two committed Claude captures were written by the model from inside a live Claude Code
session (2026-07-15). `claude-code-workflow-tool-context.md` preserves the full in-context
Workflow definition with reconstructed contract text separated from commentary;
`claude-harness-workflow-tool.md` independently labels claims as SPEC, OBSERVED, or INFERENCE.
Together they document the *contract* side of compatibility; the raw corpus below documents the
*observed-behavior* side. Where they disagree, the corpus wins.

`raw/` is ignored as a whole. That is intentional: a workflow can be executable code, and
persisted run records can contain prompts and model output. Keeping the evidence beside the
future package makes compatibility work reproducible without turning an unreviewed local
archive into repository history.

Do not force-add anything from `raw/`. A reference may move into a committed fixture directory
only after all of the following are recorded:

1. provenance and an immutable source revision or local content hash;
2. redistribution license;
3. secret, identity, absolute-path, and private-context review;
4. whether the file is expected to pass or fail Claude compatibility validation;
5. the exact behavior the fixture exists to cover.

## Raw corpus assembled on 2026-07-14

The ignored corpus is organized as:

```text
raw/
├── local/
│   ├── project-workflows/     # Exact project and worktree `.claude/workflows/*.js` files.
│   └── claude-projects/       # Persisted scripts, runs, journals, and workflow-agent transcripts.
├── official/
│   └── code-modernization/    # Installed Anthropic plugin workflows and required agent definitions.
└── public/
    ├── anthropic/
    ├── tinyusb/
    ├── onion/
    ├── code-dot-org/
    ├── salesforce/
    └── microck/
```

The local and installed-plugin sources are byte-for-byte copies. Public files are downloaded
from commit-pinned URLs listed in the main README. The archive currently contains 835 files and is
about 58 MB; most of that is the 392 workflow-agent transcript/metadata pairs used to understand
real scheduling and resume behavior. The raw corpus is evidence, not vendored runtime code: it
must never be imported, built, packaged, or executed automatically.

Release validation does not depend on that private archive. A small synthetic, secret-reviewed,
MIT-licensed positive corpus is committed under `test/fixtures/workflow-corpus/`; the always-on
conformance test requires it to be non-empty. Raw evidence remains an optional larger compatibility
check and must still never be force-added.
