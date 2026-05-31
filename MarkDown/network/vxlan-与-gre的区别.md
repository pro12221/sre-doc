# VXLAN 与 GRE 的区别

云数据中心网络从 VLAN 走向 Overlay 后，最常见的两类隧道封装是 VXLAN 和 GRE。它们都能把一段原始报文封装进新的三层报文里，让原本不在同一个二层网络或路由域中的主机跨越 Underlay 通信；但二者的设计目标、封装格式、可扩展性和云网络适配程度完全不同。

## 1. 先说结论

VXLAN 是面向大规模云数据中心多租户网络设计的二层 Overlay 技术，核心目标是替代 VLAN，并在 Leaf-Spine Underlay 之上承载海量虚拟网络。

GRE 是更通用的三层隧道封装技术，核心目标是“把一种三层协议封装进另一种三层协议”，常用于点到点隧道、跨网络互联、VPN、动态路由穿越等场景。

一句话区分：

> VXLAN 更像“云数据中心里的虚拟二层交换网络”；GRE 更像“通用 IP 隧道工具”。

## 2. 二者解决的问题不同

### VXLAN 解决什么问题

VXLAN 主要解决传统 VLAN 在云数据中心里的三个瓶颈：

- VLAN ID 只有 12 bit，最多约 4096 个，无法支撑大规模租户隔离
- 虚拟机和容器会在不同宿主机之间迁移，需要跨三层 Underlay 维持逻辑二层连通
- 东西向流量巨大，需要配合 Leaf-Spine、ECMP、硬件 offload 做规模化转发

VXLAN 的核心不是“打通一条隧道”，而是“构建很多张虚拟二层网络”。

### GRE 解决什么问题

GRE 的目标更通用：

- 在两个三层节点之间建立隧道
- 承载原本 Underlay 不直接支持的协议
- 跨公网或跨运营商网络打通私有地址空间
- 让动态路由协议、组播或特殊协议穿越普通 IP 网络

GRE 的核心不是多租户大规模虚拟网络，而是“通用封装与点到点互联”。

## 3. 封装结构不同

### VXLAN 封装

VXLAN 把原始二层以太帧封装进 UDP 报文中，默认目的端口是 4789。

```text
Outer Ethernet
Outer IP
UDP
VXLAN Header
Inner Ethernet
Inner IP
TCP/UDP/ICMP
Payload
```

关键点：

- 外层 IP 用于 Underlay 转发
- UDP 端口让物理网络可以基于五元组做 ECMP 哈希
- VXLAN Header 中的 VNI 用于标识虚拟网络
- 内层 Ethernet 是租户看到的原始二层报文

### GRE 封装

GRE 直接在 IP 之上增加 GRE Header，IP Protocol 号是 47。

```text
Outer Ethernet
Outer IP
GRE Header
Inner IP / Inner Ethernet / Other Protocol
Payload
```

关键点：

- GRE 不依赖 UDP/TCP 端口
- GRE 可以封装多种三层协议，也可以通过扩展承载二层
- 普通 GRE 天然更像点到点隧道
- 由于没有 UDP 端口，传统 ECMP 设备可能只能看到外层源/目的 IP，负载分担粒度较粗

## 4. 标识空间不同：VNI vs Key

VXLAN 使用 VNI（VXLAN Network Identifier）标识虚拟网络。

- VNI 长度：24 bit
- 可支持约 1600 万个逻辑网络
- 面向多租户、大规模虚拟网络隔离

GRE 可以使用可选的 Key 字段区分隧道或租户。

- GRE Key 通常是 32 bit
- 是否启用取决于具体实现
- 标准 GRE 本身没有像 VXLAN VNI 那样围绕云租户网络形成统一生态

所以不能简单说 GRE Key 比 VNI 长就更适合云网络。云网络看重的不只是字段长度，还包括控制平面、硬件转发、ECMP、网关、VTEP 发现和运维生态。

## 5. ECMP 友好度不同

云数据中心 Underlay 通常依赖 ECMP 把东西向流量分散到多条 Spine 路径上。

