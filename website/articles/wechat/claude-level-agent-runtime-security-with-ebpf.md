# 给 Claude 级 Agent 装上“内核安全带”：Anthropic 式零信任之下，我们用 eBPF 踩过的 9 个坑

> 当 AI Agent 已经能写代码、跑 Shell、读文件、连生产网络时，安全边界就不能只停留在 Prompt 和工具回调里。我们开源了 OpenGuardrails eBPF Sensor，把 Agent 的真实 `exec`、文件和网络行为送进一个厂商中立的安全协议。本文不讲概念包装，只讲架构、代码，以及我们真正踩过的坑。

开源地址：

https://github.com/openguardrails/openguardrails/tree/main/integrations/ebpf

## Claude 级 Agent，已经不是“更聪明的聊天机器人”

今天的 Coding Agent 可以完成一整段工作流：读取仓库、安装依赖、运行测试、调用云 API、提交代码，甚至操作生产环境。

能力越强，运行时的爆炸半径就越大。

一个 Agent 在工具层发出的动作可能只是：

```text
bash deploy.sh
```

但脚本真正运行之后，内核看到的可能是：

```text
execve("curl", ...)
openat("/home/runner/.ssh/id_rsa", ...)
connect("203.0.113.24:443")
execve("bash", ...)
```

工具 Hook 看到的是“意图”，内核看到的才是“事实”。

这正是 AI Agent 运行时安全与传统内容安全的分界线：模型有没有说危险的话是一件事；它最终有没有启动进程、读取密钥、连接陌生地址，是另一件事。

## 什么是“Anthropic 式零信任”

先做一个严谨说明：**Anthropic 并没有把它的公开方法正式命名为“Zero Trust Framework”**。本文所说的“Anthropic 式零信任”，是对 Anthropic 已公开的 Agent 安全工程原则的归纳。

Anthropic 在关于 Claude Code sandboxing 和 Claude containment 的工程文章里反复强调：不要只监督 Agent 想做什么，而要限制它实际上能够做什么。具体手段包括：

- 用操作系统级 sandbox、VM 和文件系统边界限制可触达范围；
- 默认限制网络出口，通过 egress proxy 控制目标地址；
- 把 Git、签名密钥等高价值凭证放在 sandbox 之外；
- 限定工具和外部内容的权限，降低 Prompt Injection 的爆炸半径；
- 让模型防御、环境隔离和外部内容治理彼此重叠，而不是押注某一个分类器永不漏判。

如果用零信任语言翻译，就是三句话：

1. 不因为动作来自 Claude、Codex 或某个“可信 Agent”就默认放行；
2. 每一个真实副作用都要有身份、上下文、策略和可审计的裁决；
3. 即使模型层被绕过，环境层仍然必须限制损失。

eBPF 正好位于这个环境层：它不相信 Agent 对动作的自我描述，而是观察 Linux 内核实际发生的行为。

但只有 eBPF 还不够。

企业里可能已经有多个安全厂商：一个擅长进程行为，一个擅长 DLP，一个擅长容器运行时，一个擅长 Agent Prompt Injection。每家都有自己的事件格式、风险分类和拦截接口。再接入第 N 个 Agent 框架，集成数量很快变成 N×M。

我们做 OpenGuardrails（OGR）的目的，就是在 eBPF Sensor 和安全能力之间放一个中立协议。

## 我们开源的架构：内核负责看见，OGR 负责让大家说同一种语言

```text
Claude / Codex / 自研 Agent
            |
            | fork / exec / open / connect
            v
    OGR eBPF Sensor（内核态）
            |
            | Ring Buffer
            v
       libbpf Loader
            |
            | ogr.ebpf.sensor/1 NDJSON
            v
     OGR PEP（用户态执行点）
            |
            | GuardEvent
            v
        OGR Runtime
       /      |       \
  厂商 A   厂商 B   企业规则
  EDR      DLP      allowlist
       \      |       /
            Verdict
              |
       allow / approval / block
```

Sensor 当前跟踪一个 Agent 进程树里的三类真实行为：

| 内核行为 | OGR Event | 关键字段 |
|---|---|---|
| 进程执行 | `exec` | `argv`、程序路径、PID/PPID、UID |
| 文件打开 | `file` | 路径、读/写、进程身份 |
| 网络连接 | `network` | IP、端口、方向、进程身份 |

