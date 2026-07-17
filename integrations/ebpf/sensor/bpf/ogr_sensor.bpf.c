// SPDX-License-Identifier: Apache-2.0
/*
 * OGR eBPF sensor — kernel program.
 *
 * Tracks one agent process tree (seeded by the loader with a root pid,
 * propagated across fork) and emits an `ogr_event` into a ring buffer for
 * every exec / file open / network connect inside that tree. Observation only:
 * the kernel does not block here, so the sensor loads on any 5.8+ kernel with
 * CO-RE (no BPF-LSM required). The userspace PEP asks the OGR runtime for a
 * verdict and enforces (e.g. kills the pid) — the "verify side effects"
 * altitude of the OGR model.
 *
 * Verifier discipline (see bpf/README.md): events are written straight into a
 * ring-buffer reservation (never a large stack struct), every user read is
 * length-clamped to a constant-bounded size, and per-tid stash maps carry the
 * open/connect argument from enter to exit.
 */
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>
#include "ogr_sensor.h"

char LICENSE[] SEC("license") = "Dual BSD/GPL";

#ifndef AF_INET
#define AF_INET 2
#endif
/* open flags (avoid pulling in UAPI headers under CO-RE) */
#define OGR_O_ACCMODE 00000003
#define OGR_O_WRONLY  00000001
#define OGR_O_RDWR    00000002
#define OGR_O_CREAT   00000100
#define OGR_O_TRUNC   00001000

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 24); /* 16 MiB */
} rb SEC(".maps");

/* pid (tgid) -> root_pid of the tracked tree. Membership == "in the map". */
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 65536);
	__type(key, __u32);
	__type(value, __u32);
} tracked SEC(".maps");

/* per-tid stash: user path pointer + flags from openat enter to exit */
struct open_pend {
	__u64 path_ptr;
	__u32 flags;
};
struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 10240);
	__type(key, __u64);
	__type(value, struct open_pend);
} open_pend SEC(".maps");

/* per-tid stash: user sockaddr pointer from connect enter to exit */
struct conn_pend {
	__u64 addr_ptr;
};
struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 10240);
	__type(key, __u64);
	__type(value, struct conn_pend);
} conn_pend SEC(".maps");

static __always_inline __u32 *tracked_root(__u32 pid)
{
	return bpf_map_lookup_elem(&tracked, &pid);
}

static __always_inline void fill_common(struct ogr_event *e, __u32 pid, __u32 root)
{
	e->timestamp_ns = bpf_ktime_get_ns();
	e->pid = pid;
	e->root_pid = root;
	e->uid = (__u32)bpf_get_current_uid_gid();
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	e->ppid = (__u32)BPF_CORE_READ(task, real_parent, tgid);
	bpf_get_current_comm(e->comm, sizeof(e->comm));
}

/* -- process tree tracking ------------------------------------------------ */

SEC("tp/sched/sched_process_fork")
int ogr_on_fork(struct trace_event_raw_sched_process_fork *ctx)
{
	__u32 parent = (__u32)(bpf_get_current_pid_tgid() >> 32);
	__u32 *root = tracked_root(parent);
	if (!root)
		return 0;
	__u32 child = (__u32)ctx->child_pid;
	__u32 r = *root;
	bpf_map_update_elem(&tracked, &child, &r, BPF_ANY);
	return 0;
}

SEC("tp/sched/sched_process_exit")
int ogr_on_exit(struct trace_event_raw_sched_process_template *ctx)
{
	__u64 id = bpf_get_current_pid_tgid();
	__u32 pid = (__u32)(id >> 32);
	if (pid != (__u32)id) /* thread exit, not process */
		return 0;
	bpf_map_delete_elem(&tracked, &pid);
	return 0;
}

/* -- exec ----------------------------------------------------------------- */

SEC("tp/sched/sched_process_exec")
int ogr_on_exec(struct trace_event_raw_sched_process_exec *ctx)
{
	__u32 pid = (__u32)(bpf_get_current_pid_tgid() >> 32);
	__u32 *root = tracked_root(pid);
	if (!root)
		return 0;

	struct ogr_event *e = bpf_ringbuf_reserve(&rb, sizeof(*e), 0);
	if (!e)
		return 0;
	__builtin_memset(e, 0, sizeof(*e));
	e->kind = OGR_EVT_EXEC;
	fill_common(e, pid, *root);

	/* program path from the tracepoint's data-loc field */
	unsigned fname_off = ctx->__data_loc_filename & 0xFFFF;
	bpf_probe_read_str(e->path, sizeof(e->path), (void *)ctx + fname_off);

	/* argv blob (NUL-separated) from the new mm's arg area, length-clamped */
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	unsigned long a0 = BPF_CORE_READ(task, mm, arg_start);
	unsigned long a1 = BPF_CORE_READ(task, mm, arg_end);
	if (a0 && a1 > a0) {
		__u32 len = (__u32)(a1 - a0);
		if (len > OGR_ARGS_LEN - 1)
			len = OGR_ARGS_LEN - 1;
		/* Mask so the verifier sees a bounded size: clang otherwise reuses
		 * the untruncated (a1 - a0), which is unbounded → "R2 min value is
		 * negative". OGR_ARGS_LEN is a power of two, so this bounds to
		 * [0, 255] without changing the already-clamped value. */
		len &= (OGR_ARGS_LEN - 1);
		if (len && bpf_probe_read_user(e->args, len, (void *)a0) == 0)
			e->args_len = len;
	}

	bpf_ringbuf_submit(e, 0);
	return 0;
}

