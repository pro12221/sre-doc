# Kubernetes 持久化存储

Kubernetes 中 Pod 的生命周期是短暂的，Pod 重启或重新调度后，容器内的数据会丢失。为了实现数据持久化，Kubernetes 提供了一套完整的存储抽象体系——PV（PersistentVolume）、PVC（PersistentVolumeClaim）和 StorageClass，将存储资源的"提供"与"消费"彻底解耦。本章从核心概念入手，逐步深入到 Local PV、local-path-provisioner、FlexVolume 和 CSI 等存储插件机制。

---

## PV、PVC、StorageClass 概念和区别

### 为什么需要这套抽象？

在 Kubernetes 中，Pod 本身是无状态的，容器内的文件系统是临时的。如果希望 Pod 在重新调度（例如节点故障或升级）后依然能访问之前的数据，就必须使用具备持久化能力的网络存储。但问题在于：底层存储类型多种多样（NFS、iSCSI、Ceph、云盘等），如果让应用开发者直接配置这些存储细节，会带来巨大的耦合和维护负担。

Kubernetes 通过 PV/PVC/StorageClass 这套资源抽象，实现了"接口与实现的分离"——让开发者只关心"我需要什么"，让运维只关心"我有什么"。

### 三者关系概览

```
┌─────────────────────────────────────────────────────────────┐
│                        开发者 (Dev)                          │
│                                                             │
│  创建 PVC：声明需求（容量、访问模式、StorageClass）            │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────┐     绑定      ┌─────────┐                      │
│  │   PVC   │ ◄──────────► │   PV    │                      │
│  └─────────┘              └─────────┘                      │
│       │                        ▲                            │
│       │                        │ 动态创建                    │
│       ▼                        │                            │
│  ┌─────────┐              ┌──────────────┐                  │
│  │   Pod   │              │ StorageClass │                  │
│  └─────────┘              │ + Provisioner│                  │
│                           └──────────────┘                  │
│                                  ▲                          │
│                                  │ 定义                      │
│                            运维人员 (Ops)                    │
└─────────────────────────────────────────────────────────────┘
```

### PersistentVolume（PV）

**PV 是集群级别的存储资源**，代表集群中一块已经存在的、具体的存储空间。它由集群管理员预先配置，包含了存储的全部细节：

| 字段 | 说明 |
|---|---|
| `capacity.storage` | 存储容量大小（如 10Gi） |
| `accessModes` | 访问模式：RWO / ROX / RWX |
| `persistentVolumeReclaimPolicy` | 回收策略：Retain / Delete / Recycle（已废弃） |
| `storageClassName` | 所属 StorageClass 名称 |
| `volumeMode` | 卷模式：Filesystem（默认）/ Block |
| 后端存储配置 | NFS、iSCSI、Ceph、云盘等具体配置 |

**创建静态 PV 示例（NFS）：**

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-nfs-10gi
spec:
  capacity:
    storage: 10Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: slow
  mountOptions:
    - hard
    - nfsvers=4.1
  nfs:
    server: 192.168.1.100
    path: /data/nfs/share
```

PV 有以下几个生命周期状态：

| 状态 | 说明 |
|---|---|
| **Available** | PV 已创建，尚未被任何 PVC 绑定，处于可用状态 |
| **Bound** | PV 已被 PVC 绑定，正在被使用 |
| **Released** | PVC 已删除，但 PV 尚未被回收（取决于回收策略） |
| **Failed** | 自动回收失败（如 Delete 策略下无法删除底层存储） |

### PersistentVolumeClaim（PVC）

**PVC 是命名空间级别的存储"申请单"**，由应用开发者创建，描述应用需要什么样的存储，而不关心这些存储具体从哪里来。PVC 的定义只包含"我需要什么"：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-app-pvc
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
  storageClassName: slow
```

**PVC 与 PV 的绑定规则：**

Kubernetes 控制平面的 `persistent-volume-controller` 持续监听并匹配满足 PVC 要求的 PV：

1. **容量匹配**：PV 的 `capacity.storage` 必须 ≥ PVC 的 `requests.storage`
2. **访问模式匹配**：PV 的 `accessModes` 必须包含 PVC 声明的访问模式
3. **StorageClass 匹配**：
   - PVC 指定了 `storageClassName: "slow"` → 只绑定 `storageClassName: slow` 的 PV
   - PVC 指定了 `storageClassName: ""` → 只绑定没有设置 `storageClassName` 的 PV（静态 PV）
   - PVC 未指定 `storageClassName` → 如果有默认 StorageClass，则使用默认 StorageClass 动态创建 PV
4. **LabelSelector**（可选）：通过标签精确匹配
5. **VolumeMode**：PV 和 PVC 的 `volumeMode` 必须一致

绑定是一对一的：一个 PVC 只能绑定一个 PV，一个 PV 也只能被一个 PVC 绑定。绑定后，Pod 即可通过 PVC 名称挂载存储卷。

**Pod 中使用 PVC：**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx-with-pvc
spec:
  containers:
    - name: nginx
      image: nginx:alpine
      volumeMounts:
        - name: data
          mountPath: /usr/share/nginx/html
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: my-app-pvc
```

### 访问模式（Access Modes）

| 模式 | 缩写 | 说明 | 适用场景 |
|---|---|---|---|
| **ReadWriteOnce** | RWO | 只能被单个节点以读写方式挂载 | 数据库、单实例应用 |
| **ReadOnlyMany** | ROX | 可以被多个节点以只读方式挂载 | 配置文件、静态资源 |
| **ReadWriteMany** | RWX | 可以被多个节点以读写方式挂载 | 共享文件系统、多 Pod 共享数据 |

不同存储后端支持的访问模式不同。例如块存储（EBS、云盘）通常只支持 RWO，NFS/CephFS 支持 RWX。

### StorageClass（存储类）

**StorageClass 是动态创建 PV 的"模板"**。手动管理成百上千个 PV 是运维灾难，StorageClass 定义了一个"存储模板"，告诉 Kubernetes 如何按需自动创建 PV。当用户创建指定了 `storageClassName` 的 PVC 时，如果找不到匹配的静态 PV，对应的 Provisioner 就会自动创建 PV 和底层存储。

**StorageClass YAML 示例：**

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"  # 设为默认
provisioner: ebs.csi.aws.com        # 指定使用哪个 Provisioner
parameters:                          # 传递给 Provisioner 的参数
  type: gp3
  iops: "4000"
  throughput: "200"
  encrypted: "true"
reclaimPolicy: Delete                # 回收策略
volumeBindingMode: WaitForFirstConsumer  # 卷绑定模式
allowVolumeExpansion: true           # 允许在线扩容
mountOptions:                        # 挂载选项
  - debug
```

