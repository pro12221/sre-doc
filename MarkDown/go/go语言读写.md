## Go 数据读写核心知识体系
Go 的 I/O 体系围绕一个核心理念：一切皆接口。掌握了 io.Reader 和 io.Writer 两个接口，你就掌握了 Go 数据读写的 80%。

## 一、核心接口：io.Reader 与 io.Writer
1.1 io.Reader —— 万物皆可读
type Reader interface {
    Read(p []byte) (n int, err error)
}
Read 的语义非常重要，很多 bug 都源于误解：
- 将数据读入 p，返回实际读取的字节数 n
- n < len(p) 不是错误，只是本次没读满，调用者应继续读
- 读到末尾返回 io.EOF，这是正常结束，不是错误
- n == 0 && err == nil 的情况不应出现，标准库不会这样
// 最基本的读取模式
buf := make([]byte, 1024)
for {
    n, err := reader.Read(buf)
    if n > 0 {
        // 处理 buf[:n]
    }
    if err == io.EOF {
        break // 正常结束
    }
    if err != nil {
        log.Fatal(err) // 真正的错误
    }
}
1.2 io.Writer —— 万物皆可写
type Writer interface {
    Write(p []byte) (n int, err error)
}
- 写入 p 的数据，返回实际写入的字节数
- n < len(p) 必须伴随非 nil error（这与 Read 不同！）
- Writer 不保证一次写完所有数据，调用者需检查


### io.Reader
// 准备一个"水龙头"——从字符串读
reader := strings.NewReader("hello world")
// 拿桶去接
bucket := make([]byte, 5)
n, _ := reader.Read(bucket)
fmt.Println(string(bucket[:n])) // "hello" —— 只接了5字节
// 再接一次
n, _ = reader.Read(bucket)
fmt.Println(string(bucket[:n])) // " worl" —— 接着往下接
// 第三次
n, err := reader.Read(bucket)
fmt.Println(string(bucket[:n])) // "d"    —— 只剩1字节
fmt.Println(err)                // io.EOF —— 水龙头没水了

### io.Writer
Writer 就是漏斗，你往里倒东西，它负责送到目的地。
var buf bytes.Buffer // 内存中的漏斗，倒进去的东西存着
buf.Write([]byte("hello "))
buf.WriteString("world")
fmt.Println(buf.String()) // "hello world" —— 倒进去的都存着
类比：往漏斗倒水，水去了哪里取决于漏斗接了什么——接了文件就写文件，接了网络就发网络，接了 Buffer 就存内存。

### io.Copy —— 水管（水龙头接漏斗）
你不需要自己拿桶接水再倒，用 io.Copy 一根水管直接连上：
src := strings.NewReader("hello world")
var dst bytes.Buffer
io.Copy(&dst, src) // 自动把 src 的水接到 dst
fmt.Println(dst.String()) // "hello world"
不用 Copy 的写法（自己搬水）：
buf := make([]byte, 1024)
for {
    n, err := src.Read(buf)
    dst.Write(buf[:n])
    if err == io.EOF { break }
}
io.Copy 就是帮你省掉这个循环。90% 的场景用 Copy 就够了。

四、io.ReadAll —— 一口吞
把水龙头的水一口气全喝完，返回一个 []byte：
reader := strings.NewReader("hello world")
all, _ := io.ReadAll(reader)
fmt.Println(string(all)) // "hello world"
⚠️ 小心：如果水龙头接的是 10GB 的文件，ReadAll 会撑爆内存。大文件用 io.Copy 流着喝。

io.TeeReader —— 三通管
一边读一边写，像 Unix 的 tee 命令。读到的数据同时抄一份到别处。
var backup bytes.Buffer                // 备份目标
source := strings.NewReader("secret")  // 原始数据
tee := io.TeeReader(source, &backup)   // 接上三通管
// 从三通管读——读了的同时自动写了一份到 backup
all, _ := io.ReadAll(tee)
fmt.Println(string(all))    // "secret" —— 你读到的
fmt.Println(backup.String()) // "secret" —— 备份到的
实际用途：读文件的同时算哈希、读响应体的同时记日志。


