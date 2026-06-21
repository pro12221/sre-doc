# Prometheus vs VictoriaMetrics 单机版 全方位压测实验设计

> 目标：在 K8s 集群中，于两个相同规格 Node 上分别部署 Prometheus 和 VictoriaMetrics 单机版，相同工作负载下系统性压测，量化两者在**写入、查询、资源占用、压缩效率**等维度的差异，为生产选型提供数据支撑。
>
> 本文档所有 YAML 均为**实际部署并跑通**的配置（UCloud UK8s 集群），结果章节留空，待测试完成后回填。

---

## 零、SRE 性能指标科普

做压测、看监控、定 SLO 之前，先把这套术语体系理清。这些指标分四类：**流量/吞吐、延迟、可靠性、资源**，再加 TSDB 专属指标。

### 0.1 流量与吞吐类

| 指标 | 全称 | 含义 | 典型场景 |
|---|---|---|---|
| **PV** | Page View | 页面浏览量，用户每打开/刷新一个页面记一次，不去重 | 网站流量统计 |
| **UV** | Unique Visitor | 独立访客数，按用户标识（cookie/账号/IP）去重 | 网站活跃用户评估 |
| **QPS** | Queries Per Second | 每秒查询数，衡量"读"频率 | API 网关、数据库查询、Prometheus 查询 |
| **RPS** | Requests Per Second | 每秒请求数，比 QPS 更通用（一个请求未必是一次查询） | HTTP 服务通用指标 |
| **TPS** | Transactions Per Second | 每秒事务数，一次事务通常含多步操作（读+写+提交），比 QPS 重 | 数据库事务、支付下单 |
| **Throughput** | 吞吐量 | 单位时间处理量，可以是 req/s、MB/s、samples/s，取决于语境 | 通用 |
| **Concurrency** | 并发数 | 同一时刻在处理中的请求/任务数 | 压测核心参数 |

> **QPS vs TPS 的区别**：QPS 侧重"查询"（读为主），TPS 侧重"事务"（含写与一致性保证）。一次下单事务 = 查库存 + 扣库存 + 生成订单，算 1 TPS 但可能算多次查询。本压测中数据写入类似 TPS（落盘 + WAL），查询类似 QPS。

### 0.2 延迟类

| 指标 | 含义 |
|---|---|
| **RT (Response Time)** | 响应时间，从客户端发出请求到收到完整响应的端到端时间（含网络 + 排队 + 处理） |
| **Latency** | 延迟，通常指服务端处理耗时，比 RT 小（不含客户端网络） |
| **TTFB** | Time To First Byte，首字节时间，衡量首包快慢 |
| **P50 / 中位数** | 50% 的请求快于该值，反映"典型体验" |
| **P95** | 95% 的请求快于该值，反映"大多数用户的下限" |
| **P99** | 99% 的请求快于该值，反映"长尾用户体验" |
| **P999** | 99.9 分位，反映"极端长尾" |
| **Tail Latency** | 尾延迟，高分位延迟，往往是性能瓶颈最先暴露处 |

> ⚠️ **永远不要只看平均值**：平均延迟会掩盖长尾。1000 个请求里 999 个 10ms、1 个 10s，平均 ~20ms 看着挺好，但那个 10s 的用户体验已经崩了。所以监控必须看 P95/P99。

### 0.3 可靠性类

| 指标 | 含义 |
|---|---|
| **SLI** | Service Level Indicator，服务水平指标——你测量的具体数值（如 P99 延迟、可用率、错误率） |
| **SLO** | Service Level Objective，服务水平目标——你对 SLI 设的内部目标（如 P99 < 500ms，可用率 99.9%） |
| **SLA** | Service Level Agreement，服务水平协议——跟客户签的合同条款，违反要赔偿，通常比 SLO 宽松 |
| **Availability（可用性）** | 服务可用时间占比，用"几个 9"衡量 |
| **Error Rate** | 错误率，错误请求 / 总请求 |
| **MTBF** | Mean Time Between Failures，平均故障间隔时间（两次故障之间）——越大越稳定 |
| **MTTF** | Mean Time To Failure，平均无故障时间（不可修复系统到首次故障） |
| **MTTR** | Mean Time To Repair/Recover，平均恢复时间——故障发生到服务恢复，越小越好 |
| **MTTD** | Mean Time To Detect，平均检测时间——故障发生到被告警发现 |

**可用性的"几个 9"对照表**（一年为周期）：

| 可用率 | 年停机预算 | 典型定位 |
|---|---|---|
| 99%（2 个 9） | 3.65 天 | 准生产 |
| 99.9%（3 个 9） | 8.76 小时 | 一般生产 |
| 99.99%（4 个 9） | 52.6 分钟 | 核心生产 |
| 99.999%（5 个 9） | 5.26 分钟 | 电信/金融核心 |

> 核心公式：**可用性 = MTBF / (MTBF + MTTR)**。要提升可用性，要么让故障更少（↑MTBF），要么让恢复更快（↓MTTR）。本压测的"重启恢复时间"场景（T8）测的就是 MTTR。

### 0.4 资源类（USE 方法）

USE = **Utilization（利用率）/ Saturation（饱和度）/ Errors（错误）**，对每种资源都看这三件事：

| 资源 | Utilization 利用率 | Saturation 饱和度 | Errors |
|---|---|---|---|
| CPU | CPU% | 运行队列长度、负载 | - |
| 内存 | 已用/总量 | OOM、swap、换页 | OOM kill 次数 |
| 磁盘 | 已用/总量 | IOPS、队列深度 | 读写错误 |
| 网络 | 带宽% | 丢包、重传 | 错误包 |

### 0.5 TSDB（时序数据库）专属指标

本压测最关心的就是这些——它们决定一个监控后端能不能扛住生产规模：

