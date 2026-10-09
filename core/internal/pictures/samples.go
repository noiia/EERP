package pictures

import "strings"

// SampleDir is the object-key segment of shared sample pictures: the dev seed
// (internal/devseed) uploads a small pool once per tenant under
// "<tenant>/_samples/…" and points thousands of picture rows at it, instead
// of one object per seeded record. Those objects are shared, so removing or
// replacing one row's picture must never delete them.
const SampleDir = "_samples"

// SampleKey is the object key of the tenant's shared sample `name`.
func SampleKey(tenant, name string) string { return tenant + "/" + SampleDir + "/" + name }

// IsSampleKey reports whether key is a shared sample (see SampleDir).
func IsSampleKey(key string) bool { return strings.Contains(key, "/"+SampleDir+"/") }
