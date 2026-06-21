# Prometheus Operator 使用指南

Prometheus Operator 是 CoreOS（现 Red Hat）开发的 Kubernetes Operator，用 Kubernetes 原生方式部署和管理 Prometheus、Alertmanager 及相关监控组件。它把"Prometheus 该抓谁、告警发给谁、数据存哪"这些原本要写 `prometheus.yml` 才能表达的配置，抽象成一组 Kubernetes 自定义资源（CRD），让你像管理 Deployment、Service 一样管理整套监控栈。

本文基于 Prometheus Operator 官方文档（https://prometheus-operator.dev/）整理，覆盖 CRD 介绍、部署、自定义监控告警与高级进阶。撰写时 Operator 最新版本为 **v0.88.1**，Prometheus 已支持到 v3.12.0。

> 阅读建议：第 1-3 章建立认知，第 4-7 章是上手必读，第 8 章面向生产环境。所有 YAML 均来自官方文档或可被 `kubectl apply` 直接使用。

---

## 1. 概述

### 1.1 为什么需要 Prometheus Operator

裸跑 Prometheus 在 Kubernetes 里要解决这些问题：

| 痛点 | 原生 Prometheus | Prometheus Operator |
|---|---|---|
| 配置变更 | 改 `prometheus.yml` → reload → 风险高 | 改 CRD → Operator 自动 reload |
| 服务发现 | 手写 `kubernetes_sd_configs` + relabel | `ServiceMonitor` 用 label 选择器自动发现 |
| 告警规则 | 写文件挂载 → 重启生效 | `PrometheusRule` CRD，热加载 |
| Alertmanager 配置 | 集中写一份 yaml，团队互相覆盖 | `AlertmanagerConfig` 按团队/命名空间隔离 |
| 多实例管理 | 多套 StatefulSet + ConfigMap | 一个 `Prometheus` CR 搞定 |
| 版本升级 | 改镜像 → 祈祷 | `spec.image` 或 `spec.version` 字段 |
| 高可用 | 自己搞副本 + 反亲和 | `replicas: 2` 一行搞定 |

### 1.2 核心特性

- **Kubernetes 自定义资源**：用 CRD 部署和管理 Prometheus、Alertmanager 及相关组件
- **简化部署配置**：从原生 Kubernetes 资源配置 Prometheus 的版本、持久化、保留策略、副本数
- **目标配置自动化**：基于 Kubernetes 标签查询自动生成监控目标配置，无需学习 Prometheus 专有配置语言
- **配置校验**：Operator 在生成配置前校验 `AlertmanagerConfig` 和 `PrometheusRule`，配置错误不会让 Prometheus 起不来
- **横向扩展**：通过分片（sharding）将抓取目标分布到多个 Prometheus 实例；通过 ThanosRuler 做分布式规则评估

### 1.3 项目目标

1. **自动化**：用 CRD 自动管理 Prometheus 监控目标，降低运维成本
2. **配置抽象与校验**：用 Kubernetes Label Selector 替代手写 relabel 规则；`ServiceMonitor`/`PodMonitor`/`Probe` 提供这层抽象
3. **扩展**：提供 ThanosRuler 做规则评估、抓取目标分片、Thanos sidecar 做长期存储

---

## 2. 架构设计

### 2.1 整体架构

```
┌────────────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                          │
│                                                                │
│  ┌──────────────────────┐    watch     ┌──────────────────┐   │
│  │  Prometheus Operator │ ──────────── │  API Server      │   │
│  │  (Deployment)        │              │  (CRD registry)  │   │
│  └──────────┬───────────┘              └──────────────────┘   │
│             │ reconcile                                      │
│             ▼                                                │
│  ┌──────────────────────┐  ┌─────────────────────────────┐   │
│  │  StatefulSet         │  │  ConfigMap / Secret         │   │
│  │  (Prometheus Pod)    │  │  (生成的 prometheus.yml)    │   │
│  │   ┌────────────────┐ │  └─────────────────────────────┘   │
│  │   │  prometheus    │◄─────── mount                        │
│  │   │  (容器)         │ │                                     │
│  │   └────────────────┘ │  ┌─────────────────────────────┐   │
│  │   ┌────────────────┐ │  │  prometheus-rule-files-0    │   │
│  │   │  config-reloader│ │  │  (规则文件)                  │   │
│  │   └────────────────┘ │  └─────────────────────────────┘   │
│  └──────────────────────┘                                      │
│                                                                │
│  用户创建的 CRD：                                              │
│  ┌────────────┐ ┌──────────┐ ┌─────────┐ ┌──────────────┐    │
│  │ Prometheus │ │ Alertmanager│ │ ThanosRuler│ │ PrometheusAgent│    │
│  └────────────┘ └──────────┘ └─────────┘ └──────────────┘    │
│  ┌──────────────┐ ┌──────────┐ ┌──────┐ ┌──────────────────┐ │
│  │ ServiceMonitor│ │ PodMonitor│ │ Probe│ │ ScrapeConfig     │ │
│  └──────────────┘ └──────────┘ └──────┘ └──────────────────┘ │
│  ┌──────────────┐ ┌────────────────────┐                     │
│  │ PrometheusRule│ │ AlertmanagerConfig │                     │
│  └──────────────┘ └────────────────────┘                     │
└────────────────────────────────────────────────────────────────┘
```

Operator 的核心工作循环（reconcile loop）：

1. **watch**：监听所有 Prometheus Operator CRD 的变化
2. **选择**：根据 `Prometheus` CR 中的 selector 字段，挑选出该实例应该使用的 ServiceMonitor/PodMonitor/PrometheusRule 等资源
3. **生成**：把选中资源的声明式配置翻译成原生 Prometheus 的 `prometheus.yml` 和规则文件
4. **部署**：创建/更新 StatefulSet、Service、ConfigMap、Secret 等 Kubernetes 原生资源
5. **reload**：通过给 Prometheus 容器发 HTTP reload 信号或 SIGHUP，让新配置生效，无需重启

### 2.2 CRD 分类：实例型 vs 配置型

Prometheus Operator 提供 **10 个 CRD**，分两大类：

#### 实例型资源（Instance-Based）

管理监控组件本身的部署和生命周期。Operator 为每个实例型 CRD 创建 StatefulSet。

| CRD | 作用 | 底层负载 |
|---|---|---|
| **Prometheus** | 部署一个 Prometheus 实例 | StatefulSet（每个 shard 一个） |
| **Alertmanager** | 部署一个 Alertmanager 实例，多副本自动组成 HA 集群 | StatefulSet |
| **ThanosRuler** | 部署 Thanos Ruler，跨多个 Prometheus 做规则评估 | StatefulSet |
| **PrometheusAgent** | 部署 Prometheus Agent 模式（只采集 + remote write，无本地存储/规则评估） | StatefulSet |

#### 配置型资源（Config-Based）

描述"抓谁、怎么抓、规则是什么、告警发哪去"，被实例型资源通过 selector 引用。

| CRD | 作用 |
|---|---|
| **ServiceMonitor** | 通过 Kubernetes Service 发现目标，生成 scrape 配置 |
| **PodMonitor** | 直接通过 Pod 标签发现目标，绕过 Service |
| **Probe** | 黑盒监控，配合 blackbox exporter 探测 Ingress/静态目标 |
| **ScrapeConfig** | 低阶抓取配置，支持 static/file/http/kubernetes 等服务发现，覆盖 ServiceMonitor 表达不了的场合 |
| **PrometheusRule** | 告警规则和 recording rules |
| **AlertmanagerConfig** | 告警路由、接收器、抑制规则，按命名空间/团队隔离 |

### 2.3 资源选择器机制

实例型资源通过一组 selector 字段决定"我要用哪些配置型资源"。这是 Prometheus Operator 的核心设计——**让 Prometheus 实例和监控配置解耦，团队可以各自维护自己的 ServiceMonitor/PrometheusRule**。

| 实例型 CRD | selector 字段 | 选中的配置型 CRD |
|---|---|---|
| Prometheus / PrometheusAgent | `serviceMonitorSelector` + `serviceMonitorNamespaceSelector` | ServiceMonitor |
| Prometheus / PrometheusAgent | `podMonitorSelector` + `podMonitorNamespaceSelector` | PodMonitor |
| Prometheus / PrometheusAgent | `probeSelector` + `probeNamespaceSelector` | Probe |
| Prometheus / PrometheusAgent | `scrapeConfigSelector` + `scrapeConfigNamespaceSelector` | ScrapeConfig |
| Prometheus / ThanosRuler | `ruleSelector` + `ruleNamespaceSelector` | PrometheusRule |
| Alertmanager | `alertmanagerConfigSelector` + `alertmanagerConfigNamespaceSelector` | AlertmanagerConfig |

**selector 语义**（遵循 Kubernetes 标准 label selector）：

- 空 selector `{}` → 匹配所有对象
- 未指定（null）→ 资源 selector 匹配零个对象；命名空间 selector 只匹配当前命名空间
- 指定标签 → 匹配带这些标签的对象

```
┌─────────────────┐      serviceMonitorSelector       ┌─────────────────┐
│   Prometheus    │ ─────────────────────────────────► │ ServiceMonitor  │
│   (实例)         │      (matchLabels: team=frontend) │   (team:frontend)│
│                 │                                     └─────────────────┘
│                 │      ruleSelector                  ┌─────────────────┐
│                 │ ─────────────────────────────────► │ PrometheusRule  │
│                 │      (matchLabels: role=alert)     │  (role:alert)   │
└─────────────────┘                                     └─────────────────┘
        │
        │ alerting.alertmanagers
        ▼
┌─────────────────┐      alertmanagerConfigSelector    ┌──────────────────┐
│  Alertmanager   │ ─────────────────────────────────► │AlertmanagerConfig│
│   (实例)         │                                    │  (按团队隔离)      │
└─────────────────┘                                     └──────────────────┘
```

### 2.4 工作原理：ServiceMonitor 如何变成 scrape 配置

以 ServiceMonitor 为例，Operator 把声明式 CRD 翻译成 Prometheus 原生配置的完整流程：

