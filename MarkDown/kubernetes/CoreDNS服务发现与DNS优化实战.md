# CoreDNS 服务发现与 DNS 优化实战

## 一、CoreDNS 概述

CoreDNS 是 CNCF 毕业项目，用 Go 语言编写，是 Kubernetes 1.13+ 默认的集群 DNS 服务器（取代了 kube-dns）。其核心设计理念是**插件化架构**——所有 DNS 功能通过插件链（Plugin Chain）实现，每个插件负责一个独立的 DNS 功能。

CoreDNS 在 Kubernetes 中以 Deployment 方式部署在 `kube-system` 命名空间，通常运行 2 个副本，通过名为 `kube-dns` 的 Service 暴露（ClusterIP 默认为 `10.96.0.10`），由 kubelet 在创建 Pod 时自动注入到每个容器的 `/etc/resolv.conf` 中。

---

## 二、CoreDNS 解析流程详解

> 本节用两个具体例子带你走完 CoreDNS 处理 DNS 请求的完整过程，一个查集群内 Service，一个查外部域名。

### 2.1 先理解三个关键概念

在看具体流程之前，先搞清楚三个容易混淆的概念：

**概念一：Corefile 的书写顺序 ≠ 插件执行顺序**

Corefile 中你写插件的顺序，和 CoreDNS 实际执行插件的顺序，是两回事。执行顺序是编译时在 `plugin.cfg` 里写死的。你写 Corefile 时只需要关心"哪些插件参与处理"，不需要关心"谁先谁后"。Kubernetes 默认 Corefile 的插件链执行顺序是：

```
cache → rewrite → kubernetes → hosts → forward
```

（只列了关键的 5 个，完整列表在 2.3 节）

**概念二：插件链的"洋葱模型"**

可以把插件链想象成一个洋葱——请求从外层进入，穿过每一层，在最内层被处理，然后响应从最内层一层层返回外层：

```
请求 →  [cache] → [rewrite] → [kubernetes] → [hosts] → [forward]
                                                          ↓ 找不到
                                                          ↓ 返回给上游
响应 ←  [cache] ← [rewrite] ← [kubernetes] ← [hosts] ← [forward]
```

- `cache` 在最外层：它能看到进出两个方向的所有请求和响应（所以能缓存）
- `kubernetes` 在内层：它负责处理集群内部域名
- `forward` 在最内层：它是最后的兜底，把请求转发到上游 DNS

**概念三：插件处理请求时只有两种选择**

一个插件看到请求后，要么"我处理"，要么"下一个你处理"：

| 行为 | 含义 | 类比 |
|------|------|------|
| 我来处理，不再往下传 | 插件生成响应并返回，插件链到此结束 | 某个部门直接审批了，不需要再往上汇报 |
| 我不处理，传给下一个 | 插件调用 `next.ServeDNS()`，把请求交给下一个插件 | 某个部门说"这不归我管"，转给下一个部门 |

### 2.2 实战例子一：Pod 查询集群内 Service

假设 default 命名空间有一个 Service 叫 `my-svc`，ClusterIP 是 `10.100.1.5`。同一个命名空间的 Pod 执行 `nslookup my-svc`。

**第一步：Pod 内部发起 DNS 查询**

Pod 的 `/etc/resolv.conf` 内容：

```
nameserver 10.96.0.10
search default.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

Pod 要解析 `my-svc`，因为 `my-svc` 包含 0 个点（< 5），所以先追加 search 域：

```
1. 尝试 my-svc.default.svc.cluster.local
2. 尝试 my-svc.svc.cluster.local
3. 尝试 my-svc.cluster.local
4. 尝试 my-svc（裸名称）
```

DNS 查询包最终发送到 `10.96.0.10:53`（kube-dns Service IP）。

**第二步：数据包到达 CoreDNS Pod**

`10.96.0.10` 是 kube-dns Service 的 ClusterIP。kube-proxy 通过 iptables/ipvs 规则，将这个目标 IP 的数据包 DNAT 到某个 CoreDNS Pod 的真实 IP。CoreDNS 监听 53 端口，收到 UDP 包。

**第三步：CoreDNS 内部处理 —— 插件链走一遍**

CoreDNS 拿到请求："请问 `my-svc.default.svc.cluster.local` 的 A 记录是什么？"

现在插件链开始工作：

```
1. cache 插件：我缓存里有这个记录吗？
   → 第一次查询，没有缓存。
   → 行为：我不处理，传给下一个插件。同时我记住这个请求，
     等响应回来时我会存一份到缓存里。

2. rewrite 插件：这个查询名称需要改写吗？
   → 默认配置没有 rewrite 规则。
   → 行为：我不处理，传给下一个。

3. kubernetes 插件：这个域名是 cluster.local 域的吗？
   → 是的！my-svc.default.svc.cluster.local 后缀是 cluster.local。
   → 我从 Kubernetes API 查到了：Service "my-svc" 在 "default" 命名空间，ClusterIP 10.100.1.5。
   → 行为：我处理！生成 A 记录响应：my-svc.default.svc.cluster.local → 10.100.1.5。
   → 插件链到此结束，不再向后传。

   响应原路返回：
   kubernetes → rewrite（不改） → cache（存一份到缓存）
