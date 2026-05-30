# Ingress 三种部署模式与底层原理

## 什么是 Ingress

Kubernetes Ingress 是集群内 HTTP/HTTPS 路由规则的集合，它定义了从集群外部到内部 Service 的访问路径。Ingress 本身只是一组 API 资源（规则定义），真正干活的是 Ingress Controller——一个持续监听 Ingress 资源变化并据此配置反向代理（如 Nginx、HAProxy、Traefik）的控制器。

## Ingress 资源结构

一个 Ingress 资源由以下核心字段组成：

- **rules**：路由规则列表，每条规则包含 host（域名）和 paths（URL 路径映射到后端 Service）
- **backend**：默认后端，当请求不匹配任何规则时转发到此 Service
- **tls**：TLS 证书配置，指定域名和对应 Secret
- **ingressClassName**：指定由哪个 IngressClass（即哪个 Controller）处理

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: demo-ingress
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - app.example.com
    secretName: app-tls-secret
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 8080
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web-service
            port:
              number: 80
```

### pathType 三种匹配方式

| pathType | 行为 | 示例 path=/api | /api 匹配 | /api/ 匹配 | /apis 匹配 |
|---|---|---|---|---|---|
| Prefix | 按前缀匹配，斜杠分隔 | /api | ✅ | ✅ | ❌ |
| Exact | 精确匹配，完全一致 | /api | ✅ | ❌ | ❌ |
| ImplementationSpecific | 由 Controller 自行解释 | 取决于实现 | - | - | - |

### IngressClass 与多 Controller

IngressClass 是 Kubernetes 1.18+ 引入的资源，用于解决多 Ingress Controller 共存时的路由归属问题：

```yaml
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: nginx-internal
  annotations:
    ingressclass.kubernetes.io/is-default-class: "true"
spec:
  controller: k8s.io/ingress-nginx
  parameters:
    apiGroup: k8s.example.net
    kind: IngressParameters
    name: external-lb
```

- 标注 `is-default-class` 的 IngressClass 会自动成为未指定 `ingressClassName` 的 Ingress 的默认处理器
- `spec.controller` 字段标识此 IngressClass 对应哪个 Controller 实现
- `spec.parameters` 可传递额外配置给 Controller（如负载均衡器参数）

## Ingress Controller 三种部署模式

Ingress Controller 本质上也是一个 Pod 里的反向代理进程。它以何种方式暴露到集群外部，决定了部署模式。

### Deployment + Service（NodePort / LoadBalancer）

最常见、最通用的部署方式。Ingress Controller 以 Deployment 形式运行，通过 Service 暴露端口。

```
                    ┌─────────────────┐
                    │  Cloud LB /     │
                    │  External LB    │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Service        │
                    │  type: LB/NP    │
                    └────────┬────────┘
                             │
                ┌────────────▼────────────┐
                │  Ingress Controller Pod  │
                │  (Deployment 副本)        │
                └─────────────────────────┘
```

**关键 YAML**：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ingress-nginx-controller
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: controller
        image: registry.k8s.io/ingress-nginx/controller:v1.8.1
        ports:
        - containerPort: 80
          name: http
        - containerPort: 443
          name: https
---
apiVersion: v1
kind: Service
metadata:
  name: ingress-nginx-controller
spec:
  type: LoadBalancer   # 或 NodePort
  ports:
  - port: 80
    targetPort: 80
    name: http
  - port: 443
    targetPort: 443
    name: https
  selector:
    app: ingress-nginx
```

**优点**：
- 弹性伸缩：可根据流量水平扩缩副本数
- 滚动更新：Deployment 天然支持零中断升级
- 灵活调度：Pod 可调度到任意可用节点，不占端口
- 云环境友好：LoadBalancer 类型直接对接云厂商 LB

**缺点**：
- 多了一层 NAT：外部流量经过 Service 的 iptables/ipvs 转发，增加一跳
- 源 IP 丢失：NodePort 模式下默认丢失客户端真实 IP（需配置 `externalTrafficPolicy: Local`）
- 额外延迟：请求链路多一跳 DNAT

### DaemonSet + HostNetwork

每个节点上运行一个 Ingress Controller Pod，直接绑定宿主机网络命名空间，监听宿主机的 80/443 端口。

