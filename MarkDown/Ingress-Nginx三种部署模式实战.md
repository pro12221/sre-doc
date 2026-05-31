# Ingress-Nginx 三种部署模式实战

## 环境信息

| 项目 | 值 |
|------|-----|
| K8s 版本 | v1.30.2 |
| CNI | Flannel |
| 容器运行时 | containerd 2.2.3 |
| OS | Ubuntu 24.04 LTS |
| 节点数 | 3（1 master + 2 worker） |

节点角色与公网 IP：

| 节点名 | 角色 | 内网 IP | 公网 IP |
|--------|------|---------|---------|
| master | control-plane | 10.60.21.65 | 117.50.174.70 |
| node01 | worker | 10.60.72.252 | 117.50.248.154 |
| node02 | worker | 10.60.177.72 | 117.50.180.164 |

---

## 国内镜像说明

`registry.k8s.io` 在国内无法直接访问，需要替换为阿里云镜像：

| 原始镜像 | 替换镜像 |
|----------|----------|
| `registry.k8s.io/ingress-nginx/controller:v1.8.1` | `registry.cn-hangzhou.aliyuncs.com/google_containers/nginx-ingress-controller:v1.8.1` |
| `registry.k8s.io/ingress-nginx/kube-webhook-certgen:v1.4.0` | `registry.cn-hangzhou.aliyuncs.com/google_containers/kube-webhook-certgen:v1.4.0` |

---

## 测试应用

每种模式部署完成后，使用以下 YAML 创建测试后端和 Ingress 规则进行验证：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: demo-app
  template:
    metadata:
      labels:
        app: demo-app
    spec:
      containers:
      - name: demo
        image: registry.cn-hangzhou.aliyuncs.com/google_containers/echoserver:1.10
        ports:
        - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: demo-app-svc
  namespace: default
spec:
  selector:
    app: demo-app
  ports:
  - port: 80
    targetPort: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: demo-ingress
  namespace: default
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
  - http:
      paths:
      - path: /demo
        pathType: Prefix
        backend:
          service:
            name: demo-app-svc
            port:
              number: 80
```

---

## 模式一：Deployment + NodePort

### 架构图

```
          ┌─────────────────┐
          │  External LB    │
          │  (可选)          │
          └────────┬────────┘
                   │
          ┌────────▼────────┐
          │  Service        │
          │  type: NodePort │
          │  80:30080/TCP   │
          │  443:30443/TCP  │
          └────────┬────────┘
                   │
      ┌────────────▼────────────┐
      │  Ingress Controller Pod  │
      │  (Deployment 副本=2)     │
      └─────────────────────────┘
```

### 部署步骤

**1. 创建完整资源清单**

核心差异点：
- 工作负载类型为 `Deployment`，`replicas: 2`
- Service 类型为 `NodePort`，指定 `nodePort: 30080` 和 `nodePort: 30443`
- 启动参数包含 `--publish-service` 以让 Ingress 资源自动填充地址

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
  template:
    spec:
      containers:
      - name: controller
        image: registry.cn-hangzhou.aliyuncs.com/google_containers/nginx-ingress-controller:v1.8.1
        args:
        - /nginx-ingress-controller
        - --publish-service=$(POD_NAMESPACE)/ingress-nginx-controller
        - --election-id=ingress-nginx-leader
        - --controller-class=k8s.io/ingress-nginx
        - --ingress-class=nginx
        - --configmap=$(POD_NAMESPACE)/ingress-nginx-controller
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
  namespace: ingress-nginx
spec:
  type: NodePort
  ports:
  - port: 80
    targetPort: 80
    nodePort: 30080
    name: http
  - port: 443
    targetPort: 443
    nodePort: 30443
    name: https
  selector:
    app.kubernetes.io/name: ingress-nginx
```

> 上述 YAML 仅展示核心差异部分，完整清单还包含 Namespace、SA、RBAC、IngressClass、Admission Webhook 等资源。

**2. 应用部署**

```bash
kubectl apply -f mode1-deployment-nodeport.yaml
```

**3. 等待 Pod 就绪**

```bash
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/instance=ingress-nginx \
  --timeout=120s
```

**4. 部署测试应用并验证**

```bash
kubectl apply -f test-ingress.yaml

# 验证：通过任意节点 IP:30080 访问
curl http://117.50.174.70:30080/demo -H 'Host: test.local'
curl http://117.50.248.154:30080/demo -H 'Host: test.local'
curl http://117.50.180.164:30080/demo -H 'Host: test.local'
```

### 验证结果

```
$ kubectl get deploy -n ingress-nginx
NAME                       READY   UP-TO-DATE   AVAILABLE   AGE
ingress-nginx-controller   2/2     2            2           3m28s

$ kubectl get svc -n ingress-nginx
NAME                         TYPE        CLUSTER-IP       PORT(S)
ingress-nginx-controller     NodePort    10.103.193.97    80:30080/TCP,443:30443/TCP

$ kubectl get ingress
NAME           CLASS   HOSTS   ADDRESS         PORTS   AGE
demo-ingress   nginx   *       10.103.193.97   80      55s
```