| 指标 | 含义 | 为什么重要 |
|---|---|---|
| **Ingestion rate (samples/s)** | 每秒写入样本数 | 写入跟不上采集 = 数据丢失/堆积 |
| **Active series** | 当前活跃时间序列数 | 直接决定内存占用，是 OOM 主因 |
| **Cardinality（基数）** | 不同 label 组合数 | 高基数 = 内存爆炸 + 查询变慢，TSDB 头号杀手 |
| **Churn rate** | 序列流失率，旧 series 消失、新 series 产生的速率 | 高 churn 导致索引膨胀、压缩失效 |
| **bytes/sample** | 每个样本平均占用字节数 | 衡量压缩效率，决定存储成本 |
| **WAL** | Write-Ahead Log，预写日志 | 写入持久化保障，影响崩溃恢复 |
| **Query latency** | 查询延迟（P50/P99） | Dashboard 响应、告警时效 |
| **IOPS** | 每秒 I/O 操作数 | 磁盘性能瓶颈，判断是否要 NVMe |

---

## 一、压测维度总览

| 维度 | 关键指标 | 意义 |
|---|---|---|
| **写入性能** | samples/s 写入速率、写入延迟、写入丢弃率 | 能否跟上采集量 |
| **查询性能** | p50/p95/p99 延迟、QPS | Dashboard 响应速度与告警时效 |
| **内存** | RSS 峰值/均值、OOM 风险 | 决定机器规格与成本 |
| **CPU** | 平均/峰值利用率 | 决定核心数与成本 |
| **磁盘空间** | 总占用、bytes/sample 压缩比 | 决定存储成本与保留周期 |
| **磁盘 I/O** | 读写带宽峰值、IOPS | 判断是否需要 NVMe |
| **高基数/churn** | 高 churn 下的内存膨胀与查询退化 | 生产中最常见的故障模式 |
| **长周期查询** | 大时间范围查询的延迟与资源消耗 | 影响排查体验 |
| **恢复速度** | 重启后数据加载时间、查询可用时间 | 影响故障恢复 MTTR |

---

## 二、实验环境

### 2.1 K8s 集群拓扑

> UCloud UK8s 集群。通过 `nodeSelector` 将 Prometheus 和 VictoriaMetrics 分别固定到不同 Node，消除资源竞争；监控栈与负载生成器调度到第三个工作节点，不抢被测实例资源。

```
┌──────────────────────────────────────────────────────────────────┐
│                        UK8s Cluster                              │
│                                                                  │
│  ┌─────────────────────────┐  ┌─────────────────────────────┐   │
│  │   Node: bench-node-1    │  │   Node: bench-node-2        │   │
│  │   (label: role=prom)    │  │   (label: role=vm)          │   │
│  │                         │  │                             │   │
│  │  ┌───────────────────┐  │  │  ┌───────────────────────┐  │   │
│  │  │  Prometheus v3.12 │  │  │  │  VictoriaMetrics      │  │   │
│  │  │  (被测实例 A)      │  │  │  │  单机版 (被测实例 B)   │  │   │
│  │  │  PVC: 40Gi SSD    │  │  │  │  PVC: 40Gi SSD        │  │   │
│  │  └───────────────────┘  │  │  └───────────────────────┘  │   │
│  └─────────────────────────┘  └─────────────────────────────┘   │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │   Node: bench-node-3 (无 role 标签) + 其他工作节点          │ │
│  │  ┌─────────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │ │
│  │  │ vmagent     │ │ vmalert  │ │ Monitor  │ │ Grafana   │  │ │
│  │  │ (写入负载)   │ │(查询负载)│ │Prometheus│ │ Dashboard │  │ │
│  │  └─────────────┘ └──────────┘ └──────────┘ └───────────┘  │ │
│  │  + 50 个 benchmark-node-exporter (指标生成)                 │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 节点规格与资源约束

> 用 Pod 的 `resources.limits` 把被测实例锁死在 **2 vCPU / 3500Mi**，模拟 2C4G 节点（留 ~500MB 给系统/kubelet）。即使宿主机规格更大，压测也只看 limit 内的 2C4G 表现，保证公平。

| 项目 | 规格 | 说明 |
|---|---|---|
| 被测实例 CPU | 2 vCPU（limit） | `resources.limits.cpu=2` |
| 被测实例内存 | 3500Mi（limit） | 留 ~500Mi 给系统，4G 下 Prometheus 更易 OOM |
| 磁盘 | 40 Gi SSD | `storageClassName: ssd-csi-udisk` |
| K8s | v1.30.14 | UK8s |
| 容器运行时 | containerd 1.6+ | |

> ⚠️ **踩过的坑**：原计划用 RSSD 盘（`csi-udisk-rssd`），但 VM 节点所在可用区 RSSD 云盘缺货（`no available set exist`）。最终两边统一改用 `ssd-csi-udisk`，保证磁盘维度公平可比。

### 2.3 Node 标签与隔离

```bash
# 给两个 Node 打标签，用于 nodeSelector 调度
kubectl label node <bench-node-1> role=prom
kubectl label node <bench-node-2> role=vm

