# Go 反射

反射是 Go 在运行时检查类型信息、读写变量值的机制。`reflect` 包提供了 TypeOf、ValueOf 两大入口，以及 Kind、Elem、Field 等操作方法。

---

## 反射的两个核心类型

`reflect.Type` 和 `reflect.Value` 是反射体系的两大支柱：

| 类型 | 获取方式 | 作用 |
|------|---------|------|
| `reflect.Type` | `reflect.TypeOf(x)` | 描述类型本身的元信息（名称、种类、字段、方法） |
| `reflect.Value` | `reflect.ValueOf(x)` | 持有运行时的值，可以读取和修改 |

```go
var x int = 42

t := reflect.TypeOf(x)   // reflect.Type → int
v := reflect.ValueOf(x)  // reflect.Value → 持有 42
```

**关键区别**：`TypeOf` 只关心"是什么类型"，`ValueOf` 关心"里面装的什么值"。

---

## 获取类型信息 — TypeOf

`reflect.TypeOf(x)` 返回 `reflect.Type`，包含类型的全部元信息：

```go
var x int = 42
t := reflect.TypeOf(x)

fmt.Println(t.Name()) // "int"
fmt.Println(t.Kind()) // reflect.Int
fmt.Println(t.Size()) // 8 (字节)
```

### Name vs Kind

| 属性 | 含义 | 示例 |
|------|------|------|
| `.Name()` | 类型的声明名称 | `int`、`string`、`User` |
| `.Kind()` | 底层种类（枚举值） | `reflect.Int`、`reflect.Struct`、`reflect.Ptr` |

```go
type MyInt int
var m MyInt = 10

t := reflect.TypeOf(m)
fmt.Println(t.Name()) // "MyInt" — 自定义名称
fmt.Println(t.Kind()) // reflect.Int — 底层种类
```

`Kind()` 的常见枚举值：

| Kind | 含义 |
|------|------|
| `reflect.Int` | 整数 |
| `reflect.String` | 字符串 |
| `reflect.Bool` | 布尔 |
| `reflect.Struct` | 结构体 |
| `reflect.Ptr` | 指针 |
| `reflect.Slice` | 切片 |
| `reflect.Map` | 映射 |
| `reflect.Interface` | 接口 |
| `reflect.Func` | 函数 |

---

## 获取运行时值 — ValueOf

`reflect.ValueOf(x)` 返回 `reflect.Value`，持有运行时的值：

```go
var x int = 42
v := reflect.ValueOf(x)

fmt.Printf("%v\n", v)              // 42 (Go 1.19+ 直接打印值)
fmt.Printf("%T\n", v)              // reflect.Value (v 本身是结构体)
fmt.Println(v.Kind())              // reflect.Int
fmt.Println(v.Int())               // 42 (类型特定的取值方法)
```

### 传指针才能修改

`ValueOf` 接收的是 `interface{}`，传值会产生副本。要修改原变量，必须传指针：

```go
var x int = 42

// 传值 — 不可修改
v := reflect.ValueOf(x)
v.SetInt(100) // ❌ panic: call of reflect.Value.SetInt on unaddressable value

// 传指针 — 通过 Elem() 解引用后可修改
vp := reflect.ValueOf(&x)
vp.Elem().SetInt(100) // ✅ x 变成 100
```

---

## 解引用指针 — Elem()

`Elem()` 有两种用途：

1. **对指针**：返回指针指向的值（解引用）
2. **对接口**：返回接口里装的动态值

```go
var x int = 42

// 指针解引用
vp := reflect.ValueOf(&x)  // Kind = Ptr
ve := vp.Elem()             // Kind = Int，指向 x
ve.SetInt(100)              // 修改 x 成功

// 接口解引用
var i interface{} = 42
vi := reflect.ValueOf(&i).Elem() // Kind = Interface
ve2 := vi.Elem()                  // Kind = Int，取出 42
```

**注意**：对非指针、非接口类型调用 `Elem()` 会 panic：

```go
v := reflect.ValueOf(42)
v.Elem() // ❌ panic: call of reflect.Value.Elem on int Value
```

---

## 结构体反射

结构体是反射最重要的应用场景——遍历字段、读写值、读取 Tag。

### NumField 与 Field