```
1. 用户 kubectl apply 一个 ServiceMonitor
        │
        ▼
2. Operator watch 到变化，读取目标 Prometheus 的 serviceMonitorSelector
        │
        ▼
3. 列出所有匹配的 ServiceMonitor（跨命名空间则受 serviceMonitorNamespaceSelector 控制）
        │
        ▼
4. 对每个 ServiceMonitor:
   a. 用 spec.selector.matchLabels 找到对应的 Kubernetes Service
   b. 从 Service 的 Endpoints/EndpointSlices 拿到 Pod IP 列表
   c. 按 spec.endpoints[].port 拿到端口
   d. 应用 spec.endpoints[].relabelings（抓取前 relabel）
   e. 应用 spec.endpoints[].metricRelabelings（抓取后 relabel）
        │
        ▼
5. 把所有 ServiceMonitor 翻译结果合并，生成 scrape_configs 段
        │
        ▼
6. 与 PodMonitor/Probe/ScrapeConfig 翻译结果合并，写入 ConfigMap
        │
        ▼
7. 挂载到 Prometheus Pod，触发 config-reloader sidecar 调 reload API
        │
        ▼
8. Prometheus 热加载新配置，开始按新配置抓取
```

---

## 3. CRD 详解

### 3.1 CRD 总览

| CRD | API Group | Version | 引入版本 | 类别 |
|---|---|---|---|---|
| Prometheus | monitoring.coreos.com | v1 | 初始 | 实例型 |
| Alertmanager | monitoring.coreos.com | v1 | 初始 | 实例型 |
| ThanosRuler | monitoring.coreos.com | v1 | 初始 | 实例型 |
| PrometheusAgent | monitoring.coreos.com | v1alpha1 | v0.64.0 | 实例型 |
| ServiceMonitor | monitoring.coreos.com | v1 | 初始 | 配置型 |
| PodMonitor | monitoring.coreos.com | v1 | 初始 | 配置型 |
| Probe | monitoring.coreos.com | v1 | 初始 | 配置型 |
| ScrapeConfig | monitoring.coreos.com | v1alpha1 | v0.65.1 | 配置型 |
| PrometheusRule | monitoring.coreos.com | v1 | 初始 | 配置型 |
| AlertmanagerConfig | monitoring.coreos.com | v1alpha1 | 初始 | 配置型 |

### 3.2 实例型 CRD

#### 3.2.1 Prometheus

`Prometheus` CRD 是 Prometheus Operator 的核心，部署一个 Prometheus 实例。Operator 为每个 Prometheus CR 创建一个 StatefulSet（启用了 sharding 时每个 shard 一个）。

**关键字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `spec.replicas` | int | 副本数，>1 时多副本各自独立抓取（非集群） |
| `spec.shards` | int | 分片数，默认 1。>1 时目标按 hash 分布到各 shard |
| `spec.image` / `spec.version` | string | Prometheus 镜像/版本 |
| `spec.serviceAccountName` | string | Prometheus Pod 使用的 ServiceAccount |
| `spec.storage` | object | 持久化存储 PVC 模板 |
| `spec.retention` / `spec.retentionSize` | string | 数据保留时间/大小（如 `15d`、`100Gi`） |
| `spec.ruleSelector` | object | 选中哪些 PrometheusRule |
| `spec.serviceMonitorSelector` | object | 选中哪些 ServiceMonitor |
| `spec.podMonitorSelector` | object | 选中哪些 PodMonitor |
| `spec.probeSelector` | object | 选中哪些 Probe |
| `spec.scrapeConfigSelector` | object | 选中哪些 ScrapeConfig |
| `spec.alerting.alertmanagers` | array | 告警发送到哪些 Alertmanager |
| `spec.remoteWrite` / `spec.remoteRead` | array | 远程存储 |
| `spec.thanos` | object | Thanos sidecar 配置 |
| `spec.externalLabels` | map | 外部标签，附加到所有时序 |
| `spec.externalUrl` / `spec.routePrefix` | string | Web UI 外部访问 URL/路径前缀 |
| `spec.podMetadata` | object | Pod 元数据（标签/注解） |
| `spec.resources` | object | 容器资源请求/限制 |
| `spec.affinity` / `spec.tolerations` | object | 调度约束 |
| `spec.securityContext` | object | Pod 安全上下文 |
| `spec.paused` | bool | 暂停 Operator 对该 CR 的 reconcile（用于卷扩容等场景） |

**最小示例**：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  serviceAccountName: prometheus
```

**生产级示例**：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
  namespace: monitoring
spec:
  image: quay.io/prometheus/prometheus:v3.12.0
  replicas: 2
  shards: 1
  serviceAccountName: prometheus
  retention: 15d
  retentionSize: 100Gi
  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: ssd
        resources:
          requests:
            storage: 200Gi
  resources:
    requests:
      cpu: "2"
      memory: 4Gi
    limits:
      cpu: "4"
      memory: 8Gi
  externalLabels:
    cluster: prod-cn-east-1
  serviceMonitorSelector:
    matchLabels:
      team: sre
  ruleSelector:
    matchLabels:
      role: alert-rules
  alerting:
    alertmanagers:
    - namespace: monitoring
      name: alertmanager
      port: web
  thanos:
    image: quay.io/thanos/thanos:v0.41.0
```

#### 3.2.2 Alertmanager

`Alertmanager` CRD 部署 Alertmanager 实例。`replicas > 1` 时 Operator 自动配置 HA 集群（gossip 协议复制 silences）。

**关键字段**：

| 字段 | 说明 |
|---|---|
| `spec.replicas` | 副本数，>1 自动 HA |
| `spec.image` / `spec.version` | 镜像/版本 |
| `spec.storage` | 持久化（保留 silence 状态） |
| `spec.configSecret` | 包含 `alertmanager.yaml` 的 Secret 名（默认 `alertmanager-{name}`） |
| `spec.alertmanagerConfigSelector` | 选中哪些 AlertmanagerConfig CRD |
| `spec.alertmanagerConfigNamespaceSelector` | 从哪些命名空间选 AlertmanagerConfig |
| `spec.alertmanagerConfiguration` | 引用一个 AlertmanagerConfig 作为全局主配置 |

**示例**：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Alertmanager
metadata:
  name: example
spec:
  replicas: 3
  alertmanagerConfigSelector:
    matchLabels:
      alertmanagerConfig: example
```

#### 3.2.3 ThanosRuler

`ThanosRuler` CRD 部署 Thanos Ruler，跨多个 Prometheus 实例（或 Thanos Querier）做分布式规则评估。适合分片后做全局告警的场景。

**关键字段**：

| 字段 | 说明 |
|---|---|
| `spec.image` | Thanos 镜像 |
| `spec.replicas` | 副本数 |
| `spec.queryEndpoints` | Thanos Querier 列表（query API endpoint） |
| `spec.queryConfig` | 从 Secret 读 query 配置 |
| `spec.ruleSelector` | 选中哪些 PrometheusRule |
| `spec.alertmanagersConfig` | 从 Secret 读 Alertmanager 配置 |
| `spec.storage` | 持久化（ruler 自身状态） |

**示例**：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ThanosRuler
metadata:
  name: thanos-ruler
  namespace: monitoring
spec:
  image: quay.io/thanos/thanos:v0.41.0
  replicas: 2
  ruleSelector:
    matchLabels:
      role: my-thanos-rules
  queryEndpoints:
    - dnssrv+_http._tcp.my-thanos-querier.monitoring.svc.cluster.local
  alertmanagersConfig:
    key: alertmanager-configs.yaml
    name: thanosruler-alertmanager-config
```

#### 3.2.4 PrometheusAgent

`PrometheusAgent`（v0.64.0+）部署 Prometheus Agent 模式。Agent 模式只采集 + remote write，不做本地存储/规则评估/告警——适合"中心化存储 + 边缘采集"架构，比如把所有集群的数据 remote write 到中心 Thanos/Mimir/VictoriaMetrics。

**与 Prometheus CR 的区别**：删除了 `alerting`、`ruleSelector`、`remoteRead`、`storage`、`thanos` 等字段。

**示例**：

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: PrometheusAgent
metadata:
  name: prometheus-agent
spec:
  replicas: 2
  serviceAccountName: prometheus-agent
  serviceMonitorSelector:
    matchLabels:
      team: frontend
  remoteWrite:
    - url: http://mimir.mimir.svc:8080/api/v1/push
```

### 3.3 配置型 CRD

#### 3.3.1 ServiceMonitor

最常用的监控配置 CRD。通过 Kubernetes Service 发现目标。

**工作原理**：

```
Pod (label: app=foo) 
   └─► Service (label: app=foo)  ◄── ServiceMonitor.selector
         └─► Endpoints ────────────► ServiceMonitor.endpoints[].port
                                       └─► http://<pod-ip>:<port>/metrics
```

**关键字段**：

| 字段 | 说明 |
|---|---|
| `spec.selector` | Kubernetes label selector，选中要监控的 Service |
| `spec.namespaceSelector` | 跨命名空间选择 Service |
| `spec.endpoints` | array，抓取端点列表 |
| `spec.endpoints[].port` | 端口名（Service 中定义的 port name）或端口号 |
| `spec.endpoints[].path` | metrics 路径，默认 `/metrics` |
| `spec.endpoints[].interval` | 抓取间隔，默认 `30s` |
| `spec.endpoints[].scrapeTimeout` | 抓取超时 |
| `spec.endpoints[].scheme` | `http` 或 `https` |
| `spec.endpoints[].params` | URL 参数 |
| `spec.endpoints[].tlsConfig` | TLS 配置 |
| `spec.endpoints[].bearerTokenSecret` | bearer token Secret |
| `spec.endpoints[].basicAuth` | Basic Auth |
| `spec.endpoints[].relabelings` | 抓取前 relabel |
| `spec.endpoints[].metricRelabelings` | 抓取后 relabel |
| `spec.endpoints[].honorLabels` | 是否保留目标暴露的标签 |
| `spec.endpoints[].jobName` | job 标签名 |
| `spec.endpoints[].proxyUrl` | 代理 URL |
| `spec.endpoints[].sampleLimit` | 单次抓取最大样本数 |
| `spec.targetLabels` | 把 Service/Endpoints 的标签复制到时序上 |

**完整示例**：监控一个暴露 `/metrics` 的应用

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: example-app
  namespace: default
  labels:
    team: frontend          # 被 Prometheus.serviceMonitorSelector 选中
spec:
  selector:
    matchLabels:
      app: example-app      # 选中 app=example-app 的 Service
  namespaceSelector:
    matchNames:
      - default
  endpoints:
    - port: web             # Service 中名为 web 的端口
      path: /metrics
      interval: 15s
      scrapeTimeout: 10s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
      metricRelabelings:
        - sourceLabels: [__name__]
          regex: 'go_.*'
          action: drop      # 丢弃所有 go_ 开头的指标
```

#### 3.3.2 PodMonitor