```

**第四步：响应返回给 Pod**

Pod 收到 DNS 响应：`my-svc.default.svc.cluster.local` → `10.100.1.5`。Pod 用这个 IP 连接 Service，kube-proxy 再将流量转发到后端 Pod。

**第二次查询同样的服务**：cache 插件直接命中，不再走 `kubernetes` 插件，延迟从 ~5ms 降到 ~0.01ms。

### 2.3 实战例子二：Pod 查询外部域名

同一个 Pod 执行 `nslookup www.baidu.com`。

**第一步：search 域追加**

`www.baidu.com` 包含 2 个点（< 5），所以先追加 search 域：

```
1. 尝试 www.baidu.com.default.svc.cluster.local
2. 尝试 www.baidu.com.svc.cluster.local
3. 尝试 www.baidu.com.cluster.local
4. 尝试 www.baidu.com（裸名称）
```

前三个都会返回 NXDOMAIN（不存在），只有第四个会成功。这就是为什么 ndots:5 会造成查询放大——一个外部域名查询实际上触发了 4 次 DNS 请求。

**第二步：CoreDNS 插件链处理**（以 www.baidu.com 为例）

```
1. cache 插件：缓存里有 www.baidu.com 吗？
   → 没有。
   → 我不处理，传给下一个。记住这个请求，回来时缓存。

2. rewrite 插件：需要改写吗？
   → 不需要。
   → 我不处理，传给下一个。

3. kubernetes 插件：这个域名是 cluster.local 域的吗？
   → www.baidu.com 不以 cluster.local 结尾。
   → 我不处理，传给下一个。（注意：这里不是 fallthrough，是根本就不接手）

4. hosts 插件：hosts 文件里有这个域名吗？
   → 没有。
   → 我不处理，传给下一个。

5. forward 插件：我是最后一个了，只能我处理。
   → 把请求转发到 /etc/resolv.conf 中配置的上游 DNS（如 8.8.8.8）。
   → 上游 DNS 返回：www.baidu.com → 110.242.68.66
   → 我生成响应。

   响应原路返回：
   forward → hosts → kubernetes → rewrite → cache（存一份）
```

**关键点**：`kubernetes` 插件发现域名不是 `cluster.local` 域，直接跳过了，没有返回 NXDOMAIN。这是因为它没有开启 `fallthrough`——它只对 `cluster.local` 域负责，其他域一律不碰。

### 2.4 插件链完整执行顺序

Kubernetes 默认 Corefile 对应的完整插件链：

```
metadata → tls → timeouts → bind → debug → trace → health → 
prometheus → errors → log → ready → cache → rewrite → header → 
dnssec → loadbalance → kubernetes → file → auto → hosts → 
forward → grpc → import → whoami
```

只关注与查询处理直接相关的 5 个核心插件：

| 顺序 | 插件 | 职责 |
|------|------|------|
| 1 | `cache` | 缓存响应，命中后直接返回，不往下传 |
| 2 | `rewrite` | 改写查询名称（如把外部域名映射到内部 Service） |
| 3 | `kubernetes` | 处理 `cluster.local` 域内的 Service/Pod 记录 |
| 4 | `hosts` | 处理 `/etc/hosts` 格式的静态记录 |
| 5 | `forward` | 兜底：把请求转发到上游 DNS 服务器 |

**理解要点**：`cache` 在最外层，所以它能看到所有请求和响应；`forward` 在最内层，只有前面的插件都不处理时才会走到它。

### 2.5 Kubernetes 默认 Corefile 逐行解读

```nginx
.:53 {
    # 这个 Server Block 处理所有域名（"." 是根 Zone）
    errors
    health { lameduck 5s }
    ready

    kubernetes cluster.local in-addr.arpa ip6.arpa {
        # 负责 cluster.local、反向解析域
        pods insecure       # 为 Pod IP 生成 DNS 记录
        fallthrough in-addr.arpa ip6.arpa
        ttl 30
    }

    prometheus :9153
    forward . /etc/resolv.conf {
        # "." 表示所有域名，/etc/resolv.conf 是上游 DNS 地址
        # 注意：只有前面插件不处理的请求才会走到这里
        max_concurrent 1000
    }
    cache 30
    loop
    reload
    loadbalance
}
```

**这个 Corefile 定义的查询处理逻辑**：

```
查询进来 → 是 cluster.local 域？
              ├─ 是 → kubernetes 插件处理，返回 Service/Pod IP
              └─ 否 → hosts 插件查一下 → forward 转发到上游 DNS
```

每次响应回来时，`cache` 插件都会存一份，下次同样查询直接命中缓存。

---

## 三、在 CoreDNS 中定制自己的解析记录

### 3.1 hosts 插件 — 静态 Hosts 映射

`hosts` 插件从 `/etc/hosts` 格式的文件中读取记录，支持 A、AAAA 和自动 PTR 记录。**适用于静态 IP 映射场景**。

**基本用法**：

```nginx
.:53 {
    hosts {
        10.0.1.100 legacy-db.company.com
        10.0.1.101 legacy-api.company.com
        fallthrough    # 关键：未匹配时继续下一个插件
    }
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    forward . /etc/resolv.conf
    cache 30
}
```

**使用外部文件**：

```yaml
# 创建自定义 hosts ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-custom-hosts
  namespace: kube-system
data:
  customhosts: |
    # 遗留系统
    10.0.1.100 legacy-db.company.com
    10.0.1.101 legacy-api.company.com
    # 测试环境
    172.16.0.50 test-service.company.com
