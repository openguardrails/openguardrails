/*
 * libogr-observe: what a sandboxed process opens and runs, on Linux.
 *
 * Loaded with LD_PRELOAD by `openguardrails run`. Each open and exec that goes through libc is
 * appended as one line to the file named by OGR_OBSERVE_LOG. This is telemetry, not a boundary: a
 * statically linked program (most Go binaries) or a raw system call is not seen, and the sandbox's
 * own rules, not this library, decide what is allowed.
 *
 * A line is "<ms>\t<action>\t<pid>\t<comm>\t<path>\n", action being read, write or exec. Lines are
 * written with one write() on an O_APPEND descriptor, so lines from many processes do not interleave.
 * A Unix socket is not used because the sandbox's seccomp filter forbids creating one.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <unistd.h>

/*
 * The log is opened for each line rather than once: a process about to exec often closes every
 * descriptor (Python's subprocess does), and a kept descriptor whose number was reused would write
 * into someone else's file.
 */
static char log_path[1024];
static __thread int busy;

__attribute__((constructor)) static void ogr_find_log(void) {
  const char *path = getenv("OGR_OBSERVE_LOG");
  if (path && strlen(path) < sizeof log_path) strcpy(log_path, path);
}

/* Paths every process opens on its way up, which say nothing about what it was asked to do. */
static int routine(const char *path) {
  static const char *prefixes[] = {"/proc/", "/sys/", "/dev/", "/etc/ld.so", "/usr/lib/locale/", "/usr/share/locale/", NULL};
  if (!path || !*path) return 1;
  for (int i = 0; prefixes[i]; i++) if (strncmp(path, prefixes[i], strlen(prefixes[i])) == 0) return 1;
  return 0;
}

static void note(const char *action, int dirfd, const char *path) {
  if (!log_path[0] || busy || routine(path)) return;
  busy = 1;
  char full[4096];
  const char *shown = path;
  if (path[0] != '/') {
    char base[2048];
    ssize_t n = -1;
    if (dirfd == AT_FDCWD) {
      if (getcwd(base, sizeof base)) n = (ssize_t)strlen(base);
    } else {
      char link[64];
      snprintf(link, sizeof link, "/proc/self/fd/%d", dirfd);
      n = readlink(link, base, sizeof base - 1);
    }
    if (n > 0) {
      base[n] = 0;
      snprintf(full, sizeof full, "%s/%s", base, path);
      shown = full;
    }
  }
  char comm[32] = "?";
  int cfd = (int)syscall(SYS_openat, AT_FDCWD, "/proc/self/comm", O_RDONLY | O_CLOEXEC);
  if (cfd >= 0) {
    ssize_t n = read(cfd, comm, sizeof comm - 1);
    close(cfd);
    if (n > 0) comm[n - (comm[n - 1] == '\n')] = 0;
  }
  struct timeval tv;
  gettimeofday(&tv, NULL);
  char line[4352];
  int len = snprintf(line, sizeof line, "%lld\t%s\t%d\t%s\t%s\n", (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000, action, (int)getpid(), comm, shown);
  if (len > 0) {
    if (len >= (int)sizeof line) {
      len = sizeof line;
      line[len - 1] = '\n';
    }
    /* Tabs and newlines in a path would break the line; such a path is dropped rather than mangled. */
    if (!strpbrk(shown, "\t\n")) {
      int fd = (int)syscall(SYS_openat, AT_FDCWD, log_path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
      if (fd >= 0) {
        (void)!write(fd, line, (size_t)len);
        close(fd);
      }
    }
  }
  busy = 0;
}

/* A PATH search tries every directory in turn; only the one that exists was run. */
static void note_exec(const char *path) {
  if (path && (!strchr(path, '/') || access(path, X_OK) == 0)) note("exec", AT_FDCWD, path);
}

static const char *access_of(int flags) { return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) ? "write" : "read"; }

#define REAL(name, type) static type real_##name; if (!real_##name) real_##name = (type)dlsym(RTLD_NEXT, #name)

typedef int (*open_t)(const char *, int, ...);
typedef int (*openat_t)(int, const char *, int, ...);
typedef FILE *(*fopen_t)(const char *, const char *);
typedef int (*creat_t)(const char *, mode_t);
typedef int (*execve_t)(const char *, char *const[], char *const[]);
typedef int (*execv_t)(const char *, char *const[]);
typedef int (*spawn_t)(pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *, char *const[], char *const[]);

static int mode_arg(int flags, va_list ap) { return (flags & O_CREAT) || (flags & __O_TMPFILE) == __O_TMPFILE ? va_arg(ap, int) : 0; }

int open(const char *path, int flags, ...) {
  REAL(open, open_t);
  va_list ap; va_start(ap, flags); int mode = mode_arg(flags, ap); va_end(ap);
  note(access_of(flags), AT_FDCWD, path);
  return real_open(path, flags, mode);
}
int open64(const char *path, int flags, ...) {
  REAL(open64, open_t);
  va_list ap; va_start(ap, flags); int mode = mode_arg(flags, ap); va_end(ap);
  note(access_of(flags), AT_FDCWD, path);
  return real_open64(path, flags, mode);
}
int openat(int dirfd, const char *path, int flags, ...) {
  REAL(openat, openat_t);
  va_list ap; va_start(ap, flags); int mode = mode_arg(flags, ap); va_end(ap);
  note(access_of(flags), dirfd, path);
  return real_openat(dirfd, path, flags, mode);
}
int openat64(int dirfd, const char *path, int flags, ...) {
  REAL(openat64, openat_t);
  va_list ap; va_start(ap, flags); int mode = mode_arg(flags, ap); va_end(ap);
  note(access_of(flags), dirfd, path);
  return real_openat64(dirfd, path, flags, mode);
}
int creat(const char *path, mode_t mode) {
  REAL(creat, creat_t);
  note("write", AT_FDCWD, path);
  return real_creat(path, mode);
}
int creat64(const char *path, mode_t mode) {
  REAL(creat64, creat_t);
  note("write", AT_FDCWD, path);
  return real_creat64(path, mode);
}
/* glibc's fopen opens through an internal call this library cannot see. */
FILE *fopen(const char *path, const char *mode) {
  REAL(fopen, fopen_t);
  note(strpbrk(mode, "wa+") ? "write" : "read", AT_FDCWD, path);
  return real_fopen(path, mode);
}
FILE *fopen64(const char *path, const char *mode) {
  REAL(fopen64, fopen_t);
  note(strpbrk(mode, "wa+") ? "write" : "read", AT_FDCWD, path);
  return real_fopen64(path, mode);
}

int execve(const char *path, char *const argv[], char *const envp[]) {
  REAL(execve, execve_t);
  note_exec(path);
  return real_execve(path, argv, envp);
}
int execv(const char *path, char *const argv[]) {
  REAL(execv, execv_t);
  note_exec(path);
  return real_execv(path, argv);
}
int execvp(const char *file, char *const argv[]) {
  REAL(execvp, execv_t);
  note_exec(file);
  return real_execvp(file, argv);
}
int execvpe(const char *file, char *const argv[], char *const envp[]) {
  REAL(execvpe, execve_t);
  note_exec(file);
  return real_execvpe(file, argv, envp);
}
int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions, const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  REAL(posix_spawn, spawn_t);
  note_exec(path);
  return real_posix_spawn(pid, path, actions, attr, argv, envp);
}
int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions, const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  REAL(posix_spawnp, spawn_t);
  note_exec(file);
  return real_posix_spawnp(pid, file, actions, attr, argv, envp);
}
