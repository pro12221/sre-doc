一、核心接口：io.Reader 与 io.Writer
// 只要有 Read 方法，就是一个 Reader
type Reader interface {
    Read(p []byte) (n int, err error)
}
// 只要有 Write 方法，就是一个 Writer
type Writer interface {
    Write(p []byte) (n int, err error)
}
关键约定：
- 
Read 返回 io.EOF 表示流结束，这不是错误，是正常信号
- 
Read 可能返回 n > 0 且 err != nil，此时应先处理已读取的 n 字节
- 
Write 必须返回 n == len(p)，否则应返回错误
一切皆 Reader/Writer —— 文件、网络连接、内存缓冲区、HTTP 请求体、压缩流……全部实现这两个接口。
二、文件读写
2.1 读文件
方式一：整体读取（小文件适用）
data, err := os.ReadFile("config.json")
if err != nil {
    log.Fatal(err)
}
fmt.Println(string(data))
方式二：逐块读取（大文件适用）
f, err := os.Open("large.log")
if err != nil {
    log.Fatal(err)
}
defer f.Close()
buf := make([]byte, 4096) // 4KB 缓冲区
for {
    n, err := f.Read(buf)
    if n > 0 {
        fmt.Printf("read %d bytes\n", n)
        // 处理 buf[:n]
    }
    if err == io.EOF {
        break
    }
    if err != nil {
        log.Fatal(err)
    }
}
方式三：使用 io.ReadAll 读取任意 Reader
resp, _ := http.Get("https://example.com")
defer resp.Body.Close()
body, _ := io.ReadAll(resp.Body)
2.2 写文件
方式一：整体写入
err := os.WriteFile("output.txt", []byte("hello world"), 0644)
if err != nil {
    log.Fatal(err)
}
方式二：打开后写入（支持追加等模式）
// os.O_APPEND 追加, os.O_TRUNC 清空重写, os.O_CREATE 不存在则创建
f, err := os.OpenFile("app.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
if err != nil {
    log.Fatal(err)
}
defer f.Close()
f.WriteString("2026-05-19 service started\n")
f.Write([]byte{0x48, 0x65, 0x6c, 0x6c, 0x6f}) // 写二进制
2.3 文件打开模式速查
标志	含义
os.O_RDONLY	只读
os.O_WRONLY	只写
os.O_RDWR	读写
os.O_CREATE	不存在则创建
os.O_APPEND	追加写入
os.O_TRUNC	打开时清空文件


三、缓冲读写：bufio（性能关键）
裸 Read/Write 系统调用开销大，bufio 在用户态加一层缓冲区，减少系统调用次数。
3.1 BufferedReader
f, _ := os.Open("data.csv")
defer f.Close()
scanner := bufio.NewScanner(f)
// 默认按行分割，也可自定义：
// scanner.Split(bufio.ScanWords)  // 按词
// scanner.Split(bufio.ScanBytes)  // 按字节
for scanner.Scan() {
    line := scanner.Text()   // string
    // line := scanner.Bytes() // []byte，零拷贝，下次迭代会覆盖
    fmt.Println(line)
}
if err := scanner.Err(); err != nil {
    log.Fatal(err)
}
Scanner vs ReadLine vs ReadString：
方法	适用场景	特点
Scanner	逐行/逐词读取	自动处理长行，推荐首选
ReadLine	需要判断行是否完整	低级 API，需手动处理 isPrefix
ReadString('\n')	按分隔符读取	返回包含分隔符的字符串
3.2 BufferedWriter
f, _ := os.Create("output.txt")
defer f.Close()
w := bufio.NewWriter(f)
// 默认缓冲区 4KB，可自定义：bufio.NewWriterSize(f, 8192)
w.WriteString("第一行\n")
w.WriteString("第二行\n")
w.WriteByte('A')
w.WriteRune('中')
w.Flush() // 必须调用！否则数据留在缓冲区未写入文件
常见坑：忘记 Flush()，数据丢失。用 defer w.Flush() 可以兜底，但要注意 defer 不保证执行顺序与错误处理。
3.3 性能对比
// 无缓冲：每次 Write 都是系统调用 → 慢
f.Write([]byte("x"))  // 1 次 syscall
// 有缓冲：写入用户态内存，满了才 syscall → 快
w := bufio.NewWriter(f)
w.WriteString("x")    // 0 次 syscall（直到 Flush 或缓冲满）
实际场景中，bufio 可将写性能提升 5-20 倍。


四、数据格式读写
4.1 JSON
type Server struct {
    Host    string `json:"host"`
    Port    int    `json:"port"`
    Enabled bool   `json:"enabled"`
}
// 写 JSON（结构体 → 字节）
srv := Server{Host: "localhost", Port: 8080, Enabled: true}
// 紧凑
data, _ := json.Marshal(srv)
// {"host":"localhost","port":8080,"enabled":true}
// 缩进（用于配置文件、调试）
data, _ := json.MarshalIndent(srv, "", "  ")
// 流式写入（直接写入 Writer，避免分配中间 []byte）
f, _ := os.Create("config.json")
enc := json.NewEncoder(f)
enc.SetIndent("", "  ")
enc.Encode(srv)
// 读 JSON（字节 → 结构体）
var config Server
json.Unmarshal(data, &config)
// 流式读取
f, _ := os.Open("config.json")
dec := json.NewDecoder(f)
var config Server
dec.Decode(&config)
Decoder vs Unmarshal 选择：
场景	选择	原因
数据已在内存	Unmarshal	简单直接
从文件/网络流读取	Decoder	流式，不先加载全部到内存
JSON 流中有多条记录	Decoder	可循环调用 Decode()
4.2 CSV
// 写 CSV
f, _ := os.Create("data.csv")
defer f.Close()
w := csv.NewWriter(f)
w.Write([]string{"name", "age", "city"})
w.Write([]string{"Alice", "30", "Shanghai"})
w.WriteAll([][]string{
    {"Bob", "25", "Beijing"},
    {"Charlie", "35", "Shenzhen"},
})
w.Flush()
// 读 CSV
f, _ := os.Open("data.csv")
defer f.Close()
r := csv.NewReader(f)
records, _ := r.ReadAll() // 一次读全部
for _, row := range records {
    fmt.Printf("%s, %s, %s\n", row[0], row[1], row[2])
}
// 流式读取（大文件）
r = csv.NewReader(f)
for {
    row, err := r.Read()
    if err == io.EOF {
        break
    }
    if err != nil {
        log.Fatal(err)
    }
    // 处理 row
}
4.3 二进制数据（encoding/binary）
// 写二进制（网络协议、文件格式常用）
buf := new(bytes.Buffer)
binary.Write(buf, binary.BigEndian, uint32(1024))  // 4 字节大端
binary.Write(buf, binary.LittleEndian, float64(3.14))
f.Write(buf.Bytes())
// 读二进制
var num uint32
var val float64
binary.Read(f, binary.BigEndian, &num)
binary.Read(f, binary.LittleEndian, &val)
4.4 gob（Go 对象序列化）
// 写
enc := gob.NewEncoder(f)
enc.Encode(myStruct)
// 读
dec := gob.NewDecoder(f)
dec.Decode(&myStruct)
仅限 Go 程序间通信，跨语言场景用 JSON/Protobuf。
五、组合模式：io 工具链
Go 的 io 包提供大量组合工具，像管道一样拼接 Reader/Writer：
5.1 io.Copy（零拷贝传输）
// 文件复制
src, _ := os.Open("source.txt")
defer src.Close()
dst, _ := os.Create("dest.txt")
defer dst.Close()
written, _ := io.Copy(dst, src)  // 内部用 32KB 缓冲区
fmt.Printf("copied %d bytes\n", written)
5.2 io.TeeReader（同时读和写）
// 读数据的同时写入另一个 Writer（类似 tee 命令）
var buf bytes.Buffer
tee := io.TeeReader(resp.Body, &buf)
data, _ := io.ReadAll(tee)
// data 是读取的内容，buf 中也有相同副本
5.3 io.MultiWriter（广播写入）
// 同时写入文件和 stdout
f, _ := os.Create("app.log")
multi := io.MultiWriter(f, os.Stdout)
logger := log.New(multi, "", log.LstdFlags)
logger.Println("这行同时输出到控制台和文件")
5.4 io.LimitReader（限制读取量）
// 只读前 1KB
limited := io.LimitReader(resp.Body, 1024)
header, _ := io.ReadAll(limited)
5.5 io.SectionReader（读取区间）
f, _ := os.Open("bigfile.bin")
section := io.NewSectionReader(f, 1024, 512) // 偏移 1024，读 512 字节
data, _ := io.ReadAll(section)
六、内存读写：bytes 与 strings
// bytes.Buffer：同时实现 Reader 和 Writer
var buf bytes.Buffer
buf.WriteString("hello ")
buf.WriteString("world")
fmt.Println(buf.String()) // "hello world"
// 作为 Reader 使用
n, _ := buf.Read(make([]byte, 5))
// bytes.Reader：只读，类似 bytes.Buffer 的只读版
r := bytes.NewReader([]byte("hello world"))
r.Seek(6, io.SeekStart) // 跳到位置 6
data, _ := io.ReadAll(r)  // "world"
// strings.Reader：字符串的只读 Reader
sr := strings.NewReader("hello world")
sr.Seek(6, io.SeekStart)
data, _ := io.ReadAll(sr) // "world"
七、实用模式速查
场景	推荐方式
读写小文件	os.ReadFile / os.WriteFile
逐行处理大文件	bufio.Scanner
高频写入日志	bufio.Writer + 定期 Flush
HTTP 请求体读取	io.ReadAll(resp.Body)
文件复制	io.Copy(dst, src)
JSON 配置	json.NewDecoder(f).Decode(&v)
CSV 数据	csv.NewReader(f)
网络协议二进制	encoding/binary
流式处理（边读边写）	io.TeeReader + io.Copy
内存中拼装数据	bytes.Buffer
限制读取量	io.LimitReader