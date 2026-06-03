# Pod调度与节点选择

Kubernetes 调度器（kube-scheduler）是控制平面的核心组件，负责将未调度的 Pod 分配到合适的节点上运行。调度过程并非随机——它经过**预选 → 优选 → 终选**三个阶段，确保 Pod 既"能跑"又"跑得好"。本章从调度流程入手，逐步讲解 NodeSelector、亲和性/反亲和性、污点与容忍等调度策略。

---

## Pod 创建流程与调度机制

### Pod 创建到运行的完整流程

当用户通过 `kubectl apply` 或 API 创建一个 Pod 时，整个生命周期经历以下阶段：

```
kubectl apply → API Server 收到请求
    │
    ├── 1. 认证（Authentication）：确认请求者身份
    ├── 2. 授权（Authorization）：RBAC 检查是否有创建 Pod 的权限
    ├── 3. 准入控制（Admission Controllers）：如 NamespaceExists、LimitRanger、PodSecurityPolicy 等
    │
    ▼
API Server 将 Pod 对象写入 etcd（状态: Pending）
    │
    ▼
kube-scheduler Watch 到未调度的 Pod（spec.nodeName 为空）
    │
    ├── 预选（Filtering）：过滤出所有可运行该 Pod 的节点
    ├── 优选（Scoring）：对可行节点打分排序
    ├── 终选（Binding）：将 Pod 绑定到得分最高的节点
    │
    ▼
API Server 更新 Pod 的 spec.nodeName → 写入 etcd
    │
    ▼
目标节点 kubelet Watch 到有 Pod 分配给自己
    │
    ├── 拉取镜像 → 创建容器 → 启动应用
    │
    ▼
Pod 状态变为 Running
```

### 调度器核心流程：预选 → 优选 → 终选

kube-scheduler 的调度决策分为三个阶段：

#### 预选（Filtering / Predicates）

遍历所有节点，**硬性排除**不符合条件的节点。任何一个预选条件不满足，该节点就被直接淘汰。

常见的预选策略：

| 预选策略 | 说明 |
|---|---|
| **PodFitsResources** | 节点剩余 CPU/内存/GPU 是否满足 Pod 的 `resources.requests` |
| **PodFitsHostPorts** | Pod 需要的 HostPort 是否已被占用 |
| **HostName** | 如果 Pod 指定了 `spec.nodeName`，只保留该节点 |
| **NodeSelectorFit** | 节点标签是否匹配 Pod 的 `nodeSelector` |
| **NodeAffinity** | 节点是否满足 `requiredDuringSchedulingIgnoredDuringExecution` 硬亲和规则 |
| **TaintToleration** | 节点上的污点是否被 Pod 的容忍匹配 |
| **PodToleratesNodeTaints** | 同上，检查 Pod 能否容忍节点污点 |
| **CheckNodeUnschedulable** | 节点是否被标记为 `unschedulable`（`kubectl cordon`） |
| **PodFitsVolume** | Pod 声明的 PV/StorageClass 能否在该节点挂载 |

预选结束后，剩下的节点称为**可行节点（Feasible Nodes）**。

#### 优选（Scoring / Priorities）

对所有可行节点**打分排序**，选出最"合适"的节点。每个优选策略独立打分，最终加权求和。

常见优选策略：

| 优选策略 | 权重 | 说明 |
|---|---|---|
| **NodeResourcesFit** | 1 | 节点资源越富裕得分越高（倾向分配到资源充足的节点，或最均衡的节点） |
| **ImageLocality** | 1 | 节点上已有 Pod 需要的镜像越多，得分越高 |
| **InterPodAffinity** | 1 | 节点是否满足 Pod 的 `preferredDuringScheduling` 软亲和/反亲和规则 |
| **NodeAffinity** | 1 | 节点是否满足 `preferredDuringSchedulingIgnoredDuringExecution` 软亲和规则 |
| **TaintToleration** | 1 | 节点有 PreferNoSchedule 污点但 Pod 无容忍时扣分 |
| **SelectorSpreadPriority** | 1 | 尽量将同一 RC/RS/Deployment 的 Pod 分散到不同节点 |
| **EvenPodsSpread** | 1 | 满足 `topologySpreadConstraints` 的均匀分布约束 |

