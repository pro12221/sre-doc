# iptables、IPVS 与 nftables 详解：从安装使用到内核收发包全流程

本文系统梳理 Linux 内核网络三大包处理框架——**iptables**、**IPVS**、**nftables**，覆盖安装、基本使用、底层原理、内核收发包路径，并分析它们在 Kubernetes（kube-proxy）中的实际使用与选型。

---

## 三者关系总览

| 框架 | 全称 | 引入版本 | 内核模块 | 定位 | 用户态工具 |
|---|---|---|---|---|---|
| **iptables** | netfilter/iptables | Linux 2.4（2001） | `ip_tables` / `ip6_tables` / `nf_conntrack` | 通用包过滤 / NAT 防火墙 | `iptables`、`iptables-save`、`iptables-restore` |
| **IPVS** | IP Virtual Server | Linux 2.4（LVS 项目） | `ip_vs` / `ip_vs_rr` 等调度器 | 专用四层负载均衡器 | `ipvsadm` |
| **nftables** | nftables | Linux 3.13（2014）框架，长期演进 | `nf_tables` | iptables 的继任者，统一过滤/NAT/LB | `nft` |

三者**都构建在 Netfilter 之上**，并非互相替代的独立栈。nftables 是官方钦定的 iptables 继任者，IPVS 则是专门为负载均衡场景设计的独立子系统（同样挂在 Netfilter 钩子上）。

```
                 ┌─────────────────────────────────────┐
                 │        用户态工具 (userspace)         │
                 │  iptables   ipvsadm     nft          │
                 └────────┬────────┬────────┬──────────┘
                          │        │        │
                 ┌────────▼────────▼────────▼──────────┐
                 │   Netlink 接口 (配置下发/读取)        │
                 └────────┬────────┬────────┬──────────┘
                          │        │        │
   ┌──────────────────────▼────────▼────────▼──────────────────────┐
   │                      Linux Kernel                              │
   │  ┌────────────┐  ┌────────────┐  ┌──────────────┐             │
   │  │ ip_tables  │  │   ip_vs    │  │  nf_tables   │  ← 内核模块  │
   │  │ (iptables) │  │  (IPVS)    │  │ (nftables)   │             │
   │  └─────┬──────┘  └─────┬──────┘  └──────┬───────┘             │
   │        │               │                │                     │
   │   ┌────▼───────────────▼────────────────▼─────┐               │
   │   │        Netfilter 钩子 (5 个 hook 点)        │               │
   │   │  PREROUTING / INPUT / FORWARD /            │               │
   │   │  OUTPUT / POSTROUTING                      │               │
   │   └─────────────────────┬──────────────────────┘               │
   │                         │                                       │
   │   ┌─────────────────────▼──────────────────────┐               │
   │   │  conntrack (连接跟踪) + NAT + 路由决策        │               │
   │   └────────────────────────────────────────────┘               │
   └─────────────────────────────────────────────────────────────────┘
```

---

## 一、安装

### 1.1 iptables

iptables 工具本身已预装在绝大多数 Linux 发行版。Linux 2.4.18 起内核默认编译进 Netfilter 框架。

```bash
# Debian / Ubuntu
sudo apt install -y iptables

# RHEL / CentOS / Rocky
sudo dnf install -y iptables

# 查看版本（区分 legacy 与 nf_tables 后端）
iptables --version
# iptables v1.8.9 (nf_tables)   ← 后端是 nf_tables（现代内核）
# iptables v1.8.9 (legacy)      ← 后端是旧的 xtables
```

> 现代发行版（RHEL 8+、Debian 10+、Ubuntu 22.04+）的 `iptables` 命令默认走 **nf_tables 后端**（`iptables-nft`），命令兼容但底层已是 nftables 内核。`update-alternatives --display iptables` 可查看当前后端。

### 1.2 IPVS（ipvsadm）

IPVS 内核模块同样早就在主线内核中，但默认未必加载。用户态工具是 `ipvsadm`。

```bash
# 安装用户态工具
sudo apt install -y ipvsadm        # Debian / Ubuntu
sudo dnf install -y ipvsadm        # RHEL 系

# 加载 IPVS 内核模块及调度算法
sudo modprobe ip_vs
sudo modprobe ip_vs_rr             # 轮询
sudo modprobe ip_vs_wrr            # 加权轮询
sudo modprobe ip_vs_lc             # 最少连接
sudo modprobe ip_vs_sh             # 源地址哈希
sudo modprobe nf_conntrack         # IPVS 依赖连接跟踪（4.19+ 统一用此模块）

# 持久化加载（重启生效）
cat <<'EOF' | sudo tee /etc/modules-load.d/ipvs.conf
ip_vs
ip_vs_rr
ip_vs_wrr
ip_vs_lc
ip_vs_sh
nf_conntrack
EOF

# 验证
ipvsadm -Ln
lsmod | grep ip_vs
```

### 1.3 nftables

```bash
# Debian / Ubuntu
sudo apt install -y nftables

# RHEL / CentOS / Rocky
sudo dnf install -y nftables

# 启用并启动服务（加载 /etc/nftables.conf）
sudo systemctl enable --now nftables

# 版本与内核支持
nft --version
# nftables 1.0.6 (Lester Gooch)

# 内核模块（通常已内建，非独立模块）
grep NF_TABLES /boot/config-$(uname -r)
# CONFIG_NF_TABLES=y
# CONFIG_NF_TABLES_INET=y
# CONFIG_NFT_CT=y        # conntrack 支持
# CONFIG_NFT_CHAIN_NAT=y # NAT 支持
```

### 1.4 关键内核配置确认

```bash
# 查看当前内核的网络过滤相关配置
grep -E 'NETFILTER|NF_TABLES|IP_VS|NF_CONNTRACK|NETFILTER_XT_' /boot/config-$(uname -r)
```

关键配置项含义：

| 内核配置 | 作用 |
|---|---|
| `CONFIG_NETFILTER` | Netfilter 框架总开关 |
| `CONFIG_NF_CONNTRACK` | 连接跟踪（iptables/IPVS/nftables 状态防火墙都依赖） |
| `CONFIG_NF_TABLES` | nftables 核心框架 |
| `CONFIG_NFT_CT` | nftables 使用 conntrack 状态匹配 |
| `CONFIG_NFT_CHAIN_NAT` | nftables NAT 链类型 |
| `CONFIG_IP_VS` | IPVS 核心 |
| `CONFIG_IP_VS_RR/LC/SH...` | IPVS 各调度算法 |
| `CONFIG_NETFILTER_XT_MATCH_*` | iptables 扩展匹配模块 |

---

## 二、基本使用

### 2.1 iptables 基本用法

#### 核心概念：表、链、规则

iptables 有 **5 个表**（按优先级）：`raw` → `mangle` → `nat` → `filter` → `security`，每个表包含预定义的链。

| 表 | 作用 | 常用链 |
|---|---|---|
| `raw` | 在 conntrack 之前匹配，可对包免跟踪（NOTRACK） | PREROUTING、OUTPUT |
| `mangle` | 修改包的 TTL、TOS、Mark 等 | 全部 5 链 |
| `nat` | DNAT / SNAT / MASQUERADE | PREROUTING、OUTPUT、POSTROUTING、INPUT |
| `filter` | 过滤（ACCEPT/DROP/REJECT） | INPUT、FORWARD、OUTPUT |
| `security` | SELinux 安全标记 | INPUT、FORWARD、OUTPUT |

```bash
# 查看规则（-n 不解析域名，-v 显示计数，--line-numbers 显示编号）
sudo iptables -L -n -v --line-numbers
sudo iptables -t nat -L -n -v --line-numbers

# 允许已建立连接的回流（几乎每个防火墙的第一条规则）
sudo iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# 允许 SSH（22）和 HTTP（80）/ HTTPS（443）
sudo iptables -A INPUT -p tcp --dport 22 -j ACCEPT
sudo iptables -A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT

# 允许回环
sudo iptables -A INPUT -i lo -j ACCEPT

# 默认策略设为 DROP（谨慎，先留 SSH 后路）
sudo iptables -P INPUT DROP
sudo iptables -P FORWARD DROP

# NAT 示例：把入站 80 端口转发到内网 10.0.0.5:8080（DNAT）
sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j DNAT --to-destination 10.0.0.5:8080
# 出站做 SNAT（MASQUERADE 会自动用出口网卡 IP）
sudo iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -o eth0 -j MASQUERADE

# 删除规则：先带 --line-numbers 查编号，再按编号删
sudo iptables -D INPUT 3

# 持久化（Debian/Ubuntu）
sudo apt install -y iptables-persistent
sudo netfilter-persistent save
# 规则存到 /etc/iptables/rules.v4
```

`iptables -A`（append，追加到末尾）和 `iptables -I`（insert，插入到顶部或指定位置）是日常最常用的两条命令。规则的**顺序至关重要**——内核按顺序匹配，命中即跳转。

#### iptables-save / iptables-restore

```bash
# 导出当前规则
sudo iptables-save > /tmp/iptables.rules

# 从文件恢复（原子操作，比逐条 -A 高效得多，kube-proxy 内部就是用这个）
sudo iptables-restore < /tmp/iptables.rules
```

### 2.2 IPVS（ipvsadm）基本用法

IPVS 的模型是「虚拟服务（Virtual Service）+ 真实服务器（Real Server）」。一个 VIP:Port 是一个虚拟服务，下面挂多个后端。

```bash
# 查看虚拟服务表（-L 列出，-n 不解析，--stats 显示流量统计）
sudo ipvsadm -Ln
sudo ipvsadm -Ln --stats
sudo ipvsadm -Ln --rate        # 实时速率

# 添加一个 TCP 虚拟服务：VIP=10.96.0.10:80，调度算法 rr（轮询）
sudo ipvsadm -A -t 10.96.0.10:80 -s rr

# 添加两个真实后端（-r），转发模式 -g（DR）/ -m（masquerade/NAT）/ -i（ipip 隧道）
sudo ipvsadm -a -t 10.96.0.10:80 -r 10.0.0.5:8080 -m        # NAT 模式
sudo ipvsadm -a -t 10.96.0.10:80 -r 10.0.0.6:8080 -m -w 2   # 权重 2

# 删除一个后端
sudo ipvsadm -d -t 10.96.0.10:80 -r 10.0.0.5:8080

# 删除整个虚拟服务
sudo ipvsadm -D -t 10.96.0.10:80

# 清空所有
sudo ipvsadm -C

# 持久化
sudo ipvsadm-save > /tmp/ipvs.rules
sudo ipvsadm-restore < /tmp/ipvs.rules
```

