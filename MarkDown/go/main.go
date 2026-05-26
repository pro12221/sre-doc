package main

import (
	"errors"
	"fmt"
)

var ErrNotFound = errors.New("用户不存在")

func findUser(id int) (string, error) {
	if id <= 0 {
		return "", ErrNotFound
	}
	return "小明", nil
}
func main() {
	user, err := findUser(0)
	if err != nil {
		fmt.Println(err)
	}
	fmt.Println(user)
	go func(msg string) {
		fmt.Println(msg)
	}("我来自协程")
}