#### 终选（Binding）

得分最高的节点成为**目标节点**。如果多个节点得分相同，则随机选一个（Round Robin）。

终选步骤：

1. 调度器向 API Server 发送 Binding 请求，将 Pod 的 `spec.nodeName` 设为目标节点名
2. API Server 更新 etcd 中的 Pod 对象
3. 目标节点的 kubelet Watch 到变化，开始拉取镜像、创建容器

> **注意**：如果调度失败（没有可行节点，或优选阶段所有节点得分太低），Pod 保持在 `Pending` 状态。调度器会按照 backoff 策略定期重试（`podInitialBackoffSeconds=1s`，`podMaxBackoffSeconds=10s`）。

### Scheduling Framework（v1.18+）

从 v1.18 开始，kube-scheduler 引入了 **Scheduling Framework**，将调度流程拆解为可扩展的插件扩展点：

```
QueueSort → PreFilter → Filter → PostFilter → PreScore → Score → NormalizeScore → Reserve → Permit → PreBind → Bind → PostBind
```

| 扩展点 | 作用 |
|---|---|
| **QueueSort** | 决定 Pod 从调度队列取出的优先级顺序 |
| **PreFilter** | 预处理 Pod 信息，为 Filter 阶段做准备 |
| **Filter** | 对应"预选"，排除不满足条件的节点 |
| **PostFilter** | Filter 后若无可行节点，执行补救逻辑（如抢占） |
| **PreScore** | 为 Score 阶段做预处理 |
| **Score** | 对应"优选"，对可行节点打分 |
| **Reserve** | 预留资源（防止绑定竞争） |
| **Permit** | 批准或拒绝绑定（可延迟等待） |
| **Bind** | 对应"终选"，将 Pod 绑定到节点 |
| **PostBind** | 绑定成功后的回调清理 |

开发者可以通过编写自定义插件注册到上述任何扩展点，实现自定义调度逻辑，无需修改调度器源码。

---

## 一、NodeSelector

### 1.1 介绍

`nodeSelector` 是最简单的节点选择机制——在 Pod 的 `spec` 中指定一组键值对，Kubernetes 只会将 Pod 调度到**标签完全匹配**的节点上。

它本质上是一个**硬约束**：如果集群中没有节点满足 `nodeSelector` 中所有键值对，Pod 会一直处于 `Pending` 状态。

**适用场景**：

- Pod 需要特定硬件（如 GPU 节点、SSD 磁盘节点）
- Pod 需要运行在指定区域/机房
- 简单的环境区分（生产环境 vs 测试环境）

**局限**：

- 只支持**精确匹配**（label 的 key 和 value 必须完全一致），不支持 In、NotIn、Exists 等运算符
- 是硬约束，没有"尽量满足"的软策略
- 如果需要更复杂的调度逻辑，应使用 nodeAffinity

### 1.2 实践

#### 给节点打标签

```bash
# 给 node-01 打上磁盘类型标签
kubectl label nodes node-01 disktype=ssd

# 给 node-02 打上 GPU 标签
kubectl label nodes node-02 accelerator=nvidia-tesla-p100

# 查看节点标签
kubectl get nodes --show-labels
```

#### Pod 中使用 nodeSelector

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx-ssd
spec:
  containers:
  - name: nginx
    image: nginx:1.25
  nodeSelector:
    disktype: ssd   # Pod 只会被调度到有 disktype=ssd 标签的节点
```

#### 多标签组合

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-app
spec:
  containers:
  - name: cuda-test
    image: "registry.k8s.io/cuda-vector-add:v0.1"
    resources:
      limits:
        nvidia.com/gpu: 1
  nodeSelector:
    accelerator: nvidia-tesla-p100  # 必须 GPU 节点
    disktype: ssd                    # 且必须是 SSD
```

> nodeSelector 中的**所有键值对**都必须匹配，是 AND 逻辑。Pod 只会调度到同时拥有 `accelerator=nvidia-tesla-p100` **和** `disktype=ssd` 标签的节点。

