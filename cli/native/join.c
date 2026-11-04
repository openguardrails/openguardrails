/*
 * ogr-join: run a command inside a sandbox that is already running, on Linux.
 *
 *   ogr-join <holder-pid> <directory> <command> [args...]
 *
 * `openguardrails sandbox start` keeps one process, the holder, alive in a sandbox; `openguardrails
 * run --in <name>` uses this to start another command beside it. The command then shares the
 * sandbox's processes, files, network and devices, so programs that look for each other (ps, a pid
 * in a lock file) still find each other.
 *
 * bubblewrap nests two user namespaces: the network, mount and PID namespaces belong to the outer
 * one, and the holder lives in the inner one. Entering a namespace needs privilege in the user
 * namespace that owns it, so the order is: the owner, then network, mount and PID, then the holder's
 * own user namespace. Every capability that gives is dropped before the command runs, and
 * no_new_privs is set, as bubblewrap does for its own processes. This must be a single-threaded
 * program: the kernel refuses to move a multithreaded process into a user namespace.
 *
 * The command is started as a child, in the sandbox's PID namespace, and this process waits for it,
 * passes on the signals a service manager sends, and exits with its status.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef NS_GET_USERNS
#define NS_GET_USERNS 0xb701
#endif

static pid_t child = -1;

static void die(const char *what) {
  fprintf(stderr, "ogr-join: %s: %s\n", what, strerror(errno));
  exit(126);
}

static int open_ns(const char *pid, const char *ns) {
  char path[64];
  snprintf(path, sizeof path, "/proc/%s/ns/%s", pid, ns);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) die(path);
  return fd;
}

static ino_t inode(int fd) {
  struct stat st;
  if (fstat(fd, &st) != 0) die("fstat");
  return st.st_ino;
}

static void enter(int fd, const char *what) {
  if (setns(fd, 0) != 0) die(what);
}

static void drop_privileges(void) {
  for (int cap = 0; cap <= 63; cap++) {
    if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) != 0 && errno != EINVAL) die("dropping the capability bounding set");
  }
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0 && errno != EINVAL) die("clearing ambient capabilities");
  struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct data[2];
  memset(data, 0, sizeof data);
  if (syscall(SYS_capset, &header, data) != 0) die("clearing capabilities");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) die("setting no_new_privs");
}

static void forward(int signal) {
  if (child > 0) kill(child, signal);
}

int main(int argc, char **argv) {
  if (argc < 4) {
    fprintf(stderr, "usage: ogr-join <holder-pid> <directory> <command> [args...]\n");
    return 2;
  }
  const char *pid = argv[1];
  for (const char *p = pid; *p; p++) if (*p < '0' || *p > '9') { fprintf(stderr, "ogr-join: %s is not a pid\n", pid); return 2; }

  int user = open_ns(pid, "user"), net = open_ns(pid, "net"), mnt = open_ns(pid, "mnt"), pidns = open_ns(pid, "pid");
  int net_owner = ioctl(net, NS_GET_USERNS);
  int mnt_owner = ioctl(mnt, NS_GET_USERNS);
  int pid_owner = ioctl(pidns, NS_GET_USERNS);
  if (net_owner < 0 || mnt_owner < 0 || pid_owner < 0) die("finding the namespaces' owner");

  enter(net_owner, "entering the sandbox's outer user namespace");
  enter(net, "entering the sandbox's network");
  if (inode(mnt_owner) != inode(net_owner)) enter(mnt_owner, "entering the mount namespace's owner");
  enter(mnt, "entering the sandbox's files");
  if (inode(pid_owner) != inode(mnt_owner)) enter(pid_owner, "entering the PID namespace's owner");
  enter(pidns, "entering the sandbox's processes");
  if (inode(user) != inode(pid_owner)) enter(user, "entering the sandbox's user namespace");
  drop_privileges();
  if (chdir(argv[2]) != 0) die(argv[2]);

  struct sigaction action = {0};
  action.sa_handler = forward;
  for (int s = 1; s < NSIG; s++) {
    if (s == SIGKILL || s == SIGSTOP || s == SIGCHLD) continue;
    sigaction(s, &action, NULL);
  }
  child = fork();
  if (child < 0) die("fork");
  if (child == 0) {
    signal(SIGINT, SIG_DFL);
    signal(SIGTERM, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    /* A join that is killed outright takes its command with it, as bubblewrap does for a run. */
    prctl(PR_SET_PDEATHSIG, SIGKILL);
    execvp(argv[3], argv + 3);
    fprintf(stderr, "ogr-join: %s: %s\n", argv[3], strerror(errno));
    _exit(127);
  }
  int status;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) die("waitpid");
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}
