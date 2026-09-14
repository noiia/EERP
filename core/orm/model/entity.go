package model

// Entity is the type constraint for Repository[T].
// Any struct that embeds BaseModel satisfies it automatically —
// no extra interface implementation required.
//
// The constraint exists purely to communicate intent at the type level:
// "this repository only works with ERP entities that have a UUID PK,
// timestamps, and an optional soft-delete field."
type Entity interface {
	// The blank interface body means any concrete struct satisfies Entity.
	// Repository enforces BaseModel presence at runtime via StructMeta
	// (missing pk/timestamps produce a build-time cache error).
	any
}
