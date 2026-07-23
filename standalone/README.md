# Workflow MCP standalone

This directory is the isolated Docker product around the provider-neutral `workflow-mcp` core.
The daemon, MCP proxy, TUI, web application, image, Compose bundle, launchers, and registry metadata
live here. The core package does not import this package.

The product is under active implementation. The source-of-truth design and release gates are in
[`../docs/DOCKER_FIRST_CODEX_MCP_IMPLEMENTATION_PLAN.md`](../docs/DOCKER_FIRST_CODEX_MCP_IMPLEMENTATION_PLAN.md).
