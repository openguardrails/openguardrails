// SPDX-License-Identifier: Apache-2.0
/*
 * OGR eBPF sensor — userspace loader.
 *
 * Loads ogr_sensor.bpf.o, seeds the tracked-tree root, drains the ring buffer,
 * and prints one `ogr.ebpf.sensor/1` NDJSON line per event to stdout. This is
 * the stable kernel->userspace boundary the OGR eBPF sensor exposes: the
 * Python PEP (or any consumer) reads these lines and maps them to GuardEvents.
 *
 *   ogr-sensor --pid <pid>        attach to an already-running process tree
 *   ogr-sensor -- <cmd> [args...] fork/exec <cmd> under the sensor
 *
 * Diagnostics go to stderr; only NDJSON event records go to stdout, so the
 * stream can be piped straight into the PEP.
 */
#include <argp.h>
#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <arpa/inet.h>

#include "ogr_sensor.h"

static volatile sig_atomic_t exiting;
static void on_sigint(int sig) { (void)sig; exiting = 1; }

static int libbpf_print(enum libbpf_print_level level, const char *fmt, va_list args)
{
	if (level == LIBBPF_DEBUG)
		return 0;
	return vfprintf(stderr, fmt, args);
}

static void json_escape(FILE *out, const char *s, size_t max)
{
	for (size_t i = 0; i < max && s[i]; i++) {
		unsigned char c = (unsigned char)s[i];
		switch (c) {
		case '"': fputs("\\\"", out); break;
		case '\\': fputs("\\\\", out); break;
		case '\n': fputs("\\n", out); break;
		case '\r': fputs("\\r", out); break;
		case '\t': fputs("\\t", out); break;
		default:
			if (c < 0x20)
				fprintf(out, "\\u%04x", c);
			else
				fputc(c, out);
		}
	}
}

/* render the exec argv blob (NUL-separated) as a JSON string array */
static void print_argv(FILE *out, const char *blob, unsigned len)
{
	fputc('[', out);
	unsigned i = 0;
	int first = 1;
	while (i < len && i < OGR_ARGS_LEN) {
		const char *tok = blob + i;
		unsigned toklen = 0;
		while (i + toklen < len && i + toklen < OGR_ARGS_LEN && tok[toklen])
			toklen++;
		if (toklen == 0 && (i >= len || !tok[0])) { i++; continue; }
		if (!first) fputc(',', out);
		fputc('"', out);
		json_escape(out, tok, toklen);
		fputc('"', out);
		first = 0;
		i += toklen + 1;
	}
	fputc(']', out);
}

static int handle_event(void *ctx, void *data, size_t sz)
{
	(void)ctx;
	if (sz < sizeof(struct ogr_event))
		return 0;
	const struct ogr_event *e = data;

	fprintf(stdout,
		"{\"schema\":\"ogr.ebpf.sensor/1\",\"ts_ns\":%llu,"
		"\"pid\":%u,\"ppid\":%u,\"root_pid\":%u,\"uid\":%u,\"comm\":\"",
		e->timestamp_ns, e->pid, e->ppid, e->root_pid, e->uid);
	json_escape(stdout, e->comm, OGR_COMM_LEN);
	fputc('"', stdout);

	if (e->kind == OGR_EVT_EXEC) {
		fputs(",\"kind\":\"exec\",\"path\":\"", stdout);
		json_escape(stdout, e->path, OGR_PATH_LEN);
		fputs("\",\"argv\":", stdout);
		print_argv(stdout, e->args, e->args_len);
	} else if (e->kind == OGR_EVT_FILE) {
		const char *acc = (e->access & OGR_ACC_WRITE) ? "write" : "read";
		fprintf(stdout, ",\"kind\":\"file\",\"access\":\"%s\",\"path\":\"", acc);
		json_escape(stdout, e->path, OGR_PATH_LEN);
		fputc('"', stdout);
	} else if (e->kind == OGR_EVT_NET) {
		char ip[INET_ADDRSTRLEN] = {0};
		struct in_addr a = { .s_addr = e->addr_ip };
		inet_ntop(AF_INET, &a, ip, sizeof(ip));
		fprintf(stdout, ",\"kind\":\"network\",\"ip\":\"%s\",\"port\":%u,"
			"\"direction\":\"egress\"", ip, ntohs(e->addr_port));
	}
	fputs("}\n", stdout);
	fflush(stdout);
	return 0;
}

