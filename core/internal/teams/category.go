package teams

import "core/internal/notify"

func init() { notify.RegisterCategory(notify.Category{Key: "teams", Label: "Teams"}) }