`PodMonitor` 直接通过 Pod 标签发现目标，不需要 Service。适合：

- 短生命周期 Pod（Service 还没创建 Pod 就没了）
- Pod 直连场景（不想为监控专门建 Service）
- Headless 服务 / StatefulSet 单 Pod 监控

**与 ServiceMonitor 的区别**：

| 维度 | ServiceMonitor | PodMonitor |
|---|---|---|
| 发现目标 | 通过 Service 的 Endpoints | 直接通过 Pod |
| 需要 Service | 是 | 否 |
| 端口配置 | `endpoints[].port`（Service port name） | `podMetricsEndpoints[].port`（Pod container port name） |
| 适用 | 常规服务 | 直连 Pod / 短生命周期 |

**示例**：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: example-app
  labels:
    team: frontend
spec:
  selector:
    matchLabels:
      app: example-app       # 直接选 Pod
  podMetricsEndpoints:
    - port: web              # Pod container 中名为 web 的端口
      interval: 15s
```

#### 3.3.3 Probe

`Probe` CRD 用于黑盒监控，配合 blackbox exporter 探测 Ingress 或静态目标的 HTTP/TCP/ICMP 可达性。

**关键字段**：

| 字段 | 说明 |
|---|---|
| `spec.prober.url` | blackbox exporter 地址 |
| `spec.module` | blackbox 模块名（如 `http_2xx`） |
| `spec.targets.ingress` | 从 Ingress 资源发现目标 |
| `spec.targets.staticConfig` | 静态目标 |

**示例**：黑盒监控一组 Ingress

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Probe
metadata:
  name: blackbox-ingress
  labels:
    team: sre
spec:
  module: http_2xx
  prober:
    url: blackbox-exporter.monitoring.svc:9115
  targets:
    ingress:
      selector:
        matchLabels:
          probe: enabled
```

#### 3.3.4 ScrapeConfig

`ScrapeConfig`（v0.65.1+）是低阶抓取配置 CRD，支持 Prometheus 原生 scrape_config 的大部分服务发现机制。当 ServiceMonitor/PodMonitor/Probe 表达不了的场景（比如抓集群外的目标、用 file_sd/http_sd）用它。

**支持的服务发现**：

- Tier-1（完全支持）：Kubernetes SD、File SD、Static、DNS SD、HTTP SD
- Tier-2（社区维护）：Azure/EC2/GCE/DigitalOcean 等云厂商 SD

**示例 1：staticConfigs 抓外部目标**

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: ScrapeConfig
metadata:
  name: static-config
  labels:
    prometheus: system-monitoring-prometheus
spec:
  staticConfigs:
    - labels:
        job: external-prometheus
      targets:
        - prometheus.demo.do.prometheus.io:9090
```

**示例 2：fileSDConfigs**

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: ScrapeConfig
metadata:
  name: file-sd
  labels:
    prometheus: system-monitoring-prometheus
spec:
  fileSDConfigs:
    - files:
        - /etc/prometheus/configmaps/scrape-file-sd-targets/targets.yaml
```

**示例 3：httpSDConfigs**

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: ScrapeConfig
metadata:
  name: http-sd
  labels:
    prometheus: system-monitoring-prometheus
spec:
  httpSDConfigs:
    - url: http://my-external-api/discovery
      refreshInterval: 15s
```

#### 3.3.5 PrometheusRule

`PrometheusRule` CRD 定义告警规则和 recording rules，被 Prometheus 或 ThanosRuler 通过 `ruleSelector` 选中后热加载。

**结构**：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: example-rules
  labels:
    role: alert-rules        # 被 Prometheus.ruleSelector 选中
spec:
  groups:
    - name: group-name
      interval: 30s          # 该组规则评估间隔
      rules:
        - alert: AlertName   # 告警规则
          expr: up == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "目标不可达"
            description: "{{ $labels.instance }} 已宕机超过 5 分钟"
        - record: metric:rate5m   # recording 规则
          expr: rate(http_requests_total[5m])
```

> 详见第 7 章。

#### 3.3.6 AlertmanagerConfig

`AlertmanagerConfig` CRD 让"告警路由/接收器/抑制规则"按命名空间/团队隔离，避免所有人改同一个 `alertmanager.yaml` 互相覆盖。

**关键字段**：

| 字段 | 说明 |
|---|---|
| `spec.route` | 路由配置（groupBy/groupWait/groupInterval/repeatInterval/receiver） |
| `spec.receivers` | 接收器（webhook/email/slack/pagerduty/opsgenie/...） |
| `spec.inhibitRules` | 抑制规则 |
| `spec.route.routes` | 子路由（按 matchers 分发到不同 receiver） |

**示例**：

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: config-example
  labels:
    alertmanagerConfig: example
spec:
  route:
    groupBy: ['job']
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 12h
    receiver: 'webhook'
  receivers:
    - name: 'webhook'
      webhookConfigs:
        - url: 'http://example.com/'
```

> 详见第 7 章。

### 3.4 CRD 关系总览

```
┌──────────────────────────────────────────────────────────────┐
│                    实例型资源                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────┐  ┌────────┐ │
│  │ Prometheus  │  │ Alertmanager│  │ThanosRuler│ │PromAgent│ │
│  └──────┬──────┘  └──────┬──────┘  └─────┬────┘  └────┬───┘ │
└─────────┼─────────────────┼───────────────┼────────────┼─────┘
          │                 │               │            │
   ┌──────┴──────┐   ┌──────┴──────┐  ┌─────┴────┐       │
   │serviceMonitor│  │alertmanager │  │rule      │       │
   │Selector     │   │ConfigSelector│ │Selector  │       │
   │podMonitor   │   │             │  │          │       │
   │Selector     │   │             │  │          │       │
   │probeSelector│   │             │  │          │       │
   │scrapeConfig │   │             │  │          │       │
   │Selector     │   │             │  │          │       │
   │ruleSelector │   │             │  │          │       │
   └──────┬──────┘   └──────┬──────┘  └────┬─────┘       │
          │                 │              │             │
          ▼                 ▼              ▼             │
┌─────────────────────────────────────────────────────────────┐
│                   配置型资源                                 │
│  ┌──────────────┐ ┌──────────┐ ┌──────┐ ┌──────────────┐  │
│  │ServiceMonitor│ │PodMonitor│ │Probe │ │ScrapeConfig  │  │
│  └──────────────┘ └──────────┘ └──────┘ └──────────────┘  │
│  ┌──────────────┐ ┌────────────────────┐                   │
│  │PrometheusRule│ │AlertmanagerConfig  │                   │
│  └──────────────┘ └────────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

**关键引用关系**：

- `Prometheus.serviceMonitorSelector` → 选中 `ServiceMonitor`
- `Prometheus.podMonitorSelector` → 选中 `PodMonitor`
- `Prometheus.probeSelector` → 选中 `Probe`
- `Prometheus.scrapeConfigSelector` → 选中 `ScrapeConfig`
- `Prometheus.ruleSelector` → 选中 `PrometheusRule`
- `Prometheus.alerting.alertmanagers` → 指向 `Alertmanager` 实例（通过 Service）
- `Alertmanager.alertmanagerConfigSelector` → 选中 `AlertmanagerConfig`
- `ThanosRuler.ruleSelector` → 选中 `PrometheusRule`（与 Prometheus 共用）

---

## 4. 部署

### 4.1 版本兼容性

部署前先确认版本兼容性（来自官方 Compatibility 文档）：

| 组件 | 最低版本 | 推荐版本（e2e 测试主测） | 备注 |
|---|---|---|---|
| Kubernetes | v1.25.0（Operator v0.84.0+，因使用 CEL） | 最新稳定版 | v0.84.0 之前只需 K8s v1.16.0 |
| Prometheus | v2.0.0 | v3.12.0 | 已支持 Prometheus v3.x |
| Alertmanager | v0.15.0 | v0.33.0 | |
| Thanos | v0.10.0 | v0.41.0 | |