# benchmark namespace 放开 Pod Security Admission，允许 Prometheus v3 以 root 写 PVC
kubectl label namespace benchmark pod-security.kubernetes.io/enforce=privileged --overwrite
```

> **为什么 namespace 要 privileged**：Prometheus v3 镜像默认以 `nobody`(UID 65534) 运行，写 PVC 时报 `permission denied`。需要 `securityContext.runAsUser=0`，而默认的 `restricted` PSA 会剥离该字段，必须显式放开。

### 2.4 软件版本与镜像

> 全部使用 UCloud 内网镜像仓库 `uhub.service.ucloud.cn/prometheusv3/`，拉取快、免外网。

| 组件 | 镜像 | 部署方式 |
|---|---|---|
| Prometheus（被测） | `uhub.service.ucloud.cn/prometheusv3/prometheus:v3.12.0` | StatefulSet + PVC |
| VictoriaMetrics 单机版（被测） | `uhub.service.ucloud.cn/prometheusv3/victoria-metrics:latest` | StatefulSet + PVC |
| vmagent（写入负载） | `uhub.service.ucloud.cn/prometheusv3/vmagent:latest` | Deployment |
| vmalert（查询负载） | `uhub.service.ucloud.cn/prometheusv3/vmalert:latest` | Deployment |
| node-exporter（指标源） | `uhub.service.ucloud.cn/prometheusv3/node-exporter:latest` | Deployment × 50 |
| Monitoring Prometheus | `uhub.service.ucloud.cn/prometheusv3/prometheus:v3.12.0` | Deployment + emptyDir |
| Grafana | `uhub.service.ucloud.cn/prometheusv3/grafana:11.3.0` | Deployment |

### 2.5 监控方案

**用一套独立的轻量 Prometheus 采集两个被测实例 + kubelet/cAdvisor**，Grafana 连这个监控 Prometheus 做可视化。监控栈调度到非测试 Node，不抢被测实例资源。监控 Prometheus 同时采集 5 类目标：

| scrape job | 目的 |
|---|---|
| `prometheus-under-test` | 采集 Prometheus 被测实例的自监控指标（`prometheus_tsdb_*` 等） |
| `victoriametrics-under-test` | 采集 VM 被测实例的自监控指标（`vm_*` 等） |
| `vmagent` | 采集 vmagent 的采集/发送指标 |
| `kubernetes-cadvisor` | 容器级 CPU/内存（`container_*`） |
| `kubernetes-nodes` | 节点级 kubelet 指标 |

---

## 三、工作负载设计

### 3.1 数据源：真实 node_exporter 指标

部署 50 个 `node-exporter` Pod 作为采集目标，用 vmagent 通过 `remote_write` 同时把数据写进 Prometheus 和 VM——**两边接收完全相同的写入流，这是公平性的基石**。

### 3.2 压力档位

> ⚠️ 资源有限，默认 50 目标起步。Prometheus 在 3500Mi 内存下，目标数上去后更易 OOM。

| 场景 | 目标数 | scrape_interval | 预估 samples/s | 预估 active series | 说明 |
|---|---|---|---|---|---|
| **轻量** | 50 | 15s | ~4K | ~60K | 小集群，两者均无压力 |
| **中等** | 100 | 15s | ~8K | ~120K | 中型集群，Prometheus 开始承压 |
| **重度** | 200 | 15s | ~16K | ~240K | 4G 下 Prometheus 可能 OOM |

> 每个 node_exporter 约产生 ~1200 个时间序列。调整目标数用 `kubectl scale deployment benchmark-node-exporter --replicas=N`。

### 3.3 Churn 模拟

生产中 Label 变化（Pod 重建、CI/CD）导致 series churn，需单独测试：

| Churn 场景 | 配置 | 说明 |
|---|---|---|
| **低 churn** | 0%（baseline） | 稳定环境 |
| **中 churn** | 5%/10min | 正常 K8s 集群 |
| **高 churn** | 20%/5min | 频繁滚动更新 |

### 3.4 查询负载

用 `vmalert` 跑告警规则生成查询负载，同时对 Prometheus 和 VM 两个数据源发查询，模拟真实读操作（range query + instant query）。

---

## 四、测试场景矩阵

### 4.1 核心对比场景

| 编号 | 场景 | 目标数 | Churn | 查询负载 | 运行时长 | 核心观测 |
|---|---|---|---|---|---|---|
| T1 | 基线对比 | 100 | 5%/10min | alerting rules | 7d | 全量指标基线 |
| T2 | 高写入压力 | 200 | 5%/10min | alerting rules | 7d | 写入吞吐 & 内存 |
| T3 | 高 Churn | 100 | 20%/5min | alerting rules | 7d | 内存膨胀 & 压缩比 |
| T4 | 查询压力 | 100 | 5%/10min | alerting + 20 QPS range | 7d | 查询延迟 & CPU |

### 4.2 极限/边界场景

| 编号 | 场景 | 方法 | 运行时长 | 核心观测 |
|---|---|---|---|---|
| T5 | 写入极限 | 逐步增加目标至写入失败 | ~3h | 2C4G 下最大 samples/s |
| T6 | OOM 边界 | 固定 3500Mi，增加目标数 | ~4h | OOM 时的 series 数 |
| T7 | 磁盘瓶颈 | SSD → HDD PVC 对比 | 24h | I/O 对查询的影响 |
| T8 | 重启恢复 | delete pod → 重建，记录恢复时间 | 每次 ~30min | 数据加载 & 可用时间（MTTR） |
| T9 | 长周期查询 | 1d/7d range query | 单次 | 查询延迟 & 内存峰值 |

---

## 五、关键指标采集方法

> 以下 PromQL 均在**监控 Prometheus**上执行（它带 `job` 标签区分两边）。已按实际暴露的指标名校对。

### 5.1 Prometheus 侧指标

```promql
# 写入速率 (samples/s)
sum(rate(prometheus_tsdb_head_samples_appended_total{job="prometheus-under-test"}[5m]))

# Active series
max(prometheus_tsdb_head_series{job="prometheus-under-test"})

# 写入丢弃 (out-of-order / out-of-bounds)
sum(rate(prometheus_target_scrapes_sample_out_of_order_total{job="prometheus-under-test"}[5m]))
  + sum(rate(prometheus_target_scrapes_sample_out_of_bounds_total{job="prometheus-under-test"}[5m]))

# 查询延迟 p99
histogram_quantile(0.99,
  sum by (le) (rate(prometheus_http_request_duration_seconds_bucket{job="prometheus-under-test",handler=~"/api/v1/query.*"}[5m])))

# 查询 QPS
sum(rate(prometheus_http_requests_total{job="prometheus-under-test",handler=~"/api/v1/query.*"}[5m]))

# 内存 / CPU
process_resident_memory_bytes{job="prometheus-under-test"}
rate(process_cpu_seconds_total{job="prometheus-under-test"}[5m])

# 磁盘占用
sum(prometheus_tsdb_storage_blocks_bytes{job="prometheus-under-test"})

# 压缩比 (bytes/sample)
sum(prometheus_tsdb_storage_blocks_bytes{job="prometheus-under-test"})
  / clamp_min(sum(prometheus_tsdb_head_samples_appended_total{job="prometheus-under-test"}), 1)
```

### 5.2 VictoriaMetrics 侧指标

```promql
# 写入速率 (rows/s ≈ samples/s)
sum(rate(vm_rows_inserted_total{job="victoriametrics-under-test"}[5m]))

# Active series（缓存条目近似）
max(vm_cache_entries{job="victoriametrics-under-test",type=~"storage/.*"})

# 写入丢弃 (ignored + invalid)
sum(rate(vm_rows_ignored_total{job="victoriametrics-under-test"}[5m]))
  + sum(rate(vm_rows_invalid_total{job="victoriametrics-under-test"}[5m]))