```

```nginx
.:53 {
    hosts /etc/coredns/customhosts {
        fallthrough
        reload 30s    # 每 30 秒检测文件变更
    }
    # ... 其他插件
}
```

**hosts 插件参数说明**：

| 参数 | 说明 |
|------|------|
| `FILE` | hosts 文件路径，默认 `/etc/hosts` |
| `ZONES` | 权威 Zone，默认继承 Server Block 的 Zone |
| `INLINE` | 内联 hosts 条目 |
| `ttl SECONDS` | DNS TTL，默认 3600 秒 |
| `no_reverse` | 禁用自动 PTR 记录生成 |
| `reload DURATION` | 文件重载间隔，默认 5 秒 |
| `fallthrough` | 未匹配时穿透到下一个插件 |

### 3.2 template 插件 — 动态模板生成

`template` 插件是最灵活的定制方式，使用 Go 模板语法根据查询内容动态生成 DNS 响应。**适用于需要根据规则动态生成 DNS 记录的场景**。

**基本语法**：

```nginx
template CLASS TYPE [ZONE...] {
    match REGEX...           # 匹配查询名称的正则表达式
    answer RR                 # 应答记录模板
    additional RR             # 附加记录模板
    authority RR              # 权威记录模板
    rcode CODE                # 响应码（默认 NOERROR）
    fallthrough [ZONES...]    # 未匹配时穿透
}
```

**内置模板变量**：

| 变量 | 说明 |
|------|------|
| `{{ .Zone }}` | 匹配的 Zone 字符串 |
| `{{ .Name }}` | 查询名称（小写） |
| `{{ .Class }}` | 查询类（通常 IN） |
| `{{ .Type }}` | 请求的 RR 类型 |
| `{{ .Match }}` | 正则匹配结果数组 |
| `{{ .Group }}` | 命名捕获组 map |
| `{{ .Remote }}` | 客户端 IP 地址 |
| `{{ .Meta }}` | 元数据函数 |
| `{{ parseInt }}` | 字符串转整数（支持进制转换） |

**示例：为 Pod 生成固定 FQDN 解析记录**：

```nginx
.:53 {
    # 规则：ip-{a}-{b}-{c}-{d}.example.com → A 记录 a.b.c.d
    template IN A example.com {
        match (^|[.])ip-(?P<a>[0-9]*)-(?P<b>[0-9]*)-(?P<c>[0-9]*)-(?P<d>[0-9]*)[.]example[.]com[.]$
        answer "{{ .Name }} 60 IN A {{ .Group.a }}.{{ .Group.b }}.{{ .Group.c }}.{{ .Group.d }}"
        fallthrough
    }

    # 对应的 PTR 反向解析
    template IN PTR in-addr.arpa {
        match ^(?P<d>[0-9]*)\.(?P<c>[0-9]*)\.(?P<b>[0-9]*)\.(?P<a>[0-9]*)\.in-addr\.arpa\.$
        answer "{{ .Name }} 60 IN PTR ip-{{ .Group.a }}-{{ .Group.b }}-{{ .Group.c }}-{{ .Group.d }}.example.com."
    }

    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    forward . /etc/resolv.conf
    cache 30
}
```

**示例：构造 CNAME 记录**：

```nginx
.:53 {
    template IN ANY foogle.com {
        match "^foogle\.com\.$"
        answer "foogle.com 60 IN CNAME google.com"
    }
    forward . 8.8.8.8
}
```

**示例：阻断特定域名（NXDOMAIN）**：

```nginx
.:53 {
    template IN ANY example.com {
        match "blocked\.example\.com\.$"
        rcode NXDOMAIN
        authority "{{ .Zone }} 60 IN SOA ns.example.com hostmaster.example.com (1 60 60 60 60)"
        fallthrough
    }
    forward . 8.8.8.8
}
```

### 3.3 rewrite 插件 — 查询重写

`rewrite` 插件在查询到达后端插件之前修改查询名称，适用于**为 Service 创建外部别名**。

**示例：外部域名映射到集群内部 Service**：

```nginx
.:53 {
    # 重写 foo.example.com → foo.default.svc.cluster.local
    rewrite name foo.example.com foo.default.svc.cluster.local
    kubernetes cluster.local 10.0.0.0/24
    forward . /etc/resolv.conf
    cache 30
}
```

**示例：正则重写（通配符支持）**：

```nginx
.:53 {
    # 所有 *.internal.com → api.internal.com
    rewrite name regex (.+)\.internal\.com api.internal.com
    hosts {
        10.0.1.100 api.internal.com
        fallthrough
    }
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    forward . /etc/resolv.conf
    cache 30
}
```

### 3.4 file 插件 — RFC 1035 Zone 文件

`file` 插件从标准 DNS Zone 文件加载记录，**适用于需要管理大量标准化 DNS 记录的场景**。

```nginx
.:53 {
    kubernetes cluster.local 10.0.0.0/24 {
        fallthrough    # 关键：Kubernetes 未匹配时穿透到 file
    }
    file /etc/coredns/example.db example.org
    forward . /etc/resolv.conf
    cache 30
}
```

Zone 文件示例 (`example.db`)：

```dns
example.org.              IN  SOA   ns.dns.icann.org. hostmaster.icann.org. 2015082541 7200 3600 1209600 3600
example.org.              IN  NS    a.iana-servers.net.
example.org.              IN  NS    b.iana-servers.net.
example.org.              IN  A     127.0.0.1
service.example.org.      IN  SRV   8080 10 10 example.org.
cname.example.org.        IN  CNAME www.example.net.
```

### 3.5 插件选择对比

| 场景 | 推荐插件 | 原因 |
|------|---------|------|
| 少量静态 IP→域名映射 | `hosts` | 最简单，类似 `/etc/hosts` |
| 动态规则生成 DNS 记录 | `template` | 支持正则匹配和 Go 模板 |
| 为 Service 创建外部别名 | `rewrite` | 重写查询名称后由 `kubernetes` 处理 |
| 大量标准化 DNS 记录 | `file` | 标准 Zone 文件格式，支持完整 DNS 记录类型 |
| 跨集群服务发现 | `forward` | 将特定域名转发到其他 DNS 服务器 |

---

## 四、为 Pod 定制固定 FQDN 解析记录

### 4.1 使用场景

在 Kubernetes 中，Pod 默认不拥有固定的 DNS A 记录（除非使用 StatefulSet + Headless Service）。以下场景需要为 Pod 定制固定 FQDN：

- 有状态应用需要基于主机名的服务发现（如 Kafka、ZooKeeper）
- 遗留系统使用固定主机名进行通信
- 测试环境需要模拟特定的 DNS 拓扑

### 4.2 方案一：StatefulSet + Headless Service（官方推荐）

```yaml
apiVersion: v1
kind: Service
metadata:
  name: kafka
