## 模型定义
GORM 通过将 Go 结构体（Go structs） 映射到数据库表来简化数据库交互。 了解如何在GORM中定义模型，是充分利用GORM全部功能的基础。

模型是使用普通结构体定义的。 这些结构体可以包含具有基本Go类型、指针或这些类型的别名，甚至是自定义类型（只需要实现 database/sql 包中的Scanner和Valuer接口）。
type User struct {
  ID           uint           // Standard field for the primary key
  Name         string         // A regular string field
  Email        *string        // A pointer to a string, allowing for null values
  Age          uint8          // An unsigned 8-bit integer
  Birthday     *time.Time     // A pointer to time.Time, can be null
  MemberNumber sql.NullString // Uses sql.NullString to handle nullable strings
  ActivatedAt  sql.NullTime   // Uses sql.NullTime for nullable time fields
  CreatedAt    time.Time      // Automatically managed by GORM for creation time
  UpdatedAt    time.Time      // Automatically managed by GORM for update time
  ignored      string         // 小写字母开头不会被映射
}

Go 的结构体 User → 数据库表 users，GormUserName → gorm_user_names。这是 GORM 的约定，方便你不需要手动指定表名。

GORM提供了一个预定义的结构体，名为gorm.Model，其中包含常用字段：

// gorm.Model 的定义
type Model struct {
  ID        uint           `gorm:"primaryKey"`
  CreatedAt time.Time
  UpdatedAt time.Time
  DeletedAt gorm.DeletedAt `gorm:"index"`
}

## 字段权限控制
type User struct {
  Name string `gorm:"<-:create"` // 允许读和创建
  Name string `gorm:"<-:update"` // 允许读和更新
  Name string `gorm:"<-"`        // 允许读和写（创建和更新）
  Name string `gorm:"<-:false"`  // 允许读，禁止写
  Name string `gorm:"->"`        // 只读（除非有自定义配置，否则禁止写）
  Name string `gorm:"->;<-:create"` // 允许读和写
  Name string `gorm:"->:false;<-:create"` // 仅创建（禁止从 db 读）
  Name string `gorm:"-"`  // 通过 struct 读写会忽略该字段
  Name string `gorm:"-:all"`        // 通过 struct 读写、迁移会忽略该字段
  Name string `gorm:"-:migration"`  // 通过 struct 迁移会忽略该字段
}


## 链接到数据库
package main