> 重要：v0.84.0+ 的 Operator 因为在 CRD 中使用了 [CEL](https://kubernetes.io/docs/reference/using-api/cel/) 校验，要求 K8s ≥ v1.25.0（或 v1.23.0 + `CustomResourceValidationExpressions` feature gate）。

### 4.2 前置条件

- Kubernetes ≥ v1.25.0
- `kubectl` 有 cluster-admin 权限
- 集群有可用的 StorageClass（持久化场景）
- 如果用 Helm：Helm ≥ 3.x

### 4.3 方式一：原始 YAML manifest

最轻量，只装 Operator 本身 + CRD，不带任何预置 Prometheus/Alertmanager/Grafana。适合想完全自定义的场景。

**安装到 default 命名空间**：

```bash
LATEST=$(curl -s https://api.github.com/repos/prometheus-operator/prometheus-operator/releases/latest | jq -cr .tag_name)
curl -sL https://github.com/prometheus-operator/prometheus-operator/releases/download/${LATEST}/bundle.yaml | kubectl create -f -
```

**安装到指定命名空间**（需要 [Kustomize](https://kubectl.docs.kubernetes.io/installation/kustomize/)）：

```bash
NAMESPACE=monitoring
TMPDIR=$(mktemp -d)
LATEST=$(curl -s https://api.github.com/repos/prometheus-operator/prometheus-operator/releases/latest | jq -cr .tag_name)
curl -s "https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/refs/tags/$LATEST/kustomization.yaml" > "$TMPDIR/kustomization.yaml"
curl -s "https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/refs/tags/$LATEST/bundle.yaml" > "$TMPDIR/bundle.yaml"
(cd $TMPDIR && kustomize edit set namespace $NAMESPACE) && kubectl create -k "$TMPDIR"
```

**等待 Operator 就绪**：

```bash
kubectl wait --for=condition=Ready pods -l app.kubernetes.io/name=prometheus-operator
```

这种方式装完后，集群里**只有 Operator 本身**，没有任何 Prometheus/Alertmanager 实例。需要你自己创建 `Prometheus`、`Alertmanager` 等 CR——见第 5 章。

### 4.4 方式二：kube-prometheus

`kube-prometheus` 是一个基于 Jsonnet 的"开箱即用"栈，包含 Operator + Prometheus + Alertmanager + Grafana + node-exporter + kube-state-metrics + 一套预置告警规则和 Grafana 仪表盘。适合想要"一条命令拉起整套监控"的场景。

**安装**：

```bash
git clone https://github.com/prometheus-operator/kube-prometheus.git
cd kube-prometheus

# 先装 namespace + CRD
kubectl create -f manifests/setup

# 等 servicemonitors CRD 就绪
until kubectl get servicemonitors --all-namespaces ; do date; sleep 1; echo ""; done

# 装其他资源
kubectl create -f manifests/
```

> 也可以一次性 `kubectl create -f manifests/setup -f manifests`，但可能需要多次执行。

**访问 UI**：

```bash
# 访问 Prometheus
kubectl --namespace monitoring port-forward svc/prometheus-k8s 9090:9090

# 访问 Grafana（默认账号 admin/admin）
kubectl --namespace monitoring port-forward svc/grafana 3000:3000

# 访问 Alertmanager
kubectl --namespace monitoring port-forward svc/alertmanager-main 9093:9093
```

**卸载**：

```bash
kubectl delete --ignore-not-found=true -f manifests/ -f manifests/setup
```

### 4.5 方式三：Helm Chart（kube-prometheus-stack）

`kube-prometheus-stack`（prometheus-community 维护）是生产环境最常用的部署方式，本质是把 kube-prometheus 包装成 Helm chart，加了大量可配置项。

> 注意：该 chart 现在由 [prometheus-community/helm-charts](https://github.com/prometheus-community/helm-charts) 维护，不在 prometheus-operator 官方仓库内。

**安装**：

```bash
# 添加仓库
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# 创建命名空间
kubectl create namespace monitoring

# 安装
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --version <chart-version>   # 建议固定版本，查最新：helm search repo kube-prometheus-stack
```

**关键 values.yaml 配置**：

```yaml
# values.yaml
# === Prometheus ===
prometheus:
  prometheusSpec:
    replicas: 2
    retention: 15d
    retentionSize: 100Gi
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: ssd
          resources:
            requests:
              storage: 200Gi
    resources:
      requests:
        cpu: "2"
        memory: 4Gi
      limits:
        cpu: "4"
        memory: 8Gi
    serviceMonitorSelectorNilUsesHelmValues: false  # 允许选中所有命名空间的 ServiceMonitor
    podMonitorSelectorNilUsesHelmValues: false
    ruleSelectorNilUsesHelmValues: false

# === Alertmanager ===
alertmanager:
  enabled: true
  alertmanagerSpec:
    replicas: 3
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: ssd
          resources:
            requests:
              storage: 10Gi

# === Grafana ===
grafana:
  enabled: true
  adminPassword: "your-strong-password"
  persistence:
    enabled: true
    size: 10Gi
  ingress:
    enabled: true
    hosts: ["grafana.example.com"]

# === node-exporter ===
nodeExporter:
  enabled: true

# === kube-state-metrics ===
kubeStateMetrics:
  enabled: true

# === Ingress（暴露 Prometheus）===
prometheus:
  ingress:
    enabled: true
    hosts: ["prometheus.example.com"]
    paths: ["/"]
```

**用自定义 values 安装**：

```bash
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f values.yaml
```

### 4.6 部署验证

不管用哪种方式，部署后都该验证：

```bash
# 1. CRD 是否安装（应该看到 10 个左右）
kubectl get crd | grep monitoring.coreos.com

# 期望输出：
# alertmanagerconfigs.monitoring.coreos.com
# alertmanagers.monitoring.coreos.com
# podmonitors.monitoring.coreos.com
# probes.monitoring.coreos.com
# prometheusagents.monitoring.coreos.com
# prometheuses.monitoring.coreos.com
# prometheusrules.monitoring.coreos.com
# scrapeconfigs.monitoring.coreos.com
# servicemonitors.monitoring.coreos.com
# thanosrulers.monitoring.coreos.com

# 2. Operator Pod 是否运行
kubectl get pods -l app.kubernetes.io/name=prometheus-operator

# 3. Prometheus 实例（kube-prometheus-stack / kube-prometheus 装的话）
kubectl get prometheus -A

# 4. Alertmanager 实例
kubectl get alertmanager -A

# 5. Prometheus Pod
kubectl get pods -l app.kubernetes.io/name=prometheus

# 6. 检查 Prometheus 状态
kubectl get prometheus -o yaml | kubectl get -f - -o jsonpath='{.status}'
```

### 4.7 卸载

**Helm 方式**：

```bash
helm uninstall kube-prometheus-stack -n monitoring
# 注意：CRD 不会被 Helm 删除，需要手动清理
kubectl delete crd -l app.kubernetes.io/name=kube-prometheus-stack
```

**kube-prometheus 方式**：

```bash
kubectl delete --ignore-not-found=true -f manifests/ -f manifests/setup
```

> CRD 删除会级联删除所有对应 CR 实例，操作前确认数据已备份。

### 4.8 三种部署方式对比

| 维度 | 原始 YAML | kube-prometheus | kube-prometheus-stack (Helm) |
|---|---|---|---|
| 安装复杂度 | 低 | 中 | 低 |
| 包含组件 | 仅 Operator | Operator + 完整栈 + 预置规则/仪表盘 | Operator + 完整栈 + 预置规则/仪表盘 |
| 可定制性 | 最高（完全自定义） | 中（改 Jsonnet） | 高（改 values.yaml） |
| 适合场景 | 学习 / 已有自己的栈 | 不用 Helm 的环境 | 生产推荐 |
| 升级便利性 | 手动 | 重生成 manifest | `helm upgrade` |
| 社区活跃度 | - | 高 | 最高 |

**生产建议**：用 `kube-prometheus-stack` (Helm)，把 values.yaml 纳入 GitOps（ArgoCD/Flux）管理。

---

## 5. 基础使用

本章基于第 4.3 节的"原始 YAML"部署方式（只有 Operator，没有 Prometheus 实例）。如果你用的是 kube-prometheus-stack，已经有预置实例，可跳过本章。

### 5.1 RBAC 配置

Prometheus Pod 需要权限去 list/watch nodes、services、endpoints、pods 等资源（用于服务发现和抓取）。

```yaml
# ServiceAccount
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus
---
# ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus
rules:
  - apiGroups: [""]
    resources:
      - nodes
      - nodes/metrics
      - services
      - endpoints
      - pods
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources:
      - configmaps
    verbs: ["get"]
  - apiGroups: ["discovery.k8s.io"]
    resources:
      - endpointslices
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources:
      - ingresses
    verbs: ["get", "list", "watch"]
  - nonResourceURLs: ["/metrics"]
    verbs: ["get"]
---
# ClusterRoleBinding
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus
subjects:
  - kind: ServiceAccount
    name: prometheus
    namespace: default
```

### 5.2 部署 Prometheus 实例

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
  namespace: default
spec:
  serviceAccountName: prometheus
  replicas: 2
  serviceMonitorSelector:
    matchLabels:
      team: frontend
```

验证：

```bash
kubectl get -n default prometheus prometheus -w
kubectl get pods -l prometheus=prometheus
```

### 5.3 部署 Alertmanager

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Alertmanager
metadata:
  name: example
  namespace: default
spec:
  replicas: 3
```

```bash
kubectl get pods -l alertmanager=example -w
```

### 5.4 Prometheus 与 Alertmanager 集成

**暴露 Alertmanager Service**：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: alertmanager-example
  namespace: default
spec:
  type: NodePort
  ports:
    - name: web
      nodePort: 30903
      port: 9093
      protocol: TCP
      targetPort: web
  selector:
    alertmanager: example
```

**在 Prometheus 中引用**：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: example
  namespace: default
spec:
  serviceAccountName: prometheus
  replicas: 2
  alerting:
    alertmanagers:
      - namespace: default
        name: alertmanager-example
        port: web
```

打开 Prometheus Web UI → Status → Runtime & Build Information，应该看到已发现 3 个 Alertmanager 实例。

---

## 6. 自定义监控

### 6.1 ServiceMonitor 完整指南

#### 6.1.1 工作原理

```
1. ServiceMonitor.spec.selector        → 选中 Kubernetes Service
2. Service.spec.selector               → 选中 Pod
3. Service 后端 Endpoints              → 拿到 Pod IP 列表
4. ServiceMonitor.spec.endpoints[].port → 拿到端口
5. Operator 生成 scrape_config:
   job_name: serviceMonitor/<ns>/<name>/<endpoint>
   kubernetes_sd_configs: role: endpoints
   relabel: 按 ServiceMonitor 的 label 选择
```

#### 6.1.2 完整示例：监控一个应用

**部署示例应用**：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: example-app
  namespace: default
spec:
  replicas: 3
  selector:
    matchLabels:
      app: example-app
  template:
    metadata:
      labels:
        app: example-app
    spec:
      containers:
        - name: example-app
          image: quay.io/brancz/prometheus-example-app:v0.5.0
          ports:
            - name: web
              containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: example-app
  namespace: default
  labels:
    app: example-app
spec:
  selector:
    app: example-app
  ports:
    - name: web
      port: 8080
```

**ServiceMonitor**：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: example-app
  namespace: default
  labels:
    team: frontend
spec:
  selector:
    matchLabels:
      app: example-app
  endpoints:
    - port: web
      path: /metrics
      interval: 15s
```

**Prometheus 引用**（如果 `serviceMonitorSelector` 匹配 `team=frontend` 则自动选中）：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
  namespace: default
spec:
  serviceAccountName: prometheus
  serviceMonitorSelector:
    matchLabels:
      team: frontend
```

#### 6.1.3 多端口监控

如果一个 Service 暴露多个端口都要抓：

```yaml
spec:
  endpoints:
    - port: web
      interval: 15s
    - port: metrics
      interval: 30s
      path: /custom-metrics
```

#### 6.1.4 跨命名空间选择

`namespaceSelector` 控制从哪些命名空间选 Service：

```yaml
# 从指定命名空间选
spec:
  namespaceSelector:
    matchNames:
      - default
      - production

# 从所有命名空间选（受 Prometheus.serviceMonitorNamespaceSelector 限制）
spec:
  namespaceSelector:
    any: true
```

#### 6.1.5 高级字段示例

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: complex-app
  labels:
    team: backend
spec:
  selector:
    matchLabels:
      app: complex-app
  endpoints:
    - port: https-metrics
      scheme: https
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
      tlsConfig:
        caFile: /etc/prometheus/secrets/tls/ca.crt
        certFile: /etc/prometheus/secrets/tls/tls.crt
        keyFile: /etc/prometheus/secrets/tls/tls.key
        serverName: complex-app.default.svc
      bearerTokenSecret:
        name: bearer-token
        key: token
      relabelings:
        # 把 Pod 所在节点名加到时序标签
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
        # 把 Pod 命名空间加到时序标签
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
        # 只抓带 "metrics=enabled" 标签的 Pod
        - sourceLabels: [__meta_kubernetes_pod_label_metrics]
          action: keep
          regex: enabled
      metricRelabelings:
        # 丢弃高基数指标
        - sourceLabels: [__name__]
          regex: 'go_gc_duration_seconds.*'
          action: drop
        # 重命名指标
        - sourceLabels: [__name__]
          regex: 'http_requests_total'
          targetLabel: __name__
          replacement: 'http_requests_total_count'
      sampleLimit: 5000          # 单次抓取最多 5000 样本
      honorLabels: true
```

### 6.2 PodMonitor 使用场景

#### 6.2.1 与 ServiceMonitor 的区别

| 维度 | ServiceMonitor | PodMonitor |
|---|---|---|
| 目标发现路径 | ServiceMonitor → Service → Endpoints → Pod | PodMonitor → Pod |
| 需要 Service | ✅ | ❌ |
| 端口字段 | `endpoints[].port`（Service port name） | `podMetricsEndpoints[].port`（container port name） |
| 抓取地址 | `http://<service-vip>:<port>/metrics` 或 `http://<pod-ip>:<port>/metrics` | `http://<pod-ip>:<port>/metrics` |
| 适用场景 | 普通服务、负载均衡后端 | 直连 Pod、StatefulSet 单实例、短生命周期 Pod |

#### 6.2.2 完整示例

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: example-app
  namespace: default
  labels:
    team: frontend
spec:
  selector:
    matchLabels:
      app: example-app
  podMetricsEndpoints:
    - port: web
      interval: 15s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
```

```yaml
# Prometheus 引用
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  serviceAccountName: prometheus
  podMonitorSelector:
    matchLabels:
      team: frontend
```

#### 6.2.3 何时用 PodMonitor

- 监控 StatefulSet 的每个 Pod 实例（如 etcd、consul）
- 应用没有创建 Service（监控批处理任务 Pod）
- 想抓 Pod 上一个不通过 Service 暴露的端口
- Pod 太短命，来不及建 Service

### 6.3 Probe（黑盒监控）

`Probe` 配合 [blackbox exporter](https://github.com/prometheus/blackbox_exporter) 做黑盒探测——HTTP/TCP/ICMP/HTTPS 证书到期等。

#### 6.3.1 监控 Ingress 可达性

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Probe
metadata:
  name: blackbox-ingress
  namespace: monitoring
  labels:
    team: sre
spec:
  module: http_2xx
  prober:
    url: blackbox-exporter.monitoring.svc:9115
    path: /probe
  targets:
    ingress:
      selector:
        matchLabels:
          probe: enabled
      relabelingConfigs:
        - sourceLabels: [__address__]
          targetLabel: __param_target
          replacement: https://$1
```

被选中的 Ingress 资源打上 `probe: enabled` 标签即可被探测。

#### 6.3.2 静态目标探测

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Probe
metadata:
  name: blackbox-static
spec:
  module: http_2xx
  prober:
    url: blackbox-exporter.monitoring.svc:9115
  targets:
    staticConfig:
      labels:
        team: external
      static:
        - https://example.com
        - https://api.example.com/health
```

### 6.4 ScrapeConfig

`ScrapeConfig` 用于 ServiceMonitor/PodMonitor/Probe 表达不了的场景：抓集群外目标、用 file_sd/http_sd。

#### 6.4.1 让 Prometheus 选中 ScrapeConfig

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  scrapeConfigSelector:
    matchLabels:
      prometheus: system-monitoring-prometheus
  # 跨命名空间选
  scrapeConfigNamespaceSelector: {}
```

#### 6.4.2 staticConfigs 抓外部目标

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: ScrapeConfig
metadata:
  name: static-config
  labels:
    prometheus: system-monitoring-prometheus
spec:
  staticConfigs:
    - labels:
        job: external-prometheus
      targets:
        - prometheus.demo.do.prometheus.io:9090
```

#### 6.4.3 fileSDConfigs

需要先把 sd 文件通过 ConfigMap 挂进 Prometheus Pod：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: scrape-file-sd-targets
data:
  targets.yaml: |
    - labels:
        job: node-demo
      targets:
        - node.demo.do.prometheus.io:9100
    - labels:
        job: prometheus
      targets:
        - prometheus.demo.do.prometheus.io:9090
---
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  configMaps:
    - scrape-file-sd-targets   # 挂到 /etc/prometheus/configmaps/scrape-file-sd-targets/
  scrapeConfigSelector:
    matchLabels:
      prometheus: system-monitoring-prometheus
---
apiVersion: monitoring.coreos.com/v1alpha1
kind: ScrapeConfig
metadata:
  name: file-sd
  labels:
    prometheus: system-monitoring-prometheus
spec:
  fileSDConfigs:
    - files:
        - /etc/prometheus/configmaps/scrape-file-sd-targets/targets.yaml
```

#### 6.4.4 httpSDConfigs

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: ScrapeConfig
metadata:
  name: http-sd
  labels:
    prometheus: system-monitoring-prometheus
spec:
  httpSDConfigs:
    - url: http://my-external-api/discovery
      refreshInterval: 15s
```

### 6.5 让 Prometheus 识别监控配置

关键点：**Prometheus CR 中的 selector 决定选中哪些配置**。如果创建了 ServiceMonitor 但 Prometheus 没抓到，99% 是 selector 没匹配上。

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  serviceAccountName: prometheus
  # === 以下 selector 都是"且"关系 ===
  serviceMonitorSelector:
    matchLabels:
      team: frontend           # ServiceMonitor 必须有 team=frontend 标签
  serviceMonitorNamespaceSelector:
    matchLabels:
      environment: production  # 只从带 environment=production 的命名空间选
  podMonitorSelector: {}       # 空 = 选中所有 PodMonitor
  podMonitorNamespaceSelector: {}  # 空 = 从所有命名空间选
  probeSelector:
    matchLabels:
      team: sre
  scrapeConfigSelector:
    matchLabels:
      prometheus: system-monitoring-prometheus
  ruleSelector:
    matchLabels:
      role: alert-rules
  ruleNamespaceSelector: {}
```

**排查"为什么不抓"**：

```bash
# 1. 看 Prometheus 配置里有没有 target
kubectl -n monitoring exec prometheus-prometheus-0 -- \
  wget -qO- localhost:9090/api/v1/status/config | jq '.data.yaml' -r | grep -A5 scrape_configs

# 2. 看 Service / Pod 的 label 是否匹配
kubectl get svc -l app=example-app --all-namespaces
kubectl get pods -l app=example-app --all-namespaces

# 3. 看 ServiceMonitor 是否被选中
kubectl get servicemonitor -o yaml | grep -A5 metadata
kubectl get prometheus -o jsonpath='{.items[*].spec.serviceMonitorSelector}'
```

---

## 7. 自定义告警

### 7.1 PrometheusRule 告警规则

#### 7.1.1 结构

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: <name>
  labels:
    role: alert-rules        # 必须 match Prometheus.ruleSelector
spec:
  groups:
    - name: <group-name>     # 组名，同组规则一起评估
      interval: 30s          # 该组评估间隔（覆盖 Prometheus 全局 evaluation_interval）
      rules:
        # 告警规则
        - alert: <AlertName>
          expr: <PromQL>
          for: 5m             # 持续多久才触发
          labels:
            severity: critical
          annotations:
            summary: "..."
            description: "..."
        # Recording 规则（预计算）
        - record: <metric:name>
          expr: <PromQL>
```

#### 7.1.2 让 Prometheus 选中规则

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: example
spec:
  ruleSelector:
    matchLabels:
      role: alert-rules
      prometheus: example
  ruleNamespaceSelector:
    matchLabels:
      team: frontend
```

> 默认 `ruleSelector` 为 nil，不选中任何规则。需要显式配置。

#### 7.1.3 实战告警规则示例

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: sre-alerts
  namespace: monitoring
  labels:
    role: alert-rules
    prometheus: example
spec:
  groups:
    # === Pod 状态告警 ===
    - name: pod-alerts
      interval: 30s
      rules:
        - alert: PodCrashLooping
          expr: |
            increase(kube_pod_container_status_restarts_total[1h]) > 5
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} 频繁重启"
            description: "过去 1 小时重启 {{ $value }} 次"

        - alert: PodNotReady
          expr: |
            kube_pod_status_phase{phase!="Running"} == 1
          for: 15m
          labels:
            severity: critical
          annotations:
            summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} 非 Running 状态超过 15 分钟"

        - alert: ContainerOOMKilled
          expr: |
            increase(kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}[5m]) > 0
          labels:
            severity: warning
          annotations:
            summary: "容器 OOM：{{ $labels.namespace }}/{{ $labels.pod }}/{{ $labels.container }}"

    # === 节点资源告警 ===
    - name: node-alerts
      interval: 30s
      rules:
        - alert: NodeHighCpuUsage
          expr: |
            100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 80
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "节点 {{ $labels.instance }} CPU 使用率 > 80% 持续 10 分钟"

        - alert: NodeHighMemoryUsage
          expr: |
            (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100 > 85
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "节点 {{ $labels.instance }} 内存使用率 > 85%"

        - alert: NodeDiskSpaceLow
          expr: |
            (1 - (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} /
                  node_filesystem_size_bytes{fstype!~"tmpfs|overlay"})) * 100 > 85
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "节点 {{ $labels.instance }} 磁盘 {{ $labels.mountpoint }} 使用率 > 85%"

    # === HTTP 服务 SLO 告警 ===
    - name: http-slo-alerts
      interval: 30s
      rules:
        - alert: HighErrorRate
          expr: |
            sum(rate(http_requests_total{status=~"5.."}[5m])) by(service)
              / sum(rate(http_requests_total[5m])) by(service) > 0.05
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "服务 {{ $labels.service }} 5xx 错误率 > 5%"

        - alert: HighLatencyP99
          expr: |
            histogram_quantile(0.99, sum by(le, service)(
              rate(http_request_duration_seconds_bucket[5m])
            )) > 0.5
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "服务 {{ $labels.service }} P99 延迟 > 500ms"

    # === Prometheus 自监控 ===
    - name: prometheus-self-alerts
      interval: 30s
      rules:
        - alert: PrometheusDown
          expr: up{job="prometheus"} == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Prometheus 实例 {{ $labels.instance }} 宕机"

        - alert: PrometheusConfigReloadFailed
          expr: prometheus_config_last_reload_successful == 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Prometheus 配置 reload 失败"

        - alert: PrometheusTSDBReloads
          expr: increase(prometheus_tsdb_reloads_total[1h]) > 0
          labels:
            severity: warning
          annotations:
            summary: "Prometheus TSDB 在过去 1 小时发生 reload（异常重启）"