spec:
  clusterIP: None       # Headless Service
  selector:
    app: kafka
  ports:
    - port: 9092
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka
spec:
  serviceName: kafka
  replicas: 3
  selector:
    matchLabels:
      app: kafka
  template:
    metadata:
      labels:
        app: kafka
    spec:
      containers:
        - name: kafka
          image: confluentinc/cp-kafka:latest
```

**生成的 DNS 记录**：

| Pod | FQDN |
|-----|------|
| kafka-0 | `kafka-0.kafka.default.svc.cluster.local` |
| kafka-1 | `kafka-1.kafka.default.svc.cluster.local` |
| kafka-2 | `kafka-2.kafka.default.svc.cluster.local` |

### 4.3 方案二：hostAliases（Pod 级）

`hostAliases` 是 Kubernetes 提供的最简单的自定义 DNS 方式——它直接往 Pod 的 `/etc/hosts` 文件里追加条目，不经过 CoreDNS，不经过任何插件，效果等同于你在 Linux 机器上手动执行 `echo "10.0.1.100 legacy-db" >> /etc/hosts`。

**什么原理？**

你熟悉的 Linux `/etc/hosts` 文件是这样的：

```
127.0.0.1   localhost
10.0.1.5    db-server
```

当程序解析 `db-server` 时，系统先查 `/etc/hosts`，找到 `10.0.1.5`，就不会再去查 DNS 了。`hostAliases` 做的是同一件事——kubelet 在创建 Pod 时，把你指定的条目自动写入 Pod 容器的 `/etc/hosts` 文件中。

**具体例子**：这个 Pod 里的程序解析 `my-fixed-host.company.com` 时，会直接拿到 `10.0.1.100`：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-app
spec:
  hostAliases:               # ← 这下面的条目会被写入 /etc/hosts
    - ip: "10.0.1.100"
      hostnames:
        - "my-fixed-host.company.com"
        - "alias.company.com"     # 一个 IP 可以对应多个域名
    - ip: "10.0.1.101"
      hostnames:
        - "another-host.company.com"
  containers:
    - name: app
      image: nginx
```

Pod 启动后，进入容器查看 `/etc/hosts`：

```
# Kubernetes 自动追加的条目
10.0.1.100   my-fixed-host.company.com alias.company.com
10.0.1.101   another-host.company.com
```

**和方案一（CoreDNS hosts 插件）的区别**：

| | hostAliases | CoreDNS hosts 插件 |
|---|---|---|
| 生效范围 | 只对这一个 Pod 生效 | 对集群所有 Pod 生效 |
| 修改后 | 重建 Pod 才生效 | 重启 CoreDNS 即可 |
| 适合场景 | 个别 Pod 需要特殊 DNS 记录 | 全集群都需要同样的记录 |

**典型使用场景**：你的集群里大部分 Pod 走正常的 CoreDNS 解析，但某个 Pod 需要和一个不在 Kubernetes 里的老旧系统通信（那个系统的 IP 是固定的，且没有 DNS 记录），这时候在 Pod 上加一行 `hostAliases` 就行，不影响其他 Pod。

### 4.4 方案三：CoreDNS hosts 插件（集群级）

通过 CoreDNS 的 hosts 插件为所有 Pod 提供固定 DNS 记录：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health
        hosts {
            10.244.1.10 kafka-0.kafka.default.svc.cluster.local
            10.244.1.11 kafka-1.kafka.default.svc.cluster.local
            10.244.1.12 kafka-2.kafka.default.svc.cluster.local
            fallthrough
        }
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
        }
        prometheus :9153
        forward . /etc/resolv.conf
        cache 30
        loop
        reload
        loadbalance
    }