import (
	"fmt"
	"log"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

var DB *gorm.DB

func main() {
	dsn := "root:@tcp(117.50.217.36:3306)/mysql?charset=utf8mb4&parseTime=True&loc=Local"

	// 打印尝试连接的数据库信息
	fmt.Printf("尝试连接: %s@%s:%d/%s\n", "root", "117.50.217.36", 3306, "mysql")

	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
	if err != nil {
		// 打印详细错误信息
		log.Fatalf("连接数据库失败，详细错误: %v\n", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		log.Fatalf("获取底层连接池失败: %v\n", err)
	}

	sqlDB.SetMaxIdleConns(10)
	sqlDB.SetMaxOpenConns(100)
	sqlDB.SetConnMaxLifetime(time.Hour)

	fmt.Println("数据库连接成功！")
	DB = db
}

## 自动迁移AutoMigrate
自动迁移（AutoMigrate） 是 GORM 提供的一个功能，它可以自动将你定义的 Go 结构体转换为数据库中的表结构，并保持同步。
简单说：你只管写 Go 代码定义模型，GORM 自动帮你创建/更新数据库表。 不会删除

功能	说明	示例
创建表	结构体 → 数据库表	User 结构体 → users 表
添加字段	结构体新增字段 → 表新增列	加 Email 字段 → 表加 email 列
修改字段类型	字段类型改变 → 列类型改变	int 改 string → 列类型变更
设置约束	标签定义的约束 → 数据库约束	not null, unique, default 等
创建索引	标签定义索引 → 数据库索引	gorm:"index", gorm:"uniqueIndex"
修改字段属性	字段属性改变 → 列属性改变	size:100 → VARCHAR(100)

package main

import (
	"fmt"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

type User struct {
	ID        uint
	Name      string
	Age       int
	Email     string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func main() {
	dsn := "root:@tcp(117.50.217.36:3306)/testdb?charset=utf8mb4&parseTime=True&loc=Local"
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
	if err != nil {
		panic("连接失败: " + err.Error())
	}

	// 自动创建表（如果表不存在就创建，存在就检查字段）
	db.AutoMigrate(&User{})

	fmt.Println("表创建/同步成功！")
}


## CRUD
package main

import (
	"fmt"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

type User struct {
	ID        uint
	Name      string
	Age       int
	Email     string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func main() {
	dsn := "root:@tcp(117.50.217.36:3306)/testdb?charset=utf8mb4&parseTime=True&loc=Local"
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
	if err != nil {
		panic("连接失败: " + err.Error())
	}

	// 自动创建表
	db.AutoMigrate(&User{})
	fmt.Println("表创建/同步成功！")

	// ========== 1. 创建记录 (Create) ==========
	createUser(db)

	// ========== 2. 批量创建 ==========
	batchCreateUsers(db)

	// ========== 3. 查询记录 (Read) ==========
	queryUser(db)

	// ========== 4. 更新记录 (Update) ==========
	updateUser(db)

	// ========== 5. 删除记录 (Delete) ==========
	deleteUser(db)

	// ========== 6. 复杂查询示例 ==========
	complexQuery(db)
}

// 1. 创建单条记录
func createUser(db *gorm.DB) {
	fmt.Println("\n--- 创建用户 ---")
	
	user := User{
		Name:  "张三",
		Age:   25,
		Email: "zhangsan@example.com",
	}
	
	result := db.Create(&user)
	if result.Error != nil {
		fmt.Printf("创建失败: %v\n", result.Error)
		return
	}
	
	fmt.Printf("创建成功！用户ID: %d, 姓名: %s, 年龄: %d, 邮箱: %s\n", 
		user.ID, user.Name, user.Age, user.Email)
}

// 2. 批量创建
func batchCreateUsers(db *gorm.DB) {
	fmt.Println("\n--- 批量创建用户 ---")
	
	users := []User{
		{Name: "李四", Age: 30, Email: "lisi@example.com"},
		{Name: "王五", Age: 28, Email: "wangwu@example.com"},
		{Name: "赵六", Age: 35, Email: "zhaoliu@example.com"},
	}
	
	result := db.Create(&users)
	if result.Error != nil {
		fmt.Printf("批量创建失败: %v\n", result.Error)
		return
	}
	
	fmt.Printf("批量创建成功！共创建 %d 条记录\n", result.RowsAffected)
}

// 3. 查询记录
func queryUser(db *gorm.DB) {
	fmt.Println("\n--- 查询用户 ---")
	
	var user User
	var users []User
	
	// 3.1 查询单条记录（根据主键）
	db.First(&user, 1)
	fmt.Printf("查询ID=1的用户: 姓名=%s, 年龄=%d, 邮箱=%s\n", user.Name, user.Age, user.Email)
	
	// 3.2 查询单条记录（根据条件）
	db.Where("name = ?", "张三").First(&user)
	fmt.Printf("查询姓名为张三的用户: ID=%d, 年龄=%d, 邮箱=%s\n", user.ID, user.Age, user.Email)
	
	// 3.3 查询所有记录
	db.Find(&users)
	fmt.Printf("查询所有用户: 共 %d 条记录\n", len(users))
	for _, u := range users {
		fmt.Printf("  - ID:%d, 姓名:%s, 年龄:%d, 邮箱:%s\n", u.ID, u.Name, u.Age, u.Email)
	}
	
	// 3.4 条件查询
	var youngUsers []User
	db.Where("age < ?", 30).Find(&youngUsers)
	fmt.Printf("\n年龄小于30的用户: 共 %d 条\n", len(youngUsers))
	
	// 3.5 查询指定字段
	var names []string
	db.Model(&User{}).Select("name").Find(&names)
	fmt.Printf("所有用户姓名: %v\n", names)
}

// 4. 更新记录
func updateUser(db *gorm.DB) {
	fmt.Println("\n--- 更新用户 ---")
	
	// 4.1 先查询要更新的用户
	var user User
	db.First(&user, 1)
	
	// 4.2 更新单个字段
	db.Model(&user).Update("age", 26)
	fmt.Printf("更新用户ID=%d的年龄为26\n", user.ID)
	
	// 4.3 更新多个字段
	db.Model(&user).Updates(User{
		Name:  "张三-更新",
		Email: "zhangsan_new@example.com",
	})
	fmt.Printf("更新用户ID=%d的姓名和邮箱\n", user.ID)
	
	// 4.4 使用 map 更新（不会忽略零值）
	db.Model(&user).Updates(map[string]interface{}{
		"name": "张三-map更新",
		"age":  27,
	})
	fmt.Printf("使用map更新用户ID=%d\n", user.ID)
	
	// 4.5 批量更新（更新所有符合条件的记录）
	db.Model(&User{}).Where("age > ?", 30).Update("age", 31)
	fmt.Println("批量更新：将所有年龄大于30的用户年龄改为31")
}

// 5. 删除记录
func deleteUser(db *gorm.DB) {
	fmt.Println("\n--- 删除用户 ---")
	
	// 5.1 删除单条记录（需要主键）
	var user User
	db.First(&user, "name = ?", "赵六")
	if user.ID != 0 {
		db.Delete(&user)
		fmt.Printf("删除用户: %s (ID=%d)\n", user.Name, user.ID)
	}
	
	// 5.2 批量删除
	result := db.Where("age > ?", 30).Delete(&User{})
	fmt.Printf("批量删除年龄大于30的用户: 删除了 %d 条记录\n", result.RowsAffected)
	
	// 5.3 注意：由于 User 结构体没有 gorm.DeletedAt 字段
	// 这里的删除是物理删除（永久删除数据）
}

// 6. 复杂查询示例
func complexQuery(db *gorm.DB) {
	fmt.Println("\n--- 复杂查询 ---")
	
	var users []User
	
	// 6.1 IN 查询
	db.Where("age IN ?", []int{25, 28, 30}).Find(&users)
	fmt.Printf("年龄在25,28,30的用户: %d 条\n", len(users))
	
	// 6.2 LIKE 查询
	db.Where("name LIKE ?", "%张%").Find(&users)
	fmt.Printf("姓名包含'张'的用户: %d 条\n", len(users))
	
	// 6.3 AND 条件
	db.Where("name = ? AND age > ?", "张三", 20).Find(&users)
	fmt.Printf("姓名为张三且年龄大于20的用户: %d 条\n", len(users))
	
	// 6.4 OR 条件
	db.Where("name = ?", "张三").Or("name = ?", "李四").Find(&users)
	fmt.Printf("姓名为张三或李四的用户: %d 条\n", len(users))
	
	// 6.5 排序
	db.Order("age desc").Find(&users)
	fmt.Println("按年龄降序排列:")
	for _, u := range users {
		fmt.Printf("  - %s: %d岁\n", u.Name, u.Age)
	}
	
	// 6.6 分页查询（Limit + Offset）
	var pagedUsers []User
	db.Limit(2).Offset(0).Find(&pagedUsers)
	fmt.Printf("分页查询第1页(每页2条): %d 条\n", len(pagedUsers))
	
	// 6.7 统计数量
	var count int64
	db.Model(&User{}).Where("age > ?", 25).Count(&count)
	fmt.Printf("年龄大于25岁的用户数量: %d\n", count)
}
## 原生sql
CRUD 操作	SQL 生成器方式	原生 SQL 方式
创建	db.Create(&user)	db.Exec("INSERT INTO users ...")
查询单条	db.First(&user, 1)	db.Raw("SELECT * FROM users WHERE id = ?", 1).Scan(&user)
查询多条	db.Where("age > ?", 18).Find(&users)	db.Raw("SELECT * FROM users WHERE age > ?", 18).Scan(&users)
更新	db.Model(&user).Update("age", 26)	db.Exec("UPDATE users SET age = ? WHERE id = ?", 26, user.ID)
删除	db.Delete(&user)	db.Exec("DELETE FROM users WHERE id = ?", user.ID)