```

#### 7.1.4 Recording Rules（预计算）

把高频查询的 PromQL 预先计算成新指标，提升查询速度、降低 Prometheus 压力：

```yaml
- record: job:http_requests:rate5m
  expr: sum by(job)(rate(http_requests_total[5m]))

- record: job:http_requests:error_rate5m
  expr: |
    sum by(job)(rate(http_requests_total{status=~"5.."}[5m]))
      / sum by(job)(rate(http_requests_total[5m]))

- record: node:cpu:usage_pct
  expr: 100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
```

之后告警规则就可以直接用：

```yaml
- alert: HighCpuUsage
  expr: node:cpu:usage_pct > 80
```

#### 7.1.5 标签最佳实践

- `severity`：`critical` / `warning` / `info`（用于路由）
- `team`：负责团队（用于路由到对应接收器）
- `playbook`：runbook URL（让 oncall 知道怎么处理）
- `summary`：一句话概括（短信/Slack 标题）
- `description`：详细描述（用 `{{ $labels.xxx }}` 和 `{{ $value }}` 模板化）

### 7.2 AlertmanagerConfig

`AlertmanagerConfig` 让告警路由按命名空间/团队隔离，避免所有人改同一个 `alertmanager.yaml`。

#### 7.2.1 方式一：原生 Secret 配置

最简单：把原生 `alertmanager.yaml` 存到 Secret。Secret 名必须叫 `alertmanager-{AlertmanagerName}`，key 必须是 `alertmanager.yaml`。

```yaml
# alertmanager.yaml
route:
  group_by: ['job']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  receiver: 'webhook'