```

### 4.5 方案四：CoreDNS template 插件（动态规则）

使用 template 插件按规则自动生成 Pod 的 DNS 记录：

```nginx
.:53 {
    # 规则：pod-{ns}-{name}.pod.local → 查询 Pod IP
    template IN A pod.local {
        match "^pod-(?P<ns>[^-]+)-(?P<name>.+)[.]pod[.]local[.]$"
        answer "{{ .Name }} 30 IN A 10.244.{{ index .Group "ns" | hash }}.{{ index .Group "name" | hash }}"
        fallthrough
    }
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    forward . /etc/resolv.conf
    cache 30
}
```

### 4.6 方案对比

| 方案 | 作用范围 | 动态性 | 复杂度 | 适用场景 |
|------|---------|--------|--------|---------|
| StatefulSet + Headless | 有状态 Pod | 自动 | 低 | 有状态应用 |
| hostAliases | 单个 Pod | 静态 | 低 | 少量 Pod 的静态映射 |
| hosts 插件 | 全集群 | 手动 | 中 | 集群级静态 DNS 映射 |
| template 插件 | 全集群 | 规则驱动 | 高 | 需要动态生成的 DNS 规则 |

---

## 五、Pod 的四种 DNS 策略

### 5.1 策略概览

| 策略 | 说明 | 使用场景 |
|------|------|---------|
| `ClusterFirst`（默认） | 优先使用集群 DNS，未匹配转发上游 | 绝大多数 Pod |
| `Default` | 继承节点 `/etc/resolv.conf` | 不需要集群内服务发现的 Pod |
| `ClusterFirstWithHostNet` | hostNetwork Pod 使用集群 DNS | 使用 hostNetwork 的监控/网络组件 |
| `None` | 完全自定义 DNS 配置 | 需要完全自定义 DNS 的场景 |

### 5.2 ClusterFirst（默认策略）

**行为**：Pod 的 `/etc/resolv.conf` 由 kubelet 配置，nameserver 指向 `kube-dns` Service IP。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-pod
spec:
  dnsPolicy: ClusterFirst  # 默认值，可省略
  containers:
    - name: app
      image: nginx
```

**容器内 `/etc/resolv.conf`**：

```
nameserver 10.96.0.10
search default.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

**DNS 解析路径**：

```
my-svc → my-svc.default.svc.cluster.local → 集群内 DNS
www.google.com → 匹配 search 域失败 → forward 到上游 DNS
```

**关于 ndots:5**：当域名中的 `.` 数量少于 5 时，会先追加所有 search 域进行尝试。例如 `api.example.com`（2 个点）会依次尝试 `api.example.com.default.svc.cluster.local`、`api.example.com.svc.cluster.local`、`api.example.com.cluster.local`，最后才直接查询 `api.example.com`。**这会导致 4 倍查询放大**。

### 5.3 Default

**行为**：Pod 直接继承所在节点的 `/etc/resolv.conf`，完全绕开集群 DNS。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: node-dns-pod
spec:
  dnsPolicy: Default
  containers:
    - name: app
      image: nginx
```

**特点**：
- 无法解析集群内 Service/Pod 的 DNS 名称
- 只能解析外部域名
- 适合只需要访问外部网络的 Pod

### 5.4 ClusterFirstWithHostNet

**行为**：使用 `hostNetwork: true` 的 Pod 默认会走 `Default` 策略（即使设置了 `ClusterFirst`）。要使 hostNetwork Pod 也能使用集群 DNS，必须显式设置为 `ClusterFirstWithHostNet`。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hostnet-pod
spec:
  hostNetwork: true
  dnsPolicy: ClusterFirstWithHostNet  # 必须显式设置
  containers:
    - name: app
      image: nginx
```

**使用场景**：
- 需要访问宿主机网络又能使用集群 DNS 的组件（如 CNI 插件、监控 agent）
- 需要低网络延迟的应用

### 5.5 None（完全自定义）

**行为**：不使用任何 Kubernetes 预设 DNS 配置，必须通过 `dnsConfig` 完整指定所有 DNS 设置。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: custom-dns-pod
spec:
  dnsPolicy: None
  dnsConfig:
    nameservers:
      - 8.8.8.8
      - 1.1.1.1
    searches:
      - mycompany.local
      - svc.cluster.local
    options:
      - name: ndots
        value: "2"
      - name: timeout
        value: "3"
      - name: attempts
        value: "2"
  containers:
    - name: app
      image: nginx
```

**使用场景**：
- 混合云环境（需要同时使用云 DNS 和集群 DNS）
- 需要对接特定 DNS 解析器的场景
- 精细控制 DNS 查询行为

### 5.6 dnsConfig 增强

所有 DNS 策略（除 `None` 外）都支持通过 `dnsConfig` 追加配置：

```yaml
spec:
  dnsPolicy: ClusterFirst
  dnsConfig:
    nameservers:
      - 192.168.1.100    # 追加内部 DNS 服务器
    searches:
      - internal.company.com  # 追加搜索域
    options:
      - name: ndots
        value: "2"        # 覆盖默认的 ndots:5
      - name: single-request-reopen
        value: ""         # 避免 DNS 竞态条件
```

**ndots 优化建议**：

| 应用类型 | 推荐 ndots | 原因 |
|---------|-----------|------|
| 使用 FQDN 的外部应用 | 1-2 | 减少无意义的 search 域查询 |
| 混合使用短名称和外部域名 | 3-5 | 平衡内外部查询效率 |
| 主要使用集群内短名称 | 5（默认） | 最大化短名称解析便利性 |

---

## 六、CoreDNS 压力测试

### 6.1 测试工具介绍

**dnsperf** 是 Nominum 开发的 DNS 性能测试工具，是业界标准的 DNS 基准测试工具。

- dnsperf：测试权威 DNS 服务器的吞吐量
- resperf：测试缓存 DNS 服务器的解析性能

**安装**：

```bash
# CentOS/RHEL
yum install -y dnsperf

# Ubuntu/Debian
apt-get install -y dnsperf

# 容器化
docker run -it --rm networkstatic/dnsperf dnsperf -h
```

### 6.2 准备测试查询文件

dnsperf 需要指定查询文件，格式为每行一个查询域名：