用户态 PEP 把它们标准化成 `observation_point: "sandbox"` 的 OGR `GuardEvent`，交给一个或多个 Detector。每个 Detector 返回带 `provider` 身份的 `Verdict`，再由企业自己的组合策略决定最终结果。

例如：

```yaml
composition:
  "security.secret_leak":
    providers: [vendor.dlp, vendor.endpoint, enterprise.rules]
    strategy: deny-wins
    timeout_ms: 150
    on_all_failed: block

  "security.privilege_escalation":
    providers: [vendor.endpoint, vendor.runtime, vendor.agent]
    strategy: quorum
    quorum: { count: 2, min_score: 0.8 }
```

协议规定事件、裁决、风险分类、关联和组合机制；安全厂商继续竞争检测质量，企业继续拥有最终策略。

这才是“多厂商接入”应该有的形状：**Sensor 不绑定厂商，厂商不绑定 Agent，策略不被某一家产品接管。**

## 坑一：eBPF “看见了”不等于“阻止了”

这是最容易被宣传话术模糊的一点。

我们的参考 Sensor 使用 tracepoint：`sched_process_exec`、`sys_enter/exit_openat`、`sys_enter/exit_connect` 等。这类 Hook 覆盖面好，部署门槛相对低，但它们首先是观测点。

当用户态收到事件时，系统调用可能已经发生了。

所以当前实现对 `block` 的执行语义是 kill/contain：终止违规进程，限制后续损失。它不能保证收回已经读出的第一个字节，也不能假装一个已经完成的 syscall 还在等待人工审批。

如果要在动作提交前返回 `-EPERM`，需要进入 BPF LSM、cgroup 网络 Hook，或者更早的 Agent/Gateway 拦截点。

这也是 OGR 设计三层观测高度的原因：

- Gateway 看模型消息、工具定义和数据来源；
- Agent Hook 在调用前看意图；
- Sandbox/eBPF 验证真实副作用。

前一层尽量提前阻止，内核层负责兜底和验真。**安全保证必须写清楚是 pre-commit deny，还是 post-hoc containment。**

## 坑二：Verifier 不接受“程序员觉得已经限制住了”

eBPF Verifier 需要证明每一次内存访问都有静态边界。你在 C 代码里写了 `if (len > 255) len = 255`，并不意味着编译后的寄存器状态一定能让 Verifier 得出同样结论。

我们读取新进程的 `argv` 时，就遇到过动态长度在编译后仍被判断为可能出现负最小值的问题。

最后采用了两层约束：

```c
if (len > OGR_ARGS_LEN - 1)
    len = OGR_ARGS_LEN - 1;
len &= (OGR_ARGS_LEN - 1);
```

`OGR_ARGS_LEN` 取 2 的幂，位掩码让 Verifier 明确看到长度位于固定范围。

另一个坑是栈。不要先在 eBPF 栈上构造一个很大的事件结构，再复制到 Ring Buffer。我们的做法是直接 `bpf_ringbuf_reserve`，在保留的区域里写事件。

还有一个极其“C 语言”的坑：结构体尾部 padding 也会被 Verifier 当成 Map Value 的一部分检查。字段都赋值了，但 padding 没初始化，照样可能被拒绝。解决方案很朴素：

```c
struct open_pend p;
__builtin_memset(&p, 0, sizeof(p));
```

写 eBPF，不仅要理解业务逻辑，还要理解编译器最后给 Verifier 看到了什么。

## 坑三：sys_enter 有参数，sys_exit 才知道动作是否成功

监听文件打开和网络连接时，我们既需要入口参数，也需要系统调用结果。

`sys_enter_openat` 能拿到用户态路径指针和 flags，但这时不知道 open 是否成功；`sys_exit_openat` 知道返回值，但原始参数已经不在当前上下文里。

我们的处理方式是：

1. 在 enter 阶段按 TID 把参数存入 LRU Hash Map；
2. 在 exit 阶段取出并立即删除；
3. 只对成功的 open、成功或 `EINPROGRESS` 的 connect 发事件；
4. 再读取用户内存并写入 Ring Buffer。

为什么按 TID，而不是 PID？因为同一个进程的多个线程可以同时执行 syscall，只按 PID 会互相覆盖。

这种 enter/exit 配对看起来麻烦，但它避免把大量失败尝试误当成已经发生的副作用，也让用户态拿到更准确的事实。

## 坑四：如果先 exec 再挂 Sensor，第一个动作已经丢了

我们需要跟踪的不只是 Agent 主进程，而是它创建的整个进程树。

