# 蓝鲸标准运维 API 使用指南

## 1. 概述

蓝鲸标准运维（bk-sops）是蓝鲸体系中的流程编排调度引擎，提供可视化任务流程编排与执行能力。通过 ESB 组件 API，第三方系统可以编程方式调用标准运维接口，实现：

- 通过流程模板创建并执行任务
- 操作任务（暂停/继续/终止）
- 查询任务执行状态与详情
- 管理周期任务
- 快速新建一次性任务

### 架构层次

```
┌─────────────────────────────────────────────┐
│              接入层（权限控制/API/统计）         │
├─────────────────────────────────────────────┤
│          任务管理层（编排/创建/控制）             │
├─────────────────────────────────────────────┤
│          流程引擎层（解析/调度/上下文）           │
├─────────────────────────────────────────────┤
│          API 网关层（ESB/组件分发）             │
└─────────────────────────────────────────────┘
```

## 2. 调用方式

### 2.1 ESB 组件 API 调用（现网验证可用）

现网标准运维接口通过 ESB 组件 API 调用，认证信息放在请求参数中（与 cmsi 等组件接口一致）：

- **API 基础路径**：`https://bkapi.bk.ucsoc.com/api/c/compapi/v2/sops/`
- **组件注册名**：`sops`（不是 `bk_sops`）
- **认证方式**：认证参数直接放在请求 body（POST）或 query string（GET）中

```bash
# GET 接口示例：查询模板列表（认证参数和业务参数放 URL query string）
curl -s -X GET 'https://bkapi.bk.ucsoc.com/api/c/compapi/v2/sops/get_template_list/?bk_app_code=bk_sops&bk_app_secret=YOUR_SECRET&bk_username=kevin.hui&bk_biz_id=11'

# POST 接口示例：创建并启动任务（认证参数和业务参数放 JSON body）
curl -s -X POST 'https://bkapi.bk.ucsoc.com/api/c/compapi/v2/sops/create_and_start_task/' \
  -H 'Content-Type: application/json' \
  -d '{"bk_app_code":"bk_sops","bk_app_secret":"YOUR_SECRET","bk_username":"kevin.hui","bk_biz_id":"11","template_id":"32","name":"test_task"}'
```

### 2.2 认证参数说明

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `bk_app_code` | string | 是 | 应用 ID，通过蓝鲸开发者中心 → 应用基本设置 → 鉴权信息获取 |
| `bk_app_secret` | string | 是 | 安全密钥，获取方式同上 |
| `bk_token` | string | 否* | 用户登录态，Cookie 中 bk_token 字段值；与 bk_username 至少一个有效 |
| `bk_username` | string | 否* | 用户名，仅免登录态验证白名单应用可用 |

> **注意**：`bk_token` 与 `bk_username` 必须提供一个有效值。`bk_username` 仅限已申请免用户认证白名单的应用使用，存在安全风险，谨慎使用。

### 2.3 GET 与 POST 的参数传递规则

| HTTP 方法 | 参数传递方式 | 说明 |
|-----------|-------------|------|
| GET | URL query string | 认证参数和业务参数都放 URL，**不能用 `-d` 传 body** |
| POST | JSON body | 认证参数和业务参数都放 `-d` 的 JSON body 中 |

> **重要**：GET 请求如果用 `-d` 传 body，参数不会被解析，会报 `Parameters error, param bk_biz_id is required` 错误。

### 2.4 与 cmsi 等其他组件接口的区别

| 项目 | cmsi（消息通知） | sops（标准运维） |
|------|-----------------|-----------------|
| 组件注册名 | `cmsi` | `sops` |
| API 路径 | `/api/c/compapi/cmsi/` | `/api/c/compapi/v2/sops/` |
| 版本前缀 | 无（v1） | `v2` |
| 认证方式 | body / query string | body / query string（相同） |
| HTTP 方法 | POST | GET 或 POST（因接口而异） |

### 2.5 Python 调用示例

