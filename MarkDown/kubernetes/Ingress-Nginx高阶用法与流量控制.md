# Ingress-Nginx 高阶用法：金丝雀发布、流量控制与 TLS 站点构建

## 前置说明

| 项目 | 值 |
|------|-----|
| Ingress-Nginx 版本 | ≥ 0.21.0（Canary 特性要求） |
| K8s 版本 | ≥ 1.19（networking.k8s.io/v1） |
| Canary 功能 | 从 0.21.0 引入，0.30.0 后趋于稳定 |

Ingress-Nginx 的 Canary 功能通过一组专用的 Annotation 实现，**不需要安装额外组件**，只需在 Ingress 资源上添加对应注解即可。核心思路是：创建两条 Ingress 规则指向同一域名，一条为主版本（stable），一条为金丝雀版本（canary），Controller 根据注解决定流量分配比例。

---

## 金丝雀发布（Canary Release）

### 核心注解一览

| 注解 | 类型 | 说明 |
|------|------|------|
| `nginx.ingress.kubernetes.io/canary` | "true"/"false" | **必须**，标记此 Ingress 为金丝雀 |
| `nginx.ingress.kubernetes.io/canary-weight` | 数字（0-100） | 按权重分配流量百分比 |
| `nginx.ingress.kubernetes.io/canary-by-header` | 字符串 | 按请求头路由，值为 `always` 走金丝雀，`never` 走主版本 |
| `nginx.ingress.kubernetes.io/canary-by-header-value` | 字符串 | 自定义请求头的匹配值（需配合 canary-by-header） |
| `nginx.ingress.kubernetes.io/canary-by-header-pattern` | 字符串 | PCRE 正则匹配请求头值（canary-by-header-value 优先） |
| `nginx.ingress.kubernetes.io/canary-by-cookie` | 字符串 | 按 Cookie 路由，值为 `always` 走金丝雀，`never` 走主版本 |
| `nginx.ingress.kubernetes.io/canary-weight-total` | 数字 | 权重总量，默认 100 |

### 优先级规则

```
canary-by-header > canary-by-cookie > canary-weight
```

请求到达后的匹配逻辑：

1. 先检查 `canary-by-header`——如果请求头匹配，直接路由（不管权重和 Cookie）
2. 再检查 `canary-by-cookie`——如果 Cookie 匹配，直接路由（不管权重）
3. 最后按 `canary-weight` 比例随机分配

这意味着：**精确匹配（header/cookie）始终优先于模糊分配（weight）**。

---

### 场景一：基于权重的金丝雀发布

最简单的金丝雀方式——将一定比例的流量随机导入新版本。

**架构图：**

```
                    ┌──────────────────┐
                    │   Ingress-Nginx   │
                    │   Controller      │
                    └────────┬─────────┘
                             │
               ┌─────────────┼─────────────┐
               │ 90%         │ 10%         │
        ┌──────▼──────┐  ┌──▼───────────┐
        │ Production  │  │   Canary     │
        │ Service     │  │   Service    │
        │ (v1 稳定版)  │  │  (v2 新版本)  │
        └─────────────┘  └──────────────┘
```

**1. 主版本 Deployment + Service + Ingress：**

```yaml
# 主版本 Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-v1
  labels:
    app: myapp
    version: v1
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
      version: v1
  template:
    metadata:
      labels:
        app: myapp
        version: v1
    spec:
      containers:
      - name: myapp
        image: registry.cn-hangzhou.aliyuncs.com/demo/myapp:v1
        ports:
        - containerPort: 8080
        env:
        - name: VERSION
          value: "v1"
---
# 主版本 Service
apiVersion: v1
kind: Service
metadata:
  name: myapp-v1-svc
spec:
  selector:
    app: myapp
    version: v1
  ports:
  - port: 80
    targetPort: 8080
---
# 主版本 Ingress（无 canary 注解）
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-ingress
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v1-svc
            port:
              number: 80
```

**2. 金丝雀版本 Deployment + Service + Ingress：**