# 查询延迟 p99
histogram_quantile(0.99,
  sum by (le) (rate(vm_http_request_duration_seconds_bucket{job="victoriametrics-under-test",path=~"/api/v1/query.*"}[5m])))

# 查询 QPS
sum(rate(vm_http_requests_total{job="victoriametrics-under-test",path=~"/api/v1/query.*"}[5m]))

# 内存 / CPU
process_resident_memory_bytes{job="victoriametrics-under-test"}
rate(process_cpu_seconds_total{job="victoriametrics-under-test"}[5m])

# 磁盘占用
vm_data_size_bytes{job="victoriametrics-under-test"}

# 压缩比 (bytes/sample)
vm_data_size_bytes{job="victoriametrics-under-test"}
  / clamp_max(vm_rows{job="victoriametrics-under-test",type="metric"}, 1)
```

> ⚠️ VM 的查询延迟指标是 `vm_http_request_duration_seconds_bucket`（带 `path` 标签），不是 `vm_request_duration_seconds_bucket`（后者只有 count/sum 没有 bucket，无法算分位）。这是实测踩坑点。

### 5.3 容器级指标（cAdvisor）

```promql
# 容器内存 working set（K8s 实际统计、OOM 判定依据）
container_memory_working_set_bytes{namespace="benchmark",pod="prometheus-under-test-0",container="prometheus"}
container_memory_working_set_bytes{namespace="benchmark",pod="victoriametrics-under-test-0",container="victoria-metrics"}

# 容器 CPU (cores)
rate(container_cpu_usage_seconds_total{namespace="benchmark",pod="prometheus-under-test-0",container="prometheus"}[5m])
rate(container_cpu_usage_seconds_total{namespace="benchmark",pod="victoriametrics-under-test-0",container="victoria-metrics"}[5m])
```

### 5.4 vmagent 采集状态

```promql
# 采集目标 up/down 数
vm_promscrape_targets{job="vmagent",status="up"}
vm_promscrape_targets{job="vmagent",status="down"}

# 抓取 samples/s
sum(rate(vm_promscrape_scraped_samples_sum{job="vmagent"}[5m]))

# remote_write 队列堆积（按 url）
vmagent_remotewrite_pending_data_bytes{job="vmagent"}

# remote_write 错误
vmagent_remotewrite_errors_total{job="vmagent"}
```

### 5.5 K8s 运维命令

```bash
kubectl top pods -n benchmark              # Pod 实时资源
kubectl top nodes                          # Node 实时资源
kubectl get pvc -n benchmark               # PVC 磁盘使用
```

---

## 六、K8s 部署方案

> 全部部署在 `benchmark` namespace。以下 YAML 均为实际跑通的配置。

### 6.1 Namespace 与 PSA

```bash
kubectl create namespace benchmark
kubectl label namespace benchmark pod-security.kubernetes.io/enforce=privileged --overwrite
```

### 6.2 Prometheus 被测实例（固定到 role=prom）

```yaml
# prometheus-under-test.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus
  namespace: benchmark

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: benchmark
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s
    # 仅接收 remote_write，不做本地采集
    # 启动参数已开启 --web.enable-remote-write-receiver

---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: prometheus-under-test
  namespace: benchmark
spec:
  serviceName: prometheus-under-test
  replicas: 1
  selector:
    matchLabels:
      app: prometheus-under-test
  template:
    metadata:
      labels:
        app: prometheus-under-test
    spec:
      serviceAccountName: prometheus
      securityContext:
        runAsUser: 0                    # v3 默认 nobody，写 PVC 会 permission denied
        fsGroup: 0
      nodeSelector:
        role: prom
      containers:
        - name: prometheus
          image: uhub.service.ucloud.cn/prometheusv3/prometheus:v3.12.0
          args:
            - --config.file=/etc/prometheus/prometheus.yml
            - --storage.tsdb.path=/var/lib/prometheus
            - --storage.tsdb.retention.time=7d
            - --web.enable-remote-write-receiver
            - --web.enable-lifecycle
          ports:
            - containerPort: 9090
              name: http
          resources:
            limits:
              cpu: "2"
              memory: 3500Mi
            requests:
              cpu: "2"
              memory: 3500Mi
          volumeMounts:
            - name: config
              mountPath: /etc/prometheus
            - name: data
              mountPath: /var/lib/prometheus
      volumes:
        - name: config
          configMap:
            name: prometheus-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: ssd-csi-udisk
        resources:
          requests:
            storage: 40Gi

---
apiVersion: v1
kind: Service
metadata:
  name: prometheus-under-test
  namespace: benchmark
spec:
  type: ClusterIP
  ports:
    - name: http
      port: 9090
      targetPort: 9090
  selector:
    app: prometheus-under-test
```

> **v3 启动参数注意**：v3 中 `--storage.tsdb.path` 和 `--storage.tsdb.retention.time` 仍可用（`retention.time` 标记 deprecated 但仍生效）。不要写成 `--storage.path`（不存在）或 `--storage.tsdb.retention`（缺 `.time`）。

### 6.3 VictoriaMetrics 被测实例（固定到 role=vm）

```yaml
# victoriametrics-under-test.yaml
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: victoriametrics-under-test
  namespace: benchmark
spec:
  serviceName: victoriametrics-under-test
  replicas: 1
  selector:
    matchLabels:
      app: victoriametrics-under-test
  template:
    metadata:
      labels:
        app: victoriametrics-under-test
    spec:
      nodeSelector:
        role: vm
      containers:
        - name: victoria-metrics
          image: uhub.service.ucloud.cn/prometheusv3/victoria-metrics:latest
          args:
            - -storageDataPath=/var/lib/victoria-metrics-data
            - -retentionPeriod=7d
          ports:
            - containerPort: 8428
              name: http
          resources:
            limits:
              cpu: "2"
              memory: 3500Mi
            requests:
              cpu: "2"
              memory: 3500Mi
          volumeMounts:
            - name: data
              mountPath: /var/lib/victoria-metrics-data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: ssd-csi-udisk
        resources:
          requests:
            storage: 40Gi

---
apiVersion: v1
kind: Service
metadata:
  name: victoriametrics-under-test
  namespace: benchmark
spec:
  type: ClusterIP
  ports:
    - name: http
      port: 8428
      targetPort: 8428
  selector:
    app: victoriametrics-under-test
