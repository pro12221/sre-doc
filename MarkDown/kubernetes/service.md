Node IP：Node 节点的 IP 地址
Pod IP: Pod 的 IP 地址
Cluster IP: Service 的 IP 地址

## contrack 是什么
conntrack 是“连接跟踪”（connection tracking）的缩写，顾名思义，它用于跟踪 Linux 内核中的通信连接。需要注意的是，conntrack 跟踪的“连接”不仅限于 TCP 连接，还包括 UDP、ICMP 等类型的连接。当 Linux 系统收到数据包时，conntrack 模块会为其创建一个新的连接记录，并根据数据包的类型更新连接状态，如 NEW、ESTABLISHED 等。

以 TCP 三次握手为例，说明 conntrack 模块的工作原理 ：

客户端向服务器发送一个 TCP SYN 包，发起连接请求。
Linux 系统收到 SYN 包后，conntrack 模块为其创建新的连接记录，并将状态标记为 NEW。
服务器回复 SYN-ACK 包，等待客户端的 ACK。一旦握手完成，连接状态变为 ESTABLISHED。

通过命令 cat /proc/net/nf_conntrack 查看连接记录 新内核（Ubuntu24）使用 conntrack -L

conntrack 连接记录是 iptables 连接状态匹配的基础，也是实现 SNAT 和 DNAT 的前提。我们知道 Kubernetes 的核心组件 kube-proxy，它作用是负责处理集群中的服务（Service）网络流量。它本质上是一个反向代理（即 NAT），当外部请求访问 Service 时，流量会被 DNAT 转发到 PodIP:Port，响应则经过 SNAT 处理。


## conntrack 不对称路径问题

正常情况（客户端与 Pod 在不同主机）
客户端 → [DNAT: ClusterIP → PodIP] → Pod
Pod    → [SNAT: PodIP → NodeIP/ClientIP] → 客户端
数据包来回都经过网络层（iptables/conntrack），DNAT 和 SNAT 各执行一次，conntrack 表中完整记录了这条 NAT 映射，一切正常。
问题场景（客户端与 Pod 在同一主机）
                    同一主机
┌─────────────────────────────────────┐
│  客户端(Namespace A)                │
│       │                             │
│       ▼ 网络层                      │
│  conntrack 执行 DNAT ✓             │
│  ClusterIP → PodIP                  │
│       │                             │
│       ▼ 到达网桥(bridge)            │
│  Pod(Namespace B) 收到请求          │
│       │                             │
│       ▼ Pod 回复                    │
│  网桥发现目标IP在同网桥上           │
│  → 直接二层转发！不经过网络层！     │
│  → conntrack 没被触发              │
│  → SNAT 没执行 ✗                   │
│                                     │
│  客户端收到: 源IP=PodIP (未SNAT)    │
│  但它期望源IP=ClusterIP             │
│  → 包被丢弃，连接失败               │
└─────────────────────────────────────┘
核心矛盾：Linux 网桥在二层（链路层）转发时，如果发现目标 MAC 就在本地，会直接转发，完全跳过网络层——也就跳过了 iptables 和 conntrack。
结果：
- 
去程：经过网络层 → DNAT 正常执行 → conntrack 记录了正向映射
- 
回程：网桥二层直通 → 绕过了网络层 → SNAT 未执行 → conntrack 记录不完整
客户端发出的包目标是 ClusterIP，回来时源地址却是 PodIP，对不上，连接失败。

bridge-nf-call-iptables 的作用
这个 sysctl 参数
sysctl net.bridge.bridge-nf-call-iptables = 1
含义：让网桥在转发数据包时，也经过 iptables 处理。
设置后，即使网桥在二层转发，也会"向上"触发一次 iptables 匹配，conntrack 就能正确执行 SNAT，保证来回的 NAT 映射完整。
bridge-nf-call-iptables = 0 (默认):
  网桥二层转发 → 跳过 iptables → SNAT 丢失 → 连接断裂
bridge-nf-call-iptables = 1:
  网桥二层转发 → 触发 iptables → SNAT 执行 → 连接正常