```yaml
# 金丝雀 Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-v2
  labels:
    app: myapp
    version: v2
spec:
  replicas: 1
  selector:
    matchLabels:
      app: myapp
      version: v2
  template:
    metadata:
      labels:
        app: myapp
        version: v2
    spec:
      containers:
      - name: myapp
        image: registry.cn-hangzhou.aliyuncs.com/demo/myapp:v2
        ports:
        - containerPort: 8080
        env:
        - name: VERSION
          value: "v2"
---
# 金丝雀 Service
apiVersion: v1
kind: Service
metadata:
  name: myapp-v2-svc
spec:
  selector:
    app: myapp
    version: v2
  ports:
  - port: 80
    targetPort: 8080
---
# 金丝雀 Ingress（带 canary 注解）
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-canary
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v2-svc
            port:
              number: 80
```

**验证：**

```bash
# 发送 20 次请求，观察版本分布
for i in $(seq 1 20); do
  curl -s http://myapp.example.com/api/version | grep "version"
done

# 期望输出：约 18 次 v1，约 2 次 v2
# v1  v1  v2  v1  v1  v1  v1  v2  v1  v1
# v1  v1  v1  v1  v2  v1  v1  v1  v1  v1
```

**渐进式放量流程：**

```bash
# 阶段1：10% 流量到金丝雀
kubectl annotate ingress myapp-canary nginx.ingress.kubernetes.io/canary-weight=10 --overwrite

# 观察指标无异常后 → 阶段2：30%
kubectl annotate ingress myapp-canary nginx.ingress.kubernetes.io/canary-weight=30 --overwrite

# 继续观察 → 阶段3：50%
kubectl annotate ingress myapp-canary nginx.ingress.kubernetes.io/canary-weight=50 --overwrite

# 最终：全量发布（删除 canary ingress，升级主版本镜像，删除金丝雀资源）
kubectl delete ingress myapp-canary
kubectl set image deployment/app-v1 myapp=registry.cn-hangzhou.aliyuncs.com/demo/myapp:v2
```

---

### 场景二：基于请求头的金丝雀发布

通过 HTTP 请求头精确控制哪些请求走金丝雀，适合内部测试或 A/B 测试。

**1. 固定值匹配（canary-by-header）：**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-canary-header
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v2-svc
            port:
              number: 80
```

```bash
# 请求头 X-Canary: always → 走金丝雀
curl -H "X-Canary: always" http://myapp.example.com/api/version
# 返回 v2

# 请求头 X-Canary: never → 走主版本
curl -H "X-Canary: never" http://myapp.example.com/api/version
# 返回 v1

# 无请求头或非 always/never → 按其他 canary 规则（如 weight）分配
curl http://myapp.example.com/api/version
# 返回 v1（如果没有其他 canary 规则）
```

**2. 自定义值匹配（canary-by-header + canary-by-header-value）：**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-canary-header-custom
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-by-header: "X-Env"
    nginx.ingress.kubernetes.io/canary-by-header-value: "staging"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v2-svc
            port:
              number: 80
```

```bash
# 自定义值匹配
curl -H "X-Env: staging" http://myapp.example.com/api/version
# 返回 v2

# 不匹配的值 → 走主版本
curl -H "X-Env: production" http://myapp.example.com/api/version
# 返回 v1
```

**3. 正则匹配（canary-by-header-pattern）：**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-canary-header-regex
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-by-header: "X-User-Type"
    nginx.ingress.kubernetes.io/canary-by-header-pattern: "^(internal|beta|test)$"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v2-svc
            port:
              number: 80
```

```bash
# 匹配正则 → 走金丝雀
curl -H "X-User-Type: internal" http://myapp.example.com/api/version  # v2
curl -H "X-User-Type: beta" http://myapp.example.com/api/version      # v2
curl -H "X-User-Type: test" http://myapp.example.com/api/version      # v2

# 不匹配 → 走主版本
curl -H "X-User-Type: external" http://myapp.example.com/api/version  # v1
```

> **注意**：当同时设置了 `canary-by-header-value` 和 `canary-by-header-pattern` 时，`canary-by-header-value` 优先，`canary-by-header-pattern` 会被忽略。如果正则表达式在处理请求时出错，该请求会被视为不匹配。

---

### 场景三：基于 Cookie 的金丝雀发布

通过 Cookie 控制流量分配，可以实现"登录用户走新版本"等场景。一旦用户被标记，后续请求持续走金丝雀版本。

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-canary-cookie
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-by-cookie: "use_canary"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v2-svc
            port:
              number: 80
```

