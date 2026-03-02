package common

import (
	"encoding/json"
	"os"

	"go.uber.org/zap"
)

func DecodeJSON[T any](filePath string) (T, error) {
	var zero T

	jsonFile, err := os.Open(filePath)
	if err != nil {
		return zero, err
	}
	defer func() {
		if err := jsonFile.Close(); err != nil {
			Logger.Error("❌ Error occurs on closing jsonFile : ", zap.Error(err))
		}
	}()

	decoder := json.NewDecoder(jsonFile)
	var content T
	if err := decoder.Decode(&content); err != nil {
		return zero, err
	}

	return content, nil
}