```
┌─────────────────────────────────────────────┐
│                  Node 1                      │
│  ┌────────────────────────────────────┐     │
│  │  Ingress Controller Pod            │     │
│  │  hostNetwork: true                 │     │
│  │  监听 0.0.0.0:80 / 0.0.0.0:443    │     │
│  └────────────────────────────────────┘     │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│                  Node 2                      │
│  ┌────────────────────────────────────┐     │
│  │  Ingress Controller Pod            │     │
│  │  hostNetwork: true                 │     │
│  │  监听 0.0.0.0:80 / 0.0.0.0:443    │     │
│  └────────────────────────────────────┘     │
└─────────────────────────────────────────────┘
```

**关键 YAML**：

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ingress-nginx-controller
spec:
  selector:
    matchLabels:
      app: ingress-nginx
  template:
    spec:
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      containers:
      - name: controller
        image: registry.k8s.io/ingress-nginx/controller:v1.8.1
        ports:
        - containerPort: 80
          hostPort: 80
        - containerPort: 443
          hostPort: 443
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      nodeSelector:
        node-role: ingress
```

**优点**：
- 零额外 NAT：请求直达 Pod，不经 Service 转发
- 保留源 IP：客户端真实 IP 直接到达 Nginx，无需额外配置
- 性能最优：少一跳转发，延迟最低
- 节点级高可用：每个节点都是入口，天然多副本

**缺点**：
- 端口冲突：宿主机 80/443 端口被占用，其他进程不可使用
- 资源浪费：每个节点都跑一个副本，低流量节点也消耗资源
- 扩缩不灵活：副本数等于节点数，无法按流量弹性伸缩
- 端口管理：添加新端口需重启所有 Pod

### DaemonSet + NodePort

折中方案，用 DaemonSet 保证每个节点运行副本，但通过 NodePort Service 暴露，避免直接占用宿主机端口。

```
┌──────────────────────────────────┐
│            Node 1                │
│  ┌────────────────────────┐     │
│  │  Ingress Controller    │     │
│  │  containerPort: 80     │     │
│  └────────────────────────┘     │
│        ↑ NodePort 30080         │
└──────────────────────────────────┘
┌──────────────────────────────────┐
│            Node 2                │
│  ┌────────────────────────┐     │
│  │  Ingress Controller    │     │
│  │  containerPort: 80     │     │
│  └────────────────────────┘     │
│        ↑ NodePort 30080         │
└──────────────────────────────────┘
```

**优点**：
- 节点级覆盖：每个节点都有入口点
- 端口灵活：不占用宿主机知名端口
- 安全性稍好：通过 iptables 转发，有网络策略隔离

**缺点**：
- NodePort 端口范围受限（默认 30000-32767）
- 多一跳转发：经过 iptables DNAT
- 源 IP 默认丢失：同 Deployment + NodePort 的问题

### 三种模式对比

| 维度 | Deployment + LB/NP | DaemonSet + HostNetwork | DaemonSet + NodePort |
|---|---|---|---|
| 性能 | ★★★☆（多一跳 NAT） | ★★★★★（直达） | ★★★☆（多一跳 NAT） |
| 源 IP 保留 | 需额外配置 | ✅ 天然保留 | 需额外配置 |
| 弹性伸缩 | ✅ HPA 支持 | ❌ 跟随节点数 | ❌ 跟随节点数 |
| 端口冲突 | 无风险 | ⚠️ 80/443 被占 | 无风险 |
| 资源效率 | ✅ 按需分配 | ❌ 每节点必跑 | ❌ 每节点必跑 |
| 云环境适配 | ✅ 原生 LB | ❌ 需自建 LB | ⚠️ 需外部 LB |
| 适用场景 | 云上生产、流量波动大 | 裸金属、性能敏感 | 裸金属、端口受限 |

## Nginx Ingress Controller 底层原理

### 控制循环

Nginx Ingress Controller 的核心是一个 Kubernetes Controller 的经典控制循环：

```
┌──────────────────────────────────────────────────────────────┐
│                    Nginx Ingress Controller                   │
│                                                              │
│  ┌────────────┐    watch     ┌─────────────────────────┐    │
│  │  Informer  │ ◄────────── │  API Server              │    │
│  │  (List-Watch)│ ──────────► │  Ingress / SVC / Endpoints│    │
│  └──────┬─────┘   event     └─────────────────────────┘    │
│         │                                                    │
│         ▼                                                    │
│  ┌──────────────┐                                           │
│  │  OnUpdate    │                                           │
│  │  事件处理函数  │                                           │
│  └──────┬───────┘                                           │
│         │                                                    │
│         ▼                                                    │
│  ┌──────────────────────────────────────┐                   │
│  │  1. 收集所有 Ingress 规则             │                   │
│  │  2. 收集对应 Service 的 Endpoints     │                   │
│  │  3. 生成 nginx.conf 模板              │                   │
│  │  4. 写入 /etc/nginx/nginx.conf       │                   │
│  │  5. 执行 nginx -s reload             │                   │
│  └──────────────────────────────────────┘                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