```bash
# Cookie use_canary=always → 走金丝雀
curl -b "use_canary=always" http://myapp.example.com/api/version
# 返回 v2

# Cookie use_canary=never → 走主版本
curl -b "use_canary=never" http://myapp.example.com/api/version
# 返回 v1

# 无 Cookie → 按其他 canary 规则分配
curl http://myapp.example.com/api/version
# 返回 v1
```

**浏览器端设置方式：**

```javascript
// 前端 JS 设置 Cookie，让用户进入金丝雀版本
document.cookie = "use_canary=always; path=/; max-age=86400";

// 移除 Cookie，回到主版本
document.cookie = "use_canary=never; path=/; max-age=0";
```

---

### 场景四：组合策略——Header + Cookie + Weight

实际生产中最常用的方式是组合多种策略：特定人群（Header）强制走金丝雀，已标记用户（Cookie）保持金丝雀，其余流量按权重分配。

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-canary-combined
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"
    nginx.ingress.kubernetes.io/canary-by-cookie: "use_canary"
    nginx.ingress.kubernetes.io/canary-weight: "20"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v2-svc
            port:
              number: 80
```

**请求路由流程：**

```
请求到达
  │
  ├─ 1. 检查 X-Canary 请求头
  │     ├─ always → 金丝雀（100%）
  │     ├─ never  → 主版本（100%）
  │     └─ 无/其他值 → 继续判断
  │
  ├─ 2. 检查 use_canary Cookie
  │     ├─ always → 金丝雀（100%）
  │     ├─ never  → 主版本（100%）
  │     └─ 无/其他值 → 继续判断
  │
  └─ 3. 按权重随机分配
        ├─ 20% → 金丝雀
        └─ 80% → 主版本
```

```bash
# 测试1：Header 强制金丝雀
curl -H "X-Canary: always" http://myapp.example.com/api/version
# → v2（Header 匹配，不再检查 Cookie 和权重）

# 测试2：Cookie 强制金丝雀
curl -b "use_canary=always" http://myapp.example.com/api/version
# → v2（Cookie 匹配，不再检查权重）

# 测试3：无 Header/Cookie，按权重
for i in $(seq 1 20); do
  curl -s http://myapp.example.com/api/version
done
# → 约 16 次 v1，约 4 次 v2

# 测试4：Header 强制主版本
curl -H "X-Canary: never" -b "use_canary=always" http://myapp.example.com/api/version
# → v1（Header 优先级 > Cookie）
```

---

## 蓝绿部署（Blue-Green Deployment）

蓝绿部署的核心是**全量切换**：同时运行两套完整环境（蓝/绿），通过修改 Service 的 selector 或 Ingress 的 backend 瞬间切换流量。

### 方式一：修改 Ingress Backend 切换

```yaml
# 蓝环境（当前生产）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-blue
  labels:
    app: myapp
    slot: blue
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
      slot: blue
  template:
    metadata:
      labels:
        app: myapp
        slot: blue
    spec:
      containers:
      - name: myapp
        image: myapp:v1
        ports:
        - containerPort: 8080
---
# 绿环境（新版本，待切换）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-green
  labels:
    app: myapp
    slot: green
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
      slot: green
  template:
    metadata:
      labels:
        app: myapp
        slot: green
    spec:
      containers:
      - name: myapp
        image: myapp:v2
        ports:
        - containerPort: 8080
---
# 蓝环境 Service
apiVersion: v1
kind: Service
metadata:
  name: myapp-blue-svc
spec:
  selector:
    app: myapp
    slot: blue
  ports:
  - port: 80
    targetPort: 8080
---
# 绿环境 Service
apiVersion: v1
kind: Service
metadata:
  name: myapp-green-svc
spec:
  selector:
    app: myapp
    slot: green
  ports:
  - port: 80
    targetPort: 8080
```

**Ingress 切换——蓝环境在线：**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-ingress
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-blue-svc    # ← 当前指向蓝环境
            port:
              number: 80
```

