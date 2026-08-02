package main

import (
	"fmt"

	"example.com/arforge/acceptance/service"
)

func main() {
	repository := service.Repository{}
	item, err := repository.Create("project depth")
	if err != nil {
		panic(err)
	}
	fmt.Println(item.Title)
}