IPVS 调度算法一览（内核模块）：

| 算法 | 模块 | 说明 |
|---|---|---|
| `rr` | `ip_vs_rr` | 轮询（kube-proxy 默认） |
| `wrr` | `ip_vs_wrr` | 加权轮询 |
| `lc` | `ip_vs_lc` | 最少连接数 |
| `wlc` | `ip_vs_wlc` | 加权最少连接 |
| `sh` | `ip_vs_sh` | 源地址哈希（会话保持） |
| `dh` | `ip_vs_dh` | 目的地址哈希 |
| `lblc` / `lblcr` | `ip_vs_lblc` | 局部性最少连接（缓存场景） |
| `sed` | `ip_vs_sed` | 最短期望延迟 |
| `nq` | `ip_vs_nq` | 永不排队 |

IPVS 三种转发模式：

| 模式 | 参数 | 工作方式 | 是否改 IP |
|---|---|---|---|
| **NAT（masquerade）** | `-m` | 修改目标 IP（DNAT）转发给后端，回包再 SNAT 回 VIP | 是（DNAT + SNAT） |
| **DR（Direct Routing）** | `-g` | 改 MAC 不改 IP，后端直接回客户端（需在同一 L2） | 否（仅 L2 重写） |
| **Tunnel（IP-IP）** | `-i` | 外层封装 IP 隧道，后端解封装后直接回客户端 | 否（IP-in-IP） |

> Kubernetes kube-proxy 用的是 **NAT 模式**（`-m`），因为 Pod 可能跨节点，DR/Tunnel 要求后端能直接对外回包，与 k8s 网络模型不匹配。

### 2.3 nftables 基本用法

nftables 与 iptables 最大的语法差异：**没有预定义表和链**，全部要显式创建。

#### 核心概念：family、table、chain、rule

| 概念 | 对应 iptables | 说明 |
|---|---|---|
| **family**（地址族） | IPv4/IPv6 分开 | `ip`/`ip6`/`inet`(v4+v6)/`arp`/`bridge`/`netdev` |
| **table** | 表（filter/nat/...） | 命名空间，名字自定义，不再固定 |
| **chain（base chain）** | 预定义链（INPUT/OUTPUT...） | 必须手动绑定到 hook + priority |
| **chain（regular chain）** | 用户自定义链 | 不绑 hook，仅供 jump |
| **rule** | 规则 | match + action（verdict） |

#### 交互式命令

```bash
# 创建一个 inet 表（同时处理 v4/v6）
sudo nft add table inet my_table

# 创建 base chain：input，绑定到 input hook，priority 0，默认 drop
sudo nft 'add chain inet my_table input { type filter hook input priority 0; policy drop; }'
sudo nft 'add chain inet my_table output { type filter hook output priority 0; policy accept; }'

# 添加规则
sudo nft add rule inet my_table input iifname "lo" accept
sudo nft add rule inet my_table input ct state established,related accept
sudo nft add rule inet my_table input tcp dport { 22, 80, 443 } accept
sudo nft add rule inet my_table input icmp type echo-request accept

# 查看规则集
sudo nft list ruleset
sudo nft -a list table inet my_table    # -a 显示 handle（删除时要用）

# 按 handle 删除规则
sudo nft delete rule inet my_table input handle 4

# 删除整张表
sudo nft delete table inet my_table
```

#### 脚本化（推荐方式）

nftables 原生支持脚本，`/etc/nftables.conf` 就是脚本。这才是 nftables 的「正确」用法——**整表原子替换**，不存在「逐条加规则时的中间状态」问题。

```bash
# /etc/nftables.conf
#!/usr/sbin/nft -f

flush ruleset

table inet firewall {
    chain input {
        type filter hook input priority 0; policy drop;

        ct state established,related accept
        ct state invalid drop
        iifname "lo" accept

        icmp type echo-request accept
        icmpv6 type { echo-request, nd-neighbor-solicit } accept

        tcp dport { 22, 80, 443 } accept comment "ssh http https"
    }

    chain forward {
        type filter hook forward priority 0; policy drop;
    }

    chain output {
        type filter hook output priority 0; policy accept;
    }
}

# NAT 表
table ip nat {
    chain prerouting {
        type nat hook prerouting priority dstnat;
        tcp dport 80 dnat to 10.0.0.5:8080
    }
    chain postrouting {
        type nat hook postrouting priority srcnat;
        oifname "eth0" ip saddr 10.0.0.0/24 masquerade
    }
}
```

```bash
# 加载脚本（原子操作）
sudo nft -f /etc/nftables.conf
# 或通过 systemd
sudo systemctl reload nftables
```

#### nftables 的杀手锏：sets / maps / objects

这是 iptables 做不到的——nftables 可以在内核里维护集合、字典、计数器等「有状态对象」，单条规则就能匹配上千个 IP。

```bash
# 定义一个集合（黑名单 IP）
sudo nft add set inet firewall blacklist_v4 '{ type ipv4_addr; flags interval; }'
sudo nft add element inet firewall blacklist_v4 '{ 1.2.3.4, 5.6.7.0/24, 10.0.0.0/8 }'

# 一条规则匹配整个集合
sudo nft add rule inet firewall input ip saddr @blacklist_v4 drop

# 增删集合元素（不影响规则本身）
sudo nft add element inet firewall blacklist_v4 '{ 9.9.9.9 }'
sudo nft delete element inet firewall blacklist_v4 '{ 1.2.3.4 }'
```

对比 iptables：要屏蔽 1000 个 IP，iptables 要写 1000 条规则（线性匹配 O(n)）；nftables 用 set，内核用哈希/基数树，匹配 O(1)。

---

## 三、底层原理：Netfilter 与内核钩子

iptables、IPVS、nftables 三者的底层都挂在 **Netfilter** 上。Netfilter 是 Linux 内核网络协议栈里的一组「钩子点（hook points）」，允许内核模块在包流经协议栈的特定位置注册回调函数。

### 3.1 五个核心钩子

Netfilter 在 IP 层定义了 **5 个钩子**（IPv4 内核符号）：

| 钩子 | 内核常量 | 触发时机 |
|---|---|---|
| **PREROUTING** | `NF_INET_PRE_ROUTING` | 包刚进入协议栈、路由决策之前（最早可见 L3 包） |
| **INPUT** | `NF_INET_LOCAL_IN` | 路由决策后，包目的地是本机，送达本地进程之前 |
| **FORWARD** | `NF_INET_FORWARD` | 路由决策后，包要转发到其他接口（本机做路由器） |
| **OUTPUT** | `NF_INET_LOCAL_OUT` | 本机进程产生的包，刚进入协议栈、路由决策之前 |
| **POSTROUTING** | `NF_INET_POST_ROUTING` | 包即将离开协议栈送上网卡之前（最后机会） |

 后来还增加了：
- **ingress**（Linux 4.2，netdev 族）：在 PREROUTING 之前，绑定到具体网卡，比 tc 更早
- **egress**（Linux 5.16，netdev 族）：在 POSTROUTING 之后，包即将出网卡

> **tc 是什么**：tc（Traffic Control，流量控制）是 Linux 内核的 QoS 子系统，工作在网卡队列层（比 IP 协议栈更靠近网卡），由 **qdisc（队列规则）+ class（类别）+ filter（过滤器）** 三层组件构成，用于限速、流量整形、带宽分配。tc 也有一个 `ingress` qdisc 挂在网卡入口处做入向整形。nftables netdev 族的 `ingress` hook 比 tc ingress qdisc 触发更早——换言之，包到 nftables ingress 时 tc 还没看到它。整体顺序：网卡 RX → nftables ingress（netdev） → tc ingress → PREROUTING。

### 3.2 钩子优先级

同一个钩子点上可以挂多个链/模块，按 **priority 值从小到大**依次执行。Netfilter 预定义的优先级常量：

| 关键字 | 数值 | 常量 | 含义 |
|---|---|---|---|
| - | -450 | `NF_IP_PRI_RAW_BEFORE_DEFRAG` | 分片重组之前（最早） |
| - | -400 | `NF_IP_PRI_CONNTRACK_DEFRAG` | IP 分片重组 |
| **raw** | -300 | `NF_IP_PRI_RAW` | raw 表（conntrack 之前，可 NOTRACK） |
| - | -225 | `NF_IP_PRI_SELINUX_FIRST` | SELinux 早期 |
| - | -200 | `NF_IP_PRI_CONNTRACK` | **连接跟踪**（关键：在此之后才能用 ct state） |
| **mangle** | -150 | `NF_IP_PRI_MANGLE` | mangle 表 |
| **dstnat** | -100 | `NF_IP_PRI_NAT_DST` | **DNAT**（目标地址转换） |
| **filter** | 0 | `NF_IP_PRI_FILTER` | filter 表（过滤） |
| **security** | 50 | `NF_IP_PRI_SECURITY` | security 表（SELinux 标记） |
| **srcnat** | 100 | `NF_IP_PRI_NAT_SRC` | **SNAT**（源地址转换） |
| - | 225 | `NF_IP_PRI_SELINUX_LAST` | SELinux 收尾 |
| - | 300 | `NF_IP_PRI_CONNTRACK_HELPER` | conntrack helper（期望连接） |
| - | INT_MAX | `NF_IP_PRI_CONNTRACK_CONFIRM` | **conntrack 确认**（提交新连接） |

理解这张表是理解「为什么 DNAT 在 PREROUTING、SNAT 在 POSTROUTING」「为什么 filter 在 NAT 之后」的关键。**priority 决定了执行顺序，hook 决定了触发时机**。

### 3.3 iptables 如何挂在 Netfilter 上

iptables 把自己的预定义链注册到对应 hook 上。以入站到本机的包为例，依次经过：

```
入站包 → PREROUTING hook
         │
         ├─ raw.PREROUTING      (priority -300)
         ├─ (conntrack defrag)  (-400，分片重组，更早)
         ├─ (conntrack)         (-200，连接跟踪)
         ├─ mangle.PREROUTING   (-150)
         ├─ nat.PREROUTING      (-100，DNAT 在这里)
         ├─ (routing decision)  ← 路由：本机 or 转发
         │
         └→ INPUT hook
            ├─ mangle.INPUT     (-150)
            ├─ filter.INPUT     (0，过滤在这里)
            ├─ security.INPUT   (50)
            ├─ nat.INPUT        (100，少数内核支持)
            └─ (conntrack confirm) (INT_MAX)
            → 送达本地 socket
```