**一键切换到绿环境：**

```bash
# 修改 Ingress backend，瞬间切换
kubectl patch ingress myapp-ingress -p '{"spec":{"rules":[{"host":"myapp.example.com","http":{"paths":[{"pathType":"Prefix","path":"/","backend":{"service":{"name":"myapp-green-svc","port":{"number":80}}}}]}}]}}'

# 回滚：再切回蓝环境
kubectl patch ingress myapp-ingress -p '{"spec":{"rules":[{"host":"myapp.example.com","http":{"paths":[{"pathType":"Prefix","path":"/","backend":{"service":{"name":"myapp-blue-svc","port":{"number":80}}}}]}}]}}'
```

### 方式二：利用 Canary 注解实现蓝绿

利用 `canary-weight: 100` 实现全量切换，好处是可以通过调整权重实现渐进式过渡。

```yaml
# 绿环境 Ingress，初始 weight=0（不接收流量）
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-canary-green
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "0"     # 初始不接收流量
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-green-svc
            port:
              number: 80
```

```bash
# 蓝绿切换：将金丝雀权重设为 100
kubectl annotate ingress myapp-canary-green \
  nginx.ingress.kubernetes.io/canary-weight=100 --overwrite

# 回滚：将权重设回 0
kubectl annotate ingress myapp-canary-green \
  nginx.ingress.kubernetes.io/canary-weight=0 --overwrite
```

---

## 滚动发布与灰度发布

### 滚动发布（Rolling Update）

Kubernetes Deployment 原生支持的发布策略，不需要 Ingress 层介入：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  replicas: 6
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 2        # 滚动过程中最多多出 2 个 Pod
      maxUnavailable: 1   # 滚动过程中最多允许 1 个 Pod 不可用
  selector:
    matchLabels:
      app: myapp
  template:
    spec:
      containers:
      - name: myapp
        image: myapp:v2    # 更新镜像触发滚动
```

**滚动发布 vs 金丝雀发布对比：**

| 维度 | 滚动发布 | 金丝雀发布 |
|------|---------|-----------|
| 流量控制 | 无，新旧 Pod 随机接收 | 精确控制流量比例 |
| 回滚速度 | 较慢（需要重新滚动） | 瞬间（删除 canary Ingress） |
| 影响范围 | 所有用户受影响 | 可限定特定用户群体 |
| 复杂度 | 低（K8s 原生） | 中（需配置 Ingress 注解） |
| 适用场景 | 低风险变更 | 高风险变更、需要验证 |

### 灰度发布（Grayscale Release）

灰度发布是金丝雀发布的渐进式版本——从小比例流量开始，逐步放大：

```
5% → 观察 → 10% → 观察 → 30% → 观察 → 50% → 观察 → 100%（全量）
       ↓              ↓              ↓
     回滚            回滚           回滚
```

**自动化灰度脚本示例：**

```bash
#!/bin/bash
# grayscale-release.sh
# 用法: ./grayscale-release.sh <canary-ingress-name> <namespace>

INGRESS=$1
NS=${2:-default}
WEIGHTS=(5 10 20 30 50 80 100)
INTERVAL=300  # 每阶段观察 5 分钟

for w in "${WEIGHTS[@]}"; do
  echo "[$(date)] 设置金丝雀权重: ${w}%"
  kubectl annotate ingress ${INGRESS} -n ${NS} \
    nginx.ingress.kubernetes.io/canary-weight=${w} --overwrite

  echo "[$(date)] 等待 ${INTERVAL}s 观察指标..."
  sleep ${INTERVAL}

  # 检查错误率（示例：通过 Prometheus 查询）
  ERROR_RATE=$(curl -s "http://prometheus:9090/api/v1/query?query=sum(rate(http_requests_total{status=~\"5..\"}[5m]))/sum(rate(http_requests_total[5m]))" | jq -r '.data.result[0].value[1]')
  
  echo "[$(date)] 当前错误率: ${ERROR_RATE}"
  
  # 错误率超过阈值则回滚
  if (( $(echo "${ERROR_RATE} > 0.05" | bc -l) )); then
    echo "[$(date)] 错误率超过 5%，回滚！"
    kubectl annotate ingress ${INGRESS} -n ${NS} \
      nginx.ingress.kubernetes.io/canary-weight=0 --overwrite
    exit 1
  fi