```python
import json
import requests

BK_API_HOST = "https://bkapi.bk.ucsoc.com"
BK_SOPS_API = f"{BK_API_HOST}/api/c/compapi/v2/sops"
APP_CODE = "bk_sops"
APP_SECRET = "your_app_secret"
BK_USERNAME = "kevin.hui"
BK_BIZ_ID = 11

# ============ 工具函数 ============

def api_get(path, params):
    """GET 请求：认证参数和业务参数合并放 query string"""
    full_params = {
        "bk_app_code": APP_CODE,
        "bk_app_secret": APP_SECRET,
        "bk_username": BK_USERNAME,
    }
    full_params.update(params)
    return requests.get(f"{BK_SOPS_API}{path}", params=full_params).json()

def api_post(path, data):
    """POST 请求：认证参数和业务参数合并放 JSON body"""
    full_data = {
        "bk_app_code": APP_CODE,
        "bk_app_secret": APP_SECRET,
        "bk_username": BK_USERNAME,
    }
    full_data.update(data)
    return requests.post(
        f"{BK_SOPS_API}{path}",
        headers={"Content-Type": "application/json"},
        data=json.dumps(full_data)
    ).json()
```

## 3. API 接口总览

### 3.1 任务流程接口

| 接口 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 查询模板列表 | GET | `/get_template_list/` | 查询业务下的流程模板列表 |
| 查询模板详情 | GET | `/get_template_info/` | 查询单个流程模板详情 |
| 创建任务 | POST | `/create_task/` | 通过流程模板新建任务 |
| 开始执行任务 | POST | `/start_task/` | 开始执行已创建的任务 |
| 创建并启动任务 | POST | `/create_and_start_task/` | 一步完成创建+启动（**推荐**） |
| 操作任务 | POST | `/operate_task/` | 操作任务（开始/暂停/继续/终止） |
| 查询任务状态 | GET | `/get_task_status/` | 查询任务或节点执行状态 |
| 查询任务详情 | GET | `/get_task_detail/` | 查询任务执行详情 |
| 查询节点详情 | GET | `/get_task_node_detail/` | 查询任务节点执行详情 |
| 回调任务节点 | POST | `/node_callback/` | 回调任务节点 |
| 快速新建任务 | POST | `/fast_create_task/` | 快速新建一次性任务（无需模板） |

### 3.2 周期任务接口

| 接口 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 查询周期任务列表 | GET | `/get_periodic_task_list/` | 查询业务下的周期任务列表 |
| 查询周期任务详情 | GET | `/get_periodic_task_info/` | 查询某个周期任务详情 |
| 创建周期任务 | POST | `/create_periodic_task/` | 通过流程模板新建周期任务 |
| 设置周期任务激活 | POST | `/set_periodic_task_enabled/` | 设置周期任务是否激活 |
| 修改调度策略 | POST | `/modify_cron_for_periodic_task/` | 修改周期任务的调度策略 |
| 修改全局参数 | POST | `/modify_constants_for_periodic_task/` | 修改周期任务的全局参数 |

### 3.3 公共流程接口

| 接口 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 查询公共模板列表 | GET | `/get_common_template_list/` | 查询公共流程模板列表 |
| 查询公共模板详情 | GET | `/get_common_template_info/` | 查询单个公共流程模板详情 |
| 导入公共流程 | POST | `/import_common_template/` | 导入公共流程 |

### 3.4 其他接口

| 接口 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 查询任务分类统计 | GET | `/query_task_count/` | 查询任务分类统计总数 |
| 查询插件列表 | GET | `/get_plugin_list/` | 查询项目下的标准插件列表 |

## 4. 核心接口详解

### 4.1 查询模板列表 — `get_template_list`

获取业务下可用的流程模板列表，是创建任务的前置步骤。

**请求参数：**

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `bk_biz_id` | string | 是 | 业务 ID |
| `template_source` | string | 否 | `business`（默认，业务流程）/ `common`（公共流程） |
| `scope` | string | 否 | `cmdb_biz`（默认，CMDB 业务 ID）/ `project`（项目 ID） |

**curl 调用：**

```bash
curl -s -X GET 'https://bkapi.bk.ucsoc.com/api/c/compapi/v2/sops/get_template_list/?bk_app_code=bk_sops&bk_app_secret=YOUR_SECRET&bk_username=kevin.hui&bk_biz_id=11'
```

**Python 调用：**

```python
templates = api_get("/get_template_list/", {"bk_biz_id": str(BK_BIZ_ID)})
```

**返回示例：**

```json
{
  "result": true,
  "data": [
    {
      "id": 32,
      "name": "快速执行脚本",
      "category": "Other",
      "bk_biz_id": "2",
      "bk_biz_name": "蓝鲸",
      "creator": "admin",
      "create_time": "2018-04-23 17:26:40",
      "editor": "admin",
      "edit_time": "2018-04-23 17:30:48"
    }
  ]
}
```

