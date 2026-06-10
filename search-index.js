window.SEARCH_INDEX = [
  {
    title: "Admission Webhook 开发",
    desc: "Kubernetes Admission Webhook 机制详解：Mutating / Validating 流程、AdmissionReview 返回格式、Python Flask 实现及证书配置完整指南。",
    tags: ["kubernetes", "python"],
    category: "kubernetes",
    date: "2026-05-12",
    url: "posts/admission-webhook.html"
  },
  {
    title: "ConfigMap 与 Secret",
    desc: "Kubernetes ConfigMap 和 Secret 详解：创建方式、环境变量引用、卷挂载使用，以及 Secret 内置类型与安全实践。",
    tags: ["kubernetes"],
    category: "kubernetes",
    date: "2026-05-15",
    url: "posts/configmap-secret.html"
  },
  {
    title: "IP包结构与MTU位置",
    desc: "IP 包结构与 MTU 详解：头部字段含义、MTU 在协议栈中的位置、分片与 PMTUD 机制，以及各层封装的嵌套关系。",
    tags: ["network"],
    category: "network",
    date: "2026-05-15",
    url: "posts/ip包结构与mtu位置.html"
  },
  {
    title: "Harness Engineering 是什么",
    desc: "当 AI 智能体取代人类成为代码主要生产者时，工程师从'写代码'转向'设计环境、明确意图、构建反馈回路'，让智能体可靠执行——人类掌舵，智能体执行。",
    tags: ["ai"],
    category: "ai",
    date: "2026-05-15",
    url: "posts/harness-engineering是什么.html"
  },
  {
    title: "AI常见术语",
    desc: "AI 基础术语详解：拟合与过拟合的区别、符号主义与联结主义的核心思想、权重和偏移量的作用、激活函数引入非线性的必要性。",
    tags: ["ai"],
    category: "ai",
    date: "2026-05-15",
    url: "posts/ai常见术语.html"
  },
  {
    title: "NLP基础概念",
    desc: "NLP 文本表示进化史：从 VSM 稀疏向量到 N-gram 接龙猜词，再到 Word2Vec 稠密语义向量和 ELMo 语境动态表示，一步步走向现代大模型。",
    tags: ["ai"],
    category: "ai",
    date: "2026-05-15",
    url: "posts/nlp基础概念.html"
  },
  {
    title: "LLM类型介绍",
    desc: "大语言模型分类概览：Base 模型与 Chat 模型的区别、多模态 LLM、Agent 模型、Code 模型，以及提示（Prompting）与微调（Fine-tuning）的差异。",
    tags: ["ai"],
    category: "ai",
    date: "2026-05-15",
    url: "posts/llm类型介绍.html"
  },
  {
    title: "训练微调与强化学习",
    desc: "LLM 三阶段训练范式：预训练、微调、强化学习的核心逻辑，以及将大模型类比操作系统内核的独特视角——Agent 开发就是开发 LLM 上的应用程序。",
    tags: ["ai"],
    category: "ai",
    date: "2026-05-15",
    url: "posts/训练微调与强化学习.html"
  },
  {
    title: "大模型怎么练出来",
    desc: "从数据准备到模型部署的完整流程：Tokenizer (BPE)、数据清洗八步骤、预训练与后训练 (SFT/RLHF/DPO)、神经网络训练原理与反向传播。",
    tags: ["ai"],
    category: "ai",
    date: "2026-05-15",
    url: "posts/大模型怎么练出来.html"
  },
  {
    title: "模型推理",
    desc: "LLM 推理流程六步走：分词 → 嵌入 → Transformer 计算 → 输出 Logits → 采样 → 自回归生成，逐 token 循环直到结束。",
    tags: ["ai"],
    category: "ai",
    date: "2026-05-15",
    url: "posts/模型推理.html"
  },
  {
    title: "Function Calling与MCP",
    desc: "LLM 工具调用全链路：Function Calling 五步流程、MCP 标准化协议的客户端/服务器架构、Tool 与 Skill 的区别及技能四要素。",
    tags: ["ai"],
    category: "ai",
    date: "2026-05-15",
    url: "posts/function-calling与mcp.html"
  },
  {
    title: "CPU软中断高排查记录",
    desc: "KVM 宿主机 CPU 软中断高排查：perf 定位热点、/proc/softirqs 确认 NET_RX 分布不均、RPS 关闭导致软中断无法跨核分流的根因分析与优化方案。",
    tags: ["linux", "network", "devops"],
    category: "linux",
    date: "2026-05-15",
    url: "posts/cpu软中断高排查记录.html"
  },
  {
    title: "静态站点自动部署实战",
    desc: "从 Markdown 写作到 Cloudflare Pages 上线：GitHub Actions Workflow 配置、Cloudflare Secrets 设置、完整发布流程与故障排查指南。",
    tags: ["devops"],
    category: "devops",
    date: "2026-05-16",
    url: "posts/静态站点自动部署实战.html"
  },
  {
    title: "k8s API组织结构",
    desc: "Kubernetes API 组织形式详解：Group/Version/Resource 三层结构、list-watch 机制、kubectl proxy 认证代理原理与直接访问 6443 的区别。",
    tags: ["kubernetes", "network"],
    category: "kubernetes",
    date: "2026-05-16",
    url: "posts/k8s-api组织结构.html"
  },
  {
    title: "Go 值接收者与指针接收者",
    desc: "Go 方法接收者选择策略：值接收者操作副本无法修改原值，指针接收者可修改且避免拷贝，混用导致接口满足混乱，一致性原则要求统一选择。",
    tags: ["go"],
    category: "go",
    date: "2026-05-17",
    url: "posts/go值接收者与指针接收者.html"
  },
  {
    title: "如何理解接口",
    desc: "Go 接口底层双指针结构解析：接口赋值即装箱、类型断言即拆箱、空接口 any 的无条件准入、反射对 type/data 指针的运行时探查，以及 Go 面向对象的组合哲学。",
    tags: ["go"],
    category: "go",
    date: "2026-05-18",
    url: "posts/如何理解接口.html"
  },
  {
    title: "K8s权限管理",
    desc: "Kubernetes 权限管理全流程：RBAC 核心对象与判定逻辑、用户证书创建与 CSR 审批、kubeconfig 文件结构解析、ServiceAccount 机制及命名空间 SA 与全局权限的区别。",
    tags: ["kubernetes", "devops"],
    category: "kubernetes",
    date: "2026-05-20",
    url: "posts/k8s权限管理.html"
  },
  {
    title: "Security Context和Linux Capabilities详解",
    desc: "Kubernetes Security Context 核心机制：Linux Capabilities 四组集合与传递规则、Pod/容器级安全配置字段详解、最小权限配置范式与 Pod Security Standards 三个安全级别。",
    tags: ["kubernetes", "linux"],
    category: "kubernetes",
    date: "2026-05-20",
    url: "posts/security-context和linux-capabilities详解.html"
  },
  {
    title: "Kubernetes Service原理",
    desc: "Kubernetes Service 原理详解：conntrack 连接跟踪与不对称路径问题、iptables/ipvs 两种模式下数据包流转全链路、四种 Service 类型及 Headless Service 使用场景。",
    tags: ["kubernetes", "linux", "network"],
    category: "kubernetes",
    date: "2026-05-21",
    url: "posts/kubernetes-service原理.html"
  },
  {
    title: "文件描述符与文件句柄",
    desc: "Linux 文件描述符与文件句柄总结：通过 Python os.open 示例观察 /proc/PID/fd，理解 FD、打开文件对象、inode 与路径的关系。",
    tags: ["linux", "python"],
    category: "linux",
    date: "2026-05-26",
    url: "posts/文件描述符与文件句柄.html"
  },
  {
    title: "VXLAN 与 GRE 的区别",
    desc: "云数据中心 Overlay 网络补充：从设计目标、封装结构、VNI/Key、ECMP、NAT、防火墙、MTU 与典型场景讲透 VXLAN 和 GRE 的区别。",
    tags: ["network"],
    category: "network",
    date: "2026-05-29",
    url: "posts/vxlan-与-gre的区别.html"
  },
  {
    title: "云计算网络架构演进",
    desc: "从经典网络到 VPC、从软件转发到软硬一体化、从数据中心到云边端一体：AWS/阿里云/UCloud 三大厂商网络架构演进与 SDN、VXLAN、eBPF、DPU 核心技术全解析。",
    tags: ["network", "kubernetes", "devops"],
    category: "network",
    date: "2026-05-30",
    url: "posts/云计算网络架构演进.html"
  },
  {
    title: "Ingress 三种部署模式与底层原理",
    desc: "Kubernetes Ingress 详解：Deployment/DaemonSet+HostNetwork/NodePort 三种部署模式对比、Nginx Ingress Controller 控制循环与 Lua Balancer 原理、TLS 终止与完整请求链路。",
    tags: ["kubernetes", "network"],
    category: "kubernetes",
    date: "2026-05-30",
    url: "posts/Ingress三种部署模式与底层原理.html"
  },
  {
    title: "Ingress-Nginx 三种部署模式实战",
    desc: "三节点 K8s 集群实战部署 ingress-nginx 三种模式：Deployment+NodePort、DaemonSet+HostNetwork、DaemonSet+NodePort，含国内镜像适配、验证结果与清理步骤。",
    tags: ["kubernetes", "network"],
    category: "kubernetes",
    date: "2026-05-31",
    url: "posts/Ingress-Nginx三种部署模式实战.html"
  },
  {
    title: "Ingress-Nginx 高阶用法与流量控制",
    desc: "Ingress-Nginx 金丝雀/蓝绿/灰度/滚动发布全攻略：基于权重、请求头、Cookie、正则的流量控制，TLS 站点构建与 cert-manager 自动证书，流量镜像与生产实战组合案例。",
    tags: ["kubernetes", "network"],
    category: "kubernetes",
    date: "2026-05-31",
    url: "posts/Ingress-Nginx高阶用法与流量控制.html"
  },
  {
    title: "UCloud Terraform 基础设施自动化",
    desc: "使用 Terraform 管理 UCloud 云资源，实现基础设施即代码（IaC）。",
    tags: ["iac", "devops"],
    category: "iac",
    date: "2026-06-01",
    url: "posts/ucloud-terraform-基础设施自动化.html"
  },
  {
    title: "Go 协程与通道",
    desc: "Go 并发编程核心：goroutine 启动与 WaitGroup 同步、无缓冲/带缓冲 channel、close 与 range 遍历、select 多路复用与超时控制、Worker Pool、Pipeline 等常见并发模式及新手避坑指南。",
    tags: ["go"],
    category: "go",
    date: "2026-06-02",
    url: "posts/go-协程与通道.html"
  },
  {
    title: "Go 网络模板与 Web 应用完全指南",
    desc: "面向 Go 初学者的 Web 开发教程：从零搭建 HTTP 服务器、模板引擎、表单处理、完整 Task Manager 项目，进阶 TCP/UDP、gRPC、WebSocket 实战。",
    tags: ["go", "devops", "network"],
    category: "go",
    date: "2026-06-02",
    url: "posts/go-网络模板与-web-应用完全指南.html"
  },
  {
    title: "Pod调度与节点选择",
    desc: "Kubernetes 调度全解析：预选优选终选流程、NodeSelector、亲和性/反亲和性、污点容忍、topologySpreadConstraints、Descheduler、PDB、PriorityClass、QoS、节点压力驱逐。",
    tags: ["kubernetes", "devops"],
    category: "kubernetes",
    date: "2026-06-06",
    url: "posts/kubernetes调度.html"
  },
  {
    title: "Kubernetes 持久化存储",
    desc: "Kubernetes 持久化存储：PV/PVC/StorageClass 核心概念、Local PV 实战、FlexVolume 到 CSI 演进与迁移指南。",
    tags: ["kubernetes", "devops", "linux"],
    category: "kubernetes",
    date: "2026-06-07",
    url: "posts/kubernetes-持久化存储.html"
  },
  {
    title: "Go GMP 原理与调度",
    desc: "Go GMP 并发调度模型详解：从单进程到协程的演进、G/M/P 三角色分工与协作、work stealing 与 hand off 机制、调度全生命周期及 11 个场景实战解析。",
    tags: ["go"],
    category: "go",
    date: "2026-06-07",
    url: "posts/go-gmp-原理与调度.html"
  },
  {
    title: "基于 Etcd 实现分布式锁",
    desc: "Etcd 核心概念与架构详解：Raft 共识算法、MVCC 多版本控制、Lease 租约机制、Watch 事件驱动、分布式锁两种实现模式及 Kubernetes 集群部署实战。",
    tags: ["go", "kubernetes"],
    category: "go",
    date: "2026-06-08",
    url: "posts/基于-etcd-实现分布式锁.html"
  },
  {
    title: "GORM ORM 详解",
    desc: "GORM ORM 完全指南：模型定义与字段权限控制、数据库连接与连接池配置、AutoMigrate 自动迁移、CRUD 全操作与复杂查询、原生 SQL 使用。",
    tags: ["go", "devops"],
    category: "go",
    date: "2026-06-09",
    url: "posts/gorm-orm-详解.html"
  },
  {
    title: "Prometheus 深入浅出",
    desc: "Prometheus 全链路学习指南：架构原理与源码解析、Pull/Push 模型、Google 四黄金信号与 USE/RED 方法论、二进制与 K8s 安装、服务发现与 Relabeling、K8s 监控实战（节点/Pod/PV/网络）、黑盒与白盒监控、四种指标类型详解、PromQL 完整参考与 15+ 实战查询。",
    tags: ["observability", "devops", "kubernetes", "network"],
  category: "observability",
    date: "2026-06-11",
    url: "posts/prometheus-深入浅出.html"
  }
];
