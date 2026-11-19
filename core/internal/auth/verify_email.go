package auth

import "core/internal/mail"

// TemplateVerifyEmail is the website signup's "confirm your email" mail, a
// core mail template (ADR-027) admins can reword in Settings → Email templates.
const TemplateVerifyEmail = "website.verify_email"

func init() {
	mail.RegisterTemplate(mail.TemplateDef{
		Key: TemplateVerifyEmail, Label: "Website: confirm your email", Vars: []string{"verify_url"},
		Defaults: map[string]mail.Content{
			"en": {Subject: "Confirm your email", HTML: `<p>Confirm your email address to see your bookings:</p>` +
				`<p><a href="{{verify_url}}">Confirm my email</a></p>` +
				`<p>This link expires in 48 hours. If you didn't create this account, you can ignore this email.</p>`},
			"fr": {Subject: "Confirmez votre e-mail", HTML: `<p>Confirmez votre adresse e-mail pour voir vos réservations :</p>` +
				`<p><a href="{{verify_url}}">Confirmer mon e-mail</a></p>` +
				`<p>Ce lien expire dans 48 heures. Si vous n'avez pas créé ce compte, ignorez cet e-mail.</p>`},
		},
	})
}