done

echo "[$(date)] 金丝雀发布完成，全量切换成功"
```

---

## 流量镜像（Traffic Mirroring / Shadowing）

流量镜像将生产流量的**副本**发送到镜像服务，不影响正常请求的响应。用于预生产环境验证新版本在真实流量下的表现。

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-mirror
  annotations:
    nginx.ingress.kubernetes.io/mirror-target: "http://myapp-shadow-svc:80"
    nginx.ingress.kubernetes.io/mirror-host: "myapp.example.com"
    nginx.ingress.kubernetes.io/mirror-request-body: "on"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v1-svc      # 主流量仍然正常响应
            port:
              number: 80
```

| 注解 | 说明 |
|------|------|
| `mirror-target` | 镜像流量发送的目标 Service 地址 |
| `mirror-host` | 镜像请求的 Host 头（默认与原始请求相同） |
| `mirror-request-body` | 是否镜像请求体，`on`/`off`（默认 `on`） |

**关键特性：**
- 镜像请求的响应会被**丢弃**，不影响原始请求
- 镜像请求与原始请求异步发送，不会增加主请求延迟
- 适合在预发环境用真实流量做压力测试和回归验证

---

## 构建 TLS 站点

### 方式一：手动管理 TLS 证书

**1. 生成自签名证书（测试用）：**

```bash
# 生成私钥和证书
openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout tls.key \
  -out tls.crt \
  -subj "/CN=myapp.example.com/O=myapp" \
  -addext "subjectAltName=DNS:myapp.example.com,DNS:www.myapp.example.com"

# 创建 K8s Secret
kubectl create secret tls myapp-tls-secret \
  --key tls.key \
  --cert tls.crt
```

**2. 配置 Ingress 启用 TLS：**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-tls
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - myapp.example.com
    secretName: myapp-tls-secret     # 引用上面创建的 Secret
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v1-svc
            port:
              number: 80
```

```bash
# 验证 TLS
curl -k https://myapp.example.com/api/version
# -k 跳过自签名证书验证

# 验证证书信息
openssl s_client -connect myapp.example.com:443 -servername myapp.example.com </dev/null 2>/dev/null | openssl x509 -noout -text
```

**3. 自动 HTTP → HTTPS 重定向：**

Ingress 配置了 `tls` 段后，ingress-nginx 默认会将 HTTP 请求 308 重定向到 HTTPS。可以通过注解控制：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-tls
  annotations:
    # 禁用自动 HTTPS 重定向（不推荐生产使用）
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
    # 强制 HTTPS 重定向（即使没有 TLS 证书，适用于外部 TLS 卸载场景）
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - myapp.example.com
    secretName: myapp-tls-secret
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v1-svc
            port:
              number: 80
```

| 注解 | 默认值 | 说明 |
|------|-------|------|
| `ssl-redirect` | true（配置 TLS 时） | 有 TLS 配置时自动重定向 HTTP → HTTPS |
| `force-ssl-redirect` | false | 即使没有 TLS 证书也强制重定向（适用于 AWS ELB 等外部 TLS 终止场景） |

---

### 方式二：cert-manager 自动证书管理

cert-manager 是 Kubernetes 证书管理的标准方案，支持 Let's Encrypt 自动签发和续期。

**1. 安装 cert-manager：**

```bash
# 安装 cert-manager（v1.14+）
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml

# 验证
kubectl get pods -n cert-manager
# NAME                                       READY   STATUS
# cert-manager-xxxxxx-xxxxx                  1/1     Running
# cert-manager-cainjector-xxxxxx-xxxxx       1/1     Running
# cert-manager-webhook-xxxxxx-xxxxx          1/1     Running
```

**2. 创建 ClusterIssuer（Let's Encrypt）：**

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@example.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
---
# 测试环境 Issuer（不受速率限制，但证书不被浏览器信任）
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: admin@example.com
    privateKeySecretRef:
      name: letsencrypt-staging
    solvers:
    - http01:
        ingress:
          class: nginx