## 一、Kubernetes Service 原理
1.1 Service 解决的核心问题
Pod 是临时的——每次重建 IP 都会变。Service 在一组 Pod 前面提供一个*稳定的虚拟 IP (ClusterIP)*，客户端只需访问这个 VIP，不需要关心后端 Pod 的变化。
Service 不转发数据包。它本质上是 kube-proxy 在每个节点上编写的一组内核规则，由 Linux 内核完成实际的 DNAT（目标地址转换）。"kube-proxy" 这个名字是历史遗留——早期版本确实在用户空间做 TCP 代理转发，但那个模式早已废弃。
1.2 四种 Service 类型
类型	访问范围	原理
ClusterIP	集群内部	分配一个虚拟 IP，仅在集群内可达
NodePort	集群外部 → 节点端口	在每个节点上开放一个端口（30000-32767），流量 DNAT 到 ClusterIP 再到 Pod
LoadBalancer	集群外部 → 云厂商 LB	云厂商提供外部 LB，将流量导流到 NodePort
ExternalName	集群内部 → 外部服务	返回 CNAME 记录，不涉及 iptables/IPVS 规则
1.3 数据包流转过程（以 ClusterIP 为例）
Pod A → 访问 10.96.0.10:8080 (Service ClusterIP)
       ↓
内核 PREROUTING → KUBE-SERVICES 链
       ↓
匹配 ClusterIP → 跳转 KUBE-SVC-XXXX 链（负载均衡选择 endpoint）
       ↓
跳转 KUBE-SEP-YYYY 链 → DNAT: 10.96.0.10:8080 → 172.16.0.5:8080 (Pod IP)
       ↓
内核重新路由 → 同节点走 CNI veth / 跨节点走 CNI overlay
       ↓
Pod B 收到请求（源 IP 是 Pod A 的 IP）
       ↓
响应返回 → conntrack 表记住 DNAT 映射，自动反向 un-DNAT
关键点：已建立的连接由 conntrack 表直接处理，不再遍历 iptables 规则链。这就是为什么同一连接的后续包速度很快。

## Service 动态感知机制
kube-proxy 通过 client-go 的 Informer 机制监听 API Server 的资源变化，不直接轮询。
API Server ──Watch──→ Informer (Service/EndpointSlice)
                          ↓ OnServiceUpdate / OnEndpointSliceUpdate
                    ChangeTracker (serviceChanges / endpointsChanges)
                          ↓ 积累变更
                    syncRunner.Run() → syncProxyRules()
                          ↓
                    更新 iptables 规则 / IPVS virtual server




一、查看当前环境使用的模式
kubectl get configmap kube-proxy -n kube-system -o yaml | grep mode
输出含义：
- 
mode: "" 或 mode: "iptables" → iptables 模式
- 
mode: "ipvs" → IPVS 模式
- 
mode: "nftables" → nftables 模式

## iptables 模式
kube-proxy 在 iptables 的 nat 表中构建以下自定义链：
PREROUTING → KUBE-SERVICES        # 入口链，所有进入节点的包先经过这里
               ↓ 匹配 Service
           KUBE-SVC-XXXX           # Service 链，每 Service 一个
               ↓ 概率选择
           KUBE-SEP-YYYY           # Endpoint 链，每 endpoint 一个
               ↓ DNAT
           目标 Pod IP
OUTPUT → KUBE-SERVICES            # 本节点发出的包也经过同样链
KUBE-POSTROUTING → SNAT/MASQUERADE # 回包时的源地址转换

## ipvs 模式
IPVS (IP Virtual Server) 是 Linux 内核 2.4 起内置的四层负载均衡器，专门为负载均衡设计，与 iptables 防火墙定位完全不同。
Virtual Server: 10.96.0.10:8080  (Service ClusterIP)
  ├── Real Server: 172.16.0.5:8080  (Pod 1)
  ├── Real Server: 172.16.0.8:8080  (Pod 2)
  └── Real Server: 172.16.0.9:8080  (Pod 3)