```bash
# 创建不同类型查询文件
# 集群内部 Service 查询
cat > services.txt << 'EOF'
kubernetes.default.svc.cluster.local A
kube-dns.kube-system.svc.cluster.local A
my-service.default.svc.cluster.local A
EOF

# 外部域名查询
cat > external.txt << 'EOF'
www.google.com A
www.github.com A
www.baidu.com A
EOF

# NXDOMAIN 查询（测试否定缓存）
cat > nxdomain.txt << 'EOF'
nonexistent.cluster.local A
fake-service.default.svc.cluster.local A
EOF
```

### 6.3 运行 dnsperf 测试

**基本测试**：

```bash
# 以 100 QPS 测试 60 秒
dnsperf -s 10.96.0.10 -d services.txt -l 60 -Q 100

# 不限 QPS 的压力测试（直到出现超时）
dnsperf -s 10.96.0.10 -d services.txt -l 60 -c 100

# 参数说明：
# -s : DNS 服务器地址
# -d : 查询数据文件
# -l : 测试持续时间（秒）
# -Q : 目标 QPS
# -c : 并发客户端数
# -t : 超时时间（秒）
```

**使用 Kubernetes 测试 Pod**：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: dnsperf
spec:
  containers:
    - name: dnsperf
      image: networkstatic/dnsperf
      command: ["sleep", "3600"]
```

```bash
# 在 Pod 内执行测试
kubectl exec -it dnsperf -- dnsperf -s 10.96.0.10 -d /queries/services.txt -l 60 -Q 200
```

### 6.4 使用 Kubernetes 官方 DNS 性能测试框架

Kubernetes 官方仓库提供了完整的 DNS 性能测试框架：

```bash
git clone https://github.com/kubernetes/perf-tests.git
cd perf-tests/dns

# 测试集群 DNS
python py/run_perf.py --params params/coredns/default.yaml --out-dir ./out --dns-ip <dns-service-ip>
```

**测试参数示例** (`default.yaml`)：

```yaml
# 运行时长
run_length_seconds: [60]
# CoreDNS CPU 限制
kubedns_cpu: [100m, 200m, 500m]
# 缓存大小
dnsmasq_cache: [0, 10000]
# 最大 QPS
max_qps: [500, 1000, 2000, 3000, null]
# 查询文件类型
query_file: ["nx-domain.txt", "outside.txt", "pod-ip.txt", "service.txt"]
```

### 6.5 关键监控指标

```promql
# CoreDNS 请求速率
sum(rate(coredns_dns_requests_total[5m])) by (server)

# 请求延迟 P99
histogram_quantile(0.99, 
  sum(rate(coredns_dns_request_duration_seconds_bucket[5m])) by (le))

# 缓存命中率
sum(rate(coredns_cache_hits_total[5m])) 
/ 
sum(rate(coredns_dns_requests_total[5m]))

# 上游转发延迟
histogram_quantile(0.99, 
  sum(rate(coredns_forward_request_duration_seconds_bucket[5m])) by (le))

# 错误率
sum(rate(coredns_dns_responses_total{rcode="SERVFAIL"}[5m])) 
/ 
sum(rate(coredns_dns_responses_total[5m]))
```

### 6.6 性能基准参考

| 场景 | 单 CoreDNS Pod QPS | 说明 |
|------|-------------------|------|
| 集群内 Service 查询（缓存命中） | ~8,500 QPS | 缓存命中率高 |
| 集群内 Service 查询（缓存未命中） | ~800-900 QPS | 需要查询 Kubernetes API |
| 外部域名查询 | ~2,200 QPS | 需要上游转发 |
| NXDOMAIN 查询 | ~800 QPS | 依赖否定缓存 |

**CoreDNS 扩展建议**：

| 集群规模 | CoreDNS 副本数 | CPU Request | Memory Request |
|---------|--------------|-------------|----------------|
| 10-50 节点 | 2 | 100m | 64Mi |
| 50-200 节点 | 3-5 | 200m | 128Mi |
| 200+ 节点 | 5-10 | 500m | 256Mi |

---

## 七、NodeLocal DNSCache 介绍

### 7.1 什么是 NodeLocal DNSCache

NodeLocal DNSCache 是 Kubernetes 的集群插件，通过在每个节点上以 DaemonSet 形式运行 DNS 缓存代理，大幅提升 DNS 查询性能。从 Kubernetes 1.18 起 GA，1.15 起 Beta。

### 7.2 为什么需要 NodeLocal DNSCache

**默认 DNS 架构的问题**：

```
Pod → kube-dns Service (ClusterIP) → iptables/ipvs DNAT → CoreDNS Pod
     └── 网络跳转 5-20ms ──────────────────────────────┘
```

1. **网络延迟**：每次 DNS 查询都要经过网络跳转到 CoreDNS Pod（可能在不同节点上）
2. **conntrack 竞争**：UDP DNS 请求经过 iptables DNAT 会在 conntrack 表中创建条目，高 QPS 场景下 conntrack 表可能耗尽
3. **UDP 丢包**：UDP 是无连接协议，超时重试通常为 30 秒（3 次重试 + 10 秒超时）
4. **DNS 查询放大**：每个 Pod 的 DNS 查询都汇聚到 CoreDNS，高 QPS 场景下 CoreDNS 成为瓶颈

**NodeLocal DNSCache 解决方式**：

```
Pod → NodeLocal DNSCache (本地, 0.2ms)
          ↓ (仅缓存未命中时)
       CoreDNS (网络跳转, 5ms)
