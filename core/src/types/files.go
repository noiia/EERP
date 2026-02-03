package types

import "time"

type FileMeta struct {
	Path    string
	Size    int64
	ModTime time.Time
}

type Diff struct {
	Added   []FileMeta
	Removed []FileMeta
}
