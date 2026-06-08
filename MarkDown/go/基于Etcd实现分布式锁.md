# 基于 Etcd 实现分布式锁

## 一、Etcd 基本概念

### 1.1 什么是 Etcd

Etcd 是一个**分布式、高可用的键值存储系统**，由 CoreOS 团队使用 Go 语言开发。它在分布式系统中扮演"配置中心"和"协调服务"的角色，是 Kubernetes 的核心组件之一——K8s 集群的所有状态数据（Pod、Service、Deployment 等）都存储在 etcd 中。

Etcd 的名字来源于 Unix `/etc` 目录（存放配置文件）+ 分布式（**d**istributed），合起来就是"分布式配置目录"。

**核心特性**：

| 特性 | 说明 |
|------|------|
| 强一致性 | 基于 Raft 共识算法，任意时刻所有节点数据一致 |
| 高可用 | 3 节点集群可容忍 1 节点故障，5 节点可容忍 2 节点故障 |
| 键值存储 | 类似文件系统的层级 Key-Value 模型，支持前缀查询和范围查询 |
| Watch 机制 | 客户端可监听某个 Key 或前缀的变化，实时推送事件 |
| Lease（租约） | Key 可绑定 TTL，到期自动删除，支持心跳续约 |
| MVCC | 多版本并发控制，每次修改保留历史版本 |
| 事务 | 支持 CAS（Compare-And-Swap）原子操作 |

### 1.2 Etcd 与同类产品对比

| 产品 | 一致性算法 | 存储模型 | CAP 类型 | 适用场景 |
|------|-----------|---------|---------|---------|
| Etcd | Raft | KV + MVCC | CP（强一致 + 分区容忍） | 配置中心、服务发现、分布式锁、K8s 元数据 |
| ZooKeeper | ZAB | 树形节点（类文件系统） | CP | Hadoop 生态、Kafka 元数据 |
| Consul | Raft | KV + 健康检查 | CP（默认） | 服务发现、健康检查、多数据中心 |

> **💡 Etcd vs ZooKeeper**：Etcd 使用 Go 编写，部署更轻量（单二进制文件），API 更简洁（gRPC + HTTP），社区更活跃。ZooKeeper 基于 Java，依赖 JVM，客户端协议复杂。

### 1.3 Etcd 架构概览

Etcd 集群由多个节点组成，使用 Raft 协议选举 Leader 并保证数据一致性。

**核心组件**：

```
┌─────────────────────────────────────────┐
│               Etcd 节点                   │
│  ┌─────────┐  ┌──────────────────────┐  │
│  │  gRPC   │  │    Raft 状态机        │  │
│  │ Server  │  │  ┌────┐ ┌────┐ ┌───┐ │  │
│  │         │  │  │日志│ │快照│ │状态│ │  │
│  │ :2379   │  │  └────┘ └────┘ └───┘ │  │
│  └─────────┘  └──────────────────────┘  │
│  ┌─────────┐  ┌──────────────────────┐  │
│  │  HTTP   │  │    BoltDB 存储        │  │
│  │ Server  │  │  (持久化 KV + MVCC)   │  │
│  │ :2380   │  │                      │  │
│  └─────────┘  └──────────────────────┘  │
└─────────────────────────────────────────┘
```

**两个关键端口**：

| 端口 | 用途 | 说明 |
|------|------|------|
| 2379 | Client 端口 | 客户端读写数据、Watch 事件、Lease 管理 |
| 2380 | Peer 端口 | 节点间 Raft 日志复制、心跳、Leader 选举 |

**Raft 共识算法核心概念**：

| 概念 | 说明 |
|------|------|
| Leader | 集群唯一领导者，处理所有写请求，将日志复制到 Follower |
| Follower | 被动接收 Leader 的日志复制，不处理写请求 |
| Candidate | Follower 超时未收到 Leader 心跳时，发起选举的中间状态 |
| Term（任期） | Leader 的任期编号，单调递增，选举时 Term + 1 |
| Log Entry | 包含 Term 编号、Index 编号和实际数据的日志条目 |
| Committed | 日志被集群多数节点确认后变为 Committed 状态，可安全应用到状态机 |

**Raft 工作流程**：

