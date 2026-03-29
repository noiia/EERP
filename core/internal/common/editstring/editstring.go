package editstring

import (
	"runtime"
	"strings"
	"unicode"
)

// Remove non printable characters from a string.
func Clean(text string) string {
	var cleanedText strings.Builder

	for _, char := range text {
		if unicode.IsPrint(char) {
			cleanedText.WriteRune(char)
		}
	}

	return cleanedText.String()
}

// Remove non printable characters, remove whitespaces and set every character to lowercase.
func LowedNoSpaces(text string) string {
	cleanedText := Clean(text)
	lowText := strings.ToLower(cleanedText)
	spaceDeletedText := strings.ReplaceAll(lowText, " ", "")

	return spaceDeletedText
}

// Remove the last element of a path. The string is splited by "/" then the last element is removed.
func KeepLastElementInPath(path string) string {
	var separator string
	switch runtime.GOOS {
	case "windows":
		separator = "\\"
	default:
		separator = "/"
	}

	splitedPath := strings.Split(path, separator)

	return splitedPath[len(splitedPath)-1]
}

func RemoveFirstElementInPath(path string) string {
	var separator string
	switch runtime.GOOS {
	case "windows":
		separator = "\\"
	default:
		separator = "/"
	}

	splitedPath := strings.Split(path, separator)

	var finalPath string

	for i := range len(splitedPath) - 1 {
		finalPath += splitedPath[i+1] + separator
	}

	return finalPath
}

func GetPathElementAsSlice(path string) []string {
	var separator string
	switch runtime.GOOS {
	case "windows":
		separator = "\\"
	default:
		separator = "/"
	}

	splitedPath := strings.Split(path, separator)

	var finalPath []string

	for _, value := range splitedPath {
		finalPath = append(finalPath, value+separator)
	}

	return finalPath
}
