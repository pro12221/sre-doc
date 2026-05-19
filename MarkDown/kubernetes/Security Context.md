# Security Context和Linux Capabilities详解

Kubernetes Security Context 是控制 Pod 安全属性的核心机制，它本质上是对 Linux 安全子系统（Capabilities、SELinux、AppArmor、Seccomp 等）的声明式封装。理解 Security Context 必须先理解其背后的 Linux 安全模型，否则只是照抄配置而不知其所以然。

## Linux Capabilities 机制

### 为什么需要 Capabilities

传统 Linux 只有 root 和非 root 的二元权限模型：进程要么拥有全部特权（UID 0），要么什么特权都没有。这导致两个问题：

1. **权限过度**：一个只需要绑定 80 端口的进程，却同时拥有了挂载文件系统、修改网络配置、杀死其他进程等所有特权
2. **提权风险**：任何以 root 运行的进程被攻破，攻击者就获得了系统的全部控制权

从 Linux 2.2 开始，内核将 root 特权拆分为约 40 个独立的 Capabilities，每个 Capability 控制一类特定操作。

### Capability 分类

Linux Capabilities 按功能大致分为以下几类：

| 类别 | Capability | 控制的操作 |
|------|-----------|-----------|
| 网络操作 | CAP_NET_BIND_SERVICE | 绑定 1024 以下特权端口 |
| 网络操作 | CAP_NET_RAW | 使用原始套接字（ping、抓包） |
| 网络操作 | CAP_NET_ADMIN | 修改网络配置（路由、iptables、接口） |
| 文件系统 | CAP_DAC_OVERRIDE | 绕过文件权限检查 |
| 文件系统 | CAP_DAC_READ_SEARCH | 绕过文件读权限检查 |
| 文件系统 | CAP_FOWNER | 绕过文件属主权限检查 |
| 文件系统 | CAP_CHOWN | 修改文件属主 |
| 进程管理 | CAP_KILL | 向不属于自己的进程发送信号 |
| 进程管理 | CAP_SETUID | 改变进程 UID |
| 进程管理 | CAP_SETGID | 改变进程 GID |
| 进程管理 | CAP_SYS_PTRACE | 跟踪其他进程（调试） |
| 系统管理 | CAP_SYS_ADMIN | 系统管理操作（mount、hostname 等，最危险的 capability） |
| 系统管理 | CAP_SYS_CHROOT | 使用 chroot |
| 系统管理 | CAP_SYS_TIME | 修改系统时钟 |
| 系统管理 | CAP_SYS_RESOURCE | 绕过资源限制 |

> 💡 **提示：** CAP_SYS_ADMIN 被称为"万能 capability"，它涵盖了大量无法归入其他 capability 的特权操作。在容器环境中，赋予 CAP_SYS_ADMIN 几乎等同于赋予 root 权限，应极力避免。

### Capability 在进程中的存在方式

每个进程有四组 Capability 集合：

| 集合 | 含义 |
|------|------|
| Effective (E) | 当前生效的 Capabilities，内核做权限检查时看的就是这个集合 |
| Permitted (P) | 进程可以提升到 Effective 的 Capabilities 上限 |
| Inheritable (I) | exec 执行新程序时可以继承的 Capabilities |
| Ambient (A) | Linux 4.3+ 引入，非特权进程 exec 后自动保留的 Capabilities |

执行新程序时的 Capability 传递规则：

```
execve() 后的新 Effective = 新 Permitted ∩ 新 Inheritable ∪ Ambient
新 Permitted = 文件 Permitted ∪ 文件 Inheritable ∩ 旧 Inheritable ∪ Ambient
```

对于容器场景，关键点在于：**容器运行时（containerd、CRI-O）在创建容器时会根据配置设置进程的初始 Capability 集合**，Kubernetes 的 Security Context 就是在控制这个初始集合。

### 查看进程的 Capabilities

```bash
# 查看当前进程的 Capabilities
cat /proc/self/status | grep Cap

# 输出示例：
# CapInh: 0000000000000000
# CapPrm: 0000003fffffffff
# CapEff: 0000003fffffffff
# CapBnd: 0000003fffffffff
# CapAmb: 0000000000000000
```

十六进制值需要解码，可以用 `capsh` 工具：

```bash
# 解码 Effective capabilities
capsh --decode=0000003fffffffff
```

### 容器默认拥有哪些 Capabilities

Docker 默认给容器一组有限的 Capabilities（不是全部，也不是最少）：