1. **Informer 启动时** List 所有 Ingress、Service、Endpoints、Secret 资源，建立本地缓存
2. **Watch 机制**持续监听资源变化事件（增/删/改）
3. **事件触发**时，Controller 收集全量 Ingress 规则和对应后端 Endpoints
4. **模板渲染**：将规则数据填入 Go template，生成完整的 `nginx.conf`
5. **配置热加载**：执行 `nginx -s reload`，master 进程 fork 新 worker 加载新配置，旧 worker 处理完现有连接后退出

### Nginx 内部请求处理

Nginx Ingress Controller 并非简单地将 Ingress 规则翻译为 nginx location，它引入了 Lua balancer 模块来实现动态后端选择，避免每次 Endpoints 变化都触发 reload：

```
Client Request
     │
     ▼
┌─────────────────────────────────────────────────┐
│               Nginx Worker Process               │
│                                                  │
│  ┌───────────┐    ┌──────────────────────────┐  │
│  │ Rewrite   │───►│ Server Block              │  │
│  │ Phase     │    │ (匹配 host + path)         │  │
│  └───────────┘    └────────────┬─────────────┘  │
│                                │                 │
│                                ▼                 │
│                    ┌───────────────────────┐     │
│                    │  Lua Balancer         │     │
│                    │  (balancer_by_lua)    │     │
│                    │                       │     │
│                    │  1. 读取 shared dict  │     │
│                    │     中的 Endpoints    │     │
│                    │  2. 选择后端 Pod      │     │
│                    │     (轮询/一致性哈希)  │     │
│                    │  3. 设置 peer 地址    │     │
│                    └───────────┬───────────┘     │
│                                │                 │
│                                ▼                 │
│                    ┌───────────────────────┐     │
│                    │  Proxy Pass           │     │
│                    │  → 后端 Pod IP:Port   │     │
│                    └───────────────────────┘     │
└─────────────────────────────────────────────────┘
```

**关键机制**：
- **shared dict**：Endpoints 变化时，Controller 更新 Nginx 共享内存中的后端列表，Lua balancer 直接读取，无需 reload
- **balancer_by_lua**：每个请求在负载均衡阶段执行 Lua 代码，动态选择后端 Pod
- **reload 时机**：仅当 Ingress 规则变化（新增/删除/修改路由）时才触发 reload，Endpoints 增减由 Lua 动态处理

### TLS 终止流程

```
Client                    Nginx Ingress Controller              Backend Pod
  │                              │                                  │
  │  1. TLS ClientHello          │                                  │
  │  (SNI: app.example.com)      │                                  │
  │─────────────────────────────►│                                  │
  │                              │                                  │
  │  2. ServerHello + 证书        │                                  │
  │  (从 Secret 读取 TLS 证书)    │                                  │
  │◄─────────────────────────────│                                  │
  │                              │                                  │
  │  3. TLS 握手完成              │                                  │
  │══════════════════════════════│                                  │
  │  (加密通道建立)               │                                  │
  │                              │                                  │
  │  4. HTTP 请求 (加密)          │                                  │
  │  GET /api/users              │                                  │
  │═════════════════════════════►│                                  │
  │                              │  5. 解密 TLS → 明文 HTTP          │
  │                              │  6. 匹配 Ingress 规则             │
  │                              │  7. Lua Balancer 选择后端          │
  │                              │                                  │
  │                              │  8. Proxy Pass (明文 HTTP)        │
  │                              │─────────────────────────────────►│
  │                              │                                  │
  │                              │  9. 后端响应                      │
  │                              │◄─────────────────────────────────│
  │                              │                                  │
  │  10. 加密响应返回             │                                  │
  │◄════════════════════════════│                                  │
```

