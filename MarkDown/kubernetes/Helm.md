# Helm — Kubernetes 包管理工具

Helm 是 Kubernetes 的包管理工具，相当于 CentOS 的 `yum` 或 Ubuntu 的 `apt`。它通过 Chart 来定义、安装和升级复杂的 Kubernetes 应用，解决了手动编写和维护大量 YAML 资源清单文件的痛点。

---

## 核心概念

| 概念 | 说明 |
|---|---|
| **Chart** | Helm 的包格式，包含一组描述 Kubernetes 资源的文件 |
| **Repository** | Chart 仓库，存放和共享 Chart 的 HTTP 服务器 |
| **Release** | Chart 在 Kubernetes 集群中运行的一个实例，同一 Chart 可多次安装 |
| **Revision** | Release 的版本号，每次安装、升级或回滚递增 1 |
| **Values** | 配置参数，通过 `values.yaml` 或 `--set` 传入，控制模板渲染 |

### Helm v2 vs v3

Helm v3 于 2019 年 11 月发布，是当前推荐版本。核心变化：

| 对比维度 | Helm v2 | Helm v3 |
|---|---|---|
| 服务端组件 | **Tiller**（需部署在集群中） | **无服务端**（直接与 API Server 通信） |
| 权限模型 | Tiller 拥有集群级权限，安全隐患大 | 使用本地 kubeconfig 的 RBAC 权限 |
| Release 存储 | ConfigMap 存储 | Secret 存储（默认）或 ConfigMap |
| 命名空间 | Tiller 跨命名空间 | Release 按命名空间隔离 |
| CRD 支持 | 有限 | 原生支持 CRD |
| 三方库 | 无 | 内置 Lua 脚本引擎 |

**⚠️ Helm v2 已于 2020 年停止维护，新项目应使用 v3。**

---

## 安装与配置

### 安装 Helm CLI