#### 验证调度结果

```bash
# 查看 Pod 被调度到了哪个节点
kubectl get pod nginx-ssd -o wide

# 查看调度事件
kubectl describe pod nginx-ssd | grep -A5 Events
```

如果集群中没有匹配标签的节点，事件会显示：

```
0/3 nodes are available: 3 node(s) didn't match node selector.
```

---

## 二、亲和性与反亲和性

### 2.1 总体介绍

亲和性（Affinity）和反亲和性（Anti-Affinity）是 `nodeSelector` 的增强版，提供了**更丰富的选择语义**：

| 维度 | nodeSelector | Affinity/Anti-Affinity |
|---|---|---|
| **匹配运算符** | 仅精确匹配 | In、NotIn、Exists、DoesNotExist、Gt、Lt |
| **策略类型** | 仅硬约束 | 硬约束（required）+ 软约束（preferred） |
| **选择维度** | 仅节点标签 | 节点维度（nodeAffinity）+ Pod维度（podAffinity） |
| **拓扑域** | 不支持 | 支持 topologyKey |

亲和性分两个维度：

- **nodeAffinity**：基于**节点标签**选择节点（类似增强版 nodeSelector）
- **podAffinity / podAntiAffinity**：基于**已运行 Pod 的标签**选择节点（让 Pod "亲近"或"远离"特定 Pod）

### 策略类型对比

| 类型 | 策略字段 | 行为 |
|---|---|---|
| **硬策略** | `requiredDuringSchedulingIgnoredDuringExecution` | 调度时**必须满足**，否则 Pod 不会被调度。运行后如果条件不再满足，**不会驱逐** Pod（IgnoredDuringExecution） |
| **软策略** | `preferredDuringSchedulingIgnoredDuringExecution` | 调度时**尽量满足**，找不到满足条件的节点也能调度。权重 1-100，影响优选阶段的打分 |

> `IgnoredDuringExecution` 的含义：这些规则只在**调度时生效**，一旦 Pod 已经运行在节点上，即使后续节点标签变化导致条件不再满足，也不会驱逐 Pod。`requiredDuringSchedulingIgnoredDuringExecution` 中的 "IgnoredDuringExecution" 就是强调这一点。

---

### 2.2 节点维度——nodeAffinity

nodeAffinity 让 Pod 基于**节点本身的标签**来表达调度偏好，是 nodeSelector 的超集。

#### 2.2.1 节点亲和（硬策略 + 软策略）

**硬策略：requiredDuringSchedulingIgnoredDuringExecution**

Pod **必须**调度到满足条件的节点，否则 Pending：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: affinity-required
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: zone          # 节点标签的 key
            operator: In       # 运算符
            values:            # 标签值列表
            - us-east-1a
            - us-east-1b
  containers:
  - name: nginx
    image: nginx:1.25
```

**软策略：preferredDuringSchedulingIgnoredDuringExecution**

Pod **倾向**调度到满足条件的节点，但如果没有满足条件的节点也能调度：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: affinity-preferred
spec:
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 80             # 权重 1-100，值越大倾向越强
        preference:
          matchExpressions:
          - key: zone
            operator: In
            values:
            - us-east-1a       # 倾向调度到 us-east-1a 区域
      - weight: 20
        preference:
          matchExpressions:
          - key: disktype
            operator: In
            values:
            - ssd              # 倾向 SSD 节点，但权重较低
  containers:
  - name: nginx
    image: nginx:1.25
```

**运算符说明**：

| 运算符 | 含义 | 示例 |
|---|---|---|
| `In` | 标签值在给定列表中 | `zone In [us-east-1a, us-east-1b]` → zone 为这两个值之一 |
| `NotIn` | 标签值不在给定列表中 | `zone NotIn [us-east-1c]` → zone 不是 us-east-1c |
| `Exists` | 标签 key 存在（不管值） | `gpu Exists` → 节点有 gpu 这个标签 |
| `DoesNotExist` | 标签 key 不存在 | `gpu DoesNotExist` → 节点没有 gpu 标签 |
| `Gt` | 标签值大于给定数字 | `storage Gt 500` → storage 标签值 > 500 |
| `Lt` | 标签值小于给定数字 | `storage Lt 100` → storage 标签值 < 100 |