receivers:
  - name: 'webhook'
    webhook_configs:
      - url: 'http://example.com/'
```

```bash
kubectl create secret generic alertmanager-example \
  --from-file=alertmanager.yaml=alertmanager.yaml
```

> 自定义 Secret 名：在 Alertmanager CR 中用 `spec.configSecret` 指定。

#### 7.2.2 方式二：AlertmanagerConfig CRD

按命名空间/团队隔离的推荐方式。

**AlertmanagerConfig**：

```yaml
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: config-example
  labels:
    alertmanagerConfig: example
spec:
  route:
    groupBy: ['job']
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 12h
    receiver: 'webhook'
    routes:
      - matchers:
          - severity="critical"
        receiver: oncall-pagerduty
        continue: false
      - matchers:
          - severity="warning"
        receiver: slack-warning
  receivers:
    - name: webhook
      webhookConfigs:
        - url: 'http://example.com/'
    - name: oncall-pagerduty
      pagerDutyConfigs:
        - routingKey: "your-routing-key"
          severity: critical
    - name: slack-warning
      slackConfigs:
        - apiURL:
            name: slack-webhook
            key: url
          channel: '#alerts-warning'
          title: '{{ .CommonLabels.alertname }}'
          text: '{{ .CommonAnnotations.description }}'
  inhibitRules:
    - sourceMatch:
        - severity="critical"
      targetMatch:
        - severity="warning"
      equal: ['alertname', 'namespace']
```

**Alertmanager 引用**：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Alertmanager
metadata:
  name: example
spec:
  replicas: 3
  alertmanagerConfigSelector:
    matchLabels:
      alertmanagerConfig: example
```

#### 7.2.3 方式三：全局 AlertmanagerConfig

用 `spec.alertmanagerConfiguration` 指定一个 AlertmanagerConfig 作为主配置（替代 `alertmanager-example` Secret）：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Alertmanager
metadata:
  name: example
spec:
  replicas: 3
  alertmanagerConfiguration:
    name: config-example   # 同命名空间的 AlertmanagerConfig
```

这种方式下，被引用的 AlertmanagerConfig 作为全局配置，路由和抑制规则**不会强制要求 namespace 标签**。

#### 7.2.4 接收器配置示例

**邮件**：

```yaml
receivers:
  - name: email
    emailConfigs:
      - to: 'oncall@example.com'
        from: 'alertmanager@example.com'
        smarthost: 'smtp.example.com:587'
        authUsername: 'alertmanager@example.com'
        authPassword:
          name: smtp-secret
          key: password
        requireTLS: true
```

**企业微信 / 钉钉（通过 webhook）**：

```yaml
receivers:
  - name: wechat
    webhookConfigs:
      - url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx'
        sendResolved: true
  - name: dingtalk
    webhookConfigs:
      - url: 'https://oapi.dingtalk.com/robot/send?access_token=xxx'
        sendResolved: true
```

#### 7.2.5 路由与抑制

**路由**：树状结构，按 `matchers` 分发到不同 receiver：

```yaml
spec:
  route:
    receiver: default
    groupBy: ['alertname', 'namespace']
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 4h
    routes:
      - matchers: ['severity="critical"']
        receiver: pagerduty
        groupWait: 0s          # critical 立即发
        repeatInterval: 1h
      - matchers: ['team="database"']
        receiver: dba-slack
      - matchers: ['namespace=~"staging-.*"']
        receiver: dev-slack
        continue: true          # 继续匹配后续路由
```

**抑制规则**：当某告警触发时，抑制其他相关告警：

```yaml
spec:
  inhibitRules:
    - sourceMatch:              # 当 source 触发时
        - severity="critical"
      targetMatch:              # 抑制 target
        - severity="warning"
      equal: ['alertname', 'namespace']   # 当这些标签相等时
```

典型场景：节点宕机（critical）时抑制该节点上所有 Pod 告警（warning）。

### 7.3 告警静默（Silences）

静默通过 Alertmanager API/UI 管理，不在 CRD 中。访问 Alertmanager Web UI → Silences → 创建静默，指定 matcher（如 `alertname=NodeHighCpuUsage`）和持续时间。

CLI 方式（需要 [amtool](https://prometheus.io/docs/alerting/latest/amtool/)）：

```bash
# 创建静默
amtool silence add \
  --comment "维护窗口" \
  --duration 2h \
  alertname=NodeHighCpuUsage \
  --alertmanager.url http://alertmanager:9093

# 查看静默
amtool silence query --alertmanager.url http://alertmanager:9093

# 删除静默
amtool silence expire <silence-id> --alertmanager.url http://alertmanager:9093
```

---

## 8. 高级进阶

### 8.1 高可用部署

#### 8.1.1 Prometheus 多副本

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  replicas: 2                 # 多副本各自独立抓取
  externalLabels:
    cluster: prod             # 多副本必须有区分的 external label
  # 反亲和，避免同节点
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            prometheus: prometheus
        topologyKey: kubernetes.io/hostname
```

**注意**：Prometheus 多副本**不是集群**，每个副本独立抓取、独立存储、独立评估告警。两个副本会向 Alertmanager 发送相同告警，由 Alertmanager 去重。查询结果可能略有差异（抓取时间不同）。

#### 8.1.2 Alertmanager HA 集群

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Alertmanager
metadata:
  name: alertmanager
spec:
  replicas: 3                  # >=2 即组成 HA 集群
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            alertmanager: alertmanager
        topologyKey: kubernetes.io/hostname
```

Operator 自动配置 cluster mode（gossip 协议），多副本间复制 silences 和 notification state。Prometheus 把告警发给所有 Alertmanager 副本，Alertmanager 自己去重。

#### 8.1.3 反亲和性配置示例

```yaml
spec:
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                prometheus: prometheus
            topologyKey: topology.kubernetes.io/zone   # 跨可用区
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              prometheus: prometheus
            topologyKey: kubernetes.io/hostname        # 同可用区内不同节点
```

### 8.2 分片（Sharding）

当单个 Prometheus 抓不过来时，用 sharding 把目标分布到多个 Prometheus 实例。

#### 8.2.1 设计

- `spec.shards` 控制分片数，`spec.replicas` 控制每片副本数
- Operator 创建 `shards × replicas` 个 Pod
- 默认按目标地址 hash 分布：ServiceMonitor/PodMonitor 用 `__address__`，Probe 用 `__param_target__`
- 缩容不重新分布已有数据，扩容也不重新分布（**这是当前限制**）

#### 8.2.2 基础分片

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  replicas: 2          # 每片 2 副本（HA）
  shards: 3            # 3 个分片
  serviceMonitorSelector:
    matchLabels:
      team: frontend
```

这会创建 6 个 Pod：`prometheus-prometheus-0/1`（shard 0）、`prometheus-prometheus-shard-1-0/1`、`prometheus-prometheus-shard-2-0/1`。

#### 8.2.3 自定义分片策略

默认按 `__address__` hash，可以用 relabel 改成按其他标签分片：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: example-app
spec:
  endpoints:
    - port: web
      relabelings:
        # 按 namespace/pod 分片，而不是按 address
        - sourceLabels: [__meta_kubernetes_pod_namespace, __meta_kubernetes_pod_name]
          separator: /
          targetLabel: __tmp_hash
```

#### 8.2.4 全分片抓取（不分片）

某些 singleton 服务（如 kube-state-metrics）需要所有 shard 都抓，用 `__tmp_disable_sharding`：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kube-state-metrics
spec:
  endpoints:
    - port: http
      relabelings:
        - targetLabel: __tmp_disable_sharding
          replacement: "true"
```

#### 8.2.5 拓扑感知分片（Beta）

多可用区集群中，默认按 address hash 会导致大量跨区流量。拓扑感知分片让每个 shard 只抓本区目标。

> 需要 Operator 开启 `PrometheusTopologySharding` feature gate。

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  shards: 4
  replicas: 2
  shardingStrategy:
    mode: Topology
    topology:
      values:
        - europe-west4-a
        - europe-west4-b
```

Operator 自动：
- 生成 relabel 规则，让每个 shard 只保留本区目标
- 加 `nodeSelector` 把 shard Pod 调度到对应区
- 加 `zone` external label

`shards` 数量需 ≥ 区数；是区数整数倍时均匀分布。

#### 8.2.6 保留分片（Beta）

缩容时默认删除多余 shard 的 Pod 和数据。用 `shardRetentionPolicy` 保留它们一段时间，让历史数据继续可查（通过 Thanos sidecar）。

> 需要 Operator 开启 `PrometheusShardRetentionPolicy` feature gate。

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  shards: 2
  shardRetentionPolicy:
    whenScaled: Retain
    retain:
      retentionPeriod: 7d   # 默认按 Prometheus retention
```

