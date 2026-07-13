/**
 * SRE Notes — Site Data v2
 * Single source of truth for categories, articles, tags.
 * Replaces search-index.js.
 */
window.SREData = (function() {
  var CATEGORIES = [
    { id: 'kubernetes',     name: 'Kubernetes',     color: '#7B91F0', desc: '容器编排 · 调度 · 存储' },
    { id: 'ai',            name: 'AI',             color: '#C084FC', desc: 'LLM · Agent · NLP' },
    { id: 'linux',         name: 'Linux',          color: '#F59E0B', desc: '内核 · 性能调优 · 包处理' },
    { id: 'network',       name: 'Network',        color: '#2DD4BF', desc: 'TCP/IP · Overlay · 架构' },
    { id: 'observability', name: 'Observability',  color: '#34D399', desc: '监控 · 指标 · 告警' },
    { id: 'devops',        name: 'DevOps',         color: '#A78BFA', desc: 'CI/CD · 部署 · 自动化' },
    { id: 'iac',           name: 'IaC',            color: '#FB923C', desc: 'Terraform · 基础设施即代码' }
  ];

  var ARTICLES = [
    { title: 'Admission Webhook 开发', category: 'kubernetes', date: '2026-05-12', tags: ['kubernetes'], excerpt: 'Kubernetes Admission Webhook 机制详解：Mutating / Validating 流程、AdmissionReview 返回格式、Python Flask 实现及证书配置完整指南。', url: 'posts/admission-webhook.html' },
    { title: 'ConfigMap 与 Secret', category: 'kubernetes', date: '2026-05-15', tags: ['kubernetes'], excerpt: 'Kubernetes ConfigMap 和 Secret 详解：创建方式、环境变量引用、卷挂载使用，以及 Secret 内置类型与安全实践。', url: 'posts/configmap-secret.html' },
    { title: 'CoreDNS 服务发现与 DNS 优化实战', category: 'kubernetes', date: '2026-05-18', tags: ['kubernetes', 'network'], excerpt: 'Kubernetes CoreDNS 高级配置：Stub Domains、自定义上游、NodeLocal DNSCache 缓存层、缓存预热与负缓存调优，DNS 延迟从 50ms 降到 1ms 的完整路径。', url: 'posts/coredns-服务发现与-dns-优化实战.html' },
    { title: 'IP包结构与MTU位置', category: 'network', date: '2026-05-15', tags: ['network'], excerpt: 'IP 包结构与 MTU 详解：头部字段含义、MTU 在协议栈中的位置、分片与 PMTUD 机制，以及各层封装的嵌套关系。', url: 'posts/ip包结构与mtu位置.html' },
    { title: 'Harness Engineering 是什么', category: 'ai', date: '2026-05-15', tags: ['ai'], excerpt: '当 AI 智能体取代人类成为代码主要生产者时，工程师从"写代码"转向"设计环境、明确意图、构建反馈回路"，让智能体可靠执行——人类掌舵，智能体执行。', url: 'posts/harness-engineering是什么.html' },
    { title: 'AI常见术语', category: 'ai', date: '2026-05-15', tags: ['ai'], excerpt: 'AI 基础术语详解：拟合与过拟合的区别、符号主义与联结主义的核心思想、权重和偏移量的作用、激活函数引入非线性的必要性。', url: 'posts/ai常见术语.html' },
    { title: 'NLP基础概念', category: 'ai', date: '2026-05-15', tags: ['ai'], excerpt: 'NLP 文本表示进化史：从 VSM 稀疏向量到 N-gram 接龙猜词，再到 Word2Vec 稠密语义向量和 ELMo 语境动态表示，一步步走向现代大模型。', url: 'posts/nlp基础概念.html' },
    { title: 'LLM类型介绍', category: 'ai', date: '2026-05-15', tags: ['ai'], excerpt: '大语言模型分类概览：Base 模型与 Chat 模型的区别、多模态 LLM、Agent 模型、Code 模型，以及提示（Prompting）与微调（Fine-tuning）的差异。', url: 'posts/llm类型介绍.html' },
    { title: '训练微调与强化学习', category: 'ai', date: '2026-05-15', tags: ['ai'], excerpt: 'LLM 三阶段训练范式：预训练、微调、强化学习的核心逻辑，以及将大模型类比操作系统内核的独特视角。', url: 'posts/训练微调与强化学习.html' },
    { title: '大模型怎么练出来', category: 'ai', date: '2026-05-15', tags: ['ai'], excerpt: '从数据准备到模型部署的完整流程：Tokenizer (BPE)、数据清洗八步骤、预训练与后训练 (SFT/RLHF/DPO)、神经网络训练原理与反向传播。', url: 'posts/大模型怎么练出来.html' },
    { title: '模型推理', category: 'ai', date: '2026-05-15', tags: ['ai'], excerpt: 'LLM 推理流程六步走：分词 → 嵌入 → Transformer 计算 → 输出 Logits → 采样 → 自回归生成，逐 token 循环直到结束。', url: 'posts/模型推理.html' },
    { title: 'Function Calling与MCP', category: 'ai', date: '2026-05-15', tags: ['ai'], excerpt: 'LLM 工具调用全链路：Function Calling 五步流程、MCP 标准化协议的客户端/服务器架构、Tool 与 Skill 的区别及技能四要素。', url: 'posts/function-calling与mcp.html' },
    { title: 'CPU软中断高排查记录', category: 'linux', date: '2026-05-15', tags: ['linux'], excerpt: 'KVM 宿主机 CPU 软中断高排查：perf 定位热点、/proc/softirqs 确认 NET_RX 分布不均、RPS 关闭导致软中断无法跨核分流的根因分析与优化方案。', url: 'posts/cpu软中断高排查记录.html' },
    { title: '静态站点自动部署实战', category: 'devops', date: '2026-05-16', tags: ['devops'], excerpt: '从 Markdown 写作到 Cloudflare Pages 上线：GitHub Actions Workflow 配置、Cloudflare Secrets 设置、完整发布流程与故障排查指南。', url: 'posts/静态站点自动部署实战.html' },
    { title: 'k8s API组织结构', category: 'kubernetes', date: '2026-05-16', tags: ['kubernetes'], excerpt: 'Kubernetes API 组织形式详解：Group/Version/Resource 三层结构、list-watch 机制、kubectl proxy 认证代理原理与直接访问 6443 的区别。', url: 'posts/k8s-api组织结构.html' },
    { title: 'K8s权限管理', category: 'kubernetes', date: '2026-05-20', tags: ['kubernetes'], excerpt: 'Kubernetes 权限管理全流程：RBAC 核心对象与判定逻辑、用户证书创建与 CSR 审批、kubeconfig 文件结构解析、ServiceAccount 机制。', url: 'posts/k8s权限管理.html' },
    { title: 'Security Context和Linux Capabilities详解', category: 'kubernetes', date: '2026-05-20', tags: ['kubernetes', 'linux'], excerpt: 'Kubernetes Security Context 核心机制：Linux Capabilities 四组集合与传递规则、Pod/容器级安全配置字段详解、最小权限配置范式。', url: 'posts/security-context和linux-capabilities详解.html' },
    { title: 'Kubernetes Service原理', category: 'kubernetes', date: '2026-05-21', tags: ['kubernetes', 'linux', 'network'], excerpt: 'Kubernetes Service 原理详解：conntrack 连接跟踪与不对称路径问题、iptables/ipvs 两种模式下数据包流转全链路、四种 Service 类型。', url: 'posts/kubernetes-service原理.html' },
    { title: '文件描述符与文件句柄', category: 'linux', date: '2026-05-26', tags: ['linux'], excerpt: 'Linux 文件描述符与文件句柄总结：通过 Python os.open 示例观察 /proc/PID/fd，理解 FD、打开文件对象、inode 与路径的关系。', url: 'posts/文件描述符与文件句柄.html' },
    { title: 'VXLAN 与 GRE 的区别', category: 'network', date: '2026-05-29', tags: ['network'], excerpt: '云数据中心 Overlay 网络补充：从设计目标、封装结构、VNI/Key、ECMP、NAT、防火墙、MTU 与典型场景讲透 VXLAN 和 GRE 的区别。', url: 'posts/vxlan-与-gre的区别.html' },
    { title: '云计算网络架构演进', category: 'network', date: '2026-05-30', tags: ['network'], excerpt: '从经典网络到 VPC、从软件转发到软硬一体化、从数据中心到云边端一体：AWS/阿里云/UCloud 三大厂商网络架构演进。', url: 'posts/云计算网络架构演进.html' },
    { title: 'Ingress 三种部署模式与底层原理', category: 'kubernetes', date: '2026-05-30', tags: ['kubernetes', 'network'], excerpt: 'Kubernetes Ingress 详解：Deployment/DaemonSet+HostNetwork/NodePort 三种部署模式对比、Nginx Ingress Controller 控制循环与 Lua Balancer 原理。', url: 'posts/Ingress三种部署模式与底层原理.html' },
    { title: 'Ingress-Nginx 三种部署模式实战', category: 'kubernetes', date: '2026-05-31', tags: ['kubernetes'], excerpt: '三节点 K8s 集群实战部署 ingress-nginx 三种模式：Deployment+NodePort、DaemonSet+HostNetwork、DaemonSet+NodePort。', url: 'posts/Ingress-Nginx三种部署模式实战.html' },
    { title: 'Ingress-Nginx 高阶用法与流量控制', category: 'kubernetes', date: '2026-05-31', tags: ['kubernetes'], excerpt: 'Ingress-Nginx 金丝雀/蓝绿/灰度/滚动发布全攻略：基于权重、请求头、Cookie、正则的流量控制，TLS 站点构建与 cert-manager 自动证书。', url: 'posts/Ingress-Nginx高阶用法与流量控制.html' },
    { title: 'UCloud Terraform 基础设施自动化', category: 'iac', date: '2026-06-01', tags: ['iac'], excerpt: '使用 Terraform 管理 UCloud 云资源，实现基础设施即代码（IaC）。', url: 'posts/ucloud-terraform-基础设施自动化.html' },
    { title: 'Pod调度与节点选择', category: 'kubernetes', date: '2026-06-06', tags: ['kubernetes'], excerpt: 'Kubernetes 调度全解析：预选优选终选流程、NodeSelector、亲和性/反亲和性、污点容忍、topologySpreadConstraints、Descheduler、PDB、PriorityClass、QoS。', url: 'posts/kubernetes调度.html' },
    { title: 'Kubernetes 持久化存储', category: 'kubernetes', date: '2026-06-12', tags: ['kubernetes'], excerpt: 'Kubernetes 持久化存储：PV/PVC/StorageClass 核心概念、Local PV 实战、FlexVolume 到 CSI 演进、UCloud CSI 架构与创建流程实战解析。', url: 'posts/kubernetes-持久化存储.html' },
    { title: 'Prometheus 深入浅出', category: 'observability', date: '2026-06-11', tags: ['observability'], excerpt: 'Prometheus 全链路学习指南：架构原理与源码解析、Pull/Push 模型、Google 四黄金信号与 USE/RED 方法论、K8s 监控实战、PromQL 完整参考与 15+ 实战查询。', url: 'posts/prometheus-深入浅出.html' },
    { title: 'Prometheus 深入浅出', category: 'observability', date: '2026-06-11', tags: ['observability'], excerpt: 'Prometheus 全链路学习指南：架构原理与源码解析、Pull/Push 模型、Google 四黄金信号与 USE/RED 方法论、K8s 监控实战、PromQL 完整参考与 15+ 实战查询。', url: 'posts/prometheus-深入浅出.html' },
    { title: 'iptables、IPVS 与 nftables 详解', category: 'linux', date: '2026-06-21', tags: ['linux', 'network', 'kubernetes'], excerpt: 'Linux 内核三大包处理框架详解：iptables/IPVS/nftables 的 Netfilter hook 机制、内核数据结构、conntrack 状态机、NAT 实现与 kube-proxy 选型。', url: 'posts/iptables-ipvs-nftables详解.html' }
  ];

  // Compute counts
  for (var i = 0; i < CATEGORIES.length; i++) {
    CATEGORIES[i].count = 0;
  }
  for (var j = 0; j < ARTICLES.length; j++) {
    var a = ARTICLES[j];
    for (var k = 0; k < CATEGORIES.length; k++) {
      if (CATEGORIES[k].id === a.category) { CATEGORIES[k].count++; break; }
    }
  }

  // Sort articles by date desc
  ARTICLES.sort(function(a, b) { return b.date.localeCompare(a.date); });

  return {
    categories: CATEGORIES,
    articles: ARTICLES,
    // Helpers
    getByCategory: function(catId) {
      return ARTICLES.filter(function(a) { return a.category === catId; });
    },
    getByTag: function(tag) {
      return ARTICLES.filter(function(a) { return a.tags.indexOf(tag) !== -1; });
    },
    getRecent: function(n) {
      return ARTICLES.slice(0, n || 5);
    },
    findByUrl: function(url) {
      for (var i = 0; i < ARTICLES.length; i++) {
        if (ARTICLES[i].url === url) return ARTICLES[i];
      }
      return null;
    }
  };
})();