> `Gt` 和 `Lt` 仅适用于数值型标签值，且需要开启 `TaintTolerationComparisonOperators` 特性门控。

**硬策略 + 软策略组合使用**：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: affinity-combo
spec:
  affinity:
    nodeAffinity:
      # 硬策略：必须跑在 us-east 区域
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: zone
            operator: In
            values:
            - us-east-1a
            - us-east-1b
      # 软策略：倾向 SSD 节点
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 50
        preference:
          matchExpressions:
          - key: disktype
            operator: In
            values:
            - ssd
  containers:
  - name: nginx
    image: nginx:1.25
```

调度逻辑：先在 us-east-1a 和 us-east-1b 的节点中筛选（硬策略），然后在这些节点中对 SSD 节点加分（软策略）。

#### 2.2.2 节点反亲和

节点反亲和就是用 `NotIn` 和 `DoesNotExist` 运算符表达"**不要调度到某类节点**"：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: avoid-gpu-node
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: accelerator
            operator: DoesNotExist   # 不要调度到有 GPU 标签的节点
  containers:
  - name: nginx
    image: nginx:1.25
```

**软策略反亲和**——倾向避开某类节点但不是硬性要求：

```yaml
preferredDuringSchedulingIgnoredDuringExecution:
- weight: 50
  preference:
    matchExpressions:
    - key: zone
      operator: NotIn
      values:
      - us-east-1c    # 倾向避开 us-east-1c，但实在没节点也能去
```

> **nodeAffinity 反亲和 vs nodeSelector**：nodeSelector 只能"选择"节点，无法表达"排除"语义。nodeAffinity 用 NotIn/DoesNotExist 实现排除，这是 nodeSelector 无法做到的。

---

### 2.3 Pod维度——podAffinity

podAffinity 基于**已运行 Pod 的标签**来决定新 Pod 的调度位置，实现"让相关的 Pod 跑在一起"或"让冲突的 Pod 跑开"。

#### 2.3.1 Pod 亲和

##### （1）Pod 亲和调度——硬策略

让新 Pod **必须**调度到与指定 Pod 相同拓扑域的节点：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web-server
  labels:
    app: web
spec:
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchExpressions:
          - key: app
            operator: In
            values:
            - cache        # 查找标签 app=cache 的 Pod
        topologyKey: topology.kubernetes.io/zone  # 在同一 zone 内亲和
  containers:
  - name: nginx
    image: nginx:1.25
```

调度逻辑：
1. 找到集群中所有标签含 `app=cache` 的 Pod
2. 看这些 Pod 所在节点的 `topology.kubernetes.io/zone` 标签值（如 `us-east-1a`）
3. 新 Pod **必须**调度到 `topology.kubernetes.io/zone=us-east-1a` 的节点上

如果集群中没有 `app=cache` 的 Pod 正在运行，这个 Pod 会 Pending——因为找不到参考 Pod，无法确定拓扑域。

##### （2）Pod 亲和调度——软策略

让新 Pod **倾向**调度到与指定 Pod 相同拓扑域的节点：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web-server-soft
  labels:
    app: web
spec:
  affinity:
    podAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 80               # 权重较高，强倾向
        podAffinityTerm:
          labelSelector:
            matchExpressions:
            - key: app
              operator: In
              values:
              - cache
          topologyKey: topology.kubernetes.io/zone
  containers:
  - name: nginx
    image: nginx:1.25
```

#### 2.3.2 Pod 反亲和

Pod 反亲和让新 Pod **远离**指定 Pod 所在的拓扑域，常用于：

- 同一 Deployment 的副本分散到不同节点/区域（避免单点故障）
- 互相干扰的服务不在同一节点运行

**硬策略反亲和**——同一 Deployment 的 Pod 绝不在同一节点：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - web           # 匹配自身 Deployment 的 Pod
            topologyKey: kubernetes.io/hostname  # 不同节点（hostname 不同）
      containers:
      - name: nginx
        image: nginx:1.25