iptables 各表在各 hook 的分布（关键摘要）：

| 表↓ \ 链→ | PREROUTING | INPUT | FORWARD | OUTPUT | POSTROUTING |
|---|---|---|---|---|---|
| raw | ✓ | | | ✓ | |
| mangle | ✓ | ✓ | ✓ | ✓ | ✓ |
| nat(DNAT) | ✓ | ✓* | | ✓ | |
| filter | | ✓ | ✓ | ✓ | |
| security | | ✓ | ✓ | ✓ | |
| nat(SNAT) | | | | | ✓ |

> *nat.INPUT 仅在较新内核（CONFIG_NETFILTER_XT_TABLE_nat 启用 NAT LOCAL）才有。

### 3.4 nftables 如何挂在 Netfilter 上

nftables 不再有「预定义表/链」的概念。你创建的每张表只是一个**命名空间**，里面的 **base chain** 通过 `type ... hook ... priority ...` 显式绑定到 Netfilter 钩子。换言之，nftables 给了你「在任意 hook、任意 priority 上插链」的能力，比 iptables 灵活得多。

```bash
# 等价于 iptables 的 filter.INPUT
nft 'add chain inet fw input { type filter hook input priority filter; policy drop; }'

# 也可以在 PREROUTING 上插一条优先级 -300 的链（等价于 raw 表）
nft 'add chain inet fw raw_pre { type filter hook prerouting priority raw; }'

# NAT 链
nft 'add chain inet fw dnat { type nat hook prerouting priority dstnat; }'
nft 'add chain inet fw snat { type nat hook postrouting priority srcnat; }'
```

底层：nftables 通过 `nf_tables` 内核模块把 base chain 注册为 Netfilter hook 的回调。规则用「表达式（expression）」组合而成（如 `tcp dport 22` = 取 L4 头部目的端口 + 比较 22），内核用一个通用的字节码 VM 执行，而不是像 iptables 那样每个匹配都写一个 `xt_match` 模块。

### 3.5 IPVS 如何挂在 Netfilter 上

IPVS 不走 filter/nat 表那一套，它**直接在 `LOCAL_IN` 和 `LOCAL_OUT` 两个 hook 上注册自己的处理函数**（优先级 `NF_IP_PRI_LOCAL_IN` 附近）。

IPVS 的处理逻辑：当包的目的 IP 是某个已注册的虚拟服务（VIP:Port）时，IPVS 拦截该包，按调度算法选一个后端 Real Server，做 DNAT（NAT 模式），然后重新走路由发出去。

```
入站包 → PREROUTING
         ├─ (iptables 的 nat.PREROUTING，priority -100)
         │   ↑ IPVS 通常不在这里，IPVS 在 LOCAL_IN
         ├─ (routing decision)
         │   ↑ 若 dst=VIP 且本机有 IPVS 虚拟服务 → 判定为本机
         └→ LOCAL_IN hook
            ├─ IPVS 处理函数（priority ≈ 0）
            │   ↑ 匹配 VIP:VPort → 选 RealServer → DNAT → 重新路由
            │   ↑ 包被「重新注入」协议栈，下次路由会走向 RealServer IP
            ├─ filter.INPUT（iptables）
            └→ conntrack confirm
```

**关键点**：IPVS 和 iptables 共存时，IPVS 优先于 filter.INPUT 拦截 VIP 流量；IPVS 模式下 kube-proxy 仍会用 iptables 做少量辅助工作（masquerade、NodePort 标记等），并用 **ipset** 保证 iptables 规则数量恒定（不随 Service 数增长）。

### 3.6 conntrack：三者共用的连接跟踪

连接跟踪（connection tracking，`nf_conntrack` 模块）是状态防火墙和 NAT 的基础。它为每条流维护一个条目，记录五元组、状态、NAT 映射、超时等。

**连接状态**：

| 状态 | 含义 |
|---|---|
| `NEW` | 新连接的第一个包（如 TCP SYN） |
| `ESTABLISHED` | 已建立（TCP 握手完成；UDP 双向都有包） |
| `RELATED` | 与已有连接相关（如 FTP 数据连接、ICMP 错误回包） |
| `INVALID` | 无法识别/不属于任何连接（如错误的 TCP 标志位） |
| `SNAT/DNAT` | 伪状态，表示该包做过源/目标 NAT |

**conntrack 表关键参数**（`/proc/sys/net/netfilter/nf_conntrack_*`，源自内核文档）：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `nf_conntrack_max` | = `nf_conntrack_buckets` | 允许的最大连接条目数。**表满后新连接会被丢弃**（生产事故常见诱因） |
| `nf_conntrack_buckets` | 内存/16384，[1024, 262144] | 哈希表桶数。每个连接正反方向各占一条，所以满表平均链长为 2 |
| `nf_conntrack_count` | 只读 | 当前条目数 |
| `nf_conntrack_tcp_timeout_established` | 432000s（5 天） | TCP 已建立连接的超时。**生产环境常调小到 1-2 小时** |
| `nf_conntrack_tcp_timeout_time_wait` | 120s | TIME_WAIT 超时 |
| `nf_conntrack_udp_timeout` | 30s | UDP 单向流超时 |
| `nf_conntrack_udp_timeout_stream` | 120s | UDP 双向流超时 |
| `nf_conntrack_icmp_timeout` | 30s | ICMP 超时 |

```bash
# 查看当前连接数 / 上限
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# 查看连接表（人类可读）
sudo cat /proc/net/nf_conntrack | head

# 调大上限（高并发/k8s 大集群必备）
echo 1048576 | sudo tee /proc/sys/net/netfilter/nf_conntrack_max
# buckets 只能在模块加载时或 initial netns 设置，需重载模块或启动参数 nf_conntrack.hashsize=

# 内核日志满了会打：nf_conntrack: table full, dropping packet
dmesg | grep conntrack
```

> **k8s 集群 conntrack 调优**是 kube-proxy 不论哪种模式都必须做的：`nf_conntrack_max` 按节点内存设（如 1M），`tcp_timeout_established` 从 5 天降到 1 天，避免长连接占满表。

### 3.7 Netfilter hook 调用机制（内核视角）

前面讲了「5 个 hook 点」，但内核里到底怎么调用？关键入口是 `NF_HOOK` 宏（定义在 `include/linux/netfilter.h`）。

#### NF_HOOK 宏的展开

```c
// 简化形式
int NF_HOOK(u8 pf, unsigned int hook, struct sk_buff *skb,
            struct net_device *in, struct net_device *out,
            int (*okfn)(struct sk_buff *))
{
    int ret = nf_hook(pf, hook, skb, in, out, okfn);
    if (ret == 1)          // NF_ACCEPT
        return okfn(skb);  // 继续协议栈正常路径
    return ret;            // DROP/STOLEN/QUEUE 等，不再走 okfn
}
```

- `pf`：协议族（`PF_INET` / `PF_INET6` / `PF_BRIDGE`）
- `hook`：5 个 hook 编号之一（`NF_INET_PRE_ROUTING` 等）
- `okfn`：hook 链全部 ACCEPT 后要执行的「下一站」函数（如 `ip_rcv_finish`、`ip_local_deliver_finish`）
- 内部调用 `nf_hook()` → `nf_hook_slow()`，后者遍历该 hook 上注册的所有回调

#### nf_hook_slow 的遍历逻辑

```text
NF_HOOK(pf, PRE_ROUTING, skb, in, out, ip_rcv_finish)
    │
    └→ nf_hook_slow(skb, hook)
         │
         │  struct nf_hook_entries *e = nf_hook_array[hook];
         │  for (i = 0; i < e->num_hook_entries; i++) {
         │      verdict = e->hooks[i].hook(e->hooks[i].priv, skb,
         │                                 state);
         │      switch (verdict) {
         │          case NF_ACCEPT:  continue;      // 走下一条
         │          case NF_DROP:    goto drop;     // 丢包
         │          case NF_STOLEN:  return stolen; // 被钩子接管，不再回协议栈
         │          case NF_QUEUE:   goto queue;    // 送用户态 nfqueue
         │          case NF_REPEAT:  i--;           // 重复本条
         │      }
         │  }
         └→ 全部 ACCEPT → 返回 1 → NF_HOOK 调用 okfn(skb)
```

#### 5 种 verdict（判决）

| verdict | 常量值 | 含义 |
|---|---|---|
| `NF_DROP` | -1 | 丢包，`kfree_skb`，包从此消失 |
| `NF_ACCEPT` | 1 | 接受，继续下一条 hook；全部 ACCEPT 后走 `okfn` |
| `NF_STOLEN` | 2 | 钩子「偷走」包，后续处理由钩子自己负责（如 IPVS 重新注入、conntrack 延迟确认） |
| `NF_QUEUE` | 3 | 送入 `nf_queue`，用户态 `nfqueue`（`libnetfilter_queue`）处理 |
| `NF_REPEAT` | 4 | 重复执行当前钩子（极少用） |

#### 包从网卡到 PREROUTING hook 的精确调用栈

```text
网卡 RX (硬中断)
  └→ napi_poll → netif_receive_skb
       └→ __netif_receive_skb_core
            └→ ip_rcv (IPv4 协议栈入口)
                 │  // 这里还没过 Netfilter
                 └→ NF_HOOK(PF_INET, NF_INET_PRE_ROUTING,
                            skb, indev, NULL, ip_rcv_finish)
                      │
                      ├→ [raw 表 / nftables raw 链回调]
                      ├→ [conntrack 回调 (CT=NEW 时建条目)]
                      ├→ [mangle 表回调]
                      ├→ [nat 表 DNAT 回调]
                      └→ 全部 ACCEPT → ip_rcv_finish(skb)
                           │  // 路由查表
                           └→ ip_route_input → 决定本机 or 转发
```

> **关键理解**：`okfn`（如 `ip_rcv_finish`）只有在所有 hook 都返回 ACCEPT 时才会被调用。任何一条返回 DROP/STOLEN，包就不再走协议栈正常路径。iptables/nftables/IPVS 的核心都是往这个 hook 数组里注册自己的回调函数。

### 3.8 iptables 内核数据结构与匹配流程

iptables 在内核里不是「一条一条规则散落存放」，而是把整张表组织成一个**连续内存的线性数组**，匹配时顺序遍历。