1. **Leader 选举**：Follower 在随机超时（150-300ms）后未收到心跳 → 变为 Candidate → Term + 1 → 发起投票。获得多数票者成为 Leader。
2. **日志复制**：Client 写请求 → Leader 先写入本地日志 → 并行复制到所有 Follower → 多数确认 → Committed → 应用到状态机 → 返回 Client。
3. **安全性保证**：只有拥有最新 Committed 日志的节点才能成为 Leader（选举限制）。

**数据模型**：

Etcd 的数据模型是**扁平的 KV 存储**，但通过 Key 命名约定模拟层级结构：

```
/registry/pods/default/nginx-pod      →  Pod 数据
/registry/services/default/my-svc     →  Service 数据
/registry/deployments/default/my-app  →  Deployment 数据
```

支持前缀查询（`--prefix`）和范围查询，可高效获取某个"目录"下所有数据。

**MVCC（多版本并发控制）**：

每次修改 Key 时，Etcd 不覆盖旧值，而是追加新版本：

| Key | Value | Revision | 操作 |
|-----|-------|----------|------|
| /foo | bar | 1 | PUT |
| /foo | bar2 | 2 | PUT |
| /foo | bar3 | 3 | PUT |

- **Revision**：全局递增的事务 ID，代表 etcd 集群的"时间"
- 支持按 Revision 范围查询历史数据
- 定期 Compaction（压缩）清理旧版本，释放存储空间

**WAL（Write-Ahead Log）与 Snapshot**：

```
Client 写请求
    ↓
WAL（预写日志，顺序写磁盘）── 持久化，防宕机丢失
    ↓
Raft Log（内存 + 磁盘）
    ↓
Apply to State Machine（应用到 BoltDB）
    ↓
Snapshot（定期快照，压缩历史日志）
```

- **WAL**：每次写操作先写入 WAL 文件，确保宕机后可恢复
- **Snapshot**：定期对状态机做快照，清理旧的 WAL 日志，控制磁盘占用
- 恢复流程：加载最新 Snapshot → 重放后续 WAL → 追上集群状态

## 二、Etcd 常用命令

### 2.1 基础 CRUD

```bash
# 写入 Key
etcdctl put /config/app/name "my-app"
# OK

# 读取 Key
etcdctl get /config/app/name
# /config/app/name
# my-app

# 读取 Key（只返回值，不显示 Key）
etcdctl get /config/app/name --print-value-only
# my-app

# 读取 Key 的详细元数据（版本信息）
etcdctl get /config/app/name -w json
# {"header":{"cluster_id":...,"revision":5,...},"kvs":[{"key":"L2NvbmZpZy9hcHAvbmFtZQ==",...}]}

# 删除 Key
etcdctl del /config/app/name
# 1
```

### 2.2 前缀查询与范围查询

```bash
# 前缀查询：列出 /config/app/ 下所有 Key
etcdctl put /config/app/name "my-app"
etcdctl put /config/app/port "8080"
etcdctl put /config/app/debug "true"

etcdctl get /config/app/ --prefix
# /config/app/debug
# true
# /config/app/name
# my-app
# /config/app/port
# 8080

# 范围查询：获取 /config/app/a 到 /config/app/z 之间的 Key
etcdctl get /config/app/a /config/app/z

# 只列出 Key（不显示值）
etcdctl get /config/app/ --prefix --keys-only
```

### 2.3 Watch 监听

```bash
# 终端 1：监听某个 Key
etcdctl watch /config/app/name

# 终端 2：修改 Key
etcdctl put /config/app/name "new-app"

# 终端 1 输出：
# PUT
# /config/app/name
# new-app

# 前缀监听
etcdctl watch /config/app/ --prefix

# 从历史版本开始监听（Revision ≥ 10 的事件）
etcdctl watch /config/app/ --prefix --rev=10

# 交互式 Watch（可以连续输入多个 watch 命令）
etcdctl watch -i
watch /config/app/name
watch /config/db/
```

### 2.4 Lease 租约