```

> `topologyKey: kubernetes.io/hostname` 的含义：让同一 Deployment 的 Pod 不在同一 hostname（即不同节点）上。每个节点只有一个 hostname，所以这个规则确保每个节点最多一个该 Deployment 的 Pod。

**软策略反亲和**——尽量分散但不是硬性要求：

```yaml
podAntiAffinity:
  preferredDuringSchedulingIgnoredDuringExecution:
  - weight: 100
    podAffinityTerm:
      labelSelector:
        matchExpressions:
        - key: app
          operator: In
          values:
          - web
      topologyKey: topology.kubernetes.io/zone  # 尽量不在同一 zone
```

#### 2.3.3 拓扑域

##### （1）什么是拓扑域

拓扑域（Topology Domain）是 Kubernetes 中对集群节点进行**逻辑分组**的概念。同一拓扑域内的节点共享某个拓扑标签的值。

举例：

```
节点 node-01: topology.kubernetes.io/zone=us-east-1a, kubernetes.io/hostname=node-01
节点 node-02: topology.kubernetes.io/zone=us-east-1a, kubernetes.io/hostname=node-02
节点 node-03: topology.kubernetes.io/zone=us-east-1b, kubernetes.io/hostname=node-03
节点 node-04: topology.kubernetes.io/zone=us-east-1b, kubernetes.io/hostname=node-04
```

- 以 `kubernetes.io/hostname` 为拓扑键 → 每个节点是一个独立拓扑域（4个域）
- 以 `topology.kubernetes.io/zone` 为拓扑键 → node-01/02 同域，node-03/04 同域（2个域）

拓扑域是 podAffinity/podAntiAffinity 的核心概念——亲和/反亲和不是在"节点"层面生效，而是在"拓扑域"层面生效。

##### （2）为何要用 topologyKey

podAffinity/podAntiAffinity 的匹配逻辑：

1. 先通过 `labelSelector` 找到目标 Pod
2. 找到这些 Pod 所在节点上的 `topologyKey` 标签值
3. 新 Pod 被调度到（亲和）或避开（反亲和）**相同 topologyKey 标签值**的节点

**如果不用 topologyKey**，podAffinity 就只能以节点为单位做调度，无法表达"同一区域"、"同一机房"这类更大范围的亲和/反亲和需求。

**topologyKey 的粒度决定调度粒度**：

| topologyKey | 拓扑域粒度 | 亲和效果 |
|---|---|---|
| `kubernetes.io/hostname` | 单节点 | Pod 分散到不同节点 |
| `topology.kubernetes.io/zone` | 可用区 | Pod 分散到不同可用区 |
| `topology.kubernetes.io/region` | 地域 | Pod 分散到不同地域 |

##### （3）如何表示机器归属的拓扑域

通过给节点打标签来表示机器的拓扑域归属：

```bash
# 标记节点所在可用区
kubectl label nodes node-01 topology.kubernetes.io/zone=us-east-1a
kubectl label nodes node-02 topology.kubernetes.io/zone=us-east-1a
kubectl label nodes node-03 topology.kubernetes.io/zone=us-east-1b

# 标记节点所在地域
kubectl label nodes node-01 topology.kubernetes.io/region=us-east
kubectl label nodes node-02 topology.kubernetes.io/region=us-east

# 标记节点所属机房
kubectl label nodes node-01 dc=shanghai-dc1
kubectl label nodes node-02 dc=shanghai-dc1
kubectl label nodes node-03 dc=beijing-dc1
```

##### （4）创建新 Pod 时如何指定拓扑域

在 podAffinityTerm 中通过 `topologyKey` 字段指定：

```yaml
podAffinity:
  requiredDuringSchedulingIgnoredDuringExecution:
  - labelSelector:
      matchExpressions:
      - key: app
        operator: In
        values:
        - backend
    topologyKey: topology.kubernetes.io/zone   # 以 zone 为拓扑域