Loader 会把根 PID 写入 `tracked` Map；`sched_process_fork` 把根身份传播给子进程；`sched_process_exit` 清理状态。所有事件都带 `root_pid`，因此不会把整台主机的行为混进来。

但启动顺序存在一个竞态：如果子进程先 `exec`，然后 Loader 才把 PID 写进 Map，第一个、也可能是最关键的 exec 事件就丢了。

我们的做法是：

```text
fork child
  -> child SIGSTOP
attach eBPF programs
seed tracked[root_pid]
  -> SIGCONT
exec target
```

先冻结、挂载、登记，再放行。

运行时安全里，启动时序就是安全边界的一部分。

## 坑五：CO-RE 解决了内核结构漂移，没有解决所有部署问题

我们使用 CO-RE：通过 `/sys/kernel/btf/vmlinux` 生成 `vmlinux.h`，由 Clang 产生 relocation，libbpf 在目标机器加载时适配实际内核类型布局。

这比在每台机器上携带完整编译器和内核头文件可靠得多，但“Compile Once, Run Everywhere”不是“Build Once, Forget Testing”。

生产环境仍然需要验证：

- 目标内核是否提供 BTF；
- 目标架构宏是否正确，例如 x86、arm64；
- 所需 tracepoint/LSM Hook 是否存在；
- Verifier 在支持矩阵里的每个内核系列上是否接受程序；
- 容器、发行版和安全基线是否允许加载 BPF。

编译通过只说明生成了对象文件，**不说明目标内核一定愿意加载它。**

## 坑六：Ubuntu 的 `bpftool` 路径，刚刚把我们的 CI 打红了

这是最“新鲜”的一个坑。

我们的 GitHub Runner 使用 `6.17.0-1020-azure`。CI 安装了名字完全匹配的 `linux-tools-6.17.0-1020-azure`，apt 也成功返回，但这只是一个元包；它依赖的 Azure tools 实包里只有 `cpupower`、`perf`、`turbostat`、`usbip` 等工具，**没有 `bpftool` binary**。

与此同时，Ubuntu 的 `/usr/sbin/bpftool` 只是一个按当前内核版本分发的 wrapper。精确 tools 包“安装成功”后，原来写在 `||` 右边的 `linux-tools-generic` 永远不会执行，wrapper 却仍然找不到 binary。

更麻烦的是，Ubuntu 出现过两种路径布局：

```text
/usr/lib/linux-tools/<version>/bpftool
/usr/lib/linux-tools-<version>/bpftool
```

我们最初只匹配第一种，而且错误地假设“精确 kernel tools 包安装成功”等于“bpftool 已安装”。CI 里 `BPFTOOL` 变量最终展开成空字符串，Make 执行的竟然是：

```text
btf dump file /sys/kernel/btf/vmlinux format c
/bin/sh: 1: btf: not found
```

最终修复分成两层：CI 始终安装一个真正携带版本化 binary 的 `linux-tools-generic`，找到后执行 `bpftool version` 并把绝对路径传给 Make；Makefile 仍兼容两种目录布局，如果本机没有传入路径，就在确认 wrapper 可运行后搜索版本化 binary，仍找不到则立即输出明确错误。

基础设施代码最危险的失败方式不是“报错”，而是**报一个完全误导方向的错**。

## 坑七：全量 file open 很诚实，也很吵

Agent 运行一个最简单的命令，也会打开动态链接库、locale、配置和缓存文件。Sensor 如果忠实上报每一个成功 open，事件量会迅速放大。

但直接在内核里塞进一大堆业务 allowlist，也会让策略难以更新、审计和回滚。

我们的取舍是：

- 内核侧只做稳定、低成本的范围过滤，例如只跟踪目标进程树；
- 用户态 PEP/Runtime 负责路径策略和语义判断；
- 大规模部署再把确认稳定的 watched paths 或 coarse policy 下推；
- 必须暴露 emitted、filtered、dropped 等计数，Ring Buffer 丢事件要被视为 coverage loss。

不要把“没有告警”误读成“没有风险”。也可能只是 Sensor 静默丢了数据。

## 坑八：内核看到 IP，不知道它叫哪个域名

当前参考实现从 `sockaddr_in` 读取 IPv4 和端口。它不会在内核里做 DNS 解析，也暂未覆盖 IPv6。

这意味着 eBPF Sensor 看到的是：

```text
connect 142.250.x.x:443
```

而 Agent/Gateway 层可能知道的是：

```text
https://example-api.com/v1/upload
```

