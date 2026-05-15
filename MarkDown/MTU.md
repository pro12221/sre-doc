# IP包结构与MTU位置



## IP 数据包结构（IPv4 Header）

一个 IPv4 包的头部固定 20 字节（无选项时），结构如下：

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|Version|  IHL  |Type of Service|          Total Length         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|         Identification        |Flags|      Fragment Offset    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Time to Live |    Protocol   |         Header Checksum       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       Source Address                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Destination Address                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Options                    |    Padding    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| 字段 | 长度 | 含义 |
|---|---|---|
| Version | 4 bit | 版本号，IPv4 = 4 |
| IHL | 4 bit | 头部长度（单位 4 字节），最小 5（即 20 字节） |
| TOS / DSCP | 8 bit | 服务质量 / 差分服务 |
| **Total Length** | **16 bit** | **整个 IP 包长度（头部 + 数据），最大 65535 字节** |
| Identification | 16 bit | 分片标识，同一包的分片共享同一 ID |
| Flags | 3 bit | DF（禁止分片）、MF（还有更多分片） |
| Fragment Offset | 13 bit | 分片偏移（单位 8 字节） |
| TTL | 8 bit | 每经一跳减 1，归零则丢弃 |
| Protocol | 8 bit | 上层协议：6=TCP, 17=UDP, 1=ICMP |
| Header Checksum | 16 bit | 头部校验和 |
| Source Address | 32 bit | 源 IP |
| Destination Address | 32 bit | 目的 IP |

关键点：**Total Length 是整个 IP 包的长度，而 MTU 限制了它不能超过链路层的最大值。**

---

## MTU 在哪里

MTU（Maximum Transmission Unit）是**数据链路层**的概念，限制的是**一个帧（frame）的 payload 大小**，也就是 IP 包（含头部）的最大长度。

### 各链路层的典型 MTU

| 链路类型 | MTU |
|---|---|
| **以太网（Ethernet）** | **1500 字节**（最常见） |
| IEEE 802.3 | 1492 字节 |
| PPPoE | 1492 字节（减去 8 字节 PPPoE 头） |
| Wi-Fi (802.11) | 2304 字节 |
| Loopback | 65535 字节 |
| Jumbo Frame（某些数据中心） | 9000 字节 |

### MTU 在协议栈中的位置

```
┌──────────────────────────┐
│       Application        │
├──────────────────────────┤
│    TCP / UDP (头部)       │
├──────────────────────────┤
│    IP Header (20B)       │  ← Total Length 字段记录整个 IP 包长度
│    IP Payload             │
├──────────────────────────┤  ← MTU 限制切在这里：IP包总长 ≤ MTU
│  Ethernet Header (14B)   │
│  Ethernet Payload (=IP包) │  ← 帧的 payload 就是整个 IP 包
│  Ethernet FCS (4B)       │
└──────────────────────────┘
```

**MTU 限制的是以太网帧的 payload 部分**，即 IP 包（含 IP 头）最大 1500 字节。以太网帧头 14 字节 + FCS 4 字节不在 MTU 范围内。

### 超过 MTU 会怎样？

1. **DF=0（允许分片）**：IP 层将包切片，每片 ≤ MTU，到目的端重组
2. **DF=1（禁止分片）**：路由器丢弃包，回送 **ICMP Fragmentation Needed**（Type 3, Code 4），触发 **PMTUD（Path MTU Discovery）**

### Linux 上查看/设置 MTU

```bash
# 查看所有接口 MTU
ip link show

# 查看特定接口
ip link show eth0

# 修改 MTU（临时）
sudo ip link set eth0 mtu 9000

# 永久修改（Netplan / NetworkManager 视发行版而定）
```

### 内核代码层面（Linux）

MTU 定义在 `net_device` 结构体中：

```c
// include/linux/netdevice.h
struct net_device {
    unsigned int    mtu;        // 接口 MTU 值
    unsigned short  type;       // 接口类型 (ARPHRD_ETHER 等)
    unsigned short  hard_header_len; // L2 头部长度
    ...
};
```

初始化时各驱动设置默认 MTU：
- 以太网驱动：`dev->mtu = 1500`（如 `drivers/net/ethernet/intel/e1000/e1000_main.c`）
- Loopback：`dev->mtu = 65535`

---

**总结**：IP 包头部 20 字节起，Total Length 记录整包长度；MTU 是链路层对帧 payload 的限制（以太网 1500 字节），IP 包超过 MTU 就要分片或触发 PMTUD。

---


## 封装过程（从上到下）

假设你发一条 HTTP 请求 `"Hello"`：

```
应用层:  "Hello"
           │
           ▼ 加上 HTTP 头
应用层:  [HTTP头 | Hello]
           │
           ▼ 整体当作 TCP 的"数据"，加上 TCP 头
传输层:  [TCP头 | [HTTP头 | Hello]]
           │
           ▼ 整体当作 IP 的"数据"，加上 IP 头
网络层:  [IP头 | [TCP头 | [HTTP头 | Hello]]]
           │
           ▼ 整体当作以太网的"数据"，加上帧头帧尾
链路层:  [以太网头 | [IP头 | [TCP头 | [HTTP头 | Hello]]] | FCS]
```

**每一层看"数据"的定义不同：**

| 层 | 它说的"数据"是什么 | 它的头部 |
|---|---|---|
| 链路层 | 整个 IP 包（IP头+TCP头+HTTP头+Hello） | 以太网头 14B |
| 网络层 | TCP段（TCP头+HTTP头+Hello） | IP头 20B |
| 传输层 | 应用数据（HTTP头+Hello） | TCP头 20B |
| 应用层 | Hello | HTTP头 |

所以 **"Hello" 这份数据从头到尾都在，只是被一层层包起来了**。三层不是没有数据，而是三层把自己的头部加在最外面，里面包裹的就是上层的全部内容。

## MTU 限制的是什么

```
←─────────── MTU 1500 ──────────→
┌────────┬────────┬──────┬───────┐
│以太网头 │  IP头   │TCP头 │Hello  │
│ 14B    │ 20B    │20B   │1460B  │
└────────┴────────┴──────┴───────┘
│← 不算 →│←──── 这些全算 ────→│
```

- **MTU 1500 限制的是以太网帧的 payload**，也就是从 IP 头开始往后所有内容的总长度
- 以太网头（14B）和 FCS（4B）**不算在 MTU 里**
- 所以应用层实际能用的最大载荷 = 1500 - 20(IP头) - 20(TCP头) = **1460 字节**（这叫 MSS）

## 一个常见误解

你可能是这么想的：

```
❌ 错误理解：各层平分空间
┌──────────┬──────────┬──────────┬──────────┐
│ 二层占的  │ 三层占的  │ 四层占的  │ 应用层   │
└──────────┴──────────┴──────────┴──────────┘
```

实际是：

```
✅ 正确理解：层层嵌套
┌──────────────────────────────────────────┐
│ 二层头 │ ┌──────────────────────────┐    │
│        │ │ 三层头 │ ┌────────────┐  │    │
│        │ │        │ │四层头│Hello│  │    │
│        │ │        │ └────────────┘  │    │
│        │ └──────────────────────────┘    │
└──────────────────────────────────────────┘
```

**"Hello" 这份数据在每一层都存在，只是从各层的视角来看，它被包在不同的头部里面。**

---