```

### 7.3 架构原理

```
┌──────────────────────────────────────────────────┐
│ Node A                                           │
│                                                  │
│  Pod A ──→ NodeLocal DNSCache (169.254.20.10)    │
│  Pod B ──→ (DaemonSet Pod, hostNetwork)          │
│              │ 缓存命中？直接返回                 │
│              │ 缓存未命中？                       │
│              │ cluster.local → kube-dns-upstream  │
│              │ 外部域名 → 上游 DNS (/etc/resolv)  │
│              ↓                                   │
│         kube-dns-upstream Service                │
└──────────────────────────────────────────────────┘
                    ↓
          CoreDNS Pod (可能是其他节点)
```

**核心机制**：

1. **DaemonSet 部署**：每个节点运行一个 `node-local-dns` Pod，使用 `hostNetwork: true`
2. **虚拟网卡**：在节点上创建 dummy 接口，绑定链路本地地址 `169.254.20.10/32`（可自定义）
3. **流量拦截**：通过 iptables 规则，将发往 `kube-dns` Service IP 的 DNS 请求重定向到本地 `169.254.20.10:53`
4. **上游分离**：创建单独的 `kube-dns-upstream` Service（与 `kube-dns` 相同端点但不同 IP），供本地缓存访问上游 CoreDNS
5. **TCP 升级**：本地缓存到上游 CoreDNS 的连接使用 TCP（`force_tcp`），避免 UDP conntrack 问题

### 7.4 性能收益

| 指标 | 使用前（CoreDNS Only） | 使用后（NodeLocal） | 提升 |
|------|----------------------|-------------------|------|
| DNS P50 延迟 | 5.2ms | 0.18ms | **29x** |
| DNS P99 延迟 | 28.4ms | 0.45ms | **63x** |
| DNS P999 延迟 | 89.2ms | 1.2ms | **74x** |
| CoreDNS 负载 | 100% | 3-5% | **97% 减少** |
| 缓存命中率 | 30%（本地） | 92%（本地） | **3x** |

**实际生产验证**（Neon 公司报告）：

- CoreDNS 99 分位延迟从 1.5ms 降至 240µs（**84% 改善**）
- CoreDNS 99.9 分位延迟从 10-20ms 降至 <2ms（**87% 改善**）
- CoreDNS Pod 请求量从 ~2,000 req/s 降至 ~60 req/s（**97% 减少**）

---

## 八、NodeLocal DNSCache 部署与压测

### 8.1 部署步骤

**Step 1：获取部署清单**

```bash
# 获取默认配置
wget https://raw.githubusercontent.com/kubernetes/kubernetes/master/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml
```

**Step 2：替换占位变量**

```bash
# 获取集群 DNS Service IP
kubectl get svc kube-dns -n kube-system -o jsonpath='{.spec.clusterIP}'

# 替换占位符
export DNS_SERVICE_IP="10.96.0.10"
export LOCAL_DNS_IP="169.254.20.10"
export DNS_DOMAIN="cluster.local"

sed -i "s/__PILLAR__DNS__SERVER__/$DNS_SERVICE_IP/g" nodelocaldns.yaml
sed -i "s/__PILLAR__LOCAL__DNS__/$LOCAL_DNS_IP/g" nodelocaldns.yaml
sed -i "s/__PILLAR__DNS__DOMAIN__/$DNS_DOMAIN/g" nodelocaldns.yaml
```

**Step 3：修改 kubelet 配置**

```yaml
# /var/lib/kubelet/config.yaml
clusterDNS:
  - 169.254.20.10    # NodeLocal DNS 优先
  - 10.96.0.10       # 降级到 CoreDNS（可选）
clusterDomain: cluster.local
```

**Step 4：部署**

```bash
kubectl apply -f nodelocaldns.yaml

# 验证部署
kubectl get pods -n kube-system -l k8s-app=node-local-dns

# 每个节点应有一个运行的 Pod
kubectl get ds node-local-dns -n kube-system
```

### 8.2 核心配置详解

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-local-dns
  namespace: kube-system
data:
  Corefile: |
    cluster.local:53 {
        errors
        cache {
            success 9984 30    # 成功缓存：最多 9984 条，TTL 30 秒
            denial 9984 5      # 否定缓存：最多 9984 条，TTL 5 秒
            prefetch 10 1m 10% # 预取：前 10 条，TTL 剩余 1 分钟，10% 触发
        }
        reload
        loop
        bind 169.254.20.10
        forward . __PILLAR__CLUSTER__DNS__ {
            force_tcp           # 强制使用 TCP 连接上游
            max_concurrent 1000 # 最大并发连接数
        }
        prometheus :9253
        health 169.254.20.10:8080
        ready 169.254.20.10:8181
    }
    in-addr.arpa:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10
        forward . __PILLAR__CLUSTER__DNS__ {
            force_tcp
        }
        prometheus :9253
    }
    .:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10
        forward . __PILLAR__UPSTREAM__SERVERS__
        prometheus :9253
    }
```

**三个 Server Block 的职责**：

| Server Block | 作用 | 上游 |
|-------------|------|------|
| `cluster.local:53` | 集群内域名（包括 Service 和 Pod） | CoreDNS（`kube-dns-upstream`） |
| `in-addr.arpa:53` | 反向 DNS 解析 | CoreDNS |
| `.:53` | 所有其他域名（外部查询） | 上游 DNS 服务器（如 `/etc/resolv.conf`） |

### 8.3 资源规划

```yaml
resources:
  requests:
    cpu: 25m
    memory: 32Mi
  limits:
    cpu: 100m
    memory: 128Mi
```