```

### 6.4 指标源：node-exporter + Headless Service

```yaml
# benchmark-targets.yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: benchmark-node-exporter
  namespace: benchmark
spec:
  replicas: 50                          # 起步 50，按场景 scale
  selector:
    matchLabels:
      app: benchmark-node-exporter
  template:
    metadata:
      labels:
        app: benchmark-node-exporter
    spec:
      containers:
        - name: node-exporter
          image: uhub.service.ucloud.cn/prometheusv3/node-exporter:latest
          ports:
            - containerPort: 9100
              name: metrics
          resources:
            limits:
              cpu: 50m
              memory: 64Mi

---
# Headless Service：vmagent 用 endpoints 发现必须依赖它
apiVersion: v1
kind: Service
metadata:
  name: benchmark-node-exporter
  namespace: benchmark
spec:
  clusterIP: None
  ports:
    - name: metrics
      port: 9100
      targetPort: 9100
  selector:
    app: benchmark-node-exporter
```

> **为什么必须 Headless Service**：vmagent 用 `kubernetes_sd_configs: role: endpoints` 发现目标，需要 Service 生成 Endpoints 对象。用 `clusterIP: None` 的 Headless Service 最干净，每个 Pod IP 都进 endpoints。

### 6.5 写入负载：vmagent + RBAC

> ⚠️ **关键坑**：vmagent 的 `remote_write` **不能写在 promscrape config 文件里**（strict parse 会报 `field remote_write not found`）。必须用 `-remoteWrite.url` 命令行参数传，可重复多次指向多个后端。

```yaml
# vmagent.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: vmagent
  namespace: benchmark

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: benchmark-vmagent
rules:
  - apiGroups: [""]
    resources: [pods, nodes, services, endpoints]
    verbs: [get, list, watch]
  - apiGroups: ["discovery.k8s.io"]
    resources: [endpointslices]
    verbs: [get, list, watch]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: benchmark-vmagent
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: benchmark-vmagent
subjects:
  - kind: ServiceAccount
    name: vmagent
    namespace: benchmark

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: vmagent-config
  namespace: benchmark
data:
  vmagent.yml: |
    global:
      scrape_interval: 15s
    scrape_configs:
      - job_name: node_exporter
        kubernetes_sd_configs:
          - role: endpoints
            namespaces:
              names: [benchmark]
        relabel_configs:
          - source_labels: [__meta_kubernetes_service_name]
            action: keep
            regex: benchmark-node-exporter
          - source_labels: [__meta_kubernetes_endpoint_port_name]
            action: keep
            regex: metrics
    # 注意：remote_write 不写这里！用 -remoteWrite.url 命令行参数

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vmagent
  namespace: benchmark
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vmagent
  template:
    metadata:
      labels:
        app: vmagent
    spec:
      serviceAccountName: vmagent
      containers:
        - name: vmagent
          image: uhub.service.ucloud.cn/prometheusv3/vmagent:latest
          args:
            - -promscrape.config=/etc/vmagent/vmagent.yml
            # remote_write 用命令行参数，同时写两个后端
            - -remoteWrite.url=http://prometheus-under-test.benchmark.svc.cluster.local:9090/api/v1/write
            - -remoteWrite.url=http://victoriametrics-under-test.benchmark.svc.cluster.local:8428/api/v1/write
          ports:
            - containerPort: 8429
              name: http
          resources:
            limits:
              cpu: "1"
              memory: 1Gi
            requests:
              cpu: "1"
              memory: 1Gi
          volumeMounts:
            - name: config
              mountPath: /etc/vmagent
      volumes:
        - name: config
          configMap:
            name: vmagent-config

---
apiVersion: v1
kind: Service
metadata:
  name: vmagent
  namespace: benchmark
spec:
  ports:
    - name: http
      port: 8429
      targetPort: 8429
  selector:
    app: vmagent
```

> vmagent 会自动协商协议：对 Prometheus 降级用标准 remote_write 协议（Prometheus 不支持 VM 原生协议），对 VM 用原生协议。两边 0 错误即写入正常。

### 6.6 监控栈：monitoring-prometheus + RBAC + cAdvisor

```yaml
# monitoring-stack.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: monitoring-prometheus
  namespace: benchmark

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-prometheus
rules:
  - apiGroups: [""]
    resources: [nodes, nodes/proxy, nodes/metrics]
    verbs: [get, list, watch]
  - apiGroups: [""]
    resources: [services, endpoints, pods]
    verbs: [get, list, watch]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: monitoring-prometheus
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: monitoring-prometheus
subjects:
  - kind: ServiceAccount
    name: monitoring-prometheus
    namespace: benchmark

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: monitoring-prometheus-config
  namespace: benchmark
data:
  prometheus.yml: |
    global:
      scrape_interval: 10s
    scrape_configs:
      - job_name: prometheus-under-test
        static_configs:
          - targets: ['prometheus-under-test.benchmark.svc.cluster.local:9090']
      - job_name: victoriametrics-under-test
        metrics_path: /metrics
        static_configs:
          - targets: ['victoriametrics-under-test.benchmark.svc.cluster.local:8428']
      - job_name: vmagent
        static_configs:
          - targets: ['vmagent.benchmark.svc.cluster.local:8429']
      # kubelet cAdvisor — 容器级 CPU/内存
      - job_name: kubernetes-cadvisor
        scheme: https
        tls_config:
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
          insecure_skip_verify: true
        bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
        kubernetes_sd_configs:
          - role: node
        relabel_configs:
          - action: labelmap
            regex: __meta_kubernetes_node_label_(.+)
          - target_label: __address__
            replacement: kubernetes.default.svc:443
          - source_labels: [__meta_kubernetes_node_name]
            regex: (.+)
            target_label: __metrics_path__
            replacement: /api/v1/nodes/$${1}/proxy/metrics/cadvisor
      # kubelet 自身指标 — 节点级
      - job_name: kubernetes-nodes
        scheme: https
        tls_config:
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
          insecure_skip_verify: true
        bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
        kubernetes_sd_configs:
          - role: node
        relabel_configs:
          - action: labelmap
            regex: __meta_kubernetes_node_label_(.+)
          - target_label: __address__
            replacement: kubernetes.default.svc:443
          - source_labels: [__meta_kubernetes_node_name]
            regex: (.+)
            target_label: __metrics_path__
            replacement: /api/v1/nodes/$${1}/proxy/metrics

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: monitoring-prometheus
  namespace: benchmark
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0            # 资源紧，避免新旧共存调度不下
      maxUnavailable: 1
  selector:
    matchLabels:
      app: monitoring-prometheus
  template:
    metadata:
      labels:
        app: monitoring-prometheus
    spec:
      serviceAccountName: monitoring-prometheus
      securityContext:
        runAsUser: 0
        fsGroup: 0
      containers:
        - name: prometheus
          image: uhub.service.ucloud.cn/prometheusv3/prometheus:v3.12.0
          args:
            - --config.file=/etc/prometheus/prometheus.yml
            - --storage.tsdb.path=/var/lib/prometheus
            - --storage.tsdb.retention.time=7d
            - --web.enable-lifecycle
          ports:
            - containerPort: 9090
              name: http
          resources:
            limits:
              cpu: 500m
              memory: 1Gi
            requests:
              cpu: 200m
              memory: 512Mi
          volumeMounts:
            - name: config
              mountPath: /etc/prometheus
            - name: data
              mountPath: /var/lib/prometheus
      volumes:
        - name: config
          configMap:
            name: monitoring-prometheus-config
        - name: data
          emptyDir: {}          # 监控数据不持久化，重启可丢

