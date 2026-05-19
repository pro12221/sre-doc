# K8s权限管理

## RBAC 机制概述

RBAC（Role-Based Access Control）是 Kubernetes 中控制 API 访问权限的核心机制，从 v1.8 起默认启用。核心思想：**谁（Subject）可以对什么资源（Resource）做什么操作（Verb）**。

当请求到达 API Server 时，RBAC 判定流程：

1. 认证阶段确认请求者身份（User/Group/ServiceAccount）
2. 遍历所有与该身份相关的 RoleBinding / ClusterRoleBinding
3. 检查绑定的 Role / ClusterRole 中的规则是否允许该操作
4. **只要有一条规则匹配即放行，没有匹配则拒绝**

**RBAC 是累加型的**——只能授予权限，不能拒绝。如果需要拒绝某些操作，需配合 `NodeRestriction`、Pod Security Standards 等准入控制实现。

---

## RBAC 核心对象

| 对象 | 作用域 | 说明 |
|---|---|---|
| **Role** | 命名空间内 | 定义一组权限规则，只作用于单个 namespace |
| **ClusterRole** | 集群级别 | 定义集群范围的权限（如节点、PV 等非命名空间资源，或跨所有 namespace 的权限） |
| **RoleBinding** | 命名空间内 | 将 Role 绑定给 Subject（User/Group/ServiceAccount） |
| **ClusterRoleBinding** | 集群级别 | 将 ClusterRole 绑定给 Subject |

关键点：**Role + RoleBinding 限定在 namespace 内，ClusterRole + ClusterRoleBinding 作用于整个集群**。但 ClusterRole 也可以通过 RoleBinding 在某个 namespace 内引用——这时集群级的权限规则会被"收缩"到该 namespace 范围内。

---

## 权限规则结构

一条规则由三部分组成：

```yaml
rules:
- apiGroups: ["", "apps"]       # 资源所属的 API 组（"" 是核心组）
  resources: ["pods", "deployments"]  # 操作的资源类型
  verbs: ["get", "list", "watch"]     # 允许的操作
```

常见 verbs：`get`、`list`、`watch`、`create`、`update`、`patch`、`delete`、`deletecollection`。

还可以用 `resourceNames` 字段进一步限定到特定资源实例，比如只允许访问名为 `my-config` 的 ConfigMap。

---

## Subject 类型

RBAC 中 Subject 有三种类型：

1. **User** — 外部用户，由集群外的认证系统（如 OIDC、证书）管理，K8s 本身不存储 User 对象
2. **Group** — 用户组，同样由外部认证系统提供
3. **ServiceAccount** — K8s 内部身份，Pod 通过挂载 token 自动获取，用于 Pod 内进程访问 API Server

---

## 创建用户实体与凭证

K8s 没有 User API 对象，用户身份完全依赖**外部凭证**来表征。整个流程：**造证书 → 签名 → 写入 kubeconfig → 绑定权限 → 创建 context → 切换使用**。

### 生成用户私钥和 CSR

```bash
# 1. 生成私钥
openssl genrsa -out devuser.key 2048

# 2. 用私钥生成证书签名请求（CSR）
#    -subj 中的 CN 就是 Kubernetes 识别的用户名，O 是组名
openssl req -new -key devuser.key -out devuser.csr \
  -subj "/CN=devuser/O=dev-team/O=developers"
```

关键字段：

- **CN（Common Name）**→ K8s 中的 `User` 名
- **O（Organization）**→ K8s 中的 `Group` 名，可以写多个

### 用集群 CA 签发证书

方式一：直接用 CA 密钥签发（需要拿到 master 节点的 CA 证书和密钥）

```bash
openssl x509 -req -in devuser.csr \
  -CA /etc/kubernetes/pki/ca.crt \
  -CAkey /etc/kubernetes/pki/ca.key \
  -CAcreateserial \
  -out devuser.crt \
  -days 365
```

方式二：通过 CSR 审批流程（适用于云托管集群，拿不到 CA key）

```bash
# 将 CSR base64 编码
cat devuser.csr | base64 | tr -d '\n'
```

```yaml
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: devuser-csr
spec:
  request: <base64 编码的 CSR 内容>
  signerName: kubernetes.io/kube-apiserver-client
  expirationSeconds: 86400
  usages:
  - client auth
```

```bash
# 审批通过
kubectl certificate approve devuser-csr

# 取出签好的证书
kubectl get csr devuser-csr -o jsonpath='{.status.certificate}' | base64 -d > devuser.crt
```

### 创建 RBAC 权限绑定

此时 devuser 还没有任何权限，需要创建 Role + RoleBinding：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: dev-developer
  namespace: dev