```bash
# 创建一个 60 秒的租约
etcdctl lease grant 60
# lease 694d8a4b3f2a001a granted with TTL(60s)

# 将 Key 绑定到租约（60 秒后自动删除）
etcdctl put /session/user1 "active" --lease=694d8a4b3f2a001a

# 查看租约信息
etcdctl lease timetolive 694d8a4b3f2a001a
# lease 694d8a4b3f2a001a granted with TTL(60s), remaining(55s)

# 查看租约关联的 Key
etcdctl lease timetolive 694d8a4b3f2a001a --keys

# 续约：重置 TTL（KeepAlive）
etcdctl lease keep-alive 694d8a4b3f2a001a
# lease 694d8a4b3f2a001a keepalived with TTL(60)

# 撤销租约（立即删除关联的 Key）
etcdctl lease revoke 694d8a4b3f2a001a
```

### 2.5 集群管理

```bash
# 查看集群成员列表
etcdctl member list --write-out=table
+------------------+---------+--------+------------------------+------------------------+------------+
|        ID        | STATUS  |  NAME  |       PEER ADDRS       |      CLIENT ADDRS      | IS LEARNER |
+------------------+---------+--------+------------------------+------------------------+------------+
| 8e9e05c52164694d | started | node-1 | http://10.0.0.1:2380  | http://10.0.0.1:2379   |      false |
| 91bc3c398fb3c146 | started | node-2 | http://10.0.0.2:2380  | http://10.0.0.2:2379   |      false |
| fd422379fda50e48 | started | node-3 | http://10.0.0.3:2380  | http://10.0.0.3:2379   |      false |
+------------------+---------+--------+------------------------+------------------------+------------+

# 查看端点状态（含 Leader 信息）
etcdctl endpoint status --write-out=table
+------------------------+------------------+---------+---------+-----------+-----------+------------+
|        ENDPOINT        |        ID        | VERSION | DB SIZE | IS LEADER | RAFT TERM | RAFT INDEX |
+------------------------+------------------+---------+---------+-----------+-----------+------------+
| http://10.0.0.1:2379   | 8e9e05c52164694d |  3.5.15 |   25 kB |      true |         4 |         42 |
| http://10.0.0.2:2379   | 91bc3c398fb3c146 |  3.5.15 |   25 kB |     false |         4 |         42 |
| http://10.0.0.3:2379   | fd422379fda50e48 |  3.5.15 |   25 kB |     false |         4 |         42 |
+------------------------+------------------+---------+---------+-----------+-----------+------------+

# 健康检查
etcdctl endpoint health
# http://10.0.0.1:2379 is healthy: successfully committed proposal
# http://10.0.0.2:2379 is healthy: successfully committed proposal
# http://10.0.0.3:2379 is healthy: successfully committed proposal

# 添加新成员
etcdctl member add node-4 --peer-urls=http://10.0.0.4:2380

# 移除成员
etcdctl member remove 8e9e05c52164694d

# 查看告警（如磁盘空间不足）
etcdctl alarm list

# 碎片整理（释放磁盘空间）
etcdctl defrag
```

## 三、Etcd 分布式锁原理

### 3.1 为什么 Etcd 适合实现分布式锁

Etcd 基于 Raft 算法保证数据强一致性，搭配 Lease 自动过期和 Watch 实时通知，天然适合实现分布式锁。相比 Redis 实现，Etcd 的强一致性保证在 CP 场景下可靠性更高，不会出现主从切换丢锁的问题。

### 3.2 两种锁实现方式

| 方式 | 特点 | Etcd 实现方式 |
|------|------|--------------|
| 保持独占 | 同一时刻只有一个客户端能获得锁 | 使用 CAS（CompareAndSwap）操作，通过 `prevExist` 参数保证只有一个客户端成功创建某个 Key（获得锁） |
| 控制时序 | 多个客户端按全局唯一顺序依次获得锁 | 使用 `POST` 创建有序键，自动生成递增序号键名，并按顺序列出所有键；客户端通过键中存储的值（如编号）标识自己 |

### 3.3 控制时序的关键点

**键名（自动生成）→ 决定顺序**

```
/lock/0000000001  ← 第一个客户端
/lock/0000000002  ← 第二个客户端
/lock/0000000003  ← 第三个客户端
```

**键值（客户端写入）→ 标识客户端**

```
etcdctl put /lock/0000000001 "client-001"
```

客户端通过列出所有有序键，读取每个键的值，就知道自己是第几个获得锁，并可通过 Watch 监听前一个键的删除事件来等待执行。**不需要轮询，事件驱动，零 CPU 空转。**