## 流量通信流程
3 个 Service:
  1. default/kubernetes       10.96.0.1:443/TCP   → 1个后端
  2. kube-system/kube-dns     10.96.0.10:53/UDP   → 2个后端
  3. kube-system/kube-dns     10.96.0.10:53/TCP   → 2个后端
  4. kube-system/kube-dns     10.96.0.10:9153/TCP → 2个后端（metrics）

第一层：入口 KUBE-SERVICES
Chain KUBE-SERVICES
KUBE-SVC-JD5MR3NA4I4DYORP  tcp  0.0.0.0/0 → 10.96.0.10  tcp dpt:9153  /* kube-dns:metrics */
KUBE-SVC-NPX46M4PTMTKRN6Y  tcp  0.0.0.0/0 → 10.96.0.1   tcp dpt:443   /* kubernetes:https */
KUBE-SVC-TCOU7JCQXEZGVUNU  udp  0.0.0.0/0 → 10.96.0.10  udp dpt:53    /* kube-dns:dns */
KUBE-SVC-ERIFXISQEP7F7OF4  tcp  0.0.0.0/0 → 10.96.0.10  tcp dpt:53    /* kube-dns:dns-tcp */
KUBE-NODEPORTS              ...  /* 最后一条，处理 NodePort */
这就是一个 switch-case：数据包进来后，从上到下逐条匹配目标 IP+端口，命中就跳到对应的 KUBE-SVC-* 链。

第二层：负载均衡 KUBE-SVC-*
以 kube-dns:dns（UDP 53）为例：
Chain KUBE-SVC-TCOU7JCQXEZGVUNU
KUBE-MARK-MASQ  udp  !10.244.0.0/16 → 10.96.0.10  udp dpt:53
KUBE-SEP-YIL6JZP7A3QYXJU2  probability 0.50000000000  → 10.244.0.2:53
KUBE-SEP-6E7XQMQ4RAYOWTTM  (剩余直接命中)             → 10.244.0.3:53
翻译成人话：
1. 如果源 IP 不在 Pod 网段(10.244.0.0/16)，打上 SNAT 标记（后续回包要改源地址）
2. 50% 概率 → 跳 KUBE-SEP-YIL6JZP7A3QYXJU2（CoreDNS Pod 10.244.0.2）
3. 剩下 50% → 跳 KUBE-SEP-6E7XQMQ4RAYOWTTM（CoreDNS Pod 10.244.0.3）
*这就是 iptables 的"负载均衡"*——用概率做随机选择，2 个 Pod 就各 50%。

第三层：DNAT KUBE-SEP-*
Chain KUBE-SEP-YIL6JZP7A3QYXJU2   /* → 10.244.0.2:53 */
KUBE-MARK-MASQ  0  --  10.244.0.2  0.0.0.0/0   /* 自己访问自己时标记 SNAT */
DNAT            17 --  0.0.0.0/0   0.0.0.0/0    udp to:10.244.0.2:53
两条规则：
1. 
-s 10.244.0.2：如果源 IP 正好是这个 Pod 自己（hairpin 场景：Pod 通过 Service IP 访问自己），打上 MASQ 标记
2. 
DNAT：把目标地址从 10.96.0.10:53 改成 10.244.0.2:53——这是最核心的动作


