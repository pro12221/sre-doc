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
  }
];