```

**规则**：`topologyKey` 不能为空。如果指定了 `topologyKey`，所有可行节点都必须有该标签，否则调度会排除无此标签的节点。

##### （5）拓扑域示例

**场景**：Web 服务和 Cache 服务需要跑在同一可用区以减少延迟

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web-with-cache
  labels:
    app: web
spec:
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchExpressions:
          - key: app
            operator: In
            values:
            - cache
        topologyKey: topology.kubernetes.io/zone
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchExpressions:
            - key: app
              operator: In
              values:
              - web
          topologyKey: kubernetes.io/hostname
  containers:
  - name: nginx
    image: nginx:1.25
```

解读：
- 硬亲和：必须和 `app=cache` 的 Pod 在同一可用区
- 软反亲和：尽量不和 `app=web` 的 Pod 在同一节点（分散副本）

##### （6）默认创建好的拓扑域标签

Kubernetes 节点默认拥有以下拓扑标签：

| 标签 | 说明 |
|---|---|
| `kubernetes.io/hostname` | 节点的主机名，每节点唯一 |
| `topology.kubernetes.io/zone` | 节点所在可用区（如 us-east-1a） |
| `topology.kubernetes.io/region` | 节点所在地域（如 us-east） |
| `topology.kubernetes.io/arch` | 节点 CPU 架构（如 amd64、arm64） |
| `topology.kubernetes.io/os` | 节点操作系统（如 linux） |

云厂商集群（EKS、GKE、AKS）会自动根据云平台 API 为节点填充 zone 和 region 标签。自建集群需要手动打标签或通过 cloud-controller-manager 自动设置。

##### （7）总结

- topologyKey 决定了 podAffinity/podAntiAffinity 的生效粒度
- 粒度越细（hostname），调度越分散；粒度越粗（zone/region），调度越集中
- 硬亲和使用 `required`，软亲和使用 `preferred`（带 weight）
- 硬策略可能导致 Pod Pending（没有满足条件的拓扑域时），软策略不会
- 生产环境推荐：反亲和用硬策略保证副本分散到不同节点，亲和用软策略倾向同区域但不强制

---

## 三、污点与容忍

### 3.1 污点与容忍介绍

**污点（Taint）** 打在节点上，**排斥**不容忍该污点的 Pod——让节点"嫌弃"不合适的 Pod。

**容忍（Toleration）** 定义在 Pod 上，**允许** Pod 接受节点的污点——让 Pod"接受"被嫌弃。

两者配合使用，实现**节点级准入控制**：

```
节点打污点 → 不容忍的 Pod 被排斥 → 定义了容忍的 Pod 可以调度
```

**核心区别**：

| 机制 | 作用方向 | 效果 |
|---|---|---|
| nodeSelector / nodeAffinity | Pod → Node（Pod 选择节点） | 主动吸引 |
| Taint / Toleration | Node → Pod（节点排斥 Pod） | 主动排斥 |

**典型场景**：

- 专用节点：GPU 节点只允许需要 GPU 的 Pod
- 故障隔离：节点磁盘故障，标记污点驱逐 Pod
- 维护模式：节点正在维护，不让新 Pod 调度进来
- Control Plane 专用：master 节点默认有污点，阻止普通 Pod

### 污点的三种效果

| 效果 | 说明 |
|---|---|
| **NoSchedule** | 禁止调度——新的不容忍 Pod 不会被调度到此节点，已运行的 Pod **不受影响** |
| **PreferNoSchedule** | 尽量不调度——软约束，调度器尽量避开，但实在没节点也能调度 |
| **NoExecute** | 禁止调度 + 驱逐运行——新 Pod 不调度，且**已运行的不容忍 Pod 会被驱逐** |

> Kubernetes 控制平面节点默认带有污点 `node-role.kubernetes.io/control-plane:NoSchedule`，阻止普通业务 Pod 调度到 master。

### 3.2 为节点打上污点

#### 打污点

```bash
# 为 node-01 打上专用节点污点（key=dedicated, value=special-user, effect=NoSchedule）
kubectl taint nodes node-01 dedicated=special-user:NoSchedule

# 打 GPU 专用污点
kubectl taint nodes gpu-node nvidia.com/gpu=true:NoSchedule

# 打维护模式污点（NoExecute 效果，会驱逐已运行的 Pod）
kubectl taint nodes node-03 maint=ongoing:NoExecute

# 打软排斥污点（尽量不调度）
kubectl taint nodes node-04 test-only=true:PreferNoSchedule

# 按标签选择节点打污点
kubectl taint node -l role=infra dedicated=infra:NoSchedule
```