**StorageClass 核心字段说明：**

| 字段 | 说明 |
|---|---|
| `provisioner` | **必填**，指定使用哪个存储插件（Provisioner）来创建卷 |
| `parameters` | 传递给 Provisioner 的具体参数，不同 Provisioner 支持的参数不同 |
| `reclaimPolicy` | 回收策略：`Delete`（删除 PVC 时自动删除 PV 和底层存储）或 `Retain`（保留，需要手动清理）。默认 `Delete` |
| `volumeBindingMode` | 绑定模式：`Immediate`（默认，PVC 创建后立即绑定）/ `WaitForFirstConsumer`（延迟到 Pod 使用时才创建） |
| `allowVolumeExpansion` | 是否允许在线扩容（修改 PVC 的 `storage` 请求后自动扩容） |
| `mountOptions` | 挂载选项，由 StorageClass 动态创建的 PV 会使用这些选项 |

**默认 StorageClass：**

集群管理员可以将某个 StorageClass 标记为默认：

```bash
kubectl patch storageclass fast-ssd -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

当 PVC 没有指定 `storageClassName` 时，会自动使用默认 StorageClass 动态创建 PV。如果集群中多个 StorageClass 都标记为默认，Kubernetes 使用最新创建的那个。

### 静态供应 vs 动态供应

| 维度 | 静态供应（Static Provisioning） | 动态供应（Dynamic Provisioning） |
|---|---|---|
| **PV 创建方式** | 管理员手动创建 PV | Provisioner 根据 StorageClass 自动创建 |
| **适用场景** | 小规模、已有存储资源、特殊配置 | 大规模、云环境、自动化运维 |
| **PVC 写法** | 可指定 `volumeName` 精确绑定 | 指定 `storageClassName` 即可 |
| **运维成本** | 高，需要提前规划和创建 PV | 低，按需自动创建 |
| **灵活性** | 低，扩容需要手动操作 | 高，支持在线扩容、快照等 |

**动态供应 PVC 示例：**

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: dynamic-pvc
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: fast-ssd    # 指定 StorageClass
  resources:
    requests:
      storage: 20Gi
```

创建此 PVC 后，`fast-ssd` StorageClass 对应的 Provisioner 会自动创建 20Gi 的 PV 和底层存储，并与 PVC 绑定。

### 回收策略（Reclaim Policy）

| 策略 | 行为 | 适用场景 |
|---|---|---|
| **Retain** | PVC 删除后，PV 和底层存储保留，需要手动清理 | 生产环境、重要数据 |
| **Delete** | PVC 删除后，自动删除 PV 和底层存储 | 测试环境、临时数据 |
| **Recycle** | 已废弃（Kubernetes 1.33+ 移除），执行 `rm -rf` 后重新可用 | 不再推荐使用 |

### 卷绑定模式（VolumeBindingMode）

这个参数对云环境至关重要，直接影响 Pod 能否成功挂载卷。

**Immediate（默认）：**
PVC 创建后立即创建 PV 和底层存储。问题是：在云环境中，块存储（如 AWS EBS）是可用区（AZ）级别的资源。如果 Pod 最终被调度到与存储卷不同的可用区，Pod 将永远无法挂载该卷。

**WaitForFirstConsumer（推荐）：**
延迟 PV 的创建，直到第一个使用该 PVC 的 Pod 被成功调度到某个节点上。此时 Provisioner 会在 Pod 所在可用区创建卷，确保亲和性。

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: zonal-storage
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer  # 关键配置
```

### 最佳实践

1. **生产环境使用动态供应**：配置合适的 StorageClass，避免手动管理 PV
2. **重要数据使用 Retain 策略**：防止误删 PVC 导致数据丢失
3. **云环境启用 WaitForFirstConsumer**：解决跨可用区挂载问题
4. **合理选择访问模式**：大部分场景用 RWO 即可，避免引入不必要的复杂度
5. **监控存储使用情况**：PVC 的 `storage` 字段是限制值，实际使用量需要监控底层存储

---

## Local PV

### 概念与原理

Local Persistent Volume（Local PV）表示**挂载在节点本地的存储设备**，如本地磁盘、SSD、NVMe 等。与 hostPath 不同，Local PV 通过 PV/PVC 机制管理，具有持久化能力，且 Kubernetes 调度器会感知 Local PV 的节点亲和性。

Local PV 的核心特性是 `nodeAffinity`——PV 必须声明自己位于哪个节点上，调度器会确保使用该 PV 的 Pod 被调度到该节点。

### 为什么需要 Local PV？

| 场景 | 说明 |
|---|---|
| **极低延迟需求** | 本地 NVMe SSD 的延迟远低于网络存储（如 Kafka、Elasticsearch） |
| **高吞吐 IO** | 绕过网络协议栈，直接访问本地磁盘 |
| **成本优化** | 利用节点已有的本地磁盘，无需额外购买网络存储 |
| **缓存/临时数据** | 对数据持久性要求不高，但需要高性能的场景 |

### Local PV vs hostPath

| 维度 | hostPath | Local PV |
|---|---|---|
| **持久性** | Pod 删除后数据可能丢失 | 独立于 Pod 生命周期 |
| **调度感知** | 调度器不了解 hostPath 所在节点 | 通过 `nodeAffinity` 保证调度到正确节点 |
| **动态供应** | 不支持 | 部分 Provisioner 支持（如 local-path-provisioner） |
| **管理方式** | 直接在 Pod 中指定路径 | 通过 PV/PVC 标准 API 管理 |
| **适用场景** | 测试、临时挂载 | 生产环境的本地高性能存储 |

### Local PV 的 StorageClass 定义

Local PV 不支持自动制备（没有内置 Provisioner），需要手动创建 PV。但 StorageClass 仍然需要定义，用于设置 `volumeBindingMode: WaitForFirstConsumer`：

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-storage
provisioner: kubernetes.io/no-provisioner  # 表示不支持自动制备
volumeBindingMode: WaitForFirstConsumer    # 延迟绑定，等待 Pod 调度
```