### 4.2 创建并启动任务 — `create_and_start_task`（推荐）

一步完成创建+启动，比 `create_task` + `start_task` 两步调用更方便，**推荐使用**。

**请求参数：**

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `bk_biz_id` | string | 是 | 业务 ID |
| `template_id` | string | 是 | 流程模板 ID |
| `name` | string | 是 | 任务名称 |
| `template_source` | string | 否 | `business`（默认）/ `common` |
| `flow_type` | string | 否 | `common`（常规流程，默认）/ `common_func`（职能化流程） |
| `constants` | dict | 否 | 任务全局参数，KEY 为 `${变量名}` 格式 |
| `scope` | string | 否 | 同上 |

**`constants` 说明：**

- KEY 格式：`${变量名}`，需与模板中定义的全局变量 KEY 一致
- VALUE 类型：需与模板中对应变量的类型一致

**curl 调用：**

```bash
curl -s -X POST 'https://bkapi.bk.ucsoc.com/api/c/compapi/v2/sops/create_and_start_task/' \
  -H 'Content-Type: application/json' \
  -d '{"bk_app_code":"bk_sops","bk_app_secret":"YOUR_SECRET","bk_username":"kevin.hui","bk_biz_id":"11","template_id":"32","name":"auto_task","constants":{"${content}":"echo hello","${script_timeout}":20}}'
```

**Python 调用：**

```python
result = api_post("/create_and_start_task/", {
    "bk_biz_id": str(BK_BIZ_ID),
    "template_id": str(template_id),
    "name": f"auto_task_{int(time.time())}",
    "constants": {
        "${content}": "echo hello world",
        "${script_timeout}": 20
    }
})
task_id = result["data"]["task_id"]
task_url = result["data"]["task_url"]
```

**返回关键字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `data.task_id` | int | 任务实例 ID，后续操作均依赖此 ID |
| `data.task_url` | string | 任务实例链接（可在浏览器中查看） |
| `data.pipeline_tree` | dict | 任务实例树（含节点、连线、网关等拓扑信息） |

### 4.3 通过流程模板新建任务 — `create_task`

仅创建任务实例，不自动启动。需后续调用 `start_task` 才会执行。

**请求参数：** 同 `create_and_start_task`

**curl 调用：**

```bash
curl -s -X POST 'https://bkapi.bk.ucsoc.com/api/c/compapi/v2/sops/create_task/' \
  -H 'Content-Type: application/json' \
  -d '{"bk_app_code":"bk_sops","bk_app_secret":"YOUR_SECRET","bk_username":"kevin.hui","bk_biz_id":"11","template_id":"32","name":"test_task"}'
```

### 4.4 开始执行任务 — `start_task`

创建任务后，需显式调用此接口启动执行。

**请求参数：**

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `bk_biz_id` | string | 是 | 业务 ID |
| `task_id` | string | 是 | 任务 ID（create_task 返回的 task_id） |
| `scope` | string | 否 | 同上 |

**curl 调用：**

```bash
curl -s -X POST 'https://bkapi.bk.ucsoc.com/api/c/compapi/v2/sops/start_task/' \
  -H 'Content-Type: application/json' \
  -d '{"bk_app_code":"bk_sops","bk_app_secret":"YOUR_SECRET","bk_username":"kevin.hui","bk_biz_id":"11","task_id":"10"}'
```

### 4.5 操作任务 — `operate_task`

对任务执行生命周期操作，`action=start` 等效于调用 `start_task`。

**请求参数：**

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `bk_biz_id` | string | 是 | 业务 ID |
| `task_id` | string | 是 | 任务 ID |
| `action` | string | 是 | 操作类型（见下表） |
| `scope` | string | 否 | 同上 |

**action 取值：**

| 值 | 说明 | 适用状态 |
|----|------|----------|
| `start` | 开始任务，等效于 `start_task` | CREATED |
| `pause` | 暂停任务 | RUNNING |
| `resume` | 继续任务 | SUSPENDED |
| `revoke` | 终止任务 | RUNNING / SUSPENDED |

**curl 调用：**

```bash
# 终止任务
curl -s -X POST 'https://bkapi.bk.ucsoc.com/api/c/compapi/v2/sops/operate_task/' \
  -H 'Content-Type: application/json' \
  -d '{"bk_app_code":"bk_sops","bk_app_secret":"YOUR_SECRET","bk_username":"kevin.hui","bk_biz_id":"11","task_id":"10","action":"revoke"}'
```

