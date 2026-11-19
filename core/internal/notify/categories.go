package notify

import "sync"

// Category is a kind of global activity a role can be allowed to see
// (Settings → Users → Roles → Notifications). Label is an English msgid,
// translated by the frontend.
type Category struct {
	Key   string
	Label string
}

var (
	catMu      sync.Mutex
	categories []Category
)

func init() {
	RegisterCategory(Category{Key: "cron", Label: "Scheduled actions"})
	RegisterCategory(Category{Key: "dev_seed", Label: "Demo data seeding"})
}

// RegisterCategory declares a category, at init() like mail.RegisterTemplate.
// Registering a key again updates its label.
func RegisterCategory(c Category) {
	catMu.Lock()
	defer catMu.Unlock()
	for i := range categories {
		if categories[i].Key == c.Key {
			categories[i] = c
			return
		}
	}
	categories = append(categories, c)
}

// Categories lists every registered category in registration order.
func Categories() []Category {
	catMu.Lock()
	defer catMu.Unlock()
	return append([]Category(nil), categories...)
}

// IsCategory reports whether key was registered.
func IsCategory(key string) bool {
	for _, c := range Categories() {
		if c.Key == key {
			return true
		}
	}
	return false
}