三个节点均通过 30080 端口正常响应 echoserver 页面。

### 清理环境

```bash
kubectl delete -f test-ingress.yaml --ignore-not-found
kubectl delete -f mode1-deployment-nodeport.yaml --ignore-not-found
kubectl delete ns ingress-nginx --ignore-not-found
kubectl delete clusterrole ingress-nginx ingress-nginx-admission --ignore-not-found
kubectl delete clusterrolebinding ingress-nginx ingress-nginx-admission --ignore-not-found
kubectl delete validatingwebhookconfiguration ingress-nginx-admission --ignore-not-found
kubectl delete ingressclass nginx --ignore-not-found
```

---

## 模式二：DaemonSet + HostNetwork

### 架构图

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

### 部署步骤

**1. 创建完整资源清单**

核心差异点：
- 工作负载类型为 `DaemonSet`
- Pod 配置 `hostNetwork: true` 和 `dnsPolicy: ClusterFirstWithHostNet`
- 添加 `tolerations` 允许调度到 control-plane 节点
- Service 类型为 `ClusterIP`（不需要 NodePort，直接访问宿主机端口）
- 启动参数移除 `--publish-service`，添加 `--report-node-internal-ip-address`
- **注意**：宿主机 80/443 端口不能被占用

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
  template:
    spec:
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      containers:
      - name: controller
        image: registry.cn-hangzhou.aliyuncs.com/google_containers/nginx-ingress-controller:v1.8.1
        args:
        - /nginx-ingress-controller
        - --election-id=ingress-nginx-leader
        - --controller-class=k8s.io/ingress-nginx
        - --ingress-class=nginx
        - --configmap=$(POD_NAMESPACE)/ingress-nginx-controller
        - --report-node-internal-ip-address
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
  namespace: ingress-nginx
spec:
  type: ClusterIP
  ports:
  - port: 80
    targetPort: 80
    name: http
  - port: 443
    targetPort: 443
    name: https
  selector:
    app.kubernetes.io/name: ingress-nginx
```

**2. 应用部署**

```bash
kubectl apply -f mode2-daemonset-hostnetwork.yaml
```

**3. 验证**

```bash
# 检查 Pod：注意 IP 为节点 IP（hostNetwork 模式）
kubectl get pods -n ingress-nginx -o wide

# 直接访问节点 80 端口（无需指定 NodePort）
curl http://117.50.174.70/demo -H 'Host: test.local'
curl http://117.50.248.154/demo -H 'Host: test.local'
curl http://117.50.180.164/demo -H 'Host: test.local'
```

### 验证结果

```
$ kubectl get ds -n ingress-nginx
NAME                       DESIRED   CURRENT   READY   NODE SELECTOR
ingress-nginx-controller   3         3         3       kubernetes.io/os=linux

$ kubectl get pods -n ingress-nginx -o wide
NAME                             READY   STATUS    IP             NODE
ingress-nginx-controller-4x7gr   1/1     Running   10.60.21.65    master
ingress-nginx-controller-btrr2   1/1     Running   10.60.177.72   node02
ingress-nginx-controller-skqdr   1/1     Running   10.60.72.252   node01

$ kubectl get ingress
NAME           CLASS   HOSTS   ADDRESS                                 PORTS   AGE
demo-ingress   nginx   *       10.60.177.72,10.60.21.65,10.60.72.252   80      29s
```

关键观察：
- Pod IP = 节点内网 IP（hostNetwork 直接使用宿主机网络命名空间）
- Ingress ADDRESS 列出所有节点 IP
- 三个节点均通过 80 端口直接响应

### 清理环境

```bash
kubectl delete -f test-ingress.yaml --ignore-not-found
kubectl delete -f mode2-daemonset-hostnetwork.yaml --ignore-not-found
kubectl delete ns ingress-nginx --ignore-not-found
kubectl delete clusterrole ingress-nginx ingress-nginx-admission --ignore-not-found
kubectl delete clusterrolebinding ingress-nginx ingress-nginx-admission --ignore-not-found
kubectl delete validatingwebhookconfiguration ingress-nginx-admission --ignore-not-found
kubectl delete ingressclass nginx --ignore-not-found
```

---

## 模式三：DaemonSet + NodePort

### 架构图

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

### 部署步骤

**1. 创建完整资源清单**

核心差异点：
- 工作负载类型为 `DaemonSet`（每节点一个副本）
- Service 类型为 `NodePort`（通过 iptables DNAT 转发）
- 添加 `tolerations` 允许调度到 control-plane 节点
- 启动参数包含 `--publish-service`

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
  template:
    spec:
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      containers:
      - name: controller
        image: registry.cn-hangzhou.aliyuncs.com/google_containers/nginx-ingress-controller:v1.8.1
        args:
        - /nginx-ingress-controller
        - --publish-service=$(POD_NAMESPACE)/ingress-nginx-controller
        - --election-id=ingress-nginx-leader
        - --controller-class=k8s.io/ingress-nginx
        - --ingress-class=nginx
        - --configmap=$(POD_NAMESPACE)/ingress-nginx-controller
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
  namespace: ingress-nginx
spec:
  type: NodePort
  ports:
  - port: 80
    targetPort: 80
    nodePort: 30080
    name: http
  - port: 443
    targetPort: 443
    nodePort: 30443
    name: https
  selector:
    app.kubernetes.io/name: ingress-nginx
```