VXLAN 使用 UDP 封装，外层报文有源 IP、目的 IP、源端口、目的端口、协议号。很多 VTEP 会根据内层五元组计算 UDP 源端口，让不同租户流量在 Underlay 中分散到不同路径。

```text
VM A -> VM B: UDP Source Port 35001 -> Spine1
VM C -> VM D: UDP Source Port 42017 -> Spine2
VM E -> VM F: UDP Source Port 50123 -> Spine3
```

GRE 没有 UDP 端口，很多网络设备只能基于外层源 IP、目的 IP、协议号做哈希。如果两个隧道端点之间流量很大，就容易落到同一条路径上，导致 ECMP 利用率不如 VXLAN。

这也是 VXLAN 更适合 Leaf-Spine 云数据中心的关键原因之一。

## 6. NAT 和防火墙穿越能力不同

VXLAN 基于 UDP，网络设备能识别端口，防火墙策略也比较直接：

- UDP 4789 是标准 VXLAN 端口
- 可以按 UDP 端口放行
- NAT 设备对 UDP 的处理通常更成熟
- 但生产数据中心 VXLAN 一般运行在受控 Underlay 内，不建议随意穿越公网 NAT

GRE 使用 IP Protocol 47，不是 TCP/UDP 端口。

- 某些 NAT 或防火墙对 GRE 支持不好
- 放行规则不是“端口放行”，而是协议号放行
- 多个 GRE 会话穿越同一个 NAT 时可能遇到识别和映射问题

因此跨复杂网络边界时，GRE 经常比 UDP 类隧道更容易被中间设备限制。

## 7. 二层语义不同

VXLAN 天生就是把二层以太帧封装到三层网络中。

这意味着 VXLAN 可以直接承载：

- ARP
- IPv4
- IPv6
- 广播
- 未知单播
- 组播
- 同一虚拟二层网络内的东西向通信

GRE 默认更偏向三层隧道，例如 IP over GRE。它也可以通过不同变体承载二层，例如 Ethernet over GRE、gretap，但这不是现代云数据中心的主流多租户模型。

## 8. 控制平面生态不同

VXLAN 在云数据中心里通常和控制平面一起使用：

- EVPN + VXLAN
- OpenStack Neutron + OVS/OVN
- Kubernetes CNI VXLAN 模式
- 云厂商 VPC 控制系统
- 硬件 VTEP
- 分布式网关

控制平面负责回答这些问题：

- 某个 VNI 对应哪个租户网络？
- 某个 MAC/IP 当前在哪个 VTEP？
- 哪些 VTEP 需要建立隧道？
- ARP/ND 如何抑制？
- 跨子网流量走哪个分布式网关？

GRE 也可以被路由协议、VPN 系统和 SDN 控制器管理，但它不是为大规模 L2 VNI、分布式网关和云租户生命周期设计出来的主流抽象。

## 9. 性能与硬件支持不同

VXLAN 已经成为主流云数据中心网络硬件的重点优化对象。

常见能力包括：

- 网卡 VXLAN checksum offload
- 网卡 TSO/GSO offload
- 交换机 VXLAN routing/bridging
- ASIC 硬件 VTEP
- DPU/SmartNIC 卸载 VXLAN、安全组、转发策略

GRE 也有硬件和内核支持，但在云数据中心大规模 Overlay 网络中的生态成熟度通常不如 VXLAN。

如果目标是构建 VPC、租户隔离、弹性迁移和分布式网关，VXLAN 的产业链更完整。

## 10. MTU 开销不同

VXLAN 和 GRE 都会增加额外封装头，都会降低有效载荷空间。

常见 IPv4 VXLAN 封装开销：

```text
Outer Ethernet 14B
Outer IP       20B
UDP             8B
VXLAN           8B
合计约          50B
```

普通 IPv4 GRE 封装开销通常更小：

```text
Outer IP       20B
GRE             4B
合计约          24B
```