#### 核心数据结构

```text
struct xt_table {              // 一张表(filter/nat/mangle/raw)
    const char            *name;
    unsigned int          valid_hooks;   // 哪些 hook 上有效
    void                  *private;      // → struct xt_table_info
    struct module         *me;
};

struct xt_table_info {         // 表的实际内容
    unsigned int       size;          // 规则区总字节数
    unsigned int       number;        // 规则条数
    unsigned int       initial_entries;
    void              *entries[NR_CPUS]; // 每颗 CPU 一份(减少锁竞争)
};

struct ipt_entry {             // 单条规则头(固定部分)
    struct ipt_ip    ip;       // 源/目 IP、掩码、入/出接口名
    unsigned int     nfcache;
    u_int16_t        target_offset;  // 从本头到 target 的偏移
    u_int16_t        next_offset;    // 到下一条规则的偏移
    unsigned int     comefrom;
    struct xt_counters counters;     // 包/字节统计
    // 后面紧跟: matches[] + target (变长)
};
```

#### 规则内存布局（一张表就是一个连续数组）

```text
xt_table_info.entries[] 内存布局:
┌──────────────────────────────────────────────┐
│ ipt_entry #0                                 │
│  ├─ ipt_ip (src/dst/mask/in/out)             │
│  ├─ target_offset ──┐                        │
│  └─ counters        │                        │
│   ┌─────────────────┘                        │
│   │ matches[0]: -m tcp --dport 80 (变长)     │
│   │ matches[1]: -m conntrack --ctstate ...   │
│   ├─ target: -j ACCEPT / DROP / DNAT / JUMP  │
│   └─ padding                                │
├──────────────────────────────────────────────┤
│ ipt_entry #1  ...                            │
├──────────────────────────────────────────────┤
│ ...                                          │
├──────────────────────────────────────────────┤
│ ipt_error (ERROR 目标, 表结尾标记)             │
└──────────────────────────────────────────────┘
```

#### 匹配主循环 ipt_do_table

```text
ipt_do_table(skb, hook, state, table)
  │
  │  e = table->entries;         // 第一条规则
  │  while (e != error_entry) {
  │      // 1. 匹配 IP 头: src/dst/in/out/掩码
  │      if (!ip_packet_match(e->ip, skb)) goto next;
  │      // 2. 遍历 matches[] 逐个调用 xt_match->match()
  │      for (m = e->matches; m; m = m->next) {
  │          if (!m->match(skb, m)) goto next;
  │      }
  │      // 3. 全部匹配 → 执行 target
  │      verdict = t->target(skb, t);
  │      switch (verdict) {
  │          case NF_ACCEPT: return 1;        // 离开本表
  │          case NF_DROP:   return -1;
  │          case IPT_RETURN: e = back_stack;  // 从自定义链返回
  │          default: e = table + verdict;     // JUMP 到自定义链
  │      }
  │  next:
  │      e = (void*)e + e->next_offset;       // 下一条
  │  }
```

> **性能关键**：这是**纯线性扫描**，O(n)。规则数到 10 万级时，每个包都要遍历前 N 条才能命中。iptables 模式的 kube-proxy 之所以慢，根本原因就在这里。

#### iptables-restore 原子替换机制

```text
用户态:  iptables-restore < rules.v4
    │
    │  1. 解析文本 → 构造新的 xt_table_info
    │  2. setsockopt(SO_SET_REPLACE, new_info)
    │
    └→ 内核 translate_table() 校验新表
         │
         │  3. xt_replace_table(table, new_info)
         │      old = table->private;
         │      table->private = new_info;   // 原子指针替换
         │      synchronize_rcu();            // 等所有 reader 退出
         │      free(old);                   // 释放旧表
         │
         └→ 全程无锁读, 写一次完成
```

> 这就是为什么 `iptables-restore` 是原子的——整张表指针被一次性替换，正在遍历旧表的 CPU 通过 RCU 机制安全退出后再释放。但代价是：**任何一条规则变更都要重写整张表**，这在 kube-proxy 大集群下是 CPU 杀手。

### 3.9 conntrack 详细实现

连接跟踪是状态防火墙和 NAT 的基石。它在内核里用一张哈希表维护「每条流」的状态。

#### 核心：nf_conntrack_tuple（五元组）

```text
struct nf_conntrack_tuple {
    struct {
        union {
            __be32  ip;        // v4 地址
            struct in6_addr ip6; // v6 地址
        };
        __be32  mask;
    } src;                     // 源 IP
    struct {
        union {
            __be32  ip;
            struct in6_addr ip6;
        };
        __be32  mask;
    } dst;                     // 目的 IP
    union {
        struct { __be16 port; } u3;   // L4 端口
        struct { u8 type, code; } icmp;
    } src.u, dst.u;
    u_int8_t protonum;         // IPPROTO_TCP/UDP/ICMP
};

// 每条连接有两个 tuple: 正向(orig) + 反向(reply)
struct nf_conntrack_tuple_hash {
    struct hlist_node  node;
    struct nf_conntrack_tuple tuple;
};

struct nf_conn {
    struct nf_conntrack_tuple_hash tuplehash[IP_CT_DIR_MAX]; // [0]=orig, [1]=reply
    unsigned long       status;       // 状态位图(IPS_NEW/ESTABLISHED/...)
    unsigned long       timeout;
    struct nf_ct_ext   *ext;          // NAT/HELPER/timeout 等扩展
    struct nf_conn_help *helper;
    ...
};
```

#### 哈希表组织与查找

```text
nf_conntrack_hash (全局哈希表, nf_conntrack_buckets 个桶)
  │
  │  key = hash(tuple) % nf_conntrack_buckets
  │
  ├─ bucket[0] → conn_A.tuplehash[orig] ↔ conn_A.tuplehash[reply]
  ├─ bucket[k] → conn_B.tuplehash[orig]
  │              conn_C.tuplehash[reply]   (同桶链表)
  ...
  └─ bucket[N]

查找一个包属于哪条连接:
  1. 从包头部构造 tuple (srcIP,dstIP,proto,srcPort,dstPort)
  2. hash(tuple) → bucket
  3. 遍历 bucket 链表, 比较 tuple 相等
  4. 命中 → 返回 nf_conn (含状态/NAT映射)
  5. 未命中 → NEW 连接, 新建条目

反向回包查找:
  回包的 tuple 恰好等于正向的 reply tuple
  → 同一张表同一个 bucket 命中, 拿到同一条 conn
```

#### TCP 连接状态机（内核视角）

```text
              SYN
   NEW ────────────────► IPS_EXPECTED (期望连接)
   │  SYN+ACK               │
   │                        ▼
   │  第一包          IPS_ASSURED (确认双向都见过包)
   │  ───────────► ESTABLISHED ◄───────────────┐
   │                  │  │                      │
   │                  │  │ FIN/FIN-ACK          │
   │                  │  ▼                      │
   │                  │ CLOSE_WAIT ──► LAST_ACK │
   │                  │                          │
   │                  │ FIN+ACK                  │
   │                  ▼                          │
   │              FIN_WAIT ──► TIME_WAIT ────────┘
   │                  │        (timeout 120s)
   │  超时             │
   └──────────────► 空闲超时 → conntrack GC 清理
```

status 位图关键位：`IPS_SRC_NAT` / `IPS_DST_NAT`（做过 SNAT/DNAT）、`IPS_ASSURED`（双向都见过包，超时更长）、`IPS_SEEN_REPLY`（见过回包）。

#### GC（garbage collector）机制

```text
nf_conntrack GC worker (内核定时器, 每 GC_INTERVAL 秒跑一次)
  │
  │  for each bucket:
  │      for each conn in bucket:
  │          if (conn->timeout <= now):
  │              if (status & ASSURED && !over) 跳过(长连接保活)
  │              else __nf_conntrack_l4proto->expire(conn)
  │
  │  表满时(nf_conntrack_count >= nf_conntrack_max):
  │      early_drop() → 从最老桶里随机 evict 一条
  │      若仍满 → drop packet (dmesg: table full, dropping packet)
```

#### expectation（期望连接）机制

某些协议在一条控制连接上协商出新的数据连接（FTP 主动模式、SIP/RTP 等）。conntrack 的 helper 模块解析控制连接载荷，预先登记「期望连接」：

```text
FTP 控制连接 (client:1234 → server:21)
  │  helper (nf_conntrack_ftp) 解析 PORT 命令
  │  "PORT 10,0,0,5,4,1" → 数据连接将是 10.0.0.5:1025 → server:20
  │
  └→ 登记 expectation:
        tuple = (server:20 → 10.0.0.5:1025, TCP)
        marked IPS_EXPECTED, 关联到控制连接的 conn

后续当数据连接第一个包到达:
  → 查 conntrack 表未命中
  → 查 expectation 表命中
  → 自动建 conn, status |= IPS_EXPECTED, 不走 NEW 的 NAT 规则
  → 按 expectation 里预设的 NAT 映射改写
```

> 这就是为什么 FTP 主动模式在 NAT 后面也能工作——`nf_conntrack_ftp` helper 模块解析了控制连接载荷并预登记了期望连接。K8s 环境一般禁用 helper（`nf_conntrack_helper=0`）避免安全风险。

### 3.10 NAT 实现细节

NAT 不是一个独立的 hook，而是挂在 conntrack 上的「变换动作」。它的核心是：**只在第一个包（NEW）走规则匹配，后续包直接用 conntrack 里记录的映射改写**。

#### 数据结构

```text
struct nf_nat_range {
    unsigned int       flags;      // 范围标志(IP范围/端口范围/持久化)
    union nf_inet_addr min_addr, max_addr;  // 地址范围
    union nf_conntrack_man_proto min, max;  // 端口范围
};

struct nf_conn_nat {
    struct nf_nat_range range[IP_CT_DIR_MAX];  // orig/reply 两个方向
    struct nf_conn *ct;
};
```

#### DNAT/SNAT 在 conntrack 中的记录

```text
第一个包 NEW, 做 DNAT 10.96.0.10:80 → 10.244.2.8:80:

conntrack 表记录:
  conn.tuplehash[orig]  = (src=PodA, dst=10.96.0.10:80)    ← 原始方向
  conn.tuplehash[reply] = (src=10.244.2.8:80, dst=PodA)    ← 反向(改写后)

  conn.nat = { orig: DNAT to 10.244.2.8:80 }

后续回包(10.244.2.8:80 → PodA):
  构造 tuple 查表 → 命中 conn.tuplehash[reply]
  → 取出对应 orig tuple → 反向改写:
      src 10.244.2.8:80 → 10.96.0.10:80
  → 直接送出, 不再过 nat.PREROUTING 规则
```