---
apiVersion: v1
kind: Service
metadata:
  name: monitoring-prometheus
  namespace: benchmark
spec:
  ports:
    - name: http
      port: 9090
      targetPort: 9090
  selector:
    app: monitoring-prometheus
```

### 6.7 Grafana + 数据源自动 provisioning

```yaml
# grafana.yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: benchmark
data:
  datasources.yaml: |
    apiVersion: 1
    datasources:
      - name: Prometheus
        uid: prom                      # 仪表盘用这个 uid 引用
        type: prometheus
        access: proxy
        url: http://monitoring-prometheus.benchmark.svc.cluster.local:9090
        isDefault: true
        editable: true

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
  namespace: benchmark
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 1
  selector:
    matchLabels:
      app: grafana
  template:
    metadata:
      labels:
        app: grafana
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: role
                    operator: NotIn
                    values: [prom, vm]
      containers:
        - name: grafana
          image: uhub.service.ucloud.cn/prometheusv3/grafana:11.3.0
          ports:
            - containerPort: 3000
              name: http
          env:
            - name: GF_SECURITY_ADMIN_PASSWORD
              value: admin
            - name: GF_AUTH_ANONYMOUS_ENABLED
              value: "true"
          resources:
            limits:
              cpu: 500m
              memory: 512Mi
            requests:
              cpu: 100m
              memory: 256Mi
          volumeMounts:
            - name: config
              mountPath: /etc/grafana/provisioning/datasources
      volumes:
        - name: config
          configMap:
            name: grafana-datasources

---
apiVersion: v1
kind: Service
metadata:
  name: grafana
  namespace: benchmark
spec:
  ports:
    - name: http
      port: 3000
      targetPort: 3000
  selector:
    app: grafana
```

### 6.8 Ingress（统一入口）

```yaml
# ingress.yaml
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: benchmark-ingress
  namespace: benchmark
spec:
  ingressClassName: nginx
  rules:
    - host: prom-test.benchmark.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: prometheus-under-test
                port: { number: 9090 }
    - host: vm-test.benchmark.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: victoriametrics-under-test
                port: { number: 8428 }
    - host: prom-monitor.benchmark.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: monitoring-prometheus
                port: { number: 9090 }
    - host: grafana.benchmark.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: grafana
                port: { number: 3000 }
```

访问前在本地 `/etc/hosts` 加：
```
<集群入口IP>  prom-test.benchmark.local vm-test.benchmark.local prom-monitor.benchmark.local grafana.benchmark.local
```

### 6.9 查询负载：vmalert（待部署）

> vmalert 负责对两个后端发查询，产生查询负载，让"查询性能"维度有数据。**当前尚未部署**，正式压测前需补上。

```yaml
# vmalert.yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: vmalert-rules
  namespace: benchmark