### 创建 Local PV

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: local-pv-ssd-node1
spec:
  capacity:
    storage: 100Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-storage
  local:
    path: /mnt/disks/ssd1
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - node1
```

**关键点：**
- `local.path` 指定节点上的本地路径
- `nodeAffinity` 必须指定，确保 Pod 被调度到该节点
- `storageClassName` 与 StorageClass 定义一致

### Local PV 的限制与风险

| 限制 | 说明 |
|---|---|
| **数据不具备高可用性** | 节点宕机后数据不可访问，需要应用层有副本机制 |
| **不支持动态扩容** | 本地磁盘容量固定，无法在线扩容 |
| **调度耦合** | Pod 必须调度到特定节点，降低调度灵活性 |
| **手动管理** | 需要手动创建 PV 和准备磁盘 |

**适用场景**：Kafka、Elasticsearch、Cassandra 等应用层已实现数据副本的分布式系统，它们可以利用本地高性能存储，同时通过应用层副本保证数据安全。

---

## local-path-provisioner

### 什么是 local-path-provisioner

local-path-provisioner 是 Rancher 开源的一个轻量级存储 Provisioner，它为 Kubernetes 集群提供了一种**利用节点本地存储自动创建 PV** 的能力。K3s 默认自带此组件。

它本质上是一个**自动管理 hostPath 的控制器**，让用户像使用 NFS/Longhorn 那样通过 PVC 申请存储，但数据实际存储在节点本地磁盘上。

### 工作原理

```
PVC 创建（指定 storageClassName: local-path）
    │
    ▼
local-path-provisioner 控制器检测到 PVC 事件
    │
    ▼
WaitForFirstConsumer → 等待 Pod 调度到具体节点
    │
    ▼
在目标节点上启动 helper Pod
    │
    ▼
helper Pod 在节点上创建目录：/opt/local-path-provisioner/pvc-<uuid>
    │
    ▼
控制器创建 hostPath 类型的 PV，指向该目录
    │
    ▼
PV 与 PVC 绑定 → Pod 挂载成功
```

### 安装与部署

K3s 默认自带，无需额外安装。对于标准 Kubernetes 集群：

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/master/deploy/local-path-storage.yaml
```

安装后会自动创建：
- 命名空间 `local-path-storage`
- StorageClass `local-path`
- Deployment `local-path-provisioner`
- ConfigMap `local-path-config`

### 默认 StorageClass

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-path
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: rancher.io/local-path
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
```

### 使用方式

```yaml
# PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: local-path-pvc
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: local-path
  resources:
    requests:
      storage: 2Gi

---
# Pod
apiVersion: v1
kind: Pod
metadata:
  name: volume-test
spec:
  containers:
    - name: volume-test
      image: nginx:stable-alpine
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: local-path-pvc
```

### 配置自定义路径

默认存储路径为 `/opt/local-path-provisioner/`。通过 ConfigMap 可自定义每个节点的路径：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-path-config
  namespace: local-path-storage
data:
  config.json: |
    {
      "nodePathMap": [
        {
          "node": "DEFAULT_PATH_FOR_NON_LISTED_NODES",
          "paths": ["/opt/local-path-provisioner"]
        },
        {
          "node": "node-with-ssd",
          "paths": ["/data/ssd", "/data/ssd2"]
        }
      ]
    }
```

### 多 StorageClass 配置

local-path-provisioner 支持定义多个 StorageClass，使用不同的节点路径：

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ssd-local-path
provisioner: rancher.io/local-path
parameters:
  nodePath: /data/ssd
  pathPattern: "{{ .PVC.Namespace }}/{{ .PVC.Name }}"
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
```

### 优缺点

| 优点 | 缺点 |
|---|---|
| 轻量、部署极简单（一个 Deployment + ConfigMap） | 数据不具备高可用性（只在单节点） |
| 动态创建与自动清理 | 节点损坏或被调度走，数据无法访问 |
| 非常适合开发、测试环境 | 不支持多节点访问（非网络存储） |
| 支持标准 PVC/PV API | 性能依赖节点本地磁盘 IO，无数据同步 |
| K3s 默认集成，开箱即用 | 不支持卷容量限制（容量字段被忽略） |

---

## StorageClass 如何与 Provisioner 关联

### 关联机制

StorageClass 与 Provisioner 的关联是通过 `provisioner` 字段完成的，这是一个**名称匹配**机制：

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: my-sc
provisioner: rancher.io/local-path    # 这个名称必须与运行中的 Provisioner 一致
```