static int seed_pid(struct bpf_object *obj, unsigned pid)
{
	int fd = bpf_object__find_map_fd_by_name(obj, "tracked");
	if (fd < 0) {
		fprintf(stderr, "ogr-sensor: map 'tracked' not found\n");
		return -1;
	}
	unsigned root = pid;
	if (bpf_map_update_elem(fd, &pid, &root, BPF_ANY)) {
		fprintf(stderr, "ogr-sensor: seed pid %u failed: %s\n", pid, strerror(errno));
		return -1;
	}
	return 0;
}

int main(int argc, char **argv)
{
	unsigned attach_pid = 0;
	char **cmd = NULL;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--pid") && i + 1 < argc) {
			attach_pid = (unsigned)atoi(argv[++i]);
		} else if (!strcmp(argv[i], "--")) {
			if (i + 1 < argc) cmd = &argv[i + 1];
			break;
		}
	}
	if (!attach_pid && !cmd) {
		fprintf(stderr, "usage: ogr-sensor --pid <pid> | ogr-sensor -- <cmd> [args...]\n");
		return 2;
	}

	libbpf_set_print(libbpf_print);
	struct rlimit r = { RLIM_INFINITY, RLIM_INFINITY };
	setrlimit(RLIMIT_MEMLOCK, &r);

	/* the .bpf.o ships beside this binary; resolve it from /proc/self/exe */
	char path[2048];
	ssize_t n = readlink("/proc/self/exe", path, sizeof(path) - 1);
	char obj_path[2100];
	if (n > 0) {
		path[n] = 0;
		char *slash = strrchr(path, '/');
		if (slash) *slash = 0;
		snprintf(obj_path, sizeof(obj_path), "%s/ogr_sensor.bpf.o", path);
	} else {
		snprintf(obj_path, sizeof(obj_path), "ogr_sensor.bpf.o");
	}

	struct bpf_object *obj = bpf_object__open_file(obj_path, NULL);
	if (!obj || libbpf_get_error(obj)) {
		fprintf(stderr, "ogr-sensor: open %s failed\n", obj_path);
		return 1;
	}
	if (bpf_object__load(obj)) {
		fprintf(stderr, "ogr-sensor: load failed: %s\n", strerror(errno));
		return 1;
	}

	/* fork the target first (stopped) so we seed before its exec fires */
	pid_t child = 0;
	if (cmd) {
		child = fork();
		if (child == 0) {
			raise(SIGSTOP);       /* wait for the parent to seed us */
			execvp(cmd[0], cmd);
			fprintf(stderr, "ogr-sensor: exec %s failed: %s\n", cmd[0], strerror(errno));
			_exit(127);
		}
		attach_pid = (unsigned)child;
	}

	struct bpf_program *prog;
	bpf_object__for_each_program(prog, obj) {
		if (!bpf_program__attach(prog)) {
			fprintf(stderr, "ogr-sensor: attach %s failed\n",
				bpf_program__name(prog));
			return 1;
		}
	}

	if (seed_pid(obj, attach_pid))
		return 1;
	if (child)
		kill(child, SIGCONT);     /* release the target into exec */

	struct ring_buffer *rb = ring_buffer__new(
		bpf_object__find_map_fd_by_name(obj, "rb"), handle_event, NULL, NULL);
	if (!rb) {
		fprintf(stderr, "ogr-sensor: ringbuf open failed\n");
		return 1;
	}

	signal(SIGINT, on_sigint);
	signal(SIGTERM, on_sigint);
	fprintf(stderr, "ogr-sensor: watching root pid %u\n", attach_pid);
	while (!exiting) {
		int err = ring_buffer__poll(rb, 200 /* ms */);
		if (err == -EINTR)
			break;
		if (err < 0) {
			fprintf(stderr, "ogr-sensor: poll error %d\n", err);
			break;
		}
		if (child) {           /* stop when the launched tree is gone */
			int status;
			if (waitpid(child, &status, WNOHANG) == child)
				child = 0, exiting = 1;
		}
	}
	/* final drain: catch events emitted between the last poll and exit */
	while (ring_buffer__consume(rb) > 0)
		;

	ring_buffer__free(rb);
	bpf_object__close(obj);
	return 0;
}