**Python 调用：**

```python
# 终止任务
operate_result = api_post("/operate_task/", {"bk_biz_id": "11", "task_id": "10", "action": "revoke"})
```

### 4.6 查询任务执行状态 — `get_task_status`

查询任务或任务节点的执行状态，返回状态树。

**请求参数：**

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `bk_biz_id` | string | 是 | 业务 ID |
| `task_id` | string | 是 | 任务 ID 或节点 ID |
| `scope` | string | 否 | 同上 |

**任务状态枚举：**

| 状态 | 说明 |
|------|------|
| `CREATED` | 未执行 |
| `RUNNING` | 执行中 |
| `FAILED` | 失败 |
| `SUSPENDED` | 暂停 |
| `REVOKED` | 已终止 |
| `FINISHED` | 已完成 |

**curl 调用：**

```bash
curl -s -X GET 'https://bkapi.bk.ucsoc.com/api/c/compapi/v2/sops/get_task_status/?bk_app_code=bk_sops&bk_app_secret=YOUR_SECRET&bk_username=kevin.hui&bk_biz_id=11&task_id=10'
```

**Python 调用：**

```python
status = api_get("/get_task_status/", {"bk_biz_id": str(BK_BIZ_ID), "task_id": str(task_id)})
state = status["data"]["state"]
```

**返回示例（关键字段）：**

```json
{
  "result": true,
  "data": {
    "state": "FAILED",
    "id": "5a1622f9f43e3429acb604e18dbd100a",
    "skip": false,
    "retry": 0,
    "start_time": "2018-04-26 16:08:34 +0800",
    "finish_time": "",
    "children": {
      "e8b128dff46637368b9b1bd921abc14e": {
        "state": "FAILED",
        "name": "ServiceActivity",
        "retry": 0,
        "skip": false
      }
    }
  }
}
```

### 4.7 查询任务执行详情 — `get_task_detail`

获取任务的完整执行详情，包括全局变量、输出参数、pipeline_tree 等。

**请求参数：**

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `bk_biz_id` | string | 是 | 业务 ID |
| `task_id` | string | 是 | 任务 ID |
| `scope` | string | 否 | 同上 |

**curl 调用：**

```bash
curl -s -X GET 'https://bkapi.bk.ucsoc.com/api/c/compapi/v2/sops/get_task_detail/?bk_app_code=bk_sops&bk_app_secret=YOUR_SECRET&bk_username=kevin.hui&bk_biz_id=11&task_id=10'
```

**返回关键字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `data.id` | int | 任务 ID |
| `data.name` | string | 任务名称 |
| `data.business_id` | int | 业务 ID |
| `data.template_id` | int | 流程模板 ID |
| `data.create_time` | string | 创建时间 |
| `data.start_time` | string | 执行时间 |
| `data.finish_time` | string | 完成时间 |
| `data.elapsed_time` | int | 执行耗时（秒） |
| `data.creator` | string | 创建人 |
| `data.executor` | string | 执行人 |
| `data.constants` | dict | 输入的全局变量 |
| `data.outputs` | list | 任务输出参数 |
| `data.task_url` | string | 任务实例链接 |
| `data.pipeline_tree` | dict | 任务实例树 |

### 4.8 快速新建一次性任务 — `fast_create_task`

无需预先创建流程模板，直接通过 pipeline_tree 构建一次性任务。适用于动态编排场景。

**请求参数：**

| 字段 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `project_id` | int | 是 | 项目 ID |
| `name` | string | 是 | 任务名称 |
| `pipeline_tree` | dict | 是 | 任务实例树（需完整定义节点、连线、网关） |
| `flow_type` | string | 否 | `common`（默认）/ `common_func` |
| `description` | string | 否 | 任务描述 |
| `category` | string | 否 | 任务分类 |

**pipeline_tree 结构：**