### 完整的关联流程

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. 集群管理员部署 Provisioner（如 local-path-provisioner）         │
│    - Provisioner 以 Deployment 形式运行在集群中                    │
│    - Provisioner 启动时注册自己能处理的 provisioner 名称            │
│    - 例如：rancher.io/local-path                                  │
│                                                                  │
│ 2. 集群管理员创建 StorageClass                                    │
│    - provisioner 字段设置为 "rancher.io/local-path"               │
│    - 这个名称必须与 Provisioner 注册的名称一致                      │
│                                                                  │
│ 3. 用户创建 PVC，指定 storageClassName: my-sc                     │
│                                                                  │
│ 4. Kubernetes 控制平面：                                          │
│    a. 查找名为 "my-sc" 的 StorageClass                            │
│    b. 读取其 provisioner 字段：rancher.io/local-path              │
│    c. 查找注册了该名称的 Provisioner                               │
│    d. 调用 Provisioner 的 Provision(volumeOptions) 方法           │
│                                                                  │
│ 5. Provisioner 创建底层存储和 PV 对象                              │
│                                                                  │
│ 6. PV 与 PVC 绑定                                                 │
└──────────────────────────────────────────────────────────────────┘
```

### 常用 Provisioner 名称对照

| Provisioner 名称 | 存储类型 | 来源 |
|---|---|---|
| `kubernetes.io/no-provisioner` | 静态 Local PV（不自动制备） | Kubernetes 内置 |
| `rancher.io/local-path` | 本地路径（hostPath/local） | Rancher |
| `ebs.csi.aws.com` | AWS EBS 云盘 | AWS CSI Driver |
| `efs.csi.aws.com` | AWS EFS 文件存储 | AWS CSI Driver |
| `diskplugin.csi.alibabacloud.com` | 阿里云云盘 | 阿里云 CSI Driver |
| `nasplugin.csi.alibabacloud.com` | 阿里云 NAS | 阿里云 CSI Driver |
| `everest-csi-provisioner` | 华为云存储 | 华为云 CCE |
| `kubernetes.io/gce-pd` | Google Cloud Persistent Disk | Kubernetes 内置（树内） |
| `kubernetes.io/aws-ebs` | AWS EBS（树内，已废弃） | Kubernetes 内置（树内） |
| `kubernetes.io/nfs` | NFS（树内，已废弃） | Kubernetes 内置（树内） |

### 树内 Provisioner vs CSI Provisioner

Kubernetes 早期版本的存储插件是"树内（in-tree）"的，即编译在 Kubernetes 核心代码中。这种方式存在严重问题：
- 存储插件与 Kubernetes 版本强绑定
- 新增存储插件需要修改 Kubernetes 核心代码
- 插件 bug 可能影响整个集群稳定性

因此社区正在将所有树内卷插件迁移到 CSI（Container Storage Interface）驱动。CSI 是树外（out-of-tree）的，独立于 Kubernetes 版本发布。

### 关键注意事项

1. **provisioner 名称必须精确匹配**：大小写敏感，不能有空格
2. **一个 Provisioner 可以对应多个 StorageClass**：通过不同的 `parameters` 区分存储类型
3. **Provisioner 必须提前部署**：在创建 StorageClass 之前，Provisioner 必须已经在集群中运行
4. **parameters 由 Provisioner 定义**：不同 Provisioner 支持的参数完全不同，需要查阅对应文档

---

## FlexVolume

### 什么是 FlexVolume

FlexVolume 是 Kubernetes v1.8+ 引入的一种存储插件扩展方式，允许用户编写外部可执行文件来实现自定义存储插件，而无需修改 Kubernetes 核心代码。

### 工作原理

FlexVolume 基于**可执行文件接口**：Kubernetes 在需要执行 Attach/Detach/Mount/Unmount 等操作时，调用预先放置在指定目录下的可执行文件（如 shell 脚本或二进制文件），并传递 JSON 格式的参数。

```
┌──────────────────────────────────────────────────────────────┐
│  kubelet / Controller Manager                                │
│       │                                                      │
│       │ 调用可执行文件                                         │
│       ▼                                                      │
│  /usr/libexec/kubernetes/kubelet-plugins/volume/exec/        │
│       └── k8s~nfs/                                           │
│              └── nfs    ← 可执行文件（shell 脚本/二进制）        │
│                                                              │
│  调用方式：                                                    │
│  ./nfs init                                                  │
│  ./nfs mount <mount-dir> <json-params>                       │
│  ./nfs unmount <mount-dir>                                   │
│  ./nfs attach <json-params> <node-name>                      │
│  ./nfs detach <mount-device> <node-name>                     │
└──────────────────────────────────────────────────────────────┘
```

### 插件目录结构

```
/usr/libexec/kubernetes/kubelet-plugins/volume/exec/
└── <vendor~driver>/
    └── <driver>          ← 可执行文件
```

例如 NFS 插件：
```
/usr/libexec/kubernetes/kubelet-plugins/volume/exec/
└── k8s~nfs/
    └── nfs
```

### FlexVolume 接口

FlexVolume 插件需要实现以下操作（根据存储类型，部分可选）：

| 操作 | 说明 | 必需 |
|---|---|---|
| `init` | 初始化插件，kubelet 启动时调用 | 是 |
| `attach` | 将卷附加到节点（如挂载云盘到虚拟机） | 块存储需要 |
| `detach` | 从节点分离卷 | 块存储需要 |
| `waitforattach` | 等待卷附加完成 | 块存储需要 |
| `isattached` | 检查卷是否已附加 | 块存储需要 |
| `mountdevice` | 将附加的设备挂载到全局目录 | 块存储需要 |
| `unmountdevice` | 卸载设备 | 块存储需要 |
| `mount` | 将卷挂载到 Pod 目录 | 是 |
| `unmount` | 卸载卷 | 是 |

### NFS FlexVolume 示例

**插件脚本（nfs）：**

```bash
#!/bin/bash

operation=$1

case "$operation" in
  init)
    # 初始化，返回插件能力
    echo '{"status": "Success", "capabilities": {"attach": false}}'
    ;;
  mount)
    # 参数：mount <mount-dir> <json-params>
    mount_dir=$2
    json_params=$3

    # 解析 JSON 参数
    server=$(echo "$json_params" | jq -r '.server')
    share=$(echo "$json_params" | jq -r '.share')

    mount -t nfs "${server}:${share}" "${mount_dir}"
    if [ $? -eq 0 ]; then
      echo '{"status": "Success"}'
    else
      echo '{"status": "Failure", "message": "Failed to mount NFS"}'
    fi
    ;;
  unmount)
    mount_dir=$2
    umount "${mount_dir}"
    if [ $? -eq 0 ]; then
      echo '{"status": "Success"}'
    else
      echo '{"status": "Failure", "message": "Failed to unmount"}'
    fi
    ;;
  *)
    echo '{"status": "Not supported"}'
    ;;
esac
```

**PV 定义（使用 FlexVolume）：**

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-flex-nfs
spec:
  capacity:
    storage: 10Gi
  accessModes:
    - ReadWriteMany
  flexVolume:
    driver: k8s/nfs        # 对应 vendor~driver = k8s~nfs
    options:                # 传递给 mount 操作的 JSON 参数
      server: "192.168.1.100"
      share: "/data/nfs"
```

### FlexVolume 的局限性

