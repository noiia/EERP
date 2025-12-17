package common

import (
	"encoding/json"
	"os"
)

func DecodeJSON(filePath string, content interface{}) interface{} {
	jsonFile, err := os.Open(filePath)
	if err != nil {
		panic(err)
	}
	defer jsonFile.Close()

	decoder := json.NewDecoder(jsonFile)
	err = decoder.Decode(&content)

	return content
}
