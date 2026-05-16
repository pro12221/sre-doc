# k8s API组织结构
对外提供 基于 RESTful的接口 封装了对ETCD 的操作
## list-watch机制


Watch：客户端发起一次请求，说“有变化了告诉我，没变化就保持这个连接”。然后这个连接会一直挂着，直到真正有事件发生，服务端才主动推送。没有变化的时候，网络上几乎没有流量，API Server 也几乎不做什么事。


假设一个 1000 个 Node 的集群，每个 Node 上的 kubelet 要同步 Pod 状态。

轮询 (每2秒一次)：

每秒请求数：1000 / 2 = 500 req/s

每天请求数：500 * 3600 * 24 = 4320万次！绝大部分是“没变化”。

API Server 要处理这 4320 万次几乎无用的请求，还要查 etcd。

Watch (长连接)：

请求数：每个 kubelet 建立 1 个 Watch 连接。总共 1000 个长连接。

每天请求数：建立连接时 1 次 List，然后 0 次额外查询。只有当 Pod 被调度、容器退出、健康检查失败等事件发生时，才会有通知（每天可能也就几百上千次事件）。

API Server 只处理了几次 List 和少量事件推送。



连接可能断开：网络抖动、API Server 重启、空闲超时等。解决方案：客户端需要重连。

可能错过事件：如果 Watch 连接断开了一段时间，重新连接后，那段时间内发生的事件就丢了。如果只用 Watch，就会导致状态不一致。

先 List（列举）：客户端启动时，执行一次 LIST 操作，拿到某个资源（如 Pods）的当前完整快照（加一个 ResourceVersion，比如 RV=100）。

再 Watch（监听）：然后发起 WATCH 请求，参数 ?resourceVersion=100，告诉服务器：“从版本 100 之后开始，有任何变化就通知我。”

断线重连：如果 Watch 断开，客户端会记录最后一个收到的 ResourceVersion（比如 RV=150），然后重新 LIST（可选，或直接 Watch from RV=151）。


## API的组织形式
1.分组
2.多版本 
API Group — 逻辑分组
API 资源按功能域划分为不同的 Group，避免所有资源挤在一个扁平命名空间里。
组	路径	说明
核心组（Core/Legacy）	/api/v1	最早的一批资源，没有 Group 名。Pod、Service、ConfigMap、Secret、Node、Namespace 等都在这里
命名组（Named Group）	/apis/{group}/{version}	按功能域组织，如 apps、batch、networking.k8s.io、rbac.authorization.k8s.io
核心组没有 Group 名，访问路径是 /api/v1；命名组统一走 /apis/{group}/{version}，这也是为什么你在 kubectl get --raw 时会看到两种路径前缀。

每个 Group + Version 下包含若干 Resource，Resource 本身还区分：
- 
资源名（Resource Name）：如 deployments、pods（复数形式，也是 API 路径的一部分）
- 
Kind：如 Deployment、Pod（出现在 YAML 的 kind 字段）
- 
Scope：Namespaced（命名空间级，如 Pod）或 Cluster-scoped（集群级，如 Node）
完整的 API 路径结构：
/apis/{group}/{version}/namespaces/{namespace}/{resource}/{name}
举例：
/apis/apps/v1/namespaces/default/deployments/my-app
这表示 apps 组、v1 版本、default 命名空间下的 deployments 资源、名为 my-app。

核心组路径略有不同（少了 /apis/{group} 这一层）：
/api/v1/namespaces/default/pods/my-pod

## kubectl proxy 与直接访问 6443

直接访问 6443 其实可以，只是你通常没有做对认证。

### 直接 curl 6443 会遇到什么

```bash
# 直接打——拒绝，因为没带客户端证书，TLS 握手就失败
curl https://<api-server-ip>:6443/api/v1/pods

# 即使 TLS 过了，没带 Token 也被 401
curl -k https://<api-server-ip>:6443/api/v1/pods
# → Unauthorized
```

要直接访问，你需要自己拼齐三样东西：

```bash
# 用 kubeconfig 里的信息手动构造请求
curl --cacert /path/to/ca.crt \
     --cert /path/to/client.crt \
     --key /path/to/client.key \
     https://<api-server-ip>:6443/api/v1/namespaces/default/pods

# 或者用 Bearer Token
curl --cacert /path/to/ca.crt \
     -H "Authorization: Bearer <your-token>" \
     https://<api-server-ip>:6443/api/v1/namespaces/default/pods
```

这完全可行，只是繁琐——你要自己管理证书路径、Token、CA 验证。

### kubectl proxy 做了什么

`kubectl proxy` 在本地起一个 HTTP 代理（默认 `127.0.0.1:8001`），它自动帮你做了以下事情：

| 你要自己做的 | kubectl proxy 自动处理的 |
|---|---|
| 从 kubeconfig 读取 CA 证书 | ✅ 自动加载 |
| 从 kubeconfig 读取客户端证书/Token | ✅ 自动附加到每个请求 |
| 处理 TLS 证书验证 | ✅ 自动验证服务端证书 |
| 拼接 API 路径（/api/v1/...） | ✅ 你只需 /api/v1/pods |
| 处理 APIServer 的 401/403 重试 | ✅ 自动 |

所以开了 proxy 之后，请求变得极简：

```bash
# 无需任何证书和 Token——proxy 全帮你加了
curl http://127.0.0.1:8001/api/v1/namespaces/default/pods
```

注意协议变成了 HTTP（不是 HTTPS），因为 TLS 终止在 proxy → apiserver 这一段，你到 proxy 之间是明文。这也是为什么 proxy 默认只绑 127.0.0.1——只允许本机访问，避免 Token 泄露。

### 什么时候必须用 proxy

严格来说，从来不是必须的。但有两个场景它特别方便：

1. **Webhook 开发调试**——你在本地跑一个 Webhook 服务，apiserver 需要回调你。但 apiserver 在集群里，你的开发机没有集群内网络可达的地址。`kubectl proxy` 不解决这个问题，但 `kubectl port-forward` 或 `ngrok` 可以。

2. **浏览器访问 API**——浏览器没法方便地携带客户端证书和 Bearer Token。`kubectl proxy` 让你用浏览器直接 `http://localhost:8001` 浏览 API 资源。

### 一句话总结

直接访问 6443 完全可以，只是你要自己带证书和 Token。`kubectl proxy` 是一个认证代理，把 kubeconfig 里的身份信息自动注入每个请求，让你用简单的 HTTP 调用访问 API。它不是网络代理，是认证代理。