```

**3. Ingress 自动签发证书：**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-auto-tls
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - myapp.example.com
    secretName: myapp-auto-tls    # cert-manager 自动创建此 Secret
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v1-svc
            port:
              number: 80
```

```bash
# 查看证书签发状态
kubectl get certificate
# NAME               READY   SECRET             AGE
# myapp-auto-tls     True    myapp-auto-tls     2m

# 查看证书详情
kubectl describe certificate myapp-auto-tls

# 查看订单状态
kubectl describe order myapp-auto-tls-xxxxx
```

**证书自动续期：** cert-manager 会在证书到期前 30 天自动续期，无需人工干预。

---

### 方式三：TLS Passthrough

TLS Passthrough 不在 Ingress Controller 层终止 TLS，而是将加密流量直接透传到后端 Pod，由后端服务自行处理 TLS 握手。

**适用场景：**
- 后端服务需要客户端证书认证（mTLS）
- gRPC 服务需要端到端加密
- 不信任 Ingress Controller 处理证书

```bash
# 启用 SSL Passthrough（需要修改 Ingress Controller 启动参数）
# 在 ingress-nginx-controller Deployment 中添加：
# --enable-ssl-passthrough
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-ssl-passthrough
  annotations:
    nginx.ingress.kubernetes.io/ssl-passthrough: "true"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v1-svc
            port:
              number: 443      # 后端服务监听 443
```

> **注意**：TLS Passthrough 会绕过 NGINX 的所有 HTTP 层处理（包括 L7 负载均衡、header 修改、rate limiting），且流量发送到 Service 的 ClusterIP 而非单个 Endpoint，存在性能开销。

---

### TLS 安全加固

通过 ConfigMap 全局配置 TLS 安全参数：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # TLS 协议版本（仅允许 TLS 1.2 和 1.3）
  ssl-protocols: "TLSv1.2 TLSv1.3"

  # 加密套件（推荐 Mozilla Modern 配置）
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305"

  # 优先使用服务端密码套件
  ssl-prefer-server-ciphers: "true"

  # 启用 HSTS（强制浏览器使用 HTTPS）
  hsts: "true"
  hsts-max-age: "31536000"           # 1 年
  hsts-include-subdomains: "true"
  hsts-preload: "true"

  # OCSP Stapling
  ssl-ocsp: "true"
```

也可以在单个 Ingress 上覆盖：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-tls-hardened
  annotations:
    nginx.ingress.kubernetes.io/ssl-ciphers: "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384"
    nginx.ingress.kubernetes.io/ssl-prefer-server-ciphers: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - myapp.example.com
    secretName: myapp-tls-secret
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v1-svc
            port:
              number: 80
```

---

### 多域名 TLS（SNI）

Ingress-Nginx 通过 SNI（Server Name Indication）支持在同一 IP 上为多个域名提供不同的 TLS 证书：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: multi-domain-tls
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - app1.example.com
    secretName: app1-tls-secret
  - hosts:
    - app2.example.com
    secretName: app2-tls-secret
  - hosts:
    - app3.example.com
    secretName: app3-tls-secret
  rules:
  - host: app1.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: app1-svc
            port:
              number: 80
  - host: app2.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: app2-svc
            port:
              number: 80
  - host: app3.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: app3-svc
            port:
              number: 80
```

**通配符证书：**

```yaml
# 使用通配符证书覆盖所有子域名
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: wildcard-tls
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - "*.example.com"
    secretName: wildcard-tls-secret    # 证书 SAN 包含 *.example.com
  rules:
  - host: app1.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: app1-svc
            port:
              number: 80
  - host: app2.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: app2-svc
            port:
              number: 80
```

---

## 金丝雀与 TLS 组合实战

生产环境中，金丝雀发布和 TLS 通常需要组合使用。关键约束：**Canary Ingress 的非 Canary 注解会被忽略，继承主 Ingress 的配置**，包括 TLS 配置。

```yaml
# 主版本 Ingress（含 TLS）
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-prod
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - myapp.example.com
    secretName: myapp-prod-tls
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v1-svc
            port:
              number: 80
