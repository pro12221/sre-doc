# Go Web 开发入门教程：从零到部署

> 本教程面向**只会 Go 基础语法的初学者**，从零开始教你用 Go 标准库构建 Web 应用。每个知识点都先解释"为什么需要它"，再给出可运行代码，最后讲解每行代码的含义。你不需要任何 Web 开发经验。

---

## 目录

1. [准备工作：你需要知道什么](#1-准备工作你需要知道什么)
2. [你的第一个 HTTP 服务器](#2-你的第一个-http-服务器)
3. [理解 HTTP 请求与响应](#3-理解-http-请求与响应)
4. [处理多个路由](#4-处理多个路由)
5. [返回 JSON 数据（构建 API）](#5-返回-json-数据构建-api)
6. [HTML 模板入门：告别字符串拼接](#6-html-模板入门告别字符串拼接)
7. [模板进阶：Layout 布局与组件复用](#7-模板进阶layout-布局与组件复用)
8. [处理表单：让用户提交数据](#8-处理表单让用户提交数据)
9. [实战项目：Task Manager 任务管理器](#9-实战项目task-manager-任务管理器)
10. [进阶网络编程：TCP/UDP](#10-进阶网络编程tcpudp)
11. [RPC 远程调用：服务之间如何通信](#11-rpc-远程调用服务之间如何通信)
12. [WebSocket 实时通信](#12-websocket-实时通信)
13. [安全：XSS 防护与最佳实践](#13-安全xss-防护与最佳实践)
14. [生产环境 Checklist](#14-生产环境-checklist)

---

## 1. 准备工作：你需要知道什么

### 1.1 前置知识

| 你会的 | 你不需要会的 |
|--------|-------------|
| Go 基础语法（变量、函数、struct、slice、map） | HTTP 协议细节 |
| 会用 `go run` / `go build` | HTML/CSS/JavaScript |
| 理解 `if err != nil` 错误处理 | 任何 Web 框架 |
| 知道 `package main` 和 `import` | 数据库操作 |

### 1.2 两个核心概念：你只需要记住这两个东西

在 Go 的 Web 开发中，你写代码时永远在和两个东西打交道：

```
1. http.ResponseWriter  →  用来"写响应"（告诉浏览器显示什么）
2. *http.Request        →  用来"读请求"（浏览器发来了什么）
```

**每一个**处理函数都是这个签名：

```go
func 处理函数名(w http.ResponseWriter, r *http.Request) {
    // w: 你想返回给浏览器的内容，通过 w 写出去
    // r: 浏览器发来的请求信息（URL、参数、表单数据等）
}
```

> 后面所有章节，你都会反复看到这两个参数。记住它们，后面的内容就很容易理解了。

### 1.3 项目目录

```bash
mkdir ~/go-web-tutorial && cd ~/go-web-tutorial
go mod init go-web-tutorial
```

---

## 2. 你的第一个 HTTP 服务器

### 2.1 目标

启动一个程序，在浏览器访问 `http://localhost:8080` 时显示 "Hello, 世界！"。

### 2.2 代码

创建 `main.go`：

```go
package main

import (
    "fmt"
    "net/http"
)

func main() {
    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprint(w, "Hello, 世界！")
    })
    http.ListenAndServe(":8080", nil)
}
```

运行：

```bash
go run main.go
```

打开浏览器访问 `http://localhost:8080`，你会看到 "Hello, 世界！"。

### 2.3 逐行解释

```go
http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
    //      ↑路径  ↑处理函数
    // 含义：当有人访问路径 "/" 时，执行这个函数
```

- **`"/"`**：路径。`"/"` 表示根路径，也就是 `http://localhost:8080/`。如果写成 `"/hello"`，那就是 `http://localhost:8080/hello`。
- **`func(w http.ResponseWriter, r *http.Request)`**：处理函数。`w` 负责写响应，`r` 包含请求信息。
- **`fmt.Fprint(w, "Hello, 世界！")`**：把字符串写入 `w`，浏览器就会显示这个字符串。`Fprint` 和 `fmt.Print` 用法一样，只是输出目标从终端变成了浏览器。

```go
http.ListenAndServe(":8080", nil)
//                   ↑端口  ↑暂且不管
```

- **`":8080"`**：让服务器监听 8080 端口。冒号前面是 IP 地址，留空表示监听本机所有网络接口。
- **`nil`**：暂时传 `nil`，表示使用默认的路由器。后面会讲到如何自定义。

### 2.4 关键理解

`ListenAndServe` 会**阻塞**程序——它不会返回，除非服务器出错或你手动停止（Ctrl+C）。所以这行代码通常放在 `main()` 的最后。

---

## 3. 理解 HTTP 请求与响应

### 3.1 目标

学会读取浏览器发来的请求信息（URL 路径、查询参数），并返回不同的内容。

### 3.2 代码

```go
package main

import (
    "fmt"
    "net/http"
)

func handler(w http.ResponseWriter, r *http.Request) {
    // r.URL.Path 是请求的路径部分
    path := r.URL.Path
    fmt.Fprintf(w, "你访问的路径是: %s\n", path)

    // r.URL.Query() 获取查询参数，例如 ?name=张三
    name := r.URL.Query().Get("name")
    if name != "" {
        fmt.Fprintf(w, "你好, %s!\n", name)
    } else {
        fmt.Fprint(w, "请在 URL 后面加上 ?name=你的名字 试试\n")
    }
}

func main() {
    http.HandleFunc("/", handler)
    fmt.Println("服务器启动: http://localhost:8080")
    http.ListenAndServe(":8080", nil)
}
```

### 3.3 测试

| 访问地址 | 你会看到 |
|----------|---------|
| `http://localhost:8080` | 你访问的路径是: /  + 提示 |
| `http://localhost:8080/hello` | 你访问的路径是: /hello |
| `http://localhost:8080/?name=张三` | 你访问的路径是: / 你好, 张三! |

### 3.4 关键理解

`r *http.Request` 是一个包含了**所有请求信息**的结构体。常用字段：

| 字段/方法 | 含义 | 示例 |
|-----------|------|------|
| `r.URL.Path` | URL 路径 | `/hello` |
| `r.URL.Query().Get("key")` | 查询参数 | `?name=张三` → `"张三"` |
| `r.Method` | HTTP 方法 | `"GET"`, `"POST"` |
| `r.Header.Get("key")` | 请求头 | `r.Header.Get("User-Agent")` |
| `r.Body` | 请求体（POST 数据） | 后面会讲 |

---

## 4. 处理多个路由

### 4.1 目标

创建多个页面：首页、关于页、API 页。

### 4.2 代码

```go
package main

import (
    "fmt"
    "net/http"
)

func homePage(w http.ResponseWriter, r *http.Request) {
    fmt.Fprint(w, "<h1>欢迎来到我的网站</h1><p>这是首页</p>")
}

func aboutPage(w http.ResponseWriter, r *http.Request) {
    fmt.Fprint(w, "<h1>关于本站</h1><p>这是一个 Go 语言练习项目</p>")
}

func userPage(w http.ResponseWriter, r *http.Request) {
    name := r.URL.Query().Get("name")
    if name == "" {
        name = "访客"
    }
    fmt.Fprintf(w, "<h1>用户: %s</h1>", name)
}

func main() {
    // 注册路由：哪个路径访问哪个函数
    http.HandleFunc("/", homePage)       // 首页
    http.HandleFunc("/about", aboutPage) // 关于页
    http.HandleFunc("/user", userPage)   // 用户页

    fmt.Println("服务器启动: http://localhost:8080")
    http.ListenAndServe(":8080", nil)
}
```

### 4.3 关键理解

`http.HandleFunc` 的匹配规则：

- **`"/"`**：匹配所有路径（catch-all）。如果你访问 `/任意路径`，都会执行 `homePage`。
- **`"/about"`**：精确匹配 `/about`。
- **`"/about/"`**（带尾部斜杠）：匹配 `/about/` 开头的所有路径，如 `/about/me`。

> 如果你注册了 `"/"` 和 `"/about"`，访问 `/about` 会走 `aboutPage`，因为更具体的路径优先。

### 4.4 使用 ServeMux（更好的路由管理）

随着路由增多，建议使用显式的 `http.ServeMux`：

```go
func main() {
    mux := http.NewServeMux() // 创建自己的路由器

    mux.HandleFunc("/", homePage)
    mux.HandleFunc("/about", aboutPage)
    mux.HandleFunc("/user", userPage)

    // 把 mux 传给 ListenAndServe（不再是 nil）
    http.ListenAndServe(":8080", mux)
}
```

> 为什么不用全局的 `http.HandleFunc`？因为使用自己的 `mux` 可以更好地控制路由，也方便后面添加中间件。

---

## 5. 返回 JSON 数据（构建 API）

### 5.1 目标

很多 Web 应用不只是显示 HTML 页面，还需要提供 API 接口（返回 JSON 数据给前端或 App 调用）。

### 5.2 代码

```go
package main

import (
    "encoding/json"
    "net/http"
)

type User struct {
    ID    int    `json:"id"`
    Name  string `json:"name"`
    Email string `json:"email"`
}

func usersHandler(w http.ResponseWriter, r *http.Request) {
    // 准备数据（实际项目中从数据库查）
    users := []User{
        {ID: 1, Name: "张三", Email: "zhangsan@example.com"},
        {ID: 2, Name: "李四", Email: "lisi@example.com"},
    }

    // 设置响应头：告诉浏览器返回的是 JSON
    w.Header().Set("Content-Type", "application/json")

    // 把数据编码为 JSON 并写入响应
    json.NewEncoder(w).Encode(users)
}

func main() {
    http.HandleFunc("/api/users", usersHandler)
    http.ListenAndServe(":8080", nil)
}
```

### 5.3 测试

访问 `http://localhost:8080/api/users`，你会看到：

```json
[{"id":1,"name":"张三","email":"zhangsan@example.com"},{"id":2,"name":"李四","email":"lisi@example.com"}]
```

### 5.4 关键理解

- **`json.NewEncoder(w).Encode(data)`**：把 Go 的数据结构直接转成 JSON 字符串，写入响应。
- **`w.Header().Set("Content-Type", "application/json")`**：告诉浏览器"我返回的是 JSON"，浏览器才能正确解析。
- **struct 的 json tag**：`` `json:"id"` `` 指定 JSON 输出时的字段名。不加 tag 的话，字段名首字母会大写（Go 导出规则）。

> **顺序很重要**：必须先 `Set` Header，再 `Write` 内容。一旦开始写内容，就不能再修改 Header 了。

---

## 6. HTML 模板入门：告别字符串拼接

### 6.1 目标

前面的例子中，我们直接在 Go 代码里写 HTML 字符串（`fmt.Fprint(w, "<h1>...")`）。页面一多，代码会变得又长又乱。解决方案：**模板文件**。

### 6.2 代码

创建 `templates/index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{{.Title}}</title>
</head>
<body>
    <h1>{{.Title}}</h1>
    <p>{{.Message}}</p>

    <ul>
    {{range .Items}}
        <li>{{.}}</li>
    {{end}}
    </ul>
</body>
</html>
```

修改 `main.go`：

```go
package main

import (
    "html/template"
    "net/http"
)

// 启动时加载模板（只加载一次，不是每次请求都加载）
var tmpl = template.Must(template.ParseFiles("templates/index.html"))

func handler(w http.ResponseWriter, r *http.Request) {
    // 准备要传给模板的数据
    data := map[string]interface{}{
        "Title":   "我的 Go 网站",
        "Message": "欢迎来到用 Go 模板引擎渲染的页面！",
        "Items":   []string{"学习 Go", "学习模板", "构建网站"},
    }

    // 执行模板，把数据填进去，结果写入 w
    tmpl.Execute(w, data)
}

func main() {
    http.HandleFunc("/", handler)
    http.ListenAndServe(":8080", nil)
}
```

### 6.3 逐行解释

**模板文件中的 `{{ }}` 语法**：

```html
{{.Title}}        → 输出数据中的 Title 字段
{{range .Items}}  → 遍历 Items 切片
  {{.}}           → 在 range 内部，"." 代表当前元素
{{end}}           → 结束 range
```

**Go 代码中的关键点**：

```go
// ParseFiles 读取模板文件，返回一个 *template.Template
// Must 包裹它：如果解析失败，程序直接 panic（启动时就暴露错误）
var tmpl = template.Must(template.ParseFiles("templates/index.html"))

// Execute 执行模板：
// 第一个参数是写入目标（w = 浏览器）
// 第二个参数是传给模板的数据（可以是 struct、map 等）
tmpl.Execute(w, data)
```

### 6.4 模板语法速查

| 模板语法 | 含义 |
|----------|------|
| `{{.}}` | 当前数据（"dot"） |
| `{{.Name}}` | 访问数据的 Name 字段 |
| `{{if .Show}}...{{end}}` | 条件判断 |
| `{{if .Show}}...{{else}}...{{end}}` | 条件+否则 |
| `{{range .Items}}...{{end}}` | 遍历切片 |
| `{{range .Items}}...{{else}}...{{end}}` | 遍历（空切片走 else） |
| `{{range $i, $v := .Items}}` | 遍历（带索引和值） |
| `{{with .User}}...{{end}}` | 如果 User 不为空，进入其上下文 |
| `{{/* 注释 */}}` | 模板注释（不会输出到 HTML） |

---

## 7. 模板进阶：Layout 布局与组件复用

### 7.1 目标

真实网站的每个页面都有相同的头部、导航、底部。我们要把这些公共部分提取出来，只写一次。

### 7.2 目录结构

```
templates/
├── layout.html       ← 所有页面的骨架（头部+导航+底部）
├── home.html         ← 首页（只写内容部分）
└── about.html        ← 关于页（只写内容部分）
```

### 7.3 layout.html（骨架）

```html
{{define "layout"}}
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{{block "title" .}}默认标题{{end}} - 我的网站</title>
</head>
<body>
    <header>
        <h1>我的网站</h1>
        <nav>
            <a href="/">首页</a> |
            <a href="/about">关于</a>
        </nav>
    </header>

    <main>
        {{block "content" .}}{{end}}
    </main>

    <footer>
        <p>&copy; 2026 我的网站</p>
    </footer>
</body>
</html>
{{end}}
```

### 7.4 home.html（首页内容）

```html
{{define "title"}}首页{{end}}

{{define "content"}}
    <h2>欢迎！</h2>
    <p>{{.Greeting}}</p>
{{end}}
```

### 7.5 about.html（关于页内容）

```html
{{define "title"}}关于本站{{end}}

{{define "content"}}
    <h2>关于本站</h2>
    <p>这是一个用 Go 语言构建的练习项目</p>
{{end}}
```

### 7.6 Go 代码

```go
package main

import (
    "html/template"
    "net/http"
)

var templates = template.Must(template.ParseGlob("templates/*.html"))

func homeHandler(w http.ResponseWriter, r *http.Request) {
    templates.ExecuteTemplate(w, "layout", map[string]interface{}{
        "Greeting": "欢迎来到我的 Go 网站！",
    })
}

func aboutHandler(w http.ResponseWriter, r *http.Request) {
    templates.ExecuteTemplate(w, "layout", nil)
}

func main() {
    http.HandleFunc("/", homeHandler)
    http.HandleFunc("/about", aboutHandler)
    http.ListenAndServe(":8080", nil)
}
```

### 7.7 关键理解

| 模板动作 | 含义 |
|----------|------|
| `{{define "name"}}...{{end}}` | 定义一个命名模板 |
| `{{template "name" .}}` | 调用另一个命名模板（必须存在） |
| `{{block "name" .}}默认{{end}}` | 调用模板，如果不存在则使用默认内容 |

**布局的工作原理**：
1. `layout.html` 定义了 `{{define "layout"}}`，里面用 `{{block "title"}}` 和 `{{block "content"}}` 留了两个"插槽"
2. `home.html` 用 `{{define "title"}}` 和 `{{define "content"}}` 填充这两个插槽
3. 执行 `ExecuteTemplate(w, "layout", data)`，Go 会把所有碎片拼成完整 HTML

> **`block` vs `template`**：`block` 允许默认值（如果子模板没定义这个块，就用默认内容），`template` 要求被调用的模板必须存在。

---

## 8. 处理表单：让用户提交数据

### 8.1 目标

做一个留言板：用户填写表单 → 提交 → 显示在页面上。

### 8.2 代码

```go
package main

import (
    "html/template"
    "net/http"
)

var tmpl = template.Must(template.New("").Parse(`
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>留言板</title></head>
<body>
    <h1>留言板</h1>

    <form method="POST" action="/">
        <input type="text" name="message" placeholder="输入留言..." required>
        <button type="submit">提交</button>
    </form>

    <h2>历史留言 ({{len .Messages}})</h2>
    <ul>
    {{range .Messages}}
        <li>{{.}}</li>
    {{else}}
        <li>暂无留言</li>
    {{end}}
    </ul>
</body>
</html>
`))

// 存储留言（用内存切片模拟数据库）
var messages []string

func handler(w http.ResponseWriter, r *http.Request) {
    if r.Method == "POST" {
        // 读取表单数据
        msg := r.FormValue("message")
        if msg != "" {
            messages = append(messages, msg)
        }
        // 重定向回首页（PRG 模式：Post-Redirect-Get）
        http.Redirect(w, r, "/", http.StatusSeeOther)
        return
    }

    // GET 请求：显示页面
    tmpl.Execute(w, map[string]interface{}{
        "Messages": messages,
    })
}

func main() {
    http.HandleFunc("/", handler)
    http.ListenAndServe(":8080", nil)
}
```

### 8.3 关键理解

**表单提交流程**：

```
用户填写表单 → 点击提交 → 浏览器发送 POST 请求 → 服务器读取表单数据
→ 保存数据 → 重定向回首页 → 浏览器发送 GET 请求 → 显示最新页面
```

**`r.FormValue("message")`**：读取表单中 `name="message"` 的输入框的值。

**Post-Redirect-Get (PRG) 模式**：
- 如果不重定向，用户刷新页面会重复提交表单
- `http.StatusSeeOther`（303）告诉浏览器"请用 GET 重新访问这个 URL"

---

## 9. 实战项目：Task Manager 任务管理器

### 9.1 目标

把前面学的所有知识整合起来，做一个完整的任务管理器，支持：
- 查看任务列表
- 添加任务
- 标记完成/未完成
- 删除任务

### 9.2 完整代码

```go
package main

import (
    "html/template"
    "log"
    "net/http"
    "strconv"
    "sync"
    "time"
)

// ============== 数据模型 ==============

type Task struct {
    ID        int
    Title     string
    Done      bool
    CreatedAt time.Time
}

type TaskStore struct {
    mu     sync.Mutex
    tasks  []Task
    nextID int
}

func (s *TaskStore) List() []Task {
    s.mu.Lock()
    defer s.mu.Unlock()
    result := make([]Task, len(s.tasks))
    copy(result, s.tasks)
    return result
}

func (s *TaskStore) Add(title string) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.tasks = append(s.tasks, Task{
        ID: s.nextID, Title: title, CreatedAt: time.Now(),
    })
    s.nextID++
}

func (s *TaskStore) Toggle(id int) {
    s.mu.Lock()
    defer s.mu.Unlock()
    for i := range s.tasks {
        if s.tasks[i].ID == id {
            s.tasks[i].Done = !s.tasks[i].Done
            return
        }
    }
}

func (s *TaskStore) Delete(id int) {
    s.mu.Lock()
    defer s.mu.Unlock()
    for i := range s.tasks {
        if s.tasks[i].ID == id {
            s.tasks = append(s.tasks[:i], s.tasks[i+1:]...)
            return
        }
    }
}

// ============== 模板 ==============

var tmpl = template.Must(template.New("tasks").Parse(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>Task Manager</title>
    <style>
        body { font-family: sans-serif; max-width: 600px; margin: 40px auto; }
        .task { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid #eee; }
        .task.done span { text-decoration: line-through; color: #999; }
        .task form { margin: 0; }
        button { cursor: pointer; }
    </style>
</head>
<body>
    <h1>Task Manager</h1>

    <form action="/add" method="post" style="display:flex;gap:8px;margin-bottom:20px">
        <input type="text" name="title" placeholder="新任务..." required style="flex:1;padding:8px">
        <button type="submit">添加</button>
    </form>

    {{range .Tasks}}
    <div class="task {{if .Done}}done{{end}}">
        <form action="/toggle" method="post" style="display:inline">
            <input type="hidden" name="id" value="{{.ID}}">
            <button type="submit">{{if .Done}}✓{{else}}○{{end}}</button>
        </form>
        <span style="flex:1;margin:0 12px">{{.Title}}</span>
        <small style="color:#999">{{.CreatedAt.Format "15:04"}}</small>
        <form action="/delete" method="post" style="display:inline;margin-left:12px">
            <input type="hidden" name="id" value="{{.ID}}">
            <button type="submit" style="color:red">✕</button>
        </form>
    </div>
    {{else}}
    <p style="color:#999">暂无任务，快添加一个吧！</p>
    {{end}}

    <p style="margin-top:20px;color:#999;font-size:0.85em">
        共 {{len .Tasks}} 个任务
    </p>
</body>
</html>
`))

// ============== 处理器 ==============

func main() {
    store := &TaskStore{}

    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        tmpl.Execute(w, map[string]interface{}{
            "Tasks": store.List(),
        })
    })

    http.HandleFunc("/add", func(w http.ResponseWriter, r *http.Request) {
        if r.Method != "POST" {
            http.Redirect(w, r, "/", http.StatusSeeOther)
            return
        }
        title := r.FormValue("title")
        if title != "" {
            store.Add(title)
        }
        http.Redirect(w, r, "/", http.StatusSeeOther)
    })

    http.HandleFunc("/toggle", func(w http.ResponseWriter, r *http.Request) {
        if r.Method != "POST" {
            http.Redirect(w, r, "/", http.StatusSeeOther)
            return
        }
        id, _ := strconv.Atoi(r.FormValue("id"))
        store.Toggle(id)
        http.Redirect(w, r, "/", http.StatusSeeOther)
    })

    http.HandleFunc("/delete", func(w http.ResponseWriter, r *http.Request) {
        if r.Method != "POST" {
            http.Redirect(w, r, "/", http.StatusSeeOther)
            return
        }
        id, _ := strconv.Atoi(r.FormValue("id"))
        store.Delete(id)
        http.Redirect(w, r, "/", http.StatusSeeOther)
    })

    log.Println("Task Manager 启动: http://localhost:8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

### 9.3 代码讲解

**sync.Mutex 是什么？为什么需要它？**

```go
type TaskStore struct {
    mu     sync.Mutex  // 互斥锁
    tasks  []Task
    nextID int
}
```

Go 的 HTTP 服务器会为**每个请求**启动一个 goroutine（轻量级线程）。如果两个用户同时添加任务，`tasks` 切片可能被同时修改，导致数据错乱。`sync.Mutex` 保证同一时间只有一个 goroutine 能修改数据。

> 这是 Go 并发编程中最重要的概念之一：**通过互斥锁保护共享数据**。

**`strconv.Atoi`**：把字符串转成整数。因为 `r.FormValue` 返回的是 `string`，而 `id` 是 `int`。

**为什么设计成四个独立的路由**（`/add`, `/toggle`, `/delete`）而不是一个 `/`？

这样每个路由只做一件事，代码清晰，容易维护。这是 Web 开发的常见模式。

### 9.4 运行测试

```bash
go run main.go
```

打开 `http://localhost:8080`，添加几个任务，试试标记完成和删除。

---

## 10. 进阶网络编程：TCP/UDP

### 10.1 目标

前面我们一直在用 HTTP（基于 TCP 的应用层协议）。现在来了解底层——直接用 TCP 和 UDP 收发数据。

### 10.2 TCP 服务器与客户端

TCP 是**可靠**的、面向连接的协议。类似打电话：先拨号建立连接，然后双向通话，最后挂断。

**TCP 服务器**：

```go
package main

import (
    "bufio"
    "fmt"
    "log"
    "net"
    "strings"
)

func main() {
    // 1. 监听端口
    listener, err := net.Listen("tcp", ":8000")
    if err != nil {
        log.Fatal(err)
    }
    defer listener.Close()
    fmt.Println("TCP 服务器监听 :8000")

    for {
        // 2. 等待客户端连接
        conn, err := listener.Accept()
        if err != nil {
            continue
        }
        // 3. 每个连接用独立的 goroutine 处理
        go handleConn(conn)
    }
}

func handleConn(conn net.Conn) {
    defer conn.Close()
    reader := bufio.NewReader(conn)
    for {
        msg, err := reader.ReadString('\n')
        if err != nil {
            return
        }
        fmt.Printf("收到: %s", msg)
        // 转大写后返回
        conn.Write([]byte(strings.ToUpper(msg)))
    }
}
```

**TCP 客户端**：

```go
package main

import (
    "bufio"
    "fmt"
    "log"
    "net"
)

func main() {
    // 1. 连接服务器
    conn, err := net.Dial("tcp", "localhost:8000")
    if err != nil {
        log.Fatal(err)
    }
    defer conn.Close()

    // 2. 发送消息
    fmt.Fprint(conn, "hello from client\n")

    // 3. 读取响应
    reply, _ := bufio.NewReader(conn).ReadString('\n')
    fmt.Printf("服务器响应: %s", reply)
}
```

### 10.3 UDP 服务器与客户端

UDP 是**无连接**的、不保证送达的协议。类似寄信：写好地址扔进邮筒，不确认对方是否收到。

**UDP 服务器**：

```go
func main() {
    addr, _ := net.ResolveUDPAddr("udp", ":8001")
    conn, _ := net.ListenUDP("udp", addr)
    defer conn.Close()
    fmt.Println("UDP 服务器监听 :8001")

    buf := make([]byte, 1024)
    for {
        n, clientAddr, _ := conn.ReadFromUDP(buf)
        fmt.Printf("来自 %v: %s", clientAddr, string(buf[:n]))
        conn.WriteToUDP([]byte("收到！\n"), clientAddr)
    }
}
```

**UDP 客户端**：

```go
func main() {
    serverAddr, _ := net.ResolveUDPAddr("udp", "localhost:8001")
    conn, _ := net.DialUDP("udp", nil, serverAddr)
    defer conn.Close()

    conn.Write([]byte("hello via UDP\n"))
    buf := make([]byte, 1024)
    n, _, _ := conn.ReadFromUDP(buf)
    fmt.Printf("服务器响应: %s", string(buf[:n]))
}
```

### 10.4 TCP vs UDP

| | TCP | UDP |
|------|------|------|
| 连接方式 | 面向连接（三次握手） | 无连接 |
| 可靠性 | 保证送达、顺序正确 | 不保证送达、可能乱序 |
| 速度 | 较慢（有确认机制） | 快 |
| 应用场景 | HTTP、文件传输、邮件 | 视频直播、DNS、游戏 |

### 10.5 net 包核心 API

| 函数 | 用途 |
|------|------|
| `net.Listen("tcp", ":port")` | 创建 TCP 监听器 |
| `listener.Accept()` | 阻塞等待客户端连接 |
| `net.Dial("tcp", "host:port")` | 连接 TCP 服务器 |
| `net.ListenUDP("udp", addr)` | 创建 UDP 监听 |
| `net.DialUDP("udp", laddr, raddr)` | 创建 UDP 客户端 |
| `conn.SetDeadline(t)` | 设置读写超时（防止连接永久挂起） |

---

## 11. RPC 远程调用：服务之间如何通信

### 11.1 目标

当你有多个服务时，需要一种方式让它们互相调用函数。这就是 RPC（Remote Procedure Call，远程过程调用）。

### 11.2 net/rpc（Go 标准库）

Go 标准库自带 RPC 支持，但只适用于 Go 服务之间的通信。

**共享类型定义**：

```go
package shared

type Args struct {
    A, B int
}
type Result struct {
    Value int
}
```

**RPC 服务端**：

```go
package main

import (
    "log"
    "net"
    "net/http"
    "net/rpc"
)

type Calculator int

func (c *Calculator) Multiply(args *Args, reply *Result) error {
    reply.Value = args.A * args.B
    return nil
}

func main() {
    rpc.Register(new(Calculator))
    rpc.HandleHTTP()
    l, _ := net.Listen("tcp", ":1234")
    log.Println("RPC 服务器 :1234")
    http.Serve(l, nil)
}
```

**RPC 客户端**：

```go
func main() {
    client, _ := rpc.DialHTTP("tcp", "localhost:1234")
    defer client.Close()

    args := &Args{A: 7, B: 8}
    var result Result
    client.Call("Calculator.Multiply", args, &result)
    fmt.Printf("7 * 8 = %d\n", result.Value)
}
```

### 11.3 gRPC（现代微服务通信）

gRPC 是 Google 开发的 RPC 框架，基于 HTTP/2 + Protocol Buffers（二进制序列化）。优点：
- 跨语言（Go、Java、Python、Node.js 等都能用）
- 高性能（二进制编码，比 JSON 小很多）
- 支持流式传输（服务端推送、客户端流式上传、双向流）

**定义接口**（`echo.proto`）：

```protobuf
syntax = "proto3";
package echo;
option go_package = "./pb";

service EchoService {
  rpc UnaryEcho(EchoRequest) returns (EchoResponse);                           // 一元
  rpc ServerStreamEcho(EchoRequest) returns (stream EchoResponse);             // 服务端流
  rpc ClientStreamEcho(stream EchoRequest) returns (EchoResponse);             // 客户端流
  rpc BidirectionalEcho(stream EchoRequest) returns (stream EchoResponse);     // 双向流
}

message EchoRequest { string message = 1; }
message EchoResponse { string message = 1; }
```

**gRPC 服务端**：

```go
type echoServer struct {
    pb.UnimplementedEchoServiceServer
}

func (s *echoServer) UnaryEcho(ctx context.Context, req *pb.EchoRequest) (*pb.EchoResponse, error) {
    return &pb.EchoResponse{Message: "Echo: " + req.Message}, nil
}

func main() {
    lis, _ := net.Listen("tcp", ":50051")
    s := grpc.NewServer()
    pb.RegisterEchoServiceServer(s, &echoServer{})
    log.Fatal(s.Serve(lis))
}
```

**gRPC 客户端**：

```go
func main() {
    conn, _ := grpc.NewClient("localhost:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
    defer conn.Close()
    client := pb.NewEchoServiceClient(conn)

    ctx, cancel := context.WithTimeout(context.Background(), time.Second)
    defer cancel()

    resp, _ := client.UnaryEcho(ctx, &pb.EchoRequest{Message: "hello"})
    fmt.Println(resp.Message)
}
```

### 11.4 gRPC 四种调用模式

| 模式 | 说明 | 场景 |
|------|------|------|
| 一元 RPC | 客户端发一个请求，服务端回一个响应 | 普通 API 调用 |
| 服务端流式 | 客户端发一个请求，服务端持续推送多条响应 | 实时推送、日志流 |
| 客户端流式 | 客户端持续发送多条请求，服务端最后回一个响应 | 批量上传、数据采集 |
| 双向流式 | 双方同时收发 | 聊天、实时协作 |

---

## 12. WebSocket 实时通信

### 12.1 目标

HTTP 是"请求-响应"模式，服务器不能主动推送消息给客户端。WebSocket 解决了这个问题：建立连接后，双方可以随时互发消息。

### 12.2 最简单的 WebSocket 服务器

安装依赖：

```bash
go get github.com/gorilla/websocket
```

```go
package main

import (
    "log"
    "net/http"
    "github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
    CheckOrigin: func(r *http.Request) bool { return true }, // 开发环境允许所有来源
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
    // 把 HTTP 连接升级为 WebSocket 连接
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        log.Print("升级失败:", err)
        return
    }
    defer conn.Close()

    for {
        // 读取客户端消息
        msgType, msg, err := conn.ReadMessage()
        if err != nil {
            break
        }
        log.Printf("收到: %s", msg)
        // 原样返回
        conn.WriteMessage(msgType, msg)
    }
}

func main() {
    http.HandleFunc("/ws", wsHandler)
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

### 12.3 聊天室（Hub 模式）

当多个客户端需要互相通信时，需要一个"中心"来管理连接和广播消息：

```go
type Hub struct {
    clients    map[*Client]bool
    broadcast  chan []byte
    register   chan *Client
    unregister chan *Client
}

func (h *Hub) run() {
    for {
        select {
        case client := <-h.register:
            h.clients[client] = true
        case client := <-h.unregister:
            delete(h.clients, client)
            close(client.send)
        case msg := <-h.broadcast:
            for client := range h.clients {
                select {
                case client.send <- msg:
                default: // 客户端 send 缓冲区满，认为已断开
                    delete(h.clients, client)
                    close(client.send)
                }
            }
        }
    }
}
```

> **Hub 模式**是 WebSocket 的经典架构：Hub 在一个 goroutine 中运行，通过 channel 接收所有操作（注册、注销、广播），避免了并发写冲突。

### 12.4 WebSocket 关键点

| 要点 | 说明 |
|------|------|
| 心跳 | 定时发送 Ping，超时未收到 Pong 则断开 |
| 并发写保护 | gorilla/websocket 不支持并发写，必须通过 Hub 串行化 |
| 连接数限制 | 用计数器限制最大连接数，防止资源耗尽 |
| 认证 | 在升级前校验 Token（通过 query 参数或 cookie） |

---

## 13. 安全：XSS 防护与最佳实践

### 13.1 最重要的规则

```go
// ❌ 渲染 HTML 时用 text/template —— 没有任何安全保护
import "text/template"

// ✅ 渲染 HTML 时用 html/template —— 自动转义，防止 XSS 攻击
import "html/template"
```

### 13.2 自动转义演示

```go
// 假设用户输入了恶意脚本
userInput := `<script>alert('Hacked!')</script>`

// 放入模板
tmpl.Execute(w, map[string]string{"Content": userInput})
// 浏览器显示：<script>alert('Hacked!')</script>（纯文本，不会执行）
// 而不是弹出 alert 对话框
```

`html/template` 会自动根据上下文选择转义方式：
- HTML 文本中 → HTML 实体编码（`<` → `&lt;`）
- HTML 属性中 → 属性值转义
- JavaScript 中 → JS 字符串转义
- URL 中 → URL 编码

### 13.3 禁止事项

```go
// ❌ 绝对不要对用户输入用 template.HTML（绕过转义）
safeHTML := template.HTML(userInput)  // XSS 漏洞！

// ❌ 不要直接往 ResponseWriter 写字符串
fmt.Fprintf(w, "<h1>%s</h1>", userInput)  // XSS 漏洞！

// ✅ 使用模板引擎
tmpl.Execute(w, map[string]string{"Title": userInput})
```

---

## 14. 生产环境 Checklist

在把代码部署到生产环境之前，检查以下项目：

### 14.1 代码质量

- [ ] 使用 `html/template` 而非 `text/template` 渲染 HTML
- [ ] 模板在启动时解析（`template.Must`），不在每次请求中解析
- [ ] 不使用 `template.HTML` 处理用户输入
- [ ] 表单数据做了基本校验（非空、长度限制）

### 14.2 错误处理

```go
// ✅ 渲染到 buffer 先检查错误，再写入响应
func render(w http.ResponseWriter, tmpl *template.Template, data interface{}) {
    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, data); err != nil {
        log.Printf("模板错误: %v", err)
        http.Error(w, "内部错误", http.StatusInternalServerError)
        return
    }
    buf.WriteTo(w)
}
```

### 14.3 安全

- [ ] 设置 Content-Security-Policy 头
- [ ] 限制请求体大小（`http.MaxBytesReader`）
- [ ] 设置读写超时

```go
server := &http.Server{
    Addr:         ":8080",
    ReadTimeout:  5 * time.Second,
    WriteTimeout: 10 * time.Second,
    IdleTimeout:  120 * time.Second,
}
```

### 14.4 学习路线建议

作为 Go 初学者，建议按以下顺序学习：

1. **本教程**（net/http 基础 + 模板 + 实战项目）← 你已经在这里
2. 学习使用 **Gin 框架**（更简洁的路由、中间件、参数绑定）
3. 学习**数据库操作**（`database/sql` + PostgreSQL/MySQL）
4. 学习**用户认证**（JWT、Session、Cookie）
5. 学习**测试**（`net/http/httptest` 测试 Handler）
6. 学习 **gRPC**（微服务间通信）
7. 学习 **WebSocket**（实时通信）

---

## 参考资料

- [Go 官方教程：Writing Web Applications](https://go.dev/doc/articles/wiki/) — 构建 Wiki 应用的完整教程
- [Go Web Examples](https://gowebexamples.com/) — 代码示例驱动的 Go Web 教程
- [Alex Edwards - Let's Go](https://lets-go.alexedwards.net/) — 最受欢迎的 Go Web 开发书籍
- [DigitalOcean - How To Make an HTTP Server in Go](https://www.digitalocean.com/community/tutorials/how-to-make-an-http-server-in-go)
- [net/http 官方文档](https://pkg.go.dev/net/http)
- [html/template 官方文档](https://pkg.go.dev/html/template)
- [gRPC Go 官方教程](https://grpc.io/docs/languages/go/basics/)
- [gorilla/websocket Chat 示例](https://github.com/gorilla/websocket/tree/main/examples/chat)