### 8.3 长期存储

Prometheus 本地存储不适合长期保留（默认 15 天）。生产环境通常配远程存储或 Thanos。

#### 8.3.1 Remote Write / Read

直接把样本写到远程存储（VictoriaMetrics/Mimir/Cortex/Thanos Receive）：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  remoteWrite:
    - url: http://victoria-metrics.monitoring.svc:8428/api/v1/write
      queueConfig:
        capacity: 10000
        maxSamplesPerSend: 3000
        maxShards: 200
      remoteTimeout: 30s
      writeRelabelConfigs:
        # 只发关键指标，省带宽
        - sourceLabels: [__name__]
          regex: 'up|kube_.*|node_.*'
          action: keep
  remoteRead:
    - url: http://victoria-metrics.monitoring.svc:8428/api/v1/read
      readRecent: true
```

#### 8.3.2 Thanos 集成

Thanos 提供"Prometheus + 对象存储 = 全局视图 + 长期存储"方案。Prometheus Operator 支持把 Thanos sidecar 注入 Prometheus Pod。

**步骤 1：准备对象存储配置**

```yaml
# thanos-config.yaml
type: s3
config:
  bucket: thanos
  endpoint: ams3.digitaloceanspaces.com
  access_key: XXX
  secret_key: XXX
```

```bash
kubectl -n monitoring create secret generic thanos-objstore-config \
  --from-file=thanos.yaml=thanos-config.yaml
```

**步骤 2：Prometheus CR 启用 Thanos sidecar**

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  thanos:
    image: quay.io/thanos/thanos:v0.41.0
    objectStorageConfig:
      key: thanos.yaml
      name: thanos-objstore-config
```

Sidecar 会把 Prometheus 每 2 小时产生的 block 上传到对象存储。**启用对象存储会禁用 Prometheus 本地 compaction**——由 Thanos Compactor 单独负责。

**步骤 3：部署 Thanos Querier（独立于 Prometheus Operator）**