---
# 金丝雀 Ingress（TLS 配置自动继承，无需重复声明）
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-canary
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "20"
    # 以下注解在 canary Ingress 中会被忽略，自动继承主 Ingress：
    # - cert-manager.io/cluster-issuer
    # - nginx.ingress.kubernetes.io/ssl-redirect
    # - tls 段配置
    # 以下注解在 canary Ingress 中生效（例外）：
    nginx.ingress.kubernetes.io/load-balance: "ewma"
    nginx.ingress.kubernetes.io/upstream-hash-by: "$request_uri"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v2-svc
            port:
              number: 80
```

---

## 会话亲和性与金丝雀

当使用基于 Cookie 的会话亲和性（Session Affinity）时，需要考虑与金丝雀的交互行为。

```yaml
# 主版本 Ingress 启用会话亲和性
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-prod
  annotations:
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/affinity-mode: "persistent"
    nginx.ingress.kubernetes.io/session-cookie-name: "INGRESSCOOKIE"
    nginx.ingress.kubernetes.io/session-cookie-max-age: "86400"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v1-svc
            port:
              number: 80
---
# 金丝雀 Ingress 的会话亲和性行为
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-canary
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "20"
    # sticky（默认）：被金丝雀服务过的用户，后续请求持续走金丝雀
    nginx.ingress.kubernetes.io/affinity-canary-behavior: "sticky"
    # legacy：忽略会话亲和性，每次请求按权重重新分配
    # nginx.ingress.kubernetes.io/affinity-canary-behavior: "legacy"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v2-svc
            port:
              number: 80
```

| affinity-canary-behavior | 行为 |
|--------------------------|------|
| `sticky`（默认） | 一旦用户被路由到金丝雀，后续请求持续走金丝雀 |
| `legacy` | 忽略会话亲和性，每次请求按权重重新判断 |

---

## 自定义权重总量

默认权重总量为 100，但可以通过 `canary-weight-total` 修改，实现更精细的权重控制：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-canary-fine
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "1"
    nginx.ingress.kubernetes.io/canary-weight-total: "1000"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: myapp-v2-svc
            port:
              number: 80
```

上述配置中，权重总量为 1000，金丝雀权重为 1，即 0.1% 的流量走金丝雀。这在超大规模流量场景下非常有用。

---

## 已知限制与注意事项

| 限制 | 说明 |
|------|------|
| 每个 Ingress 规则最多一条 Canary | 同一域名+路径只能有一条 Canary Ingress |
| Canary 继承主 Ingress 注解 | Canary Ingress 的非 Canary 注解被忽略（除 load-balance、upstream-hash-by、session-affinity） |
| 证书链顺序 | Secret 中证书必须是 leaf → intermediate → root 顺序，否则导入失败 |
| SSL Passthrough 性能 | 绕过 NGINX 全部 L7 处理，流量发送到 ClusterIP 而非单个 Endpoint |
| 权重非精确 | 小流量下权重分配可能有偏差，流量越大越接近设定比例 |
| Cookie 仅支持 always/never | `canary-by-cookie` 不支持自定义值，只有 `always` 和 `never` 有效 |
| 正则匹配失败处理 | `canary-by-header-pattern` 正则出错时，请求视为不匹配 |

---

## 完整实战：TLS + 金丝雀灰度发布

将以上所有特性整合为一个完整的实战案例。

**环境：**
- 域名：`app.example.com`
- 主版本：v1，3 副本
- 金丝雀版本：v2，2 副本
- 自动 TLS 证书（cert-manager + Let's Encrypt）
- 灰度策略：内部用户 Header 强制金丝雀 → Cookie 标记用户 → 其余按权重渐进

