# Go 网络模板与 Web 应用完全指南

> 本文档涵盖 Go 标准库模板引擎（`text/template`、`html/template`）、`net/http` 路由（Go 1.22+）、主流 Web 框架（Gin、Echo、Fiber）、`net` 包 TCP/UDP 网络编程、RPC 远程调用（`net/rpc`、gRPC）、以及 WebSocket 实时通信。所有代码均可直接运行。

---

## 目录

1. [net/http 路由（Go 1.22+）](#1-nethttp-路由go-122)
2. [快速开始：Hello World](#2-快速开始hello-world)
3. [模板语法速查](#3-模板语法速查)
4. [自定义函数 FuncMap](#4-自定义函数-funcmap)
5. [模板组合：Layout + Partial 模式](#5-模板组合layout--partial-模式)
6. [embed.FS：将模板嵌入二进制](#6-embedfs将模板嵌入二进制)
7. [Gin 框架模板渲染](#7-gin-框架模板渲染)
8. [Echo 框架模板渲染](#8-echo-框架模板渲染)
9. [Fiber 框架模板渲染](#9-fiber-框架模板渲染)
10. [Go 网络编程：TCP/UDP](#10-go-网络编程tcpudp)
11. [RPC 远程调用：net/rpc 与 gRPC](#11-rpc-远程调用netrpc-与-grpc)
12. [WebSocket 实时通信](#12-websocket-实时通信)
13. [安全：XSS 防护与自动转义](#13-安全xss-防护与自动转义)
14. [View Model 模式](#14-view-model-模式)
15. [生产环境最佳实践](#15-生产环境最佳实践)

---

## 1. net/http 路由（Go 1.22+）

Go 1.22 大幅增强了 `net/http.ServeMux`，原生支持 HTTP 方法匹配和路径参数。

### 6.1 基本路由

```go
package main

import (
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "strconv"
)

func main() {
    mux := http.NewServeMux()

    // 方法 + 路径匹配
    mux.HandleFunc("GET /api/users", listUsers)
    mux.HandleFunc("POST /api/users", createUser)
    mux.HandleFunc("GET /api/users/{id}", getUser)
    mux.HandleFunc("PUT /api/users/{id}", updateUser)
    mux.HandleFunc("DELETE /api/users/{id}", deleteUser)

    // 嵌套资源
    mux.HandleFunc("GET /api/users/{userID}/posts", listUserPosts)
    mux.HandleFunc("GET /api/users/{userID}/posts/{postID}", getUserPost)

    // 精确匹配根路径（{$} 防止匹配所有路径）
    mux.HandleFunc("GET /{$}", homePage)

    log.Fatal(http.ListenAndServe(":8080", mux))
}

func getUser(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id") // 提取路径参数
    // 实际应用中从数据库查询
    writeJSON(w, http.StatusOK, map[string]string{"id": id, "name": "张三"})
}
```

### 6.2 中间件模式

```go
// 中间件签名：func(http.Handler) http.Handler
func loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        next.ServeHTTP(w, r)
        log.Printf("%s %s %v", r.Method, r.URL.Path, time.Since(start))
    })
}

func authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := r.Header.Get("Authorization")
        if token == "" {
            http.Error(w, "Unauthorized", http.StatusUnauthorized)
            return
        }
        // 验证 token 并将用户信息存入 context
        ctx := context.WithValue(r.Context(), "userID", "123")
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// 中间件链
func middlewareChain(h http.Handler, middlewares ...func(http.Handler) http.Handler) http.Handler {
    for i := len(middlewares) - 1; i >= 0; i-- {
        h = middlewares[i](h)
    }
    return h
}

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("GET /api/public", publicHandler)
    mux.HandleFunc("GET /api/private", privateHandler)

    // 全局中间件
    handler := middlewareChain(mux, loggingMiddleware, corsMiddleware)

    http.ListenAndServe(":8080", handler)
}
```

### 6.3 路由分组（子路由）

```go
func main() {
    mux := http.NewServeMux()

    // API 路由组
    apiMux := http.NewServeMux()
    apiMux.HandleFunc("GET /users", listUsers)
    apiMux.HandleFunc("POST /users", createUser)
    // apiMux 挂载到 /api/ 前缀
    mux.Handle("/api/", http.StripPrefix("/api", apiMux))

    // Admin 路由组（带认证中间件）
    adminMux := http.NewServeMux()
    adminMux.HandleFunc("GET /dashboard", adminDashboard)
    adminMux.HandleFunc("GET /users", adminListUsers)
    mux.Handle("/admin/", http.StripPrefix("/admin",
        authMiddleware(adminMux)))

    http.ListenAndServe(":8080", mux)
}
```

### 6.4 完整 REST API 示例（含模板渲染）

```go
package main

import (
    "encoding/json"
    "html/template"
    "log"
    "net/http"
    "strconv"
    "sync"
    "time"
)

// ============== 数据模型 ==============

type Task struct {
    ID        int       `json:"id"`
    Title     string    `json:"title"`
    Done      bool      `json:"done"`
    CreatedAt time.Time `json:"created_at"`
}

type TaskStore struct {
    mu    sync.RWMutex
    tasks []Task
    nextID int
}

func (s *TaskStore) List() []Task {
    s.mu.RLock()
    defer s.mu.RUnlock()
    result := make([]Task, len(s.tasks))
    copy(result, s.tasks)
    return result
}

func (s *TaskStore) Add(title string) Task {
    s.mu.Lock()
    defer s.mu.Unlock()
    t := Task{ID: s.nextID, Title: title, Done: false, CreatedAt: time.Now()}
    s.nextID++
    s.tasks = append(s.tasks, t)
    return t
}

func (s *TaskStore) Toggle(id int) (Task, bool) {
    s.mu.Lock()
    defer s.mu.Unlock()
    for i := range s.tasks {
        if s.tasks[i].ID == id {
            s.tasks[i].Done = !s.tasks[i].Done
            return s.tasks[i], true
        }
    }
    return Task{}, false
}

func (s *TaskStore) Delete(id int) bool {
    s.mu.Lock()
    defer s.mu.Unlock()
    for i := range s.tasks {
        if s.tasks[i].ID == id {
            s.tasks = append(s.tasks[:i], s.tasks[i+1:]...)
            return true
        }
    }
    return false
}

// ============== 辅助函数 ==============

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, msg string) {
    writeJSON(w, status, map[string]string{"error": msg})
}

// ============== 模板 ==============

var pageTemplate = template.Must(template.New("tasks").Parse(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Task Manager</title>
    <style>
        body { font-family: sans-serif; max-width: 600px; margin: 40px auto; }
        .task { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid #eee; }
        .task.done span { text-decoration: line-through; color: #999; }
        .task form { margin-left: auto; }
        button { cursor: pointer; }
    </style>
</head>
<body>
    <h1>Task Manager</h1>

    <form action="/tasks" method="post">
        <input type="text" name="title" placeholder="新任务..." required>
        <button type="submit">添加</button>
    </form>

    <div class="task-list">
        {{range .Tasks}}
        <div class="task {{if .Done}}done{{end}}">
            <form action="/tasks/{{.ID}}/toggle" method="post" style="display:inline">
                <button type="submit">{{if .Done}}✓{{else}}○{{end}}</button>
            </form>
            <span>{{.Title}}</span>
            <form action="/tasks/{{.ID}}" method="post">
                <input type="hidden" name="_method" value="DELETE">
                <button type="submit">删除</button>
            </form>
        </div>
        {{else}}
        <p>暂无任务</p>
        {{end}}
    </div>
</body>
</html>
`))

// ============== 处理器 ==============

func main() {
    store := &TaskStore{nextID: 1}
    mux := http.NewServeMux()

    // 页面路由
    mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
        pageTemplate.Execute(w, map[string]interface{}{
            "Tasks": store.List(),
        })
    })

    // API 路由
    mux.HandleFunc("POST /tasks", func(w http.ResponseWriter, r *http.Request) {
        title := r.FormValue("title")
        if title == "" {
            writeError(w, http.StatusBadRequest, "title is required")
            return
        }
        task := store.Add(title)
        writeJSON(w, http.StatusCreated, task)
    })

    mux.HandleFunc("POST /tasks/{id}/toggle", func(w http.ResponseWriter, r *http.Request) {
        id, _ := strconv.Atoi(r.PathValue("id"))
        task, ok := store.Toggle(id)
        if !ok {
            writeError(w, http.StatusNotFound, "task not found")
            return
        }
        // HTML 表单提交后重定向回首页
        http.Redirect(w, r, "/", http.StatusSeeOther)
        _ = task
    })

    mux.HandleFunc("POST /tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
        id, _ := strconv.Atoi(r.PathValue("id"))
        if !store.Delete(id) {
            writeError(w, http.StatusNotFound, "task not found")
            return
        }
        http.Redirect(w, r, "/", http.StatusSeeOther)
    })

    log.Println("Server running at http://localhost:8080")
    log.Fatal(http.ListenAndServe(":8080", mux))
}
```

### 6.5 Go 1.22 ServeMux 增强总结

| 功能 | 语法 | 说明 |
|------|------|------|
| 方法匹配 | `"GET /path"` | 只匹配 GET 请求（GET 也匹配 HEAD） |
| 路径参数 | `"/users/{id}"` | `r.PathValue("id")` 获取 |
| 通配符 | `"/files/{path...}"` | 匹配多段路径 |
| 精确尾部 | `"/{$}"` | 只匹配 `/`，不做前缀匹配 |
| 自动 405 | 注册了 `GET /users/{id}` 但收到 `DELETE /users/123` | 自动返回 405 + Allow 头 |
| 冲突检测 | 启动时检测模式冲突 | 有歧义时 panic |

---

## 2. 快速开始：Hello World

### 1.1 text/template — 纯文本模板

```go
package main

import (
    "os"
    "text/template"
)

func main() {
    // 方式一：内联字符串
    tmpl := template.Must(template.New("hello").Parse("Hello, {{.Name}}!\n"))
    tmpl.Execute(os.Stdout, map[string]string{"Name": "World"})

    // 方式二：从文件加载
    // tmpl := template.Must(template.ParseFiles("templates/hello.tmpl"))
    // tmpl.Execute(os.Stdout, map[string]string{"Name": "World"})
}
```

### 1.2 html/template — HTML 模板（带自动转义）

```go
package main

import (
    "html/template"
    "net/http"
)

var tmpl = template.Must(template.New("index").Parse(`
<!DOCTYPE html>
<html>
<head><title>{{.Title}}</title></head>
<body>
    <h1>{{.Title}}</h1>
    <p>{{.Content}}</p>
</body>
</html>
`))

func handler(w http.ResponseWriter, r *http.Request) {
    data := map[string]string{
        "Title":   "Hello World",
        "Content": "这是一段 <script>alert('xss')</script> 测试内容",
    }
    tmpl.Execute(w, data)
}

func main() {
    http.HandleFunc("/", handler)
    http.ListenAndServe(":8080", nil)
}
```

> **关键区别**：`html/template` 会自动对 `<script>alert('xss')</script>` 进行 HTML 实体编码，浏览器中显示为纯文本而非执行脚本。`text/template` 不会做任何转义。

### 1.3 template.Must — 启动时校验

```go
// Must 在解析失败时 panic，适合在 init() 或包级变量中使用
// 模板错误在启动时立即暴露，而不是等到运行时
var templates = template.Must(template.ParseGlob("templates/*.html"))
```

---

## 3. 模板语法速查

### 2.1 基本输出

```go
// {{.}}        — 输出当前上下文（"dot"）
// {{.Name}}    — 输出字段
// {{.User.Name}} — 嵌套字段访问

type User struct {
    Name  string
    Email string
    Age   int
}

data := User{Name: "张三", Email: "zhangsan@example.com", Age: 30}
```

```html
<p>姓名: {{.Name}}</p>
<p>邮箱: {{.Email}}</p>
<p>年龄: {{.Age}}</p>
```

### 2.2 条件判断

```html
{{if .IsLoggedIn}}
    <p>欢迎回来, {{.Username}}!</p>
{{else if .IsNewUser}}
    <p>欢迎新用户!</p>
{{else}}
    <p>请先登录</p>
{{end}}
```

```go
// 比较函数：eq, ne, lt, le, gt, ge
// 注意：这些是函数调用语法，不是运算符
```

```html
{{if eq .Role "admin"}}
    <a href="/admin">管理后台</a>
{{end}}

{{if ge .Age 18}}
    <span>成年</span>
{{end}}
```

### 2.3 循环

```html
<!-- 遍历切片 -->
<ul>
{{range .Items}}
    <li>{{.}}</li>
{{else}}
    <li>暂无数据</li>
{{end}}
</ul>

<!-- 遍历 map -->
{{range $key, $value := .MapData}}
    <dt>{{$key}}</dt>
    <dd>{{$value}}</dd>
{{end}}

<!-- 遍历切片（带索引） -->
{{range $i, $item := .Items}}
    <tr>
        <td>{{inc $i}}</td>
        <td>{{$item.Title}}</td>
    </tr>
{{end}}
```

> **注意**：`range` 内部 dot（`.`）变为当前元素。如需访问外层数据，在 `range` 前保存到变量：`{{$root := .}}`

### 2.4 with — 处理可选嵌套数据

```html
{{with .Profile}}
    <div class="profile">
        <img src="{{.Avatar}}" alt="{{.Name}}">
        <p>{{.Bio}}</p>
    </div>
{{else}}
    <p>未设置个人资料</p>
{{end}}
```

### 2.5 管道（Pipeline）

```go
// 管道将前一个输出作为后一个函数的最后一个参数
```

```html
<!-- 等价于 printf("%s", htmlEscape(.Name)) -->
<p>{{.Name | html}}</p>

<!-- 链式管道 -->
<p>{{.Price | printf "%.2f" | printf "¥%s"}}</p>

<!-- 条件中的管道 -->
{{if .Content | len | lt 100}}
    <p>{{.Content}}</p>
{{else}}
    <p>{{.Content | truncate 100}}...</p>
{{end}}
```

### 2.6 变量声明

```html
{{$name := .FirstName}}
{{$name = printf "%s %s" $name .LastName}}
<p>全名: {{$name}}</p>
```

### 2.7 注释

```html
{{/* 这是模板注释，不会出现在输出中 */}}
<!-- 这是 HTML 注释，会出现在输出中 -->
```

---

## 4. 自定义函数 FuncMap

```go
package main

import (
    "fmt"
    "html/template"
    "net/http"
    "strings"
    "time"
)

// 1. 定义 FuncMap（必须在 Parse 之前）
var funcMap = template.FuncMap{
    // 使用标准库函数
    "upper": strings.ToUpper,
    "lower": strings.ToLower,

    // 自定义函数
    "formatDate": func(t time.Time) string {
        return t.Format("2006-01-02 15:04")
    },
    "formatPrice": func(price float64) string {
        return fmt.Sprintf("¥%.2f", price)
    },
    "truncate": func(s string, n int) string {
        runes := []rune(s)
        if len(runes) <= n {
            return s
        }
        return string(runes[:n]) + "..."
    },
    "add": func(a, b int) int {
        return a + b
    },
    "dict": func(values ...interface{}) (map[string]interface{}, error) {
        // 在模板中创建 map 的辅助函数
        if len(values)%2 != 0 {
            return nil, fmt.Errorf("dict requires even number of arguments")
        }
        dict := make(map[string]interface{}, len(values)/2)
        for i := 0; i < len(values); i += 2 {
            key, ok := values[i].(string)
            if !ok {
                return nil, fmt.Errorf("dict keys must be strings")
            }
            dict[key] = values[i+1]
        }
        return dict, nil
    },
}

// 2. 创建模板时绑定 FuncMap
var templates = template.Must(
    template.New("").Funcs(funcMap).ParseGlob("templates/*.html"),
)

func handler(w http.ResponseWriter, r *http.Request) {
    data := map[string]interface{}{
        "Title":     "商品列表",
        "CreatedAt": time.Now(),
        "Products": []map[string]interface{}{
            {"Name": "Go 编程", "Price": 59.9, "Desc": "这是一本关于 Go 语言的编程书籍，内容深入浅出"},
            {"Name": "云原生实战", "Price": 79.0, "Desc": "Kubernetes 与 Docker 实践指南"},
        },
    }
    templates.ExecuteTemplate(w, "products.html", data)
}

func main() {
    http.HandleFunc("/", handler)
    http.ListenAndServe(":8080", nil)
}
```

对应的模板文件 `templates/products.html`：

```html
{{define "products.html"}}
<!DOCTYPE html>
<html>
<head><title>{{.Title}}</title></head>
<body>
    <h1>{{.Title | upper}}</h1>
    <p>生成时间: {{.CreatedAt | formatDate}}</p>

    <table>
        <thead><tr><th>商品</th><th>价格</th><th>描述</th></tr></thead>
        <tbody>
        {{range .Products}}
            <tr>
                <td>{{.Name | upper}}</td>
                <td>{{.Price | formatPrice}}</td>
                <td>{{.Desc | truncate 20}}</td>
            </tr>
        {{end}}
        </tbody>
    </table>
</body>
</html>
{{end}}
```

### 内置函数速查

| 函数 | 用途 | 示例 |
|------|------|------|
| `print` / `printf` / `println` | 格式化输出 | `{{printf "%s-%d" .Name .Age}}` |
| `len` | 长度 | `{{len .Items}}` |
| `index` | 索引访问 | `{{index .Items 0}}` |
| `slice` | 切片 | `{{slice .Items 0 3}}` |
| `html` | HTML 转义 | `{{.Content \| html}}` |
| `js` | JS 转义 | `{{.Value \| js}}` |
| `urlquery` | URL 编码 | `{{.Query \| urlquery}}` |
| `and` / `or` / `not` | 逻辑运算 | `{{and .A .B}}` |
| `eq` / `ne` / `lt` / `le` / `gt` / `ge` | 比较 | `{{if ge .Age 18}}` |
| `call` | 调用函数 | `{{call .Func .Arg}}` |

---

## 5. 模板组合：Layout + Partial 模式

### 4.1 目录结构

```
templates/
├── layout.html      # 基础布局（骨架）
├── partials/
│   ├── header.html  # 页头
│   ├── nav.html     # 导航
│   └── footer.html  # 页脚
└── pages/
    ├── home.html    # 首页
    └── about.html   # 关于页
```

### 4.2 layout.html（基础布局）

```html
{{define "layout"}}
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{block "title" .}}默认标题{{end}} - My Site</title>
    <link rel="stylesheet" href="/static/style.css">
</head>
<body>
    {{template "header" .}}

    {{template "nav" .}}

    <main class="container">
        {{block "content" .}}{{end}}
    </main>

    {{template "footer" .}}
</body>
</html>
{{end}}
```

### 4.3 partials/header.html

```html
{{define "header"}}
<header class="site-header">
    <h1><a href="/">My Site</a></h1>
</header>
{{end}}
```

### 4.4 partials/nav.html

```html
{{define "nav"}}
<nav class="site-nav">
    <a href="/">首页</a>
    <a href="/about">关于</a>
    <a href="/posts">文章</a>
    {{if .IsLoggedIn}}
        <a href="/profile">{{.Username}}</a>
        <a href="/logout">退出</a>
    {{else}}
        <a href="/login">登录</a>
    {{end}}
</nav>
{{end}}
```

### 4.5 partials/footer.html

```html
{{define "footer"}}
<footer class="site-footer">
    <p>&copy; {{.Year}} My Site. All rights reserved.</p>
</footer>
{{end}}
```

### 4.6 pages/home.html

```html
{{define "title"}}首页{{end}}

{{define "content"}}
<section class="hero">
    <h2>欢迎来到 My Site</h2>
    <p>{{.Greeting}}</p>
</section>

<section class="posts">
    <h3>最新文章</h3>
    {{range .Posts}}
    <article class="post-card">
        <h4><a href="/posts/{{.ID}}">{{.Title}}</a></h4>
        <p class="meta">{{.Author}} · {{.CreatedAt | formatDate}}</p>
        <p>{{.Summary | truncate 100}}</p>
    </article>
    {{else}}
    <p>暂无文章</p>
    {{end}}
</section>
{{end}}
```

### 4.7 Go 代码

```go
package main

import (
    "fmt"
    "html/template"
    "net/http"
    "strings"
    "time"
)

var funcMap = template.FuncMap{
    "upper": strings.ToUpper,
    "formatDate": func(t time.Time) string {
        return t.Format("2006-01-02")
    },
    "truncate": func(s string, n int) string {
        runes := []rune(s)
        if len(runes) <= n {
            return s
        }
        return string(runes[:n]) + "..."
    },
}

// 启动时一次性解析所有模板
var templates = template.Must(
    template.New("").Funcs(funcMap).ParseGlob("templates/**/*.html"),
)

type Post struct {
    ID        int
    Title     string
    Author    string
    Summary   string
    CreatedAt time.Time
}

func homeHandler(w http.ResponseWriter, r *http.Request) {
    data := map[string]interface{}{
        "Year":     time.Now().Year(),
        "Greeting": "欢迎！这是一个 Go 模板渲染的页面。",
        "IsLoggedIn": true,
        "Username":  "张三",
        "Posts": []Post{
            {
                ID: 1, Title: "Go 模板入门",
                Author: "李四", Summary: "介绍 Go 标准库模板引擎的基础用法",
                CreatedAt: time.Now().AddDate(0, 0, -2),
            },
            {
                ID: 2, Title: "Web 框架对比",
                Author: "王五", Summary: "Gin vs Echo vs Fiber 深度对比",
                CreatedAt: time.Now().AddDate(0, 0, -1),
            },
        },
    }
    // 执行 layout 模板，它会自动拉入 title/content/header/nav/footer
    templates.ExecuteTemplate(w, "layout", data)
}

func aboutHandler(w http.ResponseWriter, r *http.Request) {
    data := map[string]interface{}{
        "Year": time.Now().Year(),
        "IsLoggedIn": false,
    }
    templates.ExecuteTemplate(w, "layout", data)
}

func main() {
    http.HandleFunc("/", homeHandler)
    http.HandleFunc("/about", aboutHandler)
    http.Handle("/static/", http.StripPrefix("/static/",
        http.FileServer(http.Dir("static"))))

    fmt.Println("Server running at http://localhost:8080")
    http.ListenAndServe(":8080", nil)
}
```

### 4.8 block vs template 的区别

```html
<!-- template：调用的模板必须存在，否则报错 -->
{{template "sidebar" .}}

<!-- block：如果模板不存在，使用默认内容 -->
{{block "sidebar" .}}
    <p>默认侧边栏内容</p>
{{end}}
```

> **最佳实践**：布局用 `block` 定义可覆盖的插槽，partial 用 `template` 调用必须存在的组件。

---

## 6. embed.FS：将模板嵌入二进制

Go 1.16+ 支持 `embed.FS`，将模板文件编译进二进制，部署时无需额外文件。

```go
package main

import (
    "embed"
    "html/template"
    "net/http"
    "time"
)

//go:embed templates/*
var templateFS embed.FS

// 使用 ParseFS 从嵌入文件系统加载模板
var templates = template.Must(
    template.New("").Funcs(funcMap).ParseFS(templateFS, "templates/**/*.html"),
)

// ... 其余代码不变

func main() {
    http.HandleFunc("/", homeHandler)
    http.ListenAndServe(":8080", nil)
}
```

> **关键点**：
> - `//go:embed templates/*` 只匹配一层，`templates/**/*.html` 递归匹配所有 html 文件
> - `ParseFS` 的 glob 模式与 `filepath.Glob` 一致，**不支持** `**` 递归匹配
> - 如需递归，需逐层指定：`"templates/*.html", "templates/*/*.html", "templates/*/*/*.html"`
> - 或者使用 `embed.FS` 的 `ReadDir` 手动递归收集文件，再用 `ParseFiles`

### 递归加载嵌入模板的完整方案

```go
package main

import (
    "embed"
    "html/template"
    "io/fs"
    "path/filepath"
    "strings"
)

//go:embed templates
var templateFS embed.FS

// collectTemplateFiles 递归收集所有 .html 文件路径
func collectTemplateFiles() ([]string, error) {
    var files []string
    err := fs.WalkDir(templateFS, "templates", func(path string, d fs.DirEntry, err error) error {
        if err != nil {
            return err
        }
        if !d.IsDir() && strings.HasSuffix(path, ".html") {
            files = append(files, path)
        }
        return nil
    })
    return files, err
}

func loadTemplates() *template.Template {
    files, err := collectTemplateFiles()
    if err != nil {
        panic(err)
    }
    return template.Must(
        template.New("").Funcs(funcMap).ParseFS(templateFS, files...),
    )
}
```

---

## 7. Gin 框架模板渲染

### 7.1 安装

```bash
go get github.com/gin-gonic/gin
```

### 7.2 基础模板渲染

```go
package main

import (
    "net/http"
    "time"

    "github.com/gin-gonic/gin"
)

func main() {
    r := gin.Default()

    // 加载模板
    r.LoadHTMLGlob("templates/**/*")

    r.GET("/", func(c *gin.Context) {
        c.HTML(http.StatusOK, "index.html", gin.H{
            "title": "Gin 模板示例",
            "items": []string{"Go", "Python", "Rust"},
        })
    })

    r.Run(":8080")
}
```

### 7.3 自定义模板函数

```go
package main

import (
    "fmt"
    "html/template"
    "net/http"
    "time"

    "github.com/gin-gonic/gin"
)

func formatAsDate(t time.Time) string {
    return t.Format("2006-01-02")
}

func main() {
    r := gin.Default()

    // 设置自定义函数（必须在加载模板之前）
    r.SetFuncMap(template.FuncMap{
        "formatAsDate": formatAsDate,
    })
    r.LoadHTMLGlob("templates/**/*")

    r.GET("/", func(c *gin.Context) {
        c.HTML(http.StatusOK, "posts.html", gin.H{
            "title": "文章列表",
            "posts": []gin.H{
                {"title": "Go 入门", "date": time.Now()},
                {"title": "Gin 框架", "date": time.Now().AddDate(0, 0, -1)},
            },
        })
    })

    r.Run(":8080")
}
```

### 7.4 多模板引擎（不同目录使用不同 FuncMap）

Gin 原生不支持多模板引擎，需要借助 `multitemplate` 库：

```bash
go get github.com/gin-contrib/multitemplate
```

```go
package main

import (
    "html/template"
    "net/http"
    "path/filepath"
    "strings"

    "github.com/gin-contrib/multitemplate"
    "github.com/gin-gonic/gin"
)

func createMyRender() multitemplate.Renderer {
    r := multitemplate.NewRenderer()

    // 前台页面模板
    layouts, _ := filepath.Glob("templates/layouts/*.html")
    pages, _ := filepath.Glob("templates/pages/front/*.html")
    for _, page := range pages {
        files := append(layouts, page)
        r.AddFromFilesFuncs(filepath.Base(page),
            template.FuncMap{"add": func(a, b int) int { return a + b }},
            files...,
        )
    }

    return r
}

func main() {
    r := gin.Default()
    r.HTMLRender = createMyRender()

    r.GET("/", func(c *gin.Context) {
        c.HTML(http.StatusOK, "home.html", gin.H{
            "title": "首页",
        })
    })

    r.Run(":8080")
}
```

### 7.5 Gin 模板目录结构建议

```
templates/
├── layouts/
│   ├── base.html
│   └── admin.html
├── partials/
│   ├── header.html
│   ├── sidebar.html
│   └── footer.html
└── pages/
    ├── front/
    │   ├── home.html
    │   └── about.html
    └── admin/
        ├── dashboard.html
        └── users.html
```

---

## 8. Echo 框架模板渲染

### 8.1 安装

```bash
go get github.com/labstack/echo/v4
```

### 8.2 基础模板渲染

Echo 使用 `Renderer` 接口，需要适配器：

```go
package main

import (
    "html/template"
    "io"
    "net/http"

    "github.com/labstack/echo/v4"
)

// TemplateRenderer Echo 的模板渲染适配器
type TemplateRenderer struct {
    templates *template.Template
}

func (t *TemplateRenderer) Render(w io.Writer, name string, data interface{}, c echo.Context) error {
    return t.templates.ExecuteTemplate(w, name, data)
}

func main() {
    e := echo.New()

    // 加载模板
    funcMap := template.FuncMap{
        "add": func(a, b int) int { return a + b },
    }
    templates := template.Must(
        template.New("").Funcs(funcMap).ParseGlob("templates/**/*.html"),
    )

    e.Renderer = &TemplateRenderer{templates: templates}

    e.GET("/", func(c echo.Context) error {
        return c.Render(http.StatusOK, "home.html", map[string]interface{}{
            "title": "Echo 模板示例",
        })
    })

    e.Logger.Fatal(e.Start(":8080"))
}
```

### 8.3 完整 Echo 应用示例

```go
package main

import (
    "html/template"
    "io"
    "net/http"
    "strconv"
    "sync"
    "time"

    "github.com/labstack/echo/v4"
    "github.com/labstack/echo/v4/middleware"
)

// ============== 数据模型 ==============

type Note struct {
    ID        int       `json:"id"`
    Title     string    `json:"title"`
    Content   string    `json:"content"`
    CreatedAt time.Time `json:"created_at"`
}

type NoteStore struct {
    mu     sync.RWMutex
    notes  []Note
    nextID int
}

func (s *NoteStore) List() []Note {
    s.mu.RLock()
    defer s.mu.RUnlock()
    result := make([]Note, len(s.notes))
    copy(result, s.notes)
    return result
}

func (s *NoteStore) Get(id int) (Note, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    for _, n := range s.notes {
        if n.ID == id {
            return n, true
        }
    }
    return Note{}, false
}

func (s *NoteStore) Add(title, content string) Note {
    s.mu.Lock()
    defer s.mu.Unlock()
    n := Note{ID: s.nextID, Title: title, Content: content, CreatedAt: time.Now()}
    s.nextID++
    s.notes = append(s.notes, n)
    return n
}

// ============== 模板 ==============

const baseTemplate = `
{{define "layout"}}
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{{block "title" .}}Notes{{end}} - Echo Demo</title>
    <style>
        body { font-family: sans-serif; max-width: 800px; margin: 40px auto; }
        .note { border: 1px solid #ddd; padding: 16px; margin: 8px 0; border-radius: 4px; }
        .note h3 { margin: 0 0 8px 0; }
        .note .meta { color: #999; font-size: 0.85em; }
        form { margin: 20px 0; }
        input, textarea { display: block; width: 100%; padding: 8px; margin: 8px 0; }
    </style>
</head>
<body>
    <h1>Notes</h1>
    {{block "content" .}}{{end}}
</body>
</html>
{{end}}

{{define "list.html"}}
{{template "layout" .}}
{{end}}

{{define "title"}}笔记列表{{end}}

{{define "content"}}
<form action="/notes" method="post">
    <input type="text" name="title" placeholder="标题" required>
    <textarea name="content" placeholder="内容" rows="3" required></textarea>
    <button type="submit">创建笔记</button>
</form>

{{range .Notes}}
<div class="note">
    <h3><a href="/notes/{{.ID}}">{{.Title}}</a></h3>
    <p>{{.Content}}</p>
    <p class="meta">{{.CreatedAt.Format "2006-01-02 15:04"}}</p>
</div>
{{else}}
<p>暂无笔记</p>
{{end}}
{{end}}

{{define "detail.html"}}
{{template "layout" .}}
{{end}}

{{define "detail-title"}}{{.Note.Title}}{{end}}
{{define "detail-content"}}
<div class="note">
    <h3>{{.Note.Title}}</h3>
    <p>{{.Note.Content}}</p>
    <p class="meta">{{.Note.CreatedAt.Format "2006-01-02 15:04"}}</p>
</div>
<a href="/">返回列表</a>
{{end}}
`

// TemplateRenderer Echo 模板渲染适配器
type TemplateRenderer struct {
    templates *template.Template
}

func (t *TemplateRenderer) Render(w io.Writer, name string, data interface{}, c echo.Context) error {
    return t.templates.ExecuteTemplate(w, name, data)
}

func main() {
    store := &NoteStore{nextID: 1}

    // 加载模板
    funcMap := template.FuncMap{}
    tmpl := template.Must(
        template.New("").Funcs(funcMap).Parse(baseTemplate),
    )

    e := echo.New()
    e.Renderer = &TemplateRenderer{templates: tmpl}

    // 中间件
    e.Use(middleware.Logger())
    e.Use(middleware.Recover())

    // 路由
    e.GET("/", func(c echo.Context) error {
        return c.Render(http.StatusOK, "list.html", map[string]interface{}{
            "Notes": store.List(),
        })
    })

    e.POST("/notes", func(c echo.Context) error {
        title := c.FormValue("title")
        content := c.FormValue("content")
        store.Add(title, content)
        return c.Redirect(http.StatusSeeOther, "/")
    })

    e.GET("/notes/:id", func(c echo.Context) error {
        id, _ := strconv.Atoi(c.Param("id"))
        note, ok := store.Get(id)
        if !ok {
            return c.String(http.StatusNotFound, "Note not found")
        }
        return c.Render(http.StatusOK, "detail.html", map[string]interface{}{
            "Note": note,
        })
    })

    e.Logger.Fatal(e.Start(":8080"))
}
```

---

## 9. Fiber 框架模板渲染

### 9.1 安装

```bash
go get github.com/gofiber/fiber/v3
go get github.com/gofiber/template/html/v2
```

### 9.2 基础模板渲染

```go
package main

import (
    "github.com/gofiber/fiber/v3"
    "github.com/gofiber/template/html/v2"
)

func main() {
    // 创建模板引擎
    engine := html.New("./templates", ".html")

    // 可选：开发模式自动重载模板
    engine.Reload(true)

    app := fiber.New(fiber.Config{
        Views: engine,
    })

    app.Get("/", func(c fiber.Ctx) error {
        return c.Render("index", fiber.Map{
            "Title": "Fiber 模板示例",
        })
    })

    app.Listen(":8080")
}
```

### 9.3 自定义模板函数

```go
package main

import (
    "time"

    "github.com/gofiber/fiber/v3"
    "github.com/gofiber/template/html/v2"
)

func main() {
    engine := html.New("./templates", ".html")

    // 添加自定义函数
    engine.AddFunc("formatDate", func(t time.Time) string {
        return t.Format("2006-01-02 15:04")
    })
    engine.AddFunc("add", func(a, b int) int {
        return a + b
    })

    app := fiber.New(fiber.Config{
        Views: engine,
    })

    app.Get("/", func(c fiber.Ctx) error {
        return c.Render("index", fiber.Map{
            "Title": "Fiber 模板示例",
            "Now":   time.Now(),
        })
    })

    app.Listen(":8080")
}
```

### 9.4 完整 Fiber 应用（带 Layout 支持）

```go
package main

import (
    "strconv"
    "sync"
    "time"

    "github.com/gofiber/fiber/v3"
    "github.com/gofiber/template/html/v2"
)

type Bookmark struct {
    ID        int
    URL       string
    Title     string
    CreatedAt time.Time
}

type BookmarkStore struct {
    mu       sync.RWMutex
    bookmarks []Bookmark
    nextID   int
}

func (s *BookmarkStore) List() []Bookmark {
    s.mu.RLock()
    defer s.mu.RUnlock()
    result := make([]Bookmark, len(s.bookmarks))
    copy(result, s.bookmarks)
    return result
}

func (s *BookmarkStore) Add(url, title string) Bookmark {
    s.mu.Lock()
    defer s.mu.Unlock()
    b := Bookmark{ID: s.nextID, URL: url, Title: title, CreatedAt: time.Now()}
    s.nextID++
    s.bookmarks = append(s.bookmarks, b)
    return b
}

func (s *BookmarkStore) Delete(id int) bool {
    s.mu.Lock()
    defer s.mu.Unlock()
    for i, b := range s.bookmarks {
        if b.ID == id {
            s.bookmarks = append(s.bookmarks[:i], s.bookmarks[i+1:]...)
            return true
        }
    }
    return false
}

func main() {
    store := &BookmarkStore{nextID: 1}

    engine := html.New("./templates", ".html")
    engine.AddFunc("formatDate", func(t time.Time) string {
        return t.Format("2006-01-02 15:04")
    })

    app := fiber.New(fiber.Config{
        Views: engine,
    })

    app.Get("/", func(c fiber.Ctx) error {
        return c.Render("index", fiber.Map{
            "Title":     "我的书签",
            "Bookmarks": store.List(),
        })
    })

    app.Post("/bookmarks", func(c fiber.Ctx) error {
        url := c.FormValue("url")
        title := c.FormValue("title")
        if url == "" || title == "" {
            return c.Status(fiber.StatusBadRequest).SendString("url and title required")
        }
        store.Add(url, title)
        return c.Redirect().To("/")
    })

    app.Post("/bookmarks/:id/delete", func(c fiber.Ctx) error {
        id, _ := strconv.Atoi(c.Params("id"))
        store.Delete(id)
        return c.Redirect().To("/")
    })

    app.Listen(":8080")
}
```

对应的模板文件 `templates/index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>{{.Title}}</title>
    <style>
        body { font-family: sans-serif; max-width: 600px; margin: 40px auto; }
        .bookmark { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid #eee; }
        .bookmark .info { flex: 1; }
        .bookmark button { color: red; }
        form { margin: 20px 0; display: flex; gap: 8px; }
        input { flex: 1; padding: 8px; }
    </style>
</head>
<body>
    <h1>{{.Title}}</h1>

    <form action="/bookmarks" method="post">
        <input type="url" name="url" placeholder="URL" required>
        <input type="text" name="title" placeholder="标题" required>
        <button type="submit">添加</button>
    </form>

    {{range .Bookmarks}}
    <div class="bookmark">
        <div class="info">
            <a href="{{.URL}}" target="_blank">{{.Title}}</a>
            <div style="color:#999;font-size:0.85em">{{.CreatedAt | formatDate}}</div>
        </div>
        <form action="/bookmarks/{{.ID}}/delete" method="post">
            <button type="submit">删除</button>
        </form>
    </div>
    {{else}}
    <p>暂无书签</p>
    {{end}}
</body>
</html>
```

### 9.5 Fiber 注意事项

| 注意点 | 说明 |
|--------|------|
| `*fiber.Ctx` 不可传 goroutine | Fiber 复用 Ctx 对象，goroutine 中使用的 Ctx 可能已被回收 |
| 不兼容 `net/http` 中间件 | Fiber 基于 Fasthttp，无法直接使用标准库中间件 |
| 不支持 HTTP/2 | Fasthttp 不支持 HTTP/2 |
| 模板引擎 | 使用 `github.com/gofiber/template` 系列包 |

---

## 10. Go 网络编程：TCP/UDP

Go 的 `net` 包提供了跨平台的网络 I/O 接口，支持 TCP、UDP、Unix Domain Socket 等协议。

### 13.1 TCP 并发服务器

```go
package main

import (
    "bufio"
    "fmt"
    "log"
    "net"
    "strings"
    "time"
)

func main() {
    listener, err := net.Listen("tcp", ":8000")
    if err != nil {
        log.Fatal(err)
    }
    defer listener.Close()
    fmt.Println("TCP 服务器监听 :8000")

    for {
        conn, err := listener.Accept()
        if err != nil {
            log.Printf("接受连接失败: %v", err)
            continue
        }
        // 每个连接一个 goroutine，实现并发处理
        go handleConn(conn)
    }
}

func handleConn(conn net.Conn) {
    defer conn.Close()
    // 设置读写超时
    conn.SetDeadline(time.Now().Add(5 * time.Minute))

    reader := bufio.NewReader(conn)
    for {
        msg, err := reader.ReadString('\n')
        if err != nil {
            return // 客户端断开
        }
        fmt.Printf("收到: %s", msg)

        // 转换为大写后返回
        reply := strings.ToUpper(msg)
        conn.Write([]byte(reply))
    }
}
```

### 13.2 TCP 客户端

```go
package main

import (
    "bufio"
    "fmt"
    "log"
    "net"
    "os"
)

func main() {
    conn, err := net.Dial("tcp", "localhost:8000")
    if err != nil {
        log.Fatal(err)
    }
    defer conn.Close()

    // 发送消息
    fmt.Fprintf(conn, "hello from client\n")

    // 读取响应
    reply, err := bufio.NewReader(conn).ReadString('\n')
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("服务器响应: %s", reply)
}
```

### 13.3 UDP 服务器

UDP 无连接，无需 `Accept`，直接读写数据包并记录发送方地址。

```go
package main

import (
    "fmt"
    "log"
    "net"
    "time"
)

func main() {
    addr, _ := net.ResolveUDPAddr("udp", ":8001")
    conn, err := net.ListenUDP("udp", addr)
    if err != nil {
        log.Fatal(err)
    }
    defer conn.Close()
    fmt.Println("UDP 服务器监听 :8001")

    buf := make([]byte, 1024)
    for {
        n, clientAddr, err := conn.ReadFromUDP(buf)
        if err != nil {
            continue
        }
        fmt.Printf("来自 %v: %s", clientAddr, string(buf[:n]))

        // 回复当前时间戳
        reply := []byte(time.Now().Format(time.RFC3339) + "\n")
        conn.WriteToUDP(reply, clientAddr)
    }
}
```

### 13.4 UDP 客户端

```go
package main

import (
    "fmt"
    "log"
    "net"
)

func main() {
    serverAddr, _ := net.ResolveUDPAddr("udp", "localhost:8001")
    conn, err := net.DialUDP("udp", nil, serverAddr)
    if err != nil {
        log.Fatal(err)
    }
    defer conn.Close()

    // 发送
    conn.Write([]byte("ping\n"))

    // 读取响应
    buf := make([]byte, 1024)
    n, _, err := conn.ReadFromUDP(buf)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("服务器响应: %s", string(buf[:n]))
}
```

### 13.5 net 包核心 API 速查

| 函数 | 用途 |
|------|------|
| `net.Listen("tcp", ":port")` | 创建 TCP 监听器 |
| `listener.Accept()` | 阻塞等待客户端连接，返回 `net.Conn` |
| `net.Dial("tcp", "host:port")` | 连接到 TCP 服务器 |
| `net.ListenUDP("udp", addr)` | 创建 UDP 连接 |
| `net.DialUDP("udp", laddr, raddr)` | 创建 UDP 客户端连接 |
| `conn.Read(buf)` / `conn.Write(buf)` | 读写数据 |
| `conn.SetDeadline(t)` | 设置读写超时 |
| `conn.SetReadDeadline(t)` / `conn.SetWriteDeadline(t)` | 分别设置读/写超时 |
| `net.DialTimeout("tcp", addr, timeout)` | 带超时的连接 |
| `net.Dialer{DualStack: true}` | IPv4/IPv6 双栈连接 |

### 13.6 TCP 粘包处理

TCP 是流式协议，一次 `Read` 可能读到多个消息或不完整的消息。常见方案：

```go
// 方案一：固定长度头 + 变长体（推荐）
func readPacket(conn net.Conn) ([]byte, error) {
    // 先读 4 字节长度头
    header := make([]byte, 4)
    if _, err := io.ReadFull(conn, header); err != nil {
        return nil, err
    }
    length := binary.BigEndian.Uint32(header)
    // 再读变长体
    body := make([]byte, length)
    if _, err := io.ReadFull(conn, body); err != nil {
        return nil, err
    }
    return body, nil
}

// 方案二：分隔符协议（如换行符 \n）
func readLine(conn net.Conn) (string, error) {
    return bufio.NewReader(conn).ReadString('\n')
}
```

---

## 11. RPC 远程调用：net/rpc 与 gRPC

### 14.1 net/rpc — Go 标准库 RPC

Go 标准库内置 `net/rpc`，使用 Go 的 `gob` 编码。

**服务定义**（共享类型）：

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

// 方法签名必须满足：func (t *T) MethodName(args *Args, reply *Result) error
func (c *Calculator) Multiply(args *Args, reply *Result) error {
    reply.Value = args.A * args.B
    return nil
}

func (c *Calculator) Divide(args *Args, reply *Result) error {
    if args.B == 0 {
        return errors.New("除数不能为零")
    }
    reply.Value = args.A / args.B
    return nil
}

func main() {
    calc := new(Calculator)
    rpc.Register(calc)     // 注册服务
    rpc.HandleHTTP()       // 通过 HTTP 传输

    l, err := net.Listen("tcp", ":1234")
    if err != nil {
        log.Fatal(err)
    }
    log.Println("RPC 服务器监听 :1234")
    http.Serve(l, nil)
}
```

**RPC 客户端**：

```go
package main

import (
    "fmt"
    "log"
    "net/rpc"
)

func main() {
    client, err := rpc.DialHTTP("tcp", "localhost:1234")
    if err != nil {
        log.Fatal(err)
    }
    defer client.Close()

    // 同步调用
    args := &Args{A: 7, B: 8}
    var result Result
    err = client.Call("Calculator.Multiply", args, &result)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("%d * %d = %d\n", args.A, args.B, result.Value)

    // 异步调用
    divCall := client.Go("Calculator.Divide", args, &result, nil)
    <-divCall.Done // 等待完成
    fmt.Printf("%d / %d = %d\n", args.A, args.B, result.Value)
}
```

### 14.2 JSON-RPC

Go 标准库也支持 JSON-RPC，只需更换 Codec：

```go
// 服务端
import "net/rpc/jsonrpc"

// 客户端使用 jsonrpc.Dial 而非 rpc.DialHTTP
client, err := jsonrpc.Dial("tcp", "localhost:1234")

// 或用 net/rpc 包内置的 JSON-RPC 服务端
// rpc.ServeCodec(jsonrpc.NewServerCodec(conn))
```

### 14.3 gRPC — 现代微服务通信

gRPC 基于 HTTP/2 + Protocol Buffers，支持四种调用模式。

**安装工具**：

```bash
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
```

**定义 Proto 文件** (`echo.proto`)：

```protobuf
syntax = "proto3";
package echo;
option go_package = "./pb";

service EchoService {
  // 一元 RPC：请求 → 响应
  rpc UnaryEcho(EchoRequest) returns (EchoResponse);

  // 服务端流式：请求 → 流<响应>
  rpc ServerStreamEcho(EchoRequest) returns (stream EchoResponse);

  // 客户端流式：流<请求> → 响应
  rpc ClientStreamEcho(stream EchoRequest) returns (EchoResponse);

  // 双向流式：流<请求> ↔ 流<响应>
  rpc BidirectionalEcho(stream EchoRequest) returns (stream EchoResponse);
}

message EchoRequest {
  string message = 1;
}

message EchoResponse {
  string message = 1;
}
```

**生成代码**：

```bash
protoc --go_out=. --go-grpc_out=. echo.proto
```

**gRPC 服务端**：

```go
package main

import (
    "context"
    "fmt"
    "io"
    "log"
    "net"

    "google.golang.org/grpc"
    pb "yourmodule/pb"
)

type echoServer struct {
    pb.UnimplementedEchoServiceServer
}

// 一元 RPC
func (s *echoServer) UnaryEcho(ctx context.Context, req *pb.EchoRequest) (*pb.EchoResponse, error) {
    return &pb.EchoResponse{Message: "Echo: " + req.Message}, nil
}

// 服务端流式
func (s *echoServer) ServerStreamEcho(req *pb.EchoRequest, stream pb.EchoService_ServerStreamEchoServer) error {
    for i := 0; i < 5; i++ {
        stream.Send(&pb.EchoResponse{
            Message: fmt.Sprintf("Echo #%d: %s", i+1, req.Message),
        })
    }
    return nil
}

// 客户端流式
func (s *echoServer) ClientStreamEcho(stream pb.EchoService_ClientStreamEchoServer) error {
    var messages []string
    for {
        req, err := stream.Recv()
        if err == io.EOF {
            // 客户端发送完毕，返回汇总响应
            return stream.SendAndClose(&pb.EchoResponse{
                Message: fmt.Sprintf("收到 %d 条消息: %v", len(messages), messages),
            })
        }
        if err != nil {
            return err
        }
        messages = append(messages, req.Message)
    }
}

// 双向流式
func (s *echoServer) BidirectionalEcho(stream pb.EchoService_BidirectionalEchoServer) error {
    for {
        req, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return err
        }
        // 收到一条就回复一条
        stream.Send(&pb.EchoResponse{Message: "Echo: " + req.Message})
    }
}

func main() {
    lis, _ := net.Listen("tcp", ":50051")
    s := grpc.NewServer()
    pb.RegisterEchoServiceServer(s, &echoServer{})
    log.Println("gRPC 服务器监听 :50051")
    log.Fatal(s.Serve(lis))
}
```

**gRPC 客户端**：

```go
package main

import (
    "context"
    "io"
    "log"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    pb "yourmodule/pb"
)

func main() {
    conn, err := grpc.NewClient("localhost:50051",
        grpc.WithTransportCredentials(insecure.NewCredentials()))
    if err != nil {
        log.Fatal(err)
    }
    defer conn.Close()
    client := pb.NewEchoServiceClient(conn)

    // 一元调用（带超时）
    ctx, cancel := context.WithTimeout(context.Background(), time.Second)
    defer cancel()
    resp, _ := client.UnaryEcho(ctx, &pb.EchoRequest{Message: "hello"})
    log.Printf("一元响应: %s", resp.Message)

    // 服务端流式
    stream, _ := client.ServerStreamEcho(ctx, &pb.EchoRequest{Message: "world"})
    for {
        resp, err := stream.Recv()
        if err == io.EOF {
            break
        }
        log.Printf("流响应: %s", resp.Message)
    }
}
```

### 14.4 gRPC 四种模式对比

| 模式 | Proto 关键字 | 场景 |
|------|-------------|------|
| 一元 RPC | 无 `stream` | 普通请求-响应 |
| 服务端流式 | `stream` 在返回值前 | 日志推送、实时数据流 |
| 客户端流式 | `stream` 在参数前 | 批量上传、数据采集 |
| 双向流式 | `stream` 在参数和返回值前 | 聊天、实时协作 |

### 14.5 gRPC vs REST vs net/rpc

| | gRPC | REST (JSON) | net/rpc |
|------|------|------------|---------|
| 协议 | HTTP/2 | HTTP/1.1 | HTTP/1.1 或 TCP |
| 序列化 | Protobuf (二进制) | JSON (文本) | Gob (二进制) |
| 消息体积 | 小 | 大 | 小 |
| 跨语言 | ✅ | ✅ | ❌ (Go only) |
| 流式 | 原生支持 | 需 SSE/WebSocket | ❌ |
| 浏览器直连 | ❌ (需 gRPC-Web) | ✅ | ❌ |
| 适用场景 | 微服务间通信 | 对外开放 API | Go 服务间简单通信 |

---

## 12. WebSocket 实时通信

WebSocket 在单条 TCP 连接上提供全双工通信。Go 中最常用的库是 `gorilla/websocket`。

### 15.1 安装

```bash
go get github.com/gorilla/websocket
```

### 15.2 基础 WebSocket 服务器

```go
package main

import (
    "log"
    "net/http"

    "github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  1024,
    WriteBufferSize: 1024,
    // 生产环境必须校验 Origin
    CheckOrigin: func(r *http.Request) bool { return true },
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        log.Printf("升级失败: %v", err)
        return
    }
    defer conn.Close()

    log.Printf("客户端连接: %s", conn.RemoteAddr())

    for {
        msgType, msg, err := conn.ReadMessage()
        if err != nil {
            log.Printf("读取错误: %v", err)
            break
        }
        log.Printf("收到: %s", msg)

        // 回显消息
        if err := conn.WriteMessage(msgType, msg); err != nil {
            log.Printf("写入错误: %v", err)
            break
        }
    }
}

func main() {
    http.HandleFunc("/ws", wsHandler)
    log.Println("WebSocket 服务器启动 :8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

### 15.3 完整聊天服务器（Hub 模式）

Hub 模式是 WebSocket 生产环境的标准架构：一个 Hub goroutine 管理所有 Client，避免并发写冲突。

```go
package main

import (
    "bytes"
    "log"
    "net/http"
    "sync"
    "time"

    "github.com/gorilla/websocket"
)

// ===== 常量 =====

const (
    writeWait      = 10 * time.Second
    pongWait       = 60 * time.Second
    pingPeriod     = (pongWait * 9) / 10
    maxMessageSize = 512
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  1024,
    WriteBufferSize: 1024,
    CheckOrigin:     func(r *http.Request) bool { return true },
}

// ===== Client =====

type Client struct {
    hub  *Hub
    conn *websocket.Conn
    send chan []byte
}

func (c *Client) readPump() {
    defer func() {
        c.hub.unregister <- c
        c.conn.Close()
    }()
    c.conn.SetReadLimit(maxMessageSize)
    c.conn.SetReadDeadline(time.Now().Add(pongWait))
    c.conn.SetPongHandler(func(string) error {
        c.conn.SetReadDeadline(time.Now().Add(pongWait))
        return nil
    })

    for {
        _, msg, err := c.conn.ReadMessage()
        if err != nil {
            break
        }
        msg = bytes.TrimSpace(msg)
        c.hub.broadcast <- msg
    }
}

func (c *Client) writePump() {
    ticker := time.NewTicker(pingPeriod)
    defer func() {
        ticker.Stop()
        c.conn.Close()
    }()

    for {
        select {
        case msg, ok := <-c.send:
            c.conn.SetWriteDeadline(time.Now().Add(writeWait))
            if !ok {
                c.conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }
            if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
                return
            }
        case <-ticker.C:
            c.conn.SetWriteDeadline(time.Now().Add(writeWait))
            if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }
        }
    }
}

// ===== Hub =====

type Hub struct {
    clients    map[*Client]bool
    broadcast  chan []byte
    register   chan *Client
    unregister chan *Client
    mu         sync.RWMutex
}

func newHub() *Hub {
    return &Hub{
        clients:    make(map[*Client]bool),
        broadcast:  make(chan []byte),
        register:   make(chan *Client),
        unregister: make(chan *Client),
    }
}

func (h *Hub) run() {
    for {
        select {
        case client := <-h.register:
            h.mu.Lock()
            h.clients[client] = true
            h.mu.Unlock()

        case client := <-h.unregister:
            h.mu.Lock()
            if _, ok := h.clients[client]; ok {
                delete(h.clients, client)
                close(client.send)
            }
            h.mu.Unlock()

        case msg := <-h.broadcast:
            h.mu.RLock()
            for client := range h.clients {
                select {
                case client.send <- msg:
                default:
                    // send 缓冲区满，认为客户端已死
                    close(client.send)
                    delete(h.clients, client)
                }
            }
            h.mu.RUnlock()
        }
    }
}

// ===== HTTP Handler =====

func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        log.Printf("升级失败: %v", err)
        return
    }
    client := &Client{
        hub:  hub,
        conn: conn,
        send: make(chan []byte, 256),
    }
    hub.register <- client

    go client.writePump()
    go client.readPump()
}

func main() {
    hub := newHub()
    go hub.run()

    http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
        serveWs(hub, w, r)
    })

    log.Println("聊天服务器启动 :8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

### 15.4 测试用 HTML 客户端

```html
<!DOCTYPE html>
<html>
<head><title>Chat</title></head>
<body>
    <div id="chat" style="height:300px;overflow-y:scroll;border:1px solid #ccc;margin-bottom:10px"></div>
    <input id="msg" type="text" placeholder="输入消息..." autofocus>
    <button onclick="send()">发送</button>

    <script>
    const ws = new WebSocket("ws://localhost:8080/ws");
    const chat = document.getElementById("chat");
    const input = document.getElementById("msg");

    ws.onmessage = (e) => {
        chat.innerHTML += "<div>" + e.data + "</div>";
        chat.scrollTop = chat.scrollHeight;
    };
    ws.onclose = () => chat.innerHTML += "<div style='color:red'>连接已断开</div>";

    function send() {
        if (input.value) {
            ws.send(input.value);
            input.value = "";
        }
    }
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") send();
    });
    </script>
</body>
</html>
```

### 15.5 WebSocket 生产关键点

| 要点 | 说明 |
|------|------|
| **Ping/Pong 心跳** | 服务端定时发 Ping，客户端自动回 Pong；超时未收到 Pong 则断开连接 |
| **并发写保护** | `gorilla/websocket` 不支持并发写，必须通过 channel 串行化（Hub 模式） |
| **Origin 校验** | 生产环境必须在 `CheckOrigin` 中校验请求来源 |
| **消息大小限制** | `SetReadLimit` 防止恶意超大消息耗尽内存 |
| **优雅关闭** | 用 `signal.NotifyContext` 捕获 SIGTERM，`Shutdown` 排空连接 |
| **水平扩展** | 多实例部署时用 Redis Pub/Sub 广播跨实例消息 |
| **连接数限制** | 用 `atomic` 计数器或信号量控制最大连接数 |
| **认证** | 在升级前校验 JWT Token（通过 query param 或 cookie） |
| **goroutine 泄漏** | 确保每个连接在断开时关闭对应的 goroutine |

### 15.6 coder/websocket（新项目替代方案）

`gorilla/websocket` 原仓库已于 2022 年归档，新项目推荐使用 `coder/websocket`：

```bash
go get github.com/coder/websocket
```

```go
import "github.com/coder/websocket"

func handler(w http.ResponseWriter, r *http.Request) {
    conn, err := websocket.Accept(w, r, nil)
    if err != nil {
        return
    }
    defer conn.CloseNow()

    ctx := conn.CloseRead(r.Context())
    for {
        _, msg, err := conn.Read(ctx)
        if err != nil {
            return
        }
        conn.Write(ctx, websocket.MessageText, msg)
    }
}
```

**coder/websocket 优势**：
- 使用 `context.Context` 传播取消和超时，更符合 Go 惯例
- 内部处理并发写入安全，无需 Hub 模式串行化
- 活跃维护

---

## 参考资料

- [Go 官方博客：Go 1.22 路由增强](https://go.dev/blog/routing-enhancements)
- [html/template 官方文档](https://pkg.go.dev/html/template)
- [text/template 官方文档](https://pkg.go.dev/text/template)
- [Alex Edwards - Let's Go: HTML 模板与继承](https://lets-go.alexedwards.net/sample/02.08-html-templating-and-inheritance.html)
- [Eli Bendersky - Go 1.22 HTTP 路由](https://eli.thegreenplace.net/2023/better-http-server-routing-in-go-122/)
- [Gin 官方文档](https://gin-gonic.com/docs/)
- [Echo 官方文档](https://echo.labstack.com/)
- [Fiber 官方文档](https://docs.gofiber.io/)
- [Encore - Gin vs Echo vs Fiber 对比](https://encore.dev/articles/gin-vs-echo-vs-fiber)
- [net 包官方文档](https://pkg.go.dev/net)
- [Go Socket Programming (Kelche)](https://www.kelche.co/blog/go/socket-programming/)
- [gRPC Go 官方教程](https://grpc.io/docs/languages/go/basics/)
- [gRPC 四种调用模式 Codelab](https://codelabs.developers.google.com/grpc/getting-started-grpc-go-streaming)
- [net/rpc 官方文档](https://pkg.go.dev/net/rpc)
- [gorilla/websocket 官方文档](https://pkg.go.dev/github.com/gorilla/websocket)
- [gorilla/websocket Chat 示例](https://github.com/gorilla/websocket/tree/main/examples/chat)
- [coder/websocket Go WebSocket 指南](https://websocket.org/guides/languages/go/)
## 13. 安全：XSS 防护与自动转义

### 10.1 核心规则

```go
// ❌ 错误：text/template 用于 HTML —— 无任何转义，直接输出原始 HTML
import "text/template"

// ✅ 正确：html/template 用于 HTML —— 自动上下文转义
import "html/template"
```

### 10.2 自动上下文转义

`html/template` 根据数据出现的上下文自动选择转义方式：

```html
<!-- 假设 .Data = `O'Reilly: How are <i>you</i>?` -->

<!-- HTML 文本上下文 → HTML 实体编码 -->
<p>{{.Data}}</p>
<!-- 输出: O'Reilly: How are &lt;i&gt;you&lt;/i&gt;? -->

<!-- HTML 属性上下文 → 属性转义 -->
<a title="{{.Data}}">link</a>
<!-- 输出: O&#39;Reilly: How are you? -->

<!-- URL 上下文 → URL 编码 -->
<a href="/search?q={{.Data}}">search</a>
<!-- 输出: O%27Reilly%3a%20How%20are%3ci%3eyou%3c%2fi%3e -->

<!-- JavaScript 字符串上下文 → JS 转义 -->
<script>var x = "{{.Data}}";</script>
<!-- 输出: O\x27Reilly: How are \x3ci\x3eyou... -->
```

### 10.3 安全类型（谨慎使用）

```go
// 只有在你 100% 确信内容是安全的情况下，才使用这些类型

// template.HTML — 标记为安全 HTML，不转义
type Comment struct {
    Body template.HTML
}
// tmpl.Execute(w, Comment{Body: template.HTML("<b>bold</b>")})
// 输出: <b>bold</b> （而不是 &lt;b&gt;bold&lt;/b&gt;）

// ❌ 绝对不要对用户输入这样做
// safeHTML := template.HTML(userInput) // 这是 XSS 漏洞！
```

| 类型 | 用途 | 风险 |
|------|------|------|
| `template.HTML` | 安全 HTML 片段 | 用户输入使用 → XSS |
| `template.HTMLAttr` | 安全 HTML 属性 | 用户输入使用 → XSS |
| `template.JS` | 安全 JavaScript | 用户输入使用 → XSS |
| `template.JSStr` | 安全 JS 字符串 | 用户输入使用 → XSS |
| `template.CSS` | 安全 CSS | 用户输入使用 → CSS 注入 |
| `template.URL` | 安全 URL | 用户输入使用 → javascript: 注入 |
| `template.Srcset` | 安全 srcset 属性 | 用户输入使用 → XSS |

### 10.4 直接写 ResponseWriter 的危险

```go
// ❌ 绕过模板引擎，无自动转义
func handler(w http.ResponseWriter, r *http.Request) {
    name := r.URL.Query().Get("name")
    fmt.Fprintf(w, "<h1>Hello, %s</h1>", name) // XSS 漏洞！
    // io.WriteString(w, "<h1>Hello, "+name+"</h1>") // 同样危险
    // w.Write([]byte("<h1>Hello, " + name + "</h1>")) // 同样危险
}

// ✅ 使用模板引擎
func handler(w http.ResponseWriter, r *http.Request) {
    name := r.URL.Query().Get("name")
    tmpl.Execute(w, map[string]string{"Name": name})
}
```

### 10.5 Content Security Policy（防御纵深）

```go
func securityHeadersMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Security-Policy",
            "default-src 'self'; script-src 'self'; object-src 'none';")
        w.Header().Set("X-Content-Type-Options", "nosniff")
        w.Header().Set("X-Frame-Options", "DENY")
        next.ServeHTTP(w, r)
    })
}
```

---

## 14. View Model 模式

**不要直接把数据库模型传给模板。** 创建专门的 View Model 结构体，只包含模板需要的数据。

### 反例

```go
// ❌ 直接把数据库模型传给模板
type User struct {
    ID             int
    Email          string
    PasswordHash   string   // 不应该暴露给模板
    ResetToken     *string  // 不应该暴露给模板
    BillingPlan    int      // 模板需要判断
    SubscriptionID *string
    CreatedAt      time.Time
    UpdatedAt      time.Time
    // ... 30+ 字段
}
```

### 正例

```go
// ✅ 专门的 View Model
type ProfilePageVM struct {
    DisplayName    string
    MemberSince    string // 已格式化
    PlanLabel      string // "免费版" / "专业版" / "企业版"
    CanManageBilling bool
    RecentInvoices []InvoiceSummaryVM
    ShowTrialBanner bool
}

type InvoiceSummaryVM struct {
    ID     string
    Amount string // 已格式化 "¥99.00"
    Date   string // 已格式化 "2024-01-15"
    Status string // "已支付" / "待支付"
}

func buildProfilePageVM(user User) ProfilePageVM {
    return ProfilePageVM{
        DisplayName: user.DisplayName(),
        MemberSince: user.CreatedAt.Format("2006年01月"),
        PlanLabel:   planLabel(user.BillingPlan),
        CanManageBilling: user.BillingPlan > 0,
        ShowTrialBanner:  user.BillingPlan == 0,
        RecentInvoices: buildInvoiceVMs(user.RecentInvoices()),
    }
}
```

> **View Model 原则**：
> - 模板不包含业务逻辑判断（如 `{{if eq .Plan 1}}` → 改为 `{{if .CanManageBilling}}`）
> - 字符串已格式化，模板直接输出
> - 列表已排序，模板直接遍历
> - 不暴露数据库内部字段

---

## 15. 生产环境最佳实践

### 12.1 模板解析策略

```go
// ✅ 启动时一次性解析
var templates = template.Must(
    template.New("").Funcs(funcMap).ParseFS(templateFS, "templates/**/*.html"),
)

// ❌ 每次请求都解析（性能灾难）
func handler(w http.ResponseWriter, r *http.Request) {
    tmpl, _ := template.ParseFiles("templates/home.html") // 不要这样做！
    tmpl.Execute(w, data)
}
```

> `html/template.Template` 是并发安全的，多个 goroutine 可以同时调用 `Execute`。

### 12.2 FuncMap 规范

```go
// ✅ 短小、确定性的辅助函数
var funcMap = template.FuncMap{
    "formatDate":  func(t time.Time) string { return t.Format("2006-01-02") },
    "formatPrice": func(p float64) string { return fmt.Sprintf("¥%.2f", p) },
    "truncate":    func(s string, n int) string { /* ... */ },
}

// ❌ 不要在 FuncMap 中做数据库调用、网络请求、权限检查
// 这些逻辑应该在 Go 代码中处理，结果放入 View Model
```

### 12.3 错误处理

```go
func renderTemplate(w http.ResponseWriter, tmpl *template.Template, name string, data interface{}) {
    // 先渲染到 buffer，出错时不会污染 ResponseWriter
    var buf bytes.Buffer
    if err := tmpl.ExecuteTemplate(&buf, name, data); err != nil {
        log.Printf("template error: %v", err)
        http.Error(w, "Internal Server Error", http.StatusInternalServerError)
        return
    }
    buf.WriteTo(w)
}
```

### 12.4 模板测试（Golden File）

```go
func TestHomePageTemplate(t *testing.T) {
    data := buildTestHomePageData()
    var buf bytes.Buffer
    err := templates.ExecuteTemplate(&buf, "home.html", data)
    if err != nil {
        t.Fatal(err)
    }

    // 与 golden file 对比
    golden := filepath.Join("testdata", "home.html.golden")
    if *update {
        os.WriteFile(golden, buf.Bytes(), 0644)
    }
    expected, _ := os.ReadFile(golden)
    if diff := cmp.Diff(string(expected), buf.String()); diff != "" {
        t.Errorf("template output mismatch (-want +got):\n%s", diff)
    }
}
```

### 12.5 框架选择建议

| 场景 | 推荐 | 理由 |
|------|------|------|
| 简单 API / 内部工具 | `net/http` (Go 1.22+) | 零依赖，足够强大 |
| 中小型 REST API | Gin | 生态最成熟，文档最丰富 |
| 注重代码质量 | Echo | API 最优雅，错误处理模型最好 |
| 极致性能 / Express.js 迁移 | Fiber | 基于 Fasthttp，比 net/http 快 60% |
| 服务端渲染 HTML 为主 | Gin + multitemplate 或 Echo | 模板集成成熟 |
| 微型服务 | `net/http` | 最简单，无框架开销 |

### 12.6 上线前检查清单

- [ ] 使用 `html/template` 而非 `text/template` 渲染 HTML
- [ ] 模板在启动时解析，不在请求中解析
- [ ] `FuncMap` 中的函数是确定性的，无副作用
- [ ] 使用 View Model 而非直接传递数据库模型
- [ ] 渲染前先写入 buffer，出错时返回 500 而非半截 HTML
- [ ] 未对用户输入使用 `template.HTML` 等安全类型
- [ ] 设置了 CSP 头（`Content-Security-Policy`）
- [ ] 模板错误有日志记录
- [ ] 有 golden file 测试覆盖关键模板

---


## 参考资料

- [Go 官方博客：Go 1.22 路由增强](https://go.dev/blog/routing-enhancements)
- [html/template 官方文档](https://pkg.go.dev/html/template)
- [text/template 官方文档](https://pkg.go.dev/text/template)
- [Alex Edwards - Let's Go: HTML 模板与继承](https://lets-go.alexedwards.net/sample/02.08-html-templating-and-inheritance.html)
- [Eli Bendersky - Go 1.22 HTTP 路由](https://eli.thegreenplace.net/2023/better-http-server-routing-in-go-122/)
- [Gin 官方文档](https://gin-gonic.com/docs/)
- [Echo 官方文档](https://echo.labstack.com/)
- [Fiber 官方文档](https://docs.gofiber.io/)
- [Encore - Gin vs Echo vs Fiber 对比](https://encore.dev/articles/gin-vs-echo-vs-fiber)
- [net 包官方文档](https://pkg.go.dev/net)
- [Go Socket Programming (Kelche)](https://www.kelche.co/blog/go/socket-programming/)
- [gRPC Go 官方教程](https://grpc.io/docs/languages/go/basics/)
- [gRPC 四种调用模式 Codelab](https://codelabs.developers.google.com/grpc/getting-started-grpc-go-streaming)
- [net/rpc 官方文档](https://pkg.go.dev/net/rpc)
- [gorilla/websocket 官方文档](https://pkg.go.dev/github.com/gorilla/websocket)
- [gorilla/websocket Chat 示例](https://github.com/gorilla/websocket/tree/main/examples/chat)
- [coder/websocket Go WebSocket 指南](https://websocket.org/guides/languages/go/)