#### 查看污点

```bash
# 查看节点上的污点
kubectl describe node node-01 | grep Taints

# 查看所有节点的污点
kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints
```

#### 删除污点

```bash
# 删除指定 key+effect 的污点（在 key:effect 后加 -）
kubectl taint nodes node-01 dedicated=special-user:NoSchedule-

# 删除指定 key 的所有污点（不管 effect）
kubectl taint nodes node-01 dedicated-

# 删除指定 effect 的污点（保留其他 effect）
kubectl taint nodes node-01 dedicated:NoSchedule-
```

### 3.3 为 Pod 定义容忍

#### 基本容忍

容忍需要与节点污点匹配才能生效。匹配规则取决于 `operator`：

| operator | 匹配条件 | 说明 |
|---|---|---|
| `Equal`（默认） | key=value+effect 完全匹配 | key、value、effect 三者必须与污点一致 |
| `Exists` | key+effect 匹配（忽略 value） | 只要 key 和 effect 匹配，不管污点的 value 是什么 |

**精确匹配（Equal）**：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-pod
spec:
  tolerations:
  - key: "nvidia.com/gpu"
    operator: "Equal"
    value: "true"
    effect: "NoSchedule"
  containers:
  - name: cuda-app
    image: cuda-vector-add:v0.1
```

**Exists 匹配**——容忍某 key 的所有污点（不管值）：

```yaml
tolerations:
- key: "nvidia.com/gpu"
  operator: "Exists"
  effect: "NoSchedule"
```

**容忍所有污点**——key 和 effect 都为空：

```yaml
tolerations:
- operator: "Exists"   # key 为空 + operator=Exists → 匹配所有污点
```

> 这会让 Pod 可以调度到任何有污点的节点，慎用。

#### 多容忍组合

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: multi-tolerate-pod
spec:
  tolerations:
  - key: "dedicated"
    operator: "Equal"
    value: "special-user"
    effect: "NoSchedule"
  - key: "nvidia.com/gpu"
    operator: "Exists"
    effect: "NoSchedule"
  - key: "maint"
    operator: "Equal"
    value: "ongoing"
    effect: "NoExecute"
  containers:
  - name: nginx
    image: nginx:1.25
```

> Pod 的 tolerations 是**累加型**的——只要有一条容忍匹配了节点的某个污点，该污点就不会排斥这个 Pod。不需要一条容忍匹配所有污点。

#### 常见容忍场景

**容忍 master 节点污点**（让业务 Pod 可以调度到 control plane）：

```yaml
tolerations:
- key: "node-role.kubernetes.io/control-plane"
  operator: "Exists"
  effect: "NoSchedule"
```

**容忍所有 NoSchedule 污点**（用于 DaemonSet，确保每个节点都运行）：

```yaml
tolerations:
- operator: "Exists"
  effect: "NoSchedule"
```

**DaemonSet 容忍所有污点**的完整配置：

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-monitor
spec:
  selector:
    matchLabels:
      app: monitor
  template:
    metadata:
      labels:
        app: monitor
    spec:
      tolerations:
      - operator: "Exists"    # 容忍所有 NoSchedule 污点
        effect: "NoSchedule"
      - operator: "Exists"    # 容忍所有 NoExecute 污点
        effect: "NoExecute"
      containers:
      - name: monitor
        image: prometheus-node-exporter:latest
```

### 3.4 定义 Pod 驱逐时间

`tolerationSeconds` 字段控制 Pod 在 NoExecute 污点出现后**还能留在节点上的时间**。

#### 场景说明

当节点突然被打上 `NoExecute` 污点时：

- **没有容忍**：Pod 立即被驱逐
- **有容忍但无 tolerationSeconds**：Pod 永远不会被驱逐
- **有容忍且设置 tolerationSeconds**：Pod 在 tolerationSeconds 后被驱逐

#### 示例：Pod 可以在故障节点上停留 3600 秒

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: resilient-app
spec:
  tolerations:
  - key: "node.kubernetes.io/not-ready"
    operator: "Exists"
    effect: "NoExecute"
    tolerationSeconds: 3600    # 节点 NotReady 后，Pod 还能停留 1 小时
  - key: "node.kubernetes.io/unreachable"
    operator: "Exists"
    effect: "NoExecute"
    tolerationSeconds: 3600    # 节点 Unreachable 后，Pod 还能停留 1 小时
  containers:
  - name: nginx
    image: nginx:1.25
```