企业 egress policy 往往按域名、服务身份或代理策略配置。只靠内核 IP 很难处理 CDN、DNS 轮换、代理和共享地址。

正确做法不是强迫某一层知道全部信息，而是用同一个 `guard_id` 关联不同高度：Gateway 提供域名与数据来源，Agent Hook 提供工具意图，eBPF 提供真实连接。

## 坑九：内核不会自动知道这个 syscall 属于哪一次 Agent 决策

HTTP 请求可以携带 Header，syscall 不会携带 `ogr-guardcontext`。

因此从工具调用到真实进程行为，需要一个可信的关联桥。参考实现可以读取 Agent Hook 在动作前写入的短时 guard context；更强的生产实现应该把 `guard_id` 绑定到 cgroup、sandbox、workload identity 或受保护的进程树，而不是只依赖宽泛的时间窗口。

这个关联非常重要。

没有它，你会得到三份互不相识的告警：

- Gateway 说发现了不可信网页内容；
- Agent Hook 说 Claude 想运行脚本；
- eBPF 说某个 curl 连到了外部 IP。

有了 `guard_id`，它们才是同一个安全事件：**不可信输入驱动了一次真实外连。**

## 现在可以怎么跑

```bash
git clone https://github.com/openguardrails/openguardrails.git
cd openguardrails

pip install -e packages/python -e integrations/ebpf/sensor

make -C integrations/ebpf/sensor/bpf

sudo integrations/ebpf/sensor/bpf/ogr-sensor -- \
  bash -c 'cat /etc/hostname; curl -I https://example.com' \
  | ogr-ebpf run --records -
```

生产环境更适合附加到已经用普通用户身份启动的 Agent 进程树，再开启用户态 containment：

```bash
agent_pid=$(pgrep -n claude)
sudo integrations/ebpf/sensor/bpf/ogr-sensor --pid "$agent_pid" \
  | ogr-ebpf run --records - --enforce
```

请注意两点：第一，当前开源参考实现是 tracepoint observation + 用户态 kill/containment，不要把它误当成已经完成的 BPF LSM pre-commit deny。第二，当前 Loader 的 `-- <cmd>` 演示模式会让目标进程继承 Loader 的身份；不要用 root 直接启动不可信 Agent，生产部署应使用 `--pid` 附加，或由能够加载 BPF 后主动降权的 supervisor 启动目标。

## 我们为什么把它开源

AI Agent 安全不应该再重复一遍封闭 Agent 生态的老路：每个 Agent 对接每个安全厂商，每个厂商再发明一套事件和裁决格式。

我们更希望形成这样的基础设施：

- Claude、Codex、自研 Agent 都可以被同一种内核事件描述；
- eBPF、LSM、容器 Runtime 或商业 Sensor 可以替换；
- EDR、DLP、模型分类器和企业规则可以同时给出独立 Verdict；
- 最终是企业自己的组合策略决定 allow、approval 或 block；
- 同一个 `guard_id` 串起意图、来源与真实副作用；
- 厂商可以竞争检测能力，但不锁定协议和数据。

模型会越来越强，Agent 会拿到越来越多权限。真正可持续的安全方法，不是期待每一代模型永远不犯错，而是把它运行的环境做成可观察、可裁决、可限制、可替换的基础设施。

这就是 OpenGuardrails eBPF Sensor 想补上的那一层。

## 开源地址与参考资料

- OpenGuardrails eBPF：<https://github.com/openguardrails/openguardrails/tree/main/integrations/ebpf>
- OGR eBPF Sensor：<https://github.com/openguardrails/openguardrails/tree/main/integrations/ebpf/sensor>
- OpenGuardrails 协议：<https://github.com/openguardrails/openguardrails/tree/main/specification>
- Anthropic，Beyond permission prompts: making Claude Code more secure and autonomous：<https://www.anthropic.com/engineering/claude-code-sandboxing>
- Anthropic，How we contain Claude across products：<https://www.anthropic.com/engineering/how-we-contain-claude>
- Linux Kernel，BPF LSM Programs：<https://docs.kernel.org/bpf/prog_lsm.html>
- Linux Kernel，libbpf and BPF CO-RE：<https://docs.kernel.org/bpf/libbpf/libbpf_overview.html>

如果你正在做 Agent Runtime、Sandbox、EDR、DLP、云安全或 AI Gateway，欢迎直接基于 OGR 的 `GuardEvent → Verdict` 接口接入，而不是再发明一条私有链路。
