# Kubernetes Gateway API 与 Ingress 对比及主流实现

## 一、背景：Ingress 的历史与局限

Kubernetes Ingress 自 v1.1 起成为暴露 HTTP 服务的标准方式。它定义了从集群外部到集群内 Service 的 HTTP/HTTPS 路由规则，真正干活的是 Ingress Controller——一个持续监听 Ingress 资源并配置反向代理（Nginx、Envoy、HAProxy 等）的控制器。

Ingress 在"单服务、单域名、简单路径路由"的时代足够好用，但随着 Kubernetes 在生产环境的复杂度上升，它的结构性缺陷暴露无遗：

| 局限 | 表现 |
|------|------|
| 协议覆盖窄 | 只支持 HTTP/HTTPS，TCP/UDP/gRPC/TLS 透传都需 controller 私有扩展 |
| 注解地狱 | Header 路由、流量分割、权重灰度、超时、重写全部塞进 annotations |
| 不可移植 | 每家 controller 的注解互不兼容，迁移等于重写 |
| 无角色分离 | 基础设施管理员和应用开发者编辑同一个 Ingress 对象，RBAC 颗粒度粗 |
| 无跨命名空间引用 | 后端 Service 必须与 Ingress 同命名空间（或靠私有 hack） |
| 状态反馈弱 | 只有简单的 `ingress.status.loadBalancer`，路由级状态缺失 |

> **关键时间节点**：社区版 `ingress-nginx` 已于 2026 年 3 月停止维护，不再接收安全更新。Ingress API 本身虽未废弃，但已**冻结**——所有新特性只进 Gateway API。新项目继续用 Ingress 就是在积累迁移债。

---

## 二、Gateway API 核心架构

Gateway API 由 SIG-Network 维护，是一组 CRD（Custom Resource Definitions），用类型化的 spec 字段替代注解，用角色分离的资源模型替代"一个资源干所有事"。它不是"Ingress v2"，而是对 Kubernetes 南北流量管理的一次重新设计。

### 2.1 三种角色与资源归属

Gateway API 的核心设计是**按角色拆分资源**，每种资源对应一个职责边界：

| 资源 | 作用域 | 所属角色 | 职责 |
|------|--------|----------|------|
| **GatewayClass** | Cluster | 基础设施提供商 | 声明使用哪个控制器实现（类似 StorageClass） |
| **Gateway** | Namespace | 平台工程师 / 集群运维 | 配置监听器（端口、TLS、允许挂载的 Route） |
| **HTTPRoute / TCPRoute / TLSRoute / UDPRoute / GRPCRoute** | Namespace | 应用开发者 | 定义路由规则、后端、流量策略 |
| **ReferenceGrant** | Namespace | 被引用方管理员 | 显式授权其他命名空间的 Route 引用本命名空间的后端 |

### 2.2 架构总览

```
                    ┌─────────────────────────────────────────────┐
                    │            Infrastructure Provider           │
                    │                                             │
                    │   ┌─────────────────┐                       │
                    │   │  GatewayClass    │  ← 指定控制器实现       │
                    │   │  (istio / cilium)│     (spec.controller)  │
                    │   └────────┬────────┘                       │
                    └────────────┼────────────────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────────────────────────┐
                    │          Platform Engineer / Cluster Ops     │
                    │                                             │
                    │   ┌─────────────────┐                       │
                    │   │     Gateway      │  ← 监听器 + TLS        │
                    │   │  listeners:      │     allowedRoutes     │
                    │   │   - port:443     │     限定可挂载的       │
                    │   │     protocol:HTTPS│     Route 命名空间    │
                    │   └────────┬────────┘                       │
                    └────────────┼────────────────────────────────┘
                                 │  attach
                    ┌────────────┼─────────────┬───────────────┐
                    ▼            ▼             ▼               ▼
              ┌──────────┐ ┌──────────┐  ┌──────────┐   ┌──────────┐
              │HTTPRoute │ │HTTPRoute │  │GRPCRoute │   │TCPRoute  │
              │(team A)  │ │(team B)  │  │(team C)  │   │(team D)  │
              └─────┬────┘ └─────┬────┘  └─────┬────┘   └─────┬────┘
                    │            │             │              │
                    ▼            ▼             ▼              ▼
              ┌──────────┐ ┌──────────┐  ┌──────────┐   ┌──────────┐
              │ Service  │ │ Service  │  │ Service  │   │ Service  │
              │ (app A)  │ │ (app B)  │  │ (app C)  │   │ (app D)  │
              └──────────┘ └──────────┘  └──────────┘   └──────────┘
                    Application Developer (各自管理自己的 Route)
```

