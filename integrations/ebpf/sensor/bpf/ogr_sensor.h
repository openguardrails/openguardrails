/* SPDX-License-Identifier: Apache-2.0 */
/*
 * OGR eBPF sensor — event ABI shared byte-for-byte between the kernel program
 * (ogr_sensor.bpf.c) and the userspace loader (loader.c).
 *
 * The sensor observes the three sandbox-altitude actions the OGR spec assigns
 * to real kernel behavior — exec, file open, network connect — for one agent
 * process tree, and hands each to userspace over a ring buffer. The loader
 * renders these into the stable `ogr.ebpf.sensor/1` NDJSON line format; the
 * Python PEP maps that to an OGR GuardEvent. Nothing in this struct is
 * OGR-vendor specific: a different kernel technology can emit the same records
 * and reuse the entire userspace half.
 */
#ifndef OGR_SENSOR_H
#define OGR_SENSOR_H

#define OGR_COMM_LEN 16
#define OGR_PATH_LEN 256
#define OGR_ARGS_LEN 256

/* enum ogr_evt_kind — the observed action class. */
#define OGR_EVT_EXEC 0    /* sched_process_exec: a new program image */
#define OGR_EVT_FILE 1    /* openat/open exit: a path was read or written */
#define OGR_EVT_NET 2     /* connect: an egress connection was opened */

/* file access bits (OGR_EVT_FILE) */
#define OGR_ACC_READ 1
#define OGR_ACC_WRITE 2

struct ogr_event {
	unsigned long long timestamp_ns;
	unsigned int kind;      /* OGR_EVT_* */
	unsigned int pid;       /* tgid of the acting process */
	unsigned int ppid;      /* parent tgid */
	unsigned int root_pid;  /* tracked-tree root — the session correlation key */
	unsigned int uid;
	unsigned int access;    /* OGR_EVT_FILE: OGR_ACC_* bitmask */
	unsigned int addr_ip;   /* OGR_EVT_NET: IPv4, network byte order */
	unsigned int args_len;  /* OGR_EVT_EXEC: bytes of NUL-separated argv in args[] */
	unsigned short addr_port;/* OGR_EVT_NET: TCP/UDP port, network byte order (loader ntohs) */
	unsigned short _pad;
	char comm[OGR_COMM_LEN];
	char path[OGR_PATH_LEN];/* exec: program path; file: opened path; net: unused */
	char args[OGR_ARGS_LEN];/* exec: argv blob, NUL-separated; else empty */
};

#endif /* OGR_SENSOR_H */