```yaml
# ============ 主版本 ============
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-v1
  labels:
    app: myapp
    version: v1
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
      version: v1
  template:
    metadata:
      labels:
        app: myapp
        version: v1
    spec:
      containers:
      - name: myapp
        image: myapp:v1
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: app-v1-svc
spec:
  selector:
    app: myapp
    version: v1
  ports:
  - port: 80
    targetPort: 8080
---
# ============ 金丝雀版本 ============
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-v2
  labels:
    app: myapp
    version: v2
spec:
  replicas: 2
  selector:
    matchLabels:
      app: myapp
      version: v2
  template:
    metadata:
      labels:
        app: myapp
        version: v2
    spec:
      containers:
      - name: myapp
        image: myapp:v2
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: app-v2-svc
spec:
  selector:
    app: myapp
    version: v2
  ports:
  - port: 80
    targetPort: 8080
---
# ============ 主版本 Ingress（含 TLS） ============
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-prod
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/affinity-mode: "persistent"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - app.example.com
    secretName: app-prod-tls
  rules:
  - host: app.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: app-v1-svc
            port:
              number: 80
---
# ============ 金丝雀 Ingress ============
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-canary
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"
    nginx.ingress.kubernetes.io/canary-by-cookie: "use_canary"
    nginx.ingress.kubernetes.io/canary-weight: "10"
    nginx.ingress.kubernetes.io/affinity-canary-behavior: "sticky"
spec:
  ingressClassName: nginx
  rules:
  - host: app.example.com
    http:
      paths:
      - pathType: Prefix
        path: /
        backend:
          service:
            name: app-v2-svc
            port:
              number: 80
```

**发布流程：**

```bash
# Step 1: 部署金丝雀版本，初始 10% 流量
kubectl apply -f canary-deployment.yaml

# Step 2: 内部测试——通过 Header 验证金丝雀
curl -H "X-Canary: always" https://app.example.com/api/version
# → v2

# Step 3: 观察指标，逐步放量
kubectl annotate ingress app-canary \
  nginx.ingress.kubernetes.io/canary-weight=30 --overwrite

# Step 4: 继续观察后加大流量
kubectl annotate ingress app-canary \
  nginx.ingress.kubernetes.io/canary-weight=50 --overwrite

# Step 5: 全量发布
# 方案A：将主版本镜像升级到 v2，删除金丝雀
kubectl set image deployment/app-v1 myapp=myapp:v2
kubectl delete ingress app-canary
kubectl delete deployment app-v2
kubectl delete service app-v2-svc

# 方案B：将金丝雀权重设为 100
kubectl annotate ingress app-canary \
  nginx.ingress.kubernetes.io/canary-weight=100 --overwrite

# 回滚：随时将权重设为 0
kubectl annotate ingress app-canary \
  nginx.ingress.kubernetes.io/canary-weight=0 --overwrite
```

---

## 总结

| 发布策略 | 核心机制 | 流量控制粒度 | 回滚速度 | 适用场景 |
|---------|---------|------------|---------|---------|
| 基于权重金丝雀 | `canary-weight` | 百分比 | 瞬间（改注解） | 通用灰度发布 |
| 基于请求头金丝雀 | `canary-by-header` | 特定请求头 | 瞬间 | 内部测试、A/B 测试 |
| 基于 Cookie 金丝雀 | `canary-by-cookie` | 特定用户标记 | 瞬间 | 用户维度灰度 |
| 组合策略 | Header + Cookie + Weight | 多维度 | 瞬间 | 生产级灰度 |
| 蓝绿部署 | Ingress Backend 切换 | 全量切换 | 瞬间 | 零停机发布 |
| 滚动发布 | Deployment RollingUpdate | 无（Pod 级） | 中等（需回滚滚动） | 低风险变更 |
| 流量镜像 | `mirror-target` | 100% 镜像 | 不影响主流量 | 预发验证、压力测试 |

**最佳实践：**
1. **生产环境务必使用组合策略**——Header 用于内部验证，Cookie 用于用户标记，Weight 用于剩余流量
2. **TLS 站点优先使用 cert-manager**——自动签发、自动续期，避免证书过期导致的停机
3. **灰度发布配合监控**——每个权重阶段观察错误率、延迟、资源使用，超阈值自动回滚
4. **金丝雀环境保持 readinessProbe**——确保只有健康的 Pod 接收金丝雀流量
5. **会话亲和性设为 sticky**——避免同一用户在金丝雀和主版本之间反复跳转
6. **Canary Ingress 只加 Canary 相关注解**——非 Canary 注解会被忽略，应放在主 Ingress 上