#### 端口分配算法

```text
nf_nat_setup_info(ct, range, maniptype)
  │
  │  // 在 range 指定的端口范围内找未占用的
  │  for (port = range->min; port <= range->max; port++) {
  │      new_tuple = *ct->tuplehash[maniptype].tuple;
  │      new_tuple.dst.u.tcp.port = port;
  │      if (!nf_nat_used_tuple(new_tuple, ct))   // 检查未占用
  │          goto found;
  │  }
  │  // 范围全占满 → 从整个端口空间随机找
  │  for (attempts = 0; attempts < 128; attempts++) {
  │      port = random();
  │      if (!nf_nat_used_tuple(...)) goto found;
  │  }
  │  return -1;  // 端口耗尽, 丢包
```

#### 为什么 NAT 只对 NEW 包走规则

```text
第一个包 (NEW):
  PREROUTING hook
    ├─ conntrack lookup → 未命中 → 建 conn, 标 NEW
    ├─ nat.PREROUTING 规则匹配 → 调 nf_nat_inet_fn()
    │      → nf_nat_setup_info() 记录映射到 conn.nat
    └→ 包带着改写后的地址继续协议栈

后续包 (ESTABLISHED):
  PREROUTING hook
    ├─ conntrack lookup → 命中 conn
    │   status |= SEEN_REPLY, 不再是 NEW
    ├─ nat.PREROUTING 规则【直接跳过】(仅对 NEW 有效)
    ├─ nf_nat_inet_fn() 检查 conn.nat 已有映射
    │   → 按 conn.nat 改写地址 (固定操作, 无需规则匹配)
    └→ 包继续走
```

> 这就是 NAT 的「fast path」——conntrack 命中后，NAT 改写是固定查表操作，不再扫描 nat 表规则。生产环境大量长连接下 NAT 开销可控，根本原因在此。

### 3.11 IPVS 数据结构与调度实现

IPVS 不走 iptables 那套线性表，它用哈希表组织「虚拟服务」和「连接」，查找 O(1)。

#### 核心数据结构

```text
struct ip_vs_service {        // 一个虚拟服务 (VIP:VPort:Proto)
    struct hlist_node  s_list;    // 按 {af,protocol,vip,vport} 哈希
    struct hlist_node  f_list;    // 按 {af,fwmark} 哈希(标记模式)
    atomic_t           refcnt;
    u16                protocol;
    union nf_inet_addr addr;      // VIP
    __be16             port;      // VPort
    struct ip_vs_scheduler *scheduler;  // → rr/wrr/lc/sh 等算法 ops
    struct list_head   destinations;    // Real Server 链表
    unsigned int       num_dests;
    ...
};

struct ip_vs_dest {           // 一个 Real Server
    struct list_head   n_list;    // 挂在 service->destinations
    union nf_inet_addr addr;      // RIP
    __be16             port;      // RPort
    atomic_t           weight;    // 权重
    atomic_t           activeconns, inactconns;  // 连接计数
    atomic_t           conn_flags; // 转发模式 NAT/DR/TUNNEL
    ...
};

struct ip_vs_conn {           // 一条 IPVS 连接(五元组哈希)
    struct hlist_node  c_list;    // 按 {proto, caddr,cport, vaddr,vport} 哈希
    struct ip_vs_dest *dest;       // 选中的 Real Server
    unsigned long      timeout;
    struct nf_conn    *ct;         // 关联的 conntrack 条目
    ...
};
```

#### 包处理主流程 ip_vs_in

```text
入站包到达 (PREROUTING → routing → LOCAL_IN)
  │
  └→ ip_vs_in(skb)
       │
       │  1. 构造 tuple {proto, saddr,sport, daddr,dport}
       │     (daddr 是 VIP)
       │
       │  2. 查 ip_vs_conn 表(哈希)
       │     ├─ 命中 → 已有连接, 取 dest
       │     └─ 未命中 → 新连接:
       │          a. 查 ip_vs_service 表(按 VIP:VPort:Proto 哈希) O(1)
       │          b. service->scheduler->schedule(service, skb)
       │             → 按 rr/wrr/lc/sh 选一个 dest
       │          c. 建 ip_vs_conn, 关联 dest
       │
       │  3. 根据 dest->conn_flags 选 xmit 函数:
       │     ├─ IP_VS_CONN_F_MASQ  → ip_vs_nat_xmit  (NAT 模式)
       │     │     做 DNAT: dst = dest->addr:port
       │     ├─ IP_VS_CONN_F_FWD   → ip_vs_dr_xmit   (DR 模式)
       │     │     改 L2 MAC, 不改 L3
       │     └─ IP_VS_CONN_F_TUNNEL→ ip_vs_tunnel_xmit (IPIP 隧道)
       │           外层封装 IP 头 dst=dest->addr
       │
       │  4. xmit → 重新注入协议栈(走 POSTROUTING)
       │
       └→ 包被「偷走」(NF_STOLEN), 不再走 filter.INPUT
```

#### 调度算法实现要点

| 算法 | 实现 |
|---|---|
| `rr` | `service->destinations` 链表轮转，`last_visited = last_visited->next` |
| `wrr` | 每个 dest 维护 `weight`，按权重比例轮转（经典 SM 算法） |
| `lc` | 遍历 destinations，选 `activeconns + inactconns` 最小的 |
| `wlc` | 在 lc 基础上除以 weight，选 `(active+inactive)/weight` 最小的 |
| `sh` | `hash(srcIP) % num_dests`，源地址相同的包固定去同一个 dest（会话保持） |
| `sed` | 在 wlc 基础上 +1，选 `(active+inactive+1)/weight` 最小的，避免权重高的 dest 一直被选 |
| `nq` | 在 sed 基础上，若有 `inactconns=0` 的 dest 优先选（永不排队） |

> **IPVS 查找复杂度**：service 查找哈希 O(1)，conn 查找哈希 O(1)，调度算法多数 O(n_dests)（n_dests 是单 service 的后端数，通常很小）。与 iptables 的 O(n_rules) 形成鲜明对比——iptables 的 n_rules 是全节点所有 Service 的规则总和。

### 3.12 nftables 字节码 VM 与事务机制

nftables 与 iptables 最大的架构差异：iptables 每个「匹配」都是一个独立内核模块（`xt_match`），nftables 用一个**通用表达式 VM** 统一处理所有匹配。

#### 数据结构关系

```text
struct nft_table {              // 一张表(命名空间)
    struct list_head  chains;    // 该表下所有 chain
    struct list_head  sets;      // 该表下所有 set/map
    u64               generation; // 所属 generation ID
    ...
};

struct nft_chain {              // 一条链
    struct nft_rule   *rules_gen0;  // 当前生效规则(链表)
    struct nft_rule   *rules_gen1;  // 新规则(事务提交中)
    u8                flags;
    struct nft_base_chain *base; // base chain 才有, 含 hook/priority
};

struct nft_rule {               // 一条规则
    struct list_head  list;
    unsigned int      dlen;      // 表达式区长度
    unsigned char     data[]     // 柔性数组: 连续存放 nft_expr
        __attribute__((aligned));
};

struct nft_expr {               // 单个表达式(变长)
    const struct nft_expr_ops *ops;  // 函数表: eval/init/destroy
    unsigned int      len;
    unsigned char     data[];    // 表达式私有数据
};

struct nft_expr_ops {
    const char       *name;      // 如 "payload"/"cmp"/"lookup"/"immediate"
    void            (*eval)(const struct nft_expr *expr,
                            struct nft_regs *regs,
                            const struct nft_pktinfo *pkt);
    ...
};
```

#### 执行引擎 nft_do_chain

```text
nft_do_chain(skb, state)   // 挂在 Netfilter hook 上的回调
  │
  │  struct nft_chain *chain = ...;
  │  struct nft_rule *rule;
  │
  │  list_for_each_entry(rule, &chain->rules, list) {
  │      struct nft_expr *expr;
  │      nft_rule_for_each_expr(expr, rule) {
  │          expr->ops->eval(expr, &regs, &pkt);
  │          // eval 把结果写入 regs.verdict
  │          // payload: 从 skb 取字段写入寄存器
  │          // cmp:     比较寄存器与立即数
  │          // lookup:  查 set
  │          // immediate: 设置 verdict(NF_DROP/NF_ACCEPT/...)
  │          if (regs.verdict.code != NFT_CONTINUE)
  │              break;   // 跳出本规则的表达式循环
  │      }
  │      switch (regs.verdict.code) {
  │          case NFT_BREAK:    continue;     // 本规则不匹配, 下一条
  │          case NF_ACCEPT:    return 1;     // 离开 chain
  │          case NF_DROP:      return -1;
  │          case NFT_JUMP:     push(chain); chain = target; continue;
  │          case NFT_RETURN:   chain = pop(); continue;
  │      }
  │  }
  │  return chain->policy;   // 默认策略
```

对比 iptables：

| 维度 | iptables | nftables |
|---|---|---|
| 匹配实现 | 每个 `-m xxx` 一个 `xt_match` 内核模块 | 通用表达式 VM，`payload`/`cmp`/`lookup` 组合 |
| 新匹配扩展 | 要写内核模块、modprobe 加载 | 纯 VM 指令组合，无需新模块 |
| 规则存储 | 线性数组 `ipt_entry[]` | 链表 + 每条规则内嵌连续表达式 |
| 执行 | `ipt_do_table` 线性扫 + 逐 match 调函数 | `nft_do_chain` 线性扫 + 逐 expr 调 eval |

#### sets/maps 底层

```text
nft set 的两种底层结构:

1. 哈希表 (rhashtable, 默认):
   用于精确匹配 { 1.2.3.4, 5.6.7.8, ... }
   查找 O(1)

2. 红黑树 (rbtree):
   用于区间匹配 { 10.0.0.0/8, 192.168.0.0/16 }
   查找 O(log n)

map = set + 关联数据:
   key: ipv4_addr . inet_service   (复合键)
   value: ipv4_addr . inet_service (后端地址)
   查找 key → 拿到 value → 用于 DNAT
```

#### 事务机制（generation ID）

nftables 的规则更新是**事务式、原子的**，靠 generation ID 实现：