data:
  rules.yml: |
    groups:
      - name: benchmark-queries
        interval: 15s
        rules:
          - alert: HighCPU
            expr: 100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 80
            for: 5m
          - alert: HighMemory
            expr: (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100 > 85
            for: 5m
          - alert: DiskFull
            expr: (1 - node_filesystem_avail_bytes / node_filesystem_size_bytes) * 100 > 85
            for: 5m

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vmalert
  namespace: benchmark
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vmalert
  template:
    metadata:
      labels:
        app: vmalert
    spec:
      containers:
        - name: vmalert
          image: uhub.service.ucloud.cn/prometheusv3/vmalert:latest
          args:
            - -rule=/etc/vmalert/rules.yml
            - -datasource.url=http://prometheus-under-test.benchmark.svc.cluster.local:9090
            - -notifier.url=http://blackhole.default.svc.cluster.local
          volumeMounts:
            - name: rules
              mountPath: /etc/vmalert
          resources:
            limits:
              cpu: 500m
              memory: 512Mi
      volumes:
        - name: rules
          configMap:
            name: vmalert-rules
```

> ⚠️ vmalert 一个实例只能配一个 `-datasource.url`。要同时压测两个后端，**部署两个 vmalert 实例**（各指向一个数据源，用同一份 rules），或分两次跑。`-notifier.url` 指向一个不存在的地址即可（告警发不出，只为触发查询）。

---

## 七、Grafana 仪表盘

已通过 Grafana API 导入对比仪表盘，`uid=prom-vm-bench`，数据源引用 `uid=prom`。访问：`http://grafana.benchmark.local/d/prom-vm-bench`。

> 仪表盘 JSON 单独存于 [prometheus-vs-victoriametrics-dashboard.json](prometheus-vs-victoriametrics-dashboard.json)，可直接在 Grafana UI 用 `Import` 上传，或用下方 API 导入。

仪表盘统一配色：**Prometheus = 蓝色，VictoriaMetrics = 橙色**，同面板双查询叠加，扫一眼即知谁高谁低。

| 行 | 面板 | 查询要点 |
|---|---|---|
| ① 概览 | 实例状态 / 写入速率 / Active Series | `up`、`rate(...samples_appended_total)` vs `rate(vm_rows_inserted_total)` |
| ② 写入性能 | 写入吞吐对比 / 写入丢弃 | out-of-order vs ignored+invalid |
| ③ 资源占用 | 进程内存 RSS（带 3500Mi OOM 阈值线）/ 进程 CPU / 磁盘占用 / 压缩比 | `process_resident_memory_bytes` / `process_cpu_seconds_total` |
| ④ 查询性能 | 查询延迟 p99 / 查询 QPS | `prometheus_http_request_duration_seconds_bucket` vs `vm_http_request_duration_seconds_bucket` |
| ⑤ K8s 容器资源 | 容器内存 working set（带 OOM 阈值）/ 容器 CPU | cAdvisor `container_*` 指标 |

导入方式（仪表盘 JSON 见仓库配套文件，或用 Grafana UI Import）：

```bash
# 通过 Grafana HTTP API 导入
python3 -c "import json; d=json.load(open('dashboard.json')); print(json.dumps({'dashboard':d,'overwrite':True}))" > /tmp/payload.json
kubectl cp /tmp/payload.json benchmark/<grafana-pod>:/tmp/payload.json
kubectl exec <grafana-pod> -n benchmark -- curl -s -X POST http://localhost:3000/api/dashboards/db \
  -H "Content-Type: application/json" -u admin:admin -d @/tmp/payload.json
```

---

## 八、执行流程

### 8.1 每个场景的标准流程

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  1. 清空数据  │───▶│  2. 重新部署  │───▶│  3. 预热30min │───▶│  4. 持续压测  │───▶│  5. 数据采集  │
│  删 PVC/重建  │    │  kubectl apply│    │  稳态确认     │    │  按场景运行   │    │  导出指标     │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

### 8.2 初始部署

```bash
# 0. namespace + PSA
kubectl create namespace benchmark
kubectl label namespace benchmark pod-security.kubernetes.io/enforce=privileged --overwrite
kubectl label node <bench-node-1> role=prom
kubectl label node <bench-node-2> role=vm

# 1. 被测实例
kubectl apply -f prometheus-under-test.yaml
kubectl apply -f victoriametrics-under-test.yaml

# 2. 指标源 + 写入负载
kubectl apply -f benchmark-targets.yaml
kubectl apply -f vmagent.yaml

# 3. 监控栈 + 入口
kubectl apply -f monitoring-stack.yaml
kubectl apply -f grafana.yaml
kubectl apply -f ingress.yaml

# 4. 查询负载（正式压测前补）
kubectl apply -f vmalert.yaml

# 5. 等 Pod 就绪
kubectl get pods -n benchmark -w
```

### 8.3 每场景重置脚本

```bash
#!/bin/bash
# reset_scenario.sh — 场景间清空数据重新开始
NS=benchmark
echo "=== 重置场景 ==="

kubectl delete statefulset prometheus-under-test -n $NS
kubectl delete statefulset victoriametrics-under-test -n $NS
kubectl delete pvc data-prometheus-under-test-0 -n $NS
kubectl delete pvc data-victoriametrics-under-test-0 -n $NS

kubectl apply -f prometheus-under-test.yaml
kubectl apply -f victoriametrics-under-test.yaml
kubectl rollout status statefulset/prometheus-under-test -n $NS --timeout=300s
kubectl rollout status statefulset/victoriametrics-under-test -n $NS --timeout=300s

echo "预热 30 分钟..."
sleep 1800

# 确认写入正常
echo "Prometheus 写入速率:"
kubectl exec -n $NS prometheus-under-test-0 -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=sum(rate(prometheus_tsdb_head_samples_appended_total[5m]))'
echo "VM 写入速率:"
kubectl exec -n $NS victoriametrics-under-test-0 -- \
  wget -qO- 'http://localhost:8428/api/v1/query?query=sum(rate(vm_rows_inserted_total[5m]))'
echo "=== 重置完成，可开始压测 ==="
```

### 8.4 调整场景参数

```bash
# 调整目标数
kubectl scale deployment benchmark-node-exporter -n benchmark --replicas=100
```

### 8.5 极限场景执行方法

```bash
# T5: 写入极限 — 逐步增加目标数
for targets in 50 100 150 200 250 300; do
  echo "=== 测试 ${targets} 目标 ==="
  kubectl scale deployment benchmark-node-exporter -n benchmark --replicas=${targets}
  sleep 3600
  # 检测写入堆积/失败见监控仪表盘
done

# T8: 重启恢复测试（测 MTTR）
# Prometheus
START_TS=$(date +%s%N)
kubectl delete pod prometheus-under-test-0 -n benchmark
kubectl wait --for=condition=Ready pod/prometheus-under-test-0 -n benchmark --timeout=600s
# 轮询直到首次成功查询...
END_TS=$(date +%s%N)
echo "Prometheus 恢复时间: $(( (END_TS - START_TS) / 1000000 )) ms"
# VictoriaMetrics 同理
```

---

## 九、结果记录

> 测试完成后回填。每个场景（T1-T9）独立记录一张表，最后汇总。

### 9.1 核心结果表（T_x 场景）

| 指标 | Prometheus | VictoriaMetrics | VM 优势倍数 | 备注 |
|---|---|---|---|---|
| 场景 / 目标数 / 时长 |  |  |  |  |
| 写入速率 (samples/s) |  |  |  |  |
| Active series |  |  |  |  |
| 写入丢弃 (samples/s) |  |  |  |  |
| 内存均值 (Mi) |  |  |  |  |
| 内存峰值 (Mi) |  |  |  |  |
| CPU 均值 (cores) |  |  |  |  |
| CPU 峰值 (cores) |  |  |  |  |
| 磁盘占用 (Gi) |  |  |  |  |
| bytes/sample |  |  |  |  |
| 查询 p50 (ms) |  |  |  |  |
| 查询 p95 (ms) |  |  |  |  |
| 查询 p99 (ms) |  |  |  |  |
| 查询 QPS |  |  |  |  |
| 重启恢复时间 (s) |  |  |  |  |
| OOM 次数 |  |  |  |  |

### 9.2 分场景汇总

| 场景 | 写入 samples/s (P/VM) | 内存峰值 Mi (P/VM) | 磁盘 Gi (P/VM) | 查询 p99 ms (P/VM) | 结论 |
|---|---|---|---|---|---|
| T1 基线 (100) |  |  |  |  |  |
| T2 高写入 (200) |  |  |  |  |  |
| T3 高 Churn |  |  |  |  |  |
| T4 查询压力 |  |  |  |  |  |
| T5 写入极限 |  |  |  |  |  |
| T6 OOM 边界 |  |  |  |  |  |
| T7 磁盘瓶颈 |  |  |  |  |  |
| T8 重启恢复 |  |  |  |  |  |
| T9 长周期查询 |  |  |  |  |  |

### 9.3 关键观察与结论

> （测试后填写：哪个场景下谁明显占优、是否出现 OOM、资源瓶颈在哪、生产选型建议）

---

## 十、预期结论（基于已有基准测试）

根据 VictoriaMetrics 官方和社区已发布的基准测试，预期结果：

| 维度 | 预期 VM 优势 | 依据 |
|---|---|---|
| 磁盘空间 | **3-7x 更少** | 改进 Gorilla 压缩，0.3 vs 1.15-2.1 bytes/sample |
| 内存 | **1.7-5x 更少** | 更高效的内存索引结构 |
| 查询延迟 p50 | **10-16x 更快** | 更优的数据布局与合并策略 |
| 查询延迟 p99 | **1.9-2x 更快** | 减少尾部延迟 |
| CPU | **基本持平** | 写入路径相似 |
| 写入极限 | **1.5-2x 更高** | 更高效的 WAL 和合并 |
| 重启恢复 | **2-5x 更快** | 更快的数据加载 |

> ⚠️ 以上为已有基准的预期值（基于 4C16G 环境）。本实验在 2C4G 下的实际结果可能因资源更紧张而差异更大——4G 内存下 Prometheus 更容易 OOM，VM 的内存优势会更显著。实验的核心价值在于**你自己的环境和负载下的真实数据**。

---

## 十一、注意事项

### 11.1 公平性保障

- ✅ 两个 Node 硬件一致，`nodeSelector` 固定 Prometheus→role=prom、VM→role=vm
- ✅ 两者均通过 vmagent `remote_write` 接收**完全相同**的写入流（非本地采集）
- ✅ 保留时间一致（7d）
- ✅ StorageClass 一致（`ssd-csi-udisk`）
- ✅ 资源 limit 一致（2C / 3500Mi）
- ✅ 监控栈与负载生成器不调度到测试 Node

### 11.2 实测踩过的坑

| 坑 | 现象 | 解决 |
|---|---|---|
| Prometheus v3 PVC 权限 | `open queries.active: permission denied` → panic | `securityContext.runAsUser=0, fsGroup=0` |
| PSA 剥离 securityContext | `runAsUser:0` 被静默移除，Pod 仍以 nobody 起 | namespace 打 `pod-security.kubernetes.io/enforce=privileged` |
| v3 启动参数名 | `--storage.path` / `--storage.tsdb.retention` 不存在 → Exit 1 | 用 `--storage.tsdb.path` + `--storage.tsdb.retention.time` |
| RSSD 云盘缺货 | VM 节点 PVC `ProvisioningFailed: no available set exist` | 两边统一用 `ssd-csi-udisk` |
| vmagent config 写 remote_write | `field remote_write not found` strict parse 报错 | remote_write 改用 `-remoteWrite.url` 命令行参数 |
| vmagent 无 RBAC | `pods is forbidden: User default cannot list` | 建 ServiceAccount + ClusterRole/Binding |
| vmagent Pod IP 不可达 | `no route to host`（部分网络策略） | 改用 endpoints 发现 + Headless Service |
| 资源不足调度失败 | monitoring-prometheus/grafana Pending | 降 requests、设 `maxSurge:0` 滚动更新 |

### 11.3 结果可信度

- 每个核心场景至少运行 **7 天**（短期无法反映合并、压缩真实效果）
- 极限场景运行 **至少 1 小时** 后采集
- 关键指标取 **稳态区间**（去掉前 30 分钟预热）
- 重复 2-3 次取中位数
- 场景切换前**必须删 PVC 重建**，避免历史数据干扰

---

## 十二、快速启动（最小可行实验）

```bash
# 0. 准备
kubectl create namespace benchmark
kubectl label namespace benchmark pod-security.kubernetes.io/enforce=privileged --overwrite
kubectl label node <bench-node-1> role=prom
kubectl label node <bench-node-2> role=vm

# 1. 被测实例
kubectl apply -f prometheus-under-test.yaml
kubectl apply -f victoriametrics-under-test.yaml

# 2. 指标源 + 写入负载
kubectl apply -f benchmark-targets.yaml
kubectl apply -f vmagent.yaml

# 3. 监控栈
kubectl apply -f monitoring-stack.yaml
kubectl apply -f grafana.yaml
kubectl apply -f ingress.yaml

# 4. 等就绪 + 预热 30min
kubectl get pods -n benchmark -w

# 5. 验证写入
kubectl exec -n benchmark prometheus-under-test-0 -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=sum(rate(prometheus_tsdb_head_samples_appended_total[5m]))'
kubectl exec -n benchmark victoriametrics-under-test-0 -- \
  wget -qO- 'http://localhost:8428/api/v1/query?query=sum(rate(vm_rows_inserted_total[5m]))'

# 6. 打开 Grafana 看对比仪表盘
#   http://grafana.benchmark.local/d/prom-vm-bench  (admin/admin)
#   数据源已自动 provisioning（uid=prom → monitoring-prometheus）
```

---

## 参考

- [prometheus-benchmark 工具](https://github.com/VictoriaMetrics/prometheus-benchmark)
- [VictoriaMetrics 官方基准测试 (2024)](https://victoriametrics.com/blog/reducing-costs-p1/)
- [Prometheus vs VictoriaMetrics (2020)](https://valyala.medium.com/prometheus-vs-victoriametrics-benchmark-on-node-exporter-metrics-4ca29c75590f)
- [VictoriaMetrics 单机版容量说明](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/)
- [Google SRE Book — SLI/SLO](https://sre.google/sre-book/service-level-objectives/)
- [USE 方法 (Brendan Gregg)](https://brendangregg.com/usemethod.html)
