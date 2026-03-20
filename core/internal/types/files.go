package types

import "time"

type FileMeta struct {
	Path        string
	Size        int64
	ModTime     time.Time
	Dependances []string
	Priority    int
}

type Diff struct {
	Added   []FileMeta
	Removed []FileMeta
}