## 四、搭建 Etcd 集群（Kubernetes）

### 4.1 环境说明

- **Kubernetes**: v1.28.2，3 节点（1 master + 2 worker）
- **容器运行时**: containerd v2.2.4
- **Helm**: v3.17.0
- **存储**: local-path (rancher.io/local-path)
- **etcd 镜像**: `registry.aliyuncs.com/google_containers/etcd:3.5.15-0`（阿里云 ACR 国内镜像，5 MiB/s 高速拉取）

### 4.2 踩坑：国内环境 Docker Hub 不可达

直接拉取 `docker.io/bitnami/etcd` 会超时（`dial tcp 108.160.169.185:443: i/o timeout`）。免费 Docker Hub 代理（daocloud、dockerproxy 等）不稳定且大多不缓存 Bitnami 镜像。

**解决方案**：使用阿里云 ACR 的 Google Container Registry 镜像 `registry.aliyuncs.com/google_containers/etcd`，不走 Docker Hub。

### 4.3 步骤 1：配置 containerd 镜像加速（可选，推荐）

如果还需要拉取其他 Docker Hub 镜像，为 containerd 配置国内镜像代理：

```bash
mkdir -p /etc/containerd/certs.d/docker.io
cat > /etc/containerd/certs.d/docker.io/hosts.toml << 'EOF'
server = "https://registry-1.docker.io"

[host."https://dockerproxy.com"]
  capabilities = ["pull", "resolve"]

[host."https://docker.1ms.run"]
  capabilities = ["pull", "resolve"]

[host."https://hub.rat.dev"]
  capabilities = ["pull", "resolve"]
EOF
```

修改 containerd 配置，设置 `config_path`：

```bash
cp /etc/containerd/config.toml /etc/containerd/config.toml.bak
sed -i "s|config_path = ''|config_path = '/etc/containerd/certs.d'|" /etc/containerd/config.toml
systemctl restart containerd
```

### 4.4 步骤 2：创建 Headless Service + Client Service

`etcd-services.yaml`：

```yaml
---
# Headless Service — 用于 etcd peer 间互相发现
apiVersion: v1
kind: Service
metadata:
  name: etcd-headless
  namespace: default
  labels:
    app: etcd
spec:
  clusterIP: None
  publishNotReadyAddresses: true  # 关键！允许未 Ready 的 Pod 也有 DNS 记录
  selector:
    app: etcd
  ports:
    - name: peer
      port: 2380
      targetPort: 2380
    - name: client
      port: 2379
      targetPort: 2379
---
# Client Service — 供外部客户端访问
apiVersion: v1
kind: Service
metadata:
  name: etcd-client
  namespace: default
  labels:
    app: etcd
spec:
  type: ClusterIP
  selector:
    app: etcd
  ports:
    - name: client
      port: 2379
      targetPort: 2379
```

<div class="highlight-box">
<p><strong>💡 关键踩坑</strong>：必须设置 <code>publishNotReadyAddresses: true</code>。否则 etcd Pod 在未 Ready 时 DNS 解析不到彼此（<code>no such host</code>），集群永远无法形成——经典的鸡生蛋问题。</p>
</div>

### 4.5 步骤 3：创建 StatefulSet

`etcd-statefulset.yaml`：

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: etcd
  namespace: default
  labels:
    app: etcd