**挂载关系**：Route 资源通过 `parentRefs` 引用 Gateway，Gateway 的 `listeners.allowedRoutes` 控制哪些命名空间、哪些类型的 Route 可以挂载。这种双向约束既保证应用开发者自服务，又让平台团队对入口边界有完全控制。

### 2.3 资源详解

#### GatewayClass

类似 StorageClass，集群级资源，指定由哪个控制器实现处理本类的 Gateway：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: istio
spec:
  controllerName: istio.io/gateway-controller
  description: "Istio Gateway API implementation"
```

#### Gateway

声明具体的入口实例，定义监听器、TLS、允许挂载的 Route：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-edge
  namespace: gateway-system
spec:
  gatewayClassName: istio
  listeners:
  - name: https
    protocol: HTTPS
    port: 443
    hostname: "*.example.com"
    tls:
      mode: Terminate
      certificateRefs:
      - name: wildcard-tls
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            shared-gateway-access: "true"
```

`allowedRoutes` 是关键：平台团队通过它精确控制哪些命名空间可以挂载到这个 Gateway，形成 RBAC 之外的多租户隔离层。

#### HTTPRoute

应用开发者定义路由规则，原生支持 header 匹配、流量分割、权重灰度、请求镜像：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-canary
  namespace: team-a
  labels:
    shared-gateway-access: "true"
spec:
  parentRefs:
  - name: prod-edge
    namespace: gateway-system
  hostnames:
  - api.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /v2
    backendRefs:
    - name: api-v2
      port: 8080
      weight: 10
    - name: api-v1
      port: 8080
      weight: 90
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: x-canary
          value: "true"
  - matches:
    - headers:
      - name: x-feature
        value: "beta"
    backendRefs:
    - name: api-v2
      port: 8080
```

对比 Ingress 做同样的事：流量分割要用 `nginx.ingress.kubernetes.io/canary-weight: "10"` 注解，header 路由要用 `canary-by-header` 注解，跨 controller 完全不可移植。

#### ReferenceGrant

显式授权跨命名空间引用，被引用方主动声明"允许谁引用我"：

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-team-a
  namespace: backend-system
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    namespace: team-a
  to:
  - group: ""
    kind: Service
```

### 2.4 GAMMA：东西向流量的统一 API

GAMMA（Gateway API for Mesh Management and Administration）是 Gateway API 的一个工作流，目标是把 Gateway API 扩展到**服务网格东西向流量**，而不只是南北向 ingress。

传统上 Istio 用 VirtualService/DestinationRule 管网格内流量，Gateway API 管边缘流量——两套 API 心智负担重。GAMMA 让 HTTPRoute 既能挂到 Gateway（南北向），也能挂到 `parentRefs: Service`（东西向），实现"一套 API 管两向流量"。

Istio 是 GAMMA 的主要推动者和最早实现者。

### 2.5 版本与通道

| 通道 | 稳定性 | 资源 |
|------|--------|------|
| **Standard** | GA，向后兼容 | GatewayClass、Gateway、HTTPRoute、GRPCRoute、TLSRoute、ReferenceGrant |
| **Experimental** | 实验性，可能破坏性变更 | TCPRoute、UDPRoute、部分 Filter |

Gateway API 核心资源于 K8s 1.26（HTTPRoute）/1.27（Gateway/GatewayClass）达到 GA。

---

## 三、Ingress vs Gateway API 全面对比

### 3.1 能力矩阵