```text
当前生效:  generation N
  │
用户态 nft 发命令 (NFT_MSG_NEWRULE / NEWCHAIN / ...):
  │
  │  1. 内核在 generation N+1 的副本上操作
  │     (chain->rules_gen1 指针, 与 gen0 并存)
  │
  │  2. 所有命令处理完, 用户态发 NFT_MSG_NEWGEN:
  │     内核做 commit:
  │       a. generation = N+1
  │       b. chain->rules_gen0 = chain->rules_gen1  (指针切换)
  │       c. 通知所有 reader 切到新 generation
  │
  │  3. synchronize_rcu(): 等所有正在用 gen N 的 reader 退出
  │
  └→ 4. free(gen N 的旧规则)   // RCU 延迟释放
```

> 这就是 nftables 增量更新的核心：规则可以在不停机、不锁读路径的前提下原子生效。对比 iptables 的 `iptables-restore`（整表替换），nftables 可以只改一条规则，开销恒定。

---

## 四、内核收发包全流程

把上面所有概念串起来，看一个包从网卡进/出到底走了哪些路径。

### 4.1 完整收发包路径

```
                          [网卡 RX]
                              │
                              ▼ (DMA + 硬中断)
                       ┌──────────────┐
                       │  NAPI poll   │  ← 软中断 NET_RX，驱动 poll 拿包
                       └──────┬───────┘
                              ▼
                       ┌──────────────┐
                       │  netif_receive_skb  │
                       └──────┬───────┘
                              │ (netdev 族)
                              ▼
                        ┌──────────┐
                        │ ingress  │  ← nftables netdev ingress hook（最早，4.2+）
                        └────┬─────┘
                             ▼
                       ┌──────────────┐
                       │  XDP (可选)  │  ← eBPF，比 ingress 还早
                       └──────┬───────┘
                              ▼
                       ┌──────────────┐
                       │  PREROUTING  │  ← Netfilter hook #1
                       │  ┌─────────┐ │
                       │  │raw (-300)│ │  iptables raw / nftables raw 链
                       │  │mangle   │ │  (-150)
                       │  │nat DNAT │ │  (-100)  ← DNAT/端口转发在这里
                       │  └─────────┘ │
                       └──────┬───────┘
                              ▼
                       ┌──────────────┐
                       │ routing decision │  ← 路由查表：本机 or 转发？
                       └───┬──────┬─────┘
                  本机 ↓      │      ↓ 转发
              ┌──────────┐    │   ┌──────────┐
              │  INPUT   │    │   │ FORWARD  │  ← Netfilter hook #3
              │ ┌────────┐│   │   │ ┌────────┐│
              │ │mangle  ││   │   │ │mangle  ││
              │ │filter  ││   │   │ │filter  ││  ← iptables FORWARD 过滤
              │ │security││   │   │ └────────┘│
              │ └────────┘│   │   └────┬─────┘
              │ (IPVS    ││   │        │
              │  LOCAL_IN││   │        ▼
              │  hook)   ││   │   ┌──────────┐
              └─────┬────┘   │   │POSTROUTING│ ← Netfilter hook #4
                    │        │   │ ┌────────┐│
                    ▼        │   │ │srcnat  ││ ← SNAT/MASQUERADE 在这里
              ┌──────────┐  │   │ │(100)   ││
              │ 本地 socket│ │   │ └────────┘│
              │ (进程收包) │  │   └────┬─────┘
              └──────────┘  │        ▼
                            │   [网卡 TX]
                            │
              本机发包 ↓
              ┌──────────────┐
              │  本地进程产生包 │
              └──────┬───────┘
                     ▼
              ┌──────────────┐
              │  routing decision │  ← 先路由（选源 IP、出口）
              └──────┬───────┘
                     ▼
              ┌──────────────┐
              │   OUTPUT     │  ← Netfilter hook #5
              │  ┌─────────┐ │
              │  │raw      │ │
              │  │mangle   │ │
              │  │nat DNAT │ │  (本机发出也可 DNAT)
              │  │filter   │ │
              │  │(IPVS    │ │   LOCAL_OUT 也有 IPVS 钩子)
              │  └─────────┘ │
              └──────┬───────┘
                     ▼
              ┌──────────────┐
              │  POSTROUTING │  ← Netfilter hook #4（与转发合流）
              │  │ srcnat   │ │  ← SNAT/MASQUERADE
              └──────┬───────┘
                     ▼
                [网卡 TX]
```

### 4.2 三条典型路径

| 场景 | 路径 |
|---|---|
| 入站到本机进程 | PREROUTING → routing(本机) → INPUT → 本地 socket |
| 本机做路由器转发 | PREROUTING → routing(转发) → FORWARD → POSTROUTING → 网卡 |
| 本机进程发包 | 本地进程 → routing → OUTPUT → POSTROUTING → 网卡 |

### 4.3 收包的软中断路径（与 CPU 软中断排查相关）

网卡收包到协议栈的细节（对应《CPU 软中断高排查记录》）：

```
1. 网卡收到帧 → DMA 写入环形缓冲区 → 触发硬中断
2. 硬中断处理：NAPI 禁用该队列硬中断，触发 NET_RX 软中断
3. 软中断 net_rx_action → 驱动的 napi_poll 回调
4. napi_poll 批量取 skb → netif_receive_skb
5. __netif_receive_skb_core：处理 bridge/_vlan，调用协议栈 ptype_all 钩子
6. ip_rcv → NF_INET_PRE_ROUTING（Netfilter PREROUTING hook）→ 路由 → ...
```

**RPS/RSS 影响的就是第 2-3 步**：RSS 在硬中断层分流，RPS 在软中断层把包派发到其他 CPU 的 backlog 队列。这就是为什么 RSS 开了但 RPS 关闭会导致软中断集中在部分 CPU。

### 4.4 NAT 在内核里的位置

NAT（DNAT/SNAT）只在 **第一个包**（NEW 状态）走完整规则匹配，后续包由 conntrack 直接按已建立的映射改写，不再过 nat 表规则（`nat` 表规则只对 NEW 包有意义）。

```
第一个包(NEW):  PREROUTING → nat.PREROUTING(DNAT) → routing → ... → nat.POSTROUTING(SNAT)
                                                          conntrack 记录映射
后续包(ESTABLISHED): conntrack 直接按映射改写，跳过 nat 规则
```

这就是为什么生产环境大量长连接下，iptables NAT 的性能开销没有想象中大——大部分包走的是 conntrack 的快速路径，不是规则匹配。

### 4.5 flowtable：旁路加速（Linux 5.x）

对于已建立的流，Netfilter 提供 **flowtable** 旁路：匹配到 flowtable 的包不再走 PREROUTING/POSTROUTING 那一长串 hook，直接在 ingress 层做完 NAT 后送出网卡。等价于「硬件卸载的 fastpath」。

```
ingress → 查 flowtable → 命中 → 改 NAT、减 TTL、neigh_xmit → 出网卡
                          │
                          └─未命中→ 走经典 PREROUTING→...→POSTROUTING 路径
                                    并由 "flow offload" 规则把新流加入 flowtable
```

`nf_flowtable_tcp_timeout` 默认 30s，超时后流回到 conntrack 经典路径。这对高 PPS 长连接场景是显著加速。

### 4.6 三条路径的精确函数调用栈

4.1 给的是「hook 级」概览，这里给出「函数级」调用链，标注每个 `NF_HOOK` 触发点。所有函数名来自 `net/ipv4/ip_input.c`、`ip_output.c`、`ip_forward.c`、`net/netfilter/`。

#### 路径 1：入站到本机进程

```text
ip_rcv(skb)                      // 协议栈入口, 简单校验
  └→ NF_HOOK(PRE_ROUTING, ip_rcv_finish)   ★ hook #1
       │
       │  // raw(-300) / conntrack(-200) /
       │  // mangle(-150) / nat DNAT(-100)
       │
       └→ ip_rcv_finish(skb)
            ├→ ip_route_input()   // 路由决策: 本机
            └→ dst_input = ip_local_deliver
                 │
                 └→ ip_local_deliver(skb)
                      └→ NF_HOOK(LOCAL_IN, ip_local_deliver_finish)  ★ hook #2
                           │
                           │  // mangle(-150) / filter(0) / security(50)
                           │  // (IPVS 在此 hook 拦截 VIP 流量)
                           │
                           └→ ip_local_deliver_finish(skb)
                                ├→ ipprot = skb->protocol (TCP=6)
                                └→ tcp_v4_rcv(skb)      // 交 TCP 协议栈
                                     ├→ __inet_lookup_skb()  // 找 socket
                                     └→ tcp_v4_do_rcv()
                                          └→ tcp_rcv_established()
                                               → 数据进 socket 接收队列
                                               → 唤醒进程 recv/read
```

#### 路径 2：本机做路由器转发

```text
ip_rcv(skb)
  └→ NF_HOOK(PRE_ROUTING, ip_rcv_finish)   ★ hook #1
       └→ ip_rcv_finish(skb)
            ├→ ip_route_input()   // 路由决策: 转发
            └→ dst_input = ip_forward
                 │
                 └→ ip_forward(skb)
                      ├→ ip_decrease_ttl()   // TTL-1, 为 0 则丢
                      └→ NF_HOOK(FORWARD, ip_forward_finish)  ★ hook #3
                           │
                           │  // mangle(-150) / filter(0) / security(50)
                           │  // iptables -A FORWARD 过滤在此
                           │
                           └→ ip_forward_finish(skb)
                                └→ dst_output = ip_output
                                     │
                                     └→ ip_output(skb)
                                          └→ NF_HOOK(POST_ROUTING, ip_finish_output)  ★ hook #4
                                               │
                                               │  // mangle(-150) / srcnat(100)
                                               │  // SNAT/MASQUERADE 在此
                                               │
                                               └→ ip_finish_output(skb)
                                                    ├→ ip_finish_output2()
                                                    └→ neigh_output() → dev_queue_xmit()
                                                         → 网卡驱动 TX
```

#### 路径 3：本机进程发包

```text
进程 send/write
  └→ tcp_sendmsg()
       └→ tcp_transmit_skb()
            └→ ip_queue_xmit(skb)
                 ├→ ip_route_output_flow()  // 路由: 选源 IP/出口
                 └→ NF_HOOK(LOCAL_OUT, ip_output)   ★ hook #5
                      │
                      │  // raw(-300) / mangle(-150) /
                      │  // nat DNAT(-100) / filter(0)
                      │  // (IPVS LOCAL_OUT hook 也在此)
                      │
                      └→ ip_output(skb)     // 与转发合流
                           └→ NF_HOOK(POST_ROUTING, ip_finish_output)  ★ hook #4
                                │
                                │  // mangle(-150) / srcnat(100)
                                │  // SNAT/MASQUERADE 在此
                                │
                                └→ ip_finish_output()
                                     → neigh_output() → dev_queue_xmit()
                                          → 网卡 TX
```

