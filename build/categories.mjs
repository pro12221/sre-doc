/**
 * SRE Notes — Category metadata (single source of truth)
 * Used by build.mjs to render data.js, RSS, sitemap, and templates.
 *
 * To add a new category:
 *   1. Add an entry below
 *   2. Create the directory MarkDown/{id}/
 *   3. Drop .md files inside — they'll be picked up automatically
 */
export const SITE = {
  title: 'SRE Notes',
  tagline: 'Cloud Native Tech Notes',
  description: '一位 SRE 工程师的云原生、分布式系统、Kubernetes 与可观测性实战笔记。',
  author: 'SRE Notes',
  baseUrl: 'https://sre-note.pages.dev',
  language: 'zh-CN',
  copyrightYear: 2026,
};

export const CATEGORIES = [
  { id: 'kubernetes',     name: 'Kubernetes',     color: '#7DD3FC', desc: '容器编排 · 调度 · 存储' },
  { id: 'ai',             name: 'AI',             color: '#C4B5FD', desc: 'LLM · Agent · NLP' },
  { id: 'bigdata',        name: 'BigData',        color: '#FCA5A5', desc: 'HDFS · Spark · YARN' },
  { id: 'linux',          name: 'Linux',          color: '#FCD34D', desc: '内核 · 性能调优 · 包处理' },
  { id: 'network',        name: 'Network',        color: '#5EEAD4', desc: 'TCP/IP · Overlay · 架构' },
  { id: 'observability',  name: 'Observability',  color: '#86EFAC', desc: '监控 · 指标 · 告警' },
  { id: 'devops',         name: 'DevOps',         color: '#DDD6FE', desc: 'CI/CD · 部署 · 自动化' },
  { id: 'iac',            name: 'IaC',            color: '#FDBA74', desc: 'Terraform · 基础设施即代码' },
];

/** Build a case-insensitive lookup from CATEGORIES for matching directory names. */
export const CATEGORY_BY_DIR = new Map(
  CATEGORIES.map(c => [c.id.toLowerCase(), c])
);

/** Tag keyword rules — extra tags are inferred from article content. */
export const TAG_KEYWORDS = {
  kubernetes: ['kubernetes', 'k8s', 'pod', 'deployment', 'service', 'ingress', 'configmap', 'secret', 'helm', 'admission', 'webhook', 'etcd', 'coredns', 'crd', 'operator', 'rbac'],
  network:    ['tcp', 'udp', 'mtu', 'mss', 'bgp', 'ospf', 'dns', 'http', 'tls', 'vlan', 'vxlan', '链路层', 'ip包', '路由', 'overlay', 'iptables'],
  linux:      ['linux', 'shell', 'bash', 'systemd', 'kernel', 'iptables', 'selinux', 'strace', 'ebpf', 'namespace', 'cgroup', '文件描述符'],
  devops:     ['devops', 'ci/cd', 'jenkins', 'gitlab', 'argocd', 'terraform', 'ansible', 'docker', 'containerd', 'prometheus', 'grafana', '蓝鲸'],
  ai:         ['llm', 'agent', 'nlp', 'transformer', 'embedding', 'rag', 'mcp', 'function calling', '微调', '推理'],
  observability: ['prometheus', 'grafana', 'metrics', 'tracing', 'logging', 'loki', 'tempo', 'alertmanager'],
  iac:        ['terraform', 'pulumi', 'ansible', '基础设施即代码'],
  bigdata:    ['hadoop', 'hdfs', 'spark', 'yarn', 'mapreduce', 'rdd', 'flink', 'hive'],
};