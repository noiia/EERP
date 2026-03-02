package common

import (
	"errors"
	"os"
)

// If an error occurs, the function returns false and the error.
//
// Overwise it answer an empty error coupled with the boolean response to the file inexistance
func FileNotExists(root string) (bool, error) {
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		return true, nil
	} else if err != nil {
		return false, err
	} else {
		return false, nil
	}
}

// Use FileNotExists to define if the folder exists or not and create it if needed
func MkDirIfNotExists(folderPath string) error {
	if notExists, err := FileNotExists(folderPath); err != nil {
		return err
	} else if notExists {
		err = os.MkdirAll(folderPath, 0755)
		if err != nil {
			return err
		}
	}

	return nil
}