> **关键观察**：5 个 hook 点对应 5 个 `NF_HOOK` 调用，分别嵌在 `ip_rcv`/`ip_local_deliver`/`ip_forward`/`ip_output`/`ip_queue_xmit` 里。路径 2 和路径 3 在 `ip_output` 处合流，共享 POSTROUTING hook。理解这个调用链是排查「包到哪一步消失了」的基础——结合 `tcpdump`（看网卡层）和 `iptables -L -v -n`（看 hook 计数器）能精确定位丢包点。

---

## 五、iptables vs IPVS vs nftables 横向对比

| 维度 | iptables | IPVS | nftables |
|---|---|---|---|
| **设计目标** | 通用包过滤/NAT 防火墙 | 专用四层负载均衡 | iptables 继任者，统一框架 |
| **数据结构** | 线性链表（逐条匹配） | 哈希表（O(1) 查找） | 表达式字节码 + sets（哈希/基数树） |
| **查找复杂度** | O(n)，规则越多越慢 | O(1)，与 Service 数无关 | O(1)~O(log n)（用 set 时） |
| **规则更新** | 全量 `iptables-restore` 重写 | 增量 `ipvsadm -a/-d` | 增量或整表原子替换 |
| **大规模更新开销** | 250K 规则时单次 restore 5-15s CPU | 单条增删，常数时间 | 增量小，整表替换也快 |
| **NAT 能力** | 完整 DNAT/SNAT/MASQUERADE | NAT/DR/Tunnel 三种模式 | 完整 NAT（继承自 Netfilter） |
| **调度算法** | 随机（默认） | rr/wrr/lc/wlc/sh/sed/nq... 等十余种 | 可用 map+numgen 实现，原生不强 |
| **连接跟踪** | 依赖 conntrack | 依赖 conntrack（NAT 模式） | 依赖 conntrack |
| **L7 过滤** | 不支持（需 layer7 补丁，已废弃） | 不支持 | 不支持（L7 应交给应用层代理） |
| **语法** | 分散命令式，`-A/-I/-D` | 命令式 `-A/-a` | 脚本化，类编程语言 |
| **v4/v6 统一** | 否（iptables/ip6tables 分开） | 是 | 是（inet 族） |
| **内核演进** | 维护模式，不再加新特性 | 维护模式 | 活跃开发，新特性首选 |
| **官方定位** | 逐步淘汰 | 维护 | **推荐** |

### 三者的关系本质

```
iptables ──── 维护模式（不再新增特性）
   │
   │  (命令兼容层：iptables-nft)
   ▼
nftables ──── 官方继任者，活跃开发
   │
   └── 同样构建在 Netfilter 之上

IPVS ─────── 独立子系统，专为 LB，不参与 iptables→nftables 迁移
              在 k8s 中是 iptables/ipvs/nftables 三选一的「数据平面后端」
```

`iptables-nft`（现代发行版默认）让你继续用 `iptables` 语法，但底层规则存在 nf_tables 内核里。这是平滑迁移的过渡方案。

---

## 六、在 Kubernetes 中的使用

### 6.1 kube-proxy 的本质

kube-proxy 是每个节点上运行的 daemon。它**不转发包**（名字是历史遗留，早期版本确实是 userspace 代理）。现代 kube-proxy 是「规则生成器」：watch API server 的 Service/EndpointSlice，把对应的内核规则（iptables/IPVS/nftables）写好，然后**退出数据路径**。真正的包转发由内核做。

```
┌─────────────┐    watch     ┌──────────────┐
│ API Server  │ ───────────→ │  kube-proxy  │  ← 用户态，只生成规则
└─────────────┘              └──────┬───────┘
                                    │ 写规则
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              ┌──────────┐   ┌──────────┐   ┌──────────┐
              │ iptables │   │   IPVS   │   │ nftables │   ← 内核数据平面
              │  规则    │   │  虚拟服务│   │   set    │
              └──────────┘   └──────────┘   └──────────┘
                    │               │               │
                    └───────────────┴───────────────┘
                                    │
                          数据包由内核直接转发
                          （kube-proxy 不在路径上）
```

配置方式（kube-proxy ConfigMap）：

```yaml
apiVersion: kubeproxy.config.k8s.io/v1alpha1
# 或 kube-proxy 的 command flag: --proxy-mode
mode: "iptables"   # 默认。可选: iptables | ipvs | nftables | kernelspace
```

### 6.2 iptables 模式（默认）

#### 工作原理

kube-proxy 在 nat 表里注入一组自定义链：

| 链 | 作用 |
|---|---|
| `KUBE-SERVICES` | 入口链，挂在 PREROUTING 和 OUTPUT 上。按 (ClusterIP, port, proto) 匹配，跳转到对应 Service 链 |
| `KUBE-SVC-<HASH>` | 每个 Service 一条，含若干「按概率 DNAT 到后端」的规则（统计模式实现加权随机） |
| `KUBE-SEP-<HASH>` | 每个 Service EndPoint 一条，做 DNAT 到 Pod IP:Port |
| `KUBE-MARK-MASQ` | 给包打 `0x4000` mark，用于后续 SNAT |
| `KUBE-POSTROUTING` | 挂在 POSTROUTING，对带 mark 的包做 MASQUERADE |
| `KUBE-FIREWALL` | 丢弃 INVALID 状态包 |

#### 一个 ClusterIP 请求的完整路径

以 Pod A（10.244.1.5）访问 Service `10.96.0.10:80`（后端 Pod B/C/D）为例：

```
Pod A 发出: src=10.244.1.5 dst=10.96.0.10 (ClusterIP)
    │
    ▼
PREROUTING(nat) → KUBE-SERVICES
    │  线性扫描规则，匹配 dst=10.96.0.10 dport=80
    │  → jump KUBE-SVC-XXXXXXXX
    ▼
KUBE-SVC-XXXXXXXX
    │  rule1: statistic mode random probability 0.333 → jump KUBE-SEP-AAAA (Pod B)
    │  rule2: statistic mode random probability 0.500 → jump KUBE-SEP-BBBB (Pod C)
    │  rule3: → jump KUBE-SEP-CCCC (Pod D)  ← 最后一条必然命中
    │  假设随机落到 rule2 → jump KUBE-SEP-BBBB
    ▼
KUBE-SEP-BBBB
    │  DNAT to 10.244.2.8:80  ← Pod C 的 IP
    │  (若 src 是本节点 Pod，还会先 KUBE-MARK-MASQ 打标)
    ▼
routing → 经 CNI veth/overlay 送到 Pod C
    │
    │  conntrack 记录: (10.244.1.5, 54321, 10.96.0.10, 80) → (10.244.1.5, 54321, 10.244.2.8, 80)
    │                  原始 ClusterIP 已被记录，用于回包还原
    ▼
Pod C 收到: src=10.244.1.5 dst=10.244.2.8

回包: src=10.244.2.8 dst=10.244.1.5
    │
    ▼
conntrack 命中已记录的连接 → 反向 NAT
    │  src 还原为 10.96.0.10 (ClusterIP)
    ▼
Pod A 收到: src=10.96.0.10 dst=10.244.1.5  ← 看起来就是和 ClusterIP 通信
```

#### 规则数量与性能

每个 Service 的规则数 ≈ `1(KUBE-SERVICES) + 1(KUBE-SVC) + N(KUBE-SEP, N=后端数)`。1 万个 Service、平均 3 后端，就有约 **4 万条**规则。所有包都要线性遍历 `KUBE-SERVICES` 链找匹配——这就是 iptables 模式的性能瓶颈。

#### 观测命令

```bash
# 查看所有 kube 相关链
sudo iptables-save | grep -E '^-A KUBE'

# 查看某 Service 的规则（KUBE-SVC-HASH 可从 KUBE-SERVICES 里找到）
sudo iptables -t nat -L KUBE-SERVICES -n | grep 10.96.0.10
sudo iptables -t nat -L KUBE-SVC-XXXXXXXX -n -v

# 查看某后端
sudo iptables -t nat -L KUBE-SEP-XXXXXXXX -n -v

# 查看连接跟踪
sudo cat /proc/net/nf_conntrack | grep 10.96.0.10
sudo conntrack -L | grep 10.96.0.10
```

### 6.3 IPVS 模式

#### 工作原理

kube-proxy 为每个 Service 创建一个 IPVS 虚拟服务（VIP=ClusterIP），每个 Pod 后端作为一个 Real Server。包到达时，IPVS 用哈希表 O(1) 查到虚拟服务，按调度算法选后端，DNAT 转发。

```bash
# 启用 IPVS 模式（kube-proxy ConfigMap）
mode: "ipvs"
ipvs:
  scheduler: "rr"          # 调度算法，默认 rr

# 节点上验证
sudo ipvsadm -Ln
# Prot LocalAddress:Port Scheduler Flags
#   -> RemoteAddress:Port           Forward Weight ActiveConn InActConn
# TCP  10.96.0.10:80 rr
#   -> 10.244.1.8:80                Masq    1      0          0
#   -> 10.244.2.5:80                Masq    1      0          0
#   -> 10.244.3.9:80                Masq    1      0          0
```

#### IPVS 模式仍需要 iptables

IPVS 不覆盖所有场景，kube-proxy 仍用 iptables（配合 ipset）做辅助：

| 用途 | iptables 规则 | ipset |
|---|---|---|
| 出节点流量 SNAT（masquerade） | `KUBE-POSTROUTING` | `KUBE-LOOP-BACK` |
| NodePort 流量标记/拦截 | `KUBE-NODE-PORT` | `KUBE-NODE-PORT-TCP/UDP` |
| ClusterIP 非节点流量过滤 | `KUBE-FIREWALL` | `KUBE-CLUSTER-IP` |
| externalIPs 处理 | - | `KUBE-EXTERNAL-IP` |

**关键点**：用 ipset 后，iptables 规则数量**与 Service 数无关**（恒定几十条），只有 ipset 集合元素随 Service 增长。这是 IPVS 模式在大规模集群性能优势的核心。

