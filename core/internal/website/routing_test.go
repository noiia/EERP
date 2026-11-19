package website

import "testing"

func TestValidateRouting(t *testing.T) {
	tests := []struct {
		name    string
		r       Routing
		host    string
		wantErr bool
	}{
		{"path mode needs nothing", Routing{Mode: "path"}, "localhost", false},
		{"host mode from erp host", Routing{Mode: "host", SiteHost: "www.acme.fr", ERPHost: "erp.acme.fr"}, "erp.acme.fr", false},
		{"host mode with port on request", Routing{Mode: "host", SiteHost: "www.acme.fr", ERPHost: "erp.acme.fr"}, "erp.acme.fr:443", false},
		{"host mode from elsewhere is refused (lockout guard)", Routing{Mode: "host", SiteHost: "www.acme.fr", ERPHost: "erp.acme.fr"}, "localhost", true},
		{"host mode missing a host", Routing{Mode: "host", ERPHost: "erp.acme.fr"}, "erp.acme.fr", true},
		{"same host twice", Routing{Mode: "host", SiteHost: "a.fr", ERPHost: "a.fr"}, "a.fr", true},
		{"host with a path", Routing{Mode: "host", SiteHost: "a.fr/x", ERPHost: "b.fr"}, "b.fr", true},
		{"unknown mode", Routing{Mode: "magic"}, "x", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateRouting(tt.r, tt.host); (err != nil) != tt.wantErr {
				t.Errorf("err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