1. 客户端发起 TLS 握手，携带 SNI（Server Name Indication）指明目标域名
2. Nginx 根据 SNI 匹配对应 Ingress 的 TLS 配置，从关联的 Secret 中读取证书和私钥
3. 完成 TLS 握手后，后续请求在加密通道内传输
4. Nginx 解密请求后，按 Ingress 规则路由到后端 Service
5. 默认以明文 HTTP 转发给后端 Pod（后端通常在集群内网，无需加密）
6. 如需端到端加密，可配置 `nginx.ingress.kubernetes.io/backend-protocol: "https"`

## Ingress 完整访问链路

从客户端发起请求到后端 Pod 返回响应的完整数据链路：

```
┌─────────┐    ┌──────────┐    ┌──────────────┐    ┌───────────────┐    ┌────────────┐    ┌──────────┐
│ Client   │───►│ DNS 解析  │───►│ 外部负载均衡  │───►│ Ingress       │───►│ Service    │───►│ Pod      │
│ (浏览器)  │    │           │    │ (Cloud LB)   │    │ Controller    │    │ (ClusterIP)│    │ (容器)   │
└─────────┘    └──────────┘    └──────────────┘    └───────────────┘    └────────────┘    └──────────┘
```

### 详细步骤分解

**第一步：DNS 解析**

```
浏览器请求 https://app.example.com/api/users
    │
    ▼
DNS 查询 app.example.com
    │
    ▼
┌────────────────────────────────────────────┐
│ 解析结果取决于 Service 类型：               │
│                                            │
│ LoadBalancer → 返回云 LB 的外部 IP         │
│ NodePort     → 返回任一 Node 的 IP         │
│ HostNetwork  → 返回 Node 的 IP             │
│                                            │
│ 通常配合外部 DNS (如 Route53)               │
│ 将域名 CNAME/A 记录指向 LB 外部 IP         │
└────────────────────────────────────────────┘
```

**第二步：TCP 连接建立**

```
Client                          LoadBalancer / Node
  │                                    │
  │  SYN (目的端口 80 或 443)           │
  │───────────────────────────────────►│
  │                                    │
  │  SYN-ACK                           │
  │◄───────────────────────────────────│
  │                                    │
  │  ACK                               │
  │───────────────────────────────────►│
  │                                    │
  │  TCP 连接建立                       │
```

**第三步：TLS 握手（HTTPS）**

如果是 HTTPS 请求，在 TCP 连接后执行 TLS 握手（流程见上文 TLS 终止部分）。

**第四步：请求到达 Ingress Controller**

```
外部流量如何到达 Ingress Controller Pod？

┌─────────────────────────────────────────────────────────────────┐
│                        三种路径对比                              │
│                                                                 │
│  路径A: LoadBalancer Service                                    │
│  Client → Cloud LB → Node IP:NodePort → iptables DNAT → Pod   │
│                                                                 │
│  路径B: NodePort Service                                        │
│  Client → Node IP:NodePort → iptables DNAT → Pod              │
│                                                                 │
│  路径C: HostNetwork                                             │
│  Client → Node IP:80/443 → Pod (直接监听宿主机端口)             │
└─────────────────────────────────────────────────────────────────┘
```

**第五步：Nginx 路由匹配**

```
HTTP 请求到达 Nginx Worker
    │
    ▼
┌───────────────────────────────────────────────────┐
│ 1. server_name 匹配 (Host 头 / SNI)               │
│    app.example.com → server block A               │
│                                                   │
│ 2. location 匹配 (URI 路径)                       │
│    /api/users → location /api (Prefix)            │
│                                                   │
│ 3. 应用 Ingress 注解（Annotations）               │
│    - rewrite-target: 路径重写                     │
│    - proxy-connect-timeout: 连接超时              │
│    - proxy-read-timeout: 读超时                   │
│    - ssl-redirect: 强制 HTTPS                     │
│    - cors-*: 跨域配置                            │
│    - rate-limit-*: 限流配置                       │
│                                                   │
│ 4. 注入请求头                                     │
│    X-Forwarded-For: 客户端真实 IP                 │
│    X-Forwarded-Proto: 原始协议 (https)            │
│    X-Forwarded-Host: 原始 Host                    │
│    X-Forwarded-Port: 原始端口                     │
│    X-Real-Ip: 客户端 IP                          │
└───────────────────────────────────────────────────┘
```

**第六步：Lua Balancer 选择后端**

