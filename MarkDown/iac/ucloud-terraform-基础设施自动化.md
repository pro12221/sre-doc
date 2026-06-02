# UCloud Terraform 基础设施自动化

> 使用 Terraform 管理 UCloud 云资源，实现基础设施即代码（IaC）。

## 环境准备

### 1. 安装 Terraform

```bash
# macOS
brew install terraform

# Windows - 从 https://developer.hashicorp.com/terraform/downloads 下载

# Linux
wget https://releases.hashicorp.com/terraform/1.9.8/terraform_1.9.8_linux_amd64.zip
unzip terraform_1.9.8_linux_amd64.zip
sudo mv terraform /usr/local/bin/
```

### 2. 获取 UCloud API 密钥

登录 [UCloud 控制台](https://console.ucloud.cn/uapi/apikey) → API 密钥管理，创建一对密钥，获取：

- `PublicKey`
- `PrivateKey`
- `ProjectId`（子账号必填）

### 3. 配置环境变量（推荐）

```bash
export UCLOUD_PUBLIC_KEY="你的PublicKey"
export UCLOUD_PRIVATE_KEY="你的PrivateKey"
export UCLOUD_PROJECT_ID="你的ProjectId"
```

---

## 项目结构

```
IaC/
└── ucloud-cn-wlcb/          # 乌兰察布地域基础设施
    ├── main.tf               # 核心资源定义
    ├── variables.tf          # 变量声明
    ├── outputs.tf            # 输出定义
    └── terraform.tfvars      # 密钥配置（不提交到 Git）
```

---

## Terraform 代码

### main.tf — 核心资源

```hcl
terraform {
  required_providers {
    ucloud = {
      source  = "ucloud/ucloud"
      version = "~> 1.39.0"
    }
  }
}

provider "ucloud" {
  public_key  = var.ucloud_public_key
  private_key = var.ucloud_private_key
  project_id  = var.ucloud_project_id
  region      = "cn-wlcb"
}

# Data source: find Ubuntu 24.04 base image
data "ucloud_images" "ubuntu" {
  availability_zone = "cn-wlcb-01"
  name_regex        = "^Ubuntu 24.04"
  image_type        = "base"
}

# Create 3 UHost instances with 200GB data disks inline
resource "ucloud_instance" "new" {
  count             = 3
  availability_zone = "cn-wlcb-01"
  image_id          = data.ucloud_images.ubuntu.images[0].id
  instance_type     = "o-basic-4"
  name              = "tf-instance-${count.index + 1}"
  tag               = "tf-managed"
  boot_disk_type    = "cloud_rssd"
  boot_disk_size    = 20
  vpc_id            = "uvnet-l1iy0umj"
  subnet_id         = "subnet-32bsfnag"
  charge_type       = "dynamic"

  # 200GB RSSD data disk - created with the instance
  data_disks {
    size = 200
    type = "cloud_rssd"
  }
  delete_disks_with_instance = true

  # SSH key login
  login_mode  = "KeyPair"
  key_pair_id = "6264dd"
}

# Create 3 EIPs
resource "ucloud_eip" "new" {
  count         = 3
  name          = "tf-eip-${count.index + 1}"
  tag           = "tf-managed"
  bandwidth     = 1
  charge_mode   = "bandwidth"
  internet_type = "bgp"
  charge_type   = "dynamic"
}

# Bind EIP to instances
resource "ucloud_eip_association" "new" {
  count       = 3
  eip_id      = ucloud_eip.new[count.index].id
  resource_id = ucloud_instance.new[count.index].id
}
```

### variables.tf — 变量声明

```hcl
variable "ucloud_public_key" {
  type      = string
  sensitive = true
}

variable "ucloud_private_key" {
  type      = string
  sensitive = true
}

variable "ucloud_project_id" {
  type      = string
  sensitive = true
}
```

### outputs.tf — 输出定义

```hcl
output "instance_ids" {
  value = ucloud_instance.new[*].id
}

output "instance_public_ips" {
  value = ucloud_eip.new[*].public_ip
}

output "instance_private_ips" {
  value = ucloud_instance.new[*].private_ip
}
```

### terraform.tfvars — 密钥配置

```hcl
ucloud_public_key  = "你的PublicKey"
ucloud_private_key = "你的PrivateKey"
ucloud_project_id  = "org-j41zws"
```

> ⚠️ **此文件包含敏感信息，绝不能提交到 Git。** 已在 `.gitignore` 中排除。

---

## 操作流程

### 初始化

```bash
cd IaC/ucloud-cn-wlcb
terraform init
```

### 预览变更

```bash
terraform plan
```

### 部署

```bash
terraform apply
```

### 查看输出

```bash
terraform output
```

### 销毁

```bash
terraform destroy
```

---

## 资源清单

本次部署创建 9 个资源：

| 资源类型 | 数量 | 说明 |
|---|---|---|
| `ucloud_instance` | 3 | O 型 4C8G 云主机，Ubuntu 24.04，20GB RSSD 系统盘 + 200GB RSSD 数据盘 |
| `ucloud_eip` | 3 | BGP 弹性公网 IP，1Mbps 带宽 |
| `ucloud_eip_association` | 3 | EIP 绑定到云主机 |

### 网络配置

| 项目 | 值 |
|---|---|
| 地域 | cn-wlcb（乌兰察布） |
| 可用区 | cn-wlcb-01 |
| VPC | uvnet-l1iy0umj（DefaultVPC，10.60.0.0/16） |
| 子网 | subnet-32bsfnag（DefaultNetwork） |

### 登录方式

```bash
ssh root@<公网IP>
```

使用 SSH 密钥对（KeyPair ID: `6264dd`）登录，无需密码。

### 数据盘初始化

登录主机后执行：

```bash
# 查看数据盘设备名（通常为 /dev/vdb）
lsblk

# 格式化
mkfs.ext4 /dev/vdb

# 创建挂载点并挂载
mkdir -p /data
mount /dev/vdb /data

# 开机自动挂载
echo '/dev/vdb /data ext4 defaults 0 0' >> /etc/fstab

# 验证
df -h /data
```

---

## 扩展指南

### 扩容（增加实例数）

修改 `main.tf` 中 `count = 3` 为所需数量，然后 `terraform apply`。Terraform 会自动只创建新增的实例。

### 缩容

减少 `count` 值，`terraform apply` 会自动销毁多余的实例（从末尾编号开始移除）。

### 升级配置

修改 `instance_type`（如 `o-basic-4` → `o-basic-8`），需同时设置：

```hcl
allow_stopping_for_update = true
```

Terraform 会先停机再变更配置。

### 添加更多资源

| 需求 | 添加资源类型 |
|---|---|
| 负载均衡 | `ucloud_lb` + `ucloud_lb_listener` + `ucloud_lb_attachment` |
| 安全组 | `ucloud_security_group` |
| 云数据库 | `ucloud_db_instance` |
| Redis | `ucloud_redis_instance` |
| 自定义 VPC | `ucloud_vpc` + `ucloud_subnet` |

---

## 注意事项

1. **数据盘挂载方式**：使用 `data_disks` 内联块随实例一起创建，避免独立 `ucloud_disk` + `ucloud_disk_attachment` 的并发竞态问题
2. **ForceNew 字段**：`availability_zone`、`boot_disk_type` 等字段变更会触发资源重建
3. **计费模式**：`charge_type = "dynamic"` 为按小时计费，生产环境建议改为 `month` 包月
4. **状态文件**：`terraform.tfstate` 包含敏感信息，生产环境应使用远程 Backend（如 S3）存储
5. **`terraform.tfvars`**：包含 API 密钥，已在 `.gitignore` 中排除，不得提交到版本库
