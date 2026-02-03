package common

import (
	"encoding/json"
	"os"
)

func DecodeJSON[T any](filePath string) (T, error) {
	var zero T

	jsonFile, err := os.Open(filePath)
	if err != nil {
		return zero, err
	}
	defer jsonFile.Close()

	decoder := json.NewDecoder(jsonFile)
	var content T
	if err := decoder.Decode(&content); err != nil {
		return zero, err
	}

	return content, nil
}