#### IPVS 模式的优势与坑

**优势**：
1. 查找 O(1)，与 Service 数无关，10 万 Service 也不退化
2. 增量更新，单个 Service 变化只增删一条 IPVS 条目，不重写全表
3. 支持多种调度算法（rr/lc/sh...），可做会话保持
4. kube-proxy CPU 恒定，不随 Service 数飙升

**坑**：
1. IPVS 的 NAT 模式包路径与纯 iptables 不同，与其他用 iptables 的组件（如 Calico 策略）可能有兼容性问题（需验证）
2. IPVS 无法完整实现 k8s Service 的所有语义（官方文档明确：「IPVS API 是 k8s Service API 的糟糕匹配，ipvs 模式从未能正确实现所有用例」）
3. 仍依赖 conntrack，conntrack 满了一样丢包
4. 需要 IPVS 内核模块全部加载，否则 kube-proxy 启动失败

```bash
# IPVS 模式前置检查（kube-proxy 启动失败时排查）
sudo lsmod | grep -E 'ip_vs|nf_conntrack'
# 应包含: ip_vs, ip_vs_rr, nf_conntrack 等

# conntrack 调优（IPVS 模式同样需要）
echo 1048576 | sudo tee /proc/sys/net/netfilter/nf_conntrack_max
```

### 6.4 nftables 模式（KEP-3866，推荐）

#### 背景

nftables 模式是 Kubernetes 官方钦定的 **iptables 和 ipvs 的替代品**（官方原话：「nftables proxy mode is essentially a replacement for both the iptables and ipvs modes」）。KEP-3866 提出，Kubernetes 1.29 引入 alpha，1.31 beta。

#### 工作原理

与 iptables 模式类似（都是写规则到 nat 表），但用 nftables 的 **sets/maps** 结构，把 ClusterIP→后端列表 的映射存进内核集合。查找走哈希，更新走集合元素增删，兼具 iptables 的语义完整性和 IPVS 的 O(1) 查找。

```
nftables set:
  name: svc-10.96.0.10:80
  type: inet_service . inet_service   # (clusterIP, port)
  elements: { 10.244.1.8, 10.244.2.5, 10.244.3.9 }  # 后端 Pod IP

规则: dst nat to @svc-10.96.0.10:80   # 命中即 DNAT 到集合里的某个后端
```

#### 三种模式对比（k8s 场景）

| 维度 | iptables 模式 | IPVS 模式 | nftables 模式 |
|---|---|---|---|
| **查找复杂度** | O(n)，线性遍历 KUBE-SERVICES | O(1)，IPVS 哈希 | O(1)，nft set 哈希 |
| **规则更新** | 全量 restore，大集群 5-15s | 增量 | 增量 |
| **kube-proxy CPU** | 随 Service 数线性增长 | 恒定 | 恒定 |
| **Service 语义完整** | 完整 | 部分缺失 | 完整 |
| **与 CNI 兼容** | 好（都用 iptables） | 需验证 | 取决于 CNI 是否支持 nft |
| **内核版本要求** | 低（2.4+） | 中（2.4+ ip_vs 模块） | 高（5.13+，建议 5.18+） |
| **官方推荐度** | 默认（历史） | 不再推荐 | **推荐**（替代 ipvs） |
| **生产成熟度** | 极成熟 | 成熟 | 较新（1.31 beta） |

#### 官方建议（引自 kubernetes.io）

> 如果你部署在能跑 nftables 模式的较新 Linux 上，用 nftables 模式；如果系统太老跑不了 nftables 模式，优先考虑 iptables 模式而不是 ipvs 模式（因为 iptables 模式这些年性能已经大幅改进）。

#### 启用 nftables 模式

```yaml
# kube-proxy ConfigMap
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
mode: "nftables"
# nftables:
#   masqueradeAll: true
```

```bash
# 节点内核版本检查（建议 5.18+）
uname -r

# nftables 工具版本（建议 1.0.6+）
nft --version

# 查看 kube-proxy 写入的 nftables 规则
sudo nft list ruleset | grep -i kube
```

### 6.5 选型决策树

```
是否新集群 + 内核 ≥ 5.18？
├─ 是 → nftables 模式（官方推荐，未来方向）
└─ 否 →
   ├─ Service 数 < 1000 + 通用性要求高 → iptables 模式（默认，最稳）
   ├─ Service 数 > 5000 + 不能升内核 → IPVS 模式（性能兜底）
   └─ 已用 Cilium/eBPF → 直接用 Cilium 替代 kube-proxy（不在此文范围）
```

### 6.6 排查命令速查

```bash
# 1. 看 kube-proxy 模式
kubectl -n kube-system get cm kube-proxy -o yaml | grep mode

# 2. iptables 模式排查
sudo iptables-save | grep KUBE | wc -l           # 规则总数
sudo iptables -t nat -L KUBE-SERVICES -n | wc -l  # Service 入口链长度
sudo iptables -t nat -L KUBE-SVC-<HASH> -n -v     # 某 Service 后端

# 3. IPVS 模式排查
sudo ipvsadm -Ln                                   # 虚拟服务表
sudo ipvsadm -Ln --stats                           # 流量统计
sudo ipvsadm -Ln --rate                            # 实时速率

# 4. nftables 模式排查
sudo nft list ruleset                              # 完整规则集
sudo nft list sets                                 # 所有集合（ClusterIP 映射）

# 5. conntrack（三种模式通用）
cat /proc/sys/net/netfilter/nf_conntrack_count     # 当前连接数
cat /proc/sys/net/netfilter/nf_conntrack_max       # 上限
sudo conntrack -L | grep <PodIP>                   # 看某 Pod 的连接
sudo conntrack -L -p tcp --state ESTABLISHED | wc -l

# 6. 抓包确认 DNAT 是否生效
sudo tcpdump -i any -nn 'host <ClusterIP>'         # 看不到 ClusterIP 说明已 DNAT
sudo tcpdump -i any -nn 'host <PodIP>'             # 应能看到 DNAT 后的真实后端
```

---

## 七、典型问题与排查

### 7.1 conntrack 表满

**现象**：`dmesg` 出现 `nf_conntrack: table full, dropping packet`，业务间歇性超时。

**根因**：`nf_conntrack_count` 达到 `nf_conntrack_max`，新连接被丢。常见于大集群、短连接多、或 `tcp_timeout_established`（默认 5 天）导致老条目不释放。

**处理**：

```bash
# 临时调大
echo 1048576 | sudo tee /proc/sys/net/netfilter/nf_conntrack_max

# 永久生效
cat <<'EOF' | sudo tee -a /etc/sysctl.d/99-conntrack.conf
net.netfilter.nf_conntrack_max = 1048576
net.netfilter.nf_conntrack_tcp_timeout_established = 3600
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
net.netfilter.nf_conntrack_udp_timeout = 15
EOF
sudo sysctl --system

# k8s 节点可在 kube-proxy 启动参数或 init container 里设置
# --conntrack-max-per-core=0 (0 表示用内核默认), --conntrack-tcp-established-timeout=3600s
```

### 7.2 iptables 规则更新导致 kube-proxy CPU 飙高

**现象**：Service 频繁变更时，kube-proxy CPU 100%，`iptables-restore` 单次耗时数秒。

**根因**：iptables 模式下，任何 Service 变更都要全量重写整张 nat 表。规则数到 10 万级时，单次 restore 耗 CPU 显著。

**处理**：
- 短期：减少 Service 抖动（EndpointSlice 平滑、就绪探针合理）
- 中期：切换到 IPVS 模式（增量更新）
- 长期：升级内核，切到 nftables 模式

### 7.3 IPVS 模式下 kube-proxy 启动失败

**现象**：kube-proxy 日志报 `ipvs module not loaded` 或 `IPVS proxier failed to initialize`。

**排查**：

```bash
# 检查内核模块
sudo lsmod | grep ip_vs
# 若为空，手动加载
sudo modprobe ip_vs ip_vs_rr nf_conntrack

# 检查内核是否编译了 IPVS
grep IP_VS /boot/config-$(uname -r)

# 检查 kube-proxy 日志
kubectl -n kube-system logs -l k8s-app=kube-proxy | grep -i ipvs
```

### 7.4 nftables 与 iptables 规则冲突

**现象**：升级到 nftables 模式后，部分流量不符合预期。

**根因**：同一 hook 上，iptables(-nft) 写的规则和 nftables 原生规则按 priority 共存。若两边都写了 NAT，可能互相覆盖。

**排查**：

```bash
# 同时查看两套规则（iptables-nft 后端下，iptables 命令查的就是 nft 规则）
sudo iptables-save
sudo nft list ruleset

# 确认 iptables 后端
sudo update-alternatives --display iptables
```

---

## 八、参考文档

- nftables wiki：<https://wiki.nftables.org/>
- nftables - Netfilter hooks：<https://wiki.nftables.org/wiki-nftables/index.php/Netfilter_hooks>
- nftables - Quick reference (10 minutes)：<https://wiki.nftables.org/wiki-nftables/index.php/Quick_reference-nftables_in_10_minutes>
- Linux Kernel - Netfilter Conntrack Sysfs：<https://docs.kernel.org/networking/nf_conntrack-sysctl.html>
- Linux Kernel - Flowtable infrastructure：<https://docs.kernel.org/networking/nf_flowtable.html>
- netfilter.org - Hacking HOWTO：<https://netfilter.org/documentation/HOWTO/netfilter-hacking-HOWTO-3.html>
- Kubernetes - Virtual IPs and Service Proxies：<https://kubernetes.io/docs/reference/networking/virtual-ips/>
- Kubernetes - IPVS proxier README：<https://github.com/kubernetes/kubernetes/blob/master/pkg/proxy/ipvs/README.md>
- Red Hat - Getting started with nftables：<https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/configuring_firewalls_and_packet_filters/getting-started-with-nftables_firewall-packet-filters>
- Thermalcircle - Nftables packet flow and Netfilter hooks in detail：<https://thermalcircle.de/doku.php?id=blog:linux:nftables_packet_flow_netfilter_hooks_detail>
- DigitalOcean - A Deep Dive into Iptables and Netfilter Architecture：<https://www.digitalocean.com/community/tutorials/a-deep-dive-into-iptables-and-netfilter-architecture>
- Tigera - Comparing kube-proxy modes: iptables or IPVS：<https://www.tigera.io/blog/comparing-kube-proxy-modes-iptables-or-ipvs/>