#### 默认 tolerationSeconds

Kubernetes 为 Pod 自动添加两条默认容忍（通过 Admission Controller）：

```yaml
# 默认容忍——节点 NotReady 后等待 300 秒（5 分钟）
tolerations:
- key: "node.kubernetes.io/not-ready"
  operator: "Exists"
  effect: "NoExecute"
  tolerationSeconds: 300

# 默认容忍——节点 Unreachable 后等待 300 秒（5 分钟）
tolerations:
- key: "node.kubernetes.io/unreachable"
  operator: "Exists"
  effect: "NoExecute"
  tolerationSeconds: 300
```

> 这意味着默认情况下，节点 NotReady/Unreachable 5 分钟后，Pod 会被驱逐。如果你的 Pod 需要更长容忍时间，可以显式声明更大的 tolerationSeconds。

#### Kubernetes 自动添加的污点

| 自动污点 | 触发条件 |
|---|---|
| `node.kubernetes.io/not-ready` | 节点 NodeReady 条件为 False |
| `node.kubernetes.io/unreachable` | 节点从 NodeController 不可达 |
| `node.kubernetes.io/memory-pressure` | 节点内存压力 |
| `node.kubernetes.io/disk-pressure` | 节点磁盘压力 |
| `node.kubernetes.io/pid-pressure` | 节点 PID 资源不足 |
| `node.kubernetes.io/network-unavailable` | 节点网络未配置 |
| `node.kubernetes.io/unschedulable` | 节点被 cordon 标记为不可调度 |

这些污点由 kubelet 和 node-controller 自动管理，无需手动添加。

#### 驱逐时间实战：维护场景

```bash
# 1. 给节点打维护污点（NoExecute 驱逐已运行 Pod）
kubectl taint nodes node-03 maint=planned:NoExecute

# 2. 没有 tolerationSeconds 的容忍 → Pod 永不驱逐
# 3. tolerationSeconds=0 的容忍 → Pod 立即驱逐
# 4. tolerationSeconds=3600 → Pod 还能运行 1 小时再被驱逐
```

```yaml
# 立即驱逐的容忍（tolerationSeconds=0）
tolerations:
- key: "maint"
  operator: "Equal"
  value: "planned"
  effect: "NoExecute"
  tolerationSeconds: 0    # 等于 0 → 立即驱逐

# 优雅容忍（给 Pod 1 小时时间完成工作）
tolerations:
- key: "maint"
  operator: "Equal"
  value: "planned"
  effect: "NoExecute"
  tolerationSeconds: 3600  # 1 小时后驱逐
```

---

## 调度策略对比总结

| 策略 | 作用方向 | 约束类型 | 粒度 | 适用场景 |
|---|---|---|---|---|
| **nodeSelector** | Pod → Node | 硬约束 | 精确匹配 | 简单的节点分类 |
| **nodeAffinity** | Pod → Node | 硬 + 轟 | In/NotIn/Exists 等 | 复杂节点选择逻辑 |
| **podAffinity** | Pod → Pod | 硬 + 轟 | topologyKey | 让相关 Pod 跑在一起 |
| **podAntiAffinity** | Pod → Pod | 硬 + 轟 | topologyKey | 让 Pod 分散避免单点 |
| **Taint/Toleration** | Node → Pod | NoSchedule/NoExecute | 节点级 | 专用节点、故障隔离 |

> **组合使用建议**：生产环境中，通常用 nodeAffinity 硬策略确保 Pod 跑在指定区域，podAntiAffinity 硬策略确保副本分散到不同节点，Taint/Toleration 实现专用节点准入控制。三者互补，缺一不可。