**2. 应用部署**

```bash
kubectl apply -f mode3-daemonset-nodeport.yaml
```

**3. 验证**

```bash
kubectl apply -f test-ingress.yaml

# 验证：通过任意节点 IP:30080 访问
curl http://117.50.174.70:30080/demo -H 'Host: test.local'
curl http://117.50.248.154:30080/demo -H 'Host: test.local'
curl http://117.50.180.164:30080/demo -H 'Host: test.local'
```

### 验证结果

```
$ kubectl get ds -n ingress-nginx
NAME                       DESIRED   CURRENT   READY   NODE SELECTOR
ingress-nginx-controller   3         3         3       kubernetes.io/os=linux

$ kubectl get svc -n ingress-nginx
NAME                         TYPE        CLUSTER-IP      PORT(S)
ingress-nginx-controller     NodePort    10.107.6.100    80:30080/TCP,443:30443/TCP

$ kubectl get pods -n ingress-nginx -o wide
NAME                             READY   STATUS    IP            NODE
ingress-nginx-controller-7pct9   1/1     Running   10.244.2.10   node02
ingress-nginx-controller-mlpkc   1/1     Running   10.244.0.10   master
ingress-nginx-controller-rwrf9   1/1     Running   10.244.1.9    node01
```

关键观察：
- Pod IP 为 Pod 网段 IP（非 hostNetwork，经过 iptables DNAT）
- DaemonSet 在 3 个节点各运行 1 个副本
- 三个节点均通过 30080 端口正常响应

### 清理环境

```bash
kubectl delete -f test-ingress.yaml --ignore-not-found
kubectl delete -f mode3-daemonset-nodeport.yaml --ignore-not-found
kubectl delete ns ingress-nginx --ignore-not-found
kubectl delete clusterrole ingress-nginx ingress-nginx-admission --ignore-not-found
kubectl delete clusterrolebinding ingress-nginx ingress-nginx-admission --ignore-not-found
kubectl delete validatingwebhookconfiguration ingress-nginx-admission --ignore-not-found
kubectl delete ingressclass nginx --ignore-not-found
```

---

## 三种模式实测对比

| 维度 | Deployment + NodePort | DaemonSet + HostNetwork | DaemonSet + NodePort |
|------|----------------------|------------------------|---------------------|
| 工作负载 | Deployment (replicas=2) | DaemonSet | DaemonSet |
| Service | NodePort (30080/30443) | ClusterIP | NodePort (30080/30443) |
| Pod 网络模式 | 普通容器网络 | hostNetwork: true | 普通容器网络 |
| 访问端口 | 节点IP:30080 | 节点IP:80 | 节点IP:30080 |
| Pod IP | Pod 网段 (10.244.x.x) | 节点 IP (10.60.x.x) | Pod 网段 (10.244.x.x) |
| 副本数 | 手动设置 (2) | 自动=节点数 (3) | 自动=节点数 (3) |
| NAT 跳数 | 多一跳 (iptables DNAT) | 零跳 (直达) | 多一跳 (iptables DNAT) |
| 源 IP 保留 | 需配置 externalTrafficPolicy | 天然保留 | 需配置 externalTrafficPolicy |
| 端口冲突 | 无 (使用高端口) | 有 (占用80/443) | 无 (使用高端口) |
| 弹性伸缩 | 支持 HPA | 跟随节点数 | 跟随节点数 |
| 适用场景 | 云上生产、流量波动大 | 裸金属、性能敏感 | 裸金属、端口受限 |

### 命令速查

```bash
# 查看控制器状态
kubectl get pods -n ingress-nginx -o wide

# 查看 Service
kubectl get svc -n ingress-nginx

# 查看 Ingress 规则
kubectl get ingress -A

# 查看 Nginx 配置（进入 Pod）
kubectl exec -n ingress-nginx -it <pod-name> -- cat /etc/nginx/nginx.conf

# 查看 Controller 日志
kubectl logs -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx

# 强制 reload
kubectl exec -n ingress-nginx -it <pod-name> -- nginx -s reload
```
