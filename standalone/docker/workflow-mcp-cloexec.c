#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

__attribute__((constructor)) static void restore_lock_cloexec(void) {
  const char *raw = getenv("WORKFLOW_MCP_SET_CLOEXEC_FD");
  if (raw == NULL) return;
  char *end = NULL;
  errno = 0;
  long parsed = strtol(raw, &end, 10);
  if (errno != 0 || end == raw || *end != '\0' || parsed < 3 || parsed > INT_MAX) {
    dprintf(STDERR_FILENO, "workflow-mcp-lock: invalid inherited descriptor marker\n");
    _exit(78);
  }
  int fd = (int)parsed;
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) != 0) {
    dprintf(STDERR_FILENO, "workflow-mcp-lock: cannot restore close-on-exec descriptor\n");
    _exit(78);
  }

  // Leaving LD_PRELOAD in the daemon environment would inject this library into every Codex and
  // shell command. Removing both bootstrap variables here keeps the mechanism single-use while
  // retaining WORKFLOW_MCP_LOCK_FD for the TypeScript ownership backend.
  unsetenv("WORKFLOW_MCP_SET_CLOEXEC_FD");
  unsetenv("LD_PRELOAD");
}
