package config

import (
	"core/src/types"
	"encoding/json"
	"os"
)

func Load(confFilePath string) types.Config {
	jsonFile, err := os.Open(confFilePath)
	if err != nil {
		panic(err)
	}
	defer jsonFile.Close()

	var config types.Config
	decoder := json.NewDecoder(jsonFile)
	err = decoder.Decode(&config)

	return config
}