假设一个 Pod 10.244.0.5 发起 DNS 查询 → 10.96.0.10:53/UDP：
10.244.0.5 发包 → 目标 10.96.0.10:53/UDP
│
├─→ PREROUTING (nat 表)
│      规则: -j KUBE-SERVICES
│
├─→ KUBE-SERVICES
│      第1条: 10.96.0.10:9153/TCP? ❌ (端口不对)
│      第2条: 10.96.0.1:443/TCP?    ❌ (IP不对)
│      第3条: 10.96.0.10:53/UDP?    ✅ 命中!
│      跳转 → KUBE-SVC-TCOU7JCQXEZGVUNU
│
├─→ KUBE-SVC-TCOU7JCQXEZGVUNU
│      第1条: KUBE-MARK-MASQ, 源不在 10.244.0.0/16?
│              源是 10.244.0.5，在 Pod 网段内 → ❌ 跳过
│      第2条: probability 0.5 → KUBE-SEP-YIL6JZP7A3QYXJU2
│              假设随机命中 → 跳转
│
├─→ KUBE-SEP-YIL6JZP7A3QYXJU2
│      第1条: -s 10.244.0.2 → 源是 10.244.0.5 ≠ 10.244.0.2 → ❌ 跳过
│      第2条: DNAT udp to:10.244.0.2:53 → ✅ 执行!
│
│  DNAT 完成: 10.96.0.10:53 → 10.244.0.2:53
│  conntrack 记录映射关系
│
├─→ 内核路由: 10.244.0.2 在本节点 → 赋给 CoreDNS Pod
│
├─→ CoreDNS (10.244.0.2) 收到请求，处理 DNS 查询
│
├─→ 回包: 10.244.0.2:53 → 10.244.0.5
│      conntrack 自动 un-DNAT: 改写源地址 10.244.0.2:53 → 10.96.0.10:53
│
└─→ Pod 10.244.0.5 收到回复，看起来就像 Service IP 直接回的

## ipvs通信流程
IPVS 模式下，kube-proxy 会创建一个 dummy 网络接口，把所有 ClusterIP 绑上去：
# IPVS 模式下你能看到这个
ip addr show kube-ipvs0
3: kube-ipvs0: <BROADCAST,NOARP> mtu 1500
    inet 10.96.0.1/32 scope link kube-ipvs0
    inet 10.96.0.10/32 scope link kube-ipvs0
为什么要这么做？ 内核收到目标地址是 10.96.0.10 的包时，先检查"这个 IP 是不是本机的？"如果本机没有任何接口绑这个 IP，内核会直接把包转走或丢弃，IPVS 根本没机会拦截。绑到 kube-ipvs0 上后，内核认为这是本机地址，交由 IPVS 处理。
完整通信流程
Pod A (10.244.0.5) 发包 → 目标 10.96.0.10:53/UDP
│
│  ❶ PREROUTING (nat 表)
│
├─→ KUBE-SERVICES 链
│      注意！IPVS 模式下这条链里只有少量 iptables 规则
│      不做 Service 路由！不做 DNAT！
│      只处理:
│        - masquerade-all 场景的 SNAT 标记
│        - NodePort 的 masquerade
│        - LoadBalancer 的 source range 过滤
│      这些都是用 ipset 匹配，规则数量恒定（约 10 条）
│
│  ❷ ip_vs 内核模块接管（关键！）
│
├─→ 内核发现目标 10.96.0.10 是本地地址（kube-ipvs0 上绑了）
│     → 交给 ip_vs 模块处理
│
├─→ ip_vs 哈希查找: key = 10.96.0.10:53/UDP
│     → 命中 Virtual Server
│     → 时间复杂度 O(1)，跟集群里有多少 Service 无关
│
├─→ ip_vs 调度算法选择 Real Server
│     假设调度算法是 rr（轮询），选到 10.244.0.2:53
│
│  ❸ ip_vs 执行 DNAT
│
├─→ DNAT: 10.96.0.10:53 → 10.244.0.2:53
│     ip_vs 连接表记录: {原目标: 10.96.0.10:53, 实际: 10.244.0.2:53}
│
├─→ 内核路由: 10.244.0.2 在本节点 → 赋给 CoreDNS Pod
│
│  ❹ CoreDNS 回包
│
├─→ 回包: 10.244.0.2:53 → 10.244.0.5
│     ip_vs 连接表自动 un-DNAT: 源地址 10.244.0.2:53 → 10.96.0.10:53
│
└─→ Pod A 收到回复，源地址看起来来自 10.96.0.10:53


## Service 的几种类型
1. ClusterIP（默认类型）
在集群内部暴露服务，分配一个集群内部可达的虚拟 IP，集群外部无法访问。
apiVersion: v1
kind: Service
metadata:
  name: my-clusterip
spec:
  type: ClusterIP          # 可省略，默认值
  selector:
    app: my-app
  ports:
    - port: 80             # Service 暴露的端口
      targetPort: 8080     # Pod 容器端口