```
CAP_NET_BIND_SERVICE
CAP_NET_RAW
CAP_CHOWN
CAP_DAC_OVERRIDE
CAP_FOWNER
CAP_FSETID
CAP_KILL
CAP_SETGID
CAP_SETUID
CAP_SETPCAP
CAP_AUDIT_WRITE
CAP_MKNOD
CAP_SYS_CHROOT
```

Kubernetes 默认行为取决于容器运行时，但大多数情况下与 Docker 的默认集合一致。Security Context 的 `capabilities` 字段就是用来增减这组默认集合。

## Kubernetes Security Context

### 三个配置层级

Security Context 可以在三个层级配置，作用范围从小到大：

| 层级 | 配置位置 | 作用范围 |
|------|---------|---------|
| 容器级 | `spec.containers[].securityContext` | 单个容器 |
| Pod 级 | `spec.securityContext` | Pod 内所有容器 |
| 策略级 | Pod Security Standards / PSP | 集群级别强制约束 |

容器级配置会覆盖 Pod 级的同名字段。当两者同时配置 `capabilities` 时，容器级的生效。

### Pod 级 Security Context 字段

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: security-demo
spec:
  securityContext:
    runAsUser: 1000          # 以 UID 1000 运行所有容器
    runAsGroup: 3000         # 以 GID 3000 运行
    fsGroup: 2000            # 挂载卷的文件归属 GID 2000
    fsGroupChangePolicy: "OnRootMismatch"  # 卷权限变更策略
    runAsNonRoot: true       # 禁止以 root 运行
    supplementalGroups:      # 附加组 ID 列表
    - 4000
    - 5000
    seccompProfile:          # Seccomp 配置
      type: RuntimeDefault
    sysctls:                 # 内核参数
    - name: net.core.somaxconn
      value: "1024"
  containers:
  - name: app
    image: busybox
```

各字段详解：

**runAsUser / runAsGroup**

设置容器内进程的 UID/GID。容器镜像中的 USER 指令会被此覆盖。如果两者都不设置，进程以镜像中指定的用户运行（默认 root/UID 0）。

**fsGroup**

控制挂载卷的文件归属。当 Pod 挂载卷时，Kubelet 会将卷内文件的组 ID 修改为 fsGroup 的值，并设置适当的组读写权限。

**fsGroupChangePolicy**

| 值 | 行为 |
|---|------|
| `Always`（默认） | 每次挂载都递归修改卷内所有文件权限，大卷会很慢 |
| `OnRootMismatch` | 只在卷根目录属主不匹配时才修改，大幅减少 chown 操作 |

**runAsNonRoot**

设为 `true` 时，Kubelet 在启动容器前会验证进程不以 UID 0 运行。如果镜像指定了 USER 0 且未设置 runAsUser，容器启动失败。这是防止容器以 root 运行的重要安全措施。

**supplementalGroups**

为进程添加附加组 ID。用于进程需要访问多个组拥有的资源的场景，比如同时读取属于不同 GID 的文件。

### 容器级 Security Context 字段

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: container-security-demo
spec:
  securityContext:
    runAsUser: 1000
  containers:
  - name: app
    image: busybox
    securityContext:
      runAsUser: 2000         # 覆盖 Pod 级的 1000
      runAsNonRoot: true
      readOnlyRootFilesystem: true  # 根文件系统只读
      allowPrivilegeEscalation: false
      privileged: false
      capabilities:
        add:
        - NET_BIND_SERVICE
        drop:
        - ALL
      seccompProfile:
        type: RuntimeDefault
```

各字段详解：

**privileged**

设为 `true` 时，容器获得几乎所有的 Linux Capabilities，并且可以访问所有主机设备。这等价于在主机上以 root 运行，安全风险极高，仅在特殊场景（如运行容器运行时本身）使用。

**allowPrivilegeEscalation**

控制进程是否可以通过 `setuid`/`setgid` 提升特权。设为 `false` 会阻止进程执行设置了 setuid bit 的程序来获得额外权限（如 `sudo`、`ping`）。当 `runAsNonRoot: true` 时，此字段默认为 `false`。

**readOnlyRootFilesystem**

设为 `true` 时，容器的根文件系统以只读方式挂载。应用需要写入的目录必须通过 emptyDir 或 hostPath 等卷挂载。这可以防止攻击者写入恶意文件，是安全加固的关键措施。

**capabilities.add / capabilities.drop**

增减容器的 Linux Capabilities。`drop: ["ALL"]` 表示移除所有默认 Capabilities，然后通过 `add` 只加回需要的，这是最小权限原则的最佳实践。

## Capabilities 配置实战

### 最小权限配置模式

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: minimal-capabilities
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: app
    image: nginx:latest
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
        - ALL          # 先移除所有
        add:
        - NET_BIND_SERVICE  # 只加回需要的：绑定 80 端口