```go
type User struct {
    Name string
    Age  int
}

u := User{Name: "Alice", Age: 30}
v := reflect.ValueOf(u)
t := reflect.TypeOf(u)

for i := 0; i < v.NumField(); i++ {
    field := t.Field(i)      // reflect.StructField（类型信息）
    valField := v.Field(i)   // reflect.Value（值信息）

    fmt.Printf("字段名: %s, 类型: %s, 值: %v\n",
        field.Name, field.Type, valField)
}
// 字段名: Name, 类型: string, 值: Alice
// 字段名: Age, 类型: int, 值: 30
```

### Field vs Field(i) — Type 和 Value 各有一套

| 方法 | 所属 | 返回类型 | 用途 |
|------|------|---------|------|
| `Type.Field(i)` | reflect.Type | `reflect.StructField` | 字段名、类型、Tag、偏移量 |
| `Value.Field(i)` | reflect.Value | `reflect.Value` | 字段的值，可用于 Set 操作 |

### FieldByName — 按名称取字段

```go
v := reflect.ValueOf(u)
nameVal := v.FieldByName("Name") // 返回 reflect.Value
fmt.Println(nameVal.String())    // "Alice"

t := reflect.TypeOf(u)
nameField, ok := t.FieldByName("Name") // 返回 StructField + bool
fmt.Println(nameField.Type)             // string
```

### StructField 结构体

`reflect.StructField` 包含字段的所有元信息：

```go
type StructField struct {
    Name      string       // 字段名
    Type      Type         // 字段类型
    Tag       StructTag    // 结构体标签
    Offset    uintptr      // 在结构体中的偏移量
    Index     []int        // 字段索引路径（用于嵌套）
    Anonymous bool         // 是否是匿名字段
}
```

---

## 读取结构体 Tag

Tag 是结构体字段的元数据标注，广泛用于 JSON 序列化、ORM 映射、配置解析：

```go
type Config struct {
    Host string `ini:"host" validate:"required"`
    Port int    `ini:"port" validate:"min=1,max=65535"`
}

t := reflect.TypeOf(Config{})
field, _ := t.FieldByName("Host")

fmt.Println(field.Tag.Get("ini"))       // "host"
fmt.Println(field.Tag.Get("validate"))  // "required"
```

### Tag 的格式规则

```
`key1:"value1" key2:"value2"`
```

- 整个 Tag 用反引号包裹
- 每个条目格式：`key:"value"`
- 多个条目用空格分隔
- `Get("key")` 返回 `""` 表示该 key 不存在

---

## 取回原始值 — Interface()

`.Interface()` 把 `reflect.Value` 转回 `interface{}`，再通过类型断言取出具体值：

```go
var x int = 42
v := reflect.ValueOf(x)

// reflect.Value → interface{}
i := v.Interface()    // 类型是 interface{}，里面装着 int

// interface{} → 具体类型（类型断言）
n := i.(int)          // n = 42，类型 int

// 一步到位
n2 := v.Interface().(int) // 42
```

### 为什么不直接用 .Int()？

| 方法 | 返回类型 | 适用场景 |
|------|---------|---------|
| `.Int()` | `int64` | 明确知道是 int 类型 |
| `.Interface().(int)` | `int` | 需要原始类型，或不确定具体类型 |
| `.Interface()` | `interface{}` | 配合 `fmt.Sprintf` 等通用处理 |

实际项目中常见用法（如 `ini_config.go`）：

```go
valField := v.Field(i)
value := fmt.Sprintf("%v", valField.Interface())
// Interface() 返回 interface{}，Sprintf 的 %v 会自动拆箱打印
```

---

## 修改值 — Set 系列方法

修改值的前提条件：
1. 传入的是指针（`ValueOf(&x)`）
2. 调用 `Elem()` 解引用
3. 字段是可导出的（大写字母开头）
4. 用 `CanSet()` 检查

### SetString / SetInt / SetUint / SetFloat

```go
type User struct {
    Name string
    Age  int
}

u := User{Name: "Alice", Age: 30}
vp := reflect.ValueOf(&u).Elem() // 传指针 + Elem 解引用

// 修改字符串
nameField := vp.FieldByName("Name")
if nameField.CanSet() {
    nameField.SetString("Bob")
}

// 修改整数
ageField := vp.FieldByName("Age")
if ageField.CanSet() {
    ageField.SetInt(25)
}

fmt.Println(u) // {Bob 25}
```