| 问题 | 说明 |
|---|---|
| **不支持动态供应** | FlexVolume 自身不支持 Dynamic Provisioning（除非编写额外的 External Provisioner） |
| **无状态管理** | 脚本执行是无状态的，无法在 mount 和 unmount 之间保留状态 |
| **依赖宿主机环境** | 需要在每个节点上安装依赖（如 NFS 客户端工具） |
| **需要 root 权限** | 部署插件文件需要对主节点和宿主机文件系统有 root 访问权限 |
| **操作系统耦合** | 可执行文件与操作系统绑定，跨平台兼容性差 |
| **已过时** | Kubernetes 社区已将其标记为 deprecated，推荐使用 CSI |

### 迁移建议

FlexVolume 已被 Kubernetes 社区标记为 deprecated。如果你仍在使用 FlexVolume 插件，建议尽快迁移到对应的 CSI 驱动。大多数主流存储厂商都提供了 CSI 驱动替代方案。

---

## CSI（Container Storage Interface）

### 什么是 CSI

CSI（Container Storage Interface）是 Kubernetes 存储扩展的**现代标准**，它将存储插件的开发从 Kubernetes 核心代码中完全解耦出来。CSI 通过 gRPC 协议定义了一套标准化的接口，存储厂商只需实现这些接口，就能让 Kubernetes 无缝使用其存储系统。

CSI 的设计目标是：
- **标准化**：一套接口适配所有存储系统
- **解耦**：存储插件独立于 Kubernetes 版本发布
- **容器化**：插件以容器方式部署，无需修改宿主机

### ⚠️ CSI 三层结构：哪个自带？哪个要安装？

这是最容易混淆的地方。**CSI 不是"一个东西"，而是三层不同的组件**：

```
┌─────────────────────────────────────────────────────────────────┐
│                    CSI 三层结构                                   │
│                                                                 │
│  ① CSI 规范（gRPC 接口标准）                                      │
│     ├── 定义在 Kubernetes 核心代码中（pkg/volume/csi）             │
│     ├── kubelet / Controller Manager 内置了 CSI 调用逻辑           │
│     └── 状态：✅ K8s 自带，不需要安装                              │
│                                                                 │
│  ② CSI Sidecar 容器（桥接组件）                                    │
│     ├── external-provisioner, external-attacher 等                │
│     ├── 由 Kubernetes SIG-Storage 社区维护                        │
│     ├── 镜像是现成的（registry.k8s.io/sig-storage/...）            │
│     └── 状态：⚠️ 需要部署，但镜像是官方提供的，无需自己写代码        │
│                                                                 │
│  ③ CSI Driver 驱动（存储实现）                                     │
│     ├── 由存储厂商编写（AWS、阿里云、Ceph 等）                       │
│     ├── 实现实际的后端存储操作（创建/挂载/删除磁盘）                  │
│     └── 状态：❌ 必须手动安装，否则对应的存储类型无法使用             │
└─────────────────────────────────────────────────────────────────┘
```

**打个比方**：CSI 规范相当于"USB 接口标准"（K8s 内置），Sidecar 相当于"USB 控制器芯片驱动"（官方提供），CSI Driver 相当于"U 盘 / 移动硬盘"（存储厂商提供）。没有 USB 标准就无法通信，没有芯片驱动就认不出设备，没有 U 盘就没有实际存储。

### 如果不安装 CSI 驱动，K8s 怎么实现存储？

**不是所有存储都需要 CSI**。Kubernetes 自带一套"树内（in-tree）存储插件"，无需安装任何 CSI 驱动即可使用：

#### 方式一：直接用树内卷类型（最简单，无需任何插件）

直接在 Pod 中声明，不需要创建 PV/PVC：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  containers:
    - name: nginx
      image: nginx
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      emptyDir: {}          # ← 树内插件，K8s 自带，不需要任何安装
```

常用树内卷类型（K8s 自带，零安装）：

| 卷类型 | 说明 | 持久化 |
|---|---|---|
| `emptyDir` | Pod 生命周期内的临时目录，Pod 删除即消失 | 否 |
| `hostPath` | 挂载宿主机目录到容器 | 是（绑定节点） |
| `nfs` | 挂载 NFS 共享目录 | 是（网络存储） |
| `configMap` | 注入 ConfigMap 为文件 | 否 |
| `secret` | 注入 Secret 为文件 | 否 |
| `downwardAPI` | 注入 Pod 元数据 | 否 |

#### 方式二：静态 PV + 树内存储类型

手动创建 PV，不依赖任何 StorageClass / Provisioner：

```yaml
# 1. 管理员手动创建 PV（使用树内 NFS 插件）
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-static-nfs
spec:
  capacity:
    storage: 10Gi
  accessModes:
    - ReadWriteMany
  nfs:                          # ← 树内 NFS 插件，K8s 自带
    server: 192.168.1.100
    path: /data/nfs

---
# 2. 用户创建 PVC 绑定此 PV
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 5Gi
  volumeName: pv-static-nfs     # 直接指定 PV 名称

---
# 3. Pod 使用 PVC
apiVersion: v1
kind: Pod
metadata:
  name: nginx-nfs
spec:
  containers:
    - name: nginx
      image: nginx
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: my-pvc
```

**这种方式的特点**：全程不需要任何 CSI 驱动、不需要 StorageClass、不需要 Provisioner。缺点是管理员需要手动创建每一个 PV。

### 什么场景必须安装 CSI 驱动？

| 场景 | 是否需要 CSI |
|---|---|
| 使用 `hostPath` / `emptyDir` / `nfs` 树内插件 | ❌ 不需要 |
| 手动创建静态 PV（NFS、iSCSI 等） | ❌ 不需要 |
| 使用云盘（AWS EBS、阿里云盘、华为云 EVS）动态创建 | ✅ **必须安装对应 CSI 驱动** |
| 使用分布式存储（Ceph RBD、Longhorn、Rook） | ✅ **必须安装对应 CSI 驱动** |
| PVC 自动动态创建 PV（Dynamic Provisioning） | ✅ 需要 Provisioner（通常是 CSI 驱动的一部分） |
| 在线扩容（`allowVolumeExpansion`） | ✅ 需要支持扩容的 CSI 驱动 |
| 卷快照（VolumeSnapshot） | ✅ 需要支持快照的 CSI 驱动 |

### 组件关系总结

```
                          ┌─────────────┐
                          │  用户创建    │
                          │    PVC      │
                          └──────┬──────┘
                                 │ storageClassName: csi-sc
                                 ▼