/* -- file open ------------------------------------------------------------ */

static __always_inline int stash_open(__u64 path_ptr, __u32 flags)
{
	__u64 tid = bpf_get_current_pid_tgid();
	__u32 pid = (__u32)(tid >> 32);
	if (!tracked_root(pid))
		return 0;
	/* memset so the struct's tail padding is initialized — the verifier reads
	 * the whole sizeof (16 with 8-byte alignment) as a map value. */
	struct open_pend p;
	__builtin_memset(&p, 0, sizeof(p));
	p.path_ptr = path_ptr;
	p.flags = flags;
	bpf_map_update_elem(&open_pend, &tid, &p, BPF_ANY);
	return 0;
}

static __always_inline __u32 access_from_flags(__u32 flags)
{
	__u32 acc = 0;
	__u32 mode = flags & OGR_O_ACCMODE;
	if (mode == OGR_O_WRONLY || mode == OGR_O_RDWR)
		acc |= OGR_ACC_WRITE;
	else
		acc |= OGR_ACC_READ;
	if (flags & (OGR_O_CREAT | OGR_O_TRUNC))
		acc |= OGR_ACC_WRITE;
	return acc;
}

static __always_inline int emit_open_exit(long ret)
{
	__u64 tid = bpf_get_current_pid_tgid();
	__u32 pid = (__u32)(tid >> 32);
	struct open_pend *p = bpf_map_lookup_elem(&open_pend, &tid);
	if (!p)
		return 0;
	__u64 path_ptr = p->path_ptr;
	__u32 flags = p->flags;
	bpf_map_delete_elem(&open_pend, &tid);
	if (ret < 0)
		return 0;
	__u32 *root = tracked_root(pid);
	if (!root)
		return 0;

	struct ogr_event *e = bpf_ringbuf_reserve(&rb, sizeof(*e), 0);
	if (!e)
		return 0;
	__builtin_memset(e, 0, sizeof(*e));
	e->kind = OGR_EVT_FILE;
	e->access = access_from_flags(flags);
	fill_common(e, pid, *root);
	/* the successful open means the path page is resident — read is reliable */
	bpf_probe_read_user_str(e->path, sizeof(e->path), (void *)path_ptr);
	bpf_ringbuf_submit(e, 0);
	return 0;
}

SEC("tp/syscalls/sys_enter_openat")
int ogr_openat_enter(struct trace_event_raw_sys_enter *ctx)
{
	/* openat(dfd, filename, flags, mode) */
	return stash_open((__u64)ctx->args[1], (__u32)ctx->args[2]);
}

SEC("tp/syscalls/sys_exit_openat")
int ogr_openat_exit(struct trace_event_raw_sys_exit *ctx)
{
	return emit_open_exit(ctx->ret);
}

SEC("tp/syscalls/sys_enter_open")
int ogr_open_enter(struct trace_event_raw_sys_enter *ctx)
{
	/* open(filename, flags, mode) */
	return stash_open((__u64)ctx->args[0], (__u32)ctx->args[1]);
}

SEC("tp/syscalls/sys_exit_open")
int ogr_open_exit(struct trace_event_raw_sys_exit *ctx)
{
	return emit_open_exit(ctx->ret);
}

/* -- network connect ------------------------------------------------------ */

SEC("tp/syscalls/sys_enter_connect")
int ogr_connect_enter(struct trace_event_raw_sys_enter *ctx)
{
	__u64 tid = bpf_get_current_pid_tgid();
	__u32 pid = (__u32)(tid >> 32);
	if (!tracked_root(pid))
		return 0;
	struct conn_pend p;
	__builtin_memset(&p, 0, sizeof(p));
	p.addr_ptr = (__u64)ctx->args[1];
	bpf_map_update_elem(&conn_pend, &tid, &p, BPF_ANY);
	return 0;
}

SEC("tp/syscalls/sys_exit_connect")
int ogr_connect_exit(struct trace_event_raw_sys_exit *ctx)
{
	__u64 tid = bpf_get_current_pid_tgid();
	__u32 pid = (__u32)(tid >> 32);
	struct conn_pend *p = bpf_map_lookup_elem(&conn_pend, &tid);
	if (!p)
		return 0;
	__u64 addr_ptr = p->addr_ptr;
	bpf_map_delete_elem(&conn_pend, &tid);
	/* ret 0 = connected; -EINPROGRESS (nonblocking) still means egress attempt */
	long ret = ctx->ret;
	if (ret != 0 && ret != -115 /* EINPROGRESS */)
		return 0;
	__u32 *root = tracked_root(pid);
	if (!root || !addr_ptr)
		return 0;

	struct sockaddr_in sa = {};
	if (bpf_probe_read_user(&sa, sizeof(sa), (void *)addr_ptr) != 0)
		return 0;
	if (sa.sin_family != AF_INET)
		return 0;

	struct ogr_event *e = bpf_ringbuf_reserve(&rb, sizeof(*e), 0);
	if (!e)
		return 0;
	__builtin_memset(e, 0, sizeof(*e));
	e->kind = OGR_EVT_NET;
	e->addr_ip = sa.sin_addr.s_addr;                 /* network order */
	e->addr_port = sa.sin_port;                      /* network order; loader ntohs */
	fill_common(e, pid, *root);
	bpf_ringbuf_submit(e, 0);
	return 0;
}