spec:
  serviceName: etcd-headless
  replicas: 3
  podManagementPolicy: Parallel  # 关键！3 个 Pod 同时启动才能形成 initial-cluster
  selector:
    matchLabels:
      app: etcd
  template:
    metadata:
      labels:
        app: etcd
    spec:
      terminationGracePeriodSeconds: 10
      containers:
        - name: etcd
          image: registry.aliyuncs.com/google_containers/etcd:3.5.15-0
          imagePullPolicy: IfNotPresent
          env:
            - name: POD_NAME   # 使用 Downward API 获取 Pod 名（官方 etcd 镜像无 hostname 命令）
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          command:
            - /bin/sh
            - -c
            - |
              PEERS="etcd-0=http://etcd-0.etcd-headless:2380,etcd-1=http://etcd-1.etcd-headless:2380,etcd-2=http://etcd-2.etcd-headless:2380"
              exec etcd \
                --name ${POD_NAME} \
                --listen-peer-urls http://0.0.0.0:2380 \
                --listen-client-urls http://0.0.0.0:2379 \
                --advertise-client-urls http://${POD_NAME}.etcd-headless:2379 \
                --initial-advertise-peer-urls http://${POD_NAME}.etcd-headless:2380 \
                --initial-cluster "${PEERS}" \
                --initial-cluster-token etcd-cluster \
                --initial-cluster-state new \
                --data-dir /var/run/etcd/data \
                --snapshot-count 10000 \
                --auto-compaction-retention 1 \
                --quota-backend-bytes 8589934592
          ports:
            - containerPort: 2379
              name: client
            - containerPort: 2380
              name: peer
          livenessProbe:
            exec:
              command:
                - /bin/sh
                - -c
                - etcdctl --endpoints=http://127.0.0.1:2379 endpoint health
            initialDelaySeconds: 15
            periodSeconds: 20
          readinessProbe:
            exec:
              command:
                - /bin/sh
                - -c
                - etcdctl --endpoints=http://127.0.0.1:2379 endpoint health
            initialDelaySeconds: 10
            periodSeconds: 10
          volumeMounts:
            - name: data
              mountPath: /var/run/etcd
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: local-path
        resources:
          requests:
            storage: 1Gi
```

**关键配置说明**：

| 配置项 | 说明 |
|--------|------|
| `podManagementPolicy: Parallel` | 3 个 Pod 同时启动，同时参与 initial-cluster 投票 |
| `publishNotReadyAddresses: true` | 未 Ready 的 Pod 也能通过 DNS 被发现 |
| `POD_NAME` (Downward API) | 官方 etcd 镜像是 scratch 基础镜像，没有 `hostname` 命令 |
| `--initial-cluster-state new` | 首次启动时创建新集群；数据已存在时自动忽略，正常加入 |
| 阿里云 ACR 镜像 | 国内高速拉取，不走 Docker Hub |

### 4.6 步骤 4：部署

```bash
kubectl apply -f etcd-services.yaml
kubectl apply -f etcd-statefulset.yaml
```

等待约 20 秒，检查状态：

```bash
$ kubectl get pods -l app=etcd
NAME     READY   STATUS    RESTARTS   AGE
etcd-0   1/1     Running   0          24s
etcd-1   1/1     Running   0          24s
etcd-2   1/1     Running   0          24s
```

### 4.7 步骤 5：验证集群

```bash
# 查看集群成员
$ kubectl exec etcd-0 -- etcdctl --endpoints=http://etcd-client:2379 member list --write-out=table
+------------------+---------+--------+----------------------------------+----------------------------------+------------+
|        ID        | STATUS  |  NAME  |            PEER ADDRS            |           CLIENT ADDRS           | IS LEARNER |
+------------------+---------+--------+----------------------------------+----------------------------------+------------+
| 3f54ac025181a433 | started | etcd-1 | http://etcd-1.etcd-headless:2380 | http://etcd-1.etcd-headless:2379 |      false |
| 7c5422fe4922f16f | started | etcd-2 | http://etcd-2.etcd-headless:2380 | http://etcd-2.etcd-headless:2379 |      false |
| e4ad7553eba80d25 | started | etcd-0 | http://etcd-0.etcd-headless:2380 | http://etcd-0.etcd-headless:2379 |      false |
+------------------+---------+--------+----------------------------------+----------------------------------+------------+

# 查看端点状态（Leader 信息）
$ kubectl exec etcd-0 -- etcdctl --endpoints=http://etcd-client:2379 endpoint status --write-out=table
+----------------------------------+------------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+
|             ENDPOINT             |        ID        | VERSION | DB SIZE | IS LEADER | IS LEARNER | RAFT TERM | RAFT INDEX | RAFT APPLIED INDEX | ERRORS |
+----------------------------------+------------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+
| http://etcd-0.etcd-headless:2379 | e4ad7553eba80d25 |  3.5.15 |   20 kB |     false |      false |         2 |         21 |                 21 |        |
| http://etcd-1.etcd-headless:2379 | 3f54ac025181a433 |  3.5.15 |   20 kB |      true |      false |         2 |         21 |                 21 |        |
| http://etcd-2.etcd-headless:2379 | 7c5422fe4922f16f |  3.5.15 |   20 kB |     false |      false |         2 |         21 |                 21 |        |
+----------------------------------+------------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+