```
Lua Balancer 执行流程：
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. 从 shared dict 读取 Endpoints 列表   │
│    endpoints = {                        │
│      "10.244.1.5:8080",                │
│      "10.244.2.8:8080",                │
│      "10.244.3.12:8080"                │
│    }                                    │
│                                         │
│ 2. 负载均衡算法选择                      │
│    - round-robin (默认)                  │
│    - ip-hash (会话保持)                  │
│    - consistent-hash (一致性哈希)        │
│    - ewma (指数加权移动平均，最短队列)   │
│                                         │
│ 3. 返回选中的 peer 地址                  │
│    peer = "10.244.2.8:8080"            │
└─────────────────────────────────────────┘
```

**第七步：代理转发到后端 Pod**

```
Nginx Worker                    Backend Pod
    │                              │
    │  HTTP GET /api/users         │
    │  Host: api-service:8080      │
    │  X-Forwarded-For: 1.2.3.4   │
    │─────────────────────────────►│
    │                              │
    │  200 OK + Response Body      │
    │◄─────────────────────────────│
    │                              │
```

**注意**：Nginx Ingress Controller 默认直接代理到 Pod IP，跳过 Service 的 iptables/ipvs 规则。这是通过 `--publish-service` 和 Endpoints watch 实现的——Controller 直接从 API Server 获取 Endpoints 列表，在 Lua balancer 中做负载均衡，避免 kube-proxy 的额外转发开销。

### 完整链路汇总

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          Ingress 完整访问链路                                    │
│                                                                                 │
│  ① DNS 解析                                                                     │
│  app.example.com → A 记录 → LB External IP / Node IP                           │
│                                                                                 │
│  ② TCP 连接                                                                     │
│  Client → LB/Node:443 (三次握手)                                                │
│                                                                                 │
│  ③ TLS 握手                                                                     │
│  Client ←→ Ingress Controller (SNI + 证书验证 + 密钥交换)                        │
│                                                                                 │
│  ④ HTTP 请求                                                                    │
│  GET /api/users HTTPS 加密传输                                                   │
│                                                                                 │
│  ⑤ Ingress Controller 处理                                                       │
│  Nginx 解密 → server_name 匹配 → location 匹配 → Annotations 处理               │
│                                                                                 │
│  ⑥ Lua Balancer                                                                 │
│  读取 Endpoints → 负载均衡算法 → 选择 Pod IP                                     │
│                                                                                 │
│  ⑦ 代理转发                                                                     │
│  Nginx → Pod IP:Port (HTTP 明文，集群内网)                                       │
│  注入头: X-Forwarded-For/Proto/Host                                              │
│                                                                                 │
│  ⑧ 后端处理                                                                     │
│  Pod 收到请求 → 业务逻辑 → 返回响应                                               │
│                                                                                 │
│  ⑨ 响应返回                                                                     │
│  Pod → Nginx → TLS 加密 → Client                                                │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 常用 Annotations 速查

Nginx Ingress Controller 通过 Annotations 提供丰富的功能扩展：

```yaml
metadata:
  annotations:
    # 重写路径
    nginx.ingress.kubernetes.io/rewrite-target: /$2

    # SSL 强制跳转
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"

    # 后端协议
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"

    # 连接超时
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"

    # 限流
    nginx.ingress.kubernetes.io/limit-connections: "5"
    nginx.ingress.kubernetes.io/limit-rps: "100"

    # CORS
    nginx.ingress.kubernetes.io/enable-cors: "true"
    nginx.ingress.kubernetes.io/cors-allow-origin: "*"

    # 会话保持 (一致性哈希)
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/session-cookie-name: "stickounet"

    # WebSocket
    nginx.ingress.kubernetes.io/websocket-services: "ws-service"

    # 请求体大小
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"

    # 自定义最大重试次数
    nginx.ingress.kubernetes.io/custom-http-errors: "404,503"
```

## Default Backend

当请求不匹配任何 Ingress 规则时，Ingress Controller 会将请求转发到 Default Backend。默认的 Default Backend 返回 404，可以自定义：

```yaml
# Ingress Controller 启动参数指定自定义 Default Backend
--default-backend-service=default/custom-default-backend
```

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: custom-default-backend
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: default-backend
        image: registry.k8s.io/defaultbackend:1.5
        ports:
        - containerPort: 8080
```

Default Backend 常用于展示自定义错误页面、健康检查端点等场景。
