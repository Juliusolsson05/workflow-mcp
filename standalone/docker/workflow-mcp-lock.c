#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define CLOEXEC_LIBRARY "/opt/workflow-mcp/native/libworkflow_mcp_cloexec.so"
#define OWNER_CONFLICT_EXIT 75

static void die(const char *message) {
  fprintf(stderr, "workflow-mcp-lock: %s: %s\n", message, strerror(errno));
  exit(78);
}

static void reject(const char *message) {
  fprintf(stderr, "workflow-mcp-lock: %s\n", message);
  exit(78);
}

int main(int argc, char **argv) {
  if (argc < 3) {
    reject("usage: workflow-mcp-lock ABSOLUTE_LOCK_PATH COMMAND [ARG ...]");
  }
  if (argv[1][0] != '/') {
    reject("lock path must be absolute");
  }

  // This launcher is the only process allowed to create the immutable coordination inode. Doing
  // it before Node starts ensures layout inspection and crash repair can never race another owner.
  // umask is process-local and survives exec, which also keeps later daemon-created secrets private.
  umask(0077);
  char *path_copy = strdup(argv[1]);
  if (path_copy == NULL) die("cannot allocate lock path");
  char *coordination = dirname(path_copy);
  if (mkdir(coordination, 0700) != 0 && errno != EEXIST) {
    die("cannot create coordination directory");
  }
  struct stat directory_stat;
  if (lstat(coordination, &directory_stat) != 0) die("cannot inspect coordination directory");
  if (!S_ISDIR(directory_stat.st_mode) || directory_stat.st_uid != getuid() ||
      (directory_stat.st_mode & 0077) != 0) {
    reject("coordination directory must be an owner-only directory owned by the runtime UID");
  }

  int fd = open(argv[1], O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) die("cannot open coordination lock");
  struct stat lock_stat;
  if (fstat(fd, &lock_stat) != 0) die("cannot inspect coordination lock");
  if (!S_ISREG(lock_stat.st_mode) || lock_stat.st_uid != getuid() ||
      (lock_stat.st_mode & 0777) != 0600 || lock_stat.st_nlink != 1) {
    reject("coordination lock must be one owner-only regular-file link owned by the runtime UID");
  }
  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    if (errno == EWOULDBLOCK || errno == EAGAIN) {
      fprintf(stderr, "workflow-mcp-lock: another durable workflow owner holds %s\n", argv[1]);
      return OWNER_CONFLICT_EXIT;
    }
    die("cannot acquire coordination lock");
  }

  char descriptor[32];
  if (snprintf(descriptor, sizeof(descriptor), "%d", fd) >= (int)sizeof(descriptor)) {
    reject("coordination descriptor does not fit environment contract");
  }
  if (setenv("WORKFLOW_MCP_LOCK_FD", descriptor, 1) != 0 ||
      setenv("WORKFLOW_MCP_LOCK_PATH", argv[1], 1) != 0 ||
      setenv("WORKFLOW_MCP_SET_CLOEXEC_FD", descriptor, 1) != 0 ||
      setenv("LD_PRELOAD", CLOEXEC_LIBRARY, 1) != 0) {
    die("cannot publish inherited lock contract");
  }

  // O_CLOEXEC protects every ordinary child, but one exec must cross into Node. The preload
  // constructor immediately restores FD_CLOEXEC before Node main runs and removes itself from the
  // environment. That closes the small but important gap where provider children might otherwise
  // keep a dead daemon's flock alive.
  int descriptor_flags = fcntl(fd, F_GETFD);
  if (descriptor_flags < 0 || fcntl(fd, F_SETFD, descriptor_flags & ~FD_CLOEXEC) != 0) {
    die("cannot prepare coordination descriptor for daemon exec");
  }
  execvp(argv[2], &argv[2]);
  die("cannot exec durable workflow owner");
}