流量路径： Client → ClusterIP:80 → kube-proxy(iptables/ipvs) → Pod:8080
适用场景：
- 
微服务间内部通信（如 API → DB）
- 
只需集群内可达的服务
- 
不需要外部访问的后端服务


2. NodePort
在 ClusterIP 基础上，在每个 Node 上开放一个静态端口（默认范围 30000-32767），集群外部可通过 <NodeIP>:<NodePort> 访问。
apiVersion: v1
kind: Service
metadata:
  name: my-nodeport
spec:
  type: NodePort
  selector:
    app: my-app
  ports:
    - port: 80             # ClusterIP 上的端口（集群内部访问）
      targetPort: 8080     # Pod 容器端口
      nodePort: 30080      # Node 上暴露的端口（外部访问），不指定则自动分配
流量路径： Client → NodeIP:30080 → kube-proxy → Pod:8080
适用场景：
- 
开发/测试环境快速暴露服务
- 
没有外部负载均衡器的环境
- 
需要从集群外部直接访问，但不需要生产级流量管理
注意： 生产环境通常不直接用 NodePort，端口范围受限且暴露所有 Node IP，安全性和可用性不足。


3. LoadBalancer
在 NodePort 基础上，向云厂商请求一个外部负载均衡器（ELB/SLB/Cloud Load Balancer），是生产环境暴露服务到外部的标准方式。
apiVersion: v1
kind: Service
metadata:
  name: my-loadbalancer
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"  # 云厂商特定注解
spec:
  type: LoadBalancer
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 8080
  loadBalancerIP: 1.2.3.4   # 可选，指定外部 IP（部分云厂商支持）
流量路径： Client → CloudLB(ExternalIP) → NodeIP:NodePort → kube-proxy → Pod:8080
层级关系： LoadBalancer 包含 NodePort，NodePort 包含 ClusterIP。三种端口同时存在：
端口	作用域	访问者
targetPort	Pod 内	Service→Pod
port	集群内	ClusterIP:port
nodePort	节点上	NodeIP:nodePort
ExternalIP	外部	LoadBalancer→Node
适用场景：
- 
云上生产环境对外暴露 HTTP/HTTPS 服务
- 
需要自动高可用和健康检查
注意： 每个LoadBalancer Service 都会创建一个云厂商 LB 实例，成本较高。如果服务多，考虑 Ingress 替代。

4. ExternalName
不做流量代理，只返回一个 CNAME 记录，将集群内服务名映射到外部 DNS 名。没有 selector，没有 Endpoint，纯 DNS 别名。
apiVersion: v1
kind: Service
metadata:
  name: external-db
spec:
  type: ExternalName
  externalName: db.prod.example.com   # 外部 DNS 名称
效果： 集群内 Pod 访问 external-db.default.svc.cluster.local → DNS CNAME → db.prod.example.com
适用场景：
- 
引用集群外部的服务（RDS、外部 API）
- 
迁移阶段：外部服务暂时用 ExternalName 引用，后续迁入集群后改为普通 Service
- 
统一服务发现入口，屏蔽外部服务的实际地址

5. Headless Service（ClusterIP: None）
不是一种独立的 type，而是 ClusterIP 设为 None 的特殊用法。不分配虚拟 IP，DNS 直接返回所有就绪 Pod 的 IP。
apiVersion: v1
kind: Service
metadata:
  name: my-headless
spec:
  clusterIP: None           # 关键：设为 None
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 8080
DNS 行为差异：
Service 类型	DNS 查询结果
普通 ClusterIP	返回 ClusterIP（一个虚拟 IP）
Headless (clusterIP: None)	返回所有就绪 Pod 的 A 记录（多个真实 IP）
适用场景：
- 
StatefulSet：每个 Pod 需要稳定的网络标识（pod-name.headless-svc.namespace.svc.cluster.local）
- 
数据库集群（MySQL、PostgreSQL、Redis Sentinel）主从需要独立寻址
- 
服务端服务发现：客户端需要知道所有实例地址，自行做负载均衡