```json
{
  "start_event": {"id": "node_start", "type": "EmptyStartEvent", "incoming": "", "outgoing": "line1", "name": ""},
  "end_event": {"id": "node_end", "type": "EmptyEndEvent", "incoming": "line2", "outgoing": "", "name": ""},
  "activities": {
    "node1": {
      "id": "node1", "type": "ServiceActivity", "name": "执行脚本",
      "component": {"code": "sleep_timer", "data": {"bk_timing": {"hook": false, "value": "2"}}},
      "error_ignorable": false, "retryable": true, "skippable": true,
      "incoming": "line1", "outgoing": "line2", "stage_name": "步骤1"
    }
  },
  "flows": {
    "line1": {"id": "line1", "is_default": false, "source": "node_start", "target": "node1"},
    "line2": {"id": "line2", "is_default": false, "source": "node1", "target": "node_end"}
  },
  "gateways": {},
  "constants": {},
  "outputs": []
}
```

## 5. 典型使用流程

### 5.1 推荐流程：create_and_start_task 一步到位

```
查询模板列表 → 选择模板 → 创建并启动任务 → 轮询状态 → 获取结果
```

```python
import time
import json
import requests

# ============ 配置 ============
BK_API_HOST = "https://bkapi.bk.ucsoc.com"
BK_SOPS_API = f"{BK_API_HOST}/api/c/compapi/v2/sops"
APP_CODE = "bk_sops"
APP_SECRET = "your_app_secret"
BK_USERNAME = "kevin.hui"
BK_BIZ_ID = 11

# ============ 工具函数 ============
def api_get(path, params):
    """GET 请求：认证参数和业务参数合并放 query string"""
    full_params = {
        "bk_app_code": APP_CODE,
        "bk_app_secret": APP_SECRET,
        "bk_username": BK_USERNAME,
    }
    full_params.update(params)
    return requests.get(f"{BK_SOPS_API}{path}", params=full_params).json()

def api_post(path, data):
    """POST 请求：认证参数和业务参数合并放 JSON body"""
    full_data = {
        "bk_app_code": APP_CODE,
        "bk_app_secret": APP_SECRET,
        "bk_username": BK_USERNAME,
    }
    full_data.update(data)
    return requests.post(
        f"{BK_SOPS_API}{path}",
        headers={"Content-Type": "application/json"},
        data=json.dumps(full_data)
    ).json()

# ============ Step 1: 查询模板列表 ============
templates = api_get("/get_template_list/", {"bk_biz_id": str(BK_BIZ_ID)})
print(f"可用模板: {len(templates['data'])} 个")

# 选择目标模板
target_template = None
for t in templates["data"]:
    if "部署" in t["name"]:  # 按名称筛选
        target_template = t
        break

template_id = target_template["id"]
print(f"选中模板: {target_template['name']} (ID={template_id})")

# ============ Step 2: 创建并启动任务（一步完成） ============
result = api_post("/create_and_start_task/", {
    "bk_biz_id": str(BK_BIZ_ID),
    "template_id": str(template_id),
    "name": f"auto_task_{int(time.time())}",
    "constants": {
        "${target_ip}": "10.0.0.1",
        "${script_content}": "echo 'hello from api'"
    }
})

if not result["result"]:
    print(f"创建并启动失败: {result['message']}")
    exit(1)

task_id = result["data"]["task_id"]
task_url = result["data"]["task_url"]
print(f"任务已创建并启动: ID={task_id}, URL={task_url}")

# ============ Step 3: 轮询任务状态 ============
TERMINAL_STATES = {"FINISHED", "FAILED", "REVOKED"}

while True:
    status_result = api_get("/get_task_status/", {
        "bk_biz_id": str(BK_BIZ_ID),
        "task_id": str(task_id)
    })
    state = status_result["data"]["state"]
    print(f"当前状态: {state}")

    if state in TERMINAL_STATES:
        break

    time.sleep(5)  # 每 5 秒轮询一次

# ============ Step 4: 获取任务详情 ============
detail = api_get("/get_task_detail/", {
    "bk_biz_id": str(BK_BIZ_ID),
    "task_id": str(task_id)
})

print(f"任务名称: {detail['data']['name']}")
print(f"执行耗时: {detail['data']['elapsed_time']} 秒")
print(f"输出参数: {json.dumps(detail['data']['outputs'], indent=2, ensure_ascii=False)}")
```

### 5.2 两步流程：create_task + start_task

```python
# Step 1: 仅创建任务
create_result = api_post("/create_task/", {
    "bk_biz_id": str(BK_BIZ_ID),
    "template_id": str(template_id),
    "name": "two_step_task",
})
task_id = create_result["data"]["task_id"]

# Step 2: 显式启动任务
start_result = api_post("/start_task/", {
    "bk_biz_id": str(BK_BIZ_ID),
    "task_id": str(task_id),
})
```