### 小写字段不可修改

```go
type Config struct {
    host string // 小写，不可导出
}

c := Config{host: "localhost"}
vp := reflect.ValueOf(&c).Elem()
f := vp.FieldByName("host")

fmt.Println(f.CanSet()) // false
f.SetString("127.0.0.1") // ❌ panic: reflect: call of reflect.Value.SetString on unexported field
```

---

## IsValid 与 CanSet

| 方法 | 返回 | 用途 |
|------|------|------|
| `.IsValid()` | `bool` | Value 是否持有值（零值 Value 返回 false） |
| `.CanSet()` | `bool` | Value 是否可以修改（传值/小写字段返回 false） |

```go
v := reflect.ValueOf(nil)
fmt.Println(v.IsValid()) // false

v2 := reflect.ValueOf(42)
fmt.Println(v2.IsValid()) // true
fmt.Println(v2.CanSet())  // false（传值，不是指针）

vp := reflect.ValueOf(&x)
fmt.Println(vp.Elem().CanSet()) // true（传指针 + Elem）
```

---

## 完整示例 — INI 配置解析器

综合运用反射读取 Tag、遍历字段、修改值：

```go
package main

import (
    "fmt"
    "reflect"
    "strconv"
)

type Config struct {
    Host string `ini:"host"`
    Port int    `ini:"port"`
    Debug bool  `ini:"debug"`
}

func ParseINI(cfg interface{}, data map[string]string) {
    v := reflect.ValueOf(cfg).Elem()
    t := v.Type()

    for i := 0; i < v.NumField(); i++ {
        field := t.Field(i)
        tag := field.Tag.Get("ini")
        if tag == "" {
            continue
        }

        val, ok := data[tag]
        if !ok {
            continue
        }

        f := v.Field(i)
        if !f.CanSet() {
            continue
        }

        switch f.Kind() {
        case reflect.String:
            f.SetString(val)
        case reflect.Int:
            n, _ := strconv.Atoi(val)
            f.SetInt(int64(n))
        case reflect.Bool:
            b, _ := strconv.ParseBool(val)
            f.SetBool(b)
        }
    }
}

func main() {
    cfg := Config{}
    data := map[string]string{
        "host":  "localhost",
        "port":  "8080",
        "debug": "true",
    }
    ParseINI(&cfg, data)
    fmt.Printf("%+v\n", cfg) // {Host:localhost Port:8080 Debug:true}
}
```

---

## 方法速查表

| 用途 | 方法 | 说明 |
|------|------|------|
| 获取类型信息 | `reflect.TypeOf(x)` | 返回 `reflect.Type` |
| 获取运行时值 | `reflect.ValueOf(x)` | 返回 `reflect.Value` |
| 判断类型种类 | `.Kind()` | 返回 `reflect.Kind` 枚举 |
| 解引用指针 | `.Elem()` | 指针→值，接口→动态值 |
| 结构体字段数量 | `.NumField()` | 返回字段数 |
| 按索引取字段（Type） | `.Field(i)` | 返回 `StructField` |
| 按索引取字段（Value） | `.Field(i)` | 返回 `reflect.Value` |
| 按名称取字段值 | `.FieldByName(name)` | 返回 `reflect.Value` |
| 读取结构体 Tag | `.Tag.Get("tagName")` | 返回 tag 值字符串 |
| 取回原始值 | `.Interface()` | 返回 `interface{}` |
| 修改字符串字段 | `.SetString(s)` | 修改 string 字段 |
| 修改整数字段 | `.SetInt(n)` | 修改 int 字段 |
| 修改无符号整数字段 | `.SetUint(n)` | 修改 uint 字段 |
| 修改浮点数字段 | `.SetFloat(f)` | 修改 float 字段 |
| 判断 Value 是否有效 | `.IsValid()` | 零值 Value 返回 false |
| 判断 Value 是否可修改 | `.CanSet()` | 传值/小写字段返回 false |

---

## 注意事项

1. **反射很慢**：比直接代码慢 10-100 倍，热路径不要用
2. **编译期无保护**：拼写错误的字段名、类型不匹配只在运行时 panic
3. **可读性差**：反射代码比直接代码难理解，能用普通代码就不用反射
4. **典型适用场景**：编码解码（JSON/XML）、ORM、配置解析、依赖注入——这些场景类型在编译期不确定