# 读写测试
$ kubectl exec etcd-0 -- etcdctl --endpoints=http://etcd-client:2379 put /hello world
OK
$ kubectl exec etcd-0 -- etcdctl --endpoints=http://etcd-client:2379 get /hello
/hello
world
```

### 4.8 客户端连接方式

- **集群内部**：`http://etcd-client:2379`（通过 Client Service）
- **指定端点**：`http://etcd-0.etcd-headless:2379,http://etcd-1.etcd-headless:2379,http://etcd-2.etcd-headless:2379`
- **Go 客户端示例**：
  ```go
  import "go.etcd.io/etcd/client/v3"

  cli, _ := clientv3.New(clientv3.Config{
      Endpoints:   []string{"etcd-client:2379"},
      DialTimeout: 5 * time.Second,
  })
  ```

### 4.9 踩坑总结

| 问题 | 原因 | 解决 |
|------|------|------|
| Docker Hub `i/o timeout` | 国内网络不通 | 使用阿里云 ACR 镜像 |
| `hostname: command not found` | 官方 etcd 镜像是 scratch，无 coreutils | 使用 Downward API 注入 Pod 名 |
| `no such host` DNS 解析失败 | Pod 未 Ready 时无 DNS 记录 | Service 加 `publishNotReadyAddresses: true` |
| `request timed out` 集群无法形成 | Pod 互相发现不了 | 以上两条同时修复 + `podManagementPolicy: Parallel` |
| daocloud/proxy 返回 403 | 免费代理不稳定/不缓存 Bitnami 镜像 | 放弃 Docker Hub 镜像，直接用 ACR |

## 五、Go 操作 Etcd：Watch

```go
package main

import (
    "context"
    "fmt"
    "go.etcd.io/etcd/client/v3"
    "time"
)

func main() {
    // 创建 etcd 客户端
    cli, err := clientv3.New(clientv3.Config{
        Endpoints:   []string{"127.0.0.1:2379"},
        DialTimeout: 5 * time.Second,
    })
    if err != nil {
        fmt.Printf("connect to etcd failed, err:%v\n", err)
        return
    }
    fmt.Println("connect to etcd success")
    defer cli.Close()

    // 创建 Watch 监听器
    rch := cli.Watch(context.Background(), "lmh") // <-chan WatchResponse

    // 使用 range 循环从 channel 读取 Watch 事件
    for wresp := range rch {
        for _, ev := range wresp.Events {
            fmt.Printf("Type: %s Key:%s Value:%s\n", ev.Type, ev.Kv.Key, ev.Kv.Value)
        }
    }
}
```

## 六、Go 操作 Etcd：Lease 租约

### 6.1 基础租约

```go
package main

import (
    "context"
    "fmt"
    "go.etcd.io/etcd/client/v3"
    "log"
    "time"
)

func main() {
    cli, err := clientv3.New(clientv3.Config{
        Endpoints:   []string{"127.0.0.1:2379"},
        DialTimeout: time.Second * 5,
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println("connect to etcd success.")
    defer cli.Close()

    // 创建一个 5 秒的租约
    resp, err := cli.Grant(context.TODO(), 5)
    if err != nil {
        log.Fatal(err)
    }

    // 5 秒之后 /lmh/ 这个 Key 会被自动删除
    _, err = cli.Put(context.TODO(), "/lmh/", "lmh", clientv3.WithLease(resp.ID))
    if err != nil {
        log.Fatal(err)
    }
}
```

### 6.2 KeepAlive 续约

```go
package main

import (
    "context"
    "fmt"
    "go.etcd.io/etcd/client/v3"
    "log"
    "time"
)

func main() {
    cli, err := clientv3.New(clientv3.Config{
        Endpoints:   []string{"127.0.0.1:2379"},
        DialTimeout: time.Second * 5,
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println("connect to etcd success.")
    defer cli.Close()

    resp, err := cli.Grant(context.TODO(), 5)
    if err != nil {
        log.Fatal(err)
    }

    _, err = cli.Put(context.TODO(), "/lmh/", "lmh", clientv3.WithLease(resp.ID))
    if err != nil {
        log.Fatal(err)
    }

    // KeepAlive 保持 Key 永不过期
    ch, kaerr := cli.KeepAlive(context.TODO(), resp.ID)
    if kaerr != nil {
        log.Fatal(kaerr)
    }
    for {
        ka := <-ch
        fmt.Println("ttl:", ka.TTL)
    }
}
```