### 5.3 使用 operate_task 统一操作

```python
# 开始任务（等效于 start_task）
api_post("/operate_task/", {"bk_biz_id": "11", "task_id": "10", "action": "start"})

# 暂停任务
api_post("/operate_task/", {"bk_biz_id": "11", "task_id": "10", "action": "pause"})

# 继续任务
api_post("/operate_task/", {"bk_biz_id": "11", "task_id": "10", "action": "resume"})

# 终止任务
api_post("/operate_task/", {"bk_biz_id": "11", "task_id": "10", "action": "revoke"})
```

### 5.4 使用公共流程模板

```python
# 查询公共流程模板
common_templates = api_get("/get_common_template_list/", {"bk_biz_id": str(BK_BIZ_ID)})

# 使用公共流程创建并启动任务（template_source 设为 common）
create_result = api_post("/create_and_start_task/", {
    "bk_biz_id": str(BK_BIZ_ID),
    "template_id": str(common_template_id),
    "template_source": "common",
    "name": "common_flow_task",
    "constants": {"${key1}": "value1"}
})
```

### 5.5 创建周期任务

```python
# 通过流程模板创建周期任务
periodic_result = api_post("/create_periodic_task/", {
    "bk_biz_id": str(BK_BIZ_ID),
    "template_id": str(template_id),
    "name": "daily_check",
    "cron": "0 8 * * *",  # 每天 8:00 执行
    "constants": {"${check_type}": "full"}
})

periodic_task_id = periodic_result["data"]["id"]

# 暂停周期任务
api_post("/set_periodic_task_enabled/", {
    "bk_biz_id": str(BK_BIZ_ID),
    "task_id": str(periodic_task_id),
    "enabled": False
})

# 修改调度策略
api_post("/modify_cron_for_periodic_task/", {
    "bk_biz_id": str(BK_BIZ_ID),
    "task_id": str(periodic_task_id),
    "cron": "0 6 * * 1-5"  # 工作日 6:00
})
```

## 6. curl 调用速查

以下为现网验证可用的 curl 命令，替换 `YOUR_SECRET` 和业务参数即可使用：

```bash
# 公共变量
API_HOST="https://bkapi.bk.ucsoc.com"
API_PREFIX="${API_HOST}/api/c/compapi/v2/sops"

# ========== GET 接口（参数放 URL query string） ==========

# 查询模板列表
curl -s -X GET "${API_PREFIX}/get_template_list/?bk_app_code=bk_sops&bk_app_secret=YOUR_SECRET&bk_username=kevin.hui&bk_biz_id=11"

# 查询任务状态
curl -s -X GET "${API_PREFIX}/get_task_status/?bk_app_code=bk_sops&bk_app_secret=YOUR_SECRET&bk_username=kevin.hui&bk_biz_id=11&task_id=10"

# 查询任务详情
curl -s -X GET "${API_PREFIX}/get_task_detail/?bk_app_code=bk_sops&bk_app_secret=YOUR_SECRET&bk_username=kevin.hui&bk_biz_id=11&task_id=10"

# ========== POST 接口（参数放 JSON body） ==========

# 创建并启动任务（推荐）
curl -s -X POST "${API_PREFIX}/create_and_start_task/" \
  -H 'Content-Type: application/json' \
  -d '{"bk_app_code":"bk_sops","bk_app_secret":"YOUR_SECRET","bk_username":"kevin.hui","bk_biz_id":"11","template_id":"32","name":"test_task","constants":{"${content}":"echo 1"}}'

# 创建任务（仅创建不启动）
curl -s -X POST "${API_PREFIX}/create_task/" \
  -H 'Content-Type: application/json' \
  -d '{"bk_app_code":"bk_sops","bk_app_secret":"YOUR_SECRET","bk_username":"kevin.hui","bk_biz_id":"11","template_id":"32","name":"test_task"}'

# 开始执行任务
curl -s -X POST "${API_PREFIX}/start_task/" \
  -H 'Content-Type: application/json' \
  -d '{"bk_app_code":"bk_sops","bk_app_secret":"YOUR_SECRET","bk_username":"kevin.hui","bk_biz_id":"11","task_id":"10"}'

# 操作任务（暂停/继续/终止）
curl -s -X POST "${API_PREFIX}/operate_task/" \
  -H 'Content-Type: application/json' \
  -d '{"bk_app_code":"bk_sops","bk_app_secret":"YOUR_SECRET","bk_username":"kevin.hui","bk_biz_id":"11","task_id":"10","action":"revoke"}'
```