Thanos Querier/Store/Compactor/Receiver 不由 Prometheus Operator 管理，用 [kube-thanos](https://github.com/thanos-io/kube-thanos/) 项目部署。

#### 8.3.3 ThanosRuler

跨多个 Prometheus/Querier 做分布式规则评估，适合分片后做全局告警：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ThanosRuler
metadata:
  name: thanos-ruler
  namespace: monitoring
spec:
  image: quay.io/thanos/thanos:v0.41.0
  replicas: 2
  ruleSelector:
    matchLabels:
      role: my-thanos-rules
  queryEndpoints:
    - dnssrv+_http._tcp.my-thanos-querier.monitoring.svc.cluster.local
  alertmanagersConfig:
    key: alertmanager-configs.yaml
    name: thanosruler-alertmanager-config
```

```yaml
# Alertmanager 配置 Secret
apiVersion: v1
kind: Secret
metadata:
  name: thanosruler-alertmanager-config
stringData:
  alertmanager-configs.yaml: |-
    alertmanagers:
      - static_configs:
          - "dnssrv+_web._tcp.alertmanager-operated.monitoring.svc.cluster.local"
        api_version: v2
```

### 8.4 持久化存储

默认 Prometheus/Alertmanager 用 `emptyDir`，Pod 重建数据丢失。生产环境必须配持久化。

#### 8.4.1 PVC 配置

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: persisted
spec:
  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: ssd
        resources:
          requests:
            storage: 200Gi
```

Operator 为 StatefulSet 每个 Pod 创建一个 PVC。

#### 8.4.2 手动 provisioning（NFS 等不支持动态 provisioning）

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: my-example
spec:
  storage:
    volumeClaimTemplate:
      spec:
        selector:
          matchLabels:
            app.kubernetes.io/name: my-example-prometheus
        resources:
          requests:
            storage: 50Gi
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: my-pv
  labels:
    app.kubernetes.io/name: my-example-prometheus
spec:
  capacity:
    storage: 50Gi
  accessModes:
    - ReadWriteOnce   # 必须 ReadWriteOnce
  nfs:
    server: myServer
    path: "/path/to/prom/db"
```

#### 8.4.3 hostPath

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: example
spec:
  storage:
    volumeClaimTemplate:
      spec:
        selector:
          matchLabels:
            app.kubernetes.io/name: example
        resources:
          requests:
            storage: 50Gi
  securityContext:
    fsGroup: 65534
    runAsNonRoot: true
    runAsUser: 65534
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: my-pv
  labels:
    app.kubernetes.io/name: example
spec:
  capacity:
    storage: 50Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  hostPath:
    path: /mnt/data
```

#### 8.4.4 卷扩容

StatefulSet 不直接支持卷扩容，需要手动操作：

```bash
# 1. 暂停 Operator reconcile
kubectl patch prometheus/example --patch '{"spec": {"paused": true}}' --type merge

# 2. 更新 storage request
kubectl patch prometheus/example --patch '{"spec": {"storage": {"volumeClaimTemplate": {"spec": {"resources": {"requests": {"storage":"200Gi"}}}}}}}' --type merge

# 3. 扩容每个 PVC
for p in $(kubectl get pvc -l operator.prometheus.io/name=example -o jsonpath='{range .items[*]}{.metadata.name} {end}'); do \
  kubectl patch pvc/${p} --patch '{"spec": {"resources": {"requests": {"storage":"200Gi"}}}}'; \
done

# 4. 用 orphan 策略删除 StatefulSet（Pod 不删）
kubectl delete statefulset -l operator.prometheus.io/name=example --cascade=orphan

# 5. 恢复 reconcile
kubectl patch prometheus/example --patch '{"spec": {"paused": false}}' --type merge
```

### 8.5 Prometheus Agent

适合"边缘采集 + 中心存储"架构，Agent 只采集 + remote write，不做本地存储/规则评估。

#### 8.5.1 适用场景

- 多集群监控：每个集群跑 Agent，数据 remote write 到中心 Mimir/Thanos/VictoriaMetrics
- 不需要本地查询/告警的场景
- 资源受限环境（Agent 比 Prometheus 省资源）

#### 8.5.2 部署

```yaml
# ServiceAccount
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus-agent
---
# ClusterRole（与 Prometheus 同，但不需要 rules API）
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus-agent
rules:
  - apiGroups: [""]
    resources: [services, endpoints, pods]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: [configmaps]
    verbs: ["get"]
  - apiGroups: ["networking.k8s.io"]
    resources: [ingresses]
    verbs: ["get", "list", "watch"]
  - nonResourceURLs: ["/metrics"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus-agent
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus-agent
subjects:
  - kind: ServiceAccount
    name: prometheus-agent
    namespace: default
---
# PrometheusAgent 实例
apiVersion: monitoring.coreos.com/v1alpha1
kind: PrometheusAgent
metadata:
  name: prometheus-agent
spec:
  replicas: 2
  serviceAccountName: prometheus-agent
  serviceMonitorSelector:
    matchLabels:
      team: frontend
  remoteWrite:
    - url: http://mimir.mimir.svc:8080/api/v1/push
```

### 8.6 安全性

#### 8.6.1 TLS 抓取

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: tls-app
spec:
  endpoints:
    - port: https
      scheme: https
      tlsConfig:
        caFile: /etc/prometheus/secrets/tls/ca.crt
        certFile: /etc/prometheus/secrets/tls/tls.crt
        keyFile: /etc/prometheus/secrets/tls/tls.key
        serverName: app.default.svc
        insecureSkipVerify: false   # 生产环境必须 false
```

#### 8.6.2 Bearer Token / Basic Auth

```yaml
endpoints:
  - port: metrics
    bearerTokenSecret:
      name: bearer-token
      key: token
    # 或
    basicAuth:
      username:
        name: basic-auth
        key: username
      password:
        name: basic-auth
        key: password
```

#### 8.6.3 Prometheus Web 启用 TLS + Basic Auth

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  web:
    tlsConfig:
      cert:
        name: prometheus-tls
        key: tls.crt
      keySecret:
        name: prometheus-tls
        key: tls.key
    httpConfig:
      basicAuthUsers:
        username: '$2y$10$...'   # bcrypt hash
```

#### 8.6.4 RBAC 最小权限

只给 Prometheus 实际需要的权限，不给 cluster-admin：

```yaml
rules:
  - apiGroups: [""]
    resources: [nodes, nodes/metrics, services, endpoints, pods]
    verbs: [get, list, watch]
  - apiGroups: [""]
    resources: [configmaps]
    verbs: [get]
  - apiGroups: ["discovery.k8s.io"]
    resources: [endpointslices]
    verbs: [get, list, watch]
  - apiGroups: ["networking.k8s.io"]
    resources: [ingresses]
    verbs: [get, list, watch]
  - nonResourceURLs: ["/metrics"]
    verbs: [get]
```

不要给 `verbs: ["*"]` 或 `resources: ["*"]`。

### 8.7 多租户 / 多实例

一个集群可以跑多个 Prometheus 实例，用 selector 隔离：

```yaml
# 实例 A：SRE 用
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: sre-prometheus
  namespace: monitoring
spec:
  serviceMonitorSelector:
    matchLabels:
      team: sre
  ruleSelector:
    matchLabels:
      team: sre
---
# 实例 B：DBA 用
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: dba-prometheus
  namespace: monitoring
spec:
  serviceMonitorSelector:
    matchLabels:
      team: dba
  ruleSelector:
    matchLabels:
      team: dba
```

各团队的 ServiceMonitor/PrometheusRule 打上自己的 `team` 标签，互不干扰。

### 8.8 升级与迁移

#### 8.8.1 Operator 升级

```bash
# 1. 备份当前 CRD 和 CR
kubectl get prometheus,alertmanager,thanosruler,prometheusagent -A -o yaml > backup.yaml

# 2. 升级 Operator（Helm 方式）
helm repo update
helm upgrade kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring -f values.yaml

# 3. 升级 CRD（Helm 不会自动升级 CRD）
kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/<new-version>/bundle.yaml

# 4. 检查所有 Pod 状态
kubectl get pods -n monitoring -w
```

#### 8.8.2 Prometheus 版本升级（v2 → v3）

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  image: quay.io/prometheus/prometheus:v3.12.0   # 改这里
```

> Prometheus v3 有不兼容变更（如某些 PromQL 行为、flag 名），升级前务必看 [Prometheus v3 release notes](https://prometheus.io/blog/2024/11/14/prometheus-3-0/)。建议先在测试环境验证。

#### 8.8.3 从原生 Prometheus 迁移

1. 部署 Prometheus Operator
2. 创建 `Prometheus` CR（先不接流量）
3. 把原 `prometheus.yml` 的 scrape_configs 翻译成 ServiceMonitor/PodMonitor/ScrapeConfig
4. 把 alerting rules 翻译成 PrometheusRule
5. 把 alertmanager.yaml 翻译成 AlertmanagerConfig 或 Secret
6. 验证新实例抓取目标一致、告警规则一致
7. 切换流量（Grafana 数据源、告警接收端）到新实例
8. 下线原 Prometheus

### 8.9 自监控

监控 Prometheus 自身是必须的——监控挂了你都不知道。

#### 8.9.1 关键自监控指标

| 指标 | 含义 |
|---|---|
| `up` | Prometheus 自身可达性 |
| `prometheus_config_last_reload_successful` | 配置 reload 是否成功 |
| `prometheus_tsdb_reloads_total` | TSDB 重启次数（异常） |
| `prometheus_tsdb_head_series` | 内存中时序数 |
| `prometheus_tsdb_head_samples_appended_total` | 写入速率 |
| `prometheus_scrape_duration_seconds` | 抓取耗时分布 |
| `prometheus_scrape_samples_post_metric_relabeling` | 单次抓取样本数 |
| `prometheus_rule_evaluation_duration_seconds` | 规则评估耗时 |
| `prometheus_remote_storage_dropped_samples_total` | remote write 丢弃样本数 |
| `process_resident_memory_bytes` | Prometheus 内存占用 |

#### 8.9.2 自监控告警规则

```yaml
- alert: PrometheusDown
  expr: up{job="prometheus"} == 0
  for: 1m
  labels:
    severity: critical
- alert: PrometheusConfigReloadFailed
  expr: prometheus_config_last_reload_successful == 0
  for: 5m
  labels:
    severity: warning
- alert: PrometheusTSDBReloads
  expr: increase(prometheus_tsdb_reloads_total[1h]) > 0
  labels:
    severity: warning
- alert: PrometheusTooManySeries
  expr: prometheus_tsdb_head_series > 1000000
  for: 10m
  labels:
    severity: warning
- alert: PrometheusRemoteWriteDroppingSamples
  expr: rate(prometheus_remote_storage_dropped_samples_total[5m]) > 0
  for: 5m
  labels:
    severity: critical
```

#### 8.9.3 监控 Operator 自身

```yaml
# Operator 暴露 metrics 在 8080 端口
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: prometheus-operator
  labels:
    team: sre
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: prometheus-operator
  endpoints:
    - port: http
      path: /metrics
```

### 8.10 性能调优

#### 8.10.1 scrape_interval 调优

| 场景 | 推荐 interval |
|---|---|
| 核心业务指标 | 15s |
| 系统指标（node/exporter） | 30s |
| 业务低频指标 | 1m |
| 黑盒探测 | 30s-1m |

不要无脑全用 15s——会显著增加 Prometheus 负载和存储。

#### 8.10.2 样本限制

防止单个抓取目标拖垮 Prometheus：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: protected
spec:
  endpoints:
    - port: web
      sampleLimit: 5000          # 单次抓取最多 5000 样本
      labelLimit: 60             # 单时序最多 60 个标签
      labelNameLengthLimit: 200  # 标签名最长 200 字符
      labelValueLengthLimit: 200 # 标签值最长 200 字符
```

Prometheus 全局限制：

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  # 全局单次抓取上限
  scrapeSamplesPerTargetLimit: 10000
```

#### 8.10.3 持久化存储调优

```yaml
spec:
  retention: 15d                 # 时间保留
  retentionSize: 100Gi           # 大小保留（达到任一即清理）
  # TSDB 配置
  tsdb:
    outOfOrderTimeWindow: 30m    # 允许乱序样本时间窗口
  # WAL 压缩
  walCompression: true
  # 不抓取旧数据
  enableFeatures:
    - memory-snapshot-on-shutdown
```

#### 8.10.4 资源请求/限制推荐

| 规模 | CPU req | CPU lim | Mem req | Mem lim | Storage |
|---|---|---|---|---|---|
| 小（<500 target） | 500m | 2 | 2Gi | 8Gi | 50Gi |
| 中（500-2000 target） | 2 | 4 | 4Gi | 16Gi | 200Gi |
| 大（>2000 target） | 4 | 8 | 8Gi | 32Gi | 500Gi |

> 生产环境**必须**设置 `requests`，否则可能被调度到资源紧张节点导致 OOM。

### 8.11 与 Grafana 集成

`kube-prometheus-stack` 默认带 Grafana 并预置数据源和仪表盘。如果单独部署 Grafana：

1. 添加 Prometheus Service 为数据源：
   - URL: `http://prometheus-operated.monitoring.svc:9090`
   - 访问模式：Server

2. 推荐预置仪表盘：
   - [kube-prometheus-stack 官方仪表盘](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack/templates/grafana/dashboards)
   - [Awesome Grafana Dashboards](https://grafana.com/grafana/dashboards/)

3. Grafana 也用 CRD 管理：[Grafana Operator](https://github.com/grafana-operator/grafana-operator)

---

## 9. 最佳实践与避坑

### 9.1 命名空间规划

```
monitoring          # Operator + Prometheus + Alertmanager + Grafana
monitoring-rules    # PrometheusRule（按团队标签区分）
app-namespace       # 应用的 ServiceMonitor 跟应用放一起
```

或：所有监控资源集中在 `monitoring`，按 label 区分团队。

### 9.2 标签约定

固定一组标签用于 selector：

| 标签 | 值示例 | 用途 |
|---|---|---|
| `team` | sre/dba/frontend | 服务归属 |
| `environment` | production/staging | 环境隔离 |
| `prometheus` | main/aux | 多实例选择 |
| `role` | alert-rules/recording-rules | PrometheusRule 类型 |

### 9.3 常见坑

1. **selector 不匹配**：ServiceMonitor 创建了但 Prometheus 不抓——99% 是 `serviceMonitorSelector` 没匹配。用 `kubectl get prometheus -o yaml` 看 selector，对比 ServiceMonitor 的 label。

2. **ruleSelector 默认 nil**：默认不选中任何 PrometheusRule，需要显式配置 `ruleSelector: {}` 或指定 label。

3. **Prometheus 多副本 ≠ 集群**：多副本各自独立抓取，查询结果可能不一致。要全局视图用 Thanos Querier。

4. **Alertmanager 配置变更不生效**：检查是 Secret 方式还是 CRD 方式，CRD 方式需要 `alertmanagerConfigSelector` 匹配。

5. **Thanos sidecar 启用后本地 compaction 被禁**：必须部署 Thanos Compactor，否则对象存储里的 block 不会被压缩。

6. **CRD 升级失败**：v0.84.0+ 用了 CEL，老 K8s（<1.25）装不上新 CRD。先升 K8s 再升 Operator。

7. **`ruleSelector` 改了规则没生效**：Prometheus 配置 reload 失败看 `prometheus_config_last_reload_successful` 指标和 Operator 日志。

8. **remote write 把 Prometheus 拖垮**：加 `writeRelabelConfigs` 过滤，调 `queueConfig` 限速。

9. **告警风暴**：配 `group_by` 把相关告警合并，配 `inhibit_rules` 抑制次级告警，调 `repeat_interval` 避免重复打扰。

10. **持久化卷满**：同时设 `retention` 和 `retentionSize`，达到任一就清理。监控 `prometheus_tsdb_storage_blocks_bytes` 提前预警。

### 9.4 GitOps 管理

把所有 CRD YAML 纳入 Git，用 ArgoCD/Flux 同步：

```
monitoring/
├── operator/
│   └── values.yaml           # kube-prometheus-stack Helm values
├── prometheus/
│   ├── prometheus.yaml
│   └── alertmanager.yaml
├── servicemonitors/
│   ├── app-a.yaml
│   └── app-b.yaml
├── rules/
│   ├── pod-alerts.yaml
│   ├── node-alerts.yaml
│   └── http-slo-alerts.yaml
└── alertmanager-configs/
    ├── sre.yaml
    └── dba.yaml
```

---

## 10. 参考资料

### 10.1 官方文档

- [Prometheus Operator 官方文档](https://prometheus-operator.dev/)
- [Getting Started](https://prometheus-operator.dev/docs/getting-started/introduction/)
- [Design](https://prometheus-operator.dev/docs/getting-started/design/)
- [Compatibility](https://prometheus-operator.dev/docs/getting-started/compatibility/)
- [Installation](https://prometheus-operator.dev/docs/getting-started/installation/)
- [API Reference](https://prometheus-operator.dev/docs/api-reference/api/)
- [Platform Guide](https://prometheus-operator.dev/docs/platform/platform-guide/)
- [High Availability](https://prometheus-operator.dev/docs/platform/high-availability/)
- [Sharding](https://prometheus-operator.dev/docs/platform/sharding/)
- [Thanos](https://prometheus-operator.dev/docs/platform/thanos/)
- [Storage](https://prometheus-operator.dev/docs/platform/storage/)
- [Prometheus Agent](https://prometheus-operator.dev/docs/platform/prometheus-agent/)
- [Alerting Routes](https://prometheus-operator.dev/docs/developer/alerting/)
- [ScrapeConfig CRD](https://prometheus-operator.dev/docs/developer/scrapeconfig/)

### 10.2 相关项目

- [prometheus-operator GitHub](https://github.com/prometheus-operator/prometheus-operator)
- [kube-prometheus](https://github.com/prometheus-operator/kube-prometheus)（Jsonnet 栈）
- [kube-prometheus-stack Helm Chart](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack)
- [kube-thanos](https://github.com/thanos-io/kube-thanos)（Thanos K8s 部署）
- [blackbox exporter](https://github.com/prometheus/blackbox_exporter)

### 10.3 相关技术

- [Prometheus 官方文档](https://prometheus.io/docs/)
- [Thanos](https://thanos.io/)
- [Grafana Loki](https://grafana.com/oss/loki/)
- [Prometheus 深入浅出](./prometheus-深入浅出.md)（本项目姊妹篇）
- [Prometheus vs VictoriaMetrics 压测](./prometheus-vs-victoriametrics-benchmark.md)

### 10.4 版本信息

| 组件 | 撰写时版本 |
|---|---|
| Prometheus Operator | v0.88.1 |
| Prometheus | v3.12.0（e2e 主测） |
| Alertmanager | v0.33.0 |
| Thanos | v0.41.0 |
| Kubernetes 最低要求 | v1.25.0 |