rules:
- apiGroups: ["", "apps"]
  resources: ["pods", "deployments", "services"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get"]
```

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: dev-developer-binding
  namespace: dev
subjects:
- kind: User
  name: devuser
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: dev-developer
  apiGroup: rbac.authorization.k8s.io
```

### 在 kubeconfig 中设置凭证

```bash
kubectl config set-credentials devuser \
  --client-certificate=devuser.crt \
  --client-key=devuser.key
```

### 创建 Context 并切换

```bash
# 创建 context
kubectl config set-context devuser-context \
  --cluster=your-cluster-name \
  --user=devuser \
  --namespace=dev

# 切换到新 context
kubectl config use-context devuser-context

# 验证
kubectl auth can-i create deployments
kubectl auth can-i list pods -n dev
```

### 全景流程

```
openssl genrsa → devuser.key (私钥)
        │
        ▼
openssl req -new → devuser.csr (签名请求，CN=devuser)
        │
        ▼
集群 CA 签发 → devuser.crt (用户证书)
        │
        ├──→ kubectl config set-credentials (写入 kubeconfig users 段)
        ├──→ kubectl config set-context    (组合 cluster + user + ns)
        ├──→ Role + RoleBinding            (授予权限)
        ▼
kubectl config use-context → 就可以操作集群了
```

---

## kubeconfig 文件解析

kubeconfig 是 Kubernetes 客户端的配置文件，默认路径 `~/.kube/config`，它本质上就是一组**集群、凭证、上下文**的映射关系。

### 三大顶层段

```yaml
apiVersion: v1
kind: Config
preferences: {}
current-context: devuser-context

clusters:     # 集群列表 —— 去哪访问
- name: my-cluster
  cluster:
    server: https://192.168.1.100:6443
    certificate-authority: /etc/kubernetes/pki/ca.crt

users:        # 凭证列表 —— 用什么身份
- name: devuser
  user:
    client-certificate: /path/to/devuser.crt
    client-key: /path/to/devuser.key

contexts:     # 上下文列表 —— 组合集群和凭证
- name: devuser-context
  context:
    cluster: my-cluster
    user: devuser
    namespace: dev
```

三者的关系：`context = cluster + user + namespace`

### clusters 段

| 字段 | 说明 |
|---|---|
| `server` | API Server 的 URL |
| `certificate-authority` | 集群 CA 证书文件路径，验证 API Server 身份 |
| `certificate-authority-data` | 同上，base64 内嵌 |
| `insecure-skip-tls-verify` | 跳过 TLS 验证，生产环境绝不建议 |

### users 段认证方式

| 认证方式 | 字段 | 适用场景 |
|---|---|---|
| **X.509 证书** | `client-certificate` + `client-key` | 自建集群、用户证书认证 |
| **Token** | `token` | ServiceAccount token、静态 token |
| **OIDC** | `auth-provider` → `oidc` 配置块 | 企业 SSO 对接 |
| **Exec 插件** | `exec` → 命令 + 参数 | 云厂商 CLI 动态获取凭证 |

### contexts 段

同一个 `user` 可以出现在多个 context 中，同一个 `cluster` 也可以配不同 `user`。`namespace` 字段只是默认值，`kubectl -n` 可以覆盖。

### 配置合并与优先级

kubectl 按以下顺序加载配置，后加载的覆盖先加载的：

1. 系统级配置：`/etc/kubernetes/admin.conf`
2. 用户级配置：`~/.kube/config`
3. 指定文件：`KUBECONFIG=/path/a:/path/b`

`KUBECONFIG` 支持多文件，用 `:`（Linux）或 `;`（Windows）分隔。

### 常用操作

```bash
kubectl config view              # 查看完整配置（脱敏）
kubectl config view --raw        # 不脱敏，显示证书原文
kubectl config use-context ctx   # 切换 context
kubectl config current-context   # 查看当前 context
kubectl config set-context --current --namespace=kube-system  # 修改当前 context 的 namespace
```

---

## ServiceAccount 详解

ServiceAccount（SA）是 Kubernetes **内置的身份机制**，专门给集群内部的进程（Pod）使用，让 Pod 里的程序能以确定身份访问 API Server。

### 核心机制

```
Pod 启动
  │
  ├── 自动挂载 SA 的 token 到 /var/run/secrets/kubernetes.io/serviceaccount/
  │     ├── token      ← JWT 令牌
  │     ├── ca.crt     ← 集群 CA 证书
  │     └── namespace  ← 当前命名空间
  │
  └── Pod 内程序用这个 token 调用 API Server
        │
        └── API Server 根据 SA 身份 + RBAC 规则决定是否放行
```

Pod 默认使用所在 namespace 的 `default` SA，除非显式指定。

### 创建与使用

```yaml
# 创建 SA
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-sa
  namespace: dev
```

```yaml
# Pod 中引用 SA
apiVersion: v1
kind: Pod
metadata:
  name: my-app
spec:
  serviceAccountName: my-sa
  automountServiceAccountToken: true  # 默认 true
  containers:
  - name: app
    image: my-app:latest
```

```yaml
# 给 SA 绑定权限
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-sa-reader
  namespace: dev
subjects:
- kind: ServiceAccount
  name: my-sa
  namespace: dev
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

### SA 的身份标识

SA 的完整标识：`system:serviceaccount:{namespace}:{sa-name}`

```bash
kubectl auth can-i list pods \
  --as=system:serviceaccount:dev:my-sa \
  -n dev
```

### Token 演进

| 阶段 | 机制 | 特点 |
|---|---|---|
| **v1.22 之前** | SA 自动关联 Secret，存永久 token | 不过期，泄露即永久风险 |
| **v1.22+** | TokenRequest API 动态签发短期 token | 默认 1 小时过期，Pod 挂载投射卷 |
| **手动创建** | `kubectl create token my-sa` | 按需获取临时 token |

v1.24 起创建 SA 不再自动生成 Secret：

```bash
# 获取临时 token
kubectl create token my-sa -n dev

# 指定有效期
kubectl create token my-sa -n dev --duration=2h
```

### SA vs User

| 维度 | ServiceAccount | User |
|---|---|---|
| 管理方式 | K8s API 对象 | 无 API 对象，外部认证系统管理 |
| 使用者 | Pod 内进程 | kubectl 操作者、CI/CD 系统 |
| 认证方式 | 自动挂载 token / TokenRequest | 证书、OIDC、Webhook 等 |
| 作用域 | 命名空间级别 | 集群级别 |
| RBAC Subject | `kind: ServiceAccount` | `kind: User` 或 `kind: Group` |

---

## 命名空间 SA 与全局权限

**ServiceAccount 永远属于某个 namespace，K8s 不存在集群级别的 SA**。"全局效果"是 RBAC 绑定造成的错觉。

### "全局效果"的来源

SA 本身是局部的，但通过 **ClusterRoleBinding** 可以让一个 namespace 内的 SA 获得跨所有 namespace 的权限：

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: my-sa-global-reader
subjects:
- kind: ServiceAccount
  name: my-sa
  namespace: dev
roleRef:
  kind: ClusterRole
  name: view
  apiGroup: rbac.authorization.k8s.io
```

### 两种绑定方式的区别

| 绑定方式 | 权限范围 | SA 能操作的范围 |
|---|---|---|
| **RoleBinding** + Role | namespace 内 | 只能操作 SA 所在 namespace |
| **RoleBinding** + ClusterRole | namespace 内 | ClusterRole 规则被收窄到 RoleBinding 所在 namespace |
| **ClusterRoleBinding** + ClusterRole | 集群级别 | 可操作所有 namespace + 集群级资源 |

```
SA (namespace: dev)
  │
  ├── RoleBinding(dev) + Role
  │     → 只能操作 dev namespace
  │
  ├── RoleBinding(prod) + ClusterRole
  │     → 规则被限制在 prod namespace
  │
  └── ClusterRoleBinding + ClusterRole
        → 可操作所有 namespace + 集群级资源
```

### kube-system 下的 SA 不是"全局 SA"

`kube-system` 下的 SA（coredns、endpoint-controller 等）只是恰好创建在该 namespace 中，通过 ClusterRoleBinding 获得了集群级权限。放到任何 namespace 都能达到同样效果。

### 实际设计模式

**模式一：每个 namespace 独立 SA + RoleBinding**（最常见，最安全）

不同 namespace 同名 SA 是完全独立的两个身份，权限互不干扰。

**模式二：一个 SA + ClusterRoleBinding**（集群级运维工具、Controller）

适用于 Prometheus、Falco、巡检工具等需要跨 namespace 只读的组件。

**模式三：SA 跨 namespace 引用**

RoleBinding/ClusterRoleBinding 的 subjects 中指定 SA 的 namespace 即可授权。

---

## 排查命令速查

```bash
# 检查某个 SA 是否有特定权限
kubectl auth can-i list pods --as=system:serviceaccount:default:my-sa

# 检查某个 User 的权限
kubectl auth can-i list pods --as=devuser

# 查看 Role 的详细规则
kubectl get role pod-reader -n default -o yaml

# 查看集群中所有 ClusterRoleBinding
kubectl get clusterrolebindings -o wide

# 查看当前身份
kubectl auth whoami
```