┌────────────────────────────────────────────────────────────┐
│              StorageClass (provisioner: xxx.csi.com)       │
│                     ↓ 名称匹配                              │
│                                                           │
│    ┌─────────────────────────────────────────────┐        │
│    │  CSI Controller Pod (StatefulSet)          │        │
│    │                                            │        │
│    │  ┌──────────────┐  ←gRPC→  ┌─────────────┐ │        │
│    │  │ Sidecar 容器  │         │ CSI Driver  │ │        │
│    │  │ (官方维护)    │         │ (厂商实现)   │ │        │
│    │  └──────────────┘         └─────────────┘ │        │
│    └─────────────────────────────────────────────┘        │
│                          │                                │
│                          │ 创建底层存储 + PV                │
│                          ▼                                │
│    ┌─────────────────────────────────────────────┐        │
│    │  CSI Node Pod (DaemonSet)                   │        │
│    │                                            │        │
│    │  ┌──────────────┐  ←gRPC→  ┌─────────────┐ │        │
│    │  │ Sidecar 容器  │         │ CSI Driver  │ │        │
│    │  └──────────────┘         └─────────────┘ │        │
│    └─────────────────────────────────────────────┘        │
│                          │                                │
│                          │ NodeStage + NodePublish        │
│                          ▼                                │
│                    Pod 成功挂载存储                          │
└────────────────────────────────────────────────────────────┘
```

**一句话总结**：
- **Sidecar** 是"翻译官"——监听 K8s API 事件，翻译成 gRPC 调用传给 Driver
- **CSI Driver** 是"干活的"——收到 gRPC 调用后，去实际操作后端存储系统（调用云厂商 API 创建磁盘等）
- **K8s 内置的 CSI 规范**是"通信协议"——定义了 Sidecar 和 Driver 之间怎么说话

### CSI 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Master 节点                                   │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐           │
│  │  API Server  │    │  Scheduler   │    │  Controller   │           │
│  │              │    │              │    │   Manager     │           │
│  └──────┬───────┘    └──────────────┘    └──────┬───────┘           │
│         │                                       │                    │
│         │  Watch PVC/PV/VolumeAttachment       │                    │
│         ▼                                       │                    │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │              CSI Controller 插件 (StatefulSet)              │       │
│  │                                                          │       │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐     │       │
│  │  │   External   │ │   External   │ │   External   │     │       │
│  │  │ Provisioner  │ │   Attacher   │ │   Resizer    │     │       │
│  │  │  (Sidecar)   │ │  (Sidecar)   │ │  (Sidecar)   │     │       │
│  │  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘     │       │
│  │         │                │                │               │       │
│  │         ▼                ▼                ▼               │       │
│  │  ┌──────────────────────────────────────────────────┐    │       │
│  │  │        CSI Driver (CSI Controller Service)       │    │       │
│  │  │  - CreateVolume / DeleteVolume                   │    │       │
│  │  │  - ControllerPublishVolume / UnpublishVolume     │    │       │
│  │  │  - CreateSnapshot / DeleteSnapshot               │    │       │
│  │  │  - ControllerExpandVolume                        │    │       │
│  │  └──────────────────────────────────────────────────┘    │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         Worker 节点                                  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │              CSI Node 插件 (DaemonSet)                      │       │
│  │                                                          │       │
│  │  ┌──────────────────────┐                                 │       │
│  │  │  Node Driver         │                                 │       │
│  │  │  Registrar (Sidecar) │                                 │       │
│  │  └──────────┬───────────┘                                 │       │
│  │             │                                              │       │
│  │             ▼                                              │       │
│  │  ┌──────────────────────────────────────────────────┐    │       │
│  │  │        CSI Driver (CSI Node Service)             │    │       │
│  │  │  - NodeStageVolume / NodeUnstageVolume           │    │       │
│  │  │  - NodePublishVolume / NodeUnpublishVolume       │    │       │
│  │  │  - NodeGetVolumeStats                            │    │       │
│  │  │  - NodeExpandVolume                              │    │       │
│  │  └──────────────────────────────────────────────────┘    │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌──────────┐                                                      │
│  │  kubelet  │ ←── 通过 UNIX Socket 调用 CSI Node Service            │
│  └──────────┘                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### CSI 三大 gRPC 服务

CSI 插件通过 gRPC 对外提供三个服务，每个服务定义了不同的接口：

#### 1. CSI Identity Service（身份服务）

提供插件的基本信息和能力声明：

```protobuf
service Identity {
  rpc GetPluginInfo(GetPluginInfoRequest) returns (GetPluginInfoResponse) {}      // 返回插件名称、版本
  rpc GetPluginCapabilities(GetPluginCapabilitiesRequest) returns (GetPluginCapabilitiesResponse) {}  // 声明插件能力
  rpc Probe(ProbeRequest) returns (ProbeResponse) {}                               // 健康检查
}
```

#### 2. CSI Controller Service（控制器服务）

运行在 Master 节点（StatefulSet），处理**集群级别**的卷管理操作：

| 接口 | 调用者 | 说明 |
|---|---|---|
| `CreateVolume` | External Provisioner | 创建存储卷（对应 Provision 阶段） |
| `DeleteVolume` | External Provisioner | 删除存储卷 |
| `ControllerPublishVolume` | External Attacher | 将卷附加到节点（对应 Attach 阶段） |
| `ControllerUnpublishVolume` | External Attacher | 从节点分离卷 |
| `CreateSnapshot` | External Snapshotter | 创建卷快照 |
| `DeleteSnapshot` | External Snapshotter | 删除卷快照 |
| `ControllerExpandVolume` | External Resizer | 扩容卷 |

#### 3. CSI Node Service（节点服务）

运行在每个 Worker 节点（DaemonSet），处理**节点级别**的卷操作：

| 接口 | 调用者 | 说明 |
|---|---|---|
| `NodeStageVolume` | kubelet | 将块设备格式化并挂载到临时目录（Staging 路径） |
| `NodeUnstageVolume` | kubelet | 卸载临时目录 |
| `NodePublishVolume` | kubelet | 将 Staging 路径 bind-mount 到 Pod 目录（对应 Mount 阶段） |
| `NodeUnpublishVolume` | kubelet | 卸载 Pod 目录 |
| `NodeGetVolumeStats` | kubelet | 获取卷使用统计 |
| `NodeExpandVolume` | kubelet | 节点级卷扩容（文件系统扩容） |

### Sidecar 容器

CSI 驱动的部署依赖 Kubernetes 社区维护的 Sidecar 容器，它们负责监听 Kubernetes API 并触发 CSI 接口调用：

| Sidecar | 功能 | 监听对象 |
|---|---|---|
| **external-provisioner** | 动态创建 PV | PVC（PersistentVolumeClaim） |
| **external-attacher** | 卷的附加/分离 | VolumeAttachment |
| **external-resizer** | 在线扩容 | PVC 大小变更 |
| **external-snapshotter** | 卷快照 | VolumeSnapshot |
| **node-driver-registrar** | 将 CSI 驱动注册到 kubelet | - |
| **livenessprobe** | 健康检查 | - |

### CSI 卷的完整生命周期

```
用户创建 PVC（指定 storageClassName: csi-sc）
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. Provision 阶段（创建存储卷）                               │
│                                                             │
│    External Provisioner 监听到 PVC 创建事件                   │
│        │                                                    │
│        ▼                                                    │
│    调用 CSI Controller.CreateVolume()                        │
│        │                                                    │
│        ▼                                                    │
│    创建底层存储卷 + 自动创建 PV 对象 + 绑定 PVC               │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
用户创建 Pod（引用该 PVC），Pod 被调度到节点 A
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Attach 阶段（将卷附加到节点）                              │
│                                                             │
│    AttachDetachController 检测到卷需要附加到节点 A             │
│        │                                                    │
│        ▼                                                    │
│    创建 VolumeAttachment 对象                                │
│        │                                                    │
│        ▼                                                    │
│    External Attacher 监听到 VolumeAttachment 事件             │
│        │                                                    │
│        ▼                                                    │
│    调用 CSI Controller.ControllerPublishVolume()             │
│        │                                                    │
│        ▼                                                    │
│    卷被附加到节点 A（如云盘挂载到虚拟机）                       │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Mount 阶段（挂载卷到 Pod 目录）                            │
│                                                             │
│    kubelet VolumeManagerReconciler 检测到需要执行 Mount 操作   │
│        │                                                    │
│        ▼                                                    │
│    NodeStageVolume：格式化设备 + 挂载到 Staging 路径           │
│        │         /var/lib/kubelet/plugins/kubernetes.io/csi/ │
│        │         pv/<pv-name>/globalmount                    │
│        ▼                                                    │
│    NodePublishVolume：将 Staging 路径 bind-mount 到 Pod 目录  │
│        │         /var/lib/kubelet/pods/<pod-uid>/volumes/    │
│        │         kubernetes.io~csi/<pv-name>/mount           │
│        ▼                                                    │
│    Pod 容器可以访问卷中的数据                                  │
└─────────────────────────────────────────────────────────────┘
```

### 为什么 Mount 阶段分为 NodeStageVolume 和 NodePublishVolume？

这是 CSI 设计中的一个重要细节：

- **NodeStageVolume**：将块设备格式化（如果需要）并挂载到**全局 Staging 路径**。这个路径是节点级别的，所有使用该卷的 Pod 共享。
- **NodePublishVolume**：将 Staging 路径 **bind-mount** 到 Pod 特定的目录。每个 Pod 有独立的挂载点。

这种设计的好处是：如果多个 Pod 使用同一个卷，格式化操作只执行一次，后续 Pod 只需要做 bind-mount，性能更好。

### 部署 CSI 驱动

CSI 驱动部署通常包含两个部分：

**1. Controller 插件（StatefulSet）：**

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: csi-controller
  namespace: kube-system
spec:
  serviceName: csi-controller
  replicas: 1
  selector:
    matchLabels:
      app: csi-controller
  template:
    spec:
      serviceAccountName: csi-controller-sa
      containers:
        # Sidecar 容器
        - name: external-provisioner
          image: registry.k8s.io/sig-storage/csi-provisioner:v3.6.0
          args:
            - "--csi-address=/csi/csi.sock"
          volumeMounts:
            - name: socket-dir
              mountPath: /csi
        - name: external-attacher
          image: registry.k8s.io/sig-storage/csi-attacher:v4.4.0
          args:
            - "--csi-address=/csi/csi.sock"
          volumeMounts:
            - name: socket-dir
              mountPath: /csi
        # CSI 驱动容器
        - name: my-csi-driver
          image: my-registry/csi-driver:v1.0.0
          args:
            - "--endpoint=unix:///csi/csi.sock"
          volumeMounts:
            - name: socket-dir
              mountPath: /csi
      volumes:
        - name: socket-dir
          emptyDir: {}
```