## 七、Go 基于 Etcd 实现分布式锁

### 7.1 使用 concurrency 包（官方推荐）

Etcd 官方 Go SDK 提供了 `concurrency` 包，封装了 Session、Mutex 等原语：

```go
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

func main() {
    // 连接 etcd
    endpoints := []string{"127.0.0.1:2379"}
    cli, err := clientv3.New(clientv3.Config{
        Endpoints:   endpoints,
        DialTimeout: 5 * time.Second,
    })
    if err != nil {
        log.Fatal(err)
    }
    defer cli.Close()

    // 创建两个单独的 Session 用来演示锁竞争
    s1, err := concurrency.NewSession(cli)
    if err != nil {
        log.Fatal(err)
    }
    defer s1.Close()
    m1 := concurrency.NewMutex(s1, "/my-lock/")

    s2, err := concurrency.NewSession(cli)
    if err != nil {
        log.Fatal(err)
    }
    defer s2.Close()
    m2 := concurrency.NewMutex(s2, "/my-lock/")

    // Session s1 获取锁
    fmt.Println("s1: 尝试获取锁...")
    if err := m1.Lock(context.TODO()); err != nil {
        log.Fatal(err)
    }
    fmt.Println("s1: 成功获取锁")

    // 启动 goroutine，让 s2 尝试获取锁（会被阻塞）
    m2Locked := make(chan struct{})
    go func() {
        defer close(m2Locked)
        fmt.Println("s2: 尝试获取锁（会阻塞等待 s1 释放）...")
        if err := m2.Lock(context.TODO()); err != nil {
            log.Fatal(err)
        }
        fmt.Println("s2: 成功获取锁")
    }()

    // 等待一段时间，模拟业务处理
    time.Sleep(3 * time.Second)
    fmt.Println("s1: 业务处理完成")

    // Session s1 释放锁
    if err := m1.Unlock(context.TODO()); err != nil {
        log.Fatal(err)
    }
    fmt.Println("s1: 已释放锁")

    // 等待 s2 获取锁的信号
    <-m2Locked
    fmt.Println("s2: 获取锁成功，程序退出")

    // 可选：s2 释放锁（程序结束前）
    if err := m2.Unlock(context.TODO()); err != nil {
        log.Fatal(err)
    }
    fmt.Println("s2: 已释放锁")
}
```

### 7.2 实现原理

`concurrency.Mutex` 的底层实现就是**控制时序模式**：

1. **NewSession** → 创建一个 Lease（自动续约），Session 关闭时 Lease 自动撤销 → 对应的锁 Key 被删除 → 实现故障自动释放
2. **Lock()** → `PUT /my-lock/` + `WithLease` → 创建有序 Key（如 `/my-lock/00000001`）
3. **Get prefix** → 列出 `/my-lock/` 下所有 Key，检查自己的序号是不是最小的
4. **如果不是最小** → Watch 前一个 Key 的删除事件（`DELETE`），阻塞等待
5. **Unlock()** → 删除自己的 Key，下一个客户端收到 Watch 事件 → 获得锁

```text
Session 生命周期：
  NewSession → 创建 Lease（TTL=60s，自动续约）
       ↓
  Lock()    → 创建 Key 绑定 Lease
       ↓
  业务处理中  → KeepAlive 持续心跳
       ↓
  Unlock()  → 删除 Key
       ↓
  Close()   → 撤销 Lease → 所有 Key 被删除
```

<div class="highlight-box">
<p><strong>💡 Session 的作用</strong>：Session 是锁的"保险机制"。如果客户端崩溃或网络断开，Lease 无法续约 → 60 秒后 TTL 到期 → Key 自动删除 → 锁自动释放，不会死锁。这是 etcd 分布式锁相对 Redis 实现的关键优势。</p>
</div>