| 维度 | Ingress | Gateway API |
|------|---------|-------------|
| **协议** | HTTP/HTTPS | HTTP/HTTPS/TCP/UDP/TLS/gRPC |
| **路由维度** | host + path | host + path + header + query param + method |
| **流量分割** | 注解（不可移植） | 原生 `backendRefs.weight` |
| **请求镜像** | 无标准 | 原生 `RequestMirror` filter |
| **Header 修改** | 注解 | 原生 `RequestHeaderModifier` filter |
| **TLS 透传** | 注解 | `TLSRoute` + `mode: Passthrough` |
| **超时/重试** | 注解 | Spec 级字段（Standard channel） |
| **角色分离** | 无（单一资源） | GatewayClass/Gateway/*Route 三层 |
| **跨命名空间** | 不支持 | `ReferenceGrant` 显式授权 |
| **多租户** | 弱（RBAC 颗粒度粗） | 强（`allowedRoutes` 命名空间选择器） |
| **可移植性** | 低（注解差异大） | 高（行为在 spec 字段） |
| **状态反馈** | 基础 LB IP | 路由级 Conditions（Accepted/ResolvedRefs/Programmed） |
| **API 状态** | 冻结（不再加新特性） | 活跃开发，核心已 GA |

### 3.2 同一需求两种写法

**需求**：`api.example.com/v2` 走新版本 10% 流量，`x-feature: beta` 的请求全部走新版本。

**Ingress 写法**（nginx-specific，不可移植）：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-stable
  annotations:
    nginx.ingress.kubernetes.io/canary-by-header: "x-feature"
    nginx.ingress.kubernetes.io/canary-by-header-value: "beta"
spec:
  ingressClassName: nginx
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /v2
        pathType: Prefix
        backend:
          service:
            name: api-v1
            port:
              number: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-canary
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
    nginx.ingress.kubernetes.io/canary-by-header: "x-feature"
    nginx.ingress.kubernetes.io/canary-by-header-value: "beta"
spec:
  ingressClassName: nginx
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /v2
        pathType: Prefix
        backend:
          service:
            name: api-v2
            port:
              number: 8080
```

**Gateway API 写法**（标准 spec，任何实现通用）：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-canary
spec:
  parentRefs:
  - name: prod-edge
  hostnames:
  - api.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /v2
    backendRefs:
    - name: api-v2
      port: 8080
      weight: 10
    - name: api-v1
      port: 8080
      weight: 90
  - matches:
    - path:
        type: PathPrefix
        value: /v2
      headers:
      - name: x-feature
        value: beta
    backendRefs:
    - name: api-v2
      port: 8080
```

差距一目了然：Ingress 需要两个对象 + 6 个注解 + 强绑定 nginx，Gateway API 一个对象 + 类型化字段 + 跨实现通用。

---

## 四、主流实现与数据面差异

### 4.1 实现矩阵

| 实现 | 数据面 | 项目状态 | Gateway API 成熟度 | 特色 |
|------|--------|----------|-------------------|------|
| **Istio** | Envoy（sidecar / ztunnel+waypoint） | CNCF 毕业项目 | GA，覆盖最全 | 功能最全，GAMMA 主导者，支持 sidecar + ambient 双模式 |
| **Envoy Gateway** | Envoy | CNCF（Envoy 子项目） | GA | 参考实现，纯边缘网关，无 mesh 包袱 |
| **Cilium** | eBPF（L3/L4）+ Envoy（L7） | CNCF 毕业项目 | GA，Core conformance 全通过 | eBPF 内核数据面，性能极致，CNI + mesh + observability 一体 |
| **Contour** | Envoy | CNCF 毕业项目 | GA | 老牌 Envoy ingress，与 Envoy Gateway 定位重叠 |
| **NGINX Gateway Fabric** | NGINX | 官方维护 | GA | 替代已 EOL 的 ingress-nginx，官方 NGINX 数据面 |
| **Kong Gateway** | OpenResty / LuaJIT | 商业 + 开源 | GA | API 网关基因，插件生态丰富 |
| **Traefik** | 自研（Go） | 开源 | GA | 自动服务发现，配置简单 |
| **HAProxy Ingress** | HAProxy | 开源 | 部分支持 | 老牌负载均衡器 |

### 4.2 Istio：功能最全的双模 mesh + gateway

Istio 是 Gateway API 的最早实现者，也是 GAMMA 的主导者。它的独特之处是同时支持两种数据面模式：

```
模式一：Sidecar（传统模式）
┌─────────────────────────────────────────┐
│  Pod                                     │
│  ┌──────────┐    ┌──────────────────┐   │
│  │  App     │◄──►│  Envoy Sidecar   │   │
│  │Container │    │  (L4 + L7)       │   │
│  └──────────┘    └──────────────────┘   │
└─────────────────────────────────────────┘
   每个 Pod 注入一个 Envoy，资源开销大但隔离强

模式二：Ambient（无 sidecar 模式，GA）
┌──────────────────────────────────────────────┐
│  Node                                         │
│  ┌──────────┐         ┌──────────────────┐   │
│  │  App Pod │◄──iptables┤  ztunnel        │   │
│  │          │   重定向   │  (Rust, L4 mTLS) │   │
│  └──────────┘         └────────┬─────────┘   │
│                                │ HBONE 隧道   │
│                                ▼             │
│                    ┌──────────────────────┐  │
│                    │  Waypoint Proxy       │  │
│                    │  (Envoy, L7, 可选)    │  │
│                    └──────────────────────┘  │
└──────────────────────────────────────────────┘
   L4 全节点共享 ztunnel，L7 按需挂 waypoint，资源开销降 60-70%
```

**关键点**：
- **ztunnel**：Rust 编写的 per-node DaemonSet，只做 L4 mTLS 和 L4 授权，用 HBONE（HTTP/2 CONNECT over mTLS）隧道
- **waypoint**：按 namespace / service 部署的 Envoy，只在需要 L7（HTTP 路由、JWT、header 级授权）时挂载
- **选择性增强**：基础层零信任，L7 能力按需开启，避免全量 sidecar 的资源浪费
- **Gateway API 支持**：north-south 用 Gateway + HTTPRoute，east-west 用 GAMMA（HTTPRoute 挂到 Service）

**适用场景**：需要全功能 mesh（流量管理 + 安全 + 可观测性）、多集群、复杂 L7 策略的大型集群。

### 4.3 Cilium：eBPF 内核数据面的极致性能

Cilium 的根本不同在于数据面位置——**在 Linux 内核**而非用户态：

```
传统用户态代理（Envoy / NGINX sidecar）
┌──────────────────────────────────────────┐
│  Kernel                                   │
│  ┌─────────┐    ┌──────────────────┐     │
│  │ NIC     │───►│  TCP/IP Stack     │     │
│  └─────────┘    └────────┬──────────┘     │
│                          │ context switch │
│  ┌───────────────────────▼──────────────┐ │
│  │  User Space                          │ │
│  │  ┌──────────────────────────────┐    │ │
│  │  │  Envoy / NGINX Proxy         │    │ │
│  │  │  (L4 + L7 全在用户态)         │    │ │
│  │  └──────────────────────────────┘    │ │
│  └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
   每个数据包至少 2 次内核↔用户态上下文切换

Cilium eBPF 数据面（L3/L4）
┌──────────────────────────────────────────┐
│  Kernel                                   │
│  ┌─────────┐    ┌──────────────────┐     │
│  │ NIC     │───►│  eBPF Programs   │     │
│  │         │    │  (L3/L4 路由/NAT/ │     │
│  │         │    │   策略/mTLS)      │     │
│  │         │    └────────┬─────────┘     │
│  │         │             │               │
│  │         │     ┌───────▼────────┐      │
│  │         │     │ 直接转发到目标   │      │
│  │         │     │ Pod (不经用户态) │      │
│  │         │     └────────────────┘      │
│  └─────────┘                              │
│                                           │
│  ┌──────────────────────────────────────┐ │
│  │  User Space（仅 L7 需要）             │ │
│  │  ┌──────────────────────────────┐    │ │
│  │  │  Envoy (per-node, L7 only)   │    │ │
│  │  └──────────────────────────────┘    │ │
│  └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
   L3/L4 全在内核，零上下文切换；L7 才走 per-node Envoy
```

**关键点**：
- **eBPF 程序**挂载在内核网络路径（XDP、tc、socket），L3/L4 路由、NAT、网络策略、mTLS 在内核完成
- **替代 kube-proxy**：用 eBPF 实现 Service 负载均衡，比 iptables/ipvs 更高效
- **L7 仍用 Envoy**：per-node 共享一个 Envoy 实例，通过 CiliumEnvoyConfig 配置，处理 HTTP/gRPC/Kafka
- **Hubble**：基于 eBPF 的实时可观测性，无需 sidecar 即可看到全链路流量
- **Tetragon**：内核级运行时安全策略执行

**与 Istio Ambient 的对比**：

| 维度 | Cilium | Istio Ambient |
|------|--------|---------------|
| L4 位置 | 内核 eBPF | 用户态 ztunnel（Rust） |
| L7 位置 | per-node Envoy | per-namespace waypoint Envoy |
| mTLS | 原生 TLS / WireGuard | HBONE 隧道 |
| 上下文切换 | 0（L4） | 2 次（L4） |
| 身份模型 | 网络身份为主 | SPIFFE 工作负载身份 |
| CNI 依赖 | 是（就是 CNI） | 否（任何 CNI 可用） |
| 控制面 | per-node cilium-agent | 集中式 istiod |

**适用场景**：对延迟和资源开销极致敏感、内核版本够新（≥5.10，理想 6.1+）、希望 CNI + mesh + 可观测性一体化的平台。

### 4.4 Envoy Gateway：纯边缘网关的参考实现

Envoy Gateway 是 Envoy 项目的子项目，定位是**纯南北向边缘网关**，不带 mesh 包袱：

```
┌──────────────────────────────────────────────────┐
│  Control Plane                                    │
│  ┌────────────────────┐                           │
│  │  EnvoyGateway       │  ← Watch Gateway API CRDs │
│  │  Controller         │     翻译为 Envoy xDS      │
│  └──────────┬─────────┘                           │
│             │ xDS (gRPC)                          │
│             ▼                                     │
│  ┌────────────────────┐                           │
│  │  Envoy Proxy Fleet  │  ← 数据面 Deployment      │
│  │  (多副本, 水平伸缩)   │     通过 Service 暴露     │
│  └────────────────────┘                           │
└──────────────────────────────────────────────────┘
```

**关键点**：
- **无 mesh**：不碰东西向流量，专注 ingress / egress 网关
- **参考实现**：Gateway API 规范的标杆，Core conformance 覆盖最广
- **云厂商友好**：设计上对接云 LB（ALB/NLB），Envoy 副本作为后端
- **SecurityPolicy / BackendTrafficPolicy**：通过 policy attachment 扩展，不污染核心 CRD

**适用场景**：只需要边缘网关、不需要 mesh、希望用最标准的 Gateway API 实现的团队。也是从 ingress-nginx 迁移的首选目标之一。

### 4.5 Contour：被 Envoy Gateway 部分取代的老牌项目

Contour 是 Heptio（后被 VMware 收购）开源的 Envoy ingress 控制器，CNCF 毕业项目。架构与 Envoy Gateway 类似（Contour 控制面 + Envoy 数据面），但历史更久、功能更成熟。

随着 Envoy Gateway 的出现，Contour 的定位变得尴尬——两者数据面都是 Envoy，控制面功能高度重叠。新项目建议选 Envoy Gateway，存量 Contour 用户可继续使用但建议评估迁移。

### 4.6 NGINX Gateway Fabric：ingress-nginx 的官方继任者

NGINX Gateway Fabric 是 NGINX 官方维护的 Gateway API 实现，用来替代 2026 年 3 月已 EOL 的 `ingress-nginx`：

```
┌──────────────────────────────────────────────────┐
│  ┌────────────────────┐                           │
│  │  NGINX Gateway      │  ← Watch Gateway API CRDs │
│  │  Fabric Controller  │     生成 nginx.conf       │
│  └──────────┬─────────┘                           │
│             │ nginx -s reload                     │
│             ▼                                     │
│  ┌────────────────────┐                           │
│  │  NGINX (数据面)     │  ← OSS 或 Plus             │
│  └────────────────────┘                           │
└──────────────────────────────────────────────────┘
```

**关键点**：
- **数据面是 NGINX**（非 Envoy），对熟悉 nginx 配置的团队友好
- **支持 NGINX Plus**：商业版提供额外功能（主动健康检查、JWT 验证、API dashboard）
- **从 ingress-nginx 平滑迁移**：官方提供 ingress-to-gateway 转换工具

**适用场景**：存量 ingress-nginx 用户迁移、团队熟悉 NGINX 配置、需要 NGINX Plus 商业特性。

### 4.7 Kong Gateway：API 网关基因

Kong 的数据面是 OpenResty（NGINX + LuaJIT），天生是 API 网关而非简单 ingress：

**关键点**：
- **插件生态**：认证（JWT/OAuth/KeyAuth）、限流、熔断、日志、Serverless 函数等数百插件
- **数据面 OpenResty**：NGINX 基础 + Lua 扩展，性能接近原生 NGINX，灵活性远超
- **Policy Attachment**：通过 KongPlugin / KongConsumer 等 CRD 扩展 Gateway API，不污染核心资源

**适用场景**：需要 API 网关能力（认证、限流、插件）而不仅仅是路由转发的场景。

### 4.8 数据面技术对比

| 数据面 | 代表实现 | 优势 | 劣势 |
|--------|----------|------|------|
| **Envoy** | Istio, Envoy Gateway, Contour | L7 功能最全，xDS 动态配置，可观测性强 | 用户态，每个 Pod 一个 sidecar 时资源开销大 |
| **eBPF** | Cilium | 内核执行，零上下文切换，延迟最低 | 依赖新内核（5.10+），L7 能力弱（仍需 Envoy） |
| **NGINX** | NGINX Gateway Fabric | 老牌稳定，配置模型成熟，性能优秀 | 动态配置弱（reload 模型），扩展性不如 Envoy |
| **OpenResty/LuaJIT** | Kong | 插件生态丰富，API 网关能力强 | Lua 生态小众，性能不如原生 NGINX |

---

## 五、选型指南

### 5.1 决策矩阵

| 你的场景 | 推荐实现 | 理由 |
|----------|----------|------|
| 新项目，需要全功能 mesh + gateway | **Istio (Ambient)** | 功能最全，GAMMA 一套 API 管两向，ambient 模式资源开销低 |
| 新项目，只要边缘网关，不要 mesh | **Envoy Gateway** | 参考实现，Core conformance 最全，无 mesh 包袱 |
| 对延迟 / 资源开销极致敏感 | **Cilium** | eBPF 内核数据面，L4 零上下文切换 |
| 存量 ingress-nginx 用户迁移 | **NGINX Gateway Fabric** | 官方继任者，配置模型熟悉，迁移工具完善 |
| 需要 API 网关能力（认证/限流/插件） | **Kong** | API 网关基因，插件生态丰富 |
| 已有 Cilium CNI，想扩展到 mesh | **Cilium Service Mesh** | 复用 CNI 基础设施，一体化运维 |
| 多集群 / 混合云 | **Istio** | 多集群支持最成熟 |

### 5.2 从 Ingress 迁移建议

1. **不要为了迁移而迁移**：Ingress API 不会消失，只在碰到具体瓶颈时迁
2. **共存优先**：Gateway API 和 Ingress 可在同一集群共存，新服务用 Gateway API，老服务保持 Ingress
3. **从非关键服务开始**：先迁移一个非核心服务，验证 controller 行为和可观测性
4. **用 ingress-to-gateway 工具**：官方转换工具能处理 80-90% 的规则
5. **DNS 切换式割接**：新旧并行运行，共享 LB IP，最后 DNS 切换实现零停机

### 5.3 避坑清单

- **WebSocket / gRPC 早期测试**：这是 Ingress 迁移最常见的坑点，不同实现行为差异大
- **Ambient 模式的 AuthorizationPolicy 陷阱**：无 waypoint 时 L7 策略静默不生效
- **Cilium 内核版本**：eBPF 特性强依赖内核版本，生产前确认 ≥5.10，理想 6.1+
- **ReferenceGrant 容易遗漏**：跨命名空间引用必须双向声明，报错信息不一定直观
- **TCPRoute / UDPRoute 仍在 Experimental**：生产使用需评估风险

---

## 六、总结

Gateway API 不是 Ingress 的小修小补，而是 Kubernetes 南北流量管理的重新设计。它的三个核心改进——**角色分离的资源模型**、**类型化的 spec 字段**、**多协议原生支持**——共同解决了 Ingress 的结构性缺陷。

主流实现的差异本质在**数据面技术路线**：
- **Envoy 阵营**（Istio / Envoy Gateway / Contour）：L7 功能最全，用户态执行
- **eBPF 阵营**（Cilium）：L4 内核执行，性能极致，L7 仍需 Envoy
- **NGINX 阵营**（NGINX Gateway Fabric）：配置模型成熟，存量迁移友好
- **API 网关阵营**（Kong）：插件生态丰富，适合需要认证/限流的场景

2026 年是转折点——ingress-nginx 已 EOL，Ingress API 已冻结，新特性只进 Gateway API。新项目应直接选 Gateway API，存量项目在碰到多租户、gRPC、流量分割、跨命名空间等具体瓶颈时启动迁移。