从 [GitHub Releases](https://github.com/helm/helm/releases) 下载对应平台的二进制文件（国内可使用 [华为云镜像](https://mirrors.huaweicloud.com/helm/) 加速下载），解压后将 `helm` 放入 `PATH`：

```bash
# 验证安装
helm version
# 输出示例:
# version.BuildInfo{Version:"v3.16.0", GitCommit:"...", GoVersion:"go1.22.0"}
```

**前置条件**：本地已配置好 `kubectl` 可访问目标集群，Helm 会读取 `~/.kube/config` 文件。

### 配置 Chart 仓库

```bash
# 添加国内镜像仓库（推荐）
helm repo add stable http://mirror.azure.cn/kubernetes/charts/

# 添加 bitnami 仓库（如果网络可达）
# helm repo add bitnami https://charts.bitnami.com/bitnami

# 查看已添加仓库
helm repo list

# 更新本地仓库索引
helm repo update

# 搜索 Chart
helm search repo nginx
helm search repo stable/
```

> **注意**：`stable` 和 `incubator` 官方仓库已于 2020 年 11 月停止维护。国内用户推荐使用 `http://mirror.azure.cn/kubernetes/charts/`（Azure 中国镜像）或阿里云 App Hub 等国内仓库，速度和可用性更佳。

---

## 基本使用

### 安装 Chart

```bash
# 安装 MySQL（自动生成 release 名称）
helm install stable/mysql --generate-name

# 安装并指定 release 名称
helm install my-release stable/nginx-ingress

# 安装到指定命名空间
helm install my-release stable/nginx-ingress --namespace staging --create-namespace

# 模拟安装（dry-run），不实际部署
helm install my-release stable/nginx-ingress --dry-run --debug
```

### 查看 Release

```bash
# 列出当前命名空间下的 release
helm list
helm ls

# 列出所有命名空间下的 release
helm list -A

# 查看 release 状态
helm status my-release

# 查看 release 的 values
helm get values my-release

# 查看 release 的全部资源清单
helm get manifest my-release

# 查看 release 历史
helm history my-release
```

### 卸载 Release

```bash
# 卸载 release
helm uninstall my-release

# 卸载但保留历史记录（后续可回滚恢复）
helm uninstall my-release --keep-history
```

---

## 定制配置

### 查看可配置项

```bash
# 查看 Chart 的所有可配置参数
helm show values stable/nginx-ingress
```

### 覆盖配置值

两种方式传递配置，优先级从低到高：

1. **`-f` / `--values`**：指定 YAML 文件
2. **`--set`**：命令行直接设置

```bash
# 通过 YAML 文件覆盖
cat > myvalues.yaml <<EOF
service:
  type: NodePort
  port: 8080
replicaCount: 3
EOF

helm install my-release stable/nginx-ingress -f myvalues.yaml

# 通过 --set 覆盖
helm install my-release stable/nginx-ingress \
  --set service.type=NodePort \
  --set replicaCount=3

# 两者同时使用，--set 优先级更高
helm install my-release stable/nginx-ingress -f base.yaml --set replicaCount=5
```

### `--set` 高级用法

```bash
# 嵌套属性
--set outer.inner=value

# 列表
--set servers[0].port=80,servers[0].host=example.com

# 列表简写
--set name={a,b,c}

# 特殊字符转义
--set name=value1\,value2       # 对应 "value1,value2"
--set nodeSelector."kubernetes\.io/role"=master
```

### 查看已设置的 Values

```bash
helm get values my-release
# 输出:
# USER-SUPPLIED VALUES:
# replicaCount: 5
# service:
#   type: NodePort
```

---

## 升级与回滚

### 升级 Release

```bash
# 升级到新版本 Chart
helm upgrade my-release stable/nginx-ingress

# 升级并修改配置
helm upgrade my-release stable/nginx-ingress --set replicaCount=5

# 升级时重置所有 values（清除 --set 历史值）
helm upgrade my-release stable/nginx-ingress --reset-values

# 复用安装时的 values，只改部分
helm upgrade my-release stable/nginx-ingress --reuse-values --set image.tag=latest
```

### 回滚 Release

```bash
# 查看历史版本
helm history my-release
# REVISION  UPDATED                  STATUS      CHART         DESCRIPTION
# 1         Mon Jan  1 10:00:00     superseded  nginx-18.1.0  Install complete
# 2         Mon Jan  1 11:00:00     deployed    nginx-18.1.0  Upgrade complete

# 回滚到指定版本
helm rollback my-release 1

# 回滚后验证
helm get values my-release
```

### 有用参数

| 参数 | 说明 |
|---|---|
| `--timeout 600s` | 等待 Kubernetes 操作完成的最大时间（默认 5 分钟） |
| `--wait` | 等待所有 Pod 就绪后再标记成功 |
| `--atomic` | 升级失败自动回滚（等价于 `--wait` + 失败时 `rollback`） |
| `--no-hooks` | 跳过 hook 执行 |
| `--force` | 强制重建资源（慎用） |

---

## Chart 详解

### 文件结构

```
wordpress/
├── Chart.yaml          # Chart 元数据（必须）
├── values.yaml         # 默认配置值
├── values.schema.json  # 可选：JSON Schema 校验
├── charts/             # 依赖的子 Chart
├── crds/               # CustomResourceDefinition 文件
├── templates/          # 模板目录，渲染后生成 K8s 资源清单
│   ├── NOTES.txt       # 可选：安装后显示的提示信息
│   ├── _helpers.tpl    # 命名模板（partials）
│   ├── deployment.yaml
│   ├── service.yaml
│   └── ...
├── README.md           # 可选：说明文档
└── LICENSE             # 可选：许可证
```

### Chart.yaml 关键字段

```yaml
apiVersion: v2          # Helm 3 使用 v2
name: mychart           # Chart 名称
version: 0.1.0          # Chart 版本（SemVer 2）
appVersion: 1.16.0      # 应用版本（仅供参考）
type: application       # application 或 library
description: A Helm chart for Kubernetes
keywords:
  - nginx
  - web
maintainers:
  - name: maintainer-name
    email: maintainer@example.com
dependencies:
  - name: mysql
    version: 9.4.0
    repository: http://mirror.azure.cn/kubernetes/charts/
```

### 依赖管理

```yaml
# Chart.yaml 中定义依赖
dependencies:
  - name: mysql
    version: 9.4.0
    repository: http://mirror.azure.cn/kubernetes/charts/
  - name: redis
    version: 18.0.0
    repository: http://mirror.azure.cn/kubernetes/charts/
    condition: redis.enabled          # 条件启用
    alias: cache                       # 别名引用
```

```bash
# 下载依赖到 charts/ 目录
helm dependency update
helm dependency build

# 列出依赖
helm dependency list
```

### Values 作用域

```
父 Chart 的 values.yaml:
  mysql:
    auth:
      rootPassword: "parent-pass"

子 Chart（mysql）模板中访问:
  {{ .Values.auth.rootPassword }}  → "parent-pass"
```

子 Chart 通过 `.Values.global.xxx` 可以访问全局值，父 Chart 的 `global` 字段会向下传递到所有子 Chart：

```yaml
# 父 Chart values.yaml
global:
  imageRegistry: my-registry.com
  storageClass: ssd

# 所有子 Chart 均可访问
{{ .Values.global.imageRegistry }}
```

---

## 模板开发

### 模板语法基础

Helm 模板基于 **Go template** 语言，并扩展了 [Sprig](https://masterminds.github.io/sprig/) 函数库的 60+ 函数和 Helm 专用函数。

```
{{ .Values.key }}           # 访问 values
{{ .Release.Name }}         # 内置对象
{{ .Values.drink | quote }} # 管道：将值传给函数
```

### 内置对象

| 对象 | 说明 |
|---|---|
| `{{ .Release.Name }}` | Release 名称 |
| `{{ .Release.Namespace }}` | 安装的命名空间 |
| `{{ .Release.IsInstall }}` | 是否安装操作 |
| `{{ .Release.IsUpgrade }}` | 是否升级操作 |
| `{{ .Release.Revision }}` | 当前 revision 号 |
| `{{ .Values }}` | values.yaml 及用户提供的值 |
| `{{ .Chart.Name }}` | Chart 名称 |
| `{{ .Chart.Version }}` | Chart 版本 |
| `{{ .Chart.AppVersion }}` | 应用版本 |
| `{{ .Files.Get "config.ini" }}` | 获取文件内容 |
| `{{ .Capabilities.KubeVersion }}` | Kubernetes 版本信息 |
| `{{ .Template.Name }}` | 当前模板文件路径 |

### 常用函数

```yaml
# 字符串
{{ .Values.name | quote }}            # "myapp"
{{ .Values.name | upper }}            # "MYAPP"
{{ .Values.name | nindent 4 }}        # 缩进 4 空格 + 换行

# 默认值
{{ .Values.port | default 8080 }}

# 条件默认值（计算型）
{{ .Values.name | default (printf "%s-release" (include "fullname" .)) }}

# 类型转换
{{ .Values.count | toString }}
{{ .Values.enabled | toYaml }}

# 集合操作
{{ list 1 2 3 | join "," }}
{{ .Values.tags | has "web" }}

# 编码
{{ .Values.password | b64enc }}
{{ .Values.data | sha256sum }}

# 查表
{{ include "mychart.labels" . }}
{{ tpl .Values.extraConfig . }}
```

### 流程控制

**if/else 条件判断：**

```yaml
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
{{- else if .Values.route.enabled }}
# 使用 Route
{{- else }}
# 什么都不做
{{- end }}
```

**with 作用域限定：**

```yaml
{{- with .Values.service }}
ports:
  - port: {{ .port }}
    targetPort: {{ .targetPort }}
{{- end }}
```

**range 循环：**

```yaml
env:
{{- range .Values.env }}
  - name: {{ .name }}
    value: {{ .value | quote }}
{{- end }}

# 遍历 map
{{- range $key, $val := .Values.labels }}
  {{ $key }}: {{ $val }}
{{- end }}
```

### 空格控制

使用 `{{-` 删除左侧空格，`-}}` 删除右侧空格：

```yaml
# 去掉多余空行
{{- if .Values.enabled }}
  key: value
{{- end }}
```

### 命名模板（Named Templates）

命名模板是全局可复用的模板片段，通常放在 `templates/_helpers.tpl` 中：

```yaml
{{/* 生成标准标签 */}}
{{- define "mychart.labels" -}}
app.kubernetes.io/name: {{ include "mychart.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ include "mychart.chart" . }}
{{- end -}}

{{/* Chart 名称 */}}
{{- define "mychart.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* 完整名称 */}}
{{- define "mychart.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
```

**使用命名模板：**

```yaml
# ❌ 不推荐：template 无法与管道配合
labels:
  {{ template "mychart.labels" . }}

# ✅ 推荐：include 返回内容，可继续管道处理
labels:
  {{- include "mychart.labels" . | nindent 4 }}
```

---

## Chart Hooks

Hooks 允许在 Release 生命周期的关键节点执行操作，如数据库迁移、备份等。

### 可用 Hooks

| Hook | 触发时机 |
|---|---|
| `pre-install` | 模板渲染后、资源创建前 |
| `post-install` | 所有资源创建后 |
| `pre-delete` | 资源删除前 |
| `post-delete` | 所有资源删除后 |
| `pre-upgrade` | 模板渲染后、资源升级前 |
| `post-upgrade` | 所有资源升级后 |
| `pre-rollback` | 模板渲染后、回滚执行前 |
| `post-rollback` | 所有资源回滚后 |
| `test` | `helm test` 命令执行时 |

### 编写 Hook

Hook 是带有特殊注解的普通 Kubernetes 资源：

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: "{{ .Release.Name }}-db-migrate"
  annotations:
    "helm.sh/hook": pre-upgrade
    "helm.sh/hook-weight": "5"          # 权重，越小越先执行
    "helm.sh/hook-delete-policy": hook-succeeded
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: db-migrate
        image: myapp-migrate:latest
```

### Hook 删除策略

| 策略 | 说明 |
|---|---|
| `before-hook-creation` | 新 Hook 执行前删除旧资源（默认） |
| `hook-succeeded` | Hook 成功后删除 |
| `hook-failed` | Hook 失败后删除 |

---

## 常用命令速查

| 命令 | 说明 |
|---|---|
| `helm repo add <name> <url>` | 添加 Chart 仓库 |
| `helm repo update` | 更新本地仓库索引 |
| `helm search repo <keyword>` | 搜索 Chart |
| `helm search hub <keyword>` | 在 Artifact Hub 搜索 |
| `helm install <name> <chart>` | 安装 Chart |
| `helm list` / `helm ls` | 列出 Release |
| `helm status <name>` | 查看 Release 状态 |
| `helm upgrade <name> <chart>` | 升级 Release |
| `helm rollback <name> <rev>` | 回滚到指定版本 |
| `helm history <name>` | 查看 Release 历史 |
| `helm uninstall <name>` | 卸载 Release |
| `helm get values <name>` | 查看已设置的 Values |
| `helm get manifest <name>` | 查看渲染后的资源清单 |
| `helm show values <chart>` | 查看 Chart 可配置参数 |
| `helm show chart <chart>` | 查看 Chart 元数据 |
| `helm show all <chart>` | 查看 Chart 全部信息 |
| `helm create <name>` | 创建新 Chart 脚手架 |
| `helm package <chart>` | 打包 Chart 为 .tgz |
| `helm lint <chart>` | 检查 Chart 格式 |
| `helm template <name> <chart>` | 本地渲染模板（不安装） |
| `helm dependency update` | 下载依赖 |
| `helm test <name>` | 运行 Release 测试 |
| `helm plugin list` | 列出已安装插件 |
| `helm env` | 查看 Helm 环境变量 |

---

## 最佳实践

### 1. 使用 `helm template` 验证

在部署前渲染模板，确认输出符合预期：

```bash
helm template my-release ./mychart -f values-prod.yaml --debug
```

### 2. 版本锁定

```bash
# 安装时指定 Chart 版本
helm install my-release stable/nginx-ingress --version 18.1.0

# 生产环境使用具体的镜像 tag
helm install my-release stable/nginx-ingress --set image.tag=1.25.3-debian-12-r0
```

### 3. 环境分离

为不同环境维护独立的 values 文件：

```
values/
├── values.yaml          # 公共默认值
├── values-dev.yaml      # 开发环境
├── values-staging.yaml  # 预发布环境
└── values-prod.yaml     # 生产环境

helm install my-release ./mychart \
  -f values/values.yaml \
  -f values/values-prod.yaml
```

### 4. Chart 命名约定

- Chart 名称使用小写字母和连字符：`my-web-app`
- 命名模板添加 Chart 前缀：`{{ define "mywebapp.labels" }}`
- `_helpers.tpl` 文件存放所有命名模板

### 5. 安全性

```bash
# 敏感信息使用 Secret 而非 values.yaml 明文
helm install my-release ./mychart --set secret.password="$(cat /path/to/password)"

# 安装前做安全扫描
helm lint ./mychart

# 使用 --atomic 确保原子性
helm upgrade my-release ./mychart --atomic --timeout 5m
```

### 6. CI/CD 集成

```yaml
# GitHub Actions 示例
- name: Deploy with Helm
  run: |
    helm upgrade --install my-app ./chart \
      --namespace production \
      --create-namespace \
      --values chart/values-prod.yaml \
      --set image.tag=${{ github.sha }} \
      --atomic \
      --timeout 10m \
      --wait
```

### 7. 资源标签

每个资源都应包含推荐的 Kubernetes 标签：

```yaml
labels:
  app.kubernetes.io/name: {{ include "mychart.name" . }}
  app.kubernetes.io/instance: {{ .Release.Name }}
  app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
  app.kubernetes.io/component: frontend
  app.kubernetes.io/part-of: my-system
  app.kubernetes.io/managed-by: {{ .Release.Service }}
```

---

## 调试技巧

```bash
# 1. 渲染模板查看输出
helm template my-release ./mychart --debug

# 2. 查看渲染后的 Kubernetes 资源
helm get manifest my-release

# 3. 检查 values 传递是否正确
helm get values my-release --all

# 4. 通过 --dry-run 模拟安装
helm install my-release ./mychart --dry-run --debug

# 5. 添加调试输出到模板
{{/* 调试: 打印 values */}}
{{ .Values | toYaml }}
```

---

**总结**：Helm 是 Kubernetes 生态中不可或缺的包管理工具，它解决了复杂应用部署、配置管理和版本控制的问题。掌握 Helm 的核心概念——Chart（包）、Repository（仓库）、Release（实例）——加上模板开发能力，就能高效管理 Kubernetes 应用的完整生命周期。