如果包含外层以太网头，链路上的总帧长度还要再加二层头部。

结论：GRE 头部通常更轻；VXLAN 头部更重，但换来 VNI、UDP ECMP 和云网络生态。

因此 VXLAN 环境常见做法是把 Underlay MTU 调大，例如 1550、1600 或 9000，避免 Overlay 报文因为额外封装而分片。

## 11. 典型使用场景对比

| 场景 | 更常用选择 | 原因 |
|---|---|---|
| 云数据中心 VPC | VXLAN | VNI 支持大规模租户隔离，控制平面生态完整 |
| Kubernetes Pod Overlay | VXLAN | CNI 容易实现跨 Node 二层/三层 Overlay |
| EVPN 数据中心 Fabric | VXLAN | EVPN+VXLAN 是主流标准组合 |
| 点到点跨网络隧道 | GRE | 配置简单，适合三层互联 |
| 跑动态路由协议穿越公网或专线 | GRE/IPsec GRE | GRE 可承载路由协议，常与 IPsec 组合 |
| 需要 Underlay ECMP 充分分流 | VXLAN | UDP 源端口可参与五元组哈希 |
| 受限防火墙/NAT 环境 | VXLAN/其他 UDP 隧道通常更友好 | GRE 是 IP Protocol 47，不是端口 |

## 12. VXLAN 与 GRE 对比总表

| 维度 | VXLAN | GRE |
|---|---|---|
| 技术定位 | 云数据中心二层 Overlay | 通用三层隧道封装 |
| 封装方式 | MAC-in-UDP | Protocol-in-IP |
| 默认协议/端口 | UDP 4789 | IP Protocol 47 |
| 网络标识 | 24 bit VNI | 可选 Key 字段 |
| 多租户规模 | 很强，约 1600 万 VNI | 可实现，但不是主流云网络抽象 |
| ECMP 友好度 | 强，UDP 源端口可参与哈希 | 较弱，传统设备哈希粒度有限 |
| NAT/防火墙 | 相对容易按 UDP 端口处理 | 依赖设备对 GRE 协议号支持 |
| 二层能力 | 原生承载以太帧 | 需 GRE 变体承载二层 |
| 控制平面生态 | EVPN、OVN、Neutron、CNI、VPC | 路由隧道、VPN、点到点互联 |
| 硬件卸载生态 | 云数据中心支持广泛 | 有支持，但云 Overlay 生态弱一些 |
| 典型用途 | VPC、虚拟网络、Pod 网络、EVPN Fabric | IP 隧道、跨网互联、GRE over IPsec |

## 13. 在云数据中心里为什么更偏向 VXLAN

现代云数据中心选择 VXLAN，不是因为 GRE 不能封装，而是因为 VXLAN 更符合云网络的系统性需求：

1. VNI 天然对应租户虚拟网络
2. UDP 封装更适合 Leaf-Spine ECMP
3. 可以承载完整二层语义，便于虚拟机迁移和虚拟子网抽象
4. EVPN/SDN 控制平面生态成熟
5. 交换机、网卡、DPU 对 VXLAN 的硬件卸载更普遍
6. 和 VPC、安全组、分布式网关等云产品模型更匹配

GRE 的优势在于简单、通用、头部开销较低，适合点到点隧道和三层互联；但当规模上升到“成千上万个租户网络 + 海量宿主机 + 自动化控制平面”时，VXLAN 更容易形成标准化架构。

## 14. 记忆口诀

记住这四句话即可：

1. VXLAN 是云数据中心 Overlay 主力，GRE 是通用 IP 隧道工具。
2. VXLAN 用 UDP + VNI，GRE 用 IP Protocol 47 + 可选 Key。
3. VXLAN 更适合 ECMP、多租户、VPC、EVPN 和分布式网关。
4. GRE 更适合点到点三层隧道、路由协议穿越和 GRE over IPsec。

最终选择原则：

> 构建云数据中心虚拟网络，优先 VXLAN；打通简单三层隧道或承载特殊协议，可以考虑 GRE。