**2. Node 插件（DaemonSet）：**

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: csi-node
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: csi-node
  template:
    spec:
      containers:
        - name: node-driver-registrar
          image: registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.9.0
          args:
            - "--csi-address=/csi/csi.sock"
            - "--kubelet-registration-path=/var/lib/kubelet/plugins/csi.example.com/csi.sock"
          volumeMounts:
            - name: plugin-dir
              mountPath: /csi
            - name: registration-dir
              mountPath: /registration
        - name: my-csi-driver
          image: my-registry/csi-driver:v1.0.0
          args:
            - "--endpoint=unix:///csi/csi.sock"
          securityContext:
            privileged: true
          volumeMounts:
            - name: plugin-dir
              mountPath: /csi
            - name: pods-mount-dir
              mountPath: /var/lib/kubelet/pods
              mountPropagation: Bidirectional
      volumes:
        - name: plugin-dir
          hostPath:
            path: /var/lib/kubelet/plugins/csi.example.com
            type: DirectoryOrCreate
        - name: registration-dir
          hostPath:
            path: /var/lib/kubelet/plugins_registry
            type: Directory
        - name: pods-mount-dir
          hostPath:
            path: /var/lib/kubelet/pods
            type: Directory
```

### 创建 CSIDriver 对象

部署 CSI 驱动后，需要创建 CSIDriver 对象向 Kubernetes 注册：

```yaml
apiVersion: storage.k8s.io/v1
kind: CSIDriver
metadata:
  name: csi.example.com
