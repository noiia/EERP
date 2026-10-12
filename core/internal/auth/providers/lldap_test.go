package providers

// LLDAPDefaults are LLDAP's schema defaults (ou=people, uid, mail, memberOf) —
// the directory the tests (and the optional live test) run against.
func LLDAPDefaults(baseDN string) LDAPConfig {
	return LDAPConfig{
		Label: "LLDAP", BaseDN: "ou=people," + baseDN,
		UserFilter: "(&(objectClass=person)(uid={username}))",
		EmailAttr:  "mail", NameAttr: "cn", GroupsAttr: "memberOf",
	}
}
