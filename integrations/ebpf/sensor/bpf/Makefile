# OGR eBPF sensor — kernel object + userspace loader.
#
# Builds ogr_sensor.bpf.o (CO-RE, architecture-independent) and the `ogr-sensor`
# loader. vmlinux.h is generated from the running kernel's BTF, so there is no
# committed kernel header to drift. Requires clang, bpftool, and libbpf-dev.
#
#   make            # vmlinux.h -> ogr_sensor.bpf.o -> ogr-sensor
#   make clean

CLANG    ?= clang
# Prefer a bpftool that actually runs. Ubuntu's /usr/sbin/bpftool is a wrapper
# that dispatches by *running* kernel version and fails when that exact
# linux-tools package is absent; fall back to any versioned binary, which can
# still dump BTF from the file regardless of the running kernel. Ubuntu has
# shipped both /usr/lib/linux-tools/<version>/bpftool and
# /usr/lib/linux-tools-<version>/bpftool layouts, so search both via find.
BPFTOOL  ?= $(shell if bpftool version >/dev/null 2>&1; then echo bpftool; \
	else find /usr/lib -maxdepth 2 -type f -name bpftool -print -quit 2>/dev/null; fi)
ARCH     := $(shell uname -m | sed 's/x86_64/x86/;s/aarch64/arm64/;s/ppc64le/powerpc/;s/mips.*/mips/')
BTF      ?= /sys/kernel/btf/vmlinux

BPF_CFLAGS := -g -O2 -target bpf -D__TARGET_ARCH_$(ARCH) -I. -Wall
LDLIBS     := -lbpf -lelf -lz

.PHONY: all clean
all: ogr-sensor

vmlinux.h:
	@test -n "$(BPFTOOL)" || { \
		echo "error: bpftool not found; install bpftool or a linux-tools package" >&2; \
		exit 1; \
	}
	$(BPFTOOL) btf dump file $(BTF) format c > $@

ogr_sensor.bpf.o: ogr_sensor.bpf.c ogr_sensor.h vmlinux.h
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@
	@# clang -g -target bpf emits the .BTF section libbpf needs; no gen-object
	@# link step (it is single-file and would need a version-matched bpftool).

ogr-sensor: loader.c ogr_sensor.h ogr_sensor.bpf.o
	$(CC) -g -O2 -Wall -I. loader.c -o $@ $(LDLIBS)

clean:
	rm -f ogr-sensor ogr_sensor.bpf.o vmlinux.h