```

这是推荐的安全配置范式：先 `drop: ALL`，再逐个 `add` 必需的 Capability。

### 常见场景的 Capabilities 选择

| 场景 | 需要的 Capability | 说明 |
|------|------------------|------|
| Web 服务器绑定 80/443 端口 | CAP_NET_BIND_SERVICE | 不需要 root，只需这一个 capability |
| 需要 ping/ICMP | CAP_NET_RAW | 原始套接字访问 |
| 修改路由表/iptables | CAP_NET_ADMIN | 网络管理工具、Service Mesh sidecar |
| 调试工具（strace） | CAP_SYS_PTRACE | 进程跟踪 |
| chroot | CAP_SYS_CHROOT | 切换根目录 |
| 时间同步服务 | CAP_SYS_TIME | 修改系统时钟 |

> ⚠️ **警告：** 避免授予 CAP_SYS_ADMIN。如果某个操作"似乎需要 SYS_ADMIN"，先查一下是否有更细粒度的 capability 可以替代。大多数情况下 CAP_SYS_ADMIN 都不是唯一选择。

### 查看容器实际拥有的 Capabilities

```bash
# 在容器内执行
cat /proc/1/status | grep Cap

# 在宿主机上查看容器进程
crictl inspect <container-id> | jq '.info.runtimeSpec.process.capabilities'
```

也可以用 kubectl：

```bash
kubectl exec -it <pod> -- capsh --print
```

## runAsUser 与镜像 USER 的关系

容器进程的最终 UID 由以下优先级决定：

```
容器级 securityContext.runAsUser
    ↓ 未设置时
Pod 级 securityContext.runAsUser
    ↓ 未设置时
镜像 Dockerfile 中的 USER 指令
    ↓ 未设置时
root (UID 0)
```

关键细节：

1. `runAsNonRoot: true` 只是验证，不设置 UID。如果既设了 `runAsNonRoot: true` 又没设 `runAsUser`，且镜像没有 USER 指令，容器启动会失败
2. 镜像的 USER 可以是用户名（如 `nginx`），Kubernetes 会通过容器的 `/etc/passwd` 解析为 UID
3. `runAsUser` 直接指定数字 UID，不依赖 `/etc/passwd`，更可靠

## fsGroup 与卷权限

### 挂载卷的权限处理

当一个卷挂载到 Pod 时，Kubelet 会根据 `fsGroup` 的设置修改卷内文件的权限：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: fsgroup-demo
spec:
  securityContext:
    fsGroup: 2000
    fsGroupChangePolicy: OnRootMismatch
  containers:
  - name: app
    image: busybox
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: my-pvc
```

处理逻辑：

1. 卷内所有文件的组 ID 被修改为 2000
2. 文件被赋予组读写权限（mode + 0660 或类似）
3. 如果 `fsGroupChangePolicy: OnRootMismatch`，只在根目录属主不匹配时才执行 chown

### fsGroup 与 supplementalGroups 的区别

| 字段 | 作用 | 影响范围 |
|------|------|---------|
| fsGroup | 修改挂载卷的文件属组 | 只影响卷内文件 |
| supplementalGroups | 给进程添加附加组身份 | 进程的组关系，不影响文件 |

典型组合：`fsGroup` 控制卷访问权限，`supplementalGroups` 用于访问主机上其他组拥有的资源。

## Privileged 与 PrivilegeEscalation

### privileged: true 的含义

```yaml
securityContext:
  privileged: true
```

这会：

1. 授予容器几乎所有 Linux Capabilities
2. 解除 Seccomp 限制
3. 允许访问所有主机设备（/dev 下的设备节点）
4. 允许挂载文件系统
5. 允许修改内核参数

> 唯一合理的使用场景：在容器内运行另一个容器运行时（如 Docker-in-Docker、KIND）、运行需要直接操作硬件的组件（如 GPU 驱动）、或运行网络插件（如 Calico 的 install-cni 初始化容器）。

### allowPrivilegeEscalation 的底层机制

Linux 的 `no_new_privs` 位控制进程是否可以通过 exec 获得更多权限：

```yaml
securityContext:
  allowPrivilegeEscalation: false  # 设置 no_new_privs = 1
```

设为 `false` 后：

1. 进程执行 setuid 程序（如 sudo）不会获得额外权限
2. 子进程的 Capability 不能超过父进程
3. SELinux 转换被阻止
4. 但不影响已经拥有的 Capability 的使用

## Pod Security Standards

### 三个安全级别