七、io.MultiReader —— 接力水龙头
把多个水龙头串成一条线，读完第一个自动读第二个：
r1 := strings.NewReader("hello ")
r2 := strings.NewReader("world")
combined := io.MultiReader(r1, r2)
all, _ := io.ReadAll(combined)
fmt.Println(string(all)) // "hello world" —— 先读r1，再读r2



八、io.MultiWriter —— 广播漏斗
写一次，同时发到多个地方：
var buf1, buf2 bytes.Buffer
multi := io.MultiWriter(&buf1, &buf2)
multi.Write([]byte("hello"))
fmt.Println(buf1.String()) // "hello" —— 两边都收到了
fmt.Println(buf2.String()) // "hello"
实际用途：同时写文件和终端、同时写日志和网络。


九、io.LimitReader —— 限量水龙头
只能读指定字节数，多了不给：
source := strings.NewReader("hello world this is a long text")
limited := io.LimitReader(source, 5) // 最多只给5字节
all, _ := io.ReadAll(limited)
fmt.Println(string(all)) // "hello" —— 只拿到5字节就停了
实际用途：限制上传文件大小、预读文件头判断类型。

十一、bufio.Scanner —— 逐行读文件
最常见的读文件方式，一次拿一行：
// 先造一个测试文件
os.WriteFile("test.txt", []byte("第一行\n第二行\n第三行"), 0644)
// 逐行读
file, _ := os.Open("test.txt")
defer file.Close()
scanner := bufio.NewScanner(file)
for scanner.Scan() {
    fmt.Println(scanner.Text()) // 每次打印一行
}
// 输出:
// 第一行
// 第二行
// 第三行
类比：读书时用尺子比着，一次读一行，不会读串行。


十二、bufio.Writer —— 先攒着再写
先在内存里攒一波，满了或手动刷新时才真正写出去。减少磁盘/网络的小写入次数：
file, _ := os.Create("output.txt")
defer file.Close()
w := bufio.NewWriter(file)
w.WriteString("第一行\n") // 先攒着，还没写到文件
w.WriteString("第二行\n") // 继续攒
w.Flush()                  // 这才真正写入磁盘！
// 如果不 Flush，程序退出时数据可能丢了
类比：发快递——不是买一件发一件，而是攒一箱再发，省运费。


bytes.Buffer —— 内存草稿纸
一块既能写又能读的内存空间，像草稿纸：
var buf bytes.Buffer
// 写
buf.WriteString("hello ")
buf.WriteString("world")
// 读
data := make([]byte, 5)
buf.Read(data) // 读出 "hello"
fmt.Println(string(data)) // "hello"
// 剩下的还在
fmt.Println(buf.String()) // " world"
Write = 往尾部添加数据
Read = 从头部取出数据（取出的数据会从 buffer 中删除）


strings.Builder —— 高效拼字符串
只写不读，专门用来拼字符串，比 + 快得多：
// 慢的方式（每次 + 都分配新内存）
s := ""
for i := 0; i < 10000; i++ {
    s += "hello" // 每次都拷贝整个旧字符串
}
// 快的方式
var b strings.Builder
for i := 0; i < 10000; i++ {
    b.WriteString("hello") // 追加到末尾，不拷贝旧数据
}
result := b.String()
类比：+ 拼接像每次搬家都重新打包所有行李，Builder 像往行李箱里一件件塞。


os.ReadFile / WriteFile —— 一把梭
小文件首选，一行读/写整个文件：
// 读
data, _ := os.ReadFile("config.json")
fmt.Println(string(data))
// 写
os.WriteFile("output.txt", []byte("hello"), 0644)
类比：ReadFile 是把整本书复印一份，WriteFile 是把一张纸直接塞进信封。小文件用这个最省事。

os.Open / Create + bufio —— 精细操作
大文件或需要逐行处理时用：
// 追加写入日志
f, _ := os.OpenFile("app.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
defer f.Close()
f.WriteString("2024-01-01 新日志行\n")
// 逐行读大文件（不会撑爆内存）
f, _ := os.Open("huge.log")
scanner := bufio.NewScanner(f)
for scanner.Scan() {
    line := scanner.Text()
    if strings.Contains(line, "ERROR") {
        fmt.Println(line) // 只打印含 ERROR 的行
    }
}