## 7. 任务状态流转

```
                  start_task / operate_task(start)
                  / create_and_start_task
                  ──────────────────────────────►
                 ┌──────────┐                    ┌──────────┐
                 │  CREATED │                    │  RUNNING │
                 └──────────┘                    └──────────┘
                     │                               │  │  │
                     │                               │  │  │ operate_task(pause)
                     │                               │  │  ▼
                     │                               │  │ ┌──────────┐
                     │                               │  │ │SUSPENDED │
                     │                               │  │ └──────────┘
                     │                               │  │     │
                     │                               │  │     │ operate_task(resume)
                     │                               │  │     ▼
                     │                               │  └──► RUNNING
                     │                               │
                     │              operate_task      │  正常完成 / 节点失败
                     │              (revoke)         │  ──────────────────►
                     │               │               │
                     ▼               ▼               ▼
                 ┌──────────┐  ┌──────────┐  ┌──────────┐
                 │ REVOKED  │  │ REVOKED  │  │  FAILED  │
                 └──────────┘  └──────────┘  └──────────┘
                                                    │
                                                    │ 重试/跳过失败节点后
                                                    ▼
                                               ┌──────────┐
                                               │ FINISHED │
                                               └──────────┘
```

## 8. 常见问题与注意事项

### 8.1 全局变量 constants 传参

- KEY 必须使用 `${变量名}` 格式，与模板定义一致
- VALUE 类型必须与模板中变量类型一致（int 传 int，string 传 string）
- 可通过 `get_template_info` 接口查看模板中定义的全局变量及其类型

### 8.2 scope 参数

- 默认 `cmdb_biz`：`bk_biz_id` 对应 CMDB 业务 ID
- 设为 `project`：`bk_biz_id` 对应项目 ID
- 新版标准运维推荐使用 `project` 作用域

### 8.3 任务创建与执行是两步操作

- `create_task` 仅创建任务实例，状态为 `CREATED`
- 必须显式调用 `start_task` 或 `operate_task(action=start)` 才会开始执行
- **推荐使用 `create_and_start_task` 一步完成创建+启动**
- 如果需要在创建后修改参数再启动，才需要用两步流程

### 8.4 GET 请求不能用 -d 传参数

- GET 请求的参数必须放 URL query string
- 使用 curl `-d` 传 body 时，GET 请求不会解析 body 中的参数
- 会报 `Parameters error, param bk_biz_id is required` 错误

### 8.5 轮询状态建议

- 建议轮询间隔 3~10 秒，避免过于频繁
- 终态：`FINISHED`、`FAILED`、`REVOKED`，到达终态后停止轮询
- `FAILED` 状态的任务可通过重试/跳过失败节点恢复执行

### 8.6 错误处理

所有接口返回统一格式：

```json
{
  "result": true,
  "data": {},
  "message": ""
}
```

- `result=false` 时，`message` 包含错误信息
- 常见错误：认证失败、业务 ID 不存在、模板 ID 不存在、任务状态不允许操作

### 8.7 获取认证信息

| 信息 | 获取路径 |
|------|----------|
| `bk_app_code` / `bk_app_secret` | 蓺鲸开发者中心 → 应用基本设置 → 鉴权信息 |
| `bk_token` | 登录蓝鲸后，浏览器 Cookie 中 `bk_token` 字段 |
| `bk_username` | 免登录态验证白名单应用可直接使用用户名 |

### 8.8 ESB 组件注册名

- 标准运维的 ESB 组件注册名是 **`sops`**，不是 `bk_sops`
- API 路径为 `/api/c/compapi/v2/sops/`（带 `v2` 版本前缀）
- 与 cmsi 等无版本前缀的组件不同：`/api/c/compapi/cmsi/`（无 v2）

## 9. 参考文档

- [bk-sops 官方仓库](https://github.com/TencentBlueKing/bk-sops)
- [bk-sops API 使用手册](https://www.bookstack.cn/read/bk-sops-3.4.13/docs-apidoc-readme.md)
- [现网 API 网关文档](https://apigw.bk.ucsoc.com/docs/apigw-api/bk-sops/operate_task/doc?stage=prod)