**内存估算**：默认缓存大小 10000 条，完全填满约需 30MB。生产环境建议根据实际缓存命中率调整。

### 8.4 NodeLocal DNSCache 压力测试

**测试目标**：对比启用 NodeLocal DNSCache 前后的 DNS 性能。

**测试方法一：直接测试 NodeLocal**

```bash
# 在测试 Pod 中直接向 NodeLocal 地址发送查询
dnsperf -s 169.254.20.10 -d services.txt -l 60 -c 100 -Q 5000

# 测试结果示例
# Queries sent:       2,812,456
# Queries completed:  2,812,456
# Queries lost:       0 (0.00%)
# Average latency:    0.21ms
# Maximum latency:    2.34ms
```

**测试方法二：使用 Kubernetes 官方测试框架**

```bash
cd kubernetes/perf-tests/dns

# 测试 NodeLocal DNSCache
python py/run_perf.py \
  --params params/nodelocaldns/default.yaml \
  --out-dir ./out \
  --nodecache-ip 169.254.20.10

# 对比测试集群 DNS
python py/run_perf.py \
  --params params/nodelocaldns/default.yaml \
  --out-dir ./out \
  --dns-ip <kube-dns-service-ip>
```

**测试方法三：真实负载测试**

```bash
# 从集群中抓取真实的 DNS 查询作为测试数据
# 在 node-local-dns Pod 上进行抓包
kubectl exec -n kube-system node-local-dns-xxxxx -- tcpdump -i any port 53 -w /tmp/dns.pcap

# 提取查询域名
# 在本地用 Wireshark 导出查询列表

# 使用真实查询进行压测
dnsperf -s 169.254.20.10 -d real-queries.txt -l 300 -Q 2000
```

### 8.5 性能对比监控

```promql
# NodeLocal 缓存命中率
sum(rate(coredns_cache_hits_total{server="dns://:53"}[5m]))
/
sum(rate(coredns_dns_requests_total{server="dns://:53"}[5m]))

# NodeLocal DNS 延迟 P99
histogram_quantile(0.99,
  sum(rate(coredns_dns_request_duration_seconds_bucket[5m])) by (le))

# 上游转发延迟
histogram_quantile(0.99,
  sum(rate(coredns_forward_request_duration_seconds_bucket[5m])) by (le))

# 上游连接数
coredns_forward_conn_cache_misses_total
```

### 8.6 告警规则

```yaml
groups:
  - name: node-local-dns
    rules:
      - alert: NodeLocalDNSHighLatency
        expr: |
          histogram_quantile(0.99, 
            sum(rate(coredns_dns_request_duration_seconds_bucket[5m])) by (le)
          ) > 0.01
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "NodeLocal DNS P99 延迟 > 10ms"

      - alert: NodeLocalDNSDown
        expr: up{job="nodelocaldns"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "节点 {{ $labels.node }} 上 NodeLocal DNS 不可用"

      - alert: NodeLocalDNSCacheHitRateLow
        expr: |
          sum(rate(coredns_cache_hits_total[5m]))
          /
          sum(rate(coredns_dns_requests_total[5m])) < 0.5
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "NodeLocal DNS 缓存命中率低于 50%"
```

### 8.7 已知问题与注意事项

1. **GKE + kube-dns 兼容性**：GKE 使用 kube-dns（dnsmasq），其最大工作进程数为 20，与 NodeLocal 的 TCP 连接池可能产生竞争。建议迁移到 Cloud DNS 或 CoreDNS。

2. **kube-proxy 竞态**：`node-local-dns` DaemonSet 和 `kube-dns-upstream` Service 同时创建时，kube-proxy 可能尚未安装 iptables 规则。建议**先部署 Service，再部署 DaemonSet**。

3. **Cilium CNI**：使用 Cilium 时，先部署 DaemonSet，再通过 Local Redirect Policy 将流量重定向到本地 DNS。

4. **hostNetwork Pod**：使用 `hostNetwork: true` 的 Pod 在 Dataplane V2（GKE）可能无法访问集群 DNS，需要额外配置。

5. **内存限制**：务必设置合理的内存上限，避免 OOMKilled 导致 DNS 短暂中断。

---

## 九、总结

### 核心技术选型速查

| 需求 | 推荐方案 |
|------|---------|
| 为 Pod 提供固定 FQDN | StatefulSet + Headless Service |
| 集群级静态 DNS 记录 | CoreDNS hosts 插件 |
| 动态 DNS 规则生成 | CoreDNS template 插件 |
| 外部域名映射到 Service | CoreDNS rewrite 插件 |
| 减少 DNS 延迟 | NodeLocal DNSCache |
| 降低 CoreDNS 负载 | NodeLocal DNSCache + 合理副本数 |
| 优化外部域名查询 | 降低 ndots 值（推荐 2） |
| DNS 性能监控 | Prometheus + Grafana 仪表盘 |

### 架构演进路径

```
阶段一：默认 CoreDNS
  ↓ 集群规模扩大，DNS 延迟增加
阶段二：优化 CoreDNS 配置（副本数、缓存、ndots）
  ↓ DNS 延迟仍不可接受
阶段三：部署 NodeLocal DNSCache
  ↓ 进一步优化
阶段四：调整 NodeLocal 缓存策略 + 告警监控
```

通过合理配置 CoreDNS 和 NodeLocal DNSCache，可以将集群 DNS 延迟从 5-20ms 降低到 0.2ms 以下，同时将 CoreDNS 负载减少 97% 以上。