Kubernetes 社区定义了三个安全策略级别（Pod Security Standards），从宽松到严格：

| 级别 | 说明 | 典型配置 |
|------|------|---------|
| **Privileged** | 不限制，允许一切 | 开发/测试环境 |
| **Baseline** | 最小限制，阻止已知的明显提权 | 禁止 privileged、禁止新增危险 capabilities、禁止 hostPath 等 |
| **Restricted** | 严格限制，遵循最小权限 | 生产环境，要求 drop ALL capabilities、runAsNonRoot、readOnlyRootFilesystem 等 |

### Baseline 禁止的配置

- `privileged: true`
- 添加以下 Capabilities：CAP_NET_RAW 以外的主机网络相关、CAP_SYS_ADMIN 等
- `hostNetwork: true`、`hostPID: true`、`hostIPC: true`
- `hostPath` 挂载
- 挂载 `/dev` 下的设备
- 使用 HostPort
- 修改不安全的 sysctls

### Restricted 要求的配置

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: restricted-pod
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: app
    image: nginx
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
        - ALL
```

### 在命名空间上强制执行

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

三种模式的区别：

| 模式 | 行为 |
|------|------|
| enforce | 违反策略的 Pod 直接被拒绝创建 |
| audit | 允许创建，但在审计日志中记录 |
| warn | 允许创建，但在 kubectl 操作时发出警告 |

## Seccomp 与 Security Context

### 什么是 Seccomp

Seccomp（Secure Computing Mode）限制进程可以调用的系统调用。它通过 BPF 规则定义允许/禁止的 syscall 列表，是在 Capability 之上的更细粒度安全层。

### 在 Security Context 中配置

```yaml
securityContext:
  seccompProfile:
    type: RuntimeDefault   # 使用容器运行时的默认 profile
    # type: Localhost       # 使用节点本地文件
    # localhostProfile: profiles/my-profile.json
```

| type 值 | 含义 |
|---------|------|
| `Unconfined` | 不应用 Seccomp 过滤 |
| `RuntimeDefault` | 使用容器运行时（containerd/CRI-O）的默认 profile |
| `Localhost` | 使用节点上 `/var/lib/kubelet/seccomp/` 下的自定义 profile |

推荐做法：所有工作负载都至少设置 `RuntimeDefault`，它已经阻止了大量危险系统调用。

## 完整配置示例

### 安全的 Web 应用

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-web
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 101
    fsGroup: 101
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: nginx
    image: nginxinc/nginx-unprivileged:latest
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
        - ALL
        add:
        - NET_BIND_SERVICE
    volumeMounts:
    - name: cache
      mountPath: /var/cache/nginx
    - name: run
      mountPath: /var/run
  volumes:
  - name: cache
    emptyDir: {}
  - name: run
    emptyDir: {}
```

注意 `nginxinc/nginx-unprivileged` 镜像已经配置好以非 root 运行，且监听 8080 而非 80。如果需要绑定 80 端口，则添加 `CAP_NET_BIND_SERVICE`。

### 需要 Network 权限的 Service Mesh

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: sidecar-demo
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1337
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: istio-proxy
    image: proxyv2
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
        - ALL
        add:
        - NET_ADMIN       # iptables 规则重定向
        - NET_RAW         # 原始套接字
```

## 排查命令速查

```bash
# 查看当前进程的 capabilities
kubectl exec -it <pod> -- capsh --print

# 查看当前 UID/GID
kubectl exec -it <pod> -- id

# 查看挂载卷的权限
kubectl exec -it <pod> -- ls -la /data

# 测试特定操作是否被允许
kubectl exec -it <pod> -- capsh --caps="cap_net_bind_service+eip" -- -c "nc -l -p 80"

# 查看容器的完整安全配置
kubectl get pod <pod> -o jsonpath='{.spec.securityContext}'
kubectl get pod <pod> -o jsonpath='{.spec.containers[*].securityContext}'
```

## 配置速查表

| 安全目标 | 配置 |
|---------|------|
| 禁止以 root 运行 | `runAsNonRoot: true` + `runAsUser: 1000` |
| 最小化 Capabilities | `capabilities: { drop: ["ALL"], add: [...] }` |
| 防止提权 | `allowPrivilegeEscalation: false` |
| 只读根文件系统 | `readOnlyRootFilesystem: true` |
| 控制卷访问 | `fsGroup: <gid>` + `fsGroupChangePolicy: OnRootMismatch` |
| Seccomp 保护 | `seccompProfile: { type: RuntimeDefault }` |
| 完全禁止特权 | 不设置 `privileged: true`，使用 Pod Security Standards |