spec:
  attachRequired: true          # 是否需要 Attach 操作（块存储需要，NFS 通常不需要）
  podInfoOnMount: true          # 挂载时是否传递 Pod 信息
  volumeLifecycleModes:
    - Persistent                # 支持持久卷
    - Ephemeral                 # 支持临时卷
  fsGroupPolicy: File           # 文件系统组策略
  requiresRepublish: false      # 是否需要在 Pod 重启时重新发布卷
  storageCapacity: true         # 是否支持存储容量感知调度
```

### 创建 StorageClass 使用 CSI 驱动

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: csi-fast-ssd
provisioner: csi.example.com             # 对应 CSIDriver 的 name
parameters:
  type: ssd
  fsType: ext4
  iops: "5000"
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

### 常用 CSI 驱动列表

| 存储系统 | CSI 驱动名称 | Provisioner 名称 |
|---|---|---|
| AWS EBS | aws-ebs-csi-driver | `ebs.csi.aws.com` |
| AWS EFS | aws-efs-csi-driver | `efs.csi.aws.com` |
| 阿里云云盘 | alibaba-cloud-csi-driver | `diskplugin.csi.alibabacloud.com` |
| 阿里云 NAS | alibaba-cloud-csi-driver | `nasplugin.csi.alibabacloud.com` |
| 华为云 | everest-csi-driver | `everest-csi-provisioner` |
| Ceph RBD | ceph-csi | `rbd.csi.ceph.com` |
| CephFS | ceph-csi | `cephfs.csi.ceph.com` |
| NFS | csi-driver-nfs | `nfs.csi.k8s.io` |
| Longhorn | longhorn | `driver.longhorn.io` |
| Rook-Ceph | rook-ceph | `rook-ceph.rbd.csi.ceph.com` |
| Local Path | local-path-provisioner | `rancher.io/local-path` |
| hostPath | csi-driver-host-path | `hostpath.csi.k8s.io` |

### FlexVolume vs CSI 对比

| 维度 | FlexVolume | CSI |
|---|---|---|
| **接口方式** | 可执行文件（shell/二进制） | gRPC 标准接口 |
| **部署方式** | 宿主机文件系统中的脚本 | 容器化部署（DaemonSet + StatefulSet） |
| **动态供应** | 不支持（需额外 External Provisioner） | 原生支持 |
| **快照/扩容** | 不支持 | 原生支持 |
| **状态管理** | 无状态（每次执行独立） | 有状态（gRPC 服务持续运行） |
| **依赖管理** | 需要宿主机预装依赖 | 容器内自带依赖 |
| **跨平台** | 与操作系统耦合 | 独立于操作系统 |
| **社区支持** | 已废弃 | 活跃开发，标准方案 |
| **Kubernetes 版本** | v1.8+ 支持，v1.23+ 废弃 | v1.13+ GA，推荐方案 |

### 树内插件迁移到 CSI

Kubernetes 社区正在将树内（in-tree）存储插件逐步迁移到 CSI 驱动。迁移时间线：

| 树内插件 | 状态 | CSI 替代 |
|---|---|---|
| `kubernetes.io/aws-ebs` | 已废弃 | `ebs.csi.aws.com` |
| `kubernetes.io/gce-pd` | 已废弃 | `pd.csi.storage.gke.io` |
| `kubernetes.io/cinder` | 已废弃 | `cinder.csi.openstack.org` |
| `kubernetes.io/azure-disk` | 已废弃 | `disk.csi.azure.com` |
| `kubernetes.io/azure-file` | 已废弃 | `file.csi.azure.com` |
| `kubernetes.io/vsphere-volume` | 已废弃 | `csi.vsphere.vmware.com` |

迁移步骤：
1. 安装对应的 CSI 驱动
2. 创建使用 CSI Provisioner 的新 StorageClass
3. 将 PVC 的 `storageClassName` 切换到新 StorageClass
4. 验证应用正常运行
5. 删除旧的树内 StorageClass 和 PV

---

## 总结

Kubernetes 存储体系的核心设计思想是**接口与实现的分离**：

- **PV** 代表存储的"实现"（具体的存储资源）
- **PVC** 代表存储的"接口"（用户的需求声明）
- **StorageClass** 是动态创建的"模板"（自动化 PV 创建）
- **Provisioner** 是具体的"执行者"（实际创建存储卷的组件）

在存储插件选择上：
- **开发/测试环境**：local-path-provisioner 是最简单实用的选择
- **生产环境**：使用 CSI 驱动，根据存储类型选择（云盘、NFS、Ceph 等）
- **高性能场景**：Local PV 提供最低延迟，但需应用层保证数据副本
- **FlexVolume**：已过时，不建议新项目使用，应迁移到 CSI

---

> **参考来源：**
> - [Kubernetes 官方文档 - StorageClass](https://kubernetes.io/zh-cn/docs/concepts/storage/storage-classes/)
> - [Kubernetes 官方文档 - 动态卷制备](https://kubernetes.io/zh-cn/docs/concepts/storage/dynamic-provisioning/)
> - [Kubernetes 官方文档 - 持久卷](https://kubernetes.io/zh-cn/docs/concepts/storage/persistent-volumes/)
> - [Kubernetes CSI 开发文档](https://kubernetes-csi.github.io/docs/)
> - [Rancher Local Path Provisioner](https://github.com/rancher/local-path-provisioner)
> - [深入剖析 Kubernetes - 张磊](https://learn.lianglianglee.com/专栏/深入剖析Kubernetes)
> - [Jimmy Song - Kubernetes 存储系统概览](https://jimmysong.io/zh/book/kubernetes-handbook/storage/overview/)
> - [华为云 CCE - PV、PVC 和 StorageClass](https://support.huaweicloud.com/basics-cce/kubernetes_0030.html)
> - [阿里云 ACK - 存储系统核心概念](https://help.aliyun.com/zh/ack/ack-managed-and-ack-dedicated/